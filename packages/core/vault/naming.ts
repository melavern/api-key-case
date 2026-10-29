import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import type { ConnectionCredentialRef, DestinationTrustRef, StoredSecretRef } from "./types.js";

export const VAULT_SERVICE = "api-key-case";

// The stored value of a destination trust record. The record's meaning is
// carried entirely by its account name; the value is a fixed constant so that
// nothing Secret-derived is ever written by this path.
export const DESTINATION_TRUST_MARKER = "api-key-case:destination-trust:v1";

const DESTINATION_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** Canonical path identity shared by project-scoped metadata and vault naming. */
export function canonicalProjectRealpath(targetDir: string): string {
  const real = realpathSync(targetDir);
  const normalizedPath = real.replace(/\\/g, "/");
  // Windows normally treats path case as presentation. On a case-sensitive
  // filesystem, however, lowercasing would merge two distinct projects.
  return isCaseInsensitiveFilesystem(real)
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

export function deriveProjectId(targetDir: string): string {
  const normalized = canonicalProjectRealpath(targetDir);
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

export function isConnectionCredentialRef(ref: StoredSecretRef): ref is ConnectionCredentialRef {
  return "environment" in ref || "service" in ref;
}

export function assertConnectionCredentialRef(ref: StoredSecretRef): asserts ref is ConnectionCredentialRef {
  if (ref.scope !== "project" || !/^[0-9a-f]{16}$/.test(ref.projectId ?? "") ||
      !("service" in ref) || !((ref.service === "resend" && ref.name === "RESEND_API_KEY") ||
        (ref.service === "clerk" && ref.name === "CLERK_SECRET_KEY") ||
        (ref.service === "openai" && ref.name === "OPENAI_API_KEY") ||
        (ref.service === "stripe-test" && ref.name === "STRIPE_API_KEY" &&
          "environment" in ref && (ref.environment === "development" || ref.environment === "preview"))) ||
      !("environment" in ref) || typeof ref.environment !== "string" || !["development", "preview", "production"].includes(ref.environment)) {
    throw new Error("Invalid connection credential reference.");
  }
}

export function toAccount(ref: StoredSecretRef): string {
  if (isConnectionCredentialRef(ref)) {
    assertConnectionCredentialRef(ref);
    return `v2|credential|project|${ref.projectId}|${ref.service}|${ref.environment}|${ref.name}`;
  }
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
