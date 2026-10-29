import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildNextReport} from '../dist/core/agent/next.js';
import {ConnectionStateStore} from '../dist/core/agent/connection-state.js';
import {clerkCredentialRef,connectionCredentialRef} from '../dist/core/agent/connection-credential.js';
import {clerkManagedIntentFingerprint} from '../dist/core/agent/clerk-managed.js';
import {DeploymentHistory} from '../dist/core/deploy/history.js';
import {renderAgentProtocol} from '../dist/core/agent/init.js';
import {connectionIntentFingerprint} from '../dist/core/agent/fingerprints.js';
import {readNativeApplicationEvidence,recordNativeInspection,recordNativeApplication} from '../dist/core/agent/native-observations.js';

export async function runNextOfflineTests(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'akc-next-offline-')));
 const canary='synthetic-private-error-wxyz',version='12345678-1234-1234-1234-123456789abc';
 const denied=['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'];
 const originals=Object.fromEntries(denied.map(name=>[name,childProcess[name]]));
 let childCalls=0,vaultUnexpected=0,dependencyCalls=0,count=0;
 try{
  const project=join(root,'project'),home=join(root,'home');mkdirSync(project);mkdirSync(home);
  writeFileSync(join(project,'.gitignore'),'.env\n.env.*\n!.env.example\n');
  writeFileSync(join(project,'app.ts'),'process.env.RESEND_API_KEY; process.env.CLERK_SECRET_KEY; process.env.CLERK_PUBLISHABLE_KEY;');
  writeFileSync(join(project,'wrangler.toml'),'[env.development]\nname="offline-worker"\naccount_id="0123456789abcdef0123456789abcdef"\n');
  const store=new ConnectionStateStore(project,home),ref=clerkCredentialRef(project,'development');
  const register=ref=>{const r=store.beginCredentialMutation(ref);assert.equal(r.ok,true);assert.equal(store.finishCredentialMutation(ref,r.value,true),true);};
  const selection={service:'clerk',environment:'development',route:'api-key-case-managed',destination:{kind:'cloudflare'},sendingDomain:null};
  assert.equal(store.saveClerkManagedIntent(selection).ok,true);register(ref);
  assert.equal(store.saveClerkNativeIntent({...selection,route:'provider-native',destination:{kind:'vercel'}}).ok,true);
  assert.equal(store.saveIntent({...selection,service:'resend',destination:{kind:'vercel'}}).ok,true);register(connectionCredentialRef(project,'development'));
  const history=new DeploymentHistory(project,home);
  const append=completed=>{const id=history.beginClerkPreparation({ref,target:'cloudflare',destinationId:'a'.repeat(64),force:false,credentialRevision:store.credentialRevision(ref),intentFingerprint:clerkManagedIntentFingerprint(store.readClerkManagedIntent().value)});assert.ok(id);if(completed)assert.equal(history.finishClerkPreparation(id,'completed',version),true);};append(true);
  let present=true,fail=false;const refs=[];
  const vault=new Proxy({}, {get(_target,key){if(key!=='hasSecret'){vaultUnexpected++;throw Error(canary);}return async ref=>{refs.push(ref);if(fail)throw Error(canary);return present;};}});
  const deps={offline:true,vault,licensePlan:'pro',registryBaseDir:home,connectionBaseDir:home};
  for(const name of ['adapters','inspectReadiness','connectionDestinationResolver'])Object.defineProperty(deps,name,{get(){dependencyCalls++;throw Error(canary);}});
  for(const name of denied)childProcess[name]=()=>{childCalls++;throw Error(canary);};syncBuiltinESMExports();
  const inspect=()=>buildNextReport(project,deps);
  const first=await inspect();count++;
  assert.deepEqual(first.inspection,{mode:'offline',provider:'not-inspected',vaultAvailability:'not-inspected',gitExposure:'not-inspected',gitIgnore:'not-inspected'});
  assert.equal(first.hygiene.gitignoreOk,null);assert.equal(first.schemaVersion,13);assert.equal(first.vault.status,'not-inspected');assert.deepEqual(first.targets,[]);assert.equal(first.guidedSetup,null);
  assert.equal(first.connection.report.environment,'development');assert.equal(first.connection.report.credential.status,'registered');assert.ok(['source-unresolved','destination-unresolved'].includes(first.connection.report.plan.reason));assert.equal(first.connection.report.plan.permission,'none');
  assert.equal(first.clerkNative.status,'selected');assert.equal(first.clerkNative.configuration,'not-inspected');
  assert.equal(first.clerkManaged.preparation.versionId,version);assert.equal(first.clerkManaged.preparation.currentDestination,'unverified');assert.equal(first.clerkManaged.application,'not-checked');
  assert.ok(refs.some(r=>r.service==='clerk'&&r.environment==='development'));assert.ok(refs.some(r=>r.service==='resend'&&r.environment==='development'));
  assert.ok(!refs.some(r=>r.environment&&r.environment!=='development'));
  const forbidden=['fix-gitignore','enable-vault','install-target-cli','authenticate-target-cli','register-secret','register-connection-credential','check-resend-credential','complete-provider-native-setup','approve-deploy-destination','remove-secret'];
  const closed=r=>{if(r.connection.report)assert.equal(r.connection.report.plan.permission,'none');assert.ok(!r.nextActions.some(a=>forbidden.includes(a.kind)));assert.ok(!JSON.stringify(r).includes(canary));};closed(first);
  present=false;const missing=await inspect();count++;assert.equal(missing.connection.report.credential.status,'missing');assert.equal(missing.connection.report.stage,'acquire-credential');assert.ok(missing.connection.report.recovery.some(r=>r.action==='register-environment-credential'));assert.equal(missing.connection.report.plan.permission,'none');assert.equal(missing.clerkManaged.registration.presence,'missing');closed(missing);assert.equal(missing.setup.stage,'review-deployment');
  fail=true;const unavailable=await inspect();count++;assert.equal(unavailable.connection.report.credential.status,'unavailable');assert.equal(unavailable.clerkManaged.registration.presence,'unavailable');assert.equal(unavailable.vault.status,'not-inspected');closed(unavailable);
  fail=false;present=true;append(false);const interrupted=await inspect();count++;assert.equal(interrupted.clerkManaged.preparation.status,'unknown');assert.equal(interrupted.clerkManaged.preparation.versionId,null);assert.match(interrupted.clerkManaged.summary,/再送せず/);closed(interrupted);
  writeFileSync(join(project,'app.ts'),'export const noScannedKey = true;');const explicit=await inspect();count++;assert.equal(explicit.connection.status,'selected','saved Resend intent stays visible without scanned use');
  assert.equal(childCalls,0);assert.equal(vaultUnexpected,0);assert.equal(dependencyCalls,0);
  for(const name of denied)childProcess[name]=originals[name];syncBuiltinESMExports();
  let availability=0,adapterInspections=0;const online=await buildNextReport(project,{vault:{isAvailable:async()=>{availability++;return false;},hasSecret:async()=>true},adapters:[{id:'vercel',detect:async()=>{adapterInspections++;return false;},checkCli:async()=>({installed:false,loggedIn:false})}],licensePlan:'free',registryBaseDir:home,connectionBaseDir:home,inspectReadiness:async()=>[]});count++;
  assert.equal(availability,1);assert.equal(adapterInspections,1);assert.equal('inspection' in online,false);assert.equal(online.vault.status,'unavailable');assert.equal(online.targets.length,1);
  // Actual CLI in an owned copy: mock only native keyring, deny every child API.
  const checkout=join(root,'checkout');mkdirSync(checkout);writeFileSync(join(checkout,'package.json'),'{"type":"module"}');
  cpSync(fileURLToPath(new URL('../dist',import.meta.url)),join(checkout,'dist'),{recursive:true});
  const modules=join(checkout,'node_modules');mkdirSync(modules);
  const sourceModules=realpathSync(fileURLToPath(new URL('../node_modules',import.meta.url)));
  for(const name of readdirSync(sourceModules))if(name!=='@napi-rs'&&!name.startsWith('.'))symlinkSync(join(sourceModules,name),join(modules,name),process.platform==='win32'?'junction':'dir');
  const mock=join(modules,'@napi-rs','keyring');mkdirSync(mock,{recursive:true});
  writeFileSync(join(mock,'package.json'),'{"name":"@napi-rs/keyring","main":"index.cjs"}');
  writeFileSync(join(mock,'index.cjs'),`exports.Entry=class {getPassword(){return null}setPassword(){throw Error('${canary}')}deleteCredential(){throw Error('${canary}')}};`);
  const preload=join(root,'deny-child.mjs'),marker=join(root,'unexpected-child');
  writeFileSync(preload,`import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';import{writeFileSync}from'node:fs';for(const n of ${JSON.stringify(denied)})cp[n]=()=>{writeFileSync(${JSON.stringify(marker)},n);throw Error('${canary}')};syncBuiltinESMExports();`);
  const run=args=>originals.spawnSync(process.execPath,['--import',pathToFileURL(preload).href,join(checkout,'dist','cli','index.js'),...args],{cwd:project,env:{...process.env,HOME:home,USERPROFILE:home,DO_NOT_TRACK:'1'},encoding:'utf8',timeout:15000});
  const actual=run(['next','--json','--offline']);assert.equal(actual.status,0,actual.stderr);const result=JSON.parse(actual.stdout);assert.equal(result.inspection.mode,'offline');closed(result);count++;
  assert.throws(()=>readFileSync(marker));
  for(const args of [['next','--json','--offline','--offline'],['next','--offline'],['next','--json','--offline','--force']]){assert.equal(run(args).status,1);count++;}
  // Real compiled CLI: native history supplies the next work without a generic resolver.
  const nativeProject=join(root,'native-project'),nativeHome=join(root,'native-home');mkdirSync(nativeProject);mkdirSync(nativeHome);mkdirSync(join(nativeProject,'.vercel'));
  const linked=join(nativeProject,'.vercel','project.json');writeFileSync(linked,JSON.stringify({orgId:'team_fixture',projectId:'prj_fixture'}));
  const nativeStore=new ConnectionStateStore(nativeProject,nativeHome);
  assert.equal(nativeStore.saveIntent({service:'resend',environment:'development',route:'provider-native',destination:{kind:'vercel'},sendingDomain:null}).ok,true);
  const selected=nativeStore.readIntent().value,nativeScope=readNativeApplicationEvidence(nativeProject,'resend',nativeHome);
  const inspection=recordNativeInspection(nativeProject,{schemaVersion:1,service:'resend',environment:'development',destination:'vercel',status:'inspected',reason:'inspected',
    configuration:'integration-managed',configurationFingerprint:'a'.repeat(64),intentFingerprint:connectionIntentFingerprint(selected),destinationSelectionFingerprint:nativeScope.destinationSelectionFingerprint,
    observedAt:new Date().toISOString(),integrationIdentity:'unverified',credentialValidity:'not-checked',application:'not-checked',permission:'none'},600,nativeHome);
  assert.equal(inspection.status,'recorded');
  assert.equal(recordNativeApplication(nativeProject,{service:'resend',environment:'development',inspectionId:inspection.receiptId,feature:'send-and-delivery',observer:'human',outcome:'passed',maxAgeSeconds:300},nativeHome).status,'recorded');
  const effects=join(root,'native-effects.json'),readonly=join(root,'native-readonly.cjs');
  writeFileSync(join(mock,'index.cjs'),`exports.Entry=class {constructor(){globalThis.nativeEffects.vault++;throw Error('forbidden store')}};`);
  writeFileSync(join(mock,'package.json'),'{"name":"@napi-rs/keyring","main":"index.cjs"}');
  writeFileSync(readonly,`const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net'),http=require('node:http'),https=require('node:https');const save=fs.writeFileSync;const effects=globalThis.nativeEffects={writes:0,children:0,network:0,vault:0,native:0};const deny=n=>()=>{effects[n]++;throw Error('forbidden effect')};for(const n of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync','rmSync','chmodSync'])fs[n]=deny('writes');for(const n of ${JSON.stringify(denied)})cp[n]=deny('children');net.Socket.prototype.connect=net.connect=net.createConnection=deny('network');http.get=http.request=https.get=https.request=globalThis.fetch=deny('network');process.dlopen=deny('native');require('node:module').syncBuiltinESMExports();process.on('exit',()=>save(${JSON.stringify(effects)},JSON.stringify(effects)));`);
  const invokeNative=args=>originals.spawnSync(process.execPath,[join(checkout,'dist','cli','index.js'),...args,nativeProject],{encoding:'utf8',timeout:15000,
    env:{HOME:nativeHome,USERPROFILE:nativeHome,DO_NOT_TRACK:'1',PATH:'',NODE_OPTIONS:`--require=${readonly}`,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{})}});
  const nativeSnapshot=()=>JSON.stringify(readdirSync(nativeHome,{recursive:true}).sort().flatMap(name=>{const path=join(nativeHome,name);try{return [[name,createHash('sha256').update(readFileSync(path)).digest('hex')]];}catch(error){if(error.code==='EISDIR'||error.code==='EPERM')return [];throw error;}}));
  let beforeNative=nativeSnapshot();const readNative=()=>{
    const result=invokeNative(['next','--json','--offline']);assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout);
    assert.equal(report.schemaVersion,13);assert.notEqual(report.connection.report.stage,'ready');assert.equal(report.connection.report.applicationCheck.reason,'observation-missing');
    assert.equal(report.connection.report.plan.permission,'none');assert.equal(report.connection.report.plan.execution,'unsupported');
    assert.deepEqual(report.connection.report.recovery,[],'supported native advice must use nativeApplicationObservation.remaining, not generic resolver waits');
    assert.equal(report.connection.report.nativeApplicationObservation.currentHealth,'unverified');assert.equal(report.connection.report.nativeApplicationObservation.permission,'none');
    assert.deepEqual(JSON.parse(readFileSync(effects)),{writes:0,children:0,network:0,vault:0,native:0});assert.equal(nativeSnapshot(),beforeNative);return report.connection.report;
  };
  const nativeRestored=readNative();assert.equal(nativeRestored.nativeApplicationObservation.status,'reported');assert.equal(nativeRestored.nativeApplicationObservation.application.authority,'human-reported');assert.deepEqual(nativeRestored.nativeApplicationObservation.remaining,[]);count++;
  writeFileSync(linked,JSON.stringify({orgId:'team_other',projectId:'prj_other'}));
  const changedNative=readNative();assert.equal(changedNative.nativeApplicationObservation.status,'stale');assert.deepEqual(changedNative.nativeApplicationObservation.remaining,['review-selected-target']);count++;
  const generic=invokeNative(['connection','plan','--service','resend','--env','development','--json']);assert.equal(generic.status,0,generic.stderr);const genericPlan=JSON.parse(generic.stdout);
  assert.equal(genericPlan.status,'unknown');assert.equal(genericPlan.reason,'source-unresolved');assert.ok(genericPlan.recovery.some(item=>item.action==='await-destination-resolver'));
  assert.equal(genericPlan.permission,'none');assert.equal(nativeSnapshot(),beforeNative);assert.deepEqual(JSON.parse(readFileSync(effects)),{writes:0,children:0,network:0,vault:0,native:0});count++;
  assert.equal(nativeStore.saveIntent({service:'resend',environment:'preview',route:'provider-native',destination:{kind:'vercel'},sendingDomain:null}).ok,true);beforeNative=nativeSnapshot();
  const missingNative=readNative();assert.equal(missingNative.nativeApplicationObservation.status,'missing');assert.deepEqual(missingNative.nativeApplicationObservation.remaining,['inspect-existing-native-configuration']);count++;
  assert.equal(nativeStore.saveIntent({service:'resend',environment:'preview',route:'provider-native',destination:{kind:'cloudflare'},sendingDomain:null}).ok,true);beforeNative=nativeSnapshot();
  const unsupported=invokeNative(['next','--json','--offline']);assert.equal(unsupported.status,0,unsupported.stderr);const unsupportedReport=JSON.parse(unsupported.stdout).connection.report;
  assert.equal(unsupportedReport.nativeApplicationObservation,undefined);assert.ok(unsupportedReport.recovery.some(item=>item.action==='await-destination-resolver'));
  assert.notEqual(unsupportedReport.stage,'ready');assert.equal(nativeSnapshot(),beforeNative);assert.deepEqual(JSON.parse(readFileSync(effects)),{writes:0,children:0,network:0,vault:0,native:0});count++;
  const guidance=renderAgentProtocol('0.9.2');assert.match(guidance,/next --json --offline/);assert.match(guidance,/Public 0\.9\.2 does not support this flag/);assert.match(guidance,/Nested connection stage and recovery describe advisory next work/);assert.match(guidance,/legacy project\/user presence/);count++;
  assert.match(guidance,/follow connection\.report\.nativeApplicationObservation\.remaining instead of waiting for this generic resolver/);count++;
  console.log(`Next offline: ${count} cases passed; zero provider/child/probe calls, online behavior retained.`);
 }finally{for(const name of denied)childProcess[name]=originals[name];syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runNextOfflineTests();
