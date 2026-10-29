import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runFixture } from "./vnext-cloudflare-fixture.mjs";
import { prepareTarget, registerTarget, projectTargetPlan } from "../dist/core/vnext/target.js";
import { applyUse, prepareUse, projectUsePlan, useOperationStatus } from "../dist/core/vnext/use.js";
import { catalogSchema, operationSchema, validate, emptyCatalog, locatorAccount } from "../dist/core/vnext/model.js";
import { inspectProject } from "../dist/core/vnext/project.js";
import { buildWindowsTargetScript, buildWindowsVNextUseScript } from "../dist/core/human/windows-target.js";
import { encodeWindowsHelperCommand } from "../dist/core/human/windows.js";
import { runGenericCloudflareDeployment } from "../dist/core/deploy/handoff.js";
import { saveLicenseKey } from "../dist/core/license.js";
import { VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED } from "../dist/core/vnext/gates.js";
import { runSecretCommand } from "../dist/cli/secret.js";
import { capabilities } from "../dist/core/vnext/status.js";

if (!process.env.AKC_DISPOSABLE_GENERIC_TEST) {
  test("native-accepted generic delivery is Windows-only and backend-dependent", () => {
    assert.equal(VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED, true);
    assert.equal(capabilities("win32", "available", 22000).cloudflareUse.state, "available");
    for (const platform of ["linux", "darwin"]) assert.notEqual(capabilities(platform, "available", 22000).cloudflareUse.state, "available");
    assert.equal(capabilities("win32", "unavailable", 22000).cloudflareUse.state, "unavailable");
  });
  test("isolated generic target, plan, approval and stdin contract", () => runFixture());
} else {
  const accountId = "0123456789abcdef0123456789abcdef", canary = "synthetic-generic-stdin-canary-QZ91";
  const keys = generateKeyPairSync("ed25519"), payload = Buffer.from(JSON.stringify({ v: 1, plan: "pro", id: "synthetic-generic", issuedAt: "2026-10-21" })).toString("base64url");
  const signed = `AKC1.${payload}`, license = `${signed}.${sign(null, Buffer.from(signed), keys.privateKey).toString("base64url")}`;
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "akc-generic-case-")), app = join(root, "app"), home = join(root, "home"), bin = join(root, "bin");
    for (const path of [app, home, bin]) mkdirSync(path);
    const configA = join(app, "wrangler.jsonc"), configB = join(app, "deploy", "wrangler.toml"); mkdirSync(join(app, "deploy"));
    writeFileSync(configA, JSON.stringify({ name: "synthetic-api", account_id: accountId, vars: { IGNORE_ME: "private-config-canary" } }));
    writeFileSync(configB, `account_id = "${accountId}"\n[env.staging]\nname = "synthetic-buy"\n`);
    let catalog = emptyCatalog(), snapshot = null, choice = 0, approvals = 0, probes = 0, reads = 0;
    const records = new Map(), context = inspectProject(app), projectId = randomUUID(), envId = randomUUID();
    catalog.projects.push({ ...context, id: projectId, revision: 1 });
    catalog.environments.push({ id: envId, projectId, label: "development", risk: "nonproduction", revision: 1 });
    for (const variableName of ["OTHER_API_KEY", "arbitrary_key"]) {
      const id = randomUUID(); catalog.credentials.push({ id, label: "PRIVATE_GENERIC_LABEL", locator: { kind: "v3", id, generationId: randomUUID() }, generation: 1,
        classification: "nonproduction", createdAt: "2026-10-21T00:00:00.000Z", revisedAt: "2026-10-21T00:00:00.000Z" });
      catalog.bindings.push({ id: randomUUID(), projectId, environmentId: envId, variableName, credentialId: id, revision: 1 });
    }
    snapshot = { catalog, file: {} };
    let locked = false;
    const store = { readCatalog: () => snapshot, readOperation: id => records.get(id) ?? null,
      listUseOperations: (binding, target) => [...records.values()].map(r => r.operation).filter(o => o.kind === "cloudflare-use" && o.bindingId === binding && o.boundBasis.targetId === target),
      withUseLock: async (binding, target, action) => { if (locked) throw Error("lock-present"); locked = true; try { return await action(() => locked); } finally { locked = false; } },
      compareAndSwap: (old, next) => { assert.equal(old, snapshot); validate(catalogSchema, next); catalog = structuredClone(next); snapshot = { catalog, file: {} }; return snapshot; },
      saveOperation: (old, next) => { assert.equal(old, records.get(next.operationId) ?? null); validate(operationSchema, next); const record = { operation: structuredClone(next), file: {} }; records.set(next.operationId, record); return record; } };
    const io = { store, human: { choose: async () => ({ status: "confirmed", index: choice }), approve: async () => { approvals++; return "approved"; } },
      legacy: async () => ({ status: "available", locators: [] }), presence: async () => "present", pathOverride: bin,
      probe: async () => { probes++; return { installed: true, loggedIn: true, version: "4.131.2", identity: `accounts:${accountId}` }; },
      licenseOptions: { baseDir: home, publicKey: keys.publicKey }, handoff: runGenericCloudflareDeployment };
    saveLicenseKey(license, home);
    const marker = join(root, "events.json"), script = join(bin, "provider.cjs"), executable = join(bin, process.platform === "win32" ? "wrangler.cmd" : "wrangler");
    const body = `const fs=require('fs'); const args=process.argv.slice(2);if(args[0]!=='secret'||args[1]!=='put'||!['OTHER_API_KEY','arbitrary_key'].includes(args[2]))process.exit(41);if(process.env.CLOUDFLARE_ACCOUNT_ID!==${JSON.stringify(accountId)}||process.env.NODE_OPTIONS||process.env.WRANGLER_SEND_METRICS!=='false'||process.env.WRANGLER_LOG_SANITIZE!=='true')process.exit(42);let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(input!==${JSON.stringify(canary)})process.exit(43);const events=fs.existsSync(${JSON.stringify(marker)})?JSON.parse(fs.readFileSync(${JSON.stringify(marker)},'utf8')):[];events.push(args);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(events));console.log(input+'provider-partial-canary-AB72');console.error(input.slice(0,11));});`;
    writeFileSync(script, body); writeFileSync(executable, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!${process.execPath}\n${body}`); chmodSync(executable, 0o700);
    const targetRequest = { project: app, environment: "development" };
    const f = { root, app, home, bin, store, io, targetRequest, configA, configB, records, catalog: () => catalog, select: n => { choice = n; },
      counts: () => ({ approvals, probes, reads }), loseLease: () => { locked = false; }, events: () => existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : [],
      register: async () => registerTarget(targetRequest, prepareTarget(targetRequest, io).fingerprint, io),
      cleanupDelay: 0,
      close: async () => { if (f.cleanupDelay) await new Promise(resolve => setTimeout(resolve, f.cleanupDelay)); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } };
    globalThis.syntheticRead = account => { reads++; assert.ok(catalog.credentials.some(c => locatorAccount(c.locator) === account));
      assert.equal([...records.values()].at(-1).operation.state, "executing"); return canary; };
    return f;
  }
  const withFixture = (name, work) => test(name, async t => { const f = fixture(); try { await work(f, t); } finally { await f.close(); } });
  test("accepted capability remains Windows-only and backend-dependent in the isolated candidate", () => {
    assert.equal(capabilities("win32", "available", 22000).cloudflareUse.state, "available");
    for (const platform of ["linux", "darwin"]) assert.notEqual(capabilities(platform, "available", 22000).cloudflareUse.state, "available");
    assert.equal(capabilities("win32", "unavailable", 22000).cloudflareUse.state, "unavailable");
  });
  withFixture("ordinary JSONC/TOML discovery, human selection, duplicate registration and old catalog preservation", async f => {
    const plan = prepareTarget(f.targetRequest, f.io), report = projectTargetPlan(plan); assert.equal(report.candidateCount, 2);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|private-config|accountId|canonical|synthetic-api|wrangler/);
    assert.ok(!existsSync(join(f.app, "api-key-case.targets.json"))); const bytes = readFileSync(f.configA);
    assert.equal((await f.register()).status, "completed"); assert.equal((await f.register()).status, "unchanged");
    f.select(1); assert.equal((await f.register()).status, "completed"); assert.equal(f.catalog().destinations.length, 2); assert.ok(readFileSync(f.configA).equals(bytes));
  });
  withFixture("two arbitrary issuers and mixed-case variables deliver to two exact registered Workers via stdin", async f => {
    for (const selection of [0, 1]) {
      f.select(selection); const target = await f.register();
      for (const binding of f.catalog().bindings) {
        const request = { project: f.app, bindingId: binding.id, targetId: target.targetId }, plan = prepareUse(request, f.io), projection = projectUsePlan(plan);
        assert.doesNotMatch(JSON.stringify(projection), /PRIVATE_|private-config|accountId|canonical|synthetic-api|wrangler/);
        assert.equal(projection.placementEffect, "cloudflare-version-and-immediate-deployment");
        const result = await applyUse(request, plan.fingerprint, f.io); assert.equal(result.status, "completed"); assert.equal(result.placementEffects, "possible");
        const status = useOperationStatus(result.operationId, f.store); assert.equal(status.status, "completed"); assert.equal(status.executed, false);
        assert.equal(status.effects[0].state, "completed"); const counts = f.counts(); useOperationStatus(result.operationId, f.store); assert.deepEqual(f.counts(), counts);
      }
    }
    assert.deepEqual(f.counts(), { approvals: 4, probes: 4, reads: 4 }); assert.equal(f.events().length, 4);
    const [first, , third] = f.events(); assert.deepEqual(first.slice(3), ["--config", "deploy/wrangler.toml", "--name", "synthetic-buy", "--env", "staging"]);
    assert.deepEqual(third.slice(3), ["--config", "wrangler.jsonc", "--name", "synthetic-api"]);
  });
  for (const mode of ["declined", "unavailable", "change", "presence", "generation", "license", "expired", "journal", "lease"]) withFixture(`approval boundary ${mode}: zero Secret read or provider write`, async f => {
    const target = await f.register(), request = { project: f.app, bindingId: f.catalog().bindings[0].id, targetId: target.targetId }, plan = prepareUse(request, f.io);
    f.io.human.approve = async () => {
      if (mode === "change") writeFileSync(f.configB, `account_id="${accountId}"\n[env.staging]\nname="changed-worker"`);
      if (mode === "presence") f.io.presence = async () => "unavailable";
      if (mode === "generation") f.catalog().credentials[0].locator.generationId = randomUUID();
      if (mode === "lease") f.loseLease();
      if (mode === "license") rmSync(join(f.home, ".api-key-case", "license.key"));
      if (mode === "journal") f.store.saveOperation = () => { throw Error("private-error-canary"); };
      return mode === "declined" || mode === "unavailable" ? mode : "approved";
    };
    if (mode === "expired") { let clock = 100; f.io.now = () => { const value = clock; clock += 70_000; return value; }; }
    const result = await applyUse(request, plan.fingerprint, f.io); assert.notEqual(result.status, "completed"); assert.equal(f.counts().reads, 0); assert.equal(f.events().length, 0);
    assert.doesNotMatch(JSON.stringify(result), /private-error/);
  });
  withFixture("free target inspection but Pro-only offline use plan, no provider probes", async f => {
    const target = await f.register(); rmSync(join(f.home, ".api-key-case", "license.key"));
    const request = { project: f.app, bindingId: f.catalog().bindings[0].id, targetId: target.targetId };
    assert.throws(() => prepareUse(request, f.io)); assert.equal((await applyUse(request, "0".repeat(64), f.io)).status, "pro-required");
    assert.deepEqual(f.counts(), { approvals: 0, probes: 0, reads: 0 });
  });
  withFixture("unknown outcome and failed completion persistence stay observable and never replay", async f => {
    const target = await f.register(), request = { project: f.app, bindingId: f.catalog().bindings[0].id, targetId: target.targetId }, plan = prepareUse(request, f.io);
    let calls = 0; f.io.handoff = async () => { calls++; throw Error("private-error-canary"); };
    const result = await applyUse(request, plan.fingerprint, f.io); assert.equal(result.status, "unknown"); assert.equal(result.placementEffects, "possible");
    const status = useOperationStatus(result.operationId, f.store); assert.equal(status.status, "unknown"); assert.equal(status.replay, "not-permitted"); assert.equal(calls, 1);
    const freshPlan = projectUsePlan(prepareUse(request, f.io)); assert.equal(freshPlan.previousOperation.operationId, result.operationId); assert.equal(freshPlan.previousOperation.status, "unknown");
    assert.equal((await applyUse(request, plan.fingerprint, f.io)).status, "recovery-required"); assert.equal(calls, 1);
  });
  for (const mode of ["wrong-account", "wrong-version", "after-approval", "after-read", "provider-error", "timeout"]) withFixture(`fixed transport boundary ${mode}`, async f => {
    const target = await f.register(), request = { project: f.app, bindingId: f.catalog().bindings[0].id, targetId: target.targetId }, plan = prepareUse(request, f.io);
    if (mode === "wrong-account" || mode === "wrong-version") f.io.probe = async () => ({ installed: true, loggedIn: true,
      version: mode === "wrong-version" ? "3.99.0" : "4.131.2", identity: mode === "wrong-account" ? "accounts:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : `accounts:${accountId}` });
    if (mode === "after-approval") f.io.handoff = async (...args) => { f.catalog().bindings[0].revision++; return runGenericCloudflareDeployment(...args); };
    if (mode === "after-read") { const read = globalThis.syntheticRead; globalThis.syntheticRead = account => { const value = read(account); f.catalog().credentials[0].locator.generationId = randomUUID(); return value; }; }
    if (mode === "provider-error" || mode === "timeout") {
      const body = mode === "provider-error" ? "process.stdin.resume();process.stdin.on('end',()=>process.exit(7))" : "process.stdin.resume();setTimeout(()=>process.exit(0),4000)";
      // Windows invokes provider.cjs; the POSIX fixture executes the shebang file itself.
      writeFileSync(join(f.bin, process.platform === "win32" ? "provider.cjs" : "wrangler"),
        process.platform === "win32" ? body : `#!${process.execPath}\n${body}`);
    }
    if (mode === "timeout") f.cleanupDelay = 2500; // The deliberately unowned mock descendant self-terminates after the timeout receipt.
    const result = await applyUse(request, plan.fingerprint, f.io);
    assert.equal(result.status, mode === "provider-error" ? "incomplete" : ["wrong-account", "wrong-version"].includes(mode) ? "unavailable" : "unknown");
    assert.equal(f.events().length, 0); assert.equal(f.counts().reads, ["after-read", "provider-error", "timeout"].includes(mode) ? 1 : 0);
    if (["provider-error", "timeout"].includes(mode)) assert.equal((await applyUse(request, plan.fingerprint, f.io)).status, "recovery-required");
  });
  withFixture("CLI target projection and invalid value/authority flags stay value-free with zero effects", async f => {
    const services = { ...f.io, targetHuman: f.io.human, managementHuman: { confirm: async () => "unavailable" } };
    const capture = async argv => { const previous = console.log, output = []; console.log = line => output.push(line);
      try { const code = await runSecretCommand(argv, services); return { code, report: JSON.parse(output.join("")) }; } finally { console.log = previous; } };
    const plan = await capture(["target", "inspect", "--project", f.app, "--environment", "development", "--json"]);
    if (process.platform !== "win32") {
      assert.equal(plan.code, 1); assert.equal(plan.report.status, "unavailable");
      assert.deepEqual(f.counts(), { approvals: 0, probes: 0, reads: 0 });
      return; // Direct metadata projections are covered above; the shipped CLI stays Windows-only.
    }
    assert.equal(plan.code, 0); assert.equal(plan.report.candidateCount, 2); assert.doesNotMatch(JSON.stringify(plan), /PRIVATE_|canonicalPath|accountId|private-config/);
    const registered = await capture(["target", "register", "--project", f.app, "--environment", "development", "--fingerprint", plan.report.fingerprint, "--json"]);
    assert.equal(registered.report.status, "completed");
    const rediscovered = await capture(["target", "inspect", "--project", f.app, "--environment", "development", "--json"]);
    assert.equal(rediscovered.report.targets[0].targetId, registered.report.targetId);
    for (const command of [["target", "register"], ["use", "apply"]]) for (const flag of ["--value", "--stdin", "--approved", "--command", "--url", "--env-map"]) {
      const result = await capture([...command, flag, "private-argument-canary", "--json"]); assert.equal(result.code, 1); assert.equal(result.report.executed, false);
      assert.doesNotMatch(JSON.stringify(result), /private-argument/);
    }
    assert.deepEqual(f.counts(), { approvals: 0, probes: 0, reads: 0 });
  });
  for (const mode of ["duplicate", "symlink", "junction", "hardlink", "outside", "malformed"]) withFixture(`unsafe config ${mode} rejected with no effect`, async (f, t) => {
    let request = f.targetRequest;
    if (mode === "duplicate") writeFileSync(f.configA, `{"account_id":"${accountId}","name":"a","name":"b"}`);
    if (mode === "malformed") writeFileSync(f.configA, "{broken");
    if (mode === "outside") request = { ...request, config: "../wrangler.jsonc" };
    if (mode === "hardlink" || mode === "symlink") {
      rmSync(f.configA);
      try { (mode === "hardlink" ? linkSync : symlinkSync)(f.configB, f.configA); }
      catch (error) { if (mode === "symlink" && process.platform === "win32" && error.code === "EPERM") { t.skip("Windows file-symlink privilege unavailable; directory junction is tested separately"); return; } throw error; }
      // Discovery ignores a file symlink and may still find another valid config.
      // Explicit selection must reject the unsafe file rather than selecting a different one.
      request = { ...request, config: "wrangler.jsonc" };
    }
    if (mode === "junction") { symlinkSync(join(f.app, "deploy"), join(f.app, "shared"), process.platform === "win32" ? "junction" : "dir"); request = { ...request, config: "shared/wrangler.toml" }; }
    assert.throws(() => prepareTarget(request, f.io)); assert.equal(f.catalog().destinations.length, 0); assert.equal(f.counts().reads, 0);
  });
  withFixture("native metadata display and fresh OS verification contain no value path or approval input", async f => {
    const targetPlan = prepareTarget(f.targetRequest, f.io), targetScript = buildWindowsTargetScript(targetPlan);
    assert.match(targetScript, /SelectedIndex=-1/); assert.doesNotMatch(targetScript, /CredRead|CredWrite|Write-Output|WriteAllText/);
    const target = await f.register(), request = { project: f.app, bindingId: f.catalog().bindings[0].id, targetId: target.targetId };
    const script = buildWindowsVNextUseScript(prepareUse(request, f.io), "C:/trusted/wrangler.cmd");
    assert.match(script, /Invoke-ApiKeyCaseUserVerification/); assert.match(script, /\$code -eq 0/); assert.match(script, /immediately/);
    assert.ok(encodeWindowsHelperCommand(script).length < 29000); assert.doesNotMatch(script, /CredRead|CredWrite|Write-Output|WriteAllText/);
  });
  withFixture("delivery started within consent deadline completes after 61 seconds and permits a new reviewed operation", async f => {

    const target = await f.register(), request = { project: f.app, bindingId: f.catalog().bindings[0].id, targetId: target.targetId };
    let clock = 0; f.io.now = () => clock;
    f.io.handoff = (plan, execution, current) => runGenericCloudflareDeployment(plan, execution, async phase => {
      if (phase === "completion") clock += 61000;
      return current(phase);
    });
    for (let n = 0; n < 2; n++) {
      const result = await applyUse(request, prepareUse(request, f.io).fingerprint, f.io);
      assert.equal(result.status, "completed"); assert.equal(useOperationStatus(result.operationId, f.store).status, "completed");
    }
    assert.equal(f.events().length, 2); assert.equal(f.counts().reads, 2);
  });
  withFixture("post-deadline completion still rejects generation drift and blocks automatic replay", async f => {
    const target = await f.register(), request = { project: f.app, bindingId: f.catalog().bindings[0].id, targetId: target.targetId };
    let clock = 0; f.io.now = () => clock;
    f.io.handoff = (plan, execution, current) => runGenericCloudflareDeployment(plan, execution, async phase => {
      if (phase === "completion") { clock = 61000; f.catalog().credentials[0].generation++; f.catalog().credentials[0].locator.generationId = randomUUID(); }
      return current(phase);
    });
    const result = await applyUse(request, prepareUse(request, f.io).fingerprint, f.io);
    assert.equal(result.status, "unknown");
    assert.equal((await applyUse(request, prepareUse(request, f.io).fingerprint, f.io)).status, "recovery-required");
    assert.equal(f.events().length, 1); assert.equal(f.counts().reads, 1);
  });

}
