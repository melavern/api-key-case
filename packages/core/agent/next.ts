import { DEPLOY_ENVS, type DeployEnv, type DeployTarget, type TargetId } from "../deploy/types.js";
import { inspectTargets } from "../deploy/engine.js";
import {
  AUTOMATIC_SAFE_ENVS,
  inspectDestinationTrust,
  type DestinationTrustStatus
} from "../deploy/destination.js";
import { listIndexedProjectSecretNames } from "../lifecycle.js";
import { scanProject } from "../scanner.js";
import {
  inspectHostReadiness, inspectTargetReadiness,
  type HostReadiness, type EnvironmentReadiness
} from "./readiness.js";
import {
  assertValidSecretName,
  deriveProjectId,
  SecretNameError,
  type SecretScope,
  type Vault
} from "../vault/index.js";

/**
 * `unused`: the current scanner found no reference to this registered project
 * Secret. Unsupported syntax and manual use remain possible, so it is only a
 * Phase E cleanup candidate and never a deletion decision.
 */
export type NextSecretStatus =
  | "registered"
  | "missing"
  | "unavailable"
  | "unsupported"
  | "unused";
export type NextCliStatus = "ready" | "missing" | "unauthenticated" | "unverified";
/** `not-applicable`: this target has no automatic-safe environment at all. */
export type NextDestinationTrust = DestinationTrustStatus | "not-applicable";

export type NextAction =
  | { actor: "agent"; kind: "fix-gitignore" }
  | { actor: "human"; kind: "review-possible-exposure" }
  | { actor: "human"; kind: "enable-vault" }
  | { actor: "agent"; kind: "review-secret-name"; name: string }
  | { actor: "human"; kind: "register-secret"; name: string; scope: "project" }
  | { actor: "agent"; kind: "install-target-cli"; target: TargetId }
  | { actor: "agent"; kind: "review-deploy-setup"; target: TargetId }
  | { actor: "human"; kind: "authenticate-target-cli"; target: TargetId }
  | { actor: "human"; kind: "approve-deploy-destination"; target: TargetId; env: DeployEnv }
  // Phase E lifecycle. Both are destructive or security-state changes, so both
  // stay `actor: human`: an Agent may request the Human Plane for them and can
  // never complete them.
  | { actor: "human"; kind: "remove-secret"; name: string; scope: "project" }
  | { actor: "human"; kind: "forget-deploy-destination"; target: TargetId; env: DeployEnv };

export interface NextReport {
  schemaVersion: 2;
  host: HostReadiness;
  setup: {
    stage: "review-exposure" | "prepare-storage" | "review-secret-names" |
      "register-secrets" | "human-handoff" | "review-deployment" | "no-required-secrets";
    counts: { required: number; registered: number; missing: number; unavailable: number; unsupported: number; cleanupCandidates: number };
    deploymentState: "not-inspected";
  };
  vault: { status: "available" | "unavailable" };
  license: { plan: "free" | "pro" };
  hygiene: { gitignoreOk: boolean; possibleExposure: boolean };
  secrets: Array<{
    name: string;
    scope: SecretScope | null;
    status: NextSecretStatus;
  }>;
  targets: Array<{
    id: TargetId;
    detected: boolean;
    cliStatus: NextCliStatus;
    readiness: EnvironmentReadiness[];
    /**
     * Phase D deploy policy for this target, as semantic state rather than a
     * command. `automatic` lists the environments an Agent may deploy to right
     * now without any human interaction; every other environment is in
     * `humanApproval`. The two lists always partition the closed environment
     * enum.
     */
    deployment: {
      automatic: DeployEnv[];
      humanApproval: DeployEnv[];
      destinationTrust: NextDestinationTrust;
    };
  }>;
  nextActions: NextAction[];
}

export interface NextReportDeps {
  vault: Vault;
  adapters: Iterable<DeployTarget>;
  licensePlan: "free" | "pro";
  registryBaseDir?: string; // test-only; threaded through to the vault index
  hostReadiness?: HostReadiness; // test-only; never supplied by the CLI
  inspectReadiness?: typeof inspectTargetReadiness; // test-only
}

export async function buildNextReport(
  targetDir: string,
  deps: NextReportDeps
): Promise<NextReport> {
  const scan = scanProject({ targetDir });
  const adapters = [...deps.adapters];
  const targetStatuses = [];
  for (const adapter of adapters) {
    try {
      const [status] = await inspectTargets(targetDir, [adapter]);
      targetStatuses.push({ ...status, inspectionFailed: false });
    } catch {
      // Provider failures must not erase the other targets or leak their output.
      targetStatuses.push({
        id: adapter.id, detected: false, cliInstalled: false, loggedIn: false,
        inspectionFailed: true
      });
    }
  }
  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const host = deps.hostReadiness ?? inspectHostReadiness();

  let vaultAvailable = false;
  try {
    vaultAvailable = await deps.vault.isAvailable();
  } catch {
    vaultAvailable = false;
  }

  const projectId = deriveProjectId(targetDir);
  const secrets: NextReport["secrets"] = [];

  for (const name of scan.requiredSecrets) {
    try {
      assertValidSecretName(name);
    } catch (error) {
      if (error instanceof SecretNameError) {
        secrets.push({ name, scope: null, status: "unsupported" });
        continue;
      }
      throw error;
    }

    if (!vaultAvailable) {
      secrets.push({ name, scope: null, status: "unavailable" });
      continue;
    }

    try {
      if (await deps.vault.hasSecret({ name, scope: "project", projectId })) {
        secrets.push({ name, scope: "project", status: "registered" });
      } else if (await deps.vault.hasSecret({ name, scope: "user", projectId: null })) {
        secrets.push({ name, scope: "user", status: "registered" });
      } else {
        secrets.push({ name, scope: "project", status: "missing" });
      }
    } catch {
      vaultAvailable = false;
      secrets.push({ name, scope: null, status: "unavailable" });
    }
  }

  if (!vaultAvailable) {
    for (const secret of secrets) {
      if (secret.status === "unsupported") continue;
      secret.scope = null;
      secret.status = "unavailable";
    }
  }

  // Phase E cleanup candidates: still in this project's scope of the OS secret
  // store, but no longer referenced by the project. The index only supplies
  // candidate names; the store decides whether an entry actually exists.
  if (vaultAvailable) {
    const required = new Set(scan.requiredSecrets);
    for (const name of listIndexedProjectSecretNames(projectId, deps.registryBaseDir)) {
      if (required.has(name)) continue;
      try {
        if (await deps.vault.hasSecret({ name, scope: "project", projectId })) {
          secrets.push({ name, scope: "project", status: "unused" });
        }
      } catch {
        // A store that stops answering is reported by the required-secret pass
        // above; a cleanup hint is never worth failing this report over.
        break;
      }
    }
  }

  const gitignoreOk =
    scan.gitignore.hasGitignore &&
    scan.gitignore.ignoresDotEnv &&
    scan.gitignore.ignoresDotEnvVariants &&
    scan.envFiles.every((file) => file.ignored);
  const possibleExposure =
    scan.secretFindings.length > 0 ||
    scan.envFiles.some((file) => file.tracked || file.seenInHistory);

  const targets: NextReport["targets"] = [];
  for (const target of targetStatuses) {
    const cliStatus: NextCliStatus = target.inspectionFailed ? "unverified" : !target.cliInstalled
      ? "missing"
      : target.loggedIn
        ? "ready"
        : "unauthenticated";

    // The allowlist currently holds at most one automatic-safe environment per
    // target. Extend this shape before adding a second one.
    const automaticEnvs = AUTOMATIC_SAFE_ENVS[target.id] ?? [];
    const adapter = adapterById.get(target.id);
    const readiness: EnvironmentReadiness[] = target.inspectionFailed ? DEPLOY_ENVS.map((env) => ({
      env, status: "blocked", issues: ["inspection-failed"],
      unverified: ["human-interaction", "provider-write-permission"]
    })) : await (deps.inspectReadiness ?? inspectTargetReadiness)({
      adapter: adapter!, projectDir: targetDir, detected: target.detected,
      vaultAvailable, host
    });
    let destinationTrust: NextDestinationTrust =
      automaticEnvs.length === 0 ? "not-applicable" : "unresolved";
    let automatic: DeployEnv[] = [];

    // Resolving a destination costs provider CLI calls, so only do it when an
    // automatic deploy could actually happen. This is status only: it can read
    // a trust record but never create or change one, and the deploy engine
    // re-resolves everything itself before it executes anything.
    if (
      automaticEnvs.length > 0 &&
      adapter &&
      vaultAvailable &&
      deps.licensePlan === "pro" &&
      target.detected &&
      cliStatus === "ready" &&
      readiness.some((entry) => automaticEnvs.includes(entry.env) && entry.status === "prerequisites-checked")
    ) {
      destinationTrust = await inspectDestinationTrust({
        vault: deps.vault,
        adapter,
        projectDir: targetDir,
        env: automaticEnvs[0]
      });
      if (destinationTrust === "trusted") {
        automatic = [...automaticEnvs];
      }
    }

    targets.push({
      id: target.id,
      detected: target.detected,
      cliStatus,
      readiness,
      deployment: {
        automatic,
        humanApproval: DEPLOY_ENVS.filter((env) => !automatic.includes(env)),
        destinationTrust
      }
    });
  }

  const nextActions: NextAction[] = [];
  if (!gitignoreOk) {
    nextActions.push({ actor: "agent", kind: "fix-gitignore" });
  }
  if (possibleExposure) {
    nextActions.push({ actor: "human", kind: "review-possible-exposure" });
  }
  if (!vaultAvailable) {
    nextActions.push({ actor: "human", kind: "enable-vault" });
  }
  for (const secret of secrets) {
    if (secret.status === "unsupported") {
      nextActions.push({ actor: "agent", kind: "review-secret-name", name: secret.name });
    } else if (vaultAvailable) {
      if (secret.status === "missing") {
        nextActions.push({
          actor: "human",
          kind: "register-secret",
          name: secret.name,
          scope: "project"
        });
      } else if (secret.status === "unused") {
        // A candidate, not a decision. Only a human can complete it.
        nextActions.push({
          actor: "human",
          kind: "remove-secret",
          name: secret.name,
          scope: "project"
        });
      }
    }
  }
  for (const target of targets) {
    if (!target.detected) {
      if (target.cliStatus === "unverified") {
        nextActions.push({ actor: "agent", kind: "review-deploy-setup", target: target.id });
      }
      continue;
    }
    if (target.cliStatus === "missing") {
      nextActions.push({ actor: "agent", kind: "install-target-cli", target: target.id });
    } else if (target.cliStatus === "unauthenticated" || target.readiness.some((entry) => entry.issues.includes("provider-login-required"))) {
      nextActions.push({ actor: "human", kind: "authenticate-target-cli", target: target.id });
    }
    if (target.readiness.some((entry) => entry.issues.some((issue) =>
      ["unsafe-deploy-context", "trusted-cli-unavailable", "provider-identity-unverified", "project-unavailable", "context-changed", "inspection-failed"].includes(issue)
    ))) {
      nextActions.push({ actor: "agent", kind: "review-deploy-setup", target: target.id });
    }
    // A destination becomes reusable only after a human confirms it once, in
    // the Human Plane, during a real deploy. The Agent relays this like any
    // other human action; it can never satisfy it itself.
    if (
      target.deployment.destinationTrust === "unconfirmed" ||
      target.deployment.destinationTrust === "changed"
    ) {
      for (const env of AUTOMATIC_SAFE_ENVS[target.id] ?? []) {
        nextActions.push({
          actor: "human",
          kind: "approve-deploy-destination",
          target: target.id,
          env
        });
        // A destination that changed leaves a confirmation for a destination
        // this project no longer uses. Cleaning it up is the other half of the
        // same human decision, never an automatic one.
        if (target.deployment.destinationTrust === "changed") {
          nextActions.push({
            actor: "human",
            kind: "forget-deploy-destination",
            target: target.id,
            env
          });
        }
      }
    }
  }

  const count = (status: NextSecretStatus) => secrets.filter((secret) => secret.status === status).length;
  const counts = {
    required: secrets.filter((secret) => secret.status !== "unused").length,
    registered: count("registered"), missing: count("missing"), unavailable: count("unavailable"),
    unsupported: count("unsupported"), cleanupCandidates: count("unused")
  };
  const stage: NextReport["setup"]["stage"] = possibleExposure ? "review-exposure"
    : !vaultAvailable ? "prepare-storage"
      : counts.unsupported > 0 ? "review-secret-names"
        : counts.missing > 0 ? (host.secretInput === "unavailable" ? "human-handoff" : "register-secrets")
          : counts.required === 0 ? "no-required-secrets" : "review-deployment";

  return {
    schemaVersion: 2,
    host,
    setup: { stage, counts, deploymentState: "not-inspected" },
    vault: { status: vaultAvailable ? "available" : "unavailable" },
    license: { plan: deps.licensePlan },
    hygiene: { gitignoreOk, possibleExposure },
    secrets,
    targets,
    nextActions
  };
}
