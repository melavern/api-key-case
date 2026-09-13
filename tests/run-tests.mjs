import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanProject } from "../dist/core/scanner.js";
import { renderTextReport } from "../dist/core/report.js";
import { MemoryVault } from "../dist/core/vault/memory.js";
import {
  deriveProjectId,
  DESTINATION_TRUST_MARKER,
  toAccount,
  toDestinationAccount
} from "../dist/core/vault/naming.js";
import { assertValidSecretName, SecretNameError } from "../dist/core/vault/types.js";
import {
  readRegistry,
  upsertRegistryEntry,
  removeRegistryEntry
} from "../dist/core/vault/registry.js";
import { createVault } from "../dist/core/vault/index.js";
import { runDeploy as runDeployActual } from "../dist/core/deploy/engine.js";
import { DeploymentHistory } from "../dist/core/deploy/history.js";
import { runWithSecret } from "../dist/core/deploy/handoff.js";
import { buildTrustedExecution, makeApprovalPlan, matchesTrustedExecution } from "../dist/core/deploy/snapshot.js";
import {
  AUTOMATIC_SAFE_ENVS,
  destinationIdentity,
  destinationSlotFingerprint,
  forgetDestinationTrust,
  hasDestinationTrustRecords,
  inspectDestinationTrust,
  isAutomaticSafeOperation,
  readDestinationTrust,
  recordDestinationTrust,
  resolveDestinationIdentity
} from "../dist/core/deploy/destination.js";
import { runForgetDestinationTrust, runRemoveSecret } from "../dist/core/lifecycle.js";
import {
  currentResolvedCli,
  isSameResolvedCli,
  resolveCli,
  spawnResolvedCli,
  resolveTrustedCli,
  resolveTrustedHomeDirectory
} from "../dist/core/deploy/which.js";
import { ADAPTERS } from "../dist/adapters/index.js";
import { isGitHubRemoteUrl } from "../dist/adapters/github.js";
import { buildTools } from "../dist/mcp/tools.js";
import { buildNextReport } from "../dist/core/agent/next.js";
import { runAgentSetupTests } from "./agent-setup.mjs";
import { runDeploymentHistoryTests } from "./deployment-history.mjs";
import { runWindowsVerificationHarnessTests } from "./windows-verification-harness.mjs";
import { runMacOSHumanPlaneScriptTests } from "./macos-human-plane-script.mjs";
import { runPublicBlockerTests } from "./public-blockers.mjs";
import {
  askAndRecordSecret,
  buildMacOSApprovalScript,
  buildMacOSRemovalScript,
  buildMacOSSecretInputScript,
  buildWindowsApprovalScript,
  buildWindowsRemovalScript,
  buildWindowsSecretInputScript,
  createHumanPlane,
  MacOSHumanPlane,
  MACOS_OSASCRIPT_PATH,
  resolveMacOSOsascript,
  resolveWindowsPowerShell,
  WindowsHumanPlane,
  WINDOWS_DIALOG_TEXT,
  WINDOWS_POWERSHELL_PATH,
  WINDOWS_USER_VERIFICATION_MIN_BUILD
} from "../dist/core/human/index.js";
import {
  AgentInitSafetyError,
  assertSafeProjectPath,
  initializeAgentInstructions,
  renderAgentProtocol
} from "../dist/core/agent/init.js";
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
  LicenseActivationError
} from "../dist/core/license-exchange.js";
import {
  buildCliTelemetryEvent,
  createCliTelemetry,
  disableTelemetry,
  enableTelemetry,
  getTelemetryStatus,
  POSTHOG_PUBLIC_CONFIG,
  POSTHOG_PUBLIC_PROJECT_TOKEN,
  readTelemetryState,
  resolvePostHogConfig,
  telemetryFilePath
} from "../dist/core/telemetry.js";
import { generateKeypairPem, isInsideRepo, issueLicenseKey } from "../tools/issue-license.mjs";

// Canonical form, as a shell hands the CLI its cwd. The GitHub Windows runner's
// os.tmpdir() is an 8.3 short name (C:\Users\RUNNER~1\...) that realpathSync
// keeps and realpathSync.native expands; the two spellings hash to different
// project identities, so the engine's identity recheck would refuse every
// project-scoped deploy under the raw path.
const testRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "api-key-case-")));
const runDeploy = (deps, request) => runDeployActual({ historyBaseDir: testRoot, ...deps }, request);
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
  if (E2E_STRICT) console.log(`real keyring e2e blocks passed: ${e2eBlocksRun}`);
}

const DEPLOY_SOURCE_FILES = [
  "../packages/core/deploy/types.ts",
  "../packages/core/deploy/which.ts",
  "../packages/core/deploy/handoff.ts",
  "../packages/core/deploy/snapshot.ts",
  "../packages/core/deploy/destination.ts",
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
  "../packages/core/lifecycle.ts",
  "../packages/core/patterns.ts",
  "../packages/core/agent/init.ts",
  "../packages/core/agent/next.ts",
  "../packages/core/agent/readiness.ts",
  "../packages/core/human/types.ts",
  "../packages/core/human/macos.ts",
  "../packages/core/human/windows.ts",
  "../packages/core/human/index.ts",
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

// The dialog a human reads is the last line of defence, so its language must
// come from that person's own Windows settings rather than from anything the
// Agent can set. Both tables ship in every script; the helper picks one.
function assertLocalizedWindowsDialog(script, label, ...pairs) {
  assert.match(
    script,
    /CurrentUICulture\.TwoLetterISOLanguageName -eq 'ja'/,
    `${label} must take its language from the OS display language`
  );
  assert.match(
    script,
    /CurrentCulture\.TwoLetterISOLanguageName -eq 'ja'/,
    `${label} must also accept a Japanese regional format`
  );
  assert.doesNotMatch(
    script,
    /\$env:/,
    `${label} must not let an environment variable choose the prose a human reads`
  );
  assert.match(
    script,
    /New-Object System\.Drawing\.Font\('Segoe UI', 9\)/,
    `${label} must use the current Windows UI font`
  );
  const visualStyles = script.indexOf("EnableVisualStyles()");
  const firstControl = script.indexOf("New-Object System.Windows.Forms.Form");
  assert.ok(
    visualStyles >= 0 && firstControl > visualStyles,
    `${label} must enable visual styles before it creates a control`
  );
  for (const pair of pairs) {
    for (const language of ["en", "ja"]) {
      assert.ok(
        script.includes(pair[language]),
        `${label} is missing its ${language} text for ${pair.en}`
      );
    }
  }
}

// Hands a generated helper script to PowerShell in the same encoding the
// product uses at runtime — UTF-16LE, the bytes that sit inside its
// -EncodedCommand payload — and decodes them with a matching explicit reader.
//
// Reading the script from stdin as text instead makes PowerShell 5.1 decode it
// with the console input code page. On a non-UTF-8 console (cp932 on a Japanese
// Windows) the localized dialog text then arrives as mojibake and a correct
// script is reported as a syntax error, so the check would pass or fail on the
// terminal it ran in rather than on the script. The probe itself stays short
// and ASCII, which keeps it clear of the command-line length limit.
function parseWindowsHelperScript(script) {
  const probe = [
    "$ErrorActionPreference = 'Stop'",
    "$reader = New-Object System.IO.StreamReader(" +
      "[Console]::OpenStandardInput(), [Text.Encoding]::Unicode, $false)",
    "[ScriptBlock]::Create($reader.ReadToEnd()) | Out-Null"
  ].join("\n");
  return spawnSync(
    WINDOWS_POWERSHELL_PATH,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(probe, "utf16le").toString("base64")
    ],
    {
      encoding: "utf8",
      input: Buffer.from(script, "utf16le"),
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" }
    }
  );
}

function assertWindowsUserVerificationGate(script, label) {
  assert.match(script, /UserConsentVerifierNative/, `${label} must use the OS verifier`);
  assert.match(
    script,
    /RequestVerificationForWindowAsyncDelegate/,
    `${label} must use the HWND-bound desktop interop API`
  );
  assert.match(
    script,
    new RegExp(`IsSupportedBuild\\(${WINDOWS_USER_VERIFICATION_MIN_BUILD}\\)`),
    `${label} must fail closed below the API's minimum Windows build`
  );
  assert.match(
    script,
    /Invoke-ApiKeyCaseUserVerification \$script:form\.Handle/,
    `${label} must bind verification to its owning window`
  );
  for (const [value, result] of [
    ["0", "0"], // Verified
    ["1", "10"], // DeviceNotPresent
    ["2", "10"], // NotConfiguredForUser
    ["3", "10"], // DisabledByPolicy
    ["4", "10"], // DeviceBusy
    ["5", "10"], // RetriesExhausted
    ["6", "2"] // Canceled
  ]) {
    assert.match(
      script,
      new RegExp(`${value} \\{ \\$script:resultCode = ${result} \\}`),
      `${label} has an unsafe verification-result mapping for ${value}`
    );
  }
  assert.match(script, /default \{ \$script:resultCode = 10 \}/);
  assert.doesNotMatch(
    script,
    /\$yesButton\.Add_Click\(\{ \$script:resultCode = 0/,
    `${label} must not approve from a WinForms button action alone`
  );
}

try {
  assertE2EFlagsCoherent();
  testRedactionAndSafeGeneration(join(testRoot, "safe-generation"));
  testNestedGitState(join(testRoot, "nested-git"));
  testCliExitCodes(join(testRoot, "cli"));
  await testCliTelemetry(join(testRoot, "telemetry"));
  await testNextActionSchema(join(testRoot, "next-actions"));
  await runAgentSetupTests();
  await runDeploymentHistoryTests();
  await runWindowsVerificationHarnessTests();
  await runMacOSHumanPlaneScriptTests();
  await runPublicBlockerTests();
  testNextCliJson(join(testRoot, "next-cli"));
  await testHumanPlaneSecretBoundary(join(testRoot, "human-plane"));
  await testMacOSHumanPlaneBoundary(join(testRoot, "human-plane-macos"));
  testAgentInitManagedInstructions(join(testRoot, "agent-init"));
  testAgentInitCli(join(testRoot, "agent-init-cli"));
  testAgentInitSafety(join(testRoot, "agent-init-safety"));
  testSourceDoesNotExposeDangerousHelpers();
  testGetPasswordConfinedToTwoFiles();
  testDestinationTrustWritesConfinedToEngine();
  await testMemoryVault();
  testNaming(join(testRoot, "naming-a"), join(testRoot, "naming-b"));
  testSecretNameValidation();
  testRegistry(join(testRoot, "registry"));
  testVaultCliBoundary(join(testRoot, "vault-cli"));
  await testRealKeyringE2E();
  testGitHubRemoteDetection();
  testDeployPlansNeverCarryAValue();
  testVercelPlansRequireSensitiveStorage();
  testWhichResolvesOnlyFromGivenPath(join(testRoot, "which"));
  await testMacOSPinnedInterpreter(join(testRoot, "macos-interpreter"));
  await testEngineDryRun(join(testRoot, "engine-dry-run"));
  await testEngineMissingSecret(join(testRoot, "engine-missing"));
  await testEngineCliUnavailable(join(testRoot, "engine-cli-unavailable"));
  await testEngineDeclinedConfirmation(join(testRoot, "engine-declined"));
  await testEngineGithubAlwaysConfirms(join(testRoot, "engine-github-confirm"));
  await testPhaseCApprovalBoundary(join(testRoot, "phase-c-approval"));
  await testPhaseDDestinationBoundary(join(testRoot, "phase-d-destination"));
  await testPhaseELifecycle(join(testRoot, "phase-e-lifecycle"));
  await testHandoffPreStepFailureAbortsBeforeSecretRead(join(testRoot, "handoff-prestep-abort"));
  testDeployCliValidation(join(testRoot, "deploy-cli-validation"));
  testTargetsCliSmoke(join(testRoot, "targets-cli"));
  testTrustCliSmoke(join(testRoot, "trust-cli"));
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

async function testCliTelemetry(root) {
  mkdirSync(root, { recursive: true });
  const tokenEnv = { API_KEY_CASE_POSTHOG_PROJECT_TOKEN: "test-project-token" };
  const installationId = "11111111-1111-4111-8111-111111111111";
  const nextInstallationId = "22222222-2222-4222-8222-222222222222";

  const telemetryConfigPath = new URL("../dist/core/telemetry-config.js", import.meta.url);
  const telemetryConfigSource = readFileSync(telemetryConfigPath, "utf8");
  const packageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(existsSync(telemetryConfigPath), true);
  assert.equal(packageManifest.files.includes("dist"), true);
  assert.match(telemetryConfigSource, /POSTHOG_PUBLIC_PROJECT_TOKEN/);
  assert.match(telemetryConfigSource, /us:\s*"https:\/\/us\.i\.posthog\.com"/);
  assert.match(telemetryConfigSource, /eu:\s*"https:\/\/eu\.i\.posthog\.com"/);
  assert.match(telemetryConfigSource, /\/i\/v0\/e\//);
  assert.ok([
    "https://us.i.posthog.com",
    "https://eu.i.posthog.com"
  ].includes(POSTHOG_PUBLIC_CONFIG.apiHost));
  assert.equal(POSTHOG_PUBLIC_CONFIG.apiHost, "https://us.i.posthog.com");
  assert.match(POSTHOG_PUBLIC_PROJECT_TOKEN, /^[A-Za-z0-9._~+/-]{8,256}$/);
  assert.doesNotMatch(POSTHOG_PUBLIC_PROJECT_TOKEN, /^(?:phx_|phs_)/);
  assert.equal(POSTHOG_PUBLIC_PROJECT_TOKEN, POSTHOG_PUBLIC_CONFIG.projectToken);
  const publicFallback = resolvePostHogConfig({});
  if (POSTHOG_PUBLIC_PROJECT_TOKEN) {
    assert.deepEqual(publicFallback, {
      projectToken: POSTHOG_PUBLIC_PROJECT_TOKEN,
      endpoint: `${POSTHOG_PUBLIC_CONFIG.apiHost}/i/v0/e/`,
      source: "public"
    });
  } else {
    assert.equal(publicFallback, null);
  }

  // Production uses the public project-token fallback, while a non-empty env
  // value remains the development/test/local override. Both paths resolve to
  // fixed regional endpoints, and an empty public placeholder is a no-op.
  assert.deepEqual(
    resolvePostHogConfig(
      {},
      { projectToken: "public-project-token", apiHost: "https://eu.i.posthog.com" }
    ),
    {
      projectToken: "public-project-token",
      endpoint: "https://eu.i.posthog.com/i/v0/e/",
      source: "public"
    }
  );
  assert.deepEqual(
    resolvePostHogConfig(
      {
        API_KEY_CASE_POSTHOG_PROJECT_TOKEN: " env-override-token ",
        API_KEY_CASE_POSTHOG_API_HOST: "https://evil.invalid"
      },
      { projectToken: "public-project-token", apiHost: "https://us.i.posthog.com" }
    ),
    {
      projectToken: "env-override-token",
      endpoint: "https://us.i.posthog.com/i/v0/e/",
      source: "environment"
    }
  );
  for (const privateCredential of ["phx_personal-key-test-fixture", "phs_project-secret-test-fixture"]) {
    assert.deepEqual(
      resolvePostHogConfig(
        { API_KEY_CASE_POSTHOG_PROJECT_TOKEN: privateCredential },
        { projectToken: "public-project-token", apiHost: "https://us.i.posthog.com" }
      ),
      {
        projectToken: "public-project-token",
        endpoint: "https://us.i.posthog.com/i/v0/e/",
        source: "public"
      }
    );
    assert.equal(
      resolvePostHogConfig(
        { API_KEY_CASE_POSTHOG_PROJECT_TOKEN: privateCredential },
        { projectToken: "", apiHost: "https://us.i.posthog.com" }
      ),
      null
    );
    assert.equal(
      resolvePostHogConfig(
        {},
        { projectToken: privateCredential, apiHost: "https://us.i.posthog.com" }
      ),
      null
    );
  }
  assert.equal(
    resolvePostHogConfig(
      {},
      { projectToken: "public-project-token", apiHost: "https://evil.invalid" }
    ),
    null
  );
  // A first non-TTY command is deliberately silent and must not create state.
  const nonTtyHome = join(root, "non-tty");
  const nonTtyEvents = [];
  const nonTty = createCliTelemetry({
    baseDir: nonTtyHome,
    env: tokenEnv,
    isTTY: false,
    cliVersion: "1.2.3",
    capture: (event) => nonTtyEvents.push(event)
  });
  nonTty.prepare();
  await nonTty.record({ command: "scan", outcome: "success" });
  assert.deepEqual(nonTtyEvents, []);
  assert.equal(existsSync(telemetryFilePath(nonTtyHome)), false);

  // The first eligible interactive run shows the notice once, creates a
  // random-only installation ID, and records the closed payload.
  const home = join(root, "interactive");
  const events = [];
  const notices = [];
  const interactive = createCliTelemetry({
    baseDir: home,
    env: tokenEnv,
    platform: "win32",
    isTTY: true,
    cliVersion: "1.2.3",
    randomId: () => installationId,
    writeNotice: (message) => notices.push(message),
    capture: (event) => events.push(event)
  });
  interactive.prepare();
  await interactive.record({ command: "scan", outcome: "success" });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /anonymous usage statistics/i);
  assert.ok(existsSync(telemetryFilePath(home)));
  assert.equal(statSync(telemetryFilePath(home)).isFile(), true);
  assert.deepEqual(events[0], {
    event: "cli_command_result",
    distinct_id: installationId,
    properties: {
      product: "api_key_case",
      surface: "cli",
      command: "scan",
      outcome: "success",
      cli_version: "1.2.3",
      os_family: "windows",
      "$process_person_profile": false
    }
  });

  // A later command uses the same installation ID and only adds an allowlisted
  // deploy target. No secret/project context can enter the event object.
  const later = createCliTelemetry({
    baseDir: home,
    env: tokenEnv,
    platform: "win32",
    isTTY: true,
    cliVersion: "1.2.3",
    writeNotice: (message) => notices.push(message),
    capture: (event) => events.push(event)
  });
  later.prepare();
  await later.record({
    command: "deploy",
    outcome: "failure",
    errorCategory: "operation_failed",
    target: "github"
  });
  assert.equal(notices.length, 1);
  assert.deepEqual(events[1].properties, {
    product: "api_key_case",
    surface: "cli",
    command: "deploy",
    outcome: "failure",
    cli_version: "1.2.3",
    os_family: "windows",
    error_category: "operation_failed",
    target: "github",
    "$process_person_profile": false
  });

  for (const forbidden of [
    "sk-canary-secret",
    "OPENAI_API_KEY",
    "C:\\Users\\private-project",
    "melavern/api-key-case",
    "entitlement-123",
    "order-123",
    "person@example.invalid",
    "raw argv value"
  ]) {
    assert.equal(JSON.stringify(events).includes(forbidden), false, `telemetry exposed ${forbidden}`);
  }

  // Disable persists the off setting while deleting the ID. Re-enable starts
  // a fresh installation identity.
  assert.equal(disableTelemetry(home), true);
  const disabledState = readTelemetryState(home);
  assert.equal(disabledState.enabled, false);
  assert.equal(disabledState.installationId, undefined);
  assert.equal(getTelemetryStatus({ baseDir: home, env: tokenEnv }).effective, false);

  const disabledEvents = [];
  const disabled = createCliTelemetry({
    baseDir: home,
    env: tokenEnv,
    isTTY: true,
    cliVersion: "1.2.3",
    capture: (event) => disabledEvents.push(event)
  });
  disabled.prepare();
  await disabled.record({ command: "save", outcome: "success" });
  assert.deepEqual(disabledEvents, []);

  assert.equal(enableTelemetry(home), true);
  assert.equal(readTelemetryState(home).installationId, undefined);
  const reenabledEvents = [];
  const reenabled = createCliTelemetry({
    baseDir: home,
    env: tokenEnv,
    isTTY: true,
    cliVersion: "1.2.3",
    randomId: () => nextInstallationId,
    capture: (event) => reenabledEvents.push(event)
  });
  reenabled.prepare();
  await reenabled.record({ command: "save", outcome: "success" });
  assert.equal(reenabledEvents[0].distinct_id, nextInstallationId);
  assert.notEqual(reenabledEvents[0].distinct_id, installationId);

  // CI and DNT are effective overrides even when the saved setting is on.
  for (const [label, env] of [
    ["ci", { ...tokenEnv, CI: "1" }],
    ["dnt", { ...tokenEnv, DO_NOT_TRACK: "1" }]
  ]) {
    const overrideEvents = [];
    const overrideHome = join(root, label);
    const override = createCliTelemetry({
      baseDir: overrideHome,
      env,
      isTTY: true,
      cliVersion: "1.2.3",
      randomId: () => installationId,
      writeNotice: () => { throw new Error("must not show notice"); },
      capture: (event) => overrideEvents.push(event)
    });
    override.prepare();
    await override.record({ command: "license_activate", outcome: "success" });
    assert.deepEqual(overrideEvents, [], `${label} must suppress telemetry`);
    assert.equal(getTelemetryStatus({ baseDir: overrideHome, env }).effective, false);
  }

  const statusHome = join(root, "status-cli");
  const status = spawnSync(process.execPath, [cliPath, "telemetry", "status", "--json"], {
    encoding: "utf8",
    cwd: root,
    env: isolatedHomeEnv(statusHome)
  });
  assert.equal(status.status, 0);
  const statusJson = JSON.parse(status.stdout);
  assert.equal(statusJson.configured, true);
  assert.equal(statusJson.effective, false);
  assert.equal(statusJson.installationIdPresent, false);
  assert.equal(status.stdout.includes(installationId), false);

  const disabledCli = spawnSync(process.execPath, [cliPath, "telemetry", "disable"], {
    encoding: "utf8",
    cwd: root,
    env: isolatedHomeEnv(statusHome)
  });
  assert.equal(disabledCli.status, 0);
  assert.match(disabledCli.stdout, /telemetry disabled/i);
  assert.equal(readTelemetryState(statusHome).enabled, false);
  assert.equal(readTelemetryState(statusHome).installationId, undefined);

  const disabledStatus = spawnSync(process.execPath, [cliPath, "telemetry", "status", "--json"], {
    encoding: "utf8",
    cwd: root,
    env: isolatedHomeEnv(statusHome)
  });
  assert.equal(disabledStatus.status, 0);
  assert.deepEqual(JSON.parse(disabledStatus.stdout), {
    configured: false,
    effective: false,
    noticeShown: false,
    installationIdPresent: false,
    suppression: "disabled"
  });

  const enabledCli = spawnSync(process.execPath, [cliPath, "telemetry", "enable"], {
    encoding: "utf8",
    cwd: root,
    env: isolatedHomeEnv(statusHome)
  });
  assert.equal(enabledCli.status, 0);
  assert.match(enabledCli.stdout, /telemetry enabled/i);

  // The real CLI keeps JSON stdout clean and does not send on its first
  // non-TTY invocation, even when a project token is present.
  const cliProject = join(root, "cli-project");
  mkdirSync(cliProject, { recursive: true });
  write(cliProject, "src/index.js", "export {}\n");
  const cleanEnv = isolatedHomeEnv(join(root, "cli-home"));
  cleanEnv.API_KEY_CASE_POSTHOG_PROJECT_TOKEN = "test-project-token";
  for (const key of [
    "CI", "DO_NOT_TRACK", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS",
    "GITLAB_CI", "JENKINS_URL", "BUILDKITE", "CIRCLECI", "TF_BUILD", "TEAMCITY_VERSION"
  ]) delete cleanEnv[key];
  const cliScan = spawnSync(process.execPath, [cliPath, "scan", cliProject, "--json"], {
    encoding: "utf8",
    cwd: root,
    env: cleanEnv
  });
  assert.equal(cliScan.status, 0);
  assert.doesNotThrow(() => JSON.parse(cliScan.stdout));
  assert.equal(cliScan.stderr.includes("anonymous usage statistics"), false);
  assert.equal(existsSync(telemetryFilePath(join(root, "cli-home"))), false);

  // Provider failure and a hanging provider are both swallowed by the
  // best-effort boundary.
  const failure = createCliTelemetry({
    baseDir: join(root, "provider-failure"),
    env: tokenEnv,
    isTTY: true,
    cliVersion: "1.2.3",
    randomId: () => installationId,
    writeNotice: () => {},
    fetcher: async () => { throw new Error("provider outage"); }
  });
  failure.prepare();
  await assert.doesNotReject(() => failure.record({ command: "scan", outcome: "success" }));

  const timeout = createCliTelemetry({
    baseDir: join(root, "provider-timeout"),
    env: tokenEnv,
    isTTY: true,
    cliVersion: "1.2.3",
    randomId: () => installationId,
    writeNotice: () => {},
    timeoutMs: 5,
    fetcher: () => new Promise(() => {})
  });
  timeout.prepare();
  await assert.doesNotReject(() => timeout.record({ command: "scan", outcome: "success" }));

  let transportCall;
  const transport = createCliTelemetry({
    baseDir: join(root, "provider-payload"),
    env: tokenEnv,
    platform: "linux",
    isTTY: true,
    cliVersion: "1.2.3",
    randomId: () => installationId,
    writeNotice: () => {},
    fetcher: async (endpoint, init) => {
      transportCall = { endpoint, body: JSON.parse(init.body) };
      return { ok: true };
    }
  });
  transport.prepare();
  await transport.record({ command: "deploy", outcome: "success", target: "cloudflare" });
  assert.equal(transportCall.endpoint, "https://us.i.posthog.com/i/v0/e/");
  assert.deepEqual(transportCall.body, {
    api_key: "test-project-token",
    event: "cli_command_result",
    distinct_id: installationId,
    properties: {
      product: "api_key_case",
      surface: "cli",
      command: "deploy",
      outcome: "success",
      cli_version: "1.2.3",
      os_family: "linux",
      target: "cloudflare",
      "$process_person_profile": false
    }
  });
  for (const forbidden of [
    "OPENAI_API_KEY",
    "sk-canary-secret",
    "C:\\Users\\private-project",
    "project-123",
    "raw terminal input"
  ]) {
    assert.equal(JSON.stringify(transportCall.body).includes(forbidden), false);
  }

  // Once the release-time public token is filled, the real production path
  // must use it without requiring an environment variable. Keep the transport
  // injected so this test never contacts PostHog.
  if (POSTHOG_PUBLIC_PROJECT_TOKEN) {
    let publicTransportCall;
    const publicTransport = createCliTelemetry({
      baseDir: join(root, "public-fallback-payload"),
      env: {},
      platform: "linux",
      isTTY: true,
      cliVersion: "1.2.3",
      randomId: () => installationId,
      writeNotice: () => {},
      fetcher: async (endpoint, init) => {
        publicTransportCall = { endpoint, body: JSON.parse(init.body) };
        return { ok: true };
      }
    });
    publicTransport.prepare();
    await publicTransport.record({ command: "scan", outcome: "success" });
    assert.equal(publicTransportCall.endpoint, `${POSTHOG_PUBLIC_CONFIG.apiHost}/i/v0/e/`);
    assert.equal(publicTransportCall.body.api_key, POSTHOG_PUBLIC_PROJECT_TOKEN);
  }

  const payload = buildCliTelemetryEvent(
    { command: "deploy", outcome: "cancelled", errorCategory: "confirmation_declined", target: "vercel" },
    { installationId, cliVersion: "1.2.3", platform: "linux" }
  );
  assert.deepEqual(payload, {
    event: "cli_command_result",
    distinct_id: installationId,
    properties: {
      product: "api_key_case",
      surface: "cli",
      command: "deploy",
      outcome: "cancelled",
      cli_version: "1.2.3",
      os_family: "linux",
      error_category: "confirmation_declined",
      target: "vercel",
      "$process_person_profile": false
    }
  });

  const extraContext = buildCliTelemetryEvent(
    {
      command: "scan",
      outcome: "failure",
      errorCategory: "operation_failed",
      secretName: "OPENAI_API_KEY",
      path: "C:\\Users\\private-project",
      argv: ["scan", "."],
      projectId: "project-123",
      product: "user-controlled-product",
      surface: "user-controlled-surface"
    },
    { installationId, cliVersion: "1.2.3", platform: "linux" }
  );
  assert.deepEqual(extraContext?.properties, {
    product: "api_key_case",
    surface: "cli",
    command: "scan",
    outcome: "failure",
    cli_version: "1.2.3",
    os_family: "linux",
    error_category: "operation_failed",
    "$process_person_profile": false
  });

  const scannerSource = readFileSync(new URL("../packages/core/scanner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(scannerSource, /telemetry|posthog|fetch\s*\(|https?:\/\//i);
}

async function testNextActionSchema(root) {
  mkdirSync(root, { recursive: true });
  const unsupportedName = "A".repeat(129);
  write(root, ".gitignore", ".env\n.env.*\n!.env.example\n");
  write(
    root,
    ".env.example",
    [
      `OPENAI_API_KEY=${canaryOpenAi}`,
      "USER_SHARED_KEY=",
      "MISSING_API_KEY=",
      `${unsupportedName}=`,
      ""
    ].join("\n")
  );
  write(
    root,
    "app.ts",
    [
      "process.env.OPENAI_API_KEY;",
      "process.env.USER_SHARED_KEY;",
      "process.env.MISSING_API_KEY;"
    ].join("\n")
  );

  const projectId = deriveProjectId(root);
  const vaultA = new MemoryVault();
  const vaultB = new MemoryVault();
  await vaultA.setSecret(
    { name: "OPENAI_API_KEY", scope: "project", projectId },
    canaryOpenAi
  );
  await vaultB.setSecret(
    { name: "OPENAI_API_KEY", scope: "project", projectId },
    "different-value-with-a-different-length"
  );
  await vaultA.setSecret(
    { name: "USER_SHARED_KEY", scope: "user", projectId: null },
    "tiny"
  );
  await vaultB.setSecret(
    { name: "USER_SHARED_KEY", scope: "user", projectId: null },
    "another-completely-different-value"
  );

  const providerCanary = "provider-output-canary";
  const adapters = [
    statusOnlyAdapter("cloudflare", true, {
      installed: true,
      loggedIn: true,
      version: providerCanary,
      hint: providerCanary
    }),
    statusOnlyAdapter("vercel", true, {
      installed: false,
      loggedIn: false,
      hint: providerCanary
    }),
    statusOnlyAdapter("github", false, {
      installed: true,
      loggedIn: false,
      hint: providerCanary
    })
  ];

  // A project-scoped Secret the project no longer references is a Phase E
  // cleanup candidate. The index only supplies the candidate name; both vaults
  // must actually hold it for `next` to report it.
  const unusedRef = { name: "RETIRED_API_KEY", scope: "project", projectId };
  await vaultA.setSecret(unusedRef, canaryOpenAi);
  await vaultB.setSecret(unusedRef, "a-completely-different-retired-value");
  upsertRegistryEntry(
    { name: unusedRef.name, scope: "project", projectId, projectPath: root },
    root
  );
  // An index row whose store entry is gone, and one with a name the closed
  // validation rejects, must not become cleanup candidates.
  upsertRegistryEntry(
    { name: "STALE_INDEX_ONLY_KEY", scope: "project", projectId, projectPath: root },
    root
  );
  upsertRegistryEntry(
    { name: "not-a-valid-name", scope: "project", projectId, projectPath: root },
    root
  );

  const reportA = await buildNextReport(root, {
    vault: vaultA,
    adapters,
    licensePlan: "pro",
    registryBaseDir: root
  });
  const reportB = await buildNextReport(root, {
    vault: vaultB,
    adapters,
    licensePlan: "pro",
    registryBaseDir: root
  });
  assert.deepEqual(reportA, reportB, "next output must not vary with Secret values or lengths");

  assert.deepEqual(Object.keys(reportA).sort(), [
    "host",
    "hygiene",
    "license",
    "nextActions",
    "schemaVersion",
    "secrets",
    "setup",
    "targets",
    "vault"
  ]);
  assert.deepEqual(Object.keys(reportA.vault), ["status"]);
  assert.deepEqual(Object.keys(reportA.license), ["plan"]);
  assert.deepEqual(Object.keys(reportA.hygiene).sort(), ["gitignoreOk", "possibleExposure"]);
  for (const secret of reportA.secrets) {
    assert.deepEqual(Object.keys(secret).sort(), ["name", "scope", "status"]);
  }
  for (const target of reportA.targets) {
    assert.deepEqual(Object.keys(target).sort(), ["cliStatus", "deployment", "detected", "id", "readiness"]);
    assert.deepEqual(Object.keys(target.deployment).sort(), [
      "automatic",
      "destinationTrust",
      "humanApproval"
    ]);
    // The two lists always partition the closed environment enum.
    assert.deepEqual(
      [...target.deployment.automatic, ...target.deployment.humanApproval].sort(),
      ["development", "preview", "production"]
    );
  }
  assert.equal(reportA.schemaVersion, 2);
  assert.equal(reportA.vault.status, "available");
  assert.equal(reportA.license.plan, "pro");
  assert.deepEqual(
    reportA.secrets.map((entry) => [entry.name, entry.scope, entry.status]),
    [
      [unsupportedName, null, "unsupported"],
      ["MISSING_API_KEY", "project", "missing"],
      ["OPENAI_API_KEY", "project", "registered"],
      ["USER_SHARED_KEY", "user", "registered"],
      ["RETIRED_API_KEY", "project", "unused"]
    ],
    "an index row without a stored value is not a cleanup candidate"
  );
  const allEnvs = ["production", "preview", "development"];
  assert.deepEqual(reportA.targets.map(({ readiness, ...target }) => target), [
    {
      id: "cloudflare",
      detected: true,
      cliStatus: "ready",
      // wrangler secret put always overwrites, so Cloudflare has no
      // automatic-safe environment to resolve a destination for.
      deployment: { automatic: [], humanApproval: allEnvs, destinationTrust: "not-applicable" }
    },
    {
      id: "vercel",
      detected: true,
      cliStatus: "missing",
      deployment: { automatic: [], humanApproval: allEnvs, destinationTrust: "unresolved" }
    },
    {
      id: "github",
      detected: false,
      cliStatus: "unauthenticated",
      deployment: { automatic: [], humanApproval: allEnvs, destinationTrust: "not-applicable" }
    }
  ]);
  assert.equal(
    reportA.nextActions.some((action) => action.kind === "approve-deploy-destination"),
    false,
    "an unresolved destination must not ask a human to approve one"
  );
  assert.ok(
    reportA.nextActions.some(
      (action) => action.actor === "human" && action.kind === "register-secret"
    )
  );
  assert.ok(
    reportA.nextActions.some(
      (action) => action.actor === "agent" && action.kind === "review-secret-name"
    )
  );
  assert.equal(reportA.nextActions.some((action) => action.kind === "deploy"), false);
  assert.deepEqual(
    reportA.nextActions.filter((action) => action.kind === "remove-secret"),
    [{ actor: "human", kind: "remove-secret", name: "RETIRED_API_KEY", scope: "project" }],
    "cleanup is proposed as a human action, never performed"
  );
  assert.equal(
    reportA.nextActions.some((action) => action.kind === "forget-deploy-destination"),
    false,
    "no destination is confirmed here, so nothing is a trust cleanup candidate"
  );

  const serialized = JSON.stringify(reportA);
  assertNoCanary("next report", serialized);
  assert.equal(serialized.includes(providerCanary), false);
  assert.equal(
    serialized.includes(createHash("sha256").update(canaryOpenAi).digest("hex")),
    false
  );
  assertClosedNextSchema(reportA);

  let unavailableHasCalls = 0;
  const unavailableVault = {
    backendName: "unavailable-test",
    isAvailable: async () => false,
    setSecret: async () => {
      throw new Error("must not set");
    },
    hasSecret: async () => {
      unavailableHasCalls += 1;
      throw new Error("must not inspect");
    },
    deleteSecret: async () => false
  };
  const unavailable = await buildNextReport(root, {
    vault: unavailableVault,
    adapters: [],
    licensePlan: "free",
    registryBaseDir: root
  });
  assert.equal(unavailableHasCalls, 0);
  assert.equal(unavailable.vault.status, "unavailable");
  assert.ok(
    unavailable.secrets
      .filter((entry) => entry.status !== "unsupported")
      .every((entry) => entry.status === "unavailable" && entry.scope === null)
  );
  assert.ok(
    unavailable.nextActions.some(
      (action) => action.actor === "human" && action.kind === "enable-vault"
    )
  );
}

function statusOnlyAdapter(id, detected, cliStatus) {
  return {
    id,
    cliCommand: id,
    detect: async () => ({ detected, reason: "provider-output-canary" }),
    checkCli: async () => cliStatus,
    planDeploy: () => {
      throw new Error("Phase A next must not create a deploy plan");
    },
    manualSteps: () => []
  };
}

function assertClosedNextSchema(report) {
  const forbiddenKeys = new Set([
    "argv",
    "command",
    "hash",
    "hint",
    "length",
    "message",
    "preview",
    "reason",
    "value"
  ]);

  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `next schema exposed forbidden key: ${key}`);
      visit(nested);
    }
  }

  visit(report);
  const actionKeys = {
    "fix-gitignore": ["actor", "kind"],
    "review-possible-exposure": ["actor", "kind"],
    "enable-vault": ["actor", "kind"],
    "review-secret-name": ["actor", "kind", "name"],
    "register-secret": ["actor", "kind", "name", "scope"],
    "install-target-cli": ["actor", "kind", "target"],
    "review-deploy-setup": ["actor", "kind", "target"],
    "authenticate-target-cli": ["actor", "kind", "target"],
    "approve-deploy-destination": ["actor", "kind", "target", "env"],
    "remove-secret": ["actor", "kind", "name", "scope"],
    "forget-deploy-destination": ["actor", "kind", "target", "env"]
  };
  const actionActors = {
    "fix-gitignore": "agent",
    "review-possible-exposure": "human",
    "enable-vault": "human",
    "review-secret-name": "agent",
    "register-secret": "human",
    "install-target-cli": "agent",
    "review-deploy-setup": "agent",
    "authenticate-target-cli": "human",
    "approve-deploy-destination": "human",
    // Deleting a Secret and forgetting a destination are never actor: agent.
    "remove-secret": "human",
    "forget-deploy-destination": "human"
  };
  for (const action of report.nextActions) {
    assert.ok(action.actor === "agent" || action.actor === "human");
    assert.deepEqual(Object.keys(action).sort(), actionKeys[action.kind].slice().sort());
    assert.equal(action.actor, actionActors[action.kind]);
  }

  const envs = new Set(["production", "preview", "development"]);
  const trustStates = new Set(["trusted", "changed", "unconfirmed", "unresolved", "not-applicable"]);
  for (const target of report.targets) {
    assert.ok(trustStates.has(target.deployment.destinationTrust));
    for (const env of [...target.deployment.automatic, ...target.deployment.humanApproval]) {
      assert.ok(envs.has(env), `next schema exposed a non-enum environment: ${env}`);
    }
    // Only a human-confirmed destination may appear as automatic.
    if (target.deployment.automatic.length > 0) {
      assert.equal(target.deployment.destinationTrust, "trusted");
    }
  }
  for (const action of report.nextActions.filter((a) => a.kind === "approve-deploy-destination")) {
    const target = report.targets.find((entry) => entry.id === action.target);
    assert.ok(target);
    assert.ok(["unconfirmed", "changed"].includes(target.deployment.destinationTrust));
  }
  // Only a stale confirmation is a trust cleanup candidate.
  for (const action of report.nextActions.filter((a) => a.kind === "forget-deploy-destination")) {
    const target = report.targets.find((entry) => entry.id === action.target);
    assert.ok(target);
    assert.equal(target.deployment.destinationTrust, "changed");
  }
  const statuses = new Set(["registered", "missing", "unavailable", "unsupported", "unused"]);
  for (const secret of report.secrets) {
    assert.ok(statuses.has(secret.status), `next schema exposed a non-enum status: ${secret.status}`);
  }
  // Every cleanup candidate is reported as an unused Secret, and vice versa.
  assert.deepEqual(
    report.nextActions.filter((a) => a.kind === "remove-secret").map((a) => a.name).sort(),
    report.secrets.filter((s) => s.status === "unused").map((s) => s.name).sort()
  );
}

function testNextCliJson(root) {
  mkdirSync(root, { recursive: true });
  write(root, ".gitignore", ".env\n.env.*\n!.env.example\n");
  write(root, ".env.example", `CLI_NEXT_API_KEY=${canaryOpenAi}\n`);
  const result = spawnSync(process.execPath, [cliPath, "next", "--json", root], {
    encoding: "utf8",
    timeout: 60_000,
    env: isolatedHomeEnv(join(root, "home"))
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schemaVersion, 2);
  assertClosedNextSchema(parsed);
  assertNoCanary("next CLI stdout", result.stdout);
  assertNoCanary("next CLI stderr", result.stderr);
}

function testAgentInitManagedInstructions(root) {
  mkdirSync(root, { recursive: true });
  const agentsOriginal = "# Existing instructions\n\nKeep this exact content.";
  const claudeOriginal = "# Claude\n\n@AGENTS.md\n";
  write(root, "AGENTS.md", agentsOriginal);
  write(root, "CLAUDE.md", claudeOriginal);

  const missingCheck = initializeAgentInstructions({
    projectDir: root,
    packageVersion: "0.9.1",
    check: true
  });
  assert.deepEqual(missingCheck.files, [{ path: "AGENTS.md", status: "missing" }]);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), agentsOriginal);

  const first = initializeAgentInstructions({
    projectDir: root,
    packageVersion: "0.9.1",
    check: false
  });
  assert.equal(first.persistence, "configured");
  assert.deepEqual(first.files, [{ path: "AGENTS.md", status: "updated" }]);
  const generated = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.equal(generated.startsWith(agentsOriginal), true);
  assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), claudeOriginal);
  assert.match(generated, /api-key-case@0\.9\.1 next --json \./);
  assert.match(generated, /generated-by=0\.9\.1/);
  assert.match(generated, /managed instruction block only: 0BSD/);
  assert.doesNotMatch(generated, /SPDX-License-Identifier:/);
  assert.equal(generated.includes("@latest"), false);
  assert.equal(renderAgentProtocol("0.9.1").includes("api-key-case@0.9.1 next --json ."), true);
  assert.equal(renderAgentProtocol("0.9.1").includes("api-key-case@0.9.1 save <NAME> --ask"), true);
  assert.equal(renderAgentProtocol("0.9.1").includes("@latest"), false);

  const second = initializeAgentInstructions({
    projectDir: root,
    packageVersion: "0.9.1",
    check: false
  });
  assert.deepEqual(second.files, [{ path: "AGENTS.md", status: "current" }]);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), generated);

  const suffix = "\nUser suffix after managed content.\n";
  writeFileSync(join(root, "AGENTS.md"), `${generated}${suffix}`, "utf8");
  const updated = initializeAgentInstructions({
    projectDir: root,
    packageVersion: "0.9.2",
    check: false
  });
  assert.deepEqual(updated.files, [{ path: "AGENTS.md", status: "updated" }]);
  const updatedContent = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.equal(updatedContent.startsWith(agentsOriginal), true);
  assert.equal(updatedContent.endsWith(suffix), true);
  assert.match(updatedContent, /api-key-case@0\.9\.2 next --json \./);
  assert.match(updatedContent, /generated-by=0\.9\.2/);

  const beforeOutdatedCheck = readFileSync(join(root, "AGENTS.md"), "utf8");
  const outdatedCheck = initializeAgentInstructions({
    projectDir: root,
    packageVersion: "0.9.9",
    check: true
  });
  assert.deepEqual(outdatedCheck.files, [{ path: "AGENTS.md", status: "outdated" }]);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), beforeOutdatedCheck);

  const upgraded = initializeAgentInstructions({
    projectDir: root,
    packageVersion: "0.9.9",
    check: false
  });
  assert.deepEqual(upgraded.files, [{ path: "AGENTS.md", status: "updated" }]);
  const beforeCheck = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.equal(beforeCheck.startsWith(agentsOriginal), true);
  assert.equal(beforeCheck.endsWith(suffix), true);
  assert.match(beforeCheck, /api-key-case@0\.9\.9 next --json \./);

  const check = initializeAgentInstructions({
    projectDir: root,
    packageVersion: "0.9.9",
    check: true
  });
  assert.deepEqual(check.files, [{ path: "AGENTS.md", status: "current" }]);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), beforeCheck);

  const drifted = beforeCheck.replace("perform `actor: agent` actions yourself", "perform every action");
  writeFileSync(join(root, "AGENTS.md"), drifted, "utf8");
  const driftCheck = initializeAgentInstructions({
    projectDir: root,
    packageVersion: "0.9.2",
    check: true
  });
  assert.deepEqual(driftCheck.files, [{ path: "AGENTS.md", status: "drift" }]);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), drifted);
  assert.throws(
    () =>
      initializeAgentInstructions({
        projectDir: root,
        packageVersion: "0.9.2",
        check: false
      }),
    AgentInitSafetyError
  );
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), drifted);

  const noHostRoot = join(root, "no-host");
  mkdirSync(noHostRoot, { recursive: true });
  const noHost = initializeAgentInstructions({
    projectDir: noHostRoot,
    packageVersion: "0.9.1",
    check: false
  });
  assert.equal(noHost.persistence, "unavailable");
  assert.equal(existsSync(join(noHostRoot, "AGENTS.md")), false);
}

function testAgentInitSafety(root) {
  mkdirSync(root, { recursive: true });
  const project = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside, { recursive: true });
  write(outside, "sentinel.txt", "outside-sentinel");

  assert.throws(() => assertSafeProjectPath(project, "../outside/sentinel.txt"), AgentInitSafetyError);

  write(project, "AGENTS.md", "<!-- api-key-case:managed:start malformed -->\nuser-content\n");
  const malformedBefore = readFileSync(join(project, "AGENTS.md"), "utf8");
  assert.throws(
    () =>
      initializeAgentInstructions({
        projectDir: project,
        packageVersion: "0.9.1",
        check: false
      }),
    AgentInitSafetyError
  );
  assert.equal(readFileSync(join(project, "AGENTS.md"), "utf8"), malformedBefore);

  const linkedProject = join(root, "linked-project");
  mkdirSync(linkedProject, { recursive: true });
  symlinkSync(outside, join(linkedProject, ".cursor"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () =>
      initializeAgentInstructions({
        projectDir: linkedProject,
        packageVersion: "0.9.1",
        check: false
      }),
    AgentInitSafetyError
  );
  assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "outside-sentinel");
  assert.equal(existsSync(join(outside, "rules", "api-key-case.mdc")), false);

  const cliUnsafeCheck = spawnSync(
    process.execPath,
    [cliPath, "agent-init", linkedProject, "--check"],
    { encoding: "utf8" }
  );
  assert.equal(cliUnsafeCheck.status, 2);
  assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "outside-sentinel");
  assert.equal(existsSync(join(outside, "rules", "api-key-case.mdc")), false);

  const nestedLinkedProject = join(root, "nested-linked-project");
  const outsideRules = join(root, "outside-rules");
  mkdirSync(join(nestedLinkedProject, ".cursor"), { recursive: true });
  mkdirSync(outsideRules, { recursive: true });
  write(outsideRules, "sentinel.txt", "nested-outside-sentinel");
  symlinkSync(
    outsideRules,
    join(nestedLinkedProject, ".cursor", "rules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  assert.throws(
    () =>
      initializeAgentInstructions({
        projectDir: nestedLinkedProject,
        packageVersion: "0.9.1",
        check: true
      }),
    AgentInitSafetyError
  );
  assert.equal(
    readFileSync(join(outsideRules, "sentinel.txt"), "utf8"),
    "nested-outside-sentinel"
  );
  assert.equal(existsSync(join(outsideRules, "api-key-case.mdc")), false);

  const cursorProject = join(root, "cursor-project");
  mkdirSync(join(cursorProject, ".cursor"), { recursive: true });
  const cursorResult = initializeAgentInstructions({
    projectDir: cursorProject,
    packageVersion: "0.9.1",
    check: false
  });
  assert.deepEqual(cursorResult.files, [
    { path: ".cursor/rules/api-key-case.mdc", status: "created" }
  ]);
  const cursorInstruction = readFileSync(
    join(cursorProject, ".cursor", "rules", "api-key-case.mdc"),
    "utf8"
  );
  assert.match(cursorInstruction, /^---\n/);
  assert.equal(cursorInstruction.includes("@latest"), false);
}

function testAgentInitCli(root) {
  mkdirSync(root, { recursive: true });
  write(root, "AGENTS.md", "# Existing CLI fixture\n");
  const init = spawnSync(process.execPath, [cliPath, "agent-init", root], {
    encoding: "utf8"
  });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /API Key Case agent protocol/);
  assert.match(init.stdout, /api-key-case@0\.9\.1 next --json \./);
  assert.equal(init.stdout.includes("@latest"), false);

  const beforeCheck = readFileSync(join(root, "AGENTS.md"), "utf8");
  const check = spawnSync(process.execPath, [cliPath, "agent-init", root, "--check"], {
    encoding: "utf8"
  });
  assert.equal(check.status, 0, check.stderr);
  const parsed = JSON.parse(check.stdout);
  assert.deepEqual(parsed.files, [{ path: "AGENTS.md", status: "current" }]);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), beforeCheck);

  const stale = initializeAgentInstructions({
    projectDir: root,
    packageVersion: "0.9.0",
    check: false
  });
  assert.deepEqual(stale.files, [{ path: "AGENTS.md", status: "updated" }]);
  const staleBeforeCheck = readFileSync(join(root, "AGENTS.md"), "utf8");
  const staleCheck = spawnSync(process.execPath, [cliPath, "agent-init", root, "--check"], {
    encoding: "utf8"
  });
  assert.equal(staleCheck.status, 2, staleCheck.stderr);
  assert.deepEqual(JSON.parse(staleCheck.stdout).files, [{ path: "AGENTS.md", status: "outdated" }]);
  assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), staleBeforeCheck);

  const refresh = spawnSync(process.execPath, [cliPath, "agent-init", root], {
    encoding: "utf8"
  });
  assert.equal(refresh.status, 0, refresh.stderr);
  assert.match(refresh.stdout, /api-key-case@0\.9\.1 next --json \./);
  assert.match(refresh.stdout, /updated: AGENTS\.md/);
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

// The Windows helper environment is an allowlist that must be *set*, not
// merely left empty: on Windows libuv fills PATH, TEMP, USERPROFILE,
// HOMEDRIVE, HOMEPATH and SYSTEMDRIVE in from the parent whenever the spawn
// options omit them. Omitting one therefore means inheriting the Agent's.
function assertWindowsHelperEnv(env, agentPath) {
  const systemPath = [
    "C:\\Windows\\System32",
    "C:\\Windows",
    "C:\\Windows\\System32\\Wbem",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0"
  ].join(";");
  assert.deepEqual(Object.keys(env).sort(), [
    "ComSpec",
    "HOMEDRIVE",
    "HOMEPATH",
    "PATH",
    "PATHEXT",
    "SYSTEMDRIVE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR"
  ]);
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.WINDIR, "C:\\Windows");
  assert.equal(env.SYSTEMDRIVE, "C:");
  assert.equal(env.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(env.PATH, systemPath);
  if (agentPath) {
    assert.equal(env.PATH.includes(agentPath), false, "the Agent PATH reached the helper");
  }
  // A per-call scratch directory, not the caller's temp directory.
  assert.equal(env.TEMP, env.TMP);
  assert.match(env.TEMP, /api-key-case-helper-/);
  assert.notEqual(env.TEMP, process.env.TEMP);
  assert.notEqual(env.TEMP, process.env.TMP);
  // USERPROFILE comes from the OS profile lookup rather than from the caller's
  // value. On a real host the two legitimately match, so this checks shape only.
  assert.ok(env.USERPROFILE.length > 0);
  assert.equal(env.HOMEDRIVE + env.HOMEPATH, env.USERPROFILE);

  for (const forbiddenEnv of [
    "Path",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "VERCEL_TOKEN",
    "VERCEL_ORG_ID",
    "VERCEL_PROJECT_ID"
  ]) {
    assert.equal(forbiddenEnv in env, false, `${forbiddenEnv} reached the helper`);
  }
}

async function testHumanPlaneSecretBoundary(root) {
  mkdirSync(root, { recursive: true });
  write(root, ".gitignore", ".env\n.env.*\n!.env.example\n");
  write(root, ".env.example", "HUMAN_PLANE_TEST_KEY=\n");

  const ref = {
    name: "HUMAN_PLANE_TEST_KEY",
    scope: "project",
    projectId: deriveProjectId(root),
    projectDir: root.replace(/\\/g, "/")
  };
  const humanCanary = ["sk-", "human-plane-canary-0123456789"].join("");
  const vault = new MemoryVault();
  let helperRequest;

  // The fake launcher represents the trusted helper boundary: it knows the
  // synthetic value and writes it directly to the store. The caller receives
  // only the helper exit code and the mapped status.
  const humanPlane = new WindowsHumanPlane(WINDOWS_POWERSHELL_PATH, async (request) => {
    helperRequest = request;
    await vault.setSecret(ref, humanCanary);
    return 0;
  });

  let status;
  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  write(fakeBin, "powershell.exe", "fake helper must never run\n");
  await withEnv(
    {
      PATH: fakeBin,
      NODE_OPTIONS: "--require=agent-owned-injection.js",
      LD_PRELOAD: "agent-owned-injection.so",
      DYLD_INSERT_LIBRARIES: "agent-owned-injection.dylib",
      GH_TOKEN: "agent-owned-provider-auth",
      CLOUDFLARE_API_TOKEN: "agent-owned-provider-auth",
      VERCEL_TOKEN: "agent-owned-provider-auth"
    },
    async () => {
      status = await askAndRecordSecret(
        humanPlane,
        ref,
        root.replace(/\\/g, "/"),
        (entry) => upsertRegistryEntry(entry, root)
      );
    }
  );
  assert.equal(status, "saved");
  assert.equal(await vault.hasSecret(ref), true);
  assert.ok(helperRequest);
  assert.equal(helperRequest.executable, WINDOWS_POWERSHELL_PATH);
  assert.equal(helperRequest.cwd, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0");
  assertWindowsHelperEnv(helperRequest.env, fakeBin);
  assert.equal(helperRequest.detached, false);
  assert.equal(helperRequest.shell, false);
  assert.equal(helperRequest.stdio, "ignore");
  assert.equal(helperRequest.windowsHide, false);

  const encodedIndex = helperRequest.args.indexOf("-EncodedCommand") + 1;
  assert.ok(encodedIndex > 0);
  const helperScript = Buffer.from(helperRequest.args[encodedIndex], "base64").toString("utf16le");
  assert.equal(helperScript, buildWindowsSecretInputScript(ref));
  assert.match(helperScript, /UseSystemPasswordChar = \$true/);
  assert.match(helperScript, /CredWrite/);
  assert.match(helperScript, /Registration destination: This project/);
  assert.match(helperScript, /登録先：このプロジェクト/);
  assert.ok(helperScript.includes(ref.projectDir));
  assert.doesNotMatch(helperScript, /Project ID:|Provider:|Deploy environment:/);
  assertLocalizedWindowsDialog(
    helperScript,
    "Windows Secret input",
    WINDOWS_DIALOG_TEXT.secretInputCaption,
    WINDOWS_DIALOG_TEXT.saveButton,
    WINDOWS_DIALOG_TEXT.cancelButton
  );
  assert.doesNotMatch(
    helperScript,
    /UserConsentVerifier|RequestVerificationForWindowAsync/,
    "Secret input must keep its existing value boundary independent of approval verification"
  );
  assert.doesNotMatch(helperScript, /Write-(Host|Output|Error)|Console\.Write/);
  assert.equal(helperScript.includes(humanCanary), false);

  if (process.platform === "win32") {
    assert.equal(resolveWindowsPowerShell(), WINDOWS_POWERSHELL_PATH);
    const parsed = parseWindowsHelperScript(helperScript);
    assert.equal(parsed.status, 0, "Windows Human Plane helper script must parse");
  }

  const callerVisible = JSON.stringify({ status, helperRequest });
  assert.equal(callerVisible.includes(humanCanary), false);
  assert.equal(helperRequest.args.join(" ").includes(humanCanary), false);
  assert.equal(JSON.stringify(helperRequest.env).includes(humanCanary), false);

  const registryContent = readFileSync(join(root, ".api-key-case", "index.json"), "utf8");
  assert.equal(registryContent.includes(humanCanary), false);

  const next = await buildNextReport(root, {
    vault,
    adapters: [],
    licensePlan: "free",
    registryBaseDir: root
  });
  assert.deepEqual(next.secrets, [
    { name: ref.name, scope: "project", status: "registered" }
  ]);
  assert.equal(
    next.nextActions.some((action) => action.kind === "register-secret"),
    false
  );
  assert.equal(JSON.stringify(next).includes(humanCanary), false);

  let cancellationRecords = 0;
  const cancelled = await askAndRecordSecret(
    new WindowsHumanPlane(WINDOWS_POWERSHELL_PATH, async () => 2),
    { name: "HUMAN_PLANE_CANCELLED", scope: "user", projectId: null },
    null,
    () => {
      cancellationRecords += 1;
    }
  );
  assert.equal(cancelled, "cancelled");
  assert.equal(cancellationRecords, 0, "cancelled input must not create registry metadata");

  let unavailableLaunches = 0;
  const unavailable = new WindowsHumanPlane(null, async () => {
    unavailableLaunches += 1;
    return 0;
  });
  const userRequest = {
    name: "HUMAN_PLANE_CANCELLED",
    scope: "user",
    projectId: null,
    projectDir: null
  };
  const userScript = buildWindowsSecretInputScript(userRequest);
  assert.match(userScript, /Registration destination: Current user \(shared across projects\)/);
  assert.match(userScript, /登録先：現在のユーザー共通/);
  assert.equal(await unavailable.askSecret(ref), "unavailable");
  assert.equal(unavailableLaunches, 0);
  assert.equal(await createHumanPlane("linux").askSecret(ref), "unavailable");
  const darwinPlane = createHumanPlane("darwin");
  if (process.platform === "darwin") {
    assert.equal(darwinPlane.capability(), "os-dialog");
  } else {
    assert.equal(darwinPlane.capability(), "handoff-only");
    assert.equal(await darwinPlane.askSecret(ref), "unavailable");
  }

  const cliSource = readFileSync(new URL("../packages/cli/index.ts", import.meta.url), "utf8");
  const humanSources = readSources([
    "../packages/core/human/types.ts",
    "../packages/core/human/macos.ts",
    "../packages/core/human/windows.ts",
    "../packages/core/human/index.ts"
  ])
    .map((file) => file.text)
    .join("\n");
  assert.match(cliSource, /if \(!ask && !process\.stdin\.isTTY\)/);
  assert.match(cliSource, /if \(ask\) \{[\s\S]*askAndRecordSecret/);
  assert.equal(humanSources.includes("promptSecretValue"), false);
  assert.equal(humanSources.includes("process.stdin"), false);
  assert.doesNotMatch(humanSources, /askSecret\([^)]*\):\s*Promise<string>/);
}

// Phase 6 macOS Human Plane. The injected launcher is a test seam for the
// helper process boundary: it returns only an exit status. No test path opens
// a real dialog, handles a Secret value, or adds a product-side GUI bypass.
async function testMacOSHumanPlaneBoundary(root) {
  mkdirSync(root, { recursive: true });
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  const projectId = deriveProjectId(projectDir);
  const ref = {
    name: "MACOS_HUMAN_PLANE_KEY",
    scope: "project",
    projectId,
    projectDir: projectDir.replace(/\\/g, "/")
  };
  const secretCanary = "macos-secret-must-stay-in-helper-0123456789";
  let helperRequest;
  const assertHelperRequest = (request) => {
    assert.equal(request.executable, MACOS_OSASCRIPT_PATH);
    assert.deepEqual(request.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
    assert.equal(request.args.length, 4);
    assert.equal(request.cwd, "/usr/bin");
    assert.deepEqual(request.env, {});
    assert.equal(request.detached, false);
    assert.equal(request.shell, false);
    assert.equal(request.stdio, "ignore");
  };
  const plane = new MacOSHumanPlane(MACOS_OSASCRIPT_PATH, async (request) => {
    helperRequest = request;
    // The synthetic helper returns only a status to its caller. It does not
    // model a parent-side Secret write or return a value through the seam.
    return 0;
  });

  let status;
  const fakeBin = join(root, "fake-bin");
  const fakeHome = join(root, "agent-home");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  write(fakeBin, "osascript", "agent-owned fake helper\n");
  await withEnv(
    {
      PATH: fakeBin,
      HOME: fakeHome,
      NODE_OPTIONS: "--require=agent-owned-injection.js",
      DYLD_INSERT_LIBRARIES: "agent-owned-injection.dylib",
      GH_TOKEN: "agent-owned-provider-auth",
      GITHUB_TOKEN: "agent-owned-provider-auth",
      CLOUDFLARE_API_TOKEN: secretCanary,
      VERCEL_TOKEN: "agent-owned-provider-auth"
    },
    async () => {
      status = await askAndRecordSecret(
        plane,
        ref,
        projectDir.replace(/\\/g, "/"),
        (entry) => upsertRegistryEntry(entry, root)
      );
    }
  );

  assert.equal(status, "saved");
  assert.ok(helperRequest);
  assertHelperRequest(helperRequest);
  assert.equal(helperRequest.args.join(" ").includes(secretCanary), false);
  assert.equal(JSON.stringify(helperRequest.env).includes(secretCanary), false);
  assert.equal(JSON.stringify(helperRequest).includes(secretCanary), false);

  const secretScript = helperRequest.args[3];
  assert.equal(secretScript, buildMacOSSecretInputScript(ref));
  assert.doesNotThrow(() => new Function(secretScript));
  assert.match(secretScript, /ObjC\.import\('Security'\)/);
  assert.match(secretScript, /kSecClassGenericPassword/);
  assert.match(secretScript, /kSecAttrService/);
  assert.match(secretScript, /kSecAttrAccount/);
  assert.match(secretScript, /kSecValueData/);
  assert.match(secretScript, /SecItemUpdate/);
  assert.match(secretScript, /SecItemAdd/);
  assert.match(secretScript, /field\.stringValue = ''/);
  assert.match(secretScript, /Registration destination: This project/);
  assert.ok(secretScript.includes(JSON.stringify(ref.projectDir).slice(1, -1)));
  assert.doesNotMatch(secretScript, /Project ID:|Provider:|Environment:/);
  assert.equal(secretScript.includes(JSON.stringify("api-key-case")), true);
  assert.equal(secretScript.includes(JSON.stringify(toAccount(ref))), true);
  for (const forbidden of [
    /do shell script/i,
    /System Events/i,
    /\/usr\/bin\/security/i,
    /\bsecurity\s+-[a-z]/i,
    /process\.stdin/,
    /console\./,
    /NSPasteboard/
  ]) {
    assert.doesNotMatch(secretScript, forbidden);
  }
  assert.equal(secretScript.includes(secretCanary), false);

  const humanSource = readFileSync(
    new URL("../packages/core/human/macos.ts", import.meta.url),
    "utf8"
  );
  assert.match(humanSource, /MACOS_OSASCRIPT_PATH = ["']\/usr\/bin\/osascript["']/);
  assert.match(humanSource, /spawn\(request\.executable, request\.args/);
  assert.doesNotMatch(humanSource, /do shell script/i);
  assert.doesNotMatch(humanSource, /System Events/i);
  assert.doesNotMatch(humanSource, /\/usr\/bin\/security/i);
  assert.doesNotMatch(humanSource, /process\.stdin/);
  assert.doesNotMatch(humanSource, /NODE_OPTIONS|DYLD_|GH_TOKEN|CLOUDFLARE_API_TOKEN|VERCEL_TOKEN/);

  const approvalPlan = {
    name: "MACOS_APPROVAL_KEY",
    scope: "project",
    projectId,
    target: "cloudflare",
    env: "production",
    force: false,
    projectDir: projectDir.replace(/\\/g, "/"),
    destination: "Cloudflare worker phase6-macos; account 0123456789abcdef0123456789abcdef",
    cliPath: "/opt/homebrew/bin/wrangler",
    command: "wrangler secret put MACOS_APPROVAL_KEY --env production",
    preCommands: ["wrangler deploy --dry-run"],
    trustState: "first-use"
  };
  let approvalRequest;
  const declinedPlane = new MacOSHumanPlane(MACOS_OSASCRIPT_PATH, async (request) => {
    approvalRequest = request;
    return 2;
  });
  assert.equal(await declinedPlane.askApproval(approvalPlan), "declined");
  assert.ok(approvalRequest);
  assertHelperRequest(approvalRequest);
  const approvalScript = approvalRequest.args[3];
  assert.equal(approvalScript, buildMacOSApprovalScript(approvalPlan));
  assert.doesNotThrow(() => new Function(approvalScript));
  assert.match(approvalScript, /addButtonWithTitle\('No'\)/);
  assert.match(approvalScript, /addButtonWithTitle\('Yes'\)/);
  assert.match(approvalScript, /noButton\.keyEquivalent = '\\r'/);
  assert.match(approvalScript, /initialFirstResponder = noButton/);
  assert.match(approvalScript, /NSAlertSecondButtonReturn/);
  assert.match(approvalScript, /\$\.exit\(/);
  assert.equal(approvalScript.includes(secretCanary), false);
  assert.equal(approvalScript.includes("approvalToken"), false);
  assert.equal("approvalToken" in approvalPlan, false);
  assert.deepEqual(Object.keys(approvalRequest.env), []);

  const removalPlans = [
    {
      kind: "secret",
      name: ref.name,
      scope: ref.scope,
      projectId,
      projectDir: projectDir.replace(/\\/g, "/")
    },
    {
      kind: "destination-trust",
      target: "github",
      env: "preview",
      projectDir: projectDir.replace(/\\/g, "/")
    }
  ];
  for (const removalPlan of removalPlans) {
    let removalRequest;
    const removalPlane = new MacOSHumanPlane(MACOS_OSASCRIPT_PATH, async (request) => {
      removalRequest = request;
      return 2;
    });
    assert.equal(await removalPlane.askRemoval(removalPlan), "declined");
    assertHelperRequest(removalRequest);
    const removalScript = removalRequest.args[3];
    assert.equal(removalScript, buildMacOSRemovalScript(removalPlan));
    assert.doesNotThrow(() => new Function(removalScript));
    assert.match(removalScript, /addButtonWithTitle\('No'\)/);
    assert.match(removalScript, /addButtonWithTitle\('Delete'\)/);
    assert.match(removalScript, /noButton\.keyEquivalent = '\\r'/);
    assert.match(removalScript, /initialFirstResponder = noButton/);
    assert.match(removalScript, /NSAlertSecondButtonReturn/);
    assert.equal(removalScript.includes(secretCanary), false);
  }

  let cancelLaunches = 0;
  const cancelled = new MacOSHumanPlane(MACOS_OSASCRIPT_PATH, async () => {
    cancelLaunches += 1;
    return 2;
  });
  const userRequest = { name: ref.name, scope: "user", projectId: null, projectDir: null };
  const userScript = buildMacOSSecretInputScript(userRequest);
  assert.match(userScript, /Registration destination: Current user \(shared across projects\)/);
  assert.equal(await cancelled.askSecret(ref), "cancelled");
  assert.equal(cancelLaunches, 1);
  assert.equal(await cancelled.askApproval(approvalPlan), "declined");
  assert.equal(await cancelled.askRemoval(removalPlans[0]), "declined");
  assert.equal(cancelLaunches, 3);

  const nullExit = new MacOSHumanPlane(MACOS_OSASCRIPT_PATH, async () => null);
  assert.equal(await nullExit.askSecret(ref), "unavailable");
  assert.equal(await nullExit.askApproval(approvalPlan), "unavailable");
  assert.equal(await nullExit.askRemoval(removalPlans[0]), "unavailable");
  const throwing = new MacOSHumanPlane(MACOS_OSASCRIPT_PATH, async () => {
    throw new Error("helper failure");
  });
  assert.equal(await throwing.askSecret(ref), "unavailable");
  assert.equal(await throwing.askApproval(approvalPlan), "unavailable");
  assert.equal(await throwing.askRemoval(removalPlans[0]), "unavailable");

  let invalidLaunches = 0;
  const invalidPlane = new MacOSHumanPlane(MACOS_OSASCRIPT_PATH, async () => {
    invalidLaunches += 1;
    return 0;
  });
  await assert.rejects(() => invalidPlane.askSecret({ ...ref, name: "invalid-name" }));
  await assert.rejects(() => invalidPlane.askApproval({ ...approvalPlan, target: "evil" }));
  await assert.rejects(() => invalidPlane.askRemoval({ ...removalPlans[0], name: "invalid-name" }));
  assert.equal(invalidLaunches, 0, "invalid plans must not reach osascript");

  const noHelper = new MacOSHumanPlane(null, async () => {
    throw new Error("unavailable helper must never launch");
  });
  assert.equal(noHelper.capability(), "handoff-only");
  assert.equal(await noHelper.askSecret(ref), "unavailable");
  assert.equal(await noHelper.askApproval(approvalPlan), "unavailable");
  assert.equal(await noHelper.askRemoval(removalPlans[0]), "unavailable");

  // Production resolution is fixed to the OS-owned path, independent of the
  // caller's PATH/HOME. Linux has no production trusted-helper path even if a
  // similarly named helper happens to be installed.
  const resolvedOsascript = resolveMacOSOsascript();
  if (process.platform === "darwin") {
    assert.equal(resolvedOsascript, MACOS_OSASCRIPT_PATH);
    assert.equal(createHumanPlane("darwin").capability(), "os-dialog");
    testMacOSOsascriptFrameworkSmoke();
  } else {
    assert.equal(resolvedOsascript, null);
    assert.equal(createHumanPlane("darwin").capability(), "handoff-only");
  }
  await withEnv({ PATH: fakeBin, HOME: fakeHome }, async () => {
    const pathIndependent = resolveMacOSOsascript();
    assert.equal(pathIndependent, process.platform === "darwin" ? MACOS_OSASCRIPT_PATH : null);
  });
}

// A non-interactive macOS-only smoke check for the built-in JXA host. It does
// not open a dialog, touch the Keychain, or inspect a Secret; it only proves
// that the fixed helper with a fresh empty environment can import the
// frameworks/constants the production script relies on.
function testMacOSOsascriptFrameworkSmoke() {
  const smokeScript = [
    "ObjC.import('AppKit');",
    "ObjC.import('Foundation');",
    "ObjC.import('Security');",
    "ObjC.import('stdlib');",
    "const required = [$.NSApplication, $.NSAlert, $.NSSecureTextField, $.kSecClassGenericPassword, $.kSecAttrService, $.kSecAttrAccount, $.kSecValueData, $.SecItemAdd, $.SecItemUpdate, $.errSecSuccess, $.errSecItemNotFound];",
    "$.exit(required.every((value) => value !== undefined && value !== null) ? 0 : 10);"
  ].join("\n");
  const result = spawnSync(
    MACOS_OSASCRIPT_PATH,
    ["-l", "JavaScript", "-e", smokeScript],
    {
      cwd: "/usr/bin",
      env: {},
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 0, `macOS JXA framework smoke failed: ${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

// A destination trust record is only creatable by the deploy engine, right
// after an Agent-independent Human Plane approval. Keeping the write surface
// mechanically confined is what makes "an Agent cannot register trust itself"
// a structural property rather than a code-review promise.
function testDestinationTrustWritesConfinedToEngine() {
  const storeWriters = new Set([
    "../packages/core/vault/types.ts",
    "../packages/core/vault/keyring.ts",
    "../packages/core/vault/memory.ts",
    "../packages/core/deploy/destination.ts"
  ]);
  const trustRecorders = new Set([
    "../packages/core/deploy/destination.ts",
    "../packages/core/deploy/engine.ts"
  ]);

  const sources = readSources([...VAULT_SOURCE_FILES, ...DEPLOY_SOURCE_FILES, ...MCP_SOURCE_FILES]);
  assert.deepEqual(
    sources.filter((file) => file.text.includes("saveDestinationTrust") && !storeWriters.has(file.path))
      .map((file) => file.path),
    [],
    "saveDestinationTrust must stay inside the vault backends and destination.ts"
  );
  assert.deepEqual(
    sources.filter((file) => file.text.includes("recordDestinationTrust") && !trustRecorders.has(file.path))
      .map((file) => file.path),
    [],
    "recordDestinationTrust must only be called by the deploy engine"
  );

  const engine = sources.find((file) => file.path === "../packages/core/deploy/engine.ts");
  assert.ok(engine);
  assert.match(
    engine.text,
    /if \(requiresHuman && automaticClass\) \{\s*try \{\s*await recordDestinationTrust/,
    "trust is recorded only after a Human Plane approval for an automatic-safe class"
  );
  // The catch here is the only place this warning is printed. Its wording
  // promises that a failed save leaves the destination unconfirmed, which is
  // exactly what the slot-before-exact write order in destination.ts's
  // recordDestinationTrust guarantees (see the destination-trust save/forget
  // ordering regression tests): a failure can only ever leave the slot
  // record behind, never the exact one, so readDestinationTrust can never
  // report "trusted" after this warning fires.
  assert.match(
    engine.text,
    /catch \{\s*deps\.print\("Warning: this destination could not be remembered; the next deploy will ask again\.".*\);\s*\}/,
    "the recordDestinationTrust failure warning text must stay in sync with this test's regression coverage"
  );

  // The CLI and MCP surfaces must not grow a trust flag, parameter, or token.
  for (const file of readSources(["../packages/cli/index.ts", ...MCP_SOURCE_FILES])) {
    for (const pattern of [/--trust/, /approvalToken/, /trustDestination/]) {
      assert.equal(pattern.test(file.text), false, `${file.path} must not expose ${pattern}`);
    }
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

  // Destination trust records share the store but not the namespace, and a
  // Secret account can never be read as one (or the other way round).
  const fingerprint = "a".repeat(64);
  assert.equal(toDestinationAccount({ kind: "destination", fingerprint }), `v1|destination|${fingerprint}`);
  assert.throws(
    () => toDestinationAccount({ kind: "destination", fingerprint: "not-a-fingerprint" }),
    /Invalid destination fingerprint/
  );
  assert.throws(
    () => toDestinationAccount({ kind: "secret", fingerprint }),
    /Unsupported destination trust record/
  );
  assert.equal(await vault.hasDestinationTrust({ kind: "destination", fingerprint }), false);
  await vault.saveDestinationTrust({ kind: "destination", fingerprint });
  assert.equal(await vault.hasDestinationTrust({ kind: "destination", fingerprint }), true);
  assert.equal(
    await vault.hasDestinationTrust({ kind: "destination-slot", fingerprint }),
    false,
    "an identity record must not satisfy a slot lookup"
  );
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

  const badRemoveName = spawnSync(process.execPath, [cliPath, "remove", "not-a-valid-name"], {
    encoding: "utf8",
    cwd: root
  });
  assert.equal(badRemoveName.status, 1);

  // Phase 6E removed the unattended confirmation path entirely. An Agent that
  // finds `--yes` in an old README cannot use it to complete a deletion.
  const yesFlagRemove = spawnSync(
    process.execPath,
    [cliPath, "remove", "AKC_TEST_UNKNOWN_KEY", "--yes"],
    { encoding: "utf8", cwd: root }
  );
  assert.equal(yesFlagRemove.status, 1);
  assert.match(yesFlagRemove.stderr, /Unknown option/);

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
    'import { join } from "node:path";',
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { input += chunk; });',
    'process.stdin.on("end", () => {',
    "  const argv = process.argv.slice(2);",
    "  const recordPath = process.env.AKC_FAKE_RECORD || join(process.cwd(), '.akc-fake-record.json');",
    "  if (recordPath) {",
    '    writeFileSync(recordPath, JSON.stringify({ argv, stdin: input }), "utf8");',
    "  }",
    // Trusted execution hands the child a sanitized environment, so a test
    // that runs through it steers this fixture with argv tokens instead.
    '  if ((process.env.AKC_FAKE_ECHO === "1" || argv.includes("--akc-echo")) && input) {',
    "    process.stdout.write(input);",
    "  }",
    "  if (process.env.AKC_FAKE_STDERR) {",
    "    process.stderr.write(process.env.AKC_FAKE_STDERR);",
    "  }",
    '  process.exitCode = argv.includes("--akc-fail") ? 23 : Number(process.env.AKC_FAKE_EXIT || "0");',
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
  const identity = overrides.identity ?? "user:phase-c-test";
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
        identity: loggedIn
          ? (typeof identity === "function" ? identity() : identity)
          : undefined,
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

// Test-only Human Plane double. Production entry points always construct the
// fixed-path OS Human Plane; this double lets the in-process tests exercise
// the engine's status handling without opening a real desktop dialog.
function createTestHumanPlane(status, onApproval = () => {}) {
  return {
    capability: () => "os-dialog",
    askSecret: async () => "unavailable",
    askApproval: async (plan) => {
      await onApproval(plan);
      return status;
    },
    askRemoval: async () => "unavailable"
  };
}

// Test-only Human Plane double for the Phase E lifecycle dialogs.
function createTestRemovalPlane(status, onRemoval = () => {}) {
  return {
    capability: () => (status === "no-dialog" ? "handoff-only" : "os-dialog"),
    askSecret: async () => "unavailable",
    askApproval: async () => "unavailable",
    askRemoval: async (plan) => {
      await onRemoval(plan);
      return status === "no-dialog" ? "unavailable" : status;
    }
  };
}

// Wraps a real Vault so a test can control destination trust without writing
// Phase D records into the machine's real OS secret store.
function withDestinationTrust(vault, options = {}) {
  const records = new Set();
  return {
    records,
    backendName: vault.backendName,
    isAvailable: () => vault.isAvailable(),
    setSecret: (ref, value) => vault.setSecret(ref, value),
    hasSecret: (ref) => vault.hasSecret(ref),
    deleteSecret: (ref) => vault.deleteSecret(ref),
    async hasDestinationTrust(ref) {
      if (options.onRead) await options.onRead(ref);
      return options.trusted === true || records.has(toDestinationAccount(ref));
    },
    async saveDestinationTrust(ref) {
      if (options.onSave) await options.onSave(ref);
      records.add(toDestinationAccount(ref));
    },
    async deleteDestinationTrust(ref) {
      if (options.onDelete) await options.onDelete(ref);
      if (options.trusted === true) throw new Error("must not delete a forced-trust record");
      if (options.deleteResult !== undefined) return options.deleteResult;
      return records.delete(toDestinationAccount(ref));
    }
  };
}

function withoutEnv(names, fn) {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
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

// On Vercel, sensitivity is a per-variable setting rather than something the
// environment implies (`--no-sensitive` exists, and the CLI default has
// changed over time). Every value this tool places is a Secret, so the plan
// must demand write-only storage itself instead of inheriting a provider or
// team default — and must never send the flag to `development`, where Vercel's
// API rejects it.
function testVercelPlansRequireSensitiveStorage() {
  const vercel = ADAPTERS.get("vercel");
  assert.ok(vercel);

  for (const force of [true, false]) {
    for (const env of ["production", "preview"]) {
      const plan = vercel.planDeploy("AKC_TEST_KEY", env, { force });
      // `preview` also prompts for a Git branch. This tool's child is always
      // non-interactive, so the prompt cannot be answered and the CLI exits 0
      // having created nothing — a silent success. The plan must decline the
      // prompt explicitly rather than rely on the CLI's agent auto-detection,
      // which a sanitized environment removes. Measured on vercel 59.11.7.
      const expected = ["vercel", "env", "add", "AKC_TEST_KEY", env, "--sensitive"];
      if (env === "preview") expected.push("--yes");
      assert.deepEqual(
        plan.argv,
        expected,
        `vercel/${env}/force=${force} must ask for sensitive storage explicitly`
      );
      assert.match(plan.displayCommand, env === "preview" ? /--sensitive --yes$/ : /--sensitive$/);
      assert.ok(
        vercel.manualSteps("AKC_TEST_KEY", env).some((step) => step.includes("--sensitive")),
        `vercel/${env} manual steps must mirror planDeploy`
      );
    }

    const development = vercel.planDeploy("AKC_TEST_KEY", "development", { force });
    assert.deepEqual(
      development.argv,
      ["vercel", "env", "add", "AKC_TEST_KEY", "development"],
      "development keeps its readable-back Config storage; changing that is an allowlist review, not a flag edit"
    );
    assert.equal(development.displayCommand.includes("--sensitive"), false);
    assert.equal(
      vercel.manualSteps("AKC_TEST_KEY", "development").some((step) => step.includes("--sensitive")),
      false
    );

    // The `--force` pre-step removes the old value; it takes no --sensitive.
    for (const step of [
      ...(vercel.planDeploy("AKC_TEST_KEY", "preview", { force }).preSteps ?? []),
      ...(development.preSteps ?? [])
    ]) {
      assert.deepEqual(step.argv.slice(0, 3), ["vercel", "env", "rm"]);
      assert.equal(step.argv.includes("--sensitive"), false);
    }
  }

  // The automatic-safe allowlist is justified by the value being unreadable
  // afterwards. Whatever is on it must actually plan write-only storage, so
  // dropping the flag can never silently widen automatic execution.
  for (const [target, envs] of Object.entries(AUTOMATIC_SAFE_ENVS)) {
    const adapter = ADAPTERS.get(target);
    for (const env of envs) {
      assert.equal(target, "vercel", `unexpected automatic-safe target: ${target}`);
      assert.ok(
        adapter.planDeploy("AKC_TEST_KEY", env, { force: false }).argv.includes("--sensitive"),
        `${target}/${env} is automatic-safe, so its plan must require sensitive storage`
      );
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

async function testMacOSPinnedInterpreter(root) {
  const projectDir = join(root, "project");
  const trustedBin = join(root, "trusted-bin");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(trustedBin, { recursive: true });
  const cliPath = join(trustedBin, "phase6-node-cli");
  const interpreterPath = join(trustedBin, "node");
  const markerPath = join(root, "interpreter-argv.txt");
  const interpreterSource = process.platform === "win32"
    ? "synthetic interpreter identity\n"
    : "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$AKC_INTERPRETER_MARKER\"\n";
  writeFileSync(cliPath, "#!/usr/bin/env node\n", "utf8");
  writeFileSync(interpreterPath, interpreterSource, "utf8");
  chmodSync(cliPath, 0o755);
  chmodSync(interpreterPath, 0o755);

  const resolved = resolveTrustedCli("phase6-node-cli", {
    pathOverride: trustedBin,
    platformOverride: "darwin",
    interpreterOverride: interpreterPath,
    projectDir
  });
  assert.ok(resolved, "trusted macOS Node CLI fixture must resolve");
  assert.ok(resolved.interpreter, "Node shebang must pin an exact interpreter");
  assert.equal(resolved.realPath, realpathSync.native(cliPath));
  assert.equal(resolved.interpreter.realPath, realpathSync.native(interpreterPath));
  const unchanged = currentResolvedCli(resolved);
  assert.ok(unchanged);
  assert.equal(isSameResolvedCli(resolved, unchanged), true);

  if (process.platform !== "win32") {
    const child = spawnResolvedCli(resolved, ["--identity-probe"], {
      cwd: projectDir,
      env: { AKC_INTERPRETER_MARKER: markerPath }
    });
    const code = await new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", resolvePromise);
    });
    assert.equal(code, 0);
    assert.deepEqual(readFileSync(markerPath, "utf8").trim().split(/\r?\n/), [
      resolved.realPath,
      "--identity-probe"
    ]);
  }

  writeFileSync(interpreterPath, `${interpreterSource}# replaced after approval\n`, "utf8");
  chmodSync(interpreterPath, 0o755);
  const replaced = currentResolvedCli(resolved);
  assert.ok(replaced);
  assert.equal(
    isSameResolvedCli(resolved, replaced),
    false,
    "interpreter replacement must invalidate the execution snapshot"
  );

  writeFileSync(join(trustedBin, "unsupported-shebang"), "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(join(trustedBin, "unsupported-shebang"), 0o755);
  assert.equal(
    resolveTrustedCli("unsupported-shebang", {
      pathOverride: trustedBin,
      platformOverride: "darwin",
      interpreterOverride: interpreterPath,
      projectDir
    }),
    null,
    "trusted macOS resolution must reject unpinned script interpreters"
  );
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
      pathOverride: fixture.pathOverride
    },
    {
      name: "AKC_TEST_MISSING",
      scope: "project",
      projectId: deriveProjectId(root),
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
  // Phase D binds a destination before probing the CLI, so this fixture needs
  // one concrete Wrangler config to reach the CLI readiness branch at all.
  write(root, "wrangler.toml", "name = 'cli-down-worker'\naccount_id = '0123456789abcdef0123456789abcdef'\n");
  const adapter = createFakeAdapter(fixture, { installed: false, loggedIn: false });
  const vault = new MemoryVault();
  const ref = { name: "AKC_TEST_CLI_DOWN", scope: "project", projectId: deriveProjectId(root) };
  await vault.setSecret(ref, canaryOpenAi);

  const printed = [];
  const result = await withoutEnv(
    ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CLOUDFLARE_ACCOUNT_ID"],
    () =>
      runDeploy(
        {
          vault,
          adapter,
          print: (line) => printed.push(line),
          pathOverride: fixture.pathOverride
        },
        { name: ref.name, scope: ref.scope, projectId: ref.projectId, projectDir: root, env: "development", dryRun: false, force: false }
      )
  );

  assert.equal(result.kind, "cli-unavailable");
  assert.ok(printed.some((line) => line.includes("install")));
}

async function testEngineDeclinedConfirmation(root) {
  write(root, "wrangler.toml", "name = 'decline-worker'\naccount_id = '0123456789abcdef0123456789abcdef'\n");
  const fixture = createFakeCli(root);
  const adapter = createFakeAdapter(fixture);
  const vault = new MemoryVault();
  const ref = { name: "AKC_TEST_DECLINE", scope: "project", projectId: deriveProjectId(root) };
  await vault.setSecret(ref, canaryOpenAi);

  const recordPath = join(root, "record.json");
  await withEnv({ AKC_FAKE_RECORD: recordPath }, async () => {
    let confirmCalls = 0;
    const result = await runDeploy(
      {
        vault,
        adapter,
        print: () => {},
        humanPlane: createTestHumanPlane("declined", () => {
          confirmCalls++;
        }),
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
  write(
    root,
    ".git/config",
    "[remote \"origin\"]\n\turl = https://github.com/example/phase-c-test.git\n"
  );
  const fixture = createFakeCli(root);
  const adapter = createFakeAdapter(fixture, { id: "github" });
  const vault = new MemoryVault();
  const ref = { name: "AKC_TEST_GH_CONFIRM", scope: "project", projectId: deriveProjectId(root) };
  await vault.setSecret(ref, canaryOpenAi);

  await withoutEnv(
    [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "GH_HOST",
      "GH_REPO",
      "GH_CONFIG_DIR",
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_KEY_1",
      "GIT_CONFIG_VALUE_0",
      "GIT_CONFIG_VALUE_1"
    ],
    async () => {
      let confirmCalls = 0;
      const result = await runDeploy(
        {
          vault,
          adapter,
          print: () => {},
          humanPlane: createTestHumanPlane("declined", () => {
            confirmCalls++;
          }),
          pathOverride: fixture.pathOverride
        },
        { name: ref.name, scope: ref.scope, projectId: ref.projectId, projectDir: root, env: "development", dryRun: false, force: false }
      );

      assert.equal(result.kind, "declined");
      assert.equal(confirmCalls, 1, "github target must require confirmation even for a non-production env");
    }
  );
}

async function testPhaseCApprovalBoundary(root) {
  const projectDir = join(root, "project");
  const cliDir = join(root, "cli");
  mkdirSync(projectDir, { recursive: true });
  write(projectDir, ".gitignore", ".env\n.env.*\n!.env.example\n");
  const baselineWranglerConfig =
    "name = 'phase-c-worker'\naccount_id = '0123456789abcdef0123456789abcdef'\n";
  write(projectDir, "wrangler.toml", baselineWranglerConfig);
  const fixture = createFakeCli(cliDir);
  const adapter = createFakeAdapter(fixture);
  const name = "AKC_PHASE_C_KEY";
  const projectId = deriveProjectId(projectDir);
  const snapshotRequest = {
    name,
    scope: "project",
    projectId,
    env: "production",
    force: false,
    adapterId: "cloudflare",
    cliCommand: fixture.cliCommand,
    providerIdentity: "accounts:0123456789abcdef0123456789abcdef"
  };
  const plan = adapter.planDeploy(name, "production", { force: false });
  const providerEnvNames = [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "CLOUDFLARE_ACCOUNT_ID"
  ];

  await withoutEnv(providerEnvNames, async () => {
    const trusted = buildTrustedExecution(snapshotRequest, plan, {
      pathOverride: fixture.pathOverride,
      projectDir
    });
    assert.equal(trusted.ok, true);
    if (!trusted.ok) return;

    const approvalPlan = makeApprovalPlan(
      snapshotRequest,
      plan,
      trusted.execution,
      "always-approve"
    );
    assert.deepEqual(Object.keys(approvalPlan).sort(), [
      "cliPath",
      "command",
      "destination",
      "env",
      "force",
      "name",
      "preCommands",
      "projectDir",
      "projectId",
      "scope",
      "target",
      "trustState"
    ]);
    assert.equal("approvalToken" in approvalPlan, false);
    const approvalScript = buildWindowsApprovalScript(approvalPlan);
    assert.match(approvalScript, /Approve Operation/);
    assert.match(approvalScript, /Destination:/);
    assert.match(approvalScript, /Destination status: /);
    assert.throws(
      () => buildWindowsApprovalScript({ ...approvalPlan, trustState: "trust-me" }),
      /Invalid approval trust state/
    );
    assert.match(approvalScript, /CLI:/);
    assert.match(approvalScript, /AcceptButton = \$noButton/);
    assert.match(approvalScript, /Add_Shown\(\{ \$noButton\.Focus\(\) \}\)/);
    assert.match(approvalScript, /Add_FormClosing/);
    assert.match(approvalScript, /resultCode = 2/);
    assertWindowsUserVerificationGate(approvalScript, "Windows approval");
    assertLocalizedWindowsDialog(
      approvalScript,
      "Windows approval",
      WINDOWS_DIALOG_TEXT.approvalCaption,
      WINDOWS_DIALOG_TEXT.approveButton,
      WINDOWS_DIALOG_TEXT.declineButton
    );
    assert.equal(approvalScript.includes(canaryOpenAi), false);
    assert.equal(JSON.stringify(approvalPlan).includes(canaryOpenAi), false);

    let helperRequest;
    const noPlane = new WindowsHumanPlane(WINDOWS_POWERSHELL_PATH, async (request) => {
      helperRequest = request;
      return 2;
    });
    assert.equal(await noPlane.askApproval(approvalPlan), "declined");
    assert.ok(helperRequest);
    assertWindowsHelperEnv(helperRequest.env);
    assert.equal(helperRequest.cwd, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0");
    assert.equal(helperRequest.stdio, "ignore");
    assert.equal(helperRequest.shell, false);
    assert.equal(helperRequest.detached, false);
    assert.equal(helperRequest.args.includes("-EncodedCommand"), true);
    assert.equal(helperRequest.args.join(" ").includes(canaryOpenAi), false);
    assert.equal(JSON.stringify(helperRequest.env).includes(canaryOpenAi), false);

    assert.equal(trusted.execution.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(
      trusted.execution.env.GIT_CONFIG_GLOBAL,
      process.platform === "win32" ? "NUL" : "/dev/null"
    );
    for (const forbiddenEnv of [
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CLOUDFLARE_EMAIL",
      "CLOUDFLARE_ACCOUNT_ID"
    ]) {
      assert.equal(forbiddenEnv in trusted.execution.env, false, `${forbiddenEnv} reached the provider CLI`);
    }

    if (process.platform === "darwin") {
      const agentHome = join(root, "agent-owned-exec-home");
      const agentPath = join(root, "agent-owned-exec-path");
      mkdirSync(agentHome, { recursive: true });
      mkdirSync(agentPath, { recursive: true });
      await withEnv(
        {
          HOME: agentHome,
          USERPROFILE: agentHome,
          PATH: agentPath,
          NODE_OPTIONS: "--require=agent-owned-injection.js",
          DYLD_INSERT_LIBRARIES: "agent-owned-injection.dylib"
        },
        async () => {
          const sanitized = buildTrustedExecution(snapshotRequest, plan, {
            pathOverride: fixture.pathOverride,
            projectDir
          });
          assert.equal(sanitized.ok, true);
          if (!sanitized.ok) return;
          assert.deepEqual(Object.keys(sanitized.execution.env).sort(), [
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_NOSYSTEM",
            "GIT_TERMINAL_PROMPT",
            "HOME",
            "PATH",
            "TMPDIR"
          ]);
          assert.equal(
            sanitized.execution.env.HOME,
            resolveTrustedHomeDirectory(),
            "macOS execution HOME must ignore Agent-controlled HOME"
          );
          assert.notEqual(sanitized.execution.env.HOME, agentHome);
          assert.equal(sanitized.execution.env.PATH.includes(agentPath), false);
          for (const forbiddenEnv of [
            "NODE_OPTIONS",
            "DYLD_INSERT_LIBRARIES",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "CLOUDFLARE_API_TOKEN",
            "VERCEL_TOKEN",
            "GIT_DIR",
            "GIT_WORK_TREE"
          ]) {
            assert.equal(forbiddenEnv in sanitized.execution.env, false);
          }
        }
      );
    }

    if (process.platform === "win32") {
      const parsedApproval = parseWindowsHelperScript(approvalScript);
      assert.equal(parsedApproval.status, 0, "Windows approval helper script must parse");

      // Compile the generated C# ABI bridge and resolve the closed WinRT
      // IAsyncOperation IID without opening an interactive verifier prompt.
      const displayDataMarker = approvalScript.indexOf("$secretName = ");
      assert.ok(displayDataMarker > 0);
      const verificationProbe = [
        approvalScript.slice(0, displayDataMarker),
        "$resultType = [Type]::GetType('Windows.Security.Credentials.UI.UserConsentVerificationResult, Windows.Security.Credentials.UI, ContentType=WindowsRuntime', $true)",
        "$asyncType = [Type]::GetType('Windows.Foundation.IAsyncOperation`1, Windows.Foundation, ContentType=WindowsRuntime', $true).MakeGenericType([Type[]]@($resultType))",
        "if ($asyncType.GUID -eq [Guid]::Empty) { [Environment]::Exit(20) }",
        "if (-not [ApiKeyCaseHumanPlane.UserConsentVerifierNative]::IsSupportedBuild(0)) { [Environment]::Exit(21) }",
        "[Environment]::Exit(0)"
      ].join("\n");
      const compiledVerification = spawnSync(
        WINDOWS_POWERSHELL_PATH,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-STA",
          "-EncodedCommand",
          Buffer.from(verificationProbe, "utf16le").toString("base64")
        ],
        {
          encoding: "utf8",
          env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" }
        }
      );
      assert.equal(
        compiledVerification.status,
        0,
        `Windows user-verification ABI bridge must compile: ${compiledVerification.stderr}`
      );
    }

    assert.equal(await new WindowsHumanPlane(WINDOWS_POWERSHELL_PATH, async () => null).askApproval(approvalPlan), "unavailable");
    assert.equal(await new WindowsHumanPlane(WINDOWS_POWERSHELL_PATH, async () => 10).askApproval(approvalPlan), "unavailable");
    let unavailableLaunches = 0;
    assert.equal(
      await new WindowsHumanPlane(null, async () => {
        unavailableLaunches++;
        return 0;
      }).askApproval(approvalPlan),
      "unavailable"
    );
    assert.equal(unavailableLaunches, 0);

    // Destination config fingerprints must never become Secret-value hashes.
    // Two different same-shape values under a Secret-bearing config section
    // produce the same safe projection hash, while the values themselves are
    // absent from the snapshot.
    write(projectDir, "wrangler.toml", `${baselineWranglerConfig}[vars]\nTOKEN = "${canaryOpenAi}"\n`);
    const firstProjected = buildTrustedExecution(snapshotRequest, plan, {
      pathOverride: fixture.pathOverride,
      projectDir
    });
    assert.equal(firstProjected.ok, true);
    const alternateSecret = "x".repeat(canaryOpenAi.length);
    write(projectDir, "wrangler.toml", `${baselineWranglerConfig}[vars]\nTOKEN = "${alternateSecret}"\n`);
    const secondProjected = buildTrustedExecution(snapshotRequest, plan, {
      pathOverride: fixture.pathOverride,
      projectDir
    });
    assert.equal(secondProjected.ok, true);
    if (firstProjected.ok && secondProjected.ok) {
      const firstHash = firstProjected.execution.snapshot.destinationConfig.find(
        (file) => file.path.endsWith("wrangler.toml")
      )?.contentHash;
      const secondHash = secondProjected.execution.snapshot.destinationConfig.find(
        (file) => file.path.endsWith("wrangler.toml")
      )?.contentHash;
      assert.ok(firstHash);
      assert.equal(firstHash, secondHash, "Secret-bearing config values must not influence a fingerprint hash");
      assert.equal(
        firstProjected.execution.snapshot.destinationConfig.some((file) => "size" in file),
        false,
        "config/auth fingerprints must not retain a Secret-correlated file size"
      );
      assert.equal(JSON.stringify(firstProjected.execution).includes(canaryOpenAi), false);
      assert.equal(JSON.stringify(secondProjected.execution).includes(alternateSecret), false);
    }
    write(projectDir, "wrangler.toml", baselineWranglerConfig);

    // Multiple Wrangler config filenames make precedence version-dependent,
    // so the Human Plane must not present either one as a concrete target.
    write(
      projectDir,
      "wrangler.json",
      JSON.stringify({ name: "other-worker", account_id: "fedcba9876543210fedcba9876543210" })
    );
    const ambiguousConfig = buildTrustedExecution(snapshotRequest, plan, {
      pathOverride: fixture.pathOverride,
      projectDir
    });
    assert.equal(ambiguousConfig.ok, false);
    if (!ambiguousConfig.ok) assert.equal(ambiguousConfig.reason, "unsafe-environment");
    rmSync(join(projectDir, "wrangler.json"), { force: true });

    // A config that satisfies wrangler itself can still be missing what this
    // tool binds to: wrangler infers the account from a single login, this
    // tool refuses to let a login decide where a Secret lands. Denying without
    // naming the missing field leaves the user with no next step.
    write(projectDir, "wrangler.toml", "name = 'phase-c-worker'\n");
    const incompleteVault = new MemoryVault();
    await incompleteVault.setSecret({ name, scope: "project", projectId }, canaryOpenAi);
    const incompleteLines = [];
    const incompleteDestination = await runDeploy(
      {
        vault: incompleteVault,
        adapter,
        print: (line) => incompleteLines.push(line),
        humanPlane: createTestHumanPlane("approved"),
        pathOverride: fixture.pathOverride
      },
      {
        name,
        scope: "project",
        projectId,
        projectDir,
        env: "production",
        dryRun: false,
        force: false
      }
    );
    assert.equal(incompleteDestination.kind, "unavailable");
    const incompleteOutput = incompleteLines.join("\n");
    assert.match(incompleteOutput, /could not be bound to one trusted destination/);
    assert.match(
      incompleteOutput,
      /account_id/,
      "the denial must name what binding this target actually requires"
    );
    assert.equal(incompleteOutput.includes(canaryOpenAi), false);
    write(projectDir, "wrangler.toml", baselineWranglerConfig);

    // A synthetic Yes from agent-owned stdin/PTY has no Human Plane object,
    // so the engine must fail closed before the target CLI is spawned.
    const vault = new MemoryVault();
    await vault.setSecret({ name, scope: "project", projectId }, canaryOpenAi);
    const recordPath = join(root, "record.json");
    await withEnv({ AKC_FAKE_RECORD: recordPath }, async () => {
      const noHuman = await runDeploy(
        { vault, adapter, print: () => {}, pathOverride: fixture.pathOverride },
        {
          name,
          scope: "project",
          projectId,
          projectDir,
          env: "production",
          dryRun: false,
          force: false
        }
      );
      assert.equal(noHuman.kind, "unavailable");
      assert.equal(existsSync(recordPath), false);

      // No/Cancel/close all map to a decline and never reach the keyring or
      // target CLI. The synthetic Secret is present only to prove that the
      // approval path itself does not expose or consume its value.
      const declined = await runDeploy(
        {
          vault,
          adapter,
          print: () => {},
          humanPlane: createTestHumanPlane("declined"),
          pathOverride: fixture.pathOverride
        },
        {
          name,
          scope: "project",
          projectId,
          projectDir,
          env: "production",
          dryRun: false,
          force: false
        }
      );
      assert.equal(declined.kind, "declined");
      assert.equal(existsSync(recordPath), false);

      const unavailable = await runDeploy(
        {
          vault,
          adapter,
          print: () => {},
          humanPlane: createTestHumanPlane("unavailable"),
          pathOverride: fixture.pathOverride
        },
        {
          name,
          scope: "project",
          projectId,
          projectDir,
          env: "production",
          dryRun: false,
          force: false
        }
      );
      assert.equal(unavailable.kind, "unavailable");
      assert.equal(existsSync(recordPath), false);

      // Destructive --force is independently high-risk and cannot run when
      // the Human Plane is absent, even for a non-production environment.
      const forceResult = await runDeploy(
        { vault, adapter, print: () => {}, pathOverride: fixture.pathOverride },
        {
          name,
          scope: "project",
          projectId,
          projectDir,
          env: "development",
          dryRun: false,
          force: true
        }
      );
      assert.equal(forceResult.kind, "unavailable");
      assert.equal(existsSync(recordPath), false);

      // Approval state is scoped to one runDeploy call. A second operation
      // must request the Human Plane again; no status/token from the first
      // request is accepted as reusable authority.
      let approvalRequests = 0;
      const oneShotHumanPlane = createTestHumanPlane("approved", () => {
        approvalRequests += 1;
        if (approvalRequests === 1) {
          write(projectDir, "wrangler.toml", "name = 'changed-after-one-shot-approval'\n");
        }
      });
      const firstOneShot = await runDeploy(
        { vault, adapter, print: () => {}, humanPlane: oneShotHumanPlane, pathOverride: fixture.pathOverride },
        {
          name,
          scope: "project",
          projectId,
          projectDir,
          env: "production",
          dryRun: false,
          force: false
        }
      );
      assert.equal(firstOneShot.kind, "changed");
      write(projectDir, "wrangler.toml", baselineWranglerConfig);

      const secondOneShot = await runDeploy(
        {
          vault,
          adapter,
          print: () => {},
          humanPlane: {
            ...oneShotHumanPlane,
            askApproval: async () => {
              approvalRequests += 1;
              return "unavailable";
            }
          },
          pathOverride: fixture.pathOverride
        },
        {
          name,
          scope: "project",
          projectId,
          projectDir,
          env: "production",
          dryRun: false,
          force: false
        }
      );
      assert.equal(secondOneShot.kind, "unavailable");
      assert.equal(approvalRequests, 2);
      assert.equal(existsSync(recordPath), false);
    });

    // The approval is bound to destination config and is invalidated if the
    // approved operation changes before execution.
    const destinationChanged = await runDeploy(
      {
        vault,
        adapter,
        print: () => {},
        humanPlane: createTestHumanPlane("approved", () => {
          write(projectDir, "wrangler.toml", "name = 'changed-after-approval'\n");
        }),
        pathOverride: fixture.pathOverride
      },
      {
        name,
        scope: "project",
        projectId,
        projectDir,
        env: "production",
        dryRun: false,
        force: false
      }
    );
    assert.equal(destinationChanged.kind, "changed");
    write(projectDir, "wrangler.toml", baselineWranglerConfig);

    // Provider auth identity is re-queried through the same fixed CLI/env
    // after approval. A different logged-in account is not equivalent to the
    // account the human approved.
    let activeProviderIdentity = "accounts:0123456789abcdef0123456789abcdef";
    const authChanged = await runDeploy(
      {
        vault,
        adapter: createFakeAdapter(fixture, {
          identity: () => activeProviderIdentity
        }),
        print: () => {},
        humanPlane: createTestHumanPlane("approved", () => {
          activeProviderIdentity = "accounts:fedcba9876543210fedcba9876543210";
        }),
        pathOverride: fixture.pathOverride
      },
      {
        name,
        scope: "project",
        projectId,
        projectDir,
        env: "production",
        dryRun: false,
        force: false
      }
    );
    assert.equal(authChanged.kind, "changed");

    // The snapshot compares CLI identity (path, realpath, size, mtime, and
    // inode/file id), so replacement at the same path cannot be approved.
    const cliChanged = buildTrustedExecution(snapshotRequest, plan, {
      pathOverride: fixture.pathOverride,
      projectDir
    });
    assert.equal(cliChanged.ok, true);
    if (cliChanged.ok) {
      const replacementPath = join(cliDir, process.platform === "win32" ? "akc-fake-cli.cmd" : "akc-fake-cli");
      writeFileSync(
        replacementPath,
        process.platform === "win32" ? "@echo off\r\nexit /b 9\r\n" : "#!/bin/sh\nexit 9\n",
        "utf8"
      );
      if (process.platform !== "win32") chmodSync(replacementPath, 0o755);
      assert.equal(matchesTrustedExecution(snapshotRequest, plan, cliChanged.execution), false);
    }

    // A provider auth environment value is never hashed or copied; merely
    // appearing after approval invalidates the operation.
    const envChanged = buildTrustedExecution(snapshotRequest, plan, {
      pathOverride: fixture.pathOverride,
      projectDir
    });
    assert.equal(envChanged.ok, true);
    if (envChanged.ok) {
      await withEnv({ CLOUDFLARE_API_TOKEN: canaryOpenAi }, async () => {
        assert.equal(matchesTrustedExecution(snapshotRequest, plan, envChanged.execution), false);
        assert.equal(JSON.stringify(envChanged.execution).includes(canaryOpenAi), false);
      });
    }

    // Wrangler project .env variants are not read; their presence is unsafe.
    const envFileChanged = buildTrustedExecution(snapshotRequest, plan, {
      pathOverride: fixture.pathOverride,
      projectDir
    });
    assert.equal(envFileChanged.ok, true);
    if (envFileChanged.ok) {
      write(projectDir, ".env.production", `CLOUDFLARE_API_TOKEN=${canaryOpenAi}\n`);
      assert.equal(matchesTrustedExecution(snapshotRequest, plan, envFileChanged.execution), false);
      assert.equal(JSON.stringify(envFileChanged.execution).includes(canaryOpenAi), false);
      rmSync(join(projectDir, ".env.production"), { force: true });
    }

    // Direct snapshot matching catches cwd changes independently of the
    // destination and CLI checks.
    const cwdChanged = buildTrustedExecution(snapshotRequest, plan, {
      pathOverride: fixture.pathOverride,
      projectDir
    });
    assert.equal(cwdChanged.ok, true);
    if (cwdChanged.ok) {
      const originalCwd = process.cwd();
      const alternateCwd = join(root, "alternate-cwd");
      mkdirSync(alternateCwd, { recursive: true });
      try {
        process.chdir(alternateCwd);
        assert.equal(matchesTrustedExecution(snapshotRequest, plan, cwdChanged.execution), false);
      } finally {
        process.chdir(originalCwd);
      }
    }
  });

  // Agent-owned process PATH cannot replace a high-risk provider CLI. The
  // production resolver ignores it and consults only independently derived
  // OS-owned locations (the Windows profile/registry or the macOS closed
  // candidate set).
  if (process.platform === "win32") {
    const agentBin = join(projectDir, "agent-owned-path");
    mkdirSync(agentBin, { recursive: true });
    write(agentBin, "gh.cmd", "@echo off\r\nexit /b 0\r\n");
    await withEnv({ PATH: agentBin }, async () => {
      const resolved = resolveTrustedCli("gh", { projectDir });
      assert.equal(
        resolved?.absolutePath.toLowerCase().startsWith(agentBin.toLowerCase()) ?? false,
        false,
        "trusted CLI resolution must ignore Agent-owned process PATH"
      );
    });
  }
  if (process.platform === "darwin") {
    const trustedHome = resolveTrustedHomeDirectory();
    assert.ok(trustedHome, "macOS trusted home must come from the OS user database");

    const agentHome = join(root, "agent-owned-home");
    const agentPathBin = join(root, "agent-owned-path");
    const repoBin = join(projectDir, "agent-owned-repo-bin");
    mkdirSync(agentHome, { recursive: true });
    mkdirSync(join(agentHome, ".local", "bin"), { recursive: true });
    mkdirSync(agentPathBin, { recursive: true });
    mkdirSync(repoBin, { recursive: true });
    const homeCli = join(agentHome, ".local", "bin", "gh");
    const pathCli = join(agentPathBin, "gh");
    const repoCli = join(repoBin, "gh");
    for (const cliPath of [homeCli, pathCli, repoCli]) {
      writeFileSync(cliPath, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(cliPath, 0o755);
    }

    await withEnv(
      {
        PATH: agentPathBin,
        HOME: agentHome,
        USERPROFILE: agentHome,
        GH_TOKEN: "agent-owned-provider-auth",
        GITHUB_TOKEN: "agent-owned-provider-auth",
        GH_CONFIG_DIR: join(agentHome, "gh-config")
      },
      async () => {
        assert.equal(
          resolveTrustedHomeDirectory(),
          trustedHome,
          "macOS trusted home must ignore Agent-controlled HOME"
        );
        const resolved = resolveTrustedCli("gh", { projectDir });
        assert.notEqual(resolved?.realPath, realpathSync.native(homeCli));
        assert.notEqual(resolved?.realPath, realpathSync.native(pathCli));
        assert.notEqual(resolved?.realPath, realpathSync.native(repoCli));
        if (resolved?.trustedPath) {
          assert.equal(resolved.trustedPath.includes(agentPathBin), false);
          assert.equal(resolved.trustedPath.includes(agentHome), false);
          assert.equal(resolved.trustedPath.includes(repoBin), false);
        }
      }
    );
  }

  // A local Git include can move the effective remote outside the approved
  // repository config. It must fail closed; global/system rewrites are
  // independently disabled in the trusted child environment above.
  const gitProject = join(root, "git-project");
  mkdirSync(join(gitProject, ".git"), { recursive: true });
  write(
    gitProject,
    ".git/config",
    "[include]\n\tpath = ../agent-owned.gitconfig\n[remote \"origin\"]\n\turl = https://github.com/example/phase-c-test.git\n"
  );
  const gitEnvNames = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
    "GH_REPO",
    "GH_CONFIG_DIR",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0"
  ];
  await withoutEnv(gitEnvNames, async () => {
    const gitAdapter = createFakeAdapter(fixture, { id: "github" });
    const gitRequest = {
      ...snapshotRequest,
      projectId: deriveProjectId(gitProject),
      adapterId: "github",
      providerIdentity: "user:phase-c-test"
    };
    const gitResult = buildTrustedExecution(
      gitRequest,
      gitAdapter.planDeploy(name, "production", { force: false }),
      { pathOverride: fixture.pathOverride, projectDir: gitProject }
    );
    assert.equal(gitResult.ok, false, "Git include config must not produce an approvable destination");
    if (!gitResult.ok) assert.equal(gitResult.reason, "unsafe-environment");

    write(
      gitProject,
      ".git/config",
      "[remote \"origin\"]\n\turl = https://github.com/example/phase-c-test.git\n" +
        "[remote \"secondary\"]\n\turl = https://github.com/example/other.git\n"
    );
    const ambiguousGit = buildTrustedExecution(
      gitRequest,
      gitAdapter.planDeploy(name, "production", { force: false }),
      { pathOverride: fixture.pathOverride, projectDir: gitProject }
    );
    assert.equal(ambiguousGit.ok, false, "multiple Git remotes must not produce an approvable destination");
    if (!ambiguousGit.ok) assert.equal(ambiguousGit.reason, "unsafe-environment");
  });

  // Vercel development values are provider-readable after deployment. That
  // makes the operation high-risk even though the environment is not named
  // production, so an Agent/MCP call without a Human Plane must fail closed.
  const vercelProject = join(root, "vercel-project");
  mkdirSync(join(vercelProject, ".vercel"), { recursive: true });
  write(
    vercelProject,
    ".vercel/project.json",
    JSON.stringify({ orgId: "team_phase_c", projectId: "prj_phase_c" })
  );
  await withoutEnv(["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"], async () => {
    const vercelVault = new MemoryVault();
    const vercelProjectId = deriveProjectId(vercelProject);
    await vercelVault.setSecret(
      { name, scope: "project", projectId: vercelProjectId },
      canaryOpenAi
    );
    const result = await runDeploy(
      {
        vault: vercelVault,
        adapter: createFakeAdapter(fixture, { id: "vercel" }),
        print: () => {},
        pathOverride: fixture.pathOverride
      },
      {
        name,
        scope: "project",
        projectId: vercelProjectId,
        projectDir: vercelProject,
        env: "development",
        dryRun: false,
        force: false
      }
    );
    assert.equal(result.kind, "unavailable");
  });
}

// Phase D — Destination Boundary.
//
// handoff.ts always reads the real OS secret store by design, so an in-process
// test cannot complete a deploy. That is turned into an assertion here: a run
// that reaches the Secret read is a run the engine decided to execute without
// asking a human, and it still spawns nothing because the read fails first.
// The successful-execution and trust-recording halves live in the
// AGENT_KEY_CASE_E2E-gated test below.
async function runToSecretRead(deps, request) {
  try {
    return { reachedSecretRead: false, result: await runDeploy(deps, request) };
  } catch {
    return { reachedSecretRead: true, result: undefined };
  }
}

async function testPhaseDDestinationBoundary(root) {
  const projectDir = join(root, "project");
  const twinDir = join(root, "twin-project");
  const cliDir = join(root, "cli");
  const linkedProject = JSON.stringify({ orgId: "team_phase_d", projectId: "prj_phase_d" });
  write(projectDir, ".vercel/project.json", linkedProject);
  // Same provider destination, different project directory.
  write(twinDir, ".vercel/project.json", linkedProject);

  const fixture = createFakeCli(cliDir);
  const name = "AKC_PHASE_D_KEY";
  const projectId = deriveProjectId(projectDir);
  const recordPath = join(projectDir, ".akc-fake-record.json");
  const providerIdentity = "user:phase-d";
  const vercelEnvNames = ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"];
  const request = {
    name,
    scope: "project",
    projectId,
    projectDir,
    env: "preview",
    dryRun: false,
    force: false
  };

  // --- automatic policy: deny by default, one closed allowlist entry --------
  const inertPlan = {
    argv: ["akc-fake-cli"],
    valueVia: "stdin",
    displayCommand: "akc-fake-cli",
    overwriteWarning: false
  };
  const automatic = (overrides) =>
    isAutomaticSafeOperation({
      target: "vercel",
      env: "preview",
      scope: "project",
      force: false,
      plan: inertPlan,
      ...overrides
    });
  assert.equal(automatic({}), true);
  assert.equal(automatic({ env: "production" }), false);
  assert.equal(automatic({ env: "development" }), false, "Vercel development is provider-readable");
  assert.equal(automatic({ target: "github" }), false);
  assert.equal(automatic({ target: "cloudflare" }), false);
  assert.equal(automatic({ force: true }), false);
  assert.equal(automatic({ scope: "user" }), false);
  assert.equal(automatic({ plan: { ...inertPlan, overwriteWarning: true } }), false);
  assert.equal(automatic({ plan: { ...inertPlan, preSteps: [inertPlan] } }), false);
  assert.deepEqual([...AUTOMATIC_SAFE_ENVS.cloudflare], []);
  assert.deepEqual([...AUTOMATIC_SAFE_ENVS.github], []);
  assert.deepEqual([...AUTOMATIC_SAFE_ENVS.vercel], ["preview"]);
  for (const adapter of ADAPTERS.values()) {
    for (const env of ["production", "preview", "development"]) {
      for (const force of [true, false]) {
        assert.equal(
          isAutomaticSafeOperation({
            target: adapter.id,
            env,
            scope: "project",
            force,
            plan: adapter.planDeploy("AKC_POLICY_KEY", env, { force })
          }),
          adapter.id === "vercel" && env === "preview" && !force,
          `${adapter.id}/${env}/force=${force} automatic policy`
        );
      }
    }
  }

  await withoutEnv(vercelEnvNames, async () => {
    const makeAdapter = (identity = providerIdentity) =>
      createFakeAdapter(fixture, { id: "vercel", identity });
    const adapter = makeAdapter();
    const plan = adapter.planDeploy(name, "preview", { force: false });
    const snapshotRequest = {
      name,
      scope: "project",
      projectId,
      env: "preview",
      force: false,
      adapterId: "vercel",
      cliCommand: fixture.cliCommand,
      providerIdentity
    };
    const boundIdentity = (dir) => {
      const bound = buildTrustedExecution(
        { ...snapshotRequest, projectId: deriveProjectId(dir) },
        plan,
        { pathOverride: fixture.pathOverride, projectDir: dir }
      );
      assert.equal(bound.ok, true);
      return destinationIdentity(bound.execution.snapshot, providerIdentity);
    };

    const history = new DeploymentHistory(projectDir, testRoot);
    const past = history.begin({ name, scope: "project", target: "vercel", env: "preview",
      destinationId: boundIdentity(projectDir).fingerprint, force: false });
    assert.ok(past); assert.ok(history.finish(past, "completed"));
    // All first-use, decline, cross-project and high-risk assertions below now
    // run in the presence of a past success, which cannot create any trust.
    const trustedForHistory = withDestinationTrust(new MemoryVault(), { trusted: true });
    await trustedForHistory.setSecret({ name, scope: "project", projectId }, canaryOpenAi);
    const historyBlocked = await runDeploy({ vault: trustedForHistory, adapter, print: () => {},
      pathOverride: fixture.pathOverride, historyBaseDir: join(root, "absent-history-home") }, request);
    assert.equal(historyBlocked.kind, "history-unavailable");
    assert.deepEqual(historyBlocked.historyDiagnostic, {
      phase: "start", issue: "path-unavailable", recovery: "review-storage-access"
    });
    assert.equal(existsSync(recordPath), false, "history start failure blocks before the value read/spawn");

    const historyDir = join(testRoot, ".api-key-case", "deployment-history",
      createHash("sha256").update(realpathSync.native(projectDir)).digest("hex"));
    mkdirSync(join(historyDir, "lock"));
    try {
      const printed = [];
      const locked = await runDeploy({ vault: trustedForHistory, adapter,
        print: (line) => printed.push(line), pathOverride: fixture.pathOverride }, request);
      assert.equal(locked.kind, "history-unavailable");
      assert.deepEqual(locked.historyDiagnostic, { phase: "start", issue: "lock-present", recovery: "wait-and-inspect" });
      assert.ok(printed.some((line) => line.includes("no provider write was attempted")));
      assert.ok(printed.some((line) => line.includes("crash or stale lock is not established")));
      assert.ok(printed.some((line) => line.includes("run history --json again")));
      assert.equal(existsSync(recordPath), false);
      assert.equal(existsSync(join(historyDir, "lock")), true);

      const mcp = buildTools({ defaultProjectDir: projectDir, createVault: () => trustedForHistory,
        adapters: new Map([["vercel", adapter]]), pathOverride: fixture.pathOverride, historyBaseDir: testRoot,
        licenseOptions: testProLicenseOptions(join(root, "history-start-mcp-license")) });
      const response = await mcp.deploy_secret({ name, target: "vercel", env: "preview" });
      assert.equal(response.structuredContent.status, "history-unavailable");
      assert.deepEqual(response.structuredContent.historyDiagnostic, locked.historyDiagnostic);
      assert.match(response.content[0].text, /no provider write was attempted by this invocation/);
      assert.equal(existsSync(recordPath), false);
    } finally { rmSync(join(historyDir, "lock"), { recursive: true }); }

    // A handoff exception after the unknown start is saved must reach the MCP
    // Agent as an unknown result, rather than the generic guarded error.
    const unknownMcp = buildTools({ defaultProjectDir: projectDir, createVault: () => trustedForHistory,
      adapters: new Map([["vercel", adapter]]), pathOverride: fixture.pathOverride, historyBaseDir: testRoot,
      licenseOptions: testProLicenseOptions(join(root, "unknown-mcp-license")) });
    const unknownResponse = await unknownMcp.deploy_secret({ name, target: "vercel", env: "preview" });
    assert.equal(unknownResponse.structuredContent.status, "failed");
    assert.match(unknownResponse.content[0].text, /deployment result is unknown/);
    assert.match(unknownResponse.content[0].text, /do not retry automatically/);
    assertNoCanary("MCP unknown-result text", unknownResponse.content[0].text);

    const originalConfig = readFileSync(join(projectDir, ".vercel/project.json"), "utf8");
    const swappingAdapter = { ...adapter, checkCli: async () => {
      writeFileSync(join(projectDir, ".vercel/project.json"), JSON.stringify({ orgId: "team_changed", projectId: "prj_changed" }));
      return { installed: true, loggedIn: true, identity: providerIdentity };
    } };
    assert.equal(await resolveDestinationIdentity({ adapter: swappingAdapter, projectDir, env: "preview", pathOverride: fixture.pathOverride }), null);
    writeFileSync(join(projectDir, ".vercel/project.json"), originalConfig);

    // --- the Phase C binding follows the real adapter argv ----------------
    // The write-only premise behind the preview automatic policy only holds if
    // the `--sensitive` the adapter plans is the argv that is actually bound,
    // displayed, and re-verified before the spawn.
    const realPlan = ADAPTERS.get("vercel").planDeploy(name, "preview", { force: false });
    const realBound = buildTrustedExecution(snapshotRequest, realPlan, {
      pathOverride: fixture.pathOverride,
      projectDir
    });
    assert.equal(realBound.ok, true);
    if (realBound.ok) {
      assert.deepEqual(
        [...realBound.execution.snapshot.argv],
        ["vercel", "env", "add", name, "preview", "--sensitive", "--yes"]
      );
      assert.equal(
        makeApprovalPlan(snapshotRequest, realPlan, realBound.execution, "first-use").command,
        `vercel env add ${name} preview --sensitive --yes`,
        "the approval dialog must show the sensitive storage it is approving"
      );
      assert.equal(
        matchesTrustedExecution(snapshotRequest, realPlan, realBound.execution),
        true
      );
      assert.equal(
        matchesTrustedExecution(
          snapshotRequest,
          { ...realPlan, argv: realPlan.argv.filter((token) => token !== "--sensitive") },
          realBound.execution
        ),
        false,
        "an operation that drops --sensitive is not the bound operation"
      );
    }

    // --- the identity itself --------------------------------------------
    const identity = boundIdentity(projectDir);
    assert.ok(identity);
    assert.match(identity.fingerprint, /^[0-9a-f]{64}$/);
    assert.match(identity.slot, /^[0-9a-f]{64}$/);
    assert.notEqual(identity.fingerprint, identity.slot);
    assert.equal(JSON.stringify(identity).includes(canaryOpenAi), false);
    assert.equal(
      identity.fingerprint,
      boundIdentity(projectDir).fingerprint,
      "the same destination must fingerprint identically"
    );
    assert.notEqual(
      identity.fingerprint,
      boundIdentity(twinDir).fingerprint,
      "another project directory is another destination"
    );
    assert.notEqual(identity.slot, boundIdentity(twinDir).slot);

    // --- first use is never automatic ------------------------------------
    const vault = withDestinationTrust(new MemoryVault());
    await vault.setSecret({ name, scope: "project", projectId }, canaryOpenAi);
    // A user-scoped copy exists so the user-scope case below is denied by the
    // automatic policy rather than by a missing Secret.
    await vault.setSecret({ name, scope: "user", projectId: null }, canaryOpenAi);
    const firstUsePrinted = [];
    const firstUse = await runDeploy(
      { vault, adapter, print: (line) => firstUsePrinted.push(line), pathOverride: fixture.pathOverride },
      request
    );
    assert.equal(firstUse.kind, "unavailable", "a first-use destination must not deploy automatically");
    assert.equal(vault.records.size, 0, "a denied deploy must not create a trust record");
    assert.equal(existsSync(recordPath), false);
    assert.ok(firstUsePrinted.some((line) => line.includes("first use of this destination")));

    // --- an Agent cannot approve; a decline records nothing ---------------
    let seenPlan;
    const declined = await runDeploy(
      {
        vault,
        adapter,
        print: () => {},
        humanPlane: createTestHumanPlane("declined", (approvalPlan) => {
          seenPlan = approvalPlan;
        }),
        pathOverride: fixture.pathOverride
      },
      request
    );
    assert.equal(declined.kind, "declined");
    assert.equal(seenPlan?.trustState, "first-use");
    assert.equal(vault.records.size, 0);
    assert.equal(existsSync(recordPath), false);

    // --- a recorded destination identity is reusable, and only it ---------
    await recordDestinationTrust(vault, identity);
    assert.equal(vault.records.size, 2);
    for (const account of vault.records) {
      assert.match(account, /^v1\|destination(-slot)?\|[0-9a-f]{64}$/);
      assert.equal(account.includes(canaryOpenAi), false);
    }
    assert.equal(await readDestinationTrust(vault, identity), "trusted");
    assert.equal(DESTINATION_TRUST_MARKER.includes(canaryOpenAi), false);

    // --- a save that fails partway through must never leave a destination
    // trusted (regression: recordDestinationTrust must write the slot before
    // the exact record, so a failure on the second write cannot leave the
    // exact record behind without its slot) --------------------------------
    {
      const saveOrder = [];
      const partialSaveVault = withDestinationTrust(new MemoryVault(), {
        onSave: async (ref) => {
          saveOrder.push(ref.kind);
          // The first trust-store operation succeeds; only the second throws.
          if (saveOrder.length === 2) {
            throw new Error("synthetic destination trust save failure (2nd op)");
          }
        }
      });
      await assert.rejects(() => recordDestinationTrust(partialSaveVault, identity));
      assert.deepEqual(
        saveOrder,
        ["destination-slot", "destination"],
        "the slot must be saved before the exact destination record"
      );
      assert.equal(
        partialSaveVault.records.size,
        1,
        "only the slot record must survive a save that fails on its second write"
      );
      assert.equal(
        await readDestinationTrust(partialSaveVault, identity),
        "changed",
        "a partial save must never read back as trusted"
      );
    }

    let approvalRequests = 0;
    const countingPlane = createTestHumanPlane("approved", () => {
      approvalRequests += 1;
    });
    const trustedPrinted = [];
    const trusted = await runToSecretRead(
      {
        vault,
        adapter,
        print: (line) => trustedPrinted.push(line),
        humanPlane: countingPlane,
        pathOverride: fixture.pathOverride
      },
      request
    );
    assert.equal(approvalRequests, 0, "a trusted destination must not open the Human Plane");
    assert.equal(trusted.reachedSecretRead, true);
    assert.equal(history.read().entries.at(-1).outcome, "unknown", "handoff exception leaves no inferred success");
    assert.ok(trustedPrinted.some((line) => line.includes("confirmed by a human before")));
    assert.ok(trustedPrinted.some((line) => line.includes("deployment result is unknown")));
    assert.ok(trustedPrinted.some((line) => line.includes("do not retry automatically")));
    assert.equal(existsSync(recordPath), false);

    // --- every high-risk class stays high-risk even when trusted ----------
    for (const highRisk of [
      { ...request, env: "production" },
      { ...request, env: "development" },
      { ...request, force: true },
      { ...request, scope: "user", projectId: null }
    ]) {
      let highRiskApprovals = 0;
      const result = await runDeploy(
        {
          vault,
          adapter,
          print: () => {},
          humanPlane: createTestHumanPlane("declined", () => {
            highRiskApprovals += 1;
          }),
          pathOverride: fixture.pathOverride
        },
        highRisk
      );
      assert.equal(
        result.kind,
        "declined",
        `${highRisk.env}/${highRisk.scope}/force=${highRisk.force} must ask a human`
      );
      assert.equal(highRiskApprovals, 1);
      assert.equal(existsSync(recordPath), false);
    }
    for (const highRisk of [
      { ...request, env: "production" },
      { ...request, env: "development" },
      { ...request, force: true }
    ]) {
      const withoutPlane = await runDeploy(
        { vault, adapter, print: () => {}, pathOverride: fixture.pathOverride },
        highRisk
      );
      assert.equal(withoutPlane.kind, "unavailable");
      assert.equal(existsSync(recordPath), false);
    }

    // --- provider identity / auth state change invalidates trust ----------
    let identityApprovals = 0;
    const swappedIdentity = await runDeploy(
      {
        vault,
        adapter: makeAdapter("user:someone-else"),
        print: () => {},
        humanPlane: createTestHumanPlane("declined", (approvalPlan) => {
          identityApprovals += 1;
          seenPlan = approvalPlan;
        }),
        pathOverride: fixture.pathOverride
      },
      request
    );
    assert.equal(swappedIdentity.kind, "declined");
    assert.equal(identityApprovals, 1, "a different provider account is a different destination");
    assert.equal(seenPlan.trustState, "changed");

    // --- destination config change invalidates trust ----------------------
    write(
      projectDir,
      ".vercel/project.json",
      JSON.stringify({ orgId: "team_attacker", projectId: "prj_attacker" })
    );
    const movedPrinted = [];
    const moved = await runDeploy(
      { vault, adapter, print: (line) => movedPrinted.push(line), pathOverride: fixture.pathOverride },
      request
    );
    assert.equal(moved.kind, "unavailable", "a redirected project config must not reuse trust");
    assert.ok(movedPrinted.some((line) => line.includes("changed since the last confirmation")));
    assert.equal(existsSync(recordPath), false);
    write(projectDir, ".vercel/project.json", linkedProject);

    // --- another project directory cannot borrow this trust ---------------
    await vault.setSecret(
      { name, scope: "project", projectId: deriveProjectId(twinDir) },
      canaryOpenAi
    );
    const twinResult = await runDeploy(
      { vault, adapter, print: () => {}, pathOverride: fixture.pathOverride },
      { ...request, projectId: deriveProjectId(twinDir), projectDir: twinDir }
    );
    assert.equal(twinResult.kind, "unavailable");
    assert.equal(existsSync(join(twinDir, ".akc-fake-record.json")), false);

    // --- a Secret from another project cannot ride this destination -------
    const crossProject = await runDeploy(
      { vault, adapter, print: () => {}, pathOverride: fixture.pathOverride },
      { ...request, projectId: deriveProjectId(twinDir) }
    );
    assert.equal(crossProject.kind, "changed");

    // --- provider auth environment fails closed even when trusted ---------
    await withEnv({ VERCEL_TOKEN: canaryOpenAi }, async () => {
      let envApprovals = 0;
      const result = await runDeploy(
        {
          vault,
          adapter,
          print: () => {},
          humanPlane: createTestHumanPlane("approved", () => {
            envApprovals += 1;
          }),
          pathOverride: fixture.pathOverride
        },
        request
      );
      assert.equal(result.kind, "unavailable");
      assert.equal(envApprovals, 0, "a provider credential in the environment must fail closed");
      assert.equal(existsSync(recordPath), false);
    });

    // --- an ambiguous destination fails closed ----------------------------
    rmSync(join(projectDir, ".vercel", "project.json"), { force: true });
    write(projectDir, "vercel.json", JSON.stringify({ version: 2 }));
    const ambiguous = await runDeploy(
      {
        vault,
        adapter,
        print: () => {},
        humanPlane: createTestHumanPlane("approved"),
        pathOverride: fixture.pathOverride
      },
      request
    );
    assert.equal(ambiguous.kind, "unavailable", "an unlinked Vercel project is not a destination");
    assert.equal(existsSync(recordPath), false);
    rmSync(join(projectDir, "vercel.json"), { force: true });
    write(projectDir, ".vercel/project.json", linkedProject);

    // --- a CLI upgrade keeps the destination, but not a mid-call swap -----
    const cliPathForFixture = join(
      cliDir,
      process.platform === "win32" ? "akc-fake-cli.cmd" : "akc-fake-cli"
    );
    const originalCli = readFileSync(cliPathForFixture, "utf8");
    writeFileSync(cliPathForFixture, `${originalCli}rem upgraded\n`, "utf8");
    assert.equal(
      boundIdentity(projectDir).fingerprint,
      identity.fingerprint,
      "a CLI upgrade must not force a human to re-confirm an unchanged destination"
    );
    writeFileSync(cliPathForFixture, originalCli, "utf8");

    const swapVault = withDestinationTrust(new MemoryVault(), {
      onRead: () => {
        // Replace the resolved CLI in the window between the trust decision
        // and the spawn.
        writeFileSync(cliPathForFixture, `${originalCli}rem swapped\n`, "utf8");
      }
    });
    await swapVault.setSecret({ name, scope: "project", projectId }, canaryOpenAi);
    await recordDestinationTrust(swapVault, identity);
    const swapped = await runDeploy(
      { vault: swapVault, adapter, print: () => {}, pathOverride: fixture.pathOverride },
      request
    );
    assert.equal(swapped.kind, "changed", "a CLI swapped after the trust decision must abort");
    assert.equal(existsSync(recordPath), false);
    writeFileSync(cliPathForFixture, originalCli, "utf8");

    // --- MCP can never create or use unconfirmed destination trust --------
    const mcpVault = withDestinationTrust(new MemoryVault());
    await mcpVault.setSecret(
      { name, scope: "project", projectId: deriveProjectId(twinDir) },
      canaryOpenAi
    );
    const mcpTools = buildTools({
      defaultProjectDir: twinDir,
      createVault: () => mcpVault,
      adapters: new Map([["vercel", adapter]]),
      pathOverride: fixture.pathOverride,
      licenseOptions: testProLicenseOptions(join(root, "mcp-license-home"))
    });
    const mcpResult = await mcpTools.deploy_secret({
      name,
      target: "vercel",
      env: "preview"
    });
    assert.equal(mcpResult.structuredContent?.status, "unavailable");
    assert.equal(mcpVault.records.size, 0, "MCP must not be able to confirm a destination");
    assert.equal(existsSync(join(twinDir, ".akc-fake-record.json")), false);
    assertNoCanary("mcp destination text", mcpResult.content[0].text);
  });
}

// Phase E lifecycle (v2.1 §11, AC-6). The property under test is not "the
// Agent is told not to delete things" but "the Agent cannot delete things":
// every destructive path ends at an Agent-independent Human Plane decision,
// and refusing or being unable to ask leaves the state untouched.
async function testPhaseELifecycle(root) {
  const projectDir = join(root, "project");
  const cliDir = join(root, "cli");
  const homeDir = join(root, "home");
  mkdirSync(homeDir, { recursive: true });
  write(projectDir, ".gitignore", ".env\n.env.*\n!.env.example\n");
  write(projectDir, ".env.example", "LIFECYCLE_API_KEY=\n");
  write(
    projectDir,
    ".vercel/project.json",
    JSON.stringify({ orgId: "team_phase_e", projectId: "prj_phase_e" })
  );

  const projectId = deriveProjectId(projectDir);
  const requiredRef = { name: "LIFECYCLE_API_KEY", scope: "project", projectId };
  const retiredRef = { name: "RETIRED_LIFECYCLE_KEY", scope: "project", projectId };
  const vault = withDestinationTrust(new MemoryVault());
  await vault.setSecret(requiredRef, canaryOpenAi);
  await vault.setSecret(retiredRef, canaryGithub);
  for (const ref of [requiredRef, retiredRef]) {
    upsertRegistryEntry(
      { name: ref.name, scope: "project", projectId, projectPath: projectDir },
      homeDir
    );
  }

  const nextReport = () =>
    buildNextReport(projectDir, {
      vault,
      adapters: [],
      licensePlan: "free",
      registryBaseDir: homeDir
    });

  // --- the cleanup candidate is visible, and only as a human action --------
  const before = await nextReport();
  assert.deepEqual(
    before.secrets.map((entry) => [entry.name, entry.status]),
    [["LIFECYCLE_API_KEY", "registered"], ["RETIRED_LIFECYCLE_KEY", "unused"]]
  );
  assert.deepEqual(
    before.nextActions.filter((action) => action.kind === "remove-secret"),
    [{ actor: "human", kind: "remove-secret", name: "RETIRED_LIFECYCLE_KEY", scope: "project" }]
  );
  assertClosedNextSchema(before);
  assertNoCanary("phase E next report", JSON.stringify(before));

  const removeRequest = { name: retiredRef.name, scope: "project", projectDir };
  const lifecycleDeps = (humanPlane) => ({
    vault,
    humanPlane,
    print: () => {},
    registryBaseDir: homeDir
  });

  // --- an Agent alone cannot delete a Secret -------------------------------
  let removalPlan;
  const declined = await runRemoveSecret(
    lifecycleDeps(createTestRemovalPlane("declined", (plan) => {
      removalPlan = plan;
    })),
    removeRequest
  );
  assert.equal(declined.kind, "declined");
  assert.equal(await vault.hasSecret(retiredRef), true, "a declined removal must keep the Secret");
  assert.deepEqual(removalPlan, {
    kind: "secret",
    name: retiredRef.name,
    scope: "project",
    projectId,
    projectDir: realpathSync.native(projectDir).replace(/\\/g, "/")
  });
  assertNoCanary("phase E removal plan", JSON.stringify(removalPlan));

  const noDialog = await runRemoveSecret(
    lifecycleDeps(createTestRemovalPlane("no-dialog")),
    removeRequest
  );
  assert.equal(noDialog.kind, "human-plane-unavailable");
  assert.equal(await vault.hasSecret(retiredRef), true, "no Human Plane means no deletion");

  const brokenPlane = await runRemoveSecret(
    lifecycleDeps({
      capability: () => "os-dialog",
      askSecret: async () => "unavailable",
      askApproval: async () => "unavailable",
      askRemoval: async () => {
        throw new Error("dialog crashed");
      }
    }),
    removeRequest
  );
  assert.equal(brokenPlane.kind, "human-plane-unavailable");
  assert.equal(await vault.hasSecret(retiredRef), true);

  // Linux executing deploy remains unavailable. On macOS the real Human Plane is a GUI
  // capability; this test must not open an interactive dialog, so only check
  // capability there and exercise the status mapping in the injected tests
  // above.
  assert.equal(
    await createHumanPlane("linux").askRemoval({
      kind: "secret",
      name: retiredRef.name,
      scope: "project",
      projectId,
      projectDir
    }),
    "unavailable"
  );
  const darwinLifecyclePlane = createHumanPlane("darwin");
  if (process.platform === "darwin") {
    assert.equal(darwinLifecyclePlane.capability(), "os-dialog");
  } else {
    assert.equal(darwinLifecyclePlane.capability(), "handoff-only");
    assert.equal(
      await darwinLifecyclePlane.askRemoval({
        kind: "secret",
        name: retiredRef.name,
        scope: "project",
        projectId,
        projectDir
      }),
      "unavailable"
    );
  }

  // --- the real removal dialog the Windows Human Plane would open ---------
  let helperRequest;
  const windowsPlane = new WindowsHumanPlane(WINDOWS_POWERSHELL_PATH, async (request) => {
    helperRequest = request;
    return 2; // deny, so this check never depends on a human clicking
  });
  for (const dialogPlan of [
    { kind: "secret", name: retiredRef.name, scope: "project", projectId, projectDir },
    { kind: "secret", name: retiredRef.name, scope: "user", projectId: null, projectDir: null },
    { kind: "destination-trust", target: "vercel", env: "preview", projectDir }
  ]) {
    assert.equal(await windowsPlane.askRemoval(dialogPlan), "declined");
    assert.equal(helperRequest.executable, WINDOWS_POWERSHELL_PATH);
    assertWindowsHelperEnv(helperRequest.env);
    assert.equal(helperRequest.stdio, "ignore");
    assert.equal(helperRequest.shell, false);

    const encoded = helperRequest.args[helperRequest.args.indexOf("-EncodedCommand") + 1];
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    assert.equal(script, buildWindowsRemovalScript(dialogPlan));
    // Deny-safe: Enter, Escape, and the initial focus all decline.
    assert.match(script, /\$form\.AcceptButton = \$noButton/);
    assert.match(script, /\$form\.CancelButton = \$noButton/);
    assert.match(script, /\$form\.Add_Shown\(\{ \$noButton\.Focus\(\) \}\)/);
    assert.match(script, /\$script:resultCode = 2/);
    assertWindowsUserVerificationGate(script, "Windows removal");
    assertLocalizedWindowsDialog(
      script,
      "Windows removal",
      dialogPlan.kind === "secret"
        ? WINDOWS_DIALOG_TEXT.deleteSecretCaption
        : WINDOWS_DIALOG_TEXT.forgetDestinationCaption,
      WINDOWS_DIALOG_TEXT.deleteButton,
      WINDOWS_DIALOG_TEXT.declineButton
    );
    assert.doesNotMatch(script, /Write-(Host|Output|Error)|Console\.Write/);
    assertNoCanary("removal dialog script", script);

    if (process.platform === "win32") {
      const parsed = parseWindowsHelperScript(script);
      assert.equal(parsed.status, 0, "Windows removal dialog script must parse");
    }
  }

  // Malformed plans never reach the helper.
  for (const badPlan of [
    { kind: "secret", name: "not-a-valid-name", scope: "project", projectId, projectDir },
    { kind: "secret", name: retiredRef.name, scope: "user", projectId, projectDir },
    { kind: "secret", name: retiredRef.name, scope: "project", projectId: "zz", projectDir },
    { kind: "destination-trust", target: "not-a-target", env: "preview", projectDir },
    { kind: "destination-trust", target: "vercel", env: "staging", projectDir },
    { kind: "destination-trust", target: "vercel", env: "preview", projectDir: "line\nbreak" },
    { kind: "reset-everything", projectDir }
  ]) {
    await assert.rejects(() => windowsPlane.askRemoval(badPlan));
    assert.throws(() => buildWindowsRemovalScript(badPlan));
  }

  // --- an approved removal is the only path that deletes -------------------
  const removed = await runRemoveSecret(
    lifecycleDeps(createTestRemovalPlane("approved")),
    removeRequest
  );
  assert.equal(removed.kind, "removed");
  assert.equal(await vault.hasSecret(retiredRef), false);
  assert.equal(
    readRegistry(homeDir).some((entry) => entry.name === retiredRef.name),
    false,
    "removal clears the index row too"
  );

  const afterCleanup = await nextReport();
  assert.equal(
    afterCleanup.nextActions.some((action) => action.kind === "remove-secret"),
    false,
    "no lifecycle work remains once the candidate is gone"
  );

  // --- removing a still-required Secret returns it to missing --------------
  const removedRequired = await runRemoveSecret(
    lifecycleDeps(createTestRemovalPlane("approved")),
    { name: requiredRef.name, scope: "project", projectDir }
  );
  assert.equal(removedRequired.kind, "removed");
  assert.equal(await vault.hasSecret(requiredRef), false);
  const afterRequired = await nextReport();
  assert.deepEqual(
    afterRequired.secrets.map((entry) => [entry.name, entry.status]),
    [["LIFECYCLE_API_KEY", "missing"]]
  );
  assert.ok(
    afterRequired.nextActions.some(
      (action) => action.kind === "register-secret" && action.name === requiredRef.name
    )
  );

  // A name that is neither stored nor indexed is an error, not a dialog.
  let strayDialogs = 0;
  const unknown = await runRemoveSecret(
    lifecycleDeps(createTestRemovalPlane("approved", () => {
      strayDialogs += 1;
    })),
    { name: "NEVER_REGISTERED_KEY", scope: "project", projectDir }
  );
  assert.equal(unknown.kind, "not-registered");
  assert.equal(strayDialogs, 0);

  // A leftover index row with no stored value is metadata, not a Secret.
  upsertRegistryEntry(
    { name: "STALE_LIFECYCLE_KEY", scope: "project", projectId, projectPath: projectDir },
    homeDir
  );
  const pruned = await runRemoveSecret(
    lifecycleDeps(createTestRemovalPlane("approved", () => {
      strayDialogs += 1;
    })),
    { name: "STALE_LIFECYCLE_KEY", scope: "project", projectDir }
  );
  assert.equal(pruned.kind, "index-pruned");
  assert.equal(strayDialogs, 0);
  assert.deepEqual(readRegistry(homeDir), []);

  // --- keyring read/delete failures fail closed ---------------------------
  const readFailureRef = { name: "READ_FAILURE_LIFECYCLE_KEY", scope: "project", projectId };
  upsertRegistryEntry(
    { name: readFailureRef.name, scope: readFailureRef.scope, projectId, projectPath: projectDir },
    homeDir
  );
  const readFailureVault = {
    backendName: "synthetic-read-failure",
    isAvailable: async () => true,
    setSecret: async () => {},
    hasSecret: async () => {
      throw new Error("synthetic credential store read failure");
    },
    deleteSecret: async () => {
      throw new Error("must not delete after a read failure");
    },
    hasDestinationTrust: async () => false,
    saveDestinationTrust: async () => {},
    deleteDestinationTrust: async () => false
  };
  const readFailed = await runRemoveSecret(
    { ...lifecycleDeps(createTestRemovalPlane("approved")), vault: readFailureVault },
    { name: readFailureRef.name, scope: readFailureRef.scope, projectDir }
  );
  assert.equal(readFailed.kind, "vault-read-failed");
  assert.equal(
    readRegistry(homeDir).some((entry) => entry.name === readFailureRef.name),
    true,
    "a failed store read must not prune the registry"
  );
  removeRegistryEntry(
    { name: readFailureRef.name, scope: readFailureRef.scope, projectId },
    homeDir
  );

  for (const deleteFailure of ["false", "throw"]) {
    const deleteFailureRef = {
      name: `DELETE_FAILURE_${deleteFailure.toUpperCase()}_KEY`,
      scope: "project",
      projectId
    };
    upsertRegistryEntry(
      {
        name: deleteFailureRef.name,
        scope: deleteFailureRef.scope,
        projectId,
        projectPath: projectDir
      },
      homeDir
    );
    let deleteCalls = 0;
    const deleteFailureVault = {
      backendName: `synthetic-delete-${deleteFailure}`,
      isAvailable: async () => true,
      setSecret: async () => {},
      hasSecret: async () => true,
      deleteSecret: async () => {
        deleteCalls += 1;
        if (deleteFailure === "false") return false;
        throw new Error("synthetic credential store delete failure");
      },
      hasDestinationTrust: async () => false,
      saveDestinationTrust: async () => {},
      deleteDestinationTrust: async () => false
    };
    const deleteFailed = await runRemoveSecret(
      { ...lifecycleDeps(createTestRemovalPlane("approved")), vault: deleteFailureVault },
      { name: deleteFailureRef.name, scope: deleteFailureRef.scope, projectDir }
    );
    assert.equal(deleteFailed.kind, "vault-delete-failed", `${deleteFailure} delete failure`);
    assert.equal(deleteCalls, 1);
    assert.equal(
      readRegistry(homeDir).some((entry) => entry.name === deleteFailureRef.name),
      true,
      `${deleteFailure} delete failure must leave the registry unchanged`
    );
    removeRegistryEntry(
      { name: deleteFailureRef.name, scope: deleteFailureRef.scope, projectId },
      homeDir
    );
  }

  // --- destination trust cleanup ------------------------------------------
  const fixture = createFakeCli(cliDir);
  await withoutEnv(["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"], async () => {
    const providerIdentity = "user:phase-e";
    const adapter = createFakeAdapter(fixture, { id: "vercel", identity: providerIdentity });
    const forgetRequest = {
      adapter,
      projectDir,
      env: "preview",
      pathOverride: fixture.pathOverride
    };

    const identity = await resolveDestinationIdentity(forgetRequest);
    assert.ok(identity, "the fixture destination must resolve");
    assert.match(identity.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(
      identity.slot,
      destinationSlotFingerprint(realpathSync.native(projectDir), "vercel", "preview"),
      "the slot fingerprint must be derivable without a provider call"
    );

    // Nothing recorded yet: no dialog, no change.
    let trustDialogs = 0;
    const nothing = await runForgetDestinationTrust(
      lifecycleDeps(createTestRemovalPlane("approved", () => {
        trustDialogs += 1;
      })),
      forgetRequest
    );
    assert.equal(nothing.kind, "nothing-recorded");
    assert.equal(trustDialogs, 0);

    const trustReadFailure = withDestinationTrust(new MemoryVault(), {
      onRead: async () => {
        throw new Error("synthetic destination trust read failure");
      }
    });
    await recordDestinationTrust(trustReadFailure, identity);
    const trustReadFailed = await runForgetDestinationTrust(
      { ...lifecycleDeps(createTestRemovalPlane("approved")), vault: trustReadFailure },
      forgetRequest
    );
    assert.equal(trustReadFailed.kind, "vault-read-failed");
    assert.equal(trustReadFailure.records.size, 2, "a failed trust read must not change trust state");

    // A target/environment outside the automatic-safe allowlist can never hold
    // a record, so it is answered without a provider probe or a store read.
    for (const env of ["production", "development"]) {
      let probes = 0;
      const outside = await runForgetDestinationTrust(
        lifecycleDeps(createTestRemovalPlane("approved", () => {
          trustDialogs += 1;
        })),
        {
          ...forgetRequest,
          env,
          adapter: createFakeAdapter(fixture, {
            id: "vercel",
            identity: () => {
              probes += 1;
              return providerIdentity;
            }
          })
        }
      );
      assert.equal(outside.kind, "nothing-recorded");
      assert.equal(probes, 0, `vercel/${env} must not spawn a provider probe`);
      assert.equal(trustDialogs, 0);
    }

    await recordDestinationTrust(vault, identity);
    assert.equal(vault.records.size, 2);
    assert.equal(await readDestinationTrust(vault, identity), "trusted");

    for (const deleteFailure of ["false", "throw"]) {
      const trustDeleteFailure = withDestinationTrust(new MemoryVault(), {
        onDelete: async () => {
          if (deleteFailure === "throw") {
            throw new Error("synthetic destination trust delete failure");
          }
        },
        deleteResult: deleteFailure === "false" ? false : undefined
      });
      await recordDestinationTrust(trustDeleteFailure, identity);
      const trustDeleteFailed = await runForgetDestinationTrust(
        { ...lifecycleDeps(createTestRemovalPlane("approved")), vault: trustDeleteFailure },
        forgetRequest
      );
      assert.equal(
        trustDeleteFailed.kind,
        "vault-delete-failed",
        `${deleteFailure} destination trust delete failure`
      );
      assert.equal(trustDeleteFailure.records.size, 2, `${deleteFailure} failure must preserve trust state`);
      assert.equal(await readDestinationTrust(trustDeleteFailure, identity), "trusted");
    }

    // --- a delete that fails partway through must never leave a destination
    // trusted (regression: forgetDestinationTrust must delete the exact
    // record before the slot, so a failure on the second delete can only
    // leave a "changed" state, never "trusted") -----------------------------
    {
      const deleteOrder = [];
      const partialDeleteVault = withDestinationTrust(new MemoryVault(), {
        onDelete: async (ref) => {
          deleteOrder.push(ref.kind);
          // The first trust-store operation succeeds; only the second throws.
          if (deleteOrder.length === 2) {
            throw new Error("synthetic destination trust delete failure (2nd op)");
          }
        }
      });
      await recordDestinationTrust(partialDeleteVault, identity);
      assert.equal(partialDeleteVault.records.size, 2);
      const partialDeleteFailed = await runForgetDestinationTrust(
        { ...lifecycleDeps(createTestRemovalPlane("approved")), vault: partialDeleteVault },
        forgetRequest
      );
      assert.equal(partialDeleteFailed.kind, "vault-delete-failed");
      assert.deepEqual(
        deleteOrder,
        ["destination", "destination-slot"],
        "the exact destination record must be deleted before the slot"
      );
      assert.equal(
        partialDeleteVault.records.size,
        1,
        "only the slot record must remain after a delete that fails on its second write"
      );
      assert.equal(
        await readDestinationTrust(partialDeleteVault, identity),
        "changed",
        "a partial delete must never read back as trusted"
      );
    }

    // --- an Agent alone cannot forget destination trust -------------------
    let trustPlan;
    const trustDeclined = await runForgetDestinationTrust(
      lifecycleDeps(createTestRemovalPlane("declined", (plan) => {
        trustPlan = plan;
      })),
      forgetRequest
    );
    assert.equal(trustDeclined.kind, "declined");
    assert.equal(vault.records.size, 2, "a declined removal must keep the trust records");
    assert.deepEqual(trustPlan, {
      kind: "destination-trust",
      target: "vercel",
      env: "preview",
      projectDir: realpathSync.native(projectDir).replace(/\\/g, "/")
    });
    assert.equal(JSON.stringify(trustPlan).includes(identity.fingerprint), false);

    const trustNoDialog = await runForgetDestinationTrust(
      lifecycleDeps(createTestRemovalPlane("no-dialog")),
      forgetRequest
    );
    assert.equal(trustNoDialog.kind, "human-plane-unavailable");
    assert.equal(vault.records.size, 2);
    assert.equal(await readDestinationTrust(vault, identity), "trusted");

    // --- an approved removal restores the first-use boundary --------------
    const forgotten = await runForgetDestinationTrust(
      lifecycleDeps(createTestRemovalPlane("approved")),
      forgetRequest
    );
    assert.deepEqual(forgotten, {
      kind: "forgotten",
      removal: { destination: "removed", slot: "removed" }
    });
    assert.equal(vault.records.size, 0);
    assert.equal(
      await readDestinationTrust(vault, identity),
      "unconfirmed",
      "a forgotten destination must be treated as a first use again"
    );

    // The next deploy to that destination asks a human again.
    await vault.setSecret(requiredRef, canaryOpenAi);
    const printed = [];
    const afterForget = await runDeploy(
      { vault, adapter, print: (line) => printed.push(line), pathOverride: fixture.pathOverride },
      {
        name: requiredRef.name,
        scope: "project",
        projectId,
        projectDir,
        env: "preview",
        dryRun: false,
        force: false
      }
    );
    assert.equal(afterForget.kind, "unavailable");
    assert.ok(printed.some((line) => line.includes("first use of this destination")));
    assert.equal(existsSync(join(projectDir, ".akc-fake-record.json")), false);
    await vault.deleteSecret(requiredRef);

    // --- status is readable without ever changing trust -------------------
    await recordDestinationTrust(vault, identity);
    const status = await inspectDestinationTrust({
      vault,
      adapter,
      projectDir,
      env: "preview",
      pathOverride: fixture.pathOverride
    });
    assert.equal(status, "trusted");
    assert.equal(vault.records.size, 2);
    // Clean up so the record set does not leak into later assertions.
    await runForgetDestinationTrust(
      lifecycleDeps(createTestRemovalPlane("approved")),
      forgetRequest
    );
    assert.equal(vault.records.size, 0);
  });

  // --- the same lifecycle against the real OS secret store ----------------
  // Everything above runs on MemoryVault. This gated leg proves the approved
  // path really deletes from the platform store, and — more importantly — that
  // a refusal really leaves the credential in place there.
  await testPhaseELifecycleRealStore(root, homeDir);

  // --- the surfaces that must not grow a deletion path --------------------
  const mcpTools = buildTools({
    defaultProjectDir: projectDir,
    createVault: () => vault,
    adapters: ADAPTERS
  });
  for (const tool of Object.keys(mcpTools)) {
    assert.doesNotMatch(tool, /remove|delete|forget|trust/, `MCP must not expose ${tool}`);
  }
  for (const file of readSources(MCP_SOURCE_FILES)) {
    for (const forbidden of ["lifecycle.js", "runRemoveSecret", "runForgetDestinationTrust"]) {
      assert.equal(
        file.text.includes(forbidden),
        false,
        `${file.path} must not reach the lifecycle module`
      );
    }
  }

  const lifecycleSource = readSources(["../packages/core/lifecycle.ts"])[0].text;
  // Deletion happens only after an approved Human Plane decision, in both flows.
  assert.match(
    lifecycleSource,
    /if \(decision === "declined"\) return \{ kind: "declined" \};[\s\S]*?if \(!\(await removeSecret/,
    "Secret deletion must stay behind an approved Human Plane decision"
  );
  assert.match(
    lifecycleSource,
    /if \(decision === "declined"\) return \{ kind: "declined" \};[\s\S]*?kind: "forgotten",\s*removal: await forgetDestinationTrust/
  );
  for (const forbidden of ["process.stdin", "promptSecretValue", "confirm(", "--yes"]) {
    assert.equal(
      lifecycleSource.includes(forbidden),
      false,
      `lifecycle.ts must not reach for ${forbidden}`
    );
  }

  const cliSource = readSources(["../packages/cli/index.ts"])[0].text;
  assert.equal(cliSource.includes('arg === "--yes"'), false, "remove --yes must not come back");
  assert.match(cliSource, /runRemoveSecret\(\s*\{ vault, humanPlane: createHumanPlane\(\)/);
  assert.match(cliSource, /runForgetDestinationTrust\(\s*\{ vault, humanPlane: createHumanPlane\(\)/);
  assert.match(
    cliSource,
    /case "vault-read-failed":\s*console\.error\("NG: the OS secret store could not be read; nothing was deleted\."\);\s*terminate\(1\);/
  );
  assert.match(
    cliSource,
    /case "vault-delete-failed":\s*console\.error\("NG: the OS secret store did not confirm deletion; no success was reported\."\);\s*terminate\(1\);/
  );
  assert.match(
    cliSource,
    /case "vault-read-failed":\s*console\.error\("NG: the OS secret store could not be read; no trust state was changed\."\);\s*terminate\(1\);/
  );
  assert.match(
    cliSource,
    /case "vault-delete-failed":\s*console\.error\("NG: destination trust deletion was not confirmed; no success was reported\."\);\s*terminate\(1\);/
  );

  // The destination trust delete surface stays as confined as the write one.
  const deleters = new Set([
    "../packages/core/vault/types.ts",
    "../packages/core/vault/keyring.ts",
    "../packages/core/vault/memory.ts",
    "../packages/core/deploy/destination.ts"
  ]);
  const forgetters = new Set([
    "../packages/core/deploy/destination.ts",
    "../packages/core/lifecycle.ts"
  ]);
  const sources = readSources([...VAULT_SOURCE_FILES, ...DEPLOY_SOURCE_FILES, ...MCP_SOURCE_FILES]);
  assert.deepEqual(
    sources
      .filter((file) => file.text.includes("deleteDestinationTrust") && !deleters.has(file.path))
      .map((file) => file.path),
    []
  );
  assert.deepEqual(
    sources
      .filter((file) => file.text.includes("forgetDestinationTrust") && !forgetters.has(file.path))
      .map((file) => file.path),
    []
  );
}

async function testPhaseELifecycleRealStore(root, homeDir) {
  const vault = await openRealVaultForE2E("phase E lifecycle");
  if (!vault) return;

  const projectDir = join(root, "real-store-project");
  mkdirSync(projectDir, { recursive: true });
  const ref = {
    name: "AKC_E2E_LIFECYCLE_KEY",
    scope: "project",
    projectId: deriveProjectId(projectDir)
  };
  const deps = (humanPlane) => ({ vault, humanPlane, print: () => {}, registryBaseDir: homeDir });
  const request = { name: ref.name, scope: "project", projectDir };

  try {
    await vault.setSecret(ref, "e2e-lifecycle-value");
    assert.equal(await vault.hasSecret(ref), true);

    // A refusal must leave the real credential in the real store.
    assert.equal(
      (await runRemoveSecret(deps(createTestRemovalPlane("declined")), request)).kind,
      "declined"
    );
    assert.equal(await vault.hasSecret(ref), true, "a declined removal must not delete");

    assert.equal(
      (await runRemoveSecret(deps(createTestRemovalPlane("no-dialog")), request)).kind,
      "human-plane-unavailable"
    );
    assert.equal(await vault.hasSecret(ref), true, "no Human Plane must not delete");

    assert.equal(
      (await runRemoveSecret(deps(createTestRemovalPlane("approved")), request)).kind,
      "removed"
    );
    assert.equal(await vault.hasSecret(ref), false);
  } finally {
    await vault.deleteSecret(ref);
  }

  // Destination trust records live in the same store and must delete there too.
  const trustRef = {
    kind: "destination",
    fingerprint: createHash("sha256").update("akc-e2e-lifecycle-destination").digest("hex")
  };
  try {
    await vault.saveDestinationTrust(trustRef);
    assert.equal(await vault.hasDestinationTrust(trustRef), true);
    assert.equal(await vault.deleteDestinationTrust(trustRef), true);
    assert.equal(await vault.hasDestinationTrust(trustRef), false);
    assert.equal(await vault.deleteDestinationTrust(trustRef), false);
  } finally {
    await vault.deleteDestinationTrust(trustRef);
  }
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

// The Phase E trust surface as an Agent would actually reach it. Exit code 3
// means this host has no OS secret store, which is a valid outcome everywhere
// below: the point is that no invocation shape can change trust state.
function testTrustCliSmoke(root) {
  mkdirSync(root, { recursive: true });
  const run = (args) =>
    spawnSync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      cwd: root,
      env: isolatedHomeEnv(join(root, "home"))
    });

  const noSubcommand = run(["trust"]);
  assert.equal(noSubcommand.status, 1);
  assert.match(noSubcommand.stderr, /Usage: api-key-case trust/);

  for (const args of [
    ["trust", "forget"],
    ["trust", "forget", "--target", "vercel"],
    ["trust", "forget", "--env", "preview"],
    ["trust", "forget", "--target", "vercel", "--env", "preview", "--yes"]
  ]) {
    assert.equal(run(args).status, 1, `${args.join(" ")} must not succeed`);
  }

  const status = run(["trust", "status", root, "--json"]);
  assert.ok(status.status === 0 || status.status === 3, status.stderr);
  if (status.status === 0) {
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.schemaVersion, 1);
    // Only automatic-safe classes can ever record a destination.
    assert.deepEqual(
      parsed.destinations.map((entry) => [entry.target, entry.env]),
      [["vercel", "preview"]]
    );
    for (const entry of parsed.destinations) {
      assert.ok(
        ["trusted", "changed", "unconfirmed", "unresolved"].includes(entry.trust),
        `trust status exposed a non-enum state: ${entry.trust}`
      );
    }
    assert.doesNotMatch(status.stdout, /[0-9a-f]{64}/, "no fingerprint may reach stdout");
  }
  assertNoCanary("trust status stdout", status.stdout);
  assertNoCanary("trust status stderr", status.stderr);

  // An unconfirmed project has nothing to forget, so this cannot become an
  // Agent-driven way to probe or change security state.
  const forget = run(["trust", "forget", "--target", "vercel", "--env", "preview", root]);
  assert.ok(forget.status === 0 || forget.status === 3, forget.stderr);
  if (forget.status === 0) {
    assert.match(forget.stdout, /no destination confirmation is recorded/);
  }
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
  const projectId = deriveProjectId(root);
  const ref = { name, scope: "project", projectId };
  // Trusted execution passes the child a sanitized environment, so the fake
  // CLI writes its record next to its own cwd (the bound project directory)
  // rather than to an AKC_FAKE_RECORD path the child never receives.
  const recordPath = join(root, ".akc-fake-record.json");
  const vercelEnvNames = ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"];
  write(
    root,
    ".vercel/project.json",
    JSON.stringify({ orgId: "team_e2e_deploy", projectId: "prj_e2e_deploy" })
  );
  // A destination the human already confirmed: Vercel preview is the one
  // automatic-safe class, so these steps exercise the value path without a
  // Human Plane while still going through the bound trusted execution.
  const trustedVault = withDestinationTrust(vault, { trusted: true });
  const automaticAdapter = createFakeAdapter(fixture, { id: "vercel" });
  const echoAdapter = createFakeAdapter(fixture, {
    id: "vercel",
    argv: (n, e) => [fixture.cliCommand, "set", n, e, "--akc-echo"]
  });

  await vault.setSecret(ref, canaryOpenAi);
  try {
    await withoutEnv(vercelEnvNames, async () => {
      // 1) value path: canary flows vault -> fake CLI stdin, and never
      // appears in argv, printed lines, or the HandoffResult.
      rmSync(recordPath, { force: true });
      const printed = [];
      const result = await runDeploy(
        {
          vault: trustedVault,
          adapter: automaticAdapter,
          print: (line) => printed.push(line),
          pathOverride: fixture.pathOverride
        },
        { name, scope: "project", projectId, projectDir: root, env: "preview", dryRun: false, force: false }
      );

      assert.equal(result.kind, "executed");
      assert.equal(result.handoff.exitCode, 0);
      assert.equal(result.historySaved, true);
      const history = new DeploymentHistory(root, testRoot);
      assert.equal(history.read().entries.at(-1).outcome, "completed");
      assertNoCanary("persisted deploy history", JSON.stringify(history.read()));
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      assert.equal(record.stdin, canaryOpenAi);
      assert.equal(record.argv.join(" ").includes(canaryOpenAi), false);
      assertNoCanary("handoff stdout", result.handoff.stdoutRedacted);
      assertNoCanary("handoff stderr", result.handoff.stderrRedacted);
      assertNoCanary("engine printed lines", printed.join("\n"));
      assert.ok(printed.some((line) => line.includes("confirmed by a human before")));

      // 2) scrub: the fake CLI echoes stdin back; the echoed canary must be
      // redacted, never shown raw.
      rmSync(recordPath, { force: true });
      const scrubResult = await runDeploy(
        {
          vault: trustedVault,
          adapter: echoAdapter,
          print: () => {},
          pathOverride: fixture.pathOverride
        },
        { name, scope: "project", projectId, projectDir: root, env: "preview", dryRun: false, force: false }
      );
      assert.equal(scrubResult.kind, "executed");
      assert.ok(scrubResult.handoff.stdoutRedacted.includes("***REDACTED***"));
      assertNoCanary("scrubbed echo stdout", scrubResult.handoff.stdoutRedacted);
      assertNoCanary("history after echoed provider output", JSON.stringify(history.read()));

      // Result persistence failure must preserve the successful operation and
      // its pending receipt; it must not rerun the provider or report failure.
      const finish = DeploymentHistory.prototype.finish;
      const resultLock = join(testRoot, ".api-key-case", "deployment-history",
        createHash("sha256").update(realpathSync.native(root)).digest("hex"), "lock");
      DeploymentHistory.prototype.finish = function (id, outcome) {
        mkdirSync(resultLock);
        try { return finish.call(this, id, outcome); }
        finally { rmSync(resultLock, { recursive: true }); }
      };
      const historyWarnings = [];
      try {
        const unwritten = await runDeploy({ vault: trustedVault, adapter: automaticAdapter,
          print: (line) => historyWarnings.push(line), pathOverride: fixture.pathOverride },
          { name, scope: "project", projectId, projectDir: root, env: "preview", dryRun: false, force: false });
        assert.equal(unwritten.kind, "executed");
        assert.equal(unwritten.handoff.exitCode, 0);
        assert.equal(unwritten.historySaved, false);
        assert.deepEqual(unwritten.historyDiagnostic, { phase: "result", issue: "lock-present", recovery: "wait-and-inspect" });
        assert.equal(history.read().entries.at(-1).outcome, "unknown");
        assert.ok(historyWarnings.some((line) => line.includes("do not retry automatically")));
        assert.ok(historyWarnings.some((line) => line.includes("Keep the observed operation result separate")));
        assert.equal(historyWarnings.some((line) => line.includes("no provider write was attempted")), false);

        const mcp = buildTools({ defaultProjectDir: root, createVault: () => trustedVault,
          adapters: new Map([["vercel", automaticAdapter]]), pathOverride: fixture.pathOverride,
          historyBaseDir: testRoot, licenseOptions: testProLicenseOptions(join(root, "history-mcp-license")) });
        const response = await mcp.deploy_secret({ name, target: "vercel", env: "preview" });
        assert.equal(response.structuredContent.status, "executed");
        assert.equal(response.structuredContent.historySaved, false);
        assert.deepEqual(response.structuredContent.historyDiagnostic, unwritten.historyDiagnostic);
        assert.match(response.content[0].text, /do not retry automatically/);
      } finally { DeploymentHistory.prototype.finish = finish; }

      // 3) short secret (<8 chars): withhold the whole output rather than
      // risk an unsafe partial redaction.
      const shortRef = { name: "AKC_E2E_SHORT_KEY", scope: "project", projectId };
      await vault.setSecret(shortRef, "short1");
      try {
        rmSync(recordPath, { force: true });
        const shortResult = await runDeploy(
          {
            vault: trustedVault,
            adapter: echoAdapter,
            print: () => {},
            pathOverride: fixture.pathOverride
          },
          { name: shortRef.name, scope: "project", projectId, projectDir: root, env: "preview", dryRun: false, force: false }
        );
        assert.equal(shortResult.kind, "executed");
        assert.equal(shortResult.handoff.stdoutRedacted, "(output withheld)");
      } finally {
        await vault.deleteSecret(shortRef);
      }

      // 3b) Phase D lifecycle against the real value path: a first-use
      // destination needs one Human Plane approval, that approval records the
      // destination identity, and the next identical deploy runs with no
      // Human Plane at all.
      rmSync(recordPath, { force: true });
      const lifecycleVault = withDestinationTrust(vault);
      let approvals = 0;
      const askOnce = () => createTestHumanPlane("approved", () => {
        approvals += 1;
      });
      const firstRun = await runDeploy(
        {
          vault: lifecycleVault,
          adapter: automaticAdapter,
          print: () => {},
          humanPlane: askOnce(),
          pathOverride: fixture.pathOverride
        },
        { name, scope: "project", projectId, projectDir: root, env: "preview", dryRun: false, force: false }
      );
      assert.equal(firstRun.kind, "executed");
      assert.equal(approvals, 1);
      assert.equal(lifecycleVault.records.size, 2, "one approval records the identity and its slot");
      assert.equal([...lifecycleVault.records].join("\n").includes(canaryOpenAi), false);

      rmSync(recordPath, { force: true });
      const secondRun = await runDeploy(
        {
          vault: lifecycleVault,
          adapter: automaticAdapter,
          print: () => {},
          humanPlane: askOnce(),
          pathOverride: fixture.pathOverride
        },
        { name, scope: "project", projectId, projectDir: root, env: "preview", dryRun: false, force: false }
      );
      assert.equal(secondRun.kind, "executed");
      assert.equal(approvals, 1, "a confirmed destination must not ask a human again");
      assert.equal(
        JSON.parse(readFileSync(recordPath, "utf8")).stdin,
        canaryOpenAi,
        "the automatic run still delivers the value through the bound trusted execution"
      );
    });

    // 4) --force preStep ordering: preStep (no stdin) must complete before
    // the main step (which carries the value) runs. Both write to the same
    // record file, so the main step's write is the one still on disk after
    // a successful run; if the preStep had blocked it, the record would
    // still hold the preStep's empty stdin instead. --force is high-risk in
    // every environment, so this leg still goes through the Human Plane and
    // must not create any destination trust record.
    rmSync(recordPath, { force: true });
    write(
      root,
      "wrangler.toml",
      "name = 'e2e-force-worker'\naccount_id = '0123456789abcdef0123456789abcdef'\n"
    );
    await withoutEnv(
      ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CLOUDFLARE_ACCOUNT_ID"],
      async () => {
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
        const forceVault = withDestinationTrust(vault);

        const forceResult = await runDeploy(
          {
            vault: forceVault,
            adapter: forceAdapter,
            print: () => {},
            humanPlane: createTestHumanPlane("approved"),
            pathOverride: fixture.pathOverride
          },
          { name, scope: "project", projectId, projectDir: root, env: "development", dryRun: false, force: true }
        );
        assert.equal(forceResult.kind, "executed");
        const forceRecord = JSON.parse(readFileSync(recordPath, "utf8"));
        assert.equal(forceRecord.stdin, canaryOpenAi, "main step should run and receive the value after the preStep succeeds");
        assert.equal(
          forceVault.records.size,
          0,
          "a --force approval must not create a reusable destination trust record"
        );

        const failingMain = createFakeAdapter(fixture, {
          argv: (n) => [fixture.cliCommand, "main", n, "--akc-fail"],
          preSteps: (n) => [{ argv: [fixture.cliCommand, "pre", n], valueVia: "stdin", displayCommand: "fake pre", overwriteWarning: false }]
        });
        const partial = await runDeploy({ vault: forceVault, adapter: failingMain, print: () => {},
          humanPlane: createTestHumanPlane("approved"), pathOverride: fixture.pathOverride },
          { name, scope: "project", projectId, projectDir: root, env: "development", dryRun: false, force: true });
        assert.equal(partial.kind, "executed");
        assert.equal(partial.handoff.exitCode, 23);
        const partialReceipt = new DeploymentHistory(root, testRoot).read().entries.at(-1);
        assert.equal(partialReceipt.outcome, "incomplete");
        assert.equal(partialReceipt.force, true);
        assertNoCanary("partial force history", JSON.stringify(partialReceipt));
        const protocol = renderAgentProtocol("0.9.1");
        assert.match(protocol, /a force operation is incomplete or unknown, its removal step may have succeeded while the add failed/);
        assert.match(protocol, /never repeat the same force operation automatically/);
      }
    );
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
      assert.match(prodResult.content[0].text, /Agent-independent Human Plane/);
      assert.equal(existsSync(recordPath), false, "production deploy must never spawn the target CLI");

      const githubResult = await tools.deploy_secret({
        name: "MCP_TEST_KEY",
        target: "github",
        env: "development"
      });
      assert.equal(githubResult.structuredContent?.action, "action_required");
      assert.match(githubResult.content[0].text, /Agent-independent Human Plane/);
      assert.doesNotMatch(githubResult.content[0].text, /production deploys require/, "GitHub development handoff must not mislabel the requested environment");
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
    assert.equal(
      missingResult.content[0].text,
      "NG: MCP_TEST_MISSING is not registered (project scope). Ask the human to run: npx api-key-case save MCP_TEST_MISSING"
    );

    const missingUserResult = await tools.deploy_secret({
      name: "MCP_TEST_USER_MISSING",
      target: "cloudflare",
      env: "development",
      scope: "user"
    });
    assert.equal(missingUserResult.structuredContent?.status, "missing-secret");
    assert.equal(missingUserResult.isError, undefined);
    assert.equal(
      missingUserResult.content[0].text,
      "NG: MCP_TEST_USER_MISSING is not registered (user scope). Ask the human to run: npx api-key-case save MCP_TEST_USER_MISSING --scope user"
    );
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
    assert.match(result.content[0].text, /--ask/);
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

    const deploySecretTool = list.result.tools.find((t) => t.name === "deploy_secret");
    const deployProps = Object.keys(deploySecretTool.inputSchema.properties ?? {}).sort();
    assert.deepEqual(deployProps, ["dryRun", "env", "name", "path", "scope", "target"]);
    for (const forbidden of ["approval", "approvalToken", "confirm", "token", "yes"]) {
      assert.equal(
        deployProps.includes(forbidden),
        false,
        `deploy_secret must not have a "${forbidden}" approval property`
      );
    }

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
      assert.equal(init.redirect, "error", "purchase keys must not follow exchange redirects");
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
    // The relayed link must land on the purchase section (price, host
    // conditions, Terms and refund policy beside the button), never on the
    // bare checkout form (2026-09-11 legal review).
    assert.equal(PURCHASE_URL, "https://apikeycase.melavern.com/#purchase");
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
