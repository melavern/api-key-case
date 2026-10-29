import { DESTINATION_TRUST_MARKER, toAccount, toDestinationAccount, VAULT_SERVICE } from "./naming.js";
import type { DestinationTrustRef, StoredSecretRef, Vault } from "./types.js";

// In-process test double. Not selectable from the CLI: the backend a value
// travels through must never be switchable via a runtime flag.
export class MemoryVault implements Vault {
  readonly backendName = "memory";
  private readonly store = new Map<string, string>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async setSecret(ref: StoredSecretRef, value: string): Promise<void> {
    this.store.set(this.key(ref), value);
  }

  async hasSecret(ref: StoredSecretRef): Promise<boolean> {
    return this.store.has(this.key(ref));
  }

  async deleteSecret(ref: StoredSecretRef): Promise<boolean> {
    return this.store.delete(this.key(ref));
  }

  async hasDestinationTrust(ref: DestinationTrustRef): Promise<boolean> {
    return this.store.has(this.destinationKey(ref));
  }

  async saveDestinationTrust(ref: DestinationTrustRef): Promise<void> {
    this.store.set(this.destinationKey(ref), DESTINATION_TRUST_MARKER);
  }

  async deleteDestinationTrust(ref: DestinationTrustRef): Promise<boolean> {
    return this.store.delete(this.destinationKey(ref));
  }

  private key(ref: StoredSecretRef): string {
    return `${VAULT_SERVICE}\0${toAccount(ref)}`;
  }

  private destinationKey(ref: DestinationTrustRef): string {
    return `${VAULT_SERVICE}\0${toDestinationAccount(ref)}`;
  }
}
