import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildConnectionPlan } from '../dist/core/agent/connection-plan.js';
import { parseNativeConfiguration, inspectProviderNative, renderNativeInspectionResult } from '../dist/core/agent/provider-native-check.js';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';

const canary = 'synthetic-private-value-wxyz';
const record = (extra = {}) => ({key:'RESEND_API_KEY',type:'encrypted',target:['development'],configurationId:'icfg_fixture',updatedAt:42,...extra});
export async function runProviderNativeCheckTests() {
  let checks = 0;
  const parse = envs => parseNativeConfiguration(JSON.stringify({envs}), 'development');
  const assertClosed = value => { assert.ok(!JSON.stringify(value).includes(canary)); checks++; };
  const managed = parse([record({value:canary})]);
  assert.equal(managed.configuration,'integration-managed'); assertClosed(managed);
  assert.deepEqual(managed,parse([record({value:'different value'})]),'value changes cannot enter a metadata fingerprint'); checks++;
  assert.equal(parse([]).configuration,'absent'); checks++;
  assert.equal(parse([record({configurationId:undefined})]).configuration,'present-unmanaged'); checks++;
  for(const item of [record({target:['production']}),record({gitBranch:'feature'}),record({target:'development'}),record({configurationId:canary+'!'}),record({type:'future-type'})]) {
    assert.equal(parse([item]).configuration,'unknown'); checks++;
  }
  for(const field of ['type','visibility'])for(const value of [['encrypted'],['secret'],{},null]){assert.equal(parse([record({[field]:value})]).configuration,'unknown');checks++;}
  assert.equal(parse([record(),record()]).configuration,'unknown'); checks++;
  assert.equal(parse(Array.from({length:1001},()=>({key:'OTHER',target:['development']}))).configuration,'unknown');checks++;
  assert.notEqual(managed.configurationFingerprint,parse([record({updatedAt:43})]).configurationFingerprint);checks++;
  for(const output of ['{}','not-json','{"envs":[],"envs":[]}',JSON.stringify({envs:[],error:{message:canary}}),'x'.repeat(256*1024+1)]) {
    const result=parseNativeConfiguration(output,'development');assert.equal(result.configuration,'unknown');assertClosed(result);
  }
  const root=realpathSync(mkdtempSync(join(tmpdir(),'akc-native-inspect-')));
  const oldHome=process.env.HOME,oldUser=process.env.USERPROFILE;
  try {
    const home=join(root,'home'),project=join(root,'project'),bin=join(root,'bin');
    for(const p of [home,project,bin,join(project,'.vercel')])mkdirSync(p,{mode:0o700});
    process.env.HOME=home;process.env.USERPROFILE=home;
    writeFileSync(join(project,'.vercel','project.json'),JSON.stringify({projectId:'prj_fixture',orgId:'team_fixture'}));
    const store=new ConnectionStateStore(project,home);
    const select=(environment='development',route='provider-native',kind='vercel')=>store.saveIntent({service:'resend',environment,route,destination:{kind},sendingDomain:null});
    const marker=join(root,'calls');
    const fixture=(mode='success',version='59.11.7')=>{
      const source=`const fs=require('node:fs');\n`+
        `if(process.argv.slice(2).join(' ')==='--version'){console.log(${JSON.stringify(version)});process.exit(0)}\n`+
        `fs.appendFileSync(${JSON.stringify(marker)},'call\\n');\n`+
        `const expected=['api','/v10/projects/prj_fixture/env?target=development','--method','GET','--raw','--non-interactive','--api','https://api.vercel.com','--scope','team_fixture'];\n`+
        `if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(expected)||process.env.CI!=='1'||process.env.NODE_OPTIONS||process.env.VERCEL_TOKEN)process.exit(9);\n`+
        `process.stdin.resume();process.stdin.on('end',()=>{\n`+
        (mode==='changed'?`fs.writeFileSync(${JSON.stringify(join(project,'.vercel','project.json'))},JSON.stringify({projectId:'prj_changed',orgId:'team_fixture'}));\n`:'')+
        (mode==='utf8'?`process.stdout.write(Buffer.from([0xff]));\n`:mode==='overflow'?`process.stdout.write('x'.repeat(300000));\n`:`process.stdout.write(${JSON.stringify(JSON.stringify({envs:[record({value:canary})]}))});\n`)+
        `process.stderr.write(${JSON.stringify(canary)});\n`+
        // A Windows .cmd kill may leave its owned fixture Node alive. Retain a
        // hang past the product deadline, but bound the synthetic child lifetime.
        (mode==='hang'?`setTimeout(()=>process.exit(0),2000);setInterval(()=>{},1000);`:mode==='delay'?`setTimeout(()=>process.exit(0),150);`:`process.exit(${mode==='failure'?1:0});`)+`});\n`;
      writeFileSync(join(bin,'fixture.cjs'),source);
      if(process.platform==='win32')writeFileSync(join(bin,'vercel.cmd'),`@"${process.execPath}" "${join(bin,'fixture.cjs')}" %*\r\n`);
      else {writeFileSync(join(bin,'vercel'),`#!${process.execPath}\n${source}`);chmodSync(join(bin,'vercel'),0o700);}
    };
    const inspect=(options={})=>inspectProviderNative(project,'development',{connectionBaseDir:home,pathOverride:bin,...options});
    fixture();
    assert.equal((await inspect()).reason,'intent-mismatch');checks++;
    select('production');assert.equal((await inspect()).reason,'intent-mismatch');checks++;
    select('development','api-key-case-managed');assert.equal((await inspect()).reason,'intent-mismatch');checks++;
    select('development','provider-native','cloudflare');assert.equal((await inspect()).reason,'intent-mismatch');checks++;
    assert.throws(()=>readFileSync(marker));checks++;
    select();const ok=await inspect();assert.equal(ok.configuration,'integration-managed');assert.equal(ok.permission,'none');assert.equal(ok.application,'not-checked');assert.equal(ok.integrationIdentity,'unverified');assertClosed(ok);
    // Human output keeps the selected identity and never turns configuration presence into an app pass.
    for(const service of ['resend','clerk'])for(const environment of ['development','preview','production']) {
      const result={...ok,service,environment,value:canary};const before=JSON.stringify(result);
      const text=renderNativeInspectionResult(result);
      assert.ok(text.includes(`${service==='clerk'?'Clerk':'Resend'} / Vercel / ${environment}`));
      assert.ok(text.includes(ok.destinationSelectionFingerprint));assert.ok(text.includes('アプリ機能は未確認'));
      assert.ok(text.includes('キーの二重登録は不要'));assert.ok(text.includes('別途許可された対象アプリ'));
      assert.ok(text.includes(service==='clerk'?'ログアウト時のアクセス拒否':'宛先での受信'));
      assert.ok(!text.includes(canary));assert.equal(JSON.stringify(result),before);checks++;
    }
    for(const configuration of ['present-unmanaged','absent','partial','unknown']) {
      const text=renderNativeInspectionResult({...ok,configuration,destinationSelectionFingerprint:canary});
      assert.ok(text.includes('アプリ機能は未確認'));assert.ok(text.includes('既存設定を確認'));
      assert.ok(!text.includes('次の確認は、別途許可'));assert.ok(!text.includes('キーの二重登録は不要'));assert.ok(!text.includes(canary));checks++;
    }
    const interrupted=renderNativeInspectionResult({...ok,status:'unknown',reason:'termination-unconfirmed'});
    assert.ok(interrupted.includes('設定の状態は不明'));assert.ok(interrupted.includes('終了を確認してから'));
    assert.ok(!interrupted.includes('次の確認は、別途許可'));checks++;
    for(const mode of ['failure','overflow','utf8','changed','hang']) {
      fixture(mode);const result=await inspect({timeoutMs:mode==='hang'?200:15000});assert.equal(result.status,'unknown');assertClosed(result);
      writeFileSync(join(project,'.vercel','project.json'),JSON.stringify({projectId:'prj_fixture',orgId:'team_fixture'}));
    }
    for(const version of ['58.0.0','59.11.8',canary]) {
      fixture('success',version);const before=readFileSync(marker,'utf8');const unsupported=await inspect();assert.equal(unsupported.reason,'unsupported-cli-version');assert.equal(readFileSync(marker,'utf8'),before);assertClosed(unsupported);
    }
    fixture('delay');const changedIntent=setTimeout(()=>select('production'),120);const changed=await inspect();clearTimeout(changedIntent);assert.equal(changed.reason,'basis-changed');checks++;select();
    fixture('hang');const during=new AbortController(),cancel=setTimeout(()=>during.abort(),80);const cancelled=await inspect({signal:during.signal});clearTimeout(cancel);assert.equal(cancelled.reason,'aborted');checks++;
    // The ordinary generic plan still performs no provider or vault operation for native intent.
    const countBefore=readFileSync(marker,'utf8');let forbidden=0;
    const planned=await buildConnectionPlan(project,'development',{connectionBaseDir:home,vault:new Proxy({},{get(){forbidden++;throw new Error(canary);}})});
    assert.equal(planned.status,'unknown');assert.equal(forbidden,0);assert.equal(readFileSync(marker,'utf8'),countBefore);checks++;
    // Actual public CLI rejects an unselected environment and arbitrary options before provider resolution.
    const cli=fileURLToPath(new URL('../dist/cli/index.js',import.meta.url));
    for(const extra of [[],['--raw']]) {
      const actual=spawnSync(process.execPath,[cli,'connection','native','inspect','--service','resend','--env','production','--json',project,...extra],{encoding:'utf8',timeout:10000,env:{...process.env,DO_NOT_TRACK:'1'}});
      assert.equal(actual.status,1);assert.ok(!actual.stdout.includes(canary));assert.ok(!actual.stderr.includes(canary));
      if(!extra.length)assert.equal(JSON.parse(actual.stdout).reason,'intent-mismatch');checks++;
    }
    const plain=spawnSync(process.execPath,[cli,'connection','native','inspect','--service','resend','--env','production',project],{encoding:'utf8',timeout:10000,env:{...process.env,DO_NOT_TRACK:'1'}});
    assert.equal(plain.status,1);assert.ok(plain.stdout.includes('Resend / Vercel / production'));
    assert.ok(plain.stdout.includes('アプリ機能は未確認'));assert.ok(plain.stdout.includes('一致しません'));
    assert.equal(readFileSync(marker,'utf8'),countBefore);assert.ok(!plain.stdout.includes(canary));checks++;
    // Human output cannot enable trusted execution through caller PATH on an unsupported host.
    const intentBefore=JSON.stringify(store.readIntent());const observationsBefore=JSON.stringify(store.readObservations());
    if(process.platform==='linux') {
      fixture();
      const shown=spawnSync(process.execPath,[cli,'connection','native','inspect','--service','resend','--env','development',project],{encoding:'utf8',timeout:10000,env:{...process.env,PATH:bin,DO_NOT_TRACK:'1'}});
      assert.equal(shown.status,1);assert.ok(shown.stdout.includes('設定の状態は不明'));
      assert.ok(shown.stdout.includes('アプリ機能は未確認'));assert.ok(!shown.stdout.includes('キーの二重登録は不要'));
      assert.ok(!shown.stdout.includes(canary));assert.ok(!shown.stderr.includes(canary));
      assert.equal(readFileSync(marker,'utf8'),countBefore);
      assert.equal(JSON.stringify(store.readIntent()),intentBefore);assert.equal(JSON.stringify(store.readObservations()),observationsBefore);checks++;
    }
    // Read-side stream errors must be handled internally without leaking an Error message.
    fixture();const originalSpawn=childProcess.spawn;
    for(const stream of ['stdout','stderr','cancel-after-version','cancel-after-get']) {
      const late=new AbortController();
      try {
        childProcess.spawn=(_file,args)=>{
          const child=new EventEmitter();child.pid=1234567;
          child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
          child.kill=()=>{queueMicrotask(()=>child.emit('close',null));return true;};child.unref=()=>{};
          queueMicrotask(()=>{if(args.includes('--version')){child.stdout.write('59.11.7\n');child.emit('close',0);if(stream==='cancel-after-version')late.abort();}else if(stream==='cancel-after-get'){child.stdout.write(JSON.stringify({envs:[record()]}));child.emit('close',0);late.abort();}else child[stream].emit('error',new Error(canary));});
          return child;
        };syncBuiltinESMExports();
        const failure=await inspect({signal:late.signal});assert.equal(failure.reason,stream.startsWith('cancel-')?'aborted':'command-failed');assertClosed(failure);
      } finally {childProcess.spawn=originalSpawn;syncBuiltinESMExports();}
    }
    fixture();const controller=new AbortController();controller.abort();const before=readFileSync(marker,'utf8');assert.equal((await inspect({signal:controller.signal})).reason,'aborted');assert.equal(readFileSync(marker,'utf8'),before);checks++;
    console.log(`Provider-native inspection: ${checks} checks passed; synthetic CLI only`);
  } finally {
    if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;
    if(oldUser===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=oldUser;
    rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
}
if(process.argv[1]?.endsWith('provider-native-check.mjs'))await runProviderNativeCheckTests();
