import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { connectionCredentialRef, clerkCredentialRef } from '../dist/core/agent/connection-credential.js';
import { canonicalProjectRealpath, toAccount, VAULT_SERVICE } from '../dist/core/vault/naming.js';

const canary = 'synthetic-resume-cli-private-QZ73';
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'akc-resume-cli-')));
const project = join(root, 'project'), home = join(root, 'home');
const accountId = 'a'.repeat(32);
let checks = 0;

// Compare persistent files, modes and link targets, but not read access times.
function snapshot(path) {
  if (!fs.existsSync(path)) return null;
  return JSON.stringify(fs.readdirSync(path).sort().map(name => {
    const file = join(path, name), state = fs.lstatSync(file);
    return [name, state.mode, state.isSymbolicLink() ? fs.readlinkSync(file) :
      state.isDirectory() ? snapshot(file) : createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  }));
}

try {
  fs.mkdirSync(project); fs.mkdirSync(home);
  fs.writeFileSync(join(project, 'package.json'), '{"name":"resume-fixture","private":true}');
  fs.writeFileSync(join(project, 'wrangler.jsonc'), JSON.stringify({ env: {
    development: { name: 'resume-development', account_id: accountId },
    preview: { name: 'resume-preview', account_id: accountId }
  } }));
  fs.mkdirSync(join(project, '.vercel'));
  fs.writeFileSync(join(project, '.vercel', 'project.json'), JSON.stringify({ orgId: 'team_resume', projectId: 'prj_resume' }));
  const localConfiguration = snapshot(project);
  const store = new ConnectionStateStore(project, home);
  const refs = [connectionCredentialRef(project, 'development'), clerkCredentialRef(project, 'development')];
  const accounts = refs.map(toAccount);
  const metadata = join(home, '.api-key-case', 'connections', createHash('sha256').update(canonicalProjectRealpath(project)).digest('hex'));
  const credentialBytes = new Map(), revisions = new Map();

  // Run the real compiled CLI in a disposable package; replace only native keyring.
  const checkout = join(root, 'cli-fixture'), modules = join(checkout, 'node_modules');
  fs.mkdirSync(modules, { recursive: true }); fs.writeFileSync(join(checkout, 'package.json'), '{"type":"module"}');
  fs.cpSync(fileURLToPath(new URL('../dist', import.meta.url)), join(checkout, 'dist'), { recursive: true });
  const sourceModules = fs.realpathSync(fileURLToPath(new URL('../node_modules', import.meta.url)));
  for (const name of fs.readdirSync(sourceModules)) if (name !== '@napi-rs' && !name.startsWith('.'))
    fs.symlinkSync(join(sourceModules, name), join(modules, name), process.platform === 'win32' ? 'junction' : 'dir');
  const mock = join(modules, '@napi-rs', 'keyring'); fs.mkdirSync(mock, { recursive: true });
  fs.writeFileSync(join(mock, 'package.json'), '{"name":"@napi-rs/keyring","main":"index.cjs"}');
  fs.writeFileSync(join(mock, 'index.cjs'), `const expected=new Set(${JSON.stringify(accounts)});exports.Entry=class {
    constructor(service,account){if(service!==${JSON.stringify(VAULT_SERVICE)}||!expected.has(account)){globalThis.resumeEffects.unexpectedVault++;throw Error(${JSON.stringify(canary)})}this.account=account;}
    getPassword(){if(!new Error().stack.includes('KeyringVault.hasSecret')){globalThis.resumeEffects.valueReads++;throw Error(${JSON.stringify(canary)})}globalThis.resumeEffects.presence.push(this.account);return ${JSON.stringify(canary)};}
    setPassword(){globalThis.resumeEffects.vaultWrites++;throw Error(${JSON.stringify(canary)});}
    deleteCredential(){globalThis.resumeEffects.vaultWrites++;throw Error(${JSON.stringify(canary)});}
  };`);
  const preload = join(root, 'resume-guards.cjs'), effectsFile = join(root, 'effects.json');
  fs.writeFileSync(preload, `const fs=require('node:fs'),fsp=require('node:fs/promises'),cp=require('node:child_process'),net=require('node:net'),http=require('node:http'),https=require('node:https'),tls=require('node:tls'),dns=require('node:dns'),dgram=require('node:dgram');
    const save=fs.writeFileSync,open=fs.openSync,openAsync=fs.open,promiseOpen=fsp.open;
    const effects=globalThis.resumeEffects={writes:0,children:0,network:0,human:0,native:0,unexpectedVault:0,vaultWrites:0,valueReads:0,presence:[]};
    const deny=name=>()=>{effects[name]++;throw Error(${JSON.stringify(canary)});};
    if(process.env.AKC_TEST_READ_ONLY==='1'){
      for(const name of ['writeFile','write','appendFile','mkdir','rename','unlink','rm','rmdir','chmod','fchmod','chown','truncate','ftruncate','copyFile','cp','link','symlink','utimes']){
        if(fs[name])fs[name]=deny('writes');if(fs[name+'Sync'])fs[name+'Sync']=deny('writes');if(fsp[name])fsp[name]=deny('writes');}
      fs.createWriteStream=deny('writes');
      const writable=flags=>typeof flags==='string'?/[wax+]/.test(flags):Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND));
      fs.openSync=function(path,flags,...args){if(writable(flags))return deny('writes')();return open.call(this,path,flags,...args)};
      fs.open=function(path,flags,...args){if(writable(flags))return deny('writes')();return openAsync.call(this,path,flags,...args)};
      fsp.open=async function(path,flags,...args){if(writable(flags))return deny('writes')();return promiseOpen.call(this,path,flags,...args)};
    }
    for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=deny('children');
    net.Socket.prototype.connect=net.connect=net.createConnection=tls.connect=deny('network');
    http.get=http.request=https.get=https.request=globalThis.fetch=dgram.createSocket=deny('network');
    for(const name of ['lookup','resolve','resolve4','resolve6'])dns[name]=deny('network');
    require('node:readline').createInterface=deny('human');require('node:readline/promises').createInterface=deny('human');
    process.dlopen=deny('native');require('node:module').syncBuiltinESMExports();
    process.on('exit',()=>save(${JSON.stringify(effectsFile)},JSON.stringify(effects)));`);

  const run = (args, { exit = 0, mutation = false, unchanged = !mutation, presence = [] } = {}) => {
    const before = snapshot(home);
    const result = spawnSync(process.execPath, ['--require', preload, join(checkout, 'dist', 'cli', 'index.js'), ...args], {
      cwd: project, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      env: { HOME: home, USERPROFILE: home, DO_NOT_TRACK: '1', PATH: '', AKC_TEST_READ_ONLY: mutation ? '0' : '1',
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}) }
    });
    assert.equal(result.error, undefined); assert.equal(result.status, exit, result.stderr || result.stdout);
    assert.ok(!(result.stdout + result.stderr).includes(canary), 'no key bytes, invalid input or raw error canaries');
    const effects = JSON.parse(fs.readFileSync(effectsFile));
    for (const key of ['writes', 'children', 'network', 'human', 'native', 'unexpectedVault', 'vaultWrites', 'valueReads'])
      assert.equal(effects[key], 0, `${args.join(' ')}: forbidden ${key}`);
    assert.deepEqual([...new Set(effects.presence)].sort(), [...presence].sort(), 'only explicitly expected exact slots are read for presence');
    if (unchanged) assert.equal(snapshot(home), before, 'read/unchanged/stale flows preserve every data byte and remove only their own temporary lock');
    assert.equal(snapshot(project), localConfiguration, 'selection memory never restores or edits local provider selectors/app files');
    for (const [name, bytes] of credentialBytes) assert.equal(fs.readFileSync(join(metadata, name), 'utf8'), bytes, 'credential registration metadata never changes');
    for (const ref of refs) if (revisions.has(ref.service)) assert.equal(store.credentialRevision(ref), revisions.get(ref.service));
    checks++; return result;
  };
  const resumeArgs = (service = 'resend', environment = 'development', route = 'api-key-case-managed') => ['--service', service, '--env', environment, '--route', route];
  const resume = (operation, args, options) => run(['connection', 'resume', operation, ...args], options);
  const register = service => {
    const ref = refs.find(ref => ref.service === service), mutation = store.beginCredentialMutation(ref);
    assert.equal(mutation.ok, true); assert.equal(store.finishCredentialMutation(ref, mutation.value, true), true);
    revisions.set(service, mutation.value);
    const name = `credential-${service === 'clerk' ? 'clerk-' : ''}development.json`;
    credentialBytes.set(name, fs.readFileSync(join(metadata, name), 'utf8'));
  };

  const missing = JSON.parse(resume('plan', [...resumeArgs(), '--json', project], { exit: 1 }).stdout);
  assert.equal(missing.issue, 'not-recorded'); assert.equal(fs.existsSync(join(home, '.api-key-case')), false);
  const noRoute = (environment = 'development') => ['--service', 'resend', '--env', environment];
  const undiscovered = JSON.parse(resume('plan', [...noRoute(), '--json', project], { exit: 1 }).stdout);
  assert.equal(undiscovered.issue, 'not-recorded'); assert.equal(undiscovered.route, null); assert.equal(undiscovered.profile, 'resend');
  const base = resumeArgs();
  for (const args of [
    [], ['restore', ...base], ['plan'], ['plan', '--env', 'development', '--route', 'provider-native'],
    ['plan', '--service', 'resend', '--route', 'provider-native'], ['plan', '--service', 'clerk', '--env', 'development'],
    ['apply', '--service', 'resend', '--env', 'development', '--fingerprint', 'a'.repeat(64)],
    ['plan', ...base, '--service', 'clerk'], ['plan', ...base, '--env', 'preview'], ['plan', ...base, '--route', 'manual'],
    ['plan', ...base, '--json', '--json'], ['plan', ...base, project, project], ['plan', ...base, '--destination', 'vercel'],
    ['plan', ...base, '--sending-domain', 'override.example.com'], ['plan', ...base, '--force'], ['plan', ...base, '--scope', 'user'],
    ['plan', ...base, '--fingerprint', 'a'.repeat(64)], ['apply', ...base],
    ['apply', ...base, '--fingerprint', 'A'.repeat(64)], ['apply', ...base, '--fingerprint', 'a'.repeat(63)],
    ['apply', ...base, '--fingerprint', 'a'.repeat(65)], ['apply', ...base, '--fingerprint', 'g'.repeat(64)],
    ['apply', ...base, '--fingerprint', 'a'.repeat(64), '--fingerprint', 'a'.repeat(64)],
    ['plan', ...resumeArgs('clerk', 'development', 'manual')], ['plan', ...resumeArgs('resend', 'staging')],
    ['plan', ...resumeArgs('other')], ['plan', ...resumeArgs('resend', 'development', 'unknown')],
    ['plan', ...base, '--value', canary], ['plan', ...base, '']
  ]) {
    const invalid = run(['connection', 'resume', ...args], { exit: 1 }); assert.match(invalid.stderr, /^Usage:/);
  }
  const badPath = resume('plan', [...base, '--json', join(root, canary)], { exit: 1 });
  assert.match(badPath.stderr, /metadata is unavailable/); assert.ok(!badPath.stderr.includes(root));

  // Each selection, plan, apply and continuation runs in a NEW CLI process.
  for (const service of ['resend', 'clerk']) {
    const select = environment => run(['connection', 'set', ...resumeArgs(service, environment), '--destination', 'cloudflare',
      ...(service === 'resend' ? ['--sending-domain', `${environment}.example.com`] : []), project], { mutation: true });
    select('development'); register(service);
    const read = () => service === 'resend' ? store.readIntent() : store.readClerkManagedIntent();
    const original = read().value;
    select('preview'); const beforeRevision = read().value.updatedAt;
    const args = resumeArgs(service);
    const planned = JSON.parse(resume('plan', [...(service === 'resend' ? noRoute() : args), '--json', project]).stdout);
    assert.equal(planned.status, 'ready'); assert.equal(planned.source, 'last-recorded');
    assert.equal(planned.current.environment, 'preview'); assert.equal(planned.remembered.environment, 'development');
    assert.equal(planned.route, 'api-key-case-managed');
    assert.equal(planned.remembered.sendingDomain, service === 'resend' ? 'development.example.com' : null);
    assert.equal(planned.permission, 'none'); assert.equal(planned.providerOperation, false);
    const text = resume('plan', [...args, project]).stdout;
    for (const value of [planned.projectId, 'preview', 'development', 'cloudflare', planned.recordedAt, planned.fingerprint]) assert.ok(text.includes(value));
    if (service === 'resend') assert.ok(text.includes('development.example.com') && text.includes('preview.example.com'));
    const applied = JSON.parse(resume('apply', [...args, '--fingerprint', planned.fingerprint, '--json', project], { mutation: true }).stdout);
    assert.equal(applied.status, 'applied'); assert.equal(read().value.environment, 'development');
    assert.ok(read().value.updatedAt > beforeRevision && read().value.updatedAt > original.updatedAt);
    const stale = JSON.parse(resume('apply', [...args, '--fingerprint', planned.fingerprint, '--json', project], { exit: 1, mutation: true, unchanged: true }).stdout);
    assert.equal(stale.issue, 'stale-plan');
    const unchanged = JSON.parse(resume('plan', [...args, '--json', project]).stdout), unchangedRevision = read().value.updatedAt;
    assert.equal(unchanged.status, 'unchanged'); assert.equal(unchanged.source, 'current');
    if (service === 'resend') {
      assert.deepEqual(JSON.parse(resume('plan', [...noRoute(), '--json', project]).stdout), unchanged, 'discovered current route is exactly the explicit reviewed plan');
      const wrong = JSON.parse(resume('plan', [...resumeArgs('resend', 'development', 'manual'), '--json', project], { exit: 1 }).stdout);
      assert.equal(wrong.issue, 'route-mismatch');
    }
    assert.equal(JSON.parse(resume('apply', [...args, '--fingerprint', unchanged.fingerprint, '--json', project], { mutation: true, unchanged: true }).stdout).status, 'unchanged');
    assert.equal(read().value.updatedAt, unchangedRevision);

    const expectedPresence = accounts.slice(0, service === 'resend' ? 1 : 2);
    const next = JSON.parse(run(['next', '--json', '--offline', project], { presence: expectedPresence }).stdout);
    assert.equal(next.inspection.mode, 'offline'); assert.equal(next.vault.status, 'not-inspected'); assert.deepEqual(next.targets, []);
    assert.equal(next.connection.report.environment, 'development'); assert.equal(next.connection.report.credential.status, 'registered');
    if (service === 'clerk') {
      assert.equal(next.clerkManaged.environment, 'development'); assert.deepEqual(next.clerkManaged.registration, { presence: 'registered', revision: 'recorded' });
      assert.equal(next.clerkManaged.permission, 'none');
    }
    assert.ok(!next.nextActions.some(action => action.actor === 'human' && /register|secret/.test(action.kind)), 'existing exact registration does not ask for another key');
    const guide = JSON.parse(run(['connection', 'cloudflare', 'guide', '--service', service, '--env', 'development', '--json', project]).stdout);
    assert.equal(guide.state, 'selection-confirmed'); assert.equal(guide.selection.worker, 'resume-development');
    assert.equal(guide.credentialPresence, 'not-inspected'); assert.equal(guide.permission, 'none'); assert.equal(guide.executed, false);
    const checked = JSON.parse(run(['connection', 'credential', 'check', '--service', service, '--env', 'development', '--json', project], { presence: [toAccount(refs.find(ref => ref.service === service))] }).stdout);
    assert.deepEqual(checked, { service, environment: 'development', status: 'registered' });
  }

  // Native Clerk is independent of managed Clerk and needs no duplicate vault entry.
  for (const environment of ['preview', 'production']) run(['connection', 'set', ...resumeArgs('clerk', environment, 'provider-native'), '--destination', 'vercel', project], { mutation: true });
  const nativeArgs = resumeArgs('clerk', 'preview', 'provider-native');
  const nativePlan = JSON.parse(resume('plan', [...nativeArgs, '--json', project]).stdout);
  assert.equal(nativePlan.profile, 'clerk-native'); assert.equal(nativePlan.status, 'ready');
  assert.equal(JSON.parse(resume('apply', [...nativeArgs, '--fingerprint', nativePlan.fingerprint, '--json', project], { mutation: true }).stdout).status, 'applied');
  assert.equal(store.readClerkNativeIntent().value.environment, 'preview'); assert.equal(store.readClerkManagedIntent().value.environment, 'development');
  const nativeNext = JSON.parse(run(['next', '--json', '--offline', project], { presence: accounts }).stdout);
  assert.equal(nativeNext.clerkNative.environment, 'preview'); assert.equal(nativeNext.clerkManaged.environment, 'development');
  const nativeGuide = JSON.parse(run(['connection', 'native', 'guide', '--service', 'clerk', '--env', 'preview', '--json', project]).stdout);
  assert.equal(nativeGuide.environment, 'preview'); assert.equal(nativeGuide.permission, 'none');
  assert.equal(store.credentialRevision(refs[1]), revisions.get('clerk'));

  // Discovery reads recorded conditions, including manual, without guessing from old managed history.
  run(['connection', 'set', ...resumeArgs('resend', 'development', 'manual'), '--destination', 'manual', project], { mutation: true });
  const manualCurrent = JSON.parse(resume('plan', [...noRoute(), '--json', project]).stdout);
  assert.equal(manualCurrent.route, 'manual'); assert.equal(manualCurrent.source, 'current');
  assert.equal(JSON.parse(resume('plan', [...resumeArgs(), '--json', project], { exit: 1 }).stdout).issue, 'route-mismatch', 'current same-environment route wins over matching older history');
  run(['connection', 'set', ...resumeArgs('resend', 'preview', 'manual'), '--destination', 'manual', project], { mutation: true });
  const manualHistory = JSON.parse(resume('plan', [...noRoute(), '--json', project]).stdout);
  assert.equal(manualHistory.route, 'manual'); assert.equal(manualHistory.source, 'last-recorded');
  // An independent profile's history change also invalidates the reviewed full-history token.
  run(['connection', 'set', ...resumeArgs('clerk', 'production', 'provider-native'), '--destination', 'vercel', project], { mutation: true });
  const manualArgs = resumeArgs('resend', 'development', manualHistory.route);
  assert.equal(JSON.parse(resume('apply', [...manualArgs, '--fingerprint', manualHistory.fingerprint, '--json', project], { exit: 1, mutation: true, unchanged: true }).stdout).issue, 'stale-plan');
  const freshManual = JSON.parse(resume('plan', [...noRoute(), '--json', project]).stdout);
  assert.equal(JSON.parse(resume('apply', [...manualArgs, '--fingerprint', freshManual.fingerprint, '--json', project], { mutation: true }).stdout).status, 'applied');
  assert.equal(store.readIntent().value.route, 'manual');
  run(['connection', 'set', ...resumeArgs('resend', 'preview', 'provider-native'), '--destination', 'vercel',
    '--native-enrollment', 'resend-vercel-marketplace', project], { mutation: true });
  const resendNative = JSON.parse(resume('plan', [...noRoute('preview'), '--json', project]).stdout);
  assert.equal(resendNative.route, 'provider-native'); assert.equal(resendNative.source, 'current');
  assert.equal(resendNative.current.nativeEnrollment, 'resend-vercel-marketplace');
  const marketplaceGuide = JSON.parse(run(['connection', 'native', 'guide', '--service', 'resend', '--env', 'preview', '--json', project]).stdout);
  assert.equal(marketplaceGuide.nativeEnrollment, 'resend-vercel-marketplace');
  assert.equal(marketplaceGuide.guideUrl, 'https://resend.com/changelog/vercel-marketplace-integration');
  run(['connection', 'set', ...resumeArgs('resend', 'production', 'manual'), '--destination', 'manual', project], { mutation: true });
  const recoverMethod = JSON.parse(resume('plan', [...resumeArgs('resend', 'preview', 'provider-native'), '--json', project]).stdout);
  assert.equal(recoverMethod.source, 'last-recorded');
  assert.equal(recoverMethod.remembered.nativeEnrollment, 'resend-vercel-marketplace');
  assert.equal(JSON.parse(resume('apply', [...resumeArgs('resend', 'preview', 'provider-native'), '--fingerprint', recoverMethod.fingerprint, '--json', project], { mutation: true }).stdout).status, 'applied');
  assert.equal(store.readIntent().value.nativeEnrollment, 'resend-vercel-marketplace');
  const rehydratedGuide = JSON.parse(run(['connection', 'native', 'guide', '--service', 'resend', '--env', 'preview', '--json', project]).stdout);
  assert.equal(rehydratedGuide.guideUrl, 'https://resend.com/changelog/vercel-marketplace-integration');
  console.log(`Connection resume CLI: ${checks} cases passed; fresh-process selection, resume, offline next, guide and exact-slot presence with no key input/provider effects.`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
