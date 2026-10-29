import { realpathSync } from "node:fs";
import { connectionCredentialRef } from "../agent/connection-credential.js";
import { ConnectionStateStore, type LocalSessionOutcome, type LocalSessionObservationInput, type LocalSessionReceipt, type LocalSessionHistoryEntry, type ConnectionMetadataIssue, type LocalSessionCompletionFailure } from "../agent/connection-state.js";
import { connectionIntentFingerprint } from "../agent/fingerprints.js";
import { LOCAL_NATIVE_LAUNCH_ACCEPTED } from "../deploy/handoff.js";
export { LOCAL_NATIVE_LAUNCH_ACCEPTED, runLocalApplication } from "../deploy/handoff.js";
import type { Vault } from "../vault/types.js";
import { LocalLaunchSnapshot } from "./snapshot.js";

export interface LocalSessionRequest {
  service: "resend";
  environment: "development";
  projectDir: string;
  artifact: string;
  maxDurationMs: number;
}
export interface LocalInspectionDeps {
  vault: Vault;
  connectionBaseDir?: string;
}
export interface LocalSessionResult {
  service: "resend";
  environment: "development";
  status: "unsupported" | "pro-required" | "intent-unavailable" | "intent-mismatch" | "revision-unavailable" |
    "missing-credential" | "inputs-unavailable" | "native-acceptance-required" | "ready-for-review" |
    "unavailable" | "declined" | "changed" | "metadata-unavailable" | "recovery-required" | LocalSessionOutcome;
  attemptId: string | null;
  execution: "not-started" | "possible";
  treeTermination: "not-needed" | "confirmed" | "unknown";
  receiptSaved: boolean;
  permission: "none";
  nativeLauncher: "disabled-awaiting-windows-acceptance" | "enabled";
  applicationReadiness: "not-verified";
  preparationSaved?: boolean;
  completionFailure?: LocalSessionCompletionFailure;
}
function result(status: LocalSessionResult["status"]): LocalSessionResult {
  return { service: "resend", environment: "development", status, attemptId: null,
    execution: "not-started", treeTermination: "not-needed", receiptSaved: false, permission: "none",
    nativeLauncher: LOCAL_NATIVE_LAUNCH_ACCEPTED && process.platform === "win32" ? "enabled" : "disabled-awaiting-windows-acceptance", applicationReadiness: "not-verified" };
}
function valid(request: LocalSessionRequest): boolean {
  return Boolean(request && typeof request === "object" && !Array.isArray(request) &&
    Object.keys(request).sort().join(",") === "artifact,environment,maxDurationMs,projectDir,service" &&
    request.service === "resend" && request.environment === "development" && typeof request.projectDir === "string" &&
    typeof request.artifact === "string" && Number.isInteger(request.maxDurationMs) &&
    request.maxDurationMs >= 1000 && request.maxDurationMs <= 1800000);
}

/** Inspection never grants permission, probes providers, or mutates the vault. */
export async function inspectLocalApplication(deps: LocalInspectionDeps, request: LocalSessionRequest): Promise<LocalSessionResult> {
  if (!valid(request)) return result("unsupported");
  try {
    const canonical = realpathSync(request.projectDir), store = new ConnectionStateStore(canonical, deps.connectionBaseDir);
    const intent = store.readIntent();
    if (intent.status !== "available") return result("intent-unavailable");
    if (intent.value.service !== "resend" || intent.value.environment !== "development" ||
        intent.value.route !== "api-key-case-managed" || intent.value.destination.kind !== "local") return result("intent-mismatch");
    // Inspection is advisory, but must not advertise a new review while the
    // existing session still owns or may own this project. Never clear evidence.
    const lockStatus = store.localSessionLockStatus();
    if (lockStatus !== "absent") return result(lockStatus === "present" ? "recovery-required" : "metadata-unavailable");
    const ref = connectionCredentialRef(canonical, "development"), revision = store.credentialRevision(ref);
    if (!revision) return result("revision-unavailable");
    let snapshot: LocalLaunchSnapshot;
    try { snapshot = new LocalLaunchSnapshot(canonical, request.artifact); } catch { return result("inputs-unavailable"); }
    const present = await deps.vault.hasSecret(ref);
    // Another invocation may start while presence is awaited. Execution still
    // rechecks and atomically claims its own lock; this is not a reservation.
    const afterPresence = store.localSessionLockStatus();
    if (afterPresence !== "absent") return result(afterPresence === "present" ? "recovery-required" : "metadata-unavailable");
    if (!present) return result("missing-credential");
    const next = store.readIntent();
    if (realpathSync(request.projectDir) !== canonical || next.status !== "available" ||
        connectionIntentFingerprint(next.value) !== connectionIntentFingerprint(intent.value) || store.credentialRevision(ref) !== revision ||
        !snapshot.current()) return result("changed");
    const saved = store.recordLocalPreparation({ intentRevision: intent.value.updatedAt, credentialRevision: revision,
      artifact: request.artifact, maxDurationMs: request.maxDurationMs, metadataIdentity: snapshot.preparationIdentity() });
    if (!saved.ok) return result("metadata-unavailable");
    // A record is advisory: no reservation. A concurrent edit still invalidates this inspection.
    const currentIntent = store.readIntent();
    if (!snapshot.current() || store.localSessionLockStatus() !== "absent" || store.credentialRevision(ref) !== revision ||
        currentIntent.status !== "available" || currentIntent.value.updatedAt !== intent.value.updatedAt) return result("changed");
    return { ...result("ready-for-review"), preparationSaved: true };
  } catch { return result("unavailable"); }
}

export function recordLocalApplicationObservation(projectDir: string, input: LocalSessionObservationInput, baseDir?: string) {
  try {
    const recorded = new ConnectionStateStore(projectDir, baseDir).recordLocalSessionObservation(input);
    return { service: "resend" as const, environment: "development" as const,
      status: recorded.ok ? "recorded" as const : "refused" as const, issue: recorded.issue,
      observation: recorded.value, permission: "none" as const, applicationReadiness: "not-verified" as const };
  } catch {
    return { service: "resend" as const, environment: "development" as const, status: "refused" as const,
      issue: "record-unavailable" as const, observation: null, permission: "none" as const, applicationReadiness: "not-verified" as const };
  }
}

type LocalReceiptRelation = "current-selection-and-revision" | "selection-changed" | "credential-changed" | "legacy-unbound" | "unavailable";
export interface LocalApplicationStatus {
  service: "resend";
  environment: "development";
  status: LocalSessionOutcome | "not-started" | "unavailable";
  receipt: LocalSessionReceipt | null;
  receiptRelation: LocalReceiptRelation | "not-started";
  retry: "fresh-request-required" | "owner-review-required";
  permission: "none";
  nativeLauncher: LocalSessionResult["nativeLauncher"];
  applicationReadiness: "not-verified";
  observationHistory: {
    status: "available" | "missing" | "unavailable";
    issue: ConnectionMetadataIssue | null;
    entries: Array<LocalSessionHistoryEntry & { relation: "latest-attempt" | "past-attempt"; basis: LocalReceiptRelation }>;
  };
}

export function readLocalApplicationStatus(projectDir: string, baseDir?: string): LocalApplicationStatus {
  const common = { service: "resend" as const, environment: "development" as const, permission: "none" as const,
    nativeLauncher: LOCAL_NATIVE_LAUNCH_ACCEPTED && process.platform === "win32" ? "enabled" as const : "disabled-awaiting-windows-acceptance" as const,
    applicationReadiness: "not-verified" as const };
  try {
    const store = new ConnectionStateStore(projectDir, baseDir);
    const history = store.readLocalSessionHistory();
    const lockStatus = store.localSessionLockStatus();
    const intent = store.readIntent();
    const revision = store.credentialRevision(connectionCredentialRef(projectDir, "development"));
    const basis = (receipt: LocalSessionReceipt): LocalReceiptRelation => {
      if (!receipt.executionBasisId) return "legacy-unbound";
      if (lockStatus !== "absent" || intent.status === "unavailable") return "unavailable";
      if (intent.status !== "available" || intent.value.environment !== "development" ||
          intent.value.route !== "api-key-case-managed" || intent.value.destination.kind !== "local" ||
          intent.value.updatedAt !== receipt.intentRevision) return "selection-changed";
      return revision === null ? "unavailable" : revision === receipt.credentialRevision ? "current-selection-and-revision" : "credential-changed";
    };
    const latest = history.status === "available" ? history.value.at(-1)!.receipt : null;
    return { ...common,
      status: latest ? latest.outcome : history.status === "missing" ? "not-started" : "unavailable",
      receipt: latest, receiptRelation: latest ? basis(latest) : history.status === "missing" ? "not-started" : "unavailable",
      retry: lockStatus === "absent" ? "fresh-request-required" : "owner-review-required",
      observationHistory: { status: history.status, issue: history.issue, entries: history.status === "available" ? history.value.map(entry => ({
        ...entry, relation: entry.receipt.attemptId === latest?.attemptId ? "latest-attempt" : "past-attempt", basis: basis(entry.receipt)
      })) : [] } };
  } catch { return { ...common, status: "unavailable", receipt: null, receiptRelation: "unavailable", retry: "owner-review-required",
    observationHistory: { status: "unavailable", issue: "record-unavailable", entries: [] } }; }
}
