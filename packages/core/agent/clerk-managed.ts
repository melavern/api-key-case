import { createHash } from "node:crypto";
import type { ClerkManagedIntent } from "./connection-state.js";

/** Scoped Windows synthetic preparation/consent accepted via PR78, not live-provider acceptance. */
export const CLERK_PREPARATION_NATIVE_ACCEPTED = true;
export function clerkManagedIntentFingerprint(intent: ClerkManagedIntent): string {
  return createHash("sha256").update(JSON.stringify({service:"clerk",environment:intent.environment,
    slot:"default",route:"api-key-case-managed",destination:"cloudflare",operation:"version-preparation"})).digest("hex");
}
