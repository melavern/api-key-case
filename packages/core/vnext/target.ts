import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { inspectCloudflareConfig, listCloudflareTargets, type CloudflareConfigBinding } from "../deploy/cloudflare-targets.js";
import { CatalogStore, type CatalogSnapshot } from "./files.js";
import { catalogSchema, emptyCatalog, validate, VNextError, type Catalog } from "./model.js";
import { catalogFingerprint } from "./registration.js";
import { makeBindingOperation } from "./binding.js";
import { findProject, inspectProject, type ProjectContext } from "./project.js";

export const targetRequestSchema = z.strictObject({ project: z.string().min(1).max(4096),
  environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/), config: z.string().min(1).max(240).optional() });
export type TargetRequest = z.infer<typeof targetRequestSchema>;
export type CloudflareDestination = Extract<Catalog["destinations"][number], { kind: "cloudflare" }>;
export interface TargetPlan { request: TargetRequest; context: ProjectContext; snapshot: CatalogSnapshot | null; catalog: Catalog;
  candidates: CloudflareConfigBinding[]; fingerprint: string }
export interface TargetIO {
  store: Pick<CatalogStore, "readCatalog" | "compareAndSwap" | "readOperation" | "saveOperation">;
  human: { choose(plan: TargetPlan): Promise<{ status: "confirmed"; index: number } | { status: "cancelled" | "unavailable" }> };
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const configurationNames = new Set(["wrangler.jsonc", "wrangler.json", "wrangler.toml"]);
/** Bounded ordinary configuration discovery. Directory entries only; no secret files are opened. */
function configPaths(root: string): string[] {
  const paths: string[] = []; let visited = 0;
  const walk = (relative: string, depth: number) => {
    if (++visited > 256) throw new VNextError("capacity");
    const names = readdirSync(join(root, relative), { withFileTypes: true });
    if (names.length > 4096) throw new VNextError("capacity");
    for (const entry of names) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isFile() && configurationNames.has(entry.name)) paths.push(path);
      else if (depth < 4 && entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name) &&
        !["node_modules", "dist", "build", "vendor", "coverage"].includes(entry.name)) {
        if (!lstatSync(join(root, path)).isSymbolicLink()) walk(path, depth + 1);
      }
    }
  };
  walk("", 0);
  // Existing legacy selections may use nonstandard config filenames. Only read them.
  for (const target of listCloudflareTargets(root).targets) paths.push(target.config);
  return [...new Set(paths)].sort();
}
export function prepareTarget(input: TargetRequest, io: Pick<TargetIO, "store">): TargetPlan {
  const request = validate(targetRequestSchema, input), context = inspectProject(request.project);
  const snapshot = io.store.readCatalog(), catalog = snapshot?.catalog ?? emptyCatalog();
  findProject(catalog, context); // A copied/moved project cannot inherit a prior registration.
  const paths = request.config ? [request.config] : configPaths(context.canonicalPath);
  const candidates = paths.flatMap(path => inspectCloudflareConfig(context.canonicalPath, path));
  if (!candidates.length || candidates.length > 128) throw new VNextError("unavailable");
  const fingerprint = digest({ catalog: catalogFingerprint(catalog), context, request, candidates });
  return { request, context, snapshot, catalog, candidates, fingerprint };
}
export function projectTargetPlan(plan: TargetPlan) {
  const project = findProject(plan.catalog, plan.context);
  return { schemaVersion: 1, permission: "none", executed: false, status: "reviewable", fingerprint: plan.fingerprint,
    candidateCount: plan.candidates.length, selection: "human-plane-required",
    targets: plan.catalog.destinations.filter(d => d.projectId === project?.id && d.kind === "cloudflare" && d.applicationEnvironment === plan.request.environment)
      .map(d => ({ targetId: d.id, kind: d.kind, environment: d.applicationEnvironment, revision: d.revision })) };
}
export const targetResult = (status: string, operationId: string | null = null, targetId: string | null = null) =>
  ({ schemaVersion: 1, permission: "none", executed: false, status, operationId, targetId });
/** Registration is metadata only, with independent selection and exact post-dialog CAS. */
export async function registerTarget(input: TargetRequest, expectedFingerprint: string, io: TargetIO) {
  let operationId: string | null = null;
  try {
    const plan = prepareTarget(input, io);
    if (plan.fingerprint !== expectedFingerprint) return targetResult("changed");
    const choice = await io.human.choose(plan);
    if (choice.status !== "confirmed") return targetResult(choice.status);
    if (!Number.isInteger(choice.index) || choice.index < 0 || choice.index >= plan.candidates.length) throw new VNextError("invalid-data");
    if (prepareTarget(input, io).fingerprint !== plan.fingerprint) return targetResult("changed");
    const selected = plan.candidates[choice.index].target;
    let snapshot = plan.snapshot;
    if (!snapshot) snapshot = io.store.compareAndSwap(null, emptyCatalog());
    const catalog = structuredClone(snapshot.catalog), existing = findProject(catalog, plan.context);
    const project = existing ?? { ...plan.context, id: randomUUID(), revision: 1 };
    if (!existing) catalog.projects.push(project);
    const match = catalog.destinations.find(d => d.kind === "cloudflare" && d.projectId === project.id &&
      d.providerAccountId === selected.accountId && d.resourceId === selected.worker && d.applicationEnvironment === input.environment &&
      d.canonicalConfigRelativePath === selected.config && d.configSection === (selected.wranglerEnvironment ?? "top-level"));
    if (match) return targetResult("unchanged", null, match.id);
    const destination: CloudflareDestination = { id: randomUUID(), kind: "cloudflare", projectId: project.id,
      providerAccountId: selected.accountId, resourceId: selected.worker, applicationEnvironment: input.environment,
      canonicalConfigRelativePath: selected.config, configSection: selected.wranglerEnvironment ?? "top-level", revision: 1, reviewedAt: now() };
    catalog.destinations.push(destination); catalog.revision++; validate(catalogSchema, catalog);
    let operation = makeBindingOperation(snapshot.catalog, catalog, project.id); operationId = operation.operationId;
    let record = io.store.saveOperation(null, operation);
    operation = { ...operation, state: "executing", timestamps: { ...operation.timestamps, updatedAt: now() } };
    record = io.store.saveOperation(record, operation);
    io.store.compareAndSwap(snapshot, catalog);
    io.store.saveOperation(record, { ...operation, state: "completed", timestamps: { ...operation.timestamps, updatedAt: now() } });
    return targetResult("completed", operationId, destination.id);
  } catch { return targetResult(operationId ? "recovery-required" : "unavailable", operationId); }
}
