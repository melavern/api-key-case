import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CliCheckOptions, CliStatus, DeployEnv, DeployPlan, DeployTarget, DetectResult } from "../core/deploy/types.js";
import { extractVersion, runCliSync } from "./shared.js";

// On Vercel, sensitivity is a per-variable setting, not something the target
// environment implies. `preview` alone is no guarantee: `--no-sensitive`
// exists, the CLI's own default has changed over time, and a team policy is
// outside this tool's control. Every value api-key-case places is a Secret, so
// it asks for write-only (sensitive) storage explicitly instead of inheriting
// whoever's default happens to be in effect. `development` gets no flag, so its
// value stays readable back — which is why it stays off the automatic-safe
// allowlist in core/deploy/destination.ts. That used to be forced on us:
// Vercel rejected sensitive variables in `development`. Measured on vercel
// 59.11.7 (2026-09-08) the flag is now accepted there and stores a Secret, so
// keeping it off is this tool's own conservative choice. Changing it is a
// review of the allowlist premise, not a flag edit.
const SENSITIVE_STORAGE_ENVS: readonly DeployEnv[] = Object.freeze([
  "production",
  "preview"
]);

/** True when Vercel can, and therefore must, store this env's value write-only. */
function requiresSensitiveStorage(env: DeployEnv): boolean {
  return SENSITIVE_STORAGE_ENVS.includes(env);
}

export class VercelAdapter implements DeployTarget {
  readonly id = "vercel" as const;
  readonly cliCommand = "vercel";

  async detect(projectDir: string): Promise<DetectResult> {
    if (existsSync(join(projectDir, ".vercel", "project.json"))) {
      return { detected: true, reason: ".vercel/project.json (linked)" };
    }
    if (existsSync(join(projectDir, "vercel.json"))) {
      return { detected: true, reason: "vercel.json (not yet linked; run: vercel link)" };
    }
    return { detected: false, reason: "no .vercel/project.json or vercel.json found" };
  }

  async checkCli(options: CliCheckOptions = {}): Promise<CliStatus> {
    const version = runCliSync("vercel", ["--version"], 15_000, options);
    if (!version.installed) {
      return { installed: false, loggedIn: false, hint: "npm i -g vercel" };
    }

    const who = runCliSync("vercel", ["whoami"], 15_000, options);
    const identity = providerUserIdentity(who.stdout);
    const loggedIn = who.status === 0 && identity !== undefined;
    return {
      installed: true,
      version: extractVersion(version.stdout),
      loggedIn,
      identity,
      hint: loggedIn ? undefined : "vercel login"
    };
  }

  planDeploy(name: string, env: DeployEnv, opts: { force: boolean }): DeployPlan {
    const argv = ["vercel", "env", "add", name, env];
    if (requiresSensitiveStorage(env)) argv.push("--sensitive");
    // `preview` additionally asks which Git branch the variable applies to.
    // This tool's child is always non-interactive — sanitized environment,
    // piped stdin, no TTY — so that prompt cannot be answered, and the CLI
    // then exits 0 having created nothing. Measured against vercel 59.11.7 on
    // Windows, 2026-09-08: the deploy reported success while the variable was
    // never added. The CLI skips the prompt by itself only when it detects an
    // agent in the environment, which is exactly what this tool strips.
    // `--yes` takes the documented default — every Preview branch — which is
    // what this plan already means. `production` and `development` have no
    // branch prompt and are left unchanged.
    if (env === "preview") argv.push("--yes");
    const plan: DeployPlan = {
      argv,
      valueVia: "stdin",
      displayCommand: argv.join(" "),
      overwriteWarning: false
    };

    if (opts.force) {
      const removeArgv = ["vercel", "env", "rm", name, env, "--yes"];
      plan.preSteps = [
        {
          argv: removeArgv,
          valueVia: "stdin",
          displayCommand: `${removeArgv.join(" ")}   (removes existing value first)`,
          overwriteWarning: true
        }
      ];
    }

    return plan;
  }

  // Must branch on env exactly as planDeploy does, so the steps we hand a user
  // create the same kind of variable the tool itself would have created.
  manualSteps(name: string, env: DeployEnv): string[] {
    const sensitive = requiresSensitiveStorage(env) ? " --sensitive" : "";
    return [
      "npm i -g vercel",
      "vercel login   (then: vercel link)",
      `vercel env add ${name} ${env}${sensitive}   (paste the value when prompted)`
    ];
  }
}

function providerUserIdentity(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(lines[0])) {
    return undefined;
  }
  return `user:${lines[0].toLowerCase()}`;
}
