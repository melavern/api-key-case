import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CliCheckOptions, CliStatus, DeployEnv, DeployPlan, DeployTarget, DetectResult } from "../core/deploy/types.js";
import { extractVersion, runCliSync } from "./shared.js";

const CONFIG_FILES = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];

export class CloudflareAdapter implements DeployTarget {
  readonly id = "cloudflare" as const;
  readonly cliCommand = "wrangler";

  async detect(projectDir: string): Promise<DetectResult> {
    for (const file of CONFIG_FILES) {
      if (existsSync(join(projectDir, file))) {
        return { detected: true, reason: file };
      }
    }
    return { detected: false, reason: "no wrangler.toml/json/jsonc found" };
  }

  async checkCli(options: CliCheckOptions = {}): Promise<CliStatus> {
    const version = runCliSync("wrangler", ["--version"], 15_000, options);
    if (!version.installed) {
      return { installed: false, loggedIn: false, hint: "npm i -g wrangler" };
    }

    const who = runCliSync("wrangler", ["whoami", "--json"], 15_000, options);
    const identity = cloudflareIdentity(who.stdout);
    const loggedIn = who.status === 0 && identity !== undefined;
    return {
      installed: true,
      version: extractVersion(version.stdout),
      loggedIn,
      identity,
      hint: loggedIn ? undefined : "wrangler login"
    };
  }

  planDeploy(name: string, env: DeployEnv, opts: { force: boolean }): DeployPlan {
    void opts; // wrangler always overwrites; --force has no additional effect here.
    const argv =
      env === "production"
        ? ["wrangler", "secret", "put", name]
        : ["wrangler", "secret", "put", name, "--env", env];

    return {
      argv,
      valueVia: "stdin",
      displayCommand: argv.join(" "),
      overwriteWarning: true
    };
  }

  // Must branch on env exactly as planDeploy does, so the steps we hand a user
  // target the same wrangler environment the run they asked for would have.
  manualSteps(name: string, env: DeployEnv): string[] {
    const put =
      env === "production"
        ? `wrangler secret put ${name}   (paste the value when prompted)`
        : `wrangler secret put ${name} --env ${env}   (paste the value when prompted; needs a "${env}" environment in wrangler.toml)`;

    return ["npm i -g wrangler", "wrangler login", put];
  }
}

function cloudflareIdentity(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as { loggedIn?: unknown; accounts?: unknown };
    if (parsed.loggedIn !== true || !Array.isArray(parsed.accounts)) return undefined;
    const ids = parsed.accounts
      .map((account) =>
        account && typeof account === "object" && "id" in account
          ? (account as { id?: unknown }).id
          : undefined
      )
      .filter((id): id is string => typeof id === "string" && /^[A-Fa-f0-9]{16,64}$/.test(id));
    if (ids.length === 0 || ids.length !== parsed.accounts.length || ids.length > 32) return undefined;
    return `accounts:${[...new Set(ids.map((id) => id.toLowerCase()))].sort().join(",")}`;
  } catch {
    return undefined;
  }
}
