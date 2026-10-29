import { VercelAdapter } from "./vercel.js";
import { GitHubAdapter } from "./github.js";
import { extractVersion, runCliSync } from "./shared.js";
import { hostedDeploymentPlan, type HostedDestination } from "../core/deploy/hosted-targets.js";
import type { CliCheckOptions, CliStatus, DeployEnv, DeployPlan } from "../core/deploy/types.js";

const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) && !/[\r\n]/.test(value);
export class VercelBindingAdapter extends VercelAdapter {
  constructor(readonly destination: Extract<HostedDestination, { kind: "vercel" }>) { super(); }
  override async checkCli(options: CliCheckOptions = {}): Promise<CliStatus> {
    const version = runCliSync("vercel", ["--version"], 15000, options), unavailable = { installed: version.installed, version: extractVersion(version.stdout + version.stderr), loggedIn: false };
    if (version.status !== 0 || !unavailable.version?.startsWith("59.")) return unavailable;
    const who = runCliSync("vercel", ["whoami", "--format", "json", "--scope", this.destination.providerAccountId, "--non-interactive"], 15000, options);
    if (who.status !== 0 || who.stdout.length > 8192) return unavailable;
    let user: string;
    try {
      const data = JSON.parse(who.stdout); if (!identifier(data.username) || data.team?.id !== this.destination.providerAccountId) return unavailable; user = data.username;
    } catch { return unavailable; }
    const selected = runCliSync("vercel", ["project", "inspect", "--scope", this.destination.providerAccountId, "--non-interactive"], 15000, options);
    if (selected.status !== 0 || selected.stdout.length + selected.stderr.length > 16384) return unavailable;
    // Vercel 59 project inspect prints its human-readable table to stderr.
    const plain = selected.stderr.replace(/\x1b\[[0-9;]*m/g, ""), ids = [...plain.matchAll(/^\s*ID[\t ]+(prj_[A-Za-z0-9]+)\s*$/gm)];
    if (ids.length !== 1 || ids[0][1] !== this.destination.resourceId) return unavailable;
    return { ...unavailable, loggedIn: true, identity: `user:${user.toLowerCase()},team:${this.destination.providerAccountId},project:${this.destination.resourceId}` };
  }
  override planDeploy(name: string, env: DeployEnv): DeployPlan {
    if (env !== this.destination.applicationEnvironment) throw Error("Destination unavailable."); return hostedDeploymentPlan(this.destination, name);
  }
}
export class GitHubBindingAdapter extends GitHubAdapter {
  constructor(readonly destination: Extract<HostedDestination, { kind: "github-actions" }>) { super(); }
  override async checkCli(options: CliCheckOptions = {}): Promise<CliStatus> {
    const version = runCliSync("gh", ["--version"], 15000, options), unavailable = { installed: version.installed, version: extractVersion(version.stdout), loggedIn: false };
    if (version.status !== 0 || !unavailable.version?.startsWith("2.") || runCliSync("gh", ["auth", "status", "--hostname", "github.com"], 15000, options).status !== 0) return unavailable;
    const read = (endpoint: string, projection: string): unknown[] | null => {
      const result = runCliSync("gh", ["api", "--hostname", "github.com", "--method", "GET", endpoint, "--jq", projection], 15000, options);
      if (result.status !== 0 || result.stdout.length > 8192) return null;
      try { const value: unknown = JSON.parse(result.stdout); return Array.isArray(value) ? value : null; } catch { return null; }
    };
    const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
    const user = read("user", "[.id,.login]"); if (!user || user.length !== 2 || !positive(user[0]) || !identifier(user[1])) return unavailable;
    const repo = read(`repos/${this.destination.resourceId}`, "[.id,.full_name,.owner.id]");
    if (!repo || repo.length !== 3 || !positive(repo[0]) || !positive(repo[2]) || typeof repo[1] !== "string" || repo[1].toLowerCase() !== this.destination.resourceId.toLowerCase()) return unavailable;
    let environment = "repository";
    if (this.destination.applicationEnvironment !== "repository") {
      const result = read(`repos/${this.destination.resourceId}/environments/${encodeURIComponent(this.destination.applicationEnvironment)}`, "[.id,.name]");
      if (!result || result.length !== 2 || !positive(result[0]) || result[1] !== this.destination.applicationEnvironment) return unavailable; environment = String(result[0]);
    }
    return { ...unavailable, loggedIn: true, identity: `user:${user[1].toLowerCase()},id:${user[0]},repo:${repo[0]},owner:${repo[2]},environment:${environment}` };
  }
  override planDeploy(name: string): DeployPlan { return hostedDeploymentPlan(this.destination, name); }
}
export const hostedAdapter = (destination: HostedDestination) => destination.kind === "vercel" ? new VercelBindingAdapter(destination) : new GitHubBindingAdapter(destination);
