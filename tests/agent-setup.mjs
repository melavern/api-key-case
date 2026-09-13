import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectHostReadiness, inspectTargetReadiness } from "../dist/core/agent/readiness.js";
import { buildNextReport } from "../dist/core/agent/next.js";
import { initializeAgentInstructions, renderAgentProtocol } from "../dist/core/agent/init.js";
import { askAndRecordSecret } from "../dist/core/human/index.js";
import { renderTextReport } from "../dist/core/report.js";
import { scanProject } from "../dist/core/scanner.js";
import { MemoryVault } from "../dist/core/vault/memory.js";
import { deriveProjectId, toAccount } from "../dist/core/vault/naming.js";
import { SecretStoreMetadataError } from "../dist/core/vault/types.js";

const cliPath = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const testHost = () => inspectHostReadiness({ platform: "win32", osRelease: "10.0.26200", helperAvailable: true });

export async function runAgentSetupTests() {
  const root = mkdtempSync(join(tmpdir(), "akc-agent-setup-"));
  try {
    testHostConditions();
    await testFreePreflightAndSetup(root);
    await testExistingEnvOnboarding(root);
    await testU5MeaningAndResumption(root);
    testFreshHostInstructions(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function testExistingEnvOnboarding(root) {
  const withExample = join(root, "existing-env-example");
  mkdirSync(withExample, { recursive: true });
  writeFileSync(join(withExample, ".gitignore"), ".env\n.env.*\n!.env.example\n");
  writeFileSync(join(withExample, ".env.example"), "EXAMPLE_API_KEY=\n");
  writeFileSync(join(withExample, "app.ts"), "const key = process.env.EXAMPLE_API_KEY;\n");
  assert.deepEqual(scanProject({ targetDir: withExample }).requiredSecrets, ["EXAMPLE_API_KEY"]);

  const envOnly = join(root, "existing-env-only");
  mkdirSync(envOnly, { recursive: true });
  writeFileSync(join(envOnly, ".gitignore"), ".env\n.env.*\n!.env.example\n");
  const envCanary = "synthetic-env-value-must-not-be-read";
  writeFileSync(join(envOnly, ".env"), `ENV_FILE_ONLY_NAME=${envCanary}\n`);
  writeFileSync(join(envOnly, "app.ts"), "const key = process.env.CODE_DISCOVERED_KEY;\n");
  const envOnlyReport = scanProject({ targetDir: envOnly });
  assert.deepEqual(envOnlyReport.requiredSecrets, ["CODE_DISCOVERED_KEY"]);
  assert.equal(JSON.stringify(envOnlyReport).includes("ENV_FILE_ONLY_NAME"), false);
  assert.equal(JSON.stringify(envOnlyReport).includes(envCanary), false);

  const unsupported = join(root, "existing-env-unsupported-language");
  mkdirSync(unsupported, { recursive: true });
  writeFileSync(join(unsupported, "app.py"), 'key = os.getenv("PYTHON_EXISTING_KEY")\n');
  assert.deepEqual(scanProject({ targetDir: unsupported }).requiredSecrets, []);
  const unsupportedVault = new MemoryVault();
  const unsupportedRef = {
    name: "PYTHON_EXISTING_KEY",
    scope: "project",
    projectId: deriveProjectId(unsupported)
  };
  await unsupportedVault.setSecret(unsupportedRef, "synthetic-human-entered-value");
  assert.equal(await unsupportedVault.hasSecret(unsupportedRef), true, "a known name remains storable after a scanner miss");

  const environmentVariant = join(root, "same-name-environment-variants");
  mkdirSync(environmentVariant, { recursive: true });
  const sharedSlotRef = {
    name: "SHARED_ENVIRONMENT_KEY",
    scope: "project",
    projectId: deriveProjectId(environmentVariant)
  };
  const requestedVariants = ["development", "production"].map((env) => ({
    env,
    account: toAccount(sharedSlotRef)
  }));
  assert.equal(
    new Set(requestedVariants.map(({ account }) => account)).size,
    1,
    "development and production resolve to one project/name storage slot"
  );

  const cloudflare = join(root, "existing-env-cloudflare");
  const cliDir = join(root, "existing-env-cloudflare-cli");
  mkdirSync(cloudflare, { recursive: true });
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cloudflare, "wrangler.json"), JSON.stringify({
    name: "existing-env-worker",
    account_id: "0123456789abcdef0123456789abcdef"
  }));
  writeFileSync(join(cloudflare, ".env"), `CLOUDFLARE_EXISTING_KEY=${envCanary}\n`);
  const fixtureCli = join(cliDir, process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  writeFileSync(fixtureCli, process.platform === "win32" ? "@exit /b 93\r\n" : "#!/usr/bin/env node\nprocess.exit(93);\n");
  chmodSync(fixtureCli, 0o755);
  let providerProbes = 0;
  const readiness = await inspectTargetReadiness({
    adapter: {
      id: "cloudflare",
      cliCommand: "wrangler",
      detect: async () => ({ detected: true, reason: "wrangler.json" }),
      checkCli: async () => {
        providerProbes += 1;
        return { installed: true, loggedIn: true, identity: "accounts:0123456789abcdef" };
      },
      planDeploy: () => { throw new Error("readiness must not deploy"); },
      manualSteps: () => []
    },
    projectDir: cloudflare,
    detected: true,
    vaultAvailable: true,
    host: testHost(),
    pathOverride: [cliDir, dirname(process.execPath)].join(delimiter)
  });
  assert.ok(readiness.every((entry) => entry.issues.includes("unsafe-deploy-context")));
  assert.equal(providerProbes, 0, "Cloudflare env-file coexistence must stop before login probing");
  const cloudflareVault = new MemoryVault();
  const cloudflareRef = {
    name: "CLOUDFLARE_EXISTING_KEY",
    scope: "project",
    projectId: deriveProjectId(cloudflare)
  };
  await cloudflareVault.setSecret(cloudflareRef, "synthetic-human-entered-value");
  assert.equal(await cloudflareVault.hasSecret(cloudflareRef), true, "deploy readiness must not block registration");
}

function testHostConditions() {
  const linux = inspectHostReadiness({ platform: "linux" });
  assert.equal(linux.secretInput, "unavailable");
  assert.equal(linux.approval, "unavailable");
  assert.deepEqual(linux.issues, ["unsupported-platform"]);
  const oldWindows = inspectHostReadiness({ platform: "win32", osRelease: "10.0.19045", helperAvailable: true });
  assert.equal(oldWindows.secretInput, "interaction-required", "old Windows must keep Secret input");
  assert.equal(oldWindows.approval, "unavailable");
  assert.deepEqual(oldWindows.issues, ["windows-version-unsupported"]);
  const unknownWindows = inspectHostReadiness({ platform: "win32", osRelease: "unknown", helperAvailable: true });
  assert.equal(unknownWindows.approval, "unavailable");
  assert.deepEqual(unknownWindows.issues, ["windows-version-unverified"]);
  const windows = testHost();
  assert.equal(windows.approval, "interaction-required");
  assert.ok(windows.requirements.includes("windows-hello"), "do not silently assume enrollment");
  const mac = inspectHostReadiness({ platform: "darwin", helperAvailable: true });
  assert.equal(mac.approval, "interaction-required", "helper presence cannot prove a GUI session or approval");
  const noHelper = inspectHostReadiness({ platform: "darwin", helperAvailable: false });
  assert.equal(noHelper.secretInput, "unavailable");
  assert.equal(noHelper.approval, "unavailable");
}

async function testFreePreflightAndSetup(root) {
  const projectDir = join(root, "project");
  const cliDir = join(root, "cli");
  mkdirSync(join(projectDir, ".vercel"), { recursive: true });
  mkdirSync(cliDir);
  writeFileSync(join(projectDir, ".gitignore"), ".env\n.env.*\n");
  writeFileSync(join(projectDir, "app.ts"), "process.env.FIRST_API_KEY; process.env.SECOND_API_KEY;\n");
  const configPath = join(projectDir, ".vercel/project.json");
  const linked = JSON.stringify({ orgId: "team_setup", projectId: "prj_setup" });
  writeFileSync(configPath, linked);
  const fixtureCli = join(cliDir, process.platform === "win32" ? "vercel.cmd" : "vercel");
  writeFileSync(fixtureCli, process.platform === "win32" ? "@exit /b 93\r\n" : "#!/usr/bin/env node\nprocess.exit(93);\n");
  chmodSync(fixtureCli, 0o755);
  const trustedFixturePath = [cliDir, dirname(process.execPath)].join(delimiter);
  let probes = 0;
  const adapter = {
    id: "vercel", cliCommand: "vercel",
    detect: async () => ({ detected: true, reason: "provider-raw-output-canary" }),
    checkCli: async (options) => {
      if (options) {
        probes++;
        assert.equal(options.cwd, realpathSync.native(projectDir));
        assert.ok(options.resolvedCli);
        assert.equal(options.env.NODE_OPTIONS, undefined);
        assert.equal(options.env.VERCEL_TOKEN, undefined);
      }
      return { installed: true, loggedIn: true, identity: "user:fixture", hint: "provider-raw-output-canary" };
    },
    planDeploy: () => { throw new Error("diagnostics must not plan or execute a Secret write"); },
    manualSteps: () => []
  };
  const base = { adapter, projectDir, detected: true, vaultAvailable: true, host: testHost(), pathOverride: trustedFixturePath };
  const healthy = await inspectTargetReadiness(base);
  assert.equal(probes, 3, "Free preflight must inspect every environment through the trusted CLI context");
  assert.ok(healthy.every((env) => env.status === "prerequisites-checked"), JSON.stringify(healthy));
  assert.ok(healthy.every((env) => env.unverified.includes("human-interaction") && env.unverified.includes("provider-write-permission")));
  assert.equal(JSON.stringify(healthy).includes("provider-raw-output-canary"), false);
  assert.equal(JSON.stringify(healthy).includes("user:fixture"), false);

  probes = 0;
  for (const options of [
    { host: inspectHostReadiness({ platform: "linux" }) },
    { host: inspectHostReadiness({ platform: "win32", osRelease: "10.0.19045", helperAvailable: true }) },
    { detected: false }, { vaultAvailable: false }
  ]) {
    const blocked = await inspectTargetReadiness({ ...base, ...options });
    assert.ok(blocked.every((env) => env.status === "blocked"));
  }
  assert.equal(probes, 0, "unsupported conditions must not start provider probes");

  writeFileSync(configPath, JSON.stringify({ orgId: "team_setup" }));
  const unlinked = await inspectTargetReadiness(base);
  assert.ok(unlinked.every((env) => env.issues.includes("unsafe-deploy-context")));
  assert.equal(probes, 0, "an unresolved destination must not reach the provider");
  writeFileSync(configPath, linked);

  const login = await inspectTargetReadiness({ ...base, adapter: { ...adapter, checkCli: async () => ({ installed: true, loggedIn: false }) } });
  assert.ok(login.every((env) => env.issues.includes("provider-login-required")));
  const noIdentity = await inspectTargetReadiness({ ...base, adapter: { ...adapter, checkCli: async () => ({ installed: true, loggedIn: true }) } });
  assert.ok(noIdentity.every((env) => env.issues.includes("provider-identity-unverified")));
  const failed = await inspectTargetReadiness({ ...base, adapter: { ...adapter, checkCli: async () => { throw new Error("provider-raw-output-canary"); } } });
  assert.ok(failed.every((env) => env.issues.includes("inspection-failed")));
  assert.equal(JSON.stringify(failed).includes("provider-raw-output-canary"), false);

  const changed = await inspectTargetReadiness({ ...base, adapter: {
    ...adapter, checkCli: async () => {
      writeFileSync(fixtureCli, readFileSync(fixtureCli, "utf8") + "\n");
      return { installed: true, loggedIn: true, identity: "user:fixture" };
    }
  } });
  assert.ok(changed.every((env) => env.issues.includes("context-changed")), "probe-time CLI replacement must not look ready");

  const vault = new MemoryVault();
  let secretWrites = 0;
  let trustWrites = 0;
  const setSecret = vault.setSecret.bind(vault);
  vault.setSecret = async (...args) => { secretWrites++; return setSecret(...args); };
  vault.saveDestinationTrust = async () => { trustWrites++; throw new Error("preflight must not mint trust"); };
  const deps = {
    vault, adapters: [adapter], registryBaseDir: root, hostReadiness: testHost(),
    inspectReadiness: (options) => inspectTargetReadiness({ ...options, pathOverride: trustedFixturePath })
  };
  const free = await buildNextReport(projectDir, { ...deps, licensePlan: "free" });
  const pro = await buildNextReport(projectDir, { ...deps, licensePlan: "pro" });
  assert.deepEqual(free.targets[0].readiness, pro.targets[0].readiness, "preflight must not require a purchase");
  assert.equal(secretWrites, 0);
  assert.equal(trustWrites, 0);
  assert.equal(free.schemaVersion, 2);
  assert.equal(free.setup.stage, "register-secrets");
  assert.deepEqual(free.setup.counts, { required: 2, registered: 0, missing: 2, unavailable: 0, unsupported: 0, cleanupCandidates: 0 });
  assert.equal(free.targets[0].deployment.automatic.length, 0, "Free readiness must never unlock execution");

  // The advisory probe can see a login that the sanitized execution cannot use.
  const sanitizedLogin = await buildNextReport(projectDir, {
    ...deps, licensePlan: "free", adapters: [{ ...adapter, checkCli: async (options) =>
      options ? { installed: true, loggedIn: false } : { installed: true, loggedIn: true, identity: "user:fixture" }
    }]
  });
  assert.equal(sanitizedLogin.targets[0].cliStatus, "ready");
  assert.ok(sanitizedLogin.nextActions.some((action) => action.kind === "authenticate-target-cli"));

  const projectId = deriveProjectId(projectDir);
  await vault.setSecret({ name: "FIRST_API_KEY", scope: "project", projectId }, "synthetic-first-value");
  const halfway = await buildNextReport(projectDir, { ...deps, licensePlan: "free" });
  assert.equal(halfway.setup.counts.registered, 1);
  assert.deepEqual(halfway.nextActions.filter((action) => action.kind === "register-secret").map((action) => action.name), ["SECOND_API_KEY"]);
  await vault.setSecret({ name: "SECOND_API_KEY", scope: "project", projectId }, "synthetic-second-value");
  const saved = await buildNextReport(projectDir, { ...deps, licensePlan: "free" });
  assert.equal(saved.setup.stage, "review-deployment");
  assert.equal(saved.setup.deploymentState, "not-inspected", "local registration must not claim remote completion");
  assert.equal(saved.setup.counts.missing, 0);
  assert.equal(trustWrites, 0);
  const serialized = JSON.stringify(saved);
  for (const forbidden of ["synthetic-first-value", "synthetic-second-value", "provider-raw-output-canary", "user:fixture"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  const different = new MemoryVault();
  await different.setSecret({ name: "FIRST_API_KEY", scope: "project", projectId }, "x");
  await different.setSecret({ name: "SECOND_API_KEY", scope: "project", projectId }, "different-length-content");
  assert.deepEqual(await buildNextReport(projectDir, { ...deps, vault: different, licensePlan: "free" }), saved);

  const linux = await buildNextReport(projectDir, { ...deps, vault: new MemoryVault(), licensePlan: "free", hostReadiness: inspectHostReadiness({ platform: "linux" }) });
  assert.equal(linux.setup.stage, "human-handoff");
  assert.equal(linux.vault.status, "available", "Linux still supports the existing Free vault");
  assert.ok(linux.targets[0].readiness.every((env) => env.issues.includes("unsupported-platform")));
  const failedTarget = await buildNextReport(projectDir, {
    ...deps, licensePlan: "free", adapters: [{ ...adapter, detect: async () => { throw new Error("provider-raw-output-canary"); } }]
  });
  assert.equal(failedTarget.targets[0].cliStatus, "unverified");
  assert.ok(failedTarget.targets[0].readiness.every((env) => env.issues.includes("inspection-failed")));
  assert.ok(failedTarget.nextActions.some((action) => action.kind === "review-deploy-setup"));
  assert.equal(JSON.stringify(failedTarget).includes("provider-raw-output-canary"), false);
}

async function testU5MeaningAndResumption(root) {
  const unsupported = join(root, "u5-unsupported");
  mkdirSync(join(unsupported, "src"), { recursive: true });
  writeFileSync(join(unsupported, "app.py"), 'value = os.getenv("PYTHON_API_KEY")\n');
  writeFileSync(
    join(unsupported, "src/config.js"),
    'const value = process["env"]["JS_UNSUPPORTED_API_KEY"];\n'
  );

  const emptyScan = scanProject({ targetDir: unsupported });
  assert.deepEqual(emptyScan.requiredSecrets, [], "unsupported references must not become false certainty");
  assert.match(emptyScan.envExample.reason ?? "", /current scanner/);
  assert.match(emptyScan.envExample.reason ?? "", /does not prove that the project needs no secrets/);
  const emptyText = renderTextReport(emptyScan);
  assert.match(emptyText, /current API Key Case scanner/);
  assert.match(emptyText, /does not prove that the project needs no secrets/);
  const emptyNext = await buildNextReport(unsupported, {
    vault: new MemoryVault(),
    adapters: [],
    licensePlan: "free",
    registryBaseDir: root
  });
  assert.equal(emptyNext.setup.stage, "no-required-secrets");
  assert.equal(emptyNext.setup.counts.required, 0);
  assert.deepEqual(emptyNext.secrets, []);

  const staleExample = join(root, "u5-stale-example");
  mkdirSync(staleExample, { recursive: true });
  writeFileSync(join(staleExample, ".env.example"), "OLD_API_KEY=\n");
  writeFileSync(join(staleExample, "app.ts"), "const value = process.env.CURRENT_API_KEY;\n");
  const staleScan = scanProject({ targetDir: staleExample });
  assert.deepEqual(staleScan.requiredSecrets, ["CURRENT_API_KEY", "OLD_API_KEY"]);
  assert.deepEqual(staleScan.secretUsages.find((entry) => entry.name === "OLD_API_KEY")?.files, []);
  assert.deepEqual(staleScan.secretUsages.find((entry) => entry.name === "CURRENT_API_KEY")?.files, ["app.ts"]);

  const resumed = join(root, "u5-resumed");
  mkdirSync(resumed, { recursive: true });
  writeFileSync(join(resumed, ".env.example"), "RESUMED_API_KEY=\n");
  const projectId = deriveProjectId(resumed);
  const ref = { name: "RESUMED_API_KEY", scope: "project", projectId };
  const vault = new MemoryVault();
  const syntheticValue = "synthetic-resumption-value";
  const humanPlane = {
    askSecret: async () => {
      await vault.setSecret(ref, syntheticValue);
      return "saved";
    }
  };
  const before = await buildNextReport(resumed, {
    vault,
    adapters: [],
    licensePlan: "free",
    registryBaseDir: root
  });
  assert.equal(before.secrets[0]?.status, "missing");

  await assert.rejects(
    () => askAndRecordSecret(
      humanPlane,
      ref,
      resumed,
      () => { throw new Error("index fixture failure"); }
    ),
    (error) => {
      assert.ok(error instanceof SecretStoreMetadataError);
      assert.doesNotMatch(error.message, /synthetic-resumption-value/);
      return true;
    }
  );
  assert.equal(await vault.hasSecret(ref), true, "the OS-store stage remains observable through check");

  const after = await buildNextReport(resumed, {
    vault,
    adapters: [],
    licensePlan: "free",
    registryBaseDir: root
  });
  assert.equal(after.secrets[0]?.status, "registered");
  assert.equal(after.setup.counts.missing, 0);
  assert.equal(after.nextActions.some((action) => action.kind === "register-secret"), false);
}

function testFreshHostInstructions(root) {
  for (const [host, path] of [["agents", "AGENTS.md"], ["claude", "CLAUDE.md"], ["cursor", ".cursor/rules/api-key-case.mdc"]]) {
    const projectDir = join(root, `fresh-${host}`);
    mkdirSync(projectDir);
    const before = initializeAgentInstructions({ projectDir, packageVersion: "0.9.1", check: true, host });
    assert.equal(before.files[0].status, "missing");
    assert.deepEqual(readdirSync(projectDir), [], "--check must not create host files");
    const initialized = initializeAgentInstructions({ projectDir, packageVersion: "0.9.1", check: false, host });
    assert.deepEqual(initialized.files, [{ path, status: "created" }]);
    assert.ok(existsSync(join(projectDir, path)));
    assert.deepEqual(readdirSync(projectDir), [path.split("/")[0]], "only the explicitly selected host gets instructions");
    assert.match(readFileSync(join(projectDir, path), "utf8"), /You are the user's interface/);
  }
  const cliDir = join(root, "cli-host");
  mkdirSync(cliDir);
  const check = spawnSync(process.execPath, [cliPath, "agent-init", cliDir, "--host", "agents", "--check"], { encoding: "utf8" });
  assert.equal(check.status, 2);
  assert.equal(existsSync(join(cliDir, "AGENTS.md")), false);
  const init = spawnSync(process.execPath, [cliPath, "agent-init", cliDir, "--host", "agents"], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /schemaVersion 2/);
  const before = readFileSync(join(cliDir, "AGENTS.md"), "utf8");
  const invalid = spawnSync(process.execPath, [cliPath, "agent-init", cliDir, "--host", "unknown"], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal(readFileSync(join(cliDir, "AGENTS.md"), "utf8"), before);
  const protocol = renderAgentProtocol("0.9.1");
  assert.match(protocol, /A chat Yes\/No is not OS approval/);
  assert.match(protocol, /purchase cannot fix unsupported hosts/);
  assert.match(protocol, /not deployed/);
  assert.match(protocol, /scoped to this CLI process's OS account, home and session/);
  assert.match(protocol, /Agent sandbox can differ from a human-owned shell/);
  assert.match(protocol, /keep that same invocation and wait or poll it until exit/);
  assert.match(protocol, /do not require a chat acknowledgement merely to recover its result/);
  assert.match(protocol, /current API Key Case scan detected no required Secret names/);
  assert.match(protocol, /never conclude that the project needs no Secrets/);
  assert.match(protocol, /A name found only in \.env\.example is a declaration/);
  assert.match(protocol, /A known Secret that is absent from list or next/);
  assert.match(protocol, /OS secret-store write and the local metadata\/index update/);
  assert.match(protocol, /An unused status means the current scanner found no reference/);
  assert.match(protocol, /Mention force only when the provider explicitly confirms a duplicate/);
  assert.match(protocol, /never repeat the same force operation automatically/);
  assert.match(protocol, /Existing \.env users can start by registering known keys/);
  assert.match(protocol, /human to open their own \.env and copy each value only into the Human Plane/);
  assert.match(protocol, /Registration may be the end of the requested task/);
  assert.match(protocol, /do not modify or delete the original \.env/);
  assert.match(protocol, /development and production need different values/);
  assert.match(protocol, /both cannot be stored simultaneously/);
  assert.match(protocol, /\.env, \.env\.\* \(excluding \.env\.example\)/);
  assert.match(protocol, /not because of login or Free/);
  assert.match(protocol, /Secret registration remains available and the files stay unchanged/);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runAgentSetupTests();
  console.log("Agent setup and free readiness tests passed.");
}
