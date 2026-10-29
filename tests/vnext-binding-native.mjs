// Native metadata-only selection acceptance. Synthetic keys live in random,
// recorded test accounts and are never returned or compared by product code.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Entry } from "@napi-rs/keyring";
import { WindowsHumanPlane, resolveWindowsPowerShell, WINDOWS_POWERSHELL_PATH } from "../dist/core/human/windows.js";
import { CatalogStore } from "../dist/core/vnext/files.js";
import { applyBinding, prepareBinding, projectBindingPlan, recoverBinding } from "../dist/core/vnext/binding.js";
import { applyManagement, prepareManagement } from "../dist/core/vnext/manage.js";
import { discoverCredentials, inspectLegacyCandidates, inspectLegacyStatus } from "../dist/core/vnext/discovery.js";
import { emptyCatalog, locatorAccount } from "../dist/core/vnext/model.js";
import { inspectProject } from "../dist/core/vnext/project.js";
import { deriveProjectId } from "../dist/core/vault/naming.js";
import { upsertRegistryEntry } from "../dist/core/vault/registry.js";
import { ConnectionStateStore } from "../dist/core/agent/connection-state.js";
import { buildMetadataDriver } from "./helpers/windows-metadata-driver.mjs";

assert.equal(process.platform, "win32");
const root = mkdtempSync(join(tmpdir(), "akc-binding-native-")), home = join(root, "home"), appA = join(root, "app-a"), appB = join(root, "app-b"), moved = join(root, "moved");
for (const path of [home, appA, appB]) mkdirSync(path);
const output = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "akc-binding-images-"))); mkdirSync(output, { recursive: true });
const store = new CatalogStore(home), accounts = new Set(); let helper = null, cancel = false, stage = "new", selectedKind = "v3";
const human = new WindowsHumanPlane(resolveWindowsPowerShell(), request => new Promise(resolve => {
  const child = spawn(request.executable, request.args, { cwd: request.cwd, env: request.env, detached: request.detached, shell: request.shell, stdio: request.stdio, windowsHide: request.windowsHide }); helper = child;
  const timeout = setTimeout(() => child.kill(), 120_000);
  child.once("error", () => { clearTimeout(timeout); helper = null; resolve(null); });
  child.once("close", code => { clearTimeout(timeout); helper = null; resolve(code); });
}));
const presence = Object.assign(locator => human.probeVNextPresence(locator), { all: locators => human.probeVNextPresenceBatch(locators) });
const io = { store, presence, legacy: context => inspectLegacyCandidates(context, presence, home), legacyStatus: (locator, catalog, context) => inspectLegacyStatus(locator, catalog, context, home),
  human: { choose: async plan => {
    const index = plan.candidates.findIndex(c => c.locator.kind === selectedKind); assert.ok(index >= 0);
    const result = human.chooseVNextBinding(plan); await drive("API Key Case - Confirm Binding", index); return result;
  } } };
const managementIO = { store, human: { confirm: async plan => { const result = human.confirmVNextManagement(plan); await drive("API Key Case - Manage Binding"); return result; } } };
const request = { project: appA, environment: "development", variable: "SYNTHETIC_API_KEY", risk: "nonproduction" };
async function binding(r = request) { const plan = await prepareBinding(r, io); assert.doesNotMatch(JSON.stringify(projectBindingPlan(plan)), /PRIVATE_|locator|canonicalPath/); return applyBinding(r, plan.fingerprint, io); }
async function manage(request) { const plan = prepareManagement(request, managementIO); return applyManagement(request, plan.fingerprint, managementIO); }
async function discover(project, variable = "SYNTHETIC_API_KEY") { return discoverCredentials({ project, environment: "development", variable }, io); }
function seed(locator) { const account = locatorAccount(locator); accounts.add(account); new Entry("api-key-case", account).setPassword("akc-synthetic-" + randomUUID()); }
try {
  const id = randomUUID(), time = new Date().toISOString(), catalog = emptyCatalog();
  const credential = { id, label: "PRIVATE_合成共有キー", locator: { kind: "v3", id, generationId: randomUUID() }, generation: 1, classification: "nonproduction", createdAt: time, revisedAt: time };
  seed(credential.locator); catalog.credentials.push(credential); store.compareAndSwap(null, catalog);
  const v1 = { kind: "v1", ref: { name: "SYNTHETIC_" + randomUUID().replaceAll("-", "").toUpperCase(), scope: "user", projectId: null } }; seed(v1);
  upsertRegistryEntry({ ...v1.ref, projectPath: null }, home);
  const v2 = { kind: "v2", ref: { name: "RESEND_API_KEY", scope: "project", projectId: deriveProjectId(appA), service: "resend", environment: "development" } }; seed(v2);
  const connections = new ConnectionStateStore(appA, home), mutation = connections.beginCredentialMutation(v2.ref); assert.equal(mutation.ok, true); assert.equal(connections.finishCredentialMutation(v2.ref, mutation.value, true), true);
  const legacyPath = join(home, ".api-key-case", "index.json"), legacyBytes = readFileSync(legacyPath);
  assert.deepEqual(await human.probeVNextPresenceBatch([credential.locator, v1, v2, { kind: "v3", id: randomUUID(), generationId: randomUUID() }]), ["present", "present", "present", "absent"]);
  assert.equal((await discover(appA)).status, "selection-required");
  cancel = true; assert.equal((await binding()).status, "cancelled"); assert.equal(store.readCatalog().catalog.bindings.length, 0); cancel = false;
  stage = "new"; const first = await binding(); assert.equal(first.status, "completed"); assert.equal((await discover(appA)).status, "registered");
  for (const [project, expected] of [[appA, "registered"], [appB, "selection-required"], [appA, "registered"]]) {
    const child = spawnSync(process.execPath, [resolve("tests/helpers/vnext-discovery-child.mjs"), home, "discover", "--project", project, "--environment", "development", "--variable", "SYNTHETIC_API_KEY", "--json"],
      { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.equal(child.status, 0); const report = JSON.parse(child.stdout); assert.equal(report.status, expected);
    assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE_|locator|canonicalPath|generationId/);
    if (expected === "selection-required") assert.deepEqual(report.bindings, []);
  }
  const noPrompt = { ...request, credentialId: id }; assert.equal((await binding(noPrompt)).status, "unchanged");
  stage = "second-app"; assert.equal((await binding({ ...request, project: appB })).status, "completed");
  assert.equal(store.readCatalog().catalog.credentials.length, 1); assert.equal(store.readCatalog().catalog.bindings.length, 2);
  stage = "legacy-v1"; selectedKind = "v1"; const alias = await binding({ ...request, variable: "LEGACY_API_KEY" }); assert.equal(alias.status, "completed");
  stage = "legacy-v2"; selectedKind = "v2"; assert.equal((await binding({ ...request, variable: "RESEND_API_KEY" })).status, "completed");
  assert.equal((await discover(appA, "RESEND_API_KEY")).bindings[0].stability, "legacy-unversioned");
  assert.ok(readFileSync(legacyPath).equals(legacyBytes), "legacy registry stays byte-for-byte unchanged");
  stage = "classify"; assert.equal((await manage({ action: "classify-environment", bindingId: first.bindingId, risk: "production" })).status, "completed");
  const originalProject = store.readCatalog().catalog.projects.find(p => p.canonicalPath === inspectProject(appA).canonicalPath); renameSync(appA, moved);
  assert.equal((await discover(moved)).status, "unavailable");
  stage = "relink"; const relinked = await manage({ action: "relink", bindingId: first.bindingId, project: moved }); assert.equal(relinked.status, "completed");
  assert.equal(store.readOperation(relinked.operationId).operation.boundBasis.previousProject.canonicalPath, originalProject.canonicalPath);
  assert.equal(store.readCatalog().catalog.projects.find(p => p.id === originalProject.id).revision, originalProject.revision + 1);
  assert.equal((await discover(moved)).status, "registered");
  stage = "unlink"; assert.equal((await manage({ action: "unlink", bindingId: alias.bindingId })).status, "completed");
  assert.equal((await discover(moved, "LEGACY_API_KEY")).status, "selection-required");
  assert.equal(await presence(v1), "present"); assert.equal(await presence(credential.locator), "present");
  assert.equal(recoverBinding(first.operationId, store).status, "completed");
  console.log("PASS native selection/cancel, cross-app reuse, exact legacy aliases, classification, moved-project rejection, relink/unlink, no Secret copy/delete");
} finally {
  helper?.kill(); for (const account of accounts) new Entry("api-key-case", account).deleteCredential();
  rmSync(root, { recursive: true, force: true }); console.log("All dedicated synthetic accounts and metadata cleaned up");
}
async function drive(caption, index = null) {
  assert.ok(helper?.pid); const script = buildMetadataDriver({ helperPid: helper.pid, ownerPid: process.pid, caption, index, cancel,
    imagePath: join(output, `${stage}${cancel ? "-cancel" : ""}.png`) });
  const child = spawn(WINDOWS_POWERSHELL_PATH, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { cwd: root, windowsHide: true, stdio: "ignore", env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", PATH: "C:\\Windows\\System32;C:\\Windows\\System32\\Wbem" } });
  const code = await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(null); }, 45_000); child.once("error", () => { clearTimeout(timer); resolve(null); }); child.once("close", code => { clearTimeout(timer); resolve(code); }); });
  if (code !== 0) helper?.kill(); assert.equal(code, 0, `owned metadata driver: ${stage}`);
}
