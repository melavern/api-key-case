// Synthetic local selectors only. No real provider, credential, login or deployment.
import assert from 'node:assert/strict';
import { unsafeMetadataLink } from './helpers/metadata-link-fixture.mjs';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { canonicalProjectRealpath } from '../dist/core/vault/naming.js';
import { planConnectionTarget, applyConnectionTarget, renderConnectionTarget } from '../dist/core/agent/connection-target.js';
import { readNativeDestinationSelection } from '../dist/core/agent/native-observations.js';
import { readNativeAcquisitionGuide } from '../dist/core/agent/native-acquisition.js';
import { readCloudflareAcquisitionGuide } from '../dist/core/agent/cloudflare-acquisition.js';
import { buildConnectionPlan } from '../dist/core/agent/connection-plan.js';

const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'akc-target-')));
const accountId = '0123456789abcdef0123456789abcdef', canary = 'synthetic-private-provider-data!';
let checks = 0, serial = 0;
// Reads may update access time on Windows. Preserve every write/identity field
// and the independent byte snapshot when asserting a no-op.
const writeState = path => { const { atimeMs, ...state } = fs.statSync(path); return state; };
const snapshot = dir => Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap(row => {
  const path = join(dir, row.name);
  return row.isDirectory() ? Object.entries(snapshot(path)) : row.isFile() ? [[path, { bytes: fs.readFileSync(path).toString('base64'), mode: fs.statSync(path).mode }]] : [];
}));
function fixture(service = 'resend', target = 'vercel', environment = 'development', route = target === 'vercel' ? 'provider-native' : 'api-key-case-managed') {
  const dir = join(root, String(serial++)), project = join(dir, 'project'), home = join(dir, 'home');
  for (const p of [dir, project, home]) fs.mkdirSync(p, { mode: 0o700 });
  fs.writeFileSync(join(project, 'app.js'), '// Existing app stays intact.\n');
  const store = new ConnectionStateStore(project, home);
  const select = (extra = {}) => (service === 'resend' ? store.saveIntent.bind(store) : target === 'vercel' ? store.saveClerkNativeIntent.bind(store) : store.saveClerkManagedIntent.bind(store))({ service, environment, route, destination: { kind: target }, sendingDomain: null, ...extra });
  assert.equal(select().ok, true);
  const input = { service, environment, ...(target === 'vercel' ? { orgId: 'team_fixture', projectId: 'prj_fixture' } : { accountId, worker: 'fixture-worker' }) };
  const plan = () => planConnectionTarget(project, input, home);
  const apply = fingerprint => applyConnectionTarget(project, input, fingerprint, home);
  const guide = () => target === 'vercel' ? readNativeAcquisitionGuide(project, service, environment, home) : readCloudflareAcquisitionGuide(project, service, environment, home);
  return { dir, project, home, store, input, plan, apply, guide, select, service, target, environment };
}
function closed(r) {
  assert.equal(r.permission, 'none'); assert.equal(r.authentication, 'not-inspected'); assert.equal(r.remoteResource, 'not-inspected');
  assert.equal(r.currentHealth, 'unverified'); assert.equal(r.credentialAccess, 'none'); assert.equal(r.providerExecution, false);
  assert.ok(!(JSON.stringify(r) + renderConnectionTarget(r)).includes(canary));
}
function noChange(f, fn, reason) {
  const before = snapshot(f.dir), r = fn(); closed(r);
  assert.equal(r.status, 'blocked'); if (reason) assert.equal(r.reason, reason);
  assert.equal(r.localEffects, 'none'); assert.deepEqual(snapshot(f.dir), before); checks++; return r;
}
function writeConfig(f, content) {
  const file = f.target === 'vercel' ? '.vercel/project.json' : 'wrangler.jsonc';
  if (f.target === 'vercel' && !fs.existsSync(join(f.project, '.vercel'))) fs.mkdirSync(join(f.project, '.vercel'));
  fs.writeFileSync(join(f.project, file), content); return join(f.project, file);
}
function patch(name, make, run) {
  const original = fs[name]; fs[name] = make(original); syncBuiltinESMExports();
  try { return run(); } finally { fs[name] = original; syncBuiltinESMExports(); }
}
try {
  for (const service of ['resend', 'clerk']) for (const target of ['vercel', 'cloudflare']) for (const environment of ['development', 'preview', 'production']) {
    const f = fixture(service, target, environment), before = snapshot(f.dir);
    assert.equal(f.guide().selection, null);
    const p = f.plan(); closed(p); assert.equal(p.status, 'planned'); assert.equal(p.localEffects, 'none');
    assert.equal(p.environment, environment); assert.equal(p.selection.canonicalProject, f.project); assert.match(p.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(f.plan(), p); assert.deepEqual(snapshot(f.dir), before);
    const applied = f.apply(p.fingerprint); closed(applied); assert.equal(applied.status, 'created', JSON.stringify(applied));
    assert.equal(applied.localEffects, 'created'); assert.equal(applied.localConfiguration, 'matching');
    const config = JSON.parse(fs.readFileSync(join(f.project, p.relativePath), 'utf8'));
    assert.deepEqual(config, JSON.parse(p.proposedConfig));
    if (target === 'cloudflare') assert.deepEqual(config, environment === 'production' ? { name: 'fixture-worker', account_id: accountId } : { env: { [environment]: { name: 'fixture-worker', account_id: accountId } } });
    else assert.deepEqual(config, { orgId: 'team_fixture', projectId: 'prj_fixture' });
    for (const [path, data] of Object.entries(before)) assert.deepEqual(snapshot(f.dir)[path], data);
    assert.equal(Object.keys(snapshot(f.dir)).length, Object.keys(before).length + 1);
    assert.deepEqual(Object.keys(snapshot(f.project)).sort(), [join(f.project, 'app.js'), join(f.project, p.relativePath)].sort());
    const g = f.guide(); assert.ok(g.selection); assert.equal(g.environment, environment);
    if (target === 'vercel') { assert.equal(g.selection.orgId, f.input.orgId); assert.equal(g.selection.projectId, f.input.projectId); assert.equal(g.configuration, 'not-inspected'); }
    else { assert.equal(g.selection.accountId, accountId); assert.equal(g.selection.worker, f.input.worker); assert.equal(g.state, 'selection-confirmed'); }
    const stable = snapshot(f.dir), fileState = writeState(join(f.project, p.relativePath));
    const repeated = f.apply(applied.fingerprint); assert.equal(repeated.status, 'unchanged'); assert.equal(repeated.localEffects, 'none');
    assert.deepEqual(writeState(join(f.project, p.relativePath)), fileState); assert.deepEqual(snapshot(f.dir), stable);
    const stale = noChange(f, () => f.apply(p.fingerprint), 'plan-mismatch'); assert.equal(stale.localConfiguration, 'matching'); assert.match(renderConnectionTarget(stale), /Do not recreate/);
    assert.equal(f.apply(f.plan().fingerprint).status, 'unchanged'); checks++;
  }
  // Additive updates are deliberately narrower than matching/no-write resolution.
  const tempName = '.wrangler.jsonc.api-key-case-target.tmp';
  const secondAccount = 'abcdef0123456789abcdef0123456789';
  const pair = (name = 'existing-worker', account = secondAccount) => ({ name, account_id: account });
  function additiveFixture(service = 'resend', environment = 'preview', config = { env: { development: pair() } }) {
    const f = fixture(service, 'cloudflare', environment);
    const file = join(f.project, 'wrangler.jsonc');
    fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    return { ...f, file, temporary: join(f.project, tempName) };
  }
  if (process.platform === 'linux') {
    for (const service of ['resend', 'clerk']) for (const first of ['development', 'preview']) {
      const next = first === 'development' ? 'preview' : 'development';
      // Start with the helper's own existing first-environment creation path.
      const f = fixture(service, 'cloudflare', first);
      const created = f.apply(f.plan().fingerprint); assert.equal(created.status, 'created');
      const old = JSON.parse(fs.readFileSync(join(f.project, 'wrangler.jsonc'))), before = snapshot(f.dir);
      const firstInput = { ...f.input };
      f.select({ environment: next }); f.input.environment = next; f.input.worker = `${service}-${next}`; f.input.accountId = secondAccount;
      const selectedBefore = snapshot(f.dir), p = f.plan(); closed(p);
      assert.equal(p.status, 'planned'); assert.equal(p.localConfiguration, 'missing-environment');
      assert.equal(p.existingPath, 'wrangler.jsonc'); assert.deepEqual(p.existingSelectors, old);
      assert.deepEqual(f.plan(), p); assert.deepEqual(snapshot(f.dir), selectedBefore);
      assert.deepEqual(JSON.parse(p.proposedConfig).env[first], old.env[first]);
      assert.deepEqual(p.plannedEffects, [`create ${tempName}`, `add env.${next} to wrangler.jsonc by atomic replacement`]);
      assert.doesNotMatch(renderConnectionTarget(p), /Matching existing config|Existing config \(matching\)/);
      const r = f.apply(p.fingerprint); closed(r); assert.equal(r.status, 'updated', JSON.stringify(r));
      assert.equal(r.reason, 'local-config-updated'); assert.equal(r.localEffects, 'updated'); assert.deepEqual(r.updatedPaths, ['wrangler.jsonc']);
      assert.deepEqual(r.createdPaths, [tempName]); assert.equal(fs.existsSync(join(f.project, tempName)), false);
      const after = JSON.parse(fs.readFileSync(join(f.project, 'wrangler.jsonc')));
      assert.deepEqual(after.env[first], old.env[first]); assert.deepEqual(after.env[next], pair(f.input.worker, secondAccount));
      assert.equal(fs.statSync(join(f.project, 'wrangler.jsonc')).mode, before[join(f.project, 'wrangler.jsonc')].mode);
      for (const [path, data] of Object.entries(selectedBefore)) if (path !== join(f.project, 'wrangler.jsonc')) assert.deepEqual(snapshot(f.dir)[path], data);
      assert.equal(Object.keys(snapshot(f.dir)).length, Object.keys(selectedBefore).length);
      const stable = snapshot(f.dir), stableStat = writeState(join(f.project, 'wrangler.jsonc'));
      assert.equal(f.apply(r.fingerprint).status, 'unchanged'); assert.deepEqual(snapshot(f.dir), stable); assert.deepEqual(writeState(join(f.project, 'wrangler.jsonc')), stableStat);
      noChange(f, () => f.apply(p.fingerprint), 'plan-mismatch');
      const guide = readCloudflareAcquisitionGuide(f.project, service, next, f.home);
      assert.equal(guide.state, 'selection-confirmed'); assert.equal(guide.selection.worker, f.input.worker); assert.equal(guide.selection.accountId, secondAccount);
      f.select({ environment: first });
      const oldPlan = planConnectionTarget(f.project, firstInput, f.home); assert.equal(oldPlan.status, 'unchanged');
      const oldGuide = readCloudflareAcquisitionGuide(f.project, service, first, f.home); assert.equal(oldGuide.selection.worker, firstInput.worker); checks++;
    }
    for (const service of ['resend', 'clerk']) for (const environment of ['development', 'preview']) {
      const other = environment === 'development' ? 'preview' : 'development';
      for (const config of [pair('production-worker'), { ...pair('production-worker'), env: { [other]: pair('other-worker') } }]) {
        const f = additiveFixture(service, environment, config), p = f.plan(), original = fs.statSync(f.file);
        assert.equal(p.status, 'planned'); assert.deepEqual(p.existingSelectors, config);
        assert.equal(f.apply(p.fingerprint).status, 'updated'); const updated = JSON.parse(fs.readFileSync(f.file));
        assert.equal(updated.name, config.name); assert.equal(updated.account_id, config.account_id);
        if (config.env) assert.deepEqual(updated.env[other], config.env[other]);
        const current = fs.statSync(f.file); assert.equal(current.mode, original.mode); assert.equal(current.uid, original.uid); assert.equal(current.gid, original.gid); checks++;
      }
    }
    // Every unsupported/malformed shape refuses addition without disclosing unknown content.
    const valid = { env: { development: pair() } };
    for (const content of [
      {}, { env: {} }, { name: 'partial' }, { account_id: accountId }, { env: { development: { name: 'partial' } } },
      { env: { development: { account_id: accountId } } }, { env: { staging: pair() } }, { env: { production: pair() } },
      { ...valid, main: canary }, { ...valid, compatibility_date: canary }, { ...valid, vars: { PRIVATE: canary } },
      { ...valid, bindings: [canary] }, { ...valid, $schema: canary }, { env: { development: { ...pair(), unknown: canary } } },
      { env: { development: pair(canary) } }, { env: { development: pair('worker', 'bad') } },
      { env: { development: pair('Worker') } }, { env: { development: pair('worker', accountId.toUpperCase()) } },
      { env: { development: pair('../escape') } }, { env: { development: pair('a'.repeat(64)) } },
      { env: { development: pair('worker', accountId + '0') } }, { env: { development: null } }, { env: [] }, { env: { preview: pair('conflicting') } },
      '{', '[]', '', 'x'.repeat(65537), Buffer.from([0xff]).toString(),
      `{"env":{"development":{"name":"existing-worker","account_id":"${secondAccount}","name":"existing-worker"}}}`,
      `{"env":{"development":${JSON.stringify(pair())}},"env":{"development":${JSON.stringify(pair())}}}`,
      `{"env":{"development":${JSON.stringify(pair())},"development":${JSON.stringify(pair())}}}`,
      '{"env":{"development":' + JSON.stringify(pair()) + '},}',
      '// ' + canary + '\n' + JSON.stringify(valid), JSON.stringify(valid).replace('{', '{/* comment */'),
      '{"__proto__":{},"env":{"development":' + JSON.stringify(pair()) + '}}'
    ]) {
      const f = additiveFixture('resend', 'preview', content); noChange(f, f.plan); noChange(f, () => f.apply('0'.repeat(64)));
    }
    for (const ext of ['toml', 'json']) {
      const f = fixture('resend', 'cloudflare', 'preview');
      fs.writeFileSync(join(f.project, `wrangler.${ext}`), ext === 'toml' ? `[env.development]\nname="existing-worker"\naccount_id="${secondAccount}"\n` : JSON.stringify(valid), { mode: 0o600 });
      noChange(f, f.plan, 'configuration-conflict');
    }
    const noProduction = additiveFixture('resend', 'production'); noChange(noProduction, noProduction.plan, 'configuration-conflict');
    for (const kind of ['symlink', 'hardlink', 'directory', 'multiple']) {
      const f = additiveFixture(), backing = join(f.dir, 'original');
      if (kind === 'symlink') { fs.renameSync(f.file, backing); fs.symlinkSync(backing, f.file); }
      else if (kind === 'hardlink') fs.linkSync(f.file, backing);
      else if (kind === 'directory') { fs.unlinkSync(f.file); fs.mkdirSync(f.file); }
      else fs.writeFileSync(join(f.project, 'wrangler.json'), JSON.stringify(valid));
      noChange(f, f.plan, kind === 'multiple' ? 'configuration-conflict' : 'unsafe-path');
    }
    for (const mode of [0o400, 0o644, 0o666, 0o700, 0o4600]) {
      const f = additiveFixture(); fs.chmodSync(f.file, mode); const r = noChange(f, f.plan, 'unsupported-update-layout');
      assert.match(renderConnectionTarget(r), /No local file was changed by this operation/);
    }
    for (const platform of ['darwin', 'win32']) {
      const f = additiveFixture(), descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      try { Object.defineProperty(process, 'platform', { value: platform }); noChange(f, f.plan, 'unsupported-update-layout'); }
      finally { Object.defineProperty(process, 'platform', descriptor); }
    }
    for (const field of ['uid', 'gid']) {
      const f = additiveFixture();
      patch('lstatSync', original => (...args) => { const r = original(...args); if (args[0] === f.file) r[field]++; return r; }, () => noChange(f, f.plan, 'unsupported-update-layout'));
    }
    for (const kind of ['file', 'symlink', 'directory']) {
      const f = additiveFixture();
      if (kind === 'file') fs.writeFileSync(f.temporary, 'other writer');
      else if (kind === 'symlink') fs.symlinkSync(f.file, f.temporary);
      else fs.mkdirSync(f.temporary);
      noChange(f, f.plan, 'configuration-conflict');
    }
    // Stale token binds exact bytes, original inode, intent and exact input/root.
    for (const change of ['replacement', 'edit', 'whitespace', 'intent', 'root']) {
      const f = additiveFixture(), p = f.plan();
      if (change === 'replacement') { const b = fs.readFileSync(f.file); fs.renameSync(f.file, join(f.dir, 'previous')); fs.writeFileSync(f.file, b, { mode: 0o600 }); }
      else if (change === 'edit') fs.writeFileSync(f.file, JSON.stringify({ env: { development: pair('different-existing') } }));
      else if (change === 'whitespace') fs.appendFileSync(f.file, ' ');
      else if (change === 'intent') f.select({ sendingDomain: 'changed.example.test' });
      else { const original = join(f.dir, 'original-root'); fs.renameSync(f.project, original); fs.mkdirSync(f.project, { mode: 0o700 }); fs.copyFileSync(join(original, 'wrangler.jsonc'), f.file); }
      noChange(f, () => f.apply(p.fingerprint), 'plan-mismatch');
    }
    // Exact bytes, not just stat metadata, bind an additive plan.
    const byteBound = additiveFixture(), bytePlan = byteBound.plan(), byteStat = fs.statSync(byteBound.file);
    fs.writeFileSync(byteBound.file, fs.readFileSync(byteBound.file, 'utf8').replace('existing-worker', 'modified-worker'));
    const maskTimes = st => Object.assign(st, { size: byteStat.size, mtimeMs: byteStat.mtimeMs, ctimeMs: byteStat.ctimeMs });
    patch('lstatSync', original => (...args) => args[0] === byteBound.file ? maskTimes(original(...args)) : original(...args), () =>
      patch('fstatSync', original => fd => { const st = original(fd); return st.ino === byteStat.ino && st.dev === byteStat.dev ? maskTimes(st) : st; }, () =>
        noChange(byteBound, () => byteBound.apply(bytePlan.fingerprint), 'plan-mismatch')));
    const invalidUtf8 = additiveFixture(); fs.appendFileSync(invalidUtf8.file, Buffer.from([0xff])); noChange(invalidUtf8, invalidUtf8.plan);
    const differentInput = additiveFixture(), differentPlan = differentInput.plan();
    noChange(differentInput, () => applyConnectionTarget(differentInput.project, { ...differentInput.input, worker: 'other-worker' }, differentPlan.fingerprint, differentInput.home), 'plan-mismatch');
    // Permission primitives are never called; a restrictive umask is not repaired.
    const safeMode = additiveFixture(), safePlan = safeMode.plan();
    const saved = Object.fromEntries(['chmodSync', 'fchmodSync', 'chownSync', 'fchownSync'].map(n => [n, fs[n]]));
    try { for (const n of Object.keys(saved)) fs[n] = () => { throw Error('permission mutation'); }; syncBuiltinESMExports(); assert.equal(safeMode.apply(safePlan.fingerprint).status, 'updated'); checks++; }
    finally { Object.assign(fs, saved); syncBuiltinESMExports(); }
    const restrictive = additiveFixture(), restrictivePlan = restrictive.plan(), savedUmask = process.umask();
    try { process.umask(0o777); const r = restrictive.apply(restrictivePlan.fingerprint); assert.equal(r.status, 'blocked'); assert.equal(r.reason, 'unsupported-update-layout'); assert.equal(r.localEffects, 'possible'); }
    finally { process.umask(savedUmask); } checks++;
    // Detect late original/intent/temp substitution before rename; never delete uncertain paths.
    for (const change of ['replacement', 'edit', 'intent', 'temp-replacement', 'temp-edit', 'other-selector']) {
      const f = additiveFixture(), p = f.plan(), originalBytes = fs.readFileSync(f.file); let expected = originalBytes;
      const r = patch('fsyncSync', original => fd => {
        const result = original(fd);
        if (change === 'replacement') { fs.renameSync(f.file, join(f.dir, 'previous')); expected = Buffer.from(JSON.stringify(valid)); fs.writeFileSync(f.file, expected, { mode: 0o600 }); }
        else if (change === 'edit') { expected = Buffer.from(JSON.stringify({ env: { development: pair('late-existing') } })); fs.writeFileSync(f.file, expected); }
        else if (change === 'intent') f.select({ sendingDomain: 'late.example.test' });
        else if (change === 'temp-replacement') { fs.renameSync(f.temporary, join(f.dir, 'temp-original')); fs.writeFileSync(f.temporary, 'other writer', { mode: 0o600 }); }
        else if (change === 'temp-edit') fs.writeFileSync(f.temporary, 'other writer');
        else fs.writeFileSync(join(f.project, 'wrangler.toml'), 'other writer');
        return result;
      }, () => f.apply(p.fingerprint));
      closed(r); assert.equal(r.status, 'blocked'); assert.equal(r.localEffects, 'possible'); assert.equal(r.fingerprint, null);
      assert.deepEqual(r.updatedPaths, []); assert.deepEqual(fs.readFileSync(f.file), expected); assert.equal(fs.existsSync(f.temporary), true); checks++;
    }
    for (const phase of ['openSync', 'writeSync', 'zero-write', 'partial-write', 'fsyncSync', 'closeSync', 'renameSync', 'rename-then-throw', 'post-rename-intent']) {
      const f = additiveFixture(), p = f.plan(), originalBytes = fs.readFileSync(f.file); let tempFd;
      const r = patch('openSync', original => (...args) => {
        if (args[0] === f.temporary && (args[1] & fs.constants.O_CREAT)) {
          if (phase === 'openSync') fs.writeFileSync(f.temporary, 'collision', { mode: 0o600 });
          tempFd = original(...args); return tempFd;
        } return original(...args);
      }, () => {
        const method = phase.includes('write') ? 'writeSync' : phase === 'closeSync' ? 'closeSync' : phase === 'fsyncSync' ? 'fsyncSync' : 'renameSync';
        return patch(method, original => (...args) => {
          if (method === 'renameSync' && phase === 'openSync') return original(...args);
          if (method === 'closeSync' && args[0] !== tempFd) return original(...args);
          if (phase === 'zero-write') return 0;
          if (phase === 'partial-write') { original(args[0], args[1], args[2], Math.min(7, args[3]), args[4]); throw Error(canary); }
          if (phase === 'closeSync') { original(...args); throw Error(canary); }
          if (phase === 'rename-then-throw') { original(...args); throw Error(canary); }
          if (phase === 'post-rename-intent') { const out = original(...args); f.select({ sendingDomain: 'after.example.test' }); return out; }
          throw Error(canary);
        }, () => f.apply(p.fingerprint));
      });
      closed(r); assert.equal(r.status, 'blocked', phase); assert.equal(r.localEffects, 'possible', phase); assert.equal(r.fingerprint, null);
      if (['rename-then-throw', 'post-rename-intent'].includes(phase)) {
        assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), JSON.parse(p.proposedConfig)); assert.equal(fs.existsSync(f.temporary), false);
        assert.equal(f.plan().status, 'unchanged');
      } else { assert.deepEqual(fs.readFileSync(f.file), originalBytes); assert.equal(fs.existsSync(f.temporary), true); }
      if (phase === 'openSync') { assert.deepEqual(r.createdPaths, []); assert.equal(fs.readFileSync(f.temporary, 'utf8'), 'collision'); }
      else assert.deepEqual(r.createdPaths, [tempName]);
      assert.deepEqual(r.updatedPaths, phase === 'post-rename-intent' ? ['wrangler.jsonc'] : []); checks++;
    }
  } else {
    const f = additiveFixture(); noChange(f, f.plan, 'unsupported-update-layout');
  }

  // Existing supported Resend managed/Vercel remains distinct from native acquisition.
  for (const environment of ['development', 'preview', 'production']) {
    const f = fixture('resend', 'vercel', environment, 'api-key-case-managed');
    assert.equal(f.apply(f.plan().fingerprint).status, 'created'); assert.equal(f.guide().selection, null); assert.equal(readNativeDestinationSelection(f.project, environment).projectId, 'prj_fixture'); checks++;
  }
  // Both Clerk profiles coexist; only the explicit ID family selects the matching profile.
  const both = fixture('clerk', 'vercel', 'preview');
  assert.equal(both.store.saveClerkManagedIntent({ service: 'clerk', environment: 'preview', route: 'api-key-case-managed', destination: { kind: 'cloudflare' }, sendingDomain: null }).ok, true);
  const cf = { service: 'clerk', environment: 'preview', accountId, worker: 'other-worker' };
  const vp = both.plan(), cp = planConnectionTarget(both.project, cf, both.home);
  assert.equal(vp.destination, 'vercel'); assert.equal(cp.destination, 'cloudflare'); assert.notEqual(vp.fingerprint, cp.fingerprint);
  assert.equal(both.apply(vp.fingerprint).status, 'created'); assert.equal(applyConnectionTarget(both.project, cf, cp.fingerprint, both.home).status, 'created'); checks++;
  for (const target of ['vercel', 'cloudflare']) {
    const f = fixture('resend', target), p = f.plan();
    for (const fp of [undefined, '', 'wrong', '0'.repeat(64), canary]) noChange(f, () => f.apply(fp), 'plan-mismatch');
    noChange(f, () => applyConnectionTarget(f.project, { ...f.input, environment: 'preview' }, p.fingerprint, f.home), 'selection-mismatch');
    noChange(f, () => applyConnectionTarget(f.project, { ...f.input, service: 'clerk' }, p.fingerprint, f.home), 'selection-missing');
    noChange(f, () => applyConnectionTarget(f.project, { ...f.input, ...(target === 'vercel' ? { projectId: 'prj_other' } : { worker: 'other-worker' }) }, p.fingerprint, f.home), 'plan-mismatch');
    for (const bad of [{ ...f.input, url: 'https://example.test' }, { ...f.input, arbitrary: {} }, { ...f.input, service: 'other' }, { ...f.input, environment: 'qa' },
      { ...f.input, ...(target === 'vercel' ? { orgId: '../escape' } : { worker: '../escape' }) },
      { ...f.input, ...(target === 'vercel' ? { orgId: 123 } : { accountId: 'bad' }) },
      { service: 'resend', environment: 'development', orgId: 'team', projectId: 'prj', accountId, worker: 'mixed' }]) noChange(f, () => planConnectionTarget(f.project, bad, f.home), 'invalid-input');
    const other = fixture('resend', target); noChange(other, () => other.apply(p.fingerprint), 'plan-mismatch');
    assert.equal(f.select({ sendingDomain: 'changed.example.test' }).ok, true); noChange(f, () => f.apply(p.fingerprint), 'plan-mismatch');
    for (const change of [{ route: 'manual' }, { destination: { kind: 'github' } }]) { f.select(change); noChange(f, f.plan, 'selection-mismatch'); }
  }
  for (const target of ['vercel', 'cloudflare']) for (const content of ['', '{', '[]', 'x'.repeat(65537),
    target === 'vercel' ? '{"orgId":"team_fixture","projectId":"conflicting"}' : JSON.stringify({ env: { development: { name: 'conflicting-worker', account_id: accountId } } }),
    target === 'vercel' ? '{"orgId":"team_fixture","projectId":"prj_fixture","orgId":"team_fixture"}' : `{"env":{"development":{"name":"fixture-worker","account_id":"${accountId}","account_id":"${accountId}"}}}`,
    target === 'vercel' ? '{"orgId":"team_fixture","projectId":"prj_fixture","unknown":{"x":1,"x":2}}' : `{"env":{"development":{"name":"fixture-worker","account_id":"${accountId}","unknown":{"x":1,"x":2}}}}`,
    target === 'vercel' ? JSON.stringify({ orgId: canary, projectId: 'prj_fixture' }) : JSON.stringify({ env: { development: { account_id: accountId, name: canary } } })]) {
    const f = fixture('resend', target), p = f.plan(); writeConfig(f, content); noChange(f, f.plan); noChange(f, () => f.apply(p.fingerprint));
  }
  for (const target of ['vercel', 'cloudflare']) for (const kind of ['symlink', 'hardlink', 'directory']) {
    const f = fixture('resend', target), p = f.plan(), file = writeConfig(f, p.proposedConfig), backing = join(f.dir, 'backing');
    if (kind === 'symlink') { fs.renameSync(file, backing); unsafeMetadataLink(backing, file); }
    else if (kind === 'hardlink') fs.linkSync(file, backing);
    else { fs.unlinkSync(file); fs.mkdirSync(file); }
    noChange(f, f.plan, 'unsafe-path'); noChange(f, () => f.apply(p.fingerprint), 'unsafe-path');
  }
  const mapped = fixture(); fs.mkdirSync(join(mapped.project, '.vercel')); fs.writeFileSync(join(mapped.project, '.vercel/repo.json'), canary);
  noChange(mapped, mapped.plan, 'unsupported-layout');
  const linked = fixture(), outside = join(linked.dir, 'outside'); fs.mkdirSync(outside); fs.symlinkSync(outside, join(linked.project, '.vercel'), process.platform==='win32'?'junction':'dir');
  noChange(linked, linked.plan, 'unsafe-path');
  const alias = fixture(), aliasPath = join(alias.dir, 'alias'); fs.symlinkSync(alias.project, aliasPath, process.platform==='win32'?'junction':'dir');
  noChange(alias, () => planConnectionTarget(aliasPath, alias.input, alias.home), 'unsafe-path');
  const duplicate = fixture('resend', 'cloudflare'), dp = duplicate.plan(); writeConfig(duplicate, dp.proposedConfig); fs.writeFileSync(join(duplicate.project, 'wrangler.toml'), '');
  noChange(duplicate, duplicate.plan, 'configuration-conflict');
  // Existing safe supported formats are no-write results; no format conversion or value output.
  for (const environment of ['development', 'preview', 'production']) for (const ext of ['toml', 'json', 'jsonc']) {
    const f = fixture('clerk', 'cloudflare', environment), p = f.plan();
    fs.writeFileSync(join(f.project, `wrangler.${ext}`), ext === 'toml' ? `${environment === 'production' ? '' : `[env.${environment}]\n`}name="fixture-worker"\naccount_id="${accountId}"\n` : p.proposedConfig);
    const before = snapshot(f.dir), noOp = f.plan(); assert.equal(noOp.status, 'unchanged'); assert.equal(noOp.existingPath, `wrangler.${ext}`); assert.equal(f.apply(noOp.fingerprint).status, 'unchanged'); assert.deepEqual(snapshot(f.dir), before); checks++;
  }
  // Matching general JSONC is still a read-only resolver result, never an edit.
  const matchingGeneral = fixture('resend', 'cloudflare'), general = {
    main: canary, compatibility_date: '2026-01-01', env: { development: { name: 'fixture-worker', account_id: accountId, vars: { untrusted: canary } } }
  };
  writeConfig(matchingGeneral, '// User config\n' + JSON.stringify(general));
  const generalBefore = snapshot(matchingGeneral.dir), generalPlan = matchingGeneral.plan(); closed(generalPlan);
  assert.equal(generalPlan.status, 'unchanged'); assert.equal(generalPlan.existingSelectors, null); assert.equal(matchingGeneral.apply(generalPlan.fingerprint).status, 'unchanged'); assert.deepEqual(snapshot(matchingGeneral.dir), generalBefore); checks++;
  const ignored = fixture(), ip = ignored.plan(); writeConfig(ignored, JSON.stringify({ ...JSON.parse(ip.proposedConfig), unknown: canary }));
  const ignoredPlan = ignored.plan(); closed(ignoredPlan); assert.equal(ignoredPlan.status, 'unchanged'); assert.equal(ignoredPlan.proposedConfig, null); checks++;
  const locked = fixture(), lock = join(locked.home, '.api-key-case/connections', createHash('sha256').update(canonicalProjectRealpath(locked.project)).digest('hex'), 'lock'); fs.mkdirSync(lock);
  noChange(locked, locked.plan, 'selection-unavailable');
  // Late intent and config changes during regeneration must precede writes.
  for (const mutation of ['intent', 'config']) {
    const f = fixture(), p = f.plan(), original = ConnectionStateStore.prototype.readIntent; let reads = 0;
    try {
      ConnectionStateStore.prototype.readIntent = function () { const r = original.call(this); if (++reads === 4) {
        if (mutation === 'intent') f.select({ sendingDomain: 'late.example.test' }); else writeConfig(f, '{"owner":"preserve"}');
      } return r; };
      const r = f.apply(p.fingerprint); closed(r); assert.equal(r.status, 'blocked'); assert.equal(r.localEffects, 'none');
      if (mutation === 'config') assert.equal(fs.readFileSync(join(f.project, '.vercel/project.json'), 'utf8'), '{"owner":"preserve"}');
      else assert.equal(fs.existsSync(join(f.project, '.vercel')), false); checks++;
    } finally { ConnectionStateStore.prototype.readIntent = original; }
  }
  // Collisions at exclusive creation preserve the other writer's bytes.
  const collision = fixture('resend', 'cloudflare'), collisionPlan = collision.plan();
  const collisionResult = patch('openSync', original => (path, flags, mode) => {
    if (path === join(collision.project, 'wrangler.jsonc') && (flags & fs.constants.O_CREAT)) fs.writeFileSync(path, 'owner-created');
    return original(path, flags, mode);
  }, () => collision.apply(collisionPlan.fingerprint));
  assert.equal(collisionResult.status, 'blocked'); assert.equal(fs.readFileSync(join(collision.project, 'wrangler.jsonc'), 'utf8'), 'owner-created'); checks++;
  // Interrupted writes and sync failure keep evidence and explicitly report effects.
  for (const phase of ['writeSync', 'fsyncSync']) {
    const f = fixture(), p = f.plan();
    const r = patch(phase, () => () => { throw Error(canary); }, () => f.apply(p.fingerprint)); closed(r);
    assert.equal(r.status, 'blocked'); assert.equal(r.localEffects, 'possible'); assert.deepEqual(r.createdPaths, ['.vercel/', '.vercel/project.json']);
    assert.equal(fs.existsSync(join(f.project, '.vercel/project.json')), true); checks++;
  }
  // Leaf and parent substitutions after open are detected before any content write.
  for (const kind of ['leaf', 'parent']) {
    const f = fixture(), p = f.plan(), original = ConnectionStateStore.prototype.readIntent; let changed = false, unavailable = false;
    try {
      ConnectionStateStore.prototype.readIntent = function () { const r = original.call(this), file = join(f.project, '.vercel/project.json');
        if (!changed && fs.existsSync(file)) { changed = true; if (kind === 'leaf') { fs.renameSync(file, join(f.dir, 'created-file')); fs.writeFileSync(file, 'owner-file'); }
          else {
            try { fs.renameSync(join(f.project, '.vercel'), join(f.dir, 'created-dir')); }
            catch(error) { if(process.platform==='win32' && ['EPERM','EACCES'].includes(error.code))unavailable=true; throw error; }
            fs.mkdirSync(join(f.project, '.vercel'));
          } }
        return r; };
      const r = f.apply(p.fingerprint); assert.equal(r.status, 'blocked'); assert.equal(r.localEffects, 'possible');
      if (kind === 'leaf') assert.equal(fs.readFileSync(join(f.project, '.vercel/project.json'), 'utf8'), 'owner-file');
      else if(unavailable) {
        assert.equal(fs.statSync(join(f.project,'.vercel/project.json')).size,0,'refused parent substitution still blocks content write');
        console.log('SKIP (unverified): parent substitution with open file: Windows refused fixture rename; blocked/no content write verified.');
      } else assert.deepEqual(fs.readdirSync(join(f.project, '.vercel')), []); checks++;
    } finally { ConnectionStateStore.prototype.readIntent = original; }
  }
  // Relevant Vercel config is syntax-checked without interpreting provider settings.
  for (const content of ['invalid', '[]', '{"x":1,"x":2}', '{"unknown":{"x":1,"x":2}}']) {
    const f = fixture(), p = f.plan(); fs.writeFileSync(join(f.project, 'vercel.json'), content);
    noChange(f, f.plan, 'configuration-conflict'); noChange(f, () => f.apply(p.fingerprint), 'configuration-conflict');
  }
  const extraConfig = fixture(); fs.writeFileSync(join(extraConfig.project, 'vercel.json'), JSON.stringify({ unknown: canary }));
  const extraBefore = fs.readFileSync(join(extraConfig.project, 'vercel.json'), 'utf8');
  const extraPlan = extraConfig.plan(); closed(extraPlan); assert.equal(extraConfig.apply(extraPlan.fingerprint).status, 'created');
  assert.equal(fs.readFileSync(join(extraConfig.project, 'vercel.json'), 'utf8'), extraBefore); checks++;
  for (const suffix of ['\nforged-plan', '\u001b[31m', '\u202epath']) {
    const f = fixture(), moved = f.project + suffix;
    // Windows cannot create control-character filenames; still reject the raw
    // caller path without echoing it or mutating the existing project.
    if(process.platform!=='win32' || !/[\u0000-\u001f]/.test(suffix))fs.renameSync(f.project, moved);
    const before = snapshot(f.dir), r = planConnectionTarget(moved, f.input, f.home); assert.equal(r.reason, 'unsafe-path');
    assert.equal(renderConnectionTarget(r).includes(suffix), false); assert.deepEqual(snapshot(f.dir), before); checks++;
  }
  // A same-content replacement still invalidates a previously matching file plan.
  const replacement = fixture(); replacement.apply(replacement.plan().fingerprint);
  const rp = replacement.plan(), configPath = join(replacement.project, '.vercel/project.json'), configBytes = fs.readFileSync(configPath);
  fs.renameSync(configPath, join(replacement.dir, 'previous')); fs.writeFileSync(configPath, configBytes);
  const rr = noChange(replacement, () => replacement.apply(rp.fingerprint), 'plan-mismatch'); assert.equal(rr.localConfiguration, 'matching');
  // Plan and matching apply never attempt any filesystem mutation, even temporarily.
  const readOnly = fixture(), mutate = ['mkdirSync','writeSync','writeFileSync','appendFileSync','renameSync','unlinkSync','rmdirSync','rmSync','chmodSync','fchmodSync','truncateSync','ftruncateSync','symlinkSync','linkSync','fsyncSync'];
  const denyWrites = run => {
    const saved = Object.fromEntries([...mutate, 'openSync'].map(name => [name, fs[name]])); let writes = 0;
    for (const name of mutate) fs[name] = () => { writes++; throw Error('no writes'); };
    fs.openSync = (path, flags, ...rest) => { if (typeof flags === 'string' ? flags !== 'r' : flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)) { writes++; throw Error('no write opens'); } return saved.openSync(path, flags, ...rest); };
    syncBuiltinESMExports(); try { const result = run(); assert.equal(writes, 0); return result; } finally { Object.assign(fs, saved); syncBuiltinESMExports(); }
  };
  const readOnlyPlan = denyWrites(readOnly.plan); assert.equal(readOnlyPlan.status, 'planned');
  const readOnlyApplied = readOnly.apply(readOnlyPlan.fingerprint); assert.equal(readOnlyApplied.status, 'created');
  assert.equal(denyWrites(() => readOnly.apply(readOnlyApplied.fingerprint)).status, 'unchanged'); checks++;
  if (process.platform === 'linux') {
    const f = additiveFixture(), p = denyWrites(f.plan); assert.equal(p.status, 'planned');
    const r = f.apply(p.fingerprint); assert.equal(r.status, 'updated');
    assert.equal(denyWrites(() => f.apply(r.fingerprint)).status, 'unchanged'); checks++;
  }
  // Preparing the local selector must not resolve the broader generic plan contract.
  const generic = fixture(); generic.apply(generic.plan().fingerprint);
  const genericPlan = await buildConnectionPlan(generic.project, 'development', { connectionBaseDir: generic.home, vault: new Proxy({}, { get() { throw Error('no vault'); } }) });
  assert.equal(genericPlan.status, 'unknown'); assert.equal(genericPlan.reason, 'source-unresolved'); assert.equal(genericPlan.execution, 'unsupported'); assert.equal(genericPlan.permission, 'none'); checks++;
  // CLI end-to-end is denied all provider/credential operations, including storage probes.
  const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url)), preload = join(root, 'deny-effects.mjs'), marker = join(root, 'forbidden');
  fs.writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import http from 'node:http';import https from 'node:https';import net from 'node:net';import tls from 'node:tls';import {syncBuiltinESMExports} from 'node:module';import {KeyringVault} from ${JSON.stringify(new URL('../dist/core/vault/keyring.js', import.meta.url).href)};import {ConnectionStateStore} from ${JSON.stringify(new URL('../dist/core/agent/connection-state.js', import.meta.url).href)};
const deny=()=>{fs.writeFileSync(${JSON.stringify(marker)},'effect');throw Error(${JSON.stringify(canary)})};for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=deny;for(const m of [http,https])for(const n of ['request','get'])m[n]=deny;net.connect=net.createConnection=tls.connect=global.fetch=deny;
for(const name of Object.getOwnPropertyNames(KeyringVault.prototype))if(name!=='constructor'&&typeof KeyringVault.prototype[name]==='function')KeyringVault.prototype[name]=deny;
for(const name of ['saveIntent','saveClerkNativeIntent','saveClerkManagedIntent','recordObservation','credentialRevision'])ConnectionStateStore.prototype[name]=deny;syncBuiltinESMExports();`);
  for (const target of ['vercel', 'cloudflare']) {
    const f = fixture('clerk', target, 'preview'), ids = target === 'vercel' ? ['--org-id', 'team_fixture', '--project-id', 'prj_fixture'] : ['--account-id', accountId, '--worker', 'fixture-worker'];
    const common = ['--service', 'clerk', '--env', 'preview', ...ids, '--json'];
    const run = args => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'connection', 'target', ...args, f.project], { env: { ...process.env, HOME: f.home, USERPROFILE: f.home, DO_NOT_TRACK: '1', NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 15000 });
    const before = snapshot(f.dir), planned = run(['plan', ...common]); assert.equal(planned.status, 0, planned.stderr); const p = JSON.parse(planned.stdout); closed(p); assert.deepEqual(snapshot(f.dir), before);
    const r = run(['apply', ...common, '--fingerprint', p.fingerprint]); assert.equal(r.status, 0, r.stderr); closed(JSON.parse(r.stdout)); const after = snapshot(f.dir);
    assert.equal(run(['apply', ...common, '--fingerprint', JSON.parse(r.stdout).fingerprint]).status, 0); assert.deepEqual(snapshot(f.dir), after);
    for (const extra of [['--force'], ['--url', 'https://example.test'], ['--path', 'elsewhere'], ['--json'], ['--org-id', 'duplicate'], ['--login'], ['--plugin', 'x'], ['--shell', 'sh'], ['--env', 'production'], ['--fingerprint', p.fingerprint]]) {
      const invalid = run(['plan', ...common, ...extra]); assert.equal(invalid.status, 1); assert.ok(!(invalid.stdout + invalid.stderr).includes(canary)); assert.deepEqual(snapshot(f.dir), after); checks++;
    }
    for (const args of [[], ['apply', ...common], ['plan', '--service', 'clerk', '--env', 'preview'], ['plan', ...common, '--account-id', accountId, '--worker', 'mixed']]) { assert.equal(run(args).status, 1); assert.deepEqual(snapshot(f.dir), after); checks++; }
    checks++;
  }
  if (process.platform === 'linux') for (const service of ['resend', 'clerk']) for (const first of ['development', 'preview']) {
    const next = first === 'development' ? 'preview' : 'development', f = fixture(service, 'cloudflare', first);
    const run = args => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'connection', ...args, f.project], {
      env: { ...process.env, HOME: f.home, USERPROFILE: f.home, DO_NOT_TRACK: '1', NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 15000
    });
    const targetArgs = environment => ['--service', service, '--env', environment, '--account-id', accountId, '--worker', `${service}-${environment}`, '--json'];
    const guide = environment => {
      const r = run(['cloudflare', 'guide', '--service', service, '--env', environment, '--json']);
      assert.ok(!(r.stdout + r.stderr).includes(canary)); return JSON.parse(r.stdout);
    };
    const firstPlan = JSON.parse(run(['target', 'plan', ...targetArgs(first)]).stdout);
    const created = run(['target', 'apply', ...targetArgs(first), '--fingerprint', firstPlan.fingerprint]);
    assert.equal(created.status, 0, created.stderr); assert.equal(JSON.parse(created.stdout).status, 'created');
    assert.equal(guide(first).selection.worker, `${service}-${first}`);
    assert.equal(f.select({ environment: next }).ok, true);
    assert.equal(guide(next).selection, null);
    const before = snapshot(f.dir), planned = run(['target', 'plan', ...targetArgs(next)]);
    assert.equal(planned.status, 0, planned.stderr); const p = JSON.parse(planned.stdout); closed(p);
    assert.equal(p.localConfiguration, 'missing-environment'); assert.deepEqual(snapshot(f.dir), before);
    const applied = run(['target', 'apply', ...targetArgs(next), '--fingerprint', p.fingerprint]);
    assert.equal(applied.status, 0, applied.stderr); const r = JSON.parse(applied.stdout); closed(r); assert.equal(r.status, 'updated');
    assert.equal(guide(next).selection.worker, `${service}-${next}`); assert.equal(guide(next).selection.accountId, accountId);
    const after = snapshot(f.dir), matched = run(['target', 'apply', ...targetArgs(next), '--fingerprint', r.fingerprint]);
    assert.equal(matched.status, 0); assert.equal(JSON.parse(matched.stdout).status, 'unchanged'); assert.deepEqual(snapshot(f.dir), after);
    const stale = run(['target', 'apply', ...targetArgs(next), '--fingerprint', p.fingerprint]); assert.equal(stale.status, 1); assert.equal(JSON.parse(stale.stdout).localConfiguration, 'matching');
    assert.equal(f.select({ environment: first }).ok, true);
    assert.equal(guide(first).selection.worker, `${service}-${first}`); checks++;
  }

  assert.equal(fs.existsSync(marker), false); checks++;
  console.log(`Connection target: ${checks} checks passed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
