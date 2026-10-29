import { CloudflareAdapter, cloudflareIdentity } from "./cloudflare.js";
import { runCliSync } from "./shared.js";
import type { CliCheckOptions, CliStatus, DeployEnv, DeployPlan } from "../core/deploy/types.js";
import { resolveClerkWorkerDestination } from "../core/deploy/snapshot.js";

export const CLERK_WRANGLER_VERSION = "4.131.2";
export function isClerkWranglerVersion(output:string):boolean { return output.trim() === CLERK_WRANGLER_VERSION; }
/** Fixed controls, never inherited options supplied by an Agent. */
export function cloudflarePreparationEnvironment(env: Record<string, string>): Record<string, string> {
  const result = { ...env, CI: "1", NO_COLOR: "1", DO_NOT_TRACK: "1", WRANGLER_WRITE_LOGS: "false",
    WRANGLER_LOG_SANITIZE: "true", WRANGLER_SEND_METRICS: "false", WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_NO_SKILLS_UPDATE_PROMPTS: "true" };
  for (const name of Object.keys(result)) if (name.startsWith("WRANGLER_OUTPUT_FILE_")) delete result[name as keyof typeof result];
  return result;
}

/** Creates a version of an existing Worker. It never calls versions deploy. */
export class CloudflareVersionsAdapter extends CloudflareAdapter {
  constructor(private readonly selectedEnvironment: DeployEnv) { super(); }
  override async checkCli(options: CliCheckOptions = {}): Promise<CliStatus> {
    const fixed = { ...options, env: cloudflarePreparationEnvironment(options.env ?? {}) };
    const version = runCliSync("wrangler", ["--version"], 15_000, fixed);
    if (!version.installed || version.status !== 0 || !isClerkWranglerVersion(version.stdout)) {
      return { installed: version.installed, loggedIn: false, hint: "This private preparation profile requires the reviewed Wrangler 4.131.2. No installation or login is performed." };
    }
    const who = runCliSync("wrangler",["whoami","--json"],15_000,fixed);
    const identity=cloudflareIdentity(who.stdout);
    const status:CliStatus={installed:true,version:CLERK_WRANGLER_VERSION,loggedIn:who.status===0&&identity!==undefined,identity};
    const destination = fixed.cwd ? resolveClerkWorkerDestination(fixed.cwd,this.selectedEnvironment) : null;
    if (!destination || !status.identity?.startsWith("accounts:") ||
      !status.identity.slice(9).split(",").includes(destination.accountId)) return {...status,loggedIn:false,hint:"The selected account is not confirmed by this existing CLI session."};
    return status;
  }

  override planDeploy(name: string, env: DeployEnv): DeployPlan {
    if (name !== "CLERK_SECRET_KEY" || env !== this.selectedEnvironment || !["development", "preview", "production"].includes(env)) throw new Error("Unsupported preparation.");
    const argv = ["wrangler", "versions", "secret", "put", "CLERK_SECRET_KEY", ...(env === "production" ? [] : ["--env", env])];
    return { argv, valueVia: "stdin", displayCommand: argv.join(" "), overwriteWarning: true };
  }

  override manualSteps(): string[] {
    return ["Use an existing Worker and explicit account/name in the selected Wrangler environment.",
      "Review the latest remote code and existing Version URL exposure before preparing a secret-bearing version.",
      "Activation is a separate app-deployment operation; never retry an unknown preparation automatically."];
  }
}
