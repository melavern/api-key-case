import { Entry } from "@napi-rs/keyring";
import { toAccount, VAULT_SERVICE } from "../vault/naming.js";
import type { SecretRef, Vault } from "../vault/types.js";
import type { DeployPlan } from "./types.js";
import { resolveCli, spawnResolvedCli, type ResolvedCli } from "./which.js";

// The only module allowed to retain a secret value for deployment and pass it
// to a target CLI's stdin (phase-3-deploy.md §2-9). `vault/keyring.ts` may
// call the OS-store read API from `hasSecret`, but must immediately reduce its
// result to a boolean and discard the value. No other module may perform a
// value-bearing read. Handoff functions must never put the value in a return
// value, a thrown error, or a log line.

export interface HandoffResult {
  exitCode: number | null;
  stdoutRedacted: string;
  stderrRedacted: string;
  timedOut: boolean;
  blocked?: "changed";
}

export class SecretNotRegisteredError extends Error {}

const DEFAULT_TIMEOUT_MS = 120_000;

// Reads the secret, writes it to the child's stdin, and discards it.
// The secret value MUST NOT appear in the return value, thrown errors, or any log.
export async function runWithSecret(
  vault: Vault, // unused for reading (Phase 2's Vault interface has no read method by design); kept for signature symmetry with the rest of the engine.
  ref: SecretRef,
  plan: DeployPlan,
  opts?: {
    timeoutMs?: number;
    pathOverride?: string;
    cwd?: string;
    env?: Record<string, string>;
    resolvedCli?: ResolvedCli;
    suppressOutput?: boolean;
    beforeSecretRead?: () => boolean | Promise<boolean>;
    beforeSpawn?: () => boolean | Promise<boolean>;
  }
): Promise<HandoffResult> {
  void vault;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pathOverride = opts?.pathOverride;
  const beforeSpawn = opts?.beforeSpawn;
  const suppressOutput = opts?.suppressOutput ?? false;

  for (const step of plan.preSteps ?? []) {
    const result = await runStep(
      step,
      null,
      timeoutMs,
      pathOverride,
      opts?.cwd,
      opts?.env,
      opts?.resolvedCli,
      beforeSpawn,
      suppressOutput
    );
    if (result.exitCode !== 0) {
      return result;
    }
  }

  if (opts?.beforeSecretRead && !(await opts.beforeSecretRead())) {
    return blockedResult();
  }

  const entry = new Entry(VAULT_SERVICE, toAccount(ref));
  // @napi-rs/keyring 2.0.0 returns null for a missing entry. A credential-store
  // read failure throws and is left to propagate, never reinterpreted as
  // "not registered".
  let value: string | null = entry.getPassword();

  if (value === null) {
    throw new SecretNotRegisteredError(
      `${ref.name} is not registered. Run: api-key-case save ${ref.name}`
    );
  }

  try {
    return await runStep(
      plan,
      value,
      timeoutMs,
      pathOverride,
      opts?.cwd,
      opts?.env,
      opts?.resolvedCli,
      beforeSpawn,
      suppressOutput
    );
  } finally {
    // Best-effort only: JS strings are immutable, so this cannot zero the
    // underlying memory before GC — it only drops our reference to it.
    value = "";
  }
}

async function runStep(
  plan: DeployPlan,
  value: string | null,
  timeoutMs: number,
  pathOverride: string | undefined,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  resolvedCli: ResolvedCli | undefined,
  beforeSpawn: (() => boolean | Promise<boolean>) | undefined,
  suppressOutput: boolean
): Promise<HandoffResult> {
  if (beforeSpawn && !(await beforeSpawn())) {
    return blockedResult();
  }

  const [cliName, ...args] = plan.argv;
  const resolved = resolvedCli ?? resolveCli(cliName, pathOverride);
  if (!resolved) {
    return Promise.resolve({
      exitCode: null,
      stdoutRedacted: "",
      stderrRedacted: `${cliName} could not be resolved from PATH.`,
      timedOut: false
    });
  }

  return new Promise((resolvePromise) => {
    const child = spawnResolvedCli(resolved, args, {
      cwd,
      env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: null,
        stdoutRedacted: suppressOutput ? "" : scrub(stdout, value),
        stderrRedacted: suppressOutput ? "" : scrub(`${stderr}\n${err.message}`, value),
        timedOut
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        stdoutRedacted: suppressOutput ? "" : scrub(stdout, value),
        stderrRedacted: suppressOutput ? "" : scrub(stderr, value),
        timedOut
      });
    });

    if (value !== null) {
      child.stdin?.write(value);
    }
    child.stdin?.end();
  });
}

function blockedResult(): HandoffResult {
  return {
    exitCode: null,
    stdoutRedacted: "",
    stderrRedacted: "",
    timedOut: false,
    blocked: "changed"
  };
}

// Multi-layer defense (§2-10): scrub in case the official CLI ever echoes
// the value back. Never write the pre-scrub raw output to a file or log.
function scrub(output: string, value: string | null): string {
  if (value === null) {
    return output;
  }
  if (value.length < 8) {
    return "(output withheld)";
  }
  return output.split(value).join("***REDACTED***");
}
