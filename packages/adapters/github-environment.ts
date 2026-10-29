import { GitHubAdapter } from "./github.js";
import { extractVersion, runCliSync } from "./shared.js";
import type { CliCheckOptions, CliStatus, DeployEnv, DeployPlan } from "../core/deploy/types.js";

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

/** New v2 path only. Legacy GitHub development remains repository-wide. */
export class GitHubEnvironmentAdapter extends GitHubAdapter {
  constructor(readonly repository: string, readonly environment: DeployEnv) {
    super();
    if (!REPOSITORY.test(repository) || !["development", "preview", "production"].includes(environment)) {
      throw new Error("Invalid GitHub environment destination.");
    }
  }

  override async checkCli(options: CliCheckOptions = {}): Promise<CliStatus> {
    const version = runCliSync("gh", ["--version"], 15_000, options);
    if (!version.installed) return { installed: false, loggedIn: false };
    const unavailable: CliStatus = { installed: true, version: extractVersion(version.stdout), loggedIn: false };
    if (runCliSync("gh", ["auth", "status", "--hostname", "github.com"], 15_000, options).status !== 0) return unavailable;
    const read = (endpoint: string, projection: string): [number, string] | null => {
      const result = runCliSync("gh", ["api", "--hostname", "github.com", "--method", "GET", endpoint, "--jq", projection], 15_000, options);
      if (result.status !== 0 || result.stdout.length > 4096) return null;
      try {
        const pair: unknown = JSON.parse(result.stdout);
        return Array.isArray(pair) && pair.length === 2 && Number.isSafeInteger(pair[0]) && pair[0] > 0 && typeof pair[1] === "string"
          ? pair as [number, string] : null;
      } catch { return null; }
    };
    const user = read("user", "[.id,.login]");
    if (!user || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user[1])) return unavailable;
    const repository = read(`repos/${this.repository}`, "[.id,.full_name]");
    if (!repository || repository[1].toLowerCase() !== this.repository.toLowerCase()) return unavailable;
    const environment = read(`repos/${this.repository}/environments/${this.environment}`, "[.id,.name]");
    if (!environment || environment[1] !== this.environment) return unavailable;
    return { ...unavailable, loggedIn: true,
      identity: `user:${user[1].toLowerCase()},id:${user[0]},repo:${repository[0]},environment:${environment[0]}` };
  }

  override planDeploy(name: string, environment: DeployEnv, opts: { force: boolean }): DeployPlan {
    void opts;
    if (name !== "RESEND_API_KEY" || environment !== this.environment) throw new Error("Invalid GitHub connection operation.");
    const argv = ["gh", "secret", "set", name, "--repo", `github.com/${this.repository}`, "--env", environment];
    return { argv, valueVia: "stdin", overwriteWarning: true,
      displayCommand: `${argv.join(" ")} (existing GitHub Environment; Actions jobs can consume this secret)` };
  }

  override manualSteps(): string[] {
    return ["Review the selected github.com repository and existing named Environment with its owner.",
      "This operation cannot create an Environment or fall back to repository secrets."];
  }
}
