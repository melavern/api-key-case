import { userInfo } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { ConnectionStateStore, readHistoricalCredentialRegistration } from "../agent/connection-state.js";
import { resolveTrustedHomeDirectory } from "../deploy/which.js";
import { deriveProjectId } from "../vault/naming.js";
import { CatalogStore } from "./files.js";
import { readLegacyIndex, legacyV2Locators } from "./legacy.js";
import { emptyCatalog, locatorAccount, variableSchema, validate, VNextError, type Catalog, type Locator } from "./model.js";
import { findProject, inspectProject, type ProjectContext } from "./project.js";
import { discover, discoverySchema, type Discovery } from "./status.js";

export const discoveryRequestSchema = z.strictObject({ project: z.string().min(1).max(4096),
  environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional(), variable: variableSchema.optional() });
export type DiscoveryRequest = z.infer<typeof discoveryRequestSchema>;
export type PresenceState = "present" | "absent" | "unavailable";
export interface Presence {
  (locator: Locator): Promise<PresenceState>;
  all?(locators: Locator[]): Promise<PresenceState[]>;
}
export async function presenceAll(presence: Presence, locators: Locator[]): Promise<PresenceState[]> {
  const states = presence.all ? await presence.all(locators) : await Promise.all(locators.map(presence));
  if (states.length !== locators.length || states.some(s => !["present", "absent", "unavailable"].includes(s))) throw new VNextError("unavailable");
  return states;
}
/** Internal candidates are Human Plane only. Never serialize them as a CLI result. */
export type LegacyCandidates = { status: "available" | "unavailable"; locators: Locator[]; sources?: Record<string, string> };
export interface DiscoveryIO {
  store: Pick<CatalogStore, "readCatalog">;
  project?: (path: string) => ProjectContext;
  presence: Presence;
  legacyStatus?(locator: Locator, catalog: Catalog, context: ProjectContext): "available" | "unavailable";
  legacy(context: ProjectContext): Promise<LegacyCandidates>;
}
export const discoveryReport = (status: Discovery["status"], reason: Discovery["reason"]): Discovery =>
  validate(discoverySchema, { schemaVersion: 1, permission: "none", executed: false, status, reason, bindings: [] });

export async function discoverCredentials(input: DiscoveryRequest, io: DiscoveryIO): Promise<Discovery> {
  try {
    const request = validate(discoveryRequestSchema, input), context = (io.project ?? inspectProject)(request.project);
    const catalog = io.store.readCatalog()?.catalog ?? emptyCatalog(), project = findProject(catalog, context);
    if (project) {
      const environment = request.environment === undefined ? undefined : catalog.environments.find(e => e.projectId === project.id && e.label.toLowerCase() === request.environment!.toLowerCase());
      if (request.environment === undefined || environment) {
        const result = await discover(catalog, { projectId: project.id, ...context, environmentId: environment?.id, variableName: request.variable }, locator => credentialPresence(io, locator, catalog, context));
        if (!["not-associated", "candidate-review"].includes(result.reason)) return result;
      }
    }
    const legacy = await io.legacy(context);
    if (legacy.status === "unavailable") return discoveryReport("unavailable", "metadata-unavailable");
    return catalog.credentials.length || legacy.locators.length ? discoveryReport("selection-required", "candidate-review") : discoveryReport("unknown", "not-associated");
  } catch { return discoveryReport("unavailable", "metadata-unavailable"); }
}

export async function credentialPresence(io: DiscoveryIO, locator: Locator, catalog: Catalog, context: ProjectContext): ReturnType<Presence> {
  if (locator.kind !== "v3" && io.legacyStatus?.(locator, catalog, context) === "unavailable") return "unavailable";
  return io.presence(locator);
}

/** Fresh legacy metadata validity, independent of presence and generation claims. */
export function inspectLegacyStatus(locator: Locator, catalog: Catalog, context: ProjectContext, baseDir?: string): "available" | "unavailable" {
  if (locator.kind === "v3") return "available";
  try {
    const home = baseDir ?? (process.platform === "win32" ? resolveTrustedHomeDirectory() : userInfo().homedir);
    if (!home) return "unavailable";
    if (locator.kind === "v1") return readLegacyIndex(join(home, ".api-key-case", "index.json")).status === "unavailable" ? "unavailable" : "available";
    const source = deriveProjectId(context.canonicalPath) === locator.ref.projectId ? context :
      catalog.projects.find(p => createHash("sha256").update(p.canonicalPath).digest("hex").slice(0, 16) === locator.ref.projectId);
    if (!source) {
      const record = readHistoricalCredentialRegistration(locator.ref, home);
      return record.status === "unavailable" || record.status === "available" && record.value.state !== "settled" ? "unavailable" : "available";
    }
    if (!source || JSON.stringify(inspectProject(source.canonicalPath)) !== JSON.stringify({ canonicalPath: source.canonicalPath, directoryIdentity: source.directoryIdentity })) return "unavailable";
    const record = new ConnectionStateStore(source.canonicalPath, home).readCredentialRegistration(locator.ref);
    return record.status === "unavailable" || record.status === "available" && record.value.state !== "settled" ? "unavailable" : "available";
  } catch { return "unavailable"; }
}

/** Read only known legacy locators, never enumerate OS credentials or repair old files. */
export async function inspectLegacyCandidates(context: ProjectContext, presence: Presence, baseDir?: string): Promise<LegacyCandidates> {
  try {
    const home = baseDir ?? (process.platform === "win32" ? resolveTrustedHomeDirectory() : userInfo().homedir);
    if (!home) throw new VNextError("unsupported-owner");
    const index = readLegacyIndex(join(home, ".api-key-case", "index.json"));
    if (index.status === "unavailable") return { status: "unavailable", locators: [] };
    const locators: Locator[] = [], sources: Record<string, string> = index.status === "available" ? { ...index.sources } : {};
    const v1States = await presenceAll(presence, index.locators);
    for (const [i, locator] of index.locators.entries()) {
      const state = v1States[i];
      if (state !== "present") return { status: "unavailable", locators: [] };
      locators.push(locator);
    }
    const connections = new ConnectionStateStore(context.canonicalPath, home);
    const v2 = legacyV2Locators(deriveProjectId(context.canonicalPath)), v2States = await presenceAll(presence, v2);
    for (const [i, locator] of v2.entries()) {
      if (locator.kind !== "v2") throw new VNextError("invalid-data");
      const metadata = connections.readCredentialRegistration(locator.ref);
      if (metadata.status === "unavailable" || metadata.status === "available" && metadata.value.state !== "settled") return { status: "unavailable", locators: [] };
      const state = v2States[i];
      if (state === "unavailable" || state === "absent" && metadata.status === "available") return { status: "unavailable", locators: [] };
      if (state === "present") { locators.push(locator); sources[locatorAccount(locator)] = context.canonicalPath; }
    }
    return { status: "available", locators, sources };
  } catch { return { status: "unavailable", locators: [] }; }
}
