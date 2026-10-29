// Synthetic static candidates only. No real keyring, provider or native dialog.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCloudflareRouteOption, renderCloudflareRouteOption } from '../dist/core/agent/cloudflare-options.js';
import { readOfficialNativeRouteOption } from '../dist/core/agent/native-acquisition.js';
import { renderAgentProtocol } from '../dist/core/agent/init.js';

const services = ['resend', 'clerk', 'openai', 'stripe-test'];
const environments = ['development', 'preview', 'production'];
const settings = { resend: 'RESEND_API_KEY', clerk: 'CLERK_SECRET_KEY', openai: 'OPENAI_API_KEY', 'stripe-test': 'STRIPE_API_KEY' };
const links = { resend: 'https://resend.com/docs/dashboard/api-keys/introduction', clerk: 'https://clerk.com/docs/guides/development/clerk-environment-variables', openai: 'https://help.openai.com/en/articles/8867743-assign-api-key-permissions', 'stripe-test': 'https://docs.stripe.com/keys' };
const canary = 'synthetic-private-cloudflare-options-canary';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'akc-cloudflare-options-')));
const fixture = join(root, 'fixture'), project = join(fixture, 'project'), home = join(fixture, 'home');
const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
let checks = 0;
const snapshot = path => Object.fromEntries(readdirSync(path, { withFileTypes: true }).flatMap(row => {
  const file = join(path, row.name);
  return row.isDirectory() ? Object.entries(snapshot(file)) : [[file, readFileSync(file).toString('base64')]];
}));
function closed(report) {
  assert.equal(report.permission, 'none'); assert.equal(report.executed, false);
  assert.equal(report.humanSelection, 'required');
  assert.equal(report.nativeAcquisition, 'not-supported-by-this-command');
  for (const field of ['selection', 'providerAccount', 'destinationAuthentication', 'credentialPresence', 'credentialValidity', 'configuration', 'application']) {
    assert.equal(report[field], 'not-checked');
  }
  assert.ok(!JSON.stringify(report).includes(canary));
}

try {
  let combinations = 0;
  for (const service of services) for (const environment of environments) {
    if (service === 'stripe-test' && environment === 'production') continue;
    const report = readCloudflareRouteOption(service, environment); closed(report);
    assert.equal(report.schemaVersion, 1); assert.equal(report.status, 'documented-candidate');
    assert.equal(report.service, service); assert.equal(report.environment, environment);
    assert.equal(report.destination, 'cloudflare'); assert.equal(report.route, 'api-key-case-managed');
    assert.deepEqual(report.requiredSettings, [settings[service]]);
    assert.equal(report.guideUrl, 'https://developers.cloudflare.com/workers/configuration/secrets/');
    assert.equal(report.providerGuideUrl, links[service]);
    assert.equal(report.placementEffect, service === 'clerk' ? 'prepares-worker-version-without-activation' : 'creates-and-deploys-worker-version');
    assert.match(report.placementGuidance, service === 'clerk' ? /有効化は別/ : /直ちにデプロイ/);
    const text = renderCloudflareRouteOption(report);
    for (const value of [service === 'stripe-test' ? 'Stripe test' : service === 'openai' ? 'OpenAI' : service === 'clerk' ? 'Clerk' : 'Resend', environment, settings[service], links[service], report.placementGuidance]) assert.ok(text.includes(value));
    assert.match(text, /未選択/); assert.match(text, /自動取得する公式連携ではありません/);
    assert.match(text, /Chat・Agentの端末・引数には貼らない/);
    assert.deepEqual(readCloudflareRouteOption(service, environment), report);
    const forged = { ...report, guideUrl: canary, providerGuideUrl: canary, providerGuidance: canary, placementGuidance: canary, requiredSettings: [canary] };
    assert.equal(renderCloudflareRouteOption(forged), text);
    report.requiredSettings.push(canary);
    assert.deepEqual(readCloudflareRouteOption(service, environment).requiredSettings, [settings[service]]);
    combinations++; checks++;
  }
  assert.equal(combinations, 11);
  const unsupported = [['stripe-test', 'production'], ['resend', 'staging'], [canary, 'preview'], ['resend', canary], [null, null], [undefined, undefined], [{ toString() { throw Error(canary); } }, 'preview']];
  for (const args of unsupported) {
    const report = readCloudflareRouteOption(...args); closed(report);
    assert.equal(report.status, 'unsupported'); assert.equal(report.destination, null); assert.equal(report.route, null);
    assert.equal(report.guideUrl, null); assert.equal(report.providerGuideUrl, null); assert.equal(report.providerGuidance, null);
    assert.equal(report.placementEffect, null); assert.equal(report.placementGuidance, null); assert.deepEqual(report.requiredSettings, []);
    assert.ok(!renderCloudflareRouteOption(report).includes(canary)); checks++;
  }
  const stripe = readCloudflareRouteOption('stripe-test', 'preview');
  assert.match(stripe.providerGuidance, /sk_test_/); assert.match(stripe.providerGuidance, /rk_test_/);
  assert.match(stripe.providerGuidance, /権限を広げたり/); assert.match(stripe.providerGuidance, /接頭辞だけでは/);
  assert.match(readCloudflareRouteOption('openai', 'production').providerGuidance, /必要とするAPI・モデル/); checks++;
  const protocol = renderAgentProtocol('0.9.2');
  assert.ok(protocol.includes('connection cloudflare options --service <resend|clerk|openai|stripe-test> --env <environment> --json'));
  assert.ok(protocol.includes('connection native options --service <resend|clerk> --env <environment> --json'));
  assert.ok(protocol.includes('never switch destinations automatically')); checks++;

  for (const path of [fixture, project, home]) mkdirSync(path, { mode: 0o700 });
  const preload = join(root, 'deny-effects.cjs'), marker = join(root, 'effect-attempt');
  // ESM module/source reads remain possible, but no project/home access is allowed.
  // Mutations, subprocesses, keyring construction and network are denied globally.
  writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const write=fs.writeFileSync.bind(fs),deny=()=>{write(${JSON.stringify(marker)},'attempt');throw Error(${JSON.stringify(canary)})};
const root=${JSON.stringify(fixture)},blocked=p=>{try{const q=path.resolve(p instanceof URL?require('node:url').fileURLToPath(p):String(p));return q===root||q.startsWith(root+path.sep)}catch{return false}};
for(const n of ['readFileSync','readdirSync','statSync','lstatSync','realpathSync','accessSync','existsSync','openSync','readlinkSync','readFile','readdir','stat','lstat','realpath','access','open','readlink','createReadStream']){const original=fs[n];if(original){const wrapper=function(p,...args){if(blocked(p)||(['open','openSync'].includes(n)&&args[0]!==undefined&&args[0]!=='r'&&args[0]!==0))return deny();return original.call(this,p,...args)};if(original.native)wrapper.native=function(p,...args){if(blocked(p))return deny();return original.native.call(this,p,...args)};fs[n]=wrapper}}
for(const n of ['readFile','readdir','stat','lstat','realpath','access','open','readlink']){const original=fs.promises[n];fs.promises[n]=async function(p,...args){if(blocked(p)||(['open','openSync'].includes(n)&&args[0]!==undefined&&args[0]!=='r'&&args[0]!==0))return deny();return original.call(this,p,...args)}}
for(const n of ['writeFile','appendFile','rename','unlink','rm','rmdir','mkdir','copyFile','cp','symlink','link','truncate','chmod','chown','utimes']){for(const name of [n,n+'Sync'])if(fs[name])fs[name]=deny;if(fs.promises[n])fs.promises[n]=deny}
fs.createWriteStream=deny;for(const n of ['write','writeSync','writev','writevSync']){const original=fs[n];if(original)fs[n]=function(fd,...args){if(fd!==1&&fd!==2)return deny();return original.call(this,fd,...args)}}
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[n]=deny;
for(const mod of ['node:http','node:https'])for(const n of ['get','request'])require(mod)[n]=deny;
for(const n of ['connect','createConnection'])require('node:net')[n]=deny;require('node:net').Socket.prototype.connect=deny;
require('node:tls').connect=deny;require('node:dgram').createSocket=deny;global.fetch=deny;
const keyring=require.resolve('@napi-rs/keyring',{paths:[${JSON.stringify(fileURLToPath(new URL('../dist/cli/', import.meta.url)))}]});
require.cache[keyring]={id:keyring,filename:keyring,loaded:true,exports:{Entry:class Entry{constructor(){deny()}},AsyncEntry:class AsyncEntry{constructor(){deny()}},findCredentials:deny,findCredentialsAsync:deny}};
const load=Module._load;Module._load=function(name,...rest){if(name.includes('keyring-'))return deny();return load.call(this,name,...rest)};
process.dlopen=deny;Module._extensions['.node']=deny;
require('node:module').syncBuiltinESMExports();
`);
  const run = (destination, args) => spawnSync(process.execPath, ['--require', preload, cli, 'connection', destination, 'options', ...args], {
    cwd: project, env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, DO_NOT_TRACK: '1',
      CLOUDFLARE_API_TOKEN: canary, OPENAI_API_KEY: canary, RESEND_API_KEY: canary, STRIPE_API_KEY: canary }, encoding: 'utf8', timeout: 15000
  });
  const assertNoEffects = (result, before, expected = 0) => {
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, expected, result.stderr); assert.ok(!(result.stdout + result.stderr).includes(canary));
    assert.equal(existsSync(marker), false, 'attempted effect, even if caught internally'); assert.deepEqual(snapshot(fixture), before);
  };
  const empty = snapshot(fixture);
  const first = run('cloudflare', ['--service', 'resend', '--env', 'development', '--json']); assertNoEffects(first, empty); checks++;
  // Candidate does not become a selected route from existing or corrupt records.
  mkdirSync(join(project, '.vercel')); writeFileSync(join(project, '.vercel', 'project.json'), canary);
  writeFileSync(join(project, 'wrangler.jsonc'), canary); writeFileSync(join(home, 'state.json'), canary);
  const before = snapshot(fixture);
  for (const service of services) for (const environment of environments) {
    if (service === 'stripe-test' && environment === 'production') continue;
    for (const format of [[], ['--json']]) {
      const result = run('cloudflare', ['--service', service, '--env', environment, ...format]); assertNoEffects(result, before);
      if (format.length) assert.deepEqual(JSON.parse(result.stdout), readCloudflareRouteOption(service, environment));
      else assert.equal(result.stdout.trim(), renderCloudflareRouteOption(readCloudflareRouteOption(service, environment)));
      checks++;
    }
  }
  assert.equal(run('cloudflare', ['--json', '--env', 'development', '--service', 'resend']).stdout, first.stdout); checks++;
  // Existing Vercel candidates stay separate, fixed and state-free (all 6 slots).
  for (const service of ['resend', 'clerk']) for (const environment of environments) {
    const result = run('native', ['--service', service, '--env', environment, '--json']); assertNoEffects(result, before);
    assert.deepEqual(JSON.parse(result.stdout), readOfficialNativeRouteOption(service, environment)); checks++;
  }
  const valid = ['--service', 'resend', '--env', 'preview'];
  const bad = [[], ['--json'], ['--service'], ['--service', 'resend'], ['--env', 'preview'],
    ['--service', canary, '--env', 'preview'], ['--service', 'stripe-test', '--env', 'production'],
    ['--service', 'resend', '--env', 'staging'], ['--service', 'resend', '--env', canary],
    ...[['--open'], ['--login'], ['--record'], ['--force'], ['--url', canary], ['--command', canary], ['--key', canary],
      ['--destination', 'vercel'], ['--json', '--json'], ['--service', 'resend'], ['--env', 'preview'],
      [project], ['.'], ['--', project], [canary]].map(extra => [...valid, ...extra])];
  for (const args of bad) { const result = run('cloudflare', args); assertNoEffects(result, before, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /^Usage:/); checks++; }
  assert.equal(existsSync(marker), false); assert.deepEqual(snapshot(fixture), before);
  console.log(`cloudflare options: ${checks} checks passed (11 Cloudflare slots, 6 Vercel slots; no project/home/keyring/process/network/write effects)`);
} finally { rmSync(root, { recursive: true, force: true }); }
