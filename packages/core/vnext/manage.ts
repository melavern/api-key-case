import { createHash } from "node:crypto";
import { z } from "zod";
import { bindingResult, makeBindingOperation, type BindingIO, type BindingResult } from "./binding.js";
import { validate, catalogSchema, VNextError, type Catalog } from "./model.js";
import { inspectProject, sameProject, type ProjectContext } from "./project.js";
import { catalogFingerprint } from "./registration.js";

export const manageRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("unlink"), bindingId: z.uuidv4() }),
  z.strictObject({ action: z.literal("relink"), bindingId: z.uuidv4(), project: z.string().min(1).max(4096) }),
  z.strictObject({ action: z.literal("classify-environment"), bindingId: z.uuidv4(), risk: z.enum(["unknown", "nonproduction", "production"]) })
]);
export type ManageRequest = z.infer<typeof manageRequestSchema>;
export interface ManagePlan {
  request: ManageRequest; before: Catalog; after: Catalog; projectId: string; context: ProjectContext;
  fingerprint: string; unchanged: boolean;
}
export interface ManageIO {
  store: BindingIO["store"]; project?: (path: string) => ProjectContext;
  human: { confirm(plan: ManagePlan): Promise<"confirmed" | "cancelled" | "unavailable"> };
}
export function prepareManagement(input: ManageRequest, io: Pick<ManageIO, "store" | "project">): ManagePlan {
  const request = validate(manageRequestSchema, input), before = io.store.readCatalog()?.catalog;
  if (!before) throw new VNextError("unavailable");
  const binding = before.bindings.find(b => b.id === request.bindingId), project = before.projects.find(p => p.id === binding?.projectId);
  if (!binding || !project) throw new VNextError("unavailable");
  const context = (io.project ?? inspectProject)(request.action === "relink" ? request.project : project.canonicalPath);
  const after = structuredClone(before), environment = before.environments.find(e => e.id === binding.environmentId)!;
  const unchanged = request.action === "relink" ? sameProject(project, context) : request.action === "classify-environment" && environment.risk === request.risk;
  if (request.action === "unlink") {
    if (!sameProject(project, context)) throw new VNextError("conflict");
    // A LaunchProfile cannot silently lose an input; keep it intact for explicit management.
    if (after.launchProfiles.some(p => p.bindingIds.includes(binding.id))) throw new VNextError("conflict");
    after.bindings = after.bindings.filter(b => b.id !== binding.id);
  } else if (request.action === "classify-environment") {
    if (!sameProject(project, context)) throw new VNextError("conflict");
    if (!unchanged) after.environments = after.environments.map(e => e.id === environment.id ? { ...e, risk: request.risk, revision: e.revision + 1 } : e);
  } else if (!unchanged) {
    if (after.projects.some(p => p.id !== project.id && (p.canonicalPath === context.canonicalPath || JSON.stringify(p.directoryIdentity) === JSON.stringify(context.directoryIdentity)))) throw new VNextError("conflict");
    // Relink changes association revision for every environment/Binding in this project.
    after.projects = after.projects.map(p => p.id === project.id ? { ...p, ...context, revision: p.revision + 1 } : p);
  }
  if (!unchanged) after.revision++;
  validate(catalogSchema, after);
  const fingerprint = createHash("sha256").update(JSON.stringify({ request, before: catalogFingerprint(before), context })).digest("hex");
  return { request, before, after, projectId: project.id, context, fingerprint, unchanged };
}
export function projectManagementPlan(plan: ManagePlan): BindingResult {
  return bindingResult(plan.unchanged ? "unchanged" : "reviewable", plan.fingerprint, null, plan.request.bindingId);
}
export async function applyManagement(input: ManageRequest, expectedFingerprint: string, io: ManageIO): Promise<BindingResult> {
  let operationId: string | null = null;
  try {
    const plan = prepareManagement(input, io);
    if (plan.fingerprint !== expectedFingerprint) return bindingResult("changed");
    if (plan.unchanged) return projectManagementPlan(plan);
    const confirmed = await io.human.confirm(plan);
    if (confirmed !== "confirmed") return bindingResult(confirmed);
    const fresh = prepareManagement(input, io);
    if (fresh.fingerprint !== plan.fingerprint) return bindingResult("changed");
    const snapshot = io.store.readCatalog();
    if (!snapshot || catalogFingerprint(snapshot.catalog) !== catalogFingerprint(plan.before)) return bindingResult("changed");
    const operation = makeBindingOperation(plan.before, plan.after, plan.projectId, input.bindingId); operationId = operation.operationId;
    let record = io.store.saveOperation(null, operation);
    record = io.store.saveOperation(record, { ...operation, state: "executing" });
    io.store.compareAndSwap(snapshot, plan.after);
    io.store.saveOperation(record, { ...operation, state: "completed", timestamps: { ...operation.timestamps, updatedAt: new Date().toISOString() } });
    return bindingResult("completed", null, operationId, input.bindingId);
  } catch { return bindingResult(operationId ? "recovery-required" : "unavailable", null, operationId); }
}
