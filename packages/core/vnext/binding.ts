import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { CatalogStore, type CatalogSnapshot } from "./files.js";
import { catalogSchema, credentialSchema, emptyCatalog, locatorAccount, operationSchema, validate, VNextError, type Catalog, type Credential, type Operation } from "./model.js";
import { catalogFingerprint } from "./registration.js";
import { credentialPresence, discoveryRequestSchema, presenceAll, type DiscoveryIO } from "./discovery.js";
import { findProject, inspectProject, sameProject, type ProjectContext } from "./project.js";

export const bindingRequestSchema = discoveryRequestSchema.required({ environment: true, variable: true }).extend({
  credentialId: z.uuidv4().optional(), risk: z.enum(["unknown", "nonproduction", "production"]).optional()
});
export type BindingRequest = z.infer<typeof bindingRequestSchema>;
export interface BindingPlan {
  request: BindingRequest; context: ProjectContext; snapshot: CatalogSnapshot | null; catalog: Catalog;
  candidates: Credential[]; sources: Record<string, string>; fingerprint: string; previousBindingId: string | null;
}
export interface BindingIO extends DiscoveryIO {
  store: Pick<CatalogStore, "readCatalog" | "compareAndSwap" | "readOperation" | "saveOperation">;
  human: { choose(plan: BindingPlan): Promise<{ status: "confirmed"; index: number } | { status: "cancelled" | "unavailable" }> };
}
const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const now = () => new Date().toISOString();
export const bindingResultSchema = z.strictObject({ schemaVersion: z.literal(1), permission: z.literal("none"), executed: z.literal(false),
  status: z.enum(["reviewable", "completed", "unchanged", "cancelled", "changed", "unknown", "unavailable", "recovery-required", "pending-acceptance"]),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(), operationId: z.uuidv4().nullable(), bindingId: z.uuidv4().nullable() });
export type BindingResult = z.infer<typeof bindingResultSchema>;
export const bindingResult = (status: BindingResult["status"], fingerprint: string | null = null, operationId: string | null = null, bindingId: string | null = null): BindingResult =>
  validate(bindingResultSchema, { schemaVersion: 1, permission: "none", executed: false, status, fingerprint, operationId, bindingId });

/** Read-only proposal. Candidate IDs, labels, locators and other projects stay internal. */
export async function prepareBinding(input: BindingRequest, io: DiscoveryIO): Promise<BindingPlan> {
  const request = validate(bindingRequestSchema, input), context = (io.project ?? inspectProject)(request.project);
  const snapshot = io.store.readCatalog(), catalog = snapshot?.catalog ?? emptyCatalog(), project = findProject(catalog, context);
  const environment = catalog.environments.find(e => e.projectId === project?.id && e.label.toLowerCase() === request.environment.toLowerCase());
  if (environment && request.risk !== undefined && request.risk !== environment.risk) throw new VNextError("conflict");
  const previous = catalog.bindings.find(b => b.projectId === project?.id && b.environmentId === environment?.id && b.variableName.toLowerCase() === request.variable.toLowerCase());
  const candidates: Credential[] = [];
  const relevant = request.credentialId ? catalog.credentials.filter(c => c.id === request.credentialId) : catalog.credentials;
  const states = await presenceAll(io.presence, relevant.map(c => c.locator));
  for (const [i, credential] of relevant.entries()) {
    const state = credential.locator.kind !== "v3" && io.legacyStatus?.(credential.locator, catalog, context) === "unavailable" ? "unavailable" : states[i];
    if (state === "unavailable" && request.credentialId) throw new VNextError("unavailable");
    if (state === "present") candidates.push(credential);
  }
  const legacy = request.credentialId ? { status: "available" as const, locators: [], sources: {} } : await io.legacy(context);
  if (legacy.status === "unavailable") throw new VNextError("unavailable");
  for (const locator of legacy.locators) {
    if (locator.kind === "v3" || candidates.some(c => locatorAccount(c.locator) === locatorAccount(locator))) continue;
    // Ephemeral ID is deliberately not part of the plan fingerprint or Agent projection.
    // The actual alias is saved only after the owner chooses this exact locator.
    const label = `${locator.ref.name} (${locator.kind}; ${locator.ref.scope}${locator.kind === "v2" ? `; ${locator.ref.environment}` : ""})`;
    candidates.push(validate(credentialSchema, { id: randomUUID(), label: label.slice(0, 80), locator, generation: "legacy-unversioned",
      classification: "unknown", createdAt: "1970-01-01T00:00:00.000Z", revisedAt: "1970-01-01T00:00:00.000Z" }));
  }
  const selected = request.credentialId ? candidates.filter(c => c.id === request.credentialId) : candidates;
  if (!selected.length) throw new VNextError("unavailable");
  const fingerprint = digest({ catalog: catalogFingerprint(catalog), context, environment: request.environment.toLowerCase(), variable: request.variable.toLowerCase(),
    risk: request.risk ?? environment?.risk ?? "unknown", credentialId: request.credentialId ?? null,
    candidates: selected.map(c => ({ locator: c.locator, generation: c.generation, label: c.label, classification: c.classification,
      source: legacy.sources?.[locatorAccount(c.locator)] ?? null })) });
  return { request, context, snapshot, catalog, candidates: selected, sources: legacy.sources ?? {}, fingerprint, previousBindingId: previous?.id ?? null };
}
export function projectBindingPlan(plan: BindingPlan): BindingResult {
  const previous = plan.catalog.bindings.find(b => b.id === plan.previousBindingId);
  return bindingResult(previous && plan.request.credentialId === previous.credentialId ? "unchanged" : "reviewable", plan.fingerprint, null, previous?.id ?? null);
}

/** No OS write and no value move. Only the independent Human Plane selects a candidate. */
export async function applyBinding(input: BindingRequest, expectedFingerprint: string, io: BindingIO): Promise<BindingResult> {
  let operation: Operation | null = null;
  try {
    if (!/^[0-9a-f]{64}$/.test(expectedFingerprint)) throw new VNextError("invalid-data");
    const plan = await prepareBinding(input, io);
    if (expectedFingerprint !== plan.fingerprint) return bindingResult("changed");
    const projection = projectBindingPlan(plan);
    if (projection.status === "unchanged") return projection;
    const choice = await io.human.choose(plan);
    if (choice.status !== "confirmed") return bindingResult(choice.status);
    if (!Number.isInteger(choice.index) || choice.index < 0 || choice.index >= plan.candidates.length) throw new VNextError("invalid-data");
    const selected = plan.candidates[choice.index];
    if (!sameProject(plan.context, (io.project ?? inspectProject)(input.project)) || await credentialPresence(io, selected.locator, plan.catalog, plan.context) !== "present") return bindingResult("changed");
    // Re-read all legacy metadata and candidate presence after the Human Plane.
    const fresh = await prepareBinding(input, io);
    if (fresh.fingerprint !== plan.fingerprint) return bindingResult("changed");
    let snapshot = plan.snapshot;
    if (!snapshot) snapshot = io.store.compareAndSwap(null, emptyCatalog());
    const catalog = structuredClone(snapshot.catalog), previousProject = findProject(catalog, plan.context);
    const project = previousProject ?? { ...plan.context, id: randomUUID(), revision: 1 };
    if (!previousProject) catalog.projects.push(project);
    let environment = catalog.environments.find(e => e.projectId === project.id && e.label.toLowerCase() === input.environment.toLowerCase());
    if (!environment) { environment = { id: randomUUID(), projectId: project.id, label: input.environment, risk: input.risk ?? "unknown", revision: 1 }; catalog.environments.push(environment); }
    const previous = catalog.bindings.find(b => b.id === plan.previousBindingId);
    if (previous?.credentialId === selected.id) return bindingResult("unchanged", plan.fingerprint, null, previous.id);
    if (!catalog.credentials.some(c => c.id === selected.id)) {
      if (selected.locator.kind === "v3") throw new VNextError("conflict");
      catalog.credentials.push({ ...selected, createdAt: now(), revisedAt: now() });
    }
    const binding = { id: previous?.id ?? randomUUID(), projectId: project.id, environmentId: environment.id,
      variableName: previous?.variableName ?? input.variable, credentialId: selected.id, revision: previous ? previous.revision + 1 : 1 };
    catalog.bindings = catalog.bindings.filter(b => b.id !== previous?.id); catalog.bindings.push(binding); catalog.revision++;
    validate(catalogSchema, catalog);
    operation = makeBindingOperation(snapshot.catalog, catalog, project.id, binding.id);
    let record = io.store.saveOperation(null, operation);
    operation = { ...operation, state: "executing", timestamps: { ...operation.timestamps, updatedAt: now() } };
    record = io.store.saveOperation(record, operation);
    io.store.compareAndSwap(snapshot, catalog);
    operation = { ...operation, state: "completed", timestamps: { ...operation.timestamps, updatedAt: now() } };
    io.store.saveOperation(record, operation);
    return bindingResult("completed", null, operation.operationId, binding.id);
  } catch { return bindingResult(operation ? "recovery-required" : "unavailable", null, operation?.operationId ?? null); }
}

export function makeBindingOperation(before: Catalog, after: Catalog, projectId: string, bindingId?: string): Operation {
  const time = now();
  return validate(operationSchema, { schemaVersion: 1, operationId: randomUUID(), kind: "binding", projectId, ...(bindingId ? { bindingId } : {}),
    expectedCatalogRevision: before.revision, boundBasis: { fingerprint: catalogFingerprint(before), previousGenerationId: null,
      targetId: null, targetRevision: null, projectRevision: before.projects.find(p => p.id === projectId)?.revision ?? null,
      bindingRevision: before.bindings.find(b => b.id === bindingId)?.revision ?? null, candidateCatalog: after,
      ...(before.projects.find(p => p.id === projectId) ? { previousProject: before.projects.find(p => p.id === projectId) } : {}) },
    state: "prepared", timestamps: { createdAt: time, updatedAt: time }, effects: [], authority: "none" });
}
/** Recovery observes an exact completed CAS. It never repeats UI or applies a pending proposal. */
export function recoverBinding(operationId: string, store: BindingIO["store"]): BindingResult {
  try {
    const record = store.readOperation(operationId);
    if (!record || record.operation.kind !== "binding") return bindingResult("unavailable");
    const operation = record.operation;
    if (operation.state === "completed") return bindingResult("completed", null, operationId, operation.bindingId ?? null);
    const catalog = store.readCatalog()?.catalog;
    if (catalog && catalogFingerprint(catalog) === catalogFingerprint(operation.boundBasis.candidateCatalog!)) {
      store.saveOperation(record, { ...operation, state: "completed", timestamps: { ...operation.timestamps, updatedAt: now() } });
      return bindingResult("completed", null, operationId, operation.bindingId ?? null);
    }
    return bindingResult("recovery-required", null, operationId);
  } catch { return bindingResult("unavailable"); }
}
