export type SecretScope = "user" | "project"; // NOTE: "team" is a planned future scope; do not implement.

export interface SecretRef {
  name: string; // validated: ^[A-Z][A-Z0-9_]{0,127}$
  scope: SecretScope;
  projectId: string | null; // null when scope === "user"
}

/**
 * A Phase D destination trust record (v2.1 §3.2).
 *
 * `destination` is the exact destination identity a human confirmed once;
 * `destination-slot` is the (project, target, environment) slot, used only to
 * tell a first use apart from a destination that changed since that
 * confirmation.
 *
 * These records live in the OS secret store rather than in a file so that an
 * Agent cannot mint one by writing to disk. Neither record holds a Secret
 * value, a partial value, a value-derived hash, or a Secret length, and
 * neither is an approval token: on its own it authorizes no operation. The
 * deploy engine still re-resolves the current destination, re-checks the
 * operation class, and re-verifies the execution snapshot before every spawn.
 *
 * Phase E adds deletion. Forgetting a record only ever removes permission to
 * skip the Human Plane, so it is fail-safe in direction — but it is still a
 * security-state change, so it goes through the same Agent-independent Human
 * Plane as any other trust decision.
 */
export interface DestinationTrustRef {
  kind: "destination" | "destination-slot";
  fingerprint: string; // validated: ^[0-9a-f]{64}$
}

// Deliberately has NO method that returns a secret value. Do not add one.
export interface Vault {
  readonly backendName: string;
  isAvailable(): Promise<boolean>;
  setSecret(ref: SecretRef, value: string): Promise<void>;
  hasSecret(ref: SecretRef): Promise<boolean>;
  deleteSecret(ref: SecretRef): Promise<boolean>; // true = deleted; false = absent
  hasDestinationTrust(ref: DestinationTrustRef): Promise<boolean>;
  saveDestinationTrust(ref: DestinationTrustRef): Promise<void>;
  deleteDestinationTrust(ref: DestinationTrustRef): Promise<boolean>; // true = deleted; false = absent
}

export class VaultUnavailableError extends Error {}
export class SecretNameError extends Error {}
/**
 * The OS-store write completed, but the local, value-free metadata update did
 * not. Callers must report these results separately so an index failure is not
 * mistaken for a Secret-store failure.
 */
export class SecretStoreMetadataError extends Error {
  constructor() {
    super("Secret was saved to the OS secret store, but the local metadata index update failed.");
    this.name = "SecretStoreMetadataError";
  }
}

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export function assertValidSecretName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new SecretNameError(
      `Invalid secret name: ${name}. Names must match ${NAME_PATTERN.source}.`
    );
  }
}
