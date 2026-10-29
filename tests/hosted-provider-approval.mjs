// Synthetic generated-script and fake-helper tests. No native UI, keyring or provider.
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { buildWindowsApprovalScript, WindowsHumanPlane, WINDOWS_POWERSHELL_PATH, encodeWindowsHelperCommand, WINDOWS_HELPER_COMMAND_MAX_CHARS } from '../dist/core/human/windows.js';
import { buildMacOSApprovalScript, MacOSHumanPlane, MACOS_OSASCRIPT_PATH } from '../dist/core/human/macos.js';
import { assertApprovalConnectionSource } from '../dist/core/deploy/types.js';
import { CloudflareAdapter } from '../dist/adapters/cloudflare.js';
import { VercelAdapter } from '../dist/adapters/vercel.js';
import { decodeWindowsHelperScript } from './windows-helper-command.mjs';

const revision='2026-10-07T01:02:03.456Z';
const canary='synthetic-untrusted-approval-text-QW71';
const builders=[buildWindowsApprovalScript,buildMacOSApprovalScript];
function planFor(service,env,target,force=false) {
  const name=service==='openai'?'OPENAI_API_KEY':service==='stripe-test'?'STRIPE_API_KEY':service==='clerk'?'CLERK_SECRET_KEY':'RESEND_API_KEY';
  const adapter=target==='cloudflare'?new CloudflareAdapter():new VercelAdapter();
  const planned=adapter.planDeploy(name,env,{force});
  return {name,scope:'project',projectId:'0123456789abcdef',target,env,force,
    projectDir:'/synthetic/日本語 project',destination:target==='cloudflare'?'Cloudflare worker synthetic-worker; account 0123456789abcdef0123456789abcdef':'Vercel project synthetic-project; org synthetic-org',
    cliPath:`/synthetic/bin/${target==='cloudflare'?'wrangler':'vercel'}`,command:planned.displayCommand,
    preCommands:planned.preSteps?.map(step=>step.displayCommand)??[],trustState:target==='cloudflare'||force||env!=='preview'?'always-approve':'first-use',
    connectionSource:{credentialVersion:2,service,environment:env,credentialRevision:revision}};
}

export async function runHostedProviderApprovalTests(){
  let checks=0;
  for(const service of ['openai','stripe-test'])for(const env of service==='openai'?['development','preview','production']:['development','preview'])for(const target of ['cloudflare','vercel']) {
    const plan=planFor(service,env,target),label=service==='openai'?'OpenAI':'Stripe test (provider mode: test)';
    assert.doesNotThrow(()=>assertApprovalConnectionSource(plan));
    const win=buildWindowsApprovalScript(plan),mac=buildMacOSApprovalScript(plan);new Script(mac);
    for(const script of [win,mac]) {
      assert.ok(script.includes(`v2 ${label} / ${env}`));assert.ok(script.includes(revision));
      assert.ok(script.includes(plan.name));assert.ok(script.includes(plan.projectDir));assert.ok(script.includes(plan.destination));
      assert.ok(script.includes(plan.command));assert.equal(script.includes('This secret put creates a Worker version and deploys it immediately.'),target==='cloudflare');
      assert.ok(!script.includes(canary));assert.ok(!script.includes('v2 Resend /'));
    }
    const verification=win.split('\n').find(line=>line.startsWith('$verificationMessage = '));
    assert.ok(verification.includes(`v2 ${label} source ${env} to ${target} (${env})`));
    assert.ok(win.includes('RequestVerificationForWindowAsyncDelegate'));assert.ok(win.includes('IsSupportedBuild(22000)'));
    assert.ok(win.includes('$form.AcceptButton = $noButton'));assert.ok(win.includes('$form.CancelButton = $noButton'));
    assert.ok(win.includes('default { $script:resultCode = 10 }'));assert.equal((win.match(/\$script:resultCode = 0/g)??[]).length,1);
    assert.ok(win.includes('0 { $script:resultCode = 0 }'));assert.ok(win.includes('6 { $script:resultCode = 2 }'));
    assert.ok(win.includes('$details.ReadOnly = $true'));assert.ok(win.includes('$details.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical'));
    assert.ok(mac.includes("noButton.keyEquivalent = '\\r';"));assert.ok(mac.includes('alert.window.initialFirstResponder = noButton;'));
    assert.ok(mac.includes('$.exit(Number(response) === Number($.NSAlertSecondButtonReturn) ? 0 : 2);'));
    const encoded=encodeWindowsHelperCommand(win);assert.ok(encoded.length<WINDOWS_HELPER_COMMAND_MAX_CHARS);assert.equal(decodeWindowsHelperScript(encoded),win);
    for(const [Plane,helper,decode] of [[WindowsHumanPlane,WINDOWS_POWERSHELL_PATH,request=>decodeWindowsHelperScript(request.args.at(-1))],[MacOSHumanPlane,MACOS_OSASCRIPT_PATH,request=>request.args.at(-1)]]) {
      for(const [exit,expected] of [[0,'approved'],[2,'declined'],[10,'unavailable'],[null,'unavailable'],[99,'unavailable']]) {
        const requests=[];const plane=new Plane(helper,async request=>{requests.push(request);return exit});
        assert.equal(await plane.askApproval(plan),expected);assert.equal(requests.length,1);
        assert.equal(requests[0].stdio,'ignore');assert.equal(requests[0].shell,false);assert.equal(requests[0].detached,false);
        assert.equal(decode(requests[0]),Plane===WindowsHumanPlane?win:mac);checks++;
      }
    }
    checks++;
  }
  for(const service of ['openai','stripe-test']) {
    const plan=planFor(service,'preview','vercel',true);
    assert.ok(plan.preCommands.length>0);
    for(const build of builders){const script=build(plan);for(const command of plan.preCommands)assert.ok(script.includes(command));checks++;}
    for(const bad of [
      {...plan,name:'UNRELATED_KEY'}, {...plan,scope:'user',projectId:null},
      {...plan,target:'github'}, {...plan,target:'local'}, {...plan,target:'manual'},
      {...plan,connectionSource:null}, {...plan,connectionSource:[]},
      {...plan,connectionSource:{...plan.connectionSource,service:canary}},
      {...plan,connectionSource:{...plan.connectionSource,credentialVersion:1}},
      {...plan,connectionSource:{...plan.connectionSource,environment:'development'}},
      {...plan,connectionSource:{...plan.connectionSource,credentialRevision:canary}},
      {...plan,connectionSource:{...plan.connectionSource,credentialRevision:'2026-02-30T01:02:03.456Z'}},
      {...plan,connectionSource:{...plan.connectionSource,providerMode:'live'}},
      {...plan,connectionSource:{...plan.connectionSource,operation:'cloudflare-version-preparation'}},
      {...plan,connectionSource:{...plan.connectionSource,url:`https://${canary}.invalid/`}},
    ]) {
      for(const build of builders){assert.throws(()=>build(bad),error=>!String(error).includes(canary));checks++;}
      for(const [Plane,helper] of [[WindowsHumanPlane,WINDOWS_POWERSHELL_PATH],[MacOSHumanPlane,MACOS_OSASCRIPT_PATH]]) {
        let calls=0;const plane=new Plane(helper,async()=>{calls++;return 0});
        await assert.rejects(()=>plane.askApproval(bad));assert.equal(calls,0);checks++;
      }
    }
  }
  for(const build of builders) {
    assert.throws(()=>build(planFor('stripe-test','production','cloudflare')));checks++;
    const legacy={...planFor('resend','preview','cloudflare')};delete legacy.connectionSource;
    assert.ok(build(legacy).includes('This secret put creates a Worker version and deploys it immediately.'));checks++;
    const clerk={...planFor('clerk','preview','cloudflare'),command:'wrangler versions secret put CLERK_SECRET_KEY --env preview',connectionSource:{credentialVersion:2,service:'clerk',environment:'preview',credentialRevision:revision,operation:'cloudflare-version-preparation'}};
    const script=build(clerk);assert.ok(script.includes('v2 Clerk'));assert.ok(script.includes('Version URLs'));assert.ok(script.includes('does not activate production traffic'));assert.ok(!script.includes('deploys it immediately'));checks++;
  }
  console.log(`hosted provider approval: ${checks} generated-script/fake-helper checks passed; native acceptance not run`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runHostedProviderApprovalTests();
