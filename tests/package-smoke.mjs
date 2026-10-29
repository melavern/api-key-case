// Verify the actual npm artifact in a disposable consumer project. Run through
// npm so its own CLI path is available without shell wrappers or global tools.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatePackageKeyring } from "./helpers/package-keyring-fixture.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "akc-package-smoke-"));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run with npm run test:package or npm run test:keyring:linux.");
const withKeyring = process.argv.includes("--with-keyring");
if (withKeyring) {
  assert.equal(process.env.AKC_ISOLATED_KEYRING_TEST, "1", "Use the isolated Linux keyring runner.");
}
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const observations = [];
// Registry installation/audit may use the normal npm environment. Installed
// app processes below get a separate allowlist, with no inherited credentials.
const npmEnv = { ...process.env, DO_NOT_TRACK: "1" };
let env = npmEnv;
let isolatedKeyring;
const providerTrapMarker = join(root, "unexpected-provider-probe");

function run(command, args, options = {}) {
  if (isolatedKeyring) assert.equal((options.env ?? env).NODE_OPTIONS, isolatedKeyring.env.NODE_OPTIONS,
    "every ordinary smoke child must inherit the native-load guard");
  const result = spawnSync(command, args, {
    cwd: root, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    ...options
  });
  assert.equal(result.error, undefined, "smoke subprocess failed to start or timed out");
  if (isolatedKeyring) {
    assert.ok(existsSync(join(isolatedKeyring.markers, String(result.pid))), "child native-load guard must run");
  }
  return result;
}
function npm(args, options = {}) {
  const result = run(process.execPath, [npmCli, ...args], options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

let fixtureVault;
const fixtureRefs = [];
try {
  // The caller builds first; npm test is a separate gate. Skipping prepack here
  // prevents recursive/full-suite runs when testing an already verified build.
  const [packed] = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: repo }));
  assert.equal(packed.version, manifest.version);
  const docs = new Set(["package.json", "README.md", "README.ja.md", "CHANGELOG.md", "LICENSE", "LICENSES/0BSD.txt", "NOTICE", "SECURITY.md", "SUPPORT.md"]);
  const packedPaths = new Set(packed.files.map((file) => file.path));
  for (const { path } of packed.files) {
    assert.ok(docs.has(path) || /^dist\/.+\.(?:js|js\.map|d\.ts)$/.test(path), `unexpected package entry: ${path}`);
    assert.doesNotMatch(path, /(?:^|\/)(?:\.env(?:\.|$)|\.dev\.vars|license\.key|[^/]*\.pem)(?:\/|$)/);
  }
  for (const path of ["dist/cli/index.js", "dist/core/agent/readiness.js", "dist/core/agent/guided-setup.js",
    "dist/core/agent/connection-state.js", "dist/core/agent/connection-check.js", "dist/core/agent/native-observations.js", "dist/core/agent/clerk-worker-observations.js",
    "dist/core/agent/resend-doctor.js", "dist/mcp/server.js", "dist/mcp/vnext.js", "dist/core/vnext/launch.js", "dist/core/vnext/hosted-use.js"]) {
    assert.ok(packed.files.some((file) => file.path === path), `missing shipped entry: ${path}`);
  }
  for (const path of ["LICENSE", "LICENSES/0BSD.txt", "NOTICE"]) {
    assert.ok(packedPaths.has(path), `missing shipped license entry: ${path}`);
  }
  observations.push(`artifact ${packed.version}: ${packed.files.length} allowlisted files`);

  const consumer = join(root, "consumer with spaces");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "akc-smoke-consumer", private: true }));
  // No development checkout node_modules or dev dependencies are reused.
  // Optional native keyring packages still install; lifecycle scripts do not.
  npm(["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
    ...(process.argv.includes("--offline") ? ["--offline"] : []),
    join(root, packed.filename)], { cwd: consumer });
  if (!process.argv.includes("--offline")) {
    const audit = JSON.parse(npm(["audit", "--omit=dev", "--json"], { cwd: consumer }));
    assert.equal(audit.metadata.vulnerabilities.total, 0, "installed runtime dependencies must pass audit");
    observations.push("fresh consumer runtime dependency audit: 0 vulnerabilities");
  }
  const installed = join(consumer, "node_modules/api-key-case");
  assert.equal(realpathSync(installed), join(realpathSync(consumer), "node_modules/api-key-case"), "the artifact must be installed, not linked to the development checkout");
  assert.equal(existsSync(join(consumer, "node_modules/typescript")), false);
  const installedHashes = () => Object.fromEntries(packed.files.map(({ path }) =>
    [path, createHash("sha256").update(readFileSync(join(installed, path))).digest("hex")]));
  const appHashes = installedHashes();
  if (!withKeyring) {
    const home = join(root, "consumer home");
    mkdirSync(home);
    // next also probes CLIs found on PATH. Keep the ordinary test off any real
    // provider login: only Node and the shell needed by npm exec are available.
    const bin = join(root, "consumer bin");
    mkdirSync(bin);
    if (process.platform === "win32") copyFileSync(process.execPath, join(bin, "node.exe"));
    else {
      symlinkSync(process.execPath, join(bin, "node"));
      symlinkSync("/bin/sh", join(bin, "sh"));
    }
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    isolatedKeyring = isolatePackageKeyring(installed, root, {
      DO_NOT_TRACK: "1", PATH: bin, HOME: home, USERPROFILE: home, NODE_PATH: "",
      TMPDIR: root, TMP: root, TEMP: root, APPDATA: home, LOCALAPPDATA: home,
      ...(process.platform === "win32" ? { SystemRoot: systemRoot, WINDIR: systemRoot,
        ComSpec: join(systemRoot, "System32", "cmd.exe") } : {}),
      npm_config_cache: join(root, "consumer npm cache"),
      npm_config_script_shell: process.platform === "win32" ? join(systemRoot, "System32", "cmd.exe") : "/bin/sh"
    });
    env = isolatedKeyring.env;
    // npm adds this ancestor bin to npx's child PATH. The preload must reset
    // it before next can probe any CLI; a post-report assertion alone is late.
    const ancestorBin = join(root, "node_modules", ".bin");
    mkdirSync(ancestorBin, { recursive: true });
    const trapScript = join(root, "provider-trap.cjs");
    writeFileSync(trapScript, `require('node:fs').writeFileSync(${JSON.stringify(providerTrapMarker)}, 'called'); process.exit(99);`);
    for (const command of ["gh", "vercel", "wrangler", "resend"]) {
      const trap = join(ancestorBin, command + (process.platform === "win32" ? ".cmd" : ""));
      writeFileSync(trap, process.platform === "win32"
        ? `@"${process.execPath}" "${trapScript}"\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${trapScript}"\n`);
      chmodSync(trap, 0o700);
    }
    // Check both native entry points before launching any installed app code.
    const fakeNative = join(root, "must-not-load.node");
    writeFileSync(fakeNative, "not a native library");
    for (const code of [`require(${JSON.stringify(fakeNative)})`, "process.dlopen({}, 'must-not-load')"]) {
      const blocked = run(process.execPath, ["-e", code]);
      assert.equal(blocked.status, 86);
      assert.equal(blocked.stderr.trim(), "PACKAGE_SMOKE_NATIVE_LOAD_BLOCKED");
    }
    // This negative control can only import the already-replaced JS mock. It
    // must fail closed if a future subprocess accidentally loses the preload.
    const missingGuard = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(isolatedKeyring.mock)})`], {
      env: { ...env, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 10_000
    });
    assert.equal(missingGuard.error, undefined);
    assert.equal(missingGuard.status, 87);
    assert.equal(missingGuard.stderr.trim(), "PACKAGE_SMOKE_GUARD_MISSING");
    const backend = run(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { Entry } from ${JSON.stringify(pathToFileURL(join(isolatedKeyring.mock, "index.js")).href)};
      import { KeyringVault } from ${JSON.stringify(pathToFileURL(join(installed, "dist/core/vault/keyring.js")).href)};
      const vault = new KeyringVault();
      const ref = { name: 'AKC_SMOKE_FIRST', scope: 'user', projectId: null };
      assert.equal(vault.backendName, 'keyring'); // the real adapter, not MemoryVault
      for (const method of ['setPassword', 'getPassword', 'deleteCredential']) {
        assert.equal(typeof Entry.prototype[method], 'function');
        assert.throws(() => new Entry('synthetic', 'synthetic')[method](), /Package smoke mock/);
      }
      assert.equal(await vault.isAvailable(), false);
      await assert.rejects(vault.setSecret(ref, 'synthetic-value'), /Package smoke mock/);
      await assert.rejects(vault.hasSecret(ref), /Package smoke mock/);
      await assert.rejects(vault.deleteSecret(ref), /Package smoke mock/);
      Entry.prototype.getPassword = () => null;
      assert.equal(await vault.hasSecret(ref), false);
      Entry.prototype.getPassword = () => 'synthetic-value';
      assert.equal(await vault.hasSecret(ref), true);
      for (const removed of [false, true]) {
        Entry.prototype.deleteCredential = () => removed;
        assert.equal(await vault.deleteSecret(ref), removed);
      }
      Entry.prototype.setPassword = () => { throw new Error('synthetic-value'); };
      await assert.rejects(vault.setSecret(ref, 'synthetic-value'), error =>
        error.message.includes('redacted') && !error.message.includes('synthetic-value'));
    `]);
    assert.equal(backend.status, 0, backend.stderr);
    assert.deepEqual(installedHashes(), appHashes, "mock isolation must not change any packed app file");
    observations.push("OS keyring isolated: unavailable test mock; native loading blocked in inherited child processes");
    observations.push("installed KeyringVault adapter with mock Entry: unavailable/error/null/presence/deletion and redaction contracts passed");
  }
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  const registryCard = JSON.parse(readFileSync(join(repo, "server.json"), "utf8"));
  assert.equal(installedManifest.mcpName, registryCard.name, "Registry ownership name must ship in the npm artifact");
  assert.equal(registryCard.version, installedManifest.version);
  assert.equal(registryCard.packages.length, 1);
  assert.equal(registryCard.packages[0].identifier, installedManifest.name);
  assert.equal(registryCard.packages[0].version, installedManifest.version);
  assert.equal(registryCard.packages[0].transport.type, "stdio");
  assert.deepEqual(registryCard.packages[0].packageArguments, [{ type: "positional", value: "mcp" }]);
  assert.equal(installedManifest.license, "Elastic-2.0");
  assert.match(readFileSync(join(installed, "LICENSE"), "utf8"), /^Elastic License 2\.0\r?\n/);
  assert.doesNotMatch(readFileSync(join(installed, "LICENSE"), "utf8"), /^MIT License/m);
  assert.match(readFileSync(join(installed, "LICENSES/0BSD.txt"), "utf8"), /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted\./);
  assert.match(readFileSync(join(installed, "NOTICE"), "utf8"), /managed\s+instruction block/);
  const cliPath = join(installed, "dist/cli/index.js");
  const cli = (args, project, expected = 0, extra = {}) => {
    const result = run(process.execPath, [cliPath, ...args], { cwd: project, ...extra });
    assert.equal(result.status, expected, result.stderr);
    if (isolatedKeyring) assert.ok(existsSync(join(isolatedKeyring.markers, `mock-${result.pid}`)),
      "installed CLI must load the declared keyring mock");
    return result;
  };
  assert.equal(cli(["--version"], consumer).stdout.trim(), manifest.version);
  observations.push("Registry card matches the installed npm package and existing mcp command");

  // Consumer-facing executable resolution, not just importing a source module.
  assert.equal(npm(["exec", "--offline", "--", "api-key-case", "--version"], { cwd: consumer }).trim(), manifest.version);

  let project;
  for (const [host, marker] of [["agents", "AGENTS.md"], ["claude", "CLAUDE.md"], ["cursor", ".cursor/rules/api-key-case.mdc"]]) {
    project = join(consumer, `fresh ${host} project`);
    mkdirSync(project);
    writeFileSync(join(project, "app.ts"), "process.env.AKC_SMOKE_FIRST; process.env.AKC_SMOKE_SECOND;\n");
    writeFileSync(join(project, ".gitignore"), ".env\n.env.*\n");
    const first = cli(["agent-init", "."], project);
    assert.match(first.stdout, /no existing Agent host marker/);
    cli(["agent-init", ".", "--host", host, "--check"], project, 2);
    assert.equal(existsSync(join(project, marker)), false);
    const initialized = cli(["agent-init", ".", "--host", host], project);
    assert.ok(initialized.stdout.includes(`api-key-case@${manifest.version}`));
    assert.match(initialized.stdout, /schemaVersion 13/);
    const [major, minor] = manifest.version.split(".").map(Number);
    if (major > 0 || minor >= 10) {
      const firstAction = initialized.stdout.split("\n").find(line => line.startsWith("- For API key,"));
      assert.ok(firstAction?.includes(`api-key-case@${manifest.version} secret capabilities --json`));
      assert.ok(firstAction?.includes(`api-key-case@${manifest.version} secret discover --project . --json`));
      assert.ok(!firstAction?.includes(" next "), "new installs must inspect generic registrations before legacy setup");
    }
    const instructionPath = join(project, marker);
    const original = readFileSync(instructionPath, "utf8");
    assert.match(original, /managed instruction block only: 0BSD/);
    assert.doesNotMatch(original, /SPDX-License-Identifier:/);
    cli(["agent-init", ".", "--host", host], project);
    assert.equal(readFileSync(instructionPath, "utf8"), original, "bootstrap must be idempotent");
    const current = JSON.parse(cli(["agent-init", ".", "--host", host, "--check"], project).stdout);
    assert.ok(current.files.every((file) => file.status === "current"));
    const drifted = original.replace("You are the user's interface.", "Synthetic edited instruction.");
    assert.notEqual(drifted, original);
    writeFileSync(instructionPath, drifted);
    cli(["agent-init", ".", "--host", host, "--check"], project, 2);
    cli(["agent-init", ".", "--host", host], project, 1);
    assert.equal(readFileSync(instructionPath, "utf8"), drifted, "an edited instruction must not be overwritten");
    writeFileSync(instructionPath, original); // only our own fixture
  }
  observations.push("fresh Agent hosts, paths with spaces, idempotence and drift refusal passed");

  const history = JSON.parse(cli(["history", "--json", "."], project).stdout);
  assert.equal(history.schemaVersion, 2);
  assert.equal(history.status, "missing");
  assert.equal(history.diagnostic.issue, "not-created");
  assert.equal(history.writeAccess, "not-tested");
  assert.deepEqual(history.entries, []);
  assert.equal(history.currentRemoteState, "not-inspected");
  assert.match(readFileSync(join(project, ".cursor/rules/api-key-case.mdc"), "utf8"), /history --json/);
  observations.push("installed history command and resumption protocol passed");

  const guidedProject = join(consumer, "resend guided project");
  mkdirSync(guidedProject);
  writeFileSync(join(guidedProject, "app.ts"), "process.env.RESEND_API_KEY;\n");
  writeFileSync(join(guidedProject, ".gitignore"), ".env\n.env.*\n");
  const unselected = JSON.parse(cli(["next", "--json", "."], guidedProject).stdout);
  assert.equal(unselected.schemaVersion, 13);
  assert.equal(unselected.connection.status, "not-selected");
  assert.equal(unselected.guidedSetup, null, "acquisition requires the existing explicit selection contract");
  assert.equal(unselected.localDevelopment, null);
  assert.ok(!unselected.nextActions.some(a => a.kind === "register-connection-credential"));
  cli(["connection", "set", "--service", "resend", "--env", "development", "--route",
    "api-key-case-managed", "--destination", "cloudflare", "."], guidedProject);
  const guided = JSON.parse(cli(["next", "--json", "."], guidedProject).stdout);
  assert.equal(guided.connection.status, "selected");
  assert.equal(guided.connection.report.environment, "development");
  assert.equal(guided.guidedSetup.credential, "RESEND_API_KEY");
  assert.equal(guided.guidedSetup.acquisition.dashboardUrl, "https://resend.com/api-keys");
  assert.equal(guided.guidedSetup.connectionState, "not-tested");
  assert.equal(guided.guidedSetup.runtimeAccess, "not-configured-by-this-flow");
  const connectionHome = join(root, "connection metadata home");
  mkdirSync(connectionHome);
  const connectionEnv = { ...env, HOME: connectionHome, USERPROFILE: connectionHome };
  const setConnection = cli(["connection", "set", "--service", "resend", "--env", "production",
    "--route", "provider-native", "--destination", "vercel", "--sending-domain", "mail.example.com", "."],
  guidedProject, 0, { env: connectionEnv });
  assert.match(setConnection.stdout, /intent saved/);
  assert.equal(setConnection.stdout.includes("mail.example.com"), false);
  const selected = JSON.parse(cli(["next", "--json", "."], guidedProject, 0, { env: connectionEnv }).stdout);
  assert.equal(selected.connection.status, "selected");
  assert.equal(selected.connection.report.environment, "production");
  assert.equal(selected.connection.report.route, "provider-native");
  assert.equal(selected.connection.report.credential.status, "external-unverified");
  assert.equal(JSON.stringify(selected).includes("mail.example.com"), false);
  const unavailableCheck = JSON.parse(cli(["connection", "check", "--service", "resend", "--json", "."],
    guidedProject, 1, { env: connectionEnv }).stdout);
  assert.deepEqual(unavailableCheck, { service: "resend", status: "unknown", resultCode: "unknown", recorded: false },
    "a provider-native intent cannot read or validate an API Key Case credential");
  assert.match(cli(["--help"], guidedProject).stdout, /connection check --service resend/);
  assert.match(cli(["--help"], guidedProject).stdout, /connection deploy --service <resend\|openai\|stripe-test>/);
  for (const service of ["resend", "openai", "stripe-test"]) for (const extra of [[], ["--dry-run"]]) {
    const blockedDeploy = JSON.parse(cli(["connection", "deploy", "--service", service, "--env", "preview", "--json", ...extra, "."],
      guidedProject, 6, { env: connectionEnv }).stdout);
    assert.equal(blockedDeploy.status, "pro-required");
    assert.equal(blockedDeploy.placementEffects, "none");
  }
  cli(["connection", "deploy", "--service", "resend", "--env", "production", "--scope", "user"], guidedProject, 1, { env: connectionEnv });
  observations.push("installed closed connection deploy and dry-run Pro boundary passed");
  const plan = JSON.parse(cli(["connection", "plan", "--service", "resend", "--env", "production", "--json", "."],
    guidedProject, 0, { env: connectionEnv }).stdout);
  assert.equal(plan.status, "unknown");
  assert.equal(plan.reason, "destination-unresolved");
  assert.equal(plan.permission, "none");
  assert.equal(plan.execution, "unsupported");
  assert.equal(plan.fingerprint, null);
  assert.deepEqual(plan.recovery, [
    { reason: "destination-unresolved", actor: "product", action: "await-destination-resolver" },
    { reason: "native-configuration-unresolved", actor: "product", action: "await-native-configuration-resolver" }
  ]);
  assert.equal(plan.applicationCheck.reason, "observation-missing");
  const observation = JSON.parse(cli(["connection", "observe-application", "--service", "resend", "--env", "production",
    "--plan", "a".repeat(64), "--outcome", "passed", "--configuration", "observed", "--max-age-seconds", "60", "--json", "."],
    guidedProject, 1, { env: connectionEnv }).stdout);
  assert.deepEqual(observation, { status: "unknown", authority: "agent-observed", executed: false });
  observations.push("installed closed plan stays unresolved without a production resolver; no claimed pass or execution");
  observations.push("installed Resend guide, closed connection intent/check commands and redacted projection passed");

  const report = () => JSON.parse(cli(["next", "--json", "."], project).stdout);
  const before = report();
  assert.equal(before.schemaVersion, 13);
  assert.equal(before.setup.counts.required, 2);
  assert.equal(before.setup.deploymentState, "not-inspected");
  if (!withKeyring) {
    assert.equal(before.vault.status, "unavailable");
    assert.equal(before.setup.stage, "prepare-storage");
    assert.ok(before.targets.every(target => target.cliStatus === "missing"), "default smoke must not probe real provider CLIs");
    const mcp = cli(["mcp", project], project, 0, { input: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25",
        capabilities: {}, clientInfo: { name: "package-smoke", version: "0.0.0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_secret", arguments: { name: "AKC_SMOKE_FIRST" } } }
    ].map(message => JSON.stringify(message)).join("\n") + "\n" });
    const response = mcp.stdout.trim().split("\n").map(line => JSON.parse(line)).find(message => message.id === 2);
    assert.equal(response?.result?.isError, true);
    assert.equal(response.result.content[0].text, "NG: no OS secret store is available on this system.");
    observations.push("installed CLI/next/MCP unavailable-store responses passed against the explicit mock");
  }
  const vnextMcp = cli(["mcp", project, "--vnext"], project, 0, { input: [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "packed-vnext-smoke", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
  ].map(message => JSON.stringify(message)).join("\n") + "\n" });
  const vnextTools = vnextMcp.stdout.trim().split("\n").map(line => JSON.parse(line)).find(message => message.id === 2)?.result?.tools;
  assert.equal(vnextTools?.length, 7); assert.ok(vnextTools.every(tool => tool.annotations.readOnlyHint));
  assert.ok(vnextTools.some(tool => tool.name === "discover_credentials"));
  observations.push("installed optional vNext MCP exposes seven read-only tools without store or provider access");
  // Follow the generated exact-version command with an already installed local
  // candidate. Offline mode proves this is not the older published package.
  const npxCli = join(dirname(npmCli), "npx-cli.js");
  const previousMockPids = new Set(isolatedKeyring ? readdirSync(isolatedKeyring.markers).filter(name => name.startsWith("mock-")) : []);
  // Windows can recycle a PID from an earlier smoke child. Require a new marker
  // write for this invocation rather than a never-before-seen numeric PID.
  for (const name of previousMockPids) unlinkSync(join(isolatedKeyring.markers, name));
  const pinned = run(process.execPath, [npxCli, "--offline", "-y", `api-key-case@${manifest.version}`,
    "next", "--json", "."], { cwd: project });
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(JSON.parse(pinned.stdout).schemaVersion, 13);
  assert.equal(JSON.parse(pinned.stdout).setup.counts.required, 2);
  if (isolatedKeyring) {
    assert.equal(JSON.parse(pinned.stdout).vault.status, "unavailable");
    assert.ok(JSON.parse(pinned.stdout).targets.every(target => target.cliStatus === "missing"),
      "npx must not reintroduce provider CLIs into the app environment");
    const newMockPids = readdirSync(isolatedKeyring.markers).filter(name => name.startsWith("mock-"));
    assert.equal(newMockPids.length, 1, "npx must start one installed CLI with the declared mock");
    assert.ok(existsSync(join(isolatedKeyring.markers, newMockPids[0].slice(5))), "npx CLI grandchild must inherit the native-load guard");
    assert.equal(existsSync(providerTrapMarker), false, "npx ancestor-bin provider traps must never execute");
    observations.push("allowlisted child environment and preload PATH reset prevented npx ancestor-bin provider probes");
  }
  observations.push("exact-version npx protocol resolves the local candidate offline");
  if (process.platform === "linux") {
    assert.equal(before.host.platform, "unsupported");
    assert.equal(before.host.secretInput, "unavailable");
    assert.ok(before.targets.every((target) => target.readiness.every((entry) => entry.status === "blocked")));
    const unavailableInput = cli(["save", "AKC_SMOKE_FIRST", "--ask"], project, before.vault.status === "available" ? 1 : 3);
    if (before.vault.status === "available") assert.match(unavailableInput.stderr, /Human Plane secret input is unavailable/);
    // The real-store lane uses only its isolated bus. Removing D-Bus here would
    // permit a keyutils fallback, so it is not an unavailable-store test.
  }
  const missingPath = cli(["next", "--json", join(root, "does-not-exist")], project, 1);
  assert.match(missingPath.stderr, /Next-action inspection failed/);
  assert.equal(missingPath.stderr.includes(root), false);
  observations.push("installed CLI diagnosis, unavailable input and closed path error passed");

  if (withKeyring) {
    assert.equal(before.vault.status, "available", "this lane must not silently skip the real store");
    assert.equal(before.setup.stage, "human-handoff");
    const { createVault } = await import(pathToFileURL(join(installed, "dist/core/vault/index.js")));
    const { deriveProjectId } = await import(pathToFileURL(join(installed, "dist/core/vault/naming.js")));
    fixtureVault = createVault();
    const serviceItemCount = () => {
      // Object paths only, never GetSecret/GetSecrets or attribute values.
      const found = run("gdbus", ["call", "--session", "--dest", "org.freedesktop.secrets",
        "--object-path", "/org/freedesktop/secrets", "--method", "org.freedesktop.Secret.Service.SearchItems", "{}"]);
      assert.equal(found.status, 0, "the disposable Secret Service must answer independently of the native library");
      return (found.stdout.match(/\/org\/freedesktop\/secrets\/collection\/[^'\s]+/g) ?? []).length;
    };
    assert.equal(serviceItemCount(), 0, "the disposable service must start with no leftover test items");
    const values = ["synthetic-package-first-value", "synthetic-package-second-value"];
    for (const [index, name] of ["AKC_SMOKE_FIRST", "AKC_SMOKE_SECOND"].entries()) {
      const ref = { name, scope: "project", projectId: deriveProjectId(project) };
      fixtureRefs.push(ref);
      // Synthetic setup through the shipped vault only; no value-returning API.
      await fixtureVault.setSecret(ref, values[index]);
      assert.equal(serviceItemCount(), index + 1, "prove storage in this D-Bus service, not keyutils fallback");
      const state = report();
      assert.equal(state.setup.counts.registered, index + 1);
      assert.equal(state.setup.counts.missing, 1 - index);
      assert.equal(state.setup.deploymentState, "not-inspected");
      for (const value of values) assert.equal(JSON.stringify(state).includes(value), false);
    }
    cli(["remove", "AKC_SMOKE_FIRST"], project, 5);
    assert.equal(await fixtureVault.hasSecret(fixtureRefs[0]), true, "unsupported human approval must preserve the stored value");
    observations.push("installed native vault, partial registration/resumption and fail-closed removal passed");
  }
  assert.deepEqual(installedHashes(), appHashes, "all packed app files must remain byte-identical after smoke");
  if (isolatedKeyring) assert.equal(existsSync(providerTrapMarker), false);
  observations.push(`${packed.files.length} installed app files unchanged (SHA-256) throughout the smoke`);
  console.log(JSON.stringify({ packageSmoke: "passed", version: manifest.version,
    keyringCoverage: withKeyring ? "isolated-real-store" : "mock-unavailable; native-store-not-tested",
    observations, artifactIntegrity: packed.integrity, installedFileHashes: appHashes }, null, 2));
} finally {
  for (const ref of fixtureRefs) await fixtureVault.deleteSecret(ref);
  rmSync(root, { recursive: true, force: true });
}
