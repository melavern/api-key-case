import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import type { DestinationTrustRef, SecretRef } from "./types.js";

export const VAULT_SERVICE = "api-key-case";

// The stored value of a destination trust record. The record's meaning is
// carried entirely by its account name; the value is a fixed constant so that
// nothing Secret-derived is ever written by this path.
export const DESTINATION_TRUST_MARKER = "api-key-case:destination-trust:v1";

const DESTINATION_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export function deriveProjectId(targetDir: string): string {
  const real = realpathSync(targetDir);
  const normalizedPath = real.replace(/\\/g, "/");
  // Windows normally treats path case as presentation. On a case-sensitive
  // filesystem, however, lowercasing would merge two distinct projects.
  const normalized = isCaseInsensitiveFilesystem(real)
    ? normalizedPath.toLowerCase()
    : normalizedPath;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function isCaseInsensitiveFilesystem(realPath: string): boolean {
  let current = realPath;
  const root = parse(realPath).root;

  while (current !== root) {
    const name = basename(current);
    if (/[A-Za-z]/.test(name)) {
      const alternateName = [...name]
        .map((character) => /[A-Z]/.test(character) ? character.toLowerCase() : character.toUpperCase())
        .join("");
      if (alternateName === name) return false;

      try {
        const currentStats = lstatSync(current);
        const alternateStats = lstatSync(join(dirname(current), alternateName));
        if (currentStats.isSymbolicLink() || alternateStats.isSymbolicLink()) return false;
        return currentStats.dev === alternateStats.dev && currentStats.ino === alternateStats.ino;
      } catch {
        return false;
      }
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return false;
}

export function toAccount(ref: SecretRef): string {
  const scopeId = ref.scope === "user" ? "-" : ref.projectId ?? "-";
  return `v1|${ref.scope}|${scopeId}|${ref.name}`;
}

// Cannot collide with toAccount(): a Secret account always carries a
// user/project scope field plus a Secret name, and a Secret name can never be
// the literal "destination" scope segment used here.
export function toDestinationAccount(ref: DestinationTrustRef): string {
  if (ref.kind !== "destination" && ref.kind !== "destination-slot") {
    throw new Error("Unsupported destination trust record.");
  }
  if (!DESTINATION_FINGERPRINT_PATTERN.test(ref.fingerprint)) {
    throw new Error("Invalid destination fingerprint.");
  }
  return `v1|${ref.kind}|${ref.fingerprint}`;
}
