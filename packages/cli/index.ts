#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ADAPTERS, isTargetId } from "../adapters/index.js";
import {
  AgentInitSafetyError,
  initializeAgentInstructions,
  renderAgentProtocol,
  type AgentHost
} from "../core/agent/init.js";
import { buildNextReport } from "../core/agent/next.js";
import { buildHistoryReport, historyDiagnostic, historyIssueFromError, renderHistoryDiagnostic } from "../core/deploy/history.js";
import { askAndRecordSecret, createHumanPlane, humanPlaneRequirement } from "../core/human/index.js";
import { inspectTargets, runDeploy } from "../core/deploy/engine.js";
import { AUTOMATIC_SAFE_ENVS, inspectDestinationTrust } from "../core/deploy/destination.js";
import { isDeployEnv, type DeployEnv, type TargetId } from "../core/deploy/types.js";
import { runForgetDestinationTrust, runRemoveSecret } from "../core/lifecycle.js";
import {
  assertProFeature,
  deactivateLicense,
  ProFeatureError,
  PURCHASE_URL,
  readLicenseStatus
} from "../core/license.js";
import { activatePurchaseLicense } from "../core/license-exchange.js";
import { createMcpServer } from "../mcp/server.js";
import { renderTextReport } from "../core/report.js";
import { scanProject } from "../core/scanner.js";
import {
  createCliTelemetry,
  disableTelemetry,
  enableTelemetry,
  getTelemetryStatus,
  type CliTelemetryCommand,
  type CliTelemetryErrorCategory,
  type CliTelemetryOutcome,
  type CliTelemetryTarget
} from "../core/telemetry.js";
import {
  assertValidSecretName,
  createVault,
  deriveProjectId,
  listSecrets,
  saveSecret,
  SecretNameError,
  SecretStoreMetadataError,
  type SecretRef,
  type SecretScope
} from "../core/vault/index.js";
import { promptPurchaseLicenseKey, promptSecretValue } from "./prompt.js";

type ScanArgs = {
  targetDir: string;
  json: boolean;
  strict: boolean;
  writeEnvExample: boolean;
  agentReport: boolean;
  force: boolean;
};

type CheckArgs = { name: string | null; scope: SecretScope; json: boolean; strict: boolean; targetDir: string };
type ListArgs = { scope: SecretScope; json: boolean; targetDir: string };
type DeployArgs = {
  name: string;
  target: TargetId;
  env: DeployEnv;
  scope: SecretScope;
  dryRun: boolean;
  force: boolean;
  targetDir: string;
};
type TargetsArgs = { targetDir: string; json: boolean };
type NextArgs = { targetDir: string; json: boolean };
type AgentInitArgs = { targetDir: string; check: boolean };

type CommandTelemetryResult = {
  command: CliTelemetryCommand;
  outcome: CliTelemetryOutcome;
  errorCategory?: CliTelemetryErrorCategory;
  target?: CliTelemetryTarget;
};

class CliExit extends Error {
  constructor(
    readonly code: number,
    readonly telemetry?: Omit<CommandTelemetryResult, "command">
  ) {
    super("CLI command terminated.");
    this.name = "CliExit";
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof CliExit) {
    process.exitCode = err.code;
    return;
  }
  console.error("Unexpected error.");
  process.exitCode = 1;
});

async function main(argv: string[]): Promise<void> {
  const [command = "help", ...rest] = argv;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    printVersion();
    return;
  }

  if (command === "scan") {
    await runObservedCommand("scan", undefined, () => runScan(rest));
    return;
  }

  if (command === "history") {
    await runHistoryCommand(rest);
    return;
  }

  if (command === "next") {
    await runNextCommand(rest);
    return;
  }

  if (command === "agent-init") {
    runAgentInitCommand(rest);
    return;
  }

  if (command === "save") {
    await runObservedCommand("save", undefined, () => runSave(rest));
    return;
  }

  if (command === "check") {
    await runCheck(rest);
    return;
  }

  if (command === "list") {
    await runList(rest);
    return;
  }

  if (command === "remove") {
    await runRemove(rest);
    return;
  }

  if (command === "deploy") {
    await runObservedCommand("deploy", readDeployTargetForTelemetry(rest), () => runDeployCommand(rest));
    return;
  }

  if (command === "targets") {
    await runTargetsCommand(rest);
    return;
  }

  if (command === "trust") {
    await runTrustCommand(rest);
    return;
  }

  if (command === "mcp") {
    await runMcpCommand(rest);
    return;
  }

  if (command === "telemetry") {
    runTelemetryCommand(rest);
    return;
  }

  if (command === "license") {
    await runLicenseCommand(rest);
    return;
  }

  console.error("Unknown command.");
  printHelp();
  process.exitCode = 1;
}

async function runObservedCommand(
  command: CliTelemetryCommand,
  target: CliTelemetryTarget | undefined,
  operation: () => Promise<void> | void
): Promise<void> {
  const telemetry = createCliTelemetry({
    cliVersion: readCliVersion(),
    env: process.env,
    platform: process.platform,
    isTTY: Boolean(process.stdin.isTTY),
    writeNotice: (message) => process.stderr.write(message)
  });
  telemetry.prepare();

  let result: CommandTelemetryResult = {
    command,
    outcome: "success",
    ...(target ? { target } : {})
  };

  try {
    await operation();
    if (typeof process.exitCode === "number" && process.exitCode !== 0) {
      result = resultForExitCode(command, process.exitCode, target);
    }
  } catch (err) {
    if (err instanceof CliExit) {
      process.exitCode = err.code;
      result = {
        command,
        outcome: err.telemetry?.outcome ?? "failure",
        ...(err.telemetry?.errorCategory ? { errorCategory: err.telemetry.errorCategory } : {}),
        ...(err.telemetry?.target ?? target ? { target: err.telemetry?.target ?? target } : {})
      };
    } else {
      console.error("Unexpected error.");
      process.exitCode = 1;
      result = {
        command,
        outcome: "failure",
        errorCategory: "unexpected_error",
        ...(target ? { target } : {})
      };
    }
  }

  await telemetry.record(result);
}

function resultForExitCode(
  command: CliTelemetryCommand,
  exitCode: number,
  target: CliTelemetryTarget | undefined
): CommandTelemetryResult {
  const common = target ? { target } : {};
  if (exitCode === 2) {
    return { command, outcome: "failure", errorCategory: "strict_findings", ...common };
  }
  if (exitCode === 4) {
    return { command, outcome: "cancelled", errorCategory: "confirmation_declined", ...common };
  }
  if (exitCode === 5) {
    return { command, outcome: "failure", errorCategory: "dependency_unavailable", ...common };
  }
  if (exitCode === 6) {
    return { command, outcome: "blocked", errorCategory: "license_required", ...common };
  }
  return { command, outcome: "failure", errorCategory: "operation_failed", ...common };
}

function terminate(code: number, telemetry?: Omit<CommandTelemetryResult, "command">): never {
  throw new CliExit(code, telemetry);
}

function readDeployTargetForTelemetry(rest: string[]): CliTelemetryTarget | undefined {
  for (let i = 0; i < rest.length - 1; i++) {
    const value = rest[i + 1];
    if (rest[i] === "--target" && isTargetId(value)) {
      return value;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// scan (unchanged behavior)
// ---------------------------------------------------------------------------

function runScan(rest: string[]): void {
  const parsed = parseScanArgs(rest);

  try {
    const report = scanProject({
      targetDir: parsed.targetDir,
      writeEnvExample: parsed.writeEnvExample,
      agentReport: parsed.agentReport,
      force: parsed.force
    });

    if (parsed.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(renderTextReport(report));
    }

    if (parsed.strict && report.warnings.length > 0) {
      process.exitCode = 2;
    }
  } catch {
    console.error("Scan failed. Check the target path and file permissions, then try again.");
    process.exitCode = 1;
  }
}

function parseScanArgs(rest: string[]): ScanArgs {
  let targetDir = process.cwd();
  let json = false;
  let strict = false;
  let writeEnvExample = false;
  let agentReport = false;
  let force = false;

  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--write-env-example") {
      writeEnvExample = true;
    } else if (arg === "--agent-report") {
      agentReport = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      terminate(1);
    } else {
      targetDir = resolve(arg);
    }
  }

  return { targetDir, json, strict, writeEnvExample, agentReport, force };
}

// ---------------------------------------------------------------------------
// Agent Control Plane (Phase 6A)
// ---------------------------------------------------------------------------

async function runHistoryCommand(rest: string[]): Promise<void> {
  const args = parseNextArgs(rest, "history");
  if (!args.json) {
    console.error("Usage: api-key-case history --json [path]");
    terminate(1);
  }
  try {
    const report = await buildHistoryReport(args.targetDir, { adapters: ADAPTERS });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error("History inspection failed. No deployment was requested by this inspection.");
    console.error(renderHistoryDiagnostic(historyDiagnostic("inspect", historyIssueFromError(error))));
    terminate(1);
  }
}

async function runNextCommand(rest: string[]): Promise<void> {
  const args = parseNextArgs(rest);
  if (!args.json) {
    console.error("Usage: api-key-case next --json [path]");
    terminate(1);
  }

  try {
    const targetDir = realpathSync(args.targetDir);
    const license = readLicenseStatus();
    const report = await buildNextReport(targetDir, {
      vault: createVault(),
      adapters: ADAPTERS.values(),
      licensePlan: license.plan
    });
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.error("Next-action inspection failed. Check the target path and local dependencies, then try again.");
    terminate(1);
  }
}

function parseNextArgs(rest: string[], command: "next" | "history" = "next"): NextArgs {
  let targetDir = process.cwd();
  let json = false;
  let positionalCount = 0;

  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      terminate(1);
    } else {
      positionalCount += 1;
      if (positionalCount > 1) {
        console.error(`Usage: api-key-case ${command} --json [path]`);
        terminate(1);
      }
      targetDir = resolve(arg);
    }
  }

  return { targetDir, json };
}

function runAgentInitCommand(rest: string[]): void {
  const args = parseAgentInitArgs(rest);
  const version = readCliVersion();

  let result: ReturnType<typeof initializeAgentInstructions>;
  try {
    result = initializeAgentInstructions({
      projectDir: args.targetDir,
      packageVersion: version,
      check: args.check,
      host: args.host
    });
  } catch (error) {
    if (error instanceof AgentInitSafetyError) {
      console.error("NG: agent instruction path or managed block is unsafe; no files were changed.");
      terminate(args.check ? 2 : 1);
    }
    console.error("NG: agent initialization failed; no instruction file was intentionally changed.");
    terminate(args.check ? 2 : 1);
  }

  if (args.check) {
    console.log(JSON.stringify(result, null, 2));
    const failed =
      result.persistence !== "configured" ||
      result.files.some((file) => file.status !== "current");
    if (failed) process.exitCode = 2;
    return;
  }

  console.log(renderAgentProtocol(version));
  console.log("");
  if (result.persistence === "unavailable") {
    console.log("Persistence: no existing Agent host marker was found; no host-specific file was created.");
    return;
  }
  console.log("Persistence:");
  for (const file of result.files) {
    console.log(`- ${file.status}: ${file.path}`);
  }
}

function parseAgentInitArgs(rest: string[]): AgentInitArgs & { host?: AgentHost } {
  let targetDir = process.cwd();
  let check = false;
  let positionalCount = 0;
  let host: AgentHost | undefined;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--host") {
      const value = rest[++index];
      if (host || (value !== "agents" && value !== "claude" && value !== "cursor")) {
        console.error("Usage: api-key-case agent-init [path] [--check] [--host agents|claude|cursor]");
        terminate(1);
      }
      host = value;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      terminate(1);
    } else {
      positionalCount += 1;
      if (positionalCount > 1) {
        console.error("Usage: api-key-case agent-init [path] [--check]");
        terminate(1);
      }
      targetDir = resolve(arg);
    }
  }

  return { targetDir, check, host };
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

async function runSave(rest: string[]): Promise<void> {
  const positionals: string[] = [];
  let scope: SecretScope = "project";
  let force = false;
  let ask = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--scope") {
      scope = readScopeValue(rest[++i]);
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--ask") {
      ask = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      terminate(1, { outcome: "failure", errorCategory: "invalid_input" });
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0) {
    console.error("Usage: api-key-case save <NAME> [--scope user|project] [--force] [--ask]");
    terminate(1, { outcome: "failure", errorCategory: "invalid_input" });
  }

  if (positionals.length > 1) {
    console.error(
      "NG: refusing to accept a secret value as a command-line argument. " +
        "It may already be in your shell history; rotate this key."
    );
    terminate(1, { outcome: "failure", errorCategory: "invalid_input" });
  }

  const name = positionals[0];
  validateNameOrExit(name);

  if (!ask && !process.stdin.isTTY) {
    console.error("NG: secret input requires an interactive terminal.");
    terminate(1, { outcome: "failure", errorCategory: "non_interactive" });
  }

  const vault = createVault();
  await requireVaultAvailable(vault);

  const targetDir = process.cwd();
  const ref: SecretRef = {
    name,
    scope,
    projectId: scope === "project" ? deriveProjectId(targetDir) : null
  };

  if (!force && (await vault.hasSecret(ref))) {
    console.error(`NG: ${name} already exists (use --force to overwrite)`);
    terminate(1, { outcome: "failure", errorCategory: "already_registered" });
  }

  const projectPath = scope === "project" ? normalizePath(targetDir) : null;
  if (ask) {
    let status;
    try {
      status = await askAndRecordSecret(createHumanPlane(), ref, projectPath);
    } catch (error) {
      if (error instanceof SecretStoreMetadataError) {
        reportSecretMetadataFailure(name, scope);
      }
      throw error;
    }
    if (status === "saved") {
      console.log(`OK: ${name} saved to ${scope} scope by the Human Plane.`);
      return;
    }
    if (status === "cancelled") {
      console.error("NG: Human Plane secret input was cancelled; nothing was saved.");
      terminate(4, { outcome: "cancelled", errorCategory: "confirmation_declined" });
    }

    const scopeFlag = scope === "user" ? " --scope user" : "";
    console.error(
      "NG: secure Human Plane secret input is unavailable; no terminal fallback was used.\n" +
        `    Ask the human to open their own terminal and run: npx api-key-case save ${name}${scopeFlag}`
    );
    terminate(1, { outcome: "blocked", errorCategory: "dependency_unavailable" });
  }

  const value = await promptSecretValue(name);
  try {
    await saveSecret(vault, ref, value, projectPath);
  } catch (error) {
    if (error instanceof SecretStoreMetadataError) {
      reportSecretMetadataFailure(name, scope);
    }
    throw error;
  }

  console.log(`OK: ${name} saved to ${scope} scope.`);
}

function reportSecretMetadataFailure(name: string, scope: SecretScope): never {
  const scopeFlag = scope === "user" ? " --scope user" : "";
  console.error(
    `NG: ${name} was saved to the OS secret store, but the API Key Case metadata index update failed.\n` +
      `    Confirm the OS-store result with: api-key-case check ${name}${scopeFlag}\n` +
      "    A missing list or next entry is not proof that the Secret is missing."
  );
  terminate(5, { outcome: "blocked", errorCategory: "dependency_unavailable" });
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async function runCheck(rest: string[]): Promise<void> {
  const args = parseCheckArgs(rest);
  if (args.name) {
    validateNameOrExit(args.name);
  }

  const vault = createVault();
  await requireVaultAvailable(vault);

  if (args.name) {
    const ref: SecretRef = {
      name: args.name,
      scope: args.scope,
      projectId: args.scope === "project" ? deriveProjectId(args.targetDir) : null
    };
    const registered = await vault.hasSecret(ref);

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            scope: args.scope,
            projectId: ref.projectId,
            name: args.name,
            status: registered ? "registered" : "missing",
            backend: vault.backendName
          },
          null,
          2
        )
      );
    } else if (registered) {
      console.log(`OK: ${args.name} is registered (${args.scope} scope).`);
    } else {
      console.log(`NG: ${args.name} is not registered.`);
    }

    if (args.strict && !registered) {
      process.exitCode = 2;
    }
    return;
  }

  let report;
  try {
    report = scanProject({ targetDir: args.targetDir });
  } catch {
    console.error("Scan failed. Check the target path and file permissions, then try again.");
    process.exitCode = 1;
    return;
  }
  const projectId = args.scope === "project" ? deriveProjectId(args.targetDir) : null;

  const secrets: { name: string; status: "registered" | "missing" }[] = [];
  for (const name of report.requiredSecrets) {
    const registered = await vault.hasSecret({ name, scope: args.scope, projectId });
    secrets.push({ name, status: registered ? "registered" : "missing" });
  }
  const missingCount = secrets.filter((entry) => entry.status === "missing").length;

  if (args.json) {
    console.log(
      JSON.stringify(
        { scope: args.scope, projectId, secrets, missingCount, backend: vault.backendName },
        null,
        2
      )
    );
  } else if (secrets.length === 0) {
    console.log("No required secrets detected by the current scanner. This does not prove that the project needs no secrets.");
  } else {
    console.log("Required secrets (from scan):");
    for (const entry of secrets) {
      const label = entry.status === "registered" ? "OK " : "NG ";
      const detail = entry.status === "registered" ? `registered (${args.scope})` : "missing";
      console.log(`  ${label} ${entry.name}   ${detail}`);
    }
    console.log("");
    if (missingCount > 0) {
      console.log(`${missingCount} missing. Run: api-key-case save <NAME>`);
    } else {
      console.log("All required secrets are registered.");
    }
  }

  if (args.strict && missingCount > 0) {
    process.exitCode = 2;
  }
}

function parseCheckArgs(rest: string[]): CheckArgs {
  let scope: SecretScope = "project";
  let json = false;
  let strict = false;
  let targetDir = process.cwd();
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--scope") {
      scope = readScopeValue(rest[++i]);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      terminate(1);
    } else {
      positionals.push(arg);
    }
  }

  // First positional is the secret NAME (optional); a second positional is
  // the project path. Validation of NAME happens after parsing.
  const name = positionals.length > 0 ? positionals[0] : null;
  if (positionals.length > 1) {
    targetDir = resolve(positionals[1]);
  }

  return { name, scope, json, strict, targetDir };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(rest: string[]): Promise<void> {
  const args = parseListArgs(rest);

  const vault = createVault();
  await requireVaultAvailable(vault);

  const projectId = args.scope === "project" ? deriveProjectId(args.targetDir) : null;
  const entries = await listSecrets(vault, args.scope, projectId);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          scope: args.scope,
          entries: entries.map((entry) => ({
            name: entry.name,
            scope: entry.scope,
            updatedAt: entry.updatedAt,
            storeStatus: entry.storeStatus
          }))
        },
        null,
        2
      )
    );
    return;
  }

  if (entries.length === 0) {
    const scopeFlag = args.scope === "user" ? " --scope user" : "";
    console.log(
      `No secrets indexed (${args.scope} scope). For a known name, run: api-key-case check <NAME>${scopeFlag}; ` +
        "absence from this index does not prove that the Secret is missing."
    );
    return;
  }

  console.log(`Registered secrets (${args.scope} scope):`);
  for (const entry of entries) {
    console.log(`  ${entry.name}   updated=${entry.updatedAt}   status=${entry.storeStatus}`);
  }
}

function parseListArgs(rest: string[]): ListArgs {
  let scope: SecretScope = "project";
  let json = false;
  let targetDir = process.cwd();

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--scope") {
      scope = readScopeValue(rest[++i]);
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      terminate(1);
    } else {
      targetDir = resolve(arg);
    }
  }

  return { scope, json, targetDir };
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

// Phase E: deleting a stored value is a human action. There is no --yes, no
// stdin confirmation, and no terminal fallback: an Agent that owns this
// process's stdin/PTY must not be able to complete a deletion, so the decision
// is taken in the Agent-independent Human Plane or not at all.
async function runRemove(rest: string[]): Promise<void> {
  const positionals: string[] = [];
  let scope: SecretScope = "project";

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--scope") {
      scope = readScopeValue(rest[++i]);
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      terminate(1);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 1) {
    console.error("Usage: api-key-case remove <NAME> [--scope user|project]");
    terminate(1);
  }

  const name = positionals[0];
  validateNameOrExit(name);

  const vault = createVault();
  await requireVaultAvailable(vault);

  const result = await runRemoveSecret(
    { vault, humanPlane: createHumanPlane(), print: (line) => console.log(line) },
    { name, scope, projectDir: process.cwd() }
  );

  switch (result.kind) {
    case "removed":
      console.log(`OK: ${name} removed from ${scope} scope.`);
      return;
    case "index-pruned":
      console.log(`OK: ${name} was not in the store; a stale index entry was cleared.`);
      return;
    case "not-registered":
      console.error(`NG: ${name} is not registered.`);
      terminate(1);
      break;
    case "declined":
      console.error("NG: the removal was declined in the Human Plane; nothing was deleted.");
      terminate(4);
      break;
    case "unavailable":
      terminate(1);
      break;
    case "human-plane-unavailable":
      printHumanPlaneRemovalHandoff(name, scope);
      terminate(5);
    case "vault-read-failed":
      console.error("NG: the OS secret store could not be read; nothing was deleted.");
      terminate(1);
      break;
    case "vault-delete-failed":
      console.error("NG: the OS secret store did not confirm deletion; no success was reported.");
      terminate(1);
  }
}

function printHumanPlaneRemovalHandoff(name: string, scope: SecretScope): void {
  const scopeFlag = scope === "user" ? " --scope user" : "";
  console.error(
    "NG: deleting a secret requires the Agent-independent Human Plane; nothing was deleted.\n" +
      `    That needs ${humanPlaneRequirement()}.\n` +
      `    Where it is available, a human can run: api-key-case remove ${name}${scopeFlag}\n` +
      "    Otherwise delete the entry in the OS secret store's own UI:\n" +
      "      macOS: Keychain Access, service \"api-key-case\"\n" +
      "      Windows: Credential Manager, generic credential \"api-key-case\"\n" +
      "      Linux: your Secret Service UI (e.g. seahorse), collection \"api-key-case\""
  );
}

// ---------------------------------------------------------------------------
// trust (Phase E destination lifecycle)
// ---------------------------------------------------------------------------

async function runTrustCommand(rest: string[]): Promise<void> {
  const [sub, ...subRest] = rest;

  if (sub === "status") {
    await runTrustStatus(subRest);
    return;
  }

  if (sub === "forget") {
    await runTrustForget(subRest);
    return;
  }

  console.error(
    "Usage: api-key-case trust status [path] [--json]\n" +
      "       api-key-case trust forget --target <cloudflare|vercel|github> " +
      "--env <production|preview|development> [path]"
  );
  terminate(1);
}

// Status only. It reads trust records through the same trusted resolution a
// deploy would use and can never create, change, or delete one.
async function runTrustStatus(rest: string[]): Promise<void> {
  const args = parseTargetsArgs(rest);
  const vault = createVault();
  await requireVaultAvailable(vault);

  const destinations: { target: TargetId; env: DeployEnv; trust: string }[] = [];
  for (const [target, envs] of Object.entries(AUTOMATIC_SAFE_ENVS) as [TargetId, readonly DeployEnv[]][]) {
    const adapter = ADAPTERS.get(target);
    if (!adapter) continue;
    for (const env of envs) {
      destinations.push({
        target,
        env,
        trust: await inspectDestinationTrust({ vault, adapter, projectDir: args.targetDir, env })
      });
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ schemaVersion: 1, destinations }, null, 2));
    return;
  }

  if (destinations.length === 0) {
    console.log("No deploy target records a destination confirmation.");
    return;
  }

  console.log(`Confirmed deploy destinations for ${args.targetDir}:`);
  for (const entry of destinations) {
    console.log(`  ${entry.target.padEnd(11)} ${entry.env.padEnd(12)} ${entry.trust}`);
  }
  console.log("");
  console.log("Every other target/environment always asks a human, so it records nothing.");
}

async function runTrustForget(rest: string[]): Promise<void> {
  let target: TargetId | null = null;
  let env: DeployEnv | null = null;
  let targetDir = process.cwd();
  let positionalCount = 0;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--target") {
      target = readTargetValue(rest[++i]);
    } else if (arg === "--env") {
      env = readEnvValue(rest[++i]);
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      terminate(1);
    } else {
      positionalCount += 1;
      if (positionalCount > 1) {
        console.error("Usage: api-key-case trust forget --target <target> --env <env> [path]");
        terminate(1);
      }
      targetDir = resolve(arg);
    }
  }

  if (!target || !env) {
    console.error("Usage: api-key-case trust forget --target <target> --env <env> [path]");
    terminate(1);
  }

  const adapter = ADAPTERS.get(target);
  if (!adapter) {
    console.error("Unknown option. --target must be one of: cloudflare, vercel, github");
    terminate(1);
  }

  const vault = createVault();
  await requireVaultAvailable(vault);

  const result = await runForgetDestinationTrust(
    { vault, humanPlane: createHumanPlane(), print: (line) => console.log(line) },
    { adapter, projectDir: targetDir, env }
  );

  switch (result.kind) {
    case "nothing-recorded":
      console.log(`OK: no destination confirmation is recorded for ${target} (${env}).`);
      return;
    case "forgotten": {
      console.log(`OK: ${target} (${env}) will ask for approval again on the next deploy.`);
      if (result.removal.destination === "unresolved") {
        console.error(
          "NG: the current destination could not be resolved, so a confirmation recorded\n" +
            "    for it may remain. Re-run this once the target CLI is installed and logged in."
        );
        terminate(1);
      }
      return;
    }
    case "declined":
      console.error("NG: the removal was declined in the Human Plane; nothing was changed.");
      terminate(4);
      break;
    case "unavailable":
      terminate(1);
      break;
    case "human-plane-unavailable":
      console.error(
        "NG: forgetting a confirmed destination requires the Agent-independent Human Plane;\n" +
          `    nothing was changed. That needs ${humanPlaneRequirement()}.`
      );
      terminate(5);
      break;
    case "vault-read-failed":
      console.error("NG: the OS secret store could not be read; no trust state was changed.");
      terminate(1);
      break;
    case "vault-delete-failed":
      console.error("NG: destination trust deletion was not confirmed; no success was reported.");
      terminate(1);
  }
}

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

async function runDeployCommand(rest: string[]): Promise<void> {
  try {
    assertProFeature("deploy");
  } catch (err) {
    if (err instanceof ProFeatureError) {
      printProFeatureRequired();
      terminate(6, { outcome: "blocked", errorCategory: "license_required" });
    }
    throw err;
  }

  const args = parseDeployArgs(rest);
  validateNameOrExit(args.name);

  const adapter = ADAPTERS.get(args.target);
  if (!adapter) {
    console.error("Unknown option. --target must be one of: cloudflare, vercel, github");
    terminate(1, { outcome: "failure", errorCategory: "invalid_input" });
  }

  const vault = createVault();
  await requireVaultAvailable(vault);

  const projectId = args.scope === "project" ? deriveProjectId(args.targetDir) : null;

  const result = await runDeploy(
    {
      vault,
      adapter,
      print: (line) => console.log(line),
      // High-risk approval is never read from this Agent-owned terminal.
      // WindowsHumanPlane opens a fixed-path plan dialog and requires the
      // HWND-bound OS verifier to return Verified. Unsupported platforms and
      // Windows builds below 22000 fail closed and provide only a handoff.
      humanPlane: createHumanPlane()
    },
    {
      name: args.name,
      scope: args.scope,
      projectId,
      projectDir: args.targetDir,
      env: args.env,
      dryRun: args.dryRun,
      force: args.force
    }
  );

  switch (result.kind) {
    case "history-unavailable":
      terminate(5, { outcome: "failure", errorCategory: "dependency_unavailable" });
      break;
    case "cli-unavailable":
      terminate(5, { outcome: "failure", errorCategory: "dependency_unavailable" });
      break;
    case "missing-secret":
      terminate(1, { outcome: "failure", errorCategory: "not_registered" });
      break;
    case "dry-run":
      terminate(0, { outcome: "blocked", errorCategory: "dry_run" });
    case "declined":
      terminate(4, { outcome: "cancelled", errorCategory: "confirmation_declined" });
      break;
    case "unavailable":
      terminate(5, { outcome: "failure", errorCategory: "dependency_unavailable" });
      break;
    case "changed":
      terminate(1, { outcome: "failure", errorCategory: "operation_failed" });
      break;
    case "executed": {
      const ok = result.handoff.exitCode === 0 && !result.handoff.timedOut;
      if (ok) {
        console.log(`OK: ${args.name} deployed to ${args.target} (${args.env}).`);
        return;
      }

      console.error(
        `NG: deploy to ${args.target} failed${result.handoff.timedOut ? " (timed out)" : ""}.`
      );
      const detail = result.handoff.stderrRedacted.trim() || result.handoff.stdoutRedacted.trim();
      if (detail) {
        console.error(detail);
      }
      if (result.handoff.timedOut || result.handoff.exitCode === null) {
        console.error(
          "The deployment result is unknown; provider changes may already exist. " +
            "Run: api-key-case history --json . and agree the next step with the human."
        );
      } else {
        console.error(
          "The provider reported a deployment failure. Run: api-key-case history --json . " +
            "and agree the next step with the human; do not retry automatically."
        );
      }
      terminate(1, {
        outcome: "failure",
        errorCategory: result.handoff.timedOut ? "timeout" : "operation_failed"
      });
    }
  }
}

function parseDeployArgs(rest: string[]): DeployArgs {
  const positionals: string[] = [];
  let target: TargetId | null = null;
  let env: DeployEnv = "development";
  let scope: SecretScope = "project";
  let dryRun = false;
  let force = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--target") {
      target = readTargetValue(rest[++i]);
    } else if (arg === "--env") {
      env = readEnvValue(rest[++i]);
    } else if (arg === "--scope") {
      scope = readScopeValue(rest[++i]);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      terminate(1, { outcome: "failure", errorCategory: "invalid_input" });
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0 || positionals.length > 2 || !target) {
    console.error(
      "Usage: api-key-case deploy <NAME> --target <cloudflare|vercel|github> " +
        "[--env production|preview|development] [--scope user|project] [--dry-run] [--force] [path]"
    );
    terminate(1, { outcome: "failure", errorCategory: "invalid_input" });
  }

  const name = positionals[0];
  const targetDir = positionals.length > 1 ? resolve(positionals[1]) : process.cwd();

  return { name, target, env, scope, dryRun, force, targetDir };
}

function printProFeatureRequired(): void {
  console.error(
    "NG: deploy is a Pro feature (one-time purchase).\n" +
      "    Your existing scan/save/check/list/remove/targets tools remain available at no charge.\n" +
      `    Get a license: ${PURCHASE_URL}\n` +
      "    Then run: api-key-case license activate"
  );
}

function readTargetValue(value: string | undefined): TargetId {
  if (value && isTargetId(value)) {
    return value;
  }
  console.error("Unknown option. --target must be one of: cloudflare, vercel, github");
  terminate(1, { outcome: "failure", errorCategory: "invalid_input" });
}

function readEnvValue(value: string | undefined): DeployEnv {
  if (value && isDeployEnv(value)) {
    return value;
  }
  console.error("Unknown option. --env must be one of: production, preview, development");
  terminate(1, { outcome: "failure", errorCategory: "invalid_input" });
}

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

// Optional, for agents — the CLI remains the primary interface (CLAUDE.md
// section 2). stdout is reserved for JSON-RPC once connected, so nothing in
// this path may console.log; diagnostics, if any, go to stderr only.
async function runMcpCommand(rest: string[]): Promise<void> {
  const targetDir = rest.length > 0 ? resolve(rest[0]) : process.cwd();
  const server = createMcpServer(targetDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// targets
// ---------------------------------------------------------------------------

async function runTargetsCommand(rest: string[]): Promise<void> {
  const args = parseTargetsArgs(rest);
  const statuses = await inspectTargets(args.targetDir, ADAPTERS.values());

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          targets: statuses.map((status) => ({
            id: status.id,
            detected: status.detected,
            detectReason: status.detectReason,
            cliInstalled: status.cliInstalled,
            cliVersion: status.cliVersion ?? null,
            loggedIn: status.loggedIn,
            hint: status.hint ?? null
          }))
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Deploy targets for ${args.targetDir}:`);
  for (const status of statuses) {
    const detectLabel = status.detected ? `detected (${status.detectReason})` : "not detected";
    const cliLabel = !status.cliInstalled
      ? "cli: not installed"
      : `cli: ${ADAPTERS.get(status.id)?.cliCommand} ${status.cliVersion ?? "?"}, ` +
        (status.loggedIn ? "logged in" : `not logged in${status.hint ? ` (run: ${status.hint})` : ""}`);
    console.log(`  ${status.id.padEnd(11)} ${detectLabel.padEnd(28)} ${cliLabel}`);
  }
}

function parseTargetsArgs(rest: string[]): TargetsArgs {
  let targetDir = process.cwd();
  let json = false;

  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      console.error("Unknown option.");
      terminate(1);
    } else {
      targetDir = resolve(arg);
    }
  }

  return { targetDir, json };
}

// ---------------------------------------------------------------------------
// license
// ---------------------------------------------------------------------------

async function runLicenseCommand(rest: string[]): Promise<void> {
  const [sub, ...subRest] = rest;

  if (sub === "activate") {
    await runObservedCommand("license_activate", undefined, () => runLicenseActivate(subRest));
    return;
  }

  if (sub === "status") {
    runLicenseStatus(subRest);
    return;
  }

  if (sub === "deactivate") {
    runLicenseDeactivate();
    return;
  }

  console.error("Usage: api-key-case license <activate|status|deactivate>");
  terminate(1);
}

async function runLicenseActivate(rest: string[]): Promise<void> {
  if (rest.length !== 0) {
    console.error("Usage: api-key-case license activate");
    terminate(1, { outcome: "failure", errorCategory: "invalid_input" });
  }

  let purchaseKey: string;
  try {
    purchaseKey = await promptPurchaseLicenseKey();
  } catch {
    console.error("NG: purchase license key input requires an interactive terminal.");
    terminate(1, { outcome: "failure", errorCategory: "non_interactive" });
  }

  let status: Extract<ReturnType<typeof readLicenseStatus>, { plan: "pro" }>;
  try {
    status = await activatePurchaseLicense(purchaseKey);
  } catch {
    console.error("NG: license activation failed. Check the key and your network connection, then retry.");
    terminate(1, { outcome: "failure", errorCategory: "license_activation_failed" });
  }

  console.log(`OK: pro license activated (license ${status.entitlementId}).`);
}

function runLicenseStatus(rest: string[]): void {
  const json = rest.includes("--json");
  const status = readLicenseStatus();

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (status.plan === "pro") {
    console.log(`plan: pro (license ${status.entitlementId}, issued ${status.issuedAt})`);
  } else {
    console.log("plan: free");
  }
}

function runLicenseDeactivate(): void {
  deactivateLicense();
  console.log("OK: license deactivated.");
}

// ---------------------------------------------------------------------------
// telemetry controls
// ---------------------------------------------------------------------------

function runTelemetryCommand(rest: string[]): void {
  const [sub, ...subRest] = rest;

  if (sub === "status" && subRest.every((arg) => arg === "--json")) {
    const status = getTelemetryStatus({ env: process.env });
    if (subRest.includes("--json")) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    console.log(`configured: ${status.configured ? "enabled" : "disabled"}`);
    console.log(`effective: ${status.effective ? "enabled" : `disabled (${status.suppression})`}`);
    console.log(`notice: ${status.noticeShown ? "shown" : "not shown"}`);
    console.log(`installation id: ${status.installationIdPresent ? "present" : "absent"}`);
    return;
  }

  if (sub === "enable" && subRest.length === 0) {
    if (!enableTelemetry()) {
      console.error("NG: telemetry setting could not be saved.");
      terminate(1);
    }
    console.log("OK: telemetry enabled.");
    return;
  }

  if (sub === "disable" && subRest.length === 0) {
    if (!disableTelemetry()) {
      console.error("NG: telemetry setting could not be saved.");
      terminate(1);
    }
    console.log("OK: telemetry disabled.");
    return;
  }

  console.error("Usage: api-key-case telemetry <status [--json]|enable|disable>");
  terminate(1);
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function readScopeValue(value: string | undefined): SecretScope {
  if (value === "user" || value === "project") {
    return value;
  }
  console.error("Unknown option.");
  terminate(1);
}

function validateNameOrExit(name: string): void {
  try {
    assertValidSecretName(name);
  } catch (err) {
    if (err instanceof SecretNameError) {
      console.error(`NG: ${err.message}`);
      terminate(1);
    }
    throw err;
  }
}

async function requireVaultAvailable(vault: { isAvailable(): Promise<boolean> }): Promise<void> {
  if (await vault.isAvailable()) {
    return;
  }

  console.error(
    "NG: no OS secret store is available on this system.\n" +
      "    macOS: Keychain should be available by default.\n" +
      "    Windows: Credential Manager should be available by default.\n" +
      "    Linux: install and unlock a Secret Service provider (e.g. gnome-keyring)."
  );
  terminate(3, { outcome: "failure", errorCategory: "dependency_unavailable" });
}

function normalizePath(dir: string): string {
  return realpathSync(dir).replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// help / version
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(`api-key-case

Usage:
  api-key-case agent-init [path] [--check] [--host agents|claude|cursor]
  api-key-case next --json [path]
  api-key-case history --json [path]
  api-key-case scan [path] [--json] [--strict]
                            [--write-env-example] [--agent-report] [--force]
  api-key-case save <NAME> [--scope user|project] [--force] [--ask]
  api-key-case check [NAME] [path] [--scope user|project] [--json] [--strict]
  api-key-case list [path] [--scope user|project] [--json]
  api-key-case remove <NAME> [--scope user|project]
  api-key-case deploy <NAME> --target <cloudflare|vercel|github>
                       [--env production|preview|development]
                       [--scope user|project] [--dry-run] [--force] [path]
  api-key-case targets [path] [--json]
  api-key-case trust status [path] [--json]
  api-key-case trust forget --target <cloudflare|vercel|github>
                       --env <production|preview|development> [path]
  api-key-case mcp [path]
  api-key-case license activate
  api-key-case license status [--json]
  api-key-case license deactivate
  api-key-case telemetry status [--json]
  api-key-case telemetry enable
  api-key-case telemetry disable

Commands:
  agent-init Initialize the Agent Control Plane and managed project instruction.
  next       Return a closed, status-only schema of semantic next actions.
  history    Inspect advisory past deploy results, never current remote values.
  scan       Check .env safety, required secret names, and likely leaked tokens.
  save       Store a secret value in the OS secret store. --ask opens the
             Agent-independent Human Plane and never reads this process's stdin.
  check      Report registered/missing status for one secret or all secrets from scan.
  list       List registered secret names and metadata (never values).
  remove     Delete a secret from the OS secret store. The decision is made in
             the Agent-independent Human Plane; there is no stdin confirmation.
  deploy     Send a stored secret to Cloudflare/Vercel/GitHub via their official CLI.
             Pro feature (one-time purchase) — the current core feature set is free.
  targets    Show which deploy targets are detected and whether their CLI is ready.
  trust      Show, or let a human forget, the deploy destinations previously
             confirmed on this machine. Forgetting only ever asks more often.
  mcp        Start an MCP server (stdio) exposing status-only tools to an agent.
             Optional, for agents — the CLI remains the primary interface.
  license    Exchange a Lemon Squeezy purchase key once, then check/deactivate
             the local Pro license. Pro checks remain fully offline afterward.
  telemetry  Show or change anonymous CLI usage telemetry. It never includes
             secret values, names, paths, scan results, or command arguments.
  version    Print package version.
  help       Print this help.

Security boundary:
  This CLI reports only status, names, file locations, and redacted findings.
  It does not print, export, or write real secret values.
  Secret values are typed by a human, stored in the OS secret store,
  and never printed, exported, or written to files by this CLI.
  Agent-first secret input uses --ask; it never falls back to an Agent-owned
  terminal when the Human Plane is unavailable.
  deploy reads a value only to hand it to the target CLI's stdin, once, and
  never places it in argv, an environment variable, a file, or a log line.
  High-risk deploys require a fixed-path Agent-independent Human Plane. On
  Windows 11 build 22000+ with Windows Hello set up, only OS user verification
  returning Verified can approve; older builds and accounts without Hello fail
  closed. The approval and execution happen in one call;
  there is no stdin, token, or flag that can skip this boundary.
  Deleting a secret and forgetting a confirmed destination use that same
  Human Plane. On Windows, an agent can ask for the dialog but cannot answer
  it without your own OS verification.
  Normal Agent-first support: Windows 11 with Windows Hello.
  macOS is a collaborative verification edition; native GUI/Accessibility
  acceptance, Intel hardware and real-Mac provider deployment are unverified.
  Verification continues toward regular support. Do not buy Pro for macOS.
  macOS approval currently uses an AppKit button, not OS identity verification.
  Linux provides diagnosis, status/history and human-owned-terminal storage
  where available; Agent-first input, approval and executing deploy are not provided.

Generated files:
  --write-env-example  Write an empty-value .env.example.
  --agent-report       Write agent-safe context and prompt Markdown files.
  --force              Replace generated files that already exist (scan),
                        overwrite an existing secret (save), or replace an
                        existing platform value first (deploy, vercel only).

Exit codes:
  0  success (including a completed --dry-run)
  1  general error (validation, not registered, target CLI error)
  2  --strict found warnings/missing secrets (scan, check)
  3  no OS secret store is available
  4  the high-risk operation or removal was declined
  5  the target CLI, Human Plane, or deploy history is unavailable/not logged in
  6  a Pro license is required (deploy)
`);
}

function printVersion(): void {
  console.log(readCliVersion());
}

function readCliVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "../../package.json"), "utf8")) as { version: string };
  return pkg.version;
}
