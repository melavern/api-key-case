import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {readClerkManagedReport} from '../dist/core/agent/clerk-managed-report.js';
import {ConnectionStateStore} from '../dist/core/agent/connection-state.js';
import {clerkCredentialRef} from '../dist/core/agent/connection-credential.js';
import {clerkManagedIntentFingerprint} from '../dist/core/agent/clerk-managed.js';
import {DeploymentHistory} from '../dist/core/deploy/history.js';
import {MemoryVault} from '../dist/core/vault/memory.js';
import {canonicalProjectRealpath} from '../dist/core/vault/naming.js';
import {buildNextReport} from '../dist/core/agent/next.js';

export async function runClerkManagedReportTests(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'akc-clerk-report-')));
 const version='12345678-1234-1234-1234-123456789abc',canary='synthetic-error-must-not-be-returned';
 let count=0;
 function fixture(){
  const dir=join(root,String(++count)),project=join(dir,'project'),home=join(dir,'home');
  for(const path of [dir,project,home])mkdirSync(path);
  const config=join(project,'wrangler.toml');writeFileSync(config,'[env.development]\nname="example-worker"\naccount_id="0123456789abcdef0123456789abcdef"\n');
  writeFileSync(join(project,'app.ts'),'process.env.CLERK_SECRET_KEY; process.env.CLERK_PUBLISHABLE_KEY;');
  writeFileSync(join(project,'.gitignore'),'.env\n.env.*\n!.env.example\n');
  const state=new ConnectionStateStore(project,home),history=new DeploymentHistory(project,home),ref=clerkCredentialRef(project,'development');
  const hash=createHash('sha256').update(canonicalProjectRealpath(project)).digest('hex');
  const metadata=join(home,'.api-key-case','connections',hash),historyDir=join(home,'.api-key-case','deployment-history',createHash('sha256').update(realpathSync.native(project)).digest('hex'));
  const f={dir,project,home,config,state,history,ref,metadata,historyDir,reads:0,present:true,onRead:null};
  f.select=(env='development')=>{assert.equal(state.saveClerkManagedIntent({service:'clerk',environment:env,route:'api-key-case-managed',destination:{kind:'cloudflare'},sendingDomain:null}).ok,true);};
  f.register=()=>{const begun=state.beginCredentialMutation(ref);assert.equal(begun.ok,true);assert.equal(state.finishCredentialMutation(ref,begun.value,true),true);};
  f.append=(outcome='completed',overrides={})=>{const id=history.beginClerkPreparation({ref,target:'cloudflare',destinationId:'a'.repeat(64),force:false,credentialRevision:state.credentialRevision(ref),intentFingerprint:clerkManagedIntentFingerprint(state.readClerkManagedIntent().value),preparationDestination:{accountId:'0123456789abcdef0123456789abcdef',worker:'example-worker'},...overrides});assert.ok(id);if(outcome!==null)assert.equal(history.finishClerkPreparation(id,outcome,outcome==='completed'?version:null),true);return id;};
  f.vault=new Proxy({}, {get(_target,key){assert.equal(key,'hasSecret','no other vault capability');return async exact=>{f.reads++;assert.deepEqual(exact,ref);await f.onRead?.();return f.present;};}});
  f.read=()=>readClerkManagedReport(project,{vault:f.vault,baseDir:home});
  return f;
 }
 function snapshot(f){
  const walk=dir=>readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
   const path=join(dir,entry.name);
   return entry.isDirectory()?[[path,'directory'],...walk(path)]:[[path,createHash('sha256').update(readFileSync(path)).digest('hex')]];
  });
  return JSON.stringify(walk(f.dir));
 }
 function interrupt(f,kind){
  const path=join(f.metadata,'credential-clerk-development.json');
  if(kind==='interrupted-pending'||kind==='cancelled-pending'){
   const begun=f.state.beginCredentialMutation(f.ref);assert.equal(begun.ok,true);
   if(kind==='cancelled-pending')assert.equal(f.state.finishCredentialMutation(f.ref,begun.value,false),true);
  }else if(kind==='slot-lock')mkdirSync(`${path}.lock`);
  else if(kind==='slot-tmp')writeFileSync(`${path}.tmp`,canary);
  else if(kind==='corrupt')writeFileSync(path,canary);
 }
 const interruptions=['interrupted-pending','cancelled-pending','slot-lock','slot-tmp','corrupt'];
 try{
  // An unsettled or unreadable record cannot be diagnosed as a missing key.
  for(const kind of interruptions)for(const present of [false,true]){
   const f=fixture();f.select();f.register();f.append();interrupt(f,kind);f.present=present;
   const before=snapshot(f),registration=f.state.readCredentialRegistration(f.ref);
   assert.equal(registration.status,kind==='cancelled-pending'?'available':'unavailable');
   if(kind==='cancelled-pending')assert.equal(registration.value.state,'pending');
   const closed=report=>{
    assert.equal(report.status,'selected');assert.equal(report.environment,'development');
    assert.deepEqual(report.registration,{presence:'unavailable',revision:'unverified'});
    assert.equal(report.configuration.status,'explicit-local');assert.equal(report.preparation.status,'version-recorded');
    assert.equal(report.preparation.versionId,version);assert.equal(report.preparation.registrationBasis,'unverified');
    assert.equal(report.nextStep,'review-credential');assert.equal(report.application,'not-checked');assert.equal(report.permission,'none');
    assert.ok(!/未登録/.test(report.summary));assert.ok(!JSON.stringify(report).includes(canary));
   };
   closed(await f.read());assert.equal(f.reads,0,kind);assert.equal(snapshot(f),before);
   for(let repeat=0;repeat<2;repeat++){
    const report=await buildNextReport(f.project,{offline:true,vault:f.vault,get adapters(){assert.fail('offline provider dependency');},licensePlan:'free',registryBaseDir:f.home,connectionBaseDir:f.home});
    closed(report.clerkManaged);assert.equal(report.schemaVersion,13);assert.equal(report.setup.stage,'review-deployment');
    assert.equal(report.connection.status,'inactive');assert.equal(report.clerkNative.status,'inactive');assert.deepEqual(report.secrets,[]);
    assert.ok(report.nextActions.some(a=>a.kind==='review-clerk-managed'&&a.step==='review-credential'));
    assert.ok(!report.nextActions.some(a=>['register-secret','remove-secret','register-connection-credential','complete-provider-native-setup','approve-deploy-destination'].includes(a.kind)));
    assert.ok(!JSON.stringify(report).includes(canary));assert.equal(f.reads,0,kind);assert.equal(snapshot(f),before);
   }
  }
  // Missing metadata is still a normal presence check, with an unverified revision.
  for(const settled of [false,true])for(const present of [false,true]){
   const f=fixture();f.select();if(settled)f.register();f.present=present;const before=snapshot(f),r=await f.read();
   assert.equal(r.status,'selected');assert.deepEqual(r.registration,{presence:present?'registered':'missing',revision:settled?'recorded':'unverified'});
   assert.equal(r.nextStep,settled&&present?'review-preparation':'review-credential');assert.equal(/未登録/.test(r.summary),!present);
   assert.equal(f.reads,1);assert.equal(snapshot(f),before);
  }
  // Compare the complete post-await read, including missing -> pending/unavailable.
  for(const settled of [false,true])for(const kind of interruptions){
   const f=fixture();f.select();if(settled)f.register();f.present=false;let changed;
   f.onRead=()=>{interrupt(f,kind);changed=snapshot(f);};
   const r=await f.read();assert.equal(r.status,'unavailable');assert.equal(r.issue,'inspection-changed');
   assert.equal(r.environment,null);assert.equal(r.registration.revision,'unverified');assert.equal(r.preparation.versionId,null);
   assert.ok(!/未登録/.test(r.summary));assert.ok(!JSON.stringify(r).includes(canary));assert.equal(f.reads,1);assert.equal(snapshot(f),changed);
  }
  {const f=fixture();const r=await f.read();assert.equal(r.status,'inactive');assert.equal(f.reads,0);}
  {const f=fixture();f.register();const r=await f.read();assert.equal(r.status,'not-selected');assert.equal(r.environment,null);assert.equal(f.reads,0);}
  {const f=fixture();f.select();f.present=false;const r=await f.read();assert.equal(r.registration.presence,'missing');assert.equal(r.nextStep,'review-credential');assert.equal(f.reads,1);}
  {const f=fixture();f.select();f.register();const r=await f.read();assert.equal(r.status,'selected');assert.equal(r.registration.presence,'registered');assert.equal(r.configuration.status,'explicit-local');assert.equal(r.preparation.status,'none-recorded');assert.equal(r.nextStep,'review-preparation');assert.match(r.summary,/キーの登録とローカル設定/);assert.equal(r.application,'not-checked');assert.equal(r.permission,'none');}
  {const f=fixture();f.select();f.register();f.append();const path=join(f.historyDir,'history.json'),before=readFileSync(path,'utf8');const r=await f.read();assert.equal(r.preparation.status,'version-recorded');assert.equal(r.preparation.versionId,version);assert.equal(r.preparation.registrationBasis,'unchanged-record');assert.equal(r.preparation.currentDestination,'unverified');assert.equal(r.nextStep,'review-application-observation');assert.equal(readFileSync(path,'utf8'),before);}
  for(const outcome of [null,'unknown','incomplete']){const f=fixture();f.select();f.register();f.append();f.append(outcome);const r=await f.read();assert.equal(r.preparation.status,'unknown');assert.equal(r.preparation.versionId,null);assert.equal(r.nextStep,'review-history');}
  {const f=fixture();f.select();f.register();f.append();const path=join(f.metadata,'credential-clerk-development.json'),record=JSON.parse(readFileSync(path,'utf8'));record.credential.updatedAt='2030-01-01T00:00:00.000Z';writeFileSync(path,JSON.stringify(record));const r=await f.read();assert.equal(r.preparation.status,'version-recorded');assert.equal(r.preparation.registrationBasis,'changed');assert.equal(r.nextStep,'review-credential');}
  {const f=fixture();f.select();f.register();f.append('completed',{intentFingerprint:'b'.repeat(64)});const r=await f.read();assert.equal(r.preparation.registrationBasis,'changed');assert.equal(r.nextStep,'review-credential');}
  {const f=fixture();f.select();f.register();f.append('completed',{ref:clerkCredentialRef(f.project,'preview')});const r=await f.read();assert.equal(r.preparation.status,'none-recorded');assert.equal(r.preparation.versionId,null);}
  {const f=fixture();f.select();f.register();f.append();const path=join(f.historyDir,'history.json'),record=JSON.parse(readFileSync(path,'utf8'));record.entries[0].connection.projectId='c'.repeat(16);writeFileSync(path,JSON.stringify(record));assert.equal((await f.read()).preparation.status,'history-unavailable');}
  {const f=fixture();f.select();f.register();f.append();writeFileSync(f.config,readFileSync(f.config,'utf8').replace('example-worker','changed-worker'));const r=await f.read();assert.equal(r.configuration.worker,'changed-worker');assert.equal(r.preparation.status,'version-recorded');assert.equal(r.preparation.currentDestination,'unverified');assert.equal(r.applicationObservation.reason,'prepared-target-changed');assert.equal(r.nextStep,'review-history');}
  {const f=fixture();f.select();f.register();f.append();mkdirSync(join(f.historyDir,'lock'));const before=readFileSync(join(f.historyDir,'history.json'),'utf8');const r=await f.read();assert.equal(r.preparation.status,'history-unavailable');assert.equal(r.preparation.issue,'lock-present');assert.equal(readFileSync(join(f.historyDir,'history.json'),'utf8'),before);}
  {const f=fixture();f.select();f.register();f.append();writeFileSync(join(f.historyDir,'history.json'),canary);const r=await f.read();assert.equal(r.preparation.status,'history-unavailable');assert.ok(!JSON.stringify(r).includes(canary));}
  {const f=fixture();f.select();f.register();f.onRead=()=>{throw Error(canary);};const r=await f.read();assert.equal(r.registration.presence,'unavailable');assert.equal(r.nextStep,'review-credential');assert.ok(!JSON.stringify(r).includes(canary));}
  {const f=fixture();f.select();f.register();f.onRead=()=>f.select('preview');const r=await f.read();assert.equal(r.issue,'inspection-changed');assert.equal(r.environment,null);assert.equal(r.preparation.versionId,null);}
  {const f=fixture();f.select();f.register();f.onRead=()=>writeFileSync(f.config,readFileSync(f.config,'utf8').replace('example-worker','changed-worker'));assert.equal((await f.read()).issue,'inspection-changed');}
  {const f=fixture();f.select();f.register();f.onRead=()=>{assert.ok(f.state.beginCredentialMutation(f.ref).ok);};assert.equal((await f.read()).issue,'inspection-changed');}
  {const f=fixture();f.select();writeFileSync(join(f.metadata,'clerk-managed.json'),canary);const r=await f.read();assert.equal(r.status,'unavailable');assert.equal(f.reads,0);assert.ok(!JSON.stringify(r).includes(canary));}
  {const f=fixture();f.select();mkdirSync(join(f.metadata,'lock'));const r=await f.read();assert.equal(r.status,'unavailable');assert.equal(f.reads,0);}
  {const f=fixture();f.select();f.register();rmSync(f.config);const r=await f.read();assert.equal(r.configuration.status,'unresolved');assert.equal(r.nextStep,'review-configuration');}
  {const f=fixture();f.select();f.register();f.append();const vault=new MemoryVault();await vault.setSecret(f.ref,'synthetic-no-output');const r=await buildNextReport(f.project,{vault,adapters:[],licensePlan:'free',registryBaseDir:f.home,connectionBaseDir:f.home});assert.equal(r.schemaVersion,13);assert.equal(r.clerkManaged.preparation.status,'version-recorded');assert.equal(r.setup.stage,'review-deployment');assert.ok(r.nextActions.some(a=>a.kind==='review-clerk-managed'&&a.step==='review-application-observation'));assert.ok(!r.nextActions.some(a=>a.kind==='register-secret'||a.kind==='remove-secret'));assert.equal(r.connection.status,'inactive');assert.equal(r.clerkNative.status,'inactive');assert.ok(!JSON.stringify(r).includes('synthetic-no-output'));}
  {const f=fixture();f.select();f.register();f.append();f.append(null);const path=join(f.historyDir,'history.json'),record=JSON.parse(readFileSync(path,'utf8'));record.entries.at(-1).startedAt='2020-01-01T00:00:00.000Z';writeFileSync(path,JSON.stringify(record));assert.equal((await f.read()).preparation.status,'unknown','append order, not wall-clock sorting');}
  {const f=fixture();f.select();f.register();mkdirSync(join(f.metadata,'credential-clerk-development.json.lock'));const r=await f.read();assert.equal(r.registration.revision,'unverified');assert.equal(r.nextStep,'review-credential');}
  {const f=fixture();f.select();writeFileSync(join(f.metadata,'clerk-managed.json.tmp'),canary);assert.equal((await f.read()).status,'unavailable');assert.equal(f.reads,0);}
  {const f=fixture();f.select();f.register();f.append();f.append(null);const vault=new MemoryVault();await vault.setSecret(f.ref,'synthetic-no-output');const r=await buildNextReport(f.project,{vault,adapters:[],licensePlan:'free',registryBaseDir:f.home,connectionBaseDir:f.home});assert.equal(r.clerkManaged.preparation.versionId,null);assert.ok(r.nextActions.some(a=>a.kind==='review-clerk-managed'&&a.step==='review-history'));assert.match(r.clerkManaged.summary,/再送せず/);}
  {const f=fixture();f.select();f.register();f.append('completed',{preparationDestination:undefined});const r=await f.read();assert.equal(r.applicationObservation.reason,'prepared-target-unrecorded');assert.equal(r.applicationObservation.preparation.worker,null);assert.equal(r.nextStep,'review-history');}
  console.log(`Clerk managed report: ${count} isolated cases passed; no provider or native operation.`);
 }finally{rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runClerkManagedReportTests();
