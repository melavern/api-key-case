import { assertValidSecretName, type SecretRef, type SecretScope, type Vault } from "../vault/types.js";
import { runWithSecret, type HandoffResult } from "./handoff.js";
import {
  DeploymentHistory, historyDiagnostic, historyIssueFromError, renderHistoryDiagnostic,
  type HistoryDiagnostic, type HistoryIssue
} from "./history.js";
import {
  buildTrustedExecution,
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
  | { kind: "changed"; historyDiagnostic?: HistoryDiagnostic }
  | { kind: "history-unavailable"; historyDiagnostic: HistoryDiagnostic }
  | { kind: "executed"; handoff: HandoffResult; historySaved: boolean; historyDiagnostic?: HistoryDiagnostic };

export async function runDeploy(deps: EngineDeps, request: DeployRequest): Promise<DeployResult> {
  assertValidSecretName(request.name);

  let projectDir: string;
  try {
    projectDir = realpathSync.native(request.projectDir);
    if (!statSync(projectDir).isDirectory()) return { kind: "unavailable" };
  } catch {
    deps.print("NG: the project directory is unavailable.");
    return { kind: "unavailable" };
  }

  const ref: SecretRef = { name: request.name, scope: request.scope, projectId: request.projectId };

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

  // Phase D denies by default: an operation may skip the Human Plane only if
  // its class is on the closed automatic-safe allowlist AND (checked below)
  // its destination identity was already confirmed by a human on this machine.
  // Everything else keeps the Phase C approval boundary unchanged.
  const automaticClass = isAutomaticSafeOperation({
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
  if (!(requiresHuman && deps.adapter.id === "github")) {
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
      if (request.projectId !== deriveProjectId(projectDir)) {
        deps.print("NG: the project identity changed; deploy was aborted.");
        return { kind: "changed" };
      }
    } catch {
      return { kind: "unavailable" };
    }
  }

  const hasSecret = await deps.vault.hasSecret(ref);
  if (!hasSecret) {
    const fallback =
      request.scope === "project" ? " Try --scope user or" : "";
    deps.print(
      `NG: ${request.name} is not registered in ${request.scope} scope.${fallback} Run: api-key-case save ${request.name}`
    );
    return { kind: "missing-secret" };
  }

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
      providerIdentity: null
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

  deps.print("Deploy plan:");
  deps.print(`  secret : ${request.name} (${request.scope} scope)`);
  deps.print(`  target : ${deps.adapter.id} (${deps.adapter.cliCommand})`);
  deps.print(`  env    : ${request.env}`);
  deps.print(`  command: ${plan.argv.join(" ")}`);
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
  const verify = async (): Promise<boolean> => {
    try {
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
      return matchesTrustedExecution(boundRequest, plan, boundExecution);
    } catch {
      return false;
    }
  };

  if (requiresHuman) {
    if (!deps.humanPlane || deps.humanPlane.capability() !== "os-dialog") {
      deps.print("Aborted: Agent-independent Human Plane is unavailable; no deployment was performed.");
      deps.print(`  This decision needs ${humanPlaneRequirement()}.`);
      return { kind: "unavailable" };
    }

    let approval: Awaited<ReturnType<HumanPlane["askApproval"]>>;
    try {
      approval = await deps.humanPlane.askApproval(
        makeApprovalPlan(boundRequest, plan, boundExecution, approvalTrustState(automaticClass, trustState))
      );
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
  let history: DeploymentHistory | undefined;
  let attemptId: string | null = null;
  let startIssue: HistoryIssue = "io-error";
  try {
    history = new DeploymentHistory(projectDir, deps.historyBaseDir);
    attemptId = history.begin({
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
    handoff = await runWithSecret(deps.vault, ref, plan, {
      cwd: boundExecution.cwd,
      env: boundExecution.env,
      resolvedCli: boundExecution.resolvedCli,
      suppressOutput: requiresHuman,
      beforeSecretRead: verify,
      beforeSpawn: verify
    });
  } catch (error) {
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
  const historySaved = history.finish(attemptId,
    handoff.blocked ? "incomplete" : handoff.timedOut || handoff.exitCode === null ? "unknown"
      : handoff.exitCode === 0 ? "completed" : "incomplete");
  const diagnostic = historySaved ? undefined : historyDiagnostic("result", history.writeIssue ?? "io-error");
  if (!historySaved) {
    deps.print("Warning: the operation result could not be saved to history. History cannot confirm this result; do not retry automatically.");
    deps.print("Keep the observed operation result separate from this history failure; provider changes may already exist.");
    deps.print(renderHistoryDiagnostic(diagnostic!));
  }
  if (handoff.blocked === "changed") {
    deps.print("Aborted: the bound deploy operation changed during handoff; provider changes may already exist.");
    return { kind: "changed", ...(diagnostic ? { historyDiagnostic: diagnostic } : {}) };
  }

  // The human just confirmed this exact destination for an operation class
  // that may repeat automatically. Remember the destination identity only:
  // never the operation, the Secret, or anything reusable as an approval.
  if (requiresHuman && automaticClass) {
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
