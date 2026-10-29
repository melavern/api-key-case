// No GUI, browser, provider call or real store. Exact-slot metadata and generated helpers.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { buildResendAcquisitionPanel, RESEND_ACQUISITION_URL } from '../dist/core/human/acquisition.js';
import { buildWindowsSecretInputScript } from '../dist/core/human/windows.js';
import { buildMacOSSecretInputScript } from '../dist/core/human/macos.js';
import { runConnectionCredential } from '../dist/core/agent/connection-credential.js';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { MemoryVault } from '../dist/core/vault/memory.js';
const ref = {name:'RESEND_API_KEY', scope:'project', projectId:'0123456789abcdef', projectDir:'/synthetic/日本語 project', service:'resend'};
export async function runGuidedAcquisitionTests() {
  for (const environment of ['development','preview','production']) {
    const request = {...ref,environment,acquisition:{sendingDomain:'mail.example.com',destination:'cloudflare'}};
    const panel = buildResendAcquisitionPanel(request);
    assert.ok(panel.steps.some(step => step.en.includes(`akc-${ref.projectId}-${environment}`)));
    assert.ok(panel.steps.some(step => step.en.includes('mail.example.com')));
    assert.ok(panel.afterSave.en.includes('only registration is complete'));
    for (const build of [buildWindowsSecretInputScript, buildMacOSSecretInputScript]) {
      const script = build(request);
      assert.ok(script.includes(RESEND_ACQUISITION_URL));
      assert.ok(script.includes('Sending access'));
      assert.ok(script.includes(`v2|credential|project|${ref.projectId}|resend|${environment}|RESEND_API_KEY`));
      assert.ok(!script.includes('Start-Process $'));
      assert.ok(!script.includes('https://mail.example.com'));
    }
    new Script(buildMacOSSecretInputScript(request));
    const win = buildWindowsSecretInputScript(request);
    assert.ok(win.includes('$input.UseSystemPasswordChar = $true'));
    assert.ok(win.includes('SetThreadDpiAwarenessContext([IntPtr](-4))'));
    assert.ok(win.includes('$scroll.AutoScroll = $true'));
    assert.ok(win.includes('$work.Height'));
  }
  assert.equal(buildResendAcquisitionPanel({...ref, service:'clerk',name:'CLERK_SECRET_KEY',environment:'development'}),null);
  const legacy = {...ref}; delete legacy.service;
  assert.equal(buildResendAcquisitionPanel(legacy),null);
  assert.ok(!buildWindowsSecretInputScript(legacy).includes(RESEND_ACQUISITION_URL));
  for (const acquisition of [null,[],{sendingDomain:'x.example.com',destination:'manual'},
    {sendingDomain:'https://attacker.example.com',destination:'vercel'},
    {sendingDomain:'mail.example.com',destination:'vercel',url:'https://attacker.example.com'},
    {sendingDomain:"x'; exit 0; #.com",destination:'vercel'}]) {
    for (const build of [buildWindowsSecretInputScript,buildMacOSSecretInputScript])
      assert.throws(()=>build({...ref,environment:'development',acquisition}));
  }
  assert.throws(()=>buildWindowsSecretInputScript({...ref,environment:'production',acquisition:{sendingDomain:null,destination:'local'}}));
  const root = mkdtempSync(join(tmpdir(),'akc-acquisition-'));
  try {
    const project=join(root,'project'), home=join(root,'home'); mkdirSync(project); mkdirSync(home);
    const store=new ConnectionStateStore(project,home), vault=new MemoryVault(); let shown;
    const deps={vault,connectionBaseDir:home,humanPlane:{capability:()=> 'os-dialog', askSecret:async request=>{shown=request;return 'cancelled';}}};
    assert.ok(store.saveIntent({service:'resend',environment:'preview',route:'api-key-case-managed',destination:{kind:'vercel'},sendingDomain:'mail.example.com'}).ok);
    assert.equal((await runConnectionCredential(project,'preview','save',deps)).status,'cancelled');
    assert.deepEqual(shown.acquisition,{sendingDomain:'mail.example.com',destination:'vercel'});
    const result=await runConnectionCredential(project,'development','save',deps);
    assert.equal(result.status,'cancelled'); assert.equal(shown.acquisition,undefined,'other environment must not borrow context');
    assert.ok(!JSON.stringify(result).includes('mail.example.com'));
    assert.ok(store.saveIntent({service:'resend',environment:'preview',route:'provider-native',destination:{kind:'vercel'},sendingDomain:'mail.example.com'}).ok);
    await runConnectionCredential(project,'preview','save',deps);
    assert.equal(shown.acquisition,undefined,'provider-native must not be rewritten as managed');
    assert.ok(store.saveIntent({service:'resend',environment:'production',route:'api-key-case-managed',destination:{kind:'local'},sendingDomain:null}).ok);
    assert.equal((await runConnectionCredential(project,'production','save',deps)).status,'cancelled');
    assert.equal(shown.acquisition,undefined,'unsupported local route must preserve storage without claiming runtime support');
  } finally {rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  await runGuidedAcquisitionTests(); console.log('guided acquisition fixtures passed');
}
