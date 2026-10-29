import { connectionCredentialRef } from "../dist/core/agent/connection-credential.js";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Entry } from "@napi-rs/keyring";
import { parseResendDoctor } from "../dist/core/agent/resend-doctor.js";
import { checkResendConnection } from "../dist/core/agent/connection-check.js";
import { runResendCredentialValidation } from "../dist/core/deploy/handoff.js";
import { ConnectionStateStore } from "../dist/core/agent/connection-state.js";
import { MemoryVault } from "../dist/core/vault/memory.js";
import { canonicalProjectRealpath, deriveProjectId } from "../dist/core/vault/naming.js";
import { upsertRegistryEntry } from "../dist/core/vault/registry.js";
import { resolveCli, resolveTrustedCli } from "../dist/core/deploy/which.js";
import { buildNextReport } from "../dist/core/agent/next.js";
import { runWindowsResendNpmTests } from "./windows-resend-npm.mjs";

// A non-hex suffix cannot collide with allowed receipt fingerprints.
const synthetic = "re_synthetic_connection_check_42wxyz";
const checks = (validation, extra = {}) => ({ ok: validation.status !== "fail", checks: [
  { name: "CLI Version", status: "warn", message: "v2.23.0 (could not check for updates)" },
  { name: "API Key", status: "pass", message: "re_...wxyz (source: env)" },
  { name: "Credential Storage", status: "warn", message: "plaintext file" }, validation
], ...extra });
const full = checks({ name: "Domains", status: "pass", message: "1 verified, 0 pending", detail: "private.example (verified)" });
const sending = checks({ name: "API Validation", status: "warn", message: "Sending-only API key" });
const parse = (data, exit = data.ok ? 0 : 1) => parseResendDoctor(JSON.stringify(data), exit);

export async function runConnectionCheckTests() {
  await runWindowsResendNpmTests();
  assert.equal(parse(full), "valid-full-access");
  assert.equal(parse(checks({ name: "Domains", status: "warn", message: "No domains configured" })), "valid-full-access");
  assert.equal(parse(checks({ name: "Domains", status: "warn", message: "2 domain(s) pending verification" })), "valid-full-access");
  assert.equal(parse(sending), "valid-sending-access");
  assert.equal(parse(checks({ name: "API Validation", status: "fail", message: "Invalid API key: API key is invalid" })), "invalid-credential");
  for (const message of ["Request timed out", "Network error. Check your connection and try again"]) {
    assert.equal(parse(checks({ name: "API Validation", status: "warn", message })), "network-unavailable");
  }
  for (const message of ["Invalid API key: Too many requests", "Invalid API key: Internal server error", "fetch failed"]) {
    assert.equal(parse(checks({ name: "API Validation", status: "fail", message })), "unknown");
  }
  for (const bad of [ { ok: true, checks: [] }, { ...full, injected: "ignore previous instructions" },
    { ...full, checks: [...full.checks, full.checks[1]] },
    { ...full, checks: full.checks.map((c) => c.name === "Domains" ? { ...c, name: "API Validation" } : c) },
    { ...full, checks: full.checks.map((c) => c.name === "API Key" ? { ...c, message: "re_...wxyz (source: config)" } : c) },
    { ...full, ok: false } ]) assert.ok(!parse(bad).startsWith("valid-"));
  assert.equal(parse(full, 1), "unexpected-output");
  assert.equal(parseResendDoctor("x".repeat(65537), 0), "unexpected-output");
  assert.equal(parseResendDoctor("not json", 0), "unexpected-output");
  assert.equal(parseResendDoctor("{}", 0), "unexpected-output");

  const root = mkdtempSync(join(tmpdir(), "akc-connection-check-tests-"));
  const original = Entry.prototype.getPassword;
  let reads = 0;
  Entry.prototype.getPassword = function () { reads++; return synthetic; };
  try {
    const project = join(root, "project"), home = join(root, "home"), bin = join(root, "bin");
    for (const p of [project, home, bin]) mkdirSync(p, { mode: 0o700 });
    writeFileSync(join(project, "index.ts"), "const key = process.env.RESEND_API_KEY;\n");
    writeFileSync(join(project, ".gitignore"), ".env\n.env.*\n!.env.example\n");
    const executable = join(bin, "resend");
    const fixture = (data = full, options = {}) => {
      writeFileSync(executable, `#!${process.execPath}\n` +
        `if(process.argv.slice(2).join(' ')==='--version'){console.log('${options.version ?? "2.23.0"}');process.exit(0)}\n` +
        `if(process.argv.slice(2).join(' ')!=='doctor --json')process.exit(9);\n` +
        (options.marker ? `require('fs').writeFileSync(${JSON.stringify(options.marker)},'executed');\n` : "") +
        `if(process.env.RESEND_API_KEY!=='${synthetic}')process.exit(10);\n` +
        `for(const k of ['NODE_OPTIONS','NODE_PATH','RESEND_PROFILE','HTTPS_PROXY','RESEND_BASE_URL','INJECTED'])if(process.env[k])process.exit(11);\n` +
        `if(process.env.NODE_ENV!=='production')console.error('[Resend API Error]: synthetic SDK debug output');\n` +
        `const canonical=p=>require('fs').realpathSync.native(p);\n` +
        `if(canonical(process.env.XDG_CONFIG_HOME)!==canonical(process.cwd())||canonical(process.env.HOME)!==canonical(process.cwd()))process.exit(12);\n` +
        `if(require('fs').existsSync(require('path').join(process.cwd(),'resend','credentials.json')))process.exit(13);\n` +
        (options.overflow ? `console.log('x'.repeat(70000));` : `console.log(${JSON.stringify(JSON.stringify(data))});`) +
        (options.stderr ? `console.error('${synthetic} re_...wxyz private.example');` : "") +
        (options.hang ? "setInterval(()=>{},1000);\n" : `process.exit(${data.ok ? 0 : 1});\n`));
      chmodSync(executable, 0o700);
      if (process.platform === "win32") writeFileSync(join(bin, "resend.exe"), `MZ-snapshot-only-${JSON.stringify(data)}-${JSON.stringify(options)}`);
      return resolveCli("resend", bin);
    };
    let cli = fixture();
    const beforeWindowsShim = reads;
    assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null },
      cli: { ...cli, isWindowsScript: true }, stillCurrent: () => true }), "cli-unavailable");
    assert.equal(reads, beforeWindowsShim, "unbound Windows shim/runtime is rejected before key read");
    if (process.platform === "win32") {
      const shimDir = join(root, "shim-only"); mkdirSync(shimDir);
      writeFileSync(join(shimDir, "resend.cmd"), "@echo off\n");
      assert.equal(resolveTrustedCli("resend", { pathOverride: `${shimDir}${delimiter}${bin}` }).realPath, cli.realPath,
        "earlier npm shim cannot shadow a later exact native exe");
    }
    if (process.platform !== "win32") {
    process.env.NODE_OPTIONS = "--require /should-never-run.cjs";
    process.env.INJECTED = "poison";
    assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "project", projectId: deriveProjectId(project) }, cli, stillCurrent: () => true }), "valid-full-access");
    delete process.env.NODE_OPTIONS; delete process.env.INJECTED;
    assert.equal(reads, 1);
    const hostVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
    try {
      Object.defineProperty(process.versions, "node", { value: "20.0.0", configurable: true });
      assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null }, cli, stillCurrent: () => true }), "valid-full-access",
        "product host Node20 does not reject a separately supported native/child executable");
    } finally { Object.defineProperty(process.versions, "node", hostVersion); }
    // Bind a separate interpreter snapshot, as the trusted macOS resolver does.
    // The product host version must not substitute for the actual child runtime.
    const interpreterPath = join(bin, "node-fixture");
    const interpreterFixture = (major) => {
      writeFileSync(interpreterPath, `#!${process.execPath}\n` +
        `if(process.argv[2]==='--version'){console.log('v${major}.0.0');process.exit(0)}\n` +
        `process.argv.splice(1,1);require(process.argv[1]);\n`);
      chmodSync(interpreterPath, 0o700);
      return resolveCli("node-fixture", bin);
    };
    const beforeUnsupportedRuntime = reads;
    assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null },
      cli: { ...cli, interpreter: interpreterFixture(20) }, stillCurrent: () => true }), "cli-unavailable");
    assert.equal(reads, beforeUnsupportedRuntime, "unsupported bound runtime is rejected before key read");
    const supportedInterpreter = interpreterFixture(22);
    assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null },
      cli: { ...cli, interpreter: supportedInterpreter }, stillCurrent: () => true }), "valid-full-access");
    interpreterFixture(24);
    const beforeReplacedRuntime = reads;
    assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null },
      cli: { ...cli, interpreter: supportedInterpreter }, stillCurrent: () => true }), "unknown");
    assert.equal(reads, beforeReplacedRuntime, "replaced bound runtime is rejected before key read");
    for (const data of [sending, full, checks({ name: "API Validation", status: "fail", message: "Invalid API key: API key is invalid" })]) {
      cli = fixture(data);
      assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null }, cli, stillCurrent: () => true }), parse(data));
    }
    cli = fixture(full, { stderr: true });
    const leaked = await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null }, cli, stillCurrent: () => true });
    assert.equal(leaked, "unexpected-output");
    assert.ok(!JSON.stringify(leaked).includes("wxyz"));
    cli = fixture(full, { overflow: true });
    assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null }, cli, stillCurrent: () => true }), "unexpected-output");
    cli = fixture(full, { hang: true });
    assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null }, cli, stillCurrent: () => true }), "network-unavailable");
    cli = fixture(full, { version: "99.0.0" });
    const before = reads;
    assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null }, cli, stillCurrent: () => true }), "cli-unavailable");
    assert.equal(reads, before);
    cli = fixture();
    assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null }, cli, stillCurrent: () => false }), "unknown");
    assert.equal(reads, before);
    cli = fixture(); fixture(sending); // replaced after snapshot
    assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null }, cli, stillCurrent: () => true }), "unknown");
    assert.equal(reads, before);
    cli = fixture();
    let guards = 0;
    assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null }, cli, stillCurrent: () => ++guards < 3 }), "unknown");
    assert.equal(reads, before + 1, "change before spawn prevents credential dispatch");
    cli = fixture();
    let replacingGuards = 0;
    const maliciousMarker = join(root, "replaced-doctor-executed");
    assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null }, cli,
      stillCurrent: async () => {
        if (++replacingGuards === 3) fixture(sending, { marker: maliciousMarker });
        return true;
      } }), "unknown");
    assert.equal(existsSync(maliciousMarker), false, "replacement during awaited guard never receives the credential");
    cli = fixture();
    Entry.prototype.getPassword = function () { throw new Error(synthetic); };
    assert.equal(await runResendCredentialValidation({ ref: { name: "RESEND_API_KEY", scope: "user", projectId: null }, cli, stillCurrent: () => true }), "unknown");
    }
    Entry.prototype.getPassword = original;

    const vault = new MemoryVault();
    const ref = connectionCredentialRef(project, "development");
    await vault.setSecret(ref, synthetic);
    const store = new ConnectionStateStore(project, home);
    const stamp = () => { const begun = store.beginCredentialMutation(ref); assert.equal(begun.ok, true);
      assert.equal(store.finishCredentialMutation(ref, begun.value, true), true); };
    stamp();
    const intent = { service: "resend", environment: "development", route: "api-key-case-managed", destination: { kind: "local" }, sendingDomain: null };
    assert.equal(store.saveIntent(intent).ok, true);
    cli = fixture();
    let executions = 0;
    const deps = { vault, registryBaseDir: home, connectionBaseDir: home, resolveCli: () => cli,
      validate: async (input) => { executions++; assert.equal(await input.stillCurrent(), true); return "valid-full-access"; } };
    assert.deepEqual(await checkResendConnection(project, deps), { service: "resend", status: "valid", resultCode: "valid-full-access", recorded: true });
    const next = () => buildNextReport(project, { vault, registryBaseDir: home, connectionBaseDir: home, adapters: [], licensePlan: "free" });
    assert.equal((await next()).connection.report.providerCheck.status, "passed");
    assert.notEqual((await next()).connection.report.stage, "ready");
    store.saveIntent({ ...intent, sendingDomain: "destination-change.example", destination: { kind: "manual" } });
    assert.equal((await next()).connection.report.providerCheck.status, "passed", "finished credential validation survives destination-only change");
    store.saveIntent(intent);
    stamp();
    assert.equal((await next()).connection.report.providerCheck.status, "stale");
    const staleLocal = await next();
    assert.ok(staleLocal.nextActions.some((a) => a.kind === "review-local-development"));
    assert.ok(!staleLocal.nextActions.some((a) => a.kind === "check-resend-credential"),
      "local continuation retains its own review instead of suggesting a provider operation");
    assert.equal((await checkResendConnection(project, { ...deps, validate: async () => { stamp(); return "valid-full-access"; } })).status, "unknown");
    assert.equal((await checkResendConnection(project, { ...deps, validate: async () => { store.saveIntent({ ...intent, sendingDomain: "changed.example" }); return "valid-full-access"; } })).status, "unknown");
    assert.equal((await checkResendConnection(project, { ...deps, validate: async () => { fixture(sending); return "valid-full-access"; } })).status, "unknown");
    cli = fixture();
    const dir = join(home, ".api-key-case", "connections", createHash("sha256").update(canonicalProjectRealpath(project)).digest("hex"));
    mkdirSync(join(dir, "lock"), { mode: 0o700 });
    const prior = executions;
    assert.equal((await checkResendConnection(project, deps)).status, "unknown");
    assert.equal(executions, prior);
    rmSync(join(dir, "lock"), { recursive: true });
    assert.equal((await checkResendConnection(project, { ...deps, validate: async () => { mkdirSync(join(dir, "lock"), { mode: 0o700 }); return "valid-full-access"; } })).recorded, false);
    rmSync(join(dir, "lock"), { recursive: true });
    assert.equal(store.readObservations().value.at(-1).outcome, "unknown");
    assert.equal(store.readObservations().value.at(-1).finishedAt, null);
    assert.equal((await next()).connection.report.providerCheck.status, "unknown");
    const receipt = readFileSync(join(dir, "observations.json"), "utf8");
    for (const forbidden of [synthetic, "wxyz", "private.example", "checks", "detail"]) assert.ok(!receipt.includes(forbidden));
    assert.equal((await checkResendConnection(project, { ...deps, resolveCli: () => null })).resultCode, "cli-unavailable");
    store.saveIntent({ ...intent, route: "provider-native" });
    assert.equal((await checkResendConnection(project, deps)).status, "unknown");
  } finally {
    Entry.prototype.getPassword = original;
    delete process.env.NODE_OPTIONS; delete process.env.INJECTED;
    rmSync(root, { recursive: true, force: true });
  }
  await runEnvironmentGuardTests();
  console.log("Connection-check parser, boundary, environment guards, races and journal tests passed");
}

// The existing provider parser/handoff fixtures above remain unchanged. These
// orchestration checks never execute even the synthetic doctor child.
async function runEnvironmentGuardTests() {
  const root = mkdtempSync(join(tmpdir(), "akc-check-environment-"));
  const snapshot = dir => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(path)) : entry.isFile() ? [[path, readFileSync(path).toString("base64")]] : [];
  }));
  let serial = 0, cases = 0;
  function fixture(environment = "production") {
    const dir = join(root, String(serial++)), project = join(dir, "project"), home = join(dir, "home");
    for (const path of [dir, project, home]) mkdirSync(path, { mode: 0o700 });
    const store = new ConnectionStateStore(project, home), vault = new MemoryVault();
    const ref = connectionCredentialRef(project, environment);
    const input = { service: "resend", environment, route: "api-key-case-managed", destination: { kind: "local" }, sendingDomain: null };
    const select = value => assert.equal(store.saveIntent({ ...input, ...value }).ok, true);
    const stamp = () => { const r = store.beginCredentialMutation(ref); assert.equal(r.ok, true); assert.equal(store.finishCredentialMutation(ref, r.value, true), true); };
    select({}); stamp();
    const metadata = join(home, ".api-key-case", "connections", createHash("sha256").update(canonicalProjectRealpath(project)).digest("hex"));
    return { dir, project, home, store, vault, ref, select, stamp, metadata };
  }
  const unknown = environment => ({ service: "resend", status: "unknown", resultCode: "unknown", recorded: false, environment });
  try {
    for (const environment of ["development", "preview", "production"]) {
      const f = fixture(environment); await f.vault.setSecret(f.ref, synthetic);
      const reads = [], cli = resolveCli("node", dirname(process.execPath)); assert.ok(cli);
      const original = f.vault.hasSecret.bind(f.vault);
      f.vault.hasSecret = async ref => { reads.push(ref); return original(ref); };
      const result = await checkResendConnection(f.project, { vault: f.vault, connectionBaseDir: f.home, expectedEnvironment: environment,
        resolveCli: () => cli, validate: async input => { assert.deepEqual(input.ref, f.ref); assert.equal(await input.stillCurrent(), true); return "valid-sending-access"; } });
      assert.deepEqual(result, { service: "resend", status: "valid", resultCode: "valid-sending-access", recorded: true, environment });
      assert.ok(reads.length > 0); for (const ref of reads) assert.deepEqual(ref, f.ref); cases++;
    }
    const f = fixture(), effects = { availability: 0, presence: 0, cli: 0, provider: 0 };
    const deny = name => () => { effects[name]++; throw Error(synthetic); };
    const deps = { vault: { isAvailable: deny("availability"), hasSecret: deny("presence") }, connectionBaseDir: f.home,
      resolveCli: deny("cli"), validate: deny("provider") };
    const before = snapshot(f.dir);
    assert.deepEqual(await checkResendConnection(f.project, { ...deps, expectedEnvironment: "development" }),
      { ...unknown("development"), reason: "environment-mismatch" }); cases++;
    for (const invalid of [undefined, null, "", "staging", synthetic, {}, 1]) {
      assert.deepEqual(await checkResendConnection(f.project, { ...deps, expectedEnvironment: invalid }),
        { ...unknown(null), reason: "invalid-environment" }); cases++;
    }
    assert.deepEqual(snapshot(f.dir), before);
    for (const state of ["absent", "corrupt", "pending", "slot-lock", "journal-lock", "intent-corrupt", "intent-absent", "native", "symlink"]) {
      if (state === "symlink" && process.platform === "win32") continue;
      const g = fixture(), file = join(g.metadata, "credential-production.json");
      if (state === "absent") rmSync(file);
      else if (state === "corrupt") writeFileSync(file, "{}");
      else if (state === "pending") { const raw = JSON.parse(readFileSync(file, "utf8")); raw.credential.state = "pending"; writeFileSync(file, JSON.stringify(raw)); }
      else if (state === "slot-lock") mkdirSync(file + ".lock");
      else if (state === "journal-lock") mkdirSync(join(g.metadata, "lock"));
      else if (state === "intent-corrupt") writeFileSync(join(g.metadata, "state.json"), "{}");
      else if (state === "intent-absent") rmSync(join(g.metadata, "state.json"));
      else if (state === "native") g.select({ route: "provider-native" });
      else { const outside = join(g.dir, "outside.json"); writeFileSync(outside, readFileSync(file)); rmSync(file); symlinkSync(outside, file); }
      const stable = snapshot(g.dir);
      assert.deepEqual(await checkResendConnection(g.project, { ...deps, connectionBaseDir: g.home, expectedEnvironment: "production" }), unknown("production"), state);
      assert.deepEqual(snapshot(g.dir), stable, state); cases++;
    }
    assert.deepEqual(effects, { availability: 0, presence: 0, cli: 0, provider: 0 }, "refusal precedes all vault/CLI/provider effects");
    // The legacy entrypoint still returns exactly the original four fields.
    const empty = join(root, "empty"); mkdirSync(empty);
    assert.deepEqual(await checkResendConnection(empty, deps), { service: "resend", status: "unknown", resultCode: "unknown", recorded: false }); cases++;
    for (const phase of ["availability", 1, 2, 3, 4]) for (const mutation of ["environment", "round-trip", "revision"]) {
      const g = fixture("development"); await g.vault.setSecret(g.ref, synthetic);
      let presence = 0, resolved = 0, executed = 0;
      const mutate = () => {
        if (mutation === "revision") g.stamp();
        else { g.select({ environment: "production" }); if (mutation === "round-trip") g.select({ environment: "development" }); }
      };
      const original = g.vault.hasSecret.bind(g.vault);
      g.vault.isAvailable = async () => { if (phase === "availability") mutate(); return true; };
      g.vault.hasSecret = async ref => { const present = await original(ref); if (++presence === phase) mutate(); return present; };
      const result = await checkResendConnection(g.project, { vault: g.vault, connectionBaseDir: g.home, expectedEnvironment: "development",
        resolveCli: () => { resolved++; return resolveCli("node", dirname(process.execPath)); },
        validate: async input => { executed++; await input.stillCurrent(); return "valid-full-access"; } });
      assert.equal(result.status, "unknown", `${phase}/${mutation}`); assert.equal(result.environment, "development");
      if (phase === "availability" || phase === 1) {
        assert.equal(resolved, 0); assert.equal(executed, 0); assert.equal(g.store.readObservations().status, "missing");
      } else {
        assert.equal(executed, phase === 2 ? 0 : 1); assert.equal(g.store.readObservations().value.at(-1).outcome, "unknown");
      }
      cases++;
    }
    console.log(`Connection-check environment guard: ${cases} synthetic cases passed; no provider execution.`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runConnectionCheckTests();
