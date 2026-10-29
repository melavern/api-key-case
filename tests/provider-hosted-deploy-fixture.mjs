// Disposable test build only. No host override or keyring injection is shipped.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export function runDisposableProviderHostedDeployTests(testFile = 'provider-hosted-deploy.mjs') {
  assert.ok(['provider-hosted-deploy.mjs', 'cloudflare-target-deploy.mjs'].includes(testFile));
  const repo=fileURLToPath(new URL('..',import.meta.url)), root=mkdtempSync(join(tmpdir(),'akc-hosted-platform-test-'));
  try {
    cpSync(join(repo,'dist'),join(root,'dist'),{recursive:true});
    mkdirSync(join(root,'tests'));mkdirSync(join(root,'node_modules'));
    writeFileSync(join(root,'package.json'),JSON.stringify({type:'module',private:true}));
    for(const name of ['provider-hosted-deploy.mjs','provider-hosted-deploy-fixture.mjs','cloudflare-target-deploy.mjs'])cpSync(join(repo,'tests',name),join(root,'tests',name));
    for(const name of readdirSync(join(repo,'node_modules'))) {
      if(name==='@napi-rs')continue;
      const from=join(repo,'node_modules',name),to=join(root,'node_modules',name);
      if(statSync(from).isDirectory())symlinkSync(from,to,process.platform==='win32'?'junction':undefined);else cpSync(from,to);
    }
    const mock=join(root,'node_modules','@napi-rs','keyring');mkdirSync(mock,{recursive:true});
    writeFileSync(join(mock,'package.json'),JSON.stringify({name:'@napi-rs/keyring',version:'0.0.0-synthetic',type:'module',exports:'./index.js'}));
    writeFileSync(join(mock,'index.js'),`export class Entry { constructor(service,account){this.account=account;} getPassword(){throw new Error('Unexpected synthetic keyring read');} setPassword(){throw new Error('No store write');} deletePassword(){throw new Error('No store delete');} }`);
    for(const [name,guard] of [['engine','!request.dryRun && process.platform !== "win32"'],['handoff','if (process.platform !== "win32")']]) {
      const file=join(root,'dist','core','deploy',name+'.js'),source=readFileSync(file,'utf8');
      writeFileSync(join(root,'dist','core','deploy',name+'-reviewed.js'),source.replace('./provider-hosted.js','./provider-hosted-reviewed.js').replace('./handoff.js','./handoff-reviewed.js'));
      writeFileSync(join(root,'dist','core','deploy',name+'-host-guard.js'),source.replace('./provider-hosted.js','./provider-hosted-native-guard.js'));
      assert.equal(source.split(guard).length,2,'exact isolated host guard transform');
      writeFileSync(file,source.replace(guard,guard.replace('process.platform','"win32"')));
    }
    const gateFile=join(root,'dist','core','deploy','provider-hosted.js'),gate=readFileSync(gateFile,'utf8');
    writeFileSync(join(root,'dist','core','deploy','provider-hosted-reviewed.js'),gate);
    const guard='PROVIDER_HOSTED_NATIVE_ACCEPTED = false';
    assert.equal(gate.split(guard).length,2,'exact isolated acceptance gate transform');
    const targetGuards = gate.match(/CLOUDFLARE_TARGET_NATIVE_ACCEPTED = (?:true|false)/g) ?? [];
    assert.equal(targetGuards.length,1,'exact closed narrow acceptance gate');
    const targetGuard = targetGuards[0];
    writeFileSync(join(root,'dist','core','deploy','provider-hosted-native-guard.js'),gate.replace(targetGuard,'CLOUDFLARE_TARGET_NATIVE_ACCEPTED = false'));
    writeFileSync(gateFile,gate.replace(guard,'PROVIDER_HOSTED_NATIVE_ACCEPTED = true').replace(targetGuard, 'CLOUDFLARE_TARGET_NATIVE_ACCEPTED = true'));
    const result=spawnSync(process.execPath,[join(root,'tests',testFile),'--synthetic-fixture'],{encoding:'utf8',timeout:180000,maxBuffer:1024*1024,env:{...process.env,DO_NOT_TRACK:'1'}});
    assert.equal(result.error,undefined);
    for(const forbidden of ['sk_test_synthetic-hosted-stdin-only-canary-XZ61','synthetic-provider-output-partial-ZQ47'])assert.ok(!`${result.stdout}${result.stderr}`.includes(forbidden));
    assert.equal(result.status,0,result.stderr||result.stdout);process.stdout.write(result.stdout);
  } finally { rmSync(root,{recursive:true,force:true}); }
}
