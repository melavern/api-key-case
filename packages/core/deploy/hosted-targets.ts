import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync, type BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseMetadata } from "../vnext/json.js";
import { physicalIdentity } from "../vnext/identity.js";
import { destinationSchema, validate, VNextError, variableSchema, type Catalog } from "../vnext/model.js";
import { resolveConnectionGitHubRepository, type FileFingerprint } from "./snapshot.js";
import type { DeployPlan } from "./types.js";

export type HostedDestination = Exclude<Catalog["destinations"][number], { kind: "cloudflare" }>;
export interface HostedSelection { account: string; resource: string; files: readonly FileFingerprint[] }
const fail = (): never => { throw new VNextError("unsafe-path"); };
const stamp = (s: BigIntStats) => JSON.stringify({ ...physicalIdentity(s), size: String(s.size), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs), mode: String(s.mode) });
const absent = (path: string) => { try { lstatSync(path); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; throw e; } };
/** Fixed, bounded ordinary metadata only. Never open auth files or .env files. */
function readConfig(project: string, relative: string) {
  const path = join(project, relative);
  for (let part = path;;) {
    if (lstatSync(part).isSymbolicLink()) fail(); const parent = dirname(part); if (parent === part) break; part = parent;
  }
  const before = lstatSync(path, { bigint: true }); if (!before.isFile() || before.nlink !== 1n || before.size > 65536n) fail();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (stamp(fstatSync(fd, { bigint: true })) !== stamp(before)) fail();
    const bytes = Buffer.alloc(Number(before.size));
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || stamp(fstatSync(fd, { bigint: true })) !== stamp(before) || stamp(lstatSync(path, { bigint: true })) !== stamp(before)) fail();
    return { path, bytes, stat: before };
  } finally { closeSync(fd); }
}
function fingerprint(file: ReturnType<typeof readConfig>, selection: unknown): FileFingerprint {
  return Object.freeze({ path: resolve(file.path), exists: true, kind: "file", realPath: realpathSync.native(file.path), exactIdentity: stamp(file.stat),
    mtimeMs: Number(file.stat.mtimeMs), ctimeMs: Number(file.stat.ctimeMs), birthtimeMs: Number(file.stat.birthtimeMs), mode: Number(file.stat.mode),
    dev: Number(file.stat.dev), ino: Number(file.stat.ino), contentHash: createHash("sha256").update(JSON.stringify(selection)).digest("hex"), destinationLabel: null, readable: true });
}
export function inspectHostedTarget(project: string, kind: HostedDestination["kind"]): HostedSelection {
  const root = realpathSync.native(project);
  if (/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(root)) fail();
  if (kind === "vercel") {
    if (!absent(join(root, ".vercel/repo.json"))) fail();
    const file = readConfig(root, ".vercel/project.json"), parsed = parseMetadata(file.bytes) as Record<string, unknown>;
    if (typeof parsed.orgId !== "string" || typeof parsed.projectId !== "string" || !/^team_[A-Za-z0-9]+$/.test(parsed.orgId) || !/^prj_[A-Za-z0-9]+$/.test(parsed.projectId) || /[\r\n]/.test(parsed.orgId + parsed.projectId)) return fail();
    const selection = { account: parsed.orgId, resource: parsed.projectId };
    return { ...selection, files: Object.freeze([fingerprint(file, selection)]) };
  }
  if (kind !== "github-actions") fail();
  if (!lstatSync(join(root, ".git")).isDirectory() || !absent(join(root, ".git/config.worktree"))) fail();
  const file = readConfig(root, ".git/config"), repository = resolveConnectionGitHubRepository(root);
  if (!repository || stamp(lstatSync(file.path, { bigint: true })) !== stamp(file.stat)) return fail();
  const selection = { account: repository.split("/")[0], resource: repository };
  return { ...selection, files: Object.freeze([fingerprint(file, selection)]) };
}
export function resolveHostedTarget(project: string, destination: HostedDestination): HostedSelection {
  validate(destinationSchema, destination); const selection = inspectHostedTarget(project, destination.kind);
  if (selection.account !== destination.providerAccountId || selection.resource !== destination.resourceId) fail(); return selection;
}
export function hostedDeploymentPlan(destination: HostedDestination, variable: string): DeployPlan {
  validate(destinationSchema, destination); validate(variableSchema, variable);
  if (/[\x00-\x1f\x7f]/.test(variable + destination.applicationEnvironment + destination.providerAccountId + destination.resourceId)) fail();
  if (destination.kind === "vercel") {
    // Framework-public names are never silently downgraded to Config storage.
    if (/^(?:NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|NUXT_PUBLIC_|GATSBY_|VUE_APP_|EXPO_PUBLIC_)/i.test(variable)) fail();
    const argv = ["vercel", "env", "add", variable, destination.applicationEnvironment, "--sensitive", "--yes", "--force",
      "--scope", destination.providerAccountId, "--project", destination.resourceId, "--non-interactive"];
    return { argv, valueVia: "stdin", overwriteWarning: true, displayCommand: `${argv.join(" ")} (variable registration; existing deployments are unchanged)` };
  }
  const argv = ["gh", "secret", "set", variable, "--app", "actions", "--repo", `github.com/${destination.resourceId}`];
  if (destination.applicationEnvironment !== "repository") argv.push("--env", destination.applicationEnvironment);
  return { argv, valueVia: "stdin", overwriteWarning: true, displayCommand: `${argv.join(" ")} (Actions workflows can consume this secret)` };
}
