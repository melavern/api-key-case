import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogSchema, credentialSchema, emptyCatalog, locatorAccount, locatorSchema, operationSchema, validate } from "../dist/core/vnext/model.js";
import { cancelBeforeSave, commitRegistration, prepareRegistration, reconcileRegistration, useAttemptAction } from "../dist/core/vnext/registration.js";
import { CatalogStore } from "../dist/core/vnext/files.js";
import { legacyV2Locators, readLegacyIndex } from "../dist/core/vnext/legacy.js";
import { parseMetadata } from "../dist/core/vnext/json.js";
import { proposeBindingChange, usageBasis } from "../dist/core/vnext/basis.js";
import { physicalIdentity } from "../dist/core/vnext/identity.js";
import { capabilities, discover, discoverySchema } from "../dist/core/vnext/status.js";
import { VNEXT_WINDOWS_REGISTRATION_ACCEPTED, VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED, VNEXT_WINDOWS_LOCAL_ACCEPTED, VNEXT_WINDOWS_VERCEL_ACCEPTED, VNEXT_WINDOWS_GITHUB_ACCEPTED } from "../dist/core/vnext/gates.js";
import { toAccount, toDestinationAccount } from "../dist/core/vault/naming.js";

const now = "2026-10-21T00:00:00.000Z", later = "2026-10-21T00:00:01.000Z";
const hash = "a".repeat(64);
function privateFixture(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(home).toString("base64")}'));
      $me=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=Get-Acl -LiteralPath $p; $a.SetAccessRuleProtection($true,$false);
      foreach($sid in @($me.Value,'S-1-5-18','S-1-5-32-544')) { $r=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r) }; Set-Acl -LiteralPath $p -AclObject $a`;
    const result = spawnSync(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, encoding: "utf8" });
    assert.equal(result.status, 0, "disposable fixture ACL setup");
  }
  return home;
}
function credential() {
  const id = randomUUID();
  return { id, label: "Arbitrary issuer key", locator: { kind: "v3", id, generationId: randomUUID() }, generation: 1,
    classification: "unknown", createdAt: now, revisedAt: now };
}
function fixture() {
  const c = emptyCatalog(), key = credential(), projectId = randomUUID(), environmentId = randomUUID();
  c.credentials.push(key);
  c.projects.push({ id: projectId, canonicalPath: "/synthetic/app", directoryIdentity: { dev: "1", ino: "2", birthtimeNs: "3" }, revision: 1 });
  c.environments.push({ id: environmentId, projectId, label: "dev", risk: "nonproduction", revision: 1 });
  c.bindings.push({ id: randomUUID(), projectId, environmentId, variableName: "custom_Key", credentialId: key.id, revision: 1 });
  return validate(catalogSchema, c);
}
function rotation(c) {
  const prior = c.credentials[0];
  return { ...prior, locator: { ...prior.locator, generationId: randomUUID() }, generation: prior.generation + 1, revisedAt: later };
}
function query(c) { return { projectId: c.projects[0].id, canonicalPath: c.projects[0].canonicalPath,
  directoryIdentity: c.projects[0].directoryIdentity, environmentId: c.environments[0].id, variableName: "custom_Key" }; }

test("typed locator namespace preserves all legacy accounts and rejects widening", () => {
  const v1 = { kind: "v1", ref: { name: "CUSTOM_API_KEY", scope: "user", projectId: null } };
  assert.equal(locatorAccount(v1), toAccount(v1.ref));
  const v2 = legacyV2Locators("a".repeat(16)); assert.equal(v2.length, 11);
  assert.equal(new Set(v2.map(locatorAccount)).size, 11);
  for (const locator of v2) assert.equal(locatorAccount(locator), toAccount(locator.ref));
  const key = credential(); assert.match(locatorAccount(key.locator), /^v3\|credential\|/);
  assert.notEqual(locatorAccount(key.locator), toDestinationAccount({ kind: "destination", fingerprint: hash }));
  for (const bad of [
    { ...key.locator, value: "synthetic-canary" }, { ...key.locator, id: "../oops" }, { ...key.locator, kind: "destination" },
    { kind: "v1", ref: { ...v1.ref, name: "lowercase" } }, { kind: "v1", ref: { ...v1.ref, projectId: "b".repeat(16) } },
    { kind: "v2", ref: { ...v2.at(-1).ref, environment: "production" } }
  ]) assert.equal(locatorSchema.safeParse(bad).success, false);
  assert.throws(() => locatorAccount({ ...key.locator, id: "synthetic-canary" }), e => !e.message.includes("synthetic-canary"));
});

test("physical identities preserve adjacent NTFS integers that Number would merge", () => {
  const large = 12384898976447871n;
  assert.equal(Number(large), Number(large + 1n));
  const a = physicalIdentity({ dev: 3500298673n, ino: large, birthtimeNs: 1784341299284622800n });
  const b = physicalIdentity({ dev: 3500298673n, ino: large + 1n, birthtimeNs: 1784341299284622800n });
  assert.notDeepEqual(a, b); assert.equal(a.ino, "12384898976447871");
  const catalog = fixture(); catalog.projects[0].directoryIdentity = a;
  assert.equal(validate(catalogSchema, JSON.parse(JSON.stringify(catalog))).projects[0].directoryIdentity.ino, a.ino);
  catalog.projects[0].directoryIdentity = { dev: 3500298673, ino: Number(large), birthtimeMs: 1784341299284.6228 };
  assert.equal(catalogSchema.safeParse(catalog).success, false);
});

test("strict mixed catalog references cannot alias, borrow a scope or claim a legacy generation", () => {
  const c = fixture();
  const legacy = [{ kind: "v1", ref: { name: "OLD_KEY", scope: "project", projectId: "a".repeat(16) } }, ...legacyV2Locators("a".repeat(16))];
  c.credentials.push(...legacy.map(locator => ({ ...credential(), locator, generation: "legacy-unversioned" })));
  assert.equal(validate(catalogSchema, c).credentials.length, 13);
  const reject = change => { const bad = structuredClone(c); change(bad); assert.equal(catalogSchema.safeParse(bad).success, false); };
  reject(x => x.credentials[1].generation = 1);
  reject(x => x.credentials.push({ ...x.credentials[1], id: randomUUID() }));
  reject(x => x.credentials[0].locator.id = randomUUID());
  reject(x => x.bindings.push({ ...x.bindings[0], id: randomUUID(), variableName: "CUSTOM_key" }));
  reject(x => x.bindings[0].environmentId = randomUUID());
  reject(x => x.environments[0].projectId = randomUUID());
  reject(x => x.projects.push({ ...x.projects[0], id: randomUUID() }));
  reject(x => x.credentials[0].secretHash = hash);
  reject(x => x.schemaVersion = 2);
});

test("nonexecuting generic destination and reviewed package-script descriptors are strict", () => {
  const c = fixture(), projectId = c.projects[0].id;
  c.destinations.push({ id: randomUUID(), projectId, kind: "cloudflare", canonicalConfigRelativePath: "wrangler.jsonc", configSection: "staging",
    providerAccountId: "a".repeat(32), resourceId: "ordinary-worker", applicationEnvironment: "preview", revision: 1, reviewedAt: now });
  c.launchProfiles.push({ id: randomUUID(), projectId, kind: "node-package-script", runtimeIdentity: { executable: "/usr/bin/node", fingerprint: hash },
    approvedEntryOrScript: "dev", packageManifestRevision: { manifestFingerprint: hash, lockfileFingerprint: hash, scriptDefinition: "next dev",
      packageManagerIdentity: { executable: "/usr/bin/npm", fingerprint: hash } }, cwd: ".", bindingIds: [c.bindings[0].id], maxDurationSeconds: 7200, revision: 1, reviewedAt: now });
  assert.equal(validate(catalogSchema, c).destinations[0].services, undefined);
  const basis = usageBasis(c, [c.bindings[0].id], c.launchProfiles[0].id);
  for (const mutate of [x => x.launchProfiles[0].packageManifestRevision.scriptDefinition = "next dev --port 3001",
    x => x.launchProfiles[0].runtimeIdentity.fingerprint = "b".repeat(64), x => x.projects[0].revision++,
    x => x.credentials[0] = rotation(x), x => x.bindings[0].revision++]) {
    const changed = structuredClone(c); mutate(changed);
    assert.notEqual(usageBasis(changed, [c.bindings[0].id], c.launchProfiles[0].id), basis);
  }
  for (const mutate of [x => x.destinations[0].services = ["resend"], x => x.destinations[0].canonicalConfigRelativePath = "../wrangler.jsonc",
    x => x.launchProfiles[0].approvedEntryOrScript = "arbitrary", x => delete x.launchProfiles[0].packageManifestRevision,
    x => x.launchProfiles[0].bindingIds = [randomUUID()], x => x.launchProfiles[0].maxDurationSeconds = 7201]) {
    const bad = structuredClone(c); mutate(bad); assert.equal(catalogSchema.safeParse(bad).success, false);
  }
});

test("Binding proposals preserve generations and identical requests are no-ops", () => {
  const c = fixture(), binding = c.bindings[0];
  const same = proposeBindingChange(c, binding.id, binding);
  assert.equal(same.changed, false); assert.equal(same.catalog.revision, c.revision);
  const next = { ...binding, variableName: "Another_Key", revision: 2 };
  const changed = proposeBindingChange(c, binding.id, next);
  assert.equal(changed.changed, true); assert.deepEqual(changed.catalog.credentials, c.credentials);
  assert.equal(changed.catalog.bindings[0].revision, 2);
  assert.throws(() => proposeBindingChange(c, binding.id, { ...next, revision: 1 }));
  assert.equal(proposeBindingChange(c, binding.id, null).catalog.bindings.length, 0);
  assert.throws(() => proposeBindingChange(c, randomUUID(), null));
});

test("prepared, cancellation, unknown save and CAS preserve the previous active generation", () => {
  const c = fixture(), next = rotation(c), original = structuredClone(c);
  const operation = prepareRegistration(c, next, randomUUID(), now);
  assert.equal(operation.state, "prepared");
  assert.equal(cancelBeforeSave(operation, later).state, "cancelled");
  assert.equal(reconcileRegistration(cancelBeforeSave(operation, later), c, "present", later).state, "cancelled");
  assert.equal(reconcileRegistration(operation, c, "absent", later).state, "unknown");
  assert.equal(reconcileRegistration(operation, c, "unavailable", later).state, "recovery-required");
  const stored = reconcileRegistration(operation, c, "present", later);
  assert.equal(stored.state, "stored-uncommitted");
  assert.throws(() => cancelBeforeSave(stored, later));
  const committed = commitRegistration(stored, c, later);
  assert.equal(committed.operation.state, "committed");
  assert.deepEqual(committed.catalog.bindings, c.bindings);
  assert.equal(committed.catalog.credentials[0].generation, 2);
  assert.deepEqual(c, original);
  assert.equal(reconcileRegistration(operation, committed.catalog, "present", later).state, "committed");
  const changed = { ...c, revision: c.revision + 1 };
  assert.equal(commitRegistration(stored, changed, later).operation.state, "conflict");
  assert.equal(reconcileRegistration(operation, changed, "present", later).state, "conflict");
});

test("two pure writers and lost responses cannot create a second active generation", () => {
  let c = fixture(); const before = structuredClone(c), slots = new Set(); let saves = 0;
  const a = prepareRegistration(c, rotation(c), randomUUID(), now), b = prepareRegistration(c, rotation(c), randomUUID(), now);
  // Fake native UI writes only its prewritten candidate. Recovery only calls has().
  const save = o => { slots.add(o.candidateGenerationId); saves++; };
  save(a); save(b);
  const readyA = reconcileRegistration(a, c, "present", later), readyB = reconcileRegistration(b, c, "present", later);
  c = commitRegistration(readyA, c, later).catalog;
  assert.equal(commitRegistration(readyB, c, later).operation.state, "conflict");
  assert.equal(reconcileRegistration(a, c, "present", later).state, "committed");
  assert.equal(reconcileRegistration(b, c, "present", later).state, "conflict");
  assert.equal(slots.size, 2); assert.equal(saves, 2);
  assert.notEqual(before.credentials[0].locator.generationId, c.credentials[0].locator.generationId);
  assert.equal(slots.has(b.candidateGenerationId), true); // losing candidate is retained
  assert.throws(() => prepareRegistration(c, c.credentials[0], randomUUID(), later));
});

test("value-free projection hides other projects, labels, paths and candidate accounts", async () => {
  const c = fixture(); c.credentials.push({ ...credential(), label: "Other project private purpose" });
  const present = await discover(c, query(c), async () => "present");
  assert.equal(present.status, "registered");
  const output = JSON.stringify(present);
  for (const text of ["Other project", "Arbitrary issuer", "/synthetic", "locator", c.credentials[0].locator.generationId]) assert.equal(output.includes(text), false);
  assert.equal((await discover(c, query(c), async () => "absent")).status, "missing");
  assert.equal((await discover(c, query(c), async () => { throw Error("synthetic-canary"); })).status, "unavailable");
  assert.equal((await discover(c, { ...query(c), variableName: "unknown_key" }, async () => { throw Error("should not probe global keys"); })).status, "selection-required");
  assert.equal((await discover(c, { ...query(c), canonicalPath: "/copied/app" }, async () => "present")).status, "unavailable");
  assert.equal((await discover(null, query(c), async () => "absent")).status, "unknown");
  assert.equal(discoverySchema.safeParse({ ...present, value: "synthetic-canary" }).success, false);
});

test("capabilities report accepted registration independently and receipts never authorize replay", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const report = capabilities(platform, "unavailable", 22000);
    for (const feature of ["storage", "humanInput", "highRiskApproval", "cloudflareUse", "localUse", "vercelUse", "githubUse"]) assert.notEqual(report[feature].state, "available");
    const reachable = capabilities(platform, "available", 22000);
    assert.equal(reachable.storage.state === "available", platform === "win32" && VNEXT_WINDOWS_REGISTRATION_ACCEPTED);
    for (const feature of ["highRiskApproval", "cloudflareUse"]) assert.equal(reachable[feature].state === "available", platform === "win32" && VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED && VNEXT_WINDOWS_REGISTRATION_ACCEPTED);
    assert.equal(reachable.localUse.state === "available", platform === "win32" && VNEXT_WINDOWS_LOCAL_ACCEPTED && VNEXT_WINDOWS_REGISTRATION_ACCEPTED);
    assert.equal(reachable.vercelUse.state === "available", platform === "win32" && VNEXT_WINDOWS_VERCEL_ACCEPTED && VNEXT_WINDOWS_REGISTRATION_ACCEPTED);
    assert.equal(reachable.githubUse.state === "available", platform === "win32" && VNEXT_WINDOWS_GITHUB_ACCEPTED && VNEXT_WINDOWS_REGISTRATION_ACCEPTED);
  }
  const base = prepareRegistration(fixture(), credential(), randomUUID(), now);
  const { candidateCredential, ...boundBasis } = base.boundBasis;
  const operation = { ...base, kind: "cloudflare-use", candidateGenerationId: undefined, boundBasis, state: "planned" };
  assert.equal(useAttemptAction(operation), "review-plan");
  for (const state of ["prepared", "executing", "unknown"]) assert.equal(useAttemptAction({ ...operation, state }), "recovery-required");
  assert.equal(useAttemptAction({ ...operation, state: "completed" }), "settled");
  assert.equal(operationSchema.safeParse({ ...operation, authority: "approved" }).success, false);
  assert.equal(operationSchema.safeParse({ ...operation, state: "committed" }).success, false);
});

test("Windows build support never removes free input but fails high-risk capabilities closed", () => {
  for (const build of [21999, 19045, null, NaN, Infinity]) {
    const report = capabilities("win32", "available", build);
    assert.equal(report.storage.state, "available"); assert.equal(report.humanInput.state, "available");
    for (const feature of ["highRiskApproval", "cloudflareUse", "localUse", "vercelUse", "githubUse"]) assert.equal(report[feature].state, "unavailable");
  }
  assert.equal(capabilities("win32", "available", 22000).cloudflareUse.state, "available");
});

test("strict JSON rejects duplicate keys, invalid UTF8 and unexpected formats", () => {
  for (const text of ['{"a":1,"a":2}', '{"x":{"y":1,"y":2}}', '{/*comment*/"a":1}', '{"a":1,}', '[]', '{}{}']) assert.throws(() => parseMetadata(Buffer.from(text)));
  assert.throws(() => parseMetadata(Buffer.from([0xff])));
});

test("disposable persistence reopens mixed catalog, exact operations and rejects stale writers", () => {
  const home = privateFixture("akc-vnext-contract-");
  try {
    const store = new CatalogStore(home); assert.equal(store.readCatalog(), null);
    const initial = store.compareAndSwap(null, emptyCatalog());
    const mixed = fixture(); mixed.revision = 1;
    mixed.credentials.push({ ...credential(), locator: { kind: "v1", ref: { name: "OLD_KEY", scope: "user", projectId: null } }, generation: "legacy-unversioned" });
    mixed.credentials.push(...legacyV2Locators("a".repeat(16)).map(locator => ({ ...credential(), locator, generation: "legacy-unversioned" })));
    const saved = store.compareAndSwap(initial, mixed);
    assert.deepEqual(new CatalogStore(home).readCatalog().catalog, mixed);
    assert.throws(() => store.compareAndSwap(initial, mixed), /conflict/);
    const operation = prepareRegistration(mixed, rotation(mixed), randomUUID(), now);
    const pending = store.saveOperation(null, operation);
    assert.throws(() => store.saveOperation(null, operation), /conflict/);
    assert.deepEqual(new CatalogStore(home).readOperation(operation.operationId).operation, operation);
    const recovered = reconcileRegistration(operation, mixed, "present", later);
    const staged = store.saveOperation(pending, recovered);
    const committed = commitRegistration(recovered, mixed, later);
    store.compareAndSwap(saved, committed.catalog);
    // Simulate response loss after rename, before the journal's committed state.
    const fresh = new CatalogStore(home);
    const result = reconcileRegistration(fresh.readOperation(operation.operationId).operation, fresh.readCatalog().catalog, "present", later);
    assert.equal(result.state, "committed");
    const settled = store.saveOperation(staged, result);
    assert.throws(() => store.saveOperation(settled, { ...result, state: "prepared" }), /conflict/);
    assert.throws(() => store.readOperation("../catalog"));
    const path = join(home, ".api-key-case", "vnext", "catalog.json"), bytes = readFileSync(path);
    mkdirSync(join(home, ".api-key-case", "vnext", "lock"), { mode: 0o700 });
    assert.throws(() => store.readCatalog(), /lock-present/);
    assert.deepEqual(readFileSync(path), bytes);
    rmSync(join(home, ".api-key-case", "vnext", "lock"), { recursive: true });
    writeFileSync(`${path}.tmp`, "uncertain", { mode: 0o600 });
    assert.throws(() => store.readCatalog(), /temporary-file-present/);
    assert.deepEqual(readFileSync(path), bytes);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("read-only legacy index preserves exact bytes for absent, invalid, locked and hardlinked data", () => {
  const home = privateFixture("akc-vnext-legacy-"), path = join(home, "index.json");
  try {
    assert.equal(readLegacyIndex(path).status, "not-recorded");
    for (const bytes of ["{broken", '{"version":2,"entries":[]}', '{"version":1,"version":1,"entries":[]}']) {
      writeFileSync(path, bytes, { mode: 0o600 });
      assert.equal(readLegacyIndex(path).status, "unavailable"); assert.equal(readFileSync(path, "utf8"), bytes);
    }
    const bytes = JSON.stringify({ version: 1, entries: [{ name: "LEGACY_KEY", scope: "user", projectId: null, projectPath: null, createdAt: now, updatedAt: now }] });
    writeFileSync(path, bytes, { mode: 0o600 });
    assert.equal(readLegacyIndex(path).status, "available"); assert.equal(readFileSync(path, "utf8"), bytes);
    linkSync(path, join(home, "hardlink.json")); assert.equal(readLegacyIndex(path).status, "unavailable");
    assert.equal(readFileSync(path, "utf8"), bytes);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("wrong POSIX owner/permissions and symlinked metadata fail closed", { skip: process.platform === "win32" ? "POSIX ownership fixture; Windows DACL checked by native read" : false }, () => {
  const home = mkdtempSync(join(tmpdir(), "akc-vnext-unsafe-"));
  try {
    const store = new CatalogStore(home); store.compareAndSwap(null, emptyCatalog());
    const root = join(home, ".api-key-case", "vnext"), path = join(root, "catalog.json");
    chmodSync(path, 0o644); assert.throws(() => store.readCatalog(), /unsafe-path/);
    chmodSync(path, 0o600); renameForLink(path, home);
    assert.throws(() => store.readCatalog(), /unsafe-path/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
function renameForLink(path, home) {
  const bytes = readFileSync(path); rmSync(path); const target = join(home, "outside.json");
  writeFileSync(target, bytes, { mode: 0o600 }); symlinkSync(target, path);
}
