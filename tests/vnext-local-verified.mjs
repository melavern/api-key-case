// Human-operated Windows identity verification; synthetic OS accounts and local apps only.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Entry } from "@napi-rs/keyring";
import { WindowsHumanPlane, resolveWindowsPowerShell, WINDOWS_POWERSHELL_PATH } from "../dist/core/human/windows.js";
import { CatalogStore } from "../dist/core/vnext/files.js";
import { emptyCatalog, locatorAccount } from "../dist/core/vnext/model.js";
import { inspectProject } from "../dist/core/vnext/project.js";
import { prepareProfile, registerProfile, prepareLaunch, applyLaunch, launchOperationStatus } from "../dist/core/vnext/launch.js";
import { runGenericLocalApplication } from "../dist/core/deploy/handoff.js";
import { saveLicenseKey } from "../dist/core/license.js";
import { buildMetadataDriver } from "./helpers/windows-metadata-driver.mjs";

assert.equal(process.platform, "win32");
if (!process.argv.includes("--disposable-native-local")) {
  const repo = fileURLToPath(new URL("..", import.meta.url)), root = mkdtempSync(join(tmpdir(), "akc-native-local-candidate-"));
  try {
    cpSync(join(repo, "dist"), join(root, "dist"), { recursive: true }); mkdirSync(join(root, "tests/helpers"), { recursive: true }); mkdirSync(join(root, "node_modules"));
    cpSync(fileURLToPath(import.meta.url), join(root, "tests/vnext-local-verified.mjs")); cpSync(join(repo, "tests/helpers/windows-metadata-driver.mjs"), join(root, "tests/helpers/windows-metadata-driver.mjs"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
    for (const name of readdirSync(join(repo, "node_modules"))) {
      const from = join(repo, "node_modules", name), to = join(root, "node_modules", name);
      if (statSync(from).isDirectory()) symlinkSync(from, to, "junction"); else cpSync(from, to);
    }
    const path = join(root, "dist/core/vnext/gates.js"), source = readFileSync(path, "utf8"), gate = /VNEXT_WINDOWS_LOCAL_ACCEPTED = (?:false|true)/g;
    assert.equal([...source.matchAll(gate)].length, 1); writeFileSync(path, source.replace(gate, "VNEXT_WINDOWS_LOCAL_ACCEPTED = true"));
    const result = spawnSync(process.execPath, [join(root, "tests/vnext-local-verified.mjs"), "--disposable-native-local"], { stdio: "inherit", timeout: 1200000 });
    assert.equal(result.status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
} else {
  const root = mkdtempSync(join(tmpdir(), "akc-native-local-")), app = join(root, "app"), home = join(root, "home"), output = resolve(".acceptance-vnext-local-20261021");
  for (const path of [app, home, output]) mkdirSync(path, { recursive: true });
  const store = new CatalogStore(home), accounts = [], helpers = new Set(); let helper;
  const plane = new WindowsHumanPlane(resolveWindowsPowerShell(), request => new Promise(done => {
    const child = spawn(request.executable, request.args, { cwd: request.cwd, env: request.env, shell: false, stdio: "ignore", windowsHide: request.windowsHide }); helpers.add(child); helper = child;
    const timer = setTimeout(() => child.kill(), 240000);
    child.once("error", () => { clearTimeout(timer); helpers.delete(child); done(null); }); child.once("close", code => { clearTimeout(timer); helpers.delete(child); done(code); });
  }));
  const drive = async (caption, image, cancel) => {
    assert.ok(helper?.pid); const script = buildMetadataDriver({ helperPid: helper.pid, ownerPid: process.pid, caption, index: null, cancel, imagePath: join(output, image) });
    const child = spawn(WINDOWS_POWERSHELL_PATH, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      cwd: root, stdio: "ignore", windowsHide: true, env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", PATH: "C:\\Windows\\System32;C:\\Windows\\System32\\Wbem" } });
    const code = await new Promise(done => { const timer = setTimeout(() => { child.kill(); done(null); }, 45000);
      child.once("error", () => { clearTimeout(timer); done(null); }); child.once("close", code => { clearTimeout(timer); done(code); }); }); assert.equal(code, 0);
  };
  try {
    const catalog = emptyCatalog(), projectId = randomUUID(), environmentId = randomUUID(), now = new Date().toISOString();
    catalog.projects.push({ ...inspectProject(app), id: projectId, revision: 1 }); catalog.environments.push({ id: environmentId, projectId, label: "development", risk: "nonproduction", revision: 1 });
    for (const variableName of ["SYNTHETIC_LOCAL_A", "synthetic_local_b"]) {
      const id = randomUUID(), locator = { kind: "v3", id, generationId: randomUUID() }, account = locatorAccount(locator); accounts.push(account);
      new Entry("api-key-case", account).setPassword("akc-synthetic-" + randomUUID());
      catalog.credentials.push({ id, label: `合成アプリ受入 ${variableName}`, locator, generation: 1, classification: "nonproduction", createdAt: now, revisedAt: now });
      catalog.bindings.push({ id: randomUUID(), projectId, environmentId, variableName, credentialId: id, revision: 1 });
    }
    store.compareAndSwap(null, catalog);
    const marker = join(app, "result.json");
    writeFileSync(join(app, "main.cjs"), `const fs=require('fs');for(const n of ['SYNTHETIC_LOCAL_A','synthetic_local_b'])if(!/^akc-synthetic-[0-9a-f-]{36}$/.test(process.env[n]||''))process.exit(21);if(process.env.NODE_OPTIONS||process.env.PYTHONPATH)process.exit(22);console.log(process.env.SYNTHETIC_LOCAL_A);console.error(process.env.synthetic_local_b);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({ok:true,runtime:'node',pid:process.pid}));setTimeout(()=>{},200);`);
    writeFileSync(join(app, "main.py"), `import os,re,json,sys,time\nassert all(re.fullmatch(r'akc-synthetic-[0-9a-f-]{36}',os.environ.get(n,'')) for n in ['SYNTHETIC_LOCAL_A','synthetic_local_b'])\nassert 'PYTHONPATH' not in os.environ\nprint(os.environ['SYNTHETIC_LOCAL_A'])\nprint(os.environ['synthetic_local_b'],file=sys.stderr)\nwith open(${JSON.stringify(marker)},'w') as f: json.dump({'ok':True,'runtime':'python','pid':os.getpid()},f)\ntime.sleep(0.2)\n`);
    writeFileSync(join(app, "package.json"), JSON.stringify({ private: true, scripts: { dev: "node main.cjs" } })); writeFileSync(join(app, "package-lock.json"), JSON.stringify({ name: "synthetic", lockfileVersion: 3, packages: {} }));
    const probe = spawnSync(join(homedir(), "AppData/Local/Programs/Python/Launcher/py.exe"), ["-0p"], { encoding: "utf8", windowsHide: true });
    const python = probe.stdout.split(/\r?\n/).map(line => line.match(/([A-Za-z]:\\.+\\python.exe)\s*$/i)?.[1]).find(Boolean); assert.ok(python, "installed Python runtime required for acceptance");
    const keys = generateKeyPairSync("ed25519"), payload = Buffer.from(JSON.stringify({ v: 1, plan: "pro", id: "synthetic-native-local", issuedAt: "2026-10-21" })).toString("base64url"), signed = `AKC1.${payload}`;
    saveLicenseKey(`${signed}.${sign(null, Buffer.from(signed), keys.privateKey).toString("base64url")}`, home);
    const presence = Object.assign(locator => plane.probeVNextPresence(locator), { all: locators => plane.probeVNextPresenceBatch(locators) });
    let cancelProfile = true, index = 0;
    const io = { store, presence, licenseOptions: { baseDir: home, publicKey: keys.publicKey }, legacy: async () => ({ status: "available", locators: [] }), handoff: runGenericLocalApplication,
      human: { confirm: async plan => { const pending = plane.confirmVNextProfile(plan); await drive("API Key Case - Register Launch Profile", `profile-${index}-${cancelProfile ? "cancel" : "register"}.png`, cancelProfile); return pending; },
        approve: async plan => { console.log(`Review synthetic local launch ${index + 1}/3 (${plan.profile.kind}), then complete Windows verification. No cloud connection.`); return plane.approveVNextLaunch(plan); } } };
    const variants = [{ kind: "node-entry", entry: "main.cjs", runtime: process.execPath }, { kind: "node-package-script", entry: "dev", runtime: process.execPath }, { kind: "python-entry", entry: "main.py", runtime: python }];
    for (index = 0; index < variants.length; index++) {
      const request = { project: app, ...variants[index], cwd: ".", bindingIds: catalog.bindings.map(b => b.id), maxDurationSeconds: 120 };
      if (index === 0) { assert.equal((await registerProfile(request, prepareProfile(request, io).fingerprint, io)).status, "cancelled"); assert.equal(store.readCatalog().catalog.launchProfiles.length, 0); cancelProfile = false; }
      const registered = await registerProfile(request, prepareProfile(request, io).fingerprint, io); assert.equal(registered.status, "completed");
      const launch = { project: app, profileId: registered.profileId }, plan = prepareLaunch(launch, io);
      if (index === 0) { const pending = plane.approveVNextLaunch(plan); await drive("API Key Case - Launch Application", "launch-cancel.png", true); assert.equal(await pending, "declined"); }
      const result = await applyLaunch(launch, plan.fingerprint, io); assert.equal(result.status, "exited"); assert.equal(result.treeTermination, "confirmed");
      assert.equal(launchOperationStatus(result.operationId, store).status, "exited"); assert.equal(JSON.parse(readFileSync(marker, "utf8")).ok, true); rmSync(marker);
      console.log(`PASS native OS slots -> ${variants[index].kind}, fresh verification and confirmed tree exit ${index + 1}/3`);
    }
    console.log("PASS independent profile registration/cancel, launch cancel, three fresh Windows verifications, two synthetic variables, editable ordinary apps, null stdio and durable exits.");
  } finally { for (const child of helpers) child.kill(); for (const account of accounts) new Entry("api-key-case", account).deleteCredential(); rmSync(root, { recursive: true, force: true }); console.log("Dedicated synthetic local slots and metadata cleaned up."); }
}
