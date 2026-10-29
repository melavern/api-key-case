import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {ConnectionStateStore} from '../dist/core/agent/connection-state.js';
import {runDisposableLocalSessionTests} from './local-session-fixture.mjs';

const io=()=>Object.assign(new Error('synthetic-completion-private-no-output'),{code:'EIO'});
const original={renameSync:fs.renameSync,rmdirSync:fs.rmdirSync,readSync:fs.readSync};
const reset=()=>{Object.assign(fs,original);syncBuiltinESMExports();};
const lifecycle={execution:'possible',treeTermination:'confirmed'};

function storeCases(){
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'akc-completion-')));let cases=0;
 try{
  for(const mode of ['save-once','release-once','release-permanent','lock-replaced','receipt-changed','saved-read-changed','pending-changed','unsafe-lock','new-invocation','unknown']){
   reset();const project=join(root,mode),home=join(project,'home');fs.mkdirSync(home,{recursive:true});
   const store=new ConnectionStateStore(project,home);assert.equal(store.saveIntent({service:'resend',environment:'development',route:'api-key-case-managed',destination:{kind:'local'},sendingDomain:null}).ok,true);
   const started=store.beginLocalSession('2026-10-04T00:00:00.000Z',30000);assert.equal(started.ok,true);
   const dir=join(home,'.api-key-case','connections',fs.readdirSync(join(home,'.api-key-case','connections'))[0]);
   const record=join(dir,'local-session.json'),lock=join(dir,'local-session.lock');let saves=0,releases=0;
   fs.renameSync=(from,to)=>{
    if(to===record&&JSON.parse(fs.readFileSync(from,'utf8')).receipt.finishedAt){
     saves++;
     if((mode==='save-once'||mode==='pending-changed')&&saves===1){
      if(mode==='pending-changed'){const x=JSON.parse(fs.readFileSync(record,'utf8'));x.receipt.maxDurationMs++;fs.writeFileSync(record,JSON.stringify(x));}
      throw io();
     }
    }
    return original.renameSync(from,to);
   };
   fs.rmdirSync=path=>{
    if(path===lock){
     releases++;
     if(mode!=='save-once'&&mode!=='pending-changed'&&mode!=='unknown'&&(releases===1||mode==='release-permanent')){
      if(mode==='lock-replaced'){original.renameSync(lock,lock+'-old');fs.mkdirSync(lock);}
      if(mode==='unsafe-lock'){fs.rmSync(lock,{recursive:true});fs.writeFileSync(lock,'synthetic-invalid-lock');}
      if(mode==='receipt-changed'){const x=JSON.parse(fs.readFileSync(record,'utf8'));x.receipt.maxDurationMs++;fs.writeFileSync(record,JSON.stringify(x));}
      throw io();
     }
    }
    return original.rmdirSync(path);
   };syncBuiltinESMExports();
   if(mode==='unknown'){
    assert.equal(store.finishLocalSession(started.value.attemptId,'unknown',false,{execution:'possible',treeTermination:'unknown'}),true);
    assert.equal(store.finishLocalSession(started.value.attemptId,'unknown',true,{execution:'possible',treeTermination:'unknown'}),false);
    assert.equal(fs.existsSync(lock),true);assert.equal(releases,0);cases++;continue;
   }
   assert.equal(store.finishLocalSession(started.value.attemptId,'exited',true,lifecycle),false);
   const saved=fs.readFileSync(record,'utf8');
   let readChanged=false;
   if(mode==='saved-read-changed'){
    fs.readSync=(fd,buffer,...args)=>{
     const bytes=original.readSync(fd,buffer,...args);
     if(!readChanged){
      const value=JSON.parse(buffer.subarray(0,bytes).toString('utf8'));
      if(value.receipt?.attemptId===started.value.attemptId){
       value.receipt.maxDurationMs++;fs.writeFileSync(record,JSON.stringify(value));readChanged=true;
      }
     }
     return bytes;
    };syncBuiltinESMExports();
   }
   const second=mode==='new-invocation'?new ConnectionStateStore(project,home):store;
   const ok=second.finishLocalSession(started.value.attemptId,'exited',true,lifecycle);
   assert.equal(ok,['save-once','release-once'].includes(mode));
   if(ok)assert.equal(fs.existsSync(lock),false);else assert.equal(fs.existsSync(lock),true);
   if(mode==='saved-read-changed'){
    assert.equal(readChanged,true);assert.equal(saves,1,'a changed read must never trigger rewriting a saved completion');
    assert.equal(JSON.parse(fs.readFileSync(record,'utf8')).receipt.maxDurationMs,30001);
    assert.deepEqual(second.localSessionCompletionFailure(),{phase:'lock-release',issue:'record-unavailable'});
   }else if(mode!=='save-once')assert.equal(fs.readFileSync(record,'utf8'),saved,'saved or changed evidence must not be rewritten');
   if(mode==='release-once')assert.equal(saves,1,'already saved completion is verified without another write');
   if(mode==='lock-replaced'||mode==='unsafe-lock')assert.equal(second.localSessionCompletionFailure().issue,'unsafe-path');
   if(mode==='receipt-changed'||mode==='pending-changed')assert.equal(second.localSessionCompletionFailure().issue,'record-unavailable');
   if(mode==='release-permanent')assert.deepEqual(second.localSessionCompletionFailure(),{phase:'lock-release',issue:'io-error'});
   cases++;
  }
  console.log(`Local completion storage: ${cases} cases passed; exact invocation/receipt/lock, no saved-result rewrite.`);
 }finally{reset();fs.rmSync(root,{recursive:true,force:true});}
}

export async function runLocalCompletionCoordinatorCases({fixture}){
 let cases=0;const finish=ConnectionStateStore.prototype.finishLocalSession;
 try{
  for(const mode of ['save-once','no-launch-save-once','release-once','save-permanent','release-permanent','lock-replaced','receipt-changed','unknown']){
   reset();const f=await fixture();f.request.maxDurationMs=30000;if(mode==='unknown')f.terminal='UNKNOWN';
   if(mode==='no-launch-save-once')f.onRead=f.edit;
   const record=join(f.metadata,'local-session.json'),lock=join(f.metadata,'local-session.lock');let saves=0,releases=0,finishes=0;
   ConnectionStateStore.prototype.finishLocalSession=function(...args){finishes++;return finish.apply(this,args);};
   fs.renameSync=(from,to)=>{
    if(to===record&&JSON.parse(fs.readFileSync(from,'utf8')).receipt.finishedAt){saves++;if(['save-once','no-launch-save-once','save-permanent','unknown'].includes(mode)&&(saves===1||mode==='save-permanent'))throw io();}
    return original.renameSync(from,to);
   };
   fs.rmdirSync=path=>{
    if(path===lock){releases++;if(['release-once','release-permanent','lock-replaced','receipt-changed'].includes(mode)&&(releases===1||mode==='release-permanent')){
     if(mode==='lock-replaced'){original.renameSync(lock,lock+'-old');fs.mkdirSync(lock);}
     if(mode==='receipt-changed'){const x=JSON.parse(fs.readFileSync(record,'utf8'));x.receipt.maxDurationMs++;fs.writeFileSync(record,JSON.stringify(x));}
     throw io();
    }}return original.rmdirSync(path);
   };syncBuiltinESMExports();
   const result=await f.run(),ok=['save-once','no-launch-save-once','release-once'].includes(mode),notLaunched=mode==='no-launch-save-once';
   assert.equal(result.status,notLaunched?'changed':ok?'exited':'unknown');assert.equal(result.receiptSaved,ok);
   assert.equal(finishes,mode==='unknown'?1:2,'at most one extra finish; unknown teardown is not retried');
   assert.equal(fs.existsSync(lock),!ok);assert.equal(f.approvals,1);assert.equal(f.spawns,1);assert.equal(f.reads,1);assert.equal(f.secretMessages,notLaunched?0:1);assert.equal(f.releases,notLaunched?0:1);
   if(notLaunched){assert.equal(result.execution,'not-started');assert.equal(result.treeTermination,'not-needed');}
   assert.equal(result.permission,'none');assert.equal(result.applicationReadiness,'not-verified');
   if(mode==='release-once')assert.equal(saves,1);
   if(mode==='save-permanent'||mode==='unknown')assert.deepEqual(result.completionFailure,{phase:'result-save',issue:'io-error'});
   if(mode==='release-permanent')assert.deepEqual(result.completionFailure,{phase:'lock-release',issue:'io-error'});
   if(mode==='lock-replaced')assert.equal(result.completionFailure.issue,'unsafe-path');
   if(mode==='receipt-changed')assert.equal(result.completionFailure.issue,'record-unavailable');
   assert.ok(!JSON.stringify(result).includes('synthetic-completion-private-no-output'));cases++;
  }
  console.log(`Local completion coordinator: ${cases} cases passed; bounded finish only, no repeated approval/key read/owner/app release.`);
 }finally{reset();ConnectionStateStore.prototype.finishLocalSession=finish;}
}

export async function runLocalSessionCompletionTests(){storeCases();await runDisposableLocalSessionTests({completionOnly:true});}
if(process.argv[1]===fileURLToPath(import.meta.url))await runLocalSessionCompletionTests();
