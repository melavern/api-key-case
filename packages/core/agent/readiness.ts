import { release } from "node:os";
import { createHumanPlane, WINDOWS_USER_VERIFICATION_MIN_BUILD } from "../human/index.js";
import { buildTrustedExecution, matchesTrustedExecution } from "../deploy/snapshot.js";
import { deriveProjectId } from "../vault/naming.js";
import { DEPLOY_ENVS, type DeployEnv, type DeployPlan, type DeployTarget } from "../deploy/types.js";

export type ReadinessIssue =
  | "unsupported-platform"
  | "windows-version-unsupported"
  | "windows-version-unverified"
  | "human-helper-unavailable"
  | "vault-unavailable"
  | "target-not-configured"
  | "trusted-cli-unavailable"
  | "provider-login-required"
  | "provider-identity-unverified"
  | "unsafe-deploy-context"
  | "project-unavailable"
  | "context-changed"
  | "inspection-failed";

export interface HostReadiness {
  platform: "windows" | "macos" | "unsupported";
  secretInput: "interaction-required" | "unavailable";
  approval: "interaction-required" | "unavailable";
  requirements: Array<"interactive-desktop" | "windows-hello">;
  issues: ReadinessIssue[];
}

export interface EnvironmentReadiness {
  env: DeployEnv;
  status: "blocked" | "prerequisites-checked";
  issues: ReadinessIssue[];
  // These cannot be proved without human interaction / a real provider write.
  // A successful diagnostic is never an approval or a promise of deployment.
  unverified: Array<"human-interaction" | "provider-write-permission">;
}

/** No GUI, verifier request, credential read, or persistent approval is involved. */
export function inspectHostReadiness(options: {
  platform?: NodeJS.Platform;
  osRelease?: string;
  helperAvailable?: boolean;
} = {}): HostReadiness {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin") {
    return {
      platform: "unsupported", secretInput: "unavailable", approval: "unavailable",
      requirements: [], issues: ["unsupported-platform"]
    };
  }
  const helperAvailable = options.helperAvailable ?? createHumanPlane(platform).capability() === "os-dialog";
  const issues: ReadinessIssue[] = helperAvailable ? [] : ["human-helper-unavailable"];
  if (platform === "win32") {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(options.osRelease ?? release());
    if (!match) issues.push("windows-version-unverified");
    else if (Number(match[1]) < 10 || Number(match[3]) < WINDOWS_USER_VERIFICATION_MIN_BUILD) {
      issues.push("windows-version-unsupported");
    }
  }
  return {
    platform: platform === "win32" ? "windows" : "macos",
    secretInput: helperAvailable ? "interaction-required" : "unavailable",
    approval: issues.length === 0 ? "interaction-required" : "unavailable",
    requirements: platform === "win32" ? ["interactive-desktop", "windows-hello"] : ["interactive-desktop"],
    issues
  };
}

/**
 * Free, status-only preflight. Use the executing deploy's resolver and sanitized
 * provider environment, regardless of entitlement. The fixed probe never names
 * a stored Secret and is never executed. No vault or Human Plane is accepted.
 */
export async function inspectTargetReadiness(options: {
  adapter: DeployTarget;
  projectDir: string;
  detected: boolean;
  vaultAvailable: boolean;
  host: HostReadiness;
  pathOverride?: string; // test-only; never accepted by CLI / MCP
}): Promise<EnvironmentReadiness[]> {
  const common: ReadinessIssue[] = [...options.host.issues];
  if (!options.vaultAvailable) common.push("vault-unavailable");
  if (!options.detected) common.push("target-not-configured");

  const results: EnvironmentReadiness[] = [];
  for (const env of DEPLOY_ENVS) {
    const issues = [...common];
    // Unsupported hosts and unconfigured targets cannot be made usable by a
    // purchase. Do not launch provider probes there or suggest buying Pro.
    if (issues.length === 0) {
      try {
        const plan: DeployPlan = {
          argv: [options.adapter.cliCommand], valueVia: "stdin",
          displayCommand: options.adapter.cliCommand, overwriteWarning: false
        };
        const request = {
          name: "AKC_READINESS_STATUS", scope: "project" as const,
          projectId: deriveProjectId(options.projectDir), env, force: false,
          adapterId: options.adapter.id, cliCommand: options.adapter.cliCommand,
          providerIdentity: null
        };
        const result = buildTrustedExecution(request, plan, {
          projectDir: options.projectDir, pathOverride: options.pathOverride
        });
        if (!result.ok) {
          const issue = {
            "unsupported-platform": "unsupported-platform",
            "unsafe-environment": "unsafe-deploy-context",
            "cli-unavailable": "trusted-cli-unavailable",
            "invalid-project": "project-unavailable"
          } as const;
          issues.push(issue[result.reason]);
        } else {
          const cli = await options.adapter.checkCli({
            cwd: result.execution.cwd,
            env: result.execution.env,
            resolvedCli: result.execution.resolvedCli,
            pathOverride: options.pathOverride
          });
          if (!cli.installed) issues.push("trusted-cli-unavailable");
          else if (!cli.loggedIn) issues.push("provider-login-required");
          else if (!cli.identity || !/^[A-Za-z0-9][A-Za-z0-9:_.,-]{0,511}$/.test(cli.identity)) {
            issues.push("provider-identity-unverified");
          }
          if (!matchesTrustedExecution(request, plan, result.execution)) issues.push("context-changed");
        }
      } catch {
        // Never forward provider output, exception text, paths, or identity.
        issues.push("inspection-failed");
      }
    }
    results.push({
      env,
      status: issues.length === 0 ? "prerequisites-checked" : "blocked",
      issues,
      unverified: ["human-interaction", "provider-write-permission"]
    });
  }
  return results;
}
