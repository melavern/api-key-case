import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { inspectHostedTarget, type HostedDestination, type HostedSelection } from "../deploy/hosted-targets.js";
import { CatalogStore, type CatalogSnapshot } from "./files.js";
import { catalogSchema, emptyCatalog, validate, type Catalog } from "./model.js";
import { findProject, inspectProject, type ProjectContext } from "./project.js";
import { catalogFingerprint } from "./registration.js";
import { makeBindingOperation } from "./binding.js";
import { targetResult } from "./target.js";

export const hostedTargetRequestSchema = z.strictObject({ project: z.string().min(1).max(4096), kind: z.enum(["vercel", "github-actions"]),
  environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).refine(s => !/[\r\n]/.test(s)) });
export type HostedTargetRequest = z.infer<typeof hostedTargetRequestSchema>;
export interface HostedTargetPlan { request: HostedTargetRequest; catalog: Catalog; snapshot: CatalogSnapshot | null; context: ProjectContext; selection: HostedSelection; fingerprint: string }
export interface HostedTargetIO { store: Pick<CatalogStore, "readCatalog" | "compareAndSwap" | "saveOperation" | "readOperation">;
  human: { confirm(plan: HostedTargetPlan): Promise<"approved" | "declined" | "unavailable"> } }
export function prepareHostedTarget(input: HostedTargetRequest, io: Pick<HostedTargetIO, "store">): HostedTargetPlan {
  const request = validate(hostedTargetRequestSchema, input); if (request.kind === "vercel" && !["development", "preview", "production"].includes(request.environment)) throw Error("Destination unavailable.");
  const context = inspectProject(request.project), snapshot = io.store.readCatalog(), catalog = snapshot?.catalog ?? emptyCatalog(); findProject(catalog, context);
  const selection = inspectHostedTarget(context.canonicalPath, request.kind);
  const fingerprint = createHash("sha256").update(JSON.stringify({ request, context, catalog: catalogFingerprint(catalog), selection })).digest("hex");
  return { request, context, snapshot, catalog, selection, fingerprint };
}
export function projectHostedTargetPlan(plan: HostedTargetPlan) {
  const project = findProject(plan.catalog, plan.context);
  return { schemaVersion: 1, permission: "none", executed: false, status: "reviewable", fingerprint: plan.fingerprint, candidateCount: 1, selection: "human-plane-required",
    targets: plan.catalog.destinations.filter(d => d.projectId === project?.id && d.kind === plan.request.kind && d.applicationEnvironment === plan.request.environment)
      .map(d => ({ targetId: d.id, kind: d.kind, environment: d.applicationEnvironment, revision: d.revision })) };
}
export async function registerHostedTarget(input: HostedTargetRequest, fingerprint: string, io: HostedTargetIO) {
  let operationId: string | null = null;
  try {
    const plan = prepareHostedTarget(input, io); if (plan.fingerprint !== fingerprint) return targetResult("changed");
    const decision = await io.human.confirm(plan); if (decision !== "approved") return targetResult(decision === "declined" ? "cancelled" : "unavailable");
    if (prepareHostedTarget(input, io).fingerprint !== fingerprint) return targetResult("changed");
    let snapshot = plan.snapshot; if (!snapshot) snapshot = io.store.compareAndSwap(null, emptyCatalog());
    const catalog = structuredClone(snapshot.catalog), previous = findProject(catalog, plan.context), project = previous ?? { ...plan.context, id: randomUUID(), revision: 1 };
    if (!previous) catalog.projects.push(project);
    const existing = catalog.destinations.find(d => d.kind === input.kind && d.projectId === project.id && d.providerAccountId === plan.selection.account && d.resourceId === plan.selection.resource && d.applicationEnvironment === input.environment);
    if (existing) return targetResult("unchanged", null, existing.id);
    const destination = { id: randomUUID(), kind: input.kind, projectId: project.id, providerAccountId: plan.selection.account, resourceId: plan.selection.resource,
      applicationEnvironment: input.environment, revision: 1, reviewedAt: new Date().toISOString() } as HostedDestination;
    catalog.destinations.push(destination); catalog.revision++; validate(catalogSchema, catalog);
    const operation = makeBindingOperation(snapshot.catalog, catalog, project.id); operationId = operation.operationId;
    let record = io.store.saveOperation(null, operation); record = io.store.saveOperation(record, { ...operation, state: "executing" });
    io.store.compareAndSwap(snapshot, catalog); io.store.saveOperation(record, { ...record.operation, state: "completed", timestamps: { ...record.operation.timestamps, updatedAt: new Date().toISOString() } });
    return targetResult("completed", operationId, destination.id);
  } catch { return targetResult(operationId ? "recovery-required" : "unavailable", operationId); }
}
