import assert from 'node:assert/strict';
import { runDisposableConnectionDeployTests } from './connection-deploy-fixture.mjs';
import { Entry } from '@napi-rs/keyring';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runConnectionDeploy } from '../dist/core/deploy/engine.js';
import { runWithSecret, SecretNotRegisteredError } from '../dist/core/deploy/handoff.js';
import { DeploymentHistory } from '../dist/core/deploy/history.js';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { connectionCredentialRef } from '../dist/core/agent/connection-credential.js';
import { canonicalProjectRealpath } from '../dist/core/vault/naming.js';
import { MemoryVault } from '../dist/core/vault/memory.js';
import { VercelAdapter } from '../dist/adapters/vercel.js';
import { GitHubEnvironmentAdapter } from '../dist/adapters/github-environment.js';
import { CloudflareAdapter } from '../dist/adapters/cloudflare.js';
import { saveLicenseKey } from '../dist/core/license.js';

const synthetic = 'synthetic-v2-stdin-only-canary-ZQ47';
const canary = 'synthetic-provider-output-partial-ZQ47';
const keys = generateKeyPairSync('ed25519');
const payload = Buffer.from(JSON.stringify({v:1,plan:'pro',id:'synthetic-connection-deploy',issuedAt:'2026-10-02'})).toString('base64url');
const signed = `AKC1.${payload}`;
const license = `${signed}.${sign(null,Buffer.from(signed),keys.privateKey).toString('base64url')}`;
const names = ['VERCEL_TOKEN','VERCEL_ORG_ID','VERCEL_PROJECT_ID','CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL','CLOUDFLARE_ACCOUNT_ID','NODE_OPTIONS','NODE_PATH','INJECTED'];

export async function runConnectionDeployTests() {
  if (!process.argv.includes('--synthetic-fixture')) return runDisposableConnectionDeployTests();
  const root = realpathSync(mkdtempSync(join(tmpdir(),'akc-connection-deploy-')));
  const originalRead = Entry.prototype.getPassword;
  const savedEnv = Object.fromEntries(names.map(name=>[name,process.env[name]]));
  names.forEach(name=>delete process.env[name]);
  let count = 0, active;
  Entry.prototype.getPassword = function() {
    active.reads++;
    const pending = active.history.read();
    assert.equal(pending.status,'available');
    assert.equal(pending.entries.at(-1).outcome,'unknown','durable unknown precedes every value read');
    assert.equal(pending.entries.at(-1).finishedAt,null);
    assert.equal(pending.entries.at(-1).connection.environment,active.request.environment);
    active.onRead?.();
    if (active.readError) throw new Error(synthetic + canary);
    return synthetic;
  };
  const fixture = async (environment='preview',target='vercel') => {
    const dir=join(root,`case-${++count}`),project=join(dir,'project'),home=join(dir,'home'),bin=join(dir,'bin');
    for(const path of [dir,project,home,bin])mkdirSync(path,{mode:0o700});
    let config=join(project,'.vercel','project.json');mkdirSync(join(project,'.vercel'));
    writeFileSync(config,JSON.stringify({orgId:'team_synthetic',projectId:'prj_synthetic'}));
    writeFileSync(join(project,'wrangler.toml'),'name = "synthetic"\naccount_id = "0123456789abcdef0123456789abcdef"\n[env.preview]\nname = "synthetic-preview"\naccount_id = "0123456789abcdef0123456789abcdef"\n[env.development]\nname = "synthetic-development"\naccount_id = "0123456789abcdef0123456789abcdef"\n');
    if(target==='github'){mkdirSync(join(project,'.git'));config=join(project,'.git','config');writeFileSync(config,'[remote "origin"]\nurl = https://github.com/owner/repository.git\n');}
    const remote=join(dir,'remote.json');writeFileSync(remote,JSON.stringify({user:[1,'synthetic'],repository:[2,'owner/repository'],environment:[3,environment]}));
    const official=()=>target==='github'?new GitHubEnvironmentAdapter('owner/repository',environment):target==='vercel'?new VercelAdapter():new CloudflareAdapter();
    saveLicenseKey(license,home);
    const store=new ConnectionStateStore(project,home),vault=new MemoryVault(),ref=connectionCredentialRef(project,environment);
    const select=(overrides={})=>{const saved=store.saveIntent({service:'resend',environment,route:'api-key-case-managed',destination:{kind:target},sendingDomain:null,...overrides});assert.equal(saved.ok,true);};
    select();await vault.setSecret(ref,synthetic);
    const begun=store.beginCredentialMutation(ref);assert.equal(begun.ok,true);assert.equal(store.finishCredentialMutation(ref,begun.value,true),true);
    const metadataDir=join(home,'.api-key-case','connections',createHash('sha256').update(canonicalProjectRealpath(project)).digest('hex'));
    const revisionFile=join(metadataDir,`credential-${environment}.json`);
    const history=new DeploymentHistory(project,home);
    const historyDir=join(home,'.api-key-case','deployment-history',createHash('sha256').update(realpathSync.native(project)).digest('hex'));
    const marker=join(dir,'events.json');
    const f={dir,project,home,bin,config,remote,store,vault,ref,select,metadataDir,revisionFile,history,historyDir,marker,
      reads:0,probes:0,approvals:0,presence:0,decision:'approved',capability:'os-dialog',onProbe:null,onPresence:null,onRead:null,onApprove:null,
      request:{service:'resend',environment,projectDir:project,dryRun:false,force:false},
      events:()=>existsSync(marker)?JSON.parse(readFileSync(marker,'utf8')):[],
      changeRevision:()=>{const data=JSON.parse(readFileSync(revisionFile,'utf8'));data.credential.updatedAt='2099-01-01T00:00:00.000Z';writeFileSync(revisionFile,JSON.stringify(data));},
      writeCli:(afterAdd='',afterRemove='')=>{
        const body=`const fs=require('fs');const args=process.argv.slice(2);const p=${JSON.stringify(marker)};\n`+
          (target==='github'?`const state=JSON.parse(fs.readFileSync(${JSON.stringify(remote)},'utf8'));if(args[0]==='--version'){console.log('gh version 2.80.0');process.exit(0);}if(args[0]==='auth'){if(JSON.stringify(args)!==JSON.stringify(['auth','status','--hostname','github.com']))process.exit(41);process.exit(state.authFailure?1:0);}if(args[0]==='api'){if(JSON.stringify(args.slice(0,5))!==JSON.stringify(['api','--hostname','github.com','--method','GET']))process.exit(42);const endpoint=args[5];const key=endpoint==='user'?'user':endpoint==='repos/owner/repository'?'repository':endpoint==='repos/owner/repository/environments/${environment}'?'environment':null;const projection=key==='user'?'[.id,.login]':key==='repository'?'[.id,.full_name]':'[.id,.name]';if(!key||args[6]!=='--jq'||args[7]!==projection||args.length!==8||!state[key])process.exit(43);console.log(JSON.stringify(state[key]));process.exit(0);}`:'')+
          `const rm=args[1]==='rm';const expected=rm?${JSON.stringify(['env','rm','RESEND_API_KEY',environment,'--yes'])}:${JSON.stringify(official().planDeploy('RESEND_API_KEY',environment,{force:false}).argv.slice(1))};if(JSON.stringify(args)!==JSON.stringify(expected))process.exit(21);\n`+
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
    adapter.checkCli=async(options)=>{f.probes++;await f.onProbe?.(f.probes);return target==='github'?realCheck(options):{installed:true,loggedIn:true,identity:f.identity??'user:synthetic'};};
    const has=vault.hasSecret.bind(vault);
    vault.hasSecret=async ref=>{f.presence++;const present=await has(ref);await f.onPresence?.(f.presence);return present;};
    f.deps={vault,adapter,pathOverride:bin,historyBaseDir:home,connectionBaseDir:home,licenseOptions:{baseDir:home,publicKey:keys.publicKey},humanPlane:{
      capability:()=>f.capability,askApproval:async plan=>{f.approvals++;f.approval=plan;await f.onApprove?.();return f.decision;}
    }};
    f.run=async()=>{active=f;const result=await runConnectionDeploy(f.deps,f.request);assert.ok(!JSON.stringify(result).includes(synthetic));assert.ok(!JSON.stringify(result).includes(canary));return result;};
    return f;
  };
  try {
    const guardedEngine=await import('../dist/core/deploy/engine-host-guard.js');
    const guardedHandoff=await import('../dist/core/deploy/handoff-host-guard.js');
    const originalPlatform=Object.getOwnPropertyDescriptor(process,'platform');
    try {
      for(const platform of ['linux','darwin']) {
        const f=await fixture();active=f;
        Object.defineProperty(process,'platform',{...originalPlatform,value:platform});
        f.vault.hasSecret=f.vault.isAvailable=async()=>assert.fail('unsupported host must not access vault');
        const result=await guardedEngine.runConnectionDeploy(f.deps,f.request);
        assert.equal(result.status,'unavailable');assert.equal(result.placementEffects,'none');assert.equal(result.historySaved,false);
        assert.equal(f.presence+f.probes+f.approvals+f.reads,0);assert.deepEqual(f.events(),[]);assert.equal(f.history.read().status,'missing');
        const forbidden=new Proxy({}, {get(){assert.fail('handoff host guard must precede input use');}});
        assert.equal(await guardedHandoff.runConnectionDeployment(forbidden),'changed');
        // Platform substitution proves the early host guard only. Restore the
        // real host before creating metadata: Windows cannot emulate POSIX modes.
        Object.defineProperty(process,'platform',originalPlatform);
        const preview=await fixture();active=preview;preview.request.dryRun=true;
        preview.vault.isAvailable=async()=>assert.fail('dry-run must not mutate store with availability probe');
        preview.deps.adapter.checkCli=async()=>assert.fail('dry-run must not call provider');
        const dry=await guardedEngine.runConnectionDeploy(preview.deps,preview.request);
        assert.equal(dry.status,'dry-run');assert.ok(preview.presence>0,'existing presence prerequisite retained');
        assert.equal(preview.probes+preview.approvals+preview.reads,0);assert.deepEqual(preview.events(),[]);assert.equal(preview.history.read().status,'missing');
        await preview.vault.deleteSecret(preview.ref);
        assert.equal((await guardedEngine.runConnectionDeploy(preview.deps,preview.request)).status,'missing-credential');
        Object.defineProperty(process,'platform',originalPlatform);
      }
    } finally { Object.defineProperty(process,'platform',originalPlatform); }
    for(const environment of ['development','preview','production']) {
      const f=await fixture(environment,'github');f.request.dryRun=true;
      const preview=await f.run();assert.equal(preview.status,'dry-run');assert.equal(preview.preview.target,'github');assert.equal(preview.preview.repository,'github.com/owner/repository');assert.equal(preview.preview.destinationScope,'github-environment');assert.equal(preview.preview.destinationEnvironment,environment);assert.equal(f.probes,0);assert.equal(f.reads,0);assert.equal(f.approvals,0);
      f.request.dryRun=false;const result=await f.run();assert.equal(result.status,'completed');assert.equal(f.approvals,1);assert.equal(f.reads,1);assert.deepEqual(f.events(),['add']);assert.equal(f.history.read().entries[0].connection.environment,environment);assert.ok(f.approval.command.includes('--repo github.com/owner/repository --env '+environment));
    }
    for(const state of [{environment:null},{environment:[4,'wrong']},{environment:[9007199254740992,'development']},{repository:[2,'another/repo']},{user:[0,'synthetic']},{authFailure:true}]) {
      const f=await fixture('development','github');writeFileSync(f.remote,JSON.stringify({...JSON.parse(readFileSync(f.remote,'utf8')),...state}));
      const result=await f.run();assert.equal(result.status,'unavailable');assert.equal(result.placementEffects,'none');assert.equal(f.reads,0);assert.equal(f.approvals,0);assert.deepEqual(f.events(),[]);
    }
    for(const change of ['user','repository','environment']) {
      const f=await fixture('development','github');f.onApprove=()=>{const state=JSON.parse(readFileSync(f.remote,'utf8'));state[change][0]+=10;writeFileSync(f.remote,JSON.stringify(state));};
      assert.equal((await f.run()).status,'changed');assert.equal(f.reads,0);assert.deepEqual(f.events(),[]);
    }
    {
      const f=await fixture('development','github');f.decision='declined';assert.equal((await f.run()).status,'declined');assert.equal(f.reads,0);assert.deepEqual(f.events(),[]);
    }
    {
      const f=await fixture('development','github');rmSync(f.config);assert.equal((await f.run()).status,'unavailable');assert.equal(f.presence,0);assert.equal(f.probes,0);assert.equal(f.reads,0);
    }
    {
      const f=await fixture('development','github');await f.vault.deleteSecret(f.ref);await f.vault.setSecret({...f.ref,environment:'production'},synthetic);await f.vault.setSecret({name:'RESEND_API_KEY',scope:'project',projectId:f.ref.projectId},synthetic);
      assert.equal((await f.run()).status,'missing-credential');assert.equal(f.probes,0);assert.equal(f.reads,0);
    }
    {
      const f=await fixture('development','github');f.writeCli('process.exit(5);');const result=await f.run();assert.equal(result.status,'incomplete');assert.equal(result.placementEffects,'possible');assert.equal(f.history.read().entries[0].outcome,'incomplete');assert.deepEqual(f.events(),['add']);assert.equal(f.approvals,1);
    }
    {
      const f=await fixture('development','github');const state=JSON.parse(readFileSync(f.remote,'utf8'));state.environment[0]++;
      f.writeCli(`fs.writeFileSync(${JSON.stringify(f.remote)},${JSON.stringify(JSON.stringify(state))});`);
      const result=await f.run();assert.equal(result.status,'changed');assert.equal(result.placementEffects,'possible');assert.equal(f.history.read().entries[0].outcome,'unknown');assert.deepEqual(f.events(),['add']);assert.equal(f.reads,1);assert.equal(f.approvals,1);
    }
    for (const dryRun of [true,false]) {
      const f=await fixture();rmSync(join(f.home,'.api-key-case','license.key'));f.request.dryRun=dryRun;
      f.vault.isAvailable=f.vault.hasSecret=async()=>{assert.fail('free entitlement must block vault');};
      assert.equal((await f.run()).status,'pro-required');assert.equal(f.probes,0);assert.equal(f.reads,0);
    }
    {
      const f=await fixture();f.request.dryRun=true;
      f.deps.adapter.checkCli=async()=>assert.fail('offline dry-run must not probe CLI');
      f.vault.isAvailable=async()=>assert.fail('offline dry-run must not write vault availability probe');
      for(const name of ['hasDestinationTrust','saveDestinationTrust'])f.vault[name]=async()=>assert.fail('dry-run must not touch trust');
      const begin=DeploymentHistory.prototype.beginConnection;DeploymentHistory.prototype.beginConnection=()=>assert.fail('dry-run must not write history');
      try{const r=await f.run();assert.equal(r.status,'dry-run');assert.deepEqual(r.preview,{kind:'offline-request',name:'RESEND_API_KEY',scope:'project',placementEffect:'vercel-environment-update',nativeExecution:'accepted-windows-only',providerMode:'not-applicable',sourceEnvironment:'preview',destinationEnvironment:'preview',target:'vercel',force:false,removesExistingFirst:false,mayOverwrite:false,destinationReadiness:'not-verified',providerProbes:'not-run',permission:'none'});}finally{DeploymentHistory.prototype.beginConnection=begin;}
      assert.equal(f.reads,0);assert.equal(f.approvals,0);assert.equal(f.history.read().status,'missing');assert.equal(f.store.readObservations().status,'missing');
    }
    for(const override of [{environment:'production'},{route:'manual'},{route:'provider-native'},{destination:{kind:'local'}},{destination:{kind:'manual'}}]){
      const f=await fixture();f.select(override);assert.ok(['unsupported','intent-mismatch'].includes((await f.run()).status));assert.equal(f.reads+f.probes,0);
    }
    for(const extra of [{scope:'user'},{target:'github'},{url:'https://invalid.example'},{service:'other'},{environment:'staging'},{argv:['bad']},{env:{BAD:'value'}}]){
      const f=await fixture();Object.assign(f.request,extra);assert.equal((await f.run()).status,'unsupported');assert.equal(f.reads+f.probes,0);
    }
    for(const mode of ['missing-intent','broken-intent','missing-revision','broken-revision','pending-revision','missing-slot','legacy-only','other-env']){
      const f=await fixture();
      if(mode==='missing-intent')rmSync(join(f.metadataDir,'state.json'));
      if(mode==='broken-intent')writeFileSync(join(f.metadataDir,'state.json'),'{');
      if(mode==='missing-revision')rmSync(f.revisionFile);
      if(mode==='broken-revision')writeFileSync(f.revisionFile,'{}');
      if(mode==='pending-revision')assert.equal(f.store.beginCredentialMutation(f.ref).ok,true);
      if(['missing-slot','legacy-only','other-env'].includes(mode))await f.vault.deleteSecret(f.ref);
      if(mode==='legacy-only')await f.vault.setSecret({name:f.ref.name,scope:'project',projectId:f.ref.projectId},synthetic);
      if(mode==='other-env')await f.vault.setSecret(connectionCredentialRef(f.project,'production'),synthetic);
      const r=await f.run();assert.ok(['intent-unavailable','revision-unavailable','missing-credential'].includes(r.status),mode);assert.equal(f.reads+f.probes,0,mode);
    }
    for(const decision of ['declined','unavailable','throw']){
      const f=await fixture();f.decision=decision;if(decision==='throw')f.onApprove=()=>{throw new Error(canary);};
      assert.equal((await f.run()).status,decision==='declined'?'declined':'unavailable',JSON.stringify({probes:f.probes,presence:f.presence,approvals:f.approvals}));assert.equal(f.reads,0);assert.deepEqual(f.events(),[]);assert.equal(f.history.read().status,'missing');
    }
    {const f=await fixture();f.capability='handoff-only';assert.equal((await f.run()).status,'unavailable');assert.equal(f.approvals+f.reads,0);}
    // All cases use fixed fake CLIs and a stubbed Entry; never a real provider/store.
    for(const [env,target] of [['preview','vercel'],['development','vercel'],['production','vercel'],['preview','cloudflare']]){
      const f=await fixture(env,target);process.env.INJECTED='synthetic-inherited-poison';const r=await f.run();delete process.env.INJECTED;assert.equal(r.status,'completed',`${env}/${target}: ${JSON.stringify(r)}`);assert.equal(r.historySaved,true);assert.deepEqual(f.events(),['add']);assert.equal(f.reads,1);assert.equal(f.approvals,1);
      assert.deepEqual(f.approval.connectionSource,{credentialVersion:2,service:'resend',environment:env,credentialRevision:f.store.credentialRevision(f.ref)});assert.equal(Object.isFrozen(f.approval.connectionSource),true);
      assert.equal(f.store.readObservations().status,'missing','deployment cannot authenticate app/provider observations');
      if(env==='preview'&&target==='vercel'){assert.equal((await f.run()).status,'completed');assert.equal(f.approvals,1,'same already trusted exact preview destination uses existing policy');}
      else{assert.equal((await f.run()).status,'completed');assert.equal(f.approvals,2,'high-risk classes always ask');}
    }
    {const f=await fixture();f.request.force=true;assert.equal((await f.run()).status,'completed');assert.deepEqual(f.events(),['remove','add']);assert.equal(f.approval.preCommands.length,1);}
    {const f=await fixture();f.writeCli('process.exit(5);');const r=await f.run();assert.equal(r.status,'incomplete');assert.equal(r.historySaved,true);assert.equal(f.history.read().entries[0].outcome,'incomplete');assert.deepEqual(f.events(),['add']);}
    // At every observed asynchronous guard boundary, revision drift must abort.
    const baseline=await fixture();assert.equal((await baseline.run()).status,'completed');
    for(let at=1;at<=baseline.presence;at++){
      const f=await fixture();f.onPresence=n=>{if(n===at)f.changeRevision();};const r=await f.run();assert.notEqual(r.status,'completed',`presence await ${at}`);if(f.events().length)assert.equal(r.placementEffects,'possible');
    }
    for(const phase of ['probe','approval','read','after-remove','after-add'])for(const change of ['revision','intent','destination','cli','account','missing']){
      const f=await fixture();f.request.force=phase==='after-remove';
      const mutate=async()=>{
        if(change==='revision')f.changeRevision();
        if(change==='intent')f.select({sendingDomain:'changed.example'});
        if(change==='destination')writeFileSync(f.config,JSON.stringify({orgId:'team_changed',projectId:'prj_changed'}));
        if(change==='cli')writeFileSync(f.executable,'unusable replacement');
        if(change==='account')f.identity='user:changed';
        if(change==='missing')await f.vault.deleteSecret(f.ref);
      };
      if(phase==='probe')f.onProbe=n=>n===(change==='account'?2:1)?mutate():undefined;
      if(phase==='approval')f.onApprove=mutate;
      if(phase==='read')f.onRead=()=>{if(change==='missing')f.vault.deleteSecret(f.ref);else void mutate();};
      if(phase==='after-remove'||phase==='after-add'){
        let changed=false;f.onPresence=async()=>{if(!changed&&f.events().includes(phase==='after-remove'?'remove':'add')){changed=true;await mutate();}};
      }
      const r=await f.run();assert.notEqual(r.status,'completed',`${phase}/${change}`);
      if(phase==='after-remove')assert.deepEqual(f.events(),['remove']);
      if(phase==='after-add')assert.deepEqual(f.events(),['add']);
      if(f.events().length){assert.equal(r.placementEffects,'possible');assert.equal(f.history.read().entries.at(-1).outcome,'unknown');}
    }
    for(const problem of ['lock','corrupt','tmp']){
      const f=await fixture();mkdirSync(f.historyDir,{recursive:true,mode:0o700});
      if(problem==='lock')mkdirSync(join(f.historyDir,'lock'));if(problem==='corrupt')writeFileSync(join(f.historyDir,'history.json'),'{');if(problem==='tmp')writeFileSync(join(f.historyDir,'history.tmp'),'synthetic');
      assert.equal((await f.run()).status,'history-unavailable');assert.equal(f.reads,0);assert.deepEqual(f.events(),[]);
    }
    {
      const f=await fixture();f.request.force=true;f.onRead=()=>{throw new Error(synthetic);};
      const r=await f.run();assert.equal(r.status,'unknown');assert.equal(r.placementEffects,'possible');assert.deepEqual(f.events(),['remove']);assert.equal(f.history.read().entries.at(-1).outcome,'unknown');
    }
    for(const mode of ['result-save-failure','result-save-throw','lock-after-add','tamper-attempt']){
      const f=await fixture();const finish=DeploymentHistory.prototype.finish;
      if(mode==='result-save-failure')DeploymentHistory.prototype.finish=()=>false;
      if(mode==='result-save-throw')DeploymentHistory.prototype.finish=()=>{throw new Error(canary);};
      if(mode==='lock-after-add')f.writeCli(`fs.mkdirSync(${JSON.stringify(join(f.historyDir,'lock'))});`);
      if(mode==='tamper-attempt')f.onRead=()=>{const p=join(f.historyDir,'history.json'),data=JSON.parse(readFileSync(p,'utf8'));data.entries.at(-1).connection.credentialRevision='2098-01-01T00:00:00.000Z';writeFileSync(p,JSON.stringify(data));};
      let r;try{r=await f.run();}finally{DeploymentHistory.prototype.finish=finish;}
      assert.equal(r.placementEffects,'possible');assert.equal(r.historySaved,mode==='tamper-attempt');
      assert.equal(r.status,mode==='result-save-failure'?'completed':mode==='result-save-throw'?'unknown':'changed');
      assert.ok(f.events().length<=1,'no automatic retry');
      if(mode==='lock-after-add')rmSync(join(f.historyDir,'lock'),{recursive:true});
      assert.equal(f.history.read().entries.at(-1).outcome,'unknown');
    }
    {
      const f=await fixture();const alias=join(f.dir,'alias');
      if(process.platform!=='win32'){symlinkSync(f.project,alias,'dir');f.request.projectDir=alias;assert.equal((await f.run()).status,'completed');assert.equal(f.history.read().entries[0].connection.projectId,f.ref.projectId);}
      await assert.rejects(runWithSecret(f.vault,f.ref,{}),SecretNotRegisteredError);
    }
    const cli=fileURLToPath(new URL('../dist/cli/index.js',import.meta.url));
    for(const args of [[],['--service','resend'],['--service','other','--env','preview'],['--service','resend','--env','preview','--scope','user'],['--service','resend','--env','preview','--target','vercel'],['--service','resend','--env','preview','--url',canary]]){
      const r=spawnSync(process.execPath,[cli,'connection','deploy',...args],{encoding:'utf8',env:{...process.env,HOME:root,USERPROFILE:root,DO_NOT_TRACK:'1'}});assert.equal(r.status,1);assert.ok(!(r.stdout+r.stderr).includes(canary));
    }
    for(const args of [[],['--dry-run']]){
      const r=spawnSync(process.execPath,[cli,'connection','deploy','--service','resend','--env','preview','--json',...args],{encoding:'utf8',env:{...process.env,HOME:root,USERPROFILE:root,DO_NOT_TRACK:'1'}});assert.equal(r.status,6);assert.equal(JSON.parse(r.stdout).status,'pro-required');
    }
    console.log(`Connection deploy synthetic tests passed (${count} isolated cases; no real store/provider/network)`);
  } finally {
    Entry.prototype.getPassword=originalRead;
    for(const [name,value] of Object.entries(savedEnv)){if(value===undefined)delete process.env[name];else process.env[name]=value;}
    rmSync(root,{recursive:true,force:true});
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runConnectionDeployTests();
