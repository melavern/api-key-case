// Disposable compiled candidate only; no host/keyring override ships in production.
import assert from 'node:assert/strict';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
export function runDisposableClerkPrepareTests(){
 const repo=fileURLToPath(new URL('..',import.meta.url)),root=mkdtempSync(join(tmpdir(),'akc-clerk-prepare-fixture-'));
 try{
  for(const name of ['dist','dist-guard','dist-platform'])cpSync(join(repo,'dist'),join(root,name),{recursive:true});
  mkdirSync(join(root,'tests'));mkdirSync(join(root,'node_modules'));writeFileSync(join(root,'package.json'),'{"type":"module","private":true}');
  for(const name of ['clerk-prepare.mjs','clerk-prepare-fixture.mjs'])cpSync(join(repo,'tests',name),join(root,'tests',name));
  for(const name of readdirSync(join(repo,'node_modules'))){if(name==='@napi-rs')continue;const from=join(repo,'node_modules',name),to=join(root,'node_modules',name);if(statSync(from).isDirectory())symlinkSync(from,to,process.platform==='win32'?'junction':undefined);else cpSync(from,to);}
  const mock=join(root,'node_modules/@napi-rs/keyring');mkdirSync(mock,{recursive:true});writeFileSync(join(mock,'package.json'),'{"name":"@napi-rs/keyring","version":"0.0.0-synthetic","type":"module","exports":"./index.js"}');
  writeFileSync(join(mock,'index.js'),"export class Entry {constructor(service,account){this.service=service;this.account=account;}getPassword(){throw Error('Unexpected synthetic read');}setPassword(){throw Error('No native write');}deletePassword(){throw Error('No native delete');}}\n");
  let text;for(const name of ['dist','dist-platform','dist-guard']){const gate=join(root,name,'core/agent/clerk-managed.js');text=readFileSync(gate,'utf8');const token='CLERK_PREPARATION_NATIVE_ACCEPTED = true';assert.equal(text.split(token).length,2);if(name==='dist-guard')writeFileSync(gate,text.replace(token,'CLERK_PREPARATION_NATIVE_ACCEPTED = false'));}
  for(const name of ['engine','handoff']){const file=join(root,'dist/core/deploy',name+'.js');text=readFileSync(file,'utf8');const pattern='process.platform !== "win32"';assert.ok(text.includes(pattern));writeFileSync(file,text.replaceAll(pattern,'false'));}
  const handoff=join(root,'dist/core/deploy/handoff.js');text=readFileSync(handoff,'utf8');const timeout='value, 120_000, input.signal';assert.equal(text.split(timeout).length,2);writeFileSync(handoff,text.replace(timeout,'value, 1_000, input.signal'));
  const result=spawnSync(process.execPath,[join(root,'tests/clerk-prepare.mjs'),'--synthetic-fixture'],{encoding:'utf8',timeout:180000,maxBuffer:1024*1024,env:{...process.env,DO_NOT_TRACK:'1',AGENT_KEY_CASE_E2E:'0',AGENT_KEY_CASE_E2E_STRICT:'0'}});
  assert.equal(result.error,undefined);assert.ok(!`${result.stdout}${result.stderr}`.includes('synthetic-clerk-preparation-secret-ZQ47'));assert.equal(result.status,0,result.stderr||result.stdout);process.stdout.write(result.stdout);
  // Execute the actual CLI renderer against fixed closed results in a disposable
  // compiled engine. The real engine entrypoint is never called in these cases.
  const engine=join(root,'dist/core/deploy/engine.js'),engineSource=readFileSync(engine,'utf8');
  const declaration='export async function runClerkConnectionPrepare(';
  assert.equal(engineSource.split(declaration).length,2,'one fixed test-only result seam');
  const renamed=engineSource.replace(declaration,'async function unusedClerkPreparation(');
  const version='12345678-1234-1234-1234-123456789abc';
  const base={service:'clerk',environment:'development',status:'prepared',placementEffects:'possible',versionId:version,activation:'not-performed-by-this-invocation',historySaved:true,termination:'closed'};
  const cases=[
   {value:base,code:0,has:['Created Worker version: '+version,'separately authorized','did not activate production','Version URLs','authentication has not been verified'],absent:['Do not retry','not saved']},
   {value:{...base,historySaved:false,historyDiagnostic:{phase:'result',issue:'storage-full',recovery:'free-storage-space'}},code:0,has:['Created Worker version: '+version,'not saved to local history','stop dependent work','history --json --offline','Do not retry or activate automatically']},
   {value:{...base,status:'unknown',versionId:null},code:1,has:['unknown','Do not retry','history --json --offline'],absent:['Created Worker version:']},
   {value:{...base,status:'unknown',versionId:null,termination:'unconfirmed'},code:1,has:['termination is unconfirmed','no process cleanup is established','Do not retry']},
   {value:{...base,status:'changed',versionId:null},code:1,has:['changed','Do not retry','preserve the existing evidence']},
   {value:{...base,status:'history-unavailable',versionId:null,placementEffects:'none',historySaved:false,termination:'not-started'},code:1,has:['history --json --offline'],absent:['Created Worker version:','Version URLs']},
   {value:{...base,status:'dry-run',versionId:null,placementEffects:'none',historySaved:false,termination:'not-started'},code:0,has:['Preview only; no Worker version was created'],absent:['Do not retry','not saved','Created Worker version:']},
   {value:{...base,status:'declined',versionId:null,placementEffects:'none',historySaved:false,termination:'not-started'},code:4,has:['declined'],absent:['Do not retry','Created Worker version:']}
  ];
  for(const test of cases){
   writeFileSync(engine,renamed+'\nexport async function runClerkConnectionPrepare(){return '+JSON.stringify(test.value)+';}\n');
   const args=[join(root,'dist/cli/index.js'),'connection','prepare','--service','clerk','--env','development',root];
   const run=extra=>spawnSync(process.execPath,[...args,...extra],{encoding:'utf8',timeout:15000,env:{...process.env,DO_NOT_TRACK:'1'}});
   const human=run([]);assert.equal(human.error,undefined);assert.equal(human.status,test.code);assert.equal(human.stderr,'');
   for(const word of test.has)assert.ok(human.stdout.includes(word),word);
   for(const word of test.absent??[])assert.ok(!human.stdout.includes(word),word);
   const json=run(['--json']);assert.equal(json.status,test.code);assert.deepEqual(JSON.parse(json.stdout),test.value,'existing JSON contract unchanged');
  }
  const canary='synthetic-output-must-not-appear';
  writeFileSync(engine,renamed+'\nexport async function runClerkConnectionPrepare(){return '+JSON.stringify({...base,versionId:canary,rawProviderOutput:canary})+';}\n');
  const closed=spawnSync(process.execPath,[join(root,'dist/cli/index.js'),'connection','prepare','--service','clerk','--env','development',root],{encoding:'utf8',timeout:15000,env:{...process.env,DO_NOT_TRACK:'1'}});
  assert.equal(closed.status,0);assert.ok(!closed.stdout.includes(canary));assert.ok(!closed.stdout.includes('Created Worker version:'));
  console.log('Clerk human CLI output: 8 closed-result cases plus non-return regression passed; JSON/status unchanged.');

 }finally{rmSync(root,{recursive:true,force:true});}
}
