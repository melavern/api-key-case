import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildNextReport} from '../dist/core/agent/next.js';
import {ConnectionStateStore} from '../dist/core/agent/connection-state.js';
import {connectionCredentialRef} from '../dist/core/agent/connection-credential.js';
import {inspectHostReadiness} from '../dist/core/agent/readiness.js';
import {toAccount} from '../dist/core/vault/naming.js';
import {projectLocalDevelopment} from '../dist/core/agent/local-development.js';

// Synthetic host facts exercise advisory branches; no Windows/native/app acceptance.
const supported=inspectHostReadiness({platform:'win32',osRelease:'10.0.26200',helperAvailable:true});
const denied=['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'];
export async function runLocalNextTests(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'akc-local-next-'))),evidence=process.env.AKC_LOCAL_NEXT_EVIDENCE_DIR;
 const originals=Object.fromEntries(denied.map(n=>[n,cp[n]]));let cases=0,children=0,unexpectedVault=0,provider=0;
 const fixtures=[];if(evidence)mkdirSync(evidence,{recursive:true});
 const snapshot=dir=>readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(d=>d.isDirectory()?snapshot(join(dir,d.name)):[[join(dir,d.name),createHash('sha256').update(readFileSync(join(dir,d.name))).digest('hex')]]);
 function fixture(){
  const dir=join(root,`case-${fixtures.length}`),project=join(dir,'project'),home=join(dir,'home');mkdirSync(project,{recursive:true});mkdirSync(home);
  writeFileSync(join(project,'app.ts'),'process.env.RESEND_API_KEY; // never executed');
  const store=new ConnectionStateStore(project,home),ref=connectionCredentialRef(project,'development'),slots=new Set();
  const selection={service:'resend',environment:'development',route:'api-key-case-managed',destination:{kind:'local'},sendingDomain:null};
  const vault={hasSecret:async r=>slots.has(toAccount(r)),isAvailable:async()=>{unexpectedVault++;throw Error('No probe');}};
  const f={dir,project,home,store,ref,slots,selection,vault,
   select:overrides=>assert.equal(store.saveIntent({...selection,...overrides}).ok,true),
   register:(r=ref)=>{const x=store.beginCredentialMutation(r);assert.equal(x.ok,true);assert.equal(store.finishCredentialMutation(r,x.value,true),true);slots.add(toAccount(r));},
   attempt:(outcome='exited',lifecycle={execution:'possible',treeTermination:'confirmed'})=>{const x=store.beginLocalSession(store.credentialRevision(ref),1000);assert.equal(x.ok,true);if(outcome!==null)assert.equal(store.finishLocalSession(x.value.attemptId,outcome,true,lifecycle),true);return x.value;},
   observe:(a,authority,outcome)=>assert.equal(store.recordLocalSessionObservation({service:'resend',environment:'development',attemptId:a.attemptId,executionBasisId:a.executionBasisId,credentialRevision:a.credentialRevision,authority,outcome}).ok,true),
   inspect:(extra={})=>{const deps={offline:true,vault,licensePlan:'free',registryBaseDir:home,connectionBaseDir:home,hostReadiness:supported,...extra};
    for(const n of ['adapters','inspectReadiness','connectionDestinationResolver'])Object.defineProperty(deps,n,{get(){provider++;throw Error('No provider');}});
    return buildNextReport(project,deps);},
   stateDir:()=>join(home,'.api-key-case','connections',readdirSync(join(home,'.api-key-case','connections'))[0])};fixtures.push(f);return f;
 }
 async function check(f,step,label,extra={}){
  const before=snapshot(f.home),r=await f.inspect(extra);assert.equal(r.schemaVersion,13);assert.equal(r.localDevelopment.nextStep,step,label);
  assert.deepEqual(r.localDevelopment.preparation,{build:'not-inspected',inspection:'not-inspected'});
  assert.equal(r.localDevelopment.permission,'none');assert.equal(r.localDevelopment.applicationReadiness,'not-verified');assert.notEqual(r.connection.report?.stage,'ready');
  if(r.localDevelopment.trialObservations){assert.deepEqual(Object.keys(r.localDevelopment.trialObservations).sort(),['agent','attemptId','human']);assert.equal(r.localDevelopment.trialObservations.attemptId,r.localSession.receipt.attemptId);}
  assert.deepEqual(r.nextActions.filter(a=>a.kind==='review-local-development'),[{actor:'agent',kind:'review-local-development',step}]);
  assert.ok(!r.nextActions.some(a=>['register-secret','register-connection-credential','check-resend-credential','review-destination-setup','approve-deploy-destination'].includes(a.kind)));
  if(!label?.endsWith('race'))assert.deepEqual(snapshot(f.home),before,'reading continuation preserves existing metadata');cases++;
  if(evidence&&label)writeFileSync(join(evidence,label+'.json'),JSON.stringify(r,null,2));return r;
 }
 try{
  for(const n of denied)cp[n]=()=>{children++;throw Error('No child');};syncBuiltinESMExports();
  {const f=fixture();const r=await f.inspect();assert.equal(r.localDevelopment,null);cases++;}
  for(const destination of ['vercel','cloudflare','github','manual']){const f=fixture();f.select({destination:{kind:destination}});assert.equal((await f.inspect()).localDevelopment,null);cases++;}
  {const f=fixture();f.select();f.register();const r=await check(f,'prepare-and-inspect','prepare');assert.equal(r.localDevelopment.support,'reviewable');assert.equal(r.localDevelopment.credential,'registered');assert.equal(r.localDevelopment.previousAttempt,'none');assert.equal(r.secrets[0].status,'missing','v1 missing is independent of registered v2');}
  {const f=fixture();f.select();const r=await check(f,'review-credential-input','missing');assert.equal(r.localDevelopment.credential,'missing');assert.equal(r.guidedSetup,null);}
  {const f=fixture();f.select();f.register(connectionCredentialRef(f.project,'production'));const r=await check(f,'review-credential-input','other-environment');assert.equal(r.localDevelopment.credential,'missing');}
  {const f=fixture();f.select();f.slots.add(toAccount(f.ref));const r=await check(f,'review-credential-state','revision-unresolved');assert.equal(r.localDevelopment.credential,'registered');assert.equal(r.localDevelopment.registrationRevision,'unresolved');}
  {const f=fixture();f.select();const x=f.store.beginCredentialMutation(f.ref);assert.equal(x.ok,true);await check(f,'review-credential-state','pending-credential');}
  {const f=fixture();f.select();f.register();await check(f,'review-credential-state','presence-unavailable',{vault:{...f.vault,hasSecret:async()=>{throw Error('synthetic-error-no-output');}}});}
  for(const env of ['preview','production']){const f=fixture();f.select({environment:env});const r=await check(f,'review-host-support',`unsupported-${env}`);assert.equal(r.localDevelopment.support,'unsupported-selection');}
  for(const route of ['manual','provider-native']){const f=fixture();f.select({route});const r=await check(f,'review-host-support',`unsupported-${route}`);assert.equal(r.localDevelopment.support,'unsupported-selection');}
  for(const host of [inspectHostReadiness({platform:'linux'}),inspectHostReadiness({platform:'darwin',helperAvailable:true}),inspectHostReadiness({platform:'win32',osRelease:'10.0.19000',helperAvailable:true}),inspectHostReadiness({platform:'win32',osRelease:'10.0.26200',helperAvailable:false})]){
   const f=fixture();f.select();f.register();await check(f,'review-host-support',null,{hostReadiness:host});
  }
  {const f=fixture();f.select();f.register();mkdirSync(join(f.stateDir(),'local-session.lock'));await check(f,'review-previous-attempt','lock-without-receipt');}
  {const f=fixture();f.select();f.register();f.attempt(null);await check(f,'review-previous-attempt','unfinished');}
  {const f=fixture();f.select();f.register();f.attempt('unknown',{execution:'possible',treeTermination:'unknown'});await check(f,'review-previous-attempt','unknown');}
  {const f=fixture();f.select();f.register();f.attempt('exited',{execution:'possible',treeTermination:'unknown'});await check(f,'review-previous-attempt','teardown-unknown');}
  {const f=fixture();f.select();f.register();const a=f.attempt();const r=await check(f,'review-application-observation','ended-unobserved');assert.equal(r.localDevelopment.previousAttempt,'ended');assert.deepEqual(r.localDevelopment.trialObservations,{attemptId:a.attemptId,agent:'not-reported',human:'not-reported'});assert.equal(r.localSession.observationHistory.entries[0].observations.length,0);}
  {const f=fixture();f.select();f.register();const a=f.attempt();for(const [authority,outcome] of [['agent-observed','passed'],['human-reported','received']])assert.equal(f.store.recordLocalSessionObservation({service:'resend',environment:'development',attemptId:a.attemptId,executionBasisId:a.executionBasisId,credentialRevision:a.credentialRevision,authority,outcome}).ok,true);
   const r=await check(f,'review-trial-observations','ended-observed');assert.equal(r.localSession.observationHistory.entries[0].observations.length,2);
   writeFileSync(join(f.project,'app.ts'),'process.env.RESEND_API_KEY; // changed source, never executed');await check(f,'review-trial-observations','source-edited');
   await check(f,'review-trial-observations','ended-on-linux',{hostReadiness:inspectHostReadiness({platform:'linux'})});}
  {const f=fixture();f.select();f.register();const a=f.attempt();f.observe(a,'agent-observed','passed');f.observe(a,'human-reported','received');const before=snapshot(f.home),selection=f.store.readIntent().value;
   f.select();assert.deepEqual(f.store.readIntent().value,selection);assert.deepEqual(snapshot(f.home),before);
   const r=await check(f,'review-trial-observations','identical-selection');assert.equal(r.localSession.receipt.attemptId,a.attemptId);assert.equal(r.localSession.observationHistory.entries[0].observations.length,2);assert.equal(r.localDevelopment.trialObservations.agent,'passed');assert.equal(r.localDevelopment.trialObservations.human,'received');}
  {const f=fixture();f.select();f.register();f.attempt('failed');const r=await check(f,'review-application-observation','ended-failed');assert.equal(r.localSession.status,'failed');assert.equal(r.localDevelopment.trialObservations.agent,'not-reported');}
  {const f=fixture();f.select();f.register();f.attempt('cancelled',{execution:'not-started',treeTermination:'not-needed'});await check(f,'review-unstarted-attempt','not-launched');}
  for(const outcome of ['changed','expired','cancelled']){const f=fixture();f.select();f.register();f.attempt(outcome);await check(f,'review-previous-attempt',`interrupted-${outcome}`);}
  {const f=fixture();f.select();f.register();f.attempt();f.select({destination:{kind:'github'}});f.select();const r=await check(f,'review-selection-change','selection-changed');assert.equal(r.localDevelopment.previousAttempt,'selection-changed');}
  {const f=fixture();f.select();f.register();f.attempt();f.register();const r=await check(f,'review-selection-change','credential-changed');assert.equal(r.localDevelopment.previousAttempt,'credential-changed');}
  {const f=fixture();f.select();f.register();const a=f.attempt();const receipt={...a,finishedAt:new Date().toISOString(),outcome:'exited'};for(const n of ['executionBasisId','intentRevision','execution','treeTermination'])delete receipt[n];writeFileSync(join(f.stateDir(),'local-session.json'),JSON.stringify({schemaVersion:1,receipt}),{mode:0o600});const r=await check(f,'review-selection-change','legacy-unbound');assert.equal(r.localDevelopment.previousAttempt,'legacy-unbound');}
  {const f=fixture();f.select();f.register();writeFileSync(join(f.stateDir(),'local-session.json'),'invalid synthetic data',{mode:0o600});await check(f,'review-local-state','invalid-session');}
  {const f=fixture();f.select();f.register();writeFileSync(join(f.stateDir(),'observations.json'),'invalid synthetic data',{mode:0o600});await check(f,'review-local-state','invalid-history');}
  {const f=fixture();f.select();f.register();let changed=false;const vault={...f.vault,hasSecret:async r=>{if(r.service==='resend'&&!changed){changed=true;f.attempt();}return f.slots.has(toAccount(r));}};await check(f,'review-local-state','session-race',{vault});}
  {const f=fixture();f.select();f.register();let changed=false;const vault={...f.vault,hasSecret:async r=>{if(r.service==='resend'&&!changed){changed=true;f.select({environment:'production'});}return f.slots.has(toAccount(r));}};const r=await check(f,'review-local-state','selection-race',{vault});assert.equal(r.localDevelopment.credential,'unavailable');}
  {const f=fixture();f.select();f.register();let reads=0;const r=await check(f,'review-credential-state','presence-race',{vault:{...f.vault,hasSecret:async r=>r.service==='resend'?++reads===1:false}});assert.equal(r.localDevelopment.credential,'unavailable');}
  for(const [reports,agent,human,step] of [
   [[['agent-observed','passed']],'passed','not-reported','review-trial-observations'],
   [[['agent-observed','failed']],'failed','not-reported','review-trial-observations'],
   [[['agent-observed','unknown']],'unknown','not-reported','review-trial-observations'],
   [[['human-reported','received']],'not-reported','received','review-application-observation'],
   [[['human-reported','not-received']],'not-reported','not-received','review-application-observation'],
   [[['human-reported','unknown']],'not-reported','unknown','review-application-observation'],
   [[['agent-observed','passed'],['human-reported','received']],'passed','received','review-trial-observations'],
   [[['agent-observed','failed'],['human-reported','received']],'failed','received','review-trial-observations'],
   [[['agent-observed','passed'],['human-reported','not-received']],'passed','not-received','review-trial-observations'],
   [[['agent-observed','passed'],['agent-observed','passed']],'passed','not-reported','review-trial-observations'],
   [[['agent-observed','passed'],['agent-observed','failed']],'mixed','not-reported','review-mixed-observations'],
   [[['agent-observed','unknown'],['agent-observed','passed']],'mixed','not-reported','review-mixed-observations'],
   [[['human-reported','not-received'],['human-reported','received']],'not-reported','mixed','review-mixed-observations'],
   [[['human-reported','unknown'],['human-reported','received']],'not-reported','mixed','review-mixed-observations']
  ]){const f=fixture();f.select();f.register();const a=f.attempt();for(const [authority,outcome]of reports)f.observe(a,authority,outcome);const r=await check(f,step);assert.deepEqual(r.localDevelopment.trialObservations,{attemptId:a.attemptId,agent,human});assert.ok(!r.nextActions.some(a=>a.actor==='human'),'historical observation review creates no mandatory repeat user action');}
  {const f=fixture();f.select();f.register();const old=f.attempt();f.observe(old,'agent-observed','passed');f.observe(old,'human-reported','received');const latest=f.attempt();const r=await check(f,'review-application-observation','new-trial-no-inherited-pass');assert.deepEqual(r.localDevelopment.trialObservations,{attemptId:latest.attemptId,agent:'not-reported',human:'not-reported'});assert.equal(r.localSession.observationHistory.entries[0].observations.length,2);}
  for(const changed of ['selection','credential','lock']){const f=fixture();f.select();f.register();const a=f.attempt();f.observe(a,'agent-observed','passed');if(changed==='selection')f.select({sendingDomain:'changed.example.com'});else if(changed==='credential')f.register();else mkdirSync(join(f.stateDir(),'local-session.lock'));const r=await check(f,changed==='lock'?'review-previous-attempt':'review-selection-change');assert.equal(r.localDevelopment.trialObservations,null);assert.equal(r.localSession.observationHistory.entries[0].observations.length,1);}
  {const f=fixture();f.select();f.register();const a=f.attempt();let changed=false;const vault={...f.vault,hasSecret:async r=>{if(r.service==='resend'&&!changed){changed=true;f.observe(a,'agent-observed','passed');}return f.slots.has(toAccount(r));}};const r=await check(f,'review-local-state','observation-race',{vault});assert.equal(r.localDevelopment.trialObservations,null);}
  {const f=fixture();f.select();f.register();const a=f.attempt();f.observe(a,'agent-observed','passed');const r=await f.inspect(),session=structuredClone(r.localSession);session.observationHistory.entries[0].receipt={...session.observationHistory.entries[0].receipt,outcome:'failed'};const report=projectLocalDevelopment({intent:f.store.readIntent().value,credential:'registered',credentialRevision:f.store.credentialRevision(f.ref),session,host:supported,stateCurrent:true});assert.equal(report.nextStep,'review-local-state');assert.equal(report.trialObservations,null);cases++;}
  assert.equal(children,0);assert.equal(unexpectedVault,0);assert.equal(provider,0);
  for(const n of denied)cp[n]=originals[n];syncBuiltinESMExports();
  // Real candidate CLI copied into an owned fixture. Native stores never load.
  const f=fixture();f.select();f.register();const a=f.attempt();for(const [authority,outcome] of [['agent-observed','passed'],['human-reported','received']])assert.equal(f.store.recordLocalSessionObservation({service:'resend',environment:'development',attemptId:a.attemptId,executionBasisId:a.executionBasisId,credentialRevision:a.credentialRevision,authority,outcome}).ok,true);
  const checkout=join(root,'owned-cli');mkdirSync(checkout);writeFileSync(join(checkout,'package.json'),JSON.stringify({name:'api-key-case',version:'0.9.2',type:'module',bin:{'api-key-case':'dist/cli/index.js'}}));cpSync(fileURLToPath(new URL('../dist',import.meta.url)),join(checkout,'dist'),{recursive:true});
  const modules=join(checkout,'node_modules'),sourceModules=realpathSync(fileURLToPath(new URL('../node_modules',import.meta.url)));mkdirSync(modules);for(const n of readdirSync(sourceModules))if(n!=='@napi-rs'&&!n.startsWith('.'))symlinkSync(join(sourceModules,n),join(modules,n),process.platform==='win32'?'junction':'dir');
  const fake=join(modules,'@napi-rs/keyring'),marker=join(root,'effects.json');mkdirSync(fake,{recursive:true});writeFileSync(marker,JSON.stringify({writes:0,children:0,probes:0,network:0}));
  writeFileSync(join(fake,'package.json'),'{"name":"@napi-rs/keyring","main":"index.cjs"}');writeFileSync(join(fake,'index.cjs'),`const fs=require('node:fs'),deny=()=>{const x=JSON.parse(fs.readFileSync(${JSON.stringify(marker)},'utf8'));x.writes++;fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(x));throw Error('No write')};exports.Entry=class{constructor(service,account){this.account=account}getPassword(){return this.account===${JSON.stringify(toAccount(f.ref))}?'synthetic-no-output':null}setPassword(){deny()}deleteCredential(){deny()}};`);
  const preload=join(root,'deny-effects.mjs'),entry=join(checkout,'dist/cli/index.js');writeFileSync(preload,`import cp from 'node:child_process';import fs from 'node:fs';import net from 'node:net';import http from 'node:http';import https from 'node:https';import{syncBuiltinESMExports}from'node:module';import{KeyringVault}from ${JSON.stringify(pathToFileURL(join(checkout,'dist/core/vault/keyring.js')).href)};const mark=${JSON.stringify(marker)},deny=n=>()=>{const x=JSON.parse(fs.readFileSync(mark,'utf8'));x[n]++;fs.writeFileSync(mark,JSON.stringify(x));throw Error('No effect')};KeyringVault.prototype.isAvailable=deny('probes');for(const n of ${JSON.stringify(denied)})cp[n]=deny('children');globalThis.fetch=deny('network');net.connect=deny('network');net.createConnection=deny('network');http.request=deny('network');http.get=deny('network');https.request=deny('network');https.get=deny('network');syncBuiltinESMExports();`);
  const env={...process.env,HOME:f.home,USERPROFILE:f.home,DO_NOT_TRACK:'1',NODE_OPTIONS:`--import=${pathToFileURL(preload).href}`};
  const run=args=>originals.spawnSync(process.execPath,[entry,...args],{cwd:f.project,env,encoding:'utf8',timeout:15000});
  const generated=run(['agent-init','--use-current-cli','--host','agents']);assert.equal(generated.status,0,generated.stderr);assert.equal(run(['agent-init','--use-current-cli','--host','agents','--check']).status,0);
  const before=snapshot(f.home),actual=run(['next','--json','--offline']);assert.equal(actual.status,0,actual.stderr);const r=JSON.parse(actual.stdout);
  assert.equal(r.schemaVersion,13);assert.equal(r.localDevelopment.nextStep,'review-trial-observations');assert.equal(r.localDevelopment.support,r.host.platform!=='windows'?'unsupported-host':r.host.approval!=='interaction-required'?'approval-unavailable':'reviewable');assert.equal(r.localSession.observationHistory.entries[0].observations.length,2);assert.equal(r.localSession.permission,'none');assert.equal(r.localSession.applicationReadiness,'not-verified');assert.deepEqual(snapshot(f.home),before);assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')),{writes:0,children:0,probes:0,network:0});assert.ok(!actual.stdout.includes('synthetic-no-output'));cases++;
  assert.deepEqual(r.localDevelopment.trialObservations,{attemptId:a.attemptId,agent:'passed',human:'received'});
  let finalCLI=actual;const latest=f.attempt();
  for(const mode of ['unreported','human-only','mixed']){if(mode==='human-only')f.observe(latest,'human-reported','received');if(mode==='mixed'){f.observe(latest,'agent-observed','passed');f.observe(latest,'agent-observed','failed');}const before=snapshot(f.home);finalCLI=run(['next','--json','--offline']);assert.equal(finalCLI.status,0,finalCLI.stderr);const report=JSON.parse(finalCLI.stdout);assert.equal(report.localDevelopment.nextStep,mode==='mixed'?'review-mixed-observations':'review-application-observation');assert.deepEqual(report.localDevelopment.trialObservations,{attemptId:latest.attemptId,agent:mode==='mixed'?'mixed':'not-reported',human:mode==='unreported'?'not-reported':'received'});assert.equal(report.localDevelopment.permission,'none');assert.equal(report.localDevelopment.applicationReadiness,'not-verified');assert.ok(!report.nextActions.some(a=>a.actor==='human'));assert.deepEqual(snapshot(f.home),before);assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')),{writes:0,children:0,probes:0,network:0});assert.ok(!finalCLI.stdout.includes('synthetic-no-output'));cases++;}
  if(evidence){writeFileSync(join(evidence,'fixture.json'),JSON.stringify({root,project:f.project,home:f.home,entry,preload,effects:marker},null,2));writeFileSync(join(evidence,'AGENTS.md'),readFileSync(join(f.project,'AGENTS.md')));writeFileSync(join(evidence,'actual-offline.json'),finalCLI.stdout);}
  console.log(`Local next continuation: ${cases} cases passed; current candidate CLI resume, zero writes/children/probes/network; no app/provider/native acceptance.`);
 }finally{for(const n of denied)cp[n]=originals[n];syncBuiltinESMExports();if(!evidence)rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runLocalNextTests();
