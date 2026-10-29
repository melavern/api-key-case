import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { physicalIdentity } from "../vnext/identity.js";
import { parseMetadata } from "../vnext/json.js";
import { VNextError, variableSchema, validate, type Catalog } from "../vnext/model.js";

export type LaunchProfile = Catalog["launchProfiles"][number];
export interface LaunchFile { path: string; fingerprint: string; stamp: string }
const fail = (): never => { throw new VNextError("unsafe-path"); };
const forbidden = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519)$/i;
const reserved = /^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|SYSTEMDRIVE|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|NODE_.*|PYTHON.*|NPM_.*|LD_.*|DYLD_.*|__.*)$/i;
export function launchVariable(name: string): string {
  validate(variableSchema, name); if (/[\x00-\x1f\x7f]/.test(name) || reserved.test(name)) fail(); return name;
}
/** No secret files, links, device spellings or shell metacharacters enter launch selection. */
export function launchPath(path: string, directory = false): string {
  if (!isAbsolute(path) || path.length > 1024 || /[\x00-\x1f\x7f"<>|?*\u202a-\u202e\u2066-\u2069]/u.test(path)) fail();
  const absolute = resolve(path);
  for (let part = absolute;;) {
    if (forbidden.test(basename(part))) fail();
    const info = lstatSync(part, { bigint: true }); if (info.isSymbolicLink()) fail();
    const parent = dirname(part); if (parent === part) break; part = parent;
  }
  const info = lstatSync(absolute, { bigint: true });
  if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n) fail();
  return realpathSync.native(absolute);
}
export function insideLaunchPath(project: string, path: string, directory = false): string {
  const result = launchPath(join(project, path), directory), rel = relative(project, result);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(); return result;
}
const stamp = (s: BigIntStats) => JSON.stringify({ ...physicalIdentity(s), size: String(s.size), mtime: String(s.mtimeNs) });
/** Bounded streamed hashing. Runtime/manifest selection only; app source is never hashed. */
export function launchFile(path: string, limit = 256 * 1024 * 1024): LaunchFile {
  const actual = launchPath(path), before = lstatSync(actual, { bigint: true }); if (before.size > BigInt(limit)) fail();
  const fd = openSync(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (stamp(fstatSync(fd, { bigint: true })) !== stamp(before)) fail();
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(65536); let count = 0;
    for (;;) { const n = readSync(fd, buffer, 0, Math.min(buffer.length, limit + 1 - count), count); if (!n) break; count += n; if (count > limit) fail(); hash.update(buffer.subarray(0, n)); }
    if (BigInt(count) !== before.size || stamp(fstatSync(fd, { bigint: true })) !== stamp(before) || stamp(lstatSync(actual, { bigint: true })) !== stamp(before)) fail();
    return Object.freeze({ path: actual, fingerprint: hash.digest("hex"), stamp: stamp(before) });
  } finally { closeSync(fd); }
}
function manifest(path: string): { file: LaunchFile; data: Record<string, unknown> } {
  const file = launchFile(path, 1024 * 1024), fd = openSync(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true }); if (opened.size > 1024n * 1024n || stamp(opened) !== file.stamp) fail();
    const size = Number(opened.size), bytes = Buffer.alloc(size);
    if (readSync(fd, bytes, 0, size, 0) !== size || stamp(fstatSync(fd, { bigint: true })) !== file.stamp ||
        stamp(lstatSync(file.path, { bigint: true })) !== file.stamp || createHash("sha256").update(bytes).digest("hex") !== file.fingerprint) fail();
    const data = parseMetadata(bytes);
    if (!data || typeof data !== "object" || Array.isArray(data)) fail(); return { file, data: data as Record<string, unknown> };
  } finally { closeSync(fd); }
}
export function npmSelection(project: string, cwd: string, runtime: string, script: "dev" | "start") {
  const work = insideLaunchPath(project, cwd, true), manifestPath = join(work, "package.json"), lockPath = join(work, "package-lock.json");
  // npm is the only package manager in this first closed profile. No install is performed.
  for (const name of ["pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json"]) {
    try { lstatSync(join(work, name)); fail(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  const parsed = manifest(manifestPath), scripts = parsed.data.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts) || typeof (scripts as Record<string, unknown>)[script] !== "string") fail();
  const scriptDefinition = (scripts as Record<string, string>)[script];
  if (!scriptDefinition || scriptDefinition.length > 4096 || /[\0\r\n]/.test(scriptDefinition)) fail();
  const manager = launchFile(join(dirname(runtime), "node_modules", "npm", "bin", "npm-cli.js"));
  const lockFile = launchFile(lockPath);
  return { manifestPath, lockPath, manifestFile: parsed.file, lockFile, manager, revision: { manifestFingerprint: parsed.file.fingerprint,
    lockfileFingerprint: lockFile.fingerprint, scriptDefinition,
    packageManagerIdentity: { executable: manager.path, fingerprint: manager.fingerprint } } };
}
export interface ProfileSnapshot {
  project: string; cwd: string; entry: string; files: readonly LaunchFile[]; variables: readonly string[];
  fingerprint: string; current(): boolean;
}
export function captureProfile(projectPath: string, profile: LaunchProfile, variables: string[]): ProfileSnapshot {
  const project = launchPath(projectPath, true), cwd = insideLaunchPath(project, profile.cwd, true);
  if (!variables.length || variables.length > 128 || new Set(variables.map(v => launchVariable(v).toLowerCase())).size !== variables.length) fail();
  const runtime = launchFile(profile.runtimeIdentity.executable), node = profile.kind.startsWith("node-");
  if (runtime.fingerprint !== profile.runtimeIdentity.fingerprint || !new RegExp(node ? "^node(?:\\.exe)?$" : "^python(?:3(?:\\.[0-9]+)?)?(?:\\.exe)?$", "i").test(basename(runtime.path))) fail();
  const files: LaunchFile[] = [runtime], directories = new Map<string, string>();
  const pinDirectory = (path: string) => { const checked = launchPath(path, true); directories.set(checked, JSON.stringify(physicalIdentity(lstatSync(checked, { bigint: true })))); };
  pinDirectory(project); pinDirectory(cwd);
  let entry = profile.approvedEntryOrScript;
  if (/[\x00-\x1f\x7f]/.test(entry)) fail();
  if (profile.kind === "node-package-script") {
    const selection = npmSelection(project, profile.cwd, runtime.path, profile.approvedEntryOrScript);
    if (JSON.stringify(selection.revision) !== JSON.stringify(profile.packageManifestRevision)) fail();
    files.push(selection.manager, selection.manifestFile, selection.lockFile);
  } else if (profile.kind !== "python-module") {
    entry = insideLaunchPath(project, profile.approvedEntryOrScript);
    if (node ? !/\.(?:js|mjs|cjs)$/i.test(entry) : !/\.py$/i.test(entry)) fail();
    pinDirectory(dirname(entry)); // Source content and replace-by-save remain editable.
  }
  // Dependency selection is fixed; ordinary app source and module bytes may change.
  const known = node ? ["package.json", "package-lock.json"] : ["pyproject.toml", "requirements.txt", "uv.lock", "poetry.lock"];
  for (const name of known) {
    const path = join(cwd, name);
    try { lstatSync(path); if (!files.some(f => f.path.toLowerCase() === path.toLowerCase())) files.push(launchFile(path, 2 * 1024 * 1024)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  let absentDependencies: string | null = null;
  if (node) { try { pinDirectory(join(cwd, "node_modules")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; absentDependencies = join(cwd, "node_modules"); } }
  const absent = known.map(n => join(cwd, n)).filter(p => !files.some(f => f.path.toLowerCase() === p.toLowerCase()));
  if (absentDependencies) absent.push(absentDependencies);
  if (profile.kind === "node-package-script") {
    // npm config may replace the script shell or inject Node options. Do not read it.
    for (let part = cwd;;) {
      const config = join(part, ".npmrc");
      try { lstatSync(config); fail(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      absent.push(config); const parent = dirname(part); if (part === project || parent === part) break; part = parent;
    }
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ profile, files, directories: [...directories], variables })).digest("hex");
  return Object.freeze({ project, cwd, entry, files: Object.freeze(files), variables: Object.freeze([...variables]), fingerprint,
    current: () => {
      try {
        for (const [path, identity] of directories) if (JSON.stringify(physicalIdentity(lstatSync(launchPath(path, true), { bigint: true }))) !== identity) return false;
        for (const file of files) if (stamp(lstatSync(launchPath(file.path), { bigint: true })) !== file.stamp) return false;
        for (const path of absent) { try { lstatSync(path); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false; } }
        if (profile.kind !== "node-package-script" && profile.kind !== "python-module") insideLaunchPath(project, profile.approvedEntryOrScript);
        return true;
      } catch { return false; }
    } });
}
