import { z } from "zod";
import { release } from "node:os";
import { catalogSchema, validate, variableSchema, type Catalog, type Locator } from "./model.js";
import { VNEXT_WINDOWS_REGISTRATION_ACCEPTED, VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED, VNEXT_WINDOWS_LOCAL_ACCEPTED, VNEXT_WINDOWS_VERCEL_ACCEPTED, VNEXT_WINDOWS_GITHUB_ACCEPTED } from "./gates.js";

export const discoverySchema = z.strictObject({ schemaVersion: z.literal(1), permission: z.literal("none"), executed: z.literal(false),
  status: z.enum(["registered", "missing", "unknown", "unavailable", "selection-required"]),
  reason: z.enum(["present", "absent", "not-associated", "candidate-review", "metadata-unavailable", "context-mismatch", "store-unavailable", "selection-ambiguous"]),
  bindings: z.array(z.strictObject({ bindingId: z.uuid(), environmentId: z.uuid(), variableName: variableSchema,
    credentialId: z.uuid(), stability: z.enum(["managed-generation", "legacy-unversioned"]), generation: z.number().int().min(1).nullable() })).max(16384)
});
export type Discovery = z.infer<typeof discoverySchema>;
const report = (status: Discovery["status"], reason: Discovery["reason"], bindings: Discovery["bindings"] = []): Discovery =>
  validate(discoverySchema, { schemaVersion: 1, status, reason, bindings, permission: "none", executed: false });
export interface DiscoveryQuery { projectId: string; canonicalPath: string; directoryIdentity: Catalog["projects"][number]["directoryIdentity"]; environmentId?: string; variableName?: string }

/** Presence callback returns a closed state only; it cannot return a value. */
export async function discover(input: Catalog | null, query: DiscoveryQuery, presence: (locator: Locator) => Promise<"present" | "absent" | "unavailable">): Promise<Discovery> {
  try {
    if (!input) return report("unknown", "not-associated");
    const catalog = validate(catalogSchema, input);
    const project = catalog.projects.find(p => p.id === query.projectId);
    if (!project || project.canonicalPath !== query.canonicalPath || JSON.stringify(project.directoryIdentity) !== JSON.stringify(query.directoryIdentity)) return report("unavailable", "context-mismatch");
    if (query.variableName !== undefined) validate(variableSchema, query.variableName);
    const bindings = catalog.bindings.filter(b => b.projectId === project.id && (!query.environmentId || b.environmentId === query.environmentId) &&
      (query.variableName === undefined || b.variableName.toLowerCase() === query.variableName.toLowerCase()));
    if (!bindings.length) return catalog.credentials.length ? report("selection-required", "candidate-review") : report("unknown", "not-associated");
    if (!query.environmentId && new Set(bindings.map(b => b.environmentId)).size > 1) return report("selection-required", "selection-ambiguous");
    const projection: Discovery["bindings"] = []; const states: string[] = [];
    for (const b of bindings) {
      const credential = catalog.credentials.find(c => c.id === b.credentialId)!;
      const result = await presence(credential.locator);
      if (!["present", "absent", "unavailable"].includes(result)) return report("unavailable", "store-unavailable");
      states.push(result);
      projection.push({ bindingId: b.id, credentialId: b.credentialId, environmentId: b.environmentId, variableName: b.variableName,
        stability: credential.locator.kind === "v3" ? "managed-generation" : "legacy-unversioned", generation: typeof credential.generation === "number" ? credential.generation : null });
    }
    if (states.includes("unavailable")) return report("unavailable", "store-unavailable");
    if (states.every(s => s === "present")) return report("registered", "present", projection);
    if (states.every(s => s === "absent")) return report("missing", "absent", projection);
    return report("unknown", "selection-ambiguous", projection);
  } catch { return report("unavailable", "metadata-unavailable"); }
}

const gate = z.strictObject({ state: z.enum(["available", "unavailable", "pending-acceptance"]),
  reason: z.enum(["native-not-accepted", "unsupported-platform", "backend-unavailable", "accepted"]) });
export const capabilitySchema = z.strictObject({ schemaVersion: z.literal(1), permission: z.literal("none"), executed: z.literal(false),
  storage: gate, humanInput: gate, highRiskApproval: gate, cloudflareUse: gate, localUse: gate, vercelUse: gate, githubUse: gate });
/** Gate defaults are source-owned. Helper availability and prior legacy acceptance do not open vNext. */
function windowsBuild(): number | null {
  // A non-Windows host can only reach a Windows table through this internal test seam.
  if (process.platform !== "win32") return 22000;
  const value = Number(release().split(".")[2]); return Number.isSafeInteger(value) && value > 0 ? value : null;
}
export function capabilities(platform: NodeJS.Platform = process.platform, backend: "available" | "unavailable" = "unavailable", build: number | null = windowsBuild()): z.infer<typeof capabilitySchema> {
  const pending = { state: "pending-acceptance", reason: "native-not-accepted" } as const;
  const unsupported = { state: "unavailable", reason: "unsupported-platform" } as const;
  const feature = platform === "win32" || platform === "linux" ? pending : unsupported;
  const registration = platform === "win32" && VNEXT_WINDOWS_REGISTRATION_ACCEPTED
    ? backend === "available" ? { state: "available", reason: "accepted" } as const : { state: "unavailable", reason: "backend-unavailable" } as const : feature;
  const highRiskPlatform = platform === "win32" && (build === null || !Number.isSafeInteger(build) || build < 22000) ? unsupported : null;
  const cloudflare = highRiskPlatform ?? (platform === "win32" && VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED ? registration : feature);
  const local = highRiskPlatform ?? (platform === "win32" && VNEXT_WINDOWS_LOCAL_ACCEPTED ? registration : feature);
  const vercel = highRiskPlatform ?? (platform === "win32" && VNEXT_WINDOWS_VERCEL_ACCEPTED ? registration : feature);
  const github = highRiskPlatform ?? (platform === "win32" && VNEXT_WINDOWS_GITHUB_ACCEPTED ? registration : feature);
  return validate(capabilitySchema, { schemaVersion: 1, permission: "none", executed: false,
    storage: registration, humanInput: registration, highRiskApproval: cloudflare, cloudflareUse: cloudflare, localUse: local, vercelUse: vercel, githubUse: github });
}
