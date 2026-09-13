import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanProject } from "../dist/core/scanner.js";
import { renderTextReport } from "../dist/core/report.js";
import { MemoryVault } from "../dist/core/vault/memory.js";
import { deriveProjectId, toAccount } from "../dist/core/vault/naming.js";
import { assertValidSecretName, SecretNameError } from "../dist/core/vault/types.js";
import {
  readRegistry,
  upsertRegistryEntry,
  removeRegistryEntry
} from "../dist/core/vault/registry.js";
import { createVault } from "../dist/core/vault/index.js";
import { runDeploy } from "../dist/core/deploy/engine.js";
import { runWithSecret } from "../dist/core/deploy/handoff.js";
import { resolveCli } from "../dist/core/deploy/which.js";
import { ADAPTERS } from "../dist/adapters/index.js";
import { isGitHubRemoteUrl } from "../dist/adapters/github.js";
import { buildTools } from "../dist/mcp/tools.js";
import {
  assertProFeature,
  deactivateLicense,
  parseLicenseKey,
  ProFeatureError,
  PURCHASE_URL,
  readLicenseStatus,
  saveLicenseKey
} from "../dist/core/license.js";
import {
  activatePurchaseLicense,
  LICENSE_EXCHANGE_URL,
  LicenseActivationError
} from "../dist/core/license-exchange.js";
import { generateKeypairPem, isInsideRepo, issueLicenseKey } from "../tools/issue-license.mjs";

const testRoot = mkdtempSync(join(tmpdir(), "api-key-case-"));
const cliPath = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const issueLicenseToolPath = fileURLToPath(new URL("../tools/issue-license.mjs", import.meta.url));
const canaryOpenAi = ["sk-", "canaryvalue01234567890123456789"].join("");
const canaryGithub = ["ghp_", "123456789012345678901234567890123456"].join("");
const canaries = [canaryOpenAi, canaryGithub];

// ---------------------------------------------------------------------------
// Real-OS-secret-store e2e gating
// ---------------------------------------------------------------------------
//
// These two flags only decide whether the e2e blocks RUN. They do not change
// what the vault is allowed to do, do not add any way to read a value out of
// the store, and are read nowhere outside this test harness (CLAUDE.md section 3).
//
//   AGENT_KEY_CASE_E2E=1         opt in to touching the real OS secret store.
//   AGENT_KEY_CASE_E2E_STRICT=1  additionally turn "backend unavailable" from a
//                                skip into a hard failure, so a CI job whose
//                                entire purpose is to prove the keyring works
//                                cannot report success against a dead backend.
const E2E_ENABLED = process.env.AGENT_KEY_CASE_E2E === "1";
const E2E_STRICT = process.env.AGENT_KEY_CASE_E2E_STRICT === "1";
let e2eBlocksRun = 0;

function assertE2EFlagsCoherent() {
  if (E2E_STRICT && !E2E_ENABLED) {
    throw new Error(
      "AGENT_KEY_CASE_E2E_STRICT=1 requires AGENT_KEY_CASE_E2E=1. A strict run that " +
        "skips every e2e block is exactly the vacuous pass strict mode exists to prevent."
    );
  }
}

// Returns the real vault, or null when the e2e block should be skipped.
// In strict mode an unavailable backend throws instead of returning null.
async function openRealVaultForE2E(label) {
  if (!E2E_ENABLED) {
    return null;
  }

  const vault = createVault();
  if (await vault.isAvailable()) {
    e2eBlocksRun += 1;
    return vault;
  }

  if (E2E_STRICT) {
    throw new Error(
      `${label}: the OS secret store is unavailable on ${process.platform}. ` +
        "AGENT_KEY_CASE_E2E_STRICT=1 makes this a failure instead of a skip. " +
        "On Linux a D-Bus Secret Service (e.g. gnome-keyring) must be running and unlocked."
    );
  }

  console.log(`skipping ${label}: backend unavailable`);
  return null;
}

function assertE2EActuallyRanInStrictMode() {
  if (E2E_STRICT && e2eBlocksRun === 0) {
    throw new Error(
      "AGENT_KEY_CASE_E2E_STRICT=1 but no e2e block ran against the real OS secret store."
    );
  }
}

const DEPLOY_SOURCE_FILES = [
  "../packages/core/deploy/types.ts",
  "../packages/core/deploy/which.ts",
  "../packages/core/deploy/handoff.ts",
  "../packages/core/deploy/engine.ts",
  "../packages/core/license.ts",
  "../packages/core/license-exchange.ts",
  "../workers/license-exchange/src/index.ts",
  "../packages/adapters/shared.ts",
  "../packages/adapters/cloudflare.ts",
  "../packages/adapters/vercel.ts",
  "../packages/adapters/github.ts",
  "../packages/adapters/index.ts"
];

const VAULT_SOURCE_FILES = [
  "../packages/core/scanner.ts",
  "../packages/core/patterns.ts",
  "../packages/cli/index.ts",
  "../packages/cli/prompt.ts",
  "../packages/core/vault/types.ts",
  "../packages/core/vault/naming.ts",
  "../packages/core/vault/keyring.ts",
  "../packages/core/vault/memory.ts",
  "../packages/core/vault/registry.ts",
  "../packages/core/vault/index.ts"
];

const MCP_SOURCE_FILES = [
  "../packages/mcp/server.ts",
  "../packages/mcp/tools.ts",
  "../packages/mcp/messages.ts"
];

function readSources(relativePaths) {
  return relativePaths.map((path) => ({
    path,
    text: readFileSync(new URL(path, import.meta.url), "utf8")
  }));
}

try {
  assertE2EFlagsCoherent();
  testRedactionAndSafeGeneration(join(testRoot, "safe-generation"));
  testNestedGitState(join(testRoot, "nested-git"));
  testCliExitCodes(join(testRoot, "cli"));
  testSourceDoesNotExposeDangerousHelpers();
  testGetPasswordConfinedToTwoFiles();
  await testMemoryVault();
  testNaming(join(testRoot, "naming-a"), join(testRoot, "naming-b"));
  testSecretNameValidation();
  testRegistry(join(testRoot, "registry"));
  testVaultCliBoundary(join(testRoot, "vault-cli"));
  await testRealKeyringE2E();
  testGitHubRemoteDetection();
  testDeployPlansNeverCarryAValue();
  testWhichResolvesOnlyFromGivenPath(join(testRoot, "which"));
  await testEngineDryRun(join(testRoot, "engine-dry-run"));
  await testEngineMissingSecret(join(testRoot, "engine-missing"));
  await testEngineCliUnavailable(join(testRoot, "engine-cli-unavailable"));
  await testEngineDeclinedConfirmation(join(testRoot, "engine-declined"));
  await testEngineGithubAlwaysConfirms(join(testRoot, "engine-github-confirm"));
  await testHandoffPreStepFailureAbortsBeforeSecretRead(join(testRoot, "handoff-prestep-abort"));
  testDeployCliValidation(join(testRoot, "deploy-cli-validation"));
  testTargetsCliSmoke(join(testRoot, "targets-cli"));
  await testDeployE2E(join(testRoot, "deploy-e2e"));
  await testMcpToolsInProcess(join(testRoot, "mcp-in-process"));
  await testMcpProtocolSurfaceAndCanary(join(testRoot, "mcp-protocol"));
  testLicenseTerminology();
  testLicenseSignatureVerification();
  testLicenseGate(join(testRoot, "license-gate"));
  await testOnlineLicenseActivation(join(testRoot, "license-online-activation"));
  testAssertProFeatureConfinedToDeploy();
  await testMcpDeploySecretLicenseGate(join(testRoot, "mcp-license-gate"));
  testIssueLicenseTool(join(testRoot, "issue-license"));
  testLicenseCliActivateInputPaths(join(testRoot, "license-cli-activate"));
  testLicenseCliStatusAndDeactivateIsolated(join(testRoot, "license-cli-status"));
  testPackagingExcludesToolsAndLicenseMaterial();
  assertE2EActuallyRanInStrictMode();
  console.log("tests passed");
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

function testRedactionAndSafeGeneration(root) {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  write(root, ".gitignore", ".env\n.env.*\n!.env.example\n");
  write(root, ".env", `OPENAI_API_KEY=${canaryOpenAi}\n`);
  write(root, "config/.env.local", `GITHUB_TOKEN=${canaryGithub}\n`);
  write(
    root,
    ".env.example",
    "OPENAI_API_KEY=must-be-removed\nGITHUB_TOKEN=\nRESEND_API_KEY=\n"
  );
  write(
    root,
    "src/app.ts",
    [
      "const openai = process.env.OPENAI_API_KEY;",
      "const resend = process.env.RESEND_API_KEY;",
      `const leaked = "${canaryOpenAi}"; const alsoLeaked = "${canaryGithub}";`
    ].join("\n")
  );

  const report = scanProject({ targetDir: root });
  const text = renderTextReport(report);
  const json = JSON.stringify(report);

  assert.deepEqual(report.requiredSecrets, [
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "RESEND_API_KEY"
  ]);
  assert.equal(report.secretFindings.length, 2);
  assert.ok(report.secretFindings.every((finding) => finding.preview === "***REDACTED***"));
  assert.equal(report.envFiles.length, 2);
  assert.ok(report.envFiles.every((file) => file.ignored));
  assertNoCanary("text report", text);
  assertNoCanary("JSON report", json);

  const cliText = spawnSync(process.execPath, [cliPath, "scan", root], {
    encoding: "utf8"
  });
  assert.equal(cliText.status, 0);
  assertNoCanary("CLI stdout", cliText.stdout);
  assertNoCanary("CLI stderr", cliText.stderr);

  const cliJson = spawnSync(process.execPath, [cliPath, "scan", root, "--json"], {
    encoding: "utf8"
  });
  assert.equal(cliJson.status, 0);
  assertNoCanary("CLI JSON stdout", cliJson.stdout);
  assertNoCanary("CLI JSON stderr", cliJson.stderr);

  const preserved = scanProject({ targetDir: root, writeEnvExample: true });
  assert.equal(preserved.envExample.written, false);
  assert.match(preserved.envExample.reason ?? "", /preserved/);
  assert.match(readFileSync(join(root, ".env.example"), "utf8"), /must-be-removed/);

  const forced = scanProject({ targetDir: root, writeEnvExample: true, force: true });
  assert.equal(forced.envExample.written, true);
  const generatedExample = readFileSync(join(root, ".env.example"), "utf8");
  assert.match(generatedExample, /OPENAI_API_KEY=\n/);
  assert.equal(generatedExample.includes("must-be-removed"), false);
  for (const line of generatedExample.split(/\r?\n/)) {
    if (line && !line.startsWith("#")) {
      assert.match(line, /^[A-Z][A-Z0-9_]+=$/);
    }
  }
  assertNoCanary(".env.example", generatedExample);

  const agentReport = scanProject({ targetDir: root, agentReport: true });
  assert.equal(agentReport.agentReport.files.length, 2);
  assert.ok(agentReport.agentReport.files.every((file) => file.written));

  for (const path of ["AGENT_CONTEXT.safe.md", "AI_SAFE_PROMPT.md"]) {
    const content = readFileSync(join(root, path), "utf8");
    assertNoCanary(path, content);
  }

  write(root, "AGENT_CONTEXT.safe.md", "keep this custom file\n");
  const preservedReport = scanProject({ targetDir: root, agentReport: true });
  const contextState = preservedReport.agentReport.files.find(
    (file) => file.path === "AGENT_CONTEXT.safe.md"
  );
  assert.equal(contextState?.written, false);
  assert.equal(readFileSync(join(root, "AGENT_CONTEXT.safe.md"), "utf8"), "keep this custom file\n");
}

function testNestedGitState(root) {
  mkdirSync(join(root, "nested"), { recursive: true });
  write(root, ".gitignore", "**/.env*\n!.env.example\n");
  write(root, "nested/.env.production", `SERVICE_API_KEY=${canaryOpenAi}\n`);
  write(root, "app.ts", "const key = process.env.SERVICE_API_KEY;\n");

  git(root, ["init"]);
  git(root, ["config", "user.name", "API Key Case Tests"]);
  git(root, ["config", "user.email", "tests@example.invalid"]);
  git(root, ["add", ".gitignore", "app.ts"]);
  git(root, ["add", "-f", "nested/.env.production"]);
  git(root, ["commit", "-m", "Add nested env fixture"]);

  const report = scanProject({ targetDir: root });
  const nested = report.envFiles.find((file) => file.file === "nested/.env.production");
  assert.equal(nested?.ignored, true);
  assert.equal(nested?.tracked, true);
  assert.equal(nested?.seenInHistory, true);
  assertNoCanary("nested git report", JSON.stringify(report));
}

function testCliExitCodes(root) {
  mkdirSync(root, { recursive: true });
  write(root, "app.ts", "const token = process.env.TEST_API_KEY;\n");

  const strict = spawnSync(process.execPath, [cliPath, "scan", root, "--strict"], {
    encoding: "utf8"
  });
  assert.equal(strict.status, 2);

  const json = spawnSync(process.execPath, [cliPath, "scan", root, "--json"], {
    encoding: "utf8"
  });
  assert.equal(json.status, 0);
  assert.doesNotThrow(() => JSON.parse(json.stdout));

  const secretLikePath = join(root, canaryOpenAi);
  const invalid = spawnSync(process.execPath, [cliPath, "scan", secretLikePath], {
    encoding: "utf8"
  });
  assert.equal(invalid.status, 1);
  assertNoCanary("CLI stderr", invalid.stderr);
}

function testSourceDoesNotExposeDangerousHelpers() {
  const sourceText = readSources([...VAULT_SOURCE_FILES, ...DEPLOY_SOURCE_FILES, ...MCP_SOURCE_FILES])
    .map((file) => file.text)
    .join("\n");

  for (const forbidden of [
    "get_secret",
    "print_secret",
    "show_raw_value",
    "export_all_secrets",
    "write_secret_to_env",
    "send_secret_to_url"
  ]) {
    assert.equal(sourceText.includes(forbidden), false, `${forbidden} must not exist in source`);
  }
}

function testGetPasswordConfinedToTwoFiles() {
  const allowed = new Set(["../packages/core/vault/keyring.ts", "../packages/core/deploy/handoff.ts"]);
  const offenders = readSources([...VAULT_SOURCE_FILES, ...DEPLOY_SOURCE_FILES, ...MCP_SOURCE_FILES])
    .filter((file) => file.text.includes("getPassword") && !allowed.has(file.path))
    .map((file) => file.path);

  assert.deepEqual(offenders, [], "getPassword must only be called from vault/keyring.ts and deploy/handoff.ts");
}

async function testMemoryVault() {
  const vault = new MemoryVault();
  const refA = { name: "OPENAI_API_KEY", scope: "project", projectId: "proj-a" };
  const refB = { name: "OPENAI_API_KEY", scope: "project", projectId: "proj-b" };
  const refUser = { name: "OPENAI_API_KEY", scope: "user", projectId: null };

  assert.equal(await vault.hasSecret(refA), false);
  await vault.setSecret(refA, canaryOpenAi);
  assert.equal(await vault.hasSecret(refA), true);

  // Different projectId -> different entry.
  assert.equal(await vault.hasSecret(refB), false);
  // Different scope (user vs project) -> different entry even with same name.
  assert.equal(await vault.hasSecret(refUser), false);

  assert.equal(await vault.deleteSecret(refA), true);
  assert.equal(await vault.hasSecret(refA), false);
  assert.equal(await vault.deleteSecret(refA), false);
}

function testNaming(dirA, dirB) {
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });

  const idLower = deriveProjectId(dirA);
  const idWithSlash = deriveProjectId(dirA + "/");
  assert.equal(idLower, idWithSlash);
  assert.match(idLower, /^[0-9a-f]{16}$/);

  const idOther = deriveProjectId(dirB);
  assert.notEqual(idLower, idOther);

  const account = toAccount({ name: "OPENAI_API_KEY", scope: "project", projectId: idLower });
  assert.equal(account, `v1|project|${idLower}|OPENAI_API_KEY`);
  const userAccount = toAccount({ name: "OPENAI_API_KEY", scope: "user", projectId: null });
  assert.equal(userAccount, "v1|user|-|OPENAI_API_KEY");
}

function testSecretNameValidation() {
  for (const name of ["OPENAI_API_KEY", "A", "A".repeat(128)]) {
    assert.doesNotThrow(() => assertValidSecretName(name));
  }

  for (const name of ["openai_api_key", "1BAD", "BAD-NAME", "A".repeat(129), ""]) {
    assert.throws(() => assertValidSecretName(name), SecretNameError);
  }
}

function testRegistry(baseDir) {
  mkdirSync(baseDir, { recursive: true });

  assert.deepEqual(readRegistry(baseDir), []);

  upsertRegistryEntry(
    { name: "OPENAI_API_KEY", scope: "project", projectId: "proj-a", projectPath: "/tmp/a" },
    baseDir
  );
  let entries = readRegistry(baseDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "OPENAI_API_KEY");

  const indexContent = readFileSync(join(baseDir, ".api-key-case", "index.json"), "utf8");
  assertNoCanary("registry index", indexContent);
  assert.equal(indexContent.includes(canaryOpenAi), false);

  upsertRegistryEntry(
    { name: "OPENAI_API_KEY", scope: "project", projectId: "proj-a", projectPath: "/tmp/a2" },
    baseDir
  );
  entries = readRegistry(baseDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].projectPath, "/tmp/a2");

  removeRegistryEntry({ name: "OPENAI_API_KEY", scope: "project", projectId: "proj-a" }, baseDir);
  assert.deepEqual(readRegistry(baseDir), []);

  // Corrupted index file must not crash reads.
  writeFileSync(join(baseDir, ".api-key-case", "index.json"), "{not json", "utf8");
  const warnings = [];
  const originalConsoleError = console.error;
  console.error = (...args) => warnings.push(args.join(" "));
  try {
    assert.deepEqual(readRegistry(baseDir), []);
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(warnings, ["Warning: vault index is corrupted; treating it as empty."]);
}

function testVaultCliBoundary(root) {
  mkdirSync(root, { recursive: true });

  const pipedSave = spawnSync(process.execPath, [cliPath, "save", "AKC_TEST_PIPED_KEY"], {
    encoding: "utf8",
    input: `${canaryOpenAi}\n`,
    cwd: root
  });
  assert.equal(pipedSave.status, 1);
  assertNoCanary("piped save stdout", pipedSave.stdout);
  assertNoCanary("piped save stderr", pipedSave.stderr);

  const positionalSave = spawnSync(
    process.execPath,
    [cliPath, "save", "AKC_TEST_POSITIONAL_KEY", canaryOpenAi],
    { encoding: "utf8", cwd: root }
  );
  assert.equal(positionalSave.status, 1);
  assert.match(positionalSave.stderr, /rotate/i);
  assertNoCanary("positional save stdout", positionalSave.stdout);
  assertNoCanary("positional save stderr", positionalSave.stderr);

  const badName = spawnSync(process.execPath, [cliPath, "save", "not-a-valid-name"], {
    encoding: "utf8",
    cwd: root
  });
  assert.equal(badName.status, 1);

  const badRemoveName = spawnSync(process.execPath, [cliPath, "remove", "not-a-valid-name", "--yes"], {
    encoding: "utf8",
    cwd: root
  });
  assert.equal(badRemoveName.status, 1);

  const checkUnknown = spawnSync(process.execPath, [cliPath, "check", "AKC_TEST_UNKNOWN_KEY"], {
    encoding: "utf8",
    cwd: root
  });
  assert.ok(checkUnknown.status === 0 || checkUnknown.status === 3);
  if (checkUnknown.status === 0) {
    assert.match(checkUnknown.stdout, /^NG:/);
  }

  const checkStrict = spawnSync(
    process.execPath,
    [cliPath, "check", "AKC_TEST_UNKNOWN_KEY", "--strict"],
    { encoding: "utf8", cwd: root }
  );
  assert.ok(checkStrict.status === 2 || checkStrict.status === 3);
}

async function testRealKeyringE2E() {
  const vault = await openRealVaultForE2E("real keyring e2e");
  if (!vault) {
    return;
  }

  const ref = { name: "AKC_E2E_TEST_KEY", scope: "user", projectId: null };
  try {
    await vault.setSecret(ref, "e2e-test-value");
    assert.equal(await vault.hasSecret(ref), true);
  } finally {
    await vault.deleteSecret(ref);
  }
  assert.equal(await vault.hasSecret(ref), false);
}

// ---------------------------------------------------------------------------
// deploy (Phase 3) test fixtures and cases
// ---------------------------------------------------------------------------

function fakeCliScript() {
  return [
    'import { writeFileSync } from "node:fs";',
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { input += chunk; });',
    'process.stdin.on("end", () => {',
    "  const recordPath = process.env.AKC_FAKE_RECORD;",
    "  if (recordPath) {",
    '    writeFileSync(recordPath, JSON.stringify({ argv: process.argv.slice(2), stdin: input }), "utf8");',
    "  }",
    '  if (process.env.AKC_FAKE_ECHO === "1" && input) {',
    "    process.stdout.write(input);",
    "  }",
    "  if (process.env.AKC_FAKE_STDERR) {",
    "    process.stderr.write(process.env.AKC_FAKE_STDERR);",
    "  }",
    '  process.exitCode = Number(process.env.AKC_FAKE_EXIT || "0");',
    "});",
    "process.stdin.resume();",
    ""
  ].join("\n");
}

// A test-only stand-in for wrangler/vercel/gh: records what it received on
// stdin/argv to a file so tests can assert the value path without ever
// touching a real cloud account. which.ts's pathOverride keeps it out of
// the real PATH-based resolution used by the actual adapters.
function createFakeCli(dir) {
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, "akc-fake-cli.mjs");
  writeFileSync(scriptPath, fakeCliScript(), "utf8");

  if (process.platform === "win32") {
    writeFileSync(join(dir, "akc-fake-cli.cmd"), `@echo off\r\nnode "${scriptPath}" %*\r\n`, "utf8");
  } else {
    const binPath = join(dir, "akc-fake-cli");
    writeFileSync(binPath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, "utf8");
    chmodSync(binPath, 0o755);
  }

  return { pathOverride: dir, cliCommand: "akc-fake-cli" };
}

function createFakeAdapter(fixture, overrides = {}) {
  const id = overrides.id ?? "cloudflare";
  const cliCommand = fixture.cliCommand;
  const installed = overrides.installed ?? true;
  const loggedIn = overrides.loggedIn ?? true;
  const detected = overrides.detected ?? true;

  return {
    id,
    cliCommand,
    async detect() {
      return { detected, reason: "fake adapter" };
    },
    async checkCli() {
      return {
        installed,
        loggedIn,
        version: "0.0.0",
        hint: installed && loggedIn ? undefined : `${cliCommand} login`
      };
    },
    planDeploy(name, env, opts) {
      const argv = overrides.argv ? overrides.argv(name, env, opts) : [cliCommand, "set", name, env];
      return {
        argv,
        valueVia: "stdin",
        displayCommand: argv.join(" "),
        overwriteWarning: overrides.overwriteWarning ?? false,
        preSteps: overrides.preSteps ? overrides.preSteps(name, env, opts) : undefined
      };
    },
    manualSteps(name) {
      return [`install ${cliCommand}`, `${cliCommand} login`, `${cliCommand} set ${name}`];
    }
  };
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(overrides)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

// Signs and saves a throwaway pro license under baseDir, using a
// fresh keypair generated for this call only — never the real embedded
// signing key (phase-5-license.md §9: "固定鍵をリポジトリにコミットしない").
// Returns a LicenseOptions ready to hand to readLicenseStatus/assertProFeature/buildTools.
function testProLicenseOptions(baseDir, entitlementId = "ent_test_0001") {
  const { publicKeyPem, privateKeyPem } = generateKeypairPem();
  const key = issueLicenseKey(privateKeyPem, entitlementId, "2026-01-01");
  saveLicenseKey(key, baseDir);
  return { baseDir, publicKey: createPublicKey(publicKeyPem) };
}

function testDeployPlansNeverCarryAValue() {
  for (const adapter of ADAPTERS.values()) {
    for (const env of ["production", "preview", "development"]) {
      const plan = adapter.planDeploy("AKC_TEST_KEY", env, { force: true });
      assert.ok(Array.isArray(plan.argv));
      assert.equal(plan.valueVia, "stdin");
      for (const token of plan.argv) {
        assert.equal(typeof token, "string");
      }
      assertNoCanary(`${adapter.id}/${env} argv`, plan.argv.join(" "));
      assertNoCanary(`${adapter.id}/${env} displayCommand`, plan.displayCommand);
      for (const step of plan.preSteps ?? []) {
        assertNoCanary(`${adapter.id}/${env} preStep displayCommand`, step.displayCommand);
      }
    }
  }
}

function testGitHubRemoteDetection() {
  for (const remote of [
    "https://github.com/melavern/api-key-case.git",
    "ssh://git@github.com/melavern/api-key-case.git",
    "git://GITHUB.COM/melavern/api-key-case.git",
    "git@github.com:melavern/api-key-case.git",
    "github.com:melavern/api-key-case.git"
  ]) {
    assert.equal(isGitHubRemoteUrl(remote), true, `expected GitHub remote: ${remote}`);
  }

  for (const remote of [
    "https://github.com.evil.example/owner/repo.git",
    "https://evil.example/github.com/owner/repo.git",
    "git@github.com.evil.example:owner/repo.git",
    "notgithub.com:owner/repo.git",
    "C:\\tmp\\github.com\\owner\\repo"
  ]) {
    assert.equal(isGitHubRemoteUrl(remote), false, `expected non-GitHub remote: ${remote}`);
  }
}

function testWhichResolvesOnlyFromGivenPath(root) {
  const fixture = createFakeCli(root);

  const resolved = resolveCli(fixture.cliCommand, fixture.pathOverride);
  assert.ok(resolved, "fake cli should resolve via pathOverride");
  assert.ok(existsSync(resolved.absolutePath));

  const missing = resolveCli(fixture.cliCommand, join(root, "empty-path-dir"));
  assert.equal(missing, null);
}

async function testEngineDryRun(root) {
  const fixture = createFakeCli(root);
  const adapter = createFakeAdapter(fixture);
  const vault = new MemoryVault();
  const ref = { name: "AKC_TEST_DRYRUN", scope: "project", projectId: "proj-dry" };
  await vault.setSecret(ref, canaryOpenAi);

  const recordPath = join(root, "record.json");
  await withEnv({ AKC_FAKE_RECORD: recordPath }, async () => {
    const printed = [];
    const result = await runDeploy(
      {
        vault,
        adapter,
        print: (line) => printed.push(line),
        confirmProduction: async () => true,
        pathOverride: fixture.pathOverride
      },
      {
        name: ref.name,
        scope: ref.scope,
        projectId: ref.projectId,
        projectDir: root,
        env: "development",
        dryRun: true,
        force: false
      }
    );

    assert.equal(result.kind, "dry-run");
    assert.ok(printed.some((line) => line.includes("Deploy plan:")));
    assert.equal(existsSync(recordPath), false, "dry-run must not spawn the target CLI");
    assertNoCanary("dry-run printed output", printed.join("\n"));
  });
}

async function testEngineMissingSecret(root) {
  const fixture = createFakeCli(root);
  const adapter = createFakeAdapter(fixture);
  const vault = new MemoryVault();

  const printedProject = [];
  const resultProject = await runDeploy(
    {
      vault,
      adapter,
      print: (line) => printedProject.push(line),
      confirmProduction: async () => true,
      pathOverride: fixture.pathOverride
    },
    {
      name: "AKC_TEST_MISSING",
      scope: "project",
      projectId: "proj-x",
      projectDir: root,
      env: "development",
      dryRun: false,
      force: false
    }
  );
  assert.equal(resultProject.kind, "missing-secret");
  assert.ok(printedProject.some((line) => /Try --scope user/.test(line)));

  const printedUser = [];
  const resultUser = await runDeploy(
    {
      vault,
      adapter,
      print: (line) => printedUser.push(line),
      confirmProduction: async () => true,
      pathOverride: fixture.pathOverride
    },
    { name: "AKC_TEST_MISSING", scope: "user", projectId: null, projectDir: root, env: "development", dryRun: false, force: false }
  );
  assert.equal(resultUser.kind, "missing-secret");
  assert.ok(printedUser.some((line) => line.includes("NG:")));
  assert.ok(printedUser.every((line) => !line.includes("--scope user")));
}

async function testEngineCliUnavailable(root) {
  const fixture = createFakeCli(root);
  const adapter = createFakeAdapter(fixture, { installed: false, loggedIn: false });
  const vault = new MemoryVault();
  const ref = { name: "AKC_TEST_CLI_DOWN", scope: "project", projectId: "proj-cli" };
  await vault.setSecret(ref, canaryOpenAi);

  const printed = [];
  const result = await runDeploy(
    {
      vault,
      adapter,
      print: (line) => printed.push(line),
      confirmProduction: async () => true,
      pathOverride: fixture.pathOverride
    },
    { name: ref.name, scope: ref.scope, projectId: ref.projectId, projectDir: root, env: "development", dryRun: false, force: false }
  );

  assert.equal(result.kind, "cli-unavailable");
  assert.ok(printed.some((line) => line.includes("install")));
}

async function testEngineDeclinedConfirmation(root) {
  const fixture = createFakeCli(root);
  const adapter = createFakeAdapter(fixture);
  const vault = new MemoryVault();
  const ref = { name: "AKC_TEST_DECLINE", scope: "project", projectId: "proj-decline" };
  await vault.setSecret(ref, canaryOpenAi);

  const recordPath = join(root, "record.json");
  await withEnv({ AKC_FAKE_RECORD: recordPath }, async () => {
    let confirmCalls = 0;
    const result = await runDeploy(
      {
        vault,
        adapter,
        print: () => {},
        confirmProduction: async () => {
          confirmCalls++;
          return false;
        },
        pathOverride: fixture.pathOverride
      },
      { name: ref.name, scope: ref.scope, projectId: ref.projectId, projectDir: root, env: "production", dryRun: false, force: false }
    );

    assert.equal(result.kind, "declined");
    assert.equal(confirmCalls, 1);
    assert.equal(existsSync(recordPath), false, "declined production deploy must not spawn the target CLI");
  });
}

async function testEngineGithubAlwaysConfirms(root) {
  const fixture = createFakeCli(root);
  const adapter = createFakeAdapter(fixture, { id: "github" });
  const vault = new MemoryVault();
  const ref = { name: "AKC_TEST_GH_CONFIRM", scope: "project", projectId: "proj-gh" };
  await vault.setSecret(ref, canaryOpenAi);

  let confirmCalls = 0;
  const result = await runDeploy(
    {
      vault,
      adapter,
      print: () => {},
      confirmProduction: async () => {
        confirmCalls++;
        return false;
      },
      pathOverride: fixture.pathOverride
    },
    { name: ref.name, scope: ref.scope, projectId: ref.projectId, projectDir: root, env: "development", dryRun: false, force: false }
  );

  assert.equal(result.kind, "declined");
  assert.equal(confirmCalls, 1, "github target must require confirmation even for a non-production env");
}

// Does not require the real OS keyring: a preStep failure must short-circuit
// runWithSecret before it ever reads the secret, so a never-registered NAME
// is safe to use here (if the code regressed and tried to read it anyway,
// runWithSecret would throw SecretNotRegisteredError and fail this test loudly).
async function testHandoffPreStepFailureAbortsBeforeSecretRead(root) {
  const fixture = createFakeCli(root);
  const preRecord = join(root, "pre-record.json");

  const plan = {
    argv: [fixture.cliCommand, "main"],
    valueVia: "stdin",
    displayCommand: "fake main",
    overwriteWarning: false,
    preSteps: [
      {
        argv: [fixture.cliCommand, "pre"],
        valueVia: "stdin",
        displayCommand: "fake pre",
        overwriteWarning: false
      }
    ]
  };

  await withEnv({ AKC_FAKE_RECORD: preRecord, AKC_FAKE_EXIT: "1" }, async () => {
    const vault = new MemoryVault();
    const ref = { name: `AKC_TEST_NEVER_REGISTERED_${Date.now()}`, scope: "user", projectId: null };

    const result = await runWithSecret(vault, ref, plan, { pathOverride: fixture.pathOverride });

    assert.equal(result.exitCode, 1);
    assert.equal(existsSync(preRecord), true, "preStep should have run");
    const preRecordContent = JSON.parse(readFileSync(preRecord, "utf8"));
    assert.equal(preRecordContent.stdin, "", "preStep must not receive the secret on stdin");
  });
}

// The Pro-license gate (phase-5-license.md §4.3) runs before argument
// parsing in the CLI's deploy branch by design, so every one of these
// (otherwise-invalid) invocations hits exit 6 first in an unlicensed
// environment. isolatedHomeEnv() guarantees "unlicensed" regardless of
// whether the machine running these tests has ever activated a real
// license — without it this test would be flaky on a maintainer's own
// dev box after they buy their own Pro license.
function testDeployCliValidation(root) {
  mkdirSync(root, { recursive: true });

  const cases = [
    [cliPath, "deploy", "AKC_TEST_KEY"],
    [cliPath, "deploy", "AKC_TEST_KEY", "--target", "aws"],
    [cliPath, "deploy", "AKC_TEST_KEY", "--target", "cloudflare", "--env", "staging"],
    [cliPath, "deploy", "not-a-valid-name", "--target", "cloudflare"]
  ];

  for (const args of cases) {
    const result = spawnSync(process.execPath, args, {
      encoding: "utf8",
      cwd: root,
      env: isolatedHomeEnv(root)
    });
    assert.equal(result.status, 6, `expected exit 6 (Pro required) for: ${args.join(" ")}`);
    assert.match(result.stderr, /Pro feature/);
    assert.match(result.stderr, /license activate/);
    assertNoCanary("deploy validation stdout", result.stdout);
    assertNoCanary("deploy validation stderr", result.stderr);
  }
}

function testTargetsCliSmoke(root) {
  mkdirSync(root, { recursive: true });
  const result = spawnSync(process.execPath, [cliPath, "targets", root, "--json"], {
    encoding: "utf8",
    timeout: 60_000
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  const ids = parsed.targets.map((t) => t.id).sort();
  assert.deepEqual(ids, ["cloudflare", "github", "vercel"]);
  assertNoCanary("targets stdout", result.stdout);
}

// Everything below requires a real OS secret store and is skipped unless
// AGENT_KEY_CASE_E2E=1 (see openRealVaultForE2E), matching testRealKeyringE2E's
// pattern (Phase 2).
// handoff.ts is hardwired to the real keyring by design (§2-9 of
// phase-3-deploy.md), so any test that reaches the actual spawn step must
// use the real backend, not MemoryVault.
async function testDeployE2E(root) {
  const vault = await openRealVaultForE2E("deploy e2e");
  if (!vault) {
    return;
  }

  const fixture = createFakeCli(root);
  const name = "AKC_E2E_DEPLOY_KEY";
  const ref = { name, scope: "user", projectId: null };
  const recordPath = join(root, "record.json");

  await vault.setSecret(ref, canaryOpenAi);
  try {
    await withEnv({ AKC_FAKE_RECORD: recordPath, AKC_FAKE_ECHO: "0", AKC_FAKE_EXIT: "0" }, async () => {
      // 1) value path: canary flows vault -> fake CLI stdin, and never
      // appears in argv, printed lines, or the HandoffResult.
      const printed = [];
      const result = await runDeploy(
        {
          vault,
          adapter: createFakeAdapter(fixture),
          print: (line) => printed.push(line),
          confirmProduction: async () => true,
          pathOverride: fixture.pathOverride
        },
        { name, scope: "user", projectId: null, projectDir: root, env: "development", dryRun: false, force: false }
      );

      assert.equal(result.kind, "executed");
      assert.equal(result.handoff.exitCode, 0);
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      assert.equal(record.stdin, canaryOpenAi);
      assert.equal(record.argv.join(" ").includes(canaryOpenAi), false);
      assertNoCanary("handoff stdout", result.handoff.stdoutRedacted);
      assertNoCanary("handoff stderr", result.handoff.stderrRedacted);
      assertNoCanary("engine printed lines", printed.join("\n"));
    });

    // 2) scrub: the fake CLI echoes stdin back; the echoed canary must be
    // redacted, never shown raw.
    rmSync(recordPath, { force: true });
    await withEnv({ AKC_FAKE_RECORD: recordPath, AKC_FAKE_ECHO: "1", AKC_FAKE_EXIT: "0" }, async () => {
      const scrubResult = await runDeploy(
        {
          vault,
          adapter: createFakeAdapter(fixture),
          print: () => {},
          confirmProduction: async () => true,
          pathOverride: fixture.pathOverride
        },
        { name, scope: "user", projectId: null, projectDir: root, env: "development", dryRun: false, force: false }
      );
      assert.equal(scrubResult.kind, "executed");
      assert.ok(scrubResult.handoff.stdoutRedacted.includes("***REDACTED***"));
      assertNoCanary("scrubbed echo stdout", scrubResult.handoff.stdoutRedacted);
    });

    // 3) short secret (<8 chars): withhold the whole output rather than
    // risk an unsafe partial redaction.
    const shortRef = { name: "AKC_E2E_SHORT_KEY", scope: "user", projectId: null };
    await vault.setSecret(shortRef, "short1");
    try {
      await withEnv({ AKC_FAKE_RECORD: recordPath, AKC_FAKE_ECHO: "1", AKC_FAKE_EXIT: "0" }, async () => {
        const shortResult = await runDeploy(
          {
            vault,
            adapter: createFakeAdapter(fixture),
            print: () => {},
            confirmProduction: async () => true,
            pathOverride: fixture.pathOverride
          },
          { name: shortRef.name, scope: "user", projectId: null, projectDir: root, env: "development", dryRun: false, force: false }
        );
        assert.equal(shortResult.kind, "executed");
        assert.match(shortResult.handoff.stdoutRedacted, /too short to redact safely/);
      });
    } finally {
      await vault.deleteSecret(shortRef);
    }

    // 4) --force preStep ordering: preStep (no stdin) must complete before
    // the main step (which carries the value) runs. Both write to the same
    // record file, so the main step's write is the one still on disk after
    // a successful run; if the preStep had blocked it, the record would
    // still hold the preStep's empty stdin instead.
    rmSync(recordPath, { force: true });
    await withEnv({ AKC_FAKE_RECORD: recordPath, AKC_FAKE_ECHO: "0", AKC_FAKE_EXIT: "0" }, async () => {
      const forceAdapter = createFakeAdapter(fixture, {
        argv: (n) => [fixture.cliCommand, "main", n],
        preSteps: (n) => [
          {
            argv: [fixture.cliCommand, "pre", n],
            valueVia: "stdin",
            displayCommand: "fake pre",
            overwriteWarning: false
          }
        ]
      });

      const forceResult = await runDeploy(
        {
          vault,
          adapter: forceAdapter,
          print: () => {},
          confirmProduction: async () => true,
          pathOverride: fixture.pathOverride
        },
        { name, scope: "user", projectId: null, projectDir: root, env: "development", dryRun: false, force: true }
      );
      assert.equal(forceResult.kind, "executed");
      const forceRecord = JSON.parse(readFileSync(recordPath, "utf8"));
      assert.equal(forceRecord.stdin, canaryOpenAi, "main step should run and receive the value after the preStep succeeds");
    });
  } finally {
    await vault.deleteSecret(ref);
  }
}

// ---------------------------------------------------------------------------
// mcp (Phase 4) test fixtures and cases
// ---------------------------------------------------------------------------

// In-process handler tests: no real keyring or spawned CLI is reachable
// through these paths, so unlike the process-level test below these need no
// AGENT_KEY_CASE_E2E gate (phase-4-mcp.md section 7 item 5).
async function testMcpToolsInProcess(root) {
  const fixtureRoot = join(root, "project");
  mkdirSync(fixtureRoot, { recursive: true });
  write(fixtureRoot, ".gitignore", ".env\n.env.*\n!.env.example\n");
  write(fixtureRoot, "app.ts", "const key = process.env.MCP_TEST_KEY;\n");

  const fixture = createFakeCli(join(root, "cli"));
  const adapters = new Map([["cloudflare", createFakeAdapter(fixture, { id: "cloudflare" })]]);
  const licenseOptions = testProLicenseOptions(join(root, "license-home"));

  // production / github must never reach the vault or spawn the adapter CLI.
  {
    const vault = new MemoryVault();
    const tools = buildTools({
      defaultProjectDir: fixtureRoot,
      createVault: () => vault,
      adapters,
      pathOverride: fixture.pathOverride
    });
    const recordPath = join(root, "record-prod.json");

    await withEnv({ AKC_FAKE_RECORD: recordPath }, async () => {
      const prodResult = await tools.deploy_secret({
        name: "MCP_TEST_KEY",
        target: "cloudflare",
        env: "production"
      });
      assert.equal(prodResult.structuredContent?.action, "action_required");
      assert.match(prodResult.content[0].text, /action_required/);
      assert.equal(existsSync(recordPath), false, "production deploy must never spawn the target CLI");

      const githubResult = await tools.deploy_secret({
        name: "MCP_TEST_KEY",
        target: "github",
        env: "development"
      });
      assert.equal(githubResult.structuredContent?.action, "action_required");
      assert.equal(
        existsSync(recordPath),
        false,
        "github deploy must never spawn the target CLI regardless of env"
      );
    });
  }

  // development + dryRun: plan only, never spawns the adapter CLI.
  {
    const vault = new MemoryVault();
    await vault.setSecret(
      { name: "MCP_TEST_KEY", scope: "project", projectId: deriveProjectId(fixtureRoot) },
      canaryOpenAi
    );
    const tools = buildTools({
      defaultProjectDir: fixtureRoot,
      createVault: () => vault,
      adapters,
      pathOverride: fixture.pathOverride,
      licenseOptions
    });
    const recordPath = join(root, "record-dry.json");

    await withEnv({ AKC_FAKE_RECORD: recordPath }, async () => {
      const dryResult = await tools.deploy_secret({
        name: "MCP_TEST_KEY",
        target: "cloudflare",
        env: "development",
        dryRun: true
      });
      assert.equal(dryResult.structuredContent?.status, "dry-run");
      assert.equal(existsSync(recordPath), false, "dry-run must not spawn the target CLI");
      assertNoCanary("dry-run mcp text", dryResult.content[0].text);
    });
  }

  // missing secret: reported as a normal status, not an isError.
  {
    const vault = new MemoryVault();
    const tools = buildTools({
      defaultProjectDir: fixtureRoot,
      createVault: () => vault,
      adapters,
      pathOverride: fixture.pathOverride,
      licenseOptions
    });
    const missingResult = await tools.deploy_secret({
      name: "MCP_TEST_MISSING",
      target: "cloudflare",
      env: "development"
    });
    assert.equal(missingResult.structuredContent?.status, "missing-secret");
    assert.equal(missingResult.isError, undefined);
  }

  // save_secret never calls the vault at all.
  {
    const vault = new MemoryVault();
    let hasSecretCalls = 0;
    let setSecretCalls = 0;
    const originalHasSecret = vault.hasSecret.bind(vault);
    const originalSetSecret = vault.setSecret.bind(vault);
    vault.hasSecret = async (...callArgs) => {
      hasSecretCalls++;
      return originalHasSecret(...callArgs);
    };
    vault.setSecret = async (...callArgs) => {
      setSecretCalls++;
      return originalSetSecret(...callArgs);
    };

    const tools = buildTools({
      defaultProjectDir: fixtureRoot,
      createVault: () => vault,
      adapters,
      pathOverride: fixture.pathOverride
    });
    const result = await tools.save_secret({ name: "MCP_TEST_KEY", scope: "project" });
    assert.equal(result.structuredContent?.action, "action_required");
    assert.match(result.content[0].text, /api-key-case save MCP_TEST_KEY/);
    assert.equal(hasSecretCalls, 0);
    assert.equal(setSecretCalls, 0);
  }

  // error formatting: a fixed NG text, never a raw exception or stack trace.
  {
    const vault = new MemoryVault();
    const tools = buildTools({
      defaultProjectDir: fixtureRoot,
      createVault: () => vault,
      adapters,
      pathOverride: fixture.pathOverride
    });
    const result = await tools.list_required_secrets({ path: join(root, "does-not-exist") });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^NG:/);
    assert.equal(result.content[0].text.toLowerCase().includes(" at "), false);
  }
}

function createMcpClient(targetDir) {
  const child = spawn(process.execPath, [cliPath, "mcp", targetDir], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  let rawStdout = "";
  let stderrText = "";
  let buffer = "";
  let nextId = 1;
  const pending = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    rawStdout += chunk;
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrText += chunk;
  });

  function send(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolvePromise) => {
      pending.set(id, resolvePromise);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  return {
    async initialize() {
      const response = await send("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "api-key-case-tests", version: "0.0.0" }
      });
      notify("notifications/initialized");
      return response;
    },
    listTools: () => send("tools/list", {}),
    callTool: (name, toolArgs) => send("tools/call", { name, arguments: toolArgs }),
    get rawStdout() {
      return rawStdout;
    },
    get stderrText() {
      return stderrText;
    },
    close() {
      child.stdin.end();
      child.kill();
    }
  };
}

// The most important MCP test (phase-4-mcp.md section 7 item 1): spawn the
// real server against a fixture holding a canary secret, drive it over raw
// JSON-RPC exactly as an agent host would, and confirm the canary never
// appears anywhere on stdout. Also covers item 2 (tool surface + schema).
async function testMcpProtocolSurfaceAndCanary(root) {
  mkdirSync(root, { recursive: true });
  write(root, ".gitignore", ".env\n.env.*\n!.env.example\n");
  write(root, ".env", `OPENAI_API_KEY=${canaryOpenAi}\n`);
  write(root, "app.ts", "const key = process.env.OPENAI_API_KEY;\n");

  const client = createMcpClient(root);
  try {
    const init = await client.initialize();
    assert.equal(init.error, undefined, "initialize must not fail");

    const list = await client.listTools();
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "check_gitignore",
      "check_secret",
      "deploy_secret",
      "generate_env_example",
      "list_required_secrets",
      "save_secret",
      "scan_secret_leaks"
    ]);

    const saveSecretTool = list.result.tools.find((t) => t.name === "save_secret");
    const saveProps = Object.keys(saveSecretTool.inputSchema.properties ?? {});
    assert.deepEqual(saveProps.sort(), ["name", "scope"]);

    for (const tool of list.result.tools) {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      for (const forbidden of ["value", "secret", "password"]) {
        assert.equal(props.includes(forbidden), false, `${tool.name} must not have a "${forbidden}" input property`);
      }
    }

    await client.callTool("list_required_secrets", {});
    await client.callTool("check_secret", { name: "OPENAI_API_KEY" });
    await client.callTool("save_secret", { name: "OPENAI_API_KEY" });
    await client.callTool("deploy_secret", { name: "OPENAI_API_KEY", target: "github" });
    await client.callTool("deploy_secret", {
      name: "OPENAI_API_KEY",
      target: "cloudflare",
      env: "development",
      dryRun: true
    });
    await client.callTool("generate_env_example", {});
    await client.callTool("scan_secret_leaks", {});
    await client.callTool("check_gitignore", {});
  } finally {
    assertNoCanary("mcp server stdout", client.rawStdout);
    assertNoCanary("mcp server stderr", client.stderrText);
    for (const line of client.rawStdout.split("\n")) {
      if (!line.trim()) continue;
      assert.doesNotThrow(() => JSON.parse(line), `non-JSON-RPC bytes on stdout: ${line}`);
    }
    client.close();
  }
}

// ---------------------------------------------------------------------------
// license (Phase 5) test cases
// ---------------------------------------------------------------------------

function testLicenseSignatureVerification() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const otherKeys = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const validKey = issueLicenseKey(privateKeyPem, "ent_sig_test", "2026-01-01");
  assert.deepEqual(parseLicenseKey(validKey, publicKey), {
    plan: "pro",
    entitlementId: "ent_sig_test",
    issuedAt: "2026-01-01"
  });

  const [prefix, payloadPart, sigPart] = validKey.split(".");
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  assert.deepEqual(payload, {
    v: 1,
    plan: "pro",
    id: "ent_sig_test",
    issuedAt: "2026-01-01"
  });
  assert.equal(Object.hasOwn(payload, "entitlementId"), false, "AKC1 payload shape must remain unchanged");

  // tampered payload byte
  const payloadBuf = Buffer.from(payloadPart, "base64url");
  payloadBuf[0] ^= 0xff;
  const tamperedPayloadKey = `${prefix}.${payloadBuf.toString("base64url")}.${sigPart}`;
  assert.deepEqual(parseLicenseKey(tamperedPayloadKey, publicKey), { plan: "free", reason: "invalid" });

  // tampered signature
  const sigBuf = Buffer.from(sigPart, "base64url");
  sigBuf[0] ^= 0xff;
  const tamperedSigKey = `${prefix}.${payloadPart}.${sigBuf.toString("base64url")}`;
  assert.deepEqual(parseLicenseKey(tamperedSigKey, publicKey), { plan: "free", reason: "invalid" });

  // validly signed, but by a different keypair than the one being verified against
  const wrongKeySignedKey = issueLicenseKey(
    otherKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    "ent_sig_test",
    "2026-01-01"
  );
  assert.deepEqual(parseLicenseKey(wrongKeySignedKey, publicKey), { plan: "free", reason: "invalid" });

  // validly signed, plan: "free" in the payload -> must never resolve to pro
  const freePayloadPart = Buffer.from(
    JSON.stringify({ v: 1, plan: "free", id: "ent_x", issuedAt: "2026-01-01" }),
    "utf8"
  ).toString("base64url");
  const freeSig = signEd25519(null, Buffer.from(`AKC1.${freePayloadPart}`, "utf8"), privateKey).toString(
    "base64url"
  );
  assert.deepEqual(parseLicenseKey(`AKC1.${freePayloadPart}.${freeSig}`, publicKey), {
    plan: "free",
    reason: "invalid"
  });

  // malformed shapes
  for (const malformed of [
    "not-a-license-key",
    "AKC1.onlyonepart",
    `WRONGPREFIX.${payloadPart}.${sigPart}`,
    `${payloadPart}.${sigPart}`,
    ""
  ]) {
    assert.deepEqual(parseLicenseKey(malformed, publicKey), { plan: "free", reason: "invalid" });
  }
}

function testLicenseTerminology() {
  const coreSource = readFileSync(new URL("../packages/core/license.ts", import.meta.url), "utf8");
  const cliSource = readFileSync(new URL("../packages/cli/index.ts", import.meta.url), "utf8");
  const mcpSource = readFileSync(new URL("../packages/mcp/messages.ts", import.meta.url), "utf8");
  assert.equal(coreSource.includes("orderId"), false);
  assert.match(coreSource, /entitlementId/);
  assert.equal(cliSource.includes("order ${status."), false);
  assert.ok(cliSource.includes("license ${status.entitlementId}, issued ${status.issuedAt}"));
  assert.equal(mcpSource.includes("order ${status."), false);
}

function testLicenseGate(root) {
  mkdirSync(root, { recursive: true });

  const missingDir = join(root, "missing-home");
  mkdirSync(missingDir, { recursive: true });
  assert.deepEqual(readLicenseStatus({ baseDir: missingDir }), { plan: "free", reason: "missing" });
  assert.throws(() => assertProFeature("deploy", { baseDir: missingDir }), ProFeatureError);

  const corruptDir = join(root, "corrupt-home");
  mkdirSync(join(corruptDir, ".api-key-case"), { recursive: true });
  writeFileSync(join(corruptDir, ".api-key-case", "license.key"), "not a license key", "utf8");
  assert.deepEqual(readLicenseStatus({ baseDir: corruptDir }), { plan: "free", reason: "invalid" });
  assert.throws(() => assertProFeature("deploy", { baseDir: corruptDir }), ProFeatureError);

  const licenseOptions = testProLicenseOptions(join(root, "licensed-home"));
  assert.equal(readLicenseStatus(licenseOptions).plan, "pro");
  assert.doesNotThrow(() => assertProFeature("deploy", licenseOptions));

  assert.equal(deactivateLicense(licenseOptions.baseDir), true);
  assert.deepEqual(readLicenseStatus(licenseOptions), { plan: "free", reason: "missing" });
  assert.equal(deactivateLicense(licenseOptions.baseDir), false);
}

async function testOnlineLicenseActivation(root) {
  assert.equal(LICENSE_EXCHANGE_URL, "https://apikeycase-license.melavern.com/license/exchange");
  mkdirSync(root, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const existingKey = issueLicenseKey(privateKeyPem, "ls_license_existing", "2026-07-01");
  saveLicenseKey(existingKey, root);
  const purchaseCanary = "LS-PURCHASE-CANARY-CORE";

  let requestBody = "";
  const replacementKey = issueLicenseKey(privateKeyPem, "ls_license_41", "2026-07-10");
  const status = await activatePurchaseLicense(purchaseCanary, {
    endpoint: "https://worker.test.invalid/license/exchange",
    publicKey,
    baseDir: root,
    fetcher: async (_input, init) => {
      requestBody = String(init.body);
      return Response.json({ licenseKey: replacementKey });
    }
  });
  assert.deepEqual(status, { plan: "pro", entitlementId: "ls_license_41", issuedAt: "2026-07-10" });
  assert.equal(JSON.parse(requestBody).licenseKey, purchaseCanary);
  assert.deepEqual(readLicenseStatus({ baseDir: root, publicKey }), status);
  assert.doesNotThrow(() => assertProFeature("deploy", { baseDir: root, publicKey }));

  await assert.rejects(
    activatePurchaseLicense(purchaseCanary, {
      endpoint: "https://worker.test.invalid/license/exchange",
      publicKey,
      baseDir: root,
      fetcher: async () => Response.json({ error: "license_not_eligible" }, { status: 403 })
    }),
    LicenseActivationError
  );
  assert.deepEqual(readLicenseStatus({ baseDir: root, publicKey }), status, "failed activation must preserve the valid AKC1");
}

// scan / save / check / list / remove must never be gateable (phase-5-license.md
// §5-23): confine assertProFeature call sites to the deploy paths, the same
// way testGetPasswordConfinedToTwoFiles confines the vault's read primitive.
function testAssertProFeatureConfinedToDeploy() {
  const allowed = new Set([
    "../packages/core/license.ts",
    "../packages/cli/index.ts",
    "../packages/mcp/tools.ts"
  ]);
  const offenders = readSources([...VAULT_SOURCE_FILES, ...DEPLOY_SOURCE_FILES, ...MCP_SOURCE_FILES])
    .filter((file) => file.text.includes("assertProFeature(") && !allowed.has(file.path))
    .map((file) => file.path);
  assert.deepEqual(offenders, [], "assertProFeature must only be called from cli/index.ts and mcp/tools.ts");
}

async function testMcpDeploySecretLicenseGate(root) {
  const fixtureRoot = join(root, "project");
  mkdirSync(fixtureRoot, { recursive: true });
  write(fixtureRoot, ".gitignore", ".env\n.env.*\n!.env.example\n");

  const fixture = createFakeCli(join(root, "cli"));
  const adapters = new Map([["cloudflare", createFakeAdapter(fixture, { id: "cloudflare" })]]);
  const unlicensedHome = join(root, "unlicensed-home");
  mkdirSync(unlicensedHome, { recursive: true });

  const vault = new MemoryVault();
  await vault.setSecret(
    { name: "MCP_TEST_KEY", scope: "project", projectId: deriveProjectId(fixtureRoot) },
    canaryOpenAi
  );
  const tools = buildTools({
    defaultProjectDir: fixtureRoot,
    createVault: () => vault,
    adapters,
    pathOverride: fixture.pathOverride,
    licenseOptions: { baseDir: unlicensedHome }
  });
  const recordPath = join(root, "record.json");

  await withEnv({ AKC_FAKE_RECORD: recordPath }, async () => {
    const result = await tools.deploy_secret({
      name: "MCP_TEST_KEY",
      target: "cloudflare",
      env: "development"
    });
    assert.equal(result.isError, undefined, "license-required must be a normal status, not isError");
    assert.equal(result.structuredContent?.status, "license-required");
    assert.match(result.content[0].text, /Pro feature/);
    assert.ok(result.content[0].text.includes(PURCHASE_URL));
    assert.equal(existsSync(recordPath), false, "unlicensed deploy must never spawn the target CLI");
    assertNoCanary("license-required mcp text", result.content[0].text);
  });
}

function testIssueLicenseTool(root) {
  mkdirSync(root, { recursive: true });

  // in-process round trip: keygen -> issue -> parse -> activate/status/deactivate
  const { publicKeyPem, privateKeyPem } = generateKeypairPem();
  const publicKey = createPublicKey(publicKeyPem);
  const key = issueLicenseKey(privateKeyPem, "ent_roundtrip_0001", "2026-07-03");
  const parsed = parseLicenseKey(key, publicKey);
  assert.deepEqual(parsed, { plan: "pro", entitlementId: "ent_roundtrip_0001", issuedAt: "2026-07-03" });

  const homeDir = join(root, "home");
  saveLicenseKey(key, homeDir);
  assert.deepEqual(readLicenseStatus({ baseDir: homeDir, publicKey }), parsed);
  assert.equal(deactivateLicense(homeDir), true);
  assert.deepEqual(readLicenseStatus({ baseDir: homeDir, publicKey }), { plan: "free", reason: "missing" });

  // repo-boundary guard
  const repoRootDir = fileURLToPath(new URL("..", import.meta.url));
  assert.equal(isInsideRepo(repoRootDir), true);
  assert.equal(isInsideRepo(root), false);

  const keygenInsideRepo = spawnSync(
    process.execPath,
    [issueLicenseToolPath, "--keygen", fileURLToPath(new URL("../packages", import.meta.url))],
    { encoding: "utf8" }
  );
  assert.notEqual(keygenInsideRepo.status, 0);
  assert.match(keygenInsideRepo.stderr, /inside the repository/);

  // full CLI round trip: keygen writes files, --key/--entitlement signs a working key
  const keygenOutDir = join(root, "keygen-out");
  const keygenResult = spawnSync(process.execPath, [issueLicenseToolPath, "--keygen", keygenOutDir], {
    encoding: "utf8"
  });
  assert.equal(keygenResult.status, 0, keygenResult.stderr);
  assert.ok(existsSync(join(keygenOutDir, "license-private.pem")));
  assert.ok(existsSync(join(keygenOutDir, "license-public.pem")));

  const issueResult = spawnSync(
    process.execPath,
    [
      issueLicenseToolPath,
      "--key",
      join(keygenOutDir, "license-private.pem"),
      "--entitlement",
      "ent_cli_0001",
      "--issued-at",
      "2026-07-03"
    ],
    { encoding: "utf8" }
  );
  assert.equal(issueResult.status, 0, issueResult.stderr);
  const cliIssuedPublicKey = createPublicKey(readFileSync(join(keygenOutDir, "license-public.pem"), "utf8"));
  const cliStatus = parseLicenseKey(issueResult.stdout.trim(), cliIssuedPublicKey);
  assert.deepEqual(cliStatus, { plan: "pro", entitlementId: "ent_cli_0001", issuedAt: "2026-07-03" });
}

function testLicenseCliActivateInputPaths(root) {
  mkdirSync(root, { recursive: true });

  const noArgHome = join(root, "home-noarg");
  const noArg = spawnSync(process.execPath, [cliPath, "license", "activate"], {
    encoding: "utf8",
    cwd: root,
    env: isolatedHomeEnv(noArgHome)
  });
  assert.equal(noArg.status, 1);
  assert.match(noArg.stderr, /interactive terminal/i);
  assertNoCanary("license activate (no-arg) stdout", noArg.stdout);
  assertNoCanary("license activate (no-arg) stderr", noArg.stderr);

  const pipedHome = join(root, "home-piped");
  const pipedCanary = "LS-PURCHASE-CANARY-PIPE";
  const piped = spawnSync(process.execPath, [cliPath, "license", "activate"], {
    encoding: "utf8",
    cwd: root,
    env: isolatedHomeEnv(pipedHome),
    input: `${pipedCanary}\n`
  });
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /interactive terminal/i);
  assert.equal(piped.stdout.includes(pipedCanary), false);
  assert.equal(piped.stderr.includes(pipedCanary), false);
  assert.equal(existsSync(join(pipedHome, ".api-key-case", "license.key")), false);

  const badKeyHome = join(root, "home-badkey");
  const badKey = spawnSync(process.execPath, [cliPath, "license", "activate", "LS-PURCHASE-CANARY-ARGV"], {
    encoding: "utf8",
    cwd: root,
    env: isolatedHomeEnv(badKeyHome)
  });
  assert.equal(badKey.status, 1);
  assert.match(badKey.stderr, /Usage/);
  assert.equal(badKey.stderr.includes("LS-PURCHASE-CANARY-ARGV"), false);
  assert.equal(existsSync(join(badKeyHome, ".api-key-case", "license.key")), false);

  const tooManyHome = join(root, "home-toomany");
  const tooMany = spawnSync(process.execPath, [cliPath, "license", "activate", "a", "b"], {
    encoding: "utf8",
    cwd: root,
    env: isolatedHomeEnv(tooManyHome)
  });
  assert.equal(tooMany.status, 1);
  assert.match(tooMany.stderr, /Usage/);
}

function testLicenseCliStatusAndDeactivateIsolated(root) {
  mkdirSync(root, { recursive: true });
  const homeDir = join(root, "home");

  const freeStatus = spawnSync(process.execPath, [cliPath, "license", "status"], {
    encoding: "utf8",
    cwd: root,
    env: isolatedHomeEnv(homeDir)
  });
  assert.equal(freeStatus.status, 0);
  assert.match(freeStatus.stdout, /^plan: free/);

  const freeStatusJson = spawnSync(process.execPath, [cliPath, "license", "status", "--json"], {
    encoding: "utf8",
    cwd: root,
    env: isolatedHomeEnv(homeDir)
  });
  assert.equal(freeStatusJson.status, 0);
  assert.deepEqual(JSON.parse(freeStatusJson.stdout), { plan: "free", reason: "missing" });

  // no confirmation prompt, and no error, even with nothing to deactivate (§4.1)
  const deactivate = spawnSync(process.execPath, [cliPath, "license", "deactivate"], {
    encoding: "utf8",
    cwd: root,
    env: isolatedHomeEnv(homeDir)
  });
  assert.equal(deactivate.status, 0);
  assert.match(deactivate.stdout, /^OK:/);
}

function testPackagingExcludesToolsAndLicenseMaterial() {
  const repoRootDir = fileURLToPath(new URL("..", import.meta.url));
  // npm is a .cmd shim on Windows; spawning it with shell:false throws EINVAL
  // (Node 20+ / CVE-2024-27980 hardening, same issue documented in
  // deploy/which.ts). All arguments here are static literals, so passing
  // one pre-built command string with shell:true carries no injection risk.
  const result = spawnSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: repoRootDir,
    encoding: "utf8",
    shell: true,
    env: { ...process.env, npm_config_cache: join(testRoot, "npm-cache") }
  });
  assert.equal(result.status, 0, result.stderr);

  let summary;
  try {
    [summary] = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm pack --dry-run --json did not return parseable JSON:\n${result.stdout}`);
  }

  const files = summary.files.map((entry) => entry.path);
  assert.ok(files.length > 0);
  assert.ok(files.includes("NOTICE"), "packed tarball must include NOTICE");
  for (const path of files) {
    assert.equal(path.startsWith("tools/") || path.startsWith("tools\\"), false, `packed tarball must not include tools/: ${path}`);
    assert.equal(path.startsWith("workers/") || path.startsWith("workers\\"), false, `packed tarball must not include workers/: ${path}`);
    assert.equal(path.toLowerCase().includes(".dev.vars"), false, `packed tarball must not include Worker local configuration: ${path}`);
    assert.equal(path.toLowerCase().includes("license.key"), false, `packed tarball must not include a license key: ${path}`);
    assert.equal(path.toLowerCase().endsWith(".pem"), false, `packed tarball must not include key material: ${path}`);
  }
}

// Points a spawned CLI's home directory at an empty temp dir, so
// ~/.api-key-case/license.key resolves somewhere with no real (or
// leftover test) license, regardless of the host machine's actual state.
// os.homedir() reads HOME on POSIX and USERPROFILE on win32.
function isolatedHomeEnv(homeDir) {
  mkdirSync(homeDir, { recursive: true });
  return { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
}

function write(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function git(cwd, args) {
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true
  });
}

function assertNoCanary(label, value) {
  for (const canary of canaries) {
    assert.equal(value.includes(canary), false, `${label} exposed a canary secret`);
  }
}
