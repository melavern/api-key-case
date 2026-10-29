import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ConnectionStateStore } from "../dist/core/agent/connection-state.js";
import { connectionCredentialRef, runConnectionCredential } from "../dist/core/agent/connection-credential.js";
import { checkResendConnection } from "../dist/core/agent/connection-check.js";
import { buildNextReport } from "../dist/core/agent/next.js";
import { KeyringVault } from "../dist/core/vault/keyring.js";
import { runWithSecret, SecretNotRegisteredError } from "../dist/core/deploy/handoff.js";
import { MemoryVault } from "../dist/core/vault/memory.js";
import { canonicalProjectRealpath, toAccount } from "../dist/core/vault/naming.js";
import { resolveCli } from "../dist/core/deploy/which.js";

export async function runEnvironmentCredentialTests() {
  const root = mkdtempSync(join(tmpdir(), "akc-env-tests-"));
  try {
    const project = join(root, "project"), home = join(root, "home");
    for (const path of [project, home]) mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(project, "app.ts"), "process.env.RESEND_API_KEY;\n");
    writeFileSync(join(project, ".gitignore"), ".env\n.env.*\n!.env.example\n");
    const vault = new MemoryVault(), store = new ConnectionStateStore(project, home);
    const refs = Object.fromEntries(["development", "preview", "production"].map(env => [env, connectionCredentialRef(project, env)]));
    await assert.rejects(runWithSecret(vault, refs.production, {}), SecretNotRegisteredError);
    if (process.env.AGENT_KEY_CASE_E2E === "1") {
      const realVault = new KeyringVault();
      const available = await realVault.isAvailable();
      if (process.env.AGENT_KEY_CASE_E2E_STRICT === "1") assert.equal(available, true, "real keyring required");
      if (available) {
        try {
          for (const [env, ref] of Object.entries(refs)) await realVault.setSecret(ref, `synthetic-env-e2e-${env}`);
          for (const ref of Object.values(refs)) assert.equal(await realVault.hasSecret(ref), true);
          assert.equal(await realVault.deleteSecret(refs.preview), true);
          assert.equal(await realVault.hasSecret(refs.preview), false);
          assert.equal(await realVault.hasSecret(refs.development), true);
          assert.equal(await realVault.hasSecret(refs.production), true);
        } finally { for (const ref of Object.values(refs)) await realVault.deleteSecret(ref); }
      }
    }
    for (const args of [
      ["save", "--service", "resend"],
      ["save", "--service", "resend", "--env", "staging"],
      ["remove", "--service", "resend", "--env", "production", "--force"],
      ["save", "--service", "resend", "--env", "production", "--scope", "user"],
      ["save", "--service", "resend", "--env", "production", "--value", "synthetic-argument-canary"]
    ]) {
      try { execFileSync(process.execPath, [fileURLToPath(new URL('../dist/cli/index.js',import.meta.url)),"connection","credential",...args],{encoding:"utf8",stdio:"pipe"});assert.fail("CLI must reject invalid identity/value input"); }
      catch(error) { assert.equal(error.status,1);assert.ok(!String(error.stderr).includes("synthetic-argument-canary")); }
    }
    const legacy = { name: "RESEND_API_KEY", scope: "project", projectId: refs.development.projectId };
    await vault.setSecret(legacy, "synthetic-legacy-env-canary");
    assert.equal(new Set([legacy, ...Object.values(refs)].map(toAccount)).size, 4);
    assert.equal(toAccount(legacy), `v1|project|${legacy.projectId}|RESEND_API_KEY`);
    for (const [env, ref] of Object.entries(refs)) assert.equal(toAccount(ref), `v2|credential|project|${legacy.projectId}|resend|${env}|RESEND_API_KEY`);
    // A stale early absence must never bypass the overwrite precondition.
    const raceProject=join(root,"race-project");mkdirSync(raceProject);
    const raceRef=connectionCredentialRef(raceProject,"development"),raceVault=new MemoryVault();
    const actualPresence=raceVault.hasSecret.bind(raceVault);let probes=0,raceDialogs=0;
    raceVault.hasSecret=async ref=>{
      if(++probes===1) { await raceVault.setSecret(raceRef,"synthetic-concurrent-save");return false; }
      return actualPresence(ref);
    };
    const raceResult=await runConnectionCredential(raceProject,"development","save",{
      vault:raceVault,connectionBaseDir:home,humanPlane:{capability:()=>"os-dialog",askSecret:async()=>{raceDialogs++;return "saved";}}
    });
    assert.equal(raceResult.status,"already-registered");assert.equal(raceDialogs,0);
    assert.equal(await actualPresence(raceRef),true);
    let dialog = 0, decision = "approved", save = "saved", duringSave = null;
    const deps = { vault, connectionBaseDir: home, humanPlane: {
      capability: () => "os-dialog",
      askSecret: async request => {
        dialog++;
        assert.equal(store.credentialRevision(request), null, "pending mutation is not verifiable");
        if (duringSave) await duringSave(request);
        if (save === "saved") await vault.setSecret(request, `synthetic-${request.environment}-env-canary`);
        return save;
      },
      askRemoval: async plan => { dialog++; assert.equal(plan.service, "resend"); assert.ok(refs[plan.environment]); return decision; }
    }};
    const run = (env, operation, force = false) => runConnectionCredential(project, env, operation, deps, force);
    const select = environment => assert.equal(store.saveIntent({service:"resend", environment, route:"api-key-case-managed", destination:{kind:"local"}, sendingDomain:null}).ok, true);
    const inspect = () => buildNextReport(project, {vault, adapters:[], licensePlan:"free", registryBaseDir:home, connectionBaseDir:home});
    const cli = resolveCli("node", dirname(process.execPath)); assert.ok(cli);
    let checks = 0;
    const checkDeps = {vault, connectionBaseDir:home, resolveCli:()=>cli, validate:async input => {
      checks++; assert.equal(input.ref.environment, store.readIntent().value.environment); assert.equal(await input.stillCurrent(), true); return "valid-sending-access";
    }};
    select("development");
    assert.deepEqual((await inspect()).connection.report.credential, {source:"legacy-unscoped",status:"missing"});
    assert.equal((await checkResendConnection(project, checkDeps)).status,"unknown");assert.equal(checks,0,"never fall back to legacy");
    for (const env of Object.keys(refs)) {
      assert.equal((await run(env,"check")).status,"missing");
      assert.equal((await run(env,"save")).status,"saved");
      assert.equal((await run(env,"check")).status,"registered");
      select(env);
      assert.deepEqual(await checkResendConnection(project,{...checkDeps,expectedEnvironment:env}), {service:"resend",status:"valid",resultCode:"valid-sending-access",recorded:true,environment:env});
      assert.equal((await inspect()).connection.report.providerCheck.status,"passed");
      assert.deepEqual((await inspect()).connection.report.credential,{source:"api-key-case",status:"registered"});
    }
    assert.equal(dialog,3);
    assert.equal(await vault.hasSecret(legacy),true,"legacy value is neither read nor migrated nor removed");
    assert.equal(existsSync(join(home,".api-key-case","index.json")),false,"v1 index untouched");
    assert.equal((await run("development","save")).status,"already-registered"); assert.equal(dialog,3);
    const productionRevision = store.credentialRevision(refs.production);
    assert.equal((await run("development","save",true)).status,"saved");
    select("development");assert.equal((await inspect()).connection.report.providerCheck.status,"stale");
    select("production");assert.equal((await inspect()).connection.report.providerCheck.status,"passed");
    assert.equal(store.credentialRevision(refs.production),productionRevision);
    select("preview");decision="declined";
    assert.equal((await run("preview","remove")).status,"cancelled");assert.equal(await vault.hasSecret(refs.preview),true);
    assert.equal((await inspect()).connection.report.providerCheck.status,"unknown","cancelled mutation is conservatively unverified");
    decision="approved";assert.equal((await run("preview","remove")).status,"removed");
    assert.equal((await inspect()).connection.report.providerCheck.status,"stale");
    assert.equal(await vault.hasSecret(refs.development),true);assert.equal(await vault.hasSecret(refs.production),true);
    assert.equal(await vault.hasSecret(legacy),true);
    assert.equal((await run("preview","save")).status,"saved");
    assert.equal((await checkResendConnection(project,checkDeps)).status,"valid");
    duringSave = async request => {
      assert.equal((await run(request.environment,"save",true)).status,"metadata-unavailable","same-slot mutations serialized");
      assert.equal((await checkResendConnection(project,{...checkDeps,expectedEnvironment:request.environment})).status,"unknown","pending cannot read credential");
    };
    assert.equal((await run("preview","save",true)).status,"saved");duringSave=null;
    select("production");
    const serialized = JSON.stringify(await inspect());
    assert.ok(!serialized.includes("env-canary"));
    const child = execFileSync(process.execPath,["--input-type=module","-e",`
      import {ConnectionStateStore} from ${JSON.stringify(new URL('../dist/core/agent/connection-state.js',import.meta.url).href)};
      const s=new ConnectionStateStore(${JSON.stringify(project)},${JSON.stringify(home)});
      console.log(JSON.stringify({revision:s.credentialRevision(${JSON.stringify(refs.production)}),observations:s.readObservations().value.length,intent:s.readIntent().value.environment}));
    `],{encoding:"utf8"});
    assert.deepEqual(JSON.parse(child),{revision:productionRevision,observations:store.readObservations().value.length,intent:"production"});
    const dir = join(home,".api-key-case","connections",createHash("sha256").update(canonicalProjectRealpath(project)).digest("hex"));
    const file=join(dir,"credential-production.json");const raw=readFileSync(file,"utf8");
    assert.ok(!raw.includes("canary"));assert.deepEqual(Object.keys(JSON.parse(raw).credential).sort(),["name","scope","projectId","service","environment","createdAt","updatedAt","state"].sort());
    writeFileSync(file,"{}");assert.equal(store.credentialRevision(refs.production),null);
    assert.equal((await checkResendConnection(project,checkDeps)).status,"unknown");
    assert.equal((await run("production","save",true)).status,"metadata-unavailable");
    writeFileSync(file,raw);if(process.platform!=="win32")chmodSync(file,0o600);
    const before=dialog;
    assert.equal((await runConnectionCredential(project,"production","save",{...deps,humanPlane:{capability:()=>"handoff-only"}},true)).status,"unavailable");
    assert.equal(dialog,before);
    // Finish failure must leave the successful OS write unknown, never preserve a prior pass.
    duringSave=async()=>mkdirSync(join(dir,"lock"),{mode:0o700});
    assert.equal((await run("production","save",true)).status,"metadata-unavailable");
    rmSync(join(dir,"lock"),{recursive:true});duringSave=null;
    assert.equal(store.credentialRevision(refs.production),null);
    assert.equal((await inspect()).connection.report.providerCheck.status,"unknown");
    assert.equal((await run("production","save",true)).status,"saved","explicit re-entry recovers pending metadata");
    const interrupted=store.beginCredentialMutation(refs.production);assert.equal(interrupted.ok,true);
    assert.equal(new ConnectionStateStore(project,home).credentialRevision(refs.production),null);
    assert.equal(new ConnectionStateStore(project,home).beginCredentialMutation(refs.production).ok,false,"crash lock never auto-cleared");
    assert.equal(store.finishCredentialMutation(refs.production,interrupted.value,false),true);
    if(process.platform!=="win32") {
      const original=readFileSync(file,"utf8");const outside=join(root,"outside.json");writeFileSync(outside,original,{mode:0o600});rmSync(file);symlinkSync(outside,file);
      assert.equal(store.credentialRevision(refs.production),null);
      assert.equal((await run("production","save",true)).status,"metadata-unavailable");
      assert.equal(readFileSync(outside,"utf8"),original);
    }
    console.log("Environment credential isolation, legacy compatibility, lifecycle, interruption and process-resume tests passed");
  } finally { rmSync(root,{recursive:true,force:true}); }
}
if(process.argv[1]===fileURLToPath(import.meta.url)) await runEnvironmentCredentialTests();
