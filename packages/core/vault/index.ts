import { KeyringVault } from "./keyring.js";
import { removeRegistryEntry, upsertRegistryEntry, readRegistry, type RegistryEntry } from "./registry.js";
import { SecretStoreMetadataError, type SecretRef, type Vault } from "./types.js";

export function createVault(): Vault {
  return new KeyringVault();
}

export async function saveSecret(
  vault: Vault,
  ref: SecretRef,
  value: string,
  projectPath: string | null
): Promise<void> {
  await vault.setSecret(ref, value);
  try {
    upsertRegistryEntry({
      name: ref.name,
      scope: ref.scope,
      projectId: ref.projectId,
      projectPath
    });
  } catch {
    throw new SecretStoreMetadataError();
  }
}

export async function removeSecret(
  vault: Vault,
  ref: SecretRef,
  registryBaseDir?: string // test-only; keeps `npm test` off the real vault index
): Promise<boolean> {
  const removed = await vault.deleteSecret(ref);
  if (!removed) {
    // A false result is only safe to interpret as absence when the caller has
    // not already confirmed that the Secret exists. Never clear metadata after
    // an unconfirmed deletion result.
    return false;
  }
  removeRegistryEntry(
    { name: ref.name, scope: ref.scope, projectId: ref.projectId },
    registryBaseDir
  );
  return true;
}

export type VaultListEntry = RegistryEntry & { storeStatus: "registered" | "stale" };

export async function listSecrets(
  vault: Vault,
  scope: SecretRef["scope"],
  projectId: string | null
): Promise<VaultListEntry[]> {
  const entries = readRegistry().filter(
    (entry) => entry.scope === scope && entry.projectId === projectId
  );

  const withStatus: VaultListEntry[] = [];
  for (const entry of entries) {
    const registered = await vault.hasSecret({
      name: entry.name,
      scope: entry.scope,
      projectId: entry.projectId
    });
    withStatus.push({ ...entry, storeStatus: registered ? "registered" : "stale" });
  }

  return withStatus;
}

export * from "./types.js";
export * from "./naming.js";
export * from "./registry.js";
