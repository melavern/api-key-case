import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import { physicalIdentity } from "./identity.js";
import { projectSchema, validate, VNextError, type Catalog } from "./model.js";

export type ProjectContext = Pick<Catalog["projects"][number], "canonicalPath" | "directoryIdentity">;
/** Resolve the physical directory, without workspace markers or rounded inode numbers. */
export function inspectProject(path: string): ProjectContext {
  try {
    const real = realpathSync.native(path), before = lstatSync(real, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new VNextError("unsafe-path");
    let insensitive = false, current = real;
    while (current !== parse(real).root) {
      const name = basename(current), alternate = name.replace(/[a-zA-Z]/g, c => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
      if (name !== alternate) {
        try {
          const original = lstatSync(current, { bigint: true }), other = lstatSync(join(dirname(current), alternate), { bigint: true });
          insensitive = !original.isSymbolicLink() && !other.isSymbolicLink() && original.dev === other.dev && original.ino === other.ino;
        } catch { /* A missing alternate spelling means case-sensitive. */ }
        break;
      }
      current = dirname(current);
    }
    const canonicalPath = (insensitive ? real.toLowerCase() : real).replaceAll("\\", "/");
    const after = lstatSync(canonicalPath, { bigint: true });
    if (JSON.stringify(physicalIdentity(before)) !== JSON.stringify(physicalIdentity(after))) throw new VNextError("conflict");
    return { canonicalPath, directoryIdentity: physicalIdentity(after) };
  } catch { throw new VNextError("unsafe-path"); }
}
export function sameProject(a: ProjectContext, b: ProjectContext): boolean {
  return a.canonicalPath === b.canonicalPath && JSON.stringify(a.directoryIdentity) === JSON.stringify(b.directoryIdentity);
}
export function findProject(catalog: Catalog, context: ProjectContext): Catalog["projects"][number] | undefined {
  const project = catalog.projects.find(p => p.canonicalPath === context.canonicalPath);
  if (project && !sameProject(project, context)) throw new VNextError("conflict");
  if (!project && catalog.projects.some(p => JSON.stringify(p.directoryIdentity) === JSON.stringify(context.directoryIdentity))) throw new VNextError("conflict");
  return project && validate(projectSchema, project);
}
