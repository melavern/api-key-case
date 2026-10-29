import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { listProfiles, prepareProfile, registerProfile, projectProfilePlan, prepareLaunch, applyLaunch, projectLaunchPlan, launchOperationStatus } from "../dist/core/vnext/launch.js";
import { emptyCatalog, validate, catalogSchema, operationSchema } from "../dist/core/vnext/model.js";
import { inspectProject } from "../dist/core/vnext/project.js";
import { saveLicenseKey } from "../dist/core/license.js";
import { buildWindowsLaunchReview } from "../dist/core/human/windows-launch.js";
import { VNEXT_WINDOWS_LOCAL_ACCEPTED } from "../dist/core/vnext/gates.js";
import { runGenericLocalApplication } from "../dist/core/deploy/handoff.js";
import { capabilities } from "../dist/core/vnext/status.js";
import { runSecretCommand } from "../dist/cli/secret.js";

if (!process.env.AKC_DISPOSABLE_LOCAL_TEST) {
  test("ordinary local execution is accepted only on Windows with a backend", () => {
    assert.equal(VNEXT_WINDOWS_LOCAL_ACCEPTED, true); assert.equal(capabilities("win32", "available", 22000).localUse.state, "available");
    for (const platform of ["linux", "darwin"]) assert.notEqual(capabilities(platform, "available", 22000).localUse.state, "available");
    assert.equal(capabilities("win32", "unavailable", 22000).localUse.state, "unavailable");
  });
  test("isolated local profile and approval state machine", () => {
    const repo = fileURLToPath(new URL("..", import.meta.url)), root = realpathSync.native(mkdtempSync(join(tmpdir(), "akc-profile-tests-")));
    try {
      cpSync(join(repo, "dist"), join(root, "dist"), { recursive: true }); mkdirSync(join(root, "tests")); mkdirSync(join(root, "node_modules"));
      cpSync(fileURLToPath(import.meta.url), join(root, "tests/vnext-local.mjs")); writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", private: true }));
      for (const name of readdirSync(join(repo, "node_modules"))) {
        if (name === "@napi-rs") continue;
        const from = join(repo, "node_modules", name), to = join(root, "node_modules", name);
        if (statSync(from).isDirectory()) symlinkSync(from, to, process.platform === "win32" ? "junction" : undefined); else cpSync(from, to);
      }
      const mock = join(root, "node_modules/@napi-rs/keyring"); mkdirSync(mock, { recursive: true });
      writeFileSync(join(mock, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
      writeFileSync(join(mock, "index.js"), "export class Entry { getPassword(){if(globalThis.syntheticLocalRead)return globalThis.syntheticLocalRead();throw Error('No OS reads');} setPassword(){throw Error('No OS writes');} }");
      for (const name of ["gates", "launch"]) {
        const path = join(root, `dist/core/vnext/${name}.js`), source = readFileSync(path, "utf8");
        writeFileSync(path, name === "gates" ? source.replace(/VNEXT_WINDOWS_LOCAL_ACCEPTED = (?:false|true)/, "VNEXT_WINDOWS_LOCAL_ACCEPTED = true") :
          source.replace('!VNEXT_WINDOWS_LOCAL_ACCEPTED || process.platform !== "win32"', "!VNEXT_WINDOWS_LOCAL_ACCEPTED"));
      }
      const env = { ...process.env, AKC_DISPOSABLE_LOCAL_TEST: "1" }; delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(root, "tests/vnext-local.mjs")], { env, encoding: "utf8", timeout: 120000 });
      assert.equal(result.error, undefined); assert.doesNotMatch(result.stdout + result.stderr, /akc-synthetic-rotation/);
      process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.equal(result.status, 0);
      assert.ok(Number(result.stdout.match(/^# tests (\d+)$/m)?.[1]) >= 18);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
} else {
  const keys = generateKeyPairSync("ed25519"), payload = Buffer.from(JSON.stringify({ v: 1, plan: "pro", id: "synthetic-local", issuedAt: "2026-10-21" })).toString("base64url"), signed = `AKC1.${payload}`;
  const license = `${signed}.${sign(null, Buffer.from(signed), keys.privateKey).toString("base64url")}`;
  function fixture(realRuntime = false) {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "akc-profile-state-"))), app = join(root, "app"), home = join(root, "home"), runtime = realRuntime ? process.execPath : join(root, process.platform === "win32" ? "node.exe" : "node");
    mkdirSync(app); mkdirSync(home); if (!realRuntime) writeFileSync(runtime, "synthetic non-executed runtime"); writeFileSync(join(app, "main.cjs"), "// editable source");
    let catalog = emptyCatalog(), snapshot, approved = "approved", profileDecision = "approved", locked = false, presence = "present", handoffs = 0, approvals = 0;
    const operations = new Map(), projectId = randomUUID(), environmentId = randomUUID(), now = new Date().toISOString();
    catalog.projects.push({ ...inspectProject(app), id: projectId, revision: 1 }); catalog.environments.push({ id: environmentId, projectId, label: "development", risk: "nonproduction", revision: 1 });
    for (const name of ["OTHER_KEY", "arbitrary_b_key"]) {
      const id = randomUUID(); catalog.credentials.push({ id, label: "PRIVATE_ISSUER", locator: { kind: "v3", id, generationId: randomUUID() }, generation: 1, classification: "nonproduction", createdAt: now, revisedAt: now });
      catalog.bindings.push({ id: randomUUID(), projectId, environmentId, variableName: name, credentialId: id, revision: 1 });
    }
    snapshot = { catalog, file: {} };
    const store = { readCatalog: () => snapshot, readOperation: id => operations.get(id) ?? null,
      compareAndSwap: (before, after) => { assert.equal(before, snapshot); catalog = validate(catalogSchema, structuredClone(after)); snapshot = { catalog, file: {} }; return snapshot; },
      saveOperation: (before, after) => { assert.equal(before, operations.get(after.operationId) ?? null); validate(operationSchema, after); const record = { operation: structuredClone(after), file: {} }; operations.set(after.operationId, record); return record; },
      listLaunchOperations: id => [...operations.values()].map(r => r.operation).filter(o => o.kind === "local-launch" && o.boundBasis.targetId === id),
      withUseLock: async (_a, _b, action) => { if (locked) throw Error(); locked = true; try { return await action(() => locked); } finally { locked = false; } } };
    saveLicenseKey(license, home);
    const io = { store, human: { confirm: async () => profileDecision, approve: async () => { approvals++; return approved; } }, licenseOptions: { baseDir: home, publicKey: keys.publicKey },
      presence: async () => presence, legacy: async () => ({ status: "available", locators: [] }), handoff: async (_plan, current, launched) => {
        handoffs++; assert.equal(await current(), true); launched(); return { status: "exited", execution: "possible", treeTermination: "confirmed" }; } };
    const request = { project: app, kind: "node-entry", runtime, entry: "main.cjs", cwd: ".", bindingIds: catalog.bindings.map(b => b.id), maxDurationSeconds: 7200 };
    const f = { root, app, home, runtime, request, io, store, operations, catalog: () => catalog, snapshot: () => snapshot, approve: v => { approved = v; }, profileDecision: v => { profileDecision = v; },
      presence: v => { presence = v; }, lose: () => { locked = false; }, counts: () => ({ handoffs, approvals }),
      register: async () => registerProfile(request, prepareProfile(request, io).fingerprint, io),
      launch: id => ({ project: app, profileId: id }), close: () => rmSync(root, { recursive: true, force: true }) };
    return f;
  }
  const scenario = (name, work, realRuntime = false) => test(name, async () => { const f = fixture(realRuntime); try { await work(f); } finally { delete globalThis.syntheticLocalRead; f.close(); } });
  scenario("a fresh agent discovers project-only profiles and resumes without another registration", async f => {
    const registered = await f.register(), revision = f.catalog().revision;
    const agent = { ...f.io, human: { confirm: async () => { throw Error("No registration UI"); }, approve: f.io.human.approve } };
    const list = listProfiles(f.app, agent); assert.deepEqual(list.profiles.map(p => p.profileId), [registered.profileId]);
    const output = [], log = console.log;
    try {
      console.log = line => output.push(JSON.parse(line));
      assert.equal(await runSecretCommand(["profile", "list", "--project", f.app, "--json"], agent), process.platform === "win32" ? 0 : 1);
      assert.equal(await runSecretCommand(["profile", "list", "--project", f.home, "--json"], agent), process.platform === "win32" ? 0 : 1);
      assert.equal(await runSecretCommand(["profile", "list", "--project", f.app, "--fingerprint", "forbidden", "--json"], agent), 1);
    } finally { console.log = log; }
    if (process.platform === "win32") {
      assert.deepEqual(output[0].profiles, list.profiles); assert.deepEqual(output[1].profiles, []);
    } else {
      assert.equal(output[0].status, "unavailable"); assert.equal(output[1].status, "unavailable");
    }
    assert.equal(output[2].status, "unavailable");
    assert.doesNotMatch(JSON.stringify(list), /PRIVATE_|runtimeIdentity|canonicalPath|main.cjs/);
    assert.deepEqual(listProfiles(f.home, agent).profiles, []);
    const plan = prepareProfile(f.request, agent); assert.equal(projectProfilePlan(plan).profileId, registered.profileId);
    assert.equal((await registerProfile(f.request, plan.fingerprint, agent)).status, "unchanged");
    assert.equal(f.catalog().revision, revision); assert.equal(f.catalog().launchProfiles.length, 1);
    const launch = f.launch(list.profiles[0].profileId);
    assert.equal((await applyLaunch(launch, prepareLaunch(launch, agent).fingerprint, agent)).status, "exited");
  });
  scenario("profile registration requires independent human confirmation and preserves old records", async f => {
    const before = structuredClone(f.catalog().credentials), plan = prepareProfile(f.request, f.io), projected = projectProfilePlan(plan);
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_ISSUER|runtimeIdentity|canonicalPath|main.cjs/);
    const result = await f.register(); assert.equal(result.status, "completed"); assert.deepEqual(f.catalog().credentials, before); assert.equal(f.catalog().launchProfiles.length, 1);
    assert.ok(result.profileId); assert.equal(f.catalog().launchProfiles[0].maxDurationSeconds, 7200);
  });
  scenario("declined metadata registration performs no CAS", async f => { f.profileDecision("declined"); assert.equal((await f.register()).status, "cancelled"); assert.equal(f.catalog().launchProfiles.length, 0); });
  scenario("changed proposal fingerprint performs no UI or write", async f => { assert.equal((await registerProfile(f.request, "f".repeat(64), f.io)).status, "changed"); assert.equal(f.catalog().launchProfiles.length, 0); });
  scenario("profile revision update requires another human registration", async f => {
    const result = await f.register(), update = { ...f.request, profileId: result.profileId, maxDurationSeconds: 60 };
    assert.equal((await registerProfile(update, prepareProfile(update, f.io).fingerprint, f.io)).status, "completed"); assert.equal(f.catalog().launchProfiles.length, 1); assert.equal(f.catalog().launchProfiles[0].revision, 2);
  });
  scenario("unsafe variables, argv, shell and duplicate bindings are rejected", async f => {
    for (const patch of [{ entry: "../main.cjs" }, { kind: "shell" }, { argv: ["-e"] }, { environment: { KEY: "x" } }, { maxDurationSeconds: 7201 }, { bindingIds: [f.request.bindingIds[0], f.request.bindingIds[0]] }]) assert.throws(() => prepareProfile({ ...f.request, ...patch }, f.io));
    f.catalog().bindings[0].variableName = "NODE_OPTIONS"; assert.throws(() => prepareProfile(f.request, f.io));
  });
  scenario("Pro precedes even read-only launch metadata access", async f => {
    const result = await f.register(); let reads = 0;
    assert.throws(() => prepareLaunch(f.launch(result.profileId), { store: { readCatalog: () => { reads++; throw Error(); } }, licenseOptions: { baseDir: join(f.root, "missing") } })); assert.equal(reads, 0);
  });
  scenario("successful launch journals before handoff and status never grants replay", async f => {
    const registered = await f.register(), request = f.launch(registered.profileId), plan = prepareLaunch(request, f.io);
    assert.equal(projectLaunchPlan(plan).appReadable, true); assert.doesNotMatch(JSON.stringify(projectLaunchPlan(plan)), /PRIVATE_ISSUER|runtimeIdentity|main.cjs/);
    const result = await applyLaunch(request, plan.fingerprint, f.io); assert.equal(result.status, "exited"); assert.equal(result.treeTermination, "confirmed");
    const observation = launchOperationStatus(result.operationId, f.store); assert.equal(observation.executed, false); assert.equal(observation.replay, "not-permitted"); assert.equal(f.counts().handoffs, 1);
  });
  scenario("declined OS approval never calls handoff", async f => {
    const r = await f.register(), request = f.launch(r.profileId); f.approve("declined"); const result = await applyLaunch(request, prepareLaunch(request, f.io).fingerprint, f.io);
    assert.equal(result.status, "cancelled"); assert.equal(f.counts().handoffs, 0);
  });
  scenario("unavailable presence never approves or launches", async f => {
    const r = await f.register(), request = f.launch(r.profileId); f.presence("unavailable"); assert.equal((await applyLaunch(request, prepareLaunch(request, f.io).fingerprint, f.io)).status, "changed"); assert.deepEqual(f.counts(), { handoffs: 0, approvals: 0 });
  });
  scenario("generation drift during approval invalidates the launch", async f => {
    const r = await f.register(), request = f.launch(r.profileId); f.io.human.approve = async () => { f.catalog().credentials[0].locator.generationId = randomUUID(); f.catalog().credentials[0].generation++; return "approved"; };
    assert.equal((await applyLaunch(request, prepareLaunch(request, f.io).fingerprint, f.io)).status, "changed"); assert.equal(f.counts().handoffs, 0);
  });
  scenario("loss of lock after approval prevents handoff", async f => {
    const r = await f.register(), request = f.launch(r.profileId); f.io.human.approve = async () => { f.lose(); return "approved"; };
    assert.equal((await applyLaunch(request, prepareLaunch(request, f.io).fingerprint, f.io)).status, "changed"); assert.equal(f.counts().handoffs, 0);
  });
  scenario("unknown execution cannot reopen approval or replay", async f => {
    const r = await f.register(), request = f.launch(r.profileId); f.io.handoff = async () => ({ status: "unknown", execution: "possible", treeTermination: "unknown" });
    const one = await applyLaunch(request, prepareLaunch(request, f.io).fingerprint, f.io); assert.equal(one.status, "unknown");
    const two = await applyLaunch(request, prepareLaunch(request, f.io).fingerprint, f.io); assert.equal(two.status, "recovery-required"); assert.equal(f.counts().approvals, 1);
  });
  scenario("source edits are allowed but runtime modification invalidates a registered profile", async f => {
    const r = await f.register(), request = f.launch(r.profileId), before = prepareLaunch(request, f.io).fingerprint;
    writeFileSync(join(f.app, "main.cjs"), "// another edit"); assert.equal(prepareLaunch(request, f.io).fingerprint, before);
    writeFileSync(f.runtime, "changed runtime"); assert.throws(() => prepareLaunch(request, f.io));
  });
  scenario("a changed generation while running stops the session with confirmed ownership", async f => {
    const r = await f.register(), request = f.launch(r.profileId);
    f.io.handoff = async (_plan, current, launched) => { launched(); f.catalog().credentials[0].generation++; f.catalog().credentials[0].locator.generationId = randomUUID();
      assert.equal(await current(), false); return { status: "changed", execution: "possible", treeTermination: "confirmed" }; };
    const result = await applyLaunch(request, prepareLaunch(request, f.io).fingerprint, f.io); assert.equal(result.status, "changed"); assert.equal(result.treeTermination, "confirmed");
  });
  scenario("a failed pre-execution journal never enters handoff", async f => {
    const r = await f.register(), request = f.launch(r.profileId), save = f.store.saveOperation;
    f.store.saveOperation = (old, next) => { if (next.state === "prepared") throw Error(); return save(old, next); };
    assert.equal((await applyLaunch(request, prepareLaunch(request, f.io).fingerprint, f.io)).status, "unknown"); assert.equal(f.counts().handoffs, 0);
  });
  scenario("expired fresh approval fails at the handoff boundary", async f => {
    const r = await f.register(), request = f.launch(r.profileId); let clock = 0; f.io.now = () => clock;
    f.io.handoff = async (_plan, current) => { clock = 61000; assert.equal(await current(), false); return { status: "changed", execution: "not-started", treeTermination: "not-needed" }; };
    assert.equal((await applyLaunch(request, prepareLaunch(request, f.io).fingerprint, f.io)).status, "changed");
  });
  scenario("license loss after approval prevents every value-bearing operation", async f => {
    const r = await f.register(), request = f.launch(r.profileId);
    f.io.human.approve = async () => { rmSync(join(f.home, ".api-key-case"), { recursive: true, force: true }); return "approved"; };
    assert.equal((await applyLaunch(request, prepareLaunch(request, f.io).fingerprint, f.io)).status, "changed"); assert.equal(f.counts().handoffs, 0);
  });
  scenario("native confirmation explains app-readable dependencies, duration and fresh OS verification", async f => {
    const plan = prepareProfile(f.request, f.io), script = buildWindowsLaunchReview(plan, true);
    assert.match(script, /Invoke-ApiKeyCaseUserVerification/); assert.match(script, /7200/); assert.match(script, /App, dependencies and children can read keys/);
    assert.match(script, /AcceptButton=\$cancel/); assert.match(script, /OTHER_KEY/);
  });
  if (process.platform === "win32") scenario("actual generic handoff stops a native owned app after credential generation rotation", async f => {
    const heartbeat = join(f.app, "heartbeat"); writeFileSync(join(f.app, "main.cjs"), `const fs=require('fs');if(process.env.OTHER_KEY!=='akc-synthetic-rotation')process.exit(31);console.log(process.env.OTHER_KEY);setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),25);`);
    globalThis.syntheticLocalRead = () => "akc-synthetic-rotation";
    const r = await f.register(), request = f.launch(r.profileId);
    f.io.handoff = (plan, current, launched, signal) => runGenericLocalApplication(plan, current, () => {
      launched(); setTimeout(() => { f.catalog().credentials[0].generation++; f.catalog().credentials[0].locator.generationId = randomUUID(); }, 150);
    }, signal);
    const result = await applyLaunch(request, prepareLaunch(request, f.io).fingerprint, f.io);
    assert.equal(result.status, "changed"); assert.equal(result.treeTermination, "confirmed");
    const before = readFileSync(heartbeat, "utf8"); await new Promise(resolve => setTimeout(resolve, 250)); assert.equal(readFileSync(heartbeat, "utf8"), before);
  }, true);
}
