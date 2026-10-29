import { createHash } from "node:crypto";
import { catalogSchema, bindingSchema, validate, VNextError, type Binding, type Catalog } from "./model.js";

/** A nonexecuting proposal, not proof of Human Plane confirmation. */
export function proposeBindingChange(input: Catalog, previousId: string | null, desired: Binding | null): { changed: boolean; catalog: Catalog } {
  const catalog = validate(catalogSchema, input);
  const previous = previousId === null ? undefined : catalog.bindings.find(b => b.id === previousId);
  if (previousId !== null && !previous || !previous && !desired) throw new VNextError("conflict");
  const next = desired === null ? null : validate(bindingSchema, desired);
  if (previous && next && previous.id !== next.id) throw new VNextError("conflict");
  if (previous && next && ["projectId", "environmentId", "variableName", "credentialId"].every(k => previous[k as keyof Binding] === next[k as keyof Binding])) {
    if (next.revision !== previous.revision) throw new VNextError("conflict");
    return { changed: false, catalog };
  }
  if (next && next.revision !== (previous ? previous.revision + 1 : 1)) throw new VNextError("conflict");
  const bindings = catalog.bindings.filter(b => b.id !== previousId);
  if (next) bindings.push(next);
  return { changed: true, catalog: validate(catalogSchema, { ...catalog, revision: catalog.revision + 1, bindings }) };
}

/** Resolves only validated, non-secret dependencies; never hashes Secret values or source files. */
export function usageBasis(input: Catalog, bindingIds: string[], targetId: string): string {
  const c = validate(catalogSchema, input);
  if (!bindingIds.length || new Set(bindingIds).size !== bindingIds.length) throw new VNextError("invalid-data");
  const target = c.destinations.find(t => t.id === targetId) ?? c.launchProfiles.find(t => t.id === targetId);
  if (!target) throw new VNextError("invalid-data");
  const bindings = bindingIds.map(id => c.bindings.find(b => b.id === id));
  if (bindings.some(b => !b || b.projectId !== target.projectId)) throw new VNextError("conflict");
  if ("bindingIds" in target && (target.bindingIds.length !== bindingIds.length || target.bindingIds.some(id => !bindingIds.includes(id)))) throw new VNextError("conflict");
  const snapshot = { target, project: c.projects.find(p => p.id === target.projectId),
    bindings: bindings.map(b => ({ binding: b!, environment: c.environments.find(e => e.id === b!.environmentId),
      credential: c.credentials.find(k => k.id === b!.credentialId) })).sort((a, b) => a.binding.id.localeCompare(b.binding.id)) };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
