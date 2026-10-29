import assert from 'node:assert/strict';
import {unsafeMetadataLink} from './helpers/metadata-link-fixture.mjs';
import {canonicalProjectRealpath} from '../dist/core/vault/naming.js';
import {createHash} from 'node:crypto';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,rmdirSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ConnectionStateStore} from '../dist/core/agent/connection-state.js';
import {clerkNativeIntentFingerprint} from '../dist/core/agent/clerk-native.js';
import {connectionIntentFingerprint} from '../dist/core/agent/fingerprints.js';
import {recordNativeInspection,recordNativeApplication,readNativeApplicationEvidence} from '../dist/core/agent/native-observations.js';
import {buildNextReport} from '../dist/core/agent/next.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const canary='synthetic-native-observation-private';
function snapshot(root,prefix='') {
  return Object.fromEntries(readdirSync(join(root,prefix),{withFileTypes:true}).flatMap(row=>{
    const path=join(prefix,row.name);
    return row.isDirectory()?Object.entries(snapshot(root,path)):row.isFile()?[[path,readFileSync(join(root,path)).toString('base64')]]:[];
  }));
}
export async function runNativeObservationTests() {
  let checks=0;
  const root=realpathSync(mkdtempSync(join(tmpdir(),'akc-native-observations-')));
  const cli=fileURLToPath(new URL('../dist/cli/index.js',import.meta.url));
  function fixture(service='clerk',environment='development') {
    const dir=join(root,`${service}-${environment}-${checks}`),home=join(dir,'home'),project=join(dir,'project');
    for(const path of [dir,home,project,join(project,'.vercel')])mkdirSync(path,{mode:0o700});
    const linked=join(project,'.vercel','project.json');
    writeFileSync(linked,JSON.stringify({orgId:'team_fixture',projectId:'prj_fixture',unused:canary}));
    const store=new ConnectionStateStore(project,home);
    const select=(env=environment)=>service==='clerk'?store.saveClerkNativeIntent({service,environment:env,route:'provider-native',destination:{kind:'vercel'},sendingDomain:null}):
      store.saveIntent({service,environment:env,route:'provider-native',destination:{kind:'vercel'},sendingDomain:null});
    assert.equal(select().ok,true);
    const read=()=>readNativeApplicationEvidence(project,service,home);
    const inspection=(configuration='integration-managed')=>{
      const intent=(service==='clerk'?store.readClerkNativeIntent():store.readIntent()).value;
      return {schemaVersion:service==='clerk'?2:1,service,environment,destination:'vercel',status:configuration==='unknown'?'unknown':'inspected',reason:configuration==='unknown'?'unexpected-output':'inspected',configuration,
        configurationFingerprint:configuration==='unknown'?null:hash(`${service}-${environment}-${configuration}`),intentFingerprint:service==='clerk'?clerkNativeIntentFingerprint(intent):connectionIntentFingerprint(intent),
        destinationSelectionFingerprint:read().destinationSelectionFingerprint,observedAt:new Date().toISOString(),integrationIdentity:'unverified',credentialValidity:'not-checked',application:'not-checked',permission:'none',value:canary};
    };
    const capture=(configuration='integration-managed')=>recordNativeInspection(project,inspection(configuration),600,home);
    const observe=(id,outcome='passed',extra={})=>recordNativeApplication(project,{service,environment,inspectionId:id,feature:service==='clerk'?'protected-access':'send-and-delivery',observer:'agent',outcome,maxAgeSeconds:300,...extra},home);
    return {dir,home,project,linked,store,service,environment,select,read,inspection,capture,observe};
  }
  try {
    for(const service of ['clerk','resend'])for(const environment of ['development','preview','production']) {
      const f=fixture(service,environment), initial=f.read();
      assert.equal(initial.reason,'inspection-missing');assert.ok(initial.destinationSelectionFingerprint);checks++;
      const configuration=f.capture();assert.equal(configuration.status,'recorded');assert.equal(f.read().reason,'application-missing');checks++;
      const app=f.observe(configuration.receiptId);assert.equal(app.status,'recorded');assert.equal(app.executed,false);assert.equal(app.permission,'none');checks++;
      const report=f.read();assert.equal(report.status,'reported');assert.equal(report.currentHealth,'unverified');assert.equal(report.permission,'none');
      assert.equal(report.service,service);assert.equal(report.environment,environment);assert.equal(report.application.inspectionId,configuration.receiptId);
      assert.equal(report.application.destinationSelectionFingerprint,initial.destinationSelectionFingerprint);assert.equal(report.application.outcome,'passed');assert.equal(report.application.authority,'agent-observed');
      assert.equal(report.application.feature,service==='clerk'?'protected-access':'send-and-delivery');assert.deepEqual(report.remaining,[]);assert.ok(!JSON.stringify(report).includes(canary));checks++;
      if(service==='clerk') {
        const intent=f.store.readClerkNativeIntent().value,path=join(f.home,'.api-key-case','connections',hash(canonicalProjectRealpath(f.project)),'clerk-native.json'),bytes=readFileSync(path),stat=statSync(path),stable=snapshot(f.home);
        assert.deepEqual(f.select().value,intent);assert.deepEqual(f.read(),report);assert.deepEqual(readFileSync(path),bytes);assert.equal(statSync(path).ino,stat.ino);assert.equal(statSync(path).mtimeMs,stat.mtimeMs);assert.deepEqual(snapshot(f.home),stable);checks++;
      }
      const before=snapshot(f.home);let vaultCalls=0;
      const next=await buildNextReport(f.project,{vault:new Proxy({},{get(){vaultCalls++;throw new Error(canary);}}),adapters:[],licensePlan:'free',connectionBaseDir:f.home,registryBaseDir:f.home,offline:true});
      const projected=service==='clerk'?next.clerkNative.applicationObservation:next.connection.report.nativeApplicationObservation;
      assert.equal(next.schemaVersion,13);assert.deepEqual(projected,report);assert.equal(vaultCalls,0);assert.deepEqual(snapshot(f.home),before);
       if(service==='resend'){assert.notEqual(next.connection.report.stage,'ready');assert.equal(next.connection.report.applicationCheck.reason,'observation-missing');assert.deepEqual(next.connection.report.recovery,[]);assert.ok(next.connection.report.plan.recovery.some(item=>item.action==='await-destination-resolver'));}
      else assert.equal(next.clerkNative.application,'not-checked');checks++;
      for(const extra of [{environment:environment==='development'?'preview':'development'},{service:service==='clerk'?'resend':'clerk'},{feature:service==='clerk'?'send-and-delivery':'protected-access'},
        {observer:'provider'},{maxAgeSeconds:0},{maxAgeSeconds:86401},{inspectionId:'00000000-0000-0000-0000-000000000000'}]) {
        assert.equal(f.observe(configuration.receiptId,'passed',extra).status,'unknown');assert.deepEqual(snapshot(f.home),before);checks++;
      }
      const historical=report.application.destinationSelectionFingerprint;
      writeFileSync(f.linked,JSON.stringify({orgId:'team_other',projectId:'prj_other'}));
      assert.equal(f.read().reason,'scope-changed');assert.equal(f.read().application.destinationSelectionFingerprint,historical);
      assert.notEqual(f.read().destinationSelectionFingerprint,historical);assert.equal(f.observe(configuration.receiptId).status,'unknown');assert.deepEqual(snapshot(f.home),before);checks++;
    }
    for(const configuration of ['present-unmanaged','absent','partial','unknown']) {
      const f=fixture(), result=f.capture(configuration);
      assert.equal(result.status,'recorded');assert.equal(f.read().currentHealth,'unverified');
      assert.equal(f.observe(result.receiptId).status,configuration==='present-unmanaged'?'recorded':'unknown');checks++;
    }
    const f=fixture(), first=f.capture(), app=f.observe(first.receiptId,'failed');
    assert.equal(f.read().application.outcome,'failed');assert.deepEqual(f.read().remaining,['review-recorded-failure']);checks++;
    assert.equal(f.observe(first.receiptId,'passed',{observer:'human'}).status,'recorded');assert.equal(f.read().application.authority,'human-reported');assert.equal(f.read().currentHealth,'unverified');checks++;
    const oldExpiry=f.read().application.expiresAt, repeated=f.capture();assert.notEqual(repeated.receiptId,first.receiptId);
    assert.equal(f.read().status,'reported');assert.equal(f.read().application.expiresAt,oldExpiry);assert.equal(f.read().currentHealth,'unverified');checks++;
    const newer=f.capture('present-unmanaged');assert.notEqual(newer.receiptId,first.receiptId);assert.equal(f.read().reason,'inspection-changed');
    const stable=snapshot(f.home);assert.equal(f.observe(first.receiptId).status,'unknown');assert.deepEqual(snapshot(f.home),stable);checks++;
    assert.equal(f.observe(newer.receiptId,'unknown').status,'recorded');assert.equal(f.read().status,'unknown');assert.deepEqual(f.read().remaining,['observe-application-feature']);checks++;
    const rollback=Date.now;try{Date.now=()=>rollback()-10000;assert.equal(f.read().reason,'observation-time-invalid');assert.deepEqual(f.read().remaining,['review-observation-storage']);checks++;}finally{Date.now=rollback;}
    const now=Date.now,expiryBefore=snapshot(f.home);try{Date.now=()=>now()+601000;const expired=f.read();assert.equal(expired.reason,'observation-expired');assert.equal(f.select().ok,true);assert.deepEqual(f.read(),expired);assert.equal(f.observe(newer.receiptId).status,'unknown');assert.deepEqual(snapshot(f.home),expiryBefore);checks++;}finally{Date.now=now;}
    const native=f.store.readObservations().value.at(-1).basis;
    assert.equal(f.store.beginObservation({kind:'application-check',authority:'provider-observed',basis:native}).ok,false);
    assert.equal(f.store.beginObservation({kind:'application-check',authority:'agent-observed',basis:{...native,native:{...native.native,message:canary}}}).ok,false);checks++;
    const dir=join(f.home,'.api-key-case','connections',readdirSync(join(f.home,'.api-key-case','connections'))[0]),journal=join(dir,'observations.json'),lock=join(dir,'lock');
    const journalBytes=readFileSync(journal);
    mkdirSync(lock);const locked=snapshot(f.home);assert.equal(f.read().reason,'observation-unavailable');assert.equal(f.observe(newer.receiptId).status,'unknown');assert.deepEqual(snapshot(f.home),locked);rmdirSync(lock);checks++;
    writeFileSync(journal,'{}');assert.equal(f.read().status,'unknown');assert.equal(f.capture().status,'unknown');assert.equal(readFileSync(journal,'utf8'),'{}');writeFileSync(journal,journalBytes);chmodSync(journal,0o600);checks++;
    const beforeSymlink=snapshot(f.home);rmSync(f.linked);unsafeMetadataLink(journal,f.linked);assert.equal(f.read().reason,'scope-unresolved');assert.equal(f.observe(newer.receiptId).status,'unknown');assert.deepEqual(snapshot(f.home),beforeSymlink);checks++;
    const pending=fixture(), good=pending.capture(), oldFinish=ConnectionStateStore.prototype.finishObservation;
    try{ConnectionStateStore.prototype.finishObservation=()=>({ok:false,issue:'io-error',value:null});assert.equal(pending.observe(good.receiptId).status,'unknown');}finally{ConnectionStateStore.prototype.finishObservation=oldFinish;}
    assert.equal(pending.read().reason,'observation-interrupted');assert.equal(pending.read().application.outcome,'unknown');checks++;
    const race=fixture(), raceConfig=race.capture();race.observe(raceConfig.receiptId);
    const oldRead=ConnectionStateStore.prototype.readObservations;let reads=0;
    try {ConnectionStateStore.prototype.readObservations=function(){reads++;const result=oldRead.call(this);writeFileSync(race.linked,JSON.stringify({orgId:'team_changed',projectId:'prj_changed'}));return result;};
      const changed=race.read();assert.equal(changed.reason,'scope-changed');assert.equal(changed.currentHealth,'unverified');assert.equal(reads,1);checks++;
    } finally {ConnectionStateStore.prototype.readObservations=oldRead;}
    {
      const f=fixture(),inspection=f.capture();f.observe(inspection.receiptId);const original=f.store.readClerkNativeIntent().value,application=f.read().application,clock=Date.now;
      try {
        Date.now=()=>Date.parse(original.updatedAt)-1000;
        const changed=f.select('preview').value;assert.ok(Date.parse(changed.updatedAt)>Date.parse(original.updatedAt));
        const restored=f.select().value;assert.ok(Date.parse(restored.updatedAt)>Date.parse(changed.updatedAt));assert.deepEqual(f.select().value,restored);
      } finally {Date.now=clock;}
      const report=f.read(),before=snapshot(f.home);assert.equal(report.reason,'scope-changed');assert.equal(report.status,'stale');assert.deepEqual(report.application,application);assert.equal(f.observe(inspection.receiptId).status,'unknown');assert.deepEqual(snapshot(f.home),before);checks++;
    }
    {
      const f=fixture(),path=join(f.home,'.api-key-case','connections',hash(canonicalProjectRealpath(f.project)),'clerk-native.json'),dir=join(f.home,'.api-key-case','connections',hash(canonicalProjectRealpath(f.project)));
      const input={service:'clerk',environment:'development',route:'provider-native',destination:{kind:'vercel'},sendingDomain:null},save=value=>f.store.saveClerkNativeIntent(value),bytes=readFileSync(path),stable=snapshot(f.home);
      for(const extra of [{service:'resend'},{environment:'staging'},{route:'api-key-case-managed'},{destination:{kind:'cloudflare'}},{sendingDomain:'example.test'},{destination:{kind:'vercel',extra:true}},{extra:true}]) {
        assert.equal(save({...input,...extra}).issue,'invalid-data');assert.deepEqual(snapshot(f.home),stable);checks++;
      }
      mkdirSync(join(dir,'lock'));const locked=snapshot(f.home);assert.equal(save(input).issue,'lock-present');assert.deepEqual(snapshot(f.home),locked);rmdirSync(join(dir,'lock'));checks++;
      writeFileSync(path+'.tmp','pending');const pending=snapshot(f.home);assert.equal(save(input).issue,'temporary-file-present');assert.deepEqual(snapshot(f.home),pending);rmSync(path+'.tmp');checks++;
      for(const extra of [{id:'a'.repeat(64)},{slot:'other'},{service:'resend'},{environment:'preview'},{route:'api-key-case-managed'},{destination:{kind:'cloudflare'}},{sendingDomain:'example.test'}]) {
        const data=JSON.parse(bytes);Object.assign(data.intent,extra);writeFileSync(path,JSON.stringify(data));const corrupt=snapshot(f.home);assert.equal(save(input).issue,'invalid-data');assert.deepEqual(snapshot(f.home),corrupt);checks++;
      }
      writeFileSync(path,bytes);chmodSync(path,0o600);const backing=join(f.dir,'synthetic-selection.json');writeFileSync(backing,bytes);rmSync(path);unsafeMetadataLink(backing,path);const unsafe=snapshot(f.home);assert.equal(save(input).issue,'unsafe-path');assert.deepEqual(snapshot(f.home),unsafe);assert.deepEqual(readFileSync(backing),bytes);checks++;
    }
    const coexist=fixture();coexist.store.saveIntent({service:'resend',environment:'production',route:'provider-native',destination:{kind:'vercel'},sendingDomain:null});
    const legacy=coexist.store.beginObservation({kind:'application-check',authority:'human-reported',basis:{credentialRevision:null,destinationFingerprint:null,intentFingerprint:null,sourceFingerprint:null,verifierVersion:'legacy-application-v1'}});
    assert.equal(legacy.ok,true);assert.equal(coexist.store.finishObservation(legacy.value.id,'completed','application-passed').ok,true);
    const legacyBefore=coexist.store.readObservations().value[0], own=coexist.capture();coexist.observe(own.receiptId);
    assert.deepEqual(coexist.store.readObservations().value[0],legacyBefore);assert.notEqual(coexist.store.readObservations().value.at(-1).connectionId,legacyBefore.connectionId);checks++;
    const c=fixture('clerk','preview'), receipt=c.capture(), marker=join(c.dir,'effects.json'),preload=join(c.dir,'readonly.cjs');
    const env={...process.env,HOME:c.home,USERPROFILE:c.home,DO_NOT_TRACK:'1'};
    const run=(args,extra={})=>spawnSync(process.execPath,[cli,'connection','native',...args,c.project],{encoding:'utf8',timeout:10000,env:{...env,...extra}});
    const observed=run(['observe-application','--service','clerk','--env','preview','--inspection',receipt.receiptId,'--feature','protected-access','--observer','human','--outcome','passed','--max-age-seconds','300','--json']);
    assert.equal(observed.status,0,observed.stderr);assert.equal(JSON.parse(observed.stdout).status,'recorded');assert.equal(c.read().application.authority,'human-reported');checks++;
    const selectionPath=join(c.home,'.api-key-case','connections',hash(canonicalProjectRealpath(c.project)),'clerk-native.json');
    const selectionBefore=readFileSync(selectionPath),selectionStat=statSync(selectionPath),observationBefore=c.read(),selectionSnapshot=snapshot(c.home);
    for(let repeat=0;repeat<2;repeat++) {
      const selected=spawnSync(process.execPath,[cli,'connection','set','--service','clerk','--env','preview','--route','provider-native','--destination','vercel',c.project],{encoding:'utf8',timeout:10000,env});
      assert.equal(selected.status,0,selected.stderr);assert.equal(c.read().status,'reported','identical Clerk native selection must preserve the application observation');
      assert.deepEqual(c.read(),observationBefore);assert.deepEqual(readFileSync(selectionPath),selectionBefore);assert.equal(statSync(selectionPath).ino,selectionStat.ino);assert.equal(statSync(selectionPath).mtimeMs,selectionStat.mtimeMs);assert.deepEqual(snapshot(c.home),selectionSnapshot);checks++;
    }
    writeFileSync(preload,`const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net'),http=require('node:http'),https=require('node:https');const saved=fs.writeFileSync;const effects={writes:0,children:0,network:0};for(const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync','rmSync','chmodSync'])fs[name]=()=>{effects.writes++;throw Error('forbidden')};for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync'])cp[name]=()=>{effects.children++;throw Error('forbidden')};net.Socket.prototype.connect=()=>{effects.network++;throw Error('forbidden')};http.request=https.request=()=>{effects.network++;throw Error('forbidden')};require('node:module').syncBuiltinESMExports();process.on('exit',()=>saved(${JSON.stringify(marker)},JSON.stringify(effects)));`);
    const immutable=snapshot(c.home);
    const next=spawnSync(process.execPath,[cli,'next','--json','--offline',c.project],{encoding:'utf8',timeout:10000,env:{...env,NODE_OPTIONS:`${env.NODE_OPTIONS??''} --require=${preload}`}});
    assert.equal(next.status,0,next.stderr);const restored=JSON.parse(next.stdout);
    assert.equal(restored.schemaVersion,13);assert.deepEqual(restored.clerkNative.applicationObservation,observationBefore);assert.equal(restored.clerkNative.applicationObservation.application.authority,'human-reported');assert.equal(restored.clerkNative.applicationObservation.application.outcome,'passed');
    assert.equal(restored.clerkNative.applicationObservation.currentHealth,'unverified');assert.equal(restored.clerkNative.application,'not-checked');
    assert.deepEqual(snapshot(c.home),immutable);assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')),{writes:0,children:0,network:0});assert.ok(!next.stdout.includes(canary));checks++;
    for(const extra of [['--command','anything'],['--inspection-file','arbitrary.json'],['--observer','provider'],['--max-age-seconds','86401']]) {
      const refused=run(['observe-application','--service','clerk','--env','preview','--inspection',receipt.receiptId,'--feature','protected-access','--observer','human','--outcome','passed','--max-age-seconds','300','--json',...extra]);
      assert.equal(refused.status,1);assert.deepEqual(snapshot(c.home),immutable);assert.ok(!refused.stdout.includes(canary));checks++;
    }
    if(process.platform==='linux') {
      const recorded=run(['inspect','--service','clerk','--env','preview','--record','--max-age-seconds','600','--json']);
      assert.equal(recorded.status,1);const result=JSON.parse(recorded.stdout);assert.equal(result.inspection.status,'unknown');assert.equal(result.recording.status,'recorded');
      assert.equal(c.read().reason,'inspection-unverified');assert.equal(c.read().currentHealth,'unverified');assert.equal(c.read().application.authority,'human-reported');checks++;
    }
    console.log(`Native application observations: ${checks} checks passed; synthetic metadata/CLI only`);
  } finally {rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]?.endsWith('native-observations.mjs'))await runNativeObservationTests();
