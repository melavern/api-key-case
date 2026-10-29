import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseTree } from "jsonc-parser";
import { ConnectionStateStore, type ConnectionEnvironment, type ConnectionObservation, type NativeApplicationFeature } from "./connection-state.js";
import { clerkNativeIntentFingerprint } from "./clerk-native.js";
import { connectionIntentFingerprint } from "./fingerprints.js";
import type { NativeInspectionResult } from "./provider-native-check.js";

export const NATIVE_OBSERVATION_VERSION = "native-app-observation-v1";
const MAX_AGE = 86_400;
type Service = "resend" | "clerk";
type Scope = NonNullable<ReturnType<typeof readScope>>;
type Recording = { status: "recorded" | "unknown"; receiptId: string | null; executed: false; permission: "none" };
const unknown = (): Recording => ({status:"unknown",receiptId:null,executed:false,permission:"none"});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only the existing non-secret linked-project file. No CLI, env/credential file or app read. */
export function readNativeDestinationSelection(projectDir: string, environment: ConnectionEnvironment): { orgId: string; projectId: string; fingerprint: string } | null {
  let fd: number | undefined;
  if (!["development", "preview", "production"].includes(environment)) return null;
  try {
    const root=realpathSync(projectDir), directory=join(root,".vercel"), path=join(directory,"project.json");
    const rootState=lstatSync(root), parent=lstatSync(directory), file=lstatSync(path);
    const same=(a:import("node:fs").Stats,b:import("node:fs").Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode&&a.nlink===b.nlink&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
    if(!rootState.isDirectory()||!parent.isDirectory()||parent.isSymbolicLink()||!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.size>64*1024)return null;
    fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    if(!same(file,fstatSync(fd))||!same(parent,lstatSync(directory))||!same(rootState,lstatSync(root)))return null;
    const bytes=Buffer.alloc(64*1024+1);let length=0,read=0;
    while(length<bytes.length&&(read=readSync(fd,bytes,length,bytes.length-length,length))>0)length+=read;
    if(length!==file.size||length>64*1024||!same(file,fstatSync(fd))||!same(file,lstatSync(path))||!same(parent,lstatSync(directory))||!same(rootState,lstatSync(root))||realpathSync(projectDir)!==root)return null;
    const content=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,length)), errors:import("jsonc-parser").ParseError[]=[];
    const tree=parseTree(content,errors,{disallowComments:true,allowTrailingComma:false});
    if(!tree||errors.length||tree.type!=="object")return null;
    const keys=(tree.children??[]).map(child=>child.children?.[0]?.value);
    if(new Set(keys).size!==keys.length)return null;
    const data=JSON.parse(content), id=/^[A-Za-z0-9_-]{1,128}$/;
    if(typeof data.orgId!=="string"||!id.test(data.orgId)||typeof data.projectId!=="string"||!id.test(data.projectId))return null;
    return {orgId:data.orgId,projectId:data.projectId,
      fingerprint:digest({version:1,projectDir:root,environment,org:data.orgId,project:data.projectId})};
  } catch {return null;} finally {if(fd!==undefined)try{closeSync(fd);}catch{/* closed result */}}
}
function destinationSelection(projectDir: string, environment: ConnectionEnvironment): string | null {
  return readNativeDestinationSelection(projectDir, environment)?.fingerprint ?? null;
}
function readScope(projectDir: string, service: Service, baseDir?: string) {
  const store=new ConnectionStateStore(projectDir,baseDir);
  const read=service==="clerk"?store.readClerkNativeIntent():store.readIntent();
  if(read.status!=="available"||read.value.service!==service||read.value.route!=="provider-native"||read.value.destination.kind!=="vercel")return null;
  return {store,intent:read.value,intentFingerprint:read.value.service==="clerk"?clerkNativeIntentFingerprint(read.value):connectionIntentFingerprint(read.value),
    destinationFingerprint:destinationSelection(projectDir,read.value.environment)};
}
function sameScope(a: Scope, b: Scope | null): boolean {
  return !!b&&a.intent.id===b.intent.id&&a.intent.updatedAt===b.intent.updatedAt&&a.intentFingerprint===b.intentFingerprint&&
    a.destinationFingerprint!==null&&a.destinationFingerprint===b.destinationFingerprint;
}
function matches(entry: ConnectionObservation, scope: Scope): boolean {
  return entry.connectionId===scope.intent.id&&entry.basis.verifierVersion===NATIVE_OBSERVATION_VERSION&&
    entry.basis.native?.service===scope.intent.service&&entry.basis.native.environment===scope.intent.environment&&
    entry.basis.native.intentRevision===scope.intent.updatedAt&&entry.basis.intentFingerprint===scope.intentFingerprint&&
    scope.destinationFingerprint!==null&&entry.basis.destinationFingerprint===scope.destinationFingerprint;
}
function timeIssue(entry: ConnectionObservation, now=Date.now()): "interrupted" | "invalid" | "expired" | null {
  if(!entry.finishedAt)return "interrupted";
  const start=Date.parse(entry.startedAt), finish=Date.parse(entry.finishedAt??""), expiry=Date.parse(entry.basis.expiresAt??"");
  if(![start,finish,expiry,now].every(Number.isFinite)||start>finish||finish>now||expiry<=start||expiry-start>MAX_AGE*1000)return "invalid";
  return expiry<=now?"expired":null;
}
function alive(entry: ConnectionObservation): boolean {return timeIssue(entry)===null;}
function latest(scope: Scope, kind: ConnectionObservation["kind"]): ConnectionObservation | null {
  const journal=scope.store.readObservations();
  if(journal.status==="unavailable")throw new Error("unavailable");
  return journal.status==="available"?[...journal.value].reverse().find(entry=>entry.connectionId===scope.intent.id&&entry.kind===kind&&entry.basis.native?.service===scope.intent.service)??null:null;
}
function validAge(seconds: number): boolean {return Number.isInteger(seconds)&&seconds>=1&&seconds<=MAX_AGE;}

/** Explicit opt-in persistence of an internally produced inspection. Never inspects a provider here. */
export function recordNativeInspection(projectDir: string, result: NativeInspectionResult, maxAgeSeconds: number, baseDir?: string): Recording {
  try {
    if(!validAge(maxAgeSeconds))return unknown();
    const scope=readScope(projectDir,result.service,baseDir);
    if(!scope||scope.intent.environment!==result.environment||!scope.destinationFingerprint)return unknown();
    if(result.status==="inspected"&&(result.intentFingerprint!==scope.intentFingerprint||result.destinationSelectionFingerprint!==scope.destinationFingerprint||
        !result.configurationFingerprint||!/^[a-f0-9]{64}$/.test(result.configurationFingerprint)))return unknown();
    const native={service:result.service,environment:result.environment,intentRevision:scope.intent.updatedAt,
      configuration:result.status==="inspected"?result.configuration:"unknown" as const,
      configurationFingerprint:result.status==="inspected"?result.configurationFingerprint:null,inspectionId:null,feature:null};
    const started=scope.store.beginObservation({kind:"destination-check",authority:"local-observed",basis:{credentialRevision:null,sourceFingerprint:null,
      intentFingerprint:scope.intentFingerprint,destinationFingerprint:scope.destinationFingerprint,verifierVersion:NATIVE_OBSERVATION_VERSION,
      expiresAt:new Date(Date.now()+maxAgeSeconds*1000).toISOString(),native}});
    if(!started.ok||!sameScope(scope,readScope(projectDir,result.service,baseDir)))return unknown();
    const present=["integration-managed","present-unmanaged"].includes(native.configuration), absent=["absent","partial"].includes(native.configuration);
    const finished=scope.store.finishObservation(started.value.id,present?"completed":absent?"failed":"unknown",present?"destination-configured":absent?"destination-not-configured":"unknown");
    return finished.ok?{...unknown(),status:"recorded",receiptId:finished.value.id}:unknown();
  } catch {return unknown();}
}

/** Records the caller's named app observation against the exact latest inspection receipt. No execution/health claim. */
export function recordNativeApplication(projectDir: string, input: {service:Service;environment:ConnectionEnvironment;inspectionId:string;
  feature:NativeApplicationFeature;observer:"agent"|"human";outcome:"passed"|"failed"|"unknown";maxAgeSeconds:number}, baseDir?: string): Recording {
  try {
    if(!validAge(input.maxAgeSeconds)||!["passed","failed","unknown"].includes(input.outcome)||!["agent","human"].includes(input.observer)||
        input.feature!==(input.service==="clerk"?"protected-access":"send-and-delivery"))return unknown();
    const scope=readScope(projectDir,input.service,baseDir);
    if(!scope||scope.intent.environment!==input.environment)return unknown();
    const inspection=latest(scope,"destination-check");
    if(!inspection||inspection.id!==input.inspectionId||!matches(inspection,scope)||!alive(inspection)||
        inspection.outcome!=="completed"||inspection.resultCode!=="destination-configured")return unknown();
    const started=scope.store.beginObservation({kind:"application-check",authority:input.observer==="human"?"human-reported":"agent-observed",basis:{...inspection.basis,
      expiresAt:new Date(Math.min(Date.now()+input.maxAgeSeconds*1000,Date.parse(inspection.basis.expiresAt!))).toISOString(),
      native:{...inspection.basis.native!,inspectionId:inspection.id,feature:input.feature}}});
    if(!started.ok||!sameScope(scope,readScope(projectDir,input.service,baseDir))||latest(scope,"destination-check")?.id!==inspection.id||!alive(inspection))return unknown();
    const finished=scope.store.finishObservation(started.value.id,input.outcome==="passed"?"completed":input.outcome==="failed"?"failed":"unknown",
      input.outcome==="passed"?"application-passed":input.outcome==="failed"?"application-failed":"unknown");
    return finished.ok?{...unknown(),status:"recorded",receiptId:finished.value.id}:unknown();
  } catch {return unknown();}
}

export interface NativeApplicationEvidence {
  service: Service; environment: ConnectionEnvironment | null;
  status: "inactive" | "missing" | "reported" | "unknown" | "stale";
  binding: "matches-local-selection" | "changed" | "unresolved";
  destination: "vercel"; destinationSelectionFingerprint: string | null;
  configuration: {receiptId:string;recordedAt:string;destinationSelectionFingerprint:string;state:NonNullable<ConnectionObservation["basis"]["native"]>["configuration"]} | null;
  application: {receiptId:string;inspectionId:string;feature:NativeApplicationFeature;outcome:"passed"|"failed"|"unknown";
    authority:"agent-observed"|"human-reported";destinationSelectionFingerprint:string;recordedAt:string;expiresAt:string} | null;
  reason: "inactive" | "inspection-missing" | "observation-unavailable" | "scope-unresolved" | "scope-changed" | "inspection-unverified" |
    "application-missing" | "observation-interrupted" | "observation-time-invalid" | "observation-expired" | "inspection-changed" | "application-reported";
  remaining: Array<"inspect-existing-native-configuration" | "observe-application-feature" | "review-recorded-failure" | "review-observation-storage" | "review-selected-target">;
  currentHealth: "unverified"; permission: "none";
}
/** Read-only historical evidence. Even matching/unexpired reports never claim current app health or generic readiness. */
export function readNativeApplicationEvidence(projectDir: string, service:Service, baseDir?:string): NativeApplicationEvidence {
  const report:NativeApplicationEvidence={service,environment:null,status:"unknown",binding:"unresolved",destination:"vercel",destinationSelectionFingerprint:null,
    configuration:null,application:null,reason:"observation-unavailable",remaining:["review-observation-storage"],currentHealth:"unverified",permission:"none"};
  try {
    const store=new ConnectionStateStore(projectDir,baseDir), selected=service==="clerk"?store.readClerkNativeIntent():store.readIntent();
    if(selected.status==="missing"||selected.status==="available"&&(selected.value.route!=="provider-native"||selected.value.destination.kind!=="vercel"))
      return {...report,status:"inactive",reason:"inactive",remaining:[]};
    const scope=readScope(projectDir,service,baseDir);if(!scope)return report;
    report.environment=scope.intent.environment;report.destinationSelectionFingerprint=scope.destinationFingerprint;
    const journal=scope.store.readObservations();if(journal.status==="unavailable")return report;
    const entries=journal.status==="available"?[...journal.value].reverse().filter(entry=>entry.connectionId===scope.intent.id&&entry.basis.native?.service===service):[];
    const inspection=entries.find(entry=>entry.kind==="destination-check")??null, application=entries.find(entry=>entry.kind==="application-check")??null;
    if(inspection)report.configuration={receiptId:inspection.id,recordedAt:inspection.startedAt,destinationSelectionFingerprint:inspection.basis.destinationFingerprint!,state:inspection.basis.native!.configuration};
    if(application)report.application={receiptId:application.id,inspectionId:application.basis.native!.inspectionId!,feature:application.basis.native!.feature!,
      outcome:application.resultCode==="application-passed"?"passed":application.resultCode==="application-failed"?"failed":"unknown",
      authority:application.authority as "agent-observed"|"human-reported",destinationSelectionFingerprint:application.basis.destinationFingerprint!,recordedAt:application.startedAt,expiresAt:application.basis.expiresAt!};
    const state=(status:NativeApplicationEvidence["status"],reason:NativeApplicationEvidence["reason"],remaining:NativeApplicationEvidence["remaining"])=>({...report,status,reason,remaining});
    if(!scope.destinationFingerprint)return state("unknown","scope-unresolved",["review-selected-target"]);
    if(!sameScope(scope,readScope(projectDir,service,baseDir))){report.binding="changed";return state("stale","scope-changed",["review-selected-target"]);}
    if(!inspection)return state("missing","inspection-missing",["inspect-existing-native-configuration"]);
    if(!matches(inspection,scope)||application&&!matches(application,scope)) {report.binding="changed";return state("stale","scope-changed",["review-selected-target"]);}
    report.binding="matches-local-selection";
    if(!inspection.finishedAt||application&&!application.finishedAt)return state("unknown","observation-interrupted",["review-observation-storage"]);
    if(timeIssue(inspection)==="invalid"||application&&timeIssue(application)==="invalid")return state("stale","observation-time-invalid",["review-observation-storage"]);
    if(!alive(inspection)||application&&!alive(application))return state("stale","observation-expired",["inspect-existing-native-configuration"]);
    if(inspection.outcome!=="completed"||inspection.resultCode!=="destination-configured")return state("unknown","inspection-unverified",["inspect-existing-native-configuration"]);
    if(!application)return state("missing","application-missing",["observe-application-feature"]);
    if(application.basis.native!.configurationFingerprint!==inspection.basis.native!.configurationFingerprint||
        application.basis.native!.configuration!==inspection.basis.native!.configuration)return state("stale","inspection-changed",["observe-application-feature"]);
    return state(application.outcome==="unknown"?"unknown":"reported","application-reported",
      application.outcome==="failed"?["review-recorded-failure"]:application.outcome==="unknown"?["observe-application-feature"]:[]);
  } catch {return report;}
}
