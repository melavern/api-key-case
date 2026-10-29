import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertProFeature, ProFeatureError, type LicenseOptions } from "../license.js";
import { cloudflareTargetPlan, resolveGenericCloudflareTarget, type CloudflareConfigDestination } from "../deploy/cloudflare-targets.js";
import { buildTrustedExecution, matchesTrustedExecution, type SnapshotRequest, type TrustedExecution } from "../deploy/snapshot.js";
import { CloudflareAdapter } from "../../adapters/cloudflare.js";
import { CatalogStore, type OperationSnapshot } from "./files.js";
import { operationSchema, validate, VNextError, type Binding, type Catalog, type Credential } from "./model.js";
import { usageBasis } from "./basis.js";
import { credentialPresence, type DiscoveryIO } from "./discovery.js";
import { findProject, inspectProject, sameProject, type ProjectContext } from "./project.js";
import { type CloudflareDestination } from "./target.js";
import { VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED } from "./gates.js";

export const useRequestSchema = z.strictObject({ project: z.string().min(1).max(4096), bindingId: z.uuidv4(), targetId: z.uuidv4() });
export type UseRequest = z.infer<typeof useRequestSchema>;
export interface UsePlan { request: UseRequest; catalog: Catalog; context: ProjectContext; binding: Binding; credential: Credential;
  destination: CloudflareDestination; target: CloudflareConfigDestination; fingerprint: string; basis: string; snapshotRequest: SnapshotRequest;
  previousOperation: ReturnType<typeof useOperationStatus> | null }
export interface UseIO extends DiscoveryIO {
  store: Pick<CatalogStore, "readCatalog" | "readOperation" | "saveOperation" | "listUseOperations" | "withUseLock">;
  licenseOptions?: LicenseOptions;
  pathOverride?: string; // Disposable fixtures only; never a CLI/MCP option.
  now?: () => number;
  human: { approve(plan: UsePlan, cliPath: string): Promise<"approved" | "declined" | "unavailable"> };
  probe?: (execution: TrustedExecution) => ReturnType<CloudflareAdapter["checkCli"]>;
  handoff: (plan: UsePlan, execution: TrustedExecution, stillCurrent: (phase?: "completion") => Promise<boolean>) => Promise<"completed" | "incomplete" | "unknown" | "changed">;
}
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function useResult(status: string, operationId: string | null = null, placementEffects: "none" | "possible" = "none") {
  return { schemaVersion: 1, permission: "none", executed: placementEffects === "possible", status, operationId, placementEffects, replay: "not-permitted" };
}
export function prepareUse(input: UseRequest, io: { store: Pick<CatalogStore, "readCatalog" | "readOperation" | "listUseOperations">; licenseOptions?: LicenseOptions }): UsePlan {
  // Even an offline deployment plan is Pro. Do not probe credentials first.
  assertProFeature("deploy", io.licenseOptions);
  const request = validate(useRequestSchema, input), context = inspectProject(request.project), catalog = io.store.readCatalog()?.catalog;
  if (!catalog) throw new VNextError("unavailable");
  const project = findProject(catalog, context), binding = catalog.bindings.find(b => b.id === request.bindingId && b.projectId === project?.id);
  const destination = catalog.destinations.find(d => d.id === request.targetId && d.projectId === project?.id && d.kind === "cloudflare") as CloudflareDestination | undefined;
  if (!binding || !destination) throw new VNextError("conflict");
  const environment = catalog.environments.find(e => e.id === binding.environmentId)!;
  if (environment.label !== destination.applicationEnvironment) throw new VNextError("conflict");
  const credential = catalog.credentials.find(c => c.id === binding.credentialId)!;
  // Preserve the existing test-only provider mode restriction for legacy Stripe slots.
  if (credential.locator.kind === "v2" && credential.locator.ref.service === "stripe-test" && environment.risk !== "nonproduction") throw new VNextError("conflict");
  const target = Object.freeze({ id: destination.id, config: destination.canonicalConfigRelativePath, accountId: destination.providerAccountId,
    worker: destination.resourceId, wranglerEnvironment: destination.configSection === "top-level" ? null : destination.configSection });
  const resolved = resolveGenericCloudflareTarget(context.canonicalPath, target);
  if (!resolved) throw new VNextError("conflict");
  const basis = usageBasis(catalog, [binding.id], destination.id), fingerprint = digest({ basis, context, files: resolved.files });
  // Legacy snapshot.env expresses risk only. The explicit target binds the real config section.
  const snapshotRequest: SnapshotRequest = { genericCloudflareDestination: target, name: binding.variableName, scope: "project", projectId: project!.id,
    env: environment.risk === "nonproduction" ? "preview" : "production", force: false, adapterId: "cloudflare", cliCommand: "wrangler", providerIdentity: null };
  const previous = io.store.listUseOperations(binding.id, destination.id).sort((a, b) => b.timestamps.createdAt.localeCompare(a.timestamps.createdAt) || b.operationId.localeCompare(a.operationId))[0];
  return { request, context, catalog, binding, credential, destination, target, fingerprint, basis, snapshotRequest,
    previousOperation: previous ? useOperationStatus(previous.operationId, io.store) : null };
}
export function projectUsePlan(plan: UsePlan) {
  const environment = plan.catalog.environments.find(e => e.id === plan.binding.environmentId)!;
  return { ...useResult("reviewable"), fingerprint: plan.fingerprint, bindingId: plan.binding.id, targetId: plan.destination.id,
    variable: plan.binding.variableName, environment: environment.label, risk: environment.risk,
    stability: plan.credential.locator.kind === "v3" ? "managed-generation" : "legacy-unversioned",
    generation: typeof plan.credential.generation === "number" ? plan.credential.generation : null,
    placementEffect: "cloudflare-version-and-immediate-deployment", mayOverwrite: true,
    nativeExecution: VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED ? "accepted-windows-only" : "pending-acceptance", providerProbes: "not-run",
    previousOperation: plan.previousOperation };
}
/** Observation only: neither status nor recovery repeats provider execution or approval. */
export function useOperationStatus(operationId: string, store: Pick<UseIO["store"], "readOperation">) {
  try {
    const operation = store.readOperation(operationId)?.operation;
    if (!operation || !["cloudflare-use", "vercel-use", "github-use"].includes(operation.kind)) return useResult("unavailable");
    const possible = operation.effects.some(e => e.state !== "not-started");
    return { ...useResult(operation.state === "executing" ? "unknown" : operation.state, operationId, possible ? "possible" : "none"), executed: false,
      effects: operation.effects.map(e => ({ ...e, state: e.state === "possible" ? "unknown" : e.state })) };
  } catch { return useResult("unavailable"); }
}
export async function applyUse(input: UseRequest, expectedFingerprint: string, io: UseIO) {
  try {
    input = Object.freeze(validate(useRequestSchema, input));
    const plan = prepareUse(input, io);
    if (expectedFingerprint !== plan.fingerprint) return useResult("changed");
    if (!VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED || process.platform !== "win32") return useResult("pending-acceptance");
    return await io.store.withUseLock(input.bindingId, input.targetId, async owns => {
      const pending = io.store.listUseOperations(input.bindingId, input.targetId).find(o => !["completed", "cancelled", "changed"].includes(o.state));
      return pending ? { ...useResult("recovery-required", pending.operationId, pending.effects.some(e => e.state !== "not-started") ? "possible" : "none"), executed: false } :
        applyUseLocked(input, expectedFingerprint, io, owns);
    });
  } catch (error) { return useResult(error instanceof ProFeatureError ? "pro-required" : error instanceof VNextError && error.reason === "lock-present" ? "recovery-required" : "unavailable"); }
}
async function applyUseLocked(input: UseRequest, expectedFingerprint: string, io: UseIO, owns: () => boolean) {
  let record: OperationSnapshot | null = null, entered = false;
  const finish = (state: "completed" | "incomplete" | "unknown" | "changed" | "cancelled", effect: "not-started" | "completed" | "failed" | "unknown") => {
    if (!record) return useResult(state);
    record = io.store.saveOperation(record, { ...record.operation, state, timestamps: { ...record.operation.timestamps, updatedAt: now() },
      effects: [{ targetId: record.operation.boundBasis.targetId!, state: effect }] });
    return useResult(state, record.operation.operationId, entered ? "possible" : "none");
  };
  try {
    if (!owns()) return useResult("recovery-required");
    let plan = prepareUse(input, io);
    if (expectedFingerprint !== plan.fingerprint) return useResult("changed");
    if (!VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED || process.platform !== "win32") return useResult("pending-acceptance");
    const deployment = cloudflareTargetPlan(plan.target, plan.binding.variableName);
    let built = buildTrustedExecution(plan.snapshotRequest, deployment, { projectDir: plan.context.canonicalPath, pathOverride: io.pathOverride });
    if (!built.ok) return useResult("unavailable");
    const cliStatus = await (io.probe ? io.probe(built.execution) : new CloudflareAdapter().checkCli({ cwd: built.execution.cwd, env: built.execution.env, resolvedCli: built.execution.resolvedCli }));
    if (!cliStatus.installed || !cliStatus.loggedIn || !cliStatus.version?.startsWith("4.") || !cliStatus.identity?.startsWith("accounts:") ||
        !cliStatus.identity.slice(9).split(",").includes(plan.target.accountId) ||
        !matchesTrustedExecution(plan.snapshotRequest, deployment, built.execution)) return useResult("unavailable");
    if (prepareUse(input, io).fingerprint !== plan.fingerprint) return useResult("changed");
    plan = { ...plan, snapshotRequest: { ...plan.snapshotRequest, providerIdentity: cliStatus.identity } };
    built = buildTrustedExecution(plan.snapshotRequest, deployment, { projectDir: plan.context.canonicalPath, pathOverride: io.pathOverride });
    if (!built.ok) return useResult("unavailable");
    const execution = built.execution, clock = io.now ?? Date.now;
    let approvedAt: number | null = null;
    const current = async (phase?: "completion") => {
      try {
        if (!owns() || await credentialPresence(io, plan.credential.locator, plan.catalog, plan.context) !== "present") return false;
        // All metadata and identity checks follow the awaited presence boundary.
        return owns() && sameProject(plan.context, inspectProject(input.project)) && prepareUse(input, io).fingerprint === plan.fingerprint &&
          matchesTrustedExecution(plan.snapshotRequest, deployment, execution) &&
          (phase === "completion" || approvedAt === null || clock() >= approvedAt && clock() - approvedAt <= 60_000);
      } catch { return false; }
    };
    if (!await current()) return useResult("changed");
    const time = now(), operation = validate(operationSchema, { schemaVersion: 1, operationId: randomUUID(), kind: "cloudflare-use",
      projectId: plan.binding.projectId, bindingId: plan.binding.id, credentialId: plan.credential.id, expectedCatalogRevision: plan.catalog.revision,
      boundBasis: { fingerprint: plan.fingerprint, previousGenerationId: null, targetId: plan.destination.id, targetRevision: plan.destination.revision,
        projectRevision: plan.catalog.projects.find(p => p.id === plan.binding.projectId)!.revision, bindingRevision: plan.binding.revision },
      state: "consent-needed", timestamps: { createdAt: time, updatedAt: time }, effects: [{ targetId: plan.destination.id, state: "not-started" }], authority: "none" });
    record = io.store.saveOperation(null, operation);
    const decision = await io.human.approve(plan, execution.resolvedCli.absolutePath);
    approvedAt = decision === "approved" ? clock() : null;
    if (!await current()) return finish("changed", "not-started");
    if (decision !== "approved") return decision === "declined" ? finish("cancelled", "not-started") : { ...finish("changed", "not-started"), status: "unavailable" };
    record = io.store.saveOperation(record, { ...record.operation, state: "executing", timestamps: { ...record.operation.timestamps, updatedAt: now() },
      effects: [{ targetId: plan.destination.id, state: "possible" }] });
    entered = true; // Durable unknown/possible receipt exists before the only value-bearing call.
    if (!await current()) return finish("unknown", "unknown");
    const outcome = await io.handoff(plan, execution, current);
    return finish(outcome === "changed" ? "unknown" : outcome, outcome === "completed" ? "completed" : outcome === "incomplete" ? "failed" : "unknown");
  } catch (error) {
    return useResult(record ? "unknown" : error instanceof ProFeatureError ? "pro-required" : "unavailable", record?.operation.operationId ?? null, entered ? "possible" : "none");
  }
}
