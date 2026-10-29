import assert from 'node:assert/strict';
import {unsafeMetadataLink} from './helpers/metadata-link-fixture.mjs';
import {canonicalProjectRealpath} from '../dist/core/vault/naming.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { readCloudflareAcquisitionGuide, renderCloudflareAcquisitionGuide } from '../dist/core/agent/cloudflare-acquisition.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'akc-cloudflare-guide-')));
const canary = 'synthetic-private-provider-data', account = '0123456789abcdef0123456789abcdef';
let checks = 0, serial = 0;
const snapshot = dir => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(row => {
  const path = join(dir, row.name);
  return row.isDirectory() ? Object.entries(snapshot(path)) : row.isFile() ? [[path, readFileSync(path).toString('base64')]] : [];
}));
function fixture(service = 'resend', environment = 'development', extension = 'toml') {
  const dir = join(root, String(serial++)), project = join(dir, 'project'), home = join(dir, 'home');
  for (const p of [dir, project, home]) mkdirSync(p, { mode: 0o700 });
  const config = join(project, `wrangler.${extension}`), selected = { name: 'fixture-worker', account_id: account };
  const data = environment === 'production' ? selected : { env: { [environment]: selected } };
  writeFileSync(config, extension === 'toml' ? `${environment === 'production' ? '' : `[env.${environment}]\n`}name="fixture-worker"\naccount_id="${account}"\n` : JSON.stringify(data));
  const store = new ConnectionStateStore(project, home);
  const select = (extra = {}) => (service === 'clerk' ? store.saveClerkManagedIntent.bind(store) : store.saveIntent.bind(store))({
    service, environment, route: 'api-key-case-managed', destination: { kind: 'cloudflare' }, sendingDomain: null, ...extra
  });
  assert.equal(select().ok, true);
  const guide = () => readCloudflareAcquisitionGuide(project, service, environment, home);
  return { dir, project, home, config, store, guide, select, service, environment };
}
function closed(g) {
  assert.equal(g.authentication, 'not-inspected'); assert.equal(g.remoteConfiguration, 'not-inspected');
  assert.equal(g.credentialPresence, 'not-inspected'); assert.equal(g.credentialValidity, 'not-checked');
  assert.equal(g.application, 'not-checked'); assert.equal(g.permission, 'none'); assert.equal(g.executed, false);
  assert.equal(g.nativeAcquisition, 'not-supported-by-this-guide');
  assert.ok(!(JSON.stringify(g) + renderCloudflareAcquisitionGuide(g)).includes(canary));
}
try {
  for (const service of ['resend', 'clerk']) for (const environment of ['development', 'preview', 'production']) for (const ext of ['toml', 'json', 'jsonc']) {
    const f = fixture(service, environment, ext), before = snapshot(f.dir), g = f.guide();
    closed(g); assert.equal(g.state, 'selection-confirmed'); assert.equal(g.configuration, 'explicit-local');
    assert.equal(g.selection.accountId, account); assert.equal(g.selection.worker, 'fixture-worker');
    assert.equal(g.environment, environment); assert.equal(g.guideUrl, 'https://developers.cloudflare.com/workers/configuration/secrets/');
    assert.deepEqual(g.requiredSettings, [service === 'clerk' ? 'CLERK_SECRET_KEY' : 'RESEND_API_KEY']);
    assert.deepEqual(f.guide(), g); assert.deepEqual(snapshot(f.dir), before); checks++;
  }
  const f = fixture();
  for (const extra of [{ route: 'provider-native' }, { destination: { kind: 'vercel' } }, { environment: 'production' }]) {
    assert.equal(f.select(extra).ok, true); const g = f.guide(); closed(g); assert.equal(g.state, 'unsupported'); assert.equal(g.selection, null); checks++;
  }
  f.select();
  for (const bytes of ['', 'invalid = [', 'name="worker"\naccount_id="'+account+'"', '[env.development]\nname="'+canary+'!"\naccount_id="'+account+'"', '[env.development]\nname="worker"\naccount_id="bad"', 'x'.repeat(65537)]) {
    writeFileSync(f.config, bytes); const g = f.guide(); closed(g); assert.equal(g.selection, null); assert.equal(g.reason, 'configuration-unresolved'); checks++;
  }
  const duplicate = fixture(); writeFileSync(join(duplicate.project, 'wrangler.json'), '{}'); assert.equal(duplicate.guide().selection, null); checks++;
  const ignored = fixture('resend', 'development', 'json');
  writeFileSync(ignored.config, JSON.stringify({ env: { development: { name: 'fixture-worker', account_id: account, vars: { untrusted: canary } } }, unknown: canary }));
  closed(ignored.guide()); assert.equal(ignored.guide().state, 'selection-confirmed'); checks++;
  const absent = fixture(); rmSync(absent.config); assert.equal(absent.guide().reason, 'configuration-unresolved'); checks++;
  const jsonDuplicate = fixture('resend', 'development', 'json');
  writeFileSync(jsonDuplicate.config, `{"env":{"development":{"name":"fixture-worker","account_id":"${account}","account_id":"${account}"}}}`);
  assert.equal(jsonDuplicate.guide().selection, null); checks++;
  const symlink = fixture(), backing = join(symlink.dir, 'backing'); writeFileSync(backing, readFileSync(symlink.config));
  rmSync(symlink.config); unsafeMetadataLink(backing, symlink.config); assert.equal(symlink.guide().selection, null); checks++;
  const hardlink = fixture(); linkSync(hardlink.config, join(hardlink.dir, 'hardlink')); assert.equal(hardlink.guide().selection, null); checks++;
  const locked = fixture(), hash = createHash('sha256').update(canonicalProjectRealpath(locked.project)).digest('hex');
  mkdirSync(join(locked.home, '.api-key-case', 'connections', hash, 'lock')); assert.equal(locked.guide().selection, null); checks++;
  const race = fixture(), original = ConnectionStateStore.prototype.readIntent;
  let reads = 0;
  try {
    ConnectionStateStore.prototype.readIntent = function () { const value = original.call(this); if (++reads === 2) writeFileSync(race.config, `[env.development]\nname="changed"\naccount_id="${account}"\n`); return value; };
    assert.equal(race.guide().reason, 'selection-changed'); checks++;
  } finally { ConnectionStateStore.prototype.readIntent = original; }
  for (const args of [['other', 'development'], ['resend', 'invalid']]) { const g = readCloudflareAcquisitionGuide(f.project, ...args, f.home); closed(g); assert.equal(g.state, 'unsupported'); checks++; }
  const missing = readCloudflareAcquisitionGuide(f.project, 'clerk', 'development', f.home); assert.equal(missing.reason, 'selection-missing'); checks++;
  const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url)), c = fixture('clerk', 'preview');
  const preload = join(root, 'deny-effects.cjs'), marker = join(root, 'forbidden-effect');
  writeFileSync(preload, `const fs=require('node:fs');const deny=()=>{fs.writeFileSync(${JSON.stringify(marker)},'effect');throw Error(${JSON.stringify(canary)})};
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[n]=deny;
for(const m of ['node:http','node:https'])for(const n of ['request','get'])require(m)[n]=deny;
for(const n of ['connect','createConnection'])require('node:net')[n]=deny;require('node:tls').connect=deny;global.fetch=deny;require('node:module').syncBuiltinESMExports();`);
  const run = args => spawnSync(process.execPath, ['--require', preload, cli, 'connection', 'cloudflare', ...args, c.project], {
    env: { ...process.env, HOME: c.home, USERPROFILE: c.home, DO_NOT_TRACK: '1' }, encoding: 'utf8', timeout: 15000
  });
  const before = snapshot(c.dir);
  for (const json of [[], ['--json'], ['--json']]) { const r = run(['guide', '--service', 'clerk', '--env', 'preview', ...json]); assert.equal(r.status, 0, r.stderr); if (json.length) closed(JSON.parse(r.stdout)); assert.deepEqual(snapshot(c.dir), before); checks++; }
  for (const extra of [['--url', 'https://example.test'], ['--open'], ['--login'], ['--record'], ['--force'], ['--json', '--json'], ['--env', 'production'], ['--service', 'resend']]) {
    const r = run(['guide', '--service', 'clerk', '--env', 'preview', ...extra]); assert.equal(r.status, 1); assert.ok(!(r.stdout + r.stderr).includes(canary)); checks++;
  }
  for (const args of [[], ['inspect'], ['guide'], ['guide', '--service', 'resend', '--env', 'preview']]) { assert.equal(run(args).status, 1); checks++; }
  assert.equal(existsSync(marker), false); assert.deepEqual(snapshot(c.dir), before); checks++;
  console.log(`Cloudflare acquisition: ${checks} checks passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
