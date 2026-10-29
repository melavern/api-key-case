import assert from 'node:assert/strict';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,symlinkSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {clerkCredentialRef,connectionCredentialRef,runConnectionCredential,CLERK_CREDENTIAL_NATIVE_ACCEPTED} from '../dist/core/agent/connection-credential.js';
import {ConnectionStateStore} from '../dist/core/agent/connection-state.js';
import {toAccount} from '../dist/core/vault/naming.js';
import {MemoryVault} from '../dist/core/vault/memory.js';
import {runConnectionDeployment,runWithSecret} from '../dist/core/deploy/handoff.js';
import {DeploymentHistory} from '../dist/core/deploy/history.js';
import {renderAgentProtocol} from '../dist/core/agent/init.js';
import {buildNextReport} from '../dist/core/agent/next.js';
import {buildWindowsSecretInputScript,buildWindowsRemovalScript} from '../dist/core/human/windows.js';
import {buildMacOSSecretInputScript,buildMacOSRemovalScript} from '../dist/core/human/macos.js';

export async function runClerkCredentialTests(){
 const root=mkdtempSync(join(tmpdir(),'akc-clerk-slot-'));
 try {
  const project=join(root,'project'),home=join(root,'home');mkdirSync(project);mkdirSync(home);
  writeFileSync(join(project,'app.ts'),'process.env.CLERK_SECRET_KEY; process.env.CLERK_PUBLISHABLE_KEY; process.env.OPENAI_API_KEY;');
  const store=new ConnectionStateStore(project,home), vault=new MemoryVault();
  const refs=Object.fromEntries(['development','preview','production'].map(env=>[env,clerkCredentialRef(project,env)]));
  const resend=connectionCredentialRef(project,'development'),legacy={name:'CLERK_SECRET_KEY',scope:'project',projectId:resend.projectId};
  assert.equal(CLERK_CREDENTIAL_NATIVE_ACCEPTED,true);
  const guidance=renderAgentProtocol('0.9.2');
  for(const phrase of ['For this Vercel-native flow, do not duplicate keys','separate standalone registration foundation','next.connection remains Resend','save/remove use the accepted Windows Human Plane only'])assert.ok(guidance.includes(phrase));
  assert.ok(!guidance.includes('call credential save/check/remove or doctor for Clerk'));

  assert.equal(new Set([resend,legacy,...Object.values(refs)].map(toAccount)).size,5);
  assert.equal(toAccount(resend),`v2|credential|project|${resend.projectId}|resend|development|RESEND_API_KEY`);
  for(const ref of Object.values(refs))assert.equal(toAccount(ref),`v2|credential|project|${ref.projectId}|clerk|${ref.environment}|CLERK_SECRET_KEY`);
  for(const bad of [{...refs.development,name:'RESEND_API_KEY'},{...refs.development,name:'CLERK_PUBLISHABLE_KEY'},{...refs.development,service:'other'},{...refs.development,environment:'staging'}])assert.throws(()=>toAccount(bad));
  let touched=0;const forbidden=new Proxy({}, {get(){touched++;throw Error('synthetic-private-canary');}});
  const platformDescriptor=Object.getOwnPropertyDescriptor(process,'platform');
  try { for(const platform of ['linux','darwin']) {
    Object.defineProperty(process,'platform',{...platformDescriptor,value:platform});
    for(const operation of ['save','remove'])assert.equal((await runConnectionCredential(project,'development',operation,forbidden,false,'clerk')).status,'unavailable');
  }} finally { Object.defineProperty(process,'platform',platformDescriptor); }
  assert.equal(touched,0,'native gate before vault or dialog');
  const onlyPresence={vault:new Proxy({}, {get(_t,key){assert.equal(key,'hasSecret');return async ref=>{assert.equal(ref.service,'clerk');return false;};}})};
  assert.equal((await runConnectionCredential(project,'preview','check',onlyPresence,false,'clerk')).status,'missing');
  const failed=await runConnectionCredential(project,'preview','check',{vault:{hasSecret:async()=>{throw Error('synthetic-private-canary');}}},false,'clerk');
  assert.equal(failed.status,'unavailable');assert.ok(!JSON.stringify(failed).includes('canary'));
  await vault.setSecret(legacy,'synthetic-legacy');await vault.setSecret(resend,'synthetic-resend');
  assert.equal((await runConnectionCredential(project,'development','check',{vault},false,'clerk')).status,'missing');
  await assert.rejects(runWithSecret(vault,refs.development,{}));
  const blocked={ref:refs.development,get target(){touched++;throw Error('unexpected target');}};
  assert.equal(await runConnectionDeployment(blocked),'changed');assert.equal(touched,0);
  const history=new DeploymentHistory(project,home);
  assert.equal(history.beginConnection({ref:refs.development}),null);

  // Disposable compiled fixture exercises the Windows branch with fake UI/store only.
  const fixture=join(root,'fixture');mkdirSync(fixture);
  cpSync(fileURLToPath(new URL('../dist',import.meta.url)),join(fixture,'dist'),{recursive:true});
  symlinkSync(fileURLToPath(new URL('../node_modules',import.meta.url)),join(fixture,'node_modules'),'junction');
  writeFileSync(join(fixture,'package.json'),'{"type":"module"}');
  const file=join(fixture,'dist/core/agent/connection-credential.js');let source=readFileSync(file,'utf8');
  const guard='if (service === "clerk" && (!CLERK_CREDENTIAL_NATIVE_ACCEPTED || process.platform !== "win32"))';
  assert.equal(source.split(guard).length,2);writeFileSync(file,source.replace(guard,'if (false)'));
  const enabled=(await import(pathToFileURL(file).href)).runConnectionCredential;
  let decision='approved',save='saved',dialogs=0;
  const deps={vault,connectionBaseDir:home,humanPlane:{capability:()=> 'os-dialog',askSecret:async request=>{
   dialogs++;assert.equal(request.service,'clerk');assert.equal(request.name,'CLERK_SECRET_KEY');assert.equal(store.credentialRevision(request),null);
   if(save==='saved')await vault.setSecret(request,'synthetic-clerk-canary');return save;
  },askRemoval:async request=>{dialogs++;assert.equal(request.service,'clerk');return decision;}}};
  const run=(env,op,force=false)=>enabled(project,env,op,deps,force,'clerk');
  store.saveIntent({service:'resend',environment:'development',route:'api-key-case-managed',destination:{kind:'local'},sendingDomain:null});
  const savedResend=JSON.stringify(store.readIntent());const revision=store.beginCredentialMutation(resend);assert.equal(revision.ok,true);assert.equal(store.finishCredentialMutation(resend,revision.value,true),true);
  const resendRevision=store.credentialRevision(resend);
  for(const env of Object.keys(refs)){assert.equal((await run(env,'save')).status,'saved');assert.equal((await run(env,'check')).status,'registered');assert.ok(store.credentialRevision(refs[env]));}
  const count=dialogs;assert.equal((await run('development','save')).status,'already-registered');assert.equal(dialogs,count);
  const other=store.credentialRevision(refs.production);save='cancelled';assert.equal((await run('development','save',true)).status,'cancelled');assert.equal(await vault.hasSecret(refs.development),true);assert.equal(store.credentialRevision(refs.development),null);assert.equal(store.credentialRevision(refs.production),other);
  save='saved';assert.equal((await run('development','save',true)).status,'saved');
  decision='declined';assert.equal((await run('development','remove')).status,'cancelled');assert.equal(await vault.hasSecret(refs.development),true);assert.equal(store.credentialRevision(refs.development),null);
  decision='approved';assert.equal((await run('development','remove')).status,'removed');assert.equal(await vault.hasSecret(refs.development),false);assert.equal(await vault.hasSecret(refs.production),true);
  const pending=store.beginCredentialMutation(refs.preview);assert.equal(pending.ok,true);assert.equal((await run('preview','save',true)).status,'metadata-unavailable');assert.equal(new ConnectionStateStore(project,home).credentialRevision(refs.preview),null);assert.equal(store.finishCredentialMutation(refs.preview,pending.value,false),true);
  assert.equal(JSON.stringify(store.readIntent()),savedResend);assert.equal(store.credentialRevision(resend),resendRevision);assert.equal(await vault.hasSecret(resend),true);assert.equal(await vault.hasSecret(legacy),true);
  const guarded={isAvailable:async()=>true,hasSecret:async ref=>{assert.ok(!ref.name.startsWith('CLERK_'));return false;},backendName:'synthetic'};
  const next=()=>buildNextReport(project,{vault:guarded,adapters:[],licensePlan:'free',connectionBaseDir:home,registryBaseDir:home});
  let report=await next();assert.equal(report.schemaVersion,13);assert.equal(report.clerkNative.status,'inactive');assert.ok(!report.nextActions.some(a=>a.name?.startsWith('CLERK_')));assert.ok(report.nextActions.some(a=>a.name==='OPENAI_API_KEY'));
  function find(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory()){const f=find(p);if(f)return f;}else if(e.name==='credential-clerk-production.json')return p;}}
  const metadata=find(home);assert.ok(metadata);writeFileSync(metadata,'{}');report=await next();assert.ok(!report.nextActions.some(a=>a.name?.startsWith('CLERK_')));
  const blockedHome=join(root,'blocked-home');mkdirSync(blockedHome);const blockedStore=new ConnectionStateStore(project,blockedHome);
  blockedStore.saveIntent({service:'resend',environment:'development',route:'api-key-case-managed',destination:{kind:'local'},sendingDomain:null});
  function stateDir(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory()){const d=stateDir(p);if(d)return d;}else if(e.name==='state.json')return dirname(p);}}
  const location=stateDir(blockedHome);assert.ok(location);assert.equal(blockedStore.hasClerkRegistrationRecord(),false);
  const isolatedNext=()=>buildNextReport(project,{vault:guarded,adapters:[],licensePlan:'free',connectionBaseDir:blockedHome,registryBaseDir:blockedHome});
  for(const shape of ['directory','file','temporary',...(process.platform==='win32'?[]:['symlink'])]){
   const path=join(location,'credential-clerk-development.json'+(shape==='temporary'?'.tmp':'.lock'));
   if(shape==='directory')mkdirSync(path);else if(shape==='symlink')symlinkSync(join(root,'absent-owned-target'),path);else writeFileSync(path,'{}');
   assert.equal(blockedStore.hasClerkRegistrationRecord(),true,shape);const blockedReport=await isolatedNext();assert.ok(!blockedReport.nextActions.some(a=>a.name?.startsWith('CLERK_')),shape);
   rmSync(path,{recursive:shape==='directory'});
  }
  for(const [input,remove] of [[buildWindowsSecretInputScript,buildWindowsRemovalScript],[buildMacOSSecretInputScript,buildMacOSRemovalScript]]){
   const request={...refs.development,projectDir:project};assert.ok(input(request).includes(toAccount(refs.development)));for(const script of [input(request),remove({...request,kind:'secret'})]){assert.ok(script.includes('clerk'));assert.ok(!script.includes('synthetic-clerk-canary'));}
  }
  const handoff=join(fixture,'dist/core/deploy/handoff.js');source=readFileSync(handoff,'utf8');
  const platform='if (process.platform !== "win32")';assert.equal(source.split(platform).length,2);
  writeFileSync(handoff,source.replace(platform,'if (false)')+'\nexport {performLocalApplicationHandoff};\n');
  const inner=await import(pathToFileURL(handoff).href);
  assert.equal(await inner.runConnectionDeployment(blocked),'changed');
  const local=await inner.performLocalApplicationHandoff({ref:refs.development,get snapshot(){touched++;throw Error('unexpected snapshot');}});assert.equal(local.status,'unknown');assert.equal(touched,0);
  // The real Windows CLI supports this input. Unsupported-host refusal is
  // meaningful only elsewhere; never launch a native dialog in this fixture.
  // Linux/darwin engine refusal is also checked above before any effect.
  if(process.platform!=='win32') {
   const cli=fileURLToPath(new URL('../dist/cli/index.js',import.meta.url));
   const runCli=spawnSync(process.execPath,[cli,'connection','credential','save','--service','clerk','--env','development','--json',project],{encoding:'utf8',timeout:15000,env:{...process.env,HOME:home,USERPROFILE:home}});
   assert.equal(runCli.error,undefined);assert.equal(runCli.status,1);assert.deepEqual(JSON.parse(runCli.stdout),{service:'clerk',environment:'development',status:'unavailable'});
  }
  console.log('Clerk exact-slot lifecycle, coexistence, native gate and inner refusal tests passed');
 }finally{rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runClerkCredentialTests();
