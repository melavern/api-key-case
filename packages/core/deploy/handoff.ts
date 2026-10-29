import { createVault } from "../vault/index.js";
import { createHumanPlane } from "../human/index.js";
import { assertProFeature, ProFeatureError, type LicenseOptions } from "../license.js";
import type { HumanPlane } from "../human/types.js";
import { ConnectionStateStore } from "../agent/connection-state.js";
import { connectionCredentialRef } from "../agent/connection-credential.js";
import { connectionIntentFingerprint } from "../agent/fingerprints.js";
import { LocalLaunchSnapshot } from "../local/snapshot.js";
import type { LocalSessionRequest, LocalSessionResult } from "../local/session.js";
import { realpathSync } from "node:fs";
import { Entry } from "@napi-rs/keyring";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertConnectionCredentialRef, isConnectionCredentialRef, toAccount, VAULT_SERVICE } from "../vault/naming.js";
import type { ConnectionCredentialRef, SecretRef, StoredSecretRef, Vault } from "../vault/types.js";
import type { DeployPlan, TargetId } from "./types.js";
import { resolveCli, spawnResolvedCli, type ResolvedCli } from "./which.js";
import { currentResolvedCli, isSameResolvedCli, resolveTrustedHomeDirectory } from "./which.js";
import { parseResendDoctor, RESEND_CLI_VERSION, type ResendValidationCode } from "../agent/resend-doctor.js";

import { buildTrustedExecutionEnvironment, matchesTrustedExecution, type SnapshotRequest, type TrustedExecution } from "./snapshot.js";
import { VercelAdapter } from "../../adapters/vercel.js";
import { GitHubEnvironmentAdapter } from "../../adapters/github-environment.js";
import { resolveConnectionGitHubRepository } from "./snapshot.js";
import { CloudflareAdapter, CloudflareConfigAdapter } from "../../adapters/cloudflare.js";
import { resolveCloudflareTarget, resolveGenericCloudflareTarget, cloudflareTargetPlan, cloudflareTargetEnvironment } from "./cloudflare-targets.js";
import { catalogSchema, launchProfileSchema, locatorAccount, locatorSchema, validate } from "../vnext/model.js";
import { VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED, VNEXT_WINDOWS_LOCAL_ACCEPTED } from "../vnext/gates.js";
import type { UsePlan } from "../vnext/use.js";
import type { HostedUsePlan } from "../vnext/hosted-use.js";
import { hostedUseAccepted } from "../vnext/hosted-use.js";
import { hostedDeploymentPlan, resolveHostedTarget } from "./hosted-targets.js";
import { CloudflareVersionsAdapter, isClerkWranglerVersion, cloudflarePreparationEnvironment } from "../../adapters/cloudflare-versions.js";
import { resolveClerkWorkerDestination } from "./snapshot.js";
import { PROVIDER_HOSTED_NATIVE_ACCEPTED, CLOUDFLARE_TARGET_NATIVE_ACCEPTED, isHostedDeployService } from "./provider-hosted.js";
import { CLERK_PREPARATION_NATIVE_ACCEPTED } from "../agent/clerk-managed.js";

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
  preparedVersionId?: string;
  preparationTermination?: "not-started" | "closed" | "unconfirmed";
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
  // Environment slots need their own bounded destination flow; legacy deploy never consumes them.
  if (isConnectionCredentialRef(ref)) throw new SecretNotRegisteredError("Connection credentials cannot use legacy deployment.");
  return performSecretHandoff(ref, plan, opts);
}

type HandoffOptions = Parameters<typeof runWithSecret>[3];

/** Generic bindings share the sole value-bearing module. No getter, caller argv or env map. */
export async function runGenericCloudflareDeployment(plan: UsePlan, execution: TrustedExecution, stillCurrent: (phase?: "completion") => Promise<boolean>): Promise<"completed" | "incomplete" | "unknown" | "changed"> {
  if (!VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED || process.platform !== "win32") return "changed";
  let value: string | null = null;
  try {
    const locator = validate(locatorSchema, plan.credential.locator), selected = resolveGenericCloudflareTarget(execution.cwd, plan.target);
    if (!selected || plan.binding.credentialId !== plan.credential.id || plan.binding.projectId !== plan.destination.projectId ||
        plan.destination.id !== selected.target.id || plan.snapshotRequest.genericCloudflareDestination?.id !== selected.target.id ||
        !execution.snapshot.providerIdentity?.startsWith("accounts:") || !execution.snapshot.providerIdentity.slice(9).split(",").includes(selected.target.accountId)) return "changed";
    const deployment = cloudflareTargetPlan(selected.target, plan.binding.variableName);
    const env = cloudflareTargetEnvironment(buildTrustedExecutionEnvironment(execution.resolvedCli,
      execution.resolvedCli.trustedPath === undefined ? dirname(execution.resolvedCli.absolutePath) : undefined, execution.snapshot.homeDir), selected.target);
    const current = async (phase?: "completion") => await stillCurrent(phase) && matchesTrustedExecution(plan.snapshotRequest, deployment, execution);
    if (!await current()) return "changed";
    value = new Entry(VAULT_SERVICE, locatorAccount(locator)).getPassword();
    if (value === null) return "unknown";
    // Preserve the old Stripe test-slot's mode guarantee when explicitly reused.
    if (locator.kind === "v2" && locator.ref.service === "stripe-test" && (!value.startsWith("sk_test_") || value.length <= 8 || /\s/.test(value))) return "changed";
    if (!await current()) return "changed";
    const result = await captureClerkCommand({ ...execution, env }, deployment.argv.slice(1), value, 120_000);
    if (!await current("completion") || result.termination !== "closed") return "unknown";
    // A failure may have updated remote state. Never infer safe replay from an exit code.
    return result.ok ? "completed" : result.exitCode !== undefined && result.exitCode !== null ? "incomplete" : "unknown";
  } catch { return "unknown"; }
  finally { value = null; }
}

/** Separate fixed provider sinks; the caller supplies neither argv nor environment values. */
export async function runGenericHostedDeployment(plan: HostedUsePlan, execution: TrustedExecution, stillCurrent: (phase?: "completion") => Promise<boolean>): Promise<"completed" | "incomplete" | "unknown" | "changed"> {
  if (!hostedUseAccepted(plan.destination.kind) || process.platform !== "win32") return "changed";
  let value: string | null = null;
  try {
    const locator = validate(locatorSchema, plan.credential.locator); resolveHostedTarget(execution.cwd, plan.destination);
    if (plan.binding.credentialId !== plan.credential.id || plan.binding.projectId !== plan.destination.projectId ||
        execution.snapshot.genericHostedDestination?.id !== plan.destination.id || !plan.providerIdentity || execution.snapshot.providerIdentity !== plan.providerIdentity) return "changed";
    const deployment = hostedDeploymentPlan(plan.destination, plan.binding.variableName);
    const current = async (phase?: "completion") => await stillCurrent(phase) && matchesTrustedExecution(plan.snapshotRequest, deployment, execution);
    if (!await current()) return "changed";
    value = new Entry(VAULT_SERVICE, locatorAccount(locator)).getPassword();
    if (value === null) return "unknown";
    if (locator.kind === "v2" && locator.ref.service === "stripe-test" && (!value.startsWith("sk_test_") || value.length <= 8 || /\s/.test(value))) return "changed";
    if (!await current()) return "changed";
    const env = { ...execution.env, DO_NOT_TRACK: "1", ...(plan.destination.kind === "vercel" ? { VERCEL_TELEMETRY_DISABLED: "1" } : { GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" }) };
    const hostedTimeoutMs = 120_000;
    const result = await captureClerkCommand({ ...execution, env }, deployment.argv.slice(1), value, hostedTimeoutMs);
    if (!await current("completion") || result.termination !== "closed") return "unknown";
    return result.ok ? "completed" : result.exitCode !== undefined && result.exitCode !== null ? "incomplete" : "unknown";
  } catch { return "unknown"; }
  finally { value = null; }
}

async function performSecretHandoff(ref: StoredSecretRef, plan: DeployPlan, opts?: HandoffOptions): Promise<HandoffResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pathOverride = opts?.pathOverride;
  const beforeSpawn = opts?.beforeSpawn;
  const suppressOutput = opts?.suppressOutput ?? false;

  const stripeTest = isConnectionCredentialRef(ref) && ref.service === "stripe-test";
  let value: string | null = null;
  try {
    // Stripe mode must be rejected before even a destructive force pre-step.
    // Keep this check inside the only value-bearing module, with no value-derived
    // diagnostic. The existing current-basis guard precedes this early read.
    if (stripeTest) {
      if (opts?.beforeSecretRead && !(await opts.beforeSecretRead())) return blockedResult();
      value = new Entry(VAULT_SERVICE, toAccount(ref)).getPassword();
      if (typeof value !== "string" || !value.startsWith("sk_test_") || value.length <= 8 || /\s/.test(value)) return blockedResult();
    }
    for (const step of plan.preSteps ?? []) {
      const result = await runStep(step, null, timeoutMs, pathOverride, opts?.cwd,
        opts?.env, opts?.resolvedCli, beforeSpawn, suppressOutput);
      if (result.exitCode !== 0) return result;
    }
    if (!stripeTest) {
      if (opts?.beforeSecretRead && !(await opts.beforeSecretRead())) return blockedResult();
      // Legacy and existing Resend/Clerk ordering remains unchanged.
      value = new Entry(VAULT_SERVICE, toAccount(ref)).getPassword();
      if (value === null) throw new SecretNotRegisteredError(
        `${ref.name} is not registered. Run: api-key-case save ${ref.name}`
      );
    }
    return await runStep(plan, value, timeoutMs, pathOverride, opts?.cwd,
      opts?.env, opts?.resolvedCli, beforeSpawn, suppressOutput);
  } finally {
    // Best-effort only: JS strings cannot be zeroed before GC. Every early
    // return and exception, including pre-step failures, drops our reference.
    value = "";
  }
}

/** Exact official stdin deployment only. No caller plan/argv/env or value return. */
export async function runConnectionDeployment(input: {
  ref: ConnectionCredentialRef;
  target: TargetId;
  force: boolean;
  execution: Omit<TrustedExecution, "env">;
  stillCurrent: () => boolean | Promise<boolean>;
}): Promise<"completed" | "incomplete" | "unknown" | "changed"> {
  // Defense in depth for the new v2 path; legacy deployment is unchanged.
  if (process.platform !== "win32") return "changed";
  try {
    assertConnectionCredentialRef(input.ref);
    if (!isHostedDeployService(input.ref.service)) return "changed";
    const selector = input.execution?.snapshot?.cloudflareDestination;
    if (selector ? !CLOUDFLARE_TARGET_NATIVE_ACCEPTED : input.ref.service !== "resend" && !PROVIDER_HOSTED_NATIVE_ACCEPTED) return "changed";
    if (selector && (input.target !== "cloudflare" || selector.service !== input.ref.service || input.force)) return "changed";
    if (input.ref.service !== "resend" && !["vercel", "cloudflare"].includes(input.target)) return "changed";
    if (!["vercel", "cloudflare", "github"].includes(input.target) || typeof input.force !== "boolean") return "changed";
    const ref = Object.freeze({ name: input.ref.name, scope: input.ref.scope, projectId: input.ref.projectId,
      service: input.ref.service, environment: input.ref.environment });
    const explicitTarget = selector ? resolveCloudflareTarget(input.execution.cwd, selector.id, ref.service, ref.environment) : null;
    if (selector && !explicitTarget) return "changed";
    const strictCloudflare = !explicitTarget && ref.service !== "resend" && input.target === "cloudflare";
    const destination = strictCloudflare ? resolveClerkWorkerDestination(input.execution.cwd, ref.environment) : null;
    if (strictCloudflare && (!destination || !input.execution.snapshot.providerIdentity?.startsWith("accounts:") ||
        !input.execution.snapshot.providerIdentity.slice(9).split(",").includes(destination.accountId))) return "changed";
    if (explicitTarget && (!input.execution.snapshot.providerIdentity?.startsWith("accounts:") ||
        !input.execution.snapshot.providerIdentity.slice(9).split(",").includes(explicitTarget.target.accountId))) return "changed";
    const repository = input.target === "github" ? resolveConnectionGitHubRepository(input.execution.cwd) : null;
    if (input.target === "github" && !repository) return "changed";
    const adapter = input.target === "github" ? new GitHubEnvironmentAdapter(repository!, ref.environment)
      : input.target === "vercel" ? new VercelAdapter() : explicitTarget ? new CloudflareConfigAdapter(explicitTarget.target) : new CloudflareAdapter();
    const plan = adapter.planDeploy(ref.name, ref.environment, { force: input.force });
    // Never accept an environment map from the caller, even via a trusted snapshot.
    // Production uses the resolver's trusted path; the existing test seam uses the
    // exact fixture executable directory plus the running Node directory.
    const baseEnvironment = buildTrustedExecutionEnvironment(input.execution.resolvedCli,
        input.execution.resolvedCli.trustedPath === undefined ? dirname(input.execution.resolvedCli.absolutePath) : undefined,
        input.execution.snapshot.homeDir);
    const execution: TrustedExecution = Object.freeze({ ...input.execution,
      env: Object.freeze(explicitTarget ? cloudflareTargetEnvironment(baseEnvironment, explicitTarget.target) : baseEnvironment) });
    const request: SnapshotRequest = Object.freeze({ name: ref.name, scope: "project", projectId: ref.projectId,
      env: ref.environment, force: input.force, adapterId: adapter.id, cliCommand: adapter.cliCommand,
      providerIdentity: execution.snapshot.providerIdentity, ...(selector ? { cloudflareDestination: selector } : {}) });
    const current = async () => {
      if (!await input.stillCurrent()) return false;
      // Match the exact snapshot after the awaited guard, immediately before use.
      return (!strictCloudflare || JSON.stringify(resolveClerkWorkerDestination(execution.cwd, ref.environment)) === JSON.stringify(destination)) &&
        matchesTrustedExecution(request, plan, execution);
    };
    if (!await current()) return "changed";
    const result = await performSecretHandoff(ref, plan, {
      cwd: execution.cwd, env: execution.env, resolvedCli: execution.resolvedCli,
      suppressOutput: true, beforeSecretRead: current, beforeSpawn: current
    });
    if (!await current() || result.blocked) return "changed";
    return result.timedOut || result.exitCode === null ? "unknown" : result.exitCode === 0 ? "completed" : "incomplete";
  } catch { return "unknown"; } // Native store/spawn failures may contain values.
}

/** Fixed Clerk → existing Worker version operation. Raw captures never leave this module. */
export async function runClerkVersionPreparation(input: {
  ref: ConnectionCredentialRef;
  execution: Omit<TrustedExecution,"env">;
  stillCurrent: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
}): Promise<{status:"prepared"|"incomplete"|"unknown"|"changed";versionId:string|null;termination:"not-started"|"closed"|"unconfirmed"}> {
  const unknown = (termination:"not-started"|"closed"|"unconfirmed"="not-started") => ({status:"unknown" as const,versionId:null,termination});
  if (!CLERK_PREPARATION_NATIVE_ACCEPTED || process.platform!=="win32") return unknown();
  let value:string|null=null,termination:"not-started"|"closed"|"unconfirmed"="not-started";
  try {
    assertConnectionCredentialRef(input.ref);
    if(input.ref.service!=="clerk"||input.ref.name!=="CLERK_SECRET_KEY"||input.execution.snapshot.target!=="cloudflare")return unknown();
    const ref=Object.freeze({...input.ref}),adapter=new CloudflareVersionsAdapter(ref.environment),plan=adapter.planDeploy(ref.name,ref.environment);
    const destination=resolveClerkWorkerDestination(input.execution.cwd,ref.environment);
    if(!destination||!input.execution.snapshot.providerIdentity?.startsWith("accounts:")||
      !input.execution.snapshot.providerIdentity.slice(9).split(",").includes(destination.accountId))return unknown();
    const execution:TrustedExecution=Object.freeze({...input.execution,env:Object.freeze(cloudflarePreparationEnvironment(
      buildTrustedExecutionEnvironment(input.execution.resolvedCli,input.execution.resolvedCli.trustedPath===undefined?dirname(input.execution.resolvedCli.absolutePath):undefined,input.execution.snapshot.homeDir)))});
    const request:SnapshotRequest=Object.freeze({name:ref.name,scope:"project",projectId:ref.projectId,env:ref.environment,force:false,
      adapterId:"cloudflare",cliCommand:"wrangler",providerIdentity:execution.snapshot.providerIdentity});
    const current=async()=>!input.signal?.aborted&&await input.stillCurrent()&&!input.signal?.aborted&&
      JSON.stringify(resolveClerkWorkerDestination(execution.cwd,ref.environment))===JSON.stringify(destination)&&matchesTrustedExecution(request,plan,execution);
    if(!await current())return {status:"changed",versionId:null,termination:"not-started"};
    const version=await captureClerkCommand(execution,["--version"],null,15_000,input.signal);termination=version.termination;
    if(!version.ok||!isClerkWranglerVersion(version.stdout))return unknown(version.termination);
    if(!await current())return {status:"changed",versionId:null,termination:"not-started"};
    value=new Entry(VAULT_SERVICE,toAccount(ref)).getPassword();
    if(value===null)return unknown();
    if(!await current())return {status:"changed",versionId:null,termination:"not-started"};
    termination="unconfirmed";const captured=await captureClerkCommand(execution,plan.argv.slice(1),value,120_000,input.signal);termination=captured.termination;
    if(!await current()||!captured.ok)return unknown(captured.termination);
    const matches=[...captured.stdout.replaceAll("\r\n","\n").matchAll(/^✨ Success! Created version ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}) with secret CLERK_SECRET_KEY\.$/gm)];
    if(matches.length!==1||!value.trim()||matches[0][1].toLowerCase().includes(value.trim().toLowerCase()))return unknown(captured.termination);
    return {status:"prepared",versionId:matches[0][1],termination:captured.termination};
  }catch{return unknown(termination);}finally{value=null;}
}

function captureClerkCommand(execution:TrustedExecution,args:readonly string[],value:string|null,timeoutMs:number,signal?:AbortSignal):Promise<{ok:boolean;stdout:string;termination:"not-started"|"closed"|"unconfirmed";exitCode?:number|null}> {
  if(signal?.aborted)return Promise.resolve({ok:false,stdout:"",termination:"not-started"});
  return new Promise(resolveResult=>{
    let child:ReturnType<typeof spawnResolvedCli>;
    try{child=spawnResolvedCli(execution.resolvedCli,[...args],{cwd:execution.cwd,env:execution.env,windowsHide:true});}
    catch{resolveResult({ok:false,stdout:"",termination:"not-started"});return;}
    let settled=false,failed=false,bytes=0;const chunks:Buffer[]=[];let grace:ReturnType<typeof setTimeout>|undefined;
    const finish=(ok:boolean,termination:"closed"|"unconfirmed",exitCode:number|null=null)=>{
      if(settled)return;settled=true;clearTimeout(timer);if(grace)clearTimeout(grace);signal?.removeEventListener("abort",stop);
      if(termination==="unconfirmed"){
        for(const pipe of [child.stdin,child.stdout,child.stderr])try{pipe?.destroy();}catch{/* owned pipe cleanup is best effort */}
        try{child.unref();}catch{/* never claim child termination */}
      }
      let stdout="";if(ok)try{stdout=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));}catch{ok=false;}
      chunks.length=0;resolveResult({ok,stdout:ok?stdout:"",termination,exitCode:failed?null:exitCode});
    };
    const stop=()=>{if(settled)return;failed=true;try{child.kill();}catch{/* termination remains unknown */}
      if(!grace)grace=setTimeout(()=>finish(false,"unconfirmed"),2_000);};
    const timer=setTimeout(stop,timeoutMs);
    const data=(chunk:Buffer,retain:boolean)=>{if(settled)return;bytes+=chunk.length;if(bytes>256*1024){stop();return;}if(retain&&!failed)chunks.push(Buffer.from(chunk));};
    child.stdout?.on("data",chunk=>data(chunk,true));child.stderr?.on("data",chunk=>data(chunk,false));
    child.stdout?.on("error",stop);child.stderr?.on("error",stop);child.stdin?.on("error",stop);child.on("error",stop);
    child.on("close",code=>finish(code===0&&!failed&&!signal?.aborted,"closed",code));
    signal?.addEventListener("abort",stop,{once:true});
    if(signal?.aborted){stop();return;}
    try{if(value!==null)child.stdin?.write(value);child.stdin?.end();}catch{stop();}
  });
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
      stderrRedacted: suppressOutput ? "" : `${cliName} could not be resolved from PATH.`,
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
      if (!suppressOutput) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!suppressOutput) stderr += chunk.toString("utf8");
    });

    child.stdin?.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolvePromise({ exitCode: null, stdoutRedacted: "", stderrRedacted: "", timedOut });
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

/**
 * Closed resend-credential-validation-v1 operation. This is a reviewed extension
 * of the sole value-bearing boundary, never a generic getter/env runner.
 * The caller supplies a value-free trusted snapshot; args, cwd and env are fixed here.
 * All captures stay inside this boundary and only a closed status escapes.
 */
export async function runResendCredentialValidation(input: {
  ref: StoredSecretRef;
  cli: ResolvedCli;
  stillCurrent: () => boolean | Promise<boolean>;
}): Promise<ResendValidationCode> {
  if (input.ref.name !== "RESEND_API_KEY" || !["project", "user"].includes(input.ref.scope) ||
      (input.ref.scope === "project" ? !/^[0-9a-f]{16}$/.test(input.ref.projectId ?? "") : input.ref.projectId !== null)) return "unknown";
  // A native binary is independent of the product's Node >=20 host. macOS
  // scripts and the verified Windows npm bundle bind an exact interpreter.
  // Unbound Windows shims still fail closed; they are never executed here.
  if (input.cli.isWindowsScript) return "cli-unavailable";
  const current = async () => {
    // The state guard can await vault checks. Verify the executable after that
    // await, so a replacement during the guard cannot inherit the credential.
    if (!await input.stillCurrent()) return false;
    const cli = currentResolvedCli(input.cli);
    return Boolean(cli && isSameResolvedCli(input.cli, cli));
  };
  let dir: string | null = null;
  let value: string | null = null;
  let env: Record<string, string> | null = null;
  try {
    if (!await current()) return "unknown";
    // doctor also reads its credentials metadata. An empty private config directory
    // isolates that read without touching, copying, logging in, or writing a key.
    const home = process.platform === "win32" ? resolveTrustedHomeDirectory() : null;
    if (process.platform === "win32" && !home) return "unknown";
    const temporaryRoot = process.platform === "win32" ? join(home!, "AppData", "Local", "Temp") : "/tmp";
    dir = mkdtempSync(join(temporaryRoot, "akc-resend-check-"));
    env = {
      PATH: input.cli.trustedPath ?? "",
      HOME: dir, USERPROFILE: dir, APPDATA: dir, XDG_CONFIG_HOME: dir,
      RESEND_CREDENTIAL_STORE: "file", NO_COLOR: "1", CI: "1",
      // The pinned Resend SDK logs API errors (including valid restricted keys)
      // on stderr outside production. Suppress its debug logging at the source;
      // unexpected stderr still fails closed below. Never inherit caller mode.
      NODE_ENV: "production",
      ...(process.platform === "win32" ? { SystemRoot: String.raw`C:\Windows`, WINDIR: String.raw`C:\Windows` } : {})
    };
    if (input.cli.interpreter) {
      const runtime = await captureResend({ ...input.cli.interpreter, isWindowsScript: false }, ["--version"], dir, env);
      const major = /^v(\d+)\.\d+\.\d+$/.exec(runtime.stdout.trim());
      if (runtime.exitCode !== 0 || runtime.stderr.trim() || runtime.timedOut || runtime.overflow ||
          !major || Number(major[1]) < 22) return "cli-unavailable";
    }
    const version = await captureResend(input.cli, ["--version"], dir, env);
    if (version.timedOut || version.overflow || version.exitCode !== 0 || version.stderr.trim() ||
        !new RegExp(`^(?:resend(?:-cli)? )?v?${RESEND_CLI_VERSION.replaceAll(".", "\\.")}$`).test(version.stdout.trim())) return "cli-unavailable";
    // Revalidate after the non-secret version probe and immediately before the read.
    if (!await current()) return "unknown";
    const entry = new Entry(VAULT_SERVICE, toAccount(input.ref));
    value = entry.getPassword();
    if (!value || value.length < 8) return "unknown";
    if (!await current()) return "unknown";
    env.RESEND_API_KEY = value;
    const result = await captureResend(input.cli, ["doctor", "--json"], dir, env);
    if (result.timedOut) return "network-unavailable";
    if (result.overflow) return "unexpected-output";
    if (!await current()) return "unknown";
    // Scrub full values and the CLI's own partial-key form before parsing. Neither
    // masked suffixes nor provider domain detail are ever returned or persisted.
    const clean = (output: string) => scrub(output, value).split(`${value!.slice(0, 3)}...${value!.slice(-4)}`).join("[masked]");
    if (clean(result.stderr).trim()) return "unexpected-output";
    return parseResendDoctor(clean(result.stdout), result.exitCode);
  } catch {
    return "unknown"; // Native store/spawn errors can contain secrets; never propagate.
  } finally {
    if (env) delete env.RESEND_API_KEY;
    value = null;
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* contains no credential */ } }
  }
}

/** Bounded, fixed-operation capture; no provider output crosses the handoff. */
function captureResend(cli: ResolvedCli, args: string[], cwd: string, env: Record<string, string>): Promise<{
  exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; overflow: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawnResolvedCli(cli, args, { cwd, env, windowsHide: true });
    let stdout = "", stderr = "", bytes = 0, timedOut = false, overflow = false, settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode, stdout, stderr, timedOut, overflow });
      stdout = ""; stderr = "";
    };
    const stop = () => {
      child.kill();
      killTimer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, 250);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 15_000);
    const capture = (kind: "stdout" | "stderr", chunk: Buffer) => {
      if (settled || overflow) return;
      bytes += chunk.length;
      if (bytes > 64 * 1024) { overflow = true; stdout = ""; stderr = ""; stop(); return; }
      if (kind === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.stdin?.on("error", () => finish(null));
    child.on("error", () => finish(null));
    child.on("close", finish);
    child.stdin?.end();
  });
}

// Local application credentials stay inside this existing value-bearing module.
// The owner receives a key only over a private pipe, constructs the sole allowed
// child environment, and discards all application streams. No getter is added.
export interface LocalHandoffResult {
  status: import("../agent/connection-state.js").LocalSessionOutcome;
  execution: "not-started" | "possible";
  treeTermination: "not-needed" | "confirmed" | "unknown";
}
async function performLocalApplicationHandoff(input: {
  ref?: ConnectionCredentialRef;
  generic?: import("../vnext/launch.js").LaunchPlan;
  snapshot: import("../local/snapshot.js").LocalLaunchSnapshot | import("../local/profile-snapshot.js").ProfileSnapshot;
  maxDurationMs: number;
  stillCurrent: () => Promise<boolean>;
  signal?: AbortSignal;
  launched: () => void;
}): Promise<LocalHandoffResult> {
  let owner: import("../local/windows-owner.js").WindowsLocalOwner | undefined;
  let value: string | null = null, execution: LocalHandoffResult["execution"] = "not-started";
  let changed = false, cancelled = false, released = false, started = false, fault = false, closed = false;
  let monitor: ReturnType<typeof setTimeout> | undefined, forced: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const unknown = (): LocalHandoffResult => ({ status: "unknown", execution,
    treeTermination: execution === "not-started" ? "not-needed" : "unknown" });
  let stop: () => void = () => {};
  const abort = () => { cancelled = true; stop(); };
  try {
    let ref: ConnectionCredentialRef | undefined;
    if (input.generic) {
      if (!VNEXT_WINDOWS_LOCAL_ACCEPTED || process.platform !== "win32" || input.maxDurationMs !== input.generic.profile.maxDurationSeconds * 1000 ||
          input.snapshot !== input.generic.snapshot) return unknown();
      validate(catalogSchema, input.generic.catalog); validate(launchProfileSchema, input.generic.profile);
    } else {
      if (!input.ref) return unknown();
      assertConnectionCredentialRef(input.ref);
      if (!input.ref || input.ref.service !== "resend" || input.ref.name !== "RESEND_API_KEY" || !("projectDir" in input.snapshot)) return unknown();
      if (input.ref.environment !== "development" || input.ref.projectId !== deriveLocalProject(input.snapshot.projectDir) ||
          !Number.isInteger(input.maxDurationMs) || input.maxDurationMs < 1000 || input.maxDurationMs > 1800000) return unknown();
      ref = Object.freeze({ name: "RESEND_API_KEY" as const, scope: "project" as const,
        projectId: input.ref.projectId, service: "resend" as const, environment: "development" as const });
    }
    const current = async () => !input.signal?.aborted && await input.stillCurrent() &&
      (started && !closed && "currentWithNativeLocks" in input.snapshot ? input.snapshot.currentWithNativeLocks() : input.snapshot.current());
    if (!await current()) return { status: "changed", execution, treeTermination: "not-needed" };
    if (!await current()) return { status: "changed", execution, treeTermination: "not-needed" };
    owner = input.generic ? (await import("../local/windows-launch-owner.js")).spawnWindowsProfileOwner(input.generic.snapshot, input.generic.profile) :
      (await import("../local/windows-owner.js")).spawnWindowsLocalOwner((input.snapshot as import("../local/snapshot.js").LocalLaunchSnapshot).ownerConfig(input.maxDurationMs));
    const lines: string[] = [];
    let buffer = "", bytes = 0;
    let expected: "READY" | "CREATED" | "STARTED" | "terminal" | "none" = "READY", terminalSeen = false;
    let notify: (() => void) | null = null;
    const wake = () => { notify?.(); notify = null; };
    const force = () => { fault = true; if (!closed) { try { owner!.kill(); } catch { /* unknown */ } } wake(); };
    stop = () => {
      if (closed) return;
      try { owner!.stdin.write("CANCEL\n"); } catch { fault = true; }
      if (!forced) forced = setTimeout(force, 2000);
    };
    owner.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 || chunk.some(byte => byte !== 10 && byte !== 95 && (byte < 65 || byte > 90))) { fault = true; force(); return; }
      buffer += chunk.toString("ascii");
      for (;;) {
        const index = buffer.indexOf("\n"); if (index < 0) break;
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!["READY", "CREATED", "STARTED", "EXITED", "FAILED", "CANCELLED", "EXPIRED", "PARENT_LOST", "UNKNOWN"].includes(line)) { fault = true; force(); return; }
        if (terminalSeen) { force(); return; }
        if (["READY", "CREATED", "STARTED"].includes(line)) {
          if (line !== expected) { force(); return; }
          expected = line === "STARTED" ? "terminal" : "none";
        } else {
          if (["EXITED", "FAILED"].includes(line) && expected !== "terminal") { force(); return; }
          terminalSeen = true; expected = "none";
        }
        lines.push(line);
      }
      wake();
    });
    owner.on("error", () => { fault = true; force(); });
    owner.stdin.on("error", () => { fault = true; force(); });
    owner.on("close", () => { closed = true; if (buffer) fault = true; wake(); });
    const wait = async () => { await new Promise<void>(resolve => { notify = resolve; }); };
    const next = async (): Promise<string | null> => {
      while (!lines.length && !closed && !fault) await wait();
      return fault ? null : lines.shift() ?? null;
    };
    const cleanBoundary = () => !closed && !fault && !terminalSeen && !lines.length && !buffer.length;
    const send = (line: string, response: "CREATED" | "STARTED") => {
      if (!cleanBoundary()) throw new Error();
      expected = response; owner!.stdin.write(`${line}\n`);
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    deadline = setTimeout(() => { stop(); }, input.maxDurationMs + 1000);
    // Compilation/READY/secret/CREATED/release must complete within the fresh
    // approval interval. This timeout also bounds a silent/tampered helper.
    let handshake = setTimeout(force, 30000);
    try {
      if (await next() !== "READY") { stop(); return unknown(); }
      if (!await current()) { changed = true; stop(); }
      else {
        if (!cleanBoundary()) { stop(); return unknown(); }
        // Durable attempt already exists. No value-bearing read anywhere else.
        let payload: string | null = null;
        if (input.generic) {
          const values: Record<string, string> = {};
          try {
            for (const [index, id] of input.generic.profile.bindingIds.entries()) {
              const binding = input.generic.catalog.bindings.find(b => b.id === id && b.projectId === input.generic!.profile.projectId);
              const credential = input.generic.catalog.credentials.find(c => c.id === binding?.credentialId);
              if (!binding || !credential || !await current()) { stop(); return unknown(); }
              value = new Entry(VAULT_SERVICE, locatorAccount(validate(locatorSchema, credential.locator))).getPassword();
              if (!value || value.length > 4096 || /[\0\r\n]/.test(value)) { stop(); return unknown(); }
              if (credential.locator.kind === "v2" && credential.locator.ref.service === "stripe-test" && (!value.startsWith("sk_test_") || value.length <= 8 || /\s/.test(value))) { stop(); return unknown(); }
              values[`value${index}`] = value; value = null;
            }
            if (Object.values(values).reduce((sum, v) => sum + v.length, 0) > 24000) { stop(); return unknown(); }
            payload = JSON.stringify(values);
          } finally { for (const key of Object.keys(values)) delete values[key]; }
        } else {
          value = new Entry(VAULT_SERVICE, toAccount(ref!)).getPassword();
          if (!value || value.length > 4096 || /[\0\r\n]/.test(value)) { stop(); return unknown(); }
          payload = JSON.stringify({ secret: value }); value = null;
        }
        if (!await current()) { changed = true; stop(); }
        else {
          execution = "possible";
          send(payload, "CREATED"); payload = null; value = null;
          if (await next() !== "CREATED") { stop(); return unknown(); }
          if (!await current()) { changed = true; stop(); }
          else {
            send("RELEASE", "STARTED"); released = true;
            if (await next() !== "STARTED") { stop(); return unknown(); }
            started = true; input.launched();
            if (!await current()) { changed = true; stop(); }
          }
        }
      }
    } finally { clearTimeout(handshake); }
    const poll = async () => {
      if (closed || fault || changed || cancelled) return;
      try { if (!await current()) { changed = true; stop(); return; } }
      catch { changed = true; stop(); return; }
      if (!closed && !fault) monitor = setTimeout(() => { void poll(); }, 500);
    };
    if (released && !changed && !cancelled) monitor = setTimeout(() => { void poll(); }, 500);
    const terminal = await next();
    if (!["EXITED", "FAILED", "CANCELLED", "EXPIRED", "PARENT_LOST", "UNKNOWN"].includes(terminal ?? "")) { force(); return unknown(); }
    // Native terminal means StopTree ran. Still require helper closure and no
    // extra output before asserting a confirmed termination.
    if (!forced) forced = setTimeout(force, 2000);
    while (!closed && !fault) await wait();
    if (fault || lines.length || terminal === "UNKNOWN" || terminal === "PARENT_LOST") return unknown();
    if (!cancelled && !await current()) changed = true;
    const status = changed ? "changed" : cancelled || terminal === "CANCELLED" ? "cancelled" :
      terminal === "EXPIRED" ? "expired" : terminal === "EXITED" ? "exited" : "failed";
    return { status, execution, treeTermination: execution === "not-started" ? "not-needed" : "confirmed" };
  } catch { stop(); return unknown(); }
  finally {
    value = null;
    if (monitor) clearTimeout(monitor); if (deadline) clearTimeout(deadline); if (forced) clearTimeout(forced);
    input.signal?.removeEventListener("abort", abort);
    // Early protocol failures cannot leave ownership alive while returning.
    if (owner && !closed) { try { owner.stdin.destroy(); owner.kill(); } catch { /* returns unknown */ } }
  }
}

import { deriveProjectId as deriveLocalProject } from "../vault/naming.js";

/** No value getter: all OS reads and private owner payloads stay inside this module. */
export async function runGenericLocalApplication(plan: import("../vnext/launch.js").LaunchPlan, current: () => Promise<boolean>, launched: () => void, signal?: AbortSignal): Promise<LocalHandoffResult> {
  if (!VNEXT_WINDOWS_LOCAL_ACCEPTED || process.platform !== "win32") return { status: "changed", execution: "not-started", treeTermination: "not-needed" };
  return performLocalApplicationHandoff({ generic: plan, snapshot: plan.snapshot, maxDurationMs: plan.profile.maxDurationSeconds * 1000,
    stillCurrent: current, launched, signal });
}

// Windows ordinary-file development acceptance is recorded in VERIFICATION.md.
// No request, receipt, environment variable or exported injection changes this gate.
export const LOCAL_NATIVE_LAUNCH_ACCEPTED = true;
interface LocalExecutionDeps {
  vault: Vault;
  humanPlane: HumanPlane;
  signal?: AbortSignal;
  connectionBaseDir?: string;
  licenseOptions?: LicenseOptions;
  now?: () => number;
}
function localResult(status: LocalSessionResult["status"]): LocalSessionResult {
  return { service: "resend", environment: "development", status, attemptId: null,
    execution: "not-started", treeTermination: "not-needed", receiptSaved: false, permission: "none",
    nativeLauncher: LOCAL_NATIVE_LAUNCH_ACCEPTED && process.platform === "win32" ? "enabled" : "disabled-awaiting-windows-acceptance", applicationReadiness: "not-verified" };
}
function validLocalRequest(request: LocalSessionRequest): boolean {
  return Boolean(request && typeof request === "object" && !Array.isArray(request) &&
    Object.keys(request).sort().join(",") === "artifact,environment,maxDurationMs,projectDir,service" &&
    request.service === "resend" && request.environment === "development" && typeof request.projectDir === "string" &&
    typeof request.artifact === "string" && Number.isInteger(request.maxDurationMs) &&
    request.maxDurationMs >= 1000 && request.maxDurationMs <= 1800000);
}

export async function runLocalApplication(request: LocalSessionRequest, signal?: AbortSignal): Promise<LocalSessionResult> {
  // Factory errors are also closed; no native/library diagnostic escapes.
  let deps: LocalExecutionDeps;
  try {
    deps = { vault: createVault(), humanPlane: createHumanPlane(), signal };
    // Conservative internal development gate, not public pricing. The result
    // always independently discloses whether native acceptance is still blocked.
    assertProFeature("deploy", deps.licenseOptions);
  }
  catch (error) { return localResult(error instanceof ProFeatureError ? "pro-required" : "unavailable"); }
  return prepareLocalExecution(deps, request);
}
async function prepareLocalExecution(deps: LocalExecutionDeps, request: LocalSessionRequest): Promise<LocalSessionResult> {
  if (!validLocalRequest(request)) return localResult("unsupported");
  request = Object.freeze({ ...request });
  let store: ConnectionStateStore | null = null, attemptId: string | null = null;
  try {
    const canonical = realpathSync(request.projectDir);
    store = new ConnectionStateStore(canonical, deps.connectionBaseDir);
    const selected = store.readIntent();
    if (selected.status !== "available") return localResult("intent-unavailable");
    const intent = selected.value;
    if (intent.service !== "resend" || intent.environment !== "development" ||
        intent.route !== "api-key-case-managed" || intent.destination.kind !== "local") return localResult("intent-mismatch");
    const ref = Object.freeze(connectionCredentialRef(canonical, "development"));
    const revision = store.credentialRevision(ref);
    if (!revision) return localResult("revision-unavailable");
    const fingerprint = connectionIntentFingerprint(intent);
    let snapshot: LocalLaunchSnapshot;
    try { snapshot = new LocalLaunchSnapshot(canonical, request.artifact); }
    catch { return localResult("inputs-unavailable"); }
    const now = deps.now ?? Date.now;
    let approvedAt: number | null = null, nativeRunning = false;
    const current = async (): Promise<boolean> => {
      try {
        if (deps.signal?.aborted || !await deps.vault.hasSecret(ref)) return false;
        const next = store!.readIntent();
        // All synchronous identity reads occur after the awaited vault boundary.
        return !deps.signal?.aborted && realpathSync(request.projectDir) === canonical && next.status === "available" &&
          connectionIntentFingerprint(next.value) === fingerprint && store!.credentialRevision(ref) === revision &&
          (attemptId === null || store!.ownsLocalSession(attemptId)) &&
          (nativeRunning ? snapshot.currentWithNativeLocks() : snapshot.current()) && (approvedAt === null || (now() >= approvedAt && now() - approvedAt <= 60000));
      } catch { return false; }
    };
    if (!await deps.vault.hasSecret(ref)) return localResult("missing-credential");
    if (!await current()) return localResult("changed");
    if (!LOCAL_NATIVE_LAUNCH_ACCEPTED || process.platform !== "win32") return localResult("native-acceptance-required");
    const lockStatus = store.localSessionLockStatus();
    if (lockStatus !== "absent") return localResult(lockStatus === "present" ? "recovery-required" : "metadata-unavailable");
    if (deps.humanPlane?.capability() !== "os-dialog" || !deps.humanPlane.askLocalApplication) return localResult("unavailable");
    if (deps.signal?.aborted) return localResult("cancelled");
    const decision = await deps.humanPlane.askLocalApplication(Object.freeze({ projectDir: snapshot.projectDir,
      artifactPath: snapshot.artifactPath, interpreterPath: snapshot.interpreterPath,
      service: "resend", environment: "development", credentialRevision: revision, maxDurationMs: request.maxDurationMs }));
    approvedAt = decision === "approved" ? now() : null;
    if (!await current()) return localResult("changed");
    if (decision !== "approved") return localResult(decision === "declined" ? "declined" : "unavailable");
    const begun = store.beginLocalSession(revision, request.maxDurationMs);
    if (!begun.ok) return localResult(begun.issue === "lock-present" ? "recovery-required" : "metadata-unavailable");
    attemptId = begun.value.attemptId;
    const complete = (outcome: LocalHandoffResult) => {
      const ownershipReleased = outcome.execution === "not-started" || outcome.treeTermination === "confirmed";
      const finish = () => store!.finishLocalSession(attemptId!, outcome.status, ownershipReleased,
        { execution: outcome.execution, treeTermination: outcome.treeTermination });
      let saved = finish();
      const failure = store!.localSessionCompletionFailure();
      // Only completion I/O, once, while this invocation retains its exact
      // pending receipt, lock identity and known no-launch/teardown evidence.
      if (!saved && ownershipReleased && failure &&
          ["io-error", "access-denied", "read-only-storage", "storage-full"].includes(failure.issue)) saved = finish();
      return { saved, failure: saved ? null : store!.localSessionCompletionFailure() };
    };
    if (!await current()) {
      const completion = complete({ status: "changed", execution: "not-started", treeTermination: "not-needed" });
      return { ...localResult(completion.saved ? "changed" : "metadata-unavailable"), attemptId, receiptSaved: completion.saved,
        ...(completion.failure ? { completionFailure: completion.failure } : {}) };
    }
    // Approval age matters until launch; running sessions are bounded by the
    // helper's independent deadline and monitored source/credential identity.
    let launched = false;
    const guarded = async () => {
      const before = approvedAt;
      if (launched) approvedAt = null;
      try { return await current(); } finally { approvedAt = before; }
    };
    const outcome: LocalHandoffResult = await performLocalApplicationHandoff({ ref, snapshot,
      maxDurationMs: request.maxDurationMs, stillCurrent: guarded, signal: deps.signal,
      launched: () => { launched = true; nativeRunning = true; } });
    const completion = complete(outcome);
    return { ...localResult(completion.saved ? outcome.status : "unknown"), attemptId, execution: outcome.execution,
      treeTermination: outcome.treeTermination, receiptSaved: completion.saved,
      ...(completion.failure ? { completionFailure: completion.failure } : {}) };
  } catch {
    // Once a durable start exists, an interruption remains unknown. Never retry.
    return { ...localResult(attemptId ? "unknown" : "unavailable"), attemptId,
      execution: attemptId ? "possible" : "not-started", treeTermination: attemptId ? "unknown" : "not-needed" };
  }
}
