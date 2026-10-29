// Native metadata selection and delivery-dialog cancellation only. No OS-store value or provider operation.
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WindowsHumanPlane, WINDOWS_POWERSHELL_PATH, resolveWindowsPowerShell } from "../dist/core/human/windows.js";
import { CatalogStore } from "../dist/core/vnext/files.js";
import { emptyCatalog } from "../dist/core/vnext/model.js";
import { inspectProject } from "../dist/core/vnext/project.js";
import { prepareTarget, registerTarget, projectTargetPlan } from "../dist/core/vnext/target.js";
import { prepareUse } from "../dist/core/vnext/use.js";
import { saveLicenseKey } from "../dist/core/license.js";
import { buildMetadataDriver } from "./helpers/windows-metadata-driver.mjs";

assert.equal(process.platform, "win32");
const root = mkdtempSync(join(tmpdir(), "akc-generic-native-")), app = join(root, "app"), home = join(root, "home");
const output = resolve(process.argv[2] ?? ".acceptance-vnext-cloudflare-20261021"); mkdirSync(output, { recursive: true });
for (const path of [app, home]) mkdirSync(path);
let helper = null;
const human = new WindowsHumanPlane(resolveWindowsPowerShell(), request => new Promise(resolveStatus => {
  const child = spawn(request.executable, request.args, { cwd: request.cwd, env: request.env, shell: false, stdio: "ignore", windowsHide: request.windowsHide }); helper = child;
  const timer = setTimeout(() => child.kill(), 100_000);
  child.once("error", () => { clearTimeout(timer); helper = null; resolveStatus(null); });
  child.once("close", code => { clearTimeout(timer); helper = null; resolveStatus(code); });
}));
assert.equal(human.capability(), "os-dialog", "Windows helper capability");
const account = "0123456789abcdef0123456789abcdef", store = new CatalogStore(home);
const request = { project: app, environment: "development" };
async function drive(caption, image, index, cancel) {
  assert.ok(helper?.pid);
  const script = buildMetadataDriver({ helperPid: helper.pid, ownerPid: process.pid, caption, index, cancel, imagePath: join(output, image) });
  const child = spawn(WINDOWS_POWERSHELL_PATH, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { cwd: root, windowsHide: true, stdio: "ignore", env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", PATH: "C:\\Windows\\System32;C:\\Windows\\System32\\Wbem" } });
  const code = await new Promise(resolveStatus => { const timer = setTimeout(() => { child.kill(); resolveStatus(null); }, 45_000);
    child.once("error", () => { clearTimeout(timer); resolveStatus(null); }); child.once("close", code => { clearTimeout(timer); resolveStatus(code); }); });
  if (code !== 0) helper?.kill(); assert.equal(code, 0);
}
try {
  writeFileSync(join(app, "wrangler.jsonc"), JSON.stringify({ name: "synthetic-native-api", account_id: account, env: { staging: { name: "synthetic-native-buy" } } }));
  const catalog = emptyCatalog(), projectId = randomUUID(), envId = randomUUID(), credentialId = randomUUID(), time = new Date().toISOString();
  catalog.projects.push({ ...inspectProject(app), id: projectId, revision: 1 });
  catalog.environments.push({ id: envId, projectId, label: "development", risk: "nonproduction", revision: 1 });
  catalog.credentials.push({ id: credentialId, label: "合成・未保存の表示候補", locator: { kind: "v3", id: credentialId, generationId: randomUUID() }, generation: 1,
    classification: "nonproduction", createdAt: time, revisedAt: time });
  catalog.bindings.push({ id: randomUUID(), projectId, environmentId: envId, variableName: "arbitrary_key", credentialId, revision: 1 });
  store.compareAndSwap(null, catalog);
  let selection = 0, cancel = true;
  const io = { store, human: { choose: async plan => {
    const pending = human.chooseVNextTarget(plan);
    try { await drive("API Key Case - Register Target", cancel ? "target-cancel.png" : `target-${selection}.png`, selection, cancel); }
    catch (error) { console.error("Synthetic metadata driver:", error.message); throw error; }
    return pending;
  } } };
  let plan = prepareTarget(request, io); assert.equal(projectTargetPlan(plan).candidateCount, 2);
  assert.equal((await registerTarget(request, plan.fingerprint, io)).status, "cancelled"); assert.equal(store.readCatalog().catalog.destinations.length, 0);
  cancel = false;
  const targets = [];
  for (selection = 0; selection < 2; selection++) { plan = prepareTarget(request, io); const result = await registerTarget(request, plan.fingerprint, io); assert.equal(result.status, "completed"); targets.push(result.targetId); }
  assert.equal(store.readCatalog().catalog.destinations.length, 2);
  const keys = generateKeyPairSync("ed25519"), payload = Buffer.from(JSON.stringify({ v: 1, plan: "pro", id: "synthetic-native-display", issuedAt: "2026-10-21" })).toString("base64url");
  const signed = `AKC1.${payload}`; saveLicenseKey(`${signed}.${sign(null, Buffer.from(signed), keys.privateKey).toString("base64url")}`, home);
  for (let i = 0; i < targets.length; i++) {
    const usePlan = prepareUse({ project: app, bindingId: catalog.bindings[0].id, targetId: targets[i] }, { store, licenseOptions: { baseDir: home, publicKey: keys.publicKey } });
    const pending = human.approveVNextUse(usePlan, "C:/synthetic-fixed-cli/wrangler.cmd"); await drive("API Key Case - Deploy Binding", `delivery-${i}-cancel.png`, null, true);
    assert.equal(await pending, "declined");
  }
  console.log("PASS native target select/cancel, two exact destination registrations and two delivery-dialog cancellations; no OS credential read/write or provider operation");
} finally { helper?.kill(); rmSync(root, { recursive: true, force: true }); }
