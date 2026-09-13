import type { SecretRef, SecretScope } from "../vault/types.js";
import type { ApprovalPlan, DeployEnv, TargetId } from "../deploy/types.js";

export type HumanSecretInputStatus = "saved" | "cancelled" | "unavailable";
export type HumanApprovalStatus = "approved" | "declined" | "unavailable";
export type HumanPlaneCapability = "os-dialog" | "handoff-only";

/**
 * Closed display data for the Secret-input Human Plane. It deliberately adds
 * only the resolved project path needed to distinguish storage destinations;
 * no Secret value, provider, or deploy environment can enter this request.
 */
export type SecretInputRequest = SecretRef & {
  /** null only for `user` scope, which is shared by the current OS user. */
  readonly projectDir: string | null;
};

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
  | {
      readonly kind: "secret";
      readonly name: string;
      readonly scope: SecretScope;
      readonly projectId: string | null;
      /** null only for `user` scope, which is not tied to one project. */
      readonly projectDir: string | null;
    }
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
}
