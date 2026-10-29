import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConnectionStateStore, deriveConnectionId } from '../dist/core/agent/connection-state.js';
import { connectionCredentialRef } from '../dist/core/agent/connection-credential.js';
import { toAccount } from '../dist/core/vault/naming.js';
import { MemoryVault } from '../dist/core/vault/memory.js';
import { readClerkNativeReport } from '../dist/core/agent/clerk-native.js';
import { inspectProviderNative, parseClerkNativeConfiguration } from '../dist/core/agent/provider-native-check.js';
import { buildNextReport } from '../dist/core/agent/next.js';

const canary='synthetic-clerk-private-wxyz';
const names=['CLERK_SECRET_KEY','NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'];
const rows=(environment='preview')=>names.map(key=>({key,type:'encrypted',target:[environment],configurationId:'icfg_clerk',updatedAt:1,value:canary}));
const input=(environment='preview')=>({service:'clerk',environment,route:'provider-native',destination:{kind:'vercel'},sendingDomain:null});
function files(root,prefix='') {
  const result={};
  for(const item of readdirSync(join(root,prefix),{withFileTypes:true})) {
    const name=join(prefix,item.name);
    if(item.isDirectory())Object.assign(result,files(root,name));
    else if(item.isFile())result[name]=readFileSync(join(root,name),'utf8');
  }
  return result;
}
export async function runClerkNativeTests() {
  let checks=0;
  const parse=data=>parseClerkNativeConfiguration(JSON.stringify({envs:data}),'preview');
  const matched=parse(rows());assert.equal(matched.configuration,'integration-managed');assert.equal(matched.settings.length,2);checks++;
  assert.ok(!JSON.stringify(matched).includes(canary));assert.deepEqual(matched,parse(rows().map(row=>({...row,value:'different'}))));checks++;
  assert.equal(parse([]).configuration,'absent');checks++;
  for(let index=0;index<2;index++) {
    assert.equal(parse(rows().filter((_,i)=>i!==index)).configuration,'partial');checks++;
    for(const extra of [{gitBranch:'feature'},{target:['production']},{configurationId:['icfg_clerk']},{type:['encrypted']}]) {
      assert.equal(parse(rows().map((row,i)=>i===index?{...row,...extra}:row)).configuration,'unknown');checks++;
    }
    assert.equal(parse([...rows(),rows()[index]]).configuration,'unknown');checks++;
  }
  assert.equal(parse(rows().map((row,i)=>({...row,configurationId:i?'icfg_other':'icfg_clerk'}))).configuration,'unknown');checks++;
  assert.equal(parse(rows().map(row=>({...row,configurationId:undefined}))).configuration,'present-unmanaged');checks++;
  assert.equal(parse(rows().map((row,i)=>({...row,configurationId:i?undefined:'icfg_clerk'}))).configuration,'unknown');checks++;
  assert.notEqual(matched.configurationFingerprint,parse(rows().map(row=>({...row,updatedAt:2}))).configurationFingerprint);checks++;
  const root=realpathSync(mkdtempSync(join(tmpdir(),'akc-clerk-native-')));
  try {
    const home=join(root,'home'),project=join(root,'project'),bin=join(root,'bin');
    for(const dir of [home,project,bin,join(project,'.vercel')])mkdirSync(dir,{mode:0o700});
    writeFileSync(join(project,'.vercel','project.json'),JSON.stringify({projectId:'prj_fixture',orgId:'team_fixture'}));
    writeFileSync(join(project,'app.ts'),"import { ClerkProvider } from '@clerk/nextjs';\n");
    writeFileSync(join(project,'.gitignore'),'.env\n.env.*\n');
    const store=new ConnectionStateStore(project,home);
    assert.equal(store.saveIntent({service:'resend',environment:'development',route:'api-key-case-managed',destination:{kind:'local'},sendingDomain:null}).ok,true);
    const ref=connectionCredentialRef(project,'development'),account=toAccount(ref),id=deriveConnectionId(project,'development');
    const mutation=store.beginCredentialMutation(ref);assert.equal(mutation.ok,true);assert.equal(store.finishCredentialMutation(ref,mutation.value,true),true);
    const revision=store.credentialRevision(ref);assert.ok(revision);
    const observation=store.beginObservation({kind:'application-check',authority:'agent-observed',basis:{credentialRevision:revision,destinationFingerprint:null,intentFingerprint:null,sourceFingerprint:null,verifierVersion:'synthetic-clerk-coexistence'}});assert.equal(observation.ok,true);
    assert.equal(store.beginLocalSession(revision,60000).ok,true);
    const previous=files(home),resendIntent=JSON.stringify(store.readIntent()),journal=JSON.stringify(store.readObservations()),receipt=JSON.stringify(store.readLocalSession());
    const cli=fileURLToPath(new URL('../dist/cli/index.js',import.meta.url));
    const select=(extra=[])=>spawnSync(process.execPath,[cli,'connection','set','--service','clerk','--env','preview','--route','provider-native','--destination','vercel',...extra,project],{encoding:'utf8',timeout:10000,env:{...process.env,HOME:home,USERPROFILE:home,DO_NOT_TRACK:'1'}});
    const selected=select();assert.equal(selected.status,0,selected.stderr);assert.match(selected.stdout,/Clerk connection intent/);assert.doesNotMatch(selected.stdout,/Resend connection intent/);checks++;
    assert.equal(store.readClerkNativeIntent().value.service,'clerk');assert.notEqual(store.readClerkNativeIntent().value.id,id);checks++;
    assert.equal(JSON.stringify(store.readIntent()),resendIntent);assert.equal(JSON.stringify(store.readObservations()),journal);assert.equal(JSON.stringify(store.readLocalSession()),receipt);assert.equal(store.localSessionLockStatus(),'present');assert.equal(toAccount(ref),account);assert.equal(store.credentialRevision(ref),revision);checks++;
    const after=files(home);for(const [path,content]of Object.entries(previous))assert.equal(after[path],content);assert.equal(Object.keys(after).length,Object.keys(previous).length+1);checks++;
    for(const bad of [{route:'api-key-case-managed'},{route:'manual'},{destination:{kind:'local'}},{destination:{kind:'cloudflare'}},{destination:{kind:'github'}},{sendingDomain:'example.test'},{service:'resend'}]) {
      assert.equal(store.saveClerkNativeIntent({...input(),...bad}).ok,false);checks++;
    }
    assert.deepEqual(files(home),after);checks++;
    assert.equal(select(['--sending-domain','example.test']).status,1);assert.deepEqual(files(home),after);checks++;
    const report=readClerkNativeReport(project,home);assert.equal(report.status,'selected');assert.equal(report.expectedInstance,'development');assert.equal(report.application,'not-checked');assert.equal(report.permission,'none');checks++;
    const vault=new MemoryVault();let clerkReads=0;
    const guardedVault=new Proxy(vault,{get(target,key){if(key==='hasSecret')return async ref=>{if(names.includes(ref.name)){clerkReads++;throw new Error(canary);}return target.hasSecret(ref);};return typeof target[key]==='function'?target[key].bind(target):target[key];}});
    const next=()=>buildNextReport(project,{vault:guardedVault,adapters:[],licensePlan:'free',connectionBaseDir:home,registryBaseDir:home});
    const onlySdk=await next();assert.equal(onlySdk.schemaVersion,13);assert.equal(onlySdk.clerkNative.service,'clerk');assert.equal(onlySdk.clerkNative.status,'selected');assert.equal(onlySdk.connection.status,'selected','the explicit Resend selection survives a scanner miss');assert.equal(onlySdk.guidedSetup,null);assert.equal(onlySdk.localSession.retry,'owner-review-required');assert.ok(!onlySdk.nextActions.some(a=>a.kind==='register-connection-credential'));checks++;
    writeFileSync(join(project,'app.ts'),'const a=process.env.CLERK_SECRET_KEY; const b=process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY; const c=process.env.OPENAI_API_KEY;\n');
    const mixed=await next();assert.equal(clerkReads,0);assert.ok(!mixed.secrets.some(secret=>names.includes(secret.name)));assert.ok(!mixed.nextActions.some(action=>names.includes(action.name)));assert.ok(mixed.nextActions.some(action=>action.kind==='register-secret'&&action.name==='OPENAI_API_KEY'));checks++;
    const clerkPath=Object.keys(after).find(path=>path.endsWith('clerk-native.json'));
    writeFileSync(join(home,clerkPath),'{}');const broken=await next();assert.equal(broken.clerkNative.status,'unavailable');assert.equal(clerkReads,0);assert.ok(!broken.nextActions.some(action=>names.includes(action.name)));checks++;
    writeFileSync(join(home,clerkPath),after[clerkPath]);
    assert.throws(()=>toAccount({...ref,name:'RESEND_API_KEY',service:'clerk'}));checks++;
    for(const args of [
      // Clerk credential input is supported now. Test a prohibited input source,
      // never open the real Human Plane from this offline provider-native suite.
      ['credential','save','--service','clerk','--env','preview','--stdin'],
      ['deploy','--service','clerk','--env','preview','--dry-run','--json'],
      ['check','--service','clerk','--json'],
      ['plan','--service','clerk','--env','preview','--json'],
      ['local','inspect','--service','clerk','--env','development','--artifact','dist/app.cjs','--max-seconds','10','--json']
    ]) {
      const refused=spawnSync(process.execPath,[cli,'connection',...args,project],{encoding:'utf8',timeout:10000,env:{...process.env,HOME:home,USERPROFILE:home,DO_NOT_TRACK:'1'}});
      assert.equal(refused.status,1);assert.deepEqual(files(home),after);checks++;
    }
    const marker=join(root,'calls');
    const fixture=(environment,data)=>{
      const source=`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'call\\n');\n`+
        `if(process.argv.slice(2).join(' ')==='--version'){console.log('59.11.7');process.exit(0)}\n`+
        `const expected=['api','/v10/projects/prj_fixture/env?target=${environment}','--method','GET','--raw','--non-interactive','--api','https://api.vercel.com','--scope','team_fixture'];\n`+
        `if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(expected))process.exit(9);\n`+
        `process.stdin.resume();process.stdin.on('end',()=>{console.log(${JSON.stringify(JSON.stringify({envs:data}))});console.error(${JSON.stringify(canary)});});\n`;
      writeFileSync(join(bin,'fixture.cjs'),source);
      if(process.platform==='win32')writeFileSync(join(bin,'vercel.cmd'),`@"${process.execPath}" "${join(bin,'fixture.cjs')}" %*\r\n`);
      else {writeFileSync(join(bin,'vercel'),`#!${process.execPath}\n${source}`);chmodSync(join(bin,'vercel'),0o700);}
    };
    const inspect=(environment,service='clerk')=>inspectProviderNative(project,environment,{connectionBaseDir:home,pathOverride:bin},service);
    fixture('preview',rows());assert.equal((await inspect('production')).reason,'intent-mismatch');assert.throws(()=>readFileSync(marker));checks++;
    assert.equal((await inspect('development','resend')).reason,'intent-mismatch');assert.throws(()=>readFileSync(marker));checks++;
    assert.equal(store.saveClerkNativeIntent(input('development')).ok,true);fixture('development',rows('development'));
    assert.equal((await inspect('development','resend')).reason,'intent-mismatch');assert.throws(()=>readFileSync(marker));checks++;
    if(process.platform==='linux') {
      const closed=spawnSync(process.execPath,[cli,'connection','native','inspect','--service','clerk','--env','development','--json',project],{encoding:'utf8',timeout:10000,env:{...process.env,HOME:home,USERPROFILE:home,DO_NOT_TRACK:'1'}});
      assert.equal(closed.status,1);const result=JSON.parse(closed.stdout);assert.equal(result.service,'clerk');assert.equal(result.schemaVersion,2);assert.ok(['basis-unavailable','cli-unavailable'].includes(result.reason));assert.throws(()=>readFileSync(marker));checks++;
    }
    for(const environment of ['development','preview','production']) {
      assert.equal(store.saveClerkNativeIntent(input(environment)).ok,true);fixture(environment,rows(environment));
      const inspected=await inspect(environment);assert.equal(inspected.service,'clerk');assert.equal(inspected.schemaVersion,2);assert.equal(inspected.configuration,'integration-managed');assert.equal(inspected.integrationIdentity,'unverified');assert.equal(inspected.application,'not-checked');assert.equal(inspected.permission,'none');assert.ok(!JSON.stringify(inspected).includes(canary));checks++;
      assert.equal(readClerkNativeReport(project,home).expectedInstance,environment==='production'?'production':'development');checks++;
    }
    assert.equal(JSON.stringify(store.readIntent()),resendIntent);assert.equal(JSON.stringify(store.readLocalSession()),receipt);assert.equal(store.localSessionLockStatus(),'present');assert.equal(clerkReads,0);checks++;
    console.log(`Clerk native profile: ${checks} checks passed; synthetic metadata/CLI only`);
  } finally {rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]?.endsWith('clerk-native.mjs'))await runClerkNativeTests();
