// Synthetic metadata, exact boolean presence and local selectors only.
// No real OS store, native dialog, provider account, resource, key or deployment.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { credentialEnvironments, credentialRefForService } from '../dist/core/agent/connection-credential.js';
import { readCredentialGuide, renderCredentialGuide } from '../dist/core/agent/credential-guide.js';
import { readConnectionInventory, renderConnectionInventory } from '../dist/core/agent/connection-inventory.js';
import { planConnectionTarget, applyConnectionTarget, renderConnectionTarget } from '../dist/core/agent/connection-target.js';
import { readCloudflareAcquisitionGuide, renderCloudflareAcquisitionGuide } from '../dist/core/agent/cloudflare-acquisition.js';
import { readNativeAcquisitionGuide } from '../dist/core/agent/native-acquisition.js';
import { buildNextReport } from '../dist/core/agent/next.js';
import { renderAgentProtocol } from '../dist/core/agent/init.js';
import { canonicalProjectRealpath } from '../dist/core/vault/naming.js';
import { DeploymentHistory } from '../dist/core/deploy/history.js';
import { toAccount } from '../dist/core/vault/naming.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'akc-provider-hosted-guides-')));
const canary = 'synthetic-provider-private-Q76-guides', account = '0123456789abcdef0123456789abcdef';
let serial = 0, checks = 0;
const snapshot = dir => JSON.stringify(readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(row =>
  [row.name, row.isDirectory() ? snapshot(join(dir, row.name)) : readFileSync(join(dir, row.name)).toString('base64')]));
function fixture(service = 'openai', environment = 'preview', destination = 'cloudflare', selected = true) {
  const dir = join(root, String(serial++)), project = join(dir, 'project'), home = join(dir, 'home');
  for (const path of [dir, project, home]) mkdirSync(path, { mode: 0o700 });
  const store = new ConnectionStateStore(project, home), refs = new Set(), calls = [];
  const ref = credentialRefForService(project, environment, service);
  const select = (extra = {}) => store.setProviderHostedIntent({ service, environment,
    route: 'api-key-case-managed', destination: { kind: destination }, sendingDomain: null, ...extra });
  if (selected) assert.equal(select().ok, true);
  const vault = new Proxy({}, { get(_target, property) {
    assert.equal(property, 'hasSecret', 'guide cannot enumerate, read values or probe/write the OS store');
    return async probe => { calls.push(probe); return refs.has(toAccount(probe)); };
  } });
  const register = () => {
    const begun = store.beginCredentialMutation(ref); assert.equal(begun.ok, true);
    assert.equal(store.finishCredentialMutation(ref, begun.value, true), true); refs.add(toAccount(ref)); return begun.value;
  };
  const input = { service, environment, ...(destination === 'cloudflare' ? { accountId: account, worker: 'fixture-worker' } : { orgId: 'team_fixture', projectId: 'prj_fixture' }) };
  const guide = () => readCredentialGuide(project, service, environment, { vault, humanPlane: { capability: () => 'os-dialog' }, baseDir: home });
  return { dir, project, home, service, environment, destination, store, refs, ref, calls, vault, register, select, input, guide };
}
function closed(value, text = '') {
  assert.ok(!JSON.stringify(value).includes(canary)); assert.ok(!text.includes(canary));
  if ('permission' in value) assert.equal(value.permission, 'none');
  if ('executed' in value) assert.equal(value.executed, false);
}
const next = f => buildNextReport(f.project, { offline: true, vault: f.vault,
  adapters: { [Symbol.iterator]() { throw Error('offline adapter access'); } }, licensePlan: 'free', registryBaseDir: f.home, connectionBaseDir: f.home });
try {
  for (const service of ['openai', 'stripe-test']) for (const environment of credentialEnvironments(service)) for (const destination of ['vercel', 'cloudflare']) {
    const f = fixture(service, environment, destination), revision = f.register(), before = snapshot(f.dir);
    const g = await f.guide(); closed(g, renderCredentialGuide(g));
    assert.equal(g.stage, 'stored'); assert.equal(g.acquisition, null);
    assert.equal(g.operationPlan.consumer, 'provider-hosted-managed');
    assert.equal(g.operationPlan.secretTransfer, 'none'); assert.equal(g.operationPlan.deployment, false);
    assert.equal(g.operationPlan.providerCheck, 'not-run'); assert.equal(g.operationPlan.applicationCheck, 'not-run');
    assert.deepEqual(g.hostedConnection, { status: 'selected', environment, destination, matchesRequestedEnvironment: true,
      nativeExecution: 'pending-acceptance', providerCheck: 'unsupported', applicationCheck: 'unsupported', currentHealth: 'unverified' });
    assert.match(renderCredentialGuide(g), /native受入待ち/); assert.equal(snapshot(f.dir), before);
    const p = planConnectionTarget(f.project, f.input, f.home); closed(p, renderConnectionTarget(p));
    assert.equal(p.status, 'planned'); assert.equal(p.credentialAccess, 'none'); assert.equal(p.providerExecution, false);
    assert.equal(p.route, 'api-key-case-managed'); assert.equal(p.nativeExecution, 'pending-acceptance'); assert.deepEqual(planConnectionTarget(f.project, f.input, f.home), p);
    assert.equal(snapshot(f.dir), before);
    const applied = applyConnectionTarget(f.project, f.input, p.fingerprint, f.home); assert.equal(applied.status, 'created');
    const after = snapshot(f.dir), again = applyConnectionTarget(f.project, f.input, applied.fingerprint, f.home);
    assert.equal(again.status, 'unchanged'); assert.equal(snapshot(f.dir), after);
    assert.equal(applyConnectionTarget(f.project, f.input, p.fingerprint, f.home).reason, 'plan-mismatch');
    if (destination === 'cloudflare') {
      const cf = readCloudflareAcquisitionGuide(f.project, service, environment, f.home); closed(cf, renderCloudflareAcquisitionGuide(cf));
      assert.equal(cf.state, 'selection-confirmed'); assert.equal(cf.nativeExecution, 'pending-acceptance');
      assert.equal(cf.selection.accountId, account); assert.equal(cf.selection.worker, 'fixture-worker');
      assert.deepEqual(cf.requiredSettings, [refName(service)]); assert.equal(cf.application, 'not-checked');
      assert.equal(cf.authentication, 'not-inspected'); assert.equal(cf.credentialPresence, 'not-inspected');
    }
    const history = new DeploymentHistory(f.project, f.home), id = history.beginConnection({ ref: f.ref, target: destination,
      credentialRevision: revision, destinationId: 'a'.repeat(64), intentFingerprint: 'b'.repeat(64), force: false });
    assert.ok(id); assert.equal(history.finish(id, 'completed'), true);
    const inv = await readConnectionInventory(f.project, { vault: f.vault, baseDir: f.home }); closed(inv, renderConnectionInventory(inv));
    const row = inv.slots.find(row => row.service === service && row.environment === environment);
    assert.equal(row.nextStep, 'resume-selected-connection'); assert.equal(row.selection.status, 'selected');
    assert.equal(row.history.placements[0].registrationRelation, 'same-recorded-revision');
    assert.equal(inv.currentHealth, 'unverified'); assert.match(renderConnectionInventory(inv), /native受入待ち/);
    const n = await next(f); closed(n); assert.ok(n.nextActions.some(a => a.kind === 'review-provider-credential' && a.service === service && a.environments.includes(environment)));
    assert.equal(n.schemaVersion, 13); checks++;
  }
  for (const service of ['openai', 'stripe-test']) {
    const f = fixture(service); writeFileSync(join(f.project, 'app.ts'), `process.env.${refName(service)};\n`);
    let n = await next(f); assert.deepEqual(n.nextActions.find(a => a.kind === 'review-provider-credential'),
      { actor: 'agent', kind: 'review-provider-credential', service, environments: ['preview'] });
    assert.ok(!n.nextActions.some(a => (a.kind === 'register-secret' || a.kind === 'remove-secret') && a.name === refName(service)));
    // A fresh agent finds the saved hosted environment without registering a key.
    const reopened = new ConnectionStateStore(f.project, f.home); assert.equal(reopened.readProviderHostedIntent(service).value.environment, 'preview');
    assert.equal((await f.guide()).registration.presence, 'missing'); checks++;
    const wrong = await readCredentialGuide(f.project, service, 'development', { vault: f.vault, humanPlane: { capability: () => 'os-dialog' }, baseDir: f.home });
    assert.equal(wrong.hostedConnection.matchesRequestedEnvironment, false); assert.equal(wrong.operationPlan.consumer, 'unsupported');
    assert.equal(planConnectionTarget(f.project, { ...f.input, environment: 'development' }, f.home).reason, 'selection-mismatch');
    const otherIds = { service, environment: 'preview', orgId: 'team_fixture', projectId: 'prj_fixture' };
    assert.equal(planConnectionTarget(f.project, otherIds, f.home).reason, 'selection-mismatch'); checks++;
    // Native helpers must not silently substitute a managed or provider-native route.
    assert.equal(readNativeAcquisitionGuide(f.project, service, 'preview', f.home).state, 'unsupported'); checks++;
    const hash = createHash('sha256').update(canonicalProjectRealpath(f.project)).digest('hex'), stateDir = join(f.home, '.api-key-case', 'connections', hash);
    writeFileSync(join(stateDir, `provider-${service}.json`), JSON.stringify({ secret: canary }), { mode: 0o600 });
    n = await next(f); closed(n); assert.deepEqual(n.nextActions.find(a => a.kind === 'review-provider-credential'),
      { actor: 'agent', kind: 'review-provider-credential', service, environments: [] });
    assert.ok(!n.nextActions.some(a => a.kind === 'register-secret' && a.name === refName(service)));
    f.calls.length = 0; const corrupt = await f.guide(); closed(corrupt); assert.equal(corrupt.status, 'unavailable');
    assert.equal(corrupt.hostedConnection.status, 'unavailable'); assert.equal(f.calls.length, 0); checks++;
  }
  // The same bounded additive selector path works for each new profile.
  for (const service of ['openai', 'stripe-test']) {
    const f = fixture(service, 'development'), original = planConnectionTarget(f.project, f.input, f.home);
    assert.equal(applyConnectionTarget(f.project, f.input, original.fingerprint, f.home).status, 'created');
    assert.equal(f.select({ environment: 'preview' }).ok, true);
    const input = { ...f.input, environment: 'preview', worker: 'fixture-preview' };
    const p = planConnectionTarget(f.project, input, f.home);
    if (process.platform === 'linux') {
      assert.equal(p.status, 'planned'); assert.equal(p.localConfiguration, 'missing-environment');
      assert.equal(p.existingSelectors.env.development.name, 'fixture-worker');
      assert.equal(applyConnectionTarget(f.project, input, p.fingerprint, f.home).status, 'updated');
      const data = JSON.parse(readFileSync(join(f.project, 'wrangler.jsonc'), 'utf8'));
      assert.equal(data.env.development.name, 'fixture-worker'); assert.equal(data.env.preview.name, 'fixture-preview');
      assert.equal(readCloudflareAcquisitionGuide(f.project, service, 'preview', f.home).selection.worker, 'fixture-preview');
    } else assert.equal(p.reason, 'unsupported-update-layout');
    checks++;
  }
  const coexisting = fixture('openai', 'preview', 'vercel');
  assert.equal(coexisting.store.setProviderHostedIntent({ service: 'stripe-test', environment: 'preview',
    route: 'api-key-case-managed', destination: { kind: 'vercel' }, sendingDomain: null }).ok, true);
  const openaiPlan = planConnectionTarget(coexisting.project, coexisting.input, coexisting.home);
  const stripeInput = { ...coexisting.input, service: 'stripe-test' };
  const stripePlan = planConnectionTarget(coexisting.project, stripeInput, coexisting.home);
  assert.equal(stripePlan.status, 'planned'); assert.notEqual(openaiPlan.fingerprint, stripePlan.fingerprint);
  const unchangedFiles = snapshot(coexisting.dir);
  assert.equal(applyConnectionTarget(coexisting.project, stripeInput, openaiPlan.fingerprint, coexisting.home).reason, 'plan-mismatch');
  assert.equal(snapshot(coexisting.dir), unchangedFiles); checks++;
  // Exact metadata stability is rechecked after awaited presence reads.
  const race = fixture(); race.register(); let probes = 0;
  const g = await readCredentialGuide(race.project, 'openai', 'preview', { baseDir: race.home,
    humanPlane: { capability: () => 'os-dialog' }, vault: { hasSecret: async ref => {
      if (++probes === 3) assert.equal(race.select({ destination: { kind: 'vercel' } }).ok, true);
      return race.refs.has(toAccount(ref));
    } } });
  assert.equal(g.status, 'unavailable'); assert.equal(g.hostedConnection.status, 'unavailable'); assert.equal(g.acquisition, null); closed(g); checks++;
  const invRace = fixture(); invRace.register(); let reads = 0;
  const inv = await readConnectionInventory(invRace.project, { baseDir: invRace.home, vault: { hasSecret: async ref => {
    if (++reads === 11) assert.equal(invRace.select({ destination: { kind: 'vercel' } }).ok, true);
    return invRace.refs.has(toAccount(ref));
  } } });
  assert.ok(inv.slots.filter(row => row.service === 'openai').every(row => row.selection.status === 'unavailable' && row.selection.routes.length === 0)); checks++;
  // Named environment cannot borrow root-only configuration.
  const missingEnv = fixture(); writeFileSync(join(missingEnv.project, 'wrangler.jsonc'), JSON.stringify({ name: 'root-worker', account_id: account }));
  const unresolved = readCloudflareAcquisitionGuide(missingEnv.project, 'openai', 'preview', missingEnv.home);
  assert.equal(unresolved.reason, 'configuration-unresolved'); assert.equal(unresolved.selection, null); checks++;
  const bad = fixture('stripe-test'); const denial = new Proxy({}, { get() { throw Error('unexpected effect'); } });
  const unsupported = await readCredentialGuide(bad.project, 'stripe-test', 'production', { vault: denial, humanPlane: denial, baseDir: bad.home });
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(planConnectionTarget(bad.project, { ...bad.input, environment: 'production' }, bad.home).reason, 'invalid-input');
  assert.equal(readCloudflareAcquisitionGuide(bad.project, 'stripe-test', 'production', bad.home).state, 'unsupported'); checks++;
  // Actual CLI helper entrypoints deny child/network effects and leave fixture metadata unchanged.
  const marker = join(root, 'forbidden-effect'), preload = join(root, 'deny-effects.cjs');
  writeFileSync(preload, `const fs=require('node:fs');const deny=()=>{fs.writeFileSync(${JSON.stringify(marker)},'effect');throw Error(${JSON.stringify(canary)})};
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[n]=deny;
for(const m of ['node:http','node:https'])for(const n of ['request','get'])require(m)[n]=deny;
for(const n of ['connect','createConnection'])require('node:net')[n]=deny;require('node:tls').connect=deny;global.fetch=deny;require('node:module').syncBuiltinESMExports();`);
  const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
  for (const service of ['openai', 'stripe-test']) {
    const f = fixture(service), p = planConnectionTarget(f.project, f.input, f.home);
    assert.equal(applyConnectionTarget(f.project, f.input, p.fingerprint, f.home).status, 'created');
    const before = snapshot(f.dir);
    const run = args => spawnSync(process.execPath, ['--require', preload, cli, 'connection', ...args, f.project], {
      env: { ...process.env, HOME: f.home, USERPROFILE: f.home, DO_NOT_TRACK: '1' }, encoding: 'utf8', timeout: 15000 });
    for (const args of [['cloudflare', 'guide', '--service', service, '--env', 'preview', '--json'],
      ['target', 'plan', '--service', service, '--env', 'preview', '--account-id', account, '--worker', 'fixture-worker', '--json']]) {
      const result = run(args); assert.equal(result.status, 0, result.stderr); closed(JSON.parse(result.stdout)); checks++;
    }
    for (const args of [['cloudflare', 'guide', '--service', service, '--env', 'preview', '--open'],
      ['cloudflare', 'guide', '--service', service, '--env', 'preview', '--service', 'resend'],
      ['target', 'plan', '--service', service, '--env', 'preview', '--account-id', account, '--worker', 'fixture-worker', '--force']]) {
      assert.equal(run(args).status, 1); checks++;
    }
    if (service === 'stripe-test') assert.equal(run(['cloudflare', 'guide', '--service', service, '--env', 'production']).status, 1);
    assert.equal(snapshot(f.dir), before); assert.equal(existsSync(marker), false);
  }
  const text = renderAgentProtocol('0.9.2');
  assert.match(text, /connection set --service <openai\|stripe-test>/); assert.match(text, /native execution remains unavailable pending acceptance/);
  assert.match(text, /connection resume plan --service <resend\|clerk\|openai\|stripe-test>/);
  assert.match(text, /Cloudflare secret put creates a Worker version and immediately deploys it/);
  assert.match(text, /Vercel changes future deployment configuration and does not itself deploy the app/);
  assert.match(text, /Provider\/application verification remains unsupported/); checks++;
  console.log(`Provider hosted guides: ${checks} synthetic cases passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
function refName(service) { return service === 'openai' ? 'OPENAI_API_KEY' : 'STRIPE_API_KEY'; }
