import { resolve } from "node:path";
import { readCloudflareAcquisitionGuide, renderCloudflareAcquisitionGuide } from "../core/agent/cloudflare-acquisition.js";
import { readCloudflareRouteOption, renderCloudflareRouteOption } from "../core/agent/cloudflare-options.js";
import type { ConnectionEnvironment } from "../core/agent/connection-state.js";

const USAGE = "Usage: api-key-case connection cloudflare guide --service <resend|clerk|openai|stripe-test> --env <development|preview|production> [--json] [path]. Local selection guide only; no login, acquisition, inspection of remote settings or deployment. Stripe test is development/preview only; provider hosted execution is unavailable pending native acceptance.";

/** Closed arguments and output. Returns an exit status; never opens an external URL. */
export function runCloudflareGuideCommand(args: string[]): number {
  const [operation, ...options] = args;
  if (operation === "options") return runCloudflareOptions(options);
  let project = process.cwd(), pathSeen = false, json = false;
  const fields = new Map<string, string>();
  const invalid = () => { console.error(USAGE); return 1; };
  if (operation !== "guide") return invalid();
  for (let i = 0; i < options.length; i++) {
    const arg = options[i], value = options[i + 1];
    if (["--service", "--env"].includes(arg) && !fields.has(arg) && value && !value.startsWith("-")) {
      fields.set(arg, value); i++;
    } else if (arg === "--json" && !json) json = true;
    else if (!arg.startsWith("-") && !pathSeen) { pathSeen = true; project = resolve(arg); }
    else return invalid();
  }
  const service = fields.get("--service"), environment = fields.get("--env");
  if ((service !== "resend" && service !== "clerk" && service !== "openai" && service !== "stripe-test") || !environment ||
      !["development", "preview", "production"].includes(environment) || (service === "stripe-test" && environment === "production")) return invalid();
  const guide = readCloudflareAcquisitionGuide(project, service, environment as ConnectionEnvironment);
  console.log(json ? JSON.stringify(guide) : renderCloudflareAcquisitionGuide(guide));
  return guide.state === "selection-confirmed" ? 0 : 1;
}

function runCloudflareOptions(args: string[]): number {
  const invalid = () => { console.error("Usage: api-key-case connection cloudflare options --service <resend|clerk|openai|stripe-test> --env <development|preview|production> [--json]. Static preselection only; Stripe test supports development/preview. No project path, login, acquisition or deployment."); return 1; };
  const fields = new Map<string, string>();
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index], value = args[index + 1];
    if (["--service", "--env"].includes(arg) && !fields.has(arg) && value && !value.startsWith("-")) {
      fields.set(arg, value); index++;
    } else if (arg === "--json" && !json) json = true;
    else return invalid();
  }
  const option = readCloudflareRouteOption(fields.get("--service"), fields.get("--env"));
  if (option.status !== "documented-candidate") return invalid();
  console.log(json ? JSON.stringify(option) : renderCloudflareRouteOption(option));
  return 0;
}
