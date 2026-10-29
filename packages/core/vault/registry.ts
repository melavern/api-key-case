import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SecretScope } from "./types.js";

export type RegistryEntry = {
  name: string;
  scope: SecretScope;
  projectId: string | null;
  projectPath: string | null;
  createdAt: string;
  updatedAt: string;
};

type RegistryFile = {
  version: 1;
  entries: RegistryEntry[];
};

// Overridable only for tests, so `npm test` never touches the real user
// profile's vault index. Not exposed as a CLI flag or env var.
function registryPath(baseDir?: string): string {
  return join(baseDir ?? homedir(), ".api-key-case", "index.json");
}

export function readRegistry(baseDir?: string): RegistryEntry[] {
  const path = registryPath(baseDir);
  if (!existsSync(path)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RegistryFile;
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    console.error("Warning: vault index is corrupted; treating it as empty.");
    return [];
  }
}

export function upsertRegistryEntry(
  entry: {
    name: string;
    scope: SecretScope;
    projectId: string | null;
    projectPath: string | null;
  },
  baseDir?: string
): void {
  const entries = readRegistry(baseDir);
  const now = new Date().toISOString();
  const existing = entries.find(
    (item) => item.name === entry.name && item.scope === entry.scope && item.projectId === entry.projectId
  );

  if (existing) {
    const previous = Date.parse(existing.updatedAt);
    // A timestamp is the non-secret credential revision used to invalidate
    // observations. Keep it unique even when two saves happen in one clock tick.
    existing.updatedAt = Number.isFinite(previous) && Date.parse(now) <= previous
      ? new Date(previous + 1).toISOString()
      : now;
    existing.projectPath = entry.projectPath;
  } else {
    entries.push({
      name: entry.name,
      scope: entry.scope,
      projectId: entry.projectId,
      projectPath: entry.projectPath,
      createdAt: now,
      updatedAt: now
    });
  }

  writeRegistry(entries, baseDir);
}

export function removeRegistryEntry(
  entry: {
    name: string;
    scope: SecretScope;
    projectId: string | null;
  },
  baseDir?: string
): void {
  const entries = readRegistry(baseDir).filter(
    (item) => !(item.name === entry.name && item.scope === entry.scope && item.projectId === entry.projectId)
  );
  writeRegistry(entries, baseDir);
}

function writeRegistry(entries: RegistryEntry[], baseDir?: string): void {
  const path = registryPath(baseDir);
  const dir = join(baseDir ?? homedir(), ".api-key-case");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const payload: RegistryFile = { version: 1, entries };
  writeFileSync(path, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
}
