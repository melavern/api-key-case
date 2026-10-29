import assert from 'node:assert/strict';
import { unsafeMetadataLink } from './helpers/metadata-link-fixture.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { canonicalProjectRealpath } from '../dist/core/vault/naming.js';
import { connectionCredentialRef, clerkCredentialRef } from '../dist/core/agent/connection-credential.js';

import { buildNextReport } from '../dist/core/agent/next.js';
import { buildConnectionPlan } from '../dist/core/agent/connection-plan.js';
import { connectionCredentialFingerprint, connectionIntentFingerprint } from '../dist/core/agent/fingerprints.js';
import { RESEND_VERIFIER_VERSION } from '../dist/core/agent/resend-doctor.js';
import { clerkNativeIntentFingerprint } from '../dist/core/agent/clerk-native.js';
import { clerkManagedIntentFingerprint } from '../dist/core/agent/clerk-managed.js';
import { recordNativeInspection, recordNativeApplication, readNativeApplicationEvidence } from '../dist/core/agent/native-observations.js';
import { recordClerkWorkerApplication, readClerkWorkerApplicationEvidence } from '../dist/core/agent/clerk-worker-observations.js';
import { readLocalApplicationStatus } from '../dist/core/local/session.js';
import { DeploymentHistory } from '../dist/core/deploy/history.js';

const environments = ['development', 'preview', 'production'];
const profiles = ['resend', 'clerk-native', 'clerk-managed'];
const names = { resend: 'state.json', 'clerk-native': 'clerk-native.json', 'clerk-managed': 'clerk-managed.json' };
const canary = 'synthetic-resume-no-secret-QZ73';
const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'akc-intent-memory-')));
let checks = 0;
function snapshot(path) {
  if (!fs.existsSync(path)) return null;
  return JSON.stringify(fs.readdirSync(path).sort().map(name => {
    const p = join(path, name), st = fs.lstatSync(p);
    return [name, st.mode, st.isDirectory() ? snapshot(p) : st.isSymbolicLink() ? fs.readlinkSync(p) : fs.readFileSync(p).toString('hex')];
  }));
}
function input(profile, environment = 'development', override = {}) {
  return { service: profile === 'resend' ? 'resend' : 'clerk', environment,
    route: profile === 'clerk-native' ? 'provider-native' : 'api-key-case-managed',
    destination: { kind: profile === 'resend' ? 'local' : profile === 'clerk-native' ? 'vercel' : 'cloudflare' },
    sendingDomain: profile === 'resend' ? `${environment}.example.com` : null, ...override };
}
const request = value => ({ service: value.service, environment: value.environment, route: value.route });
function fixture(name) {
  const dir = join(root, name), home = join(dir, 'home'), project = join(dir, 'project');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(project);
  const store = new ConnectionStateStore(project, home);
  const metadata = join(home, '.api-key-case', 'connections', createHash('sha256').update(canonicalProjectRealpath(project)).digest('hex'));
  const f = { dir, home, project, store, metadata, history: join(metadata, 'intent-history.json') };
  f.save = (profile, environment = 'development', override = {}) => store[profile === 'resend' ? 'saveIntent' : profile === 'clerk-native' ? 'saveClerkNativeIntent' : 'saveClerkManagedIntent'](input(profile, environment, override));
  f.read = profile => store[profile === 'resend' ? 'readIntent' : profile === 'clerk-native' ? 'readClerkNativeIntent' : 'readClerkManagedIntent']();
  f.bytes = profile => fs.readFileSync(join(metadata, names[profile]), 'utf8');
  f.historyValue = () => JSON.parse(fs.readFileSync(f.history, 'utf8'));
  f.plan = (profile, environment = 'development', route) => store.planIntentResume(request(input(profile, environment, route ? { route } : {})));
  f.apply = plan => store.applyIntentResume(request(plan), plan.fingerprint);
  return f;
}
function assertClosed(report, f) {
  assert.deepEqual(Object.keys(report).sort(), ['schemaVersion', 'projectId', 'service', 'environment', 'route', 'profile', 'status', 'issue', 'current', 'remembered', 'source', 'recordedAt', 'fingerprint', 'permission', 'providerOperation'].sort());
  assert.equal(report.schemaVersion, 1); assert.equal(report.permission, 'none'); assert.equal(report.providerOperation, false);
  assert.ok(report.fingerprint === null || /^[a-f0-9]{64}$/.test(report.fingerprint));
  for (const term of [canary, f.project, f.home]) assert.ok(!JSON.stringify(report).includes(term));
  for (const intent of [report.current, report.remembered].filter(Boolean)) {
    const keys = ['id', 'service', 'environment', 'slot', 'route', 'destination', 'sendingDomain', 'createdAt', 'updatedAt'];
    if (intent.nativeEnrollment !== undefined) keys.push('nativeEnrollment');
    assert.deepEqual(Object.keys(intent).sort(), keys.sort());
    assert.deepEqual(Object.keys(intent.destination), ['kind']);
  }
}
try {
  // Reading old schema-1 files creates no history or migration; the same v1 contract remains strict.
  for (const profile of profiles) {
    const f = fixture(`v1-${profile}`), selected = f.save(profile).value;
    assert.ok(selected); assert.equal(fs.existsSync(f.history), false);
    const bytes = f.bytes(profile), parsed = JSON.parse(bytes);
    assert.deepEqual(Object.keys(parsed), ['schemaVersion', 'intent']); assert.equal(parsed.schemaVersion, 1);
    const before = snapshot(f.dir), plan = f.plan(profile); assertClosed(plan, f);
    assert.equal(plan.status, 'unchanged'); assert.equal(plan.source, 'current');
    assert.equal(snapshot(f.dir), before); assert.equal(f.apply(plan).status, 'unchanged');
    assert.equal(f.bytes(profile), bytes); assert.equal(snapshot(f.dir), before);
    assert.deepEqual(f.save(profile).value, selected); assert.equal(f.bytes(profile), bytes);
    assert.equal(fs.existsSync(f.history), false); checks++;
  }
  const missing = fixture('missing'), missingBefore = snapshot(missing.dir);
  assert.equal(missing.plan('resend').issue, 'not-recorded'); assert.equal(snapshot(missing.dir), missingBefore);
  assert.equal(missing.store.applyIntentResume(request(input('resend')), 'a'.repeat(64)).status, 'blocked');
  assert.equal(snapshot(missing.dir), missingBefore); checks++;

  // Resend's explicit Vercel enrollment method survives fresh-process-style resume as closed v2 intent data.
  const enrollment = fixture('resend-enrollment');
  const firstMethod = enrollment.save('resend', 'development', { route: 'provider-native', destination: { kind: 'vercel' },
    sendingDomain: null, nativeEnrollment: 'resend-vercel-integration' });
  assert.equal(firstMethod.ok, true); assert.equal(JSON.parse(enrollment.bytes('resend')).schemaVersion, 2);
  const firstBytes = enrollment.bytes('resend'), firstPlan = enrollment.plan('resend', 'development', 'provider-native');
  assert.equal(firstPlan.remembered.nativeEnrollment, 'resend-vercel-integration'); assertClosed(firstPlan, enrollment);
  assert.equal(enrollment.save('resend', 'development', { route: 'provider-native', destination: { kind: 'vercel' },
    sendingDomain: null, nativeEnrollment: 'resend-vercel-integration' }).value.updatedAt, firstMethod.value.updatedAt);
  assert.equal(enrollment.bytes('resend'), firstBytes);
  const switched = enrollment.save('resend', 'development', { route: 'provider-native', destination: { kind: 'vercel' },
    sendingDomain: null, nativeEnrollment: 'resend-vercel-marketplace' });
  assert.equal(switched.ok, true); assert.ok(switched.value.updatedAt > firstMethod.value.updatedAt);
  const switchedPlan = enrollment.plan('resend', 'development', 'provider-native');
  assert.equal(switchedPlan.remembered.nativeEnrollment, 'resend-vercel-marketplace');
  assert.notEqual(switchedPlan.fingerprint, firstPlan.fingerprint);
  enrollment.save('resend', 'preview', { route: 'manual', destination: { kind: 'manual' }, sendingDomain: null });
  const restoredPlan = enrollment.plan('resend', 'development', 'provider-native');
  assert.equal(restoredPlan.source, 'last-recorded'); assert.equal(restoredPlan.remembered.nativeEnrollment, 'resend-vercel-marketplace');
  assert.equal(enrollment.apply(restoredPlan).status, 'applied');
  assert.equal(enrollment.read('resend').value.nativeEnrollment, 'resend-vercel-marketplace');
  assert.equal(JSON.parse(enrollment.bytes('resend')).schemaVersion, 2); checks++;

  const all = fixture('all-profiles');
  const preserved = new Map();
  for (const profile of profiles) {
    for (const environment of environments) {
      const selected = all.save(profile, environment); assert.equal(selected.ok, true);
      preserved.set(`${profile}/${environment}`, selected.value);
    }
    assert.equal(all.save(profile, 'development').ok, true);
  }
  assert.equal(all.historyValue().entries.length, 9);
  for (const profile of profiles) for (const environment of environments) {
    const plan = all.plan(profile, environment); assertClosed(plan, all);
    const filesBefore = Object.fromEntries(profiles.filter(p => p !== profile).map(p => [p, all.bytes(p)]));
    const beforeRevision = all.read(profile).value.updatedAt;
    const oldHistory = all.historyValue();
    const result = all.apply(plan); assert.ok(['applied', 'unchanged'].includes(result.status));
    const current = all.read(profile).value, remembered = plan.remembered;
    for (const key of ['service', 'environment', 'route', 'destination', 'sendingDomain']) assert.deepEqual(current[key], remembered[key]);
    if (result.status === 'applied') {
      assert.ok(current.updatedAt > beforeRevision);
      assert.ok(oldHistory.entries.every(entry => current.updatedAt > entry.intent.updatedAt), 'old observations cannot regain their intent revision');
      assert.equal(all.apply(plan).issue, 'stale-plan');
    } else assert.equal(current.updatedAt, beforeRevision);
    for (const [p, bytes] of Object.entries(filesBefore)) assert.equal(all.bytes(p), bytes, 'parallel profiles preserved');
    assert.ok(all.historyValue().entries.length <= 9); checks++;
  }
  // Same-environment changes retain only the previous committed selection; current wins when matching the env.
  const repeat = fixture('same-environment');
  const first = repeat.save('resend').value;
  const second = repeat.save('resend', 'development', { route: 'manual', destination: { kind: 'manual' }, sendingDomain: 'changed.example.com' }).value;
  assert.deepEqual(repeat.historyValue().entries[0].intent, first);
  assert.equal(repeat.plan('resend').issue, 'route-mismatch');
  assert.equal(repeat.plan('resend', 'development', 'manual').source, 'current');
  repeat.save('resend', 'preview');
  const plan = repeat.plan('resend', 'development', 'manual');
  assert.deepEqual(plan.remembered, second); assert.equal(plan.source, 'last-recorded');
  assert.equal(repeat.historyValue().entries.length, 1); checks++;

  // A new Agent can recover a forgotten Resend route directly from the named env record.
  const discovered = repeat.store.planIntentResume({ service: 'resend', environment: 'development' });
  assert.equal(discovered.route, 'manual'); assert.equal(discovered.fingerprint, plan.fingerprint);
  assert.equal(repeat.store.applyIntentResume(request(discovered), discovered.fingerprint).status, 'applied');
  const currentDiscovered = repeat.store.planIntentResume({ service: 'resend', environment: 'development' });
  assert.equal(currentDiscovered.route, 'manual'); assert.equal(currentDiscovered.status, 'unchanged');
  assert.equal(currentDiscovered.source, 'current'); assert.equal(repeat.apply(currentDiscovered).status, 'unchanged');
  const noRoute = missing.store.planIntentResume({ service: 'resend', environment: 'development' });
  assert.equal(noRoute.route, null); assert.equal(noRoute.issue, 'not-recorded');
  assert.equal(repeat.store.applyIntentResume({ service: 'resend', environment: 'development' }, currentDiscovered.fingerprint).issue, 'invalid-data');
  assert.equal(repeat.store.planIntentResume({ service: 'clerk', environment: 'development' }).issue, 'invalid-data');
  const changedHistoryPlan = repeat.store.planIntentResume({ service: 'resend', environment: 'preview' });
  repeat.save('clerk-native'); repeat.save('clerk-native', 'preview');
  assert.equal(repeat.apply(changedHistoryPlan).issue, 'stale-plan'); checks++;

  // Registration and journal bytes are never rewritten or read for resumption.
  const retain = fixture('retained'); retain.save('resend'); retain.save('clerk-native'); retain.save('clerk-managed');
  for (const service of ['resend', 'clerk']) for (const env of environments) {
    const ref = service === 'resend' ? connectionCredentialRef(retain.project, env) : clerkCredentialRef(retain.project, env);
    const registration = retain.store.beginCredentialMutation(ref); assert.equal(registration.ok, true);
    assert.equal(retain.store.finishCredentialMutation(ref, registration.value, true), true);
  }
  fs.writeFileSync(join(retain.metadata, 'observations.json'), '{"schemaVersion":1,"entries":[]}\n', { mode: 0o600 });
  fs.writeFileSync(join(retain.metadata, 'local-session.json'), 'synthetic-unrelated-unknown\n', { mode: 0o600 });
  retain.save('resend', 'production');
  const others = fs.readdirSync(retain.metadata).filter(n => !['state.json', 'intent-history.json'].includes(n));
  const retained = others.map(n => [n, fs.readFileSync(join(retain.metadata, n)).toString('hex')]);
  const selectedPlan = retain.plan('resend');
  const originalOpen = fs.openSync, forbiddenReads = [];
  try {
    fs.openSync = function(path, ...args) { if (others.some(n => path === join(retain.metadata, n))) { forbiddenReads.push(path); throw Error(canary); } return originalOpen.call(this, path, ...args); };
    syncBuiltinESMExports(); assert.equal(retain.apply(selectedPlan).status, 'applied');
  } finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
  assert.deepEqual(forbiddenReads, []);
  for (const [n, hex] of retained) assert.equal(fs.readFileSync(join(retain.metadata, n)).toString('hex'), hex); checks++;

  // Returning to earlier conditions does not revive native or local application approval/evidence.
  for (const profile of ['resend', 'clerk-native']) {
    const f = fixture(`native-evidence-${profile}`), service = profile === 'resend' ? 'resend' : 'clerk';
    fs.mkdirSync(join(f.project, '.vercel')); fs.writeFileSync(join(f.project, '.vercel', 'project.json'), JSON.stringify({ orgId: 'team_fixture', projectId: 'prj_fixture' }));
    const overrides = { route: 'provider-native', destination: { kind: 'vercel' }, sendingDomain: null };
    const selected = f.save(profile, 'development', overrides).value;
    const read = () => readNativeApplicationEvidence(f.project, service, f.home);
    const captured = recordNativeInspection(f.project, { service, environment: 'development', status: 'inspected', configuration: 'integration-managed',
      configurationFingerprint: 'b'.repeat(64), intentFingerprint: service === 'resend' ? connectionIntentFingerprint(selected) : clerkNativeIntentFingerprint(selected),
      destinationSelectionFingerprint: read().destinationSelectionFingerprint }, 600, f.home);
    assert.equal(captured.status, 'recorded');
    assert.equal(recordNativeApplication(f.project, { service, environment: 'development', inspectionId: captured.receiptId,
      feature: service === 'resend' ? 'send-and-delivery' : 'protected-access', observer: 'agent', outcome: 'passed', maxAgeSeconds: 300 }, f.home).status, 'recorded');
    assert.equal(read().status, 'reported');
    const journal = fs.readFileSync(join(f.metadata, 'observations.json'), 'utf8');
    f.save(profile, 'preview', overrides); assert.equal(f.apply(f.plan(profile, 'development', 'provider-native')).status, 'applied');
    assert.equal(read().status, 'stale'); assert.equal(read().reason, 'scope-changed'); assert.equal(read().currentHealth, 'unverified');
    assert.equal(fs.readFileSync(join(f.metadata, 'observations.json'), 'utf8'), journal); checks++;
  }
  const local = fixture('local-evidence'); local.save('resend');
  const localRef = connectionCredentialRef(local.project, 'development'), mutation = local.store.beginCredentialMutation(localRef);
  assert.equal(local.store.finishCredentialMutation(localRef, mutation.value, true), true);
  const attempt = local.store.beginLocalSession(mutation.value, 1000); assert.equal(attempt.ok, true);
  assert.equal(local.store.finishLocalSession(attempt.value.attemptId, 'exited', true, { execution: 'possible', treeTermination: 'confirmed' }), true);
  assert.equal(local.store.recordLocalSessionObservation({ service: 'resend', environment: 'development', attemptId: attempt.value.attemptId,
    executionBasisId: attempt.value.executionBasisId, credentialRevision: mutation.value, authority: 'agent-observed', outcome: 'passed' }).ok, true);
  const localBytes = fs.readFileSync(join(local.metadata, 'local-session.json'), 'utf8');
  local.save('resend', 'preview'); assert.equal(local.apply(local.plan('resend')).status, 'applied');
  assert.equal(readLocalApplicationStatus(local.project, local.home).receiptRelation, 'selection-changed');
  assert.equal(local.store.credentialRevision(localRef), mutation.value); assert.equal(fs.readFileSync(join(local.metadata, 'local-session.json'), 'utf8'), localBytes); checks++;

  const managed = fixture('managed-evidence'), account = '0123456789abcdef0123456789abcdef', worker = 'fixture-worker', version = '12345678-1234-1234-1234-123456789abc';
  fs.writeFileSync(join(managed.project, 'wrangler.toml'), `[env.development]\nname="${worker}"\naccount_id="${account}"\n`);
  const selected = managed.save('clerk-managed').value, managedRef = clerkCredentialRef(managed.project, 'development');
  const registration = managed.store.beginCredentialMutation(managedRef); assert.equal(managed.store.finishCredentialMutation(managedRef, registration.value, true), true);
  const history = new DeploymentHistory(managed.project, managed.home);
  const preparation = history.beginClerkPreparation({ ref: managedRef, target: 'cloudflare', destinationId: 'a'.repeat(64), force: false,
    credentialRevision: registration.value, intentFingerprint: clerkManagedIntentFingerprint(selected), preparationDestination: { accountId: account, worker } });
  assert.equal(history.finishClerkPreparation(preparation, 'completed', version), true);
  assert.equal(recordClerkWorkerApplication(managed.project, { service: 'clerk', environment: 'development', preparationId: preparation, versionId: version,
    feature: 'protected-access', observer: 'agent', outcome: 'passed', maxAgeSeconds: 300 }, managed.home).status, 'recorded');
  assert.equal(readClerkWorkerApplicationEvidence(managed.project, managed.home).status, 'reported');
  const journalBefore = fs.readFileSync(join(managed.metadata, 'observations.json'), 'utf8');
  managed.save('clerk-managed', 'preview'); assert.equal(managed.apply(managed.plan('clerk-managed')).status, 'applied');
  const evidence = readClerkWorkerApplicationEvidence(managed.project, managed.home);
  assert.equal(evidence.status, 'stale'); assert.equal(evidence.reason, 'selection-changed');
  assert.equal(fs.readFileSync(join(managed.metadata, 'observations.json'), 'utf8'), journalBefore); checks++;

  // Same-env credential validation remains historical evidence for the same credential revision.
  const credential = fixture('credential-evidence'); fs.writeFileSync(join(credential.project, 'app.ts'), 'process.env.RESEND_API_KEY;');
  const credentialIntent = credential.save('resend', 'development', { destination: { kind: 'cloudflare' } }).value;
  const ref = connectionCredentialRef(credential.project, 'development'), registered = credential.store.beginCredentialMutation(ref);
  assert.equal(credential.store.finishCredentialMutation(ref, registered.value, true), true);
  const observation = credential.store.beginObservation({ kind: 'credential-validation', authority: 'provider-observed', basis: {
    credentialRevision: registered.value, destinationFingerprint: null, intentFingerprint: connectionIntentFingerprint(credentialIntent),
    sourceFingerprint: connectionCredentialFingerprint(ref), verifierVersion: RESEND_VERIFIER_VERSION } });
  assert.equal(credential.store.finishObservation(observation.value.id, 'completed', 'valid-full-access').ok, true);
  const journalOriginal = fs.readFileSync(join(credential.metadata, 'observations.json'), 'utf8');
  credential.save('resend', 'preview'); assert.equal(credential.apply(credential.plan('resend')).status, 'applied');
  const readVault = { hasSecret: async candidate => candidate.service === 'resend' && candidate.environment === 'development',
    isAvailable: async () => { throw Error('Forbidden availability probe'); } };
  const next = await buildNextReport(credential.project, { vault: readVault, offline: true, adapters: [], licensePlan: 'free',
    registryBaseDir: credential.home, connectionBaseDir: credential.home });
  assert.equal(next.connection.report.credential.status, 'registered'); assert.equal(next.connection.report.providerCheck.status, 'passed');
  assert.equal((await buildConnectionPlan(credential.project, 'development', { vault: readVault, connectionBaseDir: credential.home })).reason, 'destination-unresolved');
  assert.equal(credential.store.credentialRevision(ref), registered.value); assert.equal(fs.readFileSync(join(credential.metadata, 'observations.json'), 'utf8'), journalOriginal); checks++;

  // Every unsupported/corrupt/unsafe record blocks a DIFFERENT selection; exact-current sets preserve bytes.
  const corruptions = [
    ['json', f => fs.writeFileSync(f.history, canary), 'invalid-data'],
    ['schema', f => fs.writeFileSync(f.history, JSON.stringify({ ...f.historyValue(), schemaVersion: 2 })), 'unsupported-schema'],
    ['extra', f => fs.writeFileSync(f.history, JSON.stringify({ ...f.historyValue(), extra: canary })), 'invalid-data'],
    ['unknown-profile', f => { const h = f.historyValue(); h.entries[0].profile = canary; fs.writeFileSync(f.history, JSON.stringify(h)); }, 'invalid-data'],
    ['unknown-env', f => { const h = f.historyValue(); h.entries[0].intent.environment = canary; fs.writeFileSync(f.history, JSON.stringify(h)); }, 'invalid-data'],
    ['unknown-field', f => { const h = f.historyValue(); h.entries[0].intent.token = canary; fs.writeFileSync(f.history, JSON.stringify(h)); }, 'invalid-data'],
    ['wrong-project', f => { const h = f.historyValue(); h.entries[0].intent.id = 'f'.repeat(64); fs.writeFileSync(f.history, JSON.stringify(h)); }, 'invalid-data'],
    ['duplicate', f => { const h = f.historyValue(); h.entries.push(h.entries[0]); fs.writeFileSync(f.history, JSON.stringify(h)); }, 'invalid-data'],
    ['overflow', f => { const h = f.historyValue(); h.entries = Array(10).fill(h.entries[0]); fs.writeFileSync(f.history, JSON.stringify(h)); }, 'invalid-data'],
    ['too-large', f => fs.writeFileSync(f.history, ' '.repeat(256 * 1024 + 1)), 'too-large'],
    ['tmp', f => fs.writeFileSync(f.history + '.tmp', canary), 'temporary-file-present'],
    ['directory', f => { fs.unlinkSync(f.history); fs.mkdirSync(f.history); }, 'unsafe-path'],
    ['symlink', f => { fs.renameSync(f.history, f.history + '.saved'); unsafeMetadataLink(f.history + '.saved', f.history); }, 'unsafe-path'],
    ['hardlink', f => fs.linkSync(f.history, f.history + '.other'), 'unsafe-path'],
    ...(process.platform === 'win32' ? [] : [['mode', f => fs.chmodSync(f.history, 0o644), 'unsafe-path']])
  ];
  for (const [name, corrupt, issue] of corruptions) for (const profile of profiles) {
    const f = fixture(`invalid-${name}-${profile}`); f.save(profile); f.save(profile, 'preview');
    const plan = f.plan(profile); corrupt(f); const before = snapshot(f.dir), active = f.bytes(profile);
    const blocked = f.plan(profile); assert.equal(blocked.issue, issue); assertClosed(blocked, f);
    assert.equal(f.apply(plan).issue, issue); assert.equal(f.save(profile, 'production').issue, issue);
    assert.equal(f.bytes(profile), active); assert.equal(snapshot(f.dir), before, 'failure does not delete/repair metadata');
    assert.equal(f.save(profile, 'preview').ok, true, 'unchanged current set does not need to rewrite corrupt history');
    assert.equal(snapshot(f.dir), before); checks++;
  }
  const locked = fixture('locked'); locked.save('resend'); locked.save('resend', 'preview');
  const lockedPlan = locked.plan('resend'); fs.mkdirSync(join(locked.metadata, 'lock'));
  const beforeLocked = snapshot(locked.dir); assert.equal(locked.plan('resend').issue, 'lock-present');
  assert.equal(locked.apply(lockedPlan).issue, 'lock-present'); assert.equal(locked.save('resend', 'production').issue, 'lock-present');
  assert.equal(snapshot(locked.dir), beforeLocked); checks++;

  // Relevant active and full history changes stale the plan, including changes immediately before lock acquisition.
  for (const kind of ['active', 'history', 'root', 'under-lock']) {
    const f = fixture(`stale-${kind}`); f.save('resend'); f.save('resend', 'preview'); const planned = f.plan('resend');
    if (kind === 'active') f.save('resend', 'production');
    if (kind === 'history') { f.save('clerk-native'); f.save('clerk-native', 'preview'); }
    if (kind === 'root') { fs.renameSync(f.project, f.project + '-old'); fs.mkdirSync(f.project); }
    const original = fs.mkdirSync;
    try {
      if (kind === 'under-lock') {
        fs.mkdirSync = function(path, ...args) {
          const result = original.call(this, path, ...args);
          if (path === join(f.metadata, 'lock')) { const value = JSON.parse(f.bytes('resend')); value.intent.sendingDomain = 'race.example.com'; fs.writeFileSync(join(f.metadata, 'state.json'), JSON.stringify(value)); }
          return result;
        }; syncBuiltinESMExports();
      }
      const oldHistory = fs.readFileSync(f.history, 'utf8');
      assert.equal(f.apply(planned).issue, kind === 'root' ? 'unsafe-path' : 'stale-plan');
      assert.equal(fs.readFileSync(f.history, 'utf8'), oldHistory, 'stale plan never archives or overwrites');
      if (kind === 'under-lock') assert.equal(f.read('resend').value.sendingDomain, 'race.example.com');
    } finally { fs.mkdirSync = original; syncBuiltinESMExports(); }
    checks++;
  }
  // Archive failure and interruption before active rename cannot promote desired-but-uncommitted input.
  for (const target of ['intent-history.json', 'state.json']) for (const mode of ['throw-before', 'crash-before', 'crash-after']) {
    const f = fixture(`interrupted-${target}-${mode}`); const old = f.save('resend').value;
    const source = `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';import{ConnectionStateStore}from ${JSON.stringify(new URL('../dist/core/agent/connection-state.js', import.meta.url).href)};
      const rename=fs.renameSync;fs.renameSync=function(from,to){if(to===${JSON.stringify(join(f.metadata,target))}){${mode === 'throw-before' ? "throw Object.assign(Error('synthetic'),{code:'ENOSPC'});" : mode === 'crash-before' ? 'process.exit(91);' : 'const result=rename.call(this,from,to);process.exit(92);return result;'}}return rename.call(this,from,to)};syncBuiltinESMExports();
      const result=new ConnectionStateStore(${JSON.stringify(f.project)},${JSON.stringify(f.home)}).saveIntent(${JSON.stringify(input('resend','production'))});console.log(JSON.stringify(result));`;
    const executed = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000 });
    assert.equal(executed.error, undefined);
    if (mode === 'throw-before') { assert.equal(executed.status, 0, executed.stderr); assert.equal(JSON.parse(executed.stdout).ok, false); }
    else assert.equal(executed.status, mode === 'crash-before' ? 91 : 92);
    const active = JSON.parse(f.bytes('resend')).intent;
    if (target === 'state.json' && mode === 'crash-after') assert.equal(active.environment, 'production');
    else assert.deepEqual(active, old);
    if (fs.existsSync(f.history)) assert.deepEqual(f.historyValue().entries.map(e => e.intent), [old], 'history contains only committed old active');
    if (mode.startsWith('crash')) { assert.equal(f.plan('resend').issue, 'lock-present'); assert.equal(fs.existsSync(join(f.metadata, 'lock')), true); }
    checks++;
  }
  // Invalid direct core input cannot echo arbitrary data or throw on null.
  const invalid = fixture('invalid-api');
  for (const value of [null, undefined, 1, canary, {}, { service: canary, environment: canary, route: canary },
    { ...request(input('resend')), unexpected: canary }, request(input('clerk-native', 'development', { route: 'manual' }))]) {
    for (const report of [invalid.store.planIntentResume(value), invalid.store.applyIntentResume(value, 'a'.repeat(64))]) {
      assertClosed(report, invalid); assert.equal(report.status, 'blocked'); assert.equal(report.issue, 'invalid-data');
      assert.equal(report.service, null); assert.equal(report.environment, null); assert.equal(report.route, null); assert.equal(report.profile, null);
    } checks++;
  }
  for (const kind of ['directory', 'symlink', 'under-lock']) {
    const f = fixture(`replaced-project-${kind}`); f.save('resend'); f.save('resend', 'preview'); const plan = f.plan('resend');
    const swap = () => { fs.renameSync(f.project, f.project + '-original'); if (kind === 'symlink') fs.symlinkSync(f.project + '-original', f.project, process.platform==='win32'?'junction':'dir'); else fs.mkdirSync(f.project); };
    const original = fs.mkdirSync;
    try {
      if (kind !== 'under-lock') swap();
      else { fs.mkdirSync = function(path, ...args) { const result = original.call(this, path, ...args); if (path === join(f.metadata, 'lock')) swap(); return result; }; syncBuiltinESMExports(); }
      const active = f.bytes('resend'), history = fs.readFileSync(f.history, 'utf8');
      if (kind !== 'under-lock') assert.equal(f.plan('resend').issue, 'unsafe-path');
      assert.equal(f.apply(plan).issue, 'unsafe-path'); assert.equal(f.bytes('resend'), active); assert.equal(fs.readFileSync(f.history, 'utf8'), history);
    } finally { fs.mkdirSync = original; syncBuiltinESMExports(); }
    checks++;
  }
  // An old binary can overwrite active without recording it. Do not invent the lost selection.
  const oldBinary = fixture('old-binary'); const legacy = oldBinary.save('resend').value;
  const changed = { ...legacy, environment: 'production', id: createHash('sha256').update(`${canonicalProjectRealpath(oldBinary.project)}\nresend\nproduction\ndefault`).digest('hex') };
  fs.writeFileSync(join(oldBinary.metadata, 'state.json'), JSON.stringify({ schemaVersion: 1, intent: changed }));
  assert.equal(oldBinary.plan('resend').issue, 'not-recorded'); assert.equal(fs.existsSync(oldBinary.history), false); checks++;
  console.log(`Connection resume: ${checks} cases passed; bounded history, v1 compatibility, locked token checks, interruption and byte-preservation.`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
