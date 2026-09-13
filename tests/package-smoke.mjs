// Verify the actual npm artifact in a disposable consumer project. Run through
// npm so its own CLI path is available without shell wrappers or global tools.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const env = { ...process.env, DO_NOT_TRACK: "1" };
// Avoid an existing user's Secret Service. The native library can still use
// Linux keyutils when D-Bus is unavailable; do not mistake that for failure.
// The opt-in lane owns a disposable bus and verifies its items independently.
if (!withKeyring && process.platform === "linux") {
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(root, "absent-bus")}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    ...options
  });
  assert.equal(result.error, undefined, "smoke subprocess failed to start or timed out");
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
  for (const path of ["dist/cli/index.js", "dist/core/agent/readiness.js", "dist/mcp/server.js"]) {
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
  const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(installedManifest.license, "Elastic-2.0");
  assert.match(readFileSync(join(installed, "LICENSE"), "utf8"), /^Elastic License 2\.0\n/);
  assert.doesNotMatch(readFileSync(join(installed, "LICENSE"), "utf8"), /^MIT License/m);
  assert.match(readFileSync(join(installed, "LICENSES/0BSD.txt"), "utf8"), /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted\./);
  assert.match(readFileSync(join(installed, "NOTICE"), "utf8"), /managed\s+instruction block/);
  const cliPath = join(installed, "dist/cli/index.js");
  const cli = (args, project, expected = 0, extra = {}) => {
    const result = run(process.execPath, [cliPath, ...args], { cwd: project, ...extra });
    assert.equal(result.status, expected, result.stderr);
    return result;
  };
  assert.equal(cli(["--version"], consumer).stdout.trim(), manifest.version);

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
    assert.match(initialized.stdout, /schemaVersion 2/);
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

  const report = () => JSON.parse(cli(["next", "--json", "."], project).stdout);
  const before = report();
  assert.equal(before.schemaVersion, 2);
  assert.equal(before.setup.counts.required, 2);
  assert.equal(before.setup.deploymentState, "not-inspected");
  // Follow the generated exact-version command with an already installed local
  // candidate. Offline mode proves this is not the older published package.
  const npxCli = join(dirname(npmCli), "npx-cli.js");
  const pinned = run(process.execPath, [npxCli, "--offline", "-y", `api-key-case@${manifest.version}`,
    "next", "--json", "."], { cwd: project });
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(JSON.parse(pinned.stdout).schemaVersion, 2);
  assert.equal(JSON.parse(pinned.stdout).setup.counts.required, 2);
  observations.push("exact-version npx protocol resolves the local candidate offline");
  if (process.platform === "linux") {
    assert.equal(before.host.platform, "unsupported");
    assert.equal(before.host.secretInput, "unavailable");
    assert.ok(before.targets.every((target) => target.readiness.every((entry) => entry.status === "blocked")));
    const unavailableInput = cli(["save", "AKC_SMOKE_FIRST", "--ask"], project, before.vault.status === "available" ? 1 : 3);
    if (before.vault.status === "available") assert.match(unavailableInput.stderr, /Human Plane secret input is unavailable/);
    const inaccessible = JSON.parse(cli(["next", "--json", "."], project, 0, {
      env: { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "absent-bus")}` }
    }).stdout);
    assert.equal(inaccessible.setup.stage, inaccessible.vault.status === "available" ? "human-handoff" : "prepare-storage");
    observations.push(`without D-Bus: vault ${inaccessible.vault.status}, stage ${inaccessible.setup.stage}`);
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
  console.log(JSON.stringify({ packageSmoke: "passed", version: manifest.version, observations }, null, 2));
} finally {
  for (const ref of fixtureRefs) await fixtureVault.deleteSecret(ref);
  rmSync(root, { recursive: true, force: true });
}
