import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {chmodSync,existsSync,realpathSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {spawnSync,ChildProcess} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {runDisposableClerkPrepareTests} from './clerk-prepare-fixture.mjs';

export async function runClerkPrepareTests(){
 if(!process.argv.includes('--synthetic-fixture'))return runDisposableClerkPrepareTests();
 const {runClerkConnectionPrepare}=await import('../dist/core/deploy/engine.js');
 const {runClerkVersionPreparation}=await import('../dist/core/deploy/handoff.js');
 const {ConnectionStateStore}=await import('../dist/core/agent/connection-state.js');
 const {clerkCredentialRef}=await import('../dist/core/agent/connection-credential.js');
 const {MemoryVault}=await import('../dist/core/vault/memory.js');
 const {DeploymentHistory,buildHistoryReport}=await import('../dist/core/deploy/history.js');
 const {CloudflareVersionsAdapter}=await import('../dist/adapters/cloudflare-versions.js');
 const {resolveClerkWorkerDestination}=await import('../dist/core/deploy/snapshot.js');
 const {saveLicenseKey}=await import('../dist/core/license.js');
 const {Entry}=await import('@napi-rs/keyring');
 const {VAULT_SERVICE,toAccount}=await import('../dist/core/vault/naming.js');
 const {buildMacOSApprovalScript}=await import('../dist/core/human/macos.js');
 const {buildWindowsApprovalScript}=await import('../dist/core/human/windows.js');
 const root=realpathSync.native(mkdtempSync(join(tmpdir(),'akc-clerk-preparation-'))),secret='synthetic-clerk-preparation-secret-ZQ47',versionId='12345678-1234-1234-1234-123456789abc',account='0123456789abcdef0123456789abcdef';
 const keys=generateKeyPairSync('ed25519'),payload=Buffer.from(JSON.stringify({v:1,plan:'pro',id:'synthetic-clerk-prepare',issuedAt:'2026-10-03'})).toString('base64url'),signed=`AKC1.${payload}`,license=`${signed}.${sign(null,Buffer.from(signed),keys.privateKey).toString('base64url')}`;
 let active,count=0;const original=Entry.prototype.getPassword;
 Entry.prototype.getPassword=function(){assert.equal(this.service,VAULT_SERVICE);assert.equal(this.account,toAccount(active.ref));active.reads++;const receipt=active.history.read();assert.equal(receipt.entries.at(-1).outcome,'unknown');assert.equal(receipt.entries.at(-1).preparation.versionId,null);active.onRead?.();return active.secret;};
 async function fixture(environment='development'){
  const dir=join(root,`case-${++count}`),project=join(dir,'project'),home=join(dir,'home'),bin=join(dir,'bin');for(const p of [dir,project,home,bin])mkdirSync(p);
  const config=join(project,'wrangler.toml');writeFileSync(config,`name = "root-worker"\naccount_id = "${account}"\n[env.development]\nname = "development-worker"\naccount_id = "${account}"\n[env.preview]\nname = "preview-worker"\naccount_id = "${account}"\n`);
  const store=new ConnectionStateStore(project,home),vault=new MemoryVault(),ref=clerkCredentialRef(project,environment),history=new DeploymentHistory(project,home);
  const select=env=>store.saveClerkManagedIntent({service:'clerk',environment:env,route:'api-key-case-managed',destination:{kind:'cloudflare'},sendingDomain:null});assert.equal(select(environment).ok,true);
  await vault.setSecret(ref,secret);const mutation=store.beginCredentialMutation(ref);assert.equal(mutation.ok,true);assert.equal(store.finishCredentialMutation(ref,mutation.value,true),true);saveLicenseKey(license,home);
  const mode=join(dir,'mode.json'),marker=join(dir,'requests.json'),probes=join(dir,'probes.json');writeFileSync(mode,'{}');
  // Outlast the fixture's 1-second timeout, but bound the synthetic Node child
  // even if killing its Windows .cmd wrapper leaves that child running.
  const body=`const fs=require('fs');const args=process.argv.slice(2),mode=JSON.parse(fs.readFileSync(${JSON.stringify(mode)},'utf8'));if(args[0]==='--version'){console.log(mode.version||'4.131.2');process.exit(0);}if(args[0]==='whoami'){fs.writeFileSync(${JSON.stringify(probes)},'called');console.log(JSON.stringify({loggedIn:true,accounts:[{id:mode.account||${JSON.stringify(account)}}]}));process.exit(0);}if(JSON.stringify(args)!==JSON.stringify(${JSON.stringify(new CloudflareVersionsAdapter(environment).planDeploy('CLERK_SECRET_KEY',environment).argv.slice(1))}))process.exit(31);for(const [k,v]of Object.entries({WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG_SANITIZE:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false',WRANGLER_NO_SKILLS_UPDATE_PROMPTS:'true',CI:'1'}))if(process.env[k]!==v)process.exit(32);if(Object.keys(process.env).some(k=>k.startsWith('WRANGLER_OUTPUT_FILE_'))||process.env.NODE_OPTIONS||process.env.CLOUDFLARE_API_TOKEN)process.exit(33);let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(input!==(mode.secret||${JSON.stringify(secret)}))process.exit(34);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(['prepare']));if(mode.nonzero)process.exit(2);if(mode.invalidUtf8){process.stdout.write(Buffer.from([255]));return;}if(mode.hang){setTimeout(()=>{},5000);return;}if(mode.large){console.log('x'.repeat(300000));return;}if(mode.malformed){console.log('not-a-version '+input);return;}console.error(input);const line='✨ Success! Created version ${versionId} with secret CLERK_SECRET_KEY.';console.log(line);if(mode.duplicate)console.log(line);});`;
  const script=join(bin,'provider.cjs');writeFileSync(script,body);const executable=join(bin,'wrangler'+(process.platform==='win32'?'.cmd':''));writeFileSync(executable,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${script}" %*\r\n`:`#!${process.execPath}\n${body}`);chmodSync(executable,0o700);
  const f={project,home,bin,config,store,vault,ref,history,mode,marker,probes,select,secret,reads:0,approvals:0,decision:'approved',onRead:null,onApprove:null,
   request:{service:'clerk',environment,projectDir:project,dryRun:false},events:()=>existsSync(marker)?JSON.parse(readFileSync(marker,'utf8')):[],setMode:value=>writeFileSync(mode,JSON.stringify(value))};
  f.deps={vault,pathOverride:bin,historyBaseDir:home,connectionBaseDir:home,licenseOptions:{baseDir:home,publicKey:keys.publicKey},humanPlane:{capability:()=> 'os-dialog',askApproval:async plan=>{f.approvals++;f.plan=plan;f.onApprove?.();return f.decision;}}};
  f.run=async()=>{active=f;const result=await runClerkConnectionPrepare(f.deps,f.request);assert.ok(!JSON.stringify(result).includes(secret));return result;};return f;
 }
 try{
  const guarded=await import('../dist-guard/core/deploy/engine.js'),guardedHandoff=await import('../dist-guard/core/deploy/handoff.js');let access=0;const denied=new Proxy({}, {get(){access++;throw Error('unexpected dependency');}});
  const f=await fixture();assert.equal((await guarded.runClerkConnectionPrepare({...f.deps,vault:denied,humanPlane:denied},f.request)).status,'unavailable');assert.equal((await guardedHandoff.runClerkVersionPreparation(denied)).status,'unknown');assert.equal(access,0);
  const platformEngine=await import('../dist-platform/core/deploy/engine.js'),platformHandoff=await import('../dist-platform/core/deploy/handoff.js');
  const platformDescriptor=Object.getOwnPropertyDescriptor(process,'platform');
  try{for(const platform of ['linux','darwin']){Object.defineProperty(process,'platform',{...platformDescriptor,value:platform});assert.equal((await platformEngine.runClerkConnectionPrepare({...f.deps,vault:denied,humanPlane:denied},f.request)).status,'unavailable');assert.equal((await platformHandoff.runClerkVersionPreparation(denied)).status,'unknown');assert.equal(access,0);}}
  finally{Object.defineProperty(process,'platform',platformDescriptor);}
  {const f=await fixture(),free=join(root,'free-license');mkdirSync(free);f.request.dryRun=true;f.deps.licenseOptions={baseDir:free,publicKey:keys.publicKey};f.deps.vault=denied;assert.equal((await f.run()).status,'pro-required');assert.equal(access,0);assert.equal(f.reads,0);assert.equal(f.approvals,0);}
  for(const environment of ['development','preview','production']){
   const f=await fixture(environment);const result=await f.run();assert.equal(result.status,'prepared');assert.equal(result.versionId,versionId);assert.equal(result.activation,'not-performed-by-this-invocation');assert.equal(result.historySaved,true);assert.equal(f.reads,1);assert.equal(f.approvals,1);assert.deepEqual(f.events(),['prepare']);
   assert.equal(f.plan.connectionSource.service,'clerk');assert.equal(f.plan.connectionSource.operation,'cloudflare-version-preparation');const dialog=buildWindowsApprovalScript(f.plan);for(const phrase of ['latest remote code','Version URLs','does not activate production traffic','v2 Clerk'])assert.ok(dialog.includes(phrase));
   const journal=JSON.parse(readFileSync(join(f.home,'.api-key-case/deployment-history',createHash('sha256').update(realpathSync.native(f.project)).digest('hex'),'history.json'),'utf8'));assert.equal(journal.schemaVersion,3);assert.equal(journal.entries.at(-1).preparation.versionId,versionId);assert.deepEqual(journal.entries.at(-1).preparation.destination,{accountId:account,worker:environment==='production'?'root-worker':environment+'-worker'});
   const report=await buildHistoryReport(f.project,{baseDir:f.home,connectionBaseDir:f.home,adapters:new Map(),offline:true});assert.equal(report.schemaVersion,3);assert.equal(report.entries.at(-1).preparation.versionId,versionId);
  }
  {const f=await fixture();f.request.dryRun=true;f.deps.adapter=new CloudflareVersionsAdapter('development');f.deps.adapter.checkCli=()=>{throw Error('offline probe');};const r=await f.run();assert.equal(r.status,'dry-run');assert.equal(r.preview.worker,'development-worker');assert.equal(r.preview.remoteCode,'latest-at-operation');assert.equal(f.reads,0);assert.equal(f.approvals,0);assert.deepEqual(f.events(),[]);}
  for(const mode of [{version:'4.0.0'},{account:'f'.repeat(32)}]){const f=await fixture();f.setMode(mode);assert.equal((await f.run()).status,'unavailable');assert.equal(f.reads,0);assert.equal(f.approvals,0);assert.deepEqual(f.events(),[]);}
  for(const version of ['4.131.2-beta','4.131.2-canary','v4.131.2','wrangler 4.131.2','prefix 4.131.2']){const f=await fixture();f.setMode({version});assert.equal((await f.run()).status,'unavailable');assert.equal(existsSync(f.probes),false);assert.equal(f.reads,0);}
  for(const mode of [{nonzero:true},{malformed:true},{duplicate:true},{large:true},{invalidUtf8:true},{hang:true}]){const f=await fixture();f.setMode(mode);const r=await f.run();assert.equal(r.status,'unknown');assert.equal(r.versionId,null);assert.equal(f.reads,1);assert.deepEqual(f.events(),['prepare']);assert.equal(f.history.read().entries.at(-1).outcome,'unknown');}
  {const f=await fixture();f.secret='  '+versionId.toUpperCase()+'\n';f.setMode({secret:f.secret});assert.equal((await f.run()).status,'unknown');assert.equal(f.history.read().entries.at(-1).preparation.versionId,null);}
  {const f=await fixture();f.decision='declined';assert.equal((await f.run()).status,'declined');assert.equal(f.reads,0);assert.deepEqual(f.events(),[]);}
  {const f=await fixture();f.onApprove=()=>f.select('preview');assert.equal((await f.run()).status,'changed');assert.equal(f.reads,0);assert.deepEqual(f.events(),[]);}
  {const f=await fixture();f.onRead=()=>writeFileSync(f.config,readFileSync(f.config,'utf8').replace('development-worker','changed-worker'));const result=await f.run();assert.equal(result.status,'changed');assert.equal(result.historySaved,true);assert.equal(f.history.read().entries.at(-1).outcome,'unknown');assert.equal(f.reads,1);assert.deepEqual(f.events(),[]);}
  {const f=await fixture();writeFileSync(f.config,`name="root-worker"\naccount_id="${account}"\n[env.development]\n`);assert.equal(resolveClerkWorkerDestination(f.project,'development'),null);assert.equal((await f.run()).status,'unavailable');assert.equal(f.reads,0);}
  {const f=await fixture();const abort=new AbortController();f.deps.signal=abort.signal;f.onApprove=()=>abort.abort();assert.equal((await f.run()).status,'changed');assert.equal(f.reads,0);}
  {const f=await fixture();await f.vault.deleteSecret(f.ref);f.request.dryRun=true;assert.equal((await f.run()).status,'missing-credential');assert.equal(f.reads,0);}
  {const f=await fixture();const blocked=store=>store.saveClerkManagedIntent({service:'clerk',environment:'development',route:'api-key-case-managed',destination:{kind:'vercel'},sendingDomain:null});assert.equal(blocked(f.store).ok,false);assert.equal(f.store.readIntent().status,'missing');assert.equal(f.store.readClerkNativeIntent().status,'missing');}
  for(const pipe of ['stdout','stderr']){
   const f=await fixture(),spawn=ChildProcess.prototype.spawn;ChildProcess.prototype.spawn=function(options){const result=spawn.call(this,options);if(options.args?.includes('versions'))setImmediate(()=>this[pipe]?.emit('error',new Error(secret)));return result;};
   try{const r=await f.run();assert.equal(r.status,'unknown');assert.equal(r.versionId,null);assert.ok(f.events().length<=1);}finally{ChildProcess.prototype.spawn=spawn;}
  }
  {const f=await fixture(),spawn=ChildProcess.prototype.spawn;let fake,unrefs=0;
   ChildProcess.prototype.spawn=function(options){if(!options.args?.includes('versions'))return spawn.call(this,options);fake=this;this.stdin=new PassThrough();this.stdout=new PassThrough();this.stderr=new PassThrough();this.kill=()=>false;this.unref=()=>{unrefs++;};setImmediate(()=>this.stdout.emit('error',new Error(secret)));return this;};
   try{const r=await f.run();assert.equal(r.status,'unknown');assert.equal(r.termination,'unconfirmed');assert.equal(unrefs,1);for(const pipe of [fake.stdin,fake.stdout,fake.stderr])assert.equal(pipe.destroyed,true);assert.deepEqual(f.events(),[]);}finally{ChildProcess.prototype.spawn=spawn;}
  }
  {const f=await fixture(),spawn=ChildProcess.prototype.spawn,abort=new AbortController();f.deps.signal=abort.signal;
   ChildProcess.prototype.spawn=function(options){if(!options.args?.includes('versions'))return spawn.call(this,options);this.stdin=new PassThrough();this.stdout=new PassThrough();this.stderr=new PassThrough();this.kill=()=>{setImmediate(()=>this.emit('close',null));return true;};this.stdin.on('finish',()=>abort.abort());return this;};
   try{const r=await f.run();assert.equal(r.status,'changed');assert.equal(r.termination,'closed');assert.equal(r.historySaved,true);assert.deepEqual(f.events(),[]);}finally{ChildProcess.prototype.spawn=spawn;}
  }
  {const f=await fixture();await f.run();for(const plan of [{...f.plan,name:'RESEND_API_KEY'},{...f.plan,target:'vercel'},{...f.plan,connectionSource:{...f.plan.connectionSource,operation:undefined}},{...f.plan,connectionSource:{...f.plan.connectionSource,operation:'deploy'}},{...f.plan,connectionSource:{...f.plan.connectionSource,environment:'production'}},{...f.plan,connectionSource:{...f.plan.connectionSource,extra:true}}])for(const build of [buildWindowsApprovalScript,buildMacOSApprovalScript])assert.throws(()=>build(plan));}
  {const f=await fixture(),legacy={name:'OTHER_KEY',scope:'project',target:'cloudflare',env:'development',destinationId:'a'.repeat(64),force:false};const id=f.history.begin(legacy);assert.ok(id);assert.equal(f.history.finish(id,'completed'),true);const before=JSON.stringify(f.history.read().entries[0]);await f.run();assert.equal(JSON.stringify(f.history.read().entries[0]),before);assert.equal(f.history.read().entries.at(-1).preparation.versionId,versionId);for(let i=0;i<201;i++)assert.ok(f.history.begin(legacy));assert.ok(f.history.read().entries.every(entry=>!entry.preparation));const file=join(f.home,'.api-key-case/deployment-history',createHash('sha256').update(realpathSync.native(f.project)).digest('hex'),'history.json');assert.equal(JSON.parse(readFileSync(file,'utf8')).schemaVersion,3);}
  {const f=await fixture();const metadata=JSON.stringify(f.store.readClerkManagedIntent());const native=f.store.saveClerkNativeIntent({service:'clerk',environment:'production',route:'provider-native',destination:{kind:'vercel'},sendingDomain:null});assert.equal(native.ok,true);assert.equal(JSON.stringify(f.store.readClerkManagedIntent()),metadata);assert.equal(f.store.readIntent().status,'missing');}
  {const f=await fixture();const abort=new AbortController();abort.abort();f.deps.signal=abort.signal;assert.equal((await f.run()).status,'changed');assert.equal(f.reads,0);assert.equal(f.approvals,0);}
  {const f=await fixture();f.request.service='resend';assert.equal((await f.run()).status,'unsupported');assert.equal(f.reads,0);assert.equal(f.approvals,0);}
  {const f=await fixture();let downstream=0;const input={ref:{name:'RESEND_API_KEY',service:'resend',scope:'project',projectId:f.ref.projectId,environment:'development'},get execution(){downstream++;throw Error('unexpected execution');}};assert.equal((await runClerkVersionPreparation(input)).status,'unknown');assert.equal(downstream,0);}
  {const f=await fixture();const path=join(f.home,'.api-key-case/deployment-history',createHash('sha256').update(realpathSync.native(f.project)).digest('hex'),'history.json');await f.run();const stored=JSON.parse(readFileSync(path,'utf8'));stored.schemaVersion=2;writeFileSync(path,JSON.stringify(stored));assert.equal(f.history.read().status,'unavailable');}
  {const f=await fixture(),outside=join(root,'owned-outside'),moved=join(root,'owned-moved');mkdirSync(outside);writeFileSync(join(outside,'wrangler.toml'),`name="outside-worker"\naccount_id="${account}"\n`);const originalLstat=fs.lstatSync;let replaced=false;
   fs.lstatSync=function(path,...args){if(!replaced&&String(path)===f.config){replaced=true;fs.renameSync(f.project,moved);fs.symlinkSync(outside,f.project,'junction');}return originalLstat.call(this,path,...args);};syncBuiltinESMExports();
   try{assert.equal(resolveClerkWorkerDestination(f.project,'production'),null);assert.equal(replaced,true);}finally{fs.lstatSync=originalLstat;syncBuiltinESMExports();}
  }
  const cli=fileURLToPath(new URL('../dist-guard/cli/index.js',import.meta.url));const selected=spawnSync(process.execPath,[cli,'connection','set','--service','clerk','--env','development','--route','api-key-case-managed','--destination','cloudflare',f.project],{encoding:'utf8',env:{...process.env,HOME:f.home,USERPROFILE:f.home}});assert.equal(selected.status,0);assert.match(selected.stdout,/Clerk connection intent/);
  console.log(`Clerk Worker preparation: ${count} isolated cases passed; fake CLI and keyring only`);
 }finally{Entry.prototype.getPassword=original;rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runClerkPrepareTests();
