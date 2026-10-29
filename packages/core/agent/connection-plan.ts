import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { type DestinationIdentity } from "../deploy/destination.js";
import type { Vault } from "../vault/types.js";
import { connectionCredentialRef } from "./connection-credential.js";
import { connectionCredentialFingerprint, connectionIntentFingerprint, applicationSourceFingerprint } from "./fingerprints.js";
import { ConnectionStateStore, type ConnectionEnvironment, type ConnectionIntent, type ConnectionObservation } from "./connection-state.js";

export const APPLICATION_OBSERVATION_VERSION = "resend-application-check-v3";
/** Advisory evidence only: callers choose a shorter lifetime, never an indefinite pass. */
export const MAX_APPLICATION_OBSERVATION_SECONDS = 86_400;
type Basis = {
  credentialRevision: string | null;
  credentialFingerprint: string | null;
  nativeConfigurationFingerprint: string | null;
  destinationFingerprint: string;
  intentFingerprint: string;
  sourceFingerprint: string;
};
export type ApplicationObservationReason = "observation-missing" | "observation-unavailable" | "observation-invalid" |
  "observation-interrupted" | "authority-mismatch" | "verifier-changed" | "observation-basis-missing" |
  "observation-time-invalid" | "observation-expired" | "basis-unresolved" | "basis-changed" |
  "outcome-unknown" | "application-failed" | "application-passed";
export interface ApplicationObservationState {
  status: "not-run" | "passed" | "failed" | "unknown" | "stale";
  reason: ApplicationObservationReason;
  configured: boolean;
}
export type ApplicationObservationProjection = ApplicationObservationState & {
  authority: "agent-observed" | "human-reported" | "none";
};
/** Closed advice, scoped by the containing plan's explicit service/environment. Never permission or a command. */
export interface ConnectionRecovery {
  reason: Exclude<ConnectionPlanBasis["reason"], "resolved"> | Exclude<ApplicationObservationReason, "application-passed"> | "configuration-unobserved";
  actor: "agent" | "human" | "product";
  action: "select-connection-intent" | "review-connection-intent" | "review-environment-selection" | "await-supported-handoff" |
    "restore-vault-access" | "register-environment-credential" | "review-credential-metadata" |
    "await-destination-resolver" | "await-native-configuration-resolver" | "review-destination-basis" |
    "review-native-configuration-basis" | "review-source-coverage" | "inspect-current-plan" |
    "review-observation-storage" | "review-application-evidence" | "review-interrupted-observation" |
    "review-observation-authority" | "review-observation-time" | "review-application-failure" |
    "review-destination-configuration";
}
export interface ConnectionPlan extends ConnectionPlanBasis {
  applicationCheck: ApplicationObservationProjection;
  recovery: ConnectionRecovery[];
}
interface ConnectionPlanBasis {
  schemaVersion: 1;
  service: "resend";
  environment: ConnectionEnvironment;
  route: ConnectionIntent["route"] | null;
  destination: ConnectionIntent["destination"]["kind"] | null;
  status: "planned" | "unknown" | "unsupported";
  reason: "resolved" | "intent-missing" | "intent-unavailable" | "environment-mismatch" | "handoff-pending" |
    "credential-unavailable" | "credential-missing" | "credential-revision-unknown" | "destination-unresolved" | "native-configuration-unresolved" | "source-unresolved" | "basis-changed";
  fingerprint: string | null;
  basis: Basis | null;
  permission: "none";
  execution: "unsupported";
}
export interface ConnectionPlanDeps {
  vault: Vault;
  connectionBaseDir?: string;
  /** Internal/test seam only. Never supplied by CLI, MCP, metadata or environment. */
  resolveDestination?: (intent: ConnectionIntent, projectDir: string) => Promise<(DestinationIdentity & { nativeConfigurationFingerprint?: string }) | null>;
}

export async function buildConnectionPlan(projectDir: string, environment: ConnectionEnvironment,
  deps: ConnectionPlanDeps): Promise<ConnectionPlan> {
  const plan = await resolveConnectionPlan(projectDir, environment, deps);
  const applicationCheck = inspectApplicationObservation(projectDir, environment, deps, plan);
  return { ...plan, applicationCheck, recovery: connectionRecovery(plan, applicationCheck, !!deps.resolveDestination) };
}

async function resolveConnectionPlan(projectDir: string, environment: ConnectionEnvironment,
  deps: ConnectionPlanDeps): Promise<ConnectionPlanBasis> {
  const report: ConnectionPlanBasis = { schemaVersion: 1, service: "resend", environment, route: null,
    destination: null, status: "unknown", reason: "intent-unavailable", fingerprint: null, basis: null,
    permission: "none", execution: "unsupported" };
  try {
    // Match the existing intent/v2 slot path contract. On Windows native
    // realpath expands 8.3 names, which would select a different metadata slot.
    projectDir = realpathSync(projectDir);
    const store = new ConnectionStateStore(projectDir, deps.connectionBaseDir);
    const selected = store.readIntent();
    if (selected.status === "missing") return { ...report, reason: "intent-missing" };
    if (selected.status !== "available") return report;
    const intent = selected.value;
    report.route = intent.route; report.destination = intent.destination.kind;
    if (intent.environment !== environment) return { ...report, reason: "environment-mismatch" };
    if (intent.destination.kind === "github" || intent.destination.kind === "local" || intent.destination.kind === "manual" || intent.route === "manual") {
      return { ...report, status: "unsupported", reason: "handoff-pending" };
    }
    const ref = connectionCredentialRef(projectDir, environment);
    let revision: string | null = null;
    if (intent.route === "api-key-case-managed") {
      try {
        // isAvailable() writes/deletes a probe in the native store. The exact-slot
        // presence read is sufficient; errors remain unknown and no probe is written.
        if (!await deps.vault.hasSecret(ref)) return { ...report, reason: "credential-missing" };
      } catch { return { ...report, reason: "credential-unavailable" }; }
      revision = store.credentialRevision(ref);
      if (!revision) return { ...report, reason: "credential-revision-unknown" };
    }
    const sourceFingerprint = applicationSourceFingerprint(projectDir);
    if (!sourceFingerprint) return { ...report, reason: "source-unresolved" };
    // Existing official CLI identity probes may refresh auth or write logs.
    // No production resolver is installed in this metadata-only contract unit.
    report.reason = "destination-unresolved";
    let identity: Awaited<ReturnType<NonNullable<ConnectionPlanDeps["resolveDestination"]>>> = null;
    try { identity = deps.resolveDestination ? await deps.resolveDestination(intent, projectDir) : null; }
    catch { return { ...report, reason: "destination-unresolved" }; }
    if (!identity || identity.target !== intent.destination.kind || identity.env !== environment ||
        realpathSync.native(identity.projectDir) !== realpathSync.native(projectDir) || !/^[a-f0-9]{64}$/.test(identity.fingerprint)) {
      return { ...report, reason: "destination-unresolved" };
    }
    if (intent.route === "provider-native" &&
        !/^[a-f0-9]{64}$/.test(identity.nativeConfigurationFingerprint ?? "")) {
      return { ...report, reason: "native-configuration-unresolved" };
    }
    report.reason = "basis-changed";
    const latest = store.readIntent();
    if (latest.status !== "available" || connectionIntentFingerprint(latest.value) !== connectionIntentFingerprint(intent) ||
        applicationSourceFingerprint(projectDir) !== sourceFingerprint ||
        (revision !== null && (store.credentialRevision(ref) !== revision || !await deps.vault.hasSecret(ref)))) {
      return { ...report, reason: "basis-changed" };
    }
    const basis: Basis = { credentialRevision: revision,
      credentialFingerprint: revision ? connectionCredentialFingerprint(ref) : null,
      nativeConfigurationFingerprint: intent.route === "provider-native" ? identity.nativeConfigurationFingerprint! : null,
      destinationFingerprint: identity.fingerprint, intentFingerprint: connectionIntentFingerprint(intent), sourceFingerprint };
    return { ...report, status: "planned", reason: "resolved", basis,
      fingerprint: createHash("sha256").update(JSON.stringify({ version: APPLICATION_OBSERVATION_VERSION,
        service: "resend", environment, basis })).digest("hex") };
  } catch { return report; }
}

/** Records a caller's observation, never runs the app or authenticates its claim. */
export async function recordApplicationObservation(projectDir: string, input: {
  environment: ConnectionEnvironment; planFingerprint: string;
  outcome: "passed" | "failed" | "unknown"; configuration: "observed" | "unknown";
  maxAgeSeconds: number;
}, deps: ConnectionPlanDeps): Promise<{ status: "recorded" | "unknown"; authority: "agent-observed"; executed: false }> {
  const unknown = { status: "unknown" as const, authority: "agent-observed" as const, executed: false as const };
  if (!/^[a-f0-9]{64}$/.test(input.planFingerprint) || !["passed", "failed", "unknown"].includes(input.outcome) ||
      !["observed", "unknown"].includes(input.configuration) || !Number.isInteger(input.maxAgeSeconds) ||
      input.maxAgeSeconds < 1 || input.maxAgeSeconds > MAX_APPLICATION_OBSERVATION_SECONDS) return unknown;
  const plan = await buildConnectionPlan(projectDir, input.environment, deps);
  if (!plan.basis || plan.fingerprint !== input.planFingerprint) return unknown;
  const store = new ConnectionStateStore(projectDir, deps.connectionBaseDir);
  const started = store.beginObservation({ kind: "application-check", authority: "agent-observed", basis: {
    credentialRevision: plan.basis.credentialRevision, destinationFingerprint: plan.basis.destinationFingerprint,
    intentFingerprint: plan.basis.intentFingerprint, sourceFingerprint: plan.basis.sourceFingerprint,
    verifierVersion: APPLICATION_OBSERVATION_VERSION, planFingerprint: plan.fingerprint,
    expiresAt: new Date(Date.now() + input.maxAgeSeconds * 1000).toISOString(),
    configurationObserved: input.configuration === "observed"
  } });
  if (!started.ok) return unknown;
  const current = await buildConnectionPlan(projectDir, input.environment, deps);
  if (current.fingerprint !== plan.fingerprint) return unknown; // Interrupted receipt is retained; no retry/execution.
  const result = store.finishObservation(started.value.id,
    input.outcome === "passed" ? "completed" : input.outcome === "failed" ? "failed" : "unknown",
    input.outcome === "passed" ? "application-passed" : input.outcome === "failed" ? "application-failed" : "unknown");
  return result.ok ? { ...unknown, status: "recorded" } : unknown;
}

export function applicationObservationState(entry: ConnectionObservation | null, plan: ConnectionPlanBasis,
  now = Date.now()): ApplicationObservationState {
  const state = (status: ApplicationObservationState["status"], reason: ApplicationObservationReason, configured = false) =>
    ({ status, reason, configured });
  if (!entry) return state("not-run", "observation-missing");
  if (entry.authority !== "agent-observed" || entry.kind !== "application-check") return state("unknown", "authority-mismatch");
  if (entry.basis.verifierVersion !== APPLICATION_OBSERVATION_VERSION) return state("stale", "verifier-changed");
  if (!entry.finishedAt) return state("unknown", "observation-interrupted");
  if (!entry.basis.planFingerprint || !entry.basis.expiresAt) return state("unknown", "observation-basis-missing");
  const start = Date.parse(entry.startedAt), finish = Date.parse(entry.finishedAt), expiry = Date.parse(entry.basis.expiresAt);
  if (![start, finish, expiry, now].every(Number.isFinite) || start > finish || finish > now || expiry <= start ||
      expiry - start > MAX_APPLICATION_OBSERVATION_SECONDS * 1000) return state("stale", "observation-time-invalid");
  if (expiry <= now) return state("stale", "observation-expired");
  if (plan.reason === "credential-missing") return state("stale", "basis-changed");
  if (!plan.basis || !plan.fingerprint) return state("unknown", "basis-unresolved");
  if (entry.basis.planFingerprint !== plan.fingerprint || entry.basis.credentialRevision !== plan.basis.credentialRevision ||
      entry.basis.destinationFingerprint !== plan.basis.destinationFingerprint || entry.basis.intentFingerprint !== plan.basis.intentFingerprint ||
      entry.basis.sourceFingerprint !== plan.basis.sourceFingerprint) return state("stale", "basis-changed");
  if (entry.outcome === "unknown") return state("unknown", "outcome-unknown");
  const configured = entry.basis.configurationObserved === true;
  if (entry.outcome === "completed" && entry.resultCode === "application-passed") return state("passed", "application-passed", configured);
  if (entry.outcome === "failed" && entry.resultCode === "application-failed") return state("failed", "application-failed", configured);
  return state("unknown", "outcome-unknown");
}

function inspectApplicationObservation(projectDir: string, environment: ConnectionEnvironment, deps: ConnectionPlanDeps,
  plan: ConnectionPlanBasis): ApplicationObservationProjection {
  const unknown = (reason: ApplicationObservationReason): ApplicationObservationProjection =>
    ({ status: "unknown", reason, configured: false, authority: "none" });
  try {
    // Keep the exact metadata path identity used by intent and v2 registration.
    const store = new ConnectionStateStore(realpathSync(projectDir), deps.connectionBaseDir);
    const selected = store.readIntent();
    if (selected.status !== "available" || selected.value.environment !== environment ||
        (plan.basis && connectionIntentFingerprint(selected.value) !== plan.basis.intentFingerprint)) {
      return unknown("basis-unresolved");
    }
    const journal = store.readObservations();
    if (journal.status === "unavailable") return unknown(journal.issue === "invalid-data" ? "observation-invalid" : "observation-unavailable");
    const entry = journal.status === "available"
      ? [...journal.value].reverse().find(item => item.connectionId === selected.value.id && item.kind === "application-check" && !item.basis.native && !item.basis.managed) ?? null
      : null;
    const authority = entry?.authority === "agent-observed" || entry?.authority === "human-reported" ? entry.authority : "none";
    return { ...applicationObservationState(entry, plan), authority };
  } catch { return unknown("observation-unavailable"); }
}

function connectionRecovery(plan: ConnectionPlanBasis, application: ApplicationObservationProjection,
  hasResolver: boolean): ConnectionRecovery[] {
  const recovery: ConnectionRecovery[] = [];
  const add = (reason: ConnectionRecovery["reason"], actor: ConnectionRecovery["actor"], action: ConnectionRecovery["action"]) => {
    if (!recovery.some(item => item.reason === reason)) recovery.push({ reason, actor, action });
  };
  // Absent production resolvers are product work, even when a separate input is also missing.
  // Never send the user through key entry/native setup to solve missing product support.
  if (plan.route && plan.reason !== "environment-mismatch" && plan.reason !== "intent-unavailable" &&
      plan.reason !== "handoff-pending" && !hasResolver) {
    add("destination-unresolved", "product", "await-destination-resolver");
    if (plan.route === "provider-native") add("native-configuration-unresolved", "product", "await-native-configuration-resolver");
  }
  switch (plan.reason) {
    case "resolved": break;
    case "intent-missing": add(plan.reason, "human", "select-connection-intent"); break;
    case "intent-unavailable": add(plan.reason, "agent", "review-connection-intent"); break;
    case "environment-mismatch": add(plan.reason, "human", "review-environment-selection"); break;
    case "handoff-pending": add(plan.reason, "product", "await-supported-handoff"); break;
    case "credential-unavailable": add(plan.reason, "human", "restore-vault-access"); break;
    case "credential-missing": add(plan.reason, "human", "register-environment-credential"); break;
    case "credential-revision-unknown": add(plan.reason, "agent", "review-credential-metadata"); break;
    case "destination-unresolved": add(plan.reason, "agent", "review-destination-basis"); break;
    case "native-configuration-unresolved": add(plan.reason, "agent", "review-native-configuration-basis"); break;
    case "source-unresolved": add(plan.reason, "agent", "review-source-coverage"); break;
    case "basis-changed": add(plan.reason, "agent", "inspect-current-plan"); break;
  }
  // Diagnose corrupt storage independently. Otherwise establish a current plan
  // before requesting fresh advisory evidence; never ask for a blind retry.
  if (application.reason === "observation-invalid" || application.reason === "observation-unavailable") {
    add(application.reason, "agent", "review-observation-storage");
  } else if (plan.status === "planned") {
    switch (application.reason) {
      case "application-passed": break;
      case "observation-interrupted": add(application.reason, "agent", "review-interrupted-observation"); break;
      case "authority-mismatch": add(application.reason, "agent", "review-observation-authority"); break;
      case "observation-time-invalid": add(application.reason, "agent", "review-observation-time"); break;
      case "application-failed": add(application.reason, "agent", "review-application-failure"); break;
      default: add(application.reason, "agent", "review-application-evidence");
    }
    if (application.status === "passed" && !application.configured) {
      add("configuration-unobserved", "agent", "review-destination-configuration");
    }
  }
  return recovery;
}
