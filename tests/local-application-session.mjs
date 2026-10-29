import assert from 'node:assert/strict';
import { Entry } from '@napi-rs/keyring';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { connectionCredentialRef } from '../dist/core/agent/connection-credential.js';
import { canonicalProjectRealpath } from '../dist/core/vault/naming.js';
import { MemoryVault } from '../dist/core/vault/memory.js';
import { saveLicenseKey } from '../dist/core/license.js';
import { LocalLaunchSnapshot } from '../dist/core/local/snapshot.js';
import { inspectLocalApplication, runLocalApplication, readLocalApplicationStatus, LOCAL_NATIVE_LAUNCH_ACCEPTED } from '../dist/core/local/session.js';
import * as handoffExports from '../dist/core/deploy/handoff.js';
import { runDisposableLocalSessionTests } from './local-session-fixture.mjs';
import { runLocalCompletionCoordinatorCases } from './local-session-completion.mjs';
import { runSyntheticApplicationFeatureTests } from './local-application-feature.mjs';
import { WindowsHumanPlane, buildWindowsLocalApplicationScript } from '../dist/core/human/windows.js';

const secret = 'synthetic-local-app-key-7S61';
const output = 'synthetic-app-output-93NJ';
const keys = generateKeyPairSync('ed25519');
const body = Buffer.from(JSON.stringify({v:1,plan:'pro',id:'synthetic-local-session',issuedAt:'2026-10-02'})).toString('base64url');
const signed = `AKC1.${body}`;
const license = `${signed}.${sign(null,Buffer.from(signed),keys.privateKey).toString('base64url')}`;

export async function runLocalApplicationTests() {
  if (!process.argv.includes('--synthetic-fixture')) {
    assert.equal(LOCAL_NATIVE_LAUNCH_ACCEPTED,true,'reviewed Windows development gate');
    assert.ok(readFileSync(new URL('../packages/core/deploy/handoff.ts',import.meta.url),'utf8').includes('!LOCAL_NATIVE_LAUNCH_ACCEPTED || process.platform !== "win32"'),'other platforms remain rejected');
    assert.equal('runLocalApplicationHandoff' in handoffExports,false,'raw handoff is not publicly callable');
    assert.equal('performLocalApplicationHandoff' in handoffExports,false);
    for(const file of ['../packages/core/deploy/handoff.ts','../packages/core/local/session.ts']) {
      assert.ok(!readFileSync(new URL(file,import.meta.url),'utf8').includes('testOwner'),'no shipped arbitrary secret sink');
    }
    return runDisposableLocalSessionTests({ featureOnly: process.argv.includes('--feature-only') });
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(),'akc-local-session-')));
  const original = Entry.prototype.getPassword;
  let active, count = 0, checks = 0;
  const unverified = [];
  const check = (value, message) => { checks++; assert.ok(value, message); };
  Entry.prototype.getPassword = function() {
    active.reads++;
    assert.deepEqual(this.fixtureArgs,["api-key-case",`v2|credential|project|${active.ref.projectId}|resend|development|RESEND_API_KEY`]);
    const receipt=active.store.readLocalSession();
    assert.equal(receipt.status,'available');assert.equal(receipt.value.finishedAt,null);assert.equal(receipt.value.outcome,'unknown');
    active.onRead?.();if(active.readFailure)throw new Error(secret+output);return secret;
  };
  const fixture = async () => {
    const dir=join(root,`case-${++count}`),project=join(dir,'project'),home=join(dir,'home');
    for(const p of [dir,project,home,join(project,'src'),join(project,'dist')])mkdirSync(p,{mode:0o700});
    const source=join(project,'src','app.ts'),artifact=join(project,'dist','app.cjs'),runtimePath=join(dir,process.platform==='win32'?'node.exe':'node');
    writeFileSync(runtimePath,'synthetic runtime');
    writeFileSync(source,'module.exports = "synthetic source";\n');writeFileSync(artifact,'setInterval(() => {}, 1000);\n');
    writeFileSync(join(project,'package.json'),'{"name":"synthetic-app","private":true}');writeFileSync(join(project,'package-lock.json'),'{"lockfileVersion":3}');
    saveLicenseKey(license,home);
    const store=new ConnectionStateStore(project,home),vault=new MemoryVault(),ref=connectionCredentialRef(project,'development');
    const select=(overrides={})=>assert.equal(store.saveIntent({service:'resend',environment:'development',route:'api-key-case-managed',destination:{kind:'local'},sendingDomain:null,...overrides}).ok,true);
    select();await vault.setSecret(ref,secret);const begun=store.beginCredentialMutation(ref);assert.equal(begun.ok,true);assert.equal(store.finishCredentialMutation(ref,begun.value,true),true);
    const metadata=join(home,'.api-key-case','connections',createHash('sha256').update(canonicalProjectRealpath(project)).digest('hex'));
    const revisionFile=join(metadata,'credential-development.json');
    const f={dir,project,home,source,artifact,runtimePath,metadata,revisionFile,store,vault,ref,select,reads:0,approvals:0,presence:0,spawns:0,secretMessages:0,releases:0,useSyntheticRuntime:true,phase:'initial',decision:'approved',terminal:'EXITED',delay:10,
      request:{service:'resend',environment:'development',projectDir:project,artifact:'dist/app.cjs',maxDurationMs:1000},
      rotate:()=>{const data=JSON.parse(readFileSync(revisionFile,'utf8'));data.credential.updatedAt='2099-01-01T00:00:00.000Z';writeFileSync(revisionFile,JSON.stringify(data));},
      edit:()=>writeFileSync(source,'module.exports = "changed source";\n')};
    const has=vault.hasSecret.bind(vault);vault.hasSecret=async r=>{assert.deepEqual(r,ref);f.presence++;const yes=await has(r);await f.onPresence?.(f.presence,f.phase);return yes;};
    vault.isAvailable=async()=>assert.fail('local session must not write a vault probe');
    for(const name of ['hasDestinationTrust','saveDestinationTrust'])vault[name]=async()=>assert.fail('hosted trust is not local launch authority');
    f.owner=config=>{
      assert.equal(config.interpreterPath,f.runtimePath,'synthetic owner receives the fixture runtime');
      f.spawns++;f.config=config;f.phase='owner';const owner=new EventEmitter();owner.stdout=new PassThrough();owner.stderr=null;
      let closed=false,timer;
      f.rawOutput=bytes=>owner.stdout.write(bytes);
      const emit=line=>{if(!closed)owner.stdout.write(line+'\n');};
      const close=()=>{if(closed)return;closed=true;clearTimeout(timer);owner.stdout.end();owner.emit('close',0);};
      f.close=close;
      const finish=status=>{emit(status);queueMicrotask(close);};
      owner.kill=()=>{f.kills=(f.kills??0)+1;close();return true;};
      owner.stdin=new Writable({write(chunk,_encoding,callback){
        const line=chunk.toString().trim();
        if(line==='CANCEL'){f.phase='cancel';f.onCancel?.();queueMicrotask(()=>finish('CANCELLED'));}
        else if(line==='RELEASE'){f.releases++;f.phase='started';f.onRelease?.();queueMicrotask(()=>{emit(f.startedLine??'STARTED');if(f.tamperAfterStart)emit(f.tamperAfterStart);timer=setTimeout(()=>{f.onTerminal?.();finish(f.terminal);},f.delay);});}
        else {const value=JSON.parse(line);assert.deepEqual(Object.keys(value),['secret']);assert.equal(value.secret,secret);f.secretMessages++;f.phase='created';f.onSecret?.();queueMicrotask(()=>emit(f.createdLine??'CREATED'));}
        callback();
      }});
      queueMicrotask(()=>{f.onReady?.();if(!f.silentReady)emit(f.tamperReady??'READY');});return owner;
    };
    f.deps={vault,connectionBaseDir:home,licenseOptions:{baseDir:home,publicKey:keys.publicKey},humanPlane:{
      capability:()=>f.capability??'os-dialog',askLocalApplication:async p=>{f.phase='approval';f.approvals++;f.approval=p;await f.onApproval?.();return f.decision;}
    }};
    f.run=async()=>{active=f;globalThis.__akcLocalSyntheticFixture=f;const result=await runLocalApplication(f.request);const json=JSON.stringify(result);assert.ok(!json.includes(secret));assert.ok(!json.includes(output));if(f.config){assert.ok(!json.includes(f.config.artifactSha256));assert.ok(!json.includes(f.config.interpreterSha256));}return result;};
    globalThis.__akcLocalSyntheticFixture=f;
    return f;
  };
  try {
    if(process.argv.includes('--completion-only')){await runLocalCompletionCoordinatorCases({fixture});return;}
    assert.equal(LOCAL_NATIVE_LAUNCH_ACCEPTED,true,'disposable build only');
    for (const platform of ['linux', 'darwin']) {
      const f=await fixture();active=f;globalThis.__akcLocalSyntheticFixture=f;
      const guarded=await import(`../dist/core/deploy/handoff-${platform}.js`);
      const result=await guarded.runLocalApplication(f.request);
      assert.equal(result.status,'native-acceptance-required');
      assert.equal(result.nativeLauncher,'disabled-awaiting-windows-acceptance');
      assert.equal(f.reads+f.spawns+f.approvals+f.secretMessages+f.releases,0);
      checks++;
    }
    {
      const f=await fixture(), original=Object.getOwnPropertyDescriptor(process,'platform');
      try {
        for(const platform of ['win32','linux','darwin']) {
          Object.defineProperty(process,'platform',{...original,value:platform});
          const expected=platform==='win32'?'enabled':'disabled-awaiting-windows-acceptance';
          assert.equal((await inspectLocalApplication(f.deps,{})).nativeLauncher,expected);
          assert.equal(readLocalApplicationStatus(f.project,f.home).nativeLauncher,expected);
          assert.equal(readLocalApplicationStatus(null,f.home).nativeLauncher,expected);
          checks++;
        }
      } finally { Object.defineProperty(process,'platform',original); }
      assert.equal(f.reads+f.spawns+f.approvals,0);
    }
    await runSyntheticApplicationFeatureTests(fixture, secret, output);
    if(process.argv.includes('--feature-only'))return;
    {
      const f=await fixture();rmSync(join(f.home,'.api-key-case','license.key'));assert.equal((await f.run()).status,'pro-required');assert.equal(f.presence+f.reads+f.spawns+f.approvals,0);
      assert.equal((await inspectLocalApplication(f.deps,f.request)).status,'ready-for-review');assert.equal(f.reads+f.spawns+f.approvals,0);assert.equal(readLocalApplicationStatus(f.project,f.home).status,'not-started');
    }
    {
      const f=await fixture();Object.defineProperty(f,'deps',{get(){throw new Error(secret+output);}});
      const r=await f.run();assert.equal(r.status,'unavailable');assert.equal(f.reads+f.spawns,0);checks++;
    }
    for(const bad of [{service:'other'},{environment:'production'},{environment:'preview'},{scope:'user'},{argv:['anything']},{env:{NODE_OPTIONS:'injected'}},{url:'https://invalid.example'},{maxDurationMs:0},{maxDurationMs:1800001},{maxDurationMs:NaN},{interpreter:'/tmp/other'}, {artifact:'../app.cjs'}]){
      const f=await fixture();Object.assign(f.request,bad);check(['unsupported','inputs-unavailable'].includes((await f.run()).status));assert.equal(f.reads+f.spawns+f.approvals,0);
    }
    for(const bad of [{environment:'production'},{destination:{kind:'vercel'}},{route:'manual'},{route:'provider-native'}]){
      const f=await fixture();f.select(bad);assert.equal((await f.run()).status,'intent-mismatch');assert.equal(f.reads+f.spawns,0);checks++;
    }
    for(const kind of ['missing-intent','corrupt-intent','missing-revision','corrupt-revision','pending-revision','missing-key','legacy-only','other-env']){
      const f=await fixture();
      if(kind==='missing-intent')rmSync(join(f.metadata,'state.json'));
      if(kind==='corrupt-intent')writeFileSync(join(f.metadata,'state.json'),'{');
      if(kind==='missing-revision')rmSync(f.revisionFile);
      if(kind==='corrupt-revision')writeFileSync(f.revisionFile,'{}');
      if(kind==='pending-revision')f.store.beginCredentialMutation(f.ref);
      if(['missing-key','legacy-only','other-env'].includes(kind))await f.vault.deleteSecret(f.ref);
      if(kind==='legacy-only')await f.vault.setSecret({name:'RESEND_API_KEY',scope:'project',projectId:f.ref.projectId},secret);
      if(kind==='other-env')await f.vault.setSecret(connectionCredentialRef(f.project,'production'),secret);
      check(['intent-unavailable','revision-unavailable','missing-credential'].includes((await f.run()).status));assert.equal(f.reads+f.spawns+f.approvals,0);
    }
    // Inspection must agree with execution's recovery boundary without
    // touching the vault or clearing prior session/artifact evidence.
    for(const kind of ['active','interrupted','lock-only','invalid-lock','absent']) {
      const f=await fixture(), lock=join(f.metadata,'local-session.lock'), receipt=join(f.metadata,'local-session.json');
      if(['active','interrupted'].includes(kind)) {
        const started=f.store.beginLocalSession(f.store.credentialRevision(f.ref),1000);assert.equal(started.ok,true);
        if(kind==='interrupted')assert.equal(f.store.finishLocalSession(started.value.attemptId,'unknown',false),true);
      } else if(kind==='lock-only')mkdirSync(lock);
      else if(kind==='invalid-lock')writeFileSync(lock,'synthetic-invalid-lock');
      const retained=[f.artifact,f.revisionFile,...(existsSync(receipt)?[receipt]:[])].map(path=>[path,readFileSync(path)]);
      const inspected=await inspectLocalApplication(f.deps,f.request);
      assert.equal(inspected.status,kind==='absent'?'ready-for-review':kind==='invalid-lock'?'metadata-unavailable':'recovery-required');
      assert.equal(f.presence,kind==='absent'?1:0);assert.equal(f.reads+f.spawns+f.approvals,0);
      assert.equal(inspected.permission,'none');assert.equal(inspected.applicationReadiness,'not-verified');
      for(const [path,bytes]of retained)assert.deepEqual(readFileSync(path),bytes);
      assert.equal(existsSync(lock),kind!=='absent');if(kind==='invalid-lock')assert.equal(readFileSync(lock,'utf8'),'synthetic-invalid-lock');
      checks++;
    }
    for(const kind of ['directory','invalid-file','missing-key-with-lock']) {
      const f=await fixture(),lock=join(f.metadata,'local-session.lock');
      if(kind==='missing-key-with-lock')await f.vault.deleteSecret(f.ref);
      f.onPresence=()=>{if(kind==='invalid-file')writeFileSync(lock,'synthetic-race-lock');else mkdirSync(lock);};
      const inspected=await inspectLocalApplication(f.deps,f.request);
      assert.equal(inspected.status,kind==='invalid-file'?'metadata-unavailable':'recovery-required');
      assert.equal(f.presence,1);assert.equal(f.reads+f.spawns+f.approvals,0);
      assert.equal(existsSync(lock),true);assert.equal(inspected.execution,'not-started');
      checks++;
    }
    let presenceCount;
    {
      const f=await fixture();const result=await f.run();assert.equal(result.status,'exited');assert.equal(result.treeTermination,'confirmed');assert.equal(f.reads,1);assert.equal(f.approvals,1);assert.equal(f.secretMessages,1);assert.equal(f.releases,1);assert.equal(result.receiptSaved,true);presenceCount=f.presence;
      const receipt=readLocalApplicationStatus(f.project,f.home);assert.equal(receipt.status,'exited');assert.equal(receipt.applicationReadiness,'not-verified');assert.equal(receipt.permission,'none');
      const disk=readFileSync(join(f.metadata,'local-session.json'),'utf8');for(const forbidden of [secret,output,f.source,f.artifact,f.config.artifactSha256,f.config.interpreterSha256])check(!disk.includes(forbidden));
      assert.equal(f.approval.credentialRevision,f.store.credentialRevision(f.ref));assert.equal(f.approval.environment,'development');
      const second=await f.run();assert.notEqual(second.attemptId,result.attemptId);assert.equal(f.approvals,2,'no approval reuse');
    }
    // Rotation on every awaited presence boundary up to and after child release.
    for(let at=1;at<=presenceCount;at++){
      const f=await fixture();f.onPresence=n=>{if(n===at)f.rotate();};const result=await f.run();check(['changed','unknown'].includes(result.status),`revision await ${at}`);assert.ok(f.spawns<=1);assert.ok(f.reads<=1);assert.ok(f.releases<=1);
    }
    for(const decision of ['declined','unavailable']){const f=await fixture();f.decision=decision;assert.equal((await f.run()).status,decision);assert.equal(f.reads+f.spawns,0);checks++;}
    for(const change of ['artifact','source','added','deleted','interpreter','intent','project']){
      const f=await fixture();f.onApproval=()=>{
        if(change==='artifact')writeFileSync(f.artifact,'process.exit(1);\n');
        if(change==='source')f.edit();if(change==='added')writeFileSync(join(f.project,'src','new.ts'),'x');if(change==='deleted')rmSync(f.source);
        if(change==='intent')f.select({sendingDomain:'changed.invalid'});
        if(change==='project'){renameSync(f.project,f.project+'-old');mkdirSync(f.project);}
        // Current process runtime cannot be edited. A separate snapshot fixture below verifies exact interpreter replacement.
        if(change==='interpreter')f.rotate();
      };assert.equal((await f.run()).status,'changed');assert.equal(f.reads+f.spawns,0);checks++;
    }
    {
      const f=await fixture();
      f.onApproval=()=>writeFileSync(f.runtimePath,'replacement synthetic runtime');
      const result=await f.run();
      assert.equal(result.status,'changed');assert.equal(f.approvals,1);
      assert.equal(f.reads,0,'changed runtime must be rejected before reading the secret');
      assert.equal(f.secretMessages+f.spawns+f.releases,0,'changed runtime must not receive or execute the secret');
      checks++;
    }
    for(const phase of ['onReady','onRead','onSecret','onTerminal']){const f=await fixture();f[phase]=f.edit;const r=await f.run();assert.equal(r.status,'changed');assert.equal(f.releases,phase==='onTerminal'?1:0);assert.ok(f.reads<=1);checks++;}
    {
      const f=await fixture();f.delay=1500;f.onRelease=()=>setTimeout(f.edit,50);const r=await f.run();assert.equal(r.status,'changed');assert.equal(r.treeTermination,'confirmed');checks++;
    }
    {
      const f=await fixture();let clock=0;f.deps.now=()=>{clock+=20000;return clock;};const r=await f.run();check(['changed','unknown'].includes(r.status));assert.equal(f.releases,0);
    }
    for(const mode of ['ready-output','terminal-output','duplicate','crash','read-error']){
      const f=await fixture();if(mode==='ready-output')f.tamperReady=secret+output;if(mode==='terminal-output')f.tamperAfterStart=secret+output;if(mode==='duplicate')f.tamperAfterStart='STARTED';if(mode==='crash')f.onRelease=()=>queueMicrotask(f.close);if(mode==='read-error')f.readFailure=true;
      const r=await f.run();assert.equal(r.status,'unknown');assert.ok(f.spawns<=1&&f.reads<=1);if(r.execution==='possible'){assert.equal(f.store.localSessionLockStatus(),'present');assert.equal((await f.run()).status,'recovery-required');}checks++;
    }
    for(const mode of ['high-bit','duplicate-ready','terminal-before-secret','terminal-before-release','duplicate-created','duplicate-started']){
      const f=await fixture();
      if(mode==='high-bit'){f.silentReady=true;f.onReady=()=>f.rawOutput(Buffer.from([...Buffer.from('READY')].map(x=>x|128).concat(10)));}
      if(mode==='duplicate-ready')f.tamperReady='READY\nREADY';
      if(mode==='terminal-before-secret')f.tamperReady='EXITED';
      if(mode==='terminal-before-release')f.createdLine='EXITED';
      if(mode==='duplicate-created')f.createdLine='CREATED\nCREATED';
      if(mode==='duplicate-started')f.startedLine='STARTED\nSTARTED';
      assert.equal((await f.run()).status,'unknown');assert.ok(f.spawns<=1&&f.reads<=1);if(['high-bit','duplicate-ready','terminal-before-secret'].includes(mode))assert.equal(f.reads+f.secretMessages,0);if(['terminal-before-release','duplicate-created'].includes(mode))assert.equal(f.releases,0);checks++;
    }
    for(const phase of ['before-ready','on-ready','on-read']){
      const f=await fixture(),controller=new AbortController();f.deps.signal=controller.signal;
      if(phase==='before-ready'){f.silentReady=true;f.onReady=()=>controller.abort();}
      if(phase==='on-ready')f.onReady=()=>controller.abort();
      if(phase==='on-read')f.onRead=()=>controller.abort();
      const r=await f.run();check(['changed','cancelled','unknown'].includes(r.status));assert.equal(f.secretMessages+f.releases,0);
    }
    // These cases classify an owner-supplied terminal, not elapsed lifetime.
    // Keep the independent deadline from racing the synthetic terminal under CPU load.
    for(const terminal of ['FAILED','EXPIRED','UNKNOWN','PARENT_LOST']){const f=await fixture();f.request.maxDurationMs=30000;f.terminal=terminal;const r=await f.run();assert.equal(r.status,{FAILED:'failed',EXPIRED:'expired',UNKNOWN:'unknown',PARENT_LOST:'unknown'}[terminal]);checks++;}
    {
      const f=await fixture();const signal=new AbortController();f.deps.signal=signal.signal;f.delay=1500;f.onRelease=()=>setTimeout(()=>signal.abort(),10);const r=await f.run();assert.equal(r.status,'cancelled');assert.equal(r.treeTermination,'confirmed');checks++;
    }
    for(const stage of ['onReady','onRead','onSecret','onRelease'])for(const change of ['remove-lock','replace-lock','receipt-revision','receipt-duration','remove-receipt']){
      const f=await fixture();f.delay=1000;
      f[stage]=()=>{
        const lock=join(f.metadata,'local-session.lock'),file=join(f.metadata,'local-session.json');
        if(change==='remove-lock')rmSync(lock,{recursive:true});
        if(change==='replace-lock'){renameSync(lock,lock+'-old');mkdirSync(lock);}
        if(change==='remove-receipt')rmSync(file);
        if(change.startsWith('receipt-')){const data=JSON.parse(readFileSync(file,'utf8'));if(change==='receipt-revision')data.receipt.credentialRevision='2099-01-01T00:00:00.000Z';else data.receipt.maxDurationMs=1800000;writeFileSync(file,JSON.stringify(data));}
      };
      const r=await f.run();check(['metadata-unavailable','unknown'].includes(r.status),`${stage}/${change}`);assert.equal(r.receiptSaved,false);
      if(stage==='onReady')assert.equal(f.reads+f.secretMessages,0);
      if(stage!=='onRelease')assert.equal(f.releases,0);
    }
    for(const kind of ['artifact','input-enumeration']){
      const f=await fixture();f.delay=1500;f.onRelease=()=>setTimeout(()=>{
        if(kind==='artifact')writeFileSync(f.artifact,'process.exit(5);');
        else writeFileSync(join(f.project,'src','new.ts'),'new source');
      },10);
      const r=await f.run();assert.equal(r.status,'changed');assert.equal(r.treeTermination,'confirmed');checks++;
    }
    for(const mode of ['start-write','existing-lock','end-write']){
      const f=await fixture();if(mode==='start-write')writeFileSync(join(f.metadata,'local-session.json.tmp'),'');if(mode==='existing-lock')mkdirSync(join(f.metadata,'local-session.lock'));
      if(mode==='end-write')f.onTerminal=()=>writeFileSync(join(f.metadata,'local-session.json.tmp'),'');
      const r=await f.run();assert.equal(r.status,mode==='end-write'?'unknown':mode==='existing-lock'?'recovery-required':'metadata-unavailable');if(mode!=='end-write')assert.equal(f.reads+f.spawns,0);else{assert.equal(r.receiptSaved,false);assert.equal(r.treeTermination,'confirmed');}
      assert.ok(f.spawns<=1);checks++;
    }
    {
      const f=await fixture();const start=f.store.beginLocalSession(f.store.credentialRevision(f.ref),1000);assert.equal(start.ok,true);assert.equal(readLocalApplicationStatus(f.project,f.home).status,'unknown');assert.equal((await f.run()).status,'recovery-required');assert.equal(f.reads,0);checks++;
    }
    for(const kind of ['artifact-symlink','source-symlink','extra-lock','missing-lock','secret-name','oversized','special','missing-source']){
      const f=await fixture();
      if(kind==='artifact-symlink'||kind==='source-symlink'){
        const path=kind==='artifact-symlink'?f.artifact:f.source;
        renameSync(path,path+'.original');
        try { symlinkSync(path+'.original',path); }
        catch(error){
          if(process.platform!=='win32'||error.code!=='EPERM')throw error;
          unverified.push(`${kind} input rejection: Windows file-symlink creation returned EPERM`);
          continue;
        }
      }
      if(kind==='extra-lock')writeFileSync(join(f.project,'yarn.lock'),'x');if(kind==='missing-lock')rmSync(join(f.project,'package-lock.json'));
      if(kind==='secret-name')writeFileSync(join(f.project,'src','.env'),'SYNTHETIC_ONLY');
      if(kind==='oversized')writeFileSync(f.source,Buffer.alloc(2*1024*1024+1));
      if(kind==='special')mkdirSync(join(f.project,'package.json.tmp'));// use non-file required manifest
      if(kind==='special'){rmSync(join(f.project,'package.json'));mkdirSync(join(f.project,'package.json'));}
      if(kind==='missing-source')rmSync(join(f.project,'src'),{recursive:true});
      assert.equal((await f.run()).status,'inputs-unavailable');assert.equal(f.reads+f.spawns,0);checks++;
    }
    {
      const f=await fixture();const runtime=join(f.dir,process.platform==='win32'?'node.exe':'node');writeFileSync(runtime,'synthetic runtime');
      const snapshot=new LocalLaunchSnapshot(f.project,'dist/app.cjs',runtime);assert.equal(snapshot.current(),true);const serialized=JSON.stringify(snapshot);check(!serialized.includes('synthetic runtime'));check(!serialized.includes('Sha256'));writeFileSync(runtime,'replacement');assert.equal(snapshot.current(),false);
    }
    const approval={projectDir:'C:\\synthetic',artifactPath:'C:\\synthetic\\dist\\app.cjs',interpreterPath:'C:\\Program Files\\nodejs\\node.exe',service:'resend',environment:'development',credentialRevision:'2026-10-02T00:00:00.000Z',maxDurationMs:1000};
    const script=buildWindowsLocalApplicationScript(approval);
    for(const needed of ['Invoke-ApiKeyCaseUserVerification','if ($verified -eq 0)','AcceptButton = $noButton','Yu Gothic UI','RESEND_API_KEY','Registration revision','Stopping cannot revoke'])check(script.includes(needed));
    assert.throws(()=>buildWindowsLocalApplicationScript({...approval,environment:'production'}));assert.throws(()=>buildWindowsLocalApplicationScript({...approval,projectDir:'C:\\bad\npath'}));
    for(const code of [0,2,10,1,null]){
      const plane=new WindowsHumanPlane('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',async request=>{assert.equal(request.stdio,'ignore');assert.equal(request.shell,false);assert.ok(!request.args.join('').includes(secret));return code;});
      assert.equal(await plane.askLocalApplication(approval),code===0?'approved':code===2?'declined':'unavailable');checks++;
    }
    const cli=fileURLToPath(new URL('../dist/cli/index.js',import.meta.url));
    for(const extra of [['--argv','echo'],['--env','production'],['--shell'],['--force'],['--test-owner','injected'],['--','anything'],['--url','https://invalid.example']]){
      const out=spawnSync(process.execPath,[cli,'connection','local','run','--service','resend','--env','development','--artifact','dist/app.cjs','--max-seconds','60','--json',...extra],{encoding:'utf8'});assert.equal(out.status,1);check(!out.stdout.includes(secret));
    }
    for(const reason of unverified)console.log(`SKIP (unverified): ${reason}`);
    console.log(`Local application synthetic checks: ${checks} passed; ${unverified.length} skipped (unverified); native Windows and real-provider execution are not exercised by this suite.`);
  } finally { Entry.prototype.getPassword=original;rmSync(root,{recursive:true,force:true}); }
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runLocalApplicationTests();
