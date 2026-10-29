import { assertCredentialPurpose } from "../human/acquisition.js";
import { realpathSync } from "node:fs";
import { ConnectionStateStore, type ConnectionEnvironment } from "./connection-state.js";
import { assertConnectionCredentialRef, deriveProjectId } from "../vault/naming.js";
import type { ConnectionCredentialRef, ResendCredentialRef, ClerkCredentialRef, CredentialService, Vault } from "../vault/types.js";
import type { CredentialPurpose, HumanPlane } from "../human/types.js";

export function connectionCredentialRef(projectDir: string, environment: ConnectionEnvironment): ResendCredentialRef {
  const ref: ResendCredentialRef = { name: "RESEND_API_KEY", scope: "project", projectId: deriveProjectId(projectDir),
    service: "resend", environment };
  assertConnectionCredentialRef(ref);
  return ref;
}

/** Scoped Windows lifecycle accepted via PR78; the separate win32 guard remains. */
export const CLERK_CREDENTIAL_NATIVE_ACCEPTED = true;
export function clerkCredentialRef(projectDir: string, environment: ConnectionEnvironment): ClerkCredentialRef {
  const ref: ClerkCredentialRef = { name: "CLERK_SECRET_KEY", scope: "project", projectId: deriveProjectId(projectDir), service: "clerk", environment };
  assertConnectionCredentialRef(ref);
  return ref;
}

/** Closed credential profiles, not a caller-defined provider/runner registry. */
export const CREDENTIAL_SERVICES = ["resend", "clerk", "openai", "stripe-test"] as const;
export function credentialEnvironments(service: CredentialService): readonly ConnectionEnvironment[] {
  return service === "stripe-test" ? ["development", "preview"] : ["development", "preview", "production"];
}
export function credentialRefForService(projectDir: string, environment: ConnectionEnvironment, service: CredentialService): ConnectionCredentialRef {
  if (service === "resend") return connectionCredentialRef(projectDir, environment);
  if (service === "clerk") return clerkCredentialRef(projectDir, environment);
  const ref = { name: service === "openai" ? "OPENAI_API_KEY" : "STRIPE_API_KEY", scope: "project" as const,
    projectId: deriveProjectId(projectDir), service, environment };
  assertConnectionCredentialRef(ref);
  return ref;
}

export type ConnectionCredentialResult = {
  service: CredentialService;
  environment: ConnectionEnvironment;
  status: "registered" | "missing" | "saved" | "removed" | "cancelled" | "unavailable" | "already-registered" | "metadata-unavailable";
};
export interface ConnectionCredentialDeps {
  vault: Vault;
  humanPlane: HumanPlane;
  connectionBaseDir?: string;
  credentialPurpose?: CredentialPurpose;
}

/** Exact-slot local lifecycle. No value argument, terminal fallback, legacy copy, or provider call. */
export async function runConnectionCredential(projectDir: string, environment: ConnectionEnvironment,
  operation: "save" | "check" | "remove", deps: ConnectionCredentialDeps, force = false, service: CredentialService = "resend"): Promise<ConnectionCredentialResult> {
  const result = (status: ConnectionCredentialResult["status"]): ConnectionCredentialResult => ({ service, environment, status });
  try {
    if (!CREDENTIAL_SERVICES.includes(service)) return result("unavailable");
    const canonical = realpathSync(projectDir), ref = credentialRefForService(canonical, environment, service);
    if (!["save", "check", "remove"].includes(operation)) return result("unavailable");
    // Availability writes/deletes a probe credential on the production backend.
    // Inspection needs only exact-slot presence; backend errors remain unavailable.
    // hasSecret may internally read/discard a value, but never returns it here.
    if (operation === "check") return result(await deps.vault.hasSecret(ref) ? "registered" : "missing");
    if (service === "clerk" && (!CLERK_CREDENTIAL_NATIVE_ACCEPTED || process.platform !== "win32")) return result("unavailable");
    assertCredentialPurpose(service, deps.credentialPurpose);
    if (deps.credentialPurpose !== undefined && operation !== "save") return result("unavailable");
    if (!await deps.vault.isAvailable()) return result("unavailable");
    const exists = await deps.vault.hasSecret(ref);
    if (operation === "save" && exists && !force) return result("already-registered");
    if (operation === "remove" && !exists) return result("missing");
    if (deps.humanPlane.capability() !== "os-dialog") return result("unavailable");
    const store = new ConnectionStateStore(canonical, deps.connectionBaseDir);
    const begun = store.beginCredentialMutation(ref);
    if (!begun.ok) return result("metadata-unavailable");
    let completed = false;
    let status: ConnectionCredentialResult["status"] = "unavailable";
    try {
      // The earlier presence probe is advisory. Another process may have completed
      // a save/remove before we acquired this slot's lock.
      const currentExists = await deps.vault.hasSecret(ref);
      if (operation === "save" && currentExists && !force) status = "already-registered";
      else if (operation === "remove" && !currentExists) status = "missing";
      else if (operation === "save") {
        const intent = service === "resend" ? store.readIntent() : null;
        const acquisition = intent?.status === "available" && intent.value.service === "resend" &&
          intent.value.environment === environment && intent.value.route === "api-key-case-managed" &&
          intent.value.destination.kind !== "manual" &&
          (intent.value.destination.kind !== "local" || environment === "development")
          ? { sendingDomain: intent.value.sendingDomain, destination: intent.value.destination.kind } : undefined;
        const saved = await deps.humanPlane.askSecret({ ...ref, projectDir: canonical.replace(/\\/g, "/"),
          ...(acquisition ? { acquisition } : {}),
          ...(deps.credentialPurpose ? { purpose: deps.credentialPurpose } : {}) });
        if (saved === "cancelled") status = "cancelled";
        else if (saved === "saved" && await deps.vault.hasSecret(ref)) { completed = true; status = "saved"; }
      } else {
        const decision = await deps.humanPlane.askRemoval({ kind: "secret", ...ref, projectDir: canonical.replace(/\\/g, "/") });
        if (decision === "declined") status = "cancelled";
        else if (decision === "approved" && await deps.vault.deleteSecret(ref)) { completed = true; status = "removed"; }
      }
    } catch { status = "unavailable"; }
    if (!store.finishCredentialMutation(ref, begun.value, completed)) return result("metadata-unavailable");
    return result(status);
  } catch { return result("unavailable"); }
}
