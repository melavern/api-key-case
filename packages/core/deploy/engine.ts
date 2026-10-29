import { assertValidSecretName, type SecretRef, type SecretScope, type Vault } from "../vault/types.js";
import { runClerkVersionPreparation, runConnectionDeployment, runWithSecret, type HandoffResult } from "./handoff.js";
import {
  DeploymentHistory, historyDiagnostic, historyIssueFromError, renderHistoryDiagnostic,
  type HistoryDiagnostic, type HistoryIssue
} from "./history.js";
import {
  buildTrustedExecution,
  resolveConnectionGitHubRepository,
  resolveClerkWorkerDestination,
  DESTINATION_REQUIREMENT,
  makeApprovalPlan,
  matchesTrustedExecution,
  type SnapshotRequest,
  type TrustedExecution
} from "./snapshot.js";
import {
  destinationIdentity,
  isAutomaticSafeOperation,
  readDestinationTrust,
  recordDestinationTrust,
  type DestinationIdentity,
  type DestinationTrustState
} from "./destination.js";
import type { HumanPlane } from "../human/types.js";
import { humanPlaneRequirement } from "../human/index.js";
import { deriveProjectId } from "../vault/naming.js";
import { realpathSync, statSync } from "node:fs";
import { isSameResolvedCli } from "./which.js";
import { ConnectionStateStore } from "../agent/connection-state.js";
import { clerkCredentialRef, connectionCredentialRef, credentialRefForService } from "../agent/connection-credential.js";
import { connectionIntentFingerprint } from "../agent/fingerprints.js";
import { assertProFeature, ProFeatureError, type LicenseOptions } from "../license.js";
import type { ConnectionCredentialRef } from "../vault/types.js";
import { VercelAdapter } from "../../adapters/vercel.js";
import { GitHubEnvironmentAdapter } from "../../adapters/github-environment.js";
import { CloudflareAdapter, CloudflareConfigAdapter } from "../../adapters/cloudflare.js";
import { CloudflareVersionsAdapter } from "../../adapters/cloudflare-versions.js";
import { CLERK_PREPARATION_NATIVE_ACCEPTED, clerkManagedIntentFingerprint } from "../agent/clerk-managed.js";
import { PROVIDER_HOSTED_NATIVE_ACCEPTED, CLOUDFLARE_TARGET_NATIVE_ACCEPTED, isHostedDeployService, type HostedDeployService } from "./provider-hosted.js";
import { isCloudflareDestinationId, resolveCloudflareTarget, type CloudflareTarget } from "./cloudflare-targets.js";
import type { ApprovalTrustState, DeployEnv, DeployPlan, DeployTarget, TargetId } from "./types.js";

// The common deploy flow (phase-3-deploy.md §3.2). Has no direct terminal
// I/O of its own. High-risk confirmation is delegated to an
// Agent-independent Human Plane; it is never read from the caller's stdin.
export interface EngineDeps {
  vault: Vault;
  adapter: DeployTarget;
  print: (line: string) => void;
  humanPlane?: HumanPlane;
  pathOverride?: string; // test-only; threaded through to which.ts
  historyBaseDir?: string; // test-only; never exposed through CLI/MCP input
}

export interface DeployRequest {
  name: string;
  scope: SecretScope;
  projectId: string | null;
  projectDir: string;
  env: DeployEnv;
  dryRun: boolean;
  force: boolean;
}

export type DeployResult =
  | { kind: "cli-unavailable" }
  | { kind: "missing-secret" }
  | { kind: "dry-run" }
  | { kind: "declined" }
  | { kind: "unavailable" }
  | { kind: "changed"; placementEffects?: "possible"; preparationTermination?: "not-started"|"closed"|"unconfirmed"; historySaved?: boolean; historyDiagnostic?: HistoryDiagnostic }
  | { kind: "history-unavailable"; historyDiagnostic: HistoryDiagnostic }
  | { kind: "executed"; handoff: HandoffResult; historySaved: boolean; historyDiagnostic?: HistoryDiagnostic };

/** Closed v2 entrypoint. No arbitrary name, scope, target, command, URL or environment map. */
export interface ConnectionDeployRequest {
  destinationId?: string;
  service: HostedDeployService;
  environment: DeployEnv;
  projectDir: string;
  dryRun: boolean;
  force: boolean;
}
export interface ConnectionDeployDeps {
  vault: Vault;
  humanPlane?: HumanPlane;
  // Internal test seams, never CLI/MCP options or environment overrides.
  pathOverride?: string;
  historyBaseDir?: string;
  connectionBaseDir?: string;
  licenseOptions?: LicenseOptions;
  adapter?: DeployTarget;
}
export interface ConnectionDeployResult {
  destination?: CloudflareTarget;
  service: HostedDeployService;
  environment: DeployEnv | null;
  status: "pro-required" | "unsupported" | "intent-unavailable" | "intent-mismatch" |
    "missing-credential" | "revision-unavailable" | "dry-run" | "declined" | "unavailable" |
    "changed" | "history-unavailable" | "completed" | "incomplete" | "unknown";
  /** Credential placement only; execution probes may refresh provider auth state. */
  placementEffects: "none" | "possible";
  preview?: {
    kind: "offline-request"; name: "RESEND_API_KEY" | "OPENAI_API_KEY" | "STRIPE_API_KEY"; scope: "project";
    placementEffect: "cloudflare-version-and-immediate-deployment" | "vercel-environment-update" | "github-environment-secret-update";
    nativeExecution: "accepted-windows-only" | "pending-acceptance";
    providerMode: "test" | "not-applicable";
    sourceEnvironment: DeployEnv; destinationEnvironment: DeployEnv | "staging"; target: "vercel" | "cloudflare" | "github";
    force: boolean; removesExistingFirst: boolean; mayOverwrite: boolean;
    destinationReadiness: "not-verified"; providerProbes: "not-run"; permission: "none";
    repository?: string; destinationScope?: "github-environment";
  };
  historySaved: boolean;
  historyDiagnostic?: HistoryDiagnostic;
}
interface ConnectionBinding {
  cloudflareTarget?: CloudflareTarget;
  ref: ConnectionCredentialRef;
  revision: string;
  intentFingerprint: string;
  metadataDir: string;
  current: () => Promise<boolean>;
  preparation?: true;
  preparationDestination?: {accountId:string;worker:string};
  signal?: AbortSignal;
}

export async function runConnectionDeploy(deps: ConnectionDeployDeps, request: ConnectionDeployRequest): Promise<ConnectionDeployResult> {
  const result = (status: ConnectionDeployResult["status"], placementEffects: "none" | "possible" = "none",
    historySaved = false, diagnostic?: HistoryDiagnostic): ConnectionDeployResult => ({ service: isHostedDeployService(request?.service) ? request.service : "resend",
    environment: ["development", "preview", "production"].includes(request?.environment) ? request.environment : null,
    status, placementEffects, historySaved,
    ...(diagnostic ? { historyDiagnostic: diagnostic } : {}) });
  let executionEntered = false;
  try { assertProFeature("deploy", deps.licenseOptions); }
  catch (error) { return result(error instanceof ProFeatureError ? "pro-required" : "unavailable"); }
  if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).sort().join(",") !== (Object.hasOwn(request, "destinationId") ? "destinationId,dryRun,environment,force,projectDir,service" : "dryRun,environment,force,projectDir,service") ||
      (Object.hasOwn(request, "destinationId") && (!isCloudflareDestinationId(request.destinationId) || request.force)) ||
      !isHostedDeployService(request.service) || !["development", "preview", "production"].includes(request.environment) ||
      (request.service === "stripe-test" && request.environment === "production") ||
      typeof request.projectDir !== "string" || typeof request.dryRun !== "boolean" || typeof request.force !== "boolean") {
    return result("unsupported");
  }
  request = Object.freeze({ ...request });
  // New v2 hosted execution is enabled only on the accepted Windows host path.
  if (!request.dryRun && process.platform !== "win32") return result("unavailable");
  if (!request.dryRun && (request.destinationId ? !CLOUDFLARE_TARGET_NATIVE_ACCEPTED : request.service !== "resend" && !PROVIDER_HOSTED_NATIVE_ACCEPTED)) return result("unavailable");
  try {
    // v2 metadata keeps realpathSync's naming rules, including Windows short paths.
    // Native expansion is reserved for physical destination equality in the engine.
    const canonical = realpathSync(request.projectDir);
    if (!statSync(canonical).isDirectory()) return result("unavailable");
    const store = new ConnectionStateStore(canonical, deps.connectionBaseDir);
    const selected = request.service === "resend" ? store.readIntent() : store.readProviderHostedIntent(request.service);
    if (selected.status !== "available") return result("intent-unavailable");
    const intent = selected.value;
    if (intent.environment !== request.environment) return result("intent-mismatch");
    if (intent.service !== request.service || intent.route !== "api-key-case-managed" ||
        !(request.service === "resend" ? ["vercel", "cloudflare", "github"] : ["vercel", "cloudflare"]).includes(intent.destination.kind)) return result("unsupported");
    const explicitTarget = request.destinationId ? resolveCloudflareTarget(canonical, request.destinationId, request.service, request.environment) : null;
    if (request.destinationId && (intent.destination.kind !== "cloudflare" || !explicitTarget)) return result("unavailable");
    const githubRepository = intent.destination.kind === "github" ? resolveConnectionGitHubRepository(canonical) : null;
    if (intent.destination.kind === "github" && !githubRepository) return result("unavailable");
    const ref = Object.freeze(credentialRefForService(canonical, request.environment, request.service));
    if (ref.service === "clerk") return result("unsupported");
    const strictCloudflare = !explicitTarget && request.service !== "resend" && intent.destination.kind === "cloudflare";
    const cloudflareDestination = strictCloudflare ? resolveClerkWorkerDestination(canonical, request.environment) : null;
    if (strictCloudflare && !cloudflareDestination) return result("unavailable");
    const revision = store.credentialRevision(ref);
    if (!revision) return result("revision-unavailable");
    const intentFingerprint = connectionIntentFingerprint(intent);
    const current = async (): Promise<boolean> => {
      try {
        // Read metadata AFTER the awaited presence check, never trust its earlier copy.
        if (!await deps.vault.hasSecret(ref)) return false;
        const now = request.service === "resend" ? store.readIntent() : store.readProviderHostedIntent(request.service);
        return (!explicitTarget || JSON.stringify(resolveCloudflareTarget(canonical, request.destinationId!, request.service, request.environment)) === JSON.stringify(explicitTarget)) &&
          (!strictCloudflare || JSON.stringify(resolveClerkWorkerDestination(canonical, request.environment)) === JSON.stringify(cloudflareDestination)) &&
          (githubRepository === null || resolveConnectionGitHubRepository(canonical) === githubRepository) &&
          realpathSync(request.projectDir) === canonical && deriveProjectId(canonical) === ref.projectId &&
          now.status === "available" && now.value.id === intent.id &&
          connectionIntentFingerprint(now.value) === intentFingerprint && store.credentialRevision(ref) === revision;
      } catch { return false; }
    };
    // isAvailable() writes a probe credential in the production vault. Exact-slot
    // presence already reports access errors, so never use that mutating probe here.
    if (!await deps.vault.hasSecret(ref)) return result("missing-credential");
    if (!await current()) return result("changed");
    const official = intent.destination.kind === "github" ? new GitHubEnvironmentAdapter(githubRepository!, request.environment)
      : intent.destination.kind === "vercel" ? new VercelAdapter() : explicitTarget ? new CloudflareConfigAdapter(explicitTarget.target) : new CloudflareAdapter();
    const adapter = deps.adapter ?? official;
    // A test seam cannot add a target or change the official argv contract.
    const expected = sealDeployPlan(official.planDeploy(ref.name, request.environment, { force: request.force }), official.cliCommand);
    const actual = sealDeployPlan(adapter.planDeploy(ref.name, request.environment, { force: request.force }), adapter.cliCommand);
    if (adapter.id !== official.id || adapter.cliCommand !== official.cliCommand || !actual ||
        JSON.stringify(actual) !== JSON.stringify(expected)) return result("unsupported");
    if (!await current()) return result("changed");
    if (request.dryRun) return { ...result("dry-run"), ...(explicitTarget ? { destination: explicitTarget.target } : {}), preview: {
      kind: "offline-request", name: ref.name, scope: "project", sourceEnvironment: request.environment,
      placementEffect: official.id === "cloudflare" ? "cloudflare-version-and-immediate-deployment" : official.id === "vercel" ? "vercel-environment-update" : "github-environment-secret-update",
      nativeExecution: explicitTarget ? (CLOUDFLARE_TARGET_NATIVE_ACCEPTED ? "accepted-windows-only" : "pending-acceptance") : request.service === "resend" ? "accepted-windows-only" : "pending-acceptance",
      providerMode: request.service === "stripe-test" ? "test" : "not-applicable",
      destinationEnvironment: explicitTarget?.target.deploymentEnvironment ?? request.environment, target: official.id, force: request.force,
      removesExistingFirst: (actual.preSteps?.length ?? 0) > 0,
      mayOverwrite: actual.overwriteWarning || (actual.preSteps?.length ?? 0) > 0,
      destinationReadiness: "not-verified", providerProbes: "not-run", permission: "none",
      ...(githubRepository ? { repository: `github.com/${githubRepository}`, destinationScope: "github-environment" as const } : {})
    } };
    const binding: ConnectionBinding = { ref, revision, intentFingerprint, metadataDir: canonical, current,
      ...(explicitTarget ? { cloudflareTarget: explicitTarget.target } : {}) };
    executionEntered = true;
    const outcome = await runDeployEngine({ ...deps, adapter, print: () => {} }, {
      name: ref.name, scope: "project", projectId: ref.projectId, projectDir: canonical,
      env: request.environment, force: request.force, dryRun: false
    }, binding);
    if (outcome.kind === "executed") return { ...result(outcome.handoff.blocked ? "changed" :
      outcome.handoff.timedOut || outcome.handoff.exitCode === null ? "unknown" :
        outcome.handoff.exitCode === 0 ? "completed" : "incomplete", "possible", outcome.historySaved, outcome.historyDiagnostic),
      ...(explicitTarget ? { destination: explicitTarget.target } : {}) };
    const status = outcome.kind === "missing-secret" ? "missing-credential" :
      outcome.kind === "cli-unavailable" ? "unavailable" : outcome.kind;
    return result(status, outcome.kind === "changed" && outcome.placementEffects === "possible" ? "possible" : "none",
      outcome.kind === "changed" ? outcome.historySaved ?? false : false, "historyDiagnostic" in outcome ? outcome.historyDiagnostic : undefined);
  } catch { return result(executionEntered ? "unknown" : "unavailable", executionEntered ? "possible" : "none"); }
}

export interface ClerkPrepareRequest {service:"clerk";environment:DeployEnv;projectDir:string;dryRun:boolean}
export interface ClerkPrepareResult {
  service:"clerk";environment:DeployEnv|null;status:Exclude<ConnectionDeployResult["status"],"completed">|"prepared";
  placementEffects:"none"|"possible";versionId:string|null;activation:"not-performed-by-this-invocation";
  historySaved:boolean;historyDiagnostic?:HistoryDiagnostic;termination?:"not-started"|"closed"|"unconfirmed";
  preview?:{target:"cloudflare";name:"CLERK_SECRET_KEY";environment:DeployEnv;worker:string;accountId:string;remoteCode:"latest-at-operation";versionUrlExposure:"possible";permission:"none"};
}
export async function runClerkConnectionPrepare(deps:ConnectionDeployDeps & {signal?:AbortSignal},request:ClerkPrepareRequest):Promise<ClerkPrepareResult>{
  const result=(status:ClerkPrepareResult["status"],placementEffects:"none"|"possible"="none"):ClerkPrepareResult=>({service:"clerk",environment:["development","preview","production"].includes(request?.environment)?request.environment:null,status,placementEffects,versionId:null,activation:"not-performed-by-this-invocation",historySaved:false});
  try{assertProFeature("deploy",deps.licenseOptions);}catch(error){return result(error instanceof ProFeatureError?"pro-required":"unavailable");}
  if(!request||typeof request!=="object"||Array.isArray(request)||Object.keys(request).sort().join(",")!=="dryRun,environment,projectDir,service"||request.service!=="clerk"||
    !["development","preview","production"].includes(request.environment)||typeof request.projectDir!=="string"||typeof request.dryRun!=="boolean")return result("unsupported");
  request=Object.freeze({...request});
  if(!request.dryRun&&(!CLERK_PREPARATION_NATIVE_ACCEPTED||process.platform!=="win32"))return result("unavailable");
  let executionEntered=false;
  try{
    const canonical=realpathSync(request.projectDir),store=new ConnectionStateStore(canonical,deps.connectionBaseDir),selected=store.readClerkManagedIntent();
    if(selected.status!=="available")return result("intent-unavailable");
    const intent=selected.value;if(intent.environment!==request.environment)return result("intent-mismatch");
    const destination=resolveClerkWorkerDestination(canonical,request.environment);if(!destination)return result("unavailable");
    const ref=Object.freeze(clerkCredentialRef(canonical,request.environment)),revision=store.credentialRevision(ref);
    if(!revision)return result("revision-unavailable");
    const intentFingerprint=clerkManagedIntentFingerprint(intent);
    const current=async()=>{
      try{if(deps.signal?.aborted||!await deps.vault.hasSecret(ref)||deps.signal?.aborted)return false;
        const now=store.readClerkManagedIntent();return realpathSync(request.projectDir)===canonical&&now.status==="available"&&
          clerkManagedIntentFingerprint(now.value)===intentFingerprint&&store.credentialRevision(ref)===revision&&
          JSON.stringify(resolveClerkWorkerDestination(canonical,request.environment))===JSON.stringify(destination);
      }catch{return false;}
    };
    if(!await deps.vault.hasSecret(ref))return result("missing-credential");if(!await current())return result("changed");
    const official=new CloudflareVersionsAdapter(request.environment),adapter=deps.adapter??official;
    const expected=sealDeployPlan(official.planDeploy(ref.name,request.environment),official.cliCommand),actual=sealDeployPlan(adapter.planDeploy(ref.name,request.environment,{force:false}),adapter.cliCommand);
    if(adapter.id!=="cloudflare"||adapter.cliCommand!=="wrangler"||!actual||JSON.stringify(actual)!==JSON.stringify(expected))return result("unsupported");
    if(request.dryRun)return {...result("dry-run"),preview:{target:"cloudflare",name:"CLERK_SECRET_KEY",environment:request.environment,worker:destination.name,accountId:destination.accountId,remoteCode:"latest-at-operation",versionUrlExposure:"possible",permission:"none"}};
    const binding:ConnectionBinding={ref,revision,intentFingerprint,metadataDir:canonical,current,preparation:true,
      preparationDestination:{accountId:destination.accountId,worker:destination.name},signal:deps.signal};executionEntered=true;
    const outcome=await runDeployEngine({...deps,adapter,print:()=>{}},{name:ref.name,scope:"project",projectId:ref.projectId,projectDir:canonical,env:request.environment,force:false,dryRun:false},binding);
    if(outcome.kind==="executed")return {...result(outcome.handoff.preparedVersionId?"prepared":"unknown","possible"),versionId:outcome.handoff.preparedVersionId??null,
      historySaved:outcome.historySaved,...(outcome.historyDiagnostic?{historyDiagnostic:outcome.historyDiagnostic}:{}),termination:outcome.handoff.preparationTermination??"not-started"};
    const status=outcome.kind==="missing-secret"?"missing-credential":outcome.kind==="cli-unavailable"?"unavailable":outcome.kind;
    return {...result(status,outcome.kind==="changed"&&outcome.placementEffects==="possible"?"possible":"none"),
      ...(outcome.kind==="changed"?{historySaved:outcome.historySaved??false,...(outcome.preparationTermination?{termination:outcome.preparationTermination}:{})}:{}),...("historyDiagnostic" in outcome?{historyDiagnostic:outcome.historyDiagnostic}:{})};
  }catch{return result(executionEntered?"unknown":"unavailable",executionEntered?"possible":"none");}
}

export async function runDeploy(deps: EngineDeps, request: DeployRequest): Promise<DeployResult> {
  return runDeployEngine(deps, request);
}

async function runDeployEngine(deps: EngineDeps, request: DeployRequest, connection?: ConnectionBinding): Promise<DeployResult> {
  assertValidSecretName(request.name);

  let projectDir: string;
  try {
    projectDir = realpathSync.native(request.projectDir);
    if (!statSync(projectDir).isDirectory()) return { kind: "unavailable" };
  } catch {
    deps.print("NG: the project directory is unavailable.");
    return { kind: "unavailable" };
  }

  const ref: SecretRef = connection?.ref ?? { name: request.name, scope: request.scope, projectId: request.projectId };

  // Build the plan once. It is the exact argv set shown to the Human Plane
  // and the only argv set permitted to execute later in this call.
  const plan = sealDeployPlan(
    deps.adapter.planDeploy(request.name, request.env, { force: request.force }),
    deps.adapter.cliCommand
  );
  if (!plan) {
    deps.print("NG: the deploy plan is not a supported operation.");
    return { kind: "unavailable" };
  }

  if (connection) {
    const repository = deps.adapter.id === "github" ? resolveConnectionGitHubRepository(projectDir) : null;
    if (deps.adapter.id === "github" && !repository) return { kind: "unavailable" };
    const official = connection.preparation ? new CloudflareVersionsAdapter(connection.ref.environment) : deps.adapter.id === "github" ? new GitHubEnvironmentAdapter(repository!, connection.ref.environment)
      : deps.adapter.id === "vercel" ? new VercelAdapter() : connection.cloudflareTarget ? new CloudflareConfigAdapter(connection.cloudflareTarget) : new CloudflareAdapter();
    if (deps.adapter.id !== official.id || JSON.stringify(plan) !== JSON.stringify(sealDeployPlan(
      official.planDeploy(connection.ref.name, connection.ref.environment, { force: request.force }), official.cliCommand))) {
      return { kind: "unavailable" };
    }
  }

  // Phase D denies by default: an operation may skip the Human Plane only if
  // its class is on the closed automatic-safe allowlist AND (checked below)
  // its destination identity was already confirmed by a human on this machine.
  // Everything else keeps the Phase C approval boundary unchanged.
  const automaticClass = !connection?.preparation && isAutomaticSafeOperation({
    target: deps.adapter.id,
    env: request.env,
    scope: request.scope,
    force: request.force,
    plan
  });
  let requiresHuman = !automaticClass;

  // GitHub detection shells out to the advisory `git` helper. It must not
  // become part of a high-risk trusted flow because that helper is resolved
  // through the caller's PATH. The approval snapshot reads and binds Git
  // destination config directly instead. Filesystem-only detection remains
  // unchanged for the other adapters.
  if (!connection && !(requiresHuman && deps.adapter.id === "github")) {
    const detect = await deps.adapter.detect(projectDir);
    if (!detect.detected) {
      deps.print(
        `Warning: ${deps.adapter.id} was not detected in this project (${detect.reason}). Continuing anyway.`
      );
    }
  }

  // Every executing project-scoped deploy must use the vault identity derived
  // from the same real directory that the child CLI will receive, so a Secret
  // from one project can never travel to another project's destination.
  if (!request.dryRun && request.scope === "project") {
    try {
      if (request.projectId !== deriveProjectId(connection?.metadataDir ?? projectDir)) {
        deps.print("NG: the project identity changed; deploy was aborted.");
        return { kind: "changed" };
      }
    } catch {
      return { kind: "unavailable" };
    }
  }

  if (connection && !await connection.current()) return { kind: "changed" };
  const hasSecret = await deps.vault.hasSecret(ref);
  if (!hasSecret) {
    const fallback =
      request.scope === "project" ? " Try --scope user or" : "";
    deps.print(
      `NG: ${request.name} is not registered in ${request.scope} scope.${fallback} Run: api-key-case save ${request.name}`
    );
    return { kind: "missing-secret" };
  }

  if (connection && !await connection.current()) return { kind: "changed" };
  let trustedExecution: TrustedExecution | undefined;
  let snapshotRequest: SnapshotRequest | undefined;

  // Both classes bind the destination. There is no execution path left that
  // inherits the caller's PATH or environment.
  if (!request.dryRun) {
    snapshotRequest = {
      name: request.name,
      scope: request.scope,
      projectId: request.projectId,
      env: request.env,
      force: request.force,
      adapterId: deps.adapter.id,
      cliCommand: deps.adapter.cliCommand,
      providerIdentity: null,
      ...(connection?.cloudflareTarget ? { cloudflareDestination: { id: connection.cloudflareTarget.id, service: connection.ref.service as HostedDeployService } } : {})
    };
    const trusted = buildTrustedExecution(snapshotRequest, plan, {
      pathOverride: deps.pathOverride,
      projectDir
    });
    if (!trusted.ok) {
      deps.print(
        "NG: this deploy could not be bound to one trusted destination; operation denied."
      );
      // Naming the requirement is not a hint about this machine's state: it is
      // the same fixed sentence for every project using this target.
      deps.print(`This target needs ${DESTINATION_REQUIREMENT[deps.adapter.id]}.`);
      deps.print("Do these steps manually instead:");
      for (const [index, step] of deps.adapter.manualSteps(request.name, request.env).entries()) {
        deps.print(`  ${index + 1}. ${step}`);
      }
      deps.print("Note: api-key-case never prints the value. Copy it from where you originally saved it.");
      return { kind: "unavailable" };
    }
    trustedExecution = trusted.execution;
  }

  // Adapter probes use the same absolute CLI and sanitized child environment
  // the operation itself will use. A dry run keeps PATH-based inspection.
  const cli = await deps.adapter.checkCli(
    trustedExecution
      ? {
          cwd: projectDir,
          env: trustedExecution.env,
          resolvedCli: trustedExecution.resolvedCli,
          pathOverride: deps.pathOverride
        }
      : { cwd: projectDir, pathOverride: deps.pathOverride }
  );
  if (connection && !await connection.current()) return { kind: "changed" };
  if (!cli.installed || !cli.loggedIn) {
    const reason = !cli.installed ? "is not installed" : "is not logged in";
    deps.print(`NG: ${deps.adapter.cliCommand} ${reason}. Do these steps manually:`);
    for (const [index, step] of deps.adapter.manualSteps(request.name, request.env).entries()) {
      deps.print(`  ${index + 1}. ${step}`);
    }
    deps.print("Note: api-key-case never prints the value. Copy it from where you originally saved it.");
    return { kind: "cli-unavailable" };
  }
  if (trustedExecution && !cli.identity) {
    deps.print("NG: the provider account identity could not be fixed; operation denied.");
    return { kind: "unavailable" };
  }
  if (connection?.cloudflareTarget && (!cli.identity?.startsWith("accounts:") ||
      !cli.identity.slice(9).split(",").includes(connection.cloudflareTarget.accountId))) return { kind: "unavailable" };

  let identity: DestinationIdentity | undefined;
  let trustState: DestinationTrustState | undefined;

  // CLI readiness probes can touch provider auth state. Freeze the state that
  // will actually be displayed, trusted, and executed only after those probes
  // finish. A CLI switch during the probe is never silently adopted.
  if (trustedExecution && snapshotRequest) {
    snapshotRequest = Object.freeze({
      ...snapshotRequest,
      providerIdentity: cli.identity ?? null
    });
    const refreshed = buildTrustedExecution(snapshotRequest, plan, {
      pathOverride: deps.pathOverride,
      projectDir
    });
    if (!refreshed.ok ||
        !isSameResolvedCli(trustedExecution.resolvedCli, refreshed.execution.resolvedCli)) {
      deps.print("NG: the trusted deploy state changed during inspection; operation denied.");
      return { kind: "changed" };
    }
    if (connection) {
      // Auth probes may refresh auth metadata, but may not replace the destination,
      // CLI, environment or process identity which was selected before the await.
      const stable = (execution: TrustedExecution) => JSON.stringify({ ...execution.snapshot,
        providerAuthFiles: [], providerIdentity: null, destinationLabel: null });
      if (stable(trustedExecution) !== stable(refreshed.execution)) return { kind: "changed" };
    }
    trustedExecution = refreshed.execution;

    const resolved = destinationIdentity(trustedExecution.snapshot, cli.identity ?? null);
    if (!resolved) {
      deps.print("NG: the deploy destination could not be identified; operation denied.");
      return { kind: "unavailable" };
    }
    identity = resolved;

    if (automaticClass) {
      try {
        trustState = await readDestinationTrust(deps.vault, identity);
      } catch {
        deps.print("NG: the destination trust record could not be read; operation denied.");
        return { kind: "unavailable" };
      }
      // A first use or a changed destination is never automatic. It falls back
      // to the same Phase C Human Plane approval used by high-risk operations.
      if (trustState !== "trusted") {
        requiresHuman = true;
      }
    }
  }

  if (connection && !await connection.current()) return { kind: "changed" };
  deps.print("Deploy plan:");
  deps.print(`  secret : ${request.name} (${request.scope} scope)`);
  deps.print(`  target : ${deps.adapter.id} (${deps.adapter.cliCommand})`);
  deps.print(`  env    : ${request.env}`);
  deps.print(`  command: ${plan.argv.join(" ")}`);
  if (deps.adapter.id === "cloudflare" && !connection?.preparation) {
    deps.print("  effect : wrangler secret put creates a Worker version and deploys it immediately.");
  }
  if (plan.overwriteWarning) {
    deps.print("  note   : this may overwrite an existing value on the platform.");
  }
  if (trustState === "trusted") {
    deps.print("  trust  : this destination was confirmed by a human before.");
  } else if (trustState === "changed") {
    deps.print("  trust  : this destination changed since the last confirmation; approval required.");
  } else if (trustState === "unconfirmed") {
    deps.print("  trust  : first use of this destination; approval required.");
  }

  if (request.dryRun) {
    return { kind: "dry-run" };
  }

  if (!trustedExecution || !snapshotRequest || !identity) {
    deps.print("Aborted: the deploy destination is not bound; no deployment was performed.");
    return { kind: "unavailable" };
  }

  const boundExecution = trustedExecution;
  const boundRequest = snapshotRequest;
  let history: DeploymentHistory | undefined;
  let attemptId: string | null = null;
  const verify = async (): Promise<boolean> => {
    try {
      if (connection && (!await connection.current() || !matchesTrustedExecution(boundRequest, plan, boundExecution))) return false;
      const currentProvider = await deps.adapter.checkCli({
        cwd: boundExecution.cwd,
        env: boundExecution.env,
        resolvedCli: boundExecution.resolvedCli,
        pathOverride: deps.pathOverride
      });
      if (!currentProvider.installed || !currentProvider.loggedIn ||
          currentProvider.identity !== boundExecution.snapshot.providerIdentity) {
        return false;
      }
      // Run snapshot matching after the provider probe so any auth-file
      // refresh performed by that probe is also detected before spawn.
      if (connection && !await connection.current()) return false;
      if (connection && attemptId) {
        const stored = history?.read();
        if (stored?.status !== "available" || !stored.entries.some((entry) => entry.id === attemptId &&
            entry.finishedAt === null && entry.outcome === "unknown" && entry.name === connection.ref.name &&
            entry.scope === "project" && entry.target === boundRequest.adapterId && entry.env === connection.ref.environment &&
            entry.destinationId === identity.fingerprint && entry.force === request.force &&
            entry.connection?.credentialVersion === 2 && entry.connection.service === connection.ref.service &&
            entry.connection.environment === connection.ref.environment && entry.connection.projectId === connection.ref.projectId &&
            entry.connection.credentialRevision === connection.revision && entry.connection.intentFingerprint === connection.intentFingerprint &&
            (!connection.cloudflareTarget || JSON.stringify(entry.cloudflareTarget) === JSON.stringify(connection.cloudflareTarget)) &&
            (!connection.preparation || JSON.stringify(entry.preparation?.destination)===JSON.stringify(connection.preparationDestination)))) return false;
      }
      return matchesTrustedExecution(boundRequest, plan, boundExecution);
    } catch {
      return false;
    }
  };

  if (connection && !await verify()) return { kind: "changed" };
  if (requiresHuman) {
    if (!deps.humanPlane || deps.humanPlane.capability() !== "os-dialog") {
      deps.print("Aborted: Agent-independent Human Plane is unavailable; no deployment was performed.");
      deps.print(`  This decision needs ${humanPlaneRequirement()}.`);
      return { kind: "unavailable" };
    }

    let approval: Awaited<ReturnType<HumanPlane["askApproval"]>>;
    try {
      const approvalPlan = makeApprovalPlan(boundRequest, plan, boundExecution, approvalTrustState(automaticClass, trustState));
      approval = await deps.humanPlane.askApproval(connection ? Object.freeze({ ...approvalPlan,
        connectionSource: Object.freeze({ credentialVersion: 2 as const, service: connection.ref.service,
          environment: connection.ref.environment, credentialRevision: connection.revision,
          ...(connection.preparation ? {operation:"cloudflare-version-preparation" as const} : {}) }) }) : approvalPlan);
    } catch {
      deps.print("Aborted: Human Plane approval failed; no deployment was performed.");
      deps.print(`  This decision needs ${humanPlaneRequirement()}.`);
      return { kind: "unavailable" };
    }
    if (approval === "declined") {
      deps.print("Aborted: high-risk operation was declined.");
      return { kind: "declined" };
    }
    if (approval !== "approved") {
      deps.print("Aborted: Human Plane is unavailable; no deployment was performed.");
      deps.print(`  This decision needs ${humanPlaneRequirement()}.`);
      return { kind: "unavailable" };
    }

    if (!(await verify())) {
      deps.print("Aborted: the approved operation changed before execution.");
      return { kind: "changed" };
    }
  }

  // Persist an unknown attempt before any destructive pre-step or value read.
  // History never feeds the entitlement, approval, trust, or execution checks.
  let startIssue: HistoryIssue = "io-error";
  try {
    history = new DeploymentHistory(connection?.metadataDir ?? projectDir, deps.historyBaseDir);
    attemptId = connection ? (connection.preparation ? history.beginClerkPreparation.bind(history) : history.beginConnection.bind(history))({ ref: connection.ref, target: deps.adapter.id,
      destinationId: identity.fingerprint, force: request.force, credentialRevision: connection.revision,
      intentFingerprint: connection.intentFingerprint,
      ...(connection.cloudflareTarget ? { cloudflareTarget: connection.cloudflareTarget } : {}),
      ...(connection.preparation?{preparationDestination:connection.preparationDestination}:{}) }) : history.begin({
      name: ref.name, scope: ref.scope, target: deps.adapter.id, env: request.env,
      destinationId: identity.fingerprint, force: request.force
    });
    startIssue = history.writeIssue ?? "io-error";
  } catch (error) { startIssue = historyIssueFromError(error); }
  if (!history || !attemptId) {
    const diagnostic = historyDiagnostic("start", startIssue);
    deps.print("NG: deployment history could not be started; no provider write was attempted.");
    deps.print("This applies to this invocation only; earlier or concurrent operations are not assessed.");
    deps.print(renderHistoryDiagnostic(diagnostic));
    return { kind: "history-unavailable", historyDiagnostic: diagnostic };
  }

  let handoff: HandoffResult;
  try {
    if (connection) {
      if(connection.preparation){
        const prepared=await runClerkVersionPreparation({ref:connection.ref,execution:boundExecution,stillCurrent:verify,signal:connection.signal});
        handoff={exitCode:prepared.status==="prepared"?0:null,stdoutRedacted:"",stderrRedacted:"",timedOut:false,
          ...(prepared.versionId?{preparedVersionId:prepared.versionId}:{}),preparationTermination:prepared.termination,
          ...(prepared.status==="changed"?{blocked:"changed" as const}:{})};
      }else{
        const status = await runConnectionDeployment({ ref: connection.ref, target: deps.adapter.id,
          force: request.force, execution: boundExecution, stillCurrent: verify });
        handoff = { exitCode: status === "completed" ? 0 : status === "incomplete" ? 1 : null,
          stdoutRedacted: "", stderrRedacted: "", timedOut: false,
          ...(status === "changed" ? { blocked: "changed" as const } : {}) };
      }
      if (!await verify()) handoff = { ...handoff, exitCode: null, blocked: "changed" };
    } else handoff = await runWithSecret(deps.vault, ref, plan, {
      cwd: boundExecution.cwd,
      env: boundExecution.env,
      resolvedCli: boundExecution.resolvedCli,
      suppressOutput: requiresHuman,
      beforeSecretRead: verify,
      beforeSpawn: verify
    });
  } catch (error) {
    if (connection) {
      const saved = history.finish(attemptId, "unknown");
      return { kind: "executed", handoff: { exitCode: null, stdoutRedacted: "", stderrRedacted: "", timedOut: false },
        historySaved: saved, ...(!saved ? { historyDiagnostic: historyDiagnostic("result", history.writeIssue ?? "io-error") } : {}) };
    }
    if (history.finish(attemptId, "unknown")) {
      deps.print(
        "Warning: the deployment result is unknown; provider changes may already exist. " +
          "Inspect history before deciding the next step with the human; do not retry automatically."
      );
    } else {
      deps.print("Warning: the operation outcome is unknown and its result could not be saved; provider changes may already exist.");
      deps.print(renderHistoryDiagnostic(historyDiagnostic("result", history.writeIssue ?? "io-error")));
    }
    throw error;
  }
  if (connection && requiresHuman && automaticClass && !handoff.blocked) {
    try { await recordDestinationTrust(deps.vault, identity); } catch { /* next call asks again */ }
    if (!await verify()) handoff = { ...handoff, exitCode: null, blocked: "changed" };
  }
  const historyOutcome = handoff.blocked ? (connection ? "unknown" : "incomplete") : handoff.timedOut || handoff.exitCode === null ? "unknown"
      : handoff.exitCode === 0 ? "completed" : "incomplete";
  const historySaved = connection?.preparation ? history.finishClerkPreparation(attemptId,historyOutcome,
    historyOutcome==="completed"?handoff.preparedVersionId??null:null) : history.finish(attemptId,historyOutcome);
  const diagnostic = historySaved ? undefined : historyDiagnostic("result", history.writeIssue ?? "io-error");
  if (!historySaved) {
    deps.print("Warning: the operation result could not be saved to history. History cannot confirm this result; do not retry automatically.");
    deps.print("Keep the observed operation result separate from this history failure; provider changes may already exist.");
    deps.print(renderHistoryDiagnostic(diagnostic!));
  }
  if (handoff.blocked === "changed") {
    deps.print("Aborted: the bound deploy operation changed during handoff; provider changes may already exist.");
    return { kind: "changed", ...(connection ? { placementEffects: "possible" as const, historySaved,...(handoff.preparationTermination?{preparationTermination:handoff.preparationTermination}:{}) } : {}), ...(diagnostic ? { historyDiagnostic: diagnostic } : {}) };
  }

  // The human just confirmed this exact destination for an operation class
  // that may repeat automatically. Remember the destination identity only:
  // never the operation, the Secret, or anything reusable as an approval.
  if (!connection && requiresHuman && automaticClass) {
    try {
      await recordDestinationTrust(deps.vault, identity);
    } catch {
      deps.print("Warning: this destination could not be remembered; the next deploy will ask again.");
    }
  }

  return { kind: "executed", handoff, historySaved, ...(diagnostic ? { historyDiagnostic: diagnostic } : {}) };
}

function approvalTrustState(
  automaticClass: boolean,
  trustState: DestinationTrustState | undefined
): ApprovalTrustState {
  if (!automaticClass) return "always-approve";
  return trustState === "changed" ? "changed" : "first-use";
}

function isClosedPlan(
  plan: { argv: string[]; valueVia: string; preSteps?: { argv: string[]; valueVia: string }[] },
  cliCommand: string
): boolean {
  if (!plan || !Array.isArray(plan.argv) || typeof cliCommand !== "string") return false;
  if (plan.valueVia !== "stdin" || plan.argv.length < 1 || plan.argv[0] !== cliCommand) return false;
  if (plan.argv.some((token) => !isSafePlanToken(token))) return false;
  if (plan.preSteps !== undefined && !Array.isArray(plan.preSteps)) return false;
  for (const step of plan.preSteps ?? []) {
    if (!step || !Array.isArray(step.argv)) return false;
    if (step.argv.length < 1 || step.argv[0] !== cliCommand) return false;
    if (step.valueVia !== "stdin" || step.argv.some((token) => !isSafePlanToken(token))) return false;
  }
  return true;
}

function sealDeployPlan(plan: DeployPlan, cliCommand: string): DeployPlan | null {
  if (!isClosedPlan(plan, cliCommand)) return null;

  const seal = (source: DeployPlan): DeployPlan => {
    const argv = [...source.argv];
    Object.freeze(argv);
    const preSteps = source.preSteps?.map(seal);
    if (preSteps) Object.freeze(preSteps);
    return Object.freeze({
      argv,
      valueVia: "stdin" as const,
      displayCommand: argv.join(" "),
      overwriteWarning: source.overwriteWarning === true,
      ...(preSteps ? { preSteps } : {})
    });
  };

  return seal(plan);
}

function isSafePlanToken(token: unknown): token is string {
  if (typeof token !== "string" || /[\r\n\0]/.test(token)) return false;
  if (process.platform === "win32" && /[&|<>^%!"]/u.test(token)) return false;
  return true;
}

export interface TargetStatus {
  id: TargetId;
  detected: boolean;
  detectReason: string;
  cliInstalled: boolean;
  cliVersion?: string;
  loggedIn: boolean;
  hint?: string;
}

export async function inspectTargets(
  projectDir: string,
  adapters: Iterable<DeployTarget>
): Promise<TargetStatus[]> {
  const results: TargetStatus[] = [];
  for (const adapter of adapters) {
    const detect = await adapter.detect(projectDir);
    const cli = await adapter.checkCli();
    results.push({
      id: adapter.id,
      detected: detect.detected,
      detectReason: detect.reason,
      cliInstalled: cli.installed,
      cliVersion: cli.version,
      loggedIn: cli.loggedIn,
      hint: cli.hint
    });
  }
  return results;
}
