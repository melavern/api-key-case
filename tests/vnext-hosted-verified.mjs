// Human-operated Windows acceptance. Offline mock CLIs and dedicated synthetic OS accounts only.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Entry } from "@napi-rs/keyring";
import { WindowsHumanPlane, resolveWindowsPowerShell, WINDOWS_POWERSHELL_PATH } from "../dist/core/human/windows.js";
import { CatalogStore } from "../dist/core/vnext/files.js";
import { emptyCatalog, locatorAccount } from "../dist/core/vnext/model.js";
import { inspectProject } from "../dist/core/vnext/project.js";
import { prepareHostedTarget, registerHostedTarget } from "../dist/core/vnext/hosted-target.js";
import { prepareHostedUse, applyHostedUse } from "../dist/core/vnext/hosted-use.js";
import { useOperationStatus } from "../dist/core/vnext/use.js";
import { runGenericHostedDeployment } from "../dist/core/deploy/handoff.js";
import { saveLicenseKey } from "../dist/core/license.js";
import { buildMetadataDriver } from "./helpers/windows-metadata-driver.mjs";

assert.equal(process.platform, "win32");
if (!process.argv.includes("--disposable-native-hosted")) {
  const repo = fileURLToPath(new URL("..", import.meta.url)), root = mkdtempSync(join(tmpdir(), "akc-native-hosted-candidate-"));
  try {
    cpSync(join(repo, "dist"), join(root, "dist"), { recursive: true }); mkdirSync(join(root, "tests/helpers"), { recursive: true }); mkdirSync(join(root, "node_modules"));
    cpSync(fileURLToPath(import.meta.url), join(root, "tests/vnext-hosted-verified.mjs")); cpSync(join(repo, "tests/helpers/windows-metadata-driver.mjs"), join(root, "tests/helpers/windows-metadata-driver.mjs"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", private: true }));
    for (const name of readdirSync(join(repo, "node_modules"))) { const from = join(repo, "node_modules", name), to = join(root, "node_modules", name); if (statSync(from).isDirectory()) symlinkSync(from, to, "junction"); else cpSync(from, to); }
    const path = join(root, "dist/core/vnext/gates.js"), source = readFileSync(path, "utf8"), guard = /VNEXT_WINDOWS_(VERCEL|GITHUB)_ACCEPTED = (?:false|true)/g;
    assert.equal([...source.matchAll(guard)].length, 2); writeFileSync(path, source.replace(guard, "VNEXT_WINDOWS_$1_ACCEPTED = true"));
    const result = spawnSync(process.execPath, [join(root, "tests/vnext-hosted-verified.mjs"), "--disposable-native-hosted", ...process.argv.slice(2)], { stdio: "inherit", timeout: 900000 }); assert.equal(result.status, 0);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
} else {
  const root = mkdtempSync(join(tmpdir(), "akc-native-hosted-")), app = join(root, "app"), home = join(root, "home"), bin = join(root, "bin"), output = resolve(".acceptance-vnext-hosted-20261021");
  for (const path of [app, home, bin, output, join(app, ".vercel"), join(app, ".git")]) mkdirSync(path, { recursive: true });
  const store = new CatalogStore(home), accounts = [], helpers = new Set(); let helper;
  const plane = new WindowsHumanPlane(resolveWindowsPowerShell(), request => new Promise(done => {
    const child = spawn(request.executable, request.args, { cwd: request.cwd, env: request.env, shell: false, stdio: "ignore", windowsHide: request.windowsHide }); helper = child; helpers.add(child);
    const timer = setTimeout(() => child.kill(), 240000); child.once("error", () => { clearTimeout(timer); helpers.delete(child); done(null); }); child.once("close", code => { clearTimeout(timer); helpers.delete(child); done(code); });
  }));
  async function drive(caption, image, cancel) {
    assert.ok(helper?.pid); const script = buildMetadataDriver({ helperPid: helper.pid, ownerPid: process.pid, caption, cancel, imagePath: join(output, image) });
    const child = spawn(WINDOWS_POWERSHELL_PATH, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      cwd: root, stdio: "ignore", windowsHide: true, env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", PATH: "C:\\Windows\\System32;C:\\Windows\\System32\\Wbem" } });
    const code = await new Promise(done => { const timer = setTimeout(() => { child.kill(); done(null); }, 45000); child.once("error", () => { clearTimeout(timer); done(null); }); child.once("close", code => { clearTimeout(timer); done(code); }); }); assert.equal(code, 0);
  }
  try {
    const catalog = emptyCatalog(), projectId = randomUUID(), environmentId = randomUUID(), now = new Date().toISOString();
    catalog.projects.push({ ...inspectProject(app), id: projectId, revision: 1 }); catalog.environments.push({ id: environmentId, projectId, label: "development", risk: "nonproduction", revision: 1 });
    for (const variableName of ["SYNTHETIC_HOSTED_A", "synthetic_hosted_b"]) {
      const id = randomUUID(), locator = { kind: "v3", id, generationId: randomUUID() }, account = locatorAccount(locator); accounts.push(account);
      new Entry("api-key-case", account).setPassword("akc-synthetic-" + randomUUID());
      catalog.credentials.push({ id, label: `合成配送受入 ${variableName}`, locator, generation: 1, classification: "nonproduction", createdAt: now, revisedAt: now });
      catalog.bindings.push({ id: randomUUID(), projectId, environmentId, variableName, credentialId: id, revision: 1 });
    }
    store.compareAndSwap(null, catalog);
    writeFileSync(join(app, ".vercel/project.json"), JSON.stringify({ orgId: "team_Synthetic", projectId: "prj_Synthetic" }));
    writeFileSync(join(app, ".git/config"), '[core]\n bare = false\n[remote "origin"]\n url = https://github.com/synthetic-owner/synthetic-repo.git\n');
    const marker = join(root, "events.json"), provider = join(bin, "provider.cjs");
    writeFileSync(provider, `const fs=require('fs');const k=process.argv[2],a=process.argv.slice(3);if(a[0]==='--version'){console.log(k==='vercel'?'59.11.7':'gh version 2.96.0');process.exit(0);}if(a[0]==='whoami'){console.log(JSON.stringify({username:'synthetic-user',team:{id:'team_Synthetic'}}));process.exit(0);}if(a[0]==='project'){console.error('> Found Project synthetic-team/synthetic-project [1ms]\\n\\n  General\\n\\n    \\x1b[36mID\\x1b[39m\\t\\t\\t\\tprj_Synthetic\\n    Name\\t\\t\\tsynthetic-project\\n    Owner\\t\\t\\tSynthetic Team\\n');process.exit(0);}if(a[0]==='auth')process.exit(0);if(a[0]==='api'){const e=a[5];console.log(JSON.stringify(e==='user'?[11,'synthetic-user']:e.includes('/environments/')?[44,'development']:[22,'synthetic-owner/synthetic-repo',33]));process.exit(0);}if(!['SYNTHETIC_HOSTED_A','synthetic_hosted_b'].includes(a[2]))process.exit(41);if(k==='vercel'&&(!a.includes('--sensitive')||!a.includes('--force')||a[a.indexOf('--scope')+1]!=='team_Synthetic'||a[a.indexOf('--project')+1]!=='prj_Synthetic'||a[3]!=='preview'))process.exit(42);if(k==='gh'&&(a[a.indexOf('--app')+1]!=='actions'||a[a.indexOf('--repo')+1]!=='github.com/synthetic-owner/synthetic-repo'||a[a.indexOf('--env')+1]!=='development'||process.env.GH_HOST!=='github.com'))process.exit(43);let v='';process.stdin.on('data',c=>v+=c);process.stdin.on('end',()=>{if(!/^akc-synthetic-[0-9a-f-]{36}$/.test(v))process.exit(44);const events=fs.existsSync(${JSON.stringify(marker)})?JSON.parse(fs.readFileSync(${JSON.stringify(marker)},'utf8')):[];events.push({kind:k,argv:a});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(events));console.log(v);console.error(v.slice(0,12));});`);
    for (const command of ["vercel", "gh"]) writeFileSync(join(bin, `${command}.cmd`), `@echo off\r\n"${process.execPath}" "${provider}" ${command} %*\r\n`);
    const keys = generateKeyPairSync("ed25519"), payload = Buffer.from(JSON.stringify({ v: 1, plan: "pro", id: "synthetic-native-hosted", issuedAt: "2026-10-21" })).toString("base64url"), signed = `AKC1.${payload}`;
    saveLicenseKey(`${signed}.${sign(null, Buffer.from(signed), keys.privateKey).toString("base64url")}`, home);
    const presence = locator => plane.probeVNextPresence(locator); let cancel = !process.argv.includes("--github-only"), index = 0;
    const io = { store, presence, pathOverride: bin, licenseOptions: { baseDir: home, publicKey: keys.publicKey }, legacy: async () => ({ status: "available", locators: [] }),
      handoff: async (plan, execution, current) => { const started = Date.now(); const outcome = await runGenericHostedDeployment(plan, execution, current); console.log(`Synthetic ${plan.destination.kind} handoff outcome=${outcome}, elapsedMs=${Date.now() - started}, receiptCount=${readFileSyncSafeEvents().length}`); return outcome; },
      human: { confirm: async plan => { const pending = plane.confirmVNextHostedTarget(plan); await drive("API Key Case - Register Hosted Target", `target-${index}-${cancel ? "cancel" : "register"}.png`, cancel); return pending; },
        approve: async (plan, path) => { if (process.argv.includes("--diagnostic-synthetic-consent")) { console.log("DIAGNOSTIC ONLY: synthetic consent, not native acceptance."); return "approved"; } console.log(`Review synthetic ${plan.destination.kind} placement ${index + 1}/2, then complete Windows verification. No cloud connection.`); return plane.approveVNextHostedUse(plan, path); } } };
    function readFileSyncSafeEvents() { try { return JSON.parse(readFileSync(marker, "utf8")); } catch { return []; } }
    const variants = [{ kind: "vercel", environment: "preview" }, { kind: "github-actions", environment: "development" }];
    for (index = 0; index < variants.length; index++) {
      if (process.argv.includes("--github-only") && index === 0) continue;
      const targetRequest = { project: app, ...variants[index] };
      if (index === 0) { assert.equal((await registerHostedTarget(targetRequest, prepareHostedTarget(targetRequest, io).fingerprint, io)).status, "cancelled"); assert.equal(store.readCatalog().catalog.destinations.length, 0); cancel = false; }
      const registered = await registerHostedTarget(targetRequest, prepareHostedTarget(targetRequest, io).fingerprint, io); assert.equal(registered.status, "completed");
      const request = { project: app, bindingId: catalog.bindings[index].id, targetId: registered.targetId }, plan = prepareHostedUse(request, io);
      const pending = plane.approveVNextHostedUse(plan, "C:/synthetic-fixed-cli/provider.cmd"); await drive("API Key Case - Deploy Binding", `delivery-${index}-cancel.png`, true); assert.equal(await pending, "declined");
      const result = await applyHostedUse(request, plan.fingerprint, io); assert.equal(result.status, "completed"); assert.equal(useOperationStatus(result.operationId, store).status, "completed");
      console.log(`PASS ${process.argv.includes("--diagnostic-synthetic-consent") ? "DIAGNOSTIC simulated consent" : "native fresh Windows verification"}: OS slot -> fixed ${variants[index].kind} stdin and durable completion ${index + 1}/2`);
    }
    const events = JSON.parse(readFileSync(marker, "utf8")); assert.deepEqual(events.map(e => e.kind), process.argv.includes("--github-only") ? ["gh"] : ["vercel", "gh"]);
    console.log(process.argv.includes("--diagnostic-synthetic-consent") ? "PASS diagnostic only; native acceptance NOT established." : "PASS selected exact native hosted routes, metadata registration, declined use, fresh OS verification, synthetic credentials, fixed stdin and suppressed output. No real provider operation.");
  } finally { for (const child of helpers) child.kill(); for (const account of accounts) new Entry("api-key-case", account).deleteCredential(); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); console.log("Dedicated hosted synthetic slots and metadata cleaned up."); }
}
