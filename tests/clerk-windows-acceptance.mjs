import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {acceptanceRevision,finalizeClerkAcceptance,compiledCandidateHash,writeAcceptanceRecord,acceptClerkMilestone,acceptanceChildSource,enableClerkAcceptanceCopy,SYNTHETIC_VERSION,SYNTHETIC_CLERK_VALUE} from '../tools/accept-clerk-windows.mjs';

export async function runClerkWindowsAcceptanceTests(){
 const replies={save:'saved','cancel-overwrite':'cancelled','cancel-remove':'cancelled',remove:'removed'};
 const fixture=()=>{let present=false,calls=[];return {calls,invoke:id=>{calls.push(id);if(id==='preflight')return {status:0,stdout:JSON.stringify({kind:'preflight',status:'ready'})};if(id.endsWith('prepare'))return {status:0,stdout:JSON.stringify({service:'clerk',status:id==='approve-prepare'?'prepared':'declined',versionId:id==='approve-prepare'?SYNTHETIC_VERSION:null,activation:'not-performed-by-this-invocation',historySaved:id==='approve-prepare'})};if(id==='save')present=true;if(id==='remove')present=false;return {status:0,stdout:JSON.stringify({service:id==='check-resend'?'resend':'clerk',environment:id==='check-preview'?'preview':id==='check-production'?'production':'development',status:replies[id]??(id==='check-clerk'&&present?'registered':'missing')})};}};};
 const f=fixture(),records=[],messages=[];
 const result=await acceptClerkMilestone({invoke:f.invoke,tell:s=>messages.push(s),confirmLayout:async()=>true,record:r=>records.push(r)});
 assert.equal(result.status,'checks-passed');assert.equal(result.cleanup,'credential-absence-confirmed');assert.equal(messages.length,6);
 assert.deepEqual(f.calls.filter(id=>!id.startsWith('check-')),['preflight','save','decline-prepare','approve-prepare','cancel-overwrite','cancel-remove','remove']);
 assert.ok(!JSON.stringify(records).includes(SYNTHETIC_CLERK_VALUE));assert.ok(records.every(r=>Object.keys(r).sort().join(',')==='cleanup,kind,layoutConfirmed,schemaVersion,status,steps'));
 const preflightCalls=[],preflightMessages=[];const unavailable=await acceptClerkMilestone({invoke:id=>{preflightCalls.push(id);return {status:0,stdout:JSON.stringify({kind:'preflight',status:'unavailable'})};},tell:s=>preflightMessages.push(s),confirmLayout:async()=>true,record:()=>{}});assert.equal(unavailable.status,'failed');assert.equal(unavailable.cleanup,'not-started');assert.deepEqual(preflightCalls,['preflight']);assert.deepEqual(preflightMessages,[]);
 const unobserved=fixture();assert.equal((await acceptClerkMilestone({invoke:unobserved.invoke,tell:()=>{},confirmLayout:async()=>false,record:()=>{}})).status,'layout-unconfirmed');
 for(const output of ['synthetic-output-canary',JSON.stringify({service:'clerk',environment:'development',status:'saved',value:'synthetic-output-canary'}),JSON.stringify({service:'resend',environment:'development',status:'registered'})]){
  const evidence=[];const r=await acceptClerkMilestone({invoke:()=>({status:0,stdout:output}),tell:()=>{},confirmLayout:async()=>true,record:e=>evidence.push(e)});assert.equal(r.status,'failed');assert.equal(r.cleanup,'not-started');assert.equal(r.steps.length,1);assert.ok(!JSON.stringify(evidence).includes('synthetic-output-canary'));
 }
 const failed=fixture();const r=await acceptClerkMilestone({invoke:id=>id==='approve-prepare'?{status:1,stdout:'{}'}:failed.invoke(id),tell:()=>{},confirmLayout:async()=>true,record:()=>{}});assert.equal(r.status,'failed');assert.ok(!failed.calls.includes('remove'),'unknown run never auto-deletes');
 assert.equal(enableClerkAcceptanceCopy('export const CLERK_PREPARATION_NATIVE_ACCEPTED = false;','CLERK_PREPARATION_NATIVE_ACCEPTED'),'export const CLERK_PREPARATION_NATIVE_ACCEPTED = true;');
 assert.equal(enableClerkAcceptanceCopy('export const G = true;','G'),'export const G = true;');
 for(const source of ['export const G = true; G = false;','export const G = false; G = false;','unrelated'])assert.throws(()=>enableClerkAcceptanceCopy(source,'G'));
 for(const fault of ['validate','cleanup']){
  const seen=[];const final=finalizeClerkAcceptance(result,{validate:()=>{if(fault==='validate')throw Error('synthetic-private-canary');return true;},cleanup:()=>{if(fault==='cleanup')throw Error('synthetic-private-canary');},record:r=>seen.push(r)});
  assert.equal(final.status,'failed');assert.ok(seen.every(r=>r.status!=='passed'));assert.equal(seen[0].status,'pending-final-validation');assert.ok(!JSON.stringify(seen).includes('synthetic-private-canary'));
 }
 const fact=finalizeClerkAcceptance(result,{validate:r=>{r.productionGatesChanged=true;return false;},cleanup:()=>{},record:()=>{}});assert.equal(fact.status,'failed');assert.equal(fact.productionGatesChanged,true);
 const successful=[];assert.equal(finalizeClerkAcceptance(result,{validate:()=>true,cleanup:()=>{},record:r=>successful.push(r)}).status,'passed');assert.equal(successful.at(-1).status,'passed');
 const git=(unknown='',dirty=false)=>(_cmd,args)=>({status:args[0]==='diff'&&dirty?1:0,stdout:args[0]==='rev-parse'?'a'.repeat(40):args.includes('--others')?unknown:'tools/accept-clerk-windows.mjs'});
 assert.equal(acceptanceRevision('/synthetic',git()),'a'.repeat(40));assert.equal(acceptanceRevision('/synthetic',git('packages/untracked.ts')),null);assert.equal(acceptanceRevision('/synthetic',git('',true)),null);
 const root=mkdtempSync(join(tmpdir(),'akc-clerk-controller-'));
 try{const record=join(root,'record.json');writeAcceptanceRecord(record,{status:'pending-final-validation'});const first=compiledCandidateHash(root);writeAcceptanceRecord(record,{status:'failed'});assert.notEqual(compiledCandidateHash(root),first);const child=join(root,'child.mjs');writeFileSync(child,acceptanceChildSource({dist:join(root,"odd '$& path"),project:join(root,'project'),home:join(root,'home'),bin:join(root,'bin'),publicKey:'synthetic-public-key'}));const parsed=spawnSync(process.execPath,['--check',child],{encoding:'utf8'});assert.equal(parsed.status,0,parsed.stderr);}
 finally{rmSync(root,{recursive:true,force:true});}
 if(process.platform!=='win32'){const unsupported=spawnSync(process.execPath,[fileURLToPath(new URL('../tools/accept-clerk-windows.mjs',import.meta.url))],{encoding:'utf8'});assert.equal(unsupported.status,1);assert.match(unsupported.stderr,/Windows 11/);}
 console.log('Clerk Windows acceptance controller passed; no native dialog/store/provider operation');
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runClerkWindowsAcceptanceTests();
