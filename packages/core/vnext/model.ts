import { z } from "zod";
import { toAccount } from "../vault/naming.js";

// These records contain references and human-authored metadata, never values.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.iso.datetime();
const label = z.string().min(1).max(80).regex(/^[^\x00-\x1f\x7f\\/]+$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const variableSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const legacyName = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const legacyProject = z.string().regex(/^[0-9a-f]{16}$/);
const v1Ref = z.discriminatedUnion("scope", [
  z.strictObject({ name: legacyName, scope: z.literal("user"), projectId: z.null() }),
  z.strictObject({ name: legacyName, scope: z.literal("project"), projectId: legacyProject })
]);
const v2Base = { scope: z.literal("project"), projectId: legacyProject };
const legacyEnvironment = z.enum(["development", "preview", "production"]);
const v2Ref = z.discriminatedUnion("service", [
  z.strictObject({ ...v2Base, name: z.literal("RESEND_API_KEY"), service: z.literal("resend"), environment: legacyEnvironment }),
  z.strictObject({ ...v2Base, name: z.literal("CLERK_SECRET_KEY"), service: z.literal("clerk"), environment: legacyEnvironment }),
  z.strictObject({ ...v2Base, name: z.literal("OPENAI_API_KEY"), service: z.literal("openai"), environment: legacyEnvironment }),
  z.strictObject({ ...v2Base, name: z.literal("STRIPE_API_KEY"), service: z.literal("stripe-test"), environment: z.enum(["development", "preview"]) })
]);
export const locatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("v1"), ref: v1Ref }),
  z.strictObject({ kind: z.literal("v2"), ref: v2Ref }),
  z.strictObject({ kind: z.literal("v3"), id: uuid, generationId: uuid })
]);
export type Locator = z.infer<typeof locatorSchema>;
export function locatorAccount(input: Locator): string {
  const locator = validate(locatorSchema, input);
  return locator.kind === "v3" ? `v3|credential|${locator.id}|${locator.generationId}` : toAccount(locator.ref);
}

export const credentialSchema = z.strictObject({
  id: uuid, label, locator: locatorSchema,
  generation: z.union([revision.min(1), z.literal("legacy-unversioned")]),
  classification: z.enum(["unknown", "nonproduction", "production"]), createdAt: timestamp, revisedAt: timestamp
}).superRefine((c, ctx) => {
  if (c.locator.kind === "v3" ? c.locator.id !== c.id || typeof c.generation !== "number" : c.generation !== "legacy-unversioned") {
    ctx.addIssue({ code: "custom", message: "Invalid generation identity" });
  }
  if (c.revisedAt < c.createdAt) ctx.addIssue({ code: "custom", message: "Invalid timestamps" });
});
const absolutePath = z.string().min(1).max(4096).refine(p => !/[\x00-\x1f]/.test(p) && (/^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p)));
const relativePath = z.string().min(1).max(1024).refine(p =>
  !/[\\:\x00-\x1f]/.test(p) && !p.startsWith("/") && p.split("/").every(s => !!s && s !== "." && s !== ".."));
export const projectSchema = z.strictObject({ id: uuid, canonicalPath: absolutePath,
  directoryIdentity: z.strictObject({ dev: z.string().regex(/^(0|[1-9][0-9]{0,39})$/), ino: z.string().regex(/^(0|[1-9][0-9]{0,39})$/),
    birthtimeNs: z.string().regex(/^(0|[1-9][0-9]{0,39})$/) }), revision });
export const environmentSchema = z.strictObject({ id: uuid, projectId: uuid, label: identifier,
  risk: z.enum(["unknown", "nonproduction", "production"]), revision });
export const bindingSchema = z.strictObject({ id: uuid, projectId: uuid, environmentId: uuid,
  variableName: variableSchema, credentialId: uuid, revision });
const targetBase = { id: uuid, projectId: uuid, providerAccountId: identifier, resourceId: identifier,
  applicationEnvironment: identifier, revision, reviewedAt: timestamp };
export const destinationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...targetBase, kind: z.literal("cloudflare"), canonicalConfigRelativePath: relativePath,
    configSection: z.union([z.literal("top-level"), identifier]) }),
  z.strictObject({ ...targetBase, kind: z.literal("vercel"), applicationEnvironment: legacyEnvironment }),
  z.strictObject({ ...targetBase, kind: z.literal("github-actions"), resourceId: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    applicationEnvironment: z.union([z.literal("repository"), identifier]) })
]);
const runtime = z.strictObject({ executable: absolutePath, fingerprint: digest });
const launchBase = { id: uuid, projectId: uuid, runtimeIdentity: runtime, cwd: relativePath.or(z.literal(".")),
  bindingIds: z.array(uuid).min(1).max(128), maxDurationSeconds: z.number().int().min(1).max(7200), revision, reviewedAt: timestamp };
export const launchProfileSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...launchBase, kind: z.literal("node-entry"), approvedEntryOrScript: relativePath }),
  z.strictObject({ ...launchBase, kind: z.literal("python-entry"), approvedEntryOrScript: relativePath }),
  z.strictObject({ ...launchBase, kind: z.literal("python-module"), approvedEntryOrScript: z.string().regex(/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/) }),
  z.strictObject({ ...launchBase, kind: z.literal("node-package-script"), approvedEntryOrScript: z.enum(["dev", "start"]),
    packageManifestRevision: z.strictObject({ manifestFingerprint: digest, lockfileFingerprint: digest,
      scriptDefinition: z.string().min(1).max(4096).regex(/^[^\x00\r\n]+$/), packageManagerIdentity: runtime }) })
]);
export const catalogSchema = z.strictObject({ schemaVersion: z.literal(1), revision,
  credentials: z.array(credentialSchema).max(4096), projects: z.array(projectSchema).max(4096),
  environments: z.array(environmentSchema).max(4096), bindings: z.array(bindingSchema).max(16384),
  destinations: z.array(destinationSchema).max(4096), launchProfiles: z.array(launchProfileSchema).max(4096)
}).superRefine((c, ctx) => {
  const fail = () => ctx.addIssue({ code: "custom", message: "Conflicting catalog references" });
  const all = [...c.credentials, ...c.projects, ...c.environments, ...c.bindings, ...c.destinations, ...c.launchProfiles];
  if (new Set(all.map(r => r.id)).size !== all.length) fail();
  const projects = new Map(c.projects.map(p => [p.id, p]));
  const environments = new Map(c.environments.map(e => [e.id, e]));
  const credentials = new Set(c.credentials.map(r => r.id));
  const bindings = new Map(c.bindings.map(b => [b.id, b]));
  if (new Set(c.credentials.map(r => locatorAccount(r.locator))).size !== c.credentials.length) fail();
  if (new Set(c.projects.map(p => p.canonicalPath)).size !== c.projects.length) fail();
  if (new Set(c.projects.map(p => `${p.directoryIdentity.dev}:${p.directoryIdentity.ino}:${p.directoryIdentity.birthtimeNs}`)).size !== c.projects.length) fail();
  if (new Set(c.environments.map(e => `${e.projectId}:${e.label.toLowerCase()}`)).size !== c.environments.length) fail();
  for (const e of c.environments) if (!projects.has(e.projectId)) fail();
  const variables = new Set<string>();
  for (const b of c.bindings) {
    const slot = `${b.projectId}:${b.environmentId}:${b.variableName.toLowerCase()}`;
    if (!projects.has(b.projectId) || environments.get(b.environmentId)?.projectId !== b.projectId || !credentials.has(b.credentialId) || variables.has(slot)) fail();
    variables.add(slot);
  }
  for (const d of c.destinations) if (!projects.has(d.projectId)) fail();
  for (const p of c.launchProfiles) {
    if (!projects.has(p.projectId) || new Set(p.bindingIds).size !== p.bindingIds.length ||
      p.bindingIds.some(id => bindings.get(id)?.projectId !== p.projectId)) fail();
    if (new Set(p.bindingIds.map(id => bindings.get(id)?.variableName.toLowerCase())).size !== p.bindingIds.length) fail();
  }
});
export type Catalog = z.infer<typeof catalogSchema>;
export type Credential = z.infer<typeof credentialSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export function emptyCatalog(): Catalog {
  return { schemaVersion: 1, revision: 0, credentials: [], projects: [], environments: [], bindings: [], destinations: [], launchProfiles: [] };
}

export const operationSchema = z.strictObject({
  schemaVersion: z.literal(1), operationId: uuid,
  kind: z.enum(["registration", "binding", "cloudflare-use", "vercel-use", "github-use", "local-launch"]),
  projectId: uuid.optional(), bindingId: uuid.optional(), credentialId: uuid.optional(), candidateGenerationId: uuid.optional(),
  expectedCatalogRevision: revision,
  boundBasis: z.strictObject({ fingerprint: digest, previousGenerationId: uuid.nullable(),
    targetId: uuid.nullable(), targetRevision: revision.nullable(), projectRevision: revision.nullable(), bindingRevision: revision.nullable(),
    candidateCredential: credentialSchema.optional(), candidateCatalog: catalogSchema.optional(), previousProject: projectSchema.optional() }),
  state: z.enum(["prepared", "awaiting-human", "stored-uncommitted", "committed", "cancelled", "conflict", "unknown", "recovery-required",
    "planned", "consent-needed", "executing", "completed", "incomplete", "changed", "reviewable", "running", "exited", "failed", "expired"]),
  timestamps: z.strictObject({ createdAt: timestamp, updatedAt: timestamp }),
  effects: z.array(z.strictObject({ targetId: uuid, state: z.enum(["not-started", "possible", "completed", "failed", "unknown"]) })).max(128),
  authority: z.literal("none")
}).superRefine((o, ctx) => {
  const fail = () => ctx.addIssue({ code: "custom", message: "Invalid operation state" });
  if (o.timestamps.updatedAt < o.timestamps.createdAt || new Set(o.effects.map(e => e.targetId)).size !== o.effects.length) fail();
  if ((o.boundBasis.targetId === null) !== (o.boundBasis.targetRevision === null)) fail();
  const states = o.kind === "registration" ? ["prepared", "awaiting-human", "stored-uncommitted", "committed", "cancelled", "conflict", "unknown", "recovery-required"] :
    o.kind === "local-launch" ? ["reviewable", "consent-needed", "prepared", "running", "exited", "failed", "expired", "cancelled", "unknown", "changed", "recovery-required"] :
    ["planned", "consent-needed", "prepared", "executing", "completed", "incomplete", "unknown", "changed", "cancelled", "recovery-required"];
  if (!states.includes(o.state)) fail();
  if (o.kind === "registration" && (!o.credentialId || !o.candidateGenerationId || o.effects.length || o.boundBasis.targetId !== null)) fail();
  const candidate = o.boundBasis.candidateCredential;
  if (o.kind === "registration" ? !candidate || candidate.id !== o.credentialId || candidate.locator.kind !== "v3" ||
    candidate.locator.generationId !== o.candidateGenerationId : candidate !== undefined) fail();
  const proposed = o.boundBasis.candidateCatalog;
  if (o.kind === "binding" ? !proposed || !o.projectId || proposed.revision !== o.expectedCatalogRevision + 1 ||
    !proposed.projects.some(p => p.id === o.projectId) || o.effects.length !== 0 : proposed !== undefined) fail();
  if (o.boundBasis.previousProject && (o.kind !== "binding" || o.boundBasis.previousProject.id !== o.projectId)) fail();
});
export type Operation = z.infer<typeof operationSchema>;

// Errors from validators may contain caller data. Collapse them at the core boundary.
export class VNextError extends Error {
  constructor(readonly reason: "invalid-data" | "unsafe-path" | "unavailable" | "conflict" | "lock-present" | "temporary-file-present" | "capacity" | "unsupported-owner") {
    super(`Secret metadata: ${reason}`); this.name = "VNextError";
  }
}
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new VNextError("invalid-data");
  return result.data;
}
