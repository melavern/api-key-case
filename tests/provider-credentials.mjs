// Synthetic OS-store/Human Plane only. No provider, real keyring or native dialog.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryVault } from '../dist/core/vault/memory.js';
import { toAccount } from '../dist/core/vault/naming.js';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { CREDENTIAL_SERVICES, credentialEnvironments, credentialRefForService, runConnectionCredential } from '../dist/core/agent/connection-credential.js';
import { readCredentialGuide, renderCredentialGuide } from '../dist/core/agent/credential-guide.js';
import { buildNextReport } from '../dist/core/agent/next.js';
import { readConnectionInventory } from '../dist/core/agent/connection-inventory.js';
import { runWithSecret, runConnectionDeployment, SecretNotRegisteredError } from '../dist/core/deploy/handoff.js';

const canary='synthetic-provider-fixture-Q6a17';
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'akc-provider-')),project=join(root,'project'),home=join(root,'home');
  mkdirSync(project);mkdirSync(home);const vault=new MemoryVault(),store=new ConnectionStateStore(project,home);
  let calls=0,mode='save';
  const humanPlane={capability:()=> 'os-dialog',askSecret:async ref=>{calls++;if(mode==='throw')throw Error(canary);if(mode==='save')await vault.setSecret(ref,canary);return mode==='cancel'?'cancelled':'saved';},askRemoval:async()=> 'declined'};
  const deps={vault,humanPlane,connectionBaseDir:home};
  return {root,project,home,vault,store,deps,humanPlane,get calls(){return calls},setMode:m=>mode=m,
    ref:(service,env='development')=>credentialRefForService(project,env,service),
    guide:(service,env='development',overrides={})=>readCredentialGuide(project,service,env,{vault,humanPlane,baseDir:home,...overrides}),
    save:(service,env='development',force=false)=>runConnectionCredential(project,env,'save',deps,force,service),
    close:()=>rmSync(root,{recursive:true,force:true})};
}
function closed(report) {
  assert.equal(report.permission,'none');assert.equal(report.executed,false);
  assert.equal(report.operationPlan.secretTransfer,'none');assert.equal(report.operationPlan.deployment,false);
  assert.equal(report.operationPlan.resourceCreation,false);assert.equal(report.operationPlan.providerCheck,'not-run');
  assert.equal(report.operationPlan.applicationCheck,'not-run');assert.ok(!JSON.stringify(report).includes(canary));
}

test('fixed eleven scoped refs reject wrong service/name/environment and preserve v1 isolation',()=>{
  const f=fixture();try {
    const refs=CREDENTIAL_SERVICES.flatMap(s=>credentialEnvironments(s).map(e=>f.ref(s,e)));
    assert.equal(new Set(refs.map(toAccount)).size,11);
    for(const ref of refs)assert.notEqual(toAccount(ref),toAccount({name:ref.name,scope:'project',projectId:ref.projectId}));
    for(const bad of [{...f.ref('openai'),name:'RESEND_API_KEY'},{...f.ref('stripe-test'),environment:'production'},
      {...f.ref('openai'),service:'arbitrary'},{...f.ref('openai'),scope:'user',projectId:null}]) assert.throws(()=>toAccount(bad));
  }finally{f.close()}
});
for(const service of ['openai','stripe-test'])for(const environment of credentialEnvironments(service)) {
  test(`${service}/${environment}: acquire, OS save, new conversation reuse and unsupported consumer are distinct`,async()=>{
    const f=fixture();try {
      let r=await f.guide(service,environment);closed(r);assert.equal(r.stage,'acquire-and-save');assert.ok(r.acquisition);
      assert.equal((await f.save(service,environment)).status,'saved');const calls=f.calls;
      r=await readCredentialGuide(f.project,service,environment,{vault:f.vault,humanPlane:f.humanPlane,baseDir:f.home});
      closed(r);assert.equal(r.stage,'stored');assert.equal(r.acquisition,null);assert.equal(r.registration.metadata,'settled');assert.ok(r.registration.revision);
      assert.equal(r.operationPlan.consumer,'unsupported');assert.equal(r.operationPlan.consumerAction,'review-standard-input-contract');
      assert.match(renderCredentialGuide(r),/再入力せず/);assert.match(renderCredentialGuide(r),/未実装/);
      assert.equal((await f.save(service,environment)).status,'already-registered');assert.equal(f.calls,calls);
      const inventory=await readConnectionInventory(f.project,{vault:f.vault,baseDir:f.home});assert.equal(inventory.schemaVersion,2);
      const row=inventory.slots.find(x=>x.service===service&&x.environment===environment);
      assert.equal(row.presence,'registered');assert.equal(row.nextStep,'review-consumer-contract');
      for(const name of readdirSync(f.home,{recursive:true}).filter(n=>String(n).endsWith('.json')))
        assert.ok(!readFileSync(join(f.home,String(name)),'utf8').includes(canary));
    }finally{f.close()}
  });
}
test('Stripe production fails before any vault or Human Plane effect',async()=>{
  let effects=0;const deny=new Proxy({}, {get(){effects++;throw Error(canary)}});const f=fixture();try{
    const r=await readCredentialGuide(f.project,'stripe-test','production',{vault:deny,humanPlane:deny,baseDir:f.home});
    assert.equal(r.status,'unsupported');closed(r);
    assert.equal((await runConnectionCredential(f.project,'production','save',{vault:deny,humanPlane:deny},false,'stripe-test')).status,'unavailable');
    assert.equal(effects,0);
  }finally{f.close()}
});
test('legacy registration is an explicit candidate, never copied or prompts duplicate input',async()=>{
  const f=fixture();try{
    const ref=f.ref('openai');await f.vault.setSecret({name:ref.name,scope:'project',projectId:ref.projectId},canary);
    const r=await f.guide('openai');closed(r);assert.equal(r.stage,'review-existing-registration');
    assert.equal(r.registration.presence,'missing');assert.equal(r.registration.legacyProject,'registered');assert.equal(r.registration.legacyUse,'none');
    assert.equal(await f.vault.hasSecret(ref),false);assert.equal(f.calls,0);
  }finally{f.close()}
});
test('user-scope registration is not borrowed into another project/environment',async()=>{
  const f=fixture();try{await f.vault.setSecret({name:'STRIPE_API_KEY',scope:'user',projectId:null},canary);
    const r=await f.guide('stripe-test','preview');closed(r);assert.equal(r.stage,'review-existing-registration');assert.equal(r.registration.legacyUser,'registered');
  }finally{f.close()}
});
test('a pending cancelled save never becomes missing or automatically asks again',async()=>{
  const f=fixture();try{f.setMode('cancel');assert.equal((await f.save('openai')).status,'cancelled');let probes=0;
    const r=await f.guide('openai','development',{vault:{hasSecret:async()=>{probes++;throw Error(canary)}}});
    closed(r);assert.equal(r.stage,'review-registration');assert.equal(r.registration.metadata,'pending');assert.equal(probes,0);assert.equal(f.calls,1);
  }finally{f.close()}
});
test('raw errors, absent metadata and unsupported input remain non-disclosing',async()=>{
  const f=fixture();try{
    let r=await f.guide('openai','development',{vault:{hasSecret:async()=>{throw Error(canary)}}});closed(r);assert.equal(r.status,'unavailable');
    await f.vault.setSecret(f.ref('openai'),canary);r=await f.guide('openai');closed(r);assert.equal(r.stage,'review-registration');assert.equal(r.registration.presence,'registered');
    r=await f.guide('stripe-test','development',{humanPlane:{capability:()=> 'handoff-only'}});closed(r);assert.equal(r.stage,'human-input-unavailable');
    f.setMode('throw');assert.equal((await f.save('stripe-test')).status,'unavailable');
  }finally{f.close()}
});
test('registration changes during a later awaited legacy probe invalidate the whole guide',async()=>{
  const f=fixture();try{await f.save('openai');let probes=0;
    const r=await f.guide('openai','development',{vault:{hasSecret:async ref=>{if(++probes===3){const begun=f.store.beginCredentialMutation(f.ref('openai'));assert.equal(begun.ok,true);assert.equal(f.store.finishCredentialMutation(f.ref('openai'),begun.value,true),true);}return f.vault.hasSecret(ref)}}});
    closed(r);assert.equal(r.status,'unavailable');assert.equal(r.registration.presence,'unavailable');assert.equal(r.stage,'review-registration');
  }finally{f.close()}
});
test('new storage profiles cannot fall through legacy deployment or existing Resend handoff',async()=>{
  const f=fixture();try{for(const service of ['openai','stripe-test']){
    await assert.rejects(runWithSecret(f.vault,f.ref(service),{}),SecretNotRegisteredError);
    assert.equal(await runConnectionDeployment({ref:f.ref(service),target:'cloudflare',force:false,execution:{},stillCurrent:async()=>true}),'changed');
  }}finally{f.close()}
});

test('a stored least-privilege key is not probed at an unrelated endpoint or treated as invalid',async()=>{
  const f=fixture();const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{"error":"scope_denied"}',{status:403})};
  try{await f.save('openai');const r=await f.guide('openai');closed(r);assert.equal(r.stage,'stored');assert.equal(calls,0);assert.equal(r.operationPlan.providerCheck,'not-run');
    const stripe=await f.guide('stripe-test','preview');assert.equal(stripe.providerMode,'test');assert.equal(stripe.environment,'preview');
  }finally{globalThis.fetch=previous;f.close()}
});

test('a selected Resend native route suppresses duplicate acquisition',async()=>{
  const f=fixture();try{assert.equal(f.store.saveIntent({service:'resend',environment:'preview',route:'provider-native',destination:{kind:'vercel'},sendingDomain:null}).ok,true);
    const r=await f.guide('resend','preview');closed(r);assert.equal(r.stage,'review-selected-native-route');assert.equal(r.acquisition,null);assert.equal(f.calls,0);
  }finally{f.close()}
});

test('Resend acquisition still requires the matching supported managed selection',async()=>{
  const f=fixture();try{
    for(const route of [null,'manual','api-key-case-managed']){
      if(route)assert.equal(f.store.saveIntent({service:'resend',environment:route==='manual'?'preview':'development',route,destination:{kind:route==='manual'?'manual':'cloudflare'},sendingDomain:null}).ok,true);
      const r=await f.guide('resend','preview');closed(r);assert.equal(r.stage,'review-connection-selection');assert.equal(r.acquisition,null);
    }
    assert.equal(f.store.saveIntent({service:'resend',environment:'preview',route:'api-key-case-managed',destination:{kind:'cloudflare'},sendingDomain:'mail.example.com'}).ok,true);
    const r=await f.guide('resend','preview');assert.equal(r.stage,'acquire-and-save');assert.ok(r.acquisition);
  }finally{f.close()}
});

for(const service of ['openai','stripe-test'])test(`${service}: normal next resumes recorded v2 instead of suggesting legacy input`,async()=>{
  const f=fixture();try{
    const ref=f.ref(service,'preview');writeFileSync(join(f.project,'app.ts'),`process.env.${ref.name};\n`);writeFileSync(join(f.project,'.gitignore'),'.env\n.env.*\n');
    await f.save(service,'preview');const calls=f.calls;
    for(const offline of [false,true]) {
      const r=await buildNextReport(f.project,{vault:f.vault,adapters:[],licensePlan:'free',registryBaseDir:f.home,connectionBaseDir:f.home,offline});
      assert.equal(r.schemaVersion,13);assert.deepEqual(r.nextActions.find(a=>a.kind==='review-provider-credential'),{actor:'agent',kind:'review-provider-credential',service,environments:['preview']});
      assert.ok(!r.nextActions.some(a=>(a.kind==='register-secret'||a.kind==='remove-secret')&&a.name===ref.name));
      assert.equal(r.setup.stage,'review-deployment');assert.equal(f.calls,calls);assert.ok(!JSON.stringify(r).includes(canary));
    }
    f.setMode('cancel');await f.save(service,'preview',true);
    const pending=await buildNextReport(f.project,{vault:f.vault,adapters:[],licensePlan:'free',registryBaseDir:f.home,connectionBaseDir:f.home,offline:true});
    assert.ok(pending.nextActions.some(a=>a.kind==='review-provider-credential'&&a.service===service));
    assert.ok(!pending.nextActions.some(a=>a.kind==='register-secret'&&a.name===ref.name));
  }finally{f.close()}
});
test('normal next observes v2 registration created during its last awaited legacy presence read',async()=>{
  const f=fixture();try{writeFileSync(join(f.project,'app.ts'),'process.env.OPENAI_API_KEY;\n');
    let calls=0;const vault={...f.vault,isAvailable:async()=>true,hasSecret:async ref=>{
      calls++;if(ref.scope==='user'&&ref.name==='OPENAI_API_KEY'){const begun=f.store.beginCredentialMutation(f.ref('openai','preview'));assert.equal(begun.ok,true);assert.equal(f.store.finishCredentialMutation(f.ref('openai','preview'),begun.value,false),true);}return false;
    }};
    const r=await buildNextReport(f.project,{vault,adapters:[],licensePlan:'free',registryBaseDir:f.home,connectionBaseDir:f.home,offline:true});
    assert.ok(calls>0);assert.ok(r.nextActions.some(a=>a.kind==='review-provider-credential'&&a.service==='openai'));
    assert.ok(!r.nextActions.some(a=>a.kind==='register-secret'&&a.name==='OPENAI_API_KEY'));
  }finally{f.close()}
});
