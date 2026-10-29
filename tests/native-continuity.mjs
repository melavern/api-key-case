// End-to-end continuation across fresh CLI processes, with synthetic metadata.
// No provider inspection, app execution, real keyring or native UI is invoked.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'akc-native-continuity-')));
const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const moduleUrl = name => new URL(`../dist/core/agent/${name}.js`, import.meta.url).href;
const canary = 'synthetic-native-continuity-private-value';
const changedCanary = 'synthetic-native-continuity-other-private-value';
const services = ['resend', 'clerk'], environments = ['development', 'preview', 'production'];
const snapshot = path => Object.fromEntries(readdirSync(path, { withFileTypes: true }).flatMap(row => {
  const file = join(path, row.name);
  return row.isDirectory() ? Object.entries(snapshot(file)) : [[file, readFileSync(file).toString('base64')]];
}));
let checks = 0;

try {
  // An internal fixture recorder joins the real closed parser to the existing
  // journal API. It does not replace or claim to execute the provider inspector.
  const recorder = join(root, 'record-synthetic-inspection.mjs');
  writeFileSync(recorder, `
import {ConnectionStateStore} from ${JSON.stringify(moduleUrl('connection-state'))};
import {clerkNativeIntentFingerprint} from ${JSON.stringify(moduleUrl('clerk-native'))};
import {connectionIntentFingerprint} from ${JSON.stringify(moduleUrl('fingerprints'))};
import {parseNativeConfiguration,parseClerkNativeConfiguration} from ${JSON.stringify(moduleUrl('provider-native-check'))};
import {readNativeDestinationSelection,recordNativeInspection} from ${JSON.stringify(moduleUrl('native-observations'))};
const [service,environment,project,home,variant='initial']=process.argv.slice(2);
const store=new ConnectionStateStore(project,home),intent=(service==='clerk'?store.readClerkNativeIntent():store.readIntent()).value;
const names=service==='clerk'?['CLERK_SECRET_KEY','NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY']:['RESEND_API_KEY'];
const raw=JSON.stringify({envs:names.map((key,i)=>({key,target:[environment],type:i?'plain':'encrypted',configurationId:'icfg_fixture',updatedAt:variant==='configuration-changed'?2:1,value:variant==='value-only'?${JSON.stringify(changedCanary)}:${JSON.stringify(canary)}}))});
const parsed=(service==='clerk'?parseClerkNativeConfiguration:parseNativeConfiguration)(raw,environment);
const result={schemaVersion:service==='clerk'?2:1,service,environment,destination:'vercel',status:'inspected',reason:'inspected',...parsed,
 intentFingerprint:service==='clerk'?clerkNativeIntentFingerprint(intent):connectionIntentFingerprint(intent),
 destinationSelectionFingerprint:readNativeDestinationSelection(project,environment).fingerprint,observedAt:new Date().toISOString(),
 integrationIdentity:'unverified',credentialValidity:'not-checked',application:'not-checked',permission:'none'};
console.log(JSON.stringify({recording:recordNativeInspection(project,result,600,home),projection:parsed}));
`);
  const guard = join(root, 'deny-native-effects.cjs');
  writeFileSync(guard, `
const fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
const openMarker=fs.openSync.bind(fs),writeMarker=fs.writeSync.bind(fs),closeMarker=fs.closeSync.bind(fs);
const deny=()=>{const fd=openMarker(process.env.AKC_CONTINUITY_MARKER,'a');writeMarker(fd,'attempt\\n'+new Error().stack+'\\n');closeMarker(fd);throw Error(${JSON.stringify(canary)})};
const writing=flags=>typeof flags==='number'?(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND))!==0:flags!==undefined&&flags!=='r';
const native=require.resolve('@napi-rs/keyring',{paths:[${JSON.stringify(fileURLToPath(new URL('../dist/cli/', import.meta.url)))}]});
// Offline next may report legacy existence-only facts. All such values are
// synthetic; mutation, enumeration and every other command's vault access fail.
class Entry{constructor(){if(process.env.AKC_CONTINUITY_COMMAND!=='next')deny()}getPassword(){return ${JSON.stringify(canary)}}setPassword(){deny()}deleteCredential(){deny()}}
require.cache[native]={id:native,filename:native,loaded:true,exports:{Entry,AsyncEntry:class{constructor(){deny()}},findCredentials:deny,findCredentialsAsync:deny}};
process.dlopen=deny;Module._extensions['.node']=deny;
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[n]=deny;
for(const m of ['node:http','node:https'])for(const n of ['get','request'])require(m)[n]=deny;
for(const n of ['connect','createConnection'])require('node:net')[n]=deny;require('node:net').Socket.prototype.connect=deny;
require('node:tls').connect=deny;require('node:dgram').createSocket=deny;global.fetch=deny;
if(process.env.AKC_CONTINUITY_READONLY==='1'){
 for(const n of ['writeFile','appendFile','rename','unlink','rm','rmdir','mkdir','copyFile','cp','symlink','link','truncate','chmod','chown','utimes']){
  for(const k of [n,n+'Sync'])if(fs[k])fs[k]=deny;if(fs.promises[n])fs.promises[n]=deny;
 }
 for(const n of ['open','openSync']){const original=fs[n];fs[n]=function(p,flags,...args){if(writing(flags))return deny();return original.call(this,p,flags,...args)}}
 const open=fs.promises.open;fs.promises.open=async function(p,flags,...args){if(writing(flags))return deny();return open.call(this,p,flags,...args)};
 fs.createWriteStream=deny;for(const n of ['write','writeSync','writev','writevSync']){const original=fs[n];if(original)fs[n]=function(fd,...args){if(fd!==1&&fd!==2)return deny();return original.call(this,fd,...args)}}
}
if(process.env.AKC_CONTINUITY_NOW)Date.now=()=>Number(process.env.AKC_CONTINUITY_NOW);
require('node:module').syncBuiltinESMExports();
`);
  const fixture = (service, environment, suffix = '') => {
    const dir = join(root, `${service}-${environment}${suffix}`), home = join(dir, 'home'), project = join(dir, 'project');
    for (const path of [dir, home, project, join(project, '.vercel')]) mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(project, '.vercel', 'project.json'), JSON.stringify({ orgId: 'team_fixture', projectId: 'prj_fixture', unused: canary }));
    // Realistic declared use also exercises existing legacy status without
    // allowing it to become a request for duplicate native-route registration.
    writeFileSync(join(project, 'app.ts'), `void process.env.${service === 'clerk' ? 'CLERK_SECRET_KEY' : 'RESEND_API_KEY'};\n`);
    return { dir, home, project, service, environment, marker: join(root, `${service}-${environment}${suffix}-effect`) };
  };
  function run(f, args, { write = false, now, expected = 0, entry = cli, json = true } = {}) {
    const before = snapshot(f.dir);
    const result = spawnSync(process.execPath, ['--require', guard, entry, ...args], {
      cwd: f.project, env: { ...process.env, HOME: f.home, USERPROFILE: f.home, XDG_CONFIG_HOME: f.home, DO_NOT_TRACK: '1',
        AKC_CONTINUITY_MARKER: f.marker, AKC_CONTINUITY_READONLY: write ? '0' : '1', AKC_CONTINUITY_COMMAND: args[0],
        AKC_CONTINUITY_NOW: now ? String(now) : '', VERCEL_TOKEN: canary, RESEND_API_KEY: canary, CLERK_SECRET_KEY: canary },
      encoding: 'utf8', timeout: 15000
    });
    assert.equal(existsSync(f.marker), false, existsSync(f.marker) ? readFileSync(f.marker, 'utf8') : 'no unexpected effect');
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, expected, result.stderr);
    assert.ok(![canary, changedCanary].some(value => (result.stdout + result.stderr).includes(value)));
    if (!write) assert.deepEqual(snapshot(f.dir), before, 'reads must not refresh or rewrite state');
    const state = Object.values(snapshot(f.home)).map(v => Buffer.from(v, 'base64').toString()).join('\n');
    assert.ok(!state.includes(canary)); assert.ok(!state.includes(changedCanary));
    checks++;
    return result.stdout.trim() ? (json ? JSON.parse(result.stdout) : result.stdout.trim()) : null;
  }
  const guideArgs = f => ['connection', 'native', 'guide', '--service', f.service, '--env', f.environment, '--json', f.project];
  const nextArgs = f => ['next', '--json', '--offline', f.project];
  const evidence = (f, report) => f.service === 'clerk' ? report.clerkNative.applicationObservation : report.connection.report.nativeApplicationObservation;
  function guardReport(f, report) {
    assert.equal(report.inspection.mode, 'offline'); assert.equal(report.inspection.provider, 'not-inspected');
    assert.equal(report.setup.deploymentState, 'not-inspected'); assert.deepEqual(report.targets, []); assert.equal(report.guidedSetup, null);
    assert.ok(!report.nextActions.some(action => ['register-secret', 'register-connection-credential', 'approve-deploy-destination', 'authenticate-target-cli', 'complete-provider-native-setup'].includes(action.kind)));
    const ev = evidence(f, report); assert.equal(ev.service, f.service); assert.equal(ev.environment, f.environment);
    assert.equal(ev.currentHealth, 'unverified'); assert.equal(ev.permission, 'none');
    if (f.service === 'clerk') { assert.equal(report.clerkNative.route, 'provider-native'); assert.equal(report.clerkNative.application, 'not-checked'); }
    else { assert.equal(report.connection.report.route, 'provider-native'); assert.notEqual(report.connection.report.stage, 'ready'); }
    return ev;
  }
  const record = (f, variant = 'initial') => run(f, [f.service, f.environment, f.project, f.home, variant], { write: true, entry: recorder });
  const observeArgs = (f, receipt, extra = {}) => ['connection', 'native', 'observe-application', '--service', extra.service ?? f.service,
    '--env', extra.environment ?? f.environment, '--inspection', receipt, '--feature', extra.feature ?? (f.service === 'clerk' ? 'protected-access' : 'send-and-delivery'),
    '--observer', 'human', '--outcome', extra.outcome ?? 'passed', '--max-age-seconds', '300', '--json', f.project];

  for (const service of services) for (const environment of environments) {
    const f = fixture(service, environment);
    const options = run(f, ['connection', 'native', 'options', '--service', service, '--env', environment, '--json']);
    assert.equal(options.status, 'documented-candidate'); assert.equal(options.permission, 'none'); assert.equal(options.executed, false);
    assert.equal(options.selection, 'not-checked'); assert.deepEqual(snapshot(f.home), {});
    const missing = run(f, guideArgs(f), { expected: 1 }); assert.equal(missing.reason, 'selection-missing'); assert.equal(missing.selection, null);
    // Explicit synthetic selection through the same public CLI a new Agent uses.
    const enrollment = service === 'resend' && environment === 'preview' ? 'resend-vercel-marketplace' : 'resend-vercel-integration';
    const selectedArgs = ['connection', 'set', '--service', service, '--env', environment, '--route', 'provider-native', '--destination', 'vercel'];
    if (service === 'resend') selectedArgs.push('--native-enrollment', enrollment);
    selectedArgs.push(f.project);
    const selected = run(f, selectedArgs, { write: true, json: false });
    assert.match(selected, /connection intent saved/);
    if (service === 'resend') {
      const rejected = run(f, ['connection', 'set', '--service', 'resend', '--env', environment, '--route', 'api-key-case-managed',
        '--destination', 'vercel', '--native-enrollment', enrollment, f.project], { expected: 1 });
      assert.equal(rejected, null);
    } else {
      const rejected = run(f, ['connection', 'set', '--service', 'clerk', '--env', environment, '--route', 'provider-native',
        '--destination', 'vercel', '--native-enrollment', 'resend-vercel-integration', f.project], { expected: 1 });
      assert.equal(rejected, null);
    }
    const initial = run(f, guideArgs(f)); assert.equal(initial.reason, 'not-inspected'); assert.equal(initial.permission, 'none');
    if (service === 'resend') {
      assert.equal(initial.nativeEnrollment, enrollment);
      assert.equal(initial.nativeEnrollmentPrerequisite, enrollment === 'resend-vercel-marketplace' ? 'domain-purchased-through-vercel' : null);
      assert.equal(initial.nativeEnrollmentEligibility, enrollment === 'resend-vercel-marketplace' ? 'unverified' : null);
      assert.equal(initial.guideUrl, enrollment === 'resend-vercel-marketplace' ? 'https://resend.com/changelog/vercel-marketplace-integration' : 'https://resend.com/blog/vercel-integration');
      assert.equal(initial.executed, false);
    }
    assert.equal(initial.selection.orgId, 'team_fixture'); assert.equal(initial.selection.projectId, 'prj_fixture');
    const start = guardReport(f, run(f, nextArgs(f))); assert.equal(start.reason, 'inspection-missing');
    const inspected = record(f); assert.equal(inspected.recording.status, 'recorded'); assert.equal(inspected.projection.configuration, 'integration-managed');
    const configured = run(f, guideArgs(f)); assert.equal(configured.state, 'integration-managed');
    assert.equal(configured.application, 'not-checked'); assert.equal(configured.credentialValidity, 'not-checked'); assert.equal(configured.integrationIdentity, 'unverified');
    const pending = guardReport(f, run(f, nextArgs(f))); assert.equal(pending.reason, 'application-missing'); assert.deepEqual(pending.remaining, ['observe-application-feature']);
    const observed = run(f, observeArgs(f, inspected.recording.receiptId), { write: true });
    assert.equal(observed.status, 'recorded'); assert.equal(observed.executed, false); assert.equal(observed.permission, 'none');
    const restored = guardReport(f, run(f, nextArgs(f))); assert.equal(restored.status, 'reported'); assert.deepEqual(restored.remaining, []);
    assert.equal(restored.application.authority, 'human-reported'); assert.equal(restored.application.inspectionId, inspected.recording.receiptId);
    assert.equal(restored.application.feature, service === 'clerk' ? 'protected-access' : 'send-and-delivery');
    assert.equal(restored.application.outcome, 'passed'); assert.equal(restored.application.destinationSelectionFingerprint, configured.selection.fingerprint);
    assert.deepEqual(guardReport(f, run(f, nextArgs(f))), restored, 'new process restores the same bounded evidence');
    // Raw value changes cannot appear in the report, journal or fingerprint.
    const same = record(f, 'value-only'); assert.equal(same.projection.configurationFingerprint, inspected.projection.configurationFingerprint);
    const refreshed = guardReport(f, run(f, nextArgs(f))); assert.equal(refreshed.status, 'reported');
    assert.deepEqual(refreshed.application, restored.application, 'configuration reinspection cannot renew application evidence');
    assert.notEqual(refreshed.configuration.receiptId, restored.configuration.receiptId);
    // A previously superseded receipt cannot authorize a new observation.
    run(f, observeArgs(f, inspected.recording.receiptId), { expected: 1 });
    const expired = guardReport(f, run(f, nextArgs(f), { now: Date.parse(restored.application.expiresAt) + 1 }));
    assert.equal(expired.status, 'stale'); assert.equal(expired.reason, 'observation-expired'); assert.deepEqual(expired.remaining, ['inspect-existing-native-configuration']);
    const wrongEnv = environment === 'production' ? 'preview' : 'production';
    run(f, observeArgs(f, same.recording.receiptId, { environment: wrongEnv }), { expected: 1 });
    const wrongGuide = run(f, guideArgs({ ...f, environment: wrongEnv }), { expected: 1 }); assert.equal(wrongGuide.selection, null);
    record(f, 'configuration-changed');
    const changed = guardReport(f, run(f, nextArgs(f))); assert.equal(changed.status, 'stale'); assert.equal(changed.reason, 'inspection-changed');
    assert.deepEqual(changed.remaining, ['observe-application-feature']);
    writeFileSync(join(f.project, '.vercel', 'project.json'), JSON.stringify({ orgId: 'team_changed', projectId: 'prj_changed' }));
    const moved = guardReport(f, run(f, nextArgs(f))); assert.equal(moved.status, 'stale'); assert.equal(moved.reason, 'scope-changed');
    assert.deepEqual(moved.remaining, ['review-selected-target']);
    assert.equal(moved.application.destinationSelectionFingerprint, restored.application.destinationSelectionFingerprint);
    assert.notEqual(moved.destinationSelectionFingerprint, moved.application.destinationSelectionFingerprint);
    const movedGuide = run(f, guideArgs(f)); assert.equal(movedGuide.selection.projectId, 'prj_changed'); assert.equal(movedGuide.state, 'unknown');
    console.log(`native continuity: ${service}/${environment} flow passed`);
  }
  // Coexisting valid profiles cannot consume each other's real fixture receipts.
  const resend = fixture('resend', 'preview', '-coexisting'), clerk = { ...resend, service: 'clerk' };
  for (const f of [resend, clerk]) run(f, ['connection', 'set', '--service', f.service, '--env', 'preview', '--route', 'provider-native', '--destination', 'vercel', f.project], { write: true, json: false });
  const resendInspection = record(resend), clerkInspection = record(clerk);
  run(resend, observeArgs(resend, clerkInspection.recording.receiptId), { expected: 1 });
  run(clerk, observeArgs(clerk, resendInspection.recording.receiptId), { expected: 1 });
  run(resend, observeArgs(resend, resendInspection.recording.receiptId, { outcome: 'unknown' }), { write: true });
  const unknown = guardReport(resend, run(resend, nextArgs(resend)));
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.application.authority, 'human-reported');
  assert.deepEqual(unknown.remaining, ['observe-application-feature']);
  run(clerk, observeArgs(clerk, clerkInspection.recording.receiptId, { outcome: 'failed' }), { write: true });
  const both = run(clerk, nextArgs(clerk)), failed = guardReport(clerk, both);
  assert.equal(failed.status, 'reported'); assert.equal(failed.application.outcome, 'failed');
  assert.equal(failed.application.authority, 'human-reported'); assert.deepEqual(failed.remaining, ['review-recorded-failure']);
  assert.deepEqual(guardReport(resend, both), unknown, 'the other service keeps its own unknown evidence');
  console.log(`native continuity: ${checks} fresh-process checks passed across six Vercel service/environment flows`);
} finally { rmSync(root, { recursive: true, force: true }); }
