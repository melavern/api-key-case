import { LOCAL_NATIVE_LAUNCH_ACCEPTED, type LocalApplicationStatus } from "../local/session.js";
import type { ConnectionIntent } from "./connection-state.js";
import type { HostReadiness } from "./readiness.js";
import { ConnectionStateStore } from "./connection-state.js";
import { observeLocalPreparationIdentity } from "../local/snapshot.js";
import { deriveProjectId } from "../vault/naming.js";

export type LocalDevelopmentStep = "review-local-state" | "review-previous-attempt" |
  "review-selection-change" | "review-host-support" | "review-credential-state" |
  "review-credential-input" | "prepare-and-inspect" | "review-trial-observations" |
  "review-unstarted-attempt" | "review-local-preparation" | "review-application-observation" |
  "review-mixed-observations";

/** Reports about one ended trial; neither current health nor execution authority. */
export interface LocalTrialObservations {
  attemptId: string;
  agent: "not-reported" | "passed" | "failed" | "unknown" | "mixed";
  human: "not-reported" | "received" | "not-received" | "unknown" | "mixed";
}

export interface LocalPreparationReview {
  status: "unchanged-metadata" | "inputs-changed" | "artifact-changed" | "runtime-changed" | "project-changed" |
    "selection-changed" | "credential-changed" | "expired" | "inputs-unavailable" | "metadata-unavailable";
  artifact: string | null;
  maxDurationMs: number | null;
  inspectedAt: string | null;
  expiresAt: string | null;
}

/** Restores a candidate only; current inspection/approval and bytes are never cached. */
export function readLocalPreparationReview(projectDir: string, intent: ConnectionIntent, revision: string | null, baseDir?: string, expectedSnapshot?: string | null): LocalPreparationReview | null {
  let receipt: ReturnType<ConnectionStateStore["readLocalPreparation"]>;
  let store: ConnectionStateStore;
  const unavailable: LocalPreparationReview = { status: "metadata-unavailable", artifact: null, maxDurationMs: null, inspectedAt: null, expiresAt: null };
  try { store = new ConnectionStateStore(projectDir, baseDir); receipt = store.readLocalPreparation(); }
  catch { return { status: "metadata-unavailable", artifact: null, maxDurationMs: null, inspectedAt: null, expiresAt: null }; }
  if (expectedSnapshot !== undefined && JSON.stringify(receipt) !== expectedSnapshot) return unavailable;
  if (receipt.status === "missing") return null;
  if (receipt.status === "unavailable") return { status: "metadata-unavailable", artifact: null, maxDurationMs: null, inspectedAt: null, expiresAt: null };
  const item = receipt.value, common = { inspectedAt: item.inspectedAt, expiresAt: item.expiresAt };
  if (item.connectionId !== intent.id || item.intentRevision !== intent.updatedAt) return { ...common, status: "selection-changed", artifact: null, maxDurationMs: null };
  if (item.credentialRevision !== revision) return { ...common, status: "credential-changed", artifact: null, maxDurationMs: null };
  const candidate = { ...common, artifact: item.artifact, maxDurationMs: item.maxDurationMs };
  try {
    const current = observeLocalPreparationIdentity(projectDir, item.artifact);
    const currentIntent = store.readIntent();
    if (JSON.stringify(store.readLocalPreparation()) !== JSON.stringify(receipt) || currentIntent.status !== "available" ||
        currentIntent.value.updatedAt !== intent.updatedAt || store.credentialRevision({name:"RESEND_API_KEY",scope:"project",projectId:deriveProjectId(projectDir),service:"resend",environment:"development"}) !== revision) return unavailable;
    for (const [part, status] of [["project", "project-changed"], ["inputs", "inputs-changed"], ["artifact", "artifact-changed"], ["runtime", "runtime-changed"]] as const) {
      if (current[part] !== item.metadataIdentity[part]) return { ...candidate, status };
    }
    return { ...candidate, status: Date.now() < Date.parse(item.inspectedAt) || Date.now() >= Date.parse(item.expiresAt) ? "expired" : "unchanged-metadata" };
  } catch { return { ...candidate, status: "inputs-unavailable" }; }
}

/** Closed advice and an optional past preparation candidate. No execution authority. */
export interface LocalDevelopmentReport {
  service: "resend";
  environment: ConnectionIntent["environment"];
  destination: "local";
  support: "reviewable" | "unsupported-selection" | "unsupported-host" |
    "approval-unavailable" | "native-acceptance-required";
  credential: "registered" | "missing" | "unavailable";
  registrationRevision: "settled" | "unresolved";
  preparation: { build: "not-inspected"; inspection: "not-inspected" };
  preparationReceipt: LocalPreparationReview | null;
  previousAttempt: "none" | "unavailable" | "unfinished-or-uncertain" |
    "selection-changed" | "credential-changed" | "legacy-unbound" | "ended" | "not-started";
  trialObservations: LocalTrialObservations | null;
  nextStep: LocalDevelopmentStep;
  permission: "none";
  applicationReadiness: "not-verified";
}

export function projectLocalDevelopment(options: {
  intent: ConnectionIntent;
  credential: LocalDevelopmentReport["credential"];
  credentialRevision: string | null;
  session: LocalApplicationStatus;
  host: HostReadiness;
  stateCurrent: boolean;
  preparationReceipt?: LocalPreparationReview | null;
}): LocalDevelopmentReport | null {
  const { intent, session, host } = options;
  if (intent.destination.kind !== "local") return null;
  const support: LocalDevelopmentReport["support"] = intent.route !== "api-key-case-managed" || intent.environment !== "development"
    ? "unsupported-selection" : host.platform !== "windows" ? "unsupported-host"
      : !LOCAL_NATIVE_LAUNCH_ACCEPTED ? "native-acceptance-required"
        : host.approval !== "interaction-required" ? "approval-unavailable" : "reviewable";
  const receipt = session.receipt;
  const previousAttempt: LocalDevelopmentReport["previousAttempt"] = session.status === "unavailable" || session.observationHistory.status === "unavailable"
    ? "unavailable" : session.retry === "owner-review-required" || (receipt &&
        (!receipt.finishedAt || receipt.outcome === "unknown" || receipt.treeTermination === "unknown"))
      ? "unfinished-or-uncertain" : !receipt ? "none"
        : session.receiptRelation === "unavailable" ? "unavailable"
          : session.receiptRelation !== "current-selection-and-revision" ? session.receiptRelation as "selection-changed" | "credential-changed" | "legacy-unbound"
            : receipt.execution === "possible" && receipt.treeTermination === "confirmed" ? "ended"
              : receipt.execution === "not-started" && receipt.treeTermination === "not-needed" ? "not-started" : "unfinished-or-uncertain";
  const observable = previousAttempt === "ended" && receipt && ["exited", "failed"].includes(receipt.outcome);
  const latest = options.stateCurrent && observable && session.observationHistory.status === "available"
    ? session.observationHistory.entries.find(entry => entry.relation === "latest-attempt" &&
      entry.basis === "current-selection-and-revision" && JSON.stringify(entry.receipt) === JSON.stringify(receipt)) : undefined;
  let trialObservations: LocalTrialObservations | null = null;
  if (latest) {
    const agent = new Set(latest.observations.flatMap(item => item.authority === "agent-observed" ? [item.outcome] : []));
    const human = new Set(latest.observations.flatMap(item => item.authority === "human-reported" ? [item.outcome] : []));
    trialObservations = { attemptId: latest.receipt.attemptId,
      agent: agent.size === 0 ? "not-reported" : agent.size === 1 ? [...agent][0]! : "mixed",
      human: human.size === 0 ? "not-reported" : human.size === 1 ? [...human][0]! : "mixed" };
  }
  const nextStep: LocalDevelopmentStep = !options.stateCurrent || previousAttempt === "unavailable" ? "review-local-state"
    : previousAttempt === "unfinished-or-uncertain" ? "review-previous-attempt"
      : ["selection-changed", "credential-changed", "legacy-unbound"].includes(previousAttempt) ? "review-selection-change"
        : previousAttempt === "ended" ? (!observable ? "review-previous-attempt" : !trialObservations ? "review-local-state"
          : trialObservations.agent === "mixed" || trialObservations.human === "mixed" ? "review-mixed-observations"
            : trialObservations.agent === "not-reported" ? "review-application-observation" : "review-trial-observations")
          : previousAttempt === "not-started" ? "review-unstarted-attempt"
            : support !== "reviewable" ? "review-host-support"
              : options.credential === "unavailable" || (options.credential === "registered" && !options.credentialRevision) ? "review-credential-state"
                : options.credential === "missing" ? "review-credential-input" : options.preparationReceipt ? "review-local-preparation" : "prepare-and-inspect";
  return { service: "resend", environment: intent.environment, destination: "local", support,
    credential: options.stateCurrent ? options.credential : "unavailable",
    registrationRevision: options.stateCurrent && options.credentialRevision ? "settled" : "unresolved",
    preparation: { build: "not-inspected", inspection: "not-inspected" },
    preparationReceipt: options.stateCurrent ? options.preparationReceipt ?? null : { status: "metadata-unavailable", artifact: null, maxDurationMs: null, inspectedAt: null, expiresAt: null }, previousAttempt, trialObservations, nextStep,
    permission: "none", applicationReadiness: "not-verified" };
}
