import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildConnectionPlan, recordApplicationObservation, applicationObservationState, APPLICATION_OBSERVATION_VERSION } from "../dist/core/agent/connection-plan.js";
import { ConnectionStateStore } from "../dist/core/agent/connection-state.js";
import { connectionCredentialRef } from "../dist/core/agent/connection-credential.js";
import { MemoryVault } from "../dist/core/vault/memory.js";
import { buildNextReport } from "../dist/core/agent/next.js";
import { inspectHostReadiness } from "../dist/core/agent/readiness.js";

export async function runConnectionPlanTests() {
  const root = mkdtempSync(join(tmpdir(), "akc-plan-"));
  try {
    const project = join(root, "project"), home = join(root, "home");
    mkdirSync(project); mkdirSync(home);
    const source = join(project, "app.ts");
    writeFileSync(source, "process.env.RESEND_API_KEY;\n");
    writeFileSync(join(project, ".gitignore"), ".env\n.env.*\n");
    const vault = new MemoryVault(), store = new ConnectionStateStore(project, home);
    const ref = connectionCredentialRef(project, "development");
    let nonPresenceCalls = 0;
    const readOnlyVault = new Proxy(vault, { get(target, property) {
      if (property === 'hasSecret') return target.hasSecret.bind(target);
      nonPresenceCalls++;
      throw new Error('Plan must use only exact-slot presence, never availability/write/delete/trust probes');
    } });
    let nativeFingerprint = "f".repeat(64);
    let fingerprint = "a".repeat(64), identityEnvironment = "development", resolverCalls = 0;
    const deps = { vault: readOnlyVault, connectionBaseDir: home, resolveDestination: async intent => {
      resolverCalls++;
      return fingerprint ? { target: intent.destination.kind, env: identityEnvironment,
        projectDir: realpathSync.native(project), fingerprint, slot: "b".repeat(64), nativeConfigurationFingerprint: nativeFingerprint } : null;
    } };
    const setIntent = (route = "api-key-case-managed", kind = "vercel", environment = "development") =>
      store.saveIntent({ service: "resend", route, environment, destination: { kind }, sendingDomain: null });
    const plan = () => buildConnectionPlan(project, "development", deps);
    assert.equal((await plan()).reason, "intent-missing");
    assert.equal(setIntent("api-key-case-managed","github").ok,true);
    const githubPlan = await plan();
    assert.equal(githubPlan.status,"unsupported");assert.equal(githubPlan.permission,"none");assert.equal(resolverCalls,0);
    setIntent();
    const originalPresence = vault.hasSecret;
    vault.hasSecret = async () => { throw new Error('synthetic-private-backend-diagnostic'); };
    const unavailable = await plan();
    assert.equal(unavailable.reason, 'credential-unavailable');
    assert.equal(JSON.stringify(unavailable).includes('synthetic-private-backend-diagnostic'), false);
    vault.hasSecret = originalPresence;
    assert.equal((await plan()).reason, "credential-missing");
    await vault.setSecret({ name: "RESEND_API_KEY", scope: "project", projectId: ref.projectId }, "synthetic-legacy-canary");
    assert.equal((await plan()).reason, "credential-missing", "no legacy fallback");
    await vault.setSecret(connectionCredentialRef(project, "production"), "synthetic-production-canary");
    assert.equal((await plan()).reason, "credential-missing", "no other environment fallback");
    const save = async () => {
      const start = store.beginCredentialMutation(ref); assert.equal(start.ok, true);
      await vault.setSecret(ref, "synthetic-development-canary");
      assert.equal(store.finishCredentialMutation(ref, start.value, true), true);
    };
    await save();
    const initial = await plan();
    assert.equal((await buildConnectionPlan(project, "development", { vault, connectionBaseDir: home })).reason, "destination-unresolved", "production plan never invokes a provider CLI");
    assert.equal(initial.status, "planned", `existing intent/v2 slot must resolve: ${initial.reason}`); assert.equal(initial.permission, "none"); assert.equal(initial.execution, "unsupported");
    assert.ok(initial.basis.credentialRevision); assert.equal(initial.basis.nativeConfigurationFingerprint, null);
    assert.equal((await buildConnectionPlan(project, "production", deps)).reason, "environment-mismatch");
    identityEnvironment = "production"; assert.equal((await plan()).reason, "destination-unresolved"); identityEnvironment = "development";
    fingerprint = null; assert.equal((await plan()).reason, "destination-unresolved"); fingerprint = "a".repeat(64);
    setIntent("api-key-case-managed", "local"); const calls = resolverCalls;
    assert.equal((await plan()).status, "unsupported"); assert.equal(resolverCalls, calls); setIntent();
    const observe = async (overrides = {}) => recordApplicationObservation(project, {
      environment: "development", planFingerprint: (await plan()).fingerprint, outcome: "passed",
      configuration: "observed", maxAgeSeconds: 60, ...overrides
    }, deps);
    assert.equal((await observe({ maxAgeSeconds: 0 })).status, "unknown");
    assert.equal((await observe({ maxAgeSeconds: 86401 })).status, "unknown");
    assert.equal((await observe({ maxAgeSeconds: NaN })).status, "unknown");
    assert.equal((await observe({ planFingerprint: "c".repeat(64) })).status, "unknown");
    assert.equal(store.readObservations().status, "missing");
    assert.deepEqual(await observe(), { status: "recorded", authority: "agent-observed", executed: false });
    const receipt = () => store.readObservations().value.at(-1);
    let current = receipt();
    assert.deepEqual(applicationObservationState(current, await plan()), { status: "passed", reason: "application-passed", configured: true });
    assert.equal(applicationObservationState({ ...current, authority: "provider-observed" }, await plan()).status, "unknown");
    assert.equal(applicationObservationState({ ...current, authority: "human-reported" }, await plan()).status, "unknown");
    assert.equal(applicationObservationState(current, await plan(), Date.parse(current.basis.expiresAt)).status, "stale");
    assert.equal(applicationObservationState(current, await plan(), Date.parse(current.startedAt) - 1).status, "stale");
    assert.equal(applicationObservationState({ ...current, basis: { ...current.basis, verifierVersion: "obsolete" } }, await plan()).status, "stale");
    assert.equal(applicationObservationState({ ...current, finishedAt: null }, await plan()).status, "unknown");
    assert.equal(applicationObservationState({ ...current, basis: { ...current.basis, expiresAt: undefined } }, await plan()).status, "unknown");
    assert.equal(applicationObservationState({ ...current, basis: { ...current.basis, expiresAt: new Date(Date.parse(current.startedAt) + 86401000).toISOString() } }, await plan()).status, "stale");
    fingerprint = "d".repeat(64); assert.equal(applicationObservationState(current, await plan()).status, "stale"); fingerprint = "a".repeat(64);
    writeFileSync(source, "void process.env.RESEND_API_KEY;\n"); assert.equal(applicationObservationState(current, await plan()).status, "stale");
    writeFileSync(source, 'const x = "not-in-a-fingerprint"; process.env.RESEND_API_KEY;\n');
    assert.equal((await plan()).reason, "source-unresolved"); assert.equal(applicationObservationState(current, await plan()).status, "unknown");
    writeFileSync(source, "process.env.RESEND_API_KEY;\n");
    const helper = join(project, "helper.ts");
    writeFileSync(helper, "function send(key) { return true; }\n");
    await observe(); const withHelper = receipt();
    writeFileSync(helper, "function send(key) { return false; }\n");
    assert.equal(applicationObservationState(withHelper, await plan()).status, "stale", "helper-only edits invalidate app pass");
    const packagePath = join(project, "package.json"); writeFileSync(packagePath, '{}');
    assert.equal((await plan()).reason, "source-unresolved", "unclassified dependency/config input stays unknown"); rmSync(packagePath);
    const dependencies = join(project, "node_modules"); mkdirSync(dependencies);
    assert.equal((await plan()).reason, "source-unresolved"); rmSync(dependencies, { recursive: true });
    rmSync(helper);
    await save(); assert.equal(applicationObservationState(current, await plan()).status, "stale");
    await vault.deleteSecret(ref); assert.equal(applicationObservationState(current, await plan()).status, "stale"); await save();
    await observe({ configuration: "unknown" }); assert.deepEqual(applicationObservationState(receipt(), await plan()), { status: "passed", reason: "application-passed", configured: false });
    await observe({ outcome: "unknown" }); assert.equal(applicationObservationState(receipt(), await plan()).status, "unknown");
    await observe({ outcome: "failed" }); assert.equal(applicationObservationState(receipt(), await plan()).status, "failed");
    // Native basis does not require a vault lookup or duplicate secret.
    setIntent("provider-native");
    const forbiddenVault = { isAvailable: async () => { throw new Error("vault must not be touched"); } };
    const native = await buildConnectionPlan(project, "development", { ...deps, vault: forbiddenVault });
    assert.equal(native.status, "planned"); assert.equal(native.basis.credentialRevision, null);
    assert.equal(native.basis.nativeConfigurationFingerprint, nativeFingerprint);
    nativeFingerprint = undefined; assert.equal((await plan()).reason, "native-configuration-unresolved"); nativeFingerprint = "f".repeat(64);
    await observe();
    const statusDeps = { vault, adapters: [], licensePlan: "free", connectionBaseDir: home, registryBaseDir: home,
      connectionDestinationResolver: deps.resolveDestination,
      hostReadiness: inspectHostReadiness({ platform: "win32", osRelease: "10.0.26200", helperAvailable: true }) };
    let report = (await buildNextReport(project, statusDeps)).connection.report;
    assert.equal(report.stage, "ready"); assert.equal(report.destination.authority, "agent-observed");
    assert.equal(report.applicationCheck.authority, "agent-observed"); assert.equal(report.providerCheck.status, "not-applicable");
    nativeFingerprint = "0".repeat(64);
    assert.equal((await buildNextReport(project, statusDeps)).connection.report.applicationCheck.status, "stale", "native configuration changes invalidate observation");
    nativeFingerprint = "f".repeat(64);
    fingerprint = "e".repeat(64);
    report = (await buildNextReport(project, statusDeps)).connection.report;
    assert.equal(report.applicationCheck.status, "stale"); assert.equal(report.destination.status, "changed"); assert.notEqual(report.stage, "ready");
    // An interrupted metadata-only attempt leaves unknown. No automatic re-run.
    const stable = await plan(); let probes = 0;
    const interrupted = await recordApplicationObservation(project, { environment: "development", planFingerprint: stable.fingerprint,
      outcome: "passed", configuration: "observed", maxAgeSeconds: 60 }, {
      ...deps, resolveDestination: async intent => { if (++probes === 2) return null; return deps.resolveDestination(intent); }
    });
    assert.equal(interrupted.status, "unknown"); assert.equal(probes, 2); assert.equal(receipt().finishedAt, null);
    assert.equal(applicationObservationState(receipt(), await plan()).status, "unknown");
    const stateDir = join(home, ".api-key-case", "connections", readdirSync(join(home, ".api-key-case", "connections"))[0]);
    const journalPath = join(stateDir, "observations.json"), journal = readFileSync(journalPath, "utf8");
    const fake = JSON.parse(journal); fake.entries.at(-1).authority = "provider-observed";
    writeFileSync(journalPath, JSON.stringify(fake)); assert.equal(store.readObservations().status, "unavailable");
    assert.notEqual((await buildNextReport(project, statusDeps)).connection.report.stage, "ready");
    writeFileSync(journalPath, journal);
    const validBasis = receipt().basis;
    assert.equal(store.beginObservation({ kind: "application-check", authority: "human-reported", basis: validBasis }).ok, false);
    writeFileSync(journalPath, "{malformed"); assert.equal(store.readObservations().status, "unavailable");
    rmSync(journalPath); assert.equal(store.readObservations().status, "missing");
    report = (await buildNextReport(project, statusDeps)).connection.report;
    assert.equal(report.applicationCheck.status, "not-run"); assert.notEqual(report.stage, "ready");
    const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
    for (const args of [
      ["plan", "--service", "resend", "--env", "development", "--json", "--url", "synthetic-url-canary"],
      ["observe-application", "--service", "resend", "--env", "development", "--json", "--authority", "provider-observed"],
      ["observe-application", "--service", "resend", "--env", "development", "--json", "--command", "synthetic-command-canary"]
    ]) {
      assert.throws(() => execFileSync(process.execPath, [cli, "connection", ...args], { encoding: "utf8", stdio: "pipe" }), error => {
        assert.equal(error.status, 1); assert.ok(!error.stderr.includes("synthetic-")); return true;
      });
    }
    assert.equal(JSON.stringify([initial, native, report, journal]).includes("synthetic-development-canary"), false);
    assert.equal(nonPresenceCalls, 0, "plan and observation recomputation must not call any vault mutator/probe");
    assert.equal(APPLICATION_OBSERVATION_VERSION, "resend-application-check-v3");
    console.log("PASS: connection plan and advisory observation contract");
  } finally { rmSync(root, { recursive: true, force: true }); }
}
