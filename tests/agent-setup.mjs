import { buildConnectionPlan, APPLICATION_OBSERVATION_VERSION } from "../dist/core/agent/connection-plan.js";
import { connectionCredentialRef, runConnectionCredential } from "../dist/core/agent/connection-credential.js";
import assert from "node:assert/strict";
import { cpSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectHostReadiness, inspectTargetReadiness } from "../dist/core/agent/readiness.js";
import { buildNextReport } from "../dist/core/agent/next.js";
import { ConnectionStateStore, deriveConnectionId } from "../dist/core/agent/connection-state.js";
import { connectionIntentFingerprint, resendSourceFingerprint, applicationSourceFingerprint } from "../dist/core/agent/fingerprints.js";
import { DeploymentHistory } from "../dist/core/deploy/history.js";
import { initializeAgentInstructions, renderAgentProtocol } from "../dist/core/agent/init.js";
import { askAndRecordSecret } from "../dist/core/human/index.js";
import { renderTextReport } from "../dist/core/report.js";
import { scanProject } from "../dist/core/scanner.js";
import { MemoryVault } from "../dist/core/vault/memory.js";
import { deriveProjectId, toAccount } from "../dist/core/vault/naming.js";
import { upsertRegistryEntry } from "../dist/core/vault/registry.js";
import { SecretStoreMetadataError } from "../dist/core/vault/types.js";

const cliPath = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const testHost = () => inspectHostReadiness({ platform: "win32", osRelease: "10.0.26200", helperAvailable: true });

export async function runAgentSetupTests({ guidedOnly = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "akc-agent-setup-"));
  try {
    if (guidedOnly) { await testResendGuidedSetup(root); return; }
    testHostConditions();
    testConnectionStateStorage(root);
    await testFreePreflightAndSetup(root);
    await testExistingEnvOnboarding(root);
    await testResendGuidedSetup(root);
    await testApplicationObservationInvalidation(root);
    await testU5MeaningAndResumption(root);
    testFreshHostInstructions(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testConnectionStateStorage(root) {
  const project = join(root, "connection-state-project");
  const home = join(root, "connection-state-home");
  mkdirSync(project);
  mkdirSync(home);
  const store = new ConnectionStateStore(project, home);
  const intentInput = {
    service: "resend", environment: "development", route: "api-key-case-managed",
    destination: { kind: "local" }, sendingDomain: null
  };
  const saved = store.saveIntent(intentInput);
  assert.equal(saved.ok, true);
  assert.equal(saved.value.id, deriveConnectionId(project, "development"));
  assert.notEqual(saved.value.id, deriveConnectionId(project, "production"));
  assert.deepEqual(store.readIntent(), { status: "available", issue: null, value: saved.value });
  assert.deepEqual(store.readObservations(), { status: "missing", issue: "not-created", value: null });

  // Older releases could create ~/.api-key-case with the process umask
  // (commonly 0755). A new connection write may tighten that ordinary
  // directory, but it must not relax the symlink/special-path boundary.
  const legacyHome = join(root, "connection-state-legacy-home");
  const legacyAppDir = join(legacyHome, ".api-key-case");
  mkdirSync(legacyAppDir, { recursive: true, mode: 0o755 });
  if (process.platform !== "win32") chmodSync(legacyAppDir, 0o755);
  writeFileSync(join(legacyAppDir, "index.json"), JSON.stringify({ version: 1, entries: [] }), { mode: 0o600 });
  const legacyStore = new ConnectionStateStore(project, legacyHome);
  assert.deepEqual(
    legacyStore.readIntent(),
    { status: "missing", issue: "not-created", value: null },
    "a legacy metadata home with no connection subtree is still a normal first-run state"
  );
  const legacySaved = legacyStore.saveIntent(intentInput);
  assert.equal(legacySaved.ok, true, "a safe legacy metadata directory is tightened instead of rejected");
  if (process.platform !== "win32") {
    assert.equal(lstatSync(legacyAppDir).mode & 0o777, 0o700);
  }

  const connectionsDir = join(home, ".api-key-case", "connections");
  const projectStateDir = join(connectionsDir, readdirSync(connectionsDir)[0]);
  const statePath = join(projectStateDir, "state.json");
  if (process.platform !== "win32") {
    assert.equal(lstatSync(projectStateDir).mode & 0o777, 0o700);
    assert.equal(lstatSync(statePath).mode & 0o777, 0o600);
  }
  const originalState = readFileSync(statePath, "utf8");
  const tampered = JSON.parse(originalState);
  tampered.intent.secretValue = "connection-secret-canary";
  writeFileSync(statePath, JSON.stringify(tampered));
  if (process.platform !== "win32") chmodSync(statePath, 0o600);
  assert.deepEqual(store.readIntent(), { status: "unavailable", issue: "invalid-data", value: null });
  writeFileSync(statePath, originalState);
  if (process.platform !== "win32") chmodSync(statePath, 0o600);

  const started = store.beginObservation({
    kind: "credential-validation", authority: "provider-observed",
    basis: {
      credentialRevision: "2026-10-01T00:00:00.000Z", destinationFingerprint: null,
      intentFingerprint: null, sourceFingerprint: null, verifierVersion: "resend-credential-validation-v1"
    }
  });
  assert.equal(started.ok, true);
  assert.equal(started.value.outcome, "unknown", "a persisted start never fabricates a result");
  const afterStart = store.readObservations();
  assert.equal(afterStart.status, "available");
  assert.equal(afterStart.value[0].finishedAt, null);
  const finished = store.finishObservation(started.value.id, "completed", "valid-sending-access");
  assert.equal(finished.ok, true);
  assert.deepEqual(finished.value, { ...started.value, outcome: "completed", resultCode: "valid-sending-access", finishedAt: finished.value.finishedAt });
  assert.equal(store.finishObservation(started.value.id, "failed", "valid-sending-access").ok, false,
    "a result code cannot contradict its outcome");
  assert.equal(JSON.stringify(store.readObservations()).includes("connection-secret-canary"), false);

  const nextEnvironment = store.saveIntent({ ...intentInput, environment: "preview" });
  assert.equal(nextEnvironment.ok, true);
  assert.notEqual(nextEnvironment.value.id, saved.value.id, "environment is part of connection identity");
  assert.equal(store.readObservations().value[0].connectionId, saved.value.id,
    "receipts stay bound to their original connection identity");

  if (process.platform !== "win32") {
    const linkProject = join(root, "connection-state-link-project");
    mkdirSync(linkProject);
    const linkStore = new ConnectionStateStore(linkProject, home);
    const beforeHashes = new Set(readdirSync(connectionsDir));
    const linkSave = linkStore.saveIntent(intentInput);
    assert.equal(linkSave.ok, true);
    const linkHash = readdirSync(connectionsDir).find((name) => !beforeHashes.has(name));
    assert.ok(linkHash);
    const linkStateDir = join(connectionsDir, linkHash);
    const linkStatePath = join(connectionsDir, linkHash, "state.json");
    assert.ok(existsSync(linkStateDir));
    rmSync(linkStatePath);
    const outside = join(home, "outside-state.json");
    writeFileSync(outside, "{}");
    chmodSync(outside, 0o600);
    symlinkSync(outside, linkStatePath);
    assert.deepEqual(linkStore.readIntent(), { status: "unavailable", issue: "unsafe-path", value: null });
  }
}

async function testApplicationObservationInvalidation(root) {
  const project = join(root, "application-observation-invalidation");
  mkdirSync(project);
  writeFileSync(join(project, ".gitignore"), ".env\n.env.*\n!.env.example\n");
  const sourcePath = join(project, "app.ts");
  const originalSource = [
    "const client = new Resend(process.env.RESEND_API_KEY);",
    "export async function send() { return client.emails.send(process.env.RESEND_API_KEY); }",
    ""
  ].join("\n");
  writeFileSync(sourcePath, originalSource);

  const vault = new MemoryVault();
  const ref = connectionCredentialRef(project, "development");
  const store = new ConnectionStateStore(project, root);
  const registryEntry = { ...ref, projectPath: project };
  const saveCredential = async (value) => {
    await vault.setSecret(ref, value);
    const begun = store.beginCredentialMutation(ref); assert.equal(begun.ok, true);
    assert.equal(store.finishCredentialMutation(ref, begun.value, true), true);
  };
  await saveCredential("synthetic-first-credential");

  const saveManagedIntent = () => store.saveIntent({
    service: "resend", environment: "development", route: "api-key-case-managed",
    destination: { kind: "vercel" }, sendingDomain: null
  });
  assert.equal(saveManagedIntent().ok, true);

  const deps = {
    vault, adapters: [], licensePlan: "free", registryBaseDir: root,
    connectionBaseDir: root, hostReadiness: testHost(),
    connectionDestinationResolver: async intent => ({ target: intent.destination.kind, env: intent.environment, projectDir: realpathSync.native(project), fingerprint: "a".repeat(64), slot: "b".repeat(64), nativeConfigurationFingerprint: "c".repeat(64) })
  };
  const inspect = () => buildNextReport(project, deps);
  const currentBasis = async () => {
    const intent = store.readIntent();
    assert.equal(intent.status, "available");
    const scan = scanProject({ targetDir: project });
    const sourceFingerprint = resendSourceFingerprint(scan);
    assert.ok(sourceFingerprint, "supported application source has a non-secret content basis");
    const credentialRevision = store.credentialRevision(ref);
    assert.ok(credentialRevision, "registered credential has a revision timestamp");
    const plan = await buildConnectionPlan(project, "development", { ...deps, resolveDestination: deps.connectionDestinationResolver });
    assert.equal(plan.status, "planned", `existing intent/v2 slot must resolve: ${plan.reason}`);
    return {
      planFingerprint: plan.fingerprint, expiresAt: new Date(Date.now() + 60000).toISOString(), configurationObserved: true,
      credentialRevision,
      destinationFingerprint: "a".repeat(64),
      intentFingerprint: connectionIntentFingerprint(intent.value),
      sourceFingerprint: applicationSourceFingerprint(project),
      verifierVersion: APPLICATION_OBSERVATION_VERSION
    };
  };
  const recordPassedApplicationCheck = async () => {
    const started = store.beginObservation({ kind: "application-check", authority: "agent-observed", basis: await currentBasis() });
    assert.equal(started.ok, true);
    const finished = store.finishObservation(started.value.id, "completed", "application-passed");
    assert.equal(finished.ok, true);
  };

  await recordPassedApplicationCheck();
  assert.equal((await inspect()).connection.report.applicationCheck.status, "passed");

  const connectionsDir = join(root, ".api-key-case", "connections");
  const stateDir = readdirSync(connectionsDir).map((name) => join(connectionsDir, name)).find((candidate) => {
    return JSON.parse(readFileSync(join(candidate, "state.json"), "utf8")).intent.id === deriveConnectionId(project, "development");
  });
  assert.ok(stateDir);
  const observationsPath = join(stateDir, "observations.json");
  const legacyJournal = JSON.parse(readFileSync(observationsPath, "utf8"));
  delete legacyJournal.entries.at(-1).basis.intentFingerprint;
  delete legacyJournal.entries.at(-1).basis.planFingerprint;
  delete legacyJournal.entries.at(-1).basis.expiresAt;
  delete legacyJournal.entries.at(-1).basis.configurationObserved;
  legacyJournal.entries.at(-1).basis.verifierVersion = "resend-application-check-v2";
  writeFileSync(observationsPath, JSON.stringify(legacyJournal));
  if (process.platform !== "win32") chmodSync(observationsPath, 0o600);
  assert.equal(store.readObservations().status, "available", "legacy observations remain readable");
  assert.equal((await inspect()).connection.report.applicationCheck.status, "stale",
    "a legacy observation without intent binding cannot preserve a passed state");
  await recordPassedApplicationCheck();
  assert.equal((await inspect()).connection.report.applicationCheck.status, "passed");

  // The source path is unchanged, but an executable syntax change invalidates
  // the old application result. Literal contents never enter the fingerprint.
  writeFileSync(sourcePath, originalSource.replace("client.emails.send", "client.emails.cancel"));
  assert.equal((await inspect()).connection.report.applicationCheck.status, "stale",
    "same-file source content change invalidates applicationCheck");
  writeFileSync(sourcePath, originalSource);
  assert.equal((await inspect()).connection.report.applicationCheck.status, "passed");

  // Behavior-bearing values are not omitted from the digest; sources that
  // contain them cannot establish a current check until a safe parser exists.
  writeFileSync(sourcePath, `${originalSource}const note = "synthetic-source-literal-one";\n`);
  assert.equal(resendSourceFingerprint(scanProject({ targetDir: project })), null);
  assert.equal((await inspect()).connection.report.applicationCheck.status, "unknown");
  writeFileSync(sourcePath, `${originalSource}const note = "synthetic-source-literal-two-with-extra-length";\n`);
  assert.equal(resendSourceFingerprint(scanProject({ targetDir: project })), null,
    "literal values and their lengths never enter a digest");
  assert.equal((await inspect()).connection.report.applicationCheck.status, "unknown");
  writeFileSync(sourcePath, originalSource);

  // A line break after `return` triggers ASI and changes the returned value.
  // It must change the source fingerprint and invalidate the prior pass.
  const sourceBeforeAsiChange = resendSourceFingerprint(scanProject({ targetDir: project }));
  const asiSource = originalSource.replace(
    "return client.emails.send(process.env.RESEND_API_KEY);",
    "return\nclient.emails.send(process.env.RESEND_API_KEY);"
  );
  writeFileSync(sourcePath, asiSource);
  const sourceAfterAsiChange = resendSourceFingerprint(scanProject({ targetDir: project }));
  assert.notEqual(sourceAfterAsiChange, sourceBeforeAsiChange,
    "a return newline changes the source fingerprint");
  assert.equal((await inspect()).connection.report.applicationCheck.status, "stale",
    "ASI-sensitive return newline invalidates applicationCheck");
  writeFileSync(sourcePath, originalSource);
  assert.equal((await inspect()).connection.report.applicationCheck.status, "passed");

  // Preserve line breaks inside block comments too: comments are stripped, but
  // a newline there can still trigger ASI.
  const singleLineCommentSource = originalSource.replace(
    "return client.emails.send(process.env.RESEND_API_KEY);",
    "return /* separator */ process.env.RESEND_API_KEY;"
  );
  writeFileSync(sourcePath, singleLineCommentSource);
  await recordPassedApplicationCheck();
  assert.equal((await inspect()).connection.report.applicationCheck.status, "passed");
  const commentFingerprint = resendSourceFingerprint(scanProject({ targetDir: project }));
  writeFileSync(sourcePath, singleLineCommentSource.replace("/* separator */", "/* separator\n */"));
  assert.notEqual(resendSourceFingerprint(scanProject({ targetDir: project })), commentFingerprint,
    "a newline within a block comment changes the source fingerprint");
  assert.equal((await inspect()).connection.report.applicationCheck.status, "stale",
    "ASI-sensitive block-comment newline invalidates applicationCheck");
  writeFileSync(sourcePath, originalSource);
  await recordPassedApplicationCheck();
  assert.equal((await inspect()).connection.report.applicationCheck.status, "passed");

  await vault.deleteSecret(ref);
  assert.equal((await inspect()).connection.report.applicationCheck.status, "stale",
    "deleting a registered credential invalidates its application result");

  await saveCredential("synthetic-second-credential");
  await recordPassedApplicationCheck();
  assert.equal((await inspect()).connection.report.applicationCheck.status, "passed");
  await saveCredential("synthetic-third-credential-with-different-length");
  assert.equal((await inspect()).connection.report.applicationCheck.status, "stale",
    "updating a credential changes its non-secret registration revision");

  await recordPassedApplicationCheck();
  assert.equal((await inspect()).connection.report.applicationCheck.status, "passed");
  assert.equal(store.saveIntent({
    service: "resend", environment: "development", route: "provider-native",
    destination: { kind: "vercel" }, sendingDomain: null
  }).ok, true);
  assert.equal((await inspect()).connection.report.applicationCheck.status, "stale",
    "managed to Vercel native route and destination intent changes invalidate the result");

  assert.equal(JSON.stringify(await inspect()).includes("synthetic-first-credential"), false);
  assert.equal(JSON.stringify(await inspect()).includes("synthetic-second-credential"), false);
  assert.equal(JSON.stringify(await inspect()).includes("synthetic-third-credential"), false);
}

async function testResendGuidedSetup(root) {
  const project = join(root, "resend-guided"), home = join(root, "resend-guided-home");
  mkdirSync(project); mkdirSync(home);
  writeFileSync(join(project, ".gitignore"), ".env\n.env.*\n!.env.example\n");
  const source = join(project, "app.ts"); writeFileSync(source, "process.env.RESEND_API_KEY;\n");
  const vault = new MemoryVault(), store = new ConnectionStateStore(project, home);
  const legacy = { name: "RESEND_API_KEY", scope: "project", projectId: deriveProjectId(project) };
  const ref = connectionCredentialRef(project, "development");
  const deps = { vault, adapters: [], licensePlan: "free", registryBaseDir: home, connectionBaseDir: home, hostReadiness: testHost() };
  const inspect = (overrides = {}) => buildNextReport(project, { ...deps, ...overrides });
  const selection = { service: "resend", environment: "development", route: "api-key-case-managed", destination: { kind: "local" }, sendingDomain: null };
  let cases = 0, humanCalls = 0;
  const noInput = report => assert.equal(report.nextActions.some(a => a.kind === "register-connection-credential" || (a.kind === "register-secret" && a.name === ref.name)), false);
  const unselected = await inspect(); assert.equal(unselected.connection.status, "not-selected"); assert.equal(unselected.guidedSetup, null);
  assert.equal(unselected.setup.stage, "review-deployment"); assert.equal(unselected.setup.counts.required, 0);
  assert.deepEqual(unselected.nextActions, [{actor:"agent",kind:"review-connection-route"}]); cases++;
  await vault.setSecret(legacy, "synthetic-legacy-key");
  assert.equal((await inspect()).guidedSetup, null, "legacy storage cannot select an environment"); cases++;
  assert.equal(store.saveIntent(selection).ok, true);
  const missing = await inspect(); assert.equal(missing.connection.report.credential.source, "legacy-unscoped");
  assert.equal(missing.guidedSetup.stage, "acquire-and-save"); assert.deepEqual(missing.guidedSetup.registration, {status:"missing",scope:"project"});
  assert.equal(missing.setup.stage, "register-secrets"); assert.equal(missing.setup.counts.missing, 1);
  assert.equal(missing.secrets.find(s=>s.name===ref.name).status, "registered", "legacy fact remains explicit");
  assert.ok(missing.nextActions.some(a=>a.kind==="register-connection-credential"&&a.environment==="development"));
  assert.equal(missing.connection.report.plan.reason, "handoff-pending", "no generic local support is enabled"); cases++;
  assert.equal((await inspect({licensePlan:"pro"})).guidedSetup.stage, "acquire-and-save"); cases++;
  const unsupportedLocal = await inspect({hostReadiness:inspectHostReadiness({platform:"linux"})}); assert.equal(unsupportedLocal.guidedSetup,null); assert.equal(unsupportedLocal.localDevelopment.nextStep,"review-host-support"); noInput(unsupportedLocal); cases++;
  const inaccessible = await inspect({vault:{isAvailable:async()=>false}}); assert.equal(inaccessible.guidedSetup.registration.status,"unavailable"); noInput(inaccessible); cases++;
  const failedPresence = await inspect({vault:{isAvailable:async()=>true,hasSecret:async()=>{throw Error("raw-error-canary")}}});
  assert.equal(failedPresence.guidedSetup.registration.status,"unavailable"); noInput(failedPresence); assert.ok(!JSON.stringify(failedPresence).includes("raw-error-canary")); cases++;
  // Cancellation leaves pending metadata, not a new request to issue another key.
  const cancelled = { capability:()=>"os-dialog", askSecret:async()=>"cancelled" };
  assert.equal((await runConnectionCredential(project,"development","save",{...deps,humanPlane:cancelled})).status,"cancelled");
  const pending = await inspect(); assert.equal(pending.guidedSetup.registration.status,"unavailable"); assert.equal(pending.setup.counts.missing,0); noInput(pending); cases++;
  // An explicit human request completes the existing scoped lifecycle once.
  const human = {capability:()=>"os-dialog", askSecret:async request=>{
    humanCalls++; assert.deepEqual(request,{...ref,projectDir:realpathSync(project).replace(/\\/g,"/"),acquisition:{sendingDomain:null,destination:"local"}});
    await vault.setSecret(ref,"synthetic-human-plane-canary"); return "saved";
  }};
  assert.equal((await runConnectionCredential(project,"development","save",{...deps,humanPlane:human})).status,"saved");
  await vault.deleteSecret(legacy);
  const stored = await inspect(); assert.equal(stored.guidedSetup.stage,"stored"); assert.deepEqual(stored.guidedSetup.registration,{status:"registered",scope:"project"});
  assert.equal(stored.setup.stage,"review-deployment"); assert.equal(stored.setup.counts.registered,1); assert.equal(stored.setup.counts.missing,0);
  assert.equal(stored.secrets.find(s=>s.name===ref.name).status,"missing", "v1 is independent of stored v2"); noInput(stored);
  assert.deepEqual(stored.nextActions,[{actor:"agent",kind:"review-local-development",step:"prepare-and-inspect"}]);
  assert.equal(stored.guidedSetup.connectionState,"not-tested"); assert.equal(stored.guidedSetup.runtimeAccess,"not-configured-by-this-flow"); cases++;
  assert.equal((await runConnectionCredential(project,"development","save",{...deps,humanPlane:human})).status,"already-registered");
  assert.equal(humanCalls,1,"fresh status and an accidental duplicate request cause no repeated Human Plane work"); cases++;
  assert.deepEqual(await inspect(),stored,"fresh process-independent state needs no acquisition journal");
  await vault.setSecret(ref,"different-synthetic-key-length"); assert.deepEqual(await inspect(),stored); cases++;
  // Wrong environments and user/project legacy slots never satisfy this target.
  assert.equal(store.saveIntent({...selection,environment:"preview",destination:{kind:"vercel"}}).ok,true);
  const wrongEnv=await inspect(); assert.equal(wrongEnv.guidedSetup.registration.status,"missing"); assert.equal(wrongEnv.setup.counts.missing,1);
  assert.ok(wrongEnv.nextActions.some(a=>a.kind==="register-connection-credential"&&a.environment==="preview")); cases++;
  const userVault=new MemoryVault(); await userVault.setSecret({...legacy,scope:"user",projectId:null},"synthetic-user-key");
  assert.equal((await inspect({vault:userVault})).guidedSetup.registration.status,"missing"); cases++;
  // Metadata uncertainty must not be recovered through input, including generic plan advice.
  const stateDir=join(home,".api-key-case","connections",readdirSync(join(home,".api-key-case","connections"))[0]);
  for(const [name,directory] of [["credential-preview.json.lock",true],["credential-preview.json.tmp",false],["lock",true],["state.json.tmp",false]]){
    const path=join(stateDir,name); if(directory)mkdirSync(path); else writeFileSync(path,"synthetic uncertain storage");
    const report=await inspect(); noInput(report); assert.equal(report.setup.counts.missing,0);
    if(report.connection.status==="selected") assert.notEqual(report.connection.report.plan.reason,"credential-missing");
    assert.ok(existsSync(path)); rmSync(path,{recursive:true}); cases++;
  }
  const begun=store.beginCredentialMutation(connectionCredentialRef(project,"preview")); assert.equal(begun.ok,true);
  assert.equal(store.finishCredentialMutation(connectionCredentialRef(project,"preview"),begun.value,false),true);
  const unsettled=await inspect(); noInput(unsettled); assert.equal(unsettled.guidedSetup.registration.status,"unavailable");
  assert.notEqual(unsettled.connection.report.plan.reason,"credential-missing"); cases++;
  // Presence/metadata changing while awaited is unknown, never a missing prompt.
  assert.equal(store.saveIntent({...selection,environment:"production",destination:{kind:"vercel"}}).ok,true);
  let changed=false; const changingVault={isAvailable:async()=>true,hasSecret:async current=>{
    if(current.service==="resend"&&!changed){changed=true;const b=store.beginCredentialMutation(current);assert.equal(b.ok,true);assert.equal(store.finishCredentialMutation(current,b.value,false),true)}return false;
  }};
  const changedReport=await inspect({vault:changingVault}); noInput(changedReport); assert.equal(changedReport.guidedSetup.registration.status,"unavailable"); cases++;
  assert.equal(store.saveIntent({...selection,destination:{kind:"vercel"}}).ok,true);
  // Even when later presence returns the first result, the plan's intervening
  // contradiction/failure is uncertainty and cannot request registration.
  for(const sequence of [[true,false,true],[false,"unavailable",false],[false,true,false]]){
    let reads=0;const inconsistentVault={isAvailable:async()=>true,hasSecret:async current=>{
      if(current.service!=="resend")return false;const value=sequence[Math.min(reads++,sequence.length-1)];
      if(value==="unavailable")throw Error("synthetic intermediate failure");return value;
    }};
    const report=await inspect({vault:inconsistentVault});noInput(report);
    assert.equal(report.guidedSetup.registration.status,"unavailable");assert.equal(report.setup.counts.missing,0);
    assert.notEqual(report.connection.report.plan.reason,"credential-missing");cases++;
  }
  assert.equal(store.saveIntent(selection).ok,true);
  let presenceReads=0;const presenceRace={isAvailable:async()=>true,hasSecret:async current=>current.service==="resend"?++presenceReads===1:false};
  const presenceChanged=await inspect({vault:presenceRace});noInput(presenceChanged);
  assert.equal(presenceChanged.guidedSetup.registration.status,"unavailable");assert.equal(presenceChanged.setup.counts.missing,0);cases++;
  // Session ownership/history never become input or retry permission.
  mkdirSync(join(stateDir,"local-session.lock")); const locked=await inspect(); noInput(locked); assert.equal(locked.guidedSetup,null);
  assert.equal(locked.localSession.retry,"owner-review-required"); rmSync(join(stateDir,"local-session.lock"),{recursive:true}); cases++;
  const trial=store.beginLocalSession(store.credentialRevision(ref),1000); assert.equal(trial.ok,true);
  assert.equal(store.finishLocalSession(trial.value.attemptId,"unknown",true,{execution:"possible",treeTermination:"unknown"}),true);
  const unknown=await inspect(); noInput(unknown); assert.equal(unknown.guidedSetup,null); assert.equal(unknown.localSession.applicationReadiness,"not-verified"); cases++;
  const legacyReceipt={...trial.value,finishedAt:new Date().toISOString(),outcome:"exited"};
  for(const field of ["executionBasisId","intentRevision","execution","treeTermination"])delete legacyReceipt[field];
  writeFileSync(join(stateDir,"local-session.json"),JSON.stringify({schemaVersion:1,receipt:legacyReceipt}),{mode:0o600});
  const legacyHistory=await inspect(); assert.equal(legacyHistory.localSession.receiptRelation,"legacy-unbound");
  assert.equal(legacyHistory.guidedSetup.stage,"stored"); noInput(legacyHistory); assert.equal(legacyHistory.localSession.permission,"none"); cases++;
  // Selection is durable without scanner coverage. Unrelated diagnostic stays actionable.
  writeFileSync(source,"process.env.OTHER_API_KEY;\n"); const otherMissing=await inspect();
  assert.equal(otherMissing.guidedSetup.stage,"stored"); assert.equal(otherMissing.setup.counts.missing,1);
  assert.ok(otherMissing.nextActions.some(a=>a.kind==="register-secret"&&a.name==="OTHER_API_KEY")); noInput(otherMissing); cases++;
  const otherProject=join(root,"resend-other-project");mkdirSync(otherProject);writeFileSync(join(otherProject,"app.ts"),"process.env.RESEND_API_KEY;");
  assert.equal(new ConnectionStateStore(otherProject,home).saveIntent(selection).ok,true);
  assert.equal((await buildNextReport(otherProject,deps)).guidedSetup.registration.status,"missing","another project's v2 key cannot satisfy this target"); cases++;
  assert.equal(store.saveIntent({...selection,route:"provider-native",destination:{kind:"vercel"}}).ok,true);
  const native=await inspect({vault:{isAvailable:async()=>false}}); assert.equal(native.guidedSetup,null); assert.equal(native.connection.report.credential.source,"provider-native");
  assert.ok(native.nextActions.some(a=>a.kind==="enable-vault"),"unrelated secret still requires storage"); noInput(native); cases++;
  writeFileSync(source,"process.env.RESEND_API_KEY;\n"); const nativeOnly=await inspect({vault:{isAvailable:async()=>false}});
  assert.equal(nativeOnly.setup.counts.required,0); assert.equal(nativeOnly.setup.stage,"review-deployment");
  assert.ok(!nativeOnly.nextActions.some(a=>a.kind==="enable-vault")); noInput(nativeOnly); cases++;
  assert.equal(store.saveIntent({...selection,environment:"preview"}).ok,true);
  const unsupported=await inspect(); assert.equal(unsupported.guidedSetup,null); noInput(unsupported); assert.equal(unsupported.connection.report.plan.reason,"handoff-pending"); assert.equal(unsupported.setup.counts.required,0); assert.equal(unsupported.setup.stage,"review-deployment"); cases++;
  assert.equal(store.saveIntent(selection).ok,true);
  const offline=await inspect({offline:true}); assert.equal(offline.guidedSetup,null); noInput(offline); assert.equal(offline.connection.report.plan.permission,"none"); cases++;
  const historyCanary="synthetic-history-raw-canary";
  writeFileSync(join(stateDir,"observations.json"),JSON.stringify({schemaVersion:1,entries:[{raw:historyCanary}]}),{mode:0o600});
  const invalidHistory=await inspect(); assert.equal(invalidHistory.guidedSetup,null); noInput(invalidHistory);
  assert.equal(invalidHistory.connection.issue,"history-unavailable"); assert.ok(!JSON.stringify(invalidHistory).includes(historyCanary)); rmSync(join(stateDir,"observations.json")); cases++;
  // Readiness is an awaited diagnostic after legacy scanning. Its completion
  // must precede the final selected-slot snapshot used for acquisition advice.
  for(const change of ["selection","pending"]){
    const raceProject=join(root,`resend-readiness-${change}`),raceHome=join(root,`resend-readiness-home-${change}`);
    mkdirSync(raceProject);mkdirSync(raceHome);writeFileSync(join(raceProject,"app.ts"),"process.env.RESEND_API_KEY;");
    writeFileSync(join(raceProject,".gitignore"),".env\n.env.*\n!.env.example\n");
    const raceStore=new ConnectionStateStore(raceProject,raceHome),raceVault=new MemoryVault();
    assert.equal(raceStore.saveIntent({...selection,destination:{kind:"vercel"}}).ok,true);
    const raceRef=connectionCredentialRef(raceProject,"development");let readinessCalls=0;
    const fakeAdapter={id:"cloudflare",cliCommand:"wrangler",detect:async()=>({detected:true,reason:"synthetic"}),
      checkCli:async()=>({installed:true,loggedIn:true,identity:"synthetic"}),
      planDeploy:()=>{throw Error("No deployment")},manualSteps:()=>[]};
    const report=await buildNextReport(raceProject,{...deps,vault:raceVault,adapters:[fakeAdapter],
      registryBaseDir:raceHome,connectionBaseDir:raceHome,inspectReadiness:async()=>{
        readinessCalls++;await Promise.resolve();
        if(change==="selection")assert.equal(raceStore.saveIntent({...selection,environment:"production",route:"provider-native",destination:{kind:"vercel"}}).ok,true);
        else{const mutation=raceStore.beginCredentialMutation(raceRef);assert.equal(mutation.ok,true);assert.equal(raceStore.finishCredentialMutation(raceRef,mutation.value,false),true);}
        return ["development","preview","production"].map(env=>({env,status:"blocked",issues:["target-not-configured"],unverified:["human-interaction","provider-write-permission"]}));
      }});
    assert.equal(readinessCalls,1);noInput(report);assert.equal(report.setup.counts.missing,0);
    if(change==="selection"){
      assert.equal(report.connection.report.environment,"production");assert.equal(report.connection.report.route,"provider-native");
      assert.equal(report.guidedSetup,null);assert.ok(!report.nextActions.some(a=>a.kind==="enable-vault"));
    }else{
      assert.equal(raceStore.readCredentialRegistration(raceRef).value.state,"pending");
      assert.equal(report.guidedSetup.registration.status,"unavailable");assert.notEqual(report.connection.report.plan.reason,"credential-missing");
    }
    cases++;
  }
  // Actual regular CLI code in the existing owned-copy pattern: fake OS store,
  // availability probe overridden, every provider/child operation denied.
  const checkout=join(root,"selected-guidance-cli"); mkdirSync(checkout); writeFileSync(join(checkout,"package.json"),'{"type":"module"}');
  cpSync(fileURLToPath(new URL("../dist",import.meta.url)),join(checkout,"dist"),{recursive:true});
  const modules=join(checkout,"node_modules"); mkdirSync(modules);
  const sourceModules=realpathSync(fileURLToPath(new URL("../node_modules",import.meta.url)));
  for(const name of readdirSync(sourceModules))if(name!=="@napi-rs"&&!name.startsWith("."))symlinkSync(join(sourceModules,name),join(modules,name),process.platform==="win32"?"junction":"dir");
  const fake=join(modules,"@napi-rs","keyring"); mkdirSync(fake,{recursive:true});
  const slots=join(root,"selected-guidance-slots.json"),effects=join(root,"selected-guidance-effects.json");
  writeFileSync(slots,JSON.stringify([toAccount(ref)])); writeFileSync(effects,JSON.stringify({writes:0,children:0}));
  writeFileSync(join(fake,"package.json"),'{"name":"@napi-rs/keyring","main":"index.cjs"}');
  writeFileSync(join(fake,"index.cjs"),`const fs=require('node:fs');exports.Entry=class{constructor(service,account){this.account=account}getPassword(){return JSON.parse(fs.readFileSync(${JSON.stringify(slots)},'utf8')).includes(this.account)?'synthetic-cli-value':null}setPassword(){throw Error('No native writes')}deletePassword(){throw Error('No native deletes')}};`);
  const preload=join(root,"selected-guidance-cli.mjs");
  writeFileSync(preload,`import cp from'node:child_process';import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';import{KeyringVault}from ${JSON.stringify(pathToFileURL(join(checkout,"dist/core/vault/keyring.js")).href)};KeyringVault.prototype.isAvailable=async()=>true;for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=(...args)=>{const x=JSON.parse(fs.readFileSync(${JSON.stringify(effects)},'utf8'));x.children++;fs.writeFileSync(${JSON.stringify(effects)},JSON.stringify(x));if(n==='spawnSync'&&args[0]==='git')return{status:1,stdout:'',stderr:''};throw Error('Synthetic provider denied')};syncBuiltinESMExports();`);
  const cli=args=>{const r=spawnSync(process.execPath,["--import",pathToFileURL(preload).href,join(checkout,"dist/cli/index.js"),...args,project],{cwd:project,env:{...process.env,HOME:home,USERPROFILE:home,DO_NOT_TRACK:"1",NODE_OPTIONS:""},encoding:"utf8",timeout:15000});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.ok(!r.stdout.includes("synthetic-cli-value"));return JSON.parse(r.stdout)};
  const actual=cli(["next","--json"]); assert.equal(actual.guidedSetup.stage,"stored"); assert.equal(actual.setup.counts.missing,0); noInput(actual); cases++;
  initializeAgentInstructions({projectDir:project,packageVersion:"0.9.2",host:"agents"});
  const protocol=readFileSync(join(project,"AGENTS.md"),"utf8");
  const selectionGuidance=protocol.split('\n').find(line=>line.startsWith('- connection.status is'));
  assert.match(selectionGuidance,/If not-selected, inspect the user's request and existing non-secret app configuration, then propose a supported app\/environment\/destination and route in plain language/);
  assert.match(selectionGuidance,/Reuse explicit choices from the request or saved selection without asking again/);
  assert.match(selectionGuidance,/Confirm only unresolved decisions together; do not make the human choose CLI terms/);
  assert.match(selectionGuidance,/Never turn an inferred route into a confirmed choice, change a confirmed selection, invent a route or bypass permission\/operation approval/);
  assert.doesNotMatch(selectionGuidance,/Before selection, ask for the exact target/);
  for(const pattern of [/registration refers only to connection.report.environment/,/skip acquisition\/save/,/Pending registration, locks/,/connection credential save --service resend --env/,/public 0\.9\.2 lacks this command/])assert.match(protocol,pattern);
  const freshChat=cli(["next","--json"]); assert.equal(freshChat.guidedSetup.stage,"stored"); noInput(freshChat); assert.equal(humanCalls,1); cases++;
  const beforeOffline=readFileSync(effects,"utf8"),resumed=cli(["next","--json","--offline"]);
  assert.equal(resumed.inspection.mode,"offline"); assert.equal(resumed.connection.report.credential.status,"registered"); noInput(resumed);
  assert.equal(readFileSync(effects,"utf8"),beforeOffline,"offline resumes without even attempted provider/child work"); cases++;
  // Preserve only non-secret acceptance input for a fresh read-only Agent.
  if(process.env.AKC_GUIDANCE_EVIDENCE_DIR){const out=process.env.AKC_GUIDANCE_EVIDENCE_DIR;mkdirSync(out,{recursive:true});writeFileSync(join(out,"AGENTS.md"),protocol);writeFileSync(join(out,"stored.json"),JSON.stringify(freshChat,null,2));writeFileSync(join(out,"offline.json"),JSON.stringify(resumed,null,2));writeFileSync(join(out,"missing.json"),JSON.stringify(missing,null,2));writeFileSync(join(out,"provider-native.json"),JSON.stringify(nativeOnly,null,2));writeFileSync(join(out,"unselected.json"),JSON.stringify(unselected,null,2));}
  console.log(`Selected Resend guidance: ${cases} cases passed; regular CLI and fresh instructions resume the exact v2 slot; one synthetic human save, no duplicate human work, real store/provider/app unverified.`);
}
async function testExistingEnvOnboarding(root) {
  const withExample = join(root, "existing-env-example");
  mkdirSync(withExample, { recursive: true });
  writeFileSync(join(withExample, ".gitignore"), ".env\n.env.*\n!.env.example\n");
  writeFileSync(join(withExample, ".env.example"), "EXAMPLE_API_KEY=\n");
  writeFileSync(join(withExample, "app.ts"), "const key = process.env.EXAMPLE_API_KEY;\n");
  assert.deepEqual(scanProject({ targetDir: withExample }).requiredSecrets, ["EXAMPLE_API_KEY"]);

  const envOnly = join(root, "existing-env-only");
  mkdirSync(envOnly, { recursive: true });
  writeFileSync(join(envOnly, ".gitignore"), ".env\n.env.*\n!.env.example\n");
  const envCanary = "synthetic-env-value-must-not-be-read";
  writeFileSync(join(envOnly, ".env"), `ENV_FILE_ONLY_NAME=${envCanary}\n`);
  writeFileSync(join(envOnly, "app.ts"), "const key = process.env.CODE_DISCOVERED_KEY;\n");
  const envOnlyReport = scanProject({ targetDir: envOnly });
  assert.deepEqual(envOnlyReport.requiredSecrets, ["CODE_DISCOVERED_KEY"]);
  assert.equal(JSON.stringify(envOnlyReport).includes("ENV_FILE_ONLY_NAME"), false);
  assert.equal(JSON.stringify(envOnlyReport).includes(envCanary), false);

  const unsupported = join(root, "existing-env-unsupported-language");
  mkdirSync(unsupported, { recursive: true });
  writeFileSync(join(unsupported, "app.py"), 'key = os.getenv("PYTHON_EXISTING_KEY")\n');
  assert.deepEqual(scanProject({ targetDir: unsupported }).requiredSecrets, []);
  const unsupportedVault = new MemoryVault();
  const unsupportedRef = {
    name: "PYTHON_EXISTING_KEY",
    scope: "project",
    projectId: deriveProjectId(unsupported)
  };
  await unsupportedVault.setSecret(unsupportedRef, "synthetic-human-entered-value");
  assert.equal(await unsupportedVault.hasSecret(unsupportedRef), true, "a known name remains storable after a scanner miss");

  const environmentVariant = join(root, "same-name-environment-variants");
  mkdirSync(environmentVariant, { recursive: true });
  const sharedSlotRef = {
    name: "SHARED_ENVIRONMENT_KEY",
    scope: "project",
    projectId: deriveProjectId(environmentVariant)
  };
  const requestedVariants = ["development", "production"].map((env) => ({
    env,
    account: toAccount(sharedSlotRef)
  }));
  assert.equal(
    new Set(requestedVariants.map(({ account }) => account)).size,
    1,
    "development and production resolve to one project/name storage slot"
  );

  const cloudflare = join(root, "existing-env-cloudflare");
  const cliDir = join(root, "existing-env-cloudflare-cli");
  mkdirSync(cloudflare, { recursive: true });
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cloudflare, "wrangler.json"), JSON.stringify({
    name: "existing-env-worker",
    account_id: "0123456789abcdef0123456789abcdef"
  }));
  writeFileSync(join(cloudflare, ".env"), `CLOUDFLARE_EXISTING_KEY=${envCanary}\n`);
  const fixtureCli = join(cliDir, process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  writeFileSync(fixtureCli, process.platform === "win32" ? "@exit /b 93\r\n" : "#!/usr/bin/env node\nprocess.exit(93);\n");
  chmodSync(fixtureCli, 0o755);
  let providerProbes = 0;
  const readiness = await inspectTargetReadiness({
    adapter: {
      id: "cloudflare",
      cliCommand: "wrangler",
      detect: async () => ({ detected: true, reason: "wrangler.json" }),
      checkCli: async () => {
        providerProbes += 1;
        return { installed: true, loggedIn: true, identity: "accounts:0123456789abcdef" };
      },
      planDeploy: () => { throw new Error("readiness must not deploy"); },
      manualSteps: () => []
    },
    projectDir: cloudflare,
    detected: true,
    vaultAvailable: true,
    host: testHost(),
    pathOverride: [cliDir, dirname(process.execPath)].join(delimiter)
  });
  assert.ok(readiness.every((entry) => entry.issues.includes("unsafe-deploy-context")));
  assert.equal(providerProbes, 0, "Cloudflare env-file coexistence must stop before login probing");
  const cloudflareVault = new MemoryVault();
  const cloudflareRef = {
    name: "CLOUDFLARE_EXISTING_KEY",
    scope: "project",
    projectId: deriveProjectId(cloudflare)
  };
  await cloudflareVault.setSecret(cloudflareRef, "synthetic-human-entered-value");
  assert.equal(await cloudflareVault.hasSecret(cloudflareRef), true, "deploy readiness must not block registration");
}

function testHostConditions() {
  const linux = inspectHostReadiness({ platform: "linux" });
  assert.equal(linux.secretInput, "unavailable");
  assert.equal(linux.approval, "unavailable");
  assert.deepEqual(linux.issues, ["unsupported-platform"]);
  const oldWindows = inspectHostReadiness({ platform: "win32", osRelease: "10.0.19045", helperAvailable: true });
  assert.equal(oldWindows.secretInput, "interaction-required", "old Windows must keep Secret input");
  assert.equal(oldWindows.approval, "unavailable");
  assert.deepEqual(oldWindows.issues, ["windows-version-unsupported"]);
  const unknownWindows = inspectHostReadiness({ platform: "win32", osRelease: "unknown", helperAvailable: true });
  assert.equal(unknownWindows.approval, "unavailable");
  assert.deepEqual(unknownWindows.issues, ["windows-version-unverified"]);
  const windows = testHost();
  assert.equal(windows.approval, "interaction-required");
  assert.ok(windows.requirements.includes("windows-hello"), "do not silently assume enrollment");
  const mac = inspectHostReadiness({ platform: "darwin", helperAvailable: true });
  assert.equal(mac.approval, "interaction-required", "helper presence cannot prove a GUI session or approval");
  const noHelper = inspectHostReadiness({ platform: "darwin", helperAvailable: false });
  assert.equal(noHelper.secretInput, "unavailable");
  assert.equal(noHelper.approval, "unavailable");
}

async function testFreePreflightAndSetup(root) {
  const projectDir = join(root, "project");
  const cliDir = join(root, "cli");
  mkdirSync(join(projectDir, ".vercel"), { recursive: true });
  mkdirSync(cliDir);
  writeFileSync(join(projectDir, ".gitignore"), ".env\n.env.*\n");
  writeFileSync(join(projectDir, "app.ts"), "process.env.FIRST_API_KEY; process.env.SECOND_API_KEY;\n");
  const configPath = join(projectDir, ".vercel/project.json");
  const linked = JSON.stringify({ orgId: "team_setup", projectId: "prj_setup" });
  writeFileSync(configPath, linked);
  const fixtureCli = join(cliDir, process.platform === "win32" ? "vercel.cmd" : "vercel");
  writeFileSync(fixtureCli, process.platform === "win32" ? "@exit /b 93\r\n" : "#!/usr/bin/env node\nprocess.exit(93);\n");
  chmodSync(fixtureCli, 0o755);
  const trustedFixturePath = [cliDir, dirname(process.execPath)].join(delimiter);
  let probes = 0;
  const adapter = {
    id: "vercel", cliCommand: "vercel",
    detect: async () => ({ detected: true, reason: "provider-raw-output-canary" }),
    checkCli: async (options) => {
      if (options) {
        probes++;
        assert.equal(options.cwd, realpathSync.native(projectDir));
        assert.ok(options.resolvedCli);
        assert.equal(options.env.NODE_OPTIONS, undefined);
        assert.equal(options.env.VERCEL_TOKEN, undefined);
      }
      return { installed: true, loggedIn: true, identity: "user:fixture", hint: "provider-raw-output-canary" };
    },
    planDeploy: () => { throw new Error("diagnostics must not plan or execute a Secret write"); },
    manualSteps: () => []
  };
  const base = { adapter, projectDir, detected: true, vaultAvailable: true, host: testHost(), pathOverride: trustedFixturePath };
  const healthy = await inspectTargetReadiness(base);
  assert.equal(probes, 3, "Free preflight must inspect every environment through the trusted CLI context");
  assert.ok(healthy.every((env) => env.status === "prerequisites-checked"), JSON.stringify(healthy));
  assert.ok(healthy.every((env) => env.unverified.includes("human-interaction") && env.unverified.includes("provider-write-permission")));
  assert.equal(JSON.stringify(healthy).includes("provider-raw-output-canary"), false);
  assert.equal(JSON.stringify(healthy).includes("user:fixture"), false);

  probes = 0;
  for (const options of [
    { host: inspectHostReadiness({ platform: "linux" }) },
    { host: inspectHostReadiness({ platform: "win32", osRelease: "10.0.19045", helperAvailable: true }) },
    { detected: false }, { vaultAvailable: false }
  ]) {
    const blocked = await inspectTargetReadiness({ ...base, ...options });
    assert.ok(blocked.every((env) => env.status === "blocked"));
  }
  assert.equal(probes, 0, "unsupported conditions must not start provider probes");

  writeFileSync(configPath, JSON.stringify({ orgId: "team_setup" }));
  const unlinked = await inspectTargetReadiness(base);
  assert.ok(unlinked.every((env) => env.issues.includes("unsafe-deploy-context")));
  assert.equal(probes, 0, "an unresolved destination must not reach the provider");
  writeFileSync(configPath, linked);

  const login = await inspectTargetReadiness({ ...base, adapter: { ...adapter, checkCli: async () => ({ installed: true, loggedIn: false }) } });
  assert.ok(login.every((env) => env.issues.includes("provider-login-required")));
  const noIdentity = await inspectTargetReadiness({ ...base, adapter: { ...adapter, checkCli: async () => ({ installed: true, loggedIn: true }) } });
  assert.ok(noIdentity.every((env) => env.issues.includes("provider-identity-unverified")));
  const failed = await inspectTargetReadiness({ ...base, adapter: { ...adapter, checkCli: async () => { throw new Error("provider-raw-output-canary"); } } });
  assert.ok(failed.every((env) => env.issues.includes("inspection-failed")));
  assert.equal(JSON.stringify(failed).includes("provider-raw-output-canary"), false);

  const changed = await inspectTargetReadiness({ ...base, adapter: {
    ...adapter, checkCli: async () => {
      writeFileSync(fixtureCli, readFileSync(fixtureCli, "utf8") + "\n");
      return { installed: true, loggedIn: true, identity: "user:fixture" };
    }
  } });
  assert.ok(changed.every((env) => env.issues.includes("context-changed")), "probe-time CLI replacement must not look ready");

  const vault = new MemoryVault();
  let secretWrites = 0;
  let trustWrites = 0;
  const setSecret = vault.setSecret.bind(vault);
  vault.setSecret = async (...args) => { secretWrites++; return setSecret(...args); };
  vault.saveDestinationTrust = async () => { trustWrites++; throw new Error("preflight must not mint trust"); };
  const deps = {
    vault, adapters: [adapter], registryBaseDir: root, hostReadiness: testHost(),
    inspectReadiness: (options) => inspectTargetReadiness({ ...options, pathOverride: trustedFixturePath })
  };
  const free = await buildNextReport(projectDir, { ...deps, licensePlan: "free" });
  const pro = await buildNextReport(projectDir, { ...deps, licensePlan: "pro" });
  assert.deepEqual(free.targets[0].readiness, pro.targets[0].readiness, "preflight must not require a purchase");
  assert.equal(secretWrites, 0);
  assert.equal(trustWrites, 0);
  assert.equal(free.schemaVersion, 13);
  assert.equal(free.setup.stage, "register-secrets");
  assert.deepEqual(free.setup.counts, { required: 2, registered: 0, missing: 2, unavailable: 0, unsupported: 0, cleanupCandidates: 0 });
  assert.equal(free.targets[0].deployment.automatic.length, 0, "Free readiness must never unlock execution");

  // The advisory probe can see a login that the sanitized execution cannot use.
  const sanitizedLogin = await buildNextReport(projectDir, {
    ...deps, licensePlan: "free", adapters: [{ ...adapter, checkCli: async (options) =>
      options ? { installed: true, loggedIn: false } : { installed: true, loggedIn: true, identity: "user:fixture" }
    }]
  });
  assert.equal(sanitizedLogin.targets[0].cliStatus, "ready");
  assert.ok(sanitizedLogin.nextActions.some((action) => action.kind === "authenticate-target-cli"));

  const projectId = deriveProjectId(projectDir);
  await vault.setSecret({ name: "FIRST_API_KEY", scope: "project", projectId }, "synthetic-first-value");
  const halfway = await buildNextReport(projectDir, { ...deps, licensePlan: "free" });
  assert.equal(halfway.setup.counts.registered, 1);
  assert.deepEqual(halfway.nextActions.filter((action) => action.kind === "register-secret").map((action) => action.name), ["SECOND_API_KEY"]);
  await vault.setSecret({ name: "SECOND_API_KEY", scope: "project", projectId }, "synthetic-second-value");
  const saved = await buildNextReport(projectDir, { ...deps, licensePlan: "free" });
  assert.equal(saved.setup.stage, "review-deployment");
  assert.equal(saved.setup.deploymentState, "not-inspected", "local registration must not claim remote completion");
  assert.equal(saved.setup.counts.missing, 0);
  assert.equal(trustWrites, 0);
  const serialized = JSON.stringify(saved);
  for (const forbidden of ["synthetic-first-value", "synthetic-second-value", "provider-raw-output-canary", "user:fixture"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  const different = new MemoryVault();
  await different.setSecret({ name: "FIRST_API_KEY", scope: "project", projectId }, "x");
  await different.setSecret({ name: "SECOND_API_KEY", scope: "project", projectId }, "different-length-content");
  assert.deepEqual(await buildNextReport(projectDir, { ...deps, vault: different, licensePlan: "free" }), saved);

  const linux = await buildNextReport(projectDir, { ...deps, vault: new MemoryVault(), licensePlan: "free", hostReadiness: inspectHostReadiness({ platform: "linux" }) });
  assert.equal(linux.setup.stage, "human-handoff");
  assert.equal(linux.vault.status, "available", "Linux still supports the existing Free vault");
  assert.ok(linux.targets[0].readiness.every((env) => env.issues.includes("unsupported-platform")));
  const failedTarget = await buildNextReport(projectDir, {
    ...deps, licensePlan: "free", adapters: [{ ...adapter, detect: async () => { throw new Error("provider-raw-output-canary"); } }]
  });
  assert.equal(failedTarget.targets[0].cliStatus, "unverified");
  assert.ok(failedTarget.targets[0].readiness.every((env) => env.issues.includes("inspection-failed")));
  assert.ok(failedTarget.nextActions.some((action) => action.kind === "review-deploy-setup"));
  assert.equal(JSON.stringify(failedTarget).includes("provider-raw-output-canary"), false);
}

async function testU5MeaningAndResumption(root) {
  const unsupported = join(root, "u5-unsupported");
  mkdirSync(join(unsupported, "src"), { recursive: true });
  writeFileSync(join(unsupported, "app.py"), 'value = os.getenv("PYTHON_API_KEY")\n');
  writeFileSync(
    join(unsupported, "src/config.js"),
    'const value = process["env"]["JS_UNSUPPORTED_API_KEY"];\n'
  );

  const emptyScan = scanProject({ targetDir: unsupported });
  assert.deepEqual(emptyScan.requiredSecrets, [], "unsupported references must not become false certainty");
  assert.match(emptyScan.envExample.reason ?? "", /current scanner/);
  assert.match(emptyScan.envExample.reason ?? "", /does not prove that the project needs no secrets/);
  const emptyText = renderTextReport(emptyScan);
  assert.match(emptyText, /current API Key Case scanner/);
  assert.match(emptyText, /does not prove that the project needs no secrets/);
  const emptyNext = await buildNextReport(unsupported, {
    vault: new MemoryVault(),
    adapters: [],
    licensePlan: "free",
    registryBaseDir: root
  });
  assert.equal(emptyNext.setup.stage, "no-required-secrets");
  assert.equal(emptyNext.setup.counts.required, 0);
  assert.deepEqual(emptyNext.secrets, []);

  const staleExample = join(root, "u5-stale-example");
  mkdirSync(staleExample, { recursive: true });
  writeFileSync(join(staleExample, ".env.example"), "OLD_API_KEY=\n");
  writeFileSync(join(staleExample, "app.ts"), "const value = process.env.CURRENT_API_KEY;\n");
  const staleScan = scanProject({ targetDir: staleExample });
  assert.deepEqual(staleScan.requiredSecrets, ["CURRENT_API_KEY", "OLD_API_KEY"]);
  assert.deepEqual(staleScan.secretUsages.find((entry) => entry.name === "OLD_API_KEY")?.files, []);
  assert.deepEqual(staleScan.secretUsages.find((entry) => entry.name === "CURRENT_API_KEY")?.files, ["app.ts"]);

  const resumed = join(root, "u5-resumed");
  mkdirSync(resumed, { recursive: true });
  writeFileSync(join(resumed, ".env.example"), "RESUMED_API_KEY=\n");
  const projectId = deriveProjectId(resumed);
  const ref = { name: "RESUMED_API_KEY", scope: "project", projectId };
  const vault = new MemoryVault();
  const syntheticValue = "synthetic-resumption-value";
  const humanPlane = {
    askSecret: async () => {
      await vault.setSecret(ref, syntheticValue);
      return "saved";
    }
  };
  const before = await buildNextReport(resumed, {
    vault,
    adapters: [],
    licensePlan: "free",
    registryBaseDir: root
  });
  assert.equal(before.secrets[0]?.status, "missing");

  await assert.rejects(
    () => askAndRecordSecret(
      humanPlane,
      ref,
      resumed,
      () => { throw new Error("index fixture failure"); }
    ),
    (error) => {
      assert.ok(error instanceof SecretStoreMetadataError);
      assert.doesNotMatch(error.message, /synthetic-resumption-value/);
      return true;
    }
  );
  assert.equal(await vault.hasSecret(ref), true, "the OS-store stage remains observable through check");

  const after = await buildNextReport(resumed, {
    vault,
    adapters: [],
    licensePlan: "free",
    registryBaseDir: root
  });
  assert.equal(after.secrets[0]?.status, "registered");
  assert.equal(after.setup.counts.missing, 0);
  assert.equal(after.nextActions.some((action) => action.kind === "register-secret"), false);
}

function testFreshHostInstructions(root) {
  for (const [host, path] of [["agents", "AGENTS.md"], ["claude", "CLAUDE.md"], ["cursor", ".cursor/rules/api-key-case.mdc"]]) {
    const projectDir = join(root, `fresh-${host}`);
    mkdirSync(projectDir);
    const before = initializeAgentInstructions({ projectDir, packageVersion: "0.9.1", check: true, host });
    assert.equal(before.files[0].status, "missing");
    assert.deepEqual(readdirSync(projectDir), [], "--check must not create host files");
    const initialized = initializeAgentInstructions({ projectDir, packageVersion: "0.9.1", check: false, host });
    assert.deepEqual(initialized.files, [{ path, status: "created" }]);
    assert.ok(existsSync(join(projectDir, path)));
    assert.deepEqual(readdirSync(projectDir), [path.split("/")[0]], "only the explicitly selected host gets instructions");
    assert.match(readFileSync(join(projectDir, path), "utf8"), /You are the user's interface/);
  }
  const cliDir = join(root, "cli-host");
  mkdirSync(cliDir);
  const check = spawnSync(process.execPath, [cliPath, "agent-init", cliDir, "--host", "agents", "--check"], { encoding: "utf8" });
  assert.equal(check.status, 2);
  assert.equal(existsSync(join(cliDir, "AGENTS.md")), false);
  const init = spawnSync(process.execPath, [cliPath, "agent-init", cliDir, "--host", "agents"], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /schemaVersion 13/);
  const before = readFileSync(join(cliDir, "AGENTS.md"), "utf8");
  const invalid = spawnSync(process.execPath, [cliPath, "agent-init", cliDir, "--host", "unknown"], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal(readFileSync(join(cliDir, "AGENTS.md"), "utf8"), before);
  const protocol = renderAgentProtocol("0.9.1");
  assert.doesNotMatch(protocol, /Local app handoff remains pending/);
  assert.match(protocol, /Windows-only development capability/);
  assert.match(protocol, /docs\/PRIVATE_CONNECTION_TRIAL\.md/);
  assert.match(protocol, /Switching destinations within the same project\/service\/environment does not require entering a saved key again/);
  assert.match(protocol, /--destination github/);
  assert.match(protocol, /GitHub v2 always selects an already-existing, identically named GitHub Environment, including development/);
  assert.match(protocol, /All GitHub placements require fresh Human Plane approval/);
  assert.match(protocol, /legacy development target remains repository-wide/);
  assert.match(protocol, /tools\/build-local-node\.mjs <project> --entry <existing-source-entry>/);
  assert.match(protocol, /private tooling, not included in the published npm package/);
  assert.match(protocol, /Rebuilding preserves earlier artifacts and cannot clear an interrupted session/);
  assert.match(protocol, /do not run a real mail check as an automatic build test/);
  assert.match(protocol, /relative \.cjs file under dist\/ and the lifetime must be 1 through 1800 seconds/);
  assert.match(protocol, /For legacy v1 only, one project\/name slot holds one value/);
  assert.match(protocol, /same built private CLI for `connection set`, not this published npx invocation/);
  assert.match(protocol, /`connection credential save` through the same built private CLI, not a published npx version/);
  assert.match(protocol, /published 0\.9\.2 does not/);
  assert.match(protocol, /connection local inspect --service resend --env development --artifact/);
  assert.match(protocol, /connection local status --service resend --env development --json/);
  assert.match(protocol, /Only after the human authorizes the named app and its concrete effects/);
  assert.match(protocol, /Execution requires Pro and fresh native OS approval/);
  assert.match(protocol, /never automatic rerun, marker\/lock deletion/);
  assert.match(protocol, /do not promote either into generic `connection observe-application` for local/);
  assert.match(protocol, /legacy\/user\/production-key fallback/);
  assert.match(protocol, /A chat Yes\/No is not OS approval/);
  assert.match(protocol, /purchase cannot fix unsupported hosts/);
  assert.match(protocol, /not deployed/);
  assert.match(protocol, /scoped to this CLI process's OS account, home and session/);
  assert.match(protocol, /Agent sandbox can differ from a human-owned shell/);
  assert.match(protocol, /keep that same invocation and wait or poll it until exit/);
  assert.match(protocol, /do not require a chat acknowledgement merely to recover its result/);
  assert.match(protocol, /current API Key Case scan detected no required Secret names/);
  assert.match(protocol, /never conclude that the project needs no Secrets/);
  assert.match(protocol, /A name found only in \.env\.example is a declaration/);
  assert.match(protocol, /next.clerkNative is a separate native-only Clerk/);
  assert.match(protocol, /connection set --service clerk/);
  assert.match(protocol, /Do not alias Clerk to Resend/);
  assert.match(protocol, /clerkMiddleware alone does not protect resources/);
  assert.match(protocol, /connection native inspect --service resend/);
  assert.match(protocol, /Never replace it with raw `vercel env ls` or `vercel api` output/);
  assert.match(protocol, /integration-managed does not identify that integration as Resend/);
  assert.match(protocol, /Unknown means inspection failed, not that a key is missing/);
  assert.match(protocol, /A known Secret that is absent from list or next/);
  assert.match(protocol, /OS secret-store write and the local metadata\/index update/);
  assert.match(protocol, /An unused status means the current scanner found no reference/);
  assert.match(protocol, /Mention force only when the provider explicitly confirms a duplicate/);
  assert.match(protocol, /never repeat the same force operation automatically/);
  assert.match(protocol, /Existing \.env users can start by registering known keys/);
  assert.match(protocol, /human to open their own \.env and copy each value only into the Human Plane/);
  assert.match(protocol, /Registration may be the end of the requested task/);
  assert.match(protocol, /do not modify or delete the original \.env/);
  assert.match(protocol, /development and production need different values/);
  assert.match(protocol, /both cannot be stored simultaneously/);
  assert.match(protocol, /\.env, \.env\.\* \(excluding \.env\.example\)/);
  assert.match(protocol, /not because of login or Free/);
  assert.match(protocol, /Secret registration remains available and the files stay unchanged/);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runAgentSetupTests({ guidedOnly: process.argv.includes("--selected-guidance-only") });
  console.log("Agent setup and free readiness tests passed.");
}
