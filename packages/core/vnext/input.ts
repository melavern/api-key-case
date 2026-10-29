import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CatalogStore, type CatalogSnapshot, type OperationSnapshot } from "./files.js";
import { credentialSchema, emptyCatalog, validate, type Catalog, type Locator, type Operation } from "./model.js";
import { cancelBeforeSave, commitRegistration, prepareRegistration, reconcileRegistration } from "./registration.js";

export const inputRequestSchema = z.strictObject({ label: z.string().min(1).max(80).regex(/^[^\x00-\x1f\x7f\\/]+$/).optional(),
  classification: z.enum(["unknown", "nonproduction", "production"]).optional(), replaceCredentialId: z.uuidv4().optional(), operationId: z.uuidv4().optional() })
  .refine(r => r.operationId !== undefined || r.label !== undefined && r.classification !== undefined);
export type InputRequest = z.infer<typeof inputRequestSchema>;
export interface RegistrationIO {
  store: Pick<CatalogStore, "readCatalog" | "compareAndSwap" | "readOperation" | "saveOperation" | "listRegistrationOperations">;
  human: { ask(plan: { operation: Operation; catalog: Catalog }): Promise<"saved" | "cancelled" | "unavailable"> };
  presence(locator: Locator): Promise<"present" | "absent" | "unavailable">;
  clock?: () => string;
}
export const inputResultSchema = z.strictObject({ schemaVersion: z.literal(1), permission: z.literal("none"),
  status: z.enum(["committed", "cancelled", "conflict", "unknown", "recovery-required", "selection-required", "unavailable", "pending-acceptance"]),
  operationId: z.uuidv4().nullable(), credentialId: z.uuidv4().nullable(),
  storageEffect: z.enum(["none", "candidate-preserved", "committed", "unknown"]), currentPresence: z.literal("not-inspected") });
export type InputResult = z.infer<typeof inputResultSchema>;
export function inputResult(status: InputResult["status"], operation: Operation | null = null, storageEffect: InputResult["storageEffect"] = "none"): InputResult {
  return validate(inputResultSchema, { schemaVersion: 1, permission: "none", status, operationId: operation?.operationId ?? null,
    credentialId: operation?.credentialId ?? null, storageEffect, currentPresence: "not-inspected" });
}
function result(operation: Operation): InputResult {
  const status = ["committed", "cancelled", "conflict", "recovery-required", "unknown"].includes(operation.state)
    ? operation.state as InputResult["status"] : "recovery-required";
  return inputResult(status, operation, status === "committed" ? "committed" : status === "cancelled" ? "none" : "candidate-preserved");
}

/** The caller must source-gate native input. No parameter can carry a Secret or an approval. */
export async function registerCredential(input: InputRequest, io: RegistrationIO): Promise<InputResult> {
  const request = validate(inputRequestSchema, input), now = io.clock ?? (() => new Date().toISOString());
  let pending: OperationSnapshot | null = null;
  try {
    if (request.operationId) {
      pending = io.store.readOperation(request.operationId);
      if (!pending || pending.operation.kind !== "registration") return inputResult("unavailable");
      const candidate = pending.operation.boundBasis.candidateCredential!;
      if (request.label !== undefined && candidate.label !== request.label || request.classification !== undefined && candidate.classification !== request.classification ||
        request.replaceCredentialId !== undefined && candidate.id !== request.replaceCredentialId) return inputResult("conflict", pending.operation);
      // A recorded ID is recovery only, even if it is still prepared and the slot is absent.
      return await recoverRegistration(pending, io, now);
    }
    // A caller may have lost the process before receiving the operation ID.
    // Search the journal before duplicate-label checks, presence or another input.
    const unfinished = io.store.listRegistrationOperations().filter(o => {
      const candidate = o.boundBasis.candidateCredential!;
      return !["committed", "cancelled"].includes(o.state) &&
        (request.replaceCredentialId ? o.credentialId === request.replaceCredentialId :
          o.boundBasis.previousGenerationId === null && candidate.label.toLowerCase() === request.label!.toLowerCase());
    });
    if (unfinished.length > 1) return inputResult("selection-required");
    if (unfinished.length === 1) {
      pending = io.store.readOperation(unfinished[0].operationId);
      if (!pending) return inputResult("unavailable");
      const candidate = pending.operation.boundBasis.candidateCredential!;
      if (candidate.label !== request.label || candidate.classification !== request.classification) return inputResult("conflict", pending.operation, "candidate-preserved");
      return await recoverRegistration(pending, io, now);
    }
    let snapshot = io.store.readCatalog();
    if (!snapshot) snapshot = io.store.compareAndSwap(null, emptyCatalog());
    const catalog = snapshot.catalog, previous = request.replaceCredentialId ? catalog.credentials.find(c => c.id === request.replaceCredentialId) : undefined;
    if (request.replaceCredentialId && (!previous || previous.locator.kind !== "v3")) return inputResult("unavailable");
    if (!previous && catalog.credentials.some(c => c.label.toLowerCase() === request.label!.toLowerCase())) return inputResult("selection-required");
    if (previous && await io.presence(previous.locator) !== "present") return inputResult("recovery-required");
    const id = previous?.id ?? randomUUID();
    const candidate = validate(credentialSchema, { id, label: request.label, classification: request.classification,
      locator: { kind: "v3", id, generationId: randomUUID() }, generation: previous ? Number(previous.generation) + 1 : 1,
      createdAt: previous?.createdAt ?? now(), revisedAt: now() });
    const operation = prepareRegistration(catalog, candidate, randomUUID(), now());
    // Validate the complete proposed catalog before the first OS-store write.
    commitRegistration({ ...operation, state: "stored-uncommitted" }, catalog, now());
    pending = io.store.saveOperation(null, operation);
    const human = await io.human.ask({ operation, catalog });
    if (human === "cancelled") {
      const cancelled = cancelBeforeSave(operation, now());
      io.store.saveOperation(pending, cancelled); return result(cancelled);
    }
    // Even an unavailable helper may have saved before its response was lost.
    return await recoverRegistration(pending, io, now);
  } catch { return pending ? inputResult("unknown", pending.operation, "unknown") : inputResult("unavailable"); }
}

async function recoverRegistration(pending: OperationSnapshot, io: RegistrationIO, now: () => string): Promise<InputResult> {
  const operation = pending.operation;
  if (["committed", "cancelled", "conflict"].includes(operation.state)) return result(operation);
  const snapshot = io.store.readCatalog();
  if (!snapshot) return inputResult("recovery-required", operation, "unknown");
  const candidate = operation.boundBasis.candidateCredential!;
  const reconciled = reconcileRegistration(operation, snapshot.catalog, await io.presence(candidate.locator), now());
  const staged = io.store.saveOperation(pending, reconciled);
  if (reconciled.state !== "stored-uncommitted") return result(reconciled);
  return commitStored(staged, snapshot, io, now);
}
function commitStored(pending: OperationSnapshot, snapshot: CatalogSnapshot, io: RegistrationIO, now: () => string): InputResult {
  const proposed = commitRegistration(pending.operation, snapshot.catalog, now());
  if (proposed.operation.state === "conflict") { io.store.saveOperation(pending, proposed.operation); return result(proposed.operation); }
  io.store.compareAndSwap(snapshot, proposed.catalog);
  // If this write/response fails, the next call reconciles the exact candidate against active.
  io.store.saveOperation(pending, proposed.operation);
  return result(proposed.operation);
}
