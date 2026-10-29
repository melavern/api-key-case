import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConnectionInventory, renderConnectionInventory } from '../dist/core/agent/connection-inventory.js';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { clerkCredentialRef, connectionCredentialRef, CREDENTIAL_SERVICES, credentialEnvironments, credentialRefForService } from '../dist/core/agent/connection-credential.js';
import { DeploymentHistory } from '../dist/core/deploy/history.js';
import { canonicalProjectRealpath, deriveProjectId, toAccount, VAULT_SERVICE } from '../dist/core/vault/naming.js';

const services = ['resend', 'clerk'];
const environments = ['development', 'preview', 'production'];
const canary = 'synthetic-inventory-private-canary-QZ73';
const fingerprint = 'e'.repeat(64);
const version = '12345678-1234-1234-1234-123456789abc';
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const rowOf = (report, service, environment) => {
  const row = report.slots.find(row => row.service === service && row.environment === environment);
  assert.ok(row, `${service}/${environment} must be discoverable`);
  return row;
};
const stateName = ref => `credential-${ref.service === 'clerk' ? 'clerk-' : ''}${ref.environment}.json`;
const metadataDir = (home, project, kind) => join(home, '.api-key-case', kind,
  createHash('sha256').update(kind === 'deployment-history' ? realpathSync.native(project) : canonicalProjectRealpath(project)).digest('hex'));

// Include paths, types, permissions and bytes, but not access times changed by reads.
function snapshot(path) {
  if (!existsSync(path)) return null;
  const visit = (dir, relative = '') => readdirSync(dir).sort().flatMap(name => {
    const file = join(dir, name), relativeName = join(relative, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) return [[relativeName, 'symlink', readlinkSync(file)]];
    if (stat.isDirectory()) return [[relativeName, 'directory', stat.mode], ...visit(file, relativeName)];
    return [[relativeName, 'file', stat.mode, createHash('sha256').update(readFileSync(file)).digest('hex')]];
  });
  return JSON.stringify(visit(path));
}

function closed(report, fixture) {
  keys(report, ['schemaVersion', 'projectId', 'status', 'inspection', 'slots', 'currentHealth', 'permission', 'executed']);
  assert.equal(report.schemaVersion, 2);
  assert.ok(['available', 'partial', 'unavailable'].includes(report.status));
  assert.equal(report.inspection, 'local-only');
  assert.equal(report.currentHealth, 'unverified');
  assert.equal(report.permission, 'none');
  assert.equal(report.executed, false);
  if (report.projectId !== null) {
    assert.equal(report.projectId, deriveProjectId(fixture.project));
    assert.deepEqual(report.slots.map(row => `${row.service}/${row.environment}`),
      CREDENTIAL_SERVICES.flatMap(service => credentialEnvironments(service).map(environment => `${service}/${environment}`)));
  } else assert.deepEqual(report.slots, []);
  for (const row of report.slots) {
    keys(row, ['service', 'environment', 'credential', 'scope', 'presence', 'registration', 'revision', 'selection', 'history', 'nextStep']);
    assert.equal(row.scope, 'project');
    assert.equal(row.credential, ({resend:'RESEND_API_KEY',clerk:'CLERK_SECRET_KEY',openai:'OPENAI_API_KEY','stripe-test':'STRIPE_API_KEY'})[row.service]);
    assert.ok(['registered', 'missing', 'unavailable'].includes(row.presence));
    assert.ok(['settled', 'pending', 'not-recorded', 'unavailable'].includes(row.registration));
    assert.ok(row.revision === null || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.revision));
    assert.ok(['review-metadata', 'review-selected-native-route', 'resume-selected-connection', 'review-recorded-environment', 'review-slot-state', 'review-consumer-contract'].includes(row.nextStep));
    keys(row.selection, ['status', 'routes']);
    assert.ok(['selected', 'not-selected', 'unavailable'].includes(row.selection.status));
    for (const route of row.selection.routes) {
      keys(route, ['route', 'destination']);
      assert.ok(['provider-native', 'api-key-case-managed', 'manual'].includes(route.route));
      assert.ok(['local', 'vercel', 'cloudflare', 'github', 'manual'].includes(route.destination));
    }
    keys(row.history, ['status', 'placements']);
    assert.ok(['available', 'not-recorded', 'unavailable'].includes(row.history.status));
    assert.equal(new Set(row.history.placements.map(item => item.target)).size, row.history.placements.length);
    for (const placement of row.history.placements) {
      keys(placement, ['target', 'outcome', 'recordedAt', 'registrationRelation', 'authority']);
      assert.ok(['cloudflare', 'vercel', 'github'].includes(placement.target));
      assert.ok(['completed', 'incomplete', 'unknown'].includes(placement.outcome));
      assert.ok(['same-recorded-revision', 'different-recorded-revision', 'unverified'].includes(placement.registrationRelation));
      assert.equal(placement.authority, 'historical-local-receipt');
      assert.ok(Number.isFinite(Date.parse(placement.recordedAt)));
    }
  }
  const output = JSON.stringify(report) + renderConnectionInventory(report);
  for (const forbidden of [canary, fixture.project, fixture.home, fingerprint, version]) assert.ok(!output.includes(forbidden), 'closed output excludes private bytes, paths and destination/version identifiers');
}

function fixture(root, name) {
  const dir = join(root, name), project = join(dir, 'project'), home = join(dir, 'home');
  mkdirSync(project, { recursive: true }); mkdirSync(home);
  const store = new ConnectionStateStore(project, home), history = new DeploymentHistory(project, home);
  const refs = CREDENTIAL_SERVICES.flatMap(service => credentialEnvironments(service).map(environment => credentialRefForService(project, environment, service)));
  const values = new Map(), calls = [], unexpected = [];
  const vault = new Proxy({}, { get(_target, property) {
    if (property !== 'hasSecret') { unexpected.push(String(property)); throw Error(canary); }
    return async ref => {
      const expected = refs.find(item => toAccount(item) === toAccount(ref));
      assert.deepEqual(ref, expected, 'only exact known project v2 refs may be inspected');
      calls.push(toAccount(ref));
      const value = values.get(toAccount(ref));
      if (value instanceof Error) throw value;
      return value === true;
    };
  } });
  const f = { dir, project, home, store, history, refs, values, calls, unexpected, vault,
    connectionDir: metadataDir(home, project, 'connections'), historyDir: metadataDir(home, project, 'deployment-history') };
  f.ref = (service, environment) => refs.find(ref => ref.service === service && ref.environment === environment);
  f.register = (ref, present = true) => {
    const mutation = store.beginCredentialMutation(ref); assert.equal(mutation.ok, true);
    assert.equal(store.finishCredentialMutation(ref, mutation.value, true), true);
    values.set(toAccount(ref), present); return mutation.value;
  };
  f.select = (service, environment, route = 'api-key-case-managed', destination = service === 'clerk' ? 'cloudflare' : 'local') => {
    const input = { service, environment, route, destination: { kind: destination }, sendingDomain: null };
    const result = service === 'resend' ? store.saveIntent(input) : route === 'provider-native' ? store.saveClerkNativeIntent(input) : store.saveClerkManagedIntent(input);
    assert.equal(result.ok, true); return result.value;
  };
  f.receipt = (ref, target, outcome, revision = store.credentialRevision(ref)) => {
    const input = { ref, target, credentialRevision: revision, destinationId: fingerprint, intentFingerprint: 'd'.repeat(64), force: false };
    const id = ref.service === 'clerk' ? history.beginClerkPreparation(input) : history.beginConnection(input);
    assert.ok(id, 'valid fixture receipt');
    if (outcome !== 'unknown') assert.equal(ref.service === 'clerk'
      ? history.finishClerkPreparation(id, outcome, outcome === 'completed' ? version : null)
      : history.finish(id, outcome), true);
    return history.read().entries.find(entry => entry.id === id);
  };
  f.read = async () => {
    const before = snapshot(dir), report = await readConnectionInventory(project, { vault, baseDir: home });
    assert.equal(snapshot(dir), before, 'inventory does not create, rewrite, repair, select or remove metadata');
    assert.deepEqual(unexpected, [], 'no vault enumeration, getter, probe or mutation is allowed');
    closed(report, f); return report;
  };
  return f;
}

export async function runConnectionInventoryTests() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'akc-inventory-')));
  let count = 0;
  try {
    const empty = fixture(root, 'empty');
    const first = await empty.read(); count++;
    assert.equal(first.status, 'available');
    assert.equal(existsSync(join(empty.home, '.api-key-case')), false);
    assert.deepEqual(empty.calls, empty.refs.map(toAccount));
    assert.ok(first.slots.every(row => row.presence === 'missing' && row.registration === 'not-recorded' && row.revision === null && row.selection.status === 'not-selected' && row.history.status === 'not-recorded'));

    // The important user path: register earlier environments, then change selections.
    const all = fixture(root, 'all-environments');
    const revisions = new Map(all.refs.map(ref => [toAccount(ref), all.register(ref)]));
    all.select('resend', 'development'); all.select('resend', 'production', 'api-key-case-managed', 'vercel');
    all.select('clerk', 'development'); all.select('clerk', 'production');
    all.select('clerk', 'development', 'provider-native', 'vercel'); all.select('clerk', 'preview', 'provider-native', 'vercel');
    const discovered = await all.read(); count++;
    assert.equal(discovered.status, 'available');
    assert.deepEqual(all.calls, all.refs.map(toAccount));
    for (const row of discovered.slots) {
      assert.equal(row.presence, 'registered'); assert.equal(row.registration, 'settled');
      assert.equal(row.revision, revisions.get(toAccount(all.ref(row.service, row.environment))));
    }
    for (const service of services) assert.equal(rowOf(discovered, service, 'development').nextStep, 'review-recorded-environment');
    assert.equal(rowOf(discovered, 'resend', 'preview').nextStep, 'review-recorded-environment');
    for (const service of services) assert.equal(rowOf(discovered, service, 'production').nextStep, 'resume-selected-connection');
    assert.equal(rowOf(discovered, 'clerk', 'preview').nextStep, 'review-selected-native-route');
    assert.deepEqual(rowOf(discovered, 'resend', 'production').selection.routes, [{ route: 'api-key-case-managed', destination: 'vercel' }]);
    assert.match(renderConnectionInventory(discovered), /再入力せず/);
    assert.match(renderConnectionInventory(discovered), /現在の接続成功|現在の状態/);

    const states = fixture(root, 'presence-states');
    states.register(states.ref('resend', 'development'), false);
    states.values.set(toAccount(states.ref('resend', 'preview')), true);
    states.values.set(toAccount(states.ref('resend', 'production')), Error(canary));
    const pendingRef = states.ref('clerk', 'preview'), pending = states.store.beginCredentialMutation(pendingRef);
    assert.equal(pending.ok, true); assert.equal(states.store.finishCredentialMutation(pendingRef, pending.value, false), true);
    const stateReport = await states.read(); count++;
    assert.equal(stateReport.status, 'partial');
    assert.equal(rowOf(stateReport, 'resend', 'development').presence, 'missing');
    assert.equal(rowOf(stateReport, 'resend', 'development').registration, 'settled');
    assert.equal(rowOf(stateReport, 'resend', 'preview').presence, 'registered');
    assert.equal(rowOf(stateReport, 'resend', 'preview').registration, 'not-recorded');
    assert.equal(rowOf(stateReport, 'resend', 'preview').nextStep, 'review-metadata');
    assert.equal(rowOf(stateReport, 'resend', 'production').presence, 'unavailable');
    assert.equal(rowOf(stateReport, 'clerk', 'preview').presence, 'unavailable');
    assert.equal(rowOf(stateReport, 'clerk', 'preview').registration, 'pending');
    assert.equal(rowOf(stateReport, 'clerk', 'preview').revision, null);
    assert.ok(!states.calls.includes(toAccount(pendingRef)), 'pending registration does not probe the store');

    // A backend contract violation is unknown, never truthy presence or false absence.
    for (const result of [undefined, null, 1, 'registered', {}, []]) {
      const before = snapshot(empty.dir);
      const report = await readConnectionInventory(empty.project, { baseDir: empty.home, vault: { hasSecret: async () => result } }); count++;
      closed(report, empty); assert.equal(report.status, 'partial');
      assert.ok(report.slots.every(row => row.presence === 'unavailable'));
      assert.equal(snapshot(empty.dir), before);
    }

    // An existing native route never requests an unnecessary second vault copy.
    const native = fixture(root, 'native-without-vault-copy');
    for (const service of services) native.select(service, 'preview', 'provider-native', 'vercel');
    const nativeReport = await native.read(); count++;
    for (const service of services) {
      const row = rowOf(nativeReport, service, 'preview');
      assert.equal(row.presence, 'missing'); assert.equal(row.selection.status, 'selected');
      assert.equal(row.nextStep, 'review-selected-native-route');
    }
    assert.match(renderConnectionInventory(nativeReport), /二重登録は不要/);
    native.select('clerk', 'preview');
    const bothRoutes = await native.read(); count++;
    assert.deepEqual(rowOf(bothRoutes, 'clerk', 'preview').selection.routes, [
      { route: 'provider-native', destination: 'vercel' }, { route: 'api-key-case-managed', destination: 'cloudflare' }
    ]);
    assert.equal(rowOf(bothRoutes, 'clerk', 'preview').nextStep, 'review-selected-native-route');

    // Slot-specific interrupted/foreign/corrupt metadata stays unknown, not absent.
    const corruptions = [
      ['lock', (f, file) => mkdirSync(`${file}.lock`, { mode: 0o700 })],
      ['temporary', (f, file) => writeFileSync(`${file}.tmp`, canary, { mode: 0o600 })],
      ['invalid-json', (f, file) => writeFileSync(file, `{${canary}`)],
      ['unknown-schema', (f, file) => { const raw = JSON.parse(readFileSync(file)); raw.schemaVersion = 999; writeFileSync(file, JSON.stringify(raw)); }],
      ['extra-field', (f, file) => { const raw = JSON.parse(readFileSync(file)); raw.credential.value = canary; writeFileSync(file, JSON.stringify(raw)); }],
      ['foreign-project', (f, file) => { const raw = JSON.parse(readFileSync(file)); raw.credential.projectId = 'f'.repeat(64); writeFileSync(file, JSON.stringify(raw)); }],
      ['wrong-environment', (f, file) => { const raw = JSON.parse(readFileSync(file)); raw.credential.environment = 'production'; writeFileSync(file, JSON.stringify(raw)); }]
    ];
    for (const service of services) for (const [name, corrupt] of corruptions) {
      const f = fixture(root, `${service}-${name}`), ref = f.ref(service, 'preview');
      f.register(ref); corrupt(f, join(f.connectionDir, stateName(ref)));
      const report = await f.read(), row = rowOf(report, service, 'preview'); count++;
      assert.equal(report.status, 'partial'); assert.equal(row.registration, 'unavailable');
      assert.equal(row.presence, 'unavailable'); assert.equal(row.revision, null); assert.equal(row.nextStep, 'review-metadata');
      assert.ok(!f.calls.includes(toAccount(ref)), `${name} must not become a vault absence`);
    }
    if (process.platform !== 'win32') {
      const f = fixture(root, 'symlink-credential'), ref = f.ref('resend', 'preview'); f.register(ref);
      const file = join(f.connectionDir, stateName(ref)), outside = join(root, 'outside-metadata.json');
      writeFileSync(outside, readFileSync(file), { mode: 0o600 }); rmSync(file); symlinkSync(outside, file);
      const report = await f.read(); count++;
      assert.equal(rowOf(report, 'resend', 'preview').presence, 'unavailable');
      assert.equal(rowOf(report, 'resend', 'preview').registration, 'unavailable');
    }
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const f = fixture(root, 'unreadable-credential'), ref = f.ref('clerk', 'development'); f.register(ref);
      const file = join(f.connectionDir, stateName(ref)), original = readFileSync(file);
      chmodSync(file, 0o000);
      try {
        const report = await readConnectionInventory(f.project, { baseDir: f.home, vault: f.vault }); count++;
        closed(report, f);
        assert.equal(rowOf(report, 'clerk', 'development').presence, 'unavailable');
        assert.equal(rowOf(report, 'clerk', 'development').registration, 'unavailable');
        assert.ok(!f.calls.includes(toAccount(ref)), 'unreadable metadata cannot become a missing vault slot');
      } finally { chmodSync(file, 0o600); }
      assert.deepEqual(readFileSync(file), original, 'an access failure never repairs or replaces the record');
    }
    const globalLock = fixture(root, 'global-metadata-lock'); globalLock.register(globalLock.refs[0]);
    mkdirSync(join(globalLock.connectionDir, 'lock'), { mode: 0o700 });
    const locked = await globalLock.read(); count++;
    assert.ok(locked.slots.every(row => row.registration === 'unavailable' && row.presence === 'unavailable'));
    assert.deepEqual(globalLock.calls, []);
    for (const [service, file] of [['resend', 'state.json'], ['clerk', 'clerk-native.json'], ['clerk', 'clerk-managed.json']]) {
      const f = fixture(root, `bad-selection-${file}`); f.register(f.ref(service, 'development'));
      writeFileSync(join(f.connectionDir, file), canary, { mode: 0o600 });
      const report = await f.read(); count++;
      for (const row of report.slots.filter(row => row.service === service)) {
        assert.equal(row.selection.status, 'unavailable'); assert.equal(row.nextStep, 'review-metadata');
      }
    }

    const historical = fixture(root, 'history');
    for (const ref of historical.refs.filter(ref => services.includes(ref.service))) {
      historical.register(ref);
      historical.receipt(ref, 'cloudflare', ref.environment === 'production' ? 'unknown' : 'completed');
    }
    const resendDev = historical.ref('resend', 'development');
    const latest = historical.receipt(resendDev, 'cloudflare', 'incomplete');
    historical.receipt(resendDev, 'vercel', 'unknown');
    historical.receipt(historical.ref('resend', 'production'), 'github', 'completed');
    historical.register(historical.ref('resend', 'preview')); // Historical completion now refers to an older revision.
    historical.select('resend', 'production', 'api-key-case-managed', 'github');
    const historyReport = await historical.read(); count++;
    for (const row of historyReport.slots.filter(row => services.includes(row.service))) assert.ok(row.history.placements.length > 0, 'all provider/environment receipts remain discoverable');
    assert.deepEqual(rowOf(historyReport, 'resend', 'development').history.placements.map(p => [p.target, p.outcome]), [['cloudflare', 'incomplete'], ['vercel', 'unknown']]);
    assert.equal(rowOf(historyReport, 'resend', 'development').history.placements[0].recordedAt, latest.startedAt);
    assert.equal(rowOf(historyReport, 'resend', 'preview').history.placements[0].registrationRelation, 'different-recorded-revision');
    assert.equal(rowOf(historyReport, 'clerk', 'preview').history.placements[0].registrationRelation, 'same-recorded-revision');
    assert.equal(rowOf(historyReport, 'resend', 'production').nextStep, 'resume-selected-connection');
    const legacy = historical.history.begin({ name: 'RESEND_API_KEY', scope: 'project', target: 'vercel', env: 'preview', destinationId: fingerprint, force: false });
    assert.ok(legacy); assert.equal(historical.history.finish(legacy, 'completed'), true);
    const legacyReport = await historical.read(); count++;
    assert.deepEqual(rowOf(legacyReport, 'resend', 'preview').history.placements.map(p => p.target), ['cloudflare'], 'unbound legacy receipts do not identify a v2 slot');
    rmSync(join(historical.connectionDir, stateName(historical.ref('clerk', 'preview'))));
    const noRevision = await historical.read(); count++;
    assert.equal(rowOf(noRevision, 'clerk', 'preview').history.placements[0].registrationRelation, 'unverified');
    const journal = join(historical.historyDir, 'history.json'), original = readFileSync(journal);
    for (const kind of ['lock', 'temporary', 'corrupt', 'unknown-schema']) {
      if (kind === 'lock') mkdirSync(join(historical.historyDir, 'lock'));
      if (kind === 'temporary') writeFileSync(join(historical.historyDir, 'history.tmp'), canary);
      if (kind === 'corrupt') writeFileSync(journal, canary);
      if (kind === 'unknown-schema') writeFileSync(journal, JSON.stringify({ ...JSON.parse(original), schemaVersion: 99 }));
      const report = await historical.read(); count++;
      assert.ok(report.slots.every(row => row.history.status === 'unavailable' && row.history.placements.length === 0 && row.nextStep === 'review-metadata'));
      if (kind === 'lock') rmSync(join(historical.historyDir, 'lock'), { recursive: true });
      if (kind === 'temporary') rmSync(join(historical.historyDir, 'history.tmp'));
      writeFileSync(journal, original);
    }

    // Inspecting project A cannot enumerate or recover project B, even in the same home.
    const isolation = fixture(root, 'isolation'), otherProject = join(isolation.dir, 'foreign-project'); mkdirSync(otherProject);
    const foreignStore = new ConnectionStateStore(otherProject, isolation.home), foreignHistory = new DeploymentHistory(otherProject, isolation.home);
    const foreignRef = connectionCredentialRef(otherProject, 'production'), mutation = foreignStore.beginCredentialMutation(foreignRef);
    assert.equal(mutation.ok, true); assert.equal(foreignStore.finishCredentialMutation(foreignRef, mutation.value, true), true);
    const foreignReceipt = foreignHistory.beginConnection({ ref: foreignRef, target: 'github', destinationId: fingerprint, force: false, credentialRevision: mutation.value, intentFingerprint: 'a'.repeat(64) });
    assert.ok(foreignReceipt); assert.equal(foreignHistory.finish(foreignReceipt, 'completed'), true);
    const beforeIsolation = snapshot(isolation.dir), forbiddenReads = [];
    const foreignPaths = [otherProject, metadataDir(isolation.home, otherProject, 'connections'), metadataDir(isolation.home, otherProject, 'deployment-history')];
    const readMethods = ['openSync', 'readFileSync', 'readdirSync', 'lstatSync', 'statSync'];
    const originalReads = Object.fromEntries(readMethods.map(name => [name, fs[name]]));
    let isolated;
    try {
      for (const method of readMethods) fs[method] = function(path, ...args) {
        if (typeof path === 'string' && foreignPaths.some(foreign => path === foreign || path.startsWith(`${foreign}/`) || path.startsWith(`${foreign}\\`))) {
          forbiddenReads.push(method); throw Error(canary);
        }
        if (method === 'readdirSync') forbiddenReads.push('project-enumeration');
        return originalReads[method].call(this, path, ...args);
      };
      syncBuiltinESMExports();
      isolated = await readConnectionInventory(isolation.project, { baseDir: isolation.home, vault: isolation.vault }); count++;
    } finally {
      for (const method of readMethods) fs[method] = originalReads[method];
      syncBuiltinESMExports();
    }
    closed(isolated, isolation);
    assert.deepEqual(forbiddenReads, [], 'inventory neither enumerates projects nor reads a foreign project');
    assert.equal(snapshot(isolation.dir), beforeIsolation);
    assert.ok(isolated.slots.every(row => row.presence === 'missing' && row.registration === 'not-recorded' && row.history.placements.length === 0));
    assert.deepEqual(isolation.calls, isolation.refs.map(toAccount));

    // Recheck after every await and after the last one: a later read can stale an earlier row.
    for (const timing of ['same-row', 'later-row']) {
      const f = fixture(root, `registration-race-${timing}`), ref = f.refs[0]; f.register(ref); f.receipt(ref, 'cloudflare', 'completed');
      let calls = 0;
      const report = await readConnectionInventory(f.project, { baseDir: f.home, vault: { hasSecret: async () => {
        calls++; if (calls === (timing === 'same-row' ? 1 : 6)) f.register(ref); return true;
      } } }); count++;
      closed(report, f);
      const raced = rowOf(report, 'resend', 'development');
      assert.equal(raced.registration, 'unavailable'); assert.equal(raced.presence, 'unavailable'); assert.equal(raced.revision, null);
      assert.equal(raced.history.placements[0].registrationRelation, 'unverified');
      assert.equal(raced.nextStep, 'review-metadata');
    }
    for (const kind of ['selection', 'history', 'missing-registration']) {
      const f = fixture(root, `later-${kind}`); f.select('resend', 'development');
      if (kind !== 'missing-registration') f.register(f.refs[0]);
      let calls = 0;
      const report = await readConnectionInventory(f.project, { baseDir: f.home, vault: { hasSecret: async () => {
        if (++calls === 6) {
          if (kind === 'selection') f.select('resend', 'production');
          if (kind === 'history') f.receipt(f.refs[0], 'cloudflare', 'completed');
          if (kind === 'missing-registration') f.register(f.refs[0]);
        }
        return false;
      } } }); count++;
      closed(report, f);
      if (kind === 'selection') for (const row of report.slots.filter(row => row.service === 'resend')) {
        assert.equal(row.selection.status, 'unavailable'); assert.deepEqual(row.selection.routes, []);
      }
      if (kind === 'history') assert.ok(report.slots.every(row => row.history.status === 'unavailable' && row.history.placements.length === 0));
      if (kind === 'missing-registration') {
        assert.equal(rowOf(report, 'resend', 'development').presence, 'unavailable');
        assert.equal(rowOf(report, 'resend', 'development').registration, 'unavailable');
      }
    }
    const vanished = fixture(root, 'project-race'); let calls = 0;
    const gone = await readConnectionInventory(vanished.project, { baseDir: vanished.home, vault: { hasSecret: async () => {
      if (++calls === 2) renameSync(vanished.project, `${vanished.project}-moved`); return false;
    } } }); count++;
    assert.equal(gone.status, 'unavailable'); assert.equal(gone.projectId, null); assert.deepEqual(gone.slots, []); closed(gone, vanished);
    let invalidPathVaultCalls = 0;
    const invalid = await readConnectionInventory(join(root, 'no-such-project'), { baseDir: root, vault: new Proxy({}, { get() { invalidPathVaultCalls++; throw Error(canary); } }) }); count++;
    assert.equal(invalidPathVaultCalls, 0, 'invalid path must not touch a vault');
    assert.equal(invalid.status, 'unavailable'); assert.deepEqual(invalid.slots, []);

    count += runInventoryCliFixture(root, all);
    console.log(`Connection inventory: ${count} cases passed; fixed eleven slots, read-only fresh CLI, no provider/child/network/write operations.`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function runInventoryCliFixture(root, f) {
  // Use the compiled CLI in a disposable package, replacing only its native keyring dependency.
  const checkout = join(root, 'cli-fixture'), modules = join(checkout, 'node_modules');
  mkdirSync(modules, { recursive: true }); writeFileSync(join(checkout, 'package.json'), '{"type":"module"}');
  cpSync(fileURLToPath(new URL('../dist', import.meta.url)), join(checkout, 'dist'), { recursive: true });
  const sourceModules = realpathSync(fileURLToPath(new URL('../node_modules', import.meta.url)));
  for (const name of readdirSync(sourceModules)) if (name !== '@napi-rs' && !name.startsWith('.'))
    symlinkSync(join(sourceModules, name), join(modules, name), process.platform === 'win32' ? 'junction' : 'dir');
  const mock = join(modules, '@napi-rs', 'keyring'); mkdirSync(mock, { recursive: true });
  writeFileSync(join(mock, 'package.json'), '{"name":"@napi-rs/keyring","main":"index.cjs"}');
  const accounts = f.refs.map(toAccount);
  writeFileSync(join(mock, 'index.cjs'), `const expected=new Set(${JSON.stringify(accounts)});exports.Entry=class {
    constructor(service,account){if(service!==${JSON.stringify(VAULT_SERVICE)}||!expected.has(account)){globalThis.inventoryEffects.unexpectedVault++;throw Error(${JSON.stringify(canary)})}this.account=account;}
    getPassword(){globalThis.inventoryEffects.presence.push(this.account);return ${JSON.stringify(canary)};}
    setPassword(){globalThis.inventoryEffects.vaultWrites++;throw Error(${JSON.stringify(canary)});}
    deleteCredential(){globalThis.inventoryEffects.vaultWrites++;throw Error(${JSON.stringify(canary)});}
  };`);
  const preload = join(root, 'inventory-readonly.cjs'), effectsFile = join(root, 'inventory-effects.json');
  writeFileSync(preload, `const fs=require('node:fs'),fsp=require('node:fs/promises'),cp=require('node:child_process'),net=require('node:net'),http=require('node:http'),https=require('node:https'),tls=require('node:tls'),dns=require('node:dns'),dgram=require('node:dgram');
    const save=fs.writeFileSync,open=fs.openSync,openAsync=fs.open,promiseOpen=fsp.open;
    const effects=globalThis.inventoryEffects={writes:0,children:0,network:0,human:0,native:0,unexpectedVault:0,vaultWrites:0,presence:[]};
    const deny=name=>()=>{effects[name]++;throw Error(${JSON.stringify(canary)});};
    for(const name of ['writeFile','appendFile','mkdir','rename','unlink','rm','rmdir','chmod','chown','truncate','copyFile','cp','link','symlink','utimes']){
      if(fs[name])fs[name]=deny('writes');if(fs[name+'Sync'])fs[name+'Sync']=deny('writes');if(fsp[name])fsp[name]=deny('writes');}
    fs.createWriteStream=deny('writes');
    const writable=flags=>typeof flags==='string'?/[wax+]/.test(flags):Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND));
    fs.openSync=function(path,flags,...args){if(writable(flags))return deny('writes')();return open.call(this,path,flags,...args)};
    fs.open=function(path,flags,...args){if(writable(flags))return deny('writes')();return openAsync.call(this,path,flags,...args)};
    fsp.open=async function(path,flags,...args){if(writable(flags))return deny('writes')();return promiseOpen.call(this,path,flags,...args)};
    for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=deny('children');
    net.Socket.prototype.connect=net.connect=net.createConnection=tls.connect=deny('network');
    http.get=http.request=https.get=https.request=globalThis.fetch=dgram.createSocket=deny('network');
    for(const name of ['lookup','resolve','resolve4','resolve6'])dns[name]=deny('network');
    require('node:readline').createInterface=deny('human');require('node:readline/promises').createInterface=deny('human');
    process.dlopen=deny('native');require('node:module').syncBuiltinESMExports();
    process.on('exit',()=>save(${JSON.stringify(effectsFile)},JSON.stringify(effects)));`);
  const before = snapshot(f.dir);
  let count = 0;
  const run = (args, expected = 0, expectPresence = true) => {
    const result = spawnSync(process.execPath, ['--require', preload, join(checkout, 'dist', 'cli', 'index.js'), ...args], {
      cwd: f.project, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      env: { HOME: f.home, USERPROFILE: f.home, DO_NOT_TRACK: '1', PATH: '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}) }
    });
    assert.equal(result.error, undefined); assert.equal(result.status, expected, result.stderr || result.stdout);
    assert.ok(!(result.stdout + result.stderr).includes(canary), 'CLI never echoes invalid arguments, keyring values or raw errors');
    const effects = JSON.parse(readFileSync(effectsFile));
    assert.deepEqual(effects, { writes: 0, children: 0, network: 0, human: 0, native: 0, unexpectedVault: 0, vaultWrites: 0, presence: expectPresence ? accounts : [] });
    assert.equal(snapshot(f.dir), before, 'fresh process preserves registrations, history, selection and every existing file');
    count++; return result;
  };
  const report = JSON.parse(run(['connection', 'inventory', '--json', f.project]).stdout); closed(report, f);
  for (const service of services) {
    assert.equal(rowOf(report, service, 'development').presence, 'registered');
    assert.equal(rowOf(report, service, 'development').nextStep, 'review-recorded-environment');
    assert.equal(rowOf(report, service, 'production').nextStep, 'resume-selected-connection');
  }
  const resumed = JSON.parse(run(['connection', 'inventory', '--json']).stdout);
  assert.deepEqual(resumed, report, 'separate processes rediscover noncurrent environments without registering again');
  const text = run(['connection', 'inventory', f.project]).stdout;
  assert.match(text, /再入力せず/); assert.match(text, /二重登録は不要/);
  for (const args of [
    ['--json', '--json'], ['--service', 'resend'], ['--env', 'preview'], ['--all'], ['--scope', 'user'],
    ['--base-dir', root], ['--force'], ['--offline'], ['--value', canary], [f.project, f.project]
  ]) run(['connection', 'inventory', ...args], 1, false);
  run(['connection', 'inventory', '--json', join(root, 'nonexistent')], 1, false);
  return count;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runConnectionInventoryTests();
