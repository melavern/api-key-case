import assert from "node:assert/strict";
import { registerCredential } from "../dist/core/vnext/input.js";
import { applyBinding, prepareBinding } from "../dist/core/vnext/binding.js";
import { listProfiles, prepareProfile, projectProfilePlan, registerProfile, prepareLaunch } from "../dist/core/vnext/launch.js";
import { test } from "node:test";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { emptyCatalog, catalogSchema, operationSchema, validate, locatorAccount } from "../dist/core/vnext/model.js";
import { inspectProject } from "../dist/core/vnext/project.js";
import { prepareHostedTarget, registerHostedTarget, projectHostedTargetPlan } from "../dist/core/vnext/hosted-target.js";
import { prepareHostedUse, projectHostedUsePlan, applyHostedUse } from "../dist/core/vnext/hosted-use.js";
import { useOperationStatus } from "../dist/core/vnext/use.js";
import { runGenericHostedDeployment } from "../dist/core/deploy/handoff.js";
import { hostedDeploymentPlan } from "../dist/core/deploy/hosted-targets.js";
import { buildWindowsHostedUseScript } from "../dist/core/human/windows-hosted.js";
import { saveLicenseKey } from "../dist/core/license.js";
import { VNEXT_WINDOWS_VERCEL_ACCEPTED, VNEXT_WINDOWS_GITHUB_ACCEPTED } from "../dist/core/vnext/gates.js";

if (!process.env.AKC_DISPOSABLE_HOSTED_TEST) {
  test("Vercel/GitHub routes are independently accepted on Windows", () => { assert.equal(VNEXT_WINDOWS_VERCEL_ACCEPTED, true); assert.equal(VNEXT_WINDOWS_GITHUB_ACCEPTED, true); });
  test("isolated hosted registration, identities, approval, fixed stdin and no replay", () => {
    const repo = fileURLToPath(new URL("..", import.meta.url)), root = mkdtempSync(join(tmpdir(), "akc-hosted-tests-"));
    try {
      cpSync(join(repo, "dist"), join(root, "dist"), { recursive: true }); mkdirSync(join(root, "tests")); mkdirSync(join(root, "node_modules"));
      cpSync(fileURLToPath(import.meta.url), join(root, "tests/vnext-hosted.mjs")); writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", private: true }));
      for (const name of readdirSync(join(repo, "node_modules"))) {
        if (name === "@napi-rs") continue; const from = join(repo, "node_modules", name), to = join(root, "node_modules", name);
        if (statSync(from).isDirectory()) symlinkSync(from, to, process.platform === "win32" ? "junction" : undefined); else cpSync(from, to);
      }
      const mock = join(root, "node_modules/@napi-rs/keyring"); mkdirSync(mock, { recursive: true });
      writeFileSync(join(mock, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
      writeFileSync(join(mock, "index.js"), "export class Entry { constructor(service,account){this.account=account;} getPassword(){return globalThis.syntheticHostedRead(this.account);} setPassword(){throw Error('No OS writes');} }");
      const gatesPath = join(root, "dist/core/vnext/gates.js"); writeFileSync(gatesPath, readFileSync(gatesPath, "utf8").replace(/VNEXT_WINDOWS_(VERCEL|GITHUB)_ACCEPTED = (?:false|true)/g, "VNEXT_WINDOWS_$1_ACCEPTED = true"));
      for (const name of ["vnext/hosted-use", "deploy/handoff"]) {
        const path = join(root, `dist/core/${name}.js`), source = readFileSync(path, "utf8"), guard = '!hostedUseAccepted(plan.destination.kind) || process.platform !== "win32"';
        assert.equal(source.split(guard).length, 2); writeFileSync(path, source.replace(guard, "!hostedUseAccepted(plan.destination.kind)"));
      }
      const path = join(root, "dist/core/deploy/handoff.js"), source = readFileSync(path, "utf8");
      assert.equal(source.split("const hostedTimeoutMs = 120_000;").length, 2); writeFileSync(path, source.replace("const hostedTimeoutMs = 120_000;", "const hostedTimeoutMs = 1000;"));
      const env = { ...process.env, AKC_DISPOSABLE_HOSTED_TEST: "1" }; delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(root, "tests/vnext-hosted.mjs")], { env, encoding: "utf8", timeout: 180000, maxBuffer: 1024 * 1024 });
      assert.equal(result.error, undefined); assert.doesNotMatch(result.stdout + result.stderr, /synthetic-hosted-stdin-WC37|synthetic-ho/);
      process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.equal(result.status, 0); assert.ok(Number(result.stdout.match(/^# tests (\d+)$/m)?.[1]) >= 26);
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  });
} else {
  const canary = "synthetic-hosted-stdin-WC37", keys = generateKeyPairSync("ed25519"), payload = Buffer.from(JSON.stringify({ v: 1, plan: "pro", id: "synthetic-hosted", issuedAt: "2026-10-21" })).toString("base64url"), signed = `AKC1.${payload}`;
  const license = `${signed}.${sign(null, Buffer.from(signed), keys.privateKey).toString("base64url")}`;
  function fixture(kind = "vercel", environment = kind === "vercel" ? "preview" : "repository") {
    const root = mkdtempSync(join(tmpdir(), "akc-hosted-case-")), app = join(root, "app"), home = join(root, "home"), bin = join(root, "bin");
    for (const path of [app, home, bin, join(app, ".vercel"), join(app, ".git")]) mkdirSync(path);
    const link = join(app, ".vercel/project.json"), git = join(app, ".git/config");
    writeFileSync(link, JSON.stringify({ orgId: "team_Synthetic", projectId: "prj_Synthetic", privateMarker: "PRIVATE_TARGET" }));
    writeFileSync(git, '[core]\n bare = false\n[remote "origin"]\n url = https://github.com/synthetic-owner/synthetic-repo.git\n');
    let catalog = emptyCatalog(), snapshot, locked = false, approval = "approved", confirm = "approved", reads = 0, approvals = 0, probes = 0;
    const operations = new Map(), projectId = randomUUID(), environmentId = randomUUID(), time = new Date().toISOString();
    catalog.projects.push({ ...inspectProject(app), id: projectId, revision: 1 }); catalog.environments.push({ id: environmentId, projectId, label: "development", risk: "nonproduction", revision: 1 });
    for (const variableName of ["CUSTOM_A_KEY", "arbitrary_b_key"]) { const id = randomUUID(); catalog.credentials.push({ id, label: "PRIVATE_ISSUER", locator: { kind: "v3", id, generationId: randomUUID() }, generation: 1, classification: "nonproduction", createdAt: time, revisedAt: time }); catalog.bindings.push({ id: randomUUID(), projectId, environmentId, variableName, credentialId: id, revision: 1 }); }
    snapshot = { catalog, file: {} };
    const store = { readCatalog: () => snapshot, readOperation: id => operations.get(id) ?? null,
      compareAndSwap: (old, after) => { assert.equal(old, snapshot); catalog = validate(catalogSchema, structuredClone(after)); snapshot = { catalog, file: {} }; return snapshot; },
      saveOperation: (old, after) => { assert.equal(old, operations.get(after.operationId) ?? null); validate(operationSchema, after); const record = { operation: structuredClone(after), file: {} }; operations.set(after.operationId, record); return record; },
      listUseOperations: (binding, target) => [...operations.values()].map(r => r.operation).filter(o => o.bindingId === binding && o.boundBasis.targetId === target),
      withUseLock: async (_binding, _target, work) => { if (locked) throw Error(); locked = true; try { return await work(() => locked); } finally { locked = false; } } };
    saveLicenseKey(license, home);
    const identity = kind === "vercel" ? "user:synthetic-user,team:team_Synthetic,project:prj_Synthetic" : `user:synthetic-user,id:11,repo:22,owner:33,environment:${environment === "repository" ? "repository" : "44"}`;
    const io = { store, licenseOptions: { baseDir: home, publicKey: keys.publicKey }, pathOverride: bin, presence: async () => "present", legacy: async () => ({ status: "available", locators: [] }),
      human: { confirm: async () => confirm, approve: async () => { approvals++; return approval; } },
      probe: async () => { probes++; return { installed: true, loggedIn: true, version: kind === "vercel" ? "59.11.7" : "2.96.0", identity }; }, handoff: runGenericHostedDeployment };
    const marker = join(root, "events.json"), provider = join(bin, "provider.cjs"), mode = join(root, "mode");
    writeFileSync(mode, "success");
    writeFileSync(provider, `const fs=require('fs');const kind=process.argv[2],a=process.argv.slice(3),mode=fs.readFileSync(${JSON.stringify(mode)},'utf8');if(a[0]==='--version'){console.log(kind==='vercel'?'59.11.7':'gh version 2.96.0');process.exit(0);}if(a[0]==='whoami'){console.log(JSON.stringify({username:'synthetic-user',team:{id:'team_Synthetic'}}));process.exit(0);}if(a[0]==='project'){console.error('> Found Project synthetic-team/synthetic-project [1ms]\\n\\n  General\\n\\n    \\x1b[36mID\\x1b[39m\\t\\t\\t\\tprj_Synthetic\\n    Name\\t\\t\\tsynthetic-project\\n    Owner\\t\\t\\tSynthetic Team\\n');process.exit(0);}if(a[0]==='auth')process.exit(0);if(a[0]==='api'){const endpoint=a[5];console.log(JSON.stringify(endpoint==='user'?[11,'synthetic-user']:endpoint.includes('/environments/')?[44,${JSON.stringify(environment)}]:[22,'synthetic-owner/synthetic-repo',33]));process.exit(0);}if(!['CUSTOM_A_KEY','arbitrary_b_key'].includes(a[kind==='vercel'?2:2]))process.exit(41);if(kind==='vercel'&&(!a.includes('--sensitive')||!a.includes('--force')||a[a.indexOf('--scope')+1]!=='team_Synthetic'||a[a.indexOf('--project')+1]!=='prj_Synthetic'))process.exit(42);if(kind==='gh'&&(a[a.indexOf('--app')+1]!=='actions'||a[a.indexOf('--repo')+1]!=='github.com/synthetic-owner/synthetic-repo'||process.env.GH_HOST!=='github.com'))process.exit(43);let value='';process.stdin.on('data',c=>value+=c);process.stdin.on('end',()=>{if(value!==${JSON.stringify(canary)})process.exit(44);const events=fs.existsSync(${JSON.stringify(marker)})?JSON.parse(fs.readFileSync(${JSON.stringify(marker)},'utf8')):[];events.push(a);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(events));console.log(value);console.error(value.slice(0,12));if(mode==='fail')process.exit(45);if(mode==='timeout')setTimeout(()=>process.exit(0),4000);});`);
    for (const command of ["vercel", "gh"]) {
      const path = join(bin, process.platform === "win32" ? `${command}.cmd` : command);
      writeFileSync(path, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${provider}" ${command} %*\r\n` : `#!${process.execPath}\nprocess.argv.splice(2,0,${JSON.stringify(command)});import(${JSON.stringify(pathToFileURL(provider).href)});\n`, { mode: 0o700 });
    }
    globalThis.syntheticHostedRead = account => { reads++; assert.ok(catalog.credentials.some(c => locatorAccount(c.locator) === account)); assert.equal([...operations.values()].at(-1).operation.state, "executing"); return canary; };
    const request = { project: app, kind, environment }, f = { root, app, home, bin, link, git, mode, kind, environment, store, io, request, identity,
      register: async () => registerHostedTarget(request, prepareHostedTarget(request, io).fingerprint, io),
      use: target => ({ project: app, bindingId: catalog.bindings[0].id, targetId: target }), catalog: () => catalog, counts: () => ({ reads, approvals, probes }),
      approve: v => { approval = v; }, confirm: v => { confirm = v; }, lose: () => { locked = false; }, events: () => existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : [], cleanupDelay: 0,
      close: async () => { if (f.cleanupDelay) await new Promise(done => setTimeout(done, f.cleanupDelay)); delete globalThis.syntheticHostedRead; rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } };
    return f;
  }
  const scenario = (name, work, kind = "vercel", environment) => test(name, async () => { const f = fixture(kind, environment); try { await work(f); } finally { await f.close(); } });
  scenario("opaque target plan, independent registration, duplicate detection and no old catalog changes", async f => {
    const before = structuredClone(f.catalog().credentials); assert.doesNotMatch(JSON.stringify(projectHostedTargetPlan(prepareHostedTarget(f.request, f.io))), /PRIVATE_|team_Synthetic|prj_Synthetic|canonical/);
    assert.equal((await f.register()).status, "completed"); assert.equal((await f.register()).status, "unchanged"); assert.equal(f.catalog().destinations.length, 1); assert.deepEqual(f.catalog().credentials, before);
  });
  scenario("cancelled target registration performs no write", async f => { f.confirm("declined"); assert.equal((await f.register()).status, "cancelled"); assert.equal(f.catalog().destinations.length, 0); });
  scenario("Vercel inspect requires a unique bounded stderr ID and successful exit", async f => {
    delete f.io.probe; const target = await f.register(), request = f.use(target.targetId);
    for (const [stdout, stderr, status] of [
      ["    ID\t\t\t\tprj_Synthetic\n", "", 0],
      ["    ID\tprj_Synthetic\n", "    ID\tprj_Other\n", 0],
      ["", "    ID\tprj_Synthetic\n    ID\tprj_Synthetic\n", 0],
      ["", "x".repeat(16385), 0],
      ["", "    ID\tprj_Synthetic\n", 1],
      ["", "    ID\tinvalid-project\n", 0]
    ]) {
      writeFileSync(join(f.bin, "provider.cjs"), `const a=process.argv.slice(3);if(a[0]==='--version'){console.log('59.11.7');process.exit(0);}if(a[0]==='whoami'){console.log(JSON.stringify({username:'synthetic-user',team:{id:'team_Synthetic'}}));process.exit(0);}process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(${status});`);
      assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "unavailable");
    }
    assert.equal(f.counts().approvals, 0); assert.equal(f.counts().reads, 0); assert.equal(f.events().length, 0);
  });
  scenario("duplicate project keys and repository links fail closed", async f => {
    writeFileSync(f.link, '{"orgId":"team_Synthetic","projectId":"prj_Synthetic","projectId":"prj_Other"}'); assert.throws(() => prepareHostedTarget(f.request, f.io));
    writeFileSync(f.link, '{"orgId":"team_Synthetic","projectId":"prj_Synthetic"}'); writeFileSync(join(f.app, ".vercel/repo.json"), "{}"); assert.throws(() => prepareHostedTarget(f.request, f.io));
  });
  scenario("hardlinked configuration is refused before approval", async f => { const saved = readFileSync(f.link); rmSync(f.link); const other = join(f.root, "outside.json"); writeFileSync(other, saved); linkSync(other, f.link); assert.throws(() => prepareHostedTarget(f.request, f.io)); });
  scenario("GitHub repo target rejects included or redirected remotes", async f => { writeFileSync(f.git, '[include]\npath = outside\n[remote "origin"]\nurl = https://github.com/synthetic-owner/synthetic-repo.git\n'); assert.throws(() => prepareHostedTarget(f.request, f.io)); }, "github-actions");
  for (const kind of ["vercel", "github-actions"]) scenario(`${kind}: two arbitrary bindings use fixed stdin with fresh approval per operation`, async f => {
    const target = await f.register();
    for (const binding of f.catalog().bindings) { const request = { ...f.use(target.targetId), bindingId: binding.id }, plan = prepareHostedUse(request, f.io);
      assert.doesNotMatch(JSON.stringify(projectHostedUsePlan(plan)), /PRIVATE_|team_Synthetic|prj_Synthetic|synthetic-owner|canonicalPath/);
      const result = await applyHostedUse(request, plan.fingerprint, f.io); assert.equal(result.status, "completed"); assert.equal(useOperationStatus(result.operationId, f.store).executed, false); }
    assert.equal(f.counts().reads, 2); assert.equal(f.counts().approvals, 2); assert.equal(f.events().length, 2);
  }, kind);
  for (const kind of ["vercel", "github-actions"]) scenario(`${kind}: real thin adapter probes the exact CLI identity before and after approval`, async f => {
    delete f.io.probe; const target = await f.register(), request = f.use(target.targetId); assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "completed");
  }, kind, kind === "github-actions" ? "development" : "preview");
  scenario("GitHub named environment is explicit and never falls back to repository", async f => {
    const target = await f.register(), request = f.use(target.targetId); assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "completed");
    assert.equal(f.events()[0].at(-1), "development"); assert.ok(f.events()[0].includes("--env"));
  }, "github-actions", "development");
  scenario("GitHub repository thin adapter omits environment lookup and fixes Actions only", async f => {
    delete f.io.probe; const target = await f.register(), request = f.use(target.targetId);
    assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "completed");
    assert.equal(f.events()[0].includes("--env"), false); assert.equal(f.events()[0][f.events()[0].indexOf("--app") + 1], "actions");
  }, "github-actions");
  scenario("Pro precedes read-only metadata access", async f => { let reads = 0; assert.throws(() => prepareHostedUse({ project: f.app, bindingId: randomUUID(), targetId: randomUUID() }, { store: { readCatalog: () => { reads++; throw Error(); } }, licenseOptions: { baseDir: join(f.root, "missing") } })); assert.equal(reads, 0); });
  scenario("Vercel development also uses sensitive storage and fixed overwrite without remove-first", async f => { const target = await f.register(), request = f.use(target.targetId), plan = prepareHostedUse(request, f.io), command = hostedDeploymentPlan(plan.destination, plan.binding.variableName); assert.equal(command.preSteps, undefined); assert.ok(command.argv.includes("--sensitive")); assert.ok(command.argv.includes("--force")); assert.equal(projectHostedUsePlan(plan).placementEffect, "variable-registration-without-app-deployment"); }, "vercel", "development");
  scenario("framework-public variables cannot be downgraded to Config", async f => { const target = await f.register(); f.catalog().bindings[0].variableName = "NEXT_PUBLIC_API_KEY"; assert.throws(() => prepareHostedUse(f.use(target.targetId), f.io)); assert.equal(f.counts().reads, 0); });
  scenario("wrong team or unsupported CLI version never opens approval", async f => { const target = await f.register(), request = f.use(target.targetId); f.io.probe = async () => ({ installed: true, loggedIn: true, version: "59.11.7", identity: "user:synthetic-user,team:team_Other,project:prj_Synthetic" }); assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "unavailable"); assert.equal(f.counts().reads, 0); assert.equal(f.counts().approvals, 0); });
  scenario("provider identity drift after approval is rejected before value read", async f => { const target = await f.register(), request = f.use(target.targetId); let probes = 0; f.io.probe = async () => ({ installed: true, loggedIn: true, version: "59.11.7", identity: ++probes === 1 ? f.identity : "user:other,team:team_Synthetic,project:prj_Synthetic" }); assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "changed"); assert.equal(f.counts().reads, 0); });
  scenario("native decline cannot read or send a value", async f => { const target = await f.register(), request = f.use(target.targetId); f.approve("declined"); assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "cancelled"); assert.equal(f.counts().reads, 0); });
  scenario("generation change during review invalidates the operation", async f => { const target = await f.register(), request = f.use(target.targetId); f.io.human.approve = async () => { f.catalog().credentials[0].generation++; f.catalog().credentials[0].locator.generationId = randomUUID(); return "approved"; }; assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "changed"); assert.equal(f.counts().reads, 0); });
  scenario("lost lock ownership after review prevents value read", async f => { const target = await f.register(), request = f.use(target.targetId); f.io.human.approve = async () => { f.lose(); return "approved"; }; assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "changed"); assert.equal(f.counts().reads, 0); });
  scenario("changed local destination never inherits an old target", async f => { const target = await f.register(), request = f.use(target.targetId); const before = prepareHostedUse(request, f.io).fingerprint; writeFileSync(f.link, '{"orgId":"team_Synthetic","projectId":"prj_Other"}'); assert.equal((await applyHostedUse(request, before, f.io)).status, "unavailable"); assert.equal(f.counts().reads, 0); });
  scenario("provider nonzero is incomplete and cannot retry", async f => { const target = await f.register(), request = f.use(target.targetId); writeFileSync(f.mode, "fail"); const result = await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io); assert.equal(result.status, "incomplete"); assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "recovery-required"); assert.equal(f.counts().reads, 1); });
  scenario("timeout is unknown and cannot retry", async f => { const target = await f.register(), request = f.use(target.targetId); writeFileSync(f.mode, "timeout"); f.cleanupDelay = 3500; const result = await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io); assert.equal(result.status, "unknown"); assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "recovery-required"); assert.equal(f.counts().reads, 1); });
  scenario("native review distinguishes registration from app deployment and uses the OS verifier", async f => { const target = await f.register(), plan = prepareHostedUse(f.use(target.targetId), f.io); const script = buildWindowsHostedUseScript({ ...plan, providerIdentity: f.identity }, "C:/fixed-cli/vercel.cmd"); assert.match(script, /Invoke-ApiKeyCaseUserVerification/); assert.match(script, /既存のアプリdeploymentは更新しません/); assert.match(script, /AcceptButton=\$cancel/); });
  scenario("no value read when handoff observes a changed basis before the OS read", async f => {
    const target = await f.register(), request = f.use(target.targetId); f.io.handoff = (plan, execution) => runGenericHostedDeployment(plan, execution, async () => false);
    assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "unknown"); assert.equal(f.counts().reads, 0); assert.equal(f.events().length, 0);
  });
  scenario("post-read destination change never spawns the provider", async f => {
    const target = await f.register(), request = f.use(target.targetId), read = globalThis.syntheticHostedRead;
    globalThis.syntheticHostedRead = account => { const value = read(account); writeFileSync(f.link, '{"orgId":"team_Synthetic","projectId":"prj_Other"}'); return value; };
    const result = await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io); assert.equal(result.status, "unknown"); assert.equal(f.counts().reads, 1); assert.equal(f.events().length, 0);
  });
  scenario("failed execution journal precedes and prevents the OS read", async f => {
    const target = await f.register(), request = f.use(target.targetId), save = f.store.saveOperation;
    f.store.saveOperation = (old, after) => { if (after.state === "executing") throw Error(); return save(old, after); };
    assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "unknown"); assert.equal(f.counts().reads, 0);
  });
  scenario("expired post-probe approval blocks the handoff", async f => {
    const target = await f.register(), request = f.use(target.targetId); let clock = 0, probes = 0; f.io.now = () => clock;
    f.io.probe = async () => { if (++probes === 2) clock = 61000; return { installed: true, loggedIn: true, version: "59.11.7", identity: f.identity }; };
    assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "changed"); assert.equal(f.counts().reads, 0);
  });
  for (const kind of ["vercel", "github-actions"]) scenario("delivery started within consent deadline completes after 61 seconds and permits a new reviewed operation", async f => {
    delete f.io.probe;
    const target = await f.register(), request = f.use(target.targetId);
    let clock = 0; f.io.now = () => clock;
    f.io.handoff = (plan, execution, current) => runGenericHostedDeployment(plan, execution, async phase => {
      if (phase === "completion") clock += 61000;
      return current(phase);
    });
    for (let n = 0; n < 2; n++) {
      const result = await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io);
      assert.equal(result.status, "completed"); assert.equal(useOperationStatus(result.operationId, f.store).status, "completed");
    }
    assert.equal(f.events().length, 2); assert.equal(f.counts().reads, 2);
  }, kind);
  for (const kind of ["vercel", "github-actions"]) scenario("post-deadline completion still rejects generation drift and blocks automatic replay", async f => {
    const target = await f.register(), request = f.use(target.targetId);
    let clock = 0; f.io.now = () => clock;
    f.io.handoff = (plan, execution, current) => runGenericHostedDeployment(plan, execution, async phase => {
      if (phase === "completion") { clock = 61000; f.catalog().credentials[0].generation++; f.catalog().credentials[0].locator.generationId = randomUUID(); }
      return current(phase);
    });
    const result = await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io);
    assert.equal(result.status, "unknown");
    assert.equal((await applyHostedUse(request, prepareHostedUse(request, f.io).fingerprint, f.io)).status, "recovery-required");
    assert.equal(f.events().length, 1); assert.equal(f.counts().reads, 1);
  }, kind);

  scenario("lost registration response, unrelated legacy reference, fresh profile discovery and slow Vercel completion compose", async f => {
    const store = f.store, records = new Map(), save = store.saveOperation, read = store.readOperation, cas = store.compareAndSwap;
    store.saveOperation = (before, after) => { const r = save(before, after); records.set(after.operationId, r.operation); return r; };
    store.listRegistrationOperations = () => [...records.values()].filter(o => o.kind === "registration");
    store.listLaunchOperations = () => [];
    f.catalog().credentials.push({ ...f.catalog().credentials[0], id: randomUUID(), label: "unresolved old v2", generation: "legacy-unversioned",
      locator: { kind: "v2", ref: { name: "RESEND_API_KEY", scope: "project", projectId: "0123456789abcdef", service: "resend", environment: "development" } } });
    let inputs = 0, fail = true;
    store.compareAndSwap = (before, after) => { if (fail) { fail = false; throw Error("Lost response after synthetic save"); } return cas(before, after); };
    const registrationIO = { store, presence: f.io.presence, human: { ask: async () => { inputs++; return "saved"; } } }, request = { label: "Recovered integration credential", classification: "nonproduction" };
    await registerCredential(request, registrationIO); // Deliberately discard the result/operation ID.
    const recovered = await registerCredential(request, registrationIO); assert.equal(recovered.status, "committed"); assert.equal(inputs, 1);
    const bindingRequest = { project: f.app, environment: "development", variable: "CUSTOM_A_KEY", credentialId: recovered.credentialId };
    const bindingIO = { ...f.io, legacyStatus: l => l.kind === "v3" ? "available" : "unavailable", legacy: async () => { throw Error("Unrelated legacy scan"); }, human: { choose: async () => ({ status: "confirmed", index: 0 }) } };
    const bound = await applyBinding(bindingRequest, (await prepareBinding(bindingRequest, bindingIO)).fingerprint, bindingIO); assert.equal(bound.status, "completed");
    writeFileSync(join(f.app, "main.cjs"), "// synthetic app source");
    const profileRequest = { project: f.app, kind: "node-entry", runtime: process.execPath, entry: "main.cjs", cwd: ".", bindingIds: [bound.bindingId], maxDurationSeconds: 60 };
    const profile = await registerProfile(profileRequest, prepareProfile(profileRequest, f.io).fingerprint, f.io); assert.equal(profile.status, "completed");
    assert.equal(projectProfilePlan(prepareProfile(profileRequest, f.io)).profileId, profile.profileId);
    assert.equal(listProfiles(f.app, f.io).profiles[0].profileId, profile.profileId);
    assert.equal(prepareLaunch({ project: f.app, profileId: profile.profileId }, f.io).profile.id, profile.profileId);
    const target = await f.register(), use = { ...f.use(target.targetId), bindingId: bound.bindingId };
    delete f.io.probe; let clock = 0; f.io.now = () => clock;
    f.io.handoff = (p, e, current) => runGenericHostedDeployment(p, e, phase => { if (phase === "completion") clock += 61000; return current(phase); });
    assert.equal((await applyHostedUse(use, prepareHostedUse(use, f.io).fingerprint, f.io)).status, "completed");
    assert.equal(f.events().length, 1); assert.equal(inputs, 1);
  });

}
