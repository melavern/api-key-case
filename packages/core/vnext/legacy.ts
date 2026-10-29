import { z } from "zod";
import { locatorAccount, locatorSchema, validate, type Locator } from "./model.js";
import { parseMetadata } from "./json.js";
import { readMetadataFile } from "./files.js";

const time = z.iso.datetime();
const entry = z.strictObject({ name: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), scope: z.enum(["user", "project"]),
  projectId: z.string().regex(/^[0-9a-f]{16}$/).nullable(), projectPath: z.string().min(1).max(4096).regex(/^[^\x00-\x1f\x7f]+$/).nullable(), createdAt: time, updatedAt: time
}).refine(e => e.scope === "user" ? e.projectId === null && e.projectPath === null : e.projectId !== null && e.projectPath !== null);
const registry = z.strictObject({ version: z.literal(1), entries: z.array(entry).max(16384) });
export type LegacyIndex = { status: "available"; locators: Locator[]; sources: Record<string, string> } | { status: "not-recorded" | "unavailable"; locators: [] };

/** Internal Human Plane input only. No cross-project labels/paths are projected to agents. */
export function readLegacyIndex(path: string): LegacyIndex {
  try {
    const file = readMetadataFile(path);
    if (!file) return { status: "not-recorded", locators: [] };
    const parsed = validate(registry, parseMetadata(file.bytes));
    const locators = parsed.entries.map(e => validate(locatorSchema, { kind: "v1", ref: { name: e.name, scope: e.scope, projectId: e.projectId } }));
    if (new Set(locators.map(l => JSON.stringify(l))).size !== locators.length) return { status: "unavailable", locators: [] };
    const sources = Object.fromEntries(locators.map((locator, i) => [locatorAccount(locator), parsed.entries[i].projectPath ?? "Current OS user / 現在のOSユーザー共通"]));
    return { status: "available", locators, sources };
  } catch { return { status: "unavailable", locators: [] }; }
}

/** Exact eleven known accounts. Never enumerates a backend or falls back to v1. */
export function legacyV2Locators(projectId: string): Locator[] {
  const profiles = [["resend", "RESEND_API_KEY"], ["clerk", "CLERK_SECRET_KEY"], ["openai", "OPENAI_API_KEY"], ["stripe-test", "STRIPE_API_KEY"]] as const;
  return profiles.flatMap(([service, name]) => (service === "stripe-test" ? ["development", "preview"] : ["development", "preview", "production"])
    .map(environment => validate(locatorSchema, { kind: "v2", ref: { name, scope: "project", projectId, service, environment } })));
}
