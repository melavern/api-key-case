import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { issueLicenseKey } from "../tools/issue-license.mjs";
import { readConnectionInventory } from "../dist/core/agent/connection-inventory.js";
import { CREDENTIAL_SERVICES, credentialEnvironments } from "../dist/core/agent/connection-credential.js";
import { DeploymentHistory, buildHistoryReport } from "../dist/core/deploy/history.js";
import {
  forgetDestinationTrust, hasDestinationTrustRecords, readDestinationTrust, recordDestinationTrust
} from "../dist/core/deploy/destination.js";
import { buildTools, registerAllTools } from "../dist/mcp/tools.js";
import { MemoryVault } from "../dist/core/vault/memory.js";
import { deriveProjectId, toAccount, toDestinationAccount } from "../dist/core/vault/naming.js";
import { parseLicenseKey } from "../dist/core/license.js";
import {
  WindowsHumanPlane, WINDOWS_POWERSHELL_PATH, buildWindowsSecretInputScript
} from "../dist/core/human/windows.js";
import { decodeWindowsHelperScript, runWindowsHelperCommandTests } from "./windows-helper-command.mjs";
import { runMacOSHumanPlaneScriptTests } from "./macos-human-plane-script.mjs";
import { runDeploymentHistoryTests } from "./deployment-history.mjs";
import fixture from "./fixtures/compat-contract-baseline.json" with { type: "json" };

const canary = "synthetic-compat-value-only";

test("baseline captures the accepted source and task execution limits", () => {
  assert.match(fixture.baseline.commit, /^[0-9a-f]{40}$/);
  assert.equal(fixture.baseline.documents.length, 11);
  for (const document of fixture.baseline.documents) {
    assert.match(document.sha256, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(fixture.baseline.unavailableCurrentState, ["tasks/in-progress.md"]);
  assert.equal(fixture.baseline.executionConditions.realOsSecretStore, "not used");
  assert.equal(fixture.baseline.executionConditions.providerOperations, "not used");
  assert.equal(fixture.baseline.executionConditions.nativeDialogs, "not used");
  assert.equal(fixture.verification.command, "npm run test:compat-contract");
  assert.equal(fixture.verification.nodeTestRunner.failed, 0);
  assert.equal(fixture.verification.exitCode, 0);
});

test("v1 user/project locators remain separate and MCP status omits the value", async () => {
  const legacy = fixture.legacyV1;
  const fixedUser = { name: legacy.name, scope: "user", projectId: null };
  const fixedProject = { name: legacy.name, scope: "project", projectId: legacy.projectId };
  assert.equal(toAccount(fixedUser), legacy.userAccount);
  assert.equal(toAccount(fixedProject), legacy.projectAccount);
  assert.notEqual(toAccount(fixedUser), toAccount(fixedProject));

  const root = mkdtempSync(join(tmpdir(), "akc-compat-v1-"));
  try {
    const project = join(root, "project");
    mkdirSync(project);
    const vault = new MemoryVault();
    const projectRef = { name: legacy.name, scope: "project", projectId: deriveProjectId(project) };
    await vault.setSecret(fixedUser, canary);
    await vault.setSecret(projectRef, canary);
    const tools = buildTools({ defaultProjectDir: project, createVault: () => vault, adapters: new Map() });
    for (const scope of ["user", "project"]) {
      const result = await tools.check_secret({ name: legacy.name, scope });
      assert.equal(result.structuredContent.status, "registered");
      assert.equal(result.structuredContent.scope, scope);
      assert.equal(JSON.stringify(result).includes(canary), false);
    }
    const saved = await tools.save_secret({ name: legacy.name, scope: "user" });
    assert.equal(saved.structuredContent.action, "action_required");
    assert.equal(JSON.stringify(saved).includes(canary), false);

    const registrations = [];
    registerAllTools({ registerTool: (...args) => registrations.push(args) }, {
      defaultProjectDir: project, createVault: () => vault, adapters: new Map()
    });
    assert.deepEqual(registrations.map(([name]) => name), fixture.agentSurfaces.mcpTools);
    for (const [name, definition] of registrations) {
      const fields = Object.keys(definition.inputSchema ?? {});
      assert.ok(!fields.some((field) => /^(value|secret|password|rawValue)$/iu.test(field)), name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v2 inventory still consists of the exact eleven closed project slots", async () => {
  assert.equal(fixture.v2.slots.length, 11);
  assert.deepEqual(CREDENTIAL_SERVICES.flatMap((service) =>
    credentialEnvironments(service).map((environment) => {
      const ref = { name: fixture.v2.slots.find((slot) => slot.service === service && slot.environment === environment)?.name,
        scope: "project", projectId: fixture.v2.projectId, service, environment };
      return { service, environment, name: ref.name, account: toAccount(ref) };
    })), fixture.v2.slots);

  const root = mkdtempSync(join(tmpdir(), "akc-compat-v2-"));
  try {
    const project = join(root, "project"), home = join(root, "home");
    mkdirSync(project); mkdirSync(home);
    const reads = [];
    const report = await readConnectionInventory(project, {
      vault: { hasSecret: async (ref) => { reads.push(toAccount(ref)); return false; } },
      baseDir: home
    });
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.slots.length, 11);
    assert.equal(reads.length, 11);
    assert.deepEqual(report.slots.map(({ service, environment, credential }) => [service, environment, credential]),
      fixture.v2.slots.map(({ service, environment, name }) => [service, environment, name]));
    assert.equal(report.inspection, "local-only");
    assert.equal(report.permission, "none");
    assert.equal(report.executed, false);
    assert.equal(JSON.stringify(report).includes(canary), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the v1 CLI check/list path uses an isolated keyring mock and returns status only", () => {
  const root = mkdtempSync(join(tmpdir(), "akc-compat-cli-"));
  try {
    const checkout = join(root, "consumer"), modules = join(checkout, "node_modules");
    const home = join(root, "home"), project = join(root, "project");
    mkdirSync(modules, { recursive: true }); mkdirSync(home); mkdirSync(project);
    writeFileSync(join(checkout, "package.json"), '{"type":"module"}');
    cpSync(fileURLToPath(new URL("../dist", import.meta.url)), join(checkout, "dist"), { recursive: true });

    const sourceModules = realpathSync(fileURLToPath(new URL("../node_modules", import.meta.url)));
    for (const name of readdirSync(sourceModules)) {
      if (name === "@napi-rs" || name.startsWith(".")) continue;
      symlinkSync(join(sourceModules, name), join(modules, name), process.platform === "win32" ? "junction" : "dir");
    }
    const scope = join(modules, "@napi-rs"), mock = join(scope, "keyring");
    mkdirSync(mock, { recursive: true });

    const name = fixture.legacyV1.name;
    const projectId = deriveProjectId(project);
    const userAccount = toAccount({ name, scope: "user", projectId: null });
    const projectAccount = toAccount({ name, scope: "project", projectId });
    assert.notEqual(userAccount, projectAccount);
    writeFileSync(join(mock, "package.json"), '{"name":"@napi-rs/keyring","main":"index.cjs"}');
    writeFileSync(join(mock, "index.cjs"), `
const present = new Set([${JSON.stringify(`api-key-case\0${userAccount}`)}]);
exports.Entry = class Entry {
  constructor(service, account) { this.service = service; this.account = account; }
  getPassword() {
    globalThis.compatEffects.reads++;
    return present.has(this.service + "\\0" + this.account) ? ${JSON.stringify(canary)} : null;
  }
  setPassword(value) {
    globalThis.compatEffects.writes++;
    if (this.service === "api-key-case" && this.account === "v1|probe" && value === "probe") {
      present.add(this.service + "\\0" + this.account); return true;
    }
    throw new Error("mock rejects persistent writes");
  }
  deleteCredential() {
    globalThis.compatEffects.deletes++;
    if (this.service === "api-key-case" && this.account === "v1|probe") return present.delete(this.service + "\\0" + this.account);
    return false;
  }
};`);

    const appDir = join(home, ".api-key-case");
    mkdirSync(appDir);
    writeFileSync(join(appDir, "index.json"), JSON.stringify({ version: 1, entries: [
      { name, scope: "user", projectId: null, updatedAt: "2026-10-19T00:00:00.000Z" },
      { name, scope: "project", projectId, updatedAt: "2026-10-19T00:00:00.000Z" }
    ] }));

    const effectsFile = join(root, "effects.json"), guard = join(root, "guard.cjs");
    writeFileSync(guard, `
const fs = require("node:fs"), cp = require("node:child_process"), net = require("node:net"), tls = require("node:tls"), http = require("node:http"), https = require("node:https");
const save = fs.writeFileSync.bind(fs);
globalThis.compatEffects = { reads: 0, writes: 0, deletes: 0, children: 0, network: 0 };
const deny = kind => () => { globalThis.compatEffects[kind]++; throw new Error("synthetic compatibility side effect denied"); };
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[key] = deny("children");
for (const key of ["connect", "createConnection"]) net[key] = deny("network");
net.Socket.prototype.connect = deny("network"); tls.connect = deny("network");
http.get = http.request = https.get = https.request = globalThis.fetch = deny("network");
require("node:module").syncBuiltinESMExports();
process.on("exit", () => save(${JSON.stringify(effectsFile)}, JSON.stringify(globalThis.compatEffects)));
`);

    const cli = join(checkout, "dist", "cli", "index.js");
    const env = {
      HOME: home, USERPROFILE: home, DO_NOT_TRACK: "1", PATH: "", TMPDIR: root, TEMP: root, TMP: root,
      ...(process.platform === "win32" ? { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" } : {})
    };
    const before = readFileSync(join(appDir, "index.json"), "utf8");
    const run = (args) => {
      const result = spawnSync(process.execPath, ["--require", guard, cli, ...args], {
        cwd: project, env, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal((result.stdout + result.stderr).includes(canary), false);
      const effects = JSON.parse(readFileSync(effectsFile, "utf8"));
      assert.equal(effects.writes, 1, "only the fake availability probe may write");
      assert.equal(effects.deletes, 1, "only the fake availability probe may delete");
      assert.equal(effects.children, 0);
      assert.equal(effects.network, 0);
      return JSON.parse(result.stdout);
    };

    assert.equal(run(["check", name, "--scope", "user", "--json"]).status, "registered");
    assert.equal(run(["check", name, "--scope", "project", "--json"]).status, "missing");
    assert.equal(run(["list", "--scope", "user", "--json"]).entries[0].storeStatus, "registered");
    assert.equal(run(["list", "--scope", "project", "--json"]).entries[0].storeStatus, "stale");
    assert.equal(readFileSync(join(appDir, "index.json"), "utf8"), before);
    assert.deepEqual(readdirSync(project), []);
    assert.deepEqual(readdirSync(appDir), ["index.json"], "CLI status checks do not mutate legacy metadata");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history remains advisory and value-free across the documented schemas", async () => {
  assert.deepEqual(fixture.deploymentHistory.readableSchemas, [1, 2, 3, 4]);
  assert.deepEqual(fixture.deploymentHistory.outcomes, ["completed", "incomplete", "unknown"]);
  assert.equal(fixture.deploymentHistory.authority, "advisory-local-history");
  await runDeploymentHistoryTests();

  const root = mkdtempSync(join(tmpdir(), "akc-compat-history-"));
  try {
    const project = join(root, "project"); mkdirSync(project);
    const history = new DeploymentHistory(project, root);
    const id = history.begin({ name: "COMPAT_FIXTURE_KEY", scope: "project", target: "vercel", env: "preview",
      destinationId: fixture.destinationTrust.fingerprint, force: false, value: canary, rawOutput: canary });
    assert.ok(id);
    assert.equal(history.read().entries[0].outcome, "unknown");
    const report = await buildHistoryReport(project, { baseDir: root, offline: true, adapters: new Map() });
    assert.equal(report.authority, "advisory-local-history");
    assert.equal(report.currentRemoteState, "not-inspected");
    assert.equal(JSON.stringify(report).includes(canary), false);
    const journalDir = join(root, ".api-key-case", "deployment-history", createHash("sha256").update(realpathSync.native(project)).digest("hex"));
    assert.equal(readFileSync(join(journalDir, "history.json"), "utf8").includes(canary), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("destination trust records preserve their status-only meanings in memory", async () => {
  const trust = fixture.destinationTrust;
  assert.deepEqual(trust.states, ["trusted", "changed", "unconfirmed"]);
  assert.deepEqual(trust.recordKinds, ["destination", "destination-slot"]);
  const vault = new MemoryVault();
  const identity = { target: "vercel", env: "preview", projectDir: "/synthetic/project",
    fingerprint: trust.fingerprint, slot: trust.slot };
  assert.equal(toDestinationAccount({ kind: "destination", fingerprint: trust.fingerprint }), `v1|destination|${trust.fingerprint}`);
  await recordDestinationTrust(vault, identity);
  assert.equal(await readDestinationTrust(vault, identity), "trusted");
  assert.deepEqual(await hasDestinationTrustRecords({ vault, slot: identity.slot, identity }), { destination: true, slot: true });
  await vault.deleteDestinationTrust({ kind: "destination", fingerprint: identity.fingerprint });
  assert.equal(await readDestinationTrust(vault, identity), "changed");
  assert.deepEqual(await forgetDestinationTrust({ vault, slot: identity.slot, identity,
    expected: { destination: false, slot: true } }), { destination: "absent", slot: "removed" });
  assert.equal(await readDestinationTrust(vault, identity), "unconfirmed");
});

test("AKC1 keeps its signed v1 payload without an exchange or stored key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const payload = fixture.license.payload;
  const key = issueLicenseKey(privateKeyPem, payload.id, payload.issuedAt);
  assert.equal(key.split(".")[0], fixture.license.prefix);
  const parsedPayload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
  assert.deepEqual(parsedPayload, payload);
  assert.deepEqual(parseLicenseKey(key, publicKey), { plan: "pro", entitlementId: payload.id, issuedAt: payload.issuedAt });
  assert.equal(JSON.stringify(parseLicenseKey(key, publicKey)).includes(key), false);
});

test("Windows and macOS helper contracts use mock launchers and closed status output", async () => {
  const root = mkdtempSync(join(tmpdir(), "akc-compat-helper-"));
  try {
    const request = { name: fixture.legacyV1.name, scope: "project", projectId: "0123456789abcdef", projectDir: root };
    const source = buildWindowsSecretInputScript(request);
    assert.match(source, /\$input\.UseSystemPasswordChar = \$true/);
    assert.match(source, /CredWrite\(\[ref\]\$credential, 0\)/);
    assert.match(source, /No value was returned to the requesting process/);
    assert.match(source, /\[Environment\]::Exit\(\$script:resultCode\)/);
    assert.doesNotMatch(source, /Write-Output|Set-Content|Out-File|ConvertTo-Json/);

    let launches = 0;
    const plane = new WindowsHumanPlane(WINDOWS_POWERSHELL_PATH, async (helperRequest) => {
      launches++;
      assert.equal(helperRequest.stdio, "ignore");
      assert.equal(helperRequest.shell, false);
      assert.equal(Object.hasOwn(helperRequest, "input"), false);
      const decoded = decodeWindowsHelperScript(helperRequest.args.at(-1));
      assert.equal(decoded, source);
      assert.equal(decoded.includes(canary), false);
      return 0;
    }, () => ({ root, home: root }));
    assert.equal(await plane.askSecret(request), "saved");
    assert.equal(launches, 1);
    await runWindowsHelperCommandTests();
    await runMacOSHumanPlaneScriptTests();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
