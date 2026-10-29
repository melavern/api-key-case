import { realpathSync } from "node:fs";
import { ConnectionStateStore, type ConnectionEnvironment } from "./connection-state.js";
import { connectionCredentialFingerprint, connectionIntentFingerprint } from "./fingerprints.js";
import { RESEND_VERIFIER_VERSION, type ResendValidationCode } from "./resend-doctor.js";
import { connectionCredentialRef } from "./connection-credential.js";
import { currentResolvedCli, isSameResolvedCli, resolveTrustedCli, type ResolvedCli } from "../deploy/which.js";
import { runResendCredentialValidation } from "../deploy/handoff.js";
import type { Vault } from "../vault/types.js";

export interface ConnectionCheckResult {
  service: "resend";
  status: "valid" | "invalid" | "unknown";
  resultCode: ResendValidationCode;
  recorded: boolean;
  /** Present only for an explicitly environment-bound request. Never a provider fact. */
  environment?: ConnectionEnvironment | null;
  reason?: "invalid-environment" | "environment-mismatch";
}
/** Test seams are never flags or environment variables in the production CLI. */
export interface ConnectionCheckDeps {
  vault: Vault;
  /** Optional compatibility guard; absence retains the selected-intent legacy contract. */
  expectedEnvironment?: ConnectionEnvironment;
  registryBaseDir?: string;
  connectionBaseDir?: string;
  resolveCli?: (projectDir: string) => ResolvedCli | null;
  validate?: typeof runResendCredentialValidation;
}

export async function checkResendConnection(projectDir: string, deps: ConnectionCheckDeps): Promise<ConnectionCheckResult> {
  const guarded = "expectedEnvironment" in deps;
  const environment = ["development", "preview", "production"].includes(deps.expectedEnvironment ?? "")
    ? deps.expectedEnvironment! : null;
  const result = (code: ResendValidationCode = "unknown", recorded = false,
    reason?: ConnectionCheckResult["reason"]): ConnectionCheckResult => ({
    service: "resend", status: code.startsWith("valid-") ? "valid" : code === "invalid-credential" ? "invalid" : "unknown",
    resultCode: code, recorded, ...(guarded ? { environment, ...(reason ? { reason } : {}) } : {})
  });
  if (guarded && !environment) return result("unknown", false, "invalid-environment");
  try {
    const canonical = realpathSync(projectDir);
    const store = new ConnectionStateStore(canonical, deps.connectionBaseDir);
    const intent = store.readIntent();
    if (intent.status !== "available") return result();
    if (guarded && intent.value.environment !== environment) return result("unknown", false, "environment-mismatch");
    if (intent.value.route !== "api-key-case-managed") return result();
    const ref = connectionCredentialRef(canonical, intent.value.environment);
    const revision = store.credentialRevision(ref);
    if (!revision) return result();
    const intentFingerprint = connectionIntentFingerprint(intent.value);
    const credentialFingerprint = connectionCredentialFingerprint(ref);
    const selectionCurrent = () => {
      if (realpathSync(projectDir) !== canonical) return false;
      const now = store.readIntent();
      return now.status === "available" && now.value.id === intent.value.id && now.value.updatedAt === intent.value.updatedAt &&
        connectionIntentFingerprint(now.value) === intentFingerprint && connectionCredentialFingerprint(ref) === credentialFingerprint &&
        store.credentialRevision(ref) === revision;
    };
    // Recheck after every awaited availability/presence read, before resolving a
    // provider CLI or writing an observation for the captured selection.
    if (!await deps.vault.isAvailable() || !selectionCurrent()) return result();
    if (!await deps.vault.hasSecret(ref) || !selectionCurrent()) return result();
    const cli = (deps.resolveCli ?? ((dir) => resolveTrustedCli("resend", { projectDir: dir })))(canonical);
    if (!selectionCurrent()) return result();
    const begun = store.beginObservation({
      kind: "credential-validation", authority: "provider-observed",
      basis: { credentialRevision: revision, destinationFingerprint: null, intentFingerprint,
        sourceFingerprint: credentialFingerprint, verifierVersion: RESEND_VERIFIER_VERSION }
    });
    // Never execute without an interruption-safe unknown receipt on disk.
    if (!begun.ok) return result();
    const stillCurrent = async () => {
      if (!selectionCurrent() || begun.value.connectionId !== intent.value.id) return false;
      const present = await deps.vault.hasSecret(ref);
      // Presence is awaited. Re-read the intent, revision and journal after it;
      // a selection replaced during that await must never report success.
      if (!present || !selectionCurrent()) return false;
      const observations = store.readObservations();
      const executable = cli ? currentResolvedCli(cli) : null;
      return observations.status === "available" &&
        observations.value.some((entry) => entry.id === begun.value.id && entry.finishedAt === null) &&
        Boolean(cli && executable && isSameResolvedCli(cli, executable));
    };
    let code: ResendValidationCode = "cli-unavailable";
    if (cli) {
      code = await stillCurrent() ? await (deps.validate ?? runResendCredentialValidation)({ ref, cli, stillCurrent }) : "unknown";
      if (!await stillCurrent()) code = "unknown";
    }
    // Explicit allowlist also protects the test seam and any future implementation drift.
    if (!["valid-full-access", "valid-sending-access", "invalid-credential", "cli-unavailable",
      "network-unavailable", "unexpected-output", "unknown"].includes(code)) code = "unknown";
    const outcome = code.startsWith("valid-") ? "completed" : code === "invalid-credential" ? "failed" : "unknown";
    const finished = store.finishObservation(begun.value.id, outcome, code);
    // A provider answer without a durable receipt must never be reported as current success.
    return finished.ok ? result(code, true) : result();
  } catch { return result(); }
}
