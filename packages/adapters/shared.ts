import { spawnSync } from "node:child_process";
import { resolveCli, type ResolvedCli } from "../core/deploy/which.js";

export interface CliInvocation {
  installed: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  pathOverride?: string;
  resolvedCli?: ResolvedCli;
}

// Synchronous helper for CLI presence/login checks (--version, whoami, etc).
// Never touches a secret value — only static, hardcoded argv tokens are
// passed in by callers.
export function runCliSync(
  command: string,
  args: string[],
  timeoutMs = 15_000,
  options: CliRunOptions = {}
): CliInvocation {
  const resolved = options.resolvedCli ?? resolveCli(command, options.pathOverride);
  if (!resolved) {
    return { installed: false, status: null, stdout: "", stderr: "" };
  }

  // Keep the synchronous probe on the same resolved binary and environment
  // as a high-risk execution. `spawnResolvedCli` uses the fixed Windows
  // cmd.exe for .cmd/.bat files; no child shell performs PATH lookup.
  const result = spawnSyncWithResolvedCli(resolved, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: timeoutMs,
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });

  return {
    installed: true,
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : ""
  };
}

function spawnSyncWithResolvedCli(
  resolved: ResolvedCli,
  args: string[],
  options: Parameters<typeof spawnSync>[2]
): ReturnType<typeof spawnSync> {
  if (resolved.isWindowsScript && process.platform === "win32") {
    return spawnSync("C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", resolved.absolutePath, ...args], {
      ...options,
      shell: false
    });
  }
  return spawnSync(resolved.absolutePath, args, { ...options, shell: false });
}

export function extractVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+/)?.[0];
}
