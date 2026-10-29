// Acquisition display context is not a credential, verification receipt or resume token.
// Memory store and fake Human Plane only; no native dialogs or network calls.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemoryVault } from '../dist/core/vault/memory.js';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { connectionCredentialRef, runConnectionCredential } from '../dist/core/agent/connection-credential.js';
import { buildNextReport } from '../dist/core/agent/next.js';

export async function runGuidedAcquisitionLifecycleTests() {
  const root=mkdtempSync(join(tmpdir(),'akc-guided-lifecycle-'));
  try {
    const project=join(root,'project'), home=join(root,'state');mkdirSync(project);mkdirSync(home);
    writeFileSync(join(project,'app.ts'),'process.env.RESEND_API_KEY;\n');
    writeFileSync(join(project,'.gitignore'),'.env\n.env.*\n');
    const vault=new MemoryVault(), store=new ConnectionStateStore(project,home);
    const canary='synthetic-guided-lifecycle-only'; let calls=0, mode='save';
    const humanPlane={capability:()=> 'os-dialog', askSecret:async request=> {
      calls++;
      assert.equal(request.service,'resend');
      assert.deepEqual(request.acquisition,{sendingDomain:'mail.example.com',destination:'cloudflare'});
      assert.ok(!JSON.stringify(request).includes(canary));
      if(mode==='throw') throw new Error(canary);
      if(mode==='save') await vault.setSecret(request,canary);
      return mode==='cancel'?'cancelled':'saved';
    }};
    const deps={vault,humanPlane,connectionBaseDir:home};
    for(const environment of ['development','preview','production']) {
      assert.ok(store.saveIntent({service:'resend',environment,route:'api-key-case-managed',destination:{kind:'cloudflare'},sendingDomain:'mail.example.com'}).ok);
      const ref=connectionCredentialRef(project,environment);
      const result=await runConnectionCredential(project,environment,'save',deps);
      assert.deepEqual(result,{service:'resend',environment,status:'saved'});
      assert.ok(store.credentialRevision(ref));
      // Simulate a fresh Agent/terminal constructing the metadata store again.
      const fresh=new ConnectionStateStore(project,home);
      assert.equal(fresh.readIntent().value.environment,environment);
      assert.equal((await runConnectionCredential(project,environment,'check',deps)).status,'registered');
      const before=calls;
      assert.equal((await runConnectionCredential(project,environment,'save',deps)).status,'already-registered');
      assert.equal(calls,before,'resume must not ask for the same key again');
      const report=await buildNextReport(project,{vault,adapters:[],licensePlan:'free',registryBaseDir:home,connectionBaseDir:home});
      assert.equal(report.guidedSetup.stage,'stored');
      assert.equal(report.connection.report.credential.status,'registered');
      assert.notEqual(report.connection.report.providerCheck.status,'passed','storage cannot prove provider verification');
      assert.ok(!JSON.stringify(report).includes(canary));
    }
    // Existing preview slot: overwrite cancellation cannot become a fresh success receipt.
    assert.ok(store.saveIntent({service:'resend',environment:'preview',route:'api-key-case-managed',destination:{kind:'cloudflare'},sendingDomain:'mail.example.com'}).ok);
    const preview=connectionCredentialRef(project,'preview'), production=connectionCredentialRef(project,'production');
    const productionRevision=store.credentialRevision(production);
    mode='cancel';
    assert.equal((await runConnectionCredential(project,'preview','save',deps,true)).status,'cancelled');
    assert.equal(await vault.hasSecret(preview),true);assert.equal(store.credentialRevision(preview),null);
    assert.equal(store.credentialRevision(production),productionRevision);
    // A helper status without an actual store write remains unavailable.
    await vault.deleteSecret(preview); mode='pretend';
    assert.equal((await runConnectionCredential(project,'preview','save',deps)).status,'unavailable');
    assert.equal(store.credentialRevision(preview),null);
    mode='throw';
    const failure=await runConnectionCredential(project,'preview','save',deps);
    assert.deepEqual(failure,{service:'resend',environment:'preview',status:'unavailable'});
    assert.ok(!JSON.stringify(failure).includes(canary));
    // Only closed metadata goes to disk. The fake vault keeps its synthetic value in memory.
    for(const path of readdirSync(home,{recursive:true})) {
      if(String(path).endsWith('.json')) assert.ok(!readFileSync(join(home,String(path)),'utf8').includes(canary));
    }
  } finally {rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  await runGuidedAcquisitionLifecycleTests();console.log('guided acquisition lifecycle fixtures passed');
}
