// Human-operated Windows verification with dedicated synthetic OS slots and offline mock CLIs.
// The source gate is changed only inside a disposable compiled candidate, never in dist or source.
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Entry } from "@napi-rs/keyring";
import { WindowsHumanPlane, resolveWindowsPowerShell } from "../dist/core/human/windows.js";
import { CatalogStore } from "../dist/core/vnext/files.js";
import { emptyCatalog, locatorAccount } from "../dist/core/vnext/model.js";
import { inspectProject } from "../dist/core/vnext/project.js";
import { prepareTarget, registerTarget } from "../dist/core/vnext/target.js";
import { applyUse, prepareUse, useOperationStatus } from "../dist/core/vnext/use.js";
import { runGenericCloudflareDeployment } from "../dist/core/deploy/handoff.js";
import { saveLicenseKey } from "../dist/core/license.js";

assert.equal(process.platform, "win32");
if (!process.argv.includes("--disposable-native-candidate")) {
  const repo = fileURLToPath(new URL("..", import.meta.url)), root = mkdtempSync(join(tmpdir(), "akc-verified-candidate-"));
  try {
    cpSync(join(repo, "dist"), join(root, "dist"), { recursive: true }); mkdirSync(join(root, "tests")); mkdirSync(join(root, "node_modules"));
    cpSync(fileURLToPath(import.meta.url), join(root, "tests/vnext-cloudflare-verified.mjs"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", private: true }));
    for (const name of readdirSync(join(repo, "node_modules"))) {
      const from = join(repo, "node_modules", name), to = join(root, "node_modules", name);
      if (statSync(from).isDirectory()) symlinkSync(from, to, "junction"); else cpSync(from, to);
    }
    const path = join(root, "dist/core/vnext/gates.js"), source = readFileSync(path, "utf8"), gate = /VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED = (?:false|true)/g;
    assert.equal([...source.matchAll(gate)].length, 1); writeFileSync(path, source.replace(gate, "VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED = true"));
    const result = spawnSync(process.execPath, [join(root, "tests/vnext-cloudflare-verified.mjs"), "--disposable-native-candidate"], { stdio: "inherit", timeout: 600_000 });
    assert.equal(result.status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
} else {
  const root = mkdtempSync(join(tmpdir(), "akc-verified-offline-")), app = join(root, "app"), home = join(root, "home"), bin = join(root, "bin");
  for (const path of [app, home, bin]) mkdirSync(path);
  const store = new CatalogStore(home), accounts = [], helpers = new Set(), account = "0123456789abcdef0123456789abcdef";
  const plane = new WindowsHumanPlane(resolveWindowsPowerShell(), request => new Promise(resolveStatus => {
    const child = spawn(request.executable, request.args, { cwd: request.cwd, env: request.env, shell: false, stdio: "ignore", windowsHide: request.windowsHide }); helpers.add(child);
    const timer = setTimeout(() => child.kill(), 180_000);
    child.once("error", () => { clearTimeout(timer); helpers.delete(child); resolveStatus(null); });
    child.once("close", code => { clearTimeout(timer); helpers.delete(child); resolveStatus(code); });
  }));
  try {
    const catalog = emptyCatalog(), projectId = randomUUID(), envId = randomUUID(), time = new Date().toISOString();
    catalog.projects.push({ ...inspectProject(app), id: projectId, revision: 1 }); catalog.environments.push({ id: envId, projectId, label: "development", risk: "nonproduction", revision: 1 });
    for (const variableName of ["SYNTHETIC_A_KEY", "synthetic_b_key"]) {
      const id = randomUUID(), locator = { kind: "v3", id, generationId: randomUUID() }, osAccount = locatorAccount(locator); accounts.push(osAccount);
      new Entry("api-key-case", osAccount).setPassword("akc-synthetic-" + randomUUID());
      catalog.credentials.push({ id, label: `合成受入専用 ${variableName}`, locator, generation: 1, classification: "nonproduction", createdAt: time, revisedAt: time });
      catalog.bindings.push({ id: randomUUID(), projectId, environmentId: envId, variableName, credentialId: id, revision: 1 });
    }
    store.compareAndSwap(null, catalog);
    writeFileSync(join(app, "wrangler.jsonc"), JSON.stringify({ name: "synthetic-native-api", account_id: account, env: { staging: { name: "synthetic-native-buy" } } }));
    const marker = join(root, "events.json"), mock = join(bin, "provider.cjs");
    writeFileSync(mock, `const fs=require('fs');const a=process.argv.slice(2);if(a[0]!=='secret'||a[1]!=='put'||!['SYNTHETIC_A_KEY','synthetic_b_key'].includes(a[2])||process.env.CLOUDFLARE_ACCOUNT_ID!==${JSON.stringify(account)}||process.env.NODE_OPTIONS)process.exit(41);let v='';process.stdin.on('data',c=>v+=c);process.stdin.on('end',()=>{if(!/^akc-synthetic-[0-9a-f-]{36}$/.test(v))process.exit(42);const events=fs.existsSync(${JSON.stringify(marker)})?JSON.parse(fs.readFileSync(${JSON.stringify(marker)},'utf8')):[];events.push(a);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(events));console.log(v);console.error(v.slice(0,12));});`);
    writeFileSync(join(bin, "wrangler.cmd"), `@echo off\r\n"${process.execPath}" "${mock}" %*\r\n`);
    const keys = generateKeyPairSync("ed25519"), payload = Buffer.from(JSON.stringify({ v: 1, plan: "pro", id: "synthetic-verified", issuedAt: "2026-10-21" })).toString("base64url"), signed = `AKC1.${payload}`;
    saveLicenseKey(`${signed}.${sign(null, Buffer.from(signed), keys.privateKey).toString("base64url")}`, home);
    const io = { store, pathOverride: bin, licenseOptions: { baseDir: home, publicKey: keys.publicKey }, presence: locator => plane.probeVNextPresence(locator),
      legacy: async () => ({ status: "available", locators: [] }), handoff: runGenericCloudflareDeployment,
      probe: async () => ({ installed: true, loggedIn: true, version: "4.131.2", identity: `accounts:${account}` }),
      human: { approve: async (plan, cliPath) => { console.log("Review the synthetic destination, then complete Windows verification. No cloud connection occurs."); return plane.approveVNextUse(plan, cliPath); } } };
    for (let index = 0; index < 2; index++) {
      const request = { project: app, environment: "development" }, targetIO = { store, human: { choose: async () => ({ status: "confirmed", index }) } };
      const target = await registerTarget(request, prepareTarget(request, targetIO).fingerprint, targetIO); assert.equal(target.status, "completed");
      const use = { project: app, bindingId: catalog.bindings[index].id, targetId: target.targetId }, plan = prepareUse(use, io);
      const result = await applyUse(use, plan.fingerprint, io); assert.equal(result.status, "completed");
      assert.equal(useOperationStatus(result.operationId, store).status, "completed");
      console.log(`PASS synthetic native OS slot and fixed stdin deployment ${index + 1}/2`);
    }
    const events = JSON.parse(readFileSync(marker, "utf8")); assert.equal(events.length, 2); assert.equal(events[0].includes("--env"), false); assert.equal(events[1].at(-1), "staging");
    console.log("PASS two fresh Windows verifications, two exact synthetic slots/Workers, fixed stdin, redacted output and durable completion. No real credential/provider operation.");
  } finally {
    for (const helper of helpers) helper.kill();
    for (const account of accounts) new Entry("api-key-case", account).deleteCredential();
    rmSync(root, { recursive: true, force: true }); console.log("Dedicated synthetic slots and metadata cleaned up.");
  }
}
