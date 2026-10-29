import type { StoredSecretRef } from "../vault/types.js";
import type { ApprovalPlan, DeployEnv, TargetId } from "../deploy/types.js";

export type HumanSecretInputStatus = "saved" | "cancelled" | "unavailable";
export type HumanApprovalStatus = "approved" | "declined" | "unavailable";
export type HumanPlaneCapability = "os-dialog" | "handoff-only";

/**
 * Closed display data for the Secret-input Human Plane. It deliberately adds
 * the resolved project path needed to distinguish storage destinations.
 * Connection credentials also identify their closed service/environment slot;
 * no Secret value can enter this request.
 */
export type SecretInputRequest = StoredSecretRef & {
  /** null only for `user` scope, which is shared by the current OS user. */
  readonly projectDir: string | null;
  /** Display only; supplied from the matching validated managed connection. */
  readonly acquisition?: { readonly sendingDomain: string | null; readonly destination: "local" | "vercel" | "cloudflare" | "github" };
  /** Closed, advisory project purpose; never a permission/account assertion. */
  readonly purpose?: CredentialPurpose;
};

export type CredentialPurpose = "email-sending" | "text-generation" | "embeddings" | "image-generation" | "test-payments";

/**
 * A Phase E lifecycle deletion presented to a human (v2.1 §11).
 *
 * Both variants are closed: every rendered field is either a closed enum or a
 * validated identifier/path. Deleting a Secret destroys a stored value, and
 * forgetting a destination changes security state, so neither is an
 * `actor: agent` action — an Agent may request the dialog but can never supply
 * the answer.
 */
export type RemovalPlan =
  | (StoredSecretRef & {
      readonly kind: "secret";
      /** null only for `user` scope, which is not tied to one project. */
      readonly projectDir: string | null;
    })
  | {
      readonly kind: "destination-trust";
      readonly target: TargetId;
      readonly env: DeployEnv;
      readonly projectDir: string;
    };

// Deliberately has no API that returns a Secret value. The implementation
// stores the value inside the Human Plane and returns status only.
export interface HumanPlane {
  capability(): HumanPlaneCapability;
  askSecret(request: SecretInputRequest): Promise<HumanSecretInputStatus>;
  // The approval result is consumed inside one deploy call. Callers must not
  // persist, serialize, or pass it to a later invocation.
  askApproval(plan: ApprovalPlan): Promise<HumanApprovalStatus>;
  // Same one-shot contract as askApproval: the answer is consumed by the
  // single lifecycle call that asked for it and is never persisted.
  askRemoval(plan: RemovalPlan): Promise<HumanApprovalStatus>;
  // Optional only so existing platforms/implementations fail closed.
  askLocalApplication?(plan: LocalApplicationApproval): Promise<HumanApprovalStatus>;
}

/** Fresh, one-session Windows verification; no grant or reusable token. */
export interface LocalApplicationApproval {
  readonly projectDir: string;
  readonly artifactPath: string;
  readonly interpreterPath: string;
  readonly service: "resend";
  readonly environment: "development";
  readonly credentialRevision: string;
  readonly maxDurationMs: number;
}
