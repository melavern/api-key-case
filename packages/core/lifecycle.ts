import { realpathSync } from "node:fs";
import {
  AUTOMATIC_SAFE_ENVS,
  destinationSlotFingerprint,
  forgetDestinationTrust,
  hasDestinationTrustRecords,
  resolveDestinationIdentity,
  type DestinationTrustRemoval
} from "./deploy/destination.js";
import type { DeployEnv, DeployTarget } from "./deploy/types.js";
import type { HumanPlane } from "./human/types.js";
import { readRegistry, removeRegistryEntry } from "./vault/registry.js";
import {
  assertValidSecretName,
  deriveProjectId,
  removeSecret,
  type SecretRef,
  type SecretScope,
  type Vault
} from "./vault/index.js";

// Phase E lifecycle (v2.1 §11, AC-6).
//
// Everything destructive in this module is a human action. An Agent may reach
// these entry points — that is the point of an Agent-first lifecycle — but it
// can never supply the answer:
//
//   - deleting a Secret destroys a value that cannot be recovered from here;
//   - forgetting a destination changes security state, and an Agent able to do
//     it at will could raise approval dialogs until a human clicks one.
//
// There is no flag, environment variable, stdin path, or MCP parameter that
// completes either one, and no fallback to the caller's terminal when the
// Agent-independent Human Plane is unavailable.

export interface LifecycleDeps {
  vault: Vault;
  humanPlane: HumanPlane;
  print: (line: string) => void;
  registryBaseDir?: string; // test-only; keeps `npm test` off the real vault index
}

export type RemoveSecretResult =
  | { kind: "removed" }
  /** The store had no value; only a stale index entry was cleared. */
  | { kind: "index-pruned" }
  | { kind: "not-registered" }
  | { kind: "declined" }
  | { kind: "human-plane-unavailable" }
  | { kind: "unavailable" }
  | { kind: "vault-read-failed" }
  | { kind: "vault-delete-failed" };

export interface RemoveSecretRequest {
  name: string;
  scope: SecretScope;
  /** The project whose scope is being cleaned up; ignored for `user` scope. */
  projectDir: string;
}

export async function runRemoveSecret(
  deps: LifecycleDeps,
  request: RemoveSecretRequest
): Promise<RemoveSecretResult> {
  assertValidSecretName(request.name);

  let projectDir: string | null = null;
  let projectId: string | null = null;
  if (request.scope === "project") {
    try {
      projectDir = displayPath(realpathSync(request.projectDir));
      projectId = deriveProjectId(request.projectDir);
    } catch {
      deps.print("NG: the project directory is unavailable.");
      return { kind: "unavailable" };
    }
  }

  const ref: SecretRef = { name: request.name, scope: request.scope, projectId };
  let registered: boolean;
  try {
    registered = await deps.vault.hasSecret(ref);
  } catch {
    // A backend read failure is not evidence that the Secret is absent. Keep
    // the registry and the OS store untouched, and let the CLI fail closed.
    return { kind: "vault-read-failed" };
  }

  if (!registered) {
    // Nothing is destroyed here: the store already has no value. Clearing a
    // leftover index row is metadata hygiene, not Secret deletion, so it does
    // not open a dialog.
    if (!hasRegistryEntry(ref, deps.registryBaseDir)) {
      return { kind: "not-registered" };
    }
    removeRegistryEntry(
      { name: ref.name, scope: ref.scope, projectId: ref.projectId },
      deps.registryBaseDir
    );
    return { kind: "index-pruned" };
  }

  deps.print("Removal plan:");
  deps.print(`  secret : ${ref.name} (${ref.scope} scope)`);
  deps.print(`  project: ${projectDir ?? "(user scope: every project on this machine)"}`);

  if (deps.humanPlane.capability() !== "os-dialog") {
    return { kind: "human-plane-unavailable" };
  }

  let decision: Awaited<ReturnType<HumanPlane["askRemoval"]>>;
  try {
    decision = await deps.humanPlane.askRemoval({
      kind: "secret",
      name: ref.name,
      scope: ref.scope,
      projectId: ref.projectId,
      projectDir
    });
  } catch {
    return { kind: "human-plane-unavailable" };
  }
  if (decision === "declined") return { kind: "declined" };
  if (decision !== "approved") return { kind: "human-plane-unavailable" };

  try {
    // A false result after the existence check is an inconsistent or failed
    // deletion, not a stale-index case. removeSecret leaves the index alone.
    if (!(await removeSecret(deps.vault, ref, deps.registryBaseDir))) {
      return { kind: "vault-delete-failed" };
    }
  } catch {
    return { kind: "vault-delete-failed" };
  }
  return { kind: "removed" };
}

export type ForgetDestinationTrustResult =
  | { kind: "forgotten"; removal: DestinationTrustRemoval }
  | { kind: "nothing-recorded" }
  | { kind: "declined" }
  | { kind: "human-plane-unavailable" }
  | { kind: "unavailable" }
  | { kind: "vault-read-failed" }
  | { kind: "vault-delete-failed" };

export interface ForgetDestinationTrustRequest {
  adapter: DeployTarget;
  projectDir: string;
  env: DeployEnv;
  pathOverride?: string; // test-only; threaded through to the CLI resolver
}

export async function runForgetDestinationTrust(
  deps: LifecycleDeps,
  request: ForgetDestinationTrustRequest
): Promise<ForgetDestinationTrustResult> {
  let projectDir: string;
  try {
    projectDir = realpathSync.native(request.projectDir);
  } catch {
    deps.print("NG: the project directory is unavailable.");
    return { kind: "unavailable" };
  }

  // Only an operation class that may repeat without a human ever records a
  // destination, so any other pair has nothing to forget. Answering that from
  // the closed allowlist keeps this from becoming a way for an Agent to spawn
  // provider CLI probes on demand.
  if (!(AUTOMATIC_SAFE_ENVS[request.adapter.id] ?? []).includes(request.env)) {
    return { kind: "nothing-recorded" };
  }

  // Resolving the live destination is what makes it possible to delete the
  // exact confirmation record. The slot fingerprint needs no provider call, so
  // a recorded slot can always be cleaned up.
  const identity = await resolveDestinationIdentity({
    adapter: request.adapter,
    projectDir,
    env: request.env,
    pathOverride: request.pathOverride
  });
  const slot = destinationSlotFingerprint(projectDir, request.adapter.id, request.env);
  let present: Awaited<ReturnType<typeof hasDestinationTrustRecords>>;
  try {
    present = await hasDestinationTrustRecords({ vault: deps.vault, slot, identity });
  } catch {
    // A backend read failure cannot be treated as "nothing recorded".
    return { kind: "vault-read-failed" };
  }
  if (!present.destination && !present.slot) {
    return { kind: "nothing-recorded" };
  }

  deps.print("Forget plan:");
  deps.print(`  target : ${request.adapter.id}`);
  deps.print(`  env    : ${request.env}`);
  deps.print(`  project: ${displayPath(projectDir)}`);
  if (!identity) {
    deps.print("  note   : the current destination could not be resolved.");
  }

  if (deps.humanPlane.capability() !== "os-dialog") {
    return { kind: "human-plane-unavailable" };
  }

  let decision: Awaited<ReturnType<HumanPlane["askRemoval"]>>;
  try {
    decision = await deps.humanPlane.askRemoval({
      kind: "destination-trust",
      target: request.adapter.id,
      env: request.env,
      projectDir: displayPath(projectDir)
    });
  } catch {
    return { kind: "human-plane-unavailable" };
  }
  if (decision === "declined") return { kind: "declined" };
  if (decision !== "approved") return { kind: "human-plane-unavailable" };

  try {
    return {
      kind: "forgotten",
      removal: await forgetDestinationTrust({ vault: deps.vault, slot, identity, expected: present })
    };
  } catch {
    // A confirmed record whose delete fails must remain an unconfirmed result;
    // in particular, do not tell the CLI that the next deploy will re-prompt.
    return { kind: "vault-delete-failed" };
  }
}

/**
 * Project-scoped Secret names this machine's index knows about, for cleanup
 * detection. The index is an ordinary file, so a name from it is only ever a
 * hint: `next` still confirms the value exists in the OS secret store, and a
 * human still sees the real name in the removal dialog before anything is
 * deleted.
 */
export function listIndexedProjectSecretNames(
  projectId: string,
  registryBaseDir?: string
): string[] {
  const names = new Set<string>();
  for (const entry of readRegistry(registryBaseDir)) {
    if (entry.scope !== "project" || entry.projectId !== projectId) continue;
    try {
      assertValidSecretName(entry.name);
    } catch {
      continue;
    }
    names.add(entry.name);
  }
  return [...names].sort();
}

function hasRegistryEntry(ref: SecretRef, registryBaseDir?: string): boolean {
  return readRegistry(registryBaseDir).some(
    (entry) =>
      entry.name === ref.name && entry.scope === ref.scope && entry.projectId === ref.projectId
  );
}

function displayPath(dir: string): string {
  return dir.replace(/\\/g, "/");
}
