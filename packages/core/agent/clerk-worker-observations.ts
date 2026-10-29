import { ConnectionStateStore, type ConnectionEnvironment, type ConnectionObservation } from "./connection-state.js";
import { clerkCredentialRef } from "./connection-credential.js";
import { clerkManagedIntentFingerprint } from "./clerk-managed.js";
import { DeploymentHistory, type DeploymentReceipt } from "../deploy/history.js";
import { resolveClerkWorkerDestination } from "../deploy/snapshot.js";

const VERSION = "clerk-worker-app-observation-v1";
const MAX_AGE = 86_400;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
type Recording = {status:"recorded"|"unknown";receiptId:string|null;executed:false;permission:"none"};
const unknown = ():Recording => ({status:"unknown",receiptId:null,executed:false,permission:"none"});

/** Existing local selection/registration metadata and prepared-version history only. No vault or provider. */
function readBasis(projectDir:string,baseDir?:string) {
  const store=new ConnectionStateStore(projectDir,baseDir), selected=store.readClerkManagedIntent();
  if(selected.status!=="available")return null;
  const intent=selected.value, ref=clerkCredentialRef(projectDir,intent.environment);
  const revision=store.credentialRevision(ref), destination=resolveClerkWorkerDestination(projectDir,intent.environment);
  const history=new DeploymentHistory(projectDir,baseDir).read();
  const preparation=[...history.entries].reverse().find(entry=>entry.name==="CLERK_SECRET_KEY"&&entry.scope==="project"&&
    entry.target==="cloudflare"&&entry.env===intent.environment&&entry.connection?.service==="clerk"&&
    entry.connection.environment===intent.environment&&entry.connection.projectId===ref.projectId&&entry.preparation?.kind==="cloudflare-worker-version")??null;
  return {store,intent,intentFingerprint:clerkManagedIntentFingerprint(intent),revision,destination,history,preparation};
}
type Basis = NonNullable<ReturnType<typeof readBasis>>;
function sameBasis(left:Basis,right:Basis|null):boolean {
  return !!right&&left.intent.id===right.intent.id&&left.intent.updatedAt===right.intent.updatedAt&&left.intentFingerprint===right.intentFingerprint&&
    left.revision===right.revision&&JSON.stringify(left.destination)===JSON.stringify(right.destination)&&
    left.history.status===right.history.status&&JSON.stringify(left.preparation)===JSON.stringify(right.preparation);
}
function preparationTimeValid(entry:DeploymentReceipt):boolean {
  const start=Date.parse(entry.startedAt),finish=Date.parse(entry.finishedAt??"");
  return Number.isFinite(start)&&Number.isFinite(finish)&&start<=finish&&finish<=Date.now();
}
function basisReady(basis:Basis):boolean {
  const entry=basis.preparation, recorded=entry?.preparation?.destination;
  return basis.history.status==="available"&&!!entry&&entry.outcome==="completed"&&preparationTimeValid(entry)&&!!entry.preparation?.versionId&&
    !!recorded&&!!basis.destination&&recorded.accountId===basis.destination.accountId&&recorded.worker===basis.destination.name&&
    basis.revision!==null&&entry.connection?.credentialRevision===basis.revision&&entry.connection.intentFingerprint===basis.intentFingerprint;
}
function timeIssue(entry:ConnectionObservation):"interrupted"|"invalid"|"expired"|null {
  if(!entry.finishedAt)return "interrupted";
  const start=Date.parse(entry.startedAt),finish=Date.parse(entry.finishedAt),expiry=Date.parse(entry.basis.expiresAt??"");
  if(![start,finish,expiry].every(Number.isFinite)||start>finish||finish>Date.now()||expiry<=start||expiry-start>MAX_AGE*1000)return "invalid";
  return expiry<=Date.now()?"expired":null;
}

/** Caller observation against the exact latest prepared version. Never activation, execution or health authority. */
export function recordClerkWorkerApplication(projectDir:string,input:{service:"clerk";environment:ConnectionEnvironment;preparationId:string;
  versionId:string;feature:"protected-access";observer:"agent"|"human";outcome:"passed"|"failed"|"unknown";maxAgeSeconds:number},baseDir?:string):Recording {
  try {
    if(input.service!=="clerk"||input.feature!=="protected-access"||!UUID.test(input.preparationId)||!UUID.test(input.versionId)||
      !["agent","human"].includes(input.observer)||!["passed","failed","unknown"].includes(input.outcome)||
      !Number.isInteger(input.maxAgeSeconds)||input.maxAgeSeconds<1||input.maxAgeSeconds>MAX_AGE)return unknown();
    const basis=readBasis(projectDir,baseDir), preparation=basis?.preparation;
    if(!basis||basis.intent.environment!==input.environment||!basisReady(basis)||preparation?.id!==input.preparationId||
        preparation.preparation?.versionId!==input.versionId)return unknown();
    const begun=basis.store.beginObservation({kind:"application-check",authority:input.observer==="agent"?"agent-observed":"human-reported",
      basis:{credentialRevision:basis.revision,destinationFingerprint:preparation.destinationId,intentFingerprint:basis.intentFingerprint,
        sourceFingerprint:null,verifierVersion:VERSION,expiresAt:new Date(Date.now()+input.maxAgeSeconds*1000).toISOString(),
        managed:{environment:input.environment,intentRevision:basis.intent.updatedAt,preparationId:input.preparationId,versionId:input.versionId,
          accountId:preparation.preparation.destination!.accountId,worker:preparation.preparation.destination!.worker,feature:input.feature}}});
    if(!begun.ok||!sameBasis(basis,readBasis(projectDir,baseDir)))return unknown();
    const finished=basis.store.finishObservation(begun.value.id,input.outcome==="passed"?"completed":input.outcome==="failed"?"failed":"unknown",
      input.outcome==="passed"?"application-passed":input.outcome==="failed"?"application-failed":"unknown");
    return finished.ok?{...unknown(),status:"recorded",receiptId:finished.value.id}:unknown();
  }catch{return unknown();}
}

export interface ClerkWorkerApplicationEvidence {
  service:"clerk";route:"api-key-case-managed";destination:"cloudflare";
  status:"inactive"|"missing"|"reported"|"unknown"|"stale";
  binding:"matches-local-selection"|"changed"|"unresolved";
  selected:{environment:ConnectionEnvironment;accountId:string|null;worker:string|null}|null;
  preparation:{receiptId:string;environment:ConnectionEnvironment;accountId:string|null;worker:string|null;versionId:string|null;
    destinationFingerprint:string;recordedAt:string;finishedAt:string|null;outcome:"completed"|"incomplete"|"unknown";authority:"advisory-local-history"}|null;
  application:{receiptId:string;preparationId:string;environment:ConnectionEnvironment;accountId:string;worker:string;versionId:string;
    destinationFingerprint:string;feature:"protected-access";authority:"agent-observed"|"human-reported";outcome:"passed"|"failed"|"unknown";
    recordedAt:string;expiresAt:string;versionBinding:"caller-asserted"}|null;
  reason:"inactive"|"selection-unavailable"|"selection-changed"|"configuration-unresolved"|"preparation-unavailable"|"preparation-missing"|
    "preparation-unknown"|"prepared-target-unrecorded"|"prepared-target-changed"|"registration-unverified"|"registration-changed"|
    "application-unavailable"|"application-missing"|"application-interrupted"|"application-time-invalid"|"application-expired"|"preparation-changed"|"application-reported";
  remaining:Array<"review-selected-worker"|"review-preparation-history"|"review-credential-metadata"|"review-observation-storage"|
    "observe-protected-access"|"review-recorded-failure"|"review-version-activation">;
  activation:"not-inspected";currentHealth:"unverified";permission:"none";
}

/** Restores history only, retaining recorded and selected targets separately. No inferred activation or remote match. */
export function readClerkWorkerApplicationEvidence(projectDir:string,baseDir?:string):ClerkWorkerApplicationEvidence {
  const report:ClerkWorkerApplicationEvidence={service:"clerk",route:"api-key-case-managed",destination:"cloudflare",status:"unknown",binding:"unresolved",
    selected:null,preparation:null,application:null,reason:"selection-unavailable",remaining:["review-selected-worker"],
    activation:"not-inspected",currentHealth:"unverified",permission:"none"};
  const state=(status:ClerkWorkerApplicationEvidence["status"],reason:ClerkWorkerApplicationEvidence["reason"],remaining:ClerkWorkerApplicationEvidence["remaining"])=>({...report,status,reason,remaining});
  try {
    const store=new ConnectionStateStore(projectDir,baseDir),selected=store.readClerkManagedIntent();
    if(selected.status==="missing")return state("inactive","inactive",[]);
    const basis=readBasis(projectDir,baseDir);if(!basis)return report;
    report.selected={environment:basis.intent.environment,accountId:basis.destination?.accountId??null,worker:basis.destination?.name??null};
    const preparation=basis.preparation, destination=preparation?.preparation?.destination;
    if(preparation)report.preparation={receiptId:preparation.id,environment:preparation.env,accountId:destination?.accountId??null,worker:destination?.worker??null,
      versionId:preparation.preparation!.versionId,destinationFingerprint:preparation.destinationId,recordedAt:preparation.startedAt,
      finishedAt:preparation.finishedAt,outcome:preparation.outcome,authority:"advisory-local-history"};
    const journal=store.readObservations();
    if(journal.status==="unavailable")return state("unknown","application-unavailable",["review-observation-storage"]);
    // Last managed observation across this exact project is retained even after an environment change, but never satisfies that new scope.
    const application=journal.status==="available"?[...journal.value].reverse().find(entry=>entry.basis.managed&&entry.basis.verifierVersion===VERSION)??null:null;
    if(application){const binding=application.basis.managed!;
      report.application={receiptId:application.id,preparationId:binding.preparationId,environment:binding.environment,accountId:binding.accountId,worker:binding.worker,
        versionId:binding.versionId,destinationFingerprint:application.basis.destinationFingerprint!,feature:binding.feature,
        authority:application.authority as "agent-observed"|"human-reported",outcome:application.resultCode==="application-passed"?"passed":application.resultCode==="application-failed"?"failed":"unknown",
        recordedAt:application.startedAt,expiresAt:application.basis.expiresAt!,versionBinding:"caller-asserted"};}
    if(!sameBasis(basis,readBasis(projectDir,baseDir))){report.binding="changed";return state("stale","selection-changed",["review-selected-worker"]);}
    if(application&&(application.connectionId!==basis.intent.id||application.basis.managed!.environment!==basis.intent.environment||
      application.basis.managed!.intentRevision!==basis.intent.updatedAt||application.basis.intentFingerprint!==basis.intentFingerprint)){
      report.binding="changed";return state("stale","selection-changed",["review-selected-worker"]);}
    if(basis.history.status==="unavailable")return state("unknown","preparation-unavailable",["review-preparation-history"]);
    if(!preparation)return state("missing","preparation-missing",["review-preparation-history"]);
    if(preparation.outcome!=="completed"||!preparationTimeValid(preparation)||!preparation.preparation?.versionId)return state("unknown","preparation-unknown",["review-preparation-history"]);
    if(!destination)return state("unknown","prepared-target-unrecorded",["review-preparation-history"]);
    if(!basis.destination)return state("unknown","configuration-unresolved",["review-selected-worker"]);
    if(destination.accountId!==basis.destination.accountId||destination.worker!==basis.destination.name){report.binding="changed";return state("stale","prepared-target-changed",["review-selected-worker"]);}
    if(!basis.revision)return state("unknown","registration-unverified",["review-credential-metadata"]);
    if(preparation.connection?.credentialRevision!==basis.revision||preparation.connection.intentFingerprint!==basis.intentFingerprint)return state("stale","registration-changed",["review-credential-metadata"]);
    report.binding="matches-local-selection";
    if(!application)return state("missing","application-missing",["observe-protected-access","review-version-activation"]);
    const binding=application.basis.managed!;
    if(binding.preparationId!==preparation.id||binding.versionId!==preparation.preparation.versionId||binding.accountId!==destination.accountId||binding.worker!==destination.worker||
      application.basis.destinationFingerprint!==preparation.destinationId||application.basis.credentialRevision!==basis.revision)return state("stale","preparation-changed",["review-preparation-history"]);
    const time=timeIssue(application);
    if(time==="interrupted")return state("unknown","application-interrupted",["review-observation-storage"]);
    if(time==="invalid")return state("stale","application-time-invalid",["review-observation-storage"]);
    if(time==="expired")return state("stale","application-expired",["observe-protected-access","review-version-activation"]);
    return state(application.outcome==="unknown"?"unknown":"reported","application-reported",
      application.outcome==="failed"?["review-recorded-failure","review-version-activation"]:
        application.outcome==="unknown"?["observe-protected-access","review-version-activation"]:["review-version-activation"]);
  }catch{return report;}
}
