import { createHash } from "node:crypto";
import { catalogSchema, credentialSchema, operationSchema, validate, VNextError, type Catalog, type Credential, type Operation } from "./model.js";

/** Fingerprints are exclusively over validated non-secret records. */
export function catalogFingerprint(input: Catalog): string {
  return createHash("sha256").update(JSON.stringify(validate(catalogSchema, input))).digest("hex");
}

export function prepareRegistration(input: Catalog, next: Credential, operationId: string, now: string): Operation {
  const catalog = validate(catalogSchema, input), candidate = validate(credentialSchema, next);
  const previous = catalog.credentials.find(c => c.id === candidate.id);
  if (candidate.locator.kind !== "v3" || previous && previous.locator.kind !== "v3" ||
    candidate.generation !== (previous ? Number(previous.generation) + 1 : 1) ||
    previous && (candidate.createdAt !== previous.createdAt || previous.locator.kind === "v3" && candidate.locator.generationId === previous.locator.generationId)) throw new VNextError("conflict");
  return validate(operationSchema, { schemaVersion: 1, operationId, kind: "registration", credentialId: candidate.id,
    candidateGenerationId: candidate.locator.generationId, expectedCatalogRevision: catalog.revision,
    boundBasis: { fingerprint: catalogFingerprint(catalog), previousGenerationId: previous?.locator.kind === "v3" ? previous.locator.generationId : null,
      targetId: null, targetRevision: null, projectRevision: null, bindingRevision: null, candidateCredential: candidate },
    state: "prepared", timestamps: { createdAt: now, updatedAt: now }, effects: [], authority: "none" });
}

function candidateOf(operation: Operation): Credential {
  if (operation.kind !== "registration" || !operation.boundBasis.candidateCredential) throw new VNextError("invalid-data");
  return operation.boundBasis.candidateCredential;
}
function state(operation: Operation, next: Operation["state"], now: string): Operation {
  return validate(operationSchema, { ...operation, state: next, timestamps: { ...operation.timestamps, updatedAt: now } });
}
const terminal = new Set(["committed", "cancelled", "conflict"]);

/** Pure recovery: never opens an input dialog, reads a value, saves or deletes a slot. */
export function reconcileRegistration(input: Operation, snapshot: Catalog, presence: "present" | "absent" | "unavailable", now: string): Operation {
  const operation = validate(operationSchema, input), catalog = validate(catalogSchema, snapshot), candidate = candidateOf(operation);
  if (terminal.has(operation.state)) return operation;
  const current = catalog.credentials.find(c => c.id === candidate.id);
  if (presence === "unavailable") return state(operation, "recovery-required", now);
  if (current && JSON.stringify(current) === JSON.stringify(candidate) && catalog.revision > operation.expectedCatalogRevision) {
    return state(operation, presence === "present" ? "committed" : "recovery-required", now);
  }
  if (presence === "absent") return state(operation, "unknown", now);
  if (catalog.revision !== operation.expectedCatalogRevision || catalogFingerprint(catalog) !== operation.boundBasis.fingerprint) {
    return state(operation, "conflict", now);
  }
  return state(operation, "stored-uncommitted", now);
}

/** Call only when an exclusive attempt knows the human declined before any save. */
export function cancelBeforeSave(input: Operation, now: string): Operation {
  const operation = validate(operationSchema, input); candidateOf(operation);
  if (operation.state !== "prepared" && operation.state !== "awaiting-human") throw new VNextError("conflict");
  return state(operation, "cancelled", now);
}

/** Pure CAS proposal. Persistence must compare the very same catalog snapshot under its lock. */
export function commitRegistration(input: Operation, snapshot: Catalog, now: string): { catalog: Catalog; operation: Operation } {
  const operation = validate(operationSchema, input), catalog = validate(catalogSchema, snapshot), candidate = candidateOf(operation);
  if (operation.state === "committed") return { catalog, operation };
  if (operation.state !== "stored-uncommitted") throw new VNextError("conflict");
  const current = catalog.credentials.find(c => c.id === candidate.id);
  const previous = current?.locator.kind === "v3" ? current.locator.generationId : null;
  if (catalog.revision !== operation.expectedCatalogRevision || catalogFingerprint(catalog) !== operation.boundBasis.fingerprint ||
    previous !== operation.boundBasis.previousGenerationId) return { catalog, operation: state(operation, "conflict", now) };
  const credentials = current ? catalog.credentials.map(c => c.id === candidate.id ? candidate : c) : [...catalog.credentials, candidate];
  return { catalog: validate(catalogSchema, { ...catalog, revision: catalog.revision + 1, credentials }), operation: state(operation, "committed", now) };
}

/** A historical operation or completed receipt never grants another execution. */
export function useAttemptAction(input: Operation): "review-plan" | "await-human" | "recovery-required" | "settled" {
  const operation = validate(operationSchema, input);
  if (operation.kind === "registration" || operation.kind === "binding") throw new VNextError("invalid-data");
  if (["planned", "reviewable", "changed"].includes(operation.state)) return "review-plan";
  if (operation.state === "consent-needed") return "await-human";
  if (["prepared", "executing", "running", "unknown", "recovery-required"].includes(operation.state)) return "recovery-required";
  return "settled";
}
