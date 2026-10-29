// Disposable test build only. No host override or keyring injection is shipped.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export function runDisposableConnectionDeployTests() {
  const repo=fileURLToPath(new URL('..',import.meta.url)), root=mkdtempSync(join(tmpdir(),'akc-hosted-platform-test-'));
  try {
    cpSync(join(repo,'dist'),join(root,'dist'),{recursive:true});
    mkdirSync(join(root,'tests'));mkdirSync(join(root,'node_modules'));
    writeFileSync(join(root,'package.json'),JSON.stringify({type:'module',private:true}));
    for(const name of ['connection-deploy.mjs','connection-deploy-fixture.mjs'])cpSync(join(repo,'tests',name),join(root,'tests',name));
    for(const name of readdirSync(join(repo,'node_modules'))) {
      if(name==='@napi-rs')continue;
      const from=join(repo,'node_modules',name),to=join(root,'node_modules',name);
      if(statSync(from).isDirectory())symlinkSync(from,to,process.platform==='win32'?'junction':undefined);else cpSync(from,to);
    }
    const mock=join(root,'node_modules','@napi-rs','keyring');mkdirSync(mock,{recursive:true});
    writeFileSync(join(mock,'package.json'),JSON.stringify({name:'@napi-rs/keyring',version:'0.0.0-synthetic',type:'module',exports:'./index.js'}));
    writeFileSync(join(mock,'index.js'),`export class Entry { getPassword(){throw new Error('Unexpected synthetic keyring read');} setPassword(){throw new Error('No store write');} deletePassword(){throw new Error('No store delete');} }`);
    for(const [name,guard] of [['engine','!request.dryRun && process.platform !== "win32"'],['handoff','if (process.platform !== "win32")']]) {
      const file=join(root,'dist','core','deploy',name+'.js'),source=readFileSync(file,'utf8');
      writeFileSync(join(root,'dist','core','deploy',name+'-host-guard.js'),source);
      assert.equal(source.split(guard).length,2,'exact isolated host guard transform');
      writeFileSync(file,source.replace(guard,guard.replace('process.platform','"win32"')));
    }
    // Windows process startup and isolated build I/O need a larger fixture budget.
    // This bounds the developer test only; production approval deadlines stay unchanged.
    const fixtureTimeout = process.platform === 'win32' ? 360000 : 180000;
    const result=spawnSync(process.execPath,[join(root,'tests','connection-deploy.mjs'),'--synthetic-fixture'],{encoding:'utf8',timeout:fixtureTimeout,maxBuffer:1024*1024,env:{...process.env,DO_NOT_TRACK:'1'}});
    assert.equal(result.error,undefined);
    for(const forbidden of ['synthetic-v2-stdin-only-canary-ZQ47','synthetic-provider-output-partial-ZQ47'])assert.ok(!`${result.stdout}${result.stderr}`.includes(forbidden));
    assert.equal(result.status,0,result.stderr||result.stdout);process.stdout.write(result.stdout);
  } finally { rmSync(root,{recursive:true,force:true}); }
}
