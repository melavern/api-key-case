// Synthetic CLI acceptance only. No real OS store, consent, provider or recipient.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalProjectRealpath } from '../dist/core/vault/naming.js';
import { spawnSync } from 'node:child_process';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { connectionCredentialRef } from '../dist/core/agent/connection-credential.js';
import { saveLicenseKey } from '../dist/core/license.js';
import { renderAgentProtocol } from '../dist/core/agent/init.js';
import { runDisposableLocalSessionTests } from './local-session-fixture.mjs';

export async function runLocalObservationTests() {
 if (!process.argv.includes('--synthetic-fixture')) return runDisposableLocalSessionTests({ observationsOnly:true });
 const root=realpathSync(mkdtempSync(join(tmpdir(),'akc-local-observations-'))), canary='synthetic-local-app-key-7S61', raw='synthetic-app-output-93NJ';
 const cli=fileURLToPath(new URL('../dist/cli/index.js',import.meta.url)), compiled=fileURLToPath(new URL('../dist',import.meta.url));
 let cases=0;
 const keys=generateKeyPairSync('ed25519');
 const body=Buffer.from(JSON.stringify({v:1,plan:'pro',id:'synthetic-trial',issuedAt:'2026-10-04'})).toString('base64url'), signed=`AKC1.${body}`;
 const license=`${signed}.${sign(null,Buffer.from(signed),keys.privateKey).toString('base64url')}`;
 try {
  const home=join(root,'home'), project=join(root,'project'), other=join(root,'other'), marker=join(root,'effects.json');
  for(const dir of [home,project,other,join(project,'src'),join(project,'dist')])mkdirSync(dir,{mode:0o700});
  writeFileSync(join(project,'package.json'),'{"private":true}');writeFileSync(join(project,'package-lock.json'),'{"lockfileVersion":3}');
  writeFileSync(join(project,'src','app.js'),'module.exports = "synthetic source";');
  writeFileSync(join(project,'dist','app.cjs'),`process.stdout.write(process.env.RESEND_API_KEY);process.stderr.write(${JSON.stringify(raw)});`);
  saveLicenseKey(license,home);
  const store=new ConnectionStateStore(project,home), ref=connectionCredentialRef(project,'development');
  const selection={service:'resend',environment:'development',route:'api-key-case-managed',destination:{kind:'local'},sendingDomain:null};
  assert.equal(store.saveIntent(selection).ok,true);
  const register=()=>{const begun=store.beginCredentialMutation(ref);assert.equal(begun.ok,true);assert.equal(store.finishCredentialMutation(ref,begun.value,true),true);};register();
  const state=join(home,'.api-key-case','connections',createHash('sha256').update(canonicalProjectRealpath(project)).digest('hex'));
  const receiptFile=join(state,'local-session.json');
  const preload=join(root,'synthetic-cli.mjs');
  writeFileSync(marker,JSON.stringify({reads:0,approvals:0,owners:0,apps:0}));
  writeFileSync(preload,`import cp from 'node:child_process';import fs from 'node:fs';import{basename}from'node:path';import{syncBuiltinESMExports}from'node:module';import{createPublicKey}from'node:crypto';import{EventEmitter}from'node:events';import{PassThrough,Writable}from'node:stream';
import{Entry}from ${JSON.stringify(new URL('../node_modules/@napi-rs/keyring/index.js',import.meta.url).href)};
import{MemoryVault}from ${JSON.stringify(pathToFileURL(join(compiled,'core/vault/memory.js')).href)};import{KeyringVault}from ${JSON.stringify(pathToFileURL(join(compiled,'core/vault/keyring.js')).href)};
const marker=${JSON.stringify(marker)}, count=name=>{const x=JSON.parse(fs.readFileSync(marker,'utf8'));x[name]++;fs.writeFileSync(marker,JSON.stringify(x));};
const originalSpawn=cp.spawn;
const running=process.argv.includes('run');
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>{throw Error('No provider/child in observation or resume')};syncBuiltinESMExports();
KeyringVault.prototype.hasSecret=async()=>true;KeyringVault.prototype.isAvailable=async()=>{throw Error('No store probe')};
Entry.prototype.getPassword=function(){if(!running)throw Error('No key read');count('reads');return ${JSON.stringify(canary)}};
if(running){const vault=new MemoryVault();vault.hasSecret=async()=>true;
globalThis.__akcLocalSyntheticFixture={deps:{vault,connectionBaseDir:${JSON.stringify(home)},licenseOptions:{baseDir:${JSON.stringify(home)},publicKey:createPublicKey(${JSON.stringify(keys.publicKey.export({type:'spki',format:'pem'}).toString())})},humanPlane:{capability:()=> 'os-dialog',askLocalApplication:async()=>{count('approvals');return 'approved'}}},owner(config){count('owners');const owner=new EventEmitter();owner.stdout=new PassThrough();owner.stderr=null;let child,closed=false;const emit=line=>owner.stdout.write(line+'\\n');const close=()=>{if(closed)return;closed=true;owner.stdout.end();owner.emit('close',0)};owner.kill=()=>{child?.kill();close();return true};owner.stdin=new Writable({write(chunk,encoding,done){const line=chunk.toString().trim();if(line==='CANCEL'){child?.kill();queueMicrotask(()=>{emit('CANCELLED');close()})}else if(line==='RELEASE'){count('apps');child=originalSpawn(config.interpreterPath,[config.artifactPath],{cwd:config.projectDir,stdio:'ignore',env:{NODE_ENV:'development',RESEND_API_KEY:${JSON.stringify(canary)}}});emit('STARTED');child.once('close',code=>{emit(code===0?'EXITED':'FAILED');close()})}else{const input=JSON.parse(line);if(input.secret!==${JSON.stringify(canary)})throw Error('wrong synthetic credential');queueMicrotask(()=>emit('CREATED'))}done()}});queueMicrotask(()=>emit('READY'));return owner}};
}
if(process.env.AKC_TEST_STORAGE_FAIL==='fsync'){fs.fsyncSync=()=>{throw Error('Synthetic write failure')};syncBuiltinESMExports()}
if(process.env.AKC_TEST_STORAGE_FAIL==='cleanup'){const remove=fs.rmdirSync;fs.rmdirSync=path=>{if(basename(String(path))==='lock')throw Error('Synthetic cleanup failure');return remove(path)};syncBuiltinESMExports()}
if(process.env.AKC_TEST_CLOCK_MS){const OriginalDate=Date,clock=Number(process.env.AKC_TEST_CLOCK_MS);globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[clock]))}static now(){return clock}}}
`);
  // These are functional receipt tests, not timeout tests. Allow cold CLI
  // startup and repeated real interpreter integrity hashing on slower hosts.
  // Product deadlines and dedicated cancellation/expiry tests stay unchanged.
  const run=(args,extra={})=>{
   const r=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,cli,...args],{cwd:project,env:{...process.env,HOME:home,USERPROFILE:home,DO_NOT_TRACK:'1',NODE_OPTIONS:'',...extra},encoding:'utf8',timeout:30000});
   assert.equal(r.error,undefined);assert.ok(!`${r.stdout}${r.stderr}`.includes(canary));assert.ok(!`${r.stdout}${r.stderr}`.includes(raw));return r;
  };
  const local=(operation,args=[],path=project)=>run(['connection','local',operation,'--service','resend','--env','development','--json',...args,path]);
  const effects=()=>JSON.parse(readFileSync(marker,'utf8'));
  const status=()=>{const r=local('status');assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)};
  const observe=(receipt,authority='agent-observed',outcome='passed',extra=[],path=project,storageFailure=null,extraEnv={})=>{
   const args=['connection','local','observe','--service','resend','--env','development','--json','--attempt',receipt.attemptId,'--execution-basis',receipt.executionBasisId??randomUUID(),'--credential-revision',receipt.credentialRevision,'--authority',authority,'--outcome',outcome,...extra,path];
   return run(args,{...extraEnv,...(storageFailure?{AKC_TEST_STORAGE_FAIL:storageFailure}:{})});
  };
  const refuse=(r)=>{assert.equal(r.status,1);if(r.stdout){const x=JSON.parse(r.stdout);assert.equal(x.status,'refused');assert.equal(x.observation,null);assert.equal(x.permission,'none')}cases++;};
  const result=local('run',['--artifact','dist/app.cjs','--max-seconds','10']);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'exited');cases++;
  const first=status();assert.equal(first.receipt.outcome,'exited');assert.equal(first.receipt.execution,'possible');assert.equal(first.receipt.treeTermination,'confirmed');assert.equal(first.observationHistory.entries[0].observations.length,0);assert.equal(first.applicationReadiness,'not-verified');cases++;
  const beforeEffects=effects();assert.deepEqual(beforeEffects,{reads:1,approvals:1,owners:1,apps:1});
  const receipt=first.receipt;
  let r=observe(receipt);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).observation.authority,'agent-observed');cases++;
  r=observe(receipt,'human-reported','received');assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).observation.authority,'human-reported');cases++;
  const restored=run(['next','--json','--offline',project]);assert.equal(restored.status,0,restored.stderr);const next=JSON.parse(restored.stdout);assert.equal(next.schemaVersion,13);assert.equal(next.inspection.mode,'offline');assert.equal(next.localSession.receipt.attemptId,receipt.attemptId);assert.equal(next.localSession.observationHistory.entries[0].observations.length,2);assert.equal(next.localSession.applicationReadiness,'not-verified');assert.notEqual(next.connection.report.stage,'ready');assert.equal(next.connection.report.plan.permission,'none');cases++;
  assert.deepEqual(effects(),beforeEffects,'record/resume: no key reads, approval, owner, app, provider or rerun');cases++;
  let saved=readFileSync(receiptFile);
  for(const change of [{attemptId:randomUUID()},{executionBasisId:randomUUID()},{credentialRevision:'2099-01-01T00:00:00.000Z'}]){refuse(observe({...receipt,...change}));assert.deepEqual(readFileSync(receiptFile),saved)}
  refuse(observe(receipt,'agent-observed','received'));refuse(observe(receipt,'human-reported','passed'));
  for(const extra of [['--note','arbitrary'],['--recipient','recipient@example.invalid'],['--service','clerk'],['--env','production'],['--artifact','dist/app.cjs']])refuse(observe(receipt,'agent-observed','passed',extra));
  const otherStore=new ConnectionStateStore(other,home),otherRef=connectionCredentialRef(other,'development');
  assert.equal(otherStore.saveIntent(selection).ok,true);const otherRegistration=otherStore.beginCredentialMutation(otherRef);assert.equal(otherRegistration.ok,true);assert.equal(otherStore.finishCredentialMutation(otherRef,otherRegistration.value,true),true);
  const otherAttempt=otherStore.beginLocalSession(otherStore.credentialRevision(otherRef),1000);assert.equal(otherAttempt.ok,true);assert.equal(otherStore.finishLocalSession(otherAttempt.value.attemptId,'exited',true,{execution:'possible',treeTermination:'confirmed'}),true);
  refuse(observe(receipt,'agent-observed','passed',[],other));assert.deepEqual(readFileSync(receiptFile),saved);
  for(const [name,directory] of [['local-session.lock',true],['lock',true],['credential-development.json.lock',true],['state.json.tmp',false],['credential-development.json.tmp',false],['local-session.json.tmp',false]]){
   const path=join(state,name);if(directory)mkdirSync(path);else writeFileSync(path,'synthetic uncertain metadata');
   refuse(observe(receipt));assert.deepEqual(readFileSync(receiptFile),saved);assert.ok(existsSync(path));rmSync(path,{recursive:true});
  }
  refuse(observe(receipt,'agent-observed','passed',[],project,'fsync'));assert.deepEqual(readFileSync(receiptFile),saved);
  refuse(observe(receipt,'agent-observed','passed',[],project,'cleanup'));assert.ok(existsSync(join(state,'lock')));rmSync(join(state,'lock'),{recursive:true});
  assert.equal(status().applicationReadiness,'not-verified');
  // A later explicit failure/unknown is another historical report, not replacement readiness.
  assert.equal(observe(receipt,'agent-observed','unknown').status,0);assert.equal(observe(receipt,'human-reported','not-received').status,0);cases++;
  // Selection rotation, including change-back, invalidates new recording without hiding history.
  assert.equal(store.saveIntent({...selection,destination:{kind:'vercel'}}).ok,true);refuse(observe(receipt));assert.equal(status().receiptRelation,'selection-changed');
  assert.equal(store.saveIntent(selection).ok,true);refuse(observe(receipt));assert.equal(status().receiptRelation,'selection-changed');cases++;
  register();refuse(observe(receipt));
  // New execution keeps prior reports, never rebinds them to its new opaque basis.
  assert.equal(local('run',['--artifact','dist/app.cjs','--max-seconds','10']).status,0);
  const second=status();assert.notEqual(second.receipt.executionBasisId,receipt.executionBasisId);assert.equal(second.observationHistory.entries[0].relation,'past-attempt');assert.equal(second.observationHistory.entries.at(-1).observations.length,0);refuse(observe(receipt));cases++;
  // A failed app is also a completed trial, not a successful feature or delivery.
  writeFileSync(join(project,'dist','app.cjs'),'process.exit(19);');
  const failure=local('run',['--artifact','dist/app.cjs','--max-seconds','10']);assert.equal(failure.status,1);assert.equal(JSON.parse(failure.stdout).status,'failed');
  const failedReceipt=status().receipt;assert.equal(observe(failedReceipt,'agent-observed','failed').status,0);assert.equal(observe(failedReceipt,'human-reported','unknown').status,0);assert.equal(status().applicationReadiness,'not-verified');cases++;
  const secondReceipt=failedReceipt;register();assert.equal(status().receiptRelation,'credential-changed');refuse(observe(secondReceipt));
  // No observation on unfinished, unknown, changed, non-started or unconfirmed teardown.
  for(const mode of ['unfinished','unknown','changed','not-started','unconfirmed']){
   const begun=store.beginLocalSession(store.credentialRevision(ref),5000);assert.equal(begun.ok,true);
   if(mode==='unfinished')refuse(observe(begun.value));
   const outcome=mode==='unknown'?'unknown':mode==='changed'?'changed':'exited';
   assert.equal(store.finishLocalSession(begun.value.attemptId,outcome,true,{execution:mode==='not-started'?'not-started':'possible',treeTermination:mode==='unconfirmed'?'unknown':'confirmed'}),true);
   if(mode!=='unfinished')refuse(observe(status().receipt));
  }
  // A backwards wall-clock correction cannot strand otherwise valid trial history.
  const clockAttempt=store.beginLocalSession(store.credentialRevision(ref),1000);assert.equal(clockAttempt.ok,true);
  const OriginalDate=Date,clock=Date.parse(clockAttempt.value.startedAt)-60000;
  try{globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[clock]))}static now(){return clock}};
   assert.equal(store.finishLocalSession(clockAttempt.value.attemptId,'exited',true,{execution:'possible',treeTermination:'confirmed'}),true);
  }finally{globalThis.Date=OriginalDate}
  const clockReceipt=status().receipt;assert.equal(clockReceipt.finishedAt,clockReceipt.startedAt);
  assert.equal(observe(clockReceipt,'agent-observed','passed',[],project,null,{AKC_TEST_CLOCK_MS:String(clock)}).status,0);cases++;
  const clockNext=run(['next','--json','--offline',project]);assert.equal(clockNext.status,0);assert.equal(JSON.parse(clockNext.stdout).localSession.observationHistory.status,'available');cases++;
  const afterClock=store.beginLocalSession(store.credentialRevision(ref),1000);assert.equal(afterClock.ok,true);
  assert.equal(store.finishLocalSession(afterClock.value.attemptId,'exited',true,{execution:'possible',treeTermination:'confirmed'}),true);
  assert.ok(status().observationHistory.entries.some(entry=>entry.receipt.attemptId===clockReceipt.attemptId&&entry.observations.length===1));cases++;
  // The schema-1 receipt stays untouched and never gains a synthetic execution basis.
  const legacy={...receipt};for(const name of ['executionBasisId','intentRevision','execution','treeTermination'])delete legacy[name];
  writeFileSync(receiptFile,JSON.stringify({schemaVersion:1,receipt:legacy}),{mode:0o600});saved=readFileSync(receiptFile);assert.equal(status().receiptRelation,'legacy-unbound');refuse(observe(receipt));assert.deepEqual(readFileSync(receiptFile),saved);cases++;
  // Corrupt payload cannot leak arbitrary text or become a successful observation.
  writeFileSync(receiptFile,JSON.stringify({schemaVersion:2,receipt:{...receipt,raw:canary+raw},observations:[],history:[]}),{mode:0o600});refuse(observe(receipt));assert.equal(status().observationHistory.status,'unavailable');
  writeFileSync(receiptFile,JSON.stringify({schemaVersion:1,receipt:legacy}),{mode:0o600});
  for(let i=0;i<22;i++){const b=store.beginLocalSession(store.credentialRevision(ref),1000);assert.equal(b.ok,true);assert.equal(store.finishLocalSession(b.value.attemptId,'exited',true,{execution:'possible',treeTermination:'confirmed'}),true)}
  assert.equal(status().observationHistory.entries.length,21);cases++;
  const rawMetadata=readFileSync(receiptFile,'utf8');for(const forbidden of [canary,raw,'artifactSha256','interpreterSha256','sourceFingerprint','recipient@','argv','dist/app.cjs'])assert.ok(!rawMetadata.includes(forbidden));cases++;
  assert.match(run(['--help']).stdout,/connection local observe/);cases++;
  const guidance=renderAgentProtocol('0.9.2');assert.match(guidance,/Expect next schemaVersion 13/);assert.match(guidance,/connection local observe/);assert.match(guidance,/human-reported and --outcome/);assert.match(guidance,/public 0\.9\.2 lacks this command/);cases++;
  console.log(`Local observations: ${cases} cases passed; real CLI synthetic run/report/offline resume, no effects during record/resume; native Windows and real delivery unverified.`);
 }finally{rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runLocalObservationTests();
