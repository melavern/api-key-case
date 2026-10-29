// Run the built CLI in a disposable package with a synthetic keyring and denied effects.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { credentialRefForService } from '../dist/core/agent/connection-credential.js';
import { toAccount } from '../dist/core/vault/naming.js';

const root=mkdtempSync(join(tmpdir(),'akc-provider-cli-')),checkout=join(root,'cli'),modules=join(checkout,'node_modules'),home=join(root,'home'),project=join(root,'project');
const canary='synthetic-cli-key-Z7uQ',effectsFile=join(root,'effects.json');let checks=0;
try {
  for(const p of [modules,home,project])mkdirSync(p,{recursive:true});
  writeFileSync(join(checkout,'package.json'),'{"type":"module"}');
  cpSync(fileURLToPath(new URL('../dist',import.meta.url)),join(checkout,'dist'),{recursive:true});
  const sourceModules=realpathSync(fileURLToPath(new URL('../node_modules',import.meta.url)));
  for(const name of readdirSync(sourceModules))if(name!=='@napi-rs'&&!name.startsWith('.'))symlinkSync(join(sourceModules,name),join(modules,name),process.platform==='win32'?'junction':'dir');
  const mock=join(modules,'@napi-rs','keyring');mkdirSync(mock,{recursive:true});writeFileSync(join(mock,'package.json'),'{"name":"@napi-rs/keyring","main":"index.cjs"}');
  const store=new ConnectionStateStore(project,home),accounts=[];
  for(const service of ['openai','stripe-test']) {
    const ref=credentialRefForService(project,'preview',service),begun=store.beginCredentialMutation(ref);
    assert.equal(begun.ok,true);assert.equal(store.finishCredentialMutation(ref,begun.value,true),true);accounts.push(toAccount(ref));
  }
  writeFileSync(join(mock,'index.cjs'),`const present=new Set(${JSON.stringify(accounts)});exports.Entry=class{
    constructor(service,account){if(service!=='api-key-case')throw Error('unexpected service');this.account=account;}
    getPassword(){globalThis.effects.reads++;return present.has(this.account)?${JSON.stringify(canary)}:null;}
    setPassword(){globalThis.effects.writes++;throw Error('unexpected store write');}
    deleteCredential(){globalThis.effects.writes++;throw Error('unexpected store deletion');}
  };`);
  const guard=join(root,'guard.cjs');
  writeFileSync(guard,`const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net'),tls=require('node:tls'),http=require('node:http'),https=require('node:https');
    const save=fs.writeFileSync;globalThis.effects={reads:0,writes:0,children:0,network:0};
    const deny=k=>()=>{globalThis.effects[k]++;throw Error(${JSON.stringify(canary)})};
    for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[k]=deny('children');
    for(const k of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync','rmSync','rmdirSync','chmodSync','chownSync'])fs[k]=deny('writes');
    net.Socket.prototype.connect=net.connect=net.createConnection=tls.connect=deny('network');
    http.get=http.request=https.get=https.request=globalThis.fetch=deny('network');require('node:module').syncBuiltinESMExports();
    process.on('exit',()=>save(${JSON.stringify(effectsFile)},JSON.stringify(globalThis.effects)));`);
  const run=(args,exit=0)=>{
    const result=spawnSync(process.execPath,['--require',guard,join(checkout,'dist','cli','index.js'),...args],{
      cwd:project,encoding:'utf8',timeout:15000,maxBuffer:1024*1024,
      env:{HOME:home,USERPROFILE:home,DO_NOT_TRACK:'1',PATH:'',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{})}});
    assert.equal(result.error,undefined);assert.equal(result.status,exit,'unexpected CLI exit');assert.ok(!(result.stdout+result.stderr).includes(canary));
    const effects=JSON.parse(readFileSync(effectsFile));assert.equal(effects.writes,0);assert.equal(effects.children,0);assert.equal(effects.network,0);checks++;return {result,effects};
  };
  for(const service of ['openai','stripe-test']) {
    const args=['connection','credential','guide','--service',service,'--env','preview','--json'];
    const first=JSON.parse(run(args).result.stdout),fresh=JSON.parse(run(args).result.stdout);
    assert.deepEqual(first,fresh);assert.equal(first.stage,'stored');assert.equal(first.operationPlan.consumer,'unsupported');
    assert.equal(first.operationPlan.secretTransfer,'none');assert.equal(first.operationPlan.deployment,false);assert.equal(first.operationPlan.providerCheck,'not-run');
    assert.equal(JSON.parse(run(['connection','credential','check','--service',service,'--env','preview','--json']).result.stdout).status,'registered');
    assert.match(run(['connection','credential','guide','--service',service,'--env','preview']).result.stdout,/再入力せず/);
  }
  const invalid=[['--value',canary],['--command','node'],['--stdin'],['--env','preview'],['--force'],['--json'],[project,project]];
  for(const suffix of invalid)assert.equal(run(['connection','credential','guide','--service','openai','--env','preview','--json',...suffix],1).effects.reads,0);
  assert.equal(run(['connection','credential','guide','--service','stripe-test','--env','production','--json'],1).effects.reads,0);
  for(const service of ['openai','stripe-test'])for(const extra of [[],['--dry-run']]) {
    const blocked=run(['connection','deploy','--service',service,'--env','preview','--json',...extra],6);
    assert.equal(blocked.effects.reads,0);assert.equal(JSON.parse(blocked.result.stdout).status,'pro-required');
  }
  assert.equal(run(['connection','local','run','--service','stripe-test','--env','preview','--json'],1).effects.reads,0);
  const inventory=JSON.parse(run(['connection','inventory','--json']).result.stdout);assert.equal(inventory.slots.length,11);
  for(const service of ['openai','stripe-test'])assert.equal(inventory.slots.find(row=>row.service===service&&row.environment==='preview').nextStep,'review-consumer-contract');
  const resumed=JSON.parse(run(['next','--json','--offline']).result.stdout);assert.equal(resumed.schemaVersion,13);
  for(const service of ['openai','stripe-test'])assert.deepEqual(resumed.nextActions.find(a=>a.kind==='review-provider-credential'&&a.service===service),{actor:'agent',kind:'review-provider-credential',service,environments:['preview']});
  assert.ok(!resumed.nextActions.some(a=>a.kind==='register-secret'||a.kind==='register-connection-credential'));
  console.log(`provider credential CLI: ${checks} cases passed; no writes, children or network; fresh-process reuse preserved`);
}finally{rmSync(root,{recursive:true,force:true})}
