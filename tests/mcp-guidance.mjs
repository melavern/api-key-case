import assert from 'node:assert/strict';import test from 'node:test';
import {mkdtempSync,writeFileSync,readdirSync,rmSync,mkdirSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawn} from 'node:child_process';
import {buildGuidanceHandler,registerGuidanceTools} from '../dist/mcp/guidance.js';
const root=mkdtempSync(join(tmpdir(),'keycase-guidance-'));test.after(()=>rmSync(root,{recursive:true,force:true}));
const fixture=()=>({requiredSecrets:['OPENAI_API_KEY','RESEND_API_KEY','SYNTHETIC_PRIVATE_NAME'],secretFindings:[{preview:'SYNTHETIC_PRIVATE_VALUE',file:'private-path',line:1}],targetDir:'private-path',warnings:['SYNTHETIC_PRIVATE_VALUE']});
test('projection omits names, paths, values and preserves uninspected credentials',async()=>{
 let options;const handler=buildGuidanceHandler({projectDir:root,scan:o=>{options=o;return fixture();}});const r=await handler({}),s=r.structuredContent;
 assert.deepEqual(options,{targetDir:root,skipGitInspection:true});assert.equal(s.credentialStatus,'not-inspected');assert.equal(s.secretStoreAccessPerformed,false);
 assert.deepEqual(s.requirements,{status:'detected',count:3,knownServices:['openai','resend'],otherNameCount:1});assert.equal(s.nextStep,'human-review-possible-exposure');assert.doesNotMatch(JSON.stringify(r),/SYNTHETIC_PRIVATE|private-path|OPENAI_API_KEY|RESEND_API_KEY/);
});
test('arguments are rejected and raw errors are redacted',async()=>{
 let calls=0;const handler=buildGuidanceHandler({projectDir:root,scan:()=>{calls++;throw Error('SYNTHETIC_PRIVATE_VALUE');}});
 for(const args of [{path:'/other'},{value:'SYNTHETIC_PRIVATE_VALUE'},null,[],{approval:true}])assert.equal((await handler(args)).isError,true);
 assert.equal(calls,0);const result=await handler({});assert.equal(result.isError,true);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE/);
});
test('empty detection does not imply missing credentials or re-registration',async()=>{
 const h=buildGuidanceHandler({projectDir:root,scan:()=>({...fixture(),requiredSecrets:[],secretFindings:[]})});const r=await h({});assert.equal(r.structuredContent.requirements.status,'none-detected');assert.equal(r.structuredContent.credentialStatus,'not-inspected');assert.equal(r.structuredContent.nextStep,'review-existing-local-setup');assert.match(r.content[0].text,/do not ask for re-registration/);
});
test('one read-only argument-free tool',()=>{
 const registered=[];registerGuidanceTools({registerTool:(...args)=>registered.push(args)},root);assert.equal(registered.length,1);assert.equal(registered[0][0],'inspect_setup_requirements');assert.deepEqual(registered[0][1].inputSchema,{});assert.equal(registered[0][1].annotations.readOnlyHint,true);
});
test('fixed project alias replacement is rejected',async()=>{
 const a=join(root,'one'),b=join(root,'two'),link=join(root,'bound');mkdirSync(a);mkdirSync(b);const type=process.platform==='win32'?'junction':'dir';symlinkSync(a,link,type);let scanned=0;const h=buildGuidanceHandler({projectDir:link,scan:()=>{scanned++;return fixture();}});unlinkSync(link);symlinkSync(b,link,type);assert.equal((await h({})).isError,true);assert.equal(scanned,0);
});
function client(dir,guidance){
 const child=spawn(process.execPath,[resolve('dist/cli/index.js'),'mcp',dir,...(guidance?['--guidance-only']:[])],{stdio:['pipe','pipe','pipe']});let buffer='',raw='',err='',id=0;const pending=new Map();
 child.stdout.on('data',chunk=>{buffer+=chunk;raw+=chunk;let cut;while((cut=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,cut);buffer=buffer.slice(cut+1);try{const m=JSON.parse(line);pending.get(m.id)?.(m);pending.delete(m.id);}catch{}}});child.stderr.on('data',x=>err+=x);
 const send=(method,params)=>new Promise((resolve,reject)=>{const requestId=++id;const timeout=setTimeout(()=>reject(Error('MCP test timeout')),15000);pending.set(requestId,m=>{clearTimeout(timeout);resolve(m);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n');});
 return {send,raw:()=>raw+err,close:()=>{child.stdin.end();child.kill();}};
}
test('real stdio preserves legacy seven tools and scans only fixed synthetic source without writes',async()=>{
 const p=join(root,'protocol');mkdirSync(p);writeFileSync(join(p,'app.ts'),'const a = process.env.OPENAI_API_KEY;');const before=readdirSync(p);
 for(const guidance of [false,true]){const c=client(p,guidance);try{
 const init=await c.send('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic-guidance-test',version:'1'}});assert.equal(init.error,undefined);const list=await c.send('tools/list',{}),names=list.result.tools.map(x=>x.name);
 if(guidance){assert.deepEqual(names,['inspect_setup_requirements']);const r=await c.send('tools/call',{name:names[0],arguments:{}});assert.equal(r.result.isError,undefined);assert.equal(r.result.structuredContent.credentialStatus,'not-inspected');assert.equal(r.result.structuredContent.requirements.count,1);assert.equal(r.result.structuredContent.secretStoreAccessPerformed,false);}
 else assert.equal(names.length,7);assert.doesNotMatch(c.raw(),/SYNTHETIC_PRIVATE_VALUE/);
 }finally{c.close();}}
 assert.deepEqual(readdirSync(p),before);
});
