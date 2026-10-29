import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { credentialRefForService } from '../dist/core/agent/connection-credential.js';
import { canonicalProjectRealpath } from '../dist/core/vault/naming.js';

const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'akc-provider-memory-')));
const services = ['openai', 'stripe-test'];
const canary = 'synthetic-provider-memory-no-output-QZ73';
let checks = 0;
const environments = service => service === 'stripe-test' ? ['development', 'preview'] : ['development', 'preview', 'production'];
const input = (service = 'openai', environment = 'development', kind = 'vercel') =>
  ({ service, environment, route: 'api-key-case-managed', destination: { kind }, sendingDomain: null });
const request = (service = 'openai', environment = 'development') => ({ service, environment, route: 'api-key-case-managed' });
function fixture(name) {
  const dir = join(root, name), home = join(dir, 'home'), project = join(dir, 'project');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(project);
  const store = new ConnectionStateStore(project, home);
  const metadata = join(home, '.api-key-case', 'connections', createHash('sha256').update(canonicalProjectRealpath(project)).digest('hex'));
  return { home, project, store, metadata, history: join(metadata, 'intent-history.json'),
    active: service => join(metadata, `provider-${service}.json`),
    save: (service, environment, kind) => store.setProviderHostedIntent(input(service, environment, kind)),
    plan: (service, environment) => store.planIntentResume(request(service, environment)),
    apply: plan => store.applyIntentResume(request(plan.service, plan.environment), plan.fingerprint) };
}
function snapshot(path) {
  if (!fs.existsSync(path)) return null;
  return JSON.stringify(fs.readdirSync(path).sort().map(name => {
    const file = join(path, name), st = fs.lstatSync(file);
    return [name, st.mode, st.isSymbolicLink() ? fs.readlinkSync(file) : st.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('hex')];
  }));
}
function writeJson(path, value) { fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
function blocked(f, expected = 'invalid-data', service = 'openai') {
  const before = snapshot(f.home), plan = f.plan(service);
  assert.equal(plan.status, 'blocked'); assert.equal(plan.issue, expected);
  assert.equal(plan.current, null); assert.equal(plan.remembered, null);
  assert.equal(plan.fingerprint, null); assert.equal(plan.permission, 'none'); assert.equal(plan.providerOperation, false);
  assert.ok(!JSON.stringify(plan).includes(canary)); assert.equal(snapshot(f.home), before); checks++;
}

try {
  // Invalid direct inputs create nothing, and no unvalidated strings enter reports.
  const empty = fixture('invalid');
  for (const bad of [null, {}, { ...input(), service: canary }, { ...input(), service: 'resend' },
    { ...input(), service: 'clerk' }, { ...input(), environment: 'staging' }, input('stripe-test', 'production'),
    { ...input(), route: 'provider-native' }, { ...input(), route: 'manual' },
    ...['local', 'github', 'manual', canary].map(kind => input('openai', 'development', kind)),
    { ...input(), sendingDomain: 'mail.example.com' }, { ...input(), destination: { kind: 'vercel', value: canary } },
    { ...input(), value: canary }, { ...input(), slot: 'default' }]) {
    assert.deepEqual(empty.store.setProviderHostedIntent(bad), { ok: false, issue: 'invalid-data', value: null }); checks++;
  }
  for (const bad of [undefined, 'resend', 'clerk', canary]) {
    assert.deepEqual(empty.store.readProviderHostedIntent(bad), { status: 'unavailable', issue: 'invalid-data', value: null }); checks++;
  }
  for (const bad of [{ service: 'openai', environment: 'development' }, { service: 'stripe-test', environment: 'preview' },
    { ...request(), route: 'provider-native' }, { ...request(), route: 'manual' }, request('stripe-test', 'production'),
    { ...request(), service: canary }, { ...request(), environment: canary }, { ...request(), value: canary }]) {
    const plan = empty.store.planIntentResume(bad);
    assert.equal(plan.issue, 'invalid-data'); assert.equal(plan.service, null); assert.equal(plan.profile, null);
    assert.ok(!JSON.stringify(plan).includes(canary)); assert.equal(empty.store.applyIntentResume(bad, 'a'.repeat(64)).issue, 'invalid-data'); checks++;
  }
  assert.equal(snapshot(empty.home), '[]');
  for (const service of services) {
    assert.equal(empty.store.readProviderHostedIntent(service).status, 'missing');
    assert.equal(empty.plan(service).issue, 'not-recorded'); checks++;
  }
  assert.equal(snapshot(empty.home), '[]');

  // Profiles share the existing lock/archive, but never overwrite each other or legacy state.
  const f = fixture('round-trip');
  assert.equal(f.store.saveIntent({ service: 'resend', environment: 'development', route: 'api-key-case-managed', destination: { kind: 'local' }, sendingDomain: null }).ok, true);
  assert.equal(f.store.saveClerkNativeIntent({ service: 'clerk', environment: 'development', route: 'provider-native', destination: { kind: 'vercel' }, sendingDomain: null }).ok, true);
  assert.equal(f.store.saveClerkManagedIntent({ service: 'clerk', environment: 'development', route: 'api-key-case-managed', destination: { kind: 'cloudflare' }, sendingDomain: null }).ok, true);
  const legacyBytes = new Map(['state.json', 'clerk-native.json', 'clerk-managed.json'].map(name => [name, fs.readFileSync(join(f.metadata, name), 'utf8')]));
  const credentialBytes = new Map(), revisions = new Map();
  for (const service of services) {
    for (const environment of environments(service)) {
      const ref = credentialRefForService(f.project, environment, service), mutation = f.store.beginCredentialMutation(ref);
      assert.equal(mutation.ok, true); assert.equal(f.store.finishCredentialMutation(ref, mutation.value, true), true);
      revisions.set(`${service}/${environment}`, mutation.value);
      const name = `credential-${service}-${environment}.json`;
      credentialBytes.set(name, fs.readFileSync(join(f.metadata, name), 'utf8'));
    }
    assert.equal(f.plan(service).issue, 'not-recorded', 'registration metadata must not infer a hosted selection');
    const selected = f.save(service).value;
    assert.equal(selected.service, service); assert.equal(selected.sendingDomain, null);
    assert.equal(f.store.readProviderHostedIntent(service).value.id, selected.id);
    assert.equal(JSON.parse(fs.readFileSync(f.active(service))).schemaVersion, 1);
    const before = snapshot(f.home);
    assert.deepEqual(f.save(service).value, selected); assert.equal(snapshot(f.home), before);
    f.save(service, 'preview', 'cloudflare');
    const plan = f.plan(service), latest = f.store.readProviderHostedIntent(service).value;
    assert.equal(plan.profile, `provider-${service}`); assert.equal(plan.status, 'ready'); assert.equal(plan.source, 'last-recorded');
    assert.deepEqual(plan.remembered, selected); assert.equal(plan.current.environment, 'preview');
    assert.equal(plan.permission, 'none'); assert.equal(plan.providerOperation, false);
    assert.equal(f.apply(plan).status, 'applied');
    const restored = f.store.readProviderHostedIntent(service).value;
    assert.equal(restored.environment, 'development'); assert.equal(restored.destination.kind, 'vercel');
    assert.ok(restored.updatedAt > selected.updatedAt && restored.updatedAt > latest.updatedAt);
    const after = snapshot(f.home);
    assert.equal(f.apply(plan).issue, 'stale-plan'); assert.equal(snapshot(f.home), after);
    const unchanged = f.plan(service);
    assert.equal(unchanged.status, 'unchanged'); assert.equal(unchanged.source, 'current');
    assert.equal(f.apply(unchanged).status, 'unchanged'); assert.equal(snapshot(f.home), after);
    // A route/destination change for the same environment keeps the newest committed selection.
    const replacement = f.save(service, 'development', 'cloudflare').value;
    const current = f.plan(service);
    assert.equal(current.source, 'current'); assert.equal(current.remembered.destination.kind, 'cloudflare');
    assert.equal(current.remembered.updatedAt, replacement.updatedAt);
    checks += 7;
  }
  for (const [name, bytes] of [...legacyBytes, ...credentialBytes]) assert.equal(fs.readFileSync(join(f.metadata, name), 'utf8'), bytes);
  for (const service of services) for (const environment of environments(service))
    assert.equal(f.store.credentialRevision(credentialRefForService(f.project, environment, service)), revisions.get(`${service}/${environment}`));

  // All fourteen closed slots can coexist; repeated rotations replace only their own slot.
  const bounded = fixture('bounded');
  for (let round = 0; round < 3; round++) for (const environment of ['development', 'preview', 'production', 'development']) {
    bounded.store.saveIntent({ service: 'resend', environment, route: 'manual', destination: { kind: 'manual' }, sendingDomain: null });
    bounded.store.saveClerkNativeIntent({ service: 'clerk', environment, route: 'provider-native', destination: { kind: 'vercel' }, sendingDomain: null });
    bounded.store.saveClerkManagedIntent({ service: 'clerk', environment, route: 'api-key-case-managed', destination: { kind: 'cloudflare' }, sendingDomain: null });
    assert.equal(bounded.save('openai', environment).ok, true);
    if (environment !== 'production') assert.equal(bounded.save('stripe-test', environment).ok, true);
  }
  const all = JSON.parse(fs.readFileSync(bounded.history));
  assert.equal(all.schemaVersion, 1); assert.equal(all.entries.length, 14);
  assert.equal(new Set(all.entries.map(entry => `${entry.profile}/${entry.intent.environment}`)).size, 14);
  for (const service of services) for (const environment of environments(service)) {
    const plan = bounded.plan(service, environment);
    assert.ok(['ready', 'unchanged'].includes(plan.status)); assert.equal(bounded.apply(plan).status, plan.status === 'ready' ? 'applied' : 'unchanged'); checks++;
  }
  assert.equal(JSON.parse(fs.readFileSync(bounded.history)).entries.length, 14);

  // Closed active envelopes bind service, environment and project identity.
  for (const [name, mutate, issue] of [
    ['unknown-schema', value => { value.schemaVersion = 2; }, 'unsupported-schema'],
    ['unknown-field', value => { value.secret = canary; }],
    ['unknown-intent-field', value => { value.intent.value = canary; }],
    ['wrong-service', value => { value.intent.service = 'stripe-test'; }],
    ['wrong-id', value => { value.intent.id = 'a'.repeat(64); }],
    ['invalid-route', value => { value.intent.route = 'provider-native'; }],
    ['invalid-destination', value => { value.intent.destination.kind = 'local'; }],
    ['sending-domain', value => { value.intent.sendingDomain = 'mail.example.com'; }],
    ['invalid-time', value => { value.intent.updatedAt = '1990-01-01T00:00:00.000Z'; }]
  ]) {
    const broken = fixture(name); broken.save('openai');
    const value = JSON.parse(fs.readFileSync(broken.active('openai'))); mutate(value); writeJson(broken.active('openai'), value);
    blocked(broken, issue); assert.equal(broken.store.readProviderHostedIntent('openai').issue, issue ?? 'invalid-data');
    const before = snapshot(broken.home); assert.equal(broken.save('openai', 'preview').ok, false); assert.equal(snapshot(broken.home), before);
  }
  const stripe = fixture('stripe-production'); stripe.save('stripe-test');
  const stripeValue = JSON.parse(fs.readFileSync(stripe.active('stripe-test'))); stripeValue.intent.environment = 'production';
  stripeValue.intent.id = createHash('sha256').update(`${canonicalProjectRealpath(stripe.project)}\nstripe-test\nproduction\ndefault`).digest('hex');
  writeJson(stripe.active('stripe-test'), stripeValue); blocked(stripe, 'invalid-data', 'stripe-test');
  const wrongProject = fixture('wrong-project'); wrongProject.save('openai');
  fs.writeFileSync(wrongProject.active('openai'), fs.readFileSync(f.active('openai'))); blocked(wrongProject);

  // Corrupt/unknown history must not be skipped, repaired or partially echoed.
  for (const [name, mutate, issue] of [
    ['history-schema', value => { value.schemaVersion = 2; }, 'unsupported-schema'],
    ['history-profile', value => { value.entries[0].profile = canary; }],
    ['history-service', value => { value.entries[0].intent.service = 'stripe-test'; }],
    ['history-extra', value => { value.entries[0].value = canary; }],
    ['history-duplicate', value => { value.entries.push(value.entries[0]); }],
    ['history-count', value => { value.entries = Array(15).fill(value.entries[0]); }],
    ['history-id', value => { value.entries[0].intent.id = 'b'.repeat(64); }],
    ['history-route', value => { value.entries[0].intent.route = 'manual'; }]
  ]) {
    const broken = fixture(name); broken.save('openai'); broken.save('openai', 'preview');
    const value = JSON.parse(fs.readFileSync(broken.history)); mutate(value); writeJson(broken.history, value);
    blocked(broken, issue);
    const before = snapshot(broken.home);
    assert.equal(broken.save('openai', 'production').ok, false); assert.equal(snapshot(broken.home), before);
    assert.equal(broken.save('openai', 'preview').ok, true, 'existing exact-current no-write path stays available');
    assert.equal(snapshot(broken.home), before);
    blocked(broken, issue);
  }
  for (const target of ['active', 'history']) for (const problem of ['temporary', 'unsafe-link', 'oversized', 'lock']) {
    const broken = fixture(`${target}-${problem}`); broken.save('openai'); broken.save('openai', 'preview');
    const path = target === 'active' ? broken.active('openai') : broken.history;
    let issue;
    if (problem === 'temporary') { fs.writeFileSync(`${path}.tmp`, canary); issue = 'temporary-file-present'; }
    if (problem === 'unsafe-link') {
      fs.unlinkSync(path);
      // A junction exercises reparse rejection without Windows symlink privileges.
      // POSIX retains the file-symlink case; neither fixture is a native acceptance.
      if (process.platform === 'win32') {
        const destination = join(broken.project, 'unsafe-target');
        fs.mkdirSync(destination);
        fs.symlinkSync(destination, path, 'junction');
      } else fs.symlinkSync(join(root, canary), path);
      issue = 'unsafe-path';
    }
    if (problem === 'oversized') { fs.writeFileSync(path, ' '.repeat(256 * 1024 + 1)); issue = 'too-large'; }
    if (problem === 'lock') { fs.mkdirSync(join(broken.metadata, 'lock')); issue = 'lock-present'; }
    blocked(broken, issue);
  }

  // Existing two-file failure semantics hold for the new files too.
  for (const afterRename of [false, true]) {
    const interrupted = fixture(`interrupted-${afterRename}`), initial = interrupted.save('openai').value;
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === interrupted.active('openai')) {
        if (afterRename) rename(from, to);
        throw Object.assign(new Error(canary), { code: 'EIO' });
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    try { assert.equal(interrupted.save('openai', 'preview').ok, false); }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    const history = JSON.parse(fs.readFileSync(interrupted.history));
    assert.deepEqual(history.entries.map(entry => entry.intent), [initial], 'only committed predecessor is archived');
    assert.equal(interrupted.store.readProviderHostedIntent('openai').value.environment, afterRename ? 'preview' : 'development');
    assert.equal(interrupted.plan('openai').status, afterRename ? 'ready' : 'unchanged'); checks++;
  }

  // Fresh processes continue using only persisted metadata, with provider/native/process effects forbidden.
  const fresh = fixture('fresh-process'), stateUrl = new URL('../dist/core/agent/connection-state.js', import.meta.url).href;
  const cliUrl = new URL('../dist/cli/connection-resume.js', import.meta.url).href;
  const guard = `const fs = await import('node:fs'), cp = await import('node:child_process');
    let forbidden = 0; const deny = () => { forbidden++; throw Error(${JSON.stringify(canary)}); };
    for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp.default[name] = deny;
    for (const module of ['node:net','node:tls','node:http','node:https','node:dns','node:dgram']) {
      const mod = (await import(module)).default;
      for (const name of ['connect','createConnection','request','get','lookup','resolve','createSocket']) if (mod[name]) mod[name] = deny;
      if (mod.Socket) mod.Socket.prototype.connect = deny;
    }
    globalThis.fetch = process.dlopen = deny;
    if (process.env.AKC_TEST_READ_ONLY === '1') {
      for (const name of ['writeFileSync','writeSync','mkdirSync','renameSync','unlinkSync','rmdirSync','chmodSync','fchmodSync']) fs.default[name] = deny;
      const open = fs.default.openSync; fs.default.openSync = (path, flags, ...rest) => {
        if (typeof flags === 'string' ? /[wax+]/.test(flags) : flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) return deny();
        return open(path, flags, ...rest);
      };
    }
    (await import('node:module')).syncBuiltinESMExports();
    process.on('exit', () => { if (forbidden) { process.stderr.write('Forbidden effect attempted'); process.exitCode = 97; } });`;
  const run = (source, { code = 0, readOnly = false, unchanged = readOnly } = {}) => {
    const before = snapshot(fresh.home), result = spawnSync(process.execPath, ['--input-type=module', '-e', guard + source], {
      cwd: fresh.project, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      env: { HOME: fresh.home, USERPROFILE: fresh.home, PATH: '', AKC_TEST_READ_ONLY: readOnly ? '1' : '0',
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}) }
    });
    assert.equal(result.error, undefined); assert.equal(result.status, code, result.stderr || result.stdout);
    assert.ok(!(result.stderr + result.stdout).includes(canary));
    if (unchanged) assert.equal(snapshot(fresh.home), before);
    checks++; return result;
  };
  const cli = (operation, args, options) => run(`const { runConnectionResumeCommand } = await import(${JSON.stringify(cliUrl)});
    process.exitCode = runConnectionResumeCommand(${JSON.stringify([operation, ...args, '--json', fresh.project])});`, options);
  const args = (service = 'openai', environment = 'development', route = 'api-key-case-managed') =>
    ['--service', service, '--env', environment, ...(route ? ['--route', route] : [])];
  for (const service of services) {
    for (const environment of ['development', 'preview']) run(`const { ConnectionStateStore } = await import(${JSON.stringify(stateUrl)});
      const result = new ConnectionStateStore(${JSON.stringify(fresh.project)}).setProviderHostedIntent(${JSON.stringify(input(service, environment, environment === 'development' ? 'vercel' : 'cloudflare'))});
      if (!result.ok) process.exitCode = 1;`);
    const plan = JSON.parse(cli('plan', args(service), { readOnly: true }).stdout);
    assert.equal(plan.status, 'ready'); assert.equal(plan.remembered.destination.kind, 'vercel');
    const applied = JSON.parse(cli('apply', [...args(service), '--fingerprint', plan.fingerprint]).stdout);
    assert.equal(applied.status, 'applied'); assert.equal(fresh.store.readProviderHostedIntent(service).value.environment, 'development');
    const unchanged = JSON.parse(cli('plan', args(service), { readOnly: true }).stdout);
    assert.equal(unchanged.status, 'unchanged');
    assert.equal(JSON.parse(cli('apply', [...args(service), '--fingerprint', unchanged.fingerprint], { unchanged: true }).stdout).status, 'unchanged');
    assert.equal(JSON.parse(cli('apply', [...args(service), '--fingerprint', plan.fingerprint], { code: 1, unchanged: true }).stdout).issue, 'stale-plan');
  }
  for (const invalid of [args('openai', 'development', null), args('stripe-test', 'preview', null),
    args('stripe-test', 'production'), args('openai', 'development', 'provider-native'), args('stripe-test', 'preview', 'manual'),
    args('stripe-live'), args('openai', 'staging'), ['--service', 'openai', '--route', 'api-key-case-managed'],
    [...args(), '--service', 'stripe-test'], [...args(), '--destination', 'cloudflare'], [...args(), '--value', canary]]) {
    assert.match(cli('plan', invalid, { code: 1, readOnly: true }).stderr, /^Usage:/);
  }
  console.log(`${checks} provider hosted memory and fresh-process resume checks passed.`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
