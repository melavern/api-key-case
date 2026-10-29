// One ordinary synthetic project; no native store, app execution or provider request.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildLocalNode } from '../tools/build-local-node.mjs';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { connectionCredentialRef, runConnectionCredential } from '../dist/core/agent/connection-credential.js';
import { MemoryVault } from '../dist/core/vault/memory.js';
import { saveLicenseKey } from '../dist/core/license.js';
import { runConnectionDeploy } from '../dist/core/deploy/engine.js';
import { inspectLocalApplication, readLocalApplicationStatus } from '../dist/core/local/session.js';
import { DeploymentHistory, buildHistoryReport } from '../dist/core/deploy/history.js';

export async function runConnectionJourneyTests() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'akc-connection-journey-')));
  try {
    const project=join(root,'ordinary app'), home=join(root,'home');
    for(const p of [project,home,join(project,'src'),join(project,'.git')])mkdirSync(p,{mode:0o700});
    writeFileSync(join(project,'package.json'),'{}');writeFileSync(join(project,'package-lock.json'),'{}');
    writeFileSync(join(project,'src','app.ts'),'export const configured = Boolean(process.env.RESEND_API_KEY);\n');
    writeFileSync(join(project,'.git','config'),'[remote "origin"]\nurl = https://github.com/owner/repository.git\n');
    const built=await buildLocalNode(project,'src/app.ts');assert.equal(built.status,'built');
    const originalArtifact=readFileSync(join(project,built.artifact));
    const store=new ConnectionStateStore(project,home),vault=new MemoryVault();
    const cli=fileURLToPath(new URL('../dist/cli/index.js',import.meta.url));
    let selections=0,dialogs=0,forbidden=0;
    const select=(environment,destination)=>{
      const child=spawnSync(process.execPath,[cli,'connection','set','--service','resend','--env',environment,'--route','api-key-case-managed','--destination',destination,project],{
        encoding:'utf8',timeout:30000,env:{...process.env,HOME:home,USERPROFILE:home,DO_NOT_TRACK:'1'}});
      // Functional CLI selection, not a startup-performance assertion.
      assert.equal(child.status,0,`Synthetic selection failed: error=${child.error?.code ?? 'none'} signal=${child.signal ?? 'none'}; ${child.stderr}`);selections++;
      const intent=store.readIntent();assert.equal(intent.status,'available');assert.equal(intent.value.environment,environment);assert.equal(intent.value.destination.kind,destination);
    };
    const human={capability:()=> 'os-dialog',askSecret:async ref=>{dialogs++;await vault.setSecret(ref,`synthetic-journey-${ref.environment}`);return 'saved';}};
    const readOnlyVault=new Proxy(vault,{get(target,property){if(property==='hasSecret')return target.hasSecret.bind(target);forbidden++;throw new Error('Unexpected mutating or value-returning vault capability');}});
    const forbiddenHuman=new Proxy({}, {get(){forbidden++;throw new Error('Check must not touch Human Plane');}});
    const check=environment=>runConnectionCredential(project,environment,'check',{vault:readOnlyVault,humanPlane:forbiddenHuman,connectionBaseDir:home});
    const save=environment=>runConnectionCredential(project,environment,'save',{vault,humanPlane:human,connectionBaseDir:home});
    const dev=connectionCredentialRef(realpathSync(project),'development');
    const prod=connectionCredentialRef(realpathSync(project),'production');
    select('development','local');assert.equal((await check('development')).status,'missing');
    assert.equal((await save('development')).status,'saved');const revision=store.credentialRevision(dev);assert.ok(revision);
    assert.equal((await check('development')).status,'registered');assert.equal(dialogs,1);assert.equal(forbidden,0);
    const localRequest={service:'resend',environment:'development',projectDir:project,artifact:built.artifact,maxDurationMs:60000};
    const inspection=await inspectLocalApplication({vault:readOnlyVault,connectionBaseDir:home},localRequest);
    assert.equal(inspection.status,'ready-for-review');assert.equal(inspection.permission,'none');assert.equal(inspection.applicationReadiness,'not-verified');
    const keys=generateKeyPairSync('ed25519');const payload=Buffer.from(JSON.stringify({v:1,plan:'pro',id:'synthetic-journey',issuedAt:'2026-10-03'})).toString('base64url');const signed=`AKC1.${payload}`;
    saveLicenseKey(`${signed}.${sign(null,Buffer.from(signed),keys.privateKey).toString('base64url')}`,home);
    const deploy=(environment)=>runConnectionDeploy({vault:readOnlyVault,humanPlane:forbiddenHuman,connectionBaseDir:home,historyBaseDir:home,licenseOptions:{baseDir:home,publicKey:keys.publicKey}},
      {service:'resend',environment,projectDir:project,force:false,dryRun:true});
    for(const destination of ['vercel','cloudflare','github']) {
      select('development',destination);assert.equal((await check('development')).status,'registered');
      const preview=await deploy('development');assert.equal(preview.status,'dry-run');assert.equal(preview.preview.target,destination);assert.equal(preview.preview.sourceEnvironment,'development');assert.equal(preview.preview.destinationEnvironment,'development');assert.equal(preview.preview.providerProbes,'not-run');assert.equal(preview.preview.permission,'none');
      assert.equal(store.credentialRevision(dev),revision);assert.equal(dialogs,1);assert.equal(forbidden,0);
      assert.equal((await inspectLocalApplication({vault:readOnlyVault,connectionBaseDir:home},localRequest)).status,'intent-mismatch');
    }
    select('production','github');assert.equal((await check('production')).status,'missing');assert.equal((await deploy('production')).status,'revision-unavailable');
    assert.equal((await save('production')).status,'saved');const productionRevision=store.credentialRevision(prod);assert.ok(productionRevision);assert.equal(dialogs,2);
    assert.equal((await deploy('production')).preview.sourceEnvironment,'production');assert.equal(store.credentialRevision(dev),revision);assert.equal((await check('preview')).status,'missing','other environment values never satisfy preview');
    select('development','local');assert.equal((await check('development')).status,'registered');assert.equal(store.credentialRevision(prod),productionRevision);assert.equal(dialogs,2);
    // Switching destinations cannot erase an interrupted local session or grant a retry.
    const started=store.beginLocalSession(revision,60000);assert.equal(started.ok,true);const receipt=JSON.stringify(store.readLocalSession());
    select('development','github');assert.equal((await deploy('development')).status,'dry-run');select('development','local');
    const rebuilt=await buildLocalNode(project,'src/app.ts');assert.equal(rebuilt.status,'built');assert.notEqual(rebuilt.artifact,built.artifact);
    assert.deepEqual(readFileSync(join(project,built.artifact)),originalArtifact);assert.equal(JSON.stringify(store.readLocalSession()),receipt);
    const status=readLocalApplicationStatus(project,home);assert.equal(status.status,'unknown');assert.equal(status.retry,'owner-review-required');assert.equal(status.permission,'none');assert.equal(store.localSessionLockStatus(),'present');
    // Advisory history remains readable without provider resolution or a fresh login.
    const history=new DeploymentHistory(project,home);const attempt=history.beginConnection({ref:dev,target:'github',destinationId:'a'.repeat(64),force:false,credentialRevision:revision,intentFingerprint:'b'.repeat(64)});assert.ok(attempt);
    const before=JSON.stringify(history.read());
    const report=await buildHistoryReport(project,{baseDir:home,offline:true,adapters:new Proxy(new Map(),{get(){forbidden++;throw new Error('Offline history must not resolve a provider');}})});
    assert.equal(report.entries[0].outcome,'unknown');assert.equal(report.entries[0].currentDestination,'unresolved');assert.equal(JSON.stringify(history.read()),before);assert.equal(forbidden,0);assert.equal(dialogs,2);
    // Backend errors stay closed; check does not substitute a write probe or ask for re-entry.
    const failure=await runConnectionCredential(project,'development','check',{vault:{hasSecret:async()=>{throw new Error('synthetic-private-diagnostic');}},humanPlane:forbiddenHuman});
    assert.equal(failure.status,'unavailable');assert.ok(!JSON.stringify(failure).includes('synthetic-private-diagnostic'));
    console.log(`Connection journey passed: ${selections} normal CLI selections, 2 separate synthetic environment saves, no app/provider/native execution.`);
  } finally {rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url))await runConnectionJourneyTests();
