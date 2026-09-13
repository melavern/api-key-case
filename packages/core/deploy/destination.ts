import { createHash } from "node:crypto";
import { buildTrustedExecution, matchesTrustedExecution, type ExecutionSnapshot, type SnapshotRequest } from "./snapshot.js";
import type { DeployEnv, DeployPlan, DeployTarget, TargetId } from "./types.js";
import type { DestinationTrustRef, SecretScope, Vault } from "../vault/types.js";

// Phase D Destination Boundary (v2.1 §3.2, §10, AC-7, AC-8).
//
// A Destination Identity answers only one question: *where* would this deploy
// put a value. It is a fingerprint of the execution conditions that select the
// destination, never a semantic parse of provider account names, and never
// anything derived from a Secret value.
//
// What the fingerprint binds:
//   - the single fixed project working directory (realpath)
//   - the deploy target and environment
//   - the destination-selecting repository config: its path, kind, closed
//     destination label, and the Secret-free content projection hash
//   - the non-credential provider account identity resolved through the same
//     fixed CLI and sanitized environment as the deploy itself
//
// What it deliberately does not bind:
//   - Secret name, scope, value, partial value, value-derived hash, or length
//   - provider credential values or hashes of them (their mere presence in the
//     environment already makes the operation fail closed in snapshot.ts)
//   - provider auth file timestamps and the resolved CLI file identity. Those
//     change on an ordinary token refresh or CLI upgrade and are execution
//     integrity, not destination: Phase C keeps re-verifying them inside the
//     one call that runs, so a CLI upgrade does not silently move a value and
//     does not force a human to re-confirm an unchanged destination.

const IDENTITY_VERSION = "akc-destination-1";

// The adapters produce closed identity strings ("accounts:<hex>", "user:<login>").
// Anything else is treated as an unresolvable destination.
const PROVIDER_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.,-]{0,511}$/;

const STATUS_PROBE_NAME = "AKC_DESTINATION_STATUS";

export type DestinationTrustState = "trusted" | "changed" | "unconfirmed";
export type DestinationTrustStatus = DestinationTrustState | "unresolved";

export interface DestinationIdentity {
  readonly target: TargetId;
  readonly env: DeployEnv;
  readonly projectDir: string;
  /** sha256 of the closed destination projection. */
  readonly fingerprint: string;
  /** sha256 of the (project, target, environment) slot only. */
  readonly slot: string;
}

/**
 * The closed allowlist of operations that may ever run without a human, before
 * destination trust is even considered.
 *
 * Cloudflare is absent because `wrangler secret put` always overwrites an
 * existing value (adapters/cloudflare.ts sets `overwriteWarning`), and v2.1 §10
 * keeps overwrite-capable operations out of automatic execution. GitHub is
 * absent because a GitHub secret of either kind is CI-reachable regardless of
 * `--env`. Vercel `development` is absent because Vercel's API does not permit
 * a sensitive variable there at all, so its value is readable back through
 * `vercel env pull` (AC-8), and Vercel `production` is high-risk by
 * definition. That leaves Vercel `preview`, which fails instead of overwriting
 * and which adapters/vercel.ts always creates with an explicit `--sensitive`,
 * so the value cannot be read back. That write-only guarantee is this tool's
 * own, not an inherited Vercel or team default; a test asserts every entry
 * below still plans sensitive storage.
 */
export const AUTOMATIC_SAFE_ENVS: Readonly<Record<TargetId, readonly DeployEnv[]>> = Object.freeze({
  cloudflare: Object.freeze([] as DeployEnv[]),
  vercel: Object.freeze(["preview"] as DeployEnv[]),
  github: Object.freeze([] as DeployEnv[])
});

export interface AutomaticOperation {
  readonly target: TargetId;
  readonly env: DeployEnv;
  readonly scope: SecretScope;
  readonly force: boolean;
  readonly plan: DeployPlan;
}

/**
 * Deny by default. Explicit denials run first so that a future adapter cannot
 * become automatic by accident, and the allowlist above is the only way to
 * return true.
 */
export function isAutomaticSafeOperation(operation: AutomaticOperation): boolean {
  if (operation.force) return false;
  if (operation.env === "production") return false;
  if (operation.target === "github") return false;
  if (operation.target === "vercel" && operation.env === "development") return false;
  // Destructive or overwrite-capable provider behaviour, in either the main
  // step or a pre-step, always belongs to the Human Plane.
  if (operation.plan.overwriteWarning) return false;
  if ((operation.plan.preSteps?.length ?? 0) > 0) return false;
  // A user-scoped Secret is shared across projects, so a project's confirmed
  // destination is not a confirmation to place it there.
  if (operation.scope !== "project") return false;
  return (AUTOMATIC_SAFE_ENVS[operation.target] ?? []).includes(operation.env);
}

/**
 * Derives the Destination Identity from an execution snapshot that
 * `buildTrustedExecution` already accepted, plus the provider account identity
 * confirmed through that same snapshot's fixed CLI and sanitized environment.
 * Returns null whenever the destination cannot be pinned down; the caller must
 * then fail closed.
 */
export function destinationIdentity(
  snapshot: ExecutionSnapshot,
  providerIdentity: string | null
): DestinationIdentity | null {
  if (!providerIdentity || !PROVIDER_IDENTITY_PATTERN.test(providerIdentity)) return null;
  // Both conditions already fail buildTrustedExecution; re-checking here keeps
  // this function safe to call on any snapshot.
  if (snapshot.providerEnvNames.length > 0) return null;
  if (snapshot.projectEnvFiles.some((file) => file.exists)) return null;

  const config = snapshot.destinationConfig
    .filter((file) => file.exists)
    .map((file) => ({
      path: file.path.replace(/\\/g, "/"),
      kind: file.kind,
      label: file.destinationLabel,
      hash: file.contentHash
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (!config.some((entry) => entry.label)) return null;

  const slotPayload = slotPayloadFor(snapshot.projectDir, snapshot.target, snapshot.env);

  return Object.freeze({
    target: snapshot.target,
    env: snapshot.env,
    projectDir: snapshot.projectDir,
    fingerprint: sha256(JSON.stringify({ ...slotPayload, providerIdentity, config })),
    slot: sha256(JSON.stringify(slotPayload))
  });
}

/**
 * The (project, target, environment) slot fingerprint. It needs no provider
 * call, which is what lets Phase E clean up a recorded slot even when the
 * current destination can no longer be resolved.
 */
export function destinationSlotFingerprint(
  projectDir: string,
  target: TargetId,
  env: DeployEnv
): string {
  return sha256(JSON.stringify(slotPayloadFor(projectDir, target, env)));
}

function slotPayloadFor(projectDir: string, target: TargetId, env: DeployEnv) {
  return { v: IDENTITY_VERSION, projectDir, target, env };
}

export async function readDestinationTrust(
  vault: Vault,
  identity: DestinationIdentity
): Promise<DestinationTrustState> {
  if (await vault.hasDestinationTrust(trustRef("destination", identity.fingerprint))) {
    return "trusted";
  }
  if (await vault.hasDestinationTrust(trustRef("destination-slot", identity.slot))) {
    return "changed";
  }
  return "unconfirmed";
}

/**
 * Records that a human confirmed this destination. Only the deploy engine may
 * call this, and only immediately after an Agent-independent Human Plane
 * approval for that exact destination. There is no CLI flag, MCP parameter,
 * environment variable, or stdin path that reaches it.
 */
export async function recordDestinationTrust(
  vault: Vault,
  identity: DestinationIdentity
): Promise<void> {
  // Slot first, exact destination second: readDestinationTrust only returns
  // "trusted" once the exact record exists, so a failure between these two
  // writes must never leave the exact record saved without the slot. Saving
  // the slot first means a failure on the second write leaves no exact
  // record at all, which readDestinationTrust and the caller's "the next
  // deploy will ask again" warning both already treat as untrusted.
  await vault.saveDestinationTrust(trustRef("destination-slot", identity.slot));
  await vault.saveDestinationTrust(trustRef("destination", identity.fingerprint));
}

/**
 * Removes the records for one destination (Phase E, v2.1 §11). Only the
 * lifecycle module may call this, and only immediately after an
 * Agent-independent Human Plane decision for that exact destination.
 *
 * Forgetting is fail-safe in direction — it can only take away permission to
 * skip the Human Plane, never grant it — but it is still a security-state
 * change, so it is never an `actor: agent` action: an Agent that could delete
 * trust at will could force approval dialogs until a human clicks through one.
 *
 * `destination: "unresolved"` means the current destination could not be
 * fingerprinted, so a confirmation recorded for it may still exist.
 */
export async function forgetDestinationTrust(options: {
  vault: Vault;
  slot: string;
  identity: DestinationIdentity | null;
  /** Presence observed before the Human Plane decision. */
  expected: DestinationTrustPresence;
}): Promise<DestinationTrustRemoval> {
  // Exact destination first, slot second: readDestinationTrust only returns
  // "trusted" while the exact record still exists, so a failure between
  // these two deletes must never leave the exact record behind. Deleting it
  // first means a failure on the second delete leaves only the slot record,
  // which readDestinationTrust already reports as "changed", not "trusted".
  if (!options.identity) {
    const slot = await deleteDestinationTrustRecord(
      options.vault,
      trustRef("destination-slot", options.slot),
      options.expected.slot
    );
    return { destination: "unresolved", slot };
  }
  const destination = await deleteDestinationTrustRecord(
    options.vault,
    trustRef("destination", options.identity.fingerprint),
    options.expected.destination
  );
  const slot = await deleteDestinationTrustRecord(
    options.vault,
    trustRef("destination-slot", options.slot),
    options.expected.slot
  );
  return { destination, slot };
}

/** Existence-only lookup used to skip a pointless removal dialog. */
export async function hasDestinationTrustRecords(options: {
  vault: Vault;
  slot: string;
  identity: DestinationIdentity | null;
}): Promise<DestinationTrustPresence> {
  return {
    destination: options.identity
      ? await options.vault.hasDestinationTrust(trustRef("destination", options.identity.fingerprint))
      : false,
    slot: await options.vault.hasDestinationTrust(trustRef("destination-slot", options.slot))
  };
}

export interface DestinationTrustPresence {
  readonly destination: boolean;
  readonly slot: boolean;
}

async function deleteDestinationTrustRecord(
  vault: Vault,
  ref: DestinationTrustRef,
  expected: boolean
): Promise<"removed" | "absent"> {
  // Under @napi-rs/keyring 2.x, false means absent and backend failures throw.
  // Since a record confirmed present must return true, false is an
  // unconfirmed delete and must fail closed just like a thrown backend error.
  const removed = await vault.deleteDestinationTrust(ref);
  if (!removed && expected) throw new Error("Destination trust deletion was not confirmed.");
  return removed ? "removed" : "absent";
}

export interface DestinationTrustRemoval {
  readonly destination: "removed" | "absent" | "unresolved";
  readonly slot: "removed" | "absent";
}

/**
 * Status-only destination trust lookup for the Agent Control Plane. It uses
 * the same trusted resolution a real deploy would use, creates no deploy plan,
 * touches no Secret, and can only ever read a trust record.
 */
export async function inspectDestinationTrust(options: {
  vault: Vault;
  adapter: DeployTarget;
  projectDir: string;
  env: DeployEnv;
  pathOverride?: string;
}): Promise<DestinationTrustStatus> {
  const identity = await resolveDestinationIdentity(options);
  if (!identity) return "unresolved";
  return await readDestinationTrust(options.vault, identity);
}

/**
 * Resolves the Destination Identity a deploy would use right now, through the
 * same fixed CLI and sanitized environment, without creating a deploy plan,
 * touching a Secret, or writing anything. Returns null when the destination
 * cannot be pinned down.
 */
export async function resolveDestinationIdentity(options: {
  adapter: DeployTarget;
  projectDir: string;
  env: DeployEnv;
  pathOverride?: string;
}): Promise<DestinationIdentity | null> {
  try {
    const probePlan: DeployPlan = {
      argv: [options.adapter.cliCommand],
      valueVia: "stdin",
      displayCommand: options.adapter.cliCommand,
      overwriteWarning: false
    };
    const request: SnapshotRequest = {
      name: STATUS_PROBE_NAME,
      scope: "project",
      projectId: null,
      env: options.env,
      force: false,
      adapterId: options.adapter.id,
      cliCommand: options.adapter.cliCommand,
      providerIdentity: null
    };
    const bound = buildTrustedExecution(
      request,
      probePlan,
      { pathOverride: options.pathOverride, projectDir: options.projectDir }
    );
    if (!bound.ok) return null;

    const cli = await options.adapter.checkCli({
      cwd: bound.execution.cwd,
      env: bound.execution.env,
      resolvedCli: bound.execution.resolvedCli,
      pathOverride: options.pathOverride
    });
    if (!cli.installed || !cli.loggedIn || !cli.identity) return null;
    // A history comparison must not label a changed CLI/config snapshot as the
    // current selection just because its advisory login probe returned success.
    if (!matchesTrustedExecution(request, probePlan, bound.execution)) return null;

    return destinationIdentity(bound.execution.snapshot, cli.identity);
  } catch {
    return null;
  }
}

function trustRef(kind: DestinationTrustRef["kind"], fingerprint: string): DestinationTrustRef {
  return { kind, fingerprint };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
