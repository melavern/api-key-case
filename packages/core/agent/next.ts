import { readLocalApplicationStatus } from "../local/session.js";
import { projectLocalDevelopment, readLocalPreparationReview, type LocalDevelopmentReport, type LocalDevelopmentStep } from "./local-development.js";
import { readClerkManagedReport, type ClerkManagedReport } from "./clerk-managed-report.js";
import { CLERK_NATIVE_SETTINGS, readClerkNativeReport, type ClerkNativeReport } from "./clerk-native.js";
import { readNativeApplicationEvidence, type NativeApplicationEvidence } from "./native-observations.js";
import { buildConnectionPlan, type ConnectionPlan, type ConnectionPlanDeps, type ApplicationObservationReason, type ConnectionRecovery } from "./connection-plan.js";
import { connectionCredentialRef, credentialEnvironments, credentialRefForService } from "./connection-credential.js";
import { DEPLOY_ENVS, type DeployEnv, type DeployTarget, type TargetId } from "../deploy/types.js";
import { inspectTargets } from "../deploy/engine.js";
import { DeploymentHistory } from "../deploy/history.js";
import {
  AUTOMATIC_SAFE_ENVS,
  inspectDestinationTrust,
  type DestinationTrustStatus
} from "../deploy/destination.js";
import { listIndexedProjectSecretNames } from "../lifecycle.js";
import { scanProject } from "../scanner.js";
import {
  ConnectionStateStore,
  type ConnectionIntent,
  type ConnectionEnvironment,
  type ConnectionObservation,
  type ConnectionObservationKind
} from "./connection-state.js";
import { connectionCredentialFingerprint, connectionIntentFingerprint, resendSourceFingerprint } from "./fingerprints.js";
import { RESEND_VERIFIER_VERSION } from "./resend-doctor.js";
import { buildResendGuidedSetup, supportsResendCredentialGuide, type ResendGuidedSetup } from "./guided-setup.js";
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
export type ConnectionStage = "choose-route" | "acquire-credential" | "configure-destination" |
  "verify-provider" | "verify-application" | "ready" | "blocked" | "unknown";

export interface ConnectionReport {
  nativeApplicationObservation?: NativeApplicationEvidence;
  service: "resend";
  environment: "development" | "preview" | "production";
  route: "provider-native" | "api-key-case-managed" | "manual";
  credential: {
    source: "api-key-case" | "provider-native" | "legacy-unscoped" | "unknown";
    status: "missing" | "registered" | "external-unverified" | "unavailable";
  };
  plan: ConnectionPlan;
  destination: {
    authority: "agent-observed" | "none";
    kind: "local" | "vercel" | "cloudflare" | "github" | "manual";
    status: "not-selected" | "prerequisites-checked" | "configured" | "changed" | "unknown";
  };
  providerCheck: {
    status: "not-run" | "passed" | "failed" | "unknown" | "stale" | "not-applicable";
    authority: "provider-observed" | "none";
  };
  applicationCheck: {
    status: "not-run" | "passed" | "failed" | "unknown" | "stale";
    authority: "agent-observed" | "human-reported" | "none";
    reason: ApplicationObservationReason;
  };
  recovery: ConnectionRecovery[];
  stage: ConnectionStage;
}

export type ConnectionReportState =
  | { status: "inactive" | "not-selected"; issue: null; report: null }
  | { status: "unavailable"; issue: "metadata-unavailable"; report: null }
  | { status: "selected"; issue: "history-unavailable" | null; report: ConnectionReport };

export type NextAction =
  | { actor: "agent"; kind: "check-resend-credential" }
  | { actor: "agent"; kind: "review-provider-credential"; service: "openai" | "stripe-test"; environments: ConnectionEnvironment[] }
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
  | { actor: "human"; kind: "forget-deploy-destination"; target: TargetId; env: DeployEnv }
  | { actor: "human"; kind: "register-connection-credential"; service: "resend"; environment: ConnectionEnvironment }
  | { actor: "agent"; kind: "review-connection-route" }
  | { actor: "agent"; kind: "review-clerk-managed"; step: ClerkManagedReport["nextStep"] }
  | { actor: "human"; kind: "complete-provider-native-setup" }
  | { actor: "agent"; kind: "review-destination-setup" }
  | { actor: "agent"; kind: "review-local-development"; step: LocalDevelopmentStep }
  | { actor: "human"; kind: "resolve-unknown-connection"; cause: "metadata-unavailable" | "history-unavailable" };

export interface NextReport {
  schemaVersion: 13;
  /** Present only for the explicitly requested offline variant. Empty targets means skipped. */
  inspection?: { mode: "offline"; provider: "not-inspected"; vaultAvailability: "not-inspected"; gitExposure: "not-inspected"; gitIgnore: "not-inspected" };
  guidedSetup: ResendGuidedSetup | null;
  connection: ConnectionReportState;
  localSession: ReturnType<typeof readLocalApplicationStatus>;
  localDevelopment: LocalDevelopmentReport | null;
  clerkNative: ClerkNativeReport & {applicationObservation:NativeApplicationEvidence};
  clerkManaged: ClerkManagedReport;
  host: HostReadiness;
  setup: {
    stage: "review-exposure" | "prepare-storage" | "review-secret-names" |
      "register-secrets" | "human-handoff" | "review-deployment" | "no-required-secrets";
    counts: { required: number; registered: number; missing: number; unavailable: number; unsupported: number; cleanupCandidates: number };
    deploymentState: "not-inspected";
  };
  vault: { status: "available" | "unavailable" | "not-inspected" };
  license: { plan: "free" | "pro" };
  hygiene: { gitignoreOk: boolean | null; possibleExposure: boolean };
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
  offline?: boolean;
  vault: Vault;
  adapters: Iterable<DeployTarget>;
  licensePlan: "free" | "pro";
  registryBaseDir?: string; // test-only; threaded through to the vault index
  connectionBaseDir?: string; // test-only; threaded through to local connection metadata
  connectionDestinationResolver?: ConnectionPlanDeps["resolveDestination"]; // test-only
  hostReadiness?: HostReadiness; // test-only; never supplied by the CLI
  inspectReadiness?: typeof inspectTargetReadiness; // test-only
}

export async function buildNextReport(
  targetDir: string,
  deps: NextReportDeps
): Promise<NextReport> {
  const offline = deps.offline === true;
  const scan = scanProject({ targetDir, skipGitInspection: offline });
  const clerkNative = {...readClerkNativeReport(targetDir, deps.connectionBaseDir),
    applicationObservation:readNativeApplicationEvidence(targetDir,"clerk",deps.connectionBaseDir)};
  const clerkManaged = await readClerkManagedReport(targetDir, { vault: deps.vault, baseDir: deps.connectionBaseDir });
  const nativeNames = new Set<string>(clerkNative.status !== "inactive" ? CLERK_NATIVE_SETTINGS.map(setting => setting.name) : []);
  // Standalone Clerk registration is not native integration readiness. Prevent
  // generic v1 advice from redirecting either fixed Clerk role into a legacy slot.
  try {
    const clerkStore = new ConnectionStateStore(targetDir, deps.connectionBaseDir);
    if (clerkStore.hasClerkRegistrationRecord() || clerkStore.readClerkManagedIntent().status !== "missing") {
      for (const name of ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"]) nativeNames.add(name);
    }
  } catch { /* no standalone identity established */ }
  // Do not even access adapter dependencies in the offline variant.
  const adapters = offline ? [] : [...deps.adapters];
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

  // Offline presence reads do not establish general store availability.
  let vaultAvailable = offline;
  if (!offline) {
    try { vaultAvailable = await deps.vault.isAvailable(); }
    catch { vaultAvailable = false; }
  }

  const projectId = deriveProjectId(targetDir);
  const secrets: NextReport["secrets"] = [];

  for (const name of scan.requiredSecrets) {
    if (nativeNames.has(name)) continue;
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
      if (!offline) vaultAvailable = false;
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
      if (required.has(name) || nativeNames.has(name)) continue;
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
  const resendCandidate = secrets.some(entry => entry.name === "RESEND_API_KEY" && entry.status !== "unused");

  let guidedSetup: ResendGuidedSetup | null = null;
  let scopedCredentialStatus: ResendGuidedSetup["registration"]["status"] = "unavailable";
  let scopedCredentialRevision: string | null = null;
  let scopedRegistrationSnapshot: string | null = null;
  let localSessionSnapshot: string | null = null;
  let localPreparationSnapshot: string | null = null;
  let credentialInputSupported = false;
  let connection: ConnectionReportState = { status: "inactive", issue: null, report: null };
  let connectionIntent: ConnectionIntent | null = null;
  let connectionObservations: ConnectionObservation[] = [];
  let observationsUnavailable = false;
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

  // Read and recheck the connection only after the final asynchronous target
  // diagnostic; guidance below must not reuse a pre-readiness selection/slot.
  {
    try {
      const connectionStore = new ConnectionStateStore(targetDir, deps.connectionBaseDir);
      const savedIntent = connectionStore.readIntent();
      if (savedIntent.status === "missing") {
        connection = { status: resendCandidate ? "not-selected" : "inactive", issue: null, report: null };
      } else if (savedIntent.status === "unavailable") {
        connection = { status: "unavailable", issue: "metadata-unavailable", report: null };
        guidedSetup = null;
      } else {
        connectionIntent = savedIntent.value;
        if (connectionIntent.destination.kind === "local") {
          localSessionSnapshot = JSON.stringify(readLocalApplicationStatus(targetDir, deps.connectionBaseDir));
          localPreparationSnapshot = JSON.stringify(connectionStore.readLocalPreparation());
        }
        const observations = connectionStore.readObservations();
        observationsUnavailable = observations.status === "unavailable";
        connectionObservations = observations.status === "available" ? observations.value : [];
        const secret = secrets.find((entry) => entry.name === "RESEND_API_KEY" && entry.status !== "unused");
        const exactRef = connectionCredentialRef(targetDir, connectionIntent.environment);
        let scopedStatus: NextSecretStatus = "unavailable";
        const beforeRegistration = connectionIntent.route === "api-key-case-managed"
          ? connectionStore.readCredentialRegistration(exactRef) : null;
        if (connectionIntent.route === "api-key-case-managed" && vaultAvailable &&
            beforeRegistration?.status !== "unavailable" && beforeRegistration?.value?.state !== "pending") {
          try { scopedStatus = await deps.vault.hasSecret(exactRef) ? "registered" : "missing"; }
          catch { scopedStatus = "unavailable"; }
        }
        const credentialRevision = scopedStatus === "registered" ? connectionStore.credentialRevision(exactRef) : null;
        const sourceFingerprint = resendSourceFingerprint(scan);
        const intentFingerprint = connectionIntentFingerprint(connectionIntent);
        // A pending/unreadable registration cannot be diagnosed as absent by a
        // second bare presence read in the generic plan.
        const uncertainVault = new Proxy(deps.vault, { get(target, property) {
          return property === "hasSecret" ? async () => { throw new Error("Credential inspection unavailable"); }
            : Reflect.get(target, property);
        } });
        const inspectPlan = () => buildConnectionPlan(targetDir, connectionIntent!.environment, {
          vault: connectionIntent!.route === "api-key-case-managed" && scopedStatus === "unavailable" ? uncertainVault : deps.vault,
          connectionBaseDir: deps.connectionBaseDir, resolveDestination: offline ? undefined : deps.connectionDestinationResolver });
        let plan = await inspectPlan();
        // The plan's own presence read must agree with the selected-slot read.
        // A transient failure or contradiction cannot become missing input
        // guidance merely because a later read returns the original result.
        if (connectionIntent.route === "api-key-case-managed" &&
            (plan.reason === "credential-unavailable" ||
              (plan.reason === "credential-missing" && scopedStatus === "registered") ||
              (scopedStatus === "missing" && !["credential-missing", "handoff-pending"].includes(plan.reason)))) {
          scopedStatus = "unavailable";
        }
        if (connectionIntent.route === "api-key-case-managed" && scopedStatus !== "unavailable") {
          try {
            const afterPresence = await deps.vault.hasSecret(exactRef) ? "registered" : "missing";
            if (afterPresence !== scopedStatus) scopedStatus = "unavailable";
          } catch { scopedStatus = "unavailable"; }
        }
        if (connectionIntent.route === "api-key-case-managed" &&
            JSON.stringify(beforeRegistration) !== JSON.stringify(connectionStore.readCredentialRegistration(exactRef))) {
          scopedStatus = "unavailable";
        }
        if (connectionIntent.route === "api-key-case-managed" && scopedStatus === "unavailable") plan = await inspectPlan();
        const afterIntent = connectionStore.readIntent();
        if (afterIntent.status !== "available" || JSON.stringify(afterIntent.value) !== JSON.stringify(connectionIntent)) {
          throw new Error("Connection inspection changed");
        }
        const report = buildConnectionReport({
          plan,
          intent: connectionIntent,
          secretStatus: scopedStatus,
          legacyRegistered: secret?.status === "registered",
          credentialRevision,
          credentialFingerprint: scopedStatus === "registered" ? connectionCredentialFingerprint(exactRef) : null,
          sourceFingerprint,
          intentFingerprint,
          observations: connectionObservations,
          observationsUnavailable
        });
        connection = { status: "selected", issue: observationsUnavailable ? "history-unavailable" : null, report };
        scopedCredentialStatus = scopedStatus === "registered" || scopedStatus === "missing" ? scopedStatus : "unavailable";
        scopedCredentialRevision = scopedStatus === "registered" ? credentialRevision : null;
        scopedRegistrationSnapshot = beforeRegistration === null ? null : JSON.stringify(beforeRegistration);
      }
    } catch {
      connection = { status: "unavailable", issue: "metadata-unavailable", report: null };
      guidedSetup = null;
    }
  }

  const localSession = readLocalApplicationStatus(targetDir, deps.connectionBaseDir);
  let localStateCurrent = connection.status === "selected" && connection.issue === null;
  if (connectionIntent?.destination.kind === "local") {
    try {
      const store = new ConnectionStateStore(targetDir, deps.connectionBaseDir), current = store.readIntent();
      localStateCurrent = localStateCurrent && current.status === "available" &&
        JSON.stringify(current.value) === JSON.stringify(connectionIntent) &&
        localSessionSnapshot === JSON.stringify(localSession) &&
        localPreparationSnapshot === JSON.stringify(store.readLocalPreparation()) &&
        (connectionIntent.route !== "api-key-case-managed" || scopedRegistrationSnapshot ===
          JSON.stringify(store.readCredentialRegistration(connectionCredentialRef(targetDir, connectionIntent.environment))));
    } catch { localStateCurrent = false; }
  }
  const localDevelopment = connectionIntent ? projectLocalDevelopment({ intent: connectionIntent,
    credential: scopedCredentialStatus, credentialRevision: scopedCredentialRevision, session: localSession,
    host, stateCurrent: localStateCurrent,
    preparationReceipt: connectionIntent.destination.kind === "local" && localStateCurrent ?
      readLocalPreparationReview(targetDir, connectionIntent, scopedCredentialRevision, deps.connectionBaseDir, localPreparationSnapshot) : null }) : null;
  if (connection.status === "selected" && connectionIntent) {
    credentialInputSupported = supportsResendCredentialGuide(connectionIntent) && connection.issue === null &&
      (connectionIntent.destination.kind !== "local" || (localSession.retry === "fresh-request-required" &&
        !["unknown", "unavailable"].includes(localSession.status) && localSession.observationHistory.status !== "unavailable" &&
        localStateCurrent && (scopedCredentialStatus !== "missing" || localDevelopment?.nextStep === "review-credential-input")));
    if (credentialInputSupported) guidedSetup = buildResendGuidedSetup(connectionIntent, scopedCredentialStatus, host, possibleExposure);
  }

  // Read after the final awaited diagnostic. Recorded v2 slots must never be
  // redirected into legacy input, including uncertain/pending registration.
  // This is routing metadata only: it grants no presence, validity or execution.
  const providerContinuations: Array<{ service: "openai" | "stripe-test"; environments: ConnectionEnvironment[] }> = [];
  const scopedProviderNames = new Set<string>();
  const providerStore = new ConnectionStateStore(targetDir, deps.connectionBaseDir);
  for (const service of ["openai", "stripe-test"] as const) {
    const intent = providerStore.readProviderHostedIntent(service);
    const environments = credentialEnvironments(service).filter(environment =>
      providerStore.readCredentialRegistration(credentialRefForService(targetDir, environment, service)).status !== "missing" ||
      (intent.status === "available" && intent.value.environment === environment));
    // Unreadable selection still suppresses legacy registration. An empty list
    // is an unknown recorded environment, never a default or missing key.
    if (environments.length || intent.status !== "missing") {
      providerContinuations.push({ service, environments });
      scopedProviderNames.add(service === "openai" ? "OPENAI_API_KEY" : "STRIPE_API_KEY");
    }
  }
  const nextActions: NextAction[] = providerContinuations.map(profile => ({ actor: "agent", kind: "review-provider-credential", ...profile }));
  if (connection.status === "not-selected") {
    nextActions.push({ actor: "agent", kind: "review-connection-route" });
  } else if (connection.status === "unavailable") {
    nextActions.push({ actor: "human", kind: "resolve-unknown-connection", cause: "metadata-unavailable" });
  } else if (connection.status === "selected") {
    if (connection.issue === "history-unavailable") {
      nextActions.push({ actor: "human", kind: "resolve-unknown-connection", cause: "history-unavailable" });
    }
    if (connection.report.plan.status === "planned" && connection.report.route === "provider-native" && connection.report.stage === "configure-destination") {
      nextActions.push({ actor: "human", kind: "complete-provider-native-setup" });
    } else if (connection.report.plan.status === "planned" && connection.report.route === "manual" && connection.report.stage === "configure-destination") {
      nextActions.push({ actor: "agent", kind: "review-destination-setup" });
    }
    if (credentialInputSupported && scopedCredentialStatus === "missing") {
      nextActions.push({ actor: "human", kind: "register-connection-credential", service: "resend", environment: connection.report.environment });
    }
    if (!localDevelopment && credentialInputSupported && connection.report.credential.status === "registered" &&
        ["not-run", "stale"].includes(connection.report.providerCheck.status)) {
      nextActions.push({ actor: "agent", kind: "check-resend-credential" });
    }
  }
  if (localDevelopment) nextActions.push({ actor: "agent", kind: "review-local-development", step: localDevelopment.nextStep });
  if (!gitignoreOk) {
    nextActions.push({ actor: "agent", kind: "fix-gitignore" });
  }
  if (possibleExposure) {
    nextActions.push({ actor: "human", kind: "review-possible-exposure" });
  }
  const unrelatedSecrets = secrets.filter(secret => !scopedProviderNames.has(secret.name) &&
    (connection.status === "inactive" || secret.name !== "RESEND_API_KEY"));
  const managedSelection = connection.status === "selected" && connectionIntent !== null && supportsResendCredentialGuide(connectionIntent);
  const vaultNeeded = unrelatedSecrets.some(secret => secret.status !== "unused") || managedSelection ||
    (connection.status === "inactive" && clerkNative.status === "inactive" && clerkManaged.status === "inactive");
  if (!vaultAvailable && vaultNeeded) {
    nextActions.push({ actor: "human", kind: "enable-vault" });
  }
  for (const secret of secrets) {
    if (scopedProviderNames.has(secret.name)) continue;
    if (secret.status === "unsupported") {
      nextActions.push({ actor: "agent", kind: "review-secret-name", name: secret.name });
    } else if (vaultAvailable) {
      if (secret.status === "missing") {
        if (secret.name === "RESEND_API_KEY") continue;
        nextActions.push({
          actor: "human",
          kind: "register-secret",
          name: secret.name,
          scope: "project"
        });
      } else if (secret.status === "unused") {
        if (secret.name === "RESEND_API_KEY" && connection.status !== "inactive") continue;
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

  if (clerkManaged.nextStep !== "none") nextActions.push({ actor: "agent", kind: "review-clerk-managed", step: clerkManaged.nextStep });

  // Legacy v1 facts remain in secrets. They cannot satisfy or create a selected
  // Resend route's storage requirement; provider-native needs no vault copy.
  const countedSecrets = [...unrelatedSecrets.filter(secret => secret.status !== "unused"),
    ...(managedSelection ? [{ name: "RESEND_API_KEY", status: scopedCredentialStatus }] : [])];
  const count = (status: NextSecretStatus) => countedSecrets.filter((secret) => secret.status === status).length;
  const counts = {
    required: countedSecrets.length,
    registered: count("registered"), missing: count("missing"), unavailable: count("unavailable"),
    unsupported: count("unsupported"), cleanupCandidates: secrets.filter(secret => secret.status === "unused").length
  };
  const stage: NextReport["setup"]["stage"] = offline ? (possibleExposure ? "review-exposure" : "review-deployment") : possibleExposure ? "review-exposure"
    : (!vaultAvailable && vaultNeeded) || counts.unavailable > 0 ? "prepare-storage"
      : counts.unsupported > 0 ? "review-secret-names"
        : (unrelatedSecrets.some(secret => secret.status === "missing") || (credentialInputSupported && scopedCredentialStatus === "missing"))
          ? (host.secretInput === "unavailable" ? "human-handoff" : "register-secrets")
          : counts.required === 0 && providerContinuations.length === 0 && clerkManaged.status === "inactive" && connection.status === "inactive" ? "no-required-secrets" : "review-deployment";

  if(connection.status==="selected"&&connection.report.route==="provider-native"&&connection.report.destination.kind==="vercel") {
    connection.report.nativeApplicationObservation=readNativeApplicationEvidence(targetDir,"resend",deps.connectionBaseDir);
    // This supported route uses the native reader's remaining work. The separate
    // generic plan stays unresolved; its missing resolver is not a prerequisite.
    if(connection.report.plan.status!=="planned"&&connection.report.nativeApplicationObservation.status!=="inactive") connection.report.recovery=[];
  }
  return {
    schemaVersion: 13,
    ...(offline ? { inspection: { mode: "offline" as const, provider: "not-inspected" as const,
      vaultAvailability: "not-inspected" as const, gitExposure: "not-inspected" as const, gitIgnore: "not-inspected" as const } } : {}),
    guidedSetup: offline ? null : guidedSetup,
    connection,
    localSession,
    localDevelopment,
    clerkNative,
    clerkManaged,
    host,
    setup: { stage, counts, deploymentState: "not-inspected" },
    vault: { status: offline ? "not-inspected" : vaultAvailable ? "available" : "unavailable" },
    license: { plan: deps.licensePlan },
    hygiene: { gitignoreOk: offline ? null : gitignoreOk, possibleExposure },
    secrets,
    targets,
    nextActions: offline ? nextActions.filter(action => [
      "review-possible-exposure", "review-secret-name", "review-connection-route", "review-provider-credential",
      "resolve-unknown-connection", "review-clerk-managed", "review-local-development"
    ].includes(action.kind)) : nextActions
  };
}

function latestObservation(entries: ConnectionObservation[], connectionId: string,
  kind: ConnectionObservationKind): ConnectionObservation | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.connectionId === connectionId && entry.kind === kind && !entry.basis.native && !entry.basis.managed) return entry;
  }
  return null;
}

function providerObservationStatus(entry: ConnectionObservation | null, credentialStatus: NextSecretStatus,
  credentialRevision: string | null, credentialFingerprint: string | null,
  observationsUnavailable: boolean): ConnectionReport["providerCheck"]["status"] {
  if (observationsUnavailable) return "unknown";
  if (credentialStatus === "registered" && !credentialRevision) return "unknown";
  if (!entry) return "not-run";
  if (entry.basis.verifierVersion !== RESEND_VERIFIER_VERSION) return "stale";
  if (credentialStatus === "missing" || credentialStatus === "unused") return "stale";
  if (credentialStatus === "unavailable" || credentialStatus === "unsupported") return "unknown";
  if (!credentialRevision || !entry.basis.credentialRevision) return "unknown";
  if (entry.basis.credentialRevision !== credentialRevision) return "stale";
  if (!entry.basis.sourceFingerprint || !credentialFingerprint) return "unknown";
  if (entry.basis.sourceFingerprint !== credentialFingerprint) return "stale";
  if (entry.outcome === "unknown") return "unknown";
  if (entry.resultCode === "valid-full-access" || entry.resultCode === "valid-sending-access") return "passed";
  if (entry.resultCode === "invalid-credential") return "failed";
  return "unknown";
}

function buildConnectionReport(options: {
  plan: ConnectionPlan;
  intent: ConnectionIntent;
  secretStatus: NextSecretStatus;
  legacyRegistered: boolean;
  credentialRevision: string | null;
  credentialFingerprint: string | null;
  sourceFingerprint: string | null;
  intentFingerprint: string;
  observations: ConnectionObservation[];
  observationsUnavailable: boolean;
}): ConnectionReport {
  const { intent, secretStatus, credentialRevision, sourceFingerprint, intentFingerprint, observations,
    observationsUnavailable } = options;
  let credential: ConnectionReport["credential"];
  if (intent.route === "provider-native") {
    credential = { source: "provider-native", status: "external-unverified" };
  } else if (intent.route === "manual") {
    credential = { source: "unknown", status: "unavailable" };
  } else if (secretStatus === "registered") {
    credential = { source: "api-key-case", status: "registered" };
  } else if (secretStatus === "missing" && options.legacyRegistered) {
    // The legacy value remains available to old commands, never to this env slot.
    credential = { source: "legacy-unscoped", status: "missing" };
  } else {
    credential = { source: "api-key-case", status: secretStatus === "missing" ? "missing" : "unavailable" };
  }

  const credentialObservation = latestObservation(observations, intent.id, "credential-validation");
  const destinationObservation = latestObservation(observations, intent.id, "destination-check");
  const applicationObservation = latestObservation(observations, intent.id, "application-check");
  const providerStatus = intent.route === "provider-native" || intent.route === "manual"
    ? "not-applicable"
    : providerObservationStatus(credentialObservation, secretStatus, credentialRevision, options.credentialFingerprint,
      observationsUnavailable);
  const application = options.plan.applicationCheck;
  const applicationStatus = application.status;
  let destinationStatus: ConnectionReport["destination"]["status"] = application.configured ? "configured" : "unknown";
  if (applicationStatus === "stale" && applicationObservation?.basis.destinationFingerprint && options.plan.basis &&
      applicationObservation.basis.destinationFingerprint !== options.plan.basis.destinationFingerprint) destinationStatus = "changed";
  const providerAuthority = credentialObservation ? "provider-observed" : "none";

  const report: ConnectionReport = {
    service: intent.service,
    environment: intent.environment,
    route: intent.route,
    credential,
    plan: options.plan,
    destination: { kind: intent.destination.kind, status: destinationStatus, authority: application.configured ? "agent-observed" : "none" },
    providerCheck: { status: providerStatus, authority: credentialObservation ? providerAuthority : "none" },
    applicationCheck: { status: applicationStatus, authority: application.authority, reason: application.reason },
    recovery: options.plan.recovery,
    stage: "unknown"
  };
  report.stage = deriveConnectionStage(report, observationsUnavailable);
  return report;
}

function deriveConnectionStage(report: ConnectionReport, observationsUnavailable: boolean): ConnectionStage {
  if (observationsUnavailable || report.providerCheck.status === "unknown" || report.applicationCheck.status === "unknown") return "unknown";
  if (report.providerCheck.status === "failed" || report.applicationCheck.status === "failed") return "blocked";
  if (report.route === "api-key-case-managed") {
    if (report.credential.status === "unavailable") return "unknown";
    if (report.credential.status === "missing") return "acquire-credential";
    if (report.providerCheck.status === "not-run" || report.providerCheck.status === "stale") return "verify-provider";
  } else if (report.route === "provider-native" && report.credential.status === "unavailable") {
    return "unknown";
  }
  if (report.destination.status !== "configured") return "configure-destination";
  if (report.route === "api-key-case-managed" && report.providerCheck.status !== "passed") return "verify-provider";
  if (report.route === "manual" && report.providerCheck.status !== "passed") return "verify-provider";
  if (report.applicationCheck.status === "not-run" || report.applicationCheck.status === "stale") return "verify-application";
  return report.applicationCheck.status === "passed" ? "ready" : "unknown";
}
