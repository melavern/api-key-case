import { getRemoteUrl } from "../core/git.js";
import type { CliCheckOptions, CliStatus, DeployEnv, DeployPlan, DeployTarget, DetectResult } from "../core/deploy/types.js";
import { extractVersion, runCliSync } from "./shared.js";

export class GitHubAdapter implements DeployTarget {
  readonly id = "github" as const;
  readonly cliCommand = "gh";

  async detect(projectDir: string): Promise<DetectResult> {
    const remote = getRemoteUrl(projectDir);
    if (remote && isGitHubRemoteUrl(remote)) {
      return { detected: true, reason: `git remote: ${remote}` };
    }
    return { detected: false, reason: "no github.com git remote found" };
  }

  async checkCli(options: CliCheckOptions = {}): Promise<CliStatus> {
    const version = runCliSync("gh", ["--version"], 15_000, options);
    if (!version.installed) {
      return { installed: false, loggedIn: false, hint: "winget install GitHub.cli (or: brew install gh)" };
    }

    const status = runCliSync("gh", ["auth", "status"], 15_000, options);
    const user = status.status === 0
      ? runCliSync("gh", ["api", "user", "--jq", ".login"], 15_000, options)
      : null;
    const login = user?.status === 0 ? user.stdout.trim() : "";
    const identity = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)
      ? `user:${login.toLowerCase()}`
      : undefined;
    const loggedIn = status.status === 0 && identity !== undefined;
    return {
      installed: true,
      version: extractVersion(version.stdout),
      loggedIn,
      identity,
      hint: loggedIn ? undefined : "gh auth login"
    };
  }

  // development maps to a repository secret (every workflow can read it);
  // production/preview map to an environment secret of that name, which only a
  // job declaring `environment: <name>` can read and which must already exist
  // on GitHub. Either kind is placed for CI to consume and we cannot see which
  // workflows will read it, so the engine always requires production-style
  // confirmation for this target regardless of --env (phase-3-deploy.md §6.3).
  planDeploy(name: string, env: DeployEnv, opts: { force: boolean }): DeployPlan {
    void opts; // gh always overwrites; no --force distinction to make.
    const argv = env === "development" ? ["gh", "secret", "set", name] : ["gh", "secret", "set", name, "--env", env];

    return {
      argv,
      valueVia: "stdin",
      displayCommand:
        env === "development"
          ? argv.join(" ")
          : `${argv.join(" ")}   (GitHub Environment "${env}" secret; the environment must already exist)`,
      overwriteWarning: true
    };
  }

  // Must branch on env exactly as planDeploy does, so the steps we hand a user
  // produce the same kind of secret the run they asked for would have.
  manualSteps(name: string, env: DeployEnv): string[] {
    const steps = ["winget install GitHub.cli   (or: brew install gh)", "gh auth login"];

    if (env === "development") {
      steps.push(`gh secret set ${name}   (paste the value when prompted)`);
    } else {
      steps.push(`create the "${env}" environment under Settings -> Environments, if it does not exist yet`);
      steps.push(`gh secret set ${name} --env ${env}   (paste the value when prompted)`);
    }

    return steps;
  }
}

export function isGitHubRemoteUrl(remote: string): boolean {
  try {
    const hostname = new URL(remote).hostname;
    if (hostname) {
      return hostname.toLowerCase() === "github.com";
    }
  } catch {
    // Fall through to Git's SCP-like syntax.
  }

  // Git also accepts SCP-like remotes such as git@github.com:owner/repo.git.
  // Match the host as a complete component so github.com.evil.example and
  // local paths that merely contain github.com are never treated as GitHub.
  const scpLike = /^(?:[^@/:\\]+@)?([^/:\\]+):[^/\\]/.exec(remote);
  return scpLike?.[1]?.toLowerCase() === "github.com";
}
