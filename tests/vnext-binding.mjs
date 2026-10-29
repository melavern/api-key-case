import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyBinding, prepareBinding, projectBindingPlan, recoverBinding } from "../dist/core/vnext/binding.js";
import { discoverCredentials, inspectLegacyStatus } from "../dist/core/vnext/discovery.js";
import { ConnectionStateStore } from "../dist/core/agent/connection-state.js";
import { deriveProjectId } from "../dist/core/vault/naming.js";
import { emptyCatalog, locatorAccount, validate, catalogSchema } from "../dist/core/vnext/model.js";
import { inspectProject } from "../dist/core/vnext/project.js";
import { buildWindowsBindingScript } from "../dist/core/human/windows-binding.js";
import { encodeWindowsHelperCommand } from "../dist/core/human/windows.js";
import { applyManagement, prepareManagement, manageRequestSchema } from "../dist/core/vnext/manage.js";
import { buildWindowsManagementScript } from "../dist/core/human/windows-binding.js";

const request = { project: "/app-a", environment: "development", variable: "GENERIC_API_KEY", risk: "nonproduction" };
const context = path => ({ canonicalPath: path, directoryIdentity: { dev: "1", ino: path === "/app-a" ? "2" : "3", birthtimeNs: "4" } });
function setup() {
  let catalog = emptyCatalog(), snapshot = null, calls = 0, fail = null;
  const records = new Map(), slots = new Set();
  const credential = { id: randomUUID(), label: "PRIVATE_GLOBAL_LABEL", locator: { kind: "v3", id: "", generationId: randomUUID() }, generation: 1,
    classification: "nonproduction", createdAt: "2026-10-21T00:00:00.000Z", revisedAt: "2026-10-21T00:00:00.000Z" };
  credential.locator.id = credential.id; catalog.credentials.push(credential); slots.add(locatorAccount(credential.locator));
  const clone = x => structuredClone(x);
  const store = {
    readCatalog: () => { if (fail === "read") throw Error(); return snapshot; },
    compareAndSwap: (before, value) => {
      assert.equal(before, snapshot); validate(catalogSchema, value);
      if (fail === "before-cas") throw Error();
      catalog = clone(value); snapshot = { catalog, file: {} };
      if (fail === "after-cas") throw Error(); return snapshot;
    },
    readOperation: id => records.get(id) ?? null,
    saveOperation: (before, value) => {
      assert.equal(before, records.get(value.operationId) ?? null);
      const record = { operation: clone(value), file: {} }; records.set(value.operationId, record); return record;
    }
  };
  snapshot = { catalog, file: {} };
  const io = { store, project: context, presence: async locator => slots.has(locatorAccount(locator)) ? "present" : "absent",
    legacy: async () => ({ status: "available", locators: [] }), human: { choose: async () => { calls++; return { status: "confirmed", index: 0 }; } } };
  return { io, credential, records, slots, catalog: () => catalog, calls: () => calls, fault: p => { fail = p; }, change: () => { catalog.revision++; } };
}
async function bind(f, r = request) { const plan = await prepareBinding(r, f.io); return applyBinding(r, plan.fingerprint, f.io); }

test("unresolved legacy candidates cannot block an explicitly selected healthy v3 in another app", async () => {
  const f = setup(), old = { ...f.credential, id: randomUUID(), locator: { kind: "v2", ref: { name: "RESEND_API_KEY", scope: "project", projectId: "0123456789abcdef", service: "resend", environment: "development" } }, generation: "legacy-unversioned" };
  f.catalog().credentials.push(old); f.slots.add(locatorAccount(old.locator));
  f.io.legacyStatus = locator => locator.kind === "v3" ? "available" : "unavailable";
  f.io.legacy = async () => { throw Error("An explicit selection must not scan unrelated legacy metadata"); };
  assert.equal((await bind(f, { ...request, project: "/app-b", credentialId: f.credential.id })).status, "completed");
  await assert.rejects(() => prepareBinding({ ...request, credentialId: old.id }, f.io));
  f.io.legacy = async () => ({ status: "available", locators: [] });
  assert.deepEqual((await prepareBinding(request, f.io)).candidates.map(c => c.id), [f.credential.id]);
});

for (const withMetadata of [true, false]) test(`relink after a real directory move preserves old v2 references, metadata=${withMetadata}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "akc-v2-move-"));
  try {
    const app = join(root, "old"), moved = join(root, "moved"), home = join(root, "home"); mkdirSync(app); mkdirSync(home);
    const f = setup(); f.io.project = inspectProject;
    const locator = { kind: "v2", ref: { name: "RESEND_API_KEY", scope: "project", projectId: deriveProjectId(app), service: "resend", environment: "development" } };
    if (withMetadata) {
      const metadata = new ConnectionStateStore(app, home), mutation = metadata.beginCredentialMutation(locator.ref);
      assert.equal(mutation.ok, true); assert.equal(metadata.finishCredentialMutation(locator.ref, mutation.value, true), true);
    }
    f.credential.locator = locator; f.credential.generation = "legacy-unversioned"; f.slots.add(locatorAccount(locator));
    f.io.legacyStatus = (l, c, p) => inspectLegacyStatus(l, c, p, home);
    const r = { ...request, project: app, credentialId: f.credential.id }, bound = await bind(f, r);
    assert.equal(bound.status, "completed"); renameSync(app, moved);
    const manage = { ...f.io, human: { confirm: async () => "confirmed" } }, relink = { action: "relink", bindingId: bound.bindingId, project: moved };
    assert.equal((await applyManagement(relink, prepareManagement(relink, manage).fingerprint, manage)).status, "completed");
    assert.equal((await discoverCredentials({ project: moved }, f.io)).status, "registered");
    assert.equal((await bind(f, { ...r, project: moved })).status, "unchanged");
    assert.deepEqual(f.catalog().credentials[0].locator, locator);
    // A pending mutation/lock in the original metadata still fails closed.
    renameSync(moved, app); const pending = new ConnectionStateStore(app, home).beginCredentialMutation(locator.ref); assert.equal(pending.ok, true); renameSync(app, moved);
    assert.equal((await discoverCredentials({ project: moved }, f.io)).status, "unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two fresh Agent interfaces discover a confirmed binding with no value or global listing", async () => {
  const f = setup(); const proposed = projectBindingPlan(await prepareBinding(request, f.io));
  assert.equal(proposed.status, "reviewable"); assert.doesNotMatch(JSON.stringify(proposed), /PRIVATE_GLOBAL_LABEL|locator|generationId|app-a/);
  const result = await bind(f); assert.equal(result.status, "completed"); assert.equal(f.calls(), 1);
  const secondAgent = { ...f.io, human: { choose: async () => { throw Error("No UI in discovery"); } } };
  const discovered = await discoverCredentials(requestWithoutRisk(), secondAgent);
  assert.equal(discovered.status, "registered"); assert.equal(discovered.bindings[0].bindingId, result.bindingId);
  assert.doesNotMatch(JSON.stringify(discovered), /PRIVATE_GLOBAL_LABEL|locator|generationId|app-a/);
  assert.equal((await discoverCredentials({ project: "/app-b", environment: "development", variable: request.variable }, secondAgent)).status, "selection-required");
  assert.equal(f.catalog().bindings.length, 1);
});
function requestWithoutRisk() { const { risk, ...r } = request; return r; }

test("identical binding is unchanged, including case-folded variable, with no second confirmation", async () => {
  const f = setup(); await bind(f); const revision = f.catalog().revision;
  const result = await bind(f, { ...request, credentialId: f.credential.id, variable: "generic_api_key" });
  assert.equal(result.status, "unchanged"); assert.equal(f.catalog().revision, revision); assert.equal(f.calls(), 1);
});
test("one credential can be explicitly associated to two physical apps without copying a slot", async () => {
  const f = setup(); await bind(f); assert.equal((await bind(f, { ...request, project: "/app-b" })).status, "completed");
  assert.equal(f.catalog().bindings.length, 2); assert.equal(f.catalog().credentials.length, 1); assert.equal(f.slots.size, 1); assert.equal(f.calls(), 2);
});
test("stale proposal and cancellation leave the catalog and references unchanged", async () => {
  const f = setup(), plan = await prepareBinding(request, f.io); f.change();
  assert.equal((await applyBinding(request, plan.fingerprint, f.io)).status, "changed"); assert.equal(f.calls(), 0);
  f.io.human.choose = async () => ({ status: "cancelled" }); assert.equal((await bind(f)).status, "cancelled"); assert.equal(f.catalog().bindings.length, 0);
});
test("project replacement during confirmation cannot inherit a binding", async () => {
  const f = setup(); f.io.human.choose = async () => { f.io.project = p => ({ ...context(p), directoryIdentity: { dev: "1", ino: "9007199254740993", birthtimeNs: "4" } }); return { status: "confirmed", index: 0 }; };
  assert.equal((await bind(f)).status, "changed"); assert.equal(f.catalog().bindings.length, 0);
});
test("candidate disappears or metadata becomes pending during confirmation: no association", async () => {
  for (const kind of ["slot", "metadata"]) {
    const f = setup(); f.io.human.choose = async () => { if (kind === "slot") f.slots.clear(); else f.io.legacy = async () => ({ status: "unavailable", locators: [] }); return { status: "confirmed", index: 0 }; };
    const result = await bind(f); assert.ok(["changed", "unavailable"].includes(result.status)); assert.equal(f.catalog().bindings.length, 0);
  }
});
test("legacy exact locator selection creates one unversioned alias and no OS write", async () => {
  const f = setup(); const locator = { kind: "v1", ref: { scope: "user", projectId: null, name: "LEGACY_API_KEY" } };
  f.slots.clear(); f.slots.add(locatorAccount(locator)); f.io.legacy = async () => ({ status: "available", locators: [locator] });
  assert.equal((await bind(f)).status, "completed"); const alias = f.catalog().credentials.find(c => c.locator.kind === "v1");
  assert.deepEqual(alias.locator, locator); assert.equal(alias.generation, "legacy-unversioned"); assert.equal(f.slots.size, 1);
  const discovered = await discoverCredentials(requestWithoutRisk(), f.io); assert.equal(discovered.bindings[0].stability, "legacy-unversioned");
  f.io.legacyStatus = () => "unavailable";
  assert.equal((await discoverCredentials(requestWithoutRisk(), f.io)).status, "unavailable");
});
test("empty scan, absent exact binding, locked backend and corrupt metadata remain distinct", async () => {
  const f = setup(); f.catalog().credentials = []; f.slots.clear();
  assert.equal((await discoverCredentials(requestWithoutRisk(), f.io)).status, "unknown");
  f.io.legacy = async () => ({ status: "unavailable", locators: [] });
  assert.equal((await discoverCredentials(requestWithoutRisk(), f.io)).status, "unavailable");
  const g = setup(); await bind(g); g.slots.clear(); assert.equal((await discoverCredentials(requestWithoutRisk(), g.io)).status, "missing");
  g.io.presence = async () => "unavailable"; assert.equal((await discoverCredentials(requestWithoutRisk(), g.io)).status, "unavailable");
});
for (const point of ["before-cas", "after-cas"]) test(`binding recovery after ${point} never reapplies or reopens Human Plane`, async () => {
  const f = setup(); f.fault(point); const result = await bind(f); assert.equal(result.status, "recovery-required");
  f.fault(null); const recovered = recoverBinding(result.operationId, f.io.store);
  assert.equal(recovered.status, point === "after-cas" ? "completed" : "recovery-required"); assert.equal(f.calls(), 1);
  assert.equal(f.catalog().bindings.length, point === "after-cas" ? 1 : 0);
});
test("native binding script contains metadata only, escaped text, deliberate selection and ignored-output transport", async () => {
  const f = setup(); f.credential.label = "日本語's $key";
  const plan = await prepareBinding(request, f.io), script = buildWindowsBindingScript(plan);
  assert.match(script, /日本語''s \$key/); assert.match(script, /SelectedIndex=-1/); assert.match(script, /resultCode=100/);
  assert.doesNotMatch(script, /CredRead|CredWrite|WriteAllText|Write-Host|Write-Output/); assert.ok(encodeWindowsHelperCommand(script).length < 29000);
});
test("physical rename/replacement is observed independently of copied workspace markers", () => {
  const root = mkdtempSync(join(tmpdir(), "akc-project-"));
  try {
    const a = join(root, "a"), b = join(root, "b"); mkdirSync(a); const original = inspectProject(a);
    assert.equal(typeof original.directoryIdentity.ino, "string"); renameSync(a, b); const moved = inspectProject(b);
    assert.deepEqual(moved.directoryIdentity, original.directoryIdentity); assert.notEqual(moved.canonicalPath, original.canonicalPath);
    mkdirSync(a); assert.notDeepEqual(inspectProject(a).directoryIdentity, original.directoryIdentity);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unlink changes only the chosen association, retaining shared credential and other app", async () => {
  const f = setup(), first = await bind(f); await bind(f, { ...request, project: "/app-b" });
  let confirmed = 0; const io = { ...f.io, human: { confirm: async () => { confirmed++; return "confirmed"; } } };
  const r = { action: "unlink", bindingId: first.bindingId }, plan = prepareManagement(r, io);
  assert.equal((await applyManagement(r, plan.fingerprint, io)).status, "completed");
  assert.equal(confirmed, 1); assert.equal(f.catalog().credentials.length, 1); assert.equal(f.slots.size, 1);
  assert.equal(f.catalog().bindings.length, 1); assert.equal((await discoverCredentials({ ...requestWithoutRisk(), project: "/app-b" }, f.io)).status, "registered");
});
test("relink requires exact confirmation and revises the project while preserving old path evidence", async () => {
  const f = setup(), first = await bind(f), original = structuredClone(f.catalog().projects[0]);
  const r = { action: "relink", bindingId: first.bindingId, project: "/app-renamed" };
  const io = { ...f.io, human: { confirm: async () => "confirmed" } };
  const result = await applyManagement(r, prepareManagement(r, io).fingerprint, io);
  assert.equal(result.status, "completed"); assert.equal(f.catalog().projects[0].revision, original.revision + 1);
  assert.equal(f.catalog().projects[0].id, original.id); assert.deepEqual(f.catalog().bindings.map(b => b.id), [first.bindingId]);
  assert.deepEqual(f.records.get(result.operationId).operation.boundBasis.previousProject, original);
  assert.equal((await discoverCredentials(requestWithoutRisk(), f.io)).status, "selection-required");
  const script = buildWindowsManagementScript(prepareManagement({ ...r, project: "/app-renamed-again" }, io));
  assert.match(script, /Prior use plans and approvals are not inherited/); assert.doesNotMatch(script, /CredRead|CredWrite|DeleteCredential|Write-Output/);
});
test("environment classification changes all intended uses via environment revision, never an execution grant", async () => {
  const f = setup(), first = await bind(f), previousBinding = structuredClone(f.catalog().bindings[0]);
  const io = { ...f.io, human: { confirm: async () => "confirmed" } }, r = { action: "classify-environment", bindingId: first.bindingId, risk: "production" };
  const result = await applyManagement(r, prepareManagement(r, io).fingerprint, io);
  assert.equal(result.status, "completed"); assert.equal(result.permission, "none"); assert.equal(result.executed, false);
  assert.equal(f.catalog().environments[0].risk, "production"); assert.equal(f.catalog().environments[0].revision, 2); assert.deepEqual(f.catalog().bindings[0], previousBinding);
  io.human.confirm = async () => { throw Error("No duplicate confirmation"); };
  assert.equal((await applyManagement(r, prepareManagement(r, io).fingerprint, io)).status, "unchanged");
});
test("management rejects relinking to another known app and stale/cancelled changes", async () => {
  const f = setup(), first = await bind(f); await bind(f, { ...request, project: "/app-b" });
  const io = { ...f.io, human: { confirm: async () => "cancelled" } };
  assert.throws(() => prepareManagement({ action: "relink", bindingId: first.bindingId, project: "/app-b" }, io));
  const r = { action: "unlink", bindingId: first.bindingId }, plan = prepareManagement(r, io);
  assert.equal((await applyManagement(r, plan.fingerprint, io)).status, "cancelled"); assert.equal(f.catalog().bindings.length, 2);
  f.change(); assert.equal((await applyManagement(r, plan.fingerprint, io)).status, "changed");
  assert.equal(manageRequestSchema.safeParse({ ...r, approved: true }).success, false);
  assert.equal(manageRequestSchema.safeParse({ ...r, project: "/unrelated" }).success, false);
});
