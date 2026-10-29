import { createHash, randomUUID } from "node:crypto";
import { assertProFeature, ProFeatureError, type LicenseOptions } from "../license.js";
import { hostedDeploymentPlan, resolveHostedTarget, type HostedDestination } from "../deploy/hosted-targets.js";
import { hostedAdapter } from "../../adapters/hosted-binding.js";
import { buildTrustedExecution, matchesTrustedExecution, type SnapshotRequest, type TrustedExecution } from "../deploy/snapshot.js";
import { CatalogStore, type OperationSnapshot } from "./files.js";
import { credentialPresence, type DiscoveryIO } from "./discovery.js";
import { findProject, inspectProject, sameProject, type ProjectContext } from "./project.js";
import { operationSchema, validate, VNextError, type Binding, type Credential, type Catalog } from "./model.js";
import { usageBasis } from "./basis.js";
import { useRequestSchema, useOperationStatus, useResult, type UseRequest } from "./use.js";
import { VNEXT_WINDOWS_VERCEL_ACCEPTED, VNEXT_WINDOWS_GITHUB_ACCEPTED } from "./gates.js";

export interface HostedUsePlan { request: UseRequest; catalog: Catalog; context: ProjectContext; binding: Binding; credential: Credential; destination: HostedDestination;
  fingerprint: string; basis: string; snapshotRequest: SnapshotRequest; providerIdentity?: string;
  previousOperation: ReturnType<typeof useOperationStatus> | null }
export interface HostedUseIO extends DiscoveryIO {
  store: Pick<CatalogStore, "readCatalog" | "readOperation" | "saveOperation" | "listUseOperations" | "withUseLock">;
  licenseOptions?: LicenseOptions; pathOverride?: string; now?: () => number;
  human: { approve(plan: HostedUsePlan, cliPath: string): Promise<"approved" | "declined" | "unavailable"> };
  probe?: (execution: TrustedExecution, plan: HostedUsePlan) => ReturnType<ReturnType<typeof hostedAdapter>["checkCli"]>;
  handoff(plan: HostedUsePlan, execution: TrustedExecution, current: (phase?: "completion") => Promise<boolean>): Promise<"completed" | "incomplete" | "changed" | "unknown">;
}
export const hostedUseAccepted = (kind: HostedDestination["kind"]) => kind === "vercel" ? VNEXT_WINDOWS_VERCEL_ACCEPTED : VNEXT_WINDOWS_GITHUB_ACCEPTED;
const now = () => new Date().toISOString();
export function prepareHostedUse(input: UseRequest, io: { store: Pick<CatalogStore, "readCatalog" | "readOperation" | "listUseOperations">; licenseOptions?: LicenseOptions }): HostedUsePlan {
  assertProFeature("deploy", io.licenseOptions);
  const request = validate(useRequestSchema, input), context = inspectProject(request.project), catalog = io.store.readCatalog()?.catalog;
  if (!catalog) throw new VNextError("unavailable");
  const project = findProject(catalog, context), binding = catalog.bindings.find(b => b.id === request.bindingId && b.projectId === project?.id), destination = catalog.destinations.find(d => d.id === request.targetId && d.projectId === project?.id);
  if (!binding || !destination || destination.kind === "cloudflare") throw new VNextError("conflict");
  const credential = catalog.credentials.find(c => c.id === binding.credentialId)!, environment = catalog.environments.find(e => e.id === binding.environmentId)!;
  if (credential.locator.kind === "v2" && credential.locator.ref.service === "stripe-test" && (environment.risk !== "nonproduction" || ["production", "repository"].includes(destination.applicationEnvironment))) throw new VNextError("conflict");
  const selected = resolveHostedTarget(context.canonicalPath, destination), basis = usageBasis(catalog, [binding.id], destination.id);
  hostedDeploymentPlan(destination, binding.variableName);
  const fingerprint = createHash("sha256").update(JSON.stringify({ basis, context, files: selected.files })).digest("hex");
  const snapshotRequest: SnapshotRequest = { genericHostedDestination: destination, name: binding.variableName, scope: "project", projectId: project!.id,
    env: destination.kind === "vercel" ? destination.applicationEnvironment : environment.risk === "nonproduction" ? "preview" : "production",
    force: false, adapterId: destination.kind === "vercel" ? "vercel" : "github", cliCommand: destination.kind === "vercel" ? "vercel" : "gh", providerIdentity: null };
  const previous = io.store.listUseOperations(binding.id, destination.id).sort((a, b) => b.timestamps.createdAt.localeCompare(a.timestamps.createdAt))[0];
  return { request, context, catalog, binding, credential, destination, basis, fingerprint, snapshotRequest, previousOperation: previous ? useOperationStatus(previous.operationId, io.store) : null };
}
export function projectHostedUsePlan(plan: HostedUsePlan) {
  const environment = plan.catalog.environments.find(e => e.id === plan.binding.environmentId)!;
  return { ...useResult("reviewable"), fingerprint: plan.fingerprint, bindingId: plan.binding.id, targetId: plan.destination.id, variable: plan.binding.variableName,
    environment: environment.label, risk: environment.risk, targetKind: plan.destination.kind, targetEnvironment: plan.destination.applicationEnvironment,
    generation: typeof plan.credential.generation === "number" ? plan.credential.generation : null, stability: plan.credential.locator.kind === "v3" ? "managed-generation" : "legacy-unversioned",
    placementEffect: plan.destination.kind === "vercel" ? "variable-registration-without-app-deployment" : "actions-workflow-readable-secret", mayOverwrite: true,
    nativeExecution: hostedUseAccepted(plan.destination.kind) ? "accepted-windows-only" : "pending-acceptance", providerProbes: "not-run", previousOperation: plan.previousOperation };
}
function validIdentity(plan: HostedUsePlan, identity: string | undefined): identity is string {
  if (!identity || identity.length > 1024) return false;
  return plan.destination.kind === "vercel" ? /^user:[a-z0-9_.-]+,team:team_[A-Za-z0-9]+,project:prj_[A-Za-z0-9]+$/.test(identity) &&
    identity.endsWith(`,team:${plan.destination.providerAccountId},project:${plan.destination.resourceId}`) :
    /^user:[a-z0-9_.-]+,id:[1-9]\d*,repo:[1-9]\d*,owner:[1-9]\d*,environment:(?:repository|[1-9]\d*)$/.test(identity) &&
    (plan.destination.applicationEnvironment === "repository" ? identity.endsWith(",environment:repository") : !identity.endsWith(",environment:repository"));
}
function unavailableGuide(plan: HostedUsePlan) {
  return { ...useResult("unavailable"), reason: "official-cli-or-identity-unavailable", manualSteps: plan.destination.kind === "vercel" ?
    ["Install a supported official Vercel CLI (59.x).", "Authenticate with vercel login using the official human flow.", "Review the existing .vercel project link, then request a new API Key Case plan."] :
    ["Install a supported official GitHub CLI (2.x).", "Authenticate to github.com using the official gh auth login human flow.", "Review the existing origin and Actions environment, then request a new API Key Case plan."] };
}
export async function applyHostedUse(input: UseRequest, expectedFingerprint: string, io: HostedUseIO) {
  try {
    input = Object.freeze(validate(useRequestSchema, input)); const plan = prepareHostedUse(input, io);
    if (plan.fingerprint !== expectedFingerprint) return useResult("changed");
    if (!hostedUseAccepted(plan.destination.kind) || process.platform !== "win32") return useResult("pending-acceptance");
    return await io.store.withUseLock(input.bindingId, input.targetId, async owns => {
      const pending = io.store.listUseOperations(input.bindingId, input.targetId).find(o => !["completed", "cancelled", "changed"].includes(o.state));
      return pending ? { ...useOperationStatus(pending.operationId, io.store), status: "recovery-required" } : executeHostedUse(input, expectedFingerprint, io, owns);
    });
  } catch (e) { return useResult(e instanceof ProFeatureError ? "pro-required" : e instanceof VNextError && e.reason === "lock-present" ? "recovery-required" : "unavailable"); }
}
async function executeHostedUse(input: UseRequest, fingerprint: string, io: HostedUseIO, owns: () => boolean) {
  let record: OperationSnapshot | null = null, entered = false;
  const finish = (state: "completed" | "incomplete" | "unknown" | "cancelled" | "changed", effect: "not-started" | "completed" | "failed" | "unknown") => {
    record = io.store.saveOperation(record, { ...record!.operation, state, timestamps: { ...record!.operation.timestamps, updatedAt: now() }, effects: [{ targetId: input.targetId, state: effect }] });
    return useResult(state, record.operation.operationId, entered ? "possible" : "none");
  };
  try {
    let plan = prepareHostedUse(input, io); if (plan.fingerprint !== fingerprint || !owns()) return useResult("changed");
    const deployment = hostedDeploymentPlan(plan.destination, plan.binding.variableName), adapter = hostedAdapter(plan.destination);
    let built = buildTrustedExecution(plan.snapshotRequest, deployment, { projectDir: plan.context.canonicalPath, pathOverride: io.pathOverride }); if (!built.ok) return unavailableGuide(plan);
    const probe = (execution: TrustedExecution) => io.probe ? io.probe(execution, plan) : adapter.checkCli({ cwd: execution.cwd, env: execution.env, resolvedCli: execution.resolvedCli });
    const initial = await probe(built.execution);
    if (!initial.installed || !initial.loggedIn || !(plan.destination.kind === "vercel" ? initial.version?.startsWith("59.") : initial.version?.startsWith("2.")) || !validIdentity(plan, initial.identity)) return unavailableGuide(plan);
    plan = { ...plan, providerIdentity: initial.identity, snapshotRequest: { ...plan.snapshotRequest, providerIdentity: initial.identity } };
    built = buildTrustedExecution(plan.snapshotRequest, deployment, { projectDir: plan.context.canonicalPath, pathOverride: io.pathOverride }); if (!built.ok) return useResult("unavailable");
    const execution = built.execution, clock = io.now ?? Date.now; let approvedAt: number | null = null;
    const current = async (phase?: "completion") => {
      try {
        if (!owns() || await credentialPresence(io, plan.credential.locator, plan.catalog, plan.context) !== "present") return false;
        return owns() && sameProject(plan.context, inspectProject(input.project)) && prepareHostedUse(input, io).fingerprint === fingerprint && matchesTrustedExecution(plan.snapshotRequest, deployment, execution) &&
          (phase === "completion" || approvedAt === null || clock() >= approvedAt && clock() - approvedAt <= 60000);
      } catch { return false; }
    };
    if (!await current()) return useResult("changed");
    const time = now(), operation = validate(operationSchema, { schemaVersion: 1, operationId: randomUUID(), kind: plan.destination.kind === "vercel" ? "vercel-use" : "github-use",
      projectId: plan.binding.projectId, bindingId: plan.binding.id, credentialId: plan.credential.id, expectedCatalogRevision: plan.catalog.revision,
      boundBasis: { fingerprint, previousGenerationId: null, targetId: plan.destination.id, targetRevision: plan.destination.revision,
        projectRevision: plan.catalog.projects.find(p => p.id === plan.binding.projectId)!.revision, bindingRevision: plan.binding.revision },
      state: "consent-needed", timestamps: { createdAt: time, updatedAt: time }, effects: [{ targetId: input.targetId, state: "not-started" }], authority: "none" });
    record = io.store.saveOperation(null, operation);
    const decision = await io.human.approve(plan, execution.resolvedCli.absolutePath); approvedAt = decision === "approved" ? clock() : null;
    if (!await current()) return finish("changed", "not-started");
    if (decision !== "approved") return decision === "declined" ? finish("cancelled", "not-started") : { ...finish("changed", "not-started"), status: "unavailable" };
    const fresh = await probe(execution);
    if (!fresh.installed || !fresh.loggedIn || fresh.version !== initial.version || fresh.identity !== initial.identity || !await current()) return finish("changed", "not-started");
    record = io.store.saveOperation(record, { ...record.operation, state: "executing", timestamps: { ...record.operation.timestamps, updatedAt: now() }, effects: [{ targetId: input.targetId, state: "possible" }] });
    entered = true; if (!await current()) return finish("unknown", "unknown");
    const outcome = await io.handoff(plan, execution, current);
    return finish(outcome === "changed" ? "unknown" : outcome, outcome === "completed" ? "completed" : outcome === "incomplete" ? "failed" : "unknown");
  } catch { return useResult(record ? "unknown" : "unavailable", record?.operation.operationId ?? null, entered ? "possible" : "none"); }
}
