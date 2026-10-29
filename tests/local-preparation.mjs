import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ConnectionStateStore} from '../dist/core/agent/connection-state.js';
import {connectionCredentialRef} from '../dist/core/agent/connection-credential.js';
import {inspectLocalApplication} from '../dist/core/local/session.js';
import {LocalLaunchSnapshot,observeLocalPreparationIdentity} from '../dist/core/local/snapshot.js';
import {readLocalPreparationReview} from '../dist/core/agent/local-development.js';
import {buildNextReport} from '../dist/core/agent/next.js';
import {inspectHostReadiness} from '../dist/core/agent/readiness.js';
import {toAccount} from '../dist/core/vault/naming.js';
import {buildLocalNode} from '../tools/build-local-node.mjs';

export async function runLocalPreparationTests(){
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'akc-local-preparation-'))),evidence=process.env.AKC_PREPARATION_EVIDENCE_DIR;
 const home=join(root,'home'),project=join(root,'project');fs.mkdirSync(home);fs.mkdirSync(join(project,'src'),{recursive:true});
 fs.writeFileSync(join(project,'package.json'),'{"type":"module"}');fs.writeFileSync(join(project,'package-lock.json'),'{"lockfileVersion":3}');
 fs.writeFileSync(join(project,'src/main.ts'),'throw new Error("synthetic-app-must-never-run");');
 let builds=0,cases=0;
 const built=await buildLocalNode(project,'src/main.ts');builds++;assert.equal(built.status,'built');
 const store=new ConnectionStateStore(project,home),ref=connectionCredentialRef(project,'development');
 const selection={service:'resend',environment:'development',route:'api-key-case-managed',destination:{kind:'local'},sendingDomain:null};
 assert.equal(store.saveIntent(selection).ok,true);const register=()=>{const x=store.beginCredentialMutation(ref);assert.equal(x.ok,true);assert.equal(store.finishCredentialMutation(ref,x.value,true),true);};register();
 const vault={hasSecret:async r=>toAccount(r)===toAccount(ref)},request={projectDir:project,service:'resend',environment:'development',artifact:built.artifact,maxDurationMs:1800000};
 const deps={offline:true,vault,licensePlan:'free',connectionBaseDir:home,registryBaseDir:home,hostReadiness:inspectHostReadiness({platform:'win32',osRelease:'10.0.26200',helperAvailable:true})};
 const review=()=>readLocalPreparationReview(project,store.readIntent().value,store.credentialRevision(ref),home);
 const tree=dir=>fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(x=>x.isDirectory()?tree(join(dir,x.name)):[[join(dir,x.name),createHash('sha256').update(fs.readFileSync(join(dir,x.name))).digest('hex')]]);
 const check=(actual,expected)=>{assert.equal(actual,expected);cases++;};
 const denied=['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'],original=Object.fromEntries(denied.map(k=>[k,cp[k]]));let children=0;
 try{
  for(const k of denied)cp[k]=()=>{children++;throw Error('No execution');};syncBuiltinESMExports();
  check(review(),null);const first=await inspectLocalApplication({vault,connectionBaseDir:home},request);check(first.status,'ready-for-review');check(first.preparationSaved,true);check(store.readLocalSession().status,'missing');
  const record=store.readLocalPreparation().value;assert.ok(record);check(Date.parse(record.expiresAt)-Date.parse(record.inspectedAt),request.maxDurationMs);
  const snapshot=new LocalLaunchSnapshot(project,built.artifact);assert.deepEqual(record.metadataIdentity,snapshot.preparationIdentity());assert.deepEqual(observeLocalPreparationIdentity(project,built.artifact),record.metadataIdentity);cases++;
  const preserveMissing=JSON.stringify(store.readLocalPreparation());check((await inspectLocalApplication({vault:{hasSecret:async()=>false},connectionBaseDir:home},request)).status,'missing-credential');assert.equal(JSON.stringify(store.readLocalPreparation()),preserveMissing);cases++;
  const raw=JSON.stringify(record);assert.ok(!raw.includes(snapshot.ownerConfig(1000).artifactSha256));assert.ok(!raw.includes(snapshot.ownerConfig(1000).interpreterSha256));assert.ok(!raw.includes('synthetic-app-must-never-run'));assert.ok(!raw.includes(project));cases++;
  // A fresh next invocation restores the artifact without another build, input, app or provider operation.
  const before=tree(home),next=await buildNextReport(project,deps);check(next.schemaVersion,13);check(next.localDevelopment.nextStep,'review-local-preparation');check(next.localDevelopment.preparationReceipt.status,'unchanged-metadata');check(next.localDevelopment.preparationReceipt.artifact,built.artifact);assert.deepEqual(next.localDevelopment.preparation,{build:'not-inspected',inspection:'not-inspected'});assert.deepEqual(tree(home),before);cases++;
  check(builds,1);check(next.localDevelopment.permission,'none');check(next.localDevelopment.applicationReadiness,'not-verified');
  // Existing observation writes preserve the small preparation fact.
  const observation=store.beginObservation({kind:'application-check',authority:'agent-observed',basis:{credentialRevision:store.credentialRevision(ref),destinationFingerprint:null,intentFingerprint:null,sourceFingerprint:null,verifierVersion:'synthetic-1'}});assert.equal(observation.ok,true);assert.equal(store.finishObservation(observation.value.id,'unknown','unknown').ok,true);assert.deepEqual(store.readLocalPreparation().value,record);cases++;
  const journal=join(home,'.api-key-case','connections',fs.readdirSync(join(home,'.api-key-case','connections'))[0],'observations.json');
  const originalJournal=fs.readFileSync(journal,'utf8'),edit=fn=>{const x=JSON.parse(originalJournal);fn(x.localPreparation);fs.writeFileSync(journal,JSON.stringify(x),{mode:0o600});};
  edit(r=>{r.inspectedAt='2000-01-01T00:00:00.000Z';r.expiresAt=new Date(Date.parse(r.inspectedAt)+r.maxDurationMs).toISOString();});check(review().status,'expired');check(review().artifact,built.artifact);
  edit(r=>{r.inspectedAt='2099-01-01T00:00:00.000Z';r.expiresAt=new Date(Date.parse(r.inspectedAt)+r.maxDurationMs).toISOString();});check(review().status,'expired');
  for(const [part,status] of [['project','project-changed'],['runtime','runtime-changed'],['artifact','artifact-changed']]){edit(r=>r.metadataIdentity[part]='0'.repeat(64));check(review().status,status);}
  fs.writeFileSync(journal,originalJournal,{mode:0o600});
  for(const change of ['edit','add','delete','config','lock']){
   const path=join(project,change==='config'?'tsconfig.json':change==='lock'?'package-lock.json':'src/added.ts');
   const existed=fs.existsSync(path),old=existed?fs.readFileSync(path):null;
   if(change==='edit')fs.appendFileSync(join(project,'src/main.ts'),'\n// changed');else if(change==='delete')fs.unlinkSync(join(project,'src/main.ts'));else fs.writeFileSync(path,change==='lock'?'{"lockfileVersion":2}':'// new');
   const status=review().status;check(status,change==='delete'?'inputs-changed':'inputs-changed');
   if(change==='edit'||change==='delete')fs.writeFileSync(join(project,'src/main.ts'),'throw new Error("synthetic-app-must-never-run");');else if(existed)fs.writeFileSync(path,old);else fs.unlinkSync(path);
   assert.equal((await inspectLocalApplication({vault,connectionBaseDir:home},request)).status,'ready-for-review');
  }
  fs.appendFileSync(join(project,built.artifact),'\n// artifact changed');check(review().status,'artifact-changed');
  assert.equal((await inspectLocalApplication({vault,connectionBaseDir:home},request)).status,'ready-for-review');
  fs.renameSync(join(project,built.artifact),join(project,built.artifact+'.kept'));check(review().status,'inputs-unavailable');fs.renameSync(join(project,built.artifact+'.kept'),join(project,built.artifact));
  assert.equal((await inspectLocalApplication({vault,connectionBaseDir:home},request)).status,'ready-for-review');
  register();check(review().status,'credential-changed');check(review().artifact,null);assert.equal((await inspectLocalApplication({vault,connectionBaseDir:home},request)).status,'ready-for-review');
  assert.equal(store.saveIntent({...selection,environment:'preview'}).ok,true);check(review().status,'selection-changed');check(review().artifact,null);assert.equal(store.saveIntent(selection).ok,true);check(review().status,'selection-changed');
  assert.equal((await inspectLocalApplication({vault,connectionBaseDir:home},request)).status,'ready-for-review');
  let changed=false;const race=await buildNextReport(project,{...deps,vault:{hasSecret:async r=>{if(!changed){changed=true;assert.equal((await inspectLocalApplication({vault,connectionBaseDir:home},request)).status,'ready-for-review');}return vault.hasSecret(r);}}});check(race.localDevelopment.nextStep,'review-local-state');check(race.localDevelopment.preparationReceipt.artifact,null);
  const last=fs.readFileSync(journal,'utf8');for(const mutate of [r=>r.artifact='../unsafe.cjs',r=>r.metadataIdentity.raw='synthetic-private-no-output',r=>r.expiresAt='invalid',r=>r.connectionId='0'.repeat(64)]){const x=JSON.parse(last);mutate(x.localPreparation);fs.writeFileSync(journal,JSON.stringify(x),{mode:0o600});check(review().status,'metadata-unavailable');check(review().artifact,null);const report=await buildNextReport(project,deps);check(report.localDevelopment.nextStep,'review-local-state');assert.ok(!JSON.stringify(report).includes('synthetic-private-no-output'));assert.ok(!report.nextActions.some(a=>a.kind==='register-connection-credential'));cases++;}fs.writeFileSync(journal,last,{mode:0o600});
  const stateDir=join(journal,'..');fs.mkdirSync(join(stateDir,'local-session.lock'));const preserved=fs.readFileSync(journal,'utf8');check((await inspectLocalApplication({vault,connectionBaseDir:home},request)).status,'recovery-required');assert.equal(fs.readFileSync(journal,'utf8'),preserved);cases++;fs.rmdirSync(join(stateDir,'local-session.lock'));
  check(children,0);
  // Editing an existing input after capture, before final enumeration, must not look unchanged.
  for(const target of ['src/main.ts','tsconfig.json']){
   const path=join(project,target),content=target==='src/main.ts'?'throw new Error("synthetic-app-must-never-run");':'{}';
   fs.writeFileSync(path,content);assert.equal((await inspectLocalApplication({vault,connectionBaseDir:home},request)).status,'ready-for-review');
   const originalReadDir=fs.readdirSync;let enumeration=0;
   fs.readdirSync=(path,...args)=>{if(String(path)===join(project,'src')&&++enumeration===2)fs.appendFileSync(join(project,target),'\n ');return originalReadDir(path,...args);};syncBuiltinESMExports();
   try{check(review().status,'inputs-unavailable');assert.ok(enumeration>=2);cases++;}
   finally{fs.readdirSync=originalReadDir;syncBuiltinESMExports();}
   fs.writeFileSync(path,content);assert.equal((await inspectLocalApplication({vault,connectionBaseDir:home},request)).status,'ready-for-review');
  }
  for(const k of denied)cp[k]=original[k];syncBuiltinESMExports();
  // Separate-process candidate CLI with a fake native package and effect traps.
  const checkout=join(root,'owned-cli');fs.mkdirSync(checkout);fs.writeFileSync(join(checkout,'package.json'),'{"name":"api-key-case","type":"module","version":"0.9.2","bin":{"api-key-case":"dist/cli/index.js"}}');fs.cpSync(fileURLToPath(new URL('../dist',import.meta.url)),join(checkout,'dist'),{recursive:true});
  const modules=join(checkout,'node_modules'),sourceModules=fs.realpathSync(fileURLToPath(new URL('../node_modules',import.meta.url)));fs.mkdirSync(modules);for(const n of fs.readdirSync(sourceModules))if(n!=='@napi-rs'&&!n.startsWith('.'))fs.symlinkSync(join(sourceModules,n),join(modules,n),process.platform==='win32'?'junction':'dir');
  const fake=join(modules,'@napi-rs/keyring'),marker=join(root,'effects.json'),preload=join(root,'deny-effects.mjs'),entry=join(checkout,'dist/cli/index.js');fs.mkdirSync(fake,{recursive:true});fs.writeFileSync(marker,'{"writes":0,"children":0,"probes":0,"network":0}');
  fs.writeFileSync(join(fake,'package.json'),'{"name":"@napi-rs/keyring","main":"index.cjs"}');fs.writeFileSync(join(fake,'index.cjs'),`exports.Entry=class{constructor(service,account){this.account=account}getPassword(){return this.account===${JSON.stringify(toAccount(ref))}?'synthetic-private-no-output':null}setPassword(){throw Error('No write')}deleteCredential(){throw Error('No write')}};`);
  fs.writeFileSync(preload,`import cp from 'node:child_process';import fs from 'node:fs';import net from 'node:net';import http from 'node:http';import https from 'node:https';import{syncBuiltinESMExports}from'node:module';import{KeyringVault}from ${JSON.stringify(pathToFileURL(join(checkout,'dist/core/vault/keyring.js')).href)};const marker=${JSON.stringify(marker)},deny=n=>()=>{const x=JSON.parse(fs.readFileSync(marker,'utf8'));x[n]++;fs.writeFileSync(marker,JSON.stringify(x));throw Error('No effect')};KeyringVault.prototype.isAvailable=deny('probes');for(const n of ['setSecret','deleteSecret','saveDestinationTrust','deleteDestinationTrust'])KeyringVault.prototype[n]=deny('writes');for(const n of ${JSON.stringify(denied)})cp[n]=deny('children');globalThis.fetch=deny('network');net.connect=deny('network');net.createConnection=deny('network');http.request=deny('network');http.get=deny('network');https.request=deny('network');https.get=deny('network');syncBuiltinESMExports();`);
  const env={HOME:home,USERPROFILE:home,DO_NOT_TRACK:'1',NODE_OPTIONS:`--import=${pathToFileURL(preload).href}`},beforeCLI=tree(home),artifactsBefore=fs.readdirSync(join(project,'dist'));
  const savedSelection=store.readIntent().value,statePath=join(stateDir,'state.json'),stateBefore=fs.statSync(statePath);
  const repeated=cp.spawnSync(process.execPath,[entry,'connection','set','--service','resend','--env','development','--route','api-key-case-managed','--destination','local','.'],{cwd:project,env,encoding:'utf8',timeout:15000});check(repeated.status,0);assert.ok(!repeated.stdout.includes('synthetic-private-no-output'));
  check(review().status,'unchanged-metadata');assert.deepEqual(store.readIntent().value,savedSelection);assert.deepEqual(tree(home),beforeCLI);const stateAfter=fs.statSync(statePath);assert.equal(stateAfter.ino,stateBefore.ino);assert.equal(stateAfter.mtimeMs,stateBefore.mtimeMs);cases++;
  const firstCLI=cp.spawnSync(process.execPath,[entry,'next','--json','--offline','.'],{cwd:project,env,encoding:'utf8',timeout:15000});check(firstCLI.status,0);const restored=JSON.parse(firstCLI.stdout);check(restored.schemaVersion,13);check(restored.localDevelopment.preparationReceipt.status,'unchanged-metadata');check(restored.localDevelopment.preparationReceipt.artifact,built.artifact);assert.ok(!firstCLI.stdout.includes('synthetic-private-no-output'));assert.deepEqual(tree(home),beforeCLI);assert.deepEqual(fs.readdirSync(join(project,'dist')),artifactsBefore);cases++;
  assert.deepEqual(JSON.parse(fs.readFileSync(marker,'utf8')),{writes:0,children:0,probes:0,network:0});cases++;
  // Repeating selection cannot renew expired preparation or bypass guarded metadata.
  const preservedJournal=fs.readFileSync(journal,'utf8'),expired=JSON.parse(preservedJournal);expired.localPreparation.inspectedAt='2000-01-01T00:00:00.000Z';expired.localPreparation.expiresAt=new Date(Date.parse(expired.localPreparation.inspectedAt)+expired.localPreparation.maxDurationMs).toISOString();
  fs.writeFileSync(journal,JSON.stringify(expired),{mode:0o600});const expiredBytes=fs.readFileSync(journal);check(store.saveIntent(selection).ok,true);check(review().status,'expired');assert.deepEqual(fs.readFileSync(journal),expiredBytes);cases++;fs.writeFileSync(journal,preservedJournal,{mode:0o600});
  const stateBytes=fs.readFileSync(statePath);
  for(const [name,issue] of [['lock','lock-present'],['state.json.tmp','temporary-file-present']]){const path=join(stateDir,name);if(name==='lock')fs.mkdirSync(path);else fs.writeFileSync(path,'synthetic unfinished metadata',{mode:0o600});check(store.saveIntent(selection).issue,issue);assert.deepEqual(fs.readFileSync(statePath),stateBytes);cases++;if(name==='lock')fs.rmdirSync(path);else fs.unlinkSync(path);}
  fs.writeFileSync(statePath,'synthetic corrupt metadata',{mode:0o600});check(store.saveIntent(selection).issue,'invalid-data');assert.equal(fs.readFileSync(statePath,'utf8'),'synthetic corrupt metadata');cases++;fs.writeFileSync(statePath,stateBytes,{mode:0o600});
  check(store.saveIntent({...selection,unexpected:'synthetic rejected field'}).issue,'invalid-data');assert.deepEqual(fs.readFileSync(statePath),stateBytes);cases++;
  // Each actual selection field change, including change-back, still invalidates earlier preparation.
  const registrationBefore=store.credentialRevision(ref);
  for(const change of [{environment:'preview'},{route:'manual'},{destination:{kind:'vercel'}},{sendingDomain:'changed.example.com'}]){
   const prior=store.readIntent().value,changedSelection=store.saveIntent({...selection,...change});check(changedSelection.ok,true);assert.ok(changedSelection.value.updatedAt>prior.updatedAt);check(review().status,'selection-changed');
   const repeatedSelection=store.saveIntent({...selection,...change});check(repeatedSelection.ok,true);assert.deepEqual(repeatedSelection.value,changedSelection.value);cases++;
   const back=store.saveIntent(selection);check(back.ok,true);assert.ok(back.value.updatedAt>changedSelection.value.updatedAt);check(review().status,'selection-changed');assert.equal(store.credentialRevision(ref),registrationBefore);assert.deepEqual(fs.readFileSync(journal,'utf8'),preservedJournal);cases++;
  }
  check(builds,1);assert.equal((await inspectLocalApplication({vault,connectionBaseDir:home},request)).status,'ready-for-review');
  if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(join(evidence,'restored.json'),firstCLI.stdout);fs.writeFileSync(join(evidence,'unchanged.json'),JSON.stringify(next,null,2));fs.appendFileSync(join(project,'src/main.ts'),'\n// another conversation sees an input edit');const changedReport=await buildNextReport(project,deps);check(changedReport.localDevelopment.preparationReceipt.status,'inputs-changed');fs.writeFileSync(join(evidence,'changed.json'),JSON.stringify(changedReport,null,2));fs.writeFileSync(join(project,'src/main.ts'),'throw new Error("synthetic-app-must-never-run");');assert.equal((await inspectLocalApplication({vault,connectionBaseDir:home},request)).status,'ready-for-review');fs.writeFileSync(join(evidence,'fixture.json'),JSON.stringify({root,project,home,entry,preload,marker,artifact:built.artifact}));}
  console.log(`Local preparation: ${cases} cases passed; one synthetic build, preserved artifact across fresh offline CLI, no repeated input/app/provider/native operation; metadata-only advisory identity.`);
 }finally{for(const k of denied)cp[k]=original[k];syncBuiltinESMExports();if(!evidence)fs.rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runLocalPreparationTests();
