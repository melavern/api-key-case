// Disposable mocked store/CLI only. This does not qualify the Windows native gate.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Entry } from '@napi-rs/keyring';
import { runDisposableProviderHostedDeployTests } from './provider-hosted-deploy-fixture.mjs';
import { runConnectionDeploy } from '../dist/core/deploy/engine.js';
import { resolveCloudflareTarget, listCloudflareTargets, cloudflareTargetPlan, CLOUDFLARE_TARGETS_FILE } from '../dist/core/deploy/cloudflare-targets.js';
import { CloudflareConfigAdapter } from '../dist/adapters/cloudflare.js';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { credentialRefForService } from '../dist/core/agent/connection-credential.js';
import { DeploymentHistory, buildHistoryReport } from '../dist/core/deploy/history.js';
import { MemoryVault } from '../dist/core/vault/memory.js';
import { saveLicenseKey } from '../dist/core/license.js';
import { toAccount } from '../dist/core/vault/naming.js';
import { readCredentialGuide, renderCredentialGuide } from '../dist/core/agent/credential-guide.js';
import { buildWindowsApprovalScript, encodeWindowsHelperCommand } from '../dist/core/human/windows.js';

const synthetic = 'sk_test_synthetic-hosted-stdin-only-canary-XZ61';
const canary = 'synthetic-provider-output-partial-ZQ47';
const accountId = '0123456789abcdef0123456789abcdef';
const keys = generateKeyPairSync('ed25519');
const payload = Buffer.from(JSON.stringify({v:1,plan:'pro',id:'synthetic-multi-config',issuedAt:'2026-10-07'})).toString('base64url');
const signed = `AKC1.${payload}`, license = `${signed}.${sign(null,Buffer.from(signed),keys.privateKey).toString('base64url')}`;

async function runTests() {
  if (!process.argv.includes('--synthetic-fixture')) return runDisposableProviderHostedDeployTests('cloudflare-target-deploy.mjs');
  const root = realpathSync.native(mkdtempSync(join(tmpdir(),'akc-multi-config-'))), oldRead = Entry.prototype.getPassword;
  const envNames = ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL'];
  const savedEnv = envNames.map(name => process.env[name]); envNames.forEach(name => delete process.env[name]);
  let count = 0, active;
  Entry.prototype.getPassword = function() {
    active.reads++; assert.equal(this.account,toAccount(active.ref));
    const receipt = active.history.read().entries.at(-1);
    assert.equal(receipt.outcome,'unknown');assert.equal(receipt.finishedAt,null);
    assert.equal(receipt.cloudflareTarget.id,active.request.destinationId);
    active.onRead?.(); return active.value;
  };
  async function fixture(service='openai',scope=null) {
    const dir=join(root,`case-${++count}`),project=join(dir,'project'),home=join(dir,'home'),bin=join(dir,'bin');
    for (const path of [dir,project,home,bin])mkdirSync(path);
    const folder=join(project,'deploy','staging');mkdirSync(folder,{recursive:true});
    const targets=['api','internal','buy','source'].map((id,index)=>({id,config:`deploy/staging/${id}.jsonc`,accountId,worker:`synthetic-${id}-staging`,sourceEnvironment:'preview',deploymentEnvironment:'staging',wranglerEnvironment:scope,services:[index===0?'openai':index===1?'resend':'stripe-test']}));
    const saveCatalog=()=>writeFileSync(join(project,CLOUDFLARE_TARGETS_FILE),JSON.stringify({version:1,cloudflare:targets}));saveCatalog();
    const writeConfig=(target,extra={})=>writeFileSync(join(project,target.config),JSON.stringify(scope?{env:{[scope]:{name:target.worker}},...extra}:{name:target.worker,...extra}));
    targets.forEach(target=>writeConfig(target));
    const selected=targets.find(target=>target.services.includes(service)),ref=credentialRefForService(project,'preview',service);
    const store=new ConnectionStateStore(project,home),vault=new MemoryVault(),history=new DeploymentHistory(project,home);
    saveLicenseKey(license,home);const select = service === 'resend' ? store.saveIntent.bind(store) : store.setProviderHostedIntent.bind(store);
    assert.equal(select({service,environment:'preview',route:'api-key-case-managed',destination:{kind:'cloudflare'},sendingDomain:null}).ok,true);
    await vault.setSecret(ref,synthetic);const begun=store.beginCredentialMutation(ref);assert.equal(begun.ok,true);assert.equal(store.finishCredentialMutation(ref,begun.value,true),true);
    const marker=join(dir,'events.json'),script=join(bin,'provider.cjs'),executable=join(bin,process.platform==='win32'?'wrangler.cmd':'wrangler');
    const body=`const fs=require('fs');const args=process.argv.slice(2);const target=JSON.parse(fs.readFileSync(${JSON.stringify(join(project,CLOUDFLARE_TARGETS_FILE))},'utf8')).cloudflare.find(t=>t.config===args[args.indexOf('--config')+1]);
      if(!target||process.cwd()!==${JSON.stringify(project)})process.exit(41);
      const expected=['secret','put',${JSON.stringify(ref.name)},'--config',target.config,'--name',target.worker,...(target.wranglerEnvironment?['--env',target.wranglerEnvironment]:[])];
      if(JSON.stringify(args)!==JSON.stringify(expected))process.exit(42);
      if(process.env.CLOUDFLARE_ACCOUNT_ID!==target.accountId||process.env.WRANGLER_LOG_SANITIZE!=='true'||process.env.WRANGLER_SEND_METRICS!=='false'||process.env.WRANGLER_LOG_PATH!=='C:\\\\Windows\\\\System32\\\\NUL.log'||process.env.NODE_OPTIONS)process.exit(43);
      let v='';process.stdin.on('data',c=>v+=c);process.stdin.on('end',()=>{if(v!==${JSON.stringify(synthetic)})process.exit(44);const events=fs.existsSync(${JSON.stringify(marker)})?JSON.parse(fs.readFileSync(${JSON.stringify(marker)},'utf8')):[];events.push({id:target.id,args,account:process.env.CLOUDFLARE_ACCOUNT_ID});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(events));console.log(v+' '+${JSON.stringify(canary)});console.error(v);});`;
    writeFileSync(script,body);writeFileSync(executable,process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${script}" %*\r\n`:`#!${process.execPath}\n${body}`);chmodSync(executable,0o700);
    const f={project,home,bin,folder,targets,selected,ref,store,vault,history,saveCatalog,writeConfig,reads:0,approvals:0,probes:0,value:synthetic,
      request:{service,environment:'preview',projectDir:project,dryRun:false,force:false,destinationId:selected.id},
      events:()=>existsSync(marker)?JSON.parse(readFileSync(marker,'utf8')):[],onApprove:null,onRead:null,decision:'approved',identity:`accounts:${accountId}`};
    const adapter=new CloudflareConfigAdapter(selected);adapter.checkCli=async()=>{f.probes++;return {installed:true,loggedIn:true,identity:f.identity}};
    f.deps={vault,adapter,pathOverride:bin,historyBaseDir:home,connectionBaseDir:home,licenseOptions:{baseDir:home,publicKey:keys.publicKey},humanPlane:{capability:()=> 'os-dialog',askApproval:async plan=>{f.approvals++;f.approval=plan;await f.onApprove?.();return f.decision}}};
    f.run=async()=>{active=f;const result=await runConnectionDeploy(f.deps,f.request);assert.ok(!JSON.stringify(result).includes(synthetic));assert.ok(!JSON.stringify(result).includes(canary));return result};
    return f;
  }
  try {
    const guarded = await import('../dist/core/deploy/engine-host-guard.js');
    const realHost = await import('../dist/core/deploy/engine-reviewed.js');
    const reviewedGate = await import('../dist/core/deploy/provider-hosted-reviewed.js');
    assert.equal(reviewedGate.PROVIDER_HOSTED_NATIVE_ACCEPTED,false,'broader route remains disabled');
    const platformDescriptor=Object.getOwnPropertyDescriptor(process,'platform');
    for(const platform of ['linux','darwin']) {
      const f=await fixture();active=f;
      try {
        Object.defineProperty(process,'platform',{...platformDescriptor,value:platform});
        f.deps.vault=new Proxy({}, {get(){assert.fail('unsupported host must not access vault')}});
        assert.equal((await realHost.runConnectionDeploy(f.deps,f.request)).status,'unavailable');
        assert.equal(f.probes+f.approvals+f.reads,0);assert.deepEqual(f.events(),[]);
      } finally {Object.defineProperty(process,'platform',platformDescriptor)}
    }
    if(process.platform==='win32' && reviewedGate.CLOUDFLARE_TARGET_NATIVE_ACCEPTED) {
      for(const service of ['openai','resend','stripe-test']) {
        const f=await fixture(service);active=f;
        assert.equal((await realHost.runConnectionDeploy(f.deps,f.request)).status,'completed');
        assert.equal(f.reads,1);assert.equal(f.approvals,1);assert.equal(f.events().length,1);
      }
    }
    for (const service of ['openai','resend','stripe-test']) {
      const f=await fixture(service);active=f;
      assert.equal((await guarded.runConnectionDeploy(f.deps,f.request)).status,'unavailable');assert.equal(f.reads+f.probes+f.approvals,0);
      f.request.dryRun=true;const dry=await f.run();assert.equal(dry.status,'dry-run');assert.equal(dry.destination.id,f.selected.id);assert.equal(dry.preview.sourceEnvironment,'preview');assert.equal(dry.preview.destinationEnvironment,'staging');assert.equal(f.probes+f.approvals+f.reads,0);
      const guide=await readCredentialGuide(f.project,service,'preview',{vault:f.vault,humanPlane:f.deps.humanPlane,baseDir:f.home});
      assert.equal(guide.stage,'stored');assert.deepEqual(guide.registeredCloudflare.destinationIds,service==='stripe-test'?['buy','source']:[f.selected.id]);
      assert.equal(guide.registeredCloudflare.sourceEnvironment,'preview');assert.equal(guide.registeredCloudflare.permission,'none');
      assert.ok(renderCredentialGuide(guide).includes('connection destinations'));assert.equal(f.probes+f.approvals+f.reads,0);
      if (service === 'openai') {
        const cli = fileURLToPath(new URL('../dist/cli/index.js',import.meta.url));
        const invoke = args => spawnSync(process.execPath,[cli,...args,f.project],{encoding:'utf8',timeout:20000});
        const listed=invoke(['connection','destinations','--json']);assert.equal(listed.status,0);const report=JSON.parse(listed.stdout);
        assert.equal(report.targets.length,4);assert.ok(report.targets.every(target=>target.configReadiness==='locally-bound'));assert.equal(report.permission,'none');
        for (const extra of [['--config','deploy/staging/api.jsonc'],['--command','evil'],['--destination','../outside'],['--destination','api','--destination','api'],['--destination','api','--force']]) {
          const denied=invoke(['connection','deploy','--service','openai','--env','preview','--dry-run','--json',...extra]);assert.equal(denied.status,1);assert.ok(!denied.stdout.includes(synthetic));
        }
      }
      f.request.dryRun=false;const result=await f.run();assert.equal(result.status,'completed');assert.equal(result.historySaved,true);assert.equal(f.reads,1);assert.equal(f.approvals,1);
      assert.equal(f.events()[0].id,f.selected.id);assert.equal(f.history.read().entries[0].cloudflareTarget.id,f.selected.id);
      assert.ok(f.approval.destination.includes('deployment staging'));assert.ok(f.approval.destination.includes('source preview'));
      const native=buildWindowsApprovalScript(f.approval);assert.ok(native.includes(f.selected.config));assert.ok(native.includes(f.selected.worker));assert.ok(native.includes(accountId));encodeWindowsHelperCommand(native);
      assert.equal((await f.run()).status,'completed');assert.equal(f.approvals,2,'every overwrite needs new approval');
      const report=await buildHistoryReport(f.project,{baseDir:f.home,adapters:new Map(),offline:true});assert.equal(report.schemaVersion,4);assert.equal(report.entries[0].currentDestination,'unresolved');
      if (service==='stripe-test') {
        f.request.destinationId='source';f.deps.adapter=new CloudflareConfigAdapter(f.targets[3]);f.deps.adapter.checkCli=async()=>({installed:true,loggedIn:true,identity:f.identity});
        assert.equal((await f.run()).status,'completed');assert.equal(f.events().at(-1).id,'source');assert.equal(f.approvals,3);assert.equal(f.reads,3,'same exact slot, individual destinations');
      }
      const files=(folder)=>readdirSync(folder,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(folder,entry.name)):entry.name.endsWith('.json')?[join(folder,entry.name)]:[]);
      for(const file of files(f.home)){const text=readFileSync(file,'utf8');assert.ok(!text.includes(synthetic));assert.ok(!text.includes(canary));}
    }
    {const f=await fixture('openai','staging');assert.equal((await f.run()).status,'completed');assert.deepEqual(f.events()[0].args.slice(-2),['--env','staging']);}
    for(const extension of ['json','toml']) {
      const f=await fixture();f.selected.config=`deploy/staging/api.${extension}`;f.saveCatalog();
      writeFileSync(join(f.project,f.selected.config),extension==='toml'?`name="${f.selected.worker}"\naccount_id="${accountId}"\n`:JSON.stringify({name:f.selected.worker,account_id:accountId}));
      assert.equal((await f.run()).status,'completed');assert.equal(f.events()[0].args[4],f.selected.config);
    }
    for (const decision of ['declined','unavailable']) {const f=await fixture();f.decision=decision;assert.equal((await f.run()).status,decision);assert.equal(f.reads,0);assert.deepEqual(f.events(),[]);assert.equal(f.history.read().status,'missing');}
    for (const mutate of [
      f=>{f.targets[0].worker='other-worker';f.saveCatalog()},
      f=>{f.targets[0].accountId='abcdef0123456789abcdef0123456789';f.saveCatalog()},
      f=>{f.targets[0].config='deploy/staging/buy.jsonc';f.saveCatalog()},
      f=>f.writeConfig(f.selected,{account_id:'abcdef0123456789abcdef0123456789'}),
      f=>f.writeConfig(f.selected,{vars:{unrelated: 'changed'}}),
      f=>mkdirSync(join(f.folder,'.env')),
      f=>{f.store.setProviderHostedIntent({service:'openai',environment:'development',route:'api-key-case-managed',destination:{kind:'cloudflare'},sendingDomain:null})},
      f=>{const begun=f.store.beginCredentialMutation(f.ref);f.store.finishCredentialMutation(f.ref,begun.value,true)}
    ]) {const f=await fixture();f.onApprove=()=>mutate(f);assert.equal((await f.run()).status,'changed');assert.equal(f.reads,0);assert.deepEqual(f.events(),[]);}
    {const f=await fixture();f.onRead=()=>f.writeConfig(f.selected,{vars:{changed:true}});assert.equal((await f.run()).status,'changed');assert.equal(f.reads,1);assert.deepEqual(f.events(),[]);assert.equal(f.history.read().entries[0].outcome,'unknown');}
    {const f=await fixture();f.identity='accounts:abcdef0123456789abcdef0123456789';assert.equal((await f.run()).status,'unavailable');assert.equal(f.reads+f.approvals,0);assert.deepEqual(f.events(),[]);}
    for(const value of ['sk_live_synthetic','rk_test_synthetic','pk_test_synthetic','whsec_synthetic','sk_test_','sk_test_a b']){const f=await fixture('stripe-test');f.value=value;assert.equal((await f.run()).status,'changed');assert.deepEqual(f.events(),[]);}
    for(const extra of [{destinationId:'../outside'},{destinationId:'missing'},{destinationId:'internal'},{force:true},{environment:'production'},{config:'deploy/staging/api.jsonc'},{command:['evil']}]){const f=await fixture();Object.assign(f.request,extra);assert.ok(['unsupported','unavailable','intent-mismatch'].includes((await f.run()).status));assert.equal(f.reads+f.probes+f.approvals,0);}
    for(const mutate of [
      f=>{f.targets[0].config='../outside.jsonc'},f=>{f.targets[0].config='C:/absolute.jsonc'},f=>{f.targets[0].config='deploy/staging/.env'},
      f=>{f.targets[0].command='evil'},f=>{f.targets[0].wranglerEnvironment='--evil'},f=>{f.targets[0].id='bad\nvalue'},
      f=>{f.targets[0].deploymentEnvironment='production'},f=>{f.targets[0].services=['stripe-live']},f=>{f.targets.push({...f.targets[0]})}
    ]){const f=await fixture();mutate(f);f.saveCatalog();assert.equal(listCloudflareTargets(f.project).status,'unavailable');assert.equal(resolveCloudflareTarget(f.project,'api','openai','preview'),null);}
    {const f=await fixture();writeFileSync(join(f.project,CLOUDFLARE_TARGETS_FILE),'{"version":1,"version":1,"cloudflare":[]}');assert.equal(listCloudflareTargets(f.project).status,'unavailable');}
    {const f=await fixture();writeFileSync(join(f.project,f.selected.config),'{"name":"synthetic-api-staging","name":"synthetic-api-staging"}');assert.equal(resolveCloudflareTarget(f.project,'api','openai','preview'),null);}
    {const f=await fixture();writeFileSync(join(f.project,f.selected.config),'x'.repeat(65537));assert.equal(resolveCloudflareTarget(f.project,'api','openai','preview'),null);}
    {const f=await fixture();f.writeConfig(f.selected,{vars:{secret:synthetic}});const binding=resolveCloudflareTarget(f.project,'api','openai','preview');assert.ok(binding);assert.ok(!JSON.stringify(binding).includes(synthetic));assert.ok(binding.files.filter(file=>file.path.endsWith('.jsonc')).every(file=>file.contentHash===null));}
    {const f=await fixture();linkSync(join(f.project,f.selected.config),join(f.project,'hardlink.jsonc'));assert.equal(resolveCloudflareTarget(f.project,'api','openai','preview'),null);}
    {const f=await fixture();const outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'api.jsonc'),JSON.stringify({name:f.selected.worker}));rmSync(f.folder,{recursive:true});symlinkSync(outside,f.folder,process.platform==='win32'?'junction':'dir');assert.equal(resolveCloudflareTarget(f.project,'api','openai','preview'),null);}
    console.log(`Cloudflare multi-config: passed ${count} synthetic fixtures; native acceptance is separate.`);
  } finally { Entry.prototype.getPassword=oldRead;envNames.forEach((name,index)=>{if(savedEnv[index]===undefined)delete process.env[name];else process.env[name]=savedEnv[index]});rmSync(root,{recursive:true,force:true}); }
}
if (process.argv[1]===fileURLToPath(import.meta.url)) await runTests();
