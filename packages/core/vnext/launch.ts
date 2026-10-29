import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertProFeature, ProFeatureError, type LicenseOptions } from "../license.js";
import { captureProfile, launchFile, npmSelection, type LaunchProfile, type ProfileSnapshot } from "../local/profile-snapshot.js";
import { type CatalogStore, type CatalogSnapshot, type OperationSnapshot } from "./files.js";
import { catalogSchema, launchProfileSchema, operationSchema, validate, VNextError, type Catalog } from "./model.js";
import { presenceAll, type DiscoveryIO } from "./discovery.js";
import { makeBindingOperation } from "./binding.js";
import { usageBasis } from "./basis.js";
import { findProject, inspectProject, sameProject, type ProjectContext } from "./project.js";
import { catalogFingerprint } from "./registration.js";
import { VNEXT_WINDOWS_LOCAL_ACCEPTED } from "./gates.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const time = () => new Date().toISOString();
const proposalId = "00000000-0000-4000-8000-000000000003";
export const profileRequestSchema = z.strictObject({ project: z.string().min(1).max(4096),
  kind: z.enum(["node-entry", "node-package-script", "python-entry", "python-module"]), runtime: z.string().min(1).max(4096),
  entry: z.string().min(1).max(1024), cwd: z.string().min(1).max(1024), bindingIds: z.array(z.uuidv4()).min(1).max(128),
  maxDurationSeconds: z.number().int().min(1).max(7200), profileId: z.uuidv4().optional() });
export type ProfileRequest = z.infer<typeof profileRequestSchema>;
type Store = Pick<CatalogStore, "readCatalog" | "compareAndSwap" | "readOperation" | "saveOperation" | "withUseLock" | "listLaunchOperations">;
export interface ProfilePlan { request: ProfileRequest; catalog: Catalog; before: CatalogSnapshot; context: ProjectContext; profile: LaunchProfile;
  snapshot: ProfileSnapshot; fingerprint: string }
export interface ProfileIO { store: Store; human: { confirm(plan: ProfilePlan): Promise<"approved" | "declined" | "unavailable"> } }
export const launchResult = (status: string, operationId: string | null = null, execution: "not-started" | "possible" = "not-started", treeTermination: "not-needed" | "confirmed" | "unknown" = "not-needed") =>
  ({ schemaVersion: 1, permission: "none", executed: execution === "possible", status, operationId, execution, treeTermination, replay: "not-permitted" });
export function prepareProfile(input: ProfileRequest, io: Pick<ProfileIO, "store">): ProfilePlan {
  const request = validate(profileRequestSchema, input), context = inspectProject(request.project), before = io.store.readCatalog();
  if (!before) throw new VNextError("unavailable");
  const catalog = before.catalog, project = findProject(catalog, context); if (!project) throw new VNextError("conflict");
  const runtime = launchFile(request.runtime);
  const matches = catalog.launchProfiles.filter(p => p.projectId === project.id && p.kind === request.kind &&
    p.runtimeIdentity.executable === runtime.path && p.runtimeIdentity.fingerprint === runtime.fingerprint &&
    p.approvedEntryOrScript === request.entry && p.cwd === request.cwd && p.maxDurationSeconds === request.maxDurationSeconds &&
    JSON.stringify([...p.bindingIds].sort()) === JSON.stringify([...request.bindingIds].sort()));
  if (!request.profileId && matches.length > 1) throw new VNextError("conflict");
  const previous = request.profileId ? catalog.launchProfiles.find(p => p.id === request.profileId && p.projectId === project.id) : matches[0];
  if (request.profileId && !previous) throw new VNextError("conflict");
  const base = { id: previous?.id ?? proposalId, projectId: project.id, runtimeIdentity: { executable: runtime.path, fingerprint: runtime.fingerprint },
    approvedEntryOrScript: request.entry, cwd: request.cwd, bindingIds: request.bindingIds, maxDurationSeconds: request.maxDurationSeconds,
    revision: previous ? previous.revision + 1 : 1, reviewedAt: "1970-01-01T00:00:00.000Z" };
  const profile = validate(launchProfileSchema, { ...base, kind: request.kind, ...(request.kind === "node-package-script" ? {
    packageManifestRevision: npmSelection(context.canonicalPath, request.cwd, runtime.path, request.entry as "dev").revision } : {}) });
  const candidate = { ...catalog, launchProfiles: [...catalog.launchProfiles.filter(p => p.id !== previous?.id), profile] }; validate(catalogSchema, candidate);
  const variables = profile.bindingIds.map(id => catalog.bindings.find(b => b.id === id)!.variableName);
  const snapshot = captureProfile(context.canonicalPath, profile, variables);
  return { request, catalog, before, context, profile, snapshot, fingerprint: digest({ catalog: catalogFingerprint(catalog), snapshot: snapshot.fingerprint }) };
}
export function projectProfilePlan(plan: ProfilePlan) {
  return { ...launchResult("reviewable"), fingerprint: plan.fingerprint, kind: plan.profile.kind, bindingIds: plan.profile.bindingIds,
    maxDurationSeconds: plan.profile.maxDurationSeconds, appReadable: true, sourceEditing: "allowed",
    profileId: plan.catalog.launchProfiles.some(p => p.id === plan.profile.id) ? plan.profile.id : null };
}
/** Value-free discovery is restricted to one verified physical project. */
export function listProfiles(projectPath: string, io: Pick<ProfileIO, "store">) {
  const context = inspectProject(projectPath), catalog = io.store.readCatalog()?.catalog;
  const project = catalog && findProject(catalog, context);
  return { ...launchResult("available"), profiles: (catalog?.launchProfiles ?? []).filter(p => p.projectId === project?.id).map(p => ({
    profileId: p.id, kind: p.kind, bindingIds: p.bindingIds, maxDurationSeconds: p.maxDurationSeconds })) };
}
export async function registerProfile(input: ProfileRequest, fingerprint: string, io: ProfileIO) {
  let operationId: string | null = null;
  try {
    const plan = prepareProfile(input, io); if (plan.fingerprint !== fingerprint) return launchResult("changed");
    const existing = plan.catalog.launchProfiles.find(p => p.id === plan.profile.id);
    const comparable = (p: LaunchProfile) => JSON.stringify({ ...p, bindingIds: [...p.bindingIds].sort(), revision: 0, reviewedAt: "" });
    if (existing && comparable(existing) === comparable(plan.profile)) return { ...launchResult("unchanged"), profileId: existing.id };
    const decision = await io.human.confirm(plan); if (decision !== "approved") return launchResult(decision === "declined" ? "cancelled" : "unavailable");
    if (prepareProfile(input, io).fingerprint !== fingerprint || !plan.snapshot.current()) return launchResult("changed");
    const profile = { ...plan.profile, id: existing?.id ?? randomUUID(), reviewedAt: time() };
    const after = validate(catalogSchema, { ...plan.catalog, revision: plan.catalog.revision + 1,
      launchProfiles: [...plan.catalog.launchProfiles.filter(p => p.id !== existing?.id), profile] });
    const operation = makeBindingOperation(plan.catalog, after, profile.projectId); operationId = operation.operationId;
    let record = io.store.saveOperation(null, operation);
    record = io.store.saveOperation(record, { ...operation, state: "executing", timestamps: { ...operation.timestamps, updatedAt: time() } });
    io.store.compareAndSwap(plan.before, after);
    io.store.saveOperation(record, { ...record.operation, state: "completed", timestamps: { ...record.operation.timestamps, updatedAt: time() } });
    return { ...launchResult("completed", operationId), profileId: profile.id };
  } catch { return launchResult(operationId ? "recovery-required" : "unavailable", operationId); }
}
export const launchRequestSchema = z.strictObject({ project: z.string().min(1).max(4096), profileId: z.uuidv4() });
export type LaunchRequest = z.infer<typeof launchRequestSchema>;
export interface LaunchPlan { request: LaunchRequest; catalog: Catalog; context: ProjectContext; profile: LaunchProfile; snapshot: ProfileSnapshot;
  fingerprint: string; basis: string; previousOperation: ReturnType<typeof launchOperationStatus> | null }
export interface LaunchIO extends DiscoveryIO {
  store: Store; licenseOptions?: LicenseOptions; now?: () => number; signal?: AbortSignal;
  human: { approve(plan: LaunchPlan): Promise<"approved" | "declined" | "unavailable"> };
  handoff(plan: LaunchPlan, current: () => Promise<boolean>, launched: () => void, signal?: AbortSignal): Promise<{
    status: "exited" | "failed" | "expired" | "cancelled" | "changed" | "unknown"; execution: "not-started" | "possible"; treeTermination: "not-needed" | "confirmed" | "unknown" }>;
}
export function prepareLaunch(input: LaunchRequest, io: { store: Pick<CatalogStore, "readCatalog" | "readOperation" | "listLaunchOperations">; licenseOptions?: LicenseOptions }): LaunchPlan {
  assertProFeature("deploy", io.licenseOptions);
  const request = validate(launchRequestSchema, input), context = inspectProject(request.project), catalog = io.store.readCatalog()?.catalog;
  if (!catalog) throw new VNextError("unavailable");
  const project = findProject(catalog, context), profile = catalog.launchProfiles.find(p => p.id === request.profileId && p.projectId === project?.id);
  if (!profile) throw new VNextError("conflict");
  for (const id of profile.bindingIds) {
    const binding = catalog.bindings.find(b => b.id === id)!, credential = catalog.credentials.find(c => c.id === binding.credentialId)!;
    if (credential.locator.kind === "v2" && credential.locator.ref.service === "stripe-test" && catalog.environments.find(e => e.id === binding.environmentId)!.risk !== "nonproduction") throw new VNextError("conflict");
  }
  const snapshot = captureProfile(context.canonicalPath, profile, profile.bindingIds.map(id => catalog.bindings.find(b => b.id === id)!.variableName));
  const basis = usageBasis(catalog, profile.bindingIds, profile.id), fingerprint = digest({ basis, context, snapshot: snapshot.fingerprint });
  const previous = io.store.listLaunchOperations(profile.id).sort((a, b) => b.timestamps.createdAt.localeCompare(a.timestamps.createdAt))[0];
  return { request, catalog, context, profile, snapshot, basis, fingerprint, previousOperation: previous ? launchOperationStatus(previous.operationId, io.store) : null };
}
export function projectLaunchPlan(plan: LaunchPlan) {
  return { ...launchResult("reviewable"), fingerprint: plan.fingerprint, profileId: plan.profile.id, kind: plan.profile.kind,
    bindingIds: plan.profile.bindingIds, maxDurationSeconds: plan.profile.maxDurationSeconds, appReadable: true,
    sourceEditing: "allowed", nativeExecution: VNEXT_WINDOWS_LOCAL_ACCEPTED ? "accepted-windows-only" : "pending-acceptance", previousOperation: plan.previousOperation };
}
export function launchOperationStatus(id: string, store: Pick<Store, "readOperation">) {
  try {
    const op = store.readOperation(id)?.operation; if (op?.kind !== "local-launch") return launchResult("unavailable");
    const possible = op.effects.some(e => e.state !== "not-started");
    const confirmed = possible && op.effects.every(e => e.state === "completed") && ["exited", "failed", "expired", "cancelled", "changed"].includes(op.state);
    return { ...launchResult(["prepared", "running"].includes(op.state) ? "unknown" : op.state, id, possible ? "possible" : "not-started", confirmed ? "confirmed" : possible ? "unknown" : "not-needed"), executed: false };
  } catch { return launchResult("unavailable"); }
}
export async function applyLaunch(input: LaunchRequest, fingerprint: string, io: LaunchIO) {
  try {
    input = Object.freeze(validate(launchRequestSchema, input)); const plan = prepareLaunch(input, io);
    if (plan.fingerprint !== fingerprint) return launchResult("changed");
    if (!VNEXT_WINDOWS_LOCAL_ACCEPTED || process.platform !== "win32") return launchResult("pending-acceptance");
    return await io.store.withUseLock(input.profileId, input.profileId, async owns => {
      const pending = io.store.listLaunchOperations(input.profileId).find(o => !["exited", "failed", "expired", "cancelled", "changed"].includes(o.state));
      if (pending) return { ...launchOperationStatus(pending.operationId, io.store), status: "recovery-required" };
      return executeLaunch(input, fingerprint, io, owns);
    });
  } catch (e) { return launchResult(e instanceof ProFeatureError ? "pro-required" : e instanceof VNextError && e.reason === "lock-present" ? "recovery-required" : "unavailable"); }
}
async function executeLaunch(input: LaunchRequest, fingerprint: string, io: LaunchIO, owns: () => boolean) {
  let record: OperationSnapshot | null = null, entered = false, started = false;
  try {
    const plan = prepareLaunch(input, io), clock = io.now ?? Date.now; let approvedAt: number | null = null;
    if (plan.fingerprint !== fingerprint) return launchResult("changed");
    const current = async () => {
      try {
        if (!owns() || io.signal?.aborted) return false;
        const credentials = plan.profile.bindingIds.map(id => plan.catalog.credentials.find(c => c.id === plan.catalog.bindings.find(b => b.id === id)!.credentialId)!);
        if (credentials.some(c => c.locator.kind !== "v3" && io.legacyStatus?.(c.locator, plan.catalog, plan.context) === "unavailable")) return false;
        if ((await presenceAll(io.presence, credentials.map(c => c.locator))).some(state => state !== "present")) return false;
        assertProFeature("deploy", io.licenseOptions);
        const fresh = io.store.readCatalog()?.catalog;
        return Boolean(fresh && owns() && sameProject(plan.context, inspectProject(input.project)) && plan.snapshot.current() &&
          usageBasis(fresh, plan.profile.bindingIds, plan.profile.id) === plan.basis &&
          (started || approvedAt === null || clock() >= approvedAt && clock() - approvedAt <= 60_000));
      } catch { return false; }
    };
    if (!await current()) return launchResult("changed");
    const now = time(), operation = validate(operationSchema, { schemaVersion: 1, operationId: randomUUID(), kind: "local-launch", projectId: plan.profile.projectId,
      expectedCatalogRevision: plan.catalog.revision, boundBasis: { fingerprint, previousGenerationId: null, targetId: plan.profile.id,
        targetRevision: plan.profile.revision, projectRevision: plan.catalog.projects.find(p => p.id === plan.profile.projectId)!.revision, bindingRevision: null },
      state: "consent-needed", timestamps: { createdAt: now, updatedAt: now }, effects: [{ targetId: plan.profile.id, state: "not-started" }], authority: "none" });
    record = io.store.saveOperation(null, operation);
    const decision = await io.human.approve(plan); approvedAt = decision === "approved" ? clock() : null;
    if (!await current() || decision !== "approved") {
      const status = decision === "declined" ? "cancelled" : "changed";
      io.store.saveOperation(record, { ...record.operation, state: status, timestamps: { ...record.operation.timestamps, updatedAt: time() } });
      return launchResult(decision === "unavailable" ? "unavailable" : status, operation.operationId);
    }
    record = io.store.saveOperation(record, { ...record.operation, state: "prepared", timestamps: { ...record.operation.timestamps, updatedAt: time() }, effects: [{ targetId: plan.profile.id, state: "possible" }] });
    entered = true;
    const outcome = await io.handoff(plan, current, () => {
      started = true; record = io.store.saveOperation(record, { ...record!.operation, state: "running", timestamps: { ...record!.operation.timestamps, updatedAt: time() } });
    }, io.signal);
    const uncertain = outcome.treeTermination === "unknown" || outcome.status === "unknown";
    record = io.store.saveOperation(record, { ...record.operation, state: uncertain ? "unknown" : outcome.status,
      timestamps: { ...record.operation.timestamps, updatedAt: time() }, effects: [{ targetId: plan.profile.id, state: uncertain ? "unknown" : "completed" }] });
    return launchResult(record.operation.state, record.operation.operationId, outcome.execution, outcome.treeTermination);
  } catch { return launchResult(record ? "unknown" : "unavailable", record?.operation.operationId ?? null, entered ? "possible" : "not-started", entered ? "unknown" : "not-needed"); }
}
