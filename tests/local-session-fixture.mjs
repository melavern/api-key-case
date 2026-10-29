// Test-only disposable compiled copy. No execution injection, gate override, or
// secret getter is shipped in dist. Every native-store read here is a fake Entry.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function runDisposableLocalSessionTests({ featureOnly = false, observationsOnly = false, completionOnly = false } = {}) {
  const repo=fileURLToPath(new URL('..',import.meta.url)), root=mkdtempSync(join(tmpdir(),'akc-local-compiled-test-'));
  try {
    cpSync(join(repo,'dist'),join(root,'dist'),{recursive:true});
    // The disposable owner never executes its interpreter. Avoid repeatedly hashing
    // the host's full Node binary in synthetic sessions; explicit snapshot tests
    // below still exercise their supplied runtime files.
    const snapshotPath=join(root,'dist','core','local','snapshot.js'),snapshotSource=readFileSync(snapshotPath,'utf8');
    const runtimeSource='this.interpreterPath = realpathSync(interpreterPath);';
    const runtimeTest='this.interpreterPath = realpathSync(interpreterPath === process.execPath && globalThis.__akcLocalSyntheticFixture?.useSyntheticRuntime ? globalThis.__akcLocalSyntheticFixture.runtimePath : interpreterPath);';
    assert.equal(snapshotSource.split(runtimeSource).length,2,'Synthetic build runtime transform requires exactly one fixed match');
    writeFileSync(snapshotPath,snapshotSource.replace(runtimeSource,runtimeTest));
    mkdirSync(join(root,'tests'));mkdirSync(join(root,'node_modules'));
    writeFileSync(join(root,'package.json'),JSON.stringify({type:'module',private:true}));
    cpSync(join(repo,'tests','local-application-session.mjs'),join(root,'tests','local-application-session.mjs'));
    cpSync(join(repo,'tests','local-application-feature.mjs'),join(root,'tests','local-application-feature.mjs'));
    cpSync(join(repo,'tests','local-observations.mjs'),join(root,'tests','local-observations.mjs'));
    cpSync(join(repo,'tests','local-session-completion.mjs'),join(root,'tests','local-session-completion.mjs'));
    mkdirSync(join(root,'tools'));
    cpSync(join(repo,'tools','build-local-node.mjs'),join(root,'tools','build-local-node.mjs'));
    cpSync(fileURLToPath(import.meta.url),join(root,'tests','local-session-fixture.mjs'));
    for(const name of readdirSync(join(repo,'node_modules'))){
      if(name==='@napi-rs')continue;
      const source=join(repo,'node_modules',name),destination=join(root,'node_modules',name);
      if(statSync(source).isDirectory())symlinkSync(source,destination,process.platform==='win32'?'junction':undefined);
      else cpSync(source,destination);
    }
    const mock=join(root,'node_modules','@napi-rs','keyring');mkdirSync(mock,{recursive:true});
    writeFileSync(join(mock,'package.json'),JSON.stringify({name:'@napi-rs/keyring',version:'0.0.0-synthetic',type:'module',exports:'./index.js'}));
    writeFileSync(join(mock,'index.js'),`export class Entry { constructor(...args) { this.fixtureArgs=args; } getPassword() { throw new Error('Synthetic keyring was not configured'); } setPassword() { throw new Error('No OS writes in synthetic fixture'); } deletePassword() { throw new Error('No OS deletion in synthetic fixture'); } }`);
    const handoff=join(root,'dist','core','deploy','handoff.js');let source=readFileSync(handoff,'utf8');
    for (const platform of ['linux', 'darwin']) {
      const guarded = source.replace('deps = { vault: createVault(), humanPlane: createHumanPlane(), signal };', 'deps = globalThis.__akcLocalSyntheticFixture.deps;')
        .replaceAll('process.platform', JSON.stringify(platform));
      writeFileSync(join(root,'dist','core','deploy',`handoff-${platform}.js`),guarded);
    }
    const replacements=[
      ['deps = { vault: createVault(), humanPlane: createHumanPlane(), signal };','deps = globalThis.__akcLocalSyntheticFixture.deps;'],
      ['!LOCAL_NATIVE_LAUNCH_ACCEPTED || process.platform !== "win32"','!LOCAL_NATIVE_LAUNCH_ACCEPTED']
    ];
    for(const [from,to] of replacements){assert.equal(source.split(from).length,2,`Synthetic build transform requires exactly one fixed match: ${from}`);source=source.replace(from,to);}
    writeFileSync(handoff,source);
    writeFileSync(join(root,'dist','core','local','windows-owner.js'),`export function spawnWindowsLocalOwner(config) { return globalThis.__akcLocalSyntheticFixture.owner(config); }`);
    const result=spawnSync(process.execPath,[join(root,'tests',observationsOnly?'local-observations.mjs':'local-application-session.mjs'),'--synthetic-fixture',...(featureOnly?['--feature-only']:[]),...(completionOnly?['--completion-only']:[])],{encoding:'utf8',timeout:180000,maxBuffer:1024*1024,env:{...process.env,DO_NOT_TRACK:'1'}});
    for(const forbidden of ['synthetic-local-app-key-7S61','synthetic-app-output-93NJ','synthetic-inherited-credential','synthetic-completion-private-no-output']) {
      assert.ok(!`${result.stdout}${result.stderr}`.includes(forbidden),'synthetic app/provider bytes must not reach ordinary test output');
    }
    assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr||result.stdout);
    process.stdout.write(result.stdout);
  } finally { rmSync(root,{recursive:true,force:true}); }
}
