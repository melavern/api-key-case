import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConnectionPlan, recordApplicationObservation } from "../dist/core/agent/connection-plan.js";
import { ConnectionStateStore } from "../dist/core/agent/connection-state.js";
import { connectionCredentialRef } from "../dist/core/agent/connection-credential.js";
import { MemoryVault } from "../dist/core/vault/memory.js";
import { buildNextReport } from "../dist/core/agent/next.js";
import { inspectHostReadiness } from "../dist/core/agent/readiness.js";

const advice = (reason, actor, action) => ({ reason, actor, action });
const productResolver = advice("destination-unresolved", "product", "await-destination-resolver");
function snapshot(path) {
  const stat = lstatSync(path);
  return { mode: stat.mode, mtime: stat.mtimeMs, content: stat.isDirectory()
    ? readdirSync(path).sort().map(name => [name, snapshot(join(path, name))])
    : readFileSync(path).toString("hex") };
}
function closed(plan) {
  assert.deepEqual(Object.keys(plan).sort(), ["schemaVersion", "service", "environment", "route", "destination", "status", "reason", "fingerprint", "basis", "permission", "execution", "applicationCheck", "recovery"].sort());
  assert.deepEqual(Object.keys(plan.applicationCheck).sort(), ["status", "reason", "configured", "authority"].sort());
  for (const item of plan.recovery) assert.deepEqual(Object.keys(item).sort(), ["reason", "actor", "action"].sort());
  assert.equal(plan.permission, "none"); assert.equal(plan.execution, "unsupported");
}

export async function runConnectionRecoveryTests() {
  const root = mkdtempSync(join(tmpdir(), "akc-recovery-"));
  try {
    for (const environment of ["development", "preview", "production"]) {
      const project = join(root, environment), home = join(root, `${environment}-home`);
      mkdirSync(project); mkdirSync(home);
      const source = join(project, "app.ts");
      writeFileSync(source, "process.env.RESEND_API_KEY;\n");
      writeFileSync(join(project, ".gitignore"), ".env\n.env.*\n");
      const vault = new MemoryVault(), store = new ConnectionStateStore(project, home);
      const ref = connectionCredentialRef(project, environment);
      let destination = "a".repeat(64), nativeConfigurationFingerprint = "b".repeat(64);
      const resolver = async intent => ({ target: intent.destination.kind, env: environment,
        projectDir: realpathSync.native(project), fingerprint: destination, slot: "c".repeat(64), nativeConfigurationFingerprint });
      // Inspection may only ask existence. Mutations/getters/runner are not available to it.
      const readVault = { isAvailable: () => vault.isAvailable(), hasSecret: ref => vault.hasSecret(ref) };
      const deps = { vault: readVault, connectionBaseDir: home, resolveDestination: resolver };
      const inspect = () => buildConnectionPlan(project, environment, deps);
      const next = () => buildNextReport(project, { ...deps, adapters: [], licensePlan: "free", registryBaseDir: home,
        connectionDestinationResolver: resolver,
        hostReadiness: inspectHostReadiness({ platform: "win32", osRelease: "10.0.26200", helperAvailable: true }) });
      const select = (route = "api-key-case-managed", kind = "vercel", env = environment) => {
        const result = store.saveIntent({ service: "resend", route, environment: env, destination: { kind }, sendingDomain: null });
        assert.equal(result.ok, true);
      };
      let plan = await inspect(); closed(plan);
      assert.equal(plan.reason, "intent-missing");
      assert.deepEqual(plan.recovery, [advice("intent-missing", "human", "select-connection-intent")]);
      assert.deepEqual((await next()).connection, { status: "not-selected", issue: null, report: null });
      select();
      const stateDir = join(home, ".api-key-case", "connections", readdirSync(join(home, ".api-key-case", "connections"))[0]);
      const intentPath = join(stateDir, "state.json"), intent = readFileSync(intentPath, "utf8");
      for (const failure of ["corrupt", "locked", "pending"]) {
        if (failure === "corrupt") writeFileSync(intentPath, '{"unsafe":"raw-intent-canary"}');
        if (failure === "locked") mkdirSync(join(stateDir, "lock"));
        if (failure === "pending") writeFileSync(join(stateDir, "state.json.tmp"), "raw-temp-canary");
        const before = snapshot(home);
        plan = await inspect();
        assert.equal(plan.reason, "intent-unavailable");
        assert.deepEqual(plan.recovery, [advice("intent-unavailable", "agent", "review-connection-intent")]);
        assert.equal((await next()).connection.status, "unavailable");
        assert.deepEqual(snapshot(home), before, "unreadable intent is never reset or overwritten");
        if (failure === "corrupt") writeFileSync(intentPath, intent);
        if (failure === "locked") rmSync(join(stateDir, "lock"), { recursive: true });
        if (failure === "pending") rmSync(join(stateDir, "state.json.tmp"));
      }
      plan = await inspect();
      assert.equal(plan.reason, "credential-missing");
      assert.equal(plan.applicationCheck.reason, "observation-missing", "no receipt is not an interrupted attempt");
      assert.deepEqual(plan.recovery, [advice("credential-missing", "human", "register-environment-credential")]);
      const production = () => buildConnectionPlan(project, environment, { vault: readVault, connectionBaseDir: home });
      assert.deepEqual((await production()).recovery, [productResolver, advice("credential-missing", "human", "register-environment-credential")]);
      await vault.setSecret(ref, "synthetic-private-value-canary");
      plan = await inspect(); assert.equal(plan.reason, "credential-revision-unknown");
      assert.deepEqual(plan.recovery, [advice("credential-revision-unknown", "agent", "review-credential-metadata")]);
      assert.equal((await next()).nextActions.some(action => action.kind === "register-connection-credential"), false);
      const mutation = store.beginCredentialMutation(ref); assert.equal(mutation.ok, true);
      assert.equal((await inspect()).reason, "credential-revision-unknown");
      assert.equal(store.finishCredentialMutation(ref, mutation.value, true), true);
      {
        const failed = await buildConnectionPlan(project, environment, { ...deps, vault: { ...readVault,
          hasSecret: async () => { throw new Error("raw-vault-error-canary"); } } });
        assert.equal(failed.reason, "credential-unavailable");
        assert.deepEqual(failed.recovery, [advice("credential-unavailable", "human", "restore-vault-access")]);
        assert.equal(JSON.stringify(failed).includes("canary"), false);
      }
      assert.notEqual((await buildConnectionPlan(project, environment, { ...deps, vault: { ...readVault,
        isAvailable: async () => { throw new Error('mutating availability probe must not run'); }
      } })).reason, 'credential-unavailable', 'exact-slot presence works without a mutating availability probe');
      select("api-key-case-managed", "local");
      plan = await inspect(); assert.equal(plan.reason, "handoff-pending");
      assert.deepEqual(plan.recovery, [advice("handoff-pending", "product", "await-supported-handoff")]);
      select("provider-native");
      assert.deepEqual((await production()).recovery, [productResolver,
        advice("native-configuration-unresolved", "product", "await-native-configuration-resolver")]);
      const noResolverReport = await buildNextReport(project, { vault: readVault, connectionBaseDir: home, registryBaseDir: home, adapters: [], licensePlan: "free" });
      assert.equal(noResolverReport.nextActions.some(item => item.kind === "complete-provider-native-setup"), false);
      const failedResolver = await buildConnectionPlan(project, environment, { ...deps, resolveDestination: async () => { throw new Error("raw-resolver-error-canary"); } });
      assert.equal(failedResolver.reason, "destination-unresolved");
      assert.deepEqual(failedResolver.recovery, [advice("destination-unresolved", "agent", "review-destination-basis")]);
      nativeConfigurationFingerprint = undefined;
      assert.deepEqual((await inspect()).recovery, [advice("native-configuration-unresolved", "agent", "review-native-configuration-basis")]);
      nativeConfigurationFingerprint = "b".repeat(64);
      for (const unknown of ["syntax", "configuration", "dependency"]) {
        const path = join(project, unknown === "configuration" ? "package.json" : "node_modules");
        if (unknown === "syntax") writeFileSync(source, 'const x = "raw-source-canary"; process.env.RESEND_API_KEY;');
        else if (unknown === "configuration") writeFileSync(path, '{"raw":"raw-config-canary"}');
        else mkdirSync(path);
        plan = await inspect(); assert.equal(plan.reason, "source-unresolved");
        assert.deepEqual(plan.recovery, [advice("source-unresolved", "agent", "review-source-coverage")]);
        if (unknown === "syntax") writeFileSync(source, "process.env.RESEND_API_KEY;\n");
        else rmSync(path, { recursive: true });
      }
      const observe = async (overrides = {}) => {
        const current = await inspect();
        assert.equal((await recordApplicationObservation(project, { environment, planFingerprint: current.fingerprint,
          outcome: "passed", configuration: "observed", maxAgeSeconds: 600, ...overrides }, deps)).status, "recorded");
      };
      plan = await inspect();
      assert.deepEqual(plan.recovery, [advice("observation-missing", "agent", "review-application-evidence")]);
      await observe();
      plan = await inspect(); closed(plan);
      assert.deepEqual(plan.applicationCheck, { status: "passed", reason: "application-passed", configured: true, authority: "agent-observed" });
      assert.deepEqual(plan.recovery, []);
      let report = await next();
      assert.equal(report.connection.report.stage, "ready"); assert.deepEqual(report.connection.report.recovery, []);
      assert.deepEqual(report.nextActions, [], "a current native success creates no unnecessary work");
      const before = snapshot(home), sourceBefore = snapshot(project);
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(await inspect(), plan);
        assert.deepEqual(await next(), report);
      }
      assert.deepEqual(snapshot(home), before, "inspection never refreshes a receipt, clears a lock or writes state");
      assert.deepEqual(snapshot(project), sourceBefore);
      const journalPath = join(stateDir, "observations.json"), journal = readFileSync(journalPath, "utf8");
      const changeReceipt = patch => {
        const copy = JSON.parse(journal); patch(copy.entries.at(-1)); writeFileSync(journalPath, JSON.stringify(copy));
      };
      const cases = [
        ["observation-interrupted", "unknown", "review-interrupted-observation", item => { item.finishedAt = null; item.outcome = "unknown"; item.resultCode = null; }],
        ["observation-expired", "stale", "review-application-evidence", item => { item.startedAt = "2020-01-01T00:00:00.000Z"; item.finishedAt = "2020-01-01T00:00:01.000Z"; item.basis.expiresAt = "2020-01-01T00:00:02.000Z"; }],
        ["observation-time-invalid", "stale", "review-observation-time", item => { item.startedAt = "2099-01-01T00:00:00.000Z"; item.finishedAt = "2099-01-01T00:00:01.000Z"; item.basis.expiresAt = "2099-01-01T00:00:02.000Z"; }],
        ["verifier-changed", "stale", "review-application-evidence", item => { item.basis.verifierVersion = "resend-application-check-v2"; }],
        ["basis-changed", "stale", "review-application-evidence", item => { item.basis.planFingerprint = "d".repeat(64); }],
        ["outcome-unknown", "unknown", "review-application-evidence", item => { item.outcome = "unknown"; item.resultCode = "unknown"; }],
        ["application-failed", "failed", "review-application-failure", item => { item.outcome = "failed"; item.resultCode = "application-failed"; }],
        ["observation-invalid", "unknown", "review-observation-storage", item => { item.authority = "provider-observed"; }],
        ["authority-mismatch", "unknown", "review-observation-authority", item => { item.authority = "human-reported"; delete item.basis.planFingerprint; delete item.basis.expiresAt; delete item.basis.configurationObserved; }],
        ["observation-basis-missing", "unknown", "review-application-evidence", item => { delete item.basis.planFingerprint; delete item.basis.expiresAt; delete item.basis.configurationObserved; }]
      ];
      for (const [reason, status, action, patch] of cases) {
        changeReceipt(patch);
        plan = await inspect(); closed(plan);
        assert.equal(plan.applicationCheck.reason, reason); assert.equal(plan.applicationCheck.status, status);
        assert.deepEqual(plan.recovery, [advice(reason, "agent", action)]);
        const current = await next();
        assert.equal(current.connection.report.applicationCheck.reason, reason);
        assert.deepEqual(current.connection.report.recovery, plan.recovery);
        assert.notEqual(current.connection.report.stage, "ready");
      }
      writeFileSync(journalPath, "{raw-journal-canary");
      assert.equal((await inspect()).applicationCheck.reason, "observation-invalid");
      writeFileSync(journalPath, journal);
      writeFileSync(`${journalPath}.tmp`, "raw-interrupted-write-canary");
      assert.equal((await inspect()).applicationCheck.reason, "observation-unavailable");
      rmSync(`${journalPath}.tmp`);
      destination = "e".repeat(64);
      assert.equal((await inspect()).applicationCheck.reason, "basis-changed"); destination = "a".repeat(64);
      nativeConfigurationFingerprint = "f".repeat(64);
      assert.equal((await inspect()).applicationCheck.reason, "basis-changed"); nativeConfigurationFingerprint = "b".repeat(64);
      writeFileSync(source, "void process.env.RESEND_API_KEY;\n");
      assert.equal((await inspect()).applicationCheck.reason, "basis-changed"); writeFileSync(source, "process.env.RESEND_API_KEY;\n");
      plan = await production(); assert.equal(plan.applicationCheck.reason, "basis-unresolved");
      assert.deepEqual(plan.recovery, [productResolver, advice("native-configuration-unresolved", "product", "await-native-configuration-resolver")]);
      const otherEnvironment = environment === "production" ? "development" : "production";
      const beforeMismatch = snapshot(home);
      const mismatched = await buildConnectionPlan(project, otherEnvironment, deps);
      assert.equal(mismatched.environment, otherEnvironment); assert.equal(mismatched.reason, "environment-mismatch");
      assert.equal(mismatched.applicationCheck.authority, "none");
      assert.deepEqual(mismatched.recovery, [advice("environment-mismatch", "human", "review-environment-selection")]);
      assert.deepEqual(snapshot(home), beforeMismatch, "a mismatch never changes the selected environment");
      await observe({ configuration: "unknown" });
      assert.deepEqual((await inspect()).recovery, [advice("configuration-unobserved", "agent", "review-destination-configuration")]);
      rmSync(journalPath);
      plan = await inspect(); assert.equal(plan.applicationCheck.reason, "observation-missing");
      assert.equal(plan.applicationCheck.status, "not-run");
      const output = JSON.stringify([plan, await next(), failedResolver, mismatched]);
      for (const value of [root, project, home, "canary", "rawOutput", "stack"]) assert.equal(output.includes(value), false);
    }
    console.log("PASS: environment-scoped closed recovery reasons, ownership, invalidation and read-only inspection");
  } finally { rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runConnectionRecoveryTests();
