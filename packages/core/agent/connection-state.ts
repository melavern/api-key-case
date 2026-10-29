import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertConnectionCredentialRef, canonicalProjectRealpath, deriveProjectId } from "../vault/naming.js";

import type { ConnectionCredentialRef } from "../vault/types.js";
import type { LocalPreparationIdentity } from "../local/snapshot.js";

const LIMIT = 200;
const MAX_BYTES = 256 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type ConnectionEnvironment = "development" | "preview" | "production";
export type ConnectionRoute = "provider-native" | "api-key-case-managed" | "manual";
export type ConnectionDestinationKind = "local" | "vercel" | "cloudflare" | "github" | "manual";
export type ConnectionObservationKind =
  | "credential-validation" | "destination-check" | "send-capability-check" | "application-check";
export type ConnectionObservationAuthority =
  | "provider-observed" | "local-observed" | "agent-observed" | "human-reported";
export type ConnectionObservationOutcome = "completed" | "failed" | "unknown";
export type NativeApplicationFeature = "protected-access" | "send-and-delivery";
export interface NativeObservationBinding {
  service: "resend" | "clerk";
  environment: ConnectionEnvironment;
  intentRevision: string;
  configuration: "integration-managed" | "present-unmanaged" | "absent" | "partial" | "unknown";
  configurationFingerprint: string | null;
  inspectionId: string | null;
  feature: NativeApplicationFeature | null;
}
export interface ClerkWorkerObservationBinding {
  environment: ConnectionEnvironment;
  intentRevision: string;
  preparationId: string;
  versionId: string;
  accountId: string;
  worker: string;
  feature: "protected-access";
}
export type ConnectionResultCode =
  | "valid-full-access" | "valid-sending-access" | "invalid-credential"
  | "cli-unavailable" | "network-unavailable" | "unexpected-output" | "unknown"
  | "destination-configured" | "destination-not-configured" | "destination-changed"
  | "send-capable" | "send-not-capable" | "application-passed" | "application-failed";

export interface ConnectionIntent {
  id: string;
  service: "resend";
  environment: ConnectionEnvironment;
  slot: "default";
  route: ConnectionRoute;
  /** Resend/Vercel provider-native enrollment choice; absent in legacy v1 records. */
  nativeEnrollment?: NativeEnrollmentMethod;
  destination: { kind: ConnectionDestinationKind };
  sendingDomain: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NativeEnrollmentMethod = "resend-vercel-integration" | "resend-vercel-marketplace";

export type ConnectionIntentInput = Pick<ConnectionIntent,
  "service" | "environment" | "route" | "destination" | "sendingDomain" | "nativeEnrollment">;

/** Native-only Clerk profile. It is never a vault or local-execution request. */
export interface ClerkNativeIntent extends Omit<ConnectionIntent, "service" | "route" | "nativeEnrollment" | "destination" | "sendingDomain"> {
  service: "clerk";
  route: "provider-native";
  destination: { kind: "vercel" };
  sendingDomain: null;
}
export type ClerkNativeIntentInput = Pick<ClerkNativeIntent, "service" | "environment" | "route" | "destination" | "sendingDomain">;
export interface ClerkManagedIntent extends Omit<ClerkNativeIntent, "route" | "destination"> {
  route: "api-key-case-managed";
  destination: {kind:"cloudflare"};
}
export type ClerkManagedIntentInput = Pick<ClerkManagedIntent, "service" | "environment" | "route" | "destination" | "sendingDomain">;

/** Closed hosted selections only; never Resend app/local/provider-check inputs. */
export type ProviderHostedService = "openai" | "stripe-test";
export interface OpenAIHostedIntent extends Omit<ConnectionIntent, "service" | "route" | "nativeEnrollment" | "destination" | "sendingDomain"> {
  service: "openai";
  route: "api-key-case-managed";
  destination: { kind: "vercel" | "cloudflare" };
  sendingDomain: null;
}
export interface StripeTestHostedIntent extends Omit<OpenAIHostedIntent, "service" | "environment"> {
  service: "stripe-test";
  environment: "development" | "preview";
}
export type ProviderHostedIntent = OpenAIHostedIntent | StripeTestHostedIntent;
export type ProviderHostedIntentInput =
  Pick<OpenAIHostedIntent, "service" | "environment" | "route" | "destination" | "sendingDomain"> |
  Pick<StripeTestHostedIntent, "service" | "environment" | "route" | "destination" | "sendingDomain">;

/** One advisory last-recorded selection per known profile/environment, never a journal. */
export type ConnectionIntentProfile = "resend" | "clerk-native" | "clerk-managed" | "provider-openai" | "provider-stripe-test";
export type RememberedConnectionIntent = ConnectionIntent | ClerkNativeIntent | ClerkManagedIntent | ProviderHostedIntent;
type IntentHistoryEntry = { profile: ConnectionIntentProfile; intent: RememberedConnectionIntent; recordedAt: string };
type IntentHistory = { schemaVersion: 1; entries: IntentHistoryEntry[] };
export interface ConnectionResumeInput {
  service: "resend" | "clerk" | ProviderHostedService;
  environment: ConnectionEnvironment;
  route: ConnectionRoute;
}
export type ConnectionResumePlanInput = ConnectionResumeInput |
  { service: "resend"; environment: ConnectionEnvironment; route?: undefined };
export interface ConnectionResumeReport {
  service: ConnectionResumeInput["service"] | null;
  environment: ConnectionEnvironment | null;
  route: ConnectionRoute | null;
  schemaVersion: 1;
  projectId: string;
  profile: ConnectionIntentProfile | null;
  status: "ready" | "unchanged" | "applied" | "blocked";
  issue: ConnectionMetadataIssue | "not-recorded" | "route-mismatch" | "stale-plan" | null;
  current: RememberedConnectionIntent | null;
  remembered: RememberedConnectionIntent | null;
  source: "current" | "last-recorded" | null;
  recordedAt: string | null;
  fingerprint: string | null;
  permission: "none";
  providerOperation: false;
}

export interface ConnectionObservation {
  id: string;
  connectionId: string;
  kind: ConnectionObservationKind;
  authority: ConnectionObservationAuthority;
  outcome: ConnectionObservationOutcome;
  startedAt: string;
  finishedAt: string | null;
  basis: {
    credentialRevision: string | null;
    destinationFingerprint: string | null;
    /** Missing only on observations written before intent binding was added. */
    intentFingerprint: string | null | undefined;
    sourceFingerprint: string | null;
    verifierVersion: string;
    /** Versioned advisory application receipt; never execution authority. */
    planFingerprint?: string | null;
    expiresAt?: string;
    configurationObserved?: boolean;
    /** Advisory native evidence in the existing journal; never current health or authority to execute. */
    native?: NativeObservationBinding;
    /** Named caller observation of a prepared Clerk Worker version, never deployment/health evidence. */
    managed?: ClerkWorkerObservationBinding;
  };
  resultCode: ConnectionResultCode | null;
}

type CredentialMetadata = ConnectionCredentialRef & {
  createdAt: string;
  updatedAt: string;
  state: "pending" | "settled";
};
type CredentialMetadataFile = `credential-${ConnectionEnvironment}.json` | `credential-${"clerk" | "openai" | "stripe-test"}-${ConnectionEnvironment}.json`;
type ProviderHostedMetadataFile = "provider-openai.json" | "provider-stripe-test.json";
type MetadataFile = "intent-history.json" | "clerk-managed.json" | "clerk-native.json" | "state.json" | "observations.json" | "local-session.json" | CredentialMetadataFile | ProviderHostedMetadataFile;

export interface LocalPreparationReceipt {
  id: string;
  connectionId: string;
  intentRevision: string;
  credentialRevision: string;
  artifact: string;
  maxDurationMs: number;
  inspectedAt: string;
  expiresAt: string;
  metadataIdentity: LocalPreparationIdentity;
}
type Journal = { schemaVersion: 1; entries: ConnectionObservation[]; localPreparation?: LocalPreparationReceipt };
export type ConnectionMetadataIssue = "not-created" | "lock-present" | "temporary-file-present" |
  "invalid-data" | "unsupported-schema" | "unsafe-path" | "too-large" | "access-denied" |
  "read-only-storage" | "storage-full" | "path-unavailable" | "record-unavailable" | "io-error";
type ReadResult<T> = { status: "available"; issue: null; value: T } |
  { status: "missing"; issue: "not-created"; value: null } |
  { status: "unavailable"; issue: ConnectionMetadataIssue; value: null };
type WriteResult<T> = { ok: true; issue: null; value: T } |
  { ok: false; issue: ConnectionMetadataIssue; value: null };

export type LocalSessionOutcome = "unknown" | "exited" | "failed" | "cancelled" | "expired" | "changed";
export interface LocalSessionReceipt {
  attemptId: string;
  connectionId: string;
  credentialRevision: string;
  startedAt: string;
  finishedAt: string | null;
  maxDurationMs: number;
  outcome: LocalSessionOutcome;
  /** New attempts only. Opaque and unrelated to source/artifact bytes. */
  executionBasisId?: string;
  intentRevision?: string;
  execution?: "not-started" | "possible";
  treeTermination?: "not-needed" | "confirmed" | "unknown";
}
export type LocalSessionCompletionFailure = {
  phase: "result-save" | "lock-release";
  issue: ConnectionMetadataIssue;
};
export type LocalSessionObservation = {
  recordedAt: string;
} & ({ authority: "agent-observed"; outcome: "passed" | "failed" | "unknown" } |
     { authority: "human-reported"; outcome: "received" | "not-received" | "unknown" });
export interface LocalSessionHistoryEntry {
  receipt: LocalSessionReceipt;
  observations: LocalSessionObservation[];
}
export type LocalSessionObservationInput = {
  service: "resend";
  environment: "development";
  attemptId: string;
  executionBasisId: string;
  credentialRevision: string;
} & Pick<LocalSessionObservation, "authority" | "outcome">;
type LocalSessionRecord = LocalSessionHistoryEntry & {
  schemaVersion: 1 | 2;
  history: LocalSessionHistoryEntry[];
};
const LOCAL_HISTORY_LIMIT = 20;
const LOCAL_OBSERVATION_LIMIT = 20;

function validLocalObservation(value: unknown): value is LocalSessionObservation {
  return object(value) && exactKeys(value, ["recordedAt", "authority", "outcome"]) && timestamp(value.recordedAt) &&
    (value.authority === "agent-observed" ? includes(["passed", "failed", "unknown"] as const, value.outcome) :
      value.authority === "human-reported" && includes(["received", "not-received", "unknown"] as const, value.outcome));
}
function validLocalReceipt(value: unknown, projectPath: string, bound: boolean): value is LocalSessionReceipt {
  if (!object(value) || !exactKeys(value, ["attemptId", "connectionId", "credentialRevision", "startedAt", "finishedAt", "maxDurationMs", "outcome",
      ...(bound ? ["executionBasisId", "intentRevision", "execution", "treeTermination"] : [])])) return false;
  return typeof value.attemptId === "string" && UUID.test(value.attemptId) &&
    value.connectionId === connectionIdForPath(projectPath, "development") &&
    timestamp(value.credentialRevision) && timestamp(value.startedAt) &&
    (value.finishedAt === null ? value.outcome === "unknown" : timestamp(value.finishedAt) && (!bound || value.finishedAt >= value.startedAt)) &&
    Number.isInteger(value.maxDurationMs) && Number(value.maxDurationMs) >= 1000 && Number(value.maxDurationMs) <= 1800000 &&
    includes(["unknown", "exited", "failed", "cancelled", "expired", "changed"] as const, value.outcome) &&
    (!bound || (typeof value.executionBasisId === "string" && UUID.test(value.executionBasisId) && timestamp(value.intentRevision) &&
      includes(["not-started", "possible"] as const, value.execution) && includes(["not-needed", "confirmed", "unknown"] as const, value.treeTermination)));
}
function observableLocalReceipt(receipt: LocalSessionReceipt): boolean {
  return Boolean(receipt.executionBasisId && receipt.finishedAt && ["exited", "failed"].includes(receipt.outcome) &&
    receipt.execution === "possible" && receipt.treeTermination === "confirmed");
}
function validLocalHistory(value: unknown, projectPath: string): value is LocalSessionHistoryEntry {
  return object(value) && exactKeys(value, ["receipt", "observations"]) && validLocalReceipt(value.receipt, projectPath, true) &&
    Array.isArray(value.observations) && value.observations.length <= LOCAL_OBSERVATION_LIMIT &&
    value.observations.every(entry => validLocalObservation(entry) && observableLocalReceipt(value.receipt as LocalSessionReceipt) &&
      entry.recordedAt >= (value.receipt as LocalSessionReceipt).finishedAt!);
}

type ObjectValue = Record<string, unknown>;
class ConnectionStorageError extends Error {
  constructor(readonly issue: ConnectionMetadataIssue) { super("Connection metadata is unavailable."); }
}

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: ObjectValue, keys: string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && DATE.test(value) && Number.isFinite(Date.parse(value));
}
function validLocalPreparation(value: unknown, projectPath: string): value is LocalPreparationReceipt {
  return object(value) && exactKeys(value, ["id", "connectionId", "intentRevision", "credentialRevision", "artifact", "maxDurationMs", "inspectedAt", "expiresAt", "metadataIdentity"]) &&
    typeof value.id === "string" && UUID.test(value.id) && value.connectionId === connectionIdForPath(projectPath, "development") &&
    timestamp(value.intentRevision) && timestamp(value.credentialRevision) && timestamp(value.inspectedAt) && timestamp(value.expiresAt) &&
    Number.isInteger(value.maxDurationMs) && Number(value.maxDurationMs) >= 1000 && Number(value.maxDurationMs) <= 1800000 &&
    Date.parse(value.expiresAt) - Date.parse(value.inspectedAt) === value.maxDurationMs &&
    typeof value.artifact === "string" && value.artifact.length <= 1024 && /^dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.cjs$/.test(value.artifact) &&
    object(value.metadataIdentity) && exactKeys(value.metadataIdentity, ["project", "inputs", "artifact", "runtime"]) &&
    Object.values(value.metadataIdentity).every(part => typeof part === "string" && SHA256.test(part));
}
function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}
function fileModeOk(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o777) === 0o600;
}
function directoryModeOk(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o777) === 0o700;
}
function absent(error: unknown): boolean {
  return object(error) && error.code === "ENOENT";
}
function errorIssue(error: unknown): ConnectionMetadataIssue {
  if (error instanceof ConnectionStorageError) return error.issue;
  const code = object(error) ? error.code : null;
  if (code === "EACCES" || code === "EPERM") return "access-denied";
  if (code === "EROFS") return "read-only-storage";
  if (code === "ENOSPC" || code === "EDQUOT") return "storage-full";
  if (code === "ENOENT") return "path-unavailable";
  if (code === "ENOTDIR" || code === "ELOOP") return "unsafe-path";
  return "io-error";
}

function connectionIdForPath(projectPath: string, environment: ConnectionEnvironment): string {
  return createHash("sha256")
    .update(`${projectPath}\nresend\n${environment}\ndefault`)
    .digest("hex");
}

export function deriveConnectionId(projectDir: string, environment: ConnectionEnvironment): string {
  return connectionIdForPath(canonicalProjectRealpath(projectDir), environment);
}

function clerkNativeId(projectPath: string, environment: ConnectionEnvironment): string {
  return createHash("sha256").update(`${projectPath}\nclerk\n${environment}\ndefault`).digest("hex");
}
function validClerkNativeInput(value: unknown): value is ClerkNativeIntentInput {
  return object(value) && exactKeys(value, ["service", "environment", "route", "destination", "sendingDomain"]) &&
    value.service === "clerk" && includes(["development", "preview", "production"] as const, value.environment) &&
    value.route === "provider-native" && value.sendingDomain === null && object(value.destination) &&
    exactKeys(value.destination, ["kind"]) && value.destination.kind === "vercel";
}
function validClerkNativeIntent(value: unknown, projectPath: string): value is ClerkNativeIntent {
  if (!object(value) || !exactKeys(value, ["id", "service", "environment", "slot", "route", "destination", "sendingDomain", "createdAt", "updatedAt"])) return false;
  return validClerkNativeInput({service:value.service,environment:value.environment,route:value.route,destination:value.destination,sendingDomain:value.sendingDomain}) &&
    value.id === clerkNativeId(projectPath, value.environment as ConnectionEnvironment) && value.slot === "default" &&
    timestamp(value.createdAt) && timestamp(value.updatedAt);
}

function validClerkManagedInput(value: unknown): value is ClerkManagedIntentInput {
  return object(value) && exactKeys(value, ["service", "environment", "route", "destination", "sendingDomain"]) &&
    value.service === "clerk" && includes(["development", "preview", "production"] as const, value.environment) &&
    value.route === "api-key-case-managed" && value.sendingDomain === null && object(value.destination) &&
    exactKeys(value.destination, ["kind"]) && value.destination.kind === "cloudflare";
}
function validClerkManagedIntent(value: unknown, projectPath: string): value is ClerkManagedIntent {
  if (!object(value) || !exactKeys(value, ["id", "service", "environment", "slot", "route", "destination", "sendingDomain", "createdAt", "updatedAt"])) return false;
  return validClerkManagedInput({service:value.service,environment:value.environment,route:value.route,destination:value.destination,sendingDomain:value.sendingDomain}) &&
    value.id === clerkNativeId(projectPath, value.environment as ConnectionEnvironment) && value.slot === "default" &&
    timestamp(value.createdAt) && timestamp(value.updatedAt);
}

function providerHostedService(value: unknown): value is ProviderHostedService {
  return value === "openai" || value === "stripe-test";
}
function providerHostedFile(service: ProviderHostedService): ProviderHostedMetadataFile {
  return service === "openai" ? "provider-openai.json" : "provider-stripe-test.json";
}
function providerHostedId(projectPath: string, service: ProviderHostedService, environment: ConnectionEnvironment): string {
  return createHash("sha256").update(`${projectPath}\n${service}\n${environment}\ndefault`).digest("hex");
}
function validProviderHostedInput(value: unknown): value is ProviderHostedIntentInput {
  return object(value) && exactKeys(value, ["service", "environment", "route", "destination", "sendingDomain"]) &&
    providerHostedService(value.service) && includes(["development", "preview", "production"] as const, value.environment) &&
    (value.service !== "stripe-test" || value.environment !== "production") &&
    value.route === "api-key-case-managed" && value.sendingDomain === null && object(value.destination) &&
    exactKeys(value.destination, ["kind"]) && includes(["vercel", "cloudflare"] as const, value.destination.kind);
}
function validProviderHostedIntent(value: unknown, projectPath: string, service: ProviderHostedService): value is ProviderHostedIntent {
  if (!object(value) || !exactKeys(value, ["id", "service", "environment", "slot", "route", "destination", "sendingDomain", "createdAt", "updatedAt"])) return false;
  return value.service === service &&
    validProviderHostedInput({ service: value.service, environment: value.environment, route: value.route, destination: value.destination, sendingDomain: value.sendingDomain }) &&
    value.id === providerHostedId(projectPath, service, value.environment as ConnectionEnvironment) && value.slot === "default" &&
    timestamp(value.createdAt) && timestamp(value.updatedAt) && value.updatedAt >= value.createdAt;
}

function validDomain(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DOMAIN.test(value));
}

function validIntent(value: unknown, projectPath: string): value is ConnectionIntent {
  const v1 = object(value) && exactKeys(value, ["id", "service", "environment", "slot", "route", "destination",
    "sendingDomain", "createdAt", "updatedAt"]);
  const v2 = object(value) && exactKeys(value, ["id", "service", "environment", "slot", "route", "nativeEnrollment", "destination",
    "sendingDomain", "createdAt", "updatedAt"]);
  if (!object(value) || (!v1 && !v2)) return false;
  if (!object(value.destination) || !exactKeys(value.destination, ["kind"])) return false;
  if (v2 && (!includes(["resend-vercel-integration", "resend-vercel-marketplace"] as const, value.nativeEnrollment) ||
      value.service !== "resend" || value.route !== "provider-native" || value.destination.kind !== "vercel")) return false;
  return value.id === connectionIdForPath(projectPath, value.environment as ConnectionEnvironment) &&
    includes(["development", "preview", "production"] as const, value.environment) &&
    value.service === "resend" && value.slot === "default" &&
    includes(["provider-native", "api-key-case-managed", "manual"] as const, value.route) &&
    includes(["local", "vercel", "cloudflare", "github", "manual"] as const, value.destination.kind) &&
    validDomain(value.sendingDomain) && timestamp(value.createdAt) && timestamp(value.updatedAt);
}

function intentProfile(intent: RememberedConnectionIntent | ConnectionResumePlanInput): ConnectionIntentProfile {
  return intent.service === "openai" ? "provider-openai" : intent.service === "stripe-test" ? "provider-stripe-test" :
    intent.service === "resend" ? "resend" : intent.route === "provider-native" ? "clerk-native" : "clerk-managed";
}
function profileFile(profile: ConnectionIntentProfile): MetadataFile {
  return profile === "provider-openai" ? "provider-openai.json" : profile === "provider-stripe-test" ? "provider-stripe-test.json" :
    profile === "resend" ? "state.json" : profile === "clerk-native" ? "clerk-native.json" : "clerk-managed.json";
}
function validResumeInput(value: unknown, allowRecordedRoute = false): value is ConnectionResumePlanInput {
  const recordedRoute = allowRecordedRoute && object(value) && value.service === "resend" && exactKeys(value, ["service", "environment"]);
  return object(value) && (exactKeys(value, ["service", "environment", "route"]) || recordedRoute) &&
    includes(["resend", "clerk", "openai", "stripe-test"] as const, value.service) &&
    includes(["development", "preview", "production"] as const, value.environment) &&
    (includes(["provider-native", "api-key-case-managed", "manual"] as const, value.route) || recordedRoute) &&
    (value.service === "resend" || (value.service === "clerk" ? value.route !== "manual" : value.route === "api-key-case-managed")) &&
    (value.service !== "stripe-test" || value.environment !== "production");
}
function sameIntentSelection(a: RememberedConnectionIntent, b: RememberedConnectionIntent): boolean {
  return a.service === b.service && a.environment === b.environment && a.route === b.route &&
    a.destination.kind === b.destination.kind && a.sendingDomain === b.sendingDomain &&
    (a.service !== "resend" || b.service !== "resend" || a.nativeEnrollment === b.nativeEnrollment);
}

function intentFile(intent: RememberedConnectionIntent | ConnectionIntent): { schemaVersion: 1 | 2; intent: RememberedConnectionIntent | ConnectionIntent } {
  return { schemaVersion: intent.service === "resend" && intent.nativeEnrollment ? 2 : 1, intent };
}

function allowedCodes(kind: ConnectionObservationKind): readonly ConnectionResultCode[] {
  switch (kind) {
    case "credential-validation":
      return ["valid-full-access", "valid-sending-access", "invalid-credential", "cli-unavailable",
        "network-unavailable", "unexpected-output", "unknown"];
    case "destination-check":
      return ["destination-configured", "destination-not-configured", "destination-changed", "unknown"];
    case "send-capability-check": return ["send-capable", "send-not-capable", "unknown"];
    case "application-check": return ["application-passed", "application-failed", "unknown"];
  }
}

function authorityMatches(kind: ConnectionObservationKind, authority: ConnectionObservationAuthority): boolean {
  if (kind === "credential-validation" || kind === "send-capability-check") return authority === "provider-observed";
  if (kind === "destination-check") return authority === "provider-observed" || authority === "local-observed";
  return authority === "agent-observed" || authority === "human-reported";
}

function outcomeMatches(kind: ConnectionObservationKind, outcome: ConnectionObservationOutcome,
  resultCode: ConnectionResultCode): boolean {
  if (resultCode === "unknown") return outcome === "unknown";
  if (kind === "credential-validation") {
    if (["valid-full-access", "valid-sending-access"].includes(resultCode)) return outcome === "completed";
    if (resultCode === "invalid-credential") return outcome === "failed";
    return outcome === "unknown";
  }
  if (kind === "destination-check") {
    if (resultCode === "destination-configured") return outcome === "completed";
    if (["destination-not-configured", "destination-changed"].includes(resultCode)) return outcome === "failed";
    return outcome === "unknown";
  }
  if (kind === "send-capability-check") {
    if (resultCode === "send-capable") return outcome === "completed";
    if (resultCode === "send-not-capable") return outcome === "failed";
    return outcome === "unknown";
  }
  if (resultCode === "application-passed") return outcome === "completed";
  if (resultCode === "application-failed") return outcome === "failed";
  return outcome === "unknown";
}

function validObservation(value: unknown): value is ConnectionObservation {
  if (!object(value) || !exactKeys(value, ["id", "connectionId", "kind", "authority", "outcome", "startedAt",
    "finishedAt", "basis", "resultCode"])) return false;
  if (!object(value.basis)) return false;
  const legacyBasis = exactKeys(value.basis, ["credentialRevision", "destinationFingerprint", "sourceFingerprint", "verifierVersion"]);
  const currentBasis = exactKeys(value.basis, ["credentialRevision", "destinationFingerprint", "intentFingerprint",
    "sourceFingerprint", "verifierVersion"]);
  const applicationBasis = validApplicationBasis(value.basis);
  const nativeBasis = validNativeObservationBasis(value.basis);
  const managedBasis = validClerkWorkerObservationBasis(value.basis);
  if (!legacyBasis && !currentBasis && !applicationBasis && !nativeBasis && !managedBasis) return false;
  if (applicationBasis && (value.kind !== "application-check" || value.authority !== "agent-observed")) return false;
  if (nativeBasis && !nativeObservationRole(value.kind, value.authority, value.basis)) return false;
  if (managedBasis && !clerkWorkerObservationRole(value.kind,value.authority)) return false;
  if (!includes(["credential-validation", "destination-check", "send-capability-check", "application-check"] as const, value.kind) ||
      !includes(["provider-observed", "local-observed", "agent-observed", "human-reported"] as const, value.authority) ||
      !authorityMatches(value.kind, value.authority) || !includes(["completed", "failed", "unknown"] as const, value.outcome)) return false;
  const result = value.resultCode === null ||
    (typeof value.resultCode === "string" && includes(allowedCodes(value.kind), value.resultCode));
  const unfinished = value.finishedAt === null && value.outcome === "unknown" && value.resultCode === null;
  const finished = timestamp(value.finishedAt) && typeof value.resultCode === "string" &&
    includes(allowedCodes(value.kind), value.resultCode) &&
    outcomeMatches(value.kind, value.outcome, value.resultCode);
  return typeof value.id === "string" && UUID.test(value.id) && typeof value.connectionId === "string" && SHA256.test(value.connectionId) &&
    timestamp(value.startedAt) && (unfinished || finished) && result &&
    (value.basis.credentialRevision === null || timestamp(value.basis.credentialRevision)) &&
    (value.basis.destinationFingerprint === null || (typeof value.basis.destinationFingerprint === "string" && SHA256.test(value.basis.destinationFingerprint))) &&
    (legacyBasis || value.basis.intentFingerprint === null ||
      (typeof value.basis.intentFingerprint === "string" && SHA256.test(value.basis.intentFingerprint))) &&
    (value.basis.sourceFingerprint === null || (typeof value.basis.sourceFingerprint === "string" && SHA256.test(value.basis.sourceFingerprint))) &&
    typeof value.basis.verifierVersion === "string" && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(value.basis.verifierVersion);
}

function readJson(path: string): unknown {
  let before;
  try { before = lstatSync(path); }
  catch (error) { throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new ConnectionStorageError("unsafe-path");
  if (!fileModeOk(before.mode)) throw new ConnectionStorageError("unsafe-path");
  if (before.size > MAX_BYTES) throw new ConnectionStorageError("too-large");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || !fileModeOk(opened.mode)) {
      throw new ConnectionStorageError("unsafe-path");
    }
    if (opened.size > MAX_BYTES) throw new ConnectionStorageError("too-large");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > MAX_BYTES) throw new ConnectionStorageError("too-large");
    try { return JSON.parse(buffer.subarray(0, bytes).toString("utf8")); }
    catch { throw new ConnectionStorageError("invalid-data"); }
  } finally { closeSync(fd); }
}

function directory(path: string, create: boolean): void {
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (!object(error) || error.code !== "EEXIST") throw error; }
  }

  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new ConnectionStorageError("unsafe-path");
  }

  if (process.platform === "win32") return;

  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    let opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.ino !== before.ino || opened.dev !== before.dev) {
      throw new ConnectionStorageError("unsafe-path");
    }

    // Older API Key Case versions could leave ~/.api-key-case at the host
    // umask's broader mode (commonly 0755). Tighten only a verified, ordinary
    // directory during a write path; reads never mutate permissions.
    if (create && !directoryModeOk(opened.mode)) {
      fchmodSync(fd, 0o700);
      opened = fstatSync(fd);
    }

    if (!directoryModeOk(opened.mode)) {
      throw new ConnectionStorageError("unsafe-path");
    }
  } finally {
    closeSync(fd);
  }
}

function requireAbsent(path: string, issue: ConnectionMetadataIssue): void {
  try { lstatSync(path); }
  catch (error) { if (absent(error)) return; throw error; }
  throw new ConnectionStorageError(issue);
}
function readCredentialAt(dir: string, ref: ConnectionCredentialRef, name: CredentialMetadataFile): CredentialMetadata | null {
  let parsed: unknown;
  try { parsed = readJson(join(dir, name)); }
  catch (error) { if (absent(error)) return null; throw error; }
  if (!object(parsed) || !exactKeys(parsed, ["schemaVersion", "credential"]) || parsed.schemaVersion !== 1 ||
      !object(parsed.credential)) throw new ConnectionStorageError("invalid-data");
  const item = parsed.credential;
  if (!exactKeys(item, ["name", "scope", "projectId", "service", "environment", "createdAt", "updatedAt", "state"]) ||
      item.name !== ref.name || item.scope !== ref.scope || item.projectId !== ref.projectId ||
      item.service !== ref.service || item.environment !== ref.environment || !timestamp(item.createdAt) ||
      !timestamp(item.updatedAt) || !includes(["pending", "settled"] as const, item.state)) {
    throw new ConnectionStorageError("invalid-data");
  }
  return item as unknown as CredentialMetadata;
}
/** Read an exact legacy v2 metadata namespace after its source directory moved.
 * The original account ID stays fixed; this never reads a credential value. */
export function readHistoricalCredentialRegistration(ref: ConnectionCredentialRef, baseDir: string): ReadResult<{ state: "pending" | "settled"; revision: string }> {
  try {
    assertConnectionCredentialRef(ref);
    const app = join(realpathSync.native(baseDir), ".api-key-case"), root = join(app, "connections");
    directory(app, false); directory(root, false);
    const names = readdirSync(root);
    if (names.length > 8192) throw new ConnectionStorageError("too-large");
    const matches = names.filter(n => SHA256.test(n) && n.startsWith(ref.projectId));
    if (matches.length === 0) return { status: "missing", issue: "not-created", value: null };
    if (matches.length !== 1) throw new ConnectionStorageError("record-unavailable");
    const dir = join(root, matches[0]); directory(dir, false);
    const name: CredentialMetadataFile = ref.service === "resend" ? `credential-${ref.environment}.json` : `credential-${ref.service}-${ref.environment}.json`;
    requireAbsent(join(dir, "lock"), "lock-present");
    requireAbsent(join(dir, `${name}.tmp`), "temporary-file-present");
    requireAbsent(join(dir, `${name}.lock`), "lock-present");
    const credential = readCredentialAt(dir, ref, name);
    return credential ? { status: "available", issue: null, value: { state: credential.state, revision: credential.updatedAt } } :
      { status: "missing", issue: "not-created", value: null };
  } catch (error) {
    return absent(error) ? { status: "missing", issue: "not-created", value: null } :
      { status: "unavailable", issue: "record-unavailable", value: null };
  }
}

export class ConnectionStateStore {
  private readonly projectPath: string;
  private readonly projectHash: string;
  private readonly resumeProjectId: string;
  private readonly resumeProjectIdentity: { dev: number; ino: number; birthtimeMs: number };
  private readonly home: string;
  private localSessionLock: { path: string; ino: number; dev: number; birthtimeMs: number; ctimeMs: number } | null = null;
  private localSessionReceipt: Readonly<LocalSessionReceipt> | null = null;
  private localSessionCompletion: { receipt: Readonly<LocalSessionReceipt>; ownershipReleased: boolean } | null = null;
  private localCompletionFailure: LocalSessionCompletionFailure | null = null;
  private readonly credentialLocks = new Map<string, { path: string; ino: number; dev: number }>();

  /** baseDir is test-only; the CLI and environment cannot redirect metadata. */
  constructor(projectDir: string, baseDir?: string) {
    this.projectPath = canonicalProjectRealpath(projectDir);
    this.projectHash = createHash("sha256").update(this.projectPath).digest("hex");
    this.resumeProjectId = this.projectHash.slice(0, 16);
    const project = lstatSync(this.projectPath);
    this.resumeProjectIdentity = { dev: project.dev, ino: project.ino, birthtimeMs: project.birthtimeMs };
    this.home = realpathSync.native(baseDir ?? homedir());
  }

  private location(create: boolean): string {
    const app = join(this.home, ".api-key-case");
    const connections = join(app, "connections");
    const project = join(connections, this.projectHash);

    if (!create) {
      // Pre-connection releases may already have ~/.api-key-case with the
      // host umask's broader mode. If this product-owned connection subtree
      // does not exist yet, report normal absence rather than treating an
      // unrelated legacy parent mode as corrupt connection metadata.
      const appState = lstatSync(app);
      if (!appState.isDirectory() || appState.isSymbolicLink()) {
        throw new ConnectionStorageError("unsafe-path");
      }
      lstatSync(connections); // ENOENT is intentionally surfaced as "missing".
    }

    for (const path of [app, connections, project]) directory(path, create);
    return project;
  }

  private readIntentAt(dir: string): ConnectionIntent | null {
    let parsed: unknown;
    try { parsed = readJson(join(dir, "state.json")); }
    catch (error) { if (absent(error)) return null; throw error; }
    if (object(parsed) && Object.hasOwn(parsed, "schemaVersion") && parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) {
      throw new ConnectionStorageError("unsupported-schema");
    }
    const v1 = object(parsed) && exactKeys(parsed, ["schemaVersion", "intent"]) && parsed.schemaVersion === 1 &&
      object(parsed.intent) && !Object.hasOwn(parsed.intent, "nativeEnrollment") && validIntent(parsed.intent, this.projectPath);
    const v2 = object(parsed) && exactKeys(parsed, ["schemaVersion", "intent"]) && parsed.schemaVersion === 2 &&
      object(parsed.intent) && Object.hasOwn(parsed.intent, "nativeEnrollment") && validIntent(parsed.intent, this.projectPath);
    if (!v1 && !v2) throw new ConnectionStorageError("invalid-data");
    return (parsed as { intent: ConnectionIntent }).intent;
  }

  private readClerkNativeAt(dir: string): ClerkNativeIntent | null {
    let parsed: unknown;
    try { parsed = readJson(join(dir, "clerk-native.json")); }
    catch (error) { if (absent(error)) return null; throw error; }
    if (object(parsed) && Object.hasOwn(parsed, "schemaVersion") && parsed.schemaVersion !== 1) throw new ConnectionStorageError("unsupported-schema");
    if (!object(parsed) || !exactKeys(parsed, ["schemaVersion", "intent"]) || parsed.schemaVersion !== 1 ||
        !validClerkNativeIntent(parsed.intent, this.projectPath)) throw new ConnectionStorageError("invalid-data");
    return parsed.intent;
  }

  readClerkNativeIntent(): ReadResult<ClerkNativeIntent> {
    return this.readFile("clerk-native.json", dir => this.readClerkNativeAt(dir));
  }

  saveClerkNativeIntent(input: ClerkNativeIntentInput): WriteResult<ClerkNativeIntent> {
    if (!validClerkNativeInput(input)) return {ok:false,issue:"invalid-data",value:null};
    let saved: ClerkNativeIntent | null = null;
    let unchanged = false;
    const result = this.change("clerk-native.json", dir => {
      const previous = this.readClerkNativeAt(dir);
      const id = clerkNativeId(this.projectPath, input.environment);
      if (previous && previous.id === id && previous.slot === "default" && previous.service === input.service &&
          previous.environment === input.environment && previous.route === input.route &&
          previous.destination.kind === input.destination.kind && previous.sendingDomain === input.sendingDomain) {
        saved = previous;
        unchanged = true;
        return {schemaVersion:1,intent:previous};
      }
      const history = this.readIntentHistoryAt(dir);
      if (previous) this.archiveIntentAt(dir, history, previous);
      const now = this.nextIntentRevision(previous, history);
      saved = { id, service:"clerk", environment:input.environment, slot:"default", route:"provider-native",
        destination:{kind:"vercel"}, sendingDomain:null, createdAt:previous?.id === id ? previous.createdAt : now, updatedAt:now };
      return {schemaVersion:1,intent:saved};
    }, () => unchanged);
    return result.ok && saved ? {ok:true,issue:null,value:saved} : {ok:false,issue:result.issue ?? "record-unavailable",value:null};
  }

  private readClerkManagedAt(dir: string): ClerkManagedIntent | null {
    let parsed: unknown;
    try { parsed = readJson(join(dir, "clerk-managed.json")); }
    catch (error) { if (absent(error)) return null; throw error; }
    if (object(parsed) && Object.hasOwn(parsed, "schemaVersion") && parsed.schemaVersion !== 1) throw new ConnectionStorageError("unsupported-schema");
    if (!object(parsed) || !exactKeys(parsed, ["schemaVersion", "intent"]) || parsed.schemaVersion !== 1 ||
        !validClerkManagedIntent(parsed.intent, this.projectPath)) throw new ConnectionStorageError("invalid-data");
    return parsed.intent;
  }

  readClerkManagedIntent(): ReadResult<ClerkManagedIntent> {
    return this.readFile("clerk-managed.json", dir => this.readClerkManagedAt(dir));
  }

  saveClerkManagedIntent(input: ClerkManagedIntentInput): WriteResult<ClerkManagedIntent> {
    if (!validClerkManagedInput(input)) return {ok:false,issue:"invalid-data",value:null};
    let saved: ClerkManagedIntent | null = null;
    let unchanged = false;
    const result = this.change("clerk-managed.json", dir => {
      const previous = this.readClerkManagedAt(dir);
      const id = clerkNativeId(this.projectPath, input.environment);
      if (previous && previous.id === id && previous.slot === "default" && previous.service === input.service &&
          previous.environment === input.environment && previous.route === input.route &&
          previous.destination.kind === input.destination.kind && previous.sendingDomain === input.sendingDomain) {
        saved = previous;
        unchanged = true;
        return {schemaVersion:1,intent:previous};
      }
      const history = this.readIntentHistoryAt(dir);
      if (previous) this.archiveIntentAt(dir, history, previous);
      const now = this.nextIntentRevision(previous, history);
      saved = { id, service:"clerk", environment:input.environment, slot:"default", route:"api-key-case-managed",
        destination:{kind:"cloudflare"}, sendingDomain:null, createdAt:previous?.id === id ? previous.createdAt : now, updatedAt:now };
      return {schemaVersion:1,intent:saved};
    }, () => unchanged);
    return result.ok && saved ? {ok:true,issue:null,value:saved} : {ok:false,issue:result.issue ?? "record-unavailable",value:null};
  }

  private readProviderHostedAt(dir: string, service: ProviderHostedService): ProviderHostedIntent | null {
    let parsed: unknown;
    try { parsed = readJson(join(dir, providerHostedFile(service))); }
    catch (error) { if (absent(error)) return null; throw error; }
    if (object(parsed) && Object.hasOwn(parsed, "schemaVersion") && parsed.schemaVersion !== 1) throw new ConnectionStorageError("unsupported-schema");
    if (!object(parsed) || !exactKeys(parsed, ["schemaVersion", "intent"]) || parsed.schemaVersion !== 1 ||
        !validProviderHostedIntent(parsed.intent, this.projectPath, service)) throw new ConnectionStorageError("invalid-data");
    return parsed.intent;
  }

  readProviderHostedIntent(service: ProviderHostedService): ReadResult<ProviderHostedIntent> {
    if (!providerHostedService(service)) return { status: "unavailable", issue: "invalid-data", value: null };
    return this.readFile(providerHostedFile(service), dir => this.readProviderHostedAt(dir, service));
  }

  /** Selection metadata only. No credentials, provider operation or execution authority. */
  setProviderHostedIntent(input: ProviderHostedIntentInput): WriteResult<ProviderHostedIntent> {
    if (!validProviderHostedInput(input)) return { ok: false, issue: "invalid-data", value: null };
    let saved: ProviderHostedIntent | null = null;
    let unchanged = false;
    const result = this.change(providerHostedFile(input.service), dir => {
      const previous = this.readProviderHostedAt(dir, input.service);
      if (previous && previous.environment === input.environment && previous.destination.kind === input.destination.kind) {
        saved = previous;
        unchanged = true;
        return { schemaVersion: 1, intent: previous };
      }
      const history = this.readIntentHistoryAt(dir);
      if (previous) this.archiveIntentAt(dir, history, previous);
      const now = this.nextIntentRevision(previous, history);
      const id = providerHostedId(this.projectPath, input.service, input.environment);
      saved = { ...input, id, slot: "default", destination: { kind: input.destination.kind },
        createdAt: previous?.id === id ? previous.createdAt : now, updatedAt: now };
      return { schemaVersion: 1, intent: saved };
    }, () => unchanged);
    return result.ok && saved ? { ok: true, issue: null, value: saved }
      : { ok: false, issue: result.issue ?? "record-unavailable", value: null };
  }

  private readJournalAt(dir: string): Journal | null {
    let parsed: unknown;
    try { parsed = readJson(join(dir, "observations.json")); }
    catch (error) { if (absent(error)) return null; throw error; }
    if (object(parsed) && Object.hasOwn(parsed, "schemaVersion") && parsed.schemaVersion !== 1) {
      throw new ConnectionStorageError("unsupported-schema");
    }
    if (!object(parsed) || (!exactKeys(parsed, ["schemaVersion", "entries"]) &&
        !(exactKeys(parsed, ["schemaVersion", "entries", "localPreparation"]) && validLocalPreparation(parsed.localPreparation, this.projectPath))) || parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.entries) || parsed.entries.length > LIMIT || !parsed.entries.every(validObservation) ||
        new Set(parsed.entries.map((entry) => (entry as ConnectionObservation).id)).size !== parsed.entries.length) {
      throw new ConnectionStorageError("invalid-data");
    }
    return parsed as Journal;
  }

  private readFile<T>(name: MetadataFile, parser: (dir: string) => T | null): ReadResult<T> {
    try {
      const dir = this.location(false);
      requireAbsent(join(dir, "lock"), "lock-present");
      requireAbsent(join(dir, `${name}.tmp`), "temporary-file-present");
      const value = parser(dir);
      return value === null
        ? { status: "missing", issue: "not-created", value: null }
        : { status: "available", issue: null, value };
    } catch (error) {
      return absent(error) ? { status: "missing", issue: "not-created", value: null }
        : { status: "unavailable", issue: errorIssue(error), value: null };
    }
  }

  readIntent(): ReadResult<ConnectionIntent> {
    return this.readFile("state.json", (dir) => this.readIntentAt(dir));
  }

  readObservations(): ReadResult<ConnectionObservation[]> {
    const result = this.readFile("observations.json", (dir) => this.readJournalAt(dir));
    return result.status === "available"
      ? { status: "available", issue: null, value: result.value.entries }
      : result;
  }

  readLocalPreparation(): ReadResult<LocalPreparationReceipt> {
    return this.readFile("observations.json", dir => this.readJournalAt(dir)?.localPreparation ?? null);
  }

  /** Called only after explicit successful inspection. Does not create a trial or grant permission. */
  recordLocalPreparation(input: Pick<LocalPreparationReceipt, "intentRevision" | "credentialRevision" | "artifact" | "maxDurationMs" | "metadataIdentity">): WriteResult<LocalPreparationReceipt> {
    let saved: LocalPreparationReceipt | null = null;
    const result = this.change("observations.json", dir => {
      const intent = this.readIntentAt(dir), ref: ConnectionCredentialRef = { name: "RESEND_API_KEY", scope: "project", projectId: deriveProjectId(this.projectPath), service: "resend", environment: "development" };
      requireAbsent(join(dir, `${this.credentialName(ref)}.lock`), "lock-present");
      requireAbsent(join(dir, "local-session.lock"), "lock-present");
      const credential = this.credentialAt(dir, ref);
      if (!intent || intent.environment !== "development" || intent.route !== "api-key-case-managed" || intent.destination.kind !== "local" ||
          intent.updatedAt !== input.intentRevision || credential?.state !== "settled" || credential.updatedAt !== input.credentialRevision) throw new ConnectionStorageError("record-unavailable");
      const inspectedAt = new Date().toISOString();
      saved = { id: randomUUID(), connectionId: intent.id, intentRevision: input.intentRevision, credentialRevision: input.credentialRevision,
        artifact: input.artifact, maxDurationMs: input.maxDurationMs, inspectedAt, expiresAt: new Date(Date.parse(inspectedAt) + input.maxDurationMs).toISOString(),
        metadataIdentity: { ...input.metadataIdentity } };
      if (!validLocalPreparation(saved, this.projectPath) || !exactKeys(input as unknown as ObjectValue, ["intentRevision", "credentialRevision", "artifact", "maxDurationMs", "metadataIdentity"])) throw new ConnectionStorageError("invalid-data");
      return { ...(this.readJournalAt(dir) ?? { schemaVersion: 1 as const, entries: [] }), localPreparation: saved };
    });
    return result.ok && saved ? { ok: true, issue: null, value: saved } : { ok: false, issue: result.ok ? "record-unavailable" : result.issue, value: null };
  }

  private change<T>(name: MetadataFile, edit: (dir: string) => T, reuseExisting?: () => boolean, create = true): WriteResult<T> {
    let dir: string;
    try {
      dir = this.location(create);
      try { mkdirSync(join(dir, "lock"), { mode: 0o700 }); }
      catch (error) {
        if (object(error) && error.code === "EEXIST") throw new ConnectionStorageError("lock-present");
        throw error;
      }
      if (process.platform !== "win32") {
        chmodSync(join(dir, "lock"), 0o700);
      }
    } catch (error) { return { ok: false, issue: errorIssue(error), value: null }; }

    try {
      requireAbsent(join(dir, `${name}.tmp`), "temporary-file-present");
      const value = edit(dir);
      // Exact selections keep their bytes/revisions. The metadata lock is still used.
      if (!reuseExisting?.()) this.writeAtomicAt(dir, name, value);
      return { ok: true, issue: null, value };
    } catch (error) {
      return { ok: false, issue: errorIssue(error), value: null };
    } finally {
      try { rmdirSync(join(dir, "lock")); } catch { /* a remaining lock makes reads fail closed */ }
    }
  }

  /** Caller holds the existing global metadata lock. Same exclusive temp/fsync/rename mechanics. */
  private writeAtomicAt(dir: string, name: MetadataFile, value: unknown): void {
    const temporary = join(dir, `${name}.tmp`);
    let temporaryCreated = false;
    try {
      let fd: number;
      try { fd = openSync(temporary, "wx", 0o600); }
      catch (error) {
        if (object(error) && error.code === "EEXIST") throw new ConnectionStorageError("temporary-file-present");
        throw error;
      }
      temporaryCreated = true;
      try {
        if (process.platform !== "win32") fchmodSync(fd, 0o600);
        writeFileSync(fd, `${JSON.stringify(value)}\n`);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temporary, join(dir, name));
      temporaryCreated = false;
    } finally {
      if (temporaryCreated) {
        try { unlinkSync(temporary); } catch { /* retain unknown if cleanup fails */ }
      }
    }
  }

  private readIntentHistoryAt(dir: string): IntentHistory | null {
    requireAbsent(join(dir, "intent-history.json.tmp"), "temporary-file-present");
    let parsed: unknown;
    try { parsed = readJson(join(dir, "intent-history.json")); }
    catch (error) { if (absent(error)) return null; throw error; }
    if (object(parsed) && Object.hasOwn(parsed, "schemaVersion") && parsed.schemaVersion !== 1) {
      throw new ConnectionStorageError("unsupported-schema");
    }
    if (!object(parsed) || !exactKeys(parsed, ["schemaVersion", "entries"]) || parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.entries) || parsed.entries.length > 14 || !parsed.entries.every(entry =>
          object(entry) && exactKeys(entry, ["profile", "intent", "recordedAt"]) && timestamp(entry.recordedAt) &&
          (entry.profile === "resend" ? validIntent(entry.intent, this.projectPath) :
            entry.profile === "clerk-native" ? validClerkNativeIntent(entry.intent, this.projectPath) :
              entry.profile === "clerk-managed" ? validClerkManagedIntent(entry.intent, this.projectPath) :
                entry.profile === "provider-openai" ? validProviderHostedIntent(entry.intent, this.projectPath, "openai") :
                  entry.profile === "provider-stripe-test" && validProviderHostedIntent(entry.intent, this.projectPath, "stripe-test")) &&
          entry.recordedAt >= (entry.intent as RememberedConnectionIntent).updatedAt) ||
        new Set(parsed.entries.map(entry => `${entry.profile}/${entry.intent.environment}`)).size !== parsed.entries.length) {
      throw new ConnectionStorageError("invalid-data");
    }
    return parsed as unknown as IntentHistory;
  }

  private nextIntentRevision(previous: RememberedConnectionIntent | null, history: IntentHistory | null): string {
    return new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0,
      ...(history?.entries.map(entry => Date.parse(entry.intent.updatedAt) + 1) ?? []))).toISOString();
  }

  /** Archive only already committed active state, never the incoming desired selection. */
  private archiveIntentAt(dir: string, history: IntentHistory | null, previous: RememberedConnectionIntent): void {
    const profile = intentProfile(previous);
    const entries = (history?.entries ?? []).filter(entry => entry.profile !== profile || entry.intent.environment !== previous.environment);
    entries.push({ profile, intent: previous,
      recordedAt: new Date(Math.max(Date.now(), Date.parse(previous.updatedAt))).toISOString() });
    entries.sort((a, b) => `${a.profile}/${a.intent.environment}`.localeCompare(`${b.profile}/${b.intent.environment}`));
    this.writeAtomicAt(dir, "intent-history.json", { schemaVersion: 1, entries });
  }

  private resumeBase(input: unknown): ConnectionResumeReport {
    const valid = validResumeInput(input, true);
    return { schemaVersion: 1, projectId: this.resumeProjectId,
      service: valid ? input.service : null, environment: valid ? input.environment : null,
      route: valid ? input.route ?? null : null, profile: valid ? intentProfile(input) : null,
      status: "blocked", issue: "not-recorded", current: null, remembered: null,
      source: null, recordedAt: null, fingerprint: null, permission: "none", providerOperation: false };
  }

  private assertResumeProject(): void {
    const stat = lstatSync(this.projectPath), previous = this.resumeProjectIdentity;
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalProjectRealpath(this.projectPath) !== this.projectPath ||
        stat.dev !== previous.dev || stat.ino !== previous.ino || stat.birthtimeMs !== previous.birthtimeMs) {
      throw new ConnectionStorageError("unsafe-path");
    }
  }

  private resumeAt(dir: string, input: ConnectionResumePlanInput): ConnectionResumeReport {
    this.assertResumeProject();
    const report = this.resumeBase(input), name = profileFile(intentProfile(input));
    requireAbsent(join(dir, `${name}.tmp`), "temporary-file-present");
    const current = input.service === "openai" || input.service === "stripe-test" ? this.readProviderHostedAt(dir, input.service) :
      report.profile === "resend" ? this.readIntentAt(dir) :
        report.profile === "clerk-native" ? this.readClerkNativeAt(dir) : this.readClerkManagedAt(dir);
    const history = this.readIntentHistoryAt(dir);
    report.current = current;
    // A newer current selection always wins over its older archive, even on a route mismatch.
    const entry = history?.entries.find(entry => entry.profile === report.profile && entry.intent.environment === input.environment);
    const selected = current?.environment === input.environment ? current : entry?.intent ?? null;
    if (!selected) return report;
    report.remembered = selected;
    report.source = selected === current ? "current" : "last-recorded";
    report.recordedAt = selected === current ? current.updatedAt : entry!.recordedAt;
    if (input.route !== undefined && selected.route !== input.route) { report.issue = "route-mismatch"; return report; }
    report.route = selected.route; // Omitted Resend plan route comes only from this committed record.
    const normalizedInput: ConnectionResumeInput = { service: input.service, environment: input.environment, route: selected.route };
    // Bind the plan to the real project/storage roots as well as the validated complete history.
    const roots = [this.projectPath, this.home, join(this.home, ".api-key-case"), join(this.home, ".api-key-case", "connections"), dir]
      .map(path => { const stat = lstatSync(path); return [path, stat.dev, stat.ino, stat.birthtimeMs]; });
    report.fingerprint = createHash("sha256").update(JSON.stringify({ version: 1, roots, input: normalizedInput, current, history, selected })).digest("hex");
    report.status = current && sameIntentSelection(current, selected) ? "unchanged" : "ready";
    report.issue = null;
    return report;
  }

  /** Local advisory plan only. Reads do not migrate or create metadata. */
  planIntentResume(input: ConnectionResumePlanInput): ConnectionResumeReport {
    const base = this.resumeBase(input);
    if (!validResumeInput(input, true)) return { ...base, issue: "invalid-data" };
    try { this.assertResumeProject(); }
    catch (error) { return { ...base, issue: errorIssue(error) }; }
    const result = this.readFile(profileFile(intentProfile(input)), dir => this.resumeAt(dir, input));
    if (result.status !== "available") return { ...base, issue: result.status === "missing" ? "not-recorded" : result.issue };
    return result.value;
  }

  /** The token is a stale-state check, not execution authority. No vault/provider path is reachable. */
  applyIntentResume(input: ConnectionResumeInput, fingerprint: string): ConnectionResumeReport {
    let report = this.resumeBase(input);
    if (!validResumeInput(input) || typeof fingerprint !== "string" || !SHA256.test(fingerprint)) return { ...report, issue: "invalid-data" };
    let unchanged = false;
    let preconditionIssue: ConnectionResumeReport["issue"] = null;
    try { this.assertResumeProject(); }
    catch (error) { return { ...report, issue: errorIssue(error) }; }
    const result = this.change(profileFile(intentProfile(input)), dir => {
      report = this.resumeAt(dir, input); // Recompute under the SAME lock used for archive + active replacement.
      if (report.status === "blocked" || report.fingerprint !== fingerprint) {
        preconditionIssue = report.status === "blocked" ? report.issue : "stale-plan";
        throw new ConnectionStorageError("record-unavailable");
      }
      if (report.status === "unchanged") { unchanged = true; return intentFile(report.current!); }
      this.assertResumeProject();
      const history = this.readIntentHistoryAt(dir), previous = report.current, selected = report.remembered!;
      if (previous) this.archiveIntentAt(dir, history, previous);
      const now = this.nextIntentRevision(previous, history);
      const intent: RememberedConnectionIntent = { ...selected,
        createdAt: previous?.id === selected.id ? previous.createdAt : now, updatedAt: now };
      return intentFile(intent);
    }, () => unchanged, false);
    if (!result.ok) return { ...report, status: "blocked", issue: preconditionIssue ?? result.issue };
    // Keep the reviewed before/remembered conditions in the receipt; refresh next/guide/check after apply.
    return { ...report, status: unchanged ? "unchanged" : "applied", issue: null };
  }

  private credentialName(ref: ConnectionCredentialRef): CredentialMetadataFile {
    assertConnectionCredentialRef(ref);
    if (ref.projectId !== deriveProjectId(this.projectPath)) throw new ConnectionStorageError("invalid-data");
    return ref.service === "resend" ? `credential-${ref.environment}.json` : `credential-${ref.service}-${ref.environment}.json`;
  }

  private credentialAt(dir: string, ref: ConnectionCredentialRef): CredentialMetadata | null {
    return readCredentialAt(dir, ref, this.credentialName(ref));
  }

  /** Advisory routing only: an unreadable record must not suggest legacy fallback. */
  hasClerkRegistrationRecord(): boolean {
    return (["development", "preview", "production"] as const).some(environment => {
      const ref: ConnectionCredentialRef = {name:"CLERK_SECRET_KEY",scope:"project",projectId:deriveProjectId(this.projectPath),service:"clerk",environment};
      const name = this.credentialName(ref);
      return this.readFile(name, dir => {
        requireAbsent(join(dir, `${name}.lock`), "lock-present");
        return this.credentialAt(dir, ref);
      }).status !== "missing";
    });
  }

  /** No value, digest, length or legacy index enters the v2 registration metadata. */
  readCredentialRegistration(ref: ConnectionCredentialRef): ReadResult<{ state: "pending" | "settled"; revision: string }> {
    try {
      const name = this.credentialName(ref);
      return this.readFile(name, dir => {
        requireAbsent(join(dir, `${name}.lock`), "lock-present");
        const credential = this.credentialAt(dir, ref);
        return credential ? { state: credential.state, revision: credential.updatedAt } : null;
      });
    } catch { return { status: "unavailable", issue: "record-unavailable", value: null }; }
  }

  credentialRevision(ref: ConnectionCredentialRef): string | null {
    try {
      const name = this.credentialName(ref);
      const dir = this.location(false);
      requireAbsent(join(dir, `${name}.lock`), "lock-present");
      const result = this.readFile(name, (location) => this.credentialAt(location, ref));
      return result.status === "available" && result.value.state === "settled" ? result.value.updatedAt : null;
    } catch { return null; }
  }

  /** Invalidate before touching the OS store; serialize the entire human operation. */
  beginCredentialMutation(ref: ConnectionCredentialRef): WriteResult<string> {
    let lock: { path: string; ino: number; dev: number } | null = null;
    try {
      const name = this.credentialName(ref), dir = this.location(true);
      const path = join(dir, `${name}.lock`);
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) {
        if (object(error) && error.code === "EEXIST") throw new ConnectionStorageError("lock-present");
        throw error;
      }
      const stat = lstatSync(path);
      lock = { path, ino: stat.ino, dev: stat.dev };
      let revision = "";
      const result = this.change(name, (location) => {
        const previous = this.credentialAt(location, ref);
        revision = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
        // Projection is intentional: extra caller data never reaches disk.
        return { schemaVersion: 1, credential: { name: ref.name, scope: "project", projectId: ref.projectId,
          service: ref.service, environment: ref.environment, createdAt: previous?.createdAt ?? revision,
          updatedAt: revision, state: "pending" } };
      });
      if (!result.ok) throw new ConnectionStorageError(result.issue);
      this.credentialLocks.set(revision + name, lock);
      return { ok: true, issue: null, value: revision };
    } catch (error) {
      if (lock) { try { rmdirSync(lock.path); } catch { /* retain fail-closed lock */ } }
      return { ok: false, issue: errorIssue(error), value: null };
    }
  }

  /** Only a successful store operation settles the revision. Cancellation stays unverified. */
  finishCredentialMutation(ref: ConnectionCredentialRef, revision: string, completed: boolean): boolean {
    const name = this.credentialName(ref), key = revision + name, lock = this.credentialLocks.get(key);
    if (!lock) return false;
    let ok = false;
    try {
      const current = lstatSync(lock.path);
      if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== lock.ino || current.dev !== lock.dev) return false;
      if (completed) {
        ok = this.change(name, (dir) => {
          const previous = this.credentialAt(dir, ref);
          if (!previous || previous.updatedAt !== revision || previous.state !== "pending") throw new ConnectionStorageError("record-unavailable");
          return { schemaVersion: 1, credential: { ...previous, state: "settled" } };
        }).ok;
      } else { ok = true; }
      rmdirSync(lock.path);
      return ok;
    } catch { return false; }
    finally { this.credentialLocks.delete(key); }
  }

  saveIntent(input: ConnectionIntentInput): WriteResult<ConnectionIntent> {
    if (!validIntentInput(input)) return { ok: false, issue: "invalid-data", value: null };
    let saved: ConnectionIntent | null = null;
    let unchanged = false;
    const result = this.change("state.json", (dir) => {
      let previous: ConnectionIntent | null = null;
      try { previous = this.readIntentAt(dir); }
      catch (error) { if (!absent(error)) throw error; }
      const sameBase = previous && previous.environment === input.environment && previous.route === input.route &&
        previous.destination.kind === input.destination.kind && previous.sendingDomain === input.sendingDomain;
      // Repeating the same explicit selection without the optional field preserves a previously chosen method.
      const nativeEnrollment = input.nativeEnrollment ?? (sameBase ? previous?.nativeEnrollment : undefined);
      if (previous && sameBase && previous.nativeEnrollment === nativeEnrollment) {
        saved = previous;
        unchanged = true;
        return intentFile(previous);
      }
      const history = this.readIntentHistoryAt(dir);
      if (previous) this.archiveIntentAt(dir, history, previous);
      const now = this.nextIntentRevision(previous, history);
      const id = connectionIdForPath(this.projectPath, input.environment);
      const intent: ConnectionIntent = {
        id, service: "resend", environment: input.environment, slot: "default", route: input.route,
        ...(nativeEnrollment ? { nativeEnrollment } : {}),
        destination: { kind: input.destination.kind }, sendingDomain: input.sendingDomain,
        createdAt: previous?.id === id ? previous.createdAt : now,
        updatedAt: now
      };
      saved = intent;
      return intentFile(intent);
    }, () => unchanged);
    if (!result.ok) return { ok: false, issue: result.issue, value: null };
    return saved ? { ok: true, issue: null, value: saved }
      : { ok: false, issue: "record-unavailable", value: null };
  }

  private localSessionRecordAt(dir: string): LocalSessionRecord | null {
    let value: unknown;
    try { value = readJson(join(dir, "local-session.json")); }
    catch (error) { if (absent(error)) return null; throw error; }
    if (!object(value)) throw new ConnectionStorageError("invalid-data");
    if (value.schemaVersion === 1 && exactKeys(value, ["schemaVersion", "receipt"]) && validLocalReceipt(value.receipt, this.projectPath, false)) {
      // Legacy receipts remain readable, but never acquire a basis or observation.
      return { schemaVersion: 1, receipt: value.receipt, observations: [], history: [] };
    }
    if (value.schemaVersion !== 2 || !exactKeys(value, ["schemaVersion", "receipt", "observations", "history"]) ||
        !validLocalHistory({ receipt: value.receipt, observations: value.observations }, this.projectPath) ||
        !Array.isArray(value.history) || value.history.length > LOCAL_HISTORY_LIMIT ||
        !value.history.every(entry => validLocalHistory(entry, this.projectPath)) ||
        new Set([...(value.history as LocalSessionHistoryEntry[]).map(entry => entry.receipt.attemptId), (value.receipt as LocalSessionReceipt).attemptId]).size !== value.history.length + 1) {
      throw new ConnectionStorageError("invalid-data");
    }
    return value as unknown as LocalSessionRecord;
  }
  private localSessionAt(dir: string): LocalSessionReceipt | null {
    return this.localSessionRecordAt(dir)?.receipt ?? null;
  }

  /** Advisory receipt only; an unfinished attempt is unknown, never 'running'. */
  readLocalSession(): ReadResult<LocalSessionReceipt> {
    return this.readFile("local-session.json", dir => this.localSessionAt(dir));
  }
  readLocalSessionHistory(): ReadResult<LocalSessionHistoryEntry[]> {
    const result = this.readFile("local-session.json", dir => this.localSessionRecordAt(dir));
    return result.status === "available" ? { status: "available", issue: null, value: [
      ...result.value.history, { receipt: result.value.receipt, observations: result.value.observations }
    ] } : result;
  }

  /** Append a closed report to this completed attempt only. Never runs or probes an app/store. */
  recordLocalSessionObservation(input: LocalSessionObservationInput): WriteResult<LocalSessionObservation> {
    if (!object(input) || !exactKeys(input, ["service", "environment", "attemptId", "executionBasisId", "credentialRevision", "authority", "outcome"]) ||
        input.service !== "resend" || input.environment !== "development" || typeof input.attemptId !== "string" || !UUID.test(input.attemptId) ||
        typeof input.executionBasisId !== "string" || !UUID.test(input.executionBasisId) ||
        !timestamp(input.credentialRevision) || !validLocalObservation({ authority: input.authority, outcome: input.outcome, recordedAt: new Date().toISOString() })) {
      return { ok: false, issue: "invalid-data", value: null };
    }
    let observation: LocalSessionObservation | null = null;
    const changed = this.change("local-session.json", dir => {
      requireAbsent(join(dir, "local-session.lock"), "lock-present");
      requireAbsent(join(dir, "state.json.tmp"), "temporary-file-present");
      requireAbsent(join(dir, "credential-development.json.tmp"), "temporary-file-present");
      requireAbsent(join(dir, "credential-development.json.lock"), "lock-present");
      const record = this.localSessionRecordAt(dir), intent = this.readIntentAt(dir);
      if (!record || record.schemaVersion !== 2 || !observableLocalReceipt(record.receipt) ||
          record.receipt.attemptId !== input.attemptId || record.receipt.executionBasisId !== input.executionBasisId ||
          record.receipt.credentialRevision !== input.credentialRevision ||
          !intent || intent.service !== "resend" || intent.environment !== "development" || intent.route !== "api-key-case-managed" ||
          intent.destination.kind !== "local" || intent.updatedAt !== record.receipt.intentRevision ||
          record.observations.length >= LOCAL_OBSERVATION_LIMIT) throw new ConnectionStorageError("record-unavailable");
      const credential = this.credentialAt(dir, { name: "RESEND_API_KEY", scope: "project", projectId: deriveProjectId(this.projectPath), service: "resend", environment: "development" });
      if (!credential || credential.state !== "settled" || credential.updatedAt !== input.credentialRevision) throw new ConnectionStorageError("record-unavailable");
      const last = record.observations.at(-1)?.recordedAt ?? record.receipt.finishedAt!;
      observation = { authority: input.authority, outcome: input.outcome,
        recordedAt: new Date(Math.max(Date.now(), Date.parse(last) + 1)).toISOString() } as LocalSessionObservation;
      return { ...record, observations: [...record.observations, observation] };
    });
    // Remaining locks/uncertain storage must not be masked by a successful report.
    const after = changed.ok ? this.readLocalSessionHistory() : null;
    return changed.ok && observation && after?.status === "available" && this.localSessionLockStatus() === "absent"
      ? { ok: true, issue: null, value: observation }
      : { ok: false, issue: changed.issue ?? "record-unavailable", value: null };
  }

  localSessionLockStatus(): "present" | "absent" | "unavailable" {
    try {
      const path = join(this.location(false), "local-session.lock");
      const stat = lstatSync(path);
      return stat.isDirectory() && !stat.isSymbolicLink() ? "present" : "unavailable";
    } catch (error) { return absent(error) ? "absent" : "unavailable"; }
  }

  beginLocalSession(credentialRevision: string, maxDurationMs: number): WriteResult<LocalSessionReceipt> {
    if (!timestamp(credentialRevision) || !Number.isInteger(maxDurationMs) || maxDurationMs < 1000 || maxDurationMs > 1800000 || this.localSessionLock) {
      return { ok: false, issue: "invalid-data", value: null };
    }
    let receipt: LocalSessionReceipt | null = null;
    const changed = this.change("local-session.json", dir => {
      const intent = this.readIntentAt(dir);
      if (!intent || intent.service !== "resend" || intent.environment !== "development" ||
          intent.route !== "api-key-case-managed" || intent.destination.kind !== "local") throw new ConnectionStorageError("record-unavailable");
      const previous = this.localSessionRecordAt(dir); // malformed prior metadata never gets silently replaced
      const path = join(dir, "local-session.lock");
      try { mkdirSync(path, { mode: 0o700 }); } catch { throw new ConnectionStorageError("lock-present"); }
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ConnectionStorageError("unsafe-path");
      this.localSessionLock = { path, ino: stat.ino, dev: stat.dev, birthtimeMs: stat.birthtimeMs, ctimeMs: stat.ctimeMs };
      receipt = { attemptId: randomUUID(), connectionId: intent.id, credentialRevision, startedAt: new Date().toISOString(),
        finishedAt: null, maxDurationMs, outcome: "unknown", executionBasisId: randomUUID(), intentRevision: intent.updatedAt,
        execution: "not-started", treeTermination: "not-needed" };
      this.localSessionReceipt = Object.freeze({ ...receipt });
      this.localSessionCompletion = null; this.localCompletionFailure = null;
      return { schemaVersion: 2, receipt, observations: [], history: previous?.schemaVersion === 2
        ? [...previous.history, { receipt: previous.receipt, observations: previous.observations }].slice(-LOCAL_HISTORY_LIMIT) : [] };
    });
    // A failed durable start may have left uncertain metadata: retain its lock.
    return changed.ok && receipt ? { ok: true, issue: null, value: receipt } : { ok: false, issue: changed.issue ?? "io-error", value: null };
  }

  /** This exact invocation's durable unknown attempt and directory lock. */
  ownsLocalSession(attemptId: string): boolean {
    try {
      const lock = this.localSessionLock;
      if (!lock) return false;
      const stat = lstatSync(lock.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== lock.ino || stat.dev !== lock.dev || stat.birthtimeMs !== lock.birthtimeMs || stat.ctimeMs !== lock.ctimeMs) return false;
      const receipt = this.readLocalSession();
      return receipt.status === "available" && receipt.value.attemptId === attemptId &&
        receipt.value.finishedAt === null && receipt.value.outcome === "unknown" &&
        JSON.stringify(receipt.value) === JSON.stringify(this.localSessionReceipt);
    } catch { return false; }
  }

  localSessionCompletionFailure(): LocalSessionCompletionFailure | null {
    return this.localCompletionFailure ? { ...this.localCompletionFailure } : null;
  }

  finishLocalSession(attemptId: string, outcome: LocalSessionOutcome, ownershipReleased = true,
    lifecycle: Pick<LocalSessionReceipt, "execution" | "treeTermination"> = { execution: "not-started", treeTermination: "not-needed" }): boolean {
    const lock = this.localSessionLock;
    this.localCompletionFailure = null;
    const fail = (phase: LocalSessionCompletionFailure["phase"], issue: ConnectionMetadataIssue) => {
      this.localCompletionFailure = { phase, issue }; return false;
    };
    if (!lock || !includes(["unknown", "exited", "failed", "cancelled", "expired", "changed"] as const, outcome) ||
        !object(lifecycle) || !exactKeys(lifecycle, ["execution", "treeTermination"]) ||
        !includes(["not-started", "possible"] as const, lifecycle.execution) ||
        !includes(["not-needed", "confirmed", "unknown"] as const, lifecycle.treeTermination)) return fail("result-save", "invalid-data");
    const prior = this.localSessionCompletion;
    if (prior && (prior.ownershipReleased !== ownershipReleased || prior.receipt.attemptId !== attemptId ||
        prior.receipt.outcome !== outcome || prior.receipt.execution !== lifecycle.execution ||
        prior.receipt.treeTermination !== lifecycle.treeTermination)) return fail("result-save", "record-unavailable");
    let alreadySaved = false;
    const changed = this.change("local-session.json", dir => {
      const stat = lstatSync(lock.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== lock.ino || stat.dev !== lock.dev || stat.birthtimeMs !== lock.birthtimeMs || stat.ctimeMs !== lock.ctimeMs) throw new ConnectionStorageError("unsafe-path");
      const record = this.localSessionRecordAt(dir), receipt = record?.receipt;
      if (receipt && prior && JSON.stringify(receipt) === JSON.stringify(prior.receipt)) {
        alreadySaved = true; return record!;
      }
      if (!receipt || receipt.attemptId !== attemptId || receipt.finishedAt !== null ||
          JSON.stringify(receipt) !== JSON.stringify(this.localSessionReceipt)) throw new ConnectionStorageError("record-unavailable");
      // Clock correction during a trial must not invalidate its durable history.
      if (!this.localSessionCompletion) {
        const finishedAt = new Date(Math.max(Date.now(), Date.parse(receipt.startedAt))).toISOString();
        this.localSessionCompletion = { ownershipReleased,
          receipt: Object.freeze({ ...receipt, outcome, ...lifecycle, finishedAt }) };
      }
      return { ...record!, receipt: this.localSessionCompletion.receipt };
    }, () => alreadySaved);
    if (!changed.ok) return fail("result-save", changed.issue);
    // A receipt can be saved while ownership is uncertain. Keep the lock so a
    // new approval cannot turn unknown teardown into an overlapping launch.
    if (!ownershipReleased) return true;
    try {
      const saved = this.readLocalSession();
      if (saved.status !== "available") return fail("lock-release", saved.issue);
      if (JSON.stringify(saved.value) !== JSON.stringify(this.localSessionCompletion?.receipt)) {
        return fail("lock-release", "record-unavailable");
      }
      const stat = lstatSync(lock.path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== lock.ino || stat.dev !== lock.dev || stat.birthtimeMs !== lock.birthtimeMs || stat.ctimeMs !== lock.ctimeMs) return fail("lock-release", "unsafe-path");
      rmdirSync(lock.path); this.localSessionLock = null; return true;
    } catch (error) { return fail("lock-release", errorIssue(error)); }
  }

  beginObservation(input: {
    kind: ConnectionObservationKind;
    authority: ConnectionObservationAuthority;
    basis: ConnectionObservation["basis"];
  }): WriteResult<ConnectionObservation> {
    if (!validObservationInput(input)) return { ok: false, issue: "invalid-data", value: null };
    let created: ConnectionObservation | null = null;
    const result = this.change("observations.json", (dir) => {
      let intent: ConnectionIntent | ClerkNativeIntent | ClerkManagedIntent | null;
      try { intent = input.basis.managed ? this.readClerkManagedAt(dir) : input.basis.native?.service === "clerk" ? this.readClerkNativeAt(dir) : this.readIntentAt(dir); }
      catch (error) {
        if (absent(error)) throw new ConnectionStorageError("record-unavailable");
        throw error;
      }
      if (!intent) throw new ConnectionStorageError("record-unavailable");
      if (input.basis.native && (intent.service !== input.basis.native.service ||
          intent.environment !== input.basis.native.environment || intent.updatedAt !== input.basis.native.intentRevision ||
          intent.route !== "provider-native" || intent.destination.kind !== "vercel")) throw new ConnectionStorageError("record-unavailable");
      if(input.basis.managed&&(intent.service!=="clerk"||intent.environment!==input.basis.managed.environment||
          intent.updatedAt!==input.basis.managed.intentRevision||intent.route!=="api-key-case-managed"||intent.destination.kind!=="cloudflare"))throw new ConnectionStorageError("record-unavailable");
      let parsed: Journal | null;
      try { parsed = this.readJournalAt(dir); }
      catch (error) {
        if (absent(error)) parsed = null;
        else throw error;
      }
      const entries = parsed?.entries ?? [];
      created = {
        id: randomUUID(), connectionId: intent.id, kind: input.kind, authority: input.authority,
        outcome: "unknown", startedAt: new Date().toISOString(), finishedAt: null,
        basis: { ...input.basis }, resultCode: null
      };
      return { ...(parsed ?? { schemaVersion: 1 as const }), entries: [...entries, created].slice(-LIMIT) };
    });
    if (!result.ok) return { ok: false, issue: result.issue, value: null };
    return created ? { ok: true, issue: null, value: created } : { ok: false, issue: "record-unavailable", value: null };
  }

  finishObservation(id: string, outcome: Exclude<ConnectionObservationOutcome, "unknown"> | "unknown",
    resultCode: ConnectionResultCode): WriteResult<ConnectionObservation> {
    let finished: ConnectionObservation | null = null;
    const result = this.change("observations.json", (dir) => {
      const journal = this.readJournalAt(dir);
      if (!journal) throw new ConnectionStorageError("record-unavailable");
      const entry = journal.entries.find((candidate) => candidate.id === id);
      if (!entry || entry.finishedAt !== null || !allowedCodes(entry.kind).includes(resultCode) ||
          !outcomeMatches(entry.kind, outcome, resultCode)) {
        throw new ConnectionStorageError("record-unavailable");
      }
      finished = { ...entry, outcome, resultCode, finishedAt: new Date().toISOString() };
      return { ...journal, entries: journal.entries.map((candidate) => candidate.id === id ? finished! : candidate) };
    });
    if (!result.ok) return { ok: false, issue: result.issue, value: null };
    return finished ? { ok: true, issue: null, value: finished } : { ok: false, issue: "record-unavailable", value: null };
  }
}

function validIntentInput(value: unknown): value is ConnectionIntentInput {
  const legacy = object(value) && exactKeys(value, ["service", "environment", "route", "destination", "sendingDomain"]);
  const versioned = object(value) && exactKeys(value, ["service", "environment", "route", "nativeEnrollment", "destination", "sendingDomain"]);
  return object(value) && (legacy || versioned) &&
    value.service === "resend" && includes(["development", "preview", "production"] as const, value.environment) &&
    includes(["provider-native", "api-key-case-managed", "manual"] as const, value.route) &&
    object(value.destination) && exactKeys(value.destination, ["kind"]) &&
    includes(["local", "vercel", "cloudflare", "github", "manual"] as const, value.destination.kind) &&
    validDomain(value.sendingDomain) && (!versioned ||
      (includes(["resend-vercel-integration", "resend-vercel-marketplace"] as const, value.nativeEnrollment) &&
        value.route === "provider-native" && value.destination.kind === "vercel"));
}

function validObservationInput(value: unknown): value is {
  kind: ConnectionObservationKind;
  authority: ConnectionObservationAuthority;
  basis: ConnectionObservation["basis"];
} {
  if (!object(value) || !exactKeys(value, ["kind", "authority", "basis"]) || !object(value.basis) ||
      (!exactKeys(value.basis, ["credentialRevision", "destinationFingerprint", "intentFingerprint",
        "sourceFingerprint", "verifierVersion"]) && !validApplicationBasis(value.basis) && !validNativeObservationBasis(value.basis) && !validClerkWorkerObservationBasis(value.basis))) return false;
  if (validApplicationBasis(value.basis) && (value.kind !== "application-check" || value.authority !== "agent-observed")) return false;
  if (validNativeObservationBasis(value.basis) && !nativeObservationRole(value.kind, value.authority, value.basis)) return false;
  if (validClerkWorkerObservationBasis(value.basis) && !clerkWorkerObservationRole(value.kind,value.authority)) return false;
  const kind = value.kind;
  const authority = value.authority;
  return includes(["credential-validation", "destination-check", "send-capability-check", "application-check"] as const, kind) &&
    includes(["provider-observed", "local-observed", "agent-observed", "human-reported"] as const, authority) &&
    authorityMatches(kind, authority) &&
    (value.basis.credentialRevision === null || timestamp(value.basis.credentialRevision)) &&
    (value.basis.destinationFingerprint === null || (typeof value.basis.destinationFingerprint === "string" && SHA256.test(value.basis.destinationFingerprint))) &&
    (value.basis.intentFingerprint === null || (typeof value.basis.intentFingerprint === "string" && SHA256.test(value.basis.intentFingerprint))) &&
    (value.basis.sourceFingerprint === null || (typeof value.basis.sourceFingerprint === "string" && SHA256.test(value.basis.sourceFingerprint))) &&
    typeof value.basis.verifierVersion === "string" && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(value.basis.verifierVersion);
}

function validApplicationBasis(basis: ObjectValue): boolean {
  return exactKeys(basis, ["credentialRevision", "destinationFingerprint", "intentFingerprint",
    "sourceFingerprint", "verifierVersion", "planFingerprint", "expiresAt", "configurationObserved"]) &&
    typeof basis.planFingerprint === "string" && SHA256.test(basis.planFingerprint) &&
    timestamp(basis.expiresAt) && typeof basis.configurationObserved === "boolean";
}

function validNativeObservationBasis(basis: ObjectValue): boolean {
  if (!exactKeys(basis, ["credentialRevision", "destinationFingerprint", "intentFingerprint", "sourceFingerprint",
      "verifierVersion", "expiresAt", "native"]) || basis.verifierVersion !== "native-app-observation-v1" ||
      basis.credentialRevision !== null || basis.sourceFingerprint !== null || !timestamp(basis.expiresAt) ||
      typeof basis.destinationFingerprint !== "string" || !SHA256.test(basis.destinationFingerprint) ||
      typeof basis.intentFingerprint !== "string" || !SHA256.test(basis.intentFingerprint) || !object(basis.native)) return false;
  const native = basis.native;
  return exactKeys(native, ["service", "environment", "intentRevision", "configuration", "configurationFingerprint", "inspectionId", "feature"]) &&
    includes(["resend", "clerk"] as const, native.service) && includes(["development", "preview", "production"] as const, native.environment) &&
    timestamp(native.intentRevision) && includes(["integration-managed", "present-unmanaged", "absent", "partial", "unknown"] as const, native.configuration) &&
    (native.configurationFingerprint === null ? native.configuration === "unknown" :
      typeof native.configurationFingerprint === "string" && SHA256.test(native.configurationFingerprint)) &&
    (native.inspectionId === null || typeof native.inspectionId === "string" && UUID.test(native.inspectionId)) &&
    (native.feature === null || native.feature === (native.service === "clerk" ? "protected-access" : "send-and-delivery"));
}
function nativeObservationRole(kind: unknown, authority: unknown, basis: ObjectValue): boolean {
  const native = basis.native as ObjectValue;
  return kind === "destination-check" ? authority === "local-observed" && native.inspectionId === null && native.feature === null :
    kind === "application-check" && (authority === "agent-observed" || authority === "human-reported") && native.inspectionId !== null && native.feature !== null &&
    includes(["integration-managed", "present-unmanaged"] as const, native.configuration);
}
function validClerkWorkerObservationBasis(basis:ObjectValue):boolean {
  if(!exactKeys(basis,["credentialRevision","destinationFingerprint","intentFingerprint","sourceFingerprint","verifierVersion","expiresAt","managed"])||
      basis.verifierVersion!=="clerk-worker-app-observation-v1"||!timestamp(basis.credentialRevision)||basis.sourceFingerprint!==null||!timestamp(basis.expiresAt)||
      typeof basis.destinationFingerprint!=="string"||!SHA256.test(basis.destinationFingerprint)||typeof basis.intentFingerprint!=="string"||!SHA256.test(basis.intentFingerprint)||!object(basis.managed))return false;
  const binding=basis.managed;
  return exactKeys(binding,["environment","intentRevision","preparationId","versionId","accountId","worker","feature"])&&
    includes(["development","preview","production"] as const,binding.environment)&&timestamp(binding.intentRevision)&&
    typeof binding.preparationId==="string"&&UUID.test(binding.preparationId)&&typeof binding.versionId==="string"&&UUID.test(binding.versionId)&&
    typeof binding.accountId==="string"&&/^[a-f0-9]{32}$/.test(binding.accountId)&&typeof binding.worker==="string"&&/^[a-z0-9][a-z0-9_-]{0,62}$/.test(binding.worker)&&binding.feature==="protected-access";
}
function clerkWorkerObservationRole(kind:unknown,authority:unknown):boolean {
  return kind==="application-check"&&(authority==="agent-observed"||authority==="human-reported");
}
