import { resolve } from "node:path";
import { applyConnectionTarget, planConnectionTarget, renderConnectionTarget, type ConnectionTargetInput } from "../core/agent/connection-target.js";
import type { ConnectionEnvironment } from "../core/agent/connection-state.js";

const USAGE = "Usage: api-key-case connection target <plan|apply> --service <resend|clerk|openai|stripe-test> --env <development|preview|production> (--org-id <id> --project-id <id> | --account-id <id> --worker <name>) [--fingerprint <plan-sha256> (apply only)] [--json] [path]. Prepares a fixed non-secret local selector from matching saved intent, including a missing named environment in a supported selector-only Cloudflare file; no provider, login, secret, resource creation or deployment. Stripe test is development/preview only; provider hosted execution is unavailable pending native acceptance.";
export function runConnectionTargetCommand(args: string[]): number {
  const [operation, ...options] = args;
  const invalid = () => { console.error(USAGE); return 1; };
  if (operation !== "plan" && operation !== "apply") return invalid();
  let project = process.cwd(), pathSeen = false, json = false;
  const fields = new Map<string, string>();
  const allowed = ["--service", "--env", "--org-id", "--project-id", "--account-id", "--worker", ...(operation === "apply" ? ["--fingerprint"] : [])];
  for (let i = 0; i < options.length; i++) {
    const arg = options[i], value = options[i + 1];
    if (allowed.includes(arg) && !fields.has(arg) && value && !value.startsWith("-")) { fields.set(arg, value); i++; }
    else if (arg === "--json" && !json) json = true;
    else if (!arg.startsWith("-") && !pathSeen) { pathSeen = true; project = resolve(arg); }
    else return invalid();
  }
  const service = fields.get("--service"), environment = fields.get("--env");
  if ((service !== "resend" && service !== "clerk" && service !== "openai" && service !== "stripe-test") || !environment || !["development", "preview", "production"].includes(environment) || (service === "stripe-test" && environment === "production")) return invalid();
  const vercel = fields.has("--org-id") && fields.has("--project-id") && !fields.has("--account-id") && !fields.has("--worker");
  const cloudflare = fields.has("--account-id") && fields.has("--worker") && !fields.has("--org-id") && !fields.has("--project-id");
  if ((!vercel && !cloudflare) || (operation === "apply" && !fields.has("--fingerprint"))) return invalid();
  const input: ConnectionTargetInput = { service, environment: environment as ConnectionEnvironment,
    ...(vercel ? { orgId: fields.get("--org-id")!, projectId: fields.get("--project-id")! } : { accountId: fields.get("--account-id")!, worker: fields.get("--worker")! }) };
  const result = operation === "plan" ? planConnectionTarget(project, input) : applyConnectionTarget(project, input, fields.get("--fingerprint")!);
  console.log(json ? JSON.stringify(result) : renderConnectionTarget(result));
  return result.status === "blocked" ? 1 : 0;
}
