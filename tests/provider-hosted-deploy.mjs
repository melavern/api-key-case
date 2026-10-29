import assert from 'node:assert/strict';
import { runDisposableProviderHostedDeployTests } from './provider-hosted-deploy-fixture.mjs';
import { Entry } from '@napi-rs/keyring';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runConnectionDeploy } from '../dist/core/deploy/engine.js';
import { runWithSecret, SecretNotRegisteredError, runConnectionDeployment } from '../dist/core/deploy/handoff.js';
import { DeploymentHistory, buildHistoryReport } from '../dist/core/deploy/history.js';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { credentialRefForService } from '../dist/core/agent/connection-credential.js';
import { canonicalProjectRealpath, toAccount } from '../dist/core/vault/naming.js';
import { MemoryVault } from '../dist/core/vault/memory.js';
import { VercelAdapter } from '../dist/adapters/vercel.js';
import { GitHubEnvironmentAdapter } from '../dist/adapters/github-environment.js';
import { CloudflareAdapter } from '../dist/adapters/cloudflare.js';
import { saveLicenseKey } from '../dist/core/license.js';

const synthetic = 'sk_test_synthetic-hosted-stdin-only-canary-XZ61';
const canary = 'synthetic-provider-output-partial-ZQ47';
const keys = generateKeyPairSync('ed25519');
const payload = Buffer.from(JSON.stringify({v:1,plan:'pro',id:'synthetic-connection-deploy',issuedAt:'2026-10-02'})).toString('base64url');
const signed = `AKC1.${payload}`;
const license = `${signed}.${sign(null,Buffer.from(signed),keys.privateKey).toString('base64url')}`;
const names = ['VERCEL_TOKEN','VERCEL_ORG_ID','VERCEL_PROJECT_ID','CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL','CLOUDFLARE_ACCOUNT_ID','NODE_OPTIONS','NODE_PATH','INJECTED'];

export async function runProviderHostedDeployTests() {
  if (!process.argv.includes('--synthetic-fixture')) return runDisposableProviderHostedDeployTests();
  const root = realpathSync(mkdtempSync(join(tmpdir(),'akc-connection-deploy-')));
  const originalRead = Entry.prototype.getPassword;
  const savedEnv = Object.fromEntries(names.map(name=>[name,process.env[name]]));
  names.forEach(name=>delete process.env[name]);
  let count = 0, active;
  Entry.prototype.getPassword = function() {
    active.reads++;
    assert.equal(this.account, toAccount(active.ref));
    const pending = active.history.read();
    assert.equal(pending.status,'available');
    assert.equal(pending.entries.at(-1).outcome,'unknown','durable unknown precedes every value read');
    assert.equal(pending.entries.at(-1).finishedAt,null);
    assert.equal(pending.entries.at(-1).connection.environment,active.request.environment);
    active.onRead?.();
    if (active.readError) throw new Error(synthetic + canary);
    return Object.hasOwn(active, "value") ? active.value : synthetic;
  };
  const fixture = async (service='openai',environment='preview',target='vercel') => {
    const dir=join(root,`case-${++count}`),project=join(dir,'project'),home=join(dir,'home'),bin=join(dir,'bin');
    for(const path of [dir,project,home,bin])mkdirSync(path,{mode:0o700});
    let config=join(project,'.vercel','project.json');mkdirSync(join(project,'.vercel'));
    writeFileSync(config,JSON.stringify({orgId:'team_synthetic',projectId:'prj_synthetic'}));
    writeFileSync(join(project,'wrangler.toml'),'name = "synthetic"\naccount_id = "0123456789abcdef0123456789abcdef"\n[env.preview]\nname = "synthetic-preview"\naccount_id = "0123456789abcdef0123456789abcdef"\n[env.development]\nname = "synthetic-development"\naccount_id = "0123456789abcdef0123456789abcdef"\n');
    if(target==='github'){mkdirSync(join(project,'.git'));config=join(project,'.git','config');writeFileSync(config,'[remote "origin"]\nurl = https://github.com/owner/repository.git\n');}
    const remote=join(dir,'remote.json');writeFileSync(remote,JSON.stringify({user:[1,'synthetic'],repository:[2,'owner/repository'],environment:[3,environment]}));
    const official=()=>target==='github'?new GitHubEnvironmentAdapter('owner/repository',environment):target==='vercel'?new VercelAdapter():new CloudflareAdapter();
    saveLicenseKey(license,home);
    const store=new ConnectionStateStore(project,home),vault=new MemoryVault(),ref=credentialRefForService(project,environment,service);
    const select=(overrides={})=>{const saved=store.setProviderHostedIntent({service,environment,route:'api-key-case-managed',destination:{kind:target},sendingDomain:null,...overrides});assert.equal(saved.ok,true);};
    select();await vault.setSecret(ref,synthetic);
    const begun=store.beginCredentialMutation(ref);assert.equal(begun.ok,true);assert.equal(store.finishCredentialMutation(ref,begun.value,true),true);
    const metadataDir=join(home,'.api-key-case','connections',createHash('sha256').update(canonicalProjectRealpath(project)).digest('hex'));
    const revisionFile=join(metadataDir,`credential-${service}-${environment}.json`);
    const history=new DeploymentHistory(project,home);
    const historyDir=join(home,'.api-key-case','deployment-history',createHash('sha256').update(realpathSync.native(project)).digest('hex'));
    const marker=join(dir,'events.json');
    const f={dir,project,home,bin,config,remote,store,vault,ref,select,metadataDir,revisionFile,history,historyDir,marker,
      reads:0,probes:0,approvals:0,presence:0,decision:'approved',capability:'os-dialog',onProbe:null,onPresence:null,onRead:null,onApprove:null,
      request:{service,environment,projectDir:project,dryRun:false,force:false},
      events:()=>existsSync(marker)?JSON.parse(readFileSync(marker,'utf8')):[],
      changeRevision:()=>{const data=JSON.parse(readFileSync(revisionFile,'utf8'));data.credential.updatedAt='2099-01-01T00:00:00.000Z';writeFileSync(revisionFile,JSON.stringify(data));},
      writeCli:(afterAdd='',afterRemove='')=>{
        const body=`const fs=require('fs');const args=process.argv.slice(2);const p=${JSON.stringify(marker)};\n`+
          (target==='github'?`const state=JSON.parse(fs.readFileSync(${JSON.stringify(remote)},'utf8'));if(args[0]==='--version'){console.log('gh version 2.80.0');process.exit(0);}if(args[0]==='auth'){if(JSON.stringify(args)!==JSON.stringify(['auth','status','--hostname','github.com']))process.exit(41);process.exit(state.authFailure?1:0);}if(args[0]==='api'){if(JSON.stringify(args.slice(0,5))!==JSON.stringify(['api','--hostname','github.com','--method','GET']))process.exit(42);const endpoint=args[5];const key=endpoint==='user'?'user':endpoint==='repos/owner/repository'?'repository':endpoint==='repos/owner/repository/environments/${environment}'?'environment':null;const projection=key==='user'?'[.id,.login]':key==='repository'?'[.id,.full_name]':'[.id,.name]';if(!key||args[6]!=='--jq'||args[7]!==projection||args.length!==8||!state[key])process.exit(43);console.log(JSON.stringify(state[key]));process.exit(0);}`:'')+
          `const rm=args[1]==='rm';const expected=rm?${JSON.stringify(['env','rm',ref.name,environment,'--yes'])}:${JSON.stringify(official().planDeploy(ref.name,environment,{force:false}).argv.slice(1))};if(JSON.stringify(args)!==JSON.stringify(expected))process.exit(21);\n`+
          `if(process.env.NODE_OPTIONS||process.env.NODE_PATH||process.env.VERCEL_TOKEN||process.env.INJECTED)process.exit(22);\n`+
          `const journal=JSON.parse(fs.readFileSync(${JSON.stringify(join(historyDir,'history.json'))},'utf8'));if(journal.entries.at(-1).outcome!=='unknown'||journal.entries.at(-1).finishedAt!==null)process.exit(23);\n`+
          `let v='';process.stdin.on('data',c=>v+=c);process.stdin.on('end',()=>{if(v!==(rm?'':${JSON.stringify(synthetic)}))process.exit(24);const events=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):[];events.push(rm?'remove':'add');fs.writeFileSync(p,JSON.stringify(events));console.log(v+' '+${JSON.stringify(canary)});console.error(${JSON.stringify(canary)});if(rm){${afterRemove}}else{${afterAdd}};process.exit(0)});`;
        const script=join(bin,'provider.cjs');writeFileSync(script,body);
        const name=target==='github'?'gh':target==='vercel'?'vercel':'wrangler';
        const executable=join(bin,name+(process.platform==='win32'?'.cmd':''));
        writeFileSync(executable,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${script}" %*\r\n`:`#!${process.execPath}\n${body}`);
        chmodSync(executable,0o700);f.executable=executable;
      }
    };
    f.writeCli();
    const adapter=official();const realCheck=adapter.checkCli.bind(adapter);
    adapter.detect=async()=>{throw new Error('new flow must not call detect');};
    adapter.checkCli=async(options)=>{f.probes++;await f.onProbe?.(f.probes);return target==='github'?realCheck(options):{installed:true,loggedIn:true,identity:f.identity??(target==='cloudflare'?'accounts:0123456789abcdef0123456789abcdef':'user:synthetic')};};
    const has=vault.hasSecret.bind(vault);
    vault.hasSecret=async ref=>{f.presence++;const present=await has(ref);await f.onPresence?.(f.presence);return present;};
    f.deps={vault,adapter,pathOverride:bin,historyBaseDir:home,connectionBaseDir:home,licenseOptions:{baseDir:home,publicKey:keys.publicKey},humanPlane:{
      capability:()=>f.capability,askApproval:async plan=>{f.approvals++;f.approval=plan;await f.onApprove?.();return f.decision;}
    }};
    f.run=async()=>{active=f;const result=await runConnectionDeploy(f.deps,f.request);assert.ok(!JSON.stringify(result).includes(synthetic));assert.ok(!JSON.stringify(result).includes(canary));return result;};
    return f;
  };
  try {
    const guardedEngine = await import('../dist/core/deploy/engine-host-guard.js');
    const guardedHandoff = await import('../dist/core/deploy/handoff-host-guard.js');
    for (const service of ['openai','stripe-test']) {
      // The unchanged shipped host AND source gates precede all store/provider effects.
      const descriptor = Object.getOwnPropertyDescriptor(process,'platform');
      for (const platform of ['linux','darwin','win32']) {
        const f=await fixture(service); active=f;
        try {
          Object.defineProperty(process,'platform',{...descriptor,value:platform});
          f.vault.hasSecret=f.vault.isAvailable=async()=>assert.fail('source gate must precede vault');
          const result=await guardedEngine.runConnectionDeploy(f.deps,f.request);
          assert.equal(result.status,'unavailable'); assert.equal(result.placementEffects,'none');
          assert.equal(f.presence+f.probes+f.approvals+f.reads,0);
          assert.equal(await guardedHandoff.runConnectionDeployment({ref:f.ref,target:'vercel',force:false}),'changed');
        } finally {Object.defineProperty(process,'platform',descriptor);}
      }
      for(const environment of service==='openai'?['development','preview','production']:['development','preview']) {
        for(const target of ['vercel','cloudflare']) {
          const f=await fixture(service,environment,target);
          f.request.dryRun=true;
          const dry=await f.run();assert.equal(dry.status,'dry-run');
          assert.equal(dry.preview.name,f.ref.name);assert.equal(dry.preview.sourceEnvironment,environment);
          assert.equal(dry.preview.placementEffect,target==='cloudflare'?'cloudflare-version-and-immediate-deployment':'vercel-environment-update');
          assert.equal(dry.preview.nativeExecution,'pending-acceptance');assert.equal(dry.preview.providerMode,service==='stripe-test'?'test':'not-applicable');
          assert.equal(dry.preview.permission,'none');assert.equal(dry.preview.providerProbes,'not-run');
          assert.equal(f.probes+f.approvals+f.reads,0);assert.equal(f.history.read().status,'missing');
          f.request.dryRun=false;
          process.env.INJECTED=synthetic;
          const result=await f.run();delete process.env.INJECTED;assert.equal(result.status,'completed',`${service}/${environment}/${target}`);
          assert.equal(result.historySaved,true);assert.equal(f.reads,1);assert.deepEqual(f.events(),['add']);
          assert.equal(f.approval.connectionSource.service,service);assert.equal(f.approval.connectionSource.environment,environment);
          assert.equal(f.history.read().entries[0].connection.service,service);
          for(const dir of [f.metadataDir,f.historyDir])for(const file of readdirSync(dir)){
            if(!file.endsWith('.json'))continue;const output=readFileSync(join(dir,file),'utf8');
            assert.equal(output.includes(synthetic),false);assert.equal(output.includes(canary),false);
          }
          assert.equal(f.store.readObservations().status,'missing','placement creates no provider/app observation');
          assert.equal((await f.run()).status,'completed');
          assert.equal(f.approvals,target==='vercel'&&environment==='preview'?1:2,'only exact Vercel preview may reuse destination trust');
          const old=f.history.read().entries.at(-1).connection.credentialRevision;
          f.changeRevision();
          const report=await buildHistoryReport(f.project,{adapters:new Map(),baseDir:f.home,offline:true});
          assert.equal(report.entries[0].connection.credentialRevision,old);assert.equal(report.entries[0].localRegistration,'update-recorded');
        }
      }
      for(const dryRun of [true,false]) {
        const f=await fixture(service);rmSync(join(f.home,'.api-key-case','license.key'));f.request.dryRun=dryRun;
        f.vault.hasSecret=async()=>assert.fail('Pro gate precedes vault');
        assert.equal((await f.run()).status,'pro-required');assert.equal(f.probes+f.reads+f.approvals,0);
      }
      for(const patch of [{scope:'user'},{target:'github'},{argv:['bad']},{env:{BAD:synthetic}},{url:'https://invalid.example'},{service:'stripe-live'},{environment:'staging'}]) {
        const f=await fixture(service);Object.assign(f.request,patch);assert.equal((await f.run()).status,'unsupported');assert.equal(f.reads+f.probes,0);
      }
      for(const mode of ['missing','legacy','wrong-env','wrong-project','wrong-service','missing-revision','pending','wrong-selected-env','wrong-target','wrong-route']) {
        const f=await fixture(service);
        if(['missing','legacy','wrong-env','wrong-project','wrong-service'].includes(mode)) {
          await f.vault.deleteSecret(f.ref);
          if(mode==='legacy')await f.vault.setSecret({name:f.ref.name,scope:'project',projectId:f.ref.projectId},synthetic);
          if(mode==='wrong-env')await f.vault.setSecret({...f.ref,environment:'development'},synthetic);
          if(mode==='wrong-project')await f.vault.setSecret({...f.ref,projectId:'ffffffffffffffff'},synthetic);
          if(mode==='wrong-service')await f.vault.setSecret(credentialRefForService(f.project,'preview',service==='openai'?'stripe-test':'openai'),synthetic);
        }
        if(mode==='missing-revision')rmSync(f.revisionFile);
        if(mode==='pending')f.store.beginCredentialMutation(f.ref);
        if(mode==='wrong-selected-env')f.select({environment:'development'});
        if(mode==='wrong-target'||mode==='wrong-route') {
          const path=join(f.metadataDir,`provider-${service}.json`),data=JSON.parse(readFileSync(path,'utf8'));
          if(mode==='wrong-target')data.intent.destination.kind='github';else data.intent.route='provider-native';
          writeFileSync(path,JSON.stringify(data));
        }
        const r=await f.run();assert.ok(['missing-credential','revision-unavailable','intent-mismatch','intent-unavailable'].includes(r.status),mode);
        assert.equal(f.reads+f.probes,0);assert.deepEqual(f.events(),[]);
      }
      for(const decision of ['declined','unavailable','throw']) {
        const f=await fixture(service);f.decision=decision;if(decision==='throw')f.onApprove=()=>{throw new Error(synthetic);};
        assert.equal((await f.run()).status,decision==='declined'?'declined':'unavailable');assert.equal(f.reads,0);assert.deepEqual(f.events(),[]);
      }
      {const f=await fixture(service);f.capability='handoff-only';assert.equal((await f.run()).status,'unavailable');assert.equal(f.reads+f.approvals,0);}
      for(const boundary of ['presence','probe','approval','read']) {
        const f=await fixture(service);
        if(boundary==='presence')f.onPresence=n=>{if(n===1)f.changeRevision();};
        if(boundary==='probe')f.onProbe=n=>{if(n===1)f.changeRevision();};
        if(boundary==='approval')f.onApprove=()=>f.changeRevision();
        if(boundary==='read')f.onRead=()=>f.changeRevision();
        assert.equal((await f.run()).status,'changed',boundary);assert.equal(f.reads,boundary==='read'?1:0);assert.deepEqual(f.events(),[]);
      }
      for(const change of ['account','destination','intent']) {
        const f=await fixture(service);
        f.onApprove=()=>{if(change==='account')f.identity='user:changed';if(change==='destination')writeFileSync(f.config,JSON.stringify({orgId:'team_other',projectId:'prj_other'}));if(change==='intent')f.select({destination:{kind:'cloudflare'}});};
        assert.equal((await f.run()).status,'changed',change);assert.equal(f.reads,0);assert.deepEqual(f.events(),[]);
      }
      {const f=await fixture(service);f.request.force=true;assert.equal((await f.run()).status,'completed');assert.deepEqual(f.events(),['remove','add']);assert.equal(f.approval.preCommands.length,1);}
      for(const failed of ['unknown','incomplete']) {
        const f=await fixture(service);if(failed==='unknown')f.readError=true;else f.writeCli('process.exit(5);');
        assert.equal((await f.run()).status,failed);assert.equal(f.history.read().entries[0].outcome,failed);
        const events=f.events();await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(f.events(),events,'unknown has no automatic retry');
      }
      {const f=await fixture(service);mkdirSync(f.historyDir,{recursive:true});writeFileSync(join(f.historyDir,'history.json'),'{}');assert.equal((await f.run()).status,'history-unavailable');assert.equal(f.reads,0);assert.deepEqual(f.events(),[]);}
      {const f=await fixture(service);await assert.rejects(runWithSecret(f.vault,f.ref,new VercelAdapter().planDeploy(f.ref.name,'preview',{force:false})),SecretNotRegisteredError);}
      for(const config of [
        'name="worker-preview"\naccount_id="0123456789abcdef0123456789abcdef"\n',
        'name="root"\naccount_id="0123456789abcdef0123456789abcdef"\n[env.preview]\nname="preview"\n',
        'name="root"\naccount_id="0123456789abcdef0123456789abcdef"\n[env.preview]\naccount_id="0123456789abcdef0123456789abcdef"\n'
      ]) {
        const f=await fixture(service,'preview','cloudflare');writeFileSync(join(f.project,'wrangler.toml'),config);
        f.request.dryRun=true;assert.equal((await f.run()).status,'unavailable');assert.equal(f.probes+f.reads,0);
        f.request.dryRun=false;assert.equal((await f.run()).status,'unavailable');assert.equal(f.probes+f.reads,0);
      }
      for(const boundary of ['approval','read']) {
        const f=await fixture(service,'preview','cloudflare');
        const change=()=>writeFileSync(join(f.project,'wrangler.toml'),'name="fallback"\naccount_id="0123456789abcdef0123456789abcdef"\n[env.preview]\nname="changed"\n');
        if(boundary==='approval')f.onApprove=change;else f.onRead=change;
        assert.equal((await f.run()).status,'changed');assert.deepEqual(f.events(),[]);
      }
    }
    for(const boundary of ['read','after-remove']) {
      const f=await fixture('stripe-test');f.request.force=true;
      if(boundary==='read')f.onRead=()=>f.changeRevision();
      else f.writeCli('',`const file=${JSON.stringify(f.revisionFile)};const data=JSON.parse(fs.readFileSync(file,'utf8'));data.credential.updatedAt='2099-01-01T00:00:00.000Z';fs.writeFileSync(file,JSON.stringify(data));`);
      assert.equal((await f.run()).status,'changed');assert.equal(f.reads,1);
      assert.deepEqual(f.events(),boundary==='read'?[]:['remove'],'Stripe early-read revision recheck covers pre-steps and final spawn');
      assert.equal(f.history.read().entries.at(-1).outcome,'unknown');
    }
    for(const value of [null,42,'sk_live_synthetic','rk_test_synthetic','pk_test_synthetic','whsec_synthetic','sk_test_','sk_test_a b','sk_test_a\n']) {
      const f=await fixture('stripe-test');f.value=value;f.request.force=true;
      const result=await f.run();assert.equal(result.status,'changed');assert.equal(f.reads,1);assert.deepEqual(f.events(),[]);
      if(typeof value==='string')for(const output of [JSON.stringify(result),JSON.stringify(f.history.read())])assert.equal(output.includes(value),false);
    }
    for(const override of [{ref:{name:'OTHER'}},{ref:{service:'stripe-live'}},{ref:{environment:'production'}},{target:'github'},{target:'local'},{force:'yes'}]) {
      const f=await fixture('stripe-test');active=f;
      const input={ref:{...f.ref,...override.ref},target:override.target??'vercel',force:override.force??false};
      const status=await runConnectionDeployment(input);
      assert.ok(['unknown','changed'].includes(status));assert.equal(f.reads+f.probes+f.approvals,0);assert.deepEqual(f.events(),[]);
    }
    {const f=await fixture('stripe-test');f.request.environment='production';assert.equal((await f.run()).status,'unsupported');assert.equal(f.reads+f.probes,0);}
    console.log(`Provider hosted deployment: passed ${count} synthetic fixtures; native gates remain closed.`);
  } finally {
    Entry.prototype.getPassword=originalRead;
    for(const name of names) {if(savedEnv[name]===undefined)delete process.env[name];else process.env[name]=savedEnv[name];}
    rmSync(root,{recursive:true,force:true});
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runProviderHostedDeployTests();
