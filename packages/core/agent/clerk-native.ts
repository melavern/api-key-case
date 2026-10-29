import { createHash } from "node:crypto";
import { ConnectionStateStore, type ClerkNativeIntent, type ConnectionEnvironment, type ConnectionMetadataIssue } from "./connection-state.js";

export const CLERK_NATIVE_SETTINGS = Object.freeze([
  Object.freeze({ role: "secret" as const, name: "CLERK_SECRET_KEY" as const }),
  Object.freeze({ role: "publishable" as const, name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" as const })
]);
export function clerkNativeIntentFingerprint(intent: ClerkNativeIntent): string {
  return createHash("sha256").update(JSON.stringify({service:"clerk", environment:intent.environment,
    slot:"default",route:"provider-native",destination:"vercel"})).digest("hex");
}
export interface ClerkNativeReport {
  service: "clerk";
  status: "inactive" | "selected" | "unavailable";
  issue: ConnectionMetadataIssue | null;
  environment: ConnectionEnvironment | null;
  route: "provider-native";
  destination: "vercel";
  /** Expected official mapping; no key value or instance identity is inspected. */
  expectedInstance: "development" | "production" | null;
  requiredSettings: typeof CLERK_NATIVE_SETTINGS;
  configuration: "not-inspected";
  application: "not-checked";
  permission: "none";
}
/** Metadata only; no vault, provider CLI, SDK, app or execution dependency. */
export function readClerkNativeReport(projectDir: string, baseDir?: string): ClerkNativeReport {
  const report: ClerkNativeReport = { service:"clerk",status:"unavailable",issue:"record-unavailable",
    environment:null,route:"provider-native",destination:"vercel",expectedInstance:null,
    requiredSettings:CLERK_NATIVE_SETTINGS,configuration:"not-inspected",application:"not-checked",permission:"none" };
  try {
    const read = new ConnectionStateStore(projectDir, baseDir).readClerkNativeIntent();
    if (read.status === "missing") return {...report,status:"inactive",issue:null};
    if (read.status !== "available") return {...report,issue:read.issue};
    return {...report,status:"selected",issue:null,environment:read.value.environment,
      expectedInstance:read.value.environment === "production" ? "production" : "development"};
  } catch { return report; }
}
