// Interactive synthetic acceptance. Control only this harness's native windows.
// No product test bypass or real user key is used. Cleanup touches only random
// v3 accounts recorded by this harness before its native UI is opened.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Entry } from "@napi-rs/keyring";
import { WindowsHumanPlane, resolveWindowsPowerShell, WINDOWS_DIALOG_TEXT, WINDOWS_POWERSHELL_PATH } from "../dist/core/human/windows.js";
import { CatalogStore } from "../dist/core/vnext/files.js";
import { registerCredential } from "../dist/core/vnext/input.js";
import { locatorAccount } from "../dist/core/vnext/model.js";
import { buildSecretInputDriver } from "./helpers/windows-secret-input-driver.mjs";

assert.equal(process.platform, "win32", "Windows native session required");
const root = mkdtempSync(join(tmpdir(), "akc-vnext-native-")), store = new CatalogStore(root), accounts = new Set();
let helper = null;
const human = new WindowsHumanPlane(resolveWindowsPowerShell(), request => new Promise(resolve => {
  const child = spawn(request.executable, request.args, { cwd: request.cwd, env: request.env, detached: request.detached,
    shell: request.shell, stdio: request.stdio, windowsHide: request.windowsHide }); helper = child;
  // Test lifecycle only. An unattended fixture cannot leave a dialog behind.
  const timeout = setTimeout(() => child.kill(), 180_000);
  child.once("error", () => { clearTimeout(timeout); helper = null; resolve(null); });
  child.once("close", code => { clearTimeout(timeout); helper = null; resolve(code); });
}));
const useDriver = process.argv.includes("--driver");
const plans = new Map();
const io = { store, human: { ask: async plan => {
  plans.set(plan.operation.operationId, plan);
  accounts.add(locatorAccount(plan.operation.boundBasis.candidateCredential.locator));
  console.log(`AWAITING ${stage}: synthetic native dialog`);
  const input = human.askVNextSecret(plan);
  if (useDriver) {
    try { await driveSynthetic(); } catch (error) { helper?.kill(); await input; throw error; }
  }
  return input;
} }, presence: locator => human.probeVNextPresence(locator) };
let stage = "cancel";
try {
  const cancelled = await registerCredential({ label: "Synthetic cancel", classification: "unknown" }, io);
  assert.equal(cancelled.status, "cancelled"); assert.equal(store.readCatalog().catalog.credentials.length, 0);
  assert.equal((await registerCredential({ operationId: cancelled.operationId }, io)).status, "cancelled");
  console.log("PASS cancel + replay suppression");

  stage = "new development";
  const first = await registerCredential({ label: "Synthetic issuer development", classification: "nonproduction" }, io);
  assert.equal(first.status, "committed"); const original = store.readCatalog().catalog.credentials[0];
  assert.equal(await io.presence(original.locator), "present");
  assert.equal((await registerCredential({ operationId: first.operationId }, io)).status, "committed");
  assert.equal((await registerCredential({ label: "Synthetic issuer development", classification: "nonproduction" }, io)).status, "selection-required");
  const existingStarted = Date.now();
  assert.equal(await human.askVNextSecret(plans.get(first.operationId)), "unavailable");
  assert.ok(Date.now() - existingStarted < 15_000, "an already-existing candidate must refuse before showing input");
  console.log("PASS new development + fresh presence + same ID/label no prompt");

  stage = "new production";
  const second = await registerCredential({ label: "Synthetic issuer production", classification: "production" }, io);
  assert.equal(second.status, "committed"); assert.notEqual(first.credentialId, second.credentialId);
  console.log("PASS same issuer independent production credential");

  // Test-only, non-secret association, so the rotation UI must display impacts.
  const before = store.readCatalog(), projectId = randomUUID(), environmentId = randomUUID();
  const changed = structuredClone(before.catalog); changed.revision++;
  changed.projects.push({ id: projectId, canonicalPath: root.replaceAll("\\", "/"), directoryIdentity: { dev: "1", ino: "2", birthtimeNs: "3" }, revision: 1 });
  changed.environments.push({ id: environmentId, projectId, label: "development", risk: "nonproduction", revision: 1 });
  changed.bindings.push({ id: randomUUID(), projectId, environmentId, variableName: "SYNTHETIC_API_KEY", credentialId: first.credentialId, revision: 1 });
  store.compareAndSwap(before, changed);
  stage = "rotation with impact";
  const rotated = await registerCredential({ label: "Synthetic issuer rotated", classification: "nonproduction", replaceCredentialId: first.credentialId }, io);
  assert.equal(rotated.status, "committed");
  const active = store.readCatalog().catalog.credentials.find(c => c.id === first.credentialId);
  assert.equal(active.generation, 2); assert.equal(await io.presence(original.locator), "present"); assert.equal(await io.presence(active.locator), "present");
  assert.deepEqual(store.readCatalog().catalog.bindings, changed.bindings);
  console.log("PASS rotation + retained old slot + unchanged binding");

  stage = "max-size accepted";
  const maximum = await registerCredential({ label: "Synthetic Unicode maximum", classification: "nonproduction" }, io);
  assert.equal(maximum.status, "committed");
  assert.equal(await io.presence(store.readCatalog().catalog.credentials.find(c => c.id === maximum.credentialId).locator), "present");
  console.log("PASS exact 2560 UTF-16 bytes including Unicode, without clipping");

  stage = "post-save response loss";
  const normalAsk = io.human.ask;
  io.human.ask = async plan => { const result = await normalAsk(plan); if (result === "saved") throw Error("Synthetic post-save interruption"); return result; };
  const lost = await registerCredential({ label: "Synthetic response loss", classification: "nonproduction" }, io);
  assert.equal(lost.status, "unknown"); io.human.ask = normalAsk;
  const fresh = new WindowsHumanPlane(resolveWindowsPowerShell());
  const resumed = await registerCredential({ operationId: lost.operationId }, { store: new CatalogStore(root),
    human: { ask: async () => { throw Error("Recovery must not show input"); } }, presence: locator => fresh.probeVNextPresence(locator) });
  assert.equal(resumed.status, "committed");
  console.log("PASS actual native save + lost response + fresh observer recovery without input");

  stage = "oversized refusal";
  const oversized = await registerCredential({ label: "Synthetic oversized", classification: "unknown" }, io);
  assert.equal(oversized.status, "unknown");
  const pending = store.readOperation(oversized.operationId).operation;
  assert.equal(await io.presence(pending.boundBasis.candidateCredential.locator), "absent");
  assert.equal(store.readCatalog().catalog.credentials.length, 4);
  console.log("PASS oversized whole refusal + old active preserved");
  console.log("PASS Windows vNext registration native synthetic acceptance (no provider or real keys)");
} finally {
  helper?.kill();
  for (const account of accounts) new Entry("api-key-case", account).deleteCredential();
  rmSync(root, { recursive: true, force: true });
  console.log("Synthetic accounts and disposable metadata cleaned up");
}

async function driveSynthetic() {
  const value = stage === "oversized refusal" ? "akc-synthetic-oversize-".padEnd(1281, "x") : stage === "max-size accepted" ? "合成".repeat(640) : "akc-synthetic-vnext-" + randomUUID();
  const script = "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)\n" + buildSecretInputDriver({ mode: stage === "cancel" ? "inspect" : "save", cliPid: process.pid,
    captions: Object.values(WINDOWS_DIALOG_TEXT.secretInputCaption), saveLabels: Object.values(WINDOWS_DIALOG_TEXT.saveButton),
    cancelLabels: Object.values(WINDOWS_DIALOG_TEXT.cancelButton) });
  const child = spawn(WINDOWS_POWERSHELL_PATH, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", SYSTEMDRIVE: "C:",
      PATH: "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0", PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules", TEMP: root, TMP: root } });
  child.stdin.end(stage === "cancel" ? "" : value + "\n");
  let stdout = "", stderr = ""; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(Error("Synthetic native driver timeout")); }, 120_000);
    child.once("error", e => { clearTimeout(timeout); reject(e); }); child.once("close", code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(code, 0, "synthetic driver must finish against this harness's own helper");
  assert.equal((stdout + stderr).includes(value), false, "synthetic value must not enter output");
  const line = stdout.split(/\r?\n/).find(l => l.startsWith("AKC_JSON=")); assert.ok(line, "closed native driver report");
  const report = JSON.parse(Buffer.from(line.slice(9), "base64").toString("utf8"));
  assert.equal(report.reason === "cancelled" || report.reason === "save-completed", true);
  if (stage !== "cancel") assert.equal(report.setLength, value.length, "never clip input");
  assert.equal(Boolean(report.messageBox), stage === "oversized refusal");
}
