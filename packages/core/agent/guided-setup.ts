import type { NextReport } from "./next.js";
import type { ConnectionIntent } from "./connection-state.js";

/** One bounded acquisition guide, not a provider registry or a deploy target. */
export interface ResendGuidedSetup {
  service: "resend";
  credential: "RESEND_API_KEY";
  purpose: "resend-api-authentication";
  registration: {
    status: "registered" | "missing" | "unavailable";
    scope: "user" | "project" | null;
  };
  stage: "review-exposure" | "prepare-storage" | "human-handoff" | "acquire-and-save" | "stored";
  acquisition: {
    dashboardUrl: "https://resend.com/api-keys";
    documentationUrl: "https://resend.com/docs/create-an-api-key";
    steps: readonly ["human-sign-in", "human-create-api-key", "human-select-permission-and-domain", "human-copy-once-to-human-plane"];
  };
  connectionState: "not-tested";
  runtimeAccess: "not-configured-by-this-flow";
}

// The containing connection report supplies the exact selected environment.
// Input is existence-only state already collected by next. No vault, browser,
// network, instruction-file writes, values or human approval enter this guide.
export function buildResendGuidedSetup(
  intent: ConnectionIntent,
  status: ResendGuidedSetup["registration"]["status"],
  host: NextReport["host"],
  possibleExposure: boolean
): ResendGuidedSetup | null {
  if (!supportsResendCredentialGuide(intent)) return null;
  const stage = possibleExposure ? "review-exposure"
    : status === "unavailable" ? "prepare-storage"
      : status === "registered" ? "stored"
        : host.secretInput === "unavailable" ? "human-handoff" : "acquire-and-save";
  return {
    service: "resend",
    credential: "RESEND_API_KEY",
    purpose: "resend-api-authentication",
    registration: { status, scope: "project" },
    stage,
    acquisition: {
      dashboardUrl: "https://resend.com/api-keys",
      documentationUrl: "https://resend.com/docs/create-an-api-key",
      steps: ["human-sign-in", "human-create-api-key", "human-select-permission-and-domain", "human-copy-once-to-human-plane"]
    },
    connectionState: "not-tested",
    runtimeAccess: "not-configured-by-this-flow"
  };
}

/** Existing explicit storage/placement operations, not generic local planning. */
export function supportsResendCredentialGuide(intent: ConnectionIntent): boolean {
  return intent.route === "api-key-case-managed" &&
    (["vercel", "cloudflare", "github"].includes(intent.destination.kind) ||
      (intent.destination.kind === "local" && intent.environment === "development"));
}
