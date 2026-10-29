import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Private, in-memory launch integrity only. Never use these bytes/digests as a
// public source fingerprint, receipt, diagnostic, or provenance assertion.
const ROOTS = ["src", "app", "server", "lib", "pages"] as const;
const CONFIGS = ["tsconfig.json", "tsconfig.build.json", "vite.config.ts", "vite.config.js", "esbuild.config.mjs"] as const;
const LOCKS = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"] as const;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 16 * 1024 * 1024, MAX_FILES = 1024;
const INVALID = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u;
const PRIVATE_NAME = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519)$/i;

function fail(): never { throw new Error("Local application inputs are unavailable."); }
function safePath(path: string): void {
  if (!isAbsolute(path) || INVALID.test(path) || path.length > 1024) fail();
  let part = resolve(path);
  for (;;) {
    const info = lstatSync(part);
    if (info.isSymbolicLink()) fail();
    const parent = dirname(part);
    if (parent === part) break;
    part = parent;
  }
}
function identity(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs].join(":");
}
function capture(path: string, limit: number, scratch: Buffer): { path: string; identity: string; byteCount: number; sha256: string } {
  safePath(path);
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (identity(opened) !== identity(before)) fail();
    const hash = createHash("sha256");
    let count = 0;
    // Read at most the captured size plus one byte, including an EOF probe. This
    // detects growth/short reads without retaining file-sized buffers. One fixed
    // scratch buffer is reused across the entire capture/check pass.
    while (count <= opened.size) {
      const n = readSync(fd, scratch, 0, Math.min(scratch.length, opened.size + 1 - count), count);
      if (!n) break;
      hash.update(scratch.subarray(0, n));
      count += n;
    }
    if (count !== opened.size || identity(fstatSync(fd)) !== identity(opened) || identity(lstatSync(path)) !== identity(opened)) fail();
    return { path, identity: identity(opened), byteCount: count, sha256: hash.digest("hex") };
  } finally { closeSync(fd); }
}
function optional(path: string): Stats | null {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}
function enumerate(project: string): string[] {
  const files: string[] = [];
  const add = (path: string) => { files.push(path); if (files.length > MAX_FILES) fail(); };
  const walk = (path: string, depth: number): void => {
    if (depth > 20) fail();
    safePath(path);
    const info = lstatSync(path);
    if (!info.isDirectory()) fail();
    for (const name of readdirSync(path).sort()) {
      if (INVALID.test(name) || PRIVATE_NAME.test(name) || name === "node_modules" || name === ".git") fail();
      const child = join(path, name), stat = lstatSync(child);
      if (stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) walk(child, depth + 1);
      else if (stat.isFile()) add(child);
      else fail();
    }
  };
  let roots = 0;
  for (const root of ROOTS) if (optional(join(project, root))) { roots++; walk(join(project, root), 0); }
  if (!roots) fail();
  add(join(project, "package.json"));
  const locks = LOCKS.filter(name => optional(join(project, name)) !== null);
  if (locks.length !== 1) fail();
  add(join(project, locks[0]));
  for (const config of CONFIGS) if (optional(join(project, config))) add(join(project, config));
  return files.sort();
}

/** Metadata-only advisory basis. No file content, value-derived digest or launch authority. */
export interface LocalPreparationIdentity { project: string; inputs: string; artifact: string; runtime: string }
function preparationIdentity(project: string, projectIdentity: string,
  files: { path: string; identity: string }[], artifact: { path: string; identity: string },
  runtime: { path: string; identity: string }): LocalPreparationIdentity {
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(["local-preparation-stat-1", value])).digest("hex");
  return { project: digest(projectIdentity), inputs: digest(files.map(file => [relative(project, file.path), file.identity])),
    artifact: digest([relative(project, artifact.path), artifact.identity]), runtime: digest([runtime.path, runtime.identity]) };
}

/** Reobserve only bounded ordinary-file metadata; never reads source/runtime bytes or executes code. */
export function observeLocalPreparationIdentity(projectDir: string, artifact: string): LocalPreparationIdentity {
  if (!/^dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.cjs$/.test(artifact)) fail();
  safePath(resolve(projectDir));
  const project = realpathSync(projectDir);
  const metadata = (path: string, limit: number) => {
    safePath(path); const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) fail();
    return { path, identity: identity(stat), byteCount: stat.size };
  };
  const runtime = realpathSync(process.execPath);
  if (!relative(project, runtime).startsWith(`..${sep}`) && !isAbsolute(relative(project, runtime))) fail();
  const sample = () => {
    safePath(project); const stat = lstatSync(project);
    if (!stat.isDirectory() || realpathSync(projectDir) !== project) fail();
    const paths = enumerate(project), files = paths.map(path => metadata(path, MAX_FILE));
    if (files.reduce((total, file) => total + file.byteCount, 0) > MAX_TOTAL) fail();
    return preparationIdentity(project, [stat.dev, stat.ino].join(":"), files,
      metadata(join(project, ...artifact.split("/")), 16 * 1024 * 1024), metadata(runtime, 128 * 1024 * 1024));
  };
  const before = sample(), after = sample();
  if (JSON.stringify(before) !== JSON.stringify(after)) fail();
  return before;
}

/** No enumerable private bytes or hashes, even under accidental JSON.stringify. */
export class LocalLaunchSnapshot {
  readonly projectDir: string;
  readonly artifactPath: string;
  readonly interpreterPath: string;
  #files: ReturnType<typeof capture>[];
  #artifact: ReturnType<typeof capture>;
  #interpreter: ReturnType<typeof capture>;
  #projectIdentity: string;

  constructor(projectDir: string, artifact: string, interpreterPath = process.execPath) {
    if (typeof artifact !== "string" || !/^dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.cjs$/.test(artifact)) fail();
    safePath(resolve(projectDir));
    this.projectDir = realpathSync(projectDir);
    if (!lstatSync(this.projectDir).isDirectory()) fail();
    this.#projectIdentity = [lstatSync(this.projectDir).dev, lstatSync(this.projectDir).ino].join(":");
    this.artifactPath = join(this.projectDir, ...artifact.split("/"));
    // The current, already-running Node runtime is the sole production selection;
    // no executable argument or PATH lookup is part of the public request.
    this.interpreterPath = realpathSync(interpreterPath);
    if (!relative(this.projectDir, this.interpreterPath).startsWith(`..${sep}`) && !isAbsolute(relative(this.projectDir, this.interpreterPath))) fail();
    if (process.platform === "win32" && basename(this.interpreterPath).toLowerCase() !== "node.exe") fail();
    safePath(interpreterPath);
    const scratch = Buffer.alloc(READ_CHUNK_BYTES);
    this.#artifact = capture(this.artifactPath, 16 * 1024 * 1024, scratch);
    this.#interpreter = capture(this.interpreterPath, 128 * 1024 * 1024, scratch);
    if (!this.#artifact.byteCount || !this.#interpreter.byteCount) fail();
    const paths = enumerate(this.projectDir);
    let total = 0;
    this.#files = paths.map(path => { const file = capture(path, MAX_FILE, scratch); total += file.byteCount; if (total > MAX_TOTAL) fail(); return file; });
    if (JSON.stringify(paths) !== JSON.stringify(enumerate(this.projectDir))) fail();
    Object.freeze(this);
  }

  current(): boolean { return this.check(false); }

  /** Only after the fixed native owner confirmed locks; still verify path/metadata. */
  currentWithNativeLocks(): boolean { return this.check(true); }

  /** Explicit non-content projection for an advisory preparation receipt only. */
  preparationIdentity(): LocalPreparationIdentity {
    return preparationIdentity(this.projectDir, this.#projectIdentity, this.#files, this.#artifact, this.#interpreter);
  }

  private check(nativeLocks: boolean): boolean {
    try {
      safePath(this.projectDir);
      const project = lstatSync(this.projectDir);
      if ([project.dev, project.ino].join(":") !== this.#projectIdentity || !project.isDirectory()) return false;
      const paths = enumerate(this.projectDir);
      if (paths.length !== this.#files.length || paths.some((path, index) => path !== this.#files[index].path)) return false;
      const scratch = Buffer.alloc(READ_CHUNK_BYTES);
      for (const file of [...this.#files, this.#artifact, this.#interpreter]) {
        if (nativeLocks && (file === this.#artifact || file === this.#interpreter)) {
          safePath(file.path);
          if (identity(lstatSync(file.path)) !== file.identity) return false;
          continue;
        }
        const now = capture(file.path, file === this.#interpreter ? 128 * 1024 * 1024 : file === this.#artifact ? 16 * 1024 * 1024 : MAX_FILE, scratch);
        if (now.identity !== file.identity || now.byteCount !== file.byteCount || now.sha256 !== file.sha256) return false;
      }
      return JSON.stringify(paths) === JSON.stringify(enumerate(this.projectDir));
    } catch { return false; }
  }

  /** Private helper input only. Caller must never persist or expose this object. */
  ownerConfig(maxDurationMs: number) {
    return { version: 1 as const, projectDir: this.projectDir, artifactPath: this.artifactPath,
      interpreterPath: this.interpreterPath,
      artifactSha256: this.#artifact.sha256,
      interpreterSha256: this.#interpreter.sha256,
      maxDurationMs, parentPid: process.pid };
  }
}
