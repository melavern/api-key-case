import { resolve } from "node:path";
import {
  ConnectionStateStore,
  type ConnectionEnvironment,
  type ConnectionResumeInput,
  type ConnectionResumePlanInput,
  type ConnectionResumeReport,
  type ConnectionRoute
} from "../core/agent/connection-state.js";

const USAGE = "Usage: api-key-case connection resume <plan|apply> --service <resend|clerk|openai|stripe-test> --env <development|preview|production> [--route <provider-native|api-key-case-managed|manual>] [--fingerprint <64-lowercase-hex-plan-sha256> (required for apply only)] [--json] [path]. Route is required for apply and every non-Resend profile; Resend plan may read the recorded route when omitted. Restores only a previously recorded local selection; no credential, local destination configuration or provider operation. Clerk does not support manual. OpenAI and Stripe test require api-key-case-managed; Stripe test supports development and preview only.";
const FINGERPRINT = /^[0-9a-f]{64}$/;

/** Explicit environment; Resend plan alone may discover the exact recorded route. */
export function runConnectionResumeCommand(args: string[]): number {
  const [operation, ...options] = args;
  const invalid = () => { console.error(USAGE); return 1; };
  if (operation !== "plan" && operation !== "apply") return invalid();
  let project = process.cwd(), pathSeen = false, json = false;
  const fields = new Map<string, string>();
  const allowed = ["--service", "--env", "--route", ...(operation === "apply" ? ["--fingerprint"] : [])];
  for (let index = 0; index < options.length; index++) {
    const arg = options[index], value = options[index + 1];
    if (allowed.includes(arg) && !fields.has(arg) && value && !value.startsWith("-")) {
      fields.set(arg, value);
      index++;
    } else if (arg === "--json" && !json) json = true;
    else if (arg && !arg.startsWith("-") && !pathSeen) { pathSeen = true; project = resolve(arg); }
    else return invalid();
  }
  const service = fields.get("--service"), environment = fields.get("--env"), route = fields.get("--route");
  if ((service !== "resend" && service !== "clerk" && service !== "openai" && service !== "stripe-test") ||
      !environment || !["development", "preview", "production"].includes(environment) ||
      (route !== undefined && !["provider-native", "api-key-case-managed", "manual"].includes(route)) ||
      (!route && (operation === "apply" || service !== "resend")) ||
      (service === "clerk" && route === "manual") ||
      ((service === "openai" || service === "stripe-test") && route !== "api-key-case-managed") ||
      (service === "stripe-test" && environment === "production")) return invalid();
  const fingerprint = fields.get("--fingerprint");
  if (operation === "apply" && (!fingerprint || !FINGERPRINT.test(fingerprint))) return invalid();
  const input: ConnectionResumePlanInput = service === "resend"
    ? { service, environment: environment as ConnectionEnvironment, ...(route ? { route: route as ConnectionRoute } : {}) }
    : { service, environment: environment as ConnectionEnvironment, route: route as ConnectionRoute };
  let result: ConnectionResumeReport;
  try {
    const store = new ConnectionStateStore(project);
    result = operation === "plan" ? store.planIntentResume(input) : store.applyIntentResume(input as ConnectionResumeInput, fingerprint!);
  } catch {
    // A project/home lookup can fail before the store can return a safe report.
    // Never expose an exception, filesystem path, or unvalidated metadata.
    console.error("NG: connection resume metadata is unavailable. Re-read and re-plan before continuing; no provider operation was performed.");
    return 1;
  }
  console.log(json ? JSON.stringify(result) : renderConnectionResume(result));
  return result.status === "blocked" ? 1 : 0;
}

export function renderConnectionResume(report: ConnectionResumeReport): string {
  const missing = report.status === "blocked" && report.issue !== "not-recorded" ? "unavailable" : "not recorded";
  const selection = (intent: ConnectionResumeReport["current"]): string => intent
    ? `${intent.service} / ${intent.environment} / ${intent.route} / ${intent.destination.kind}; sending domain: ${intent.sendingDomain ?? "not selected"}; revision: ${intent.updatedAt}`
    : missing;
  const effects = report.status === "applied"
    ? "Active selection metadata updated; no provider operation."
    : report.status === "ready"
      ? "Would restore local selection metadata only; no provider operation."
      : report.status === "unchanged"
        ? "No data-file changes; the selected conditions already match."
        : "Blocked. Re-read and re-plan; an error does not prove that a previous metadata write had no effect.";
  return [
    `Connection resume: ${report.status}`,
    `Project: ${report.projectId}`,
    `Requested selection: ${report.service} / ${report.environment} / ${report.route ?? missing} (${report.profile})`,
    `Current selection (at plan review): ${selection(report.current)}`,
    `Remembered selection: ${selection(report.remembered)}`,
    `Source: ${report.source ?? missing}`,
    `Recorded at: ${report.recordedAt ?? missing}`,
    `Effects: ${effects}`,
    "Credentials, local Vercel/Wrangler selectors, approvals and observations are not restored.",
    `Permission: ${report.permission}; provider operation: ${report.providerOperation}`,
    `Fingerprint: ${report.fingerprint ?? "unavailable"}`,
    ...(report.issue ? [`Issue: ${report.issue}`] : [])
  ].join("\n");
}
