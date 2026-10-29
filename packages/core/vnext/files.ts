import { spawnSync } from "node:child_process";
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, writeSync, type BigIntStats } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { userInfo } from "node:os";
import { resolveTrustedHomeDirectory } from "../deploy/which.js";
import { catalogSchema, operationSchema, validate, VNextError, type Catalog, type Operation } from "./model.js";
import { parseMetadata } from "./json.js";
import { physicalIdentity } from "./identity.js";

const MAX_BYTES = 4 * 1024 * 1024;
const identity = (s: BigIntStats) => `${JSON.stringify(physicalIdentity(s))}:${s.uid}:${s.mode}`;
const version = (s: BigIntStats) => `${identity(s)}:${s.nlink}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
function stat(path: string): BigIntStats | null {
  try { return lstatSync(path, { bigint: true }); } catch (e) { if (absent(e)) return null; throw new VNextError("unavailable"); }
}
function noLinks(path: string): void {
  for (let p = resolve(path); ; p = dirname(p)) {
    const s = stat(p);
    if (s && s.isSymbolicLink()) throw new VNextError("unsafe-path");
    if (p === parse(p).root) break;
  }
}
function ancestry(path: string): string {
  const result: string[] = [];
  for (let p = dirname(resolve(path)); ; p = dirname(p)) {
    const s = lstatSync(p, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) throw new VNextError("unsafe-path");
    result.push(identity(s)); if (p === parse(p).root) break;
  }
  return result.join("|");
}

/** Windows mode bits do not describe DACLs. Inspect the real owner/ACEs, read-only. */
function windowsPermissions(path: string, initialize = false): void {
  const encoded = Buffer.from(path, "utf8").toString("base64");
  const script = `$ErrorActionPreference='Stop'; try {
    $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));
    $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    $a=Get-Acl -LiteralPath $p; if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $me){exit 2};
    ${initialize ? `$a.SetAccessRuleProtection($true,$false);
    $inherit=if([IO.Directory]::Exists($p)){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None};
    foreach($sid in @($me,'S-1-5-18','S-1-5-32-544')) {
      $r=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]::new($sid),'FullControl',$inherit,[Security.AccessControl.PropagationFlags]::None,'Allow'); $a.AddAccessRule($r)
    }; Set-Acl -LiteralPath $p -AclObject $a; $a=Get-Acl -LiteralPath $p;` : ""}
    foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($me,'S-1-5-18','S-1-5-32-544','S-1-3-4')){exit 3}
    }; [Console]::Out.Write('SAFE')
  } catch { exit 4 }`;
  const root = String.raw`C:\Windows`;
  const result = spawnSync(join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", cwd: join(root, "System32"), windowsHide: true, timeout: 10_000, maxBuffer: 1024,
      env: { SystemRoot: root, WINDIR: root, PATH: join(root, "System32") }, stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0 || result.stdout !== "SAFE") throw new VNextError("unsupported-owner");
}
function permissions(path: string, s: BigIntStats, directory: boolean): void {
  if (process.platform === "win32") { windowsPermissions(path); return; }
  if (!process.getuid || s.uid !== BigInt(process.getuid())) throw new VNextError("unsupported-owner");
  if ((s.mode & 0o077n) !== 0n || (s.mode & 0o7000n) !== 0n || (s.mode & (directory ? 0o700n : 0o600n)) !== (directory ? 0o700n : 0o600n)) throw new VNextError("unsafe-path");
}
function directory(path: string, create: boolean): BigIntStats {
  noLinks(path);
  if (create && !stat(path)) {
    mkdirSync(path, { mode: 0o700 });
    if (process.platform === "win32") windowsPermissions(path, true);
  }
  const s = stat(path);
  if (!s?.isDirectory() || s.isSymbolicLink()) throw new VNextError("unsafe-path");
  permissions(path, s, true);
  return s;
}
export type FileSnapshot = { bytes: Buffer; basis: string };
/** Also used for the read-only legacy importer. Never follows or repairs an index. */
export function readMetadataFile(path: string): FileSnapshot | null {
  noLinks(path);
  const before = stat(path);
  if (!before) return null;
  const parents = ancestry(path);
  if (!before.isFile() || before.nlink !== 1n || before.size > MAX_BYTES) throw new VNextError("unsafe-path");
  permissions(path, before, false);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (version(fstatSync(fd, { bigint: true })) !== version(before)) throw new VNextError("conflict");
    const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0, n = 0;
    while (length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, length)) > 0) length += n;
    if (BigInt(length) !== before.size || length > MAX_BYTES || version(fstatSync(fd, { bigint: true })) !== version(before) || version(lstatSync(path, { bigint: true })) !== version(before) || ancestry(path) !== parents) throw new VNextError("conflict");
    return { bytes: buffer.subarray(0, length), basis: version(before) };
  } finally { closeSync(fd); }
}
function sameFile(a: FileSnapshot | null, b: FileSnapshot | null): boolean {
  return a === null ? b === null : b !== null && a.basis === b.basis && a.bytes.equals(b.bytes);
}
function requireAbsent(path: string, reason: "lock-present" | "temporary-file-present"): void {
  if (stat(path)) throw new VNextError(reason);
}
function syncDirectory(path: string): void {
  // Windows has no Node directory fsync. Its native persistence acceptance is separate.
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export type CatalogSnapshot = { catalog: Catalog; file: FileSnapshot };
export type OperationSnapshot = { operation: Operation; file: FileSnapshot };
/** No OS-store access. baseDir is test-only, never a CLI flag or environment variable. */
export class CatalogStore {
  private readonly home: string;
  constructor(baseDir?: string) {
    const home = baseDir ?? (process.platform === "win32" ? resolveTrustedHomeDirectory() : userInfo().homedir);
    if (!home) throw new VNextError("unsupported-owner");
    noLinks(home); this.home = realpathSync.native(home);
  }
  private location(create: boolean): string | null {
    noLinks(this.home);
    const app = join(this.home, ".api-key-case"), root = join(app, "vnext");
    if (!create && !stat(root)) {
      const s = stat(app);
      if (s && (!s.isDirectory() || s.isSymbolicLink())) throw new VNextError("unsafe-path");
      return null;
    }
    // Keep the legacy container and files untouched. Only our subtree is private.
    if (create && !stat(app)) directory(app, true);
    const parent = stat(app);
    if (!parent?.isDirectory() || parent.isSymbolicLink()) throw new VNextError("unsafe-path");
    if (process.platform === "win32") windowsPermissions(app);
    if (process.platform !== "win32" && (!process.getuid || parent.uid !== BigInt(process.getuid()) || (parent.mode & 0o022n) !== 0n)) throw new VNextError("unsupported-owner");
    directory(root, create);
    return root;
  }
  private clear(root: string): void {
    requireAbsent(join(root, "lock"), "lock-present");
    requireAbsent(join(root, "catalog.json.tmp"), "temporary-file-present");
  }
  readCatalog(): CatalogSnapshot | null {
    const root = this.location(false); if (!root) return null;
    this.clear(root);
    const file = readMetadataFile(join(root, "catalog.json"));
    if (!file) return null;
    const catalog = validate(catalogSchema, parseMetadata(file.bytes));
    this.clear(root);
    return { catalog, file };
  }
  private claim<T>(root: string, name: string, action: () => T): T {
    const lock = join(root, name);
    if (stat(lock)) throw new VNextError("lock-present");
    try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new VNextError("lock-present"); }
    const owned = directory(lock, false);
    try { return action(); }
    finally {
      // Never remove a foreign/replaced/uncertain lock or guess from its age.
      const current = stat(lock);
      if (current && identity(current) === identity(owned) && current.isDirectory() && !current.isSymbolicLink()) {
        rmdirSync(lock); syncDirectory(root);
      }
    }
  }
  private replace(path: string, expected: FileSnapshot | null, bytes: Buffer): void {
    if (bytes.length > MAX_BYTES) throw new VNextError("capacity");
    const root = dirname(path), parent = directory(root, false), temporary = `${path}.tmp`;
    requireAbsent(temporary, "temporary-file-present");
    if (!sameFile(expected, readMetadataFile(path))) throw new VNextError("conflict");
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const opened = fstatSync(fd, { bigint: true });
    try {
      if (process.platform === "win32") windowsPermissions(temporary, true);
      let offset = 0;
      while (offset < bytes.length) {
        const n = writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!n) throw new VNextError("unavailable"); offset += n;
      }
      fsyncSync(fd);
      const current = fstatSync(fd, { bigint: true });
      if (identity(current) !== identity(opened) || current.nlink !== 1n || current.size !== BigInt(bytes.length)) throw new VNextError("conflict");
    } finally { closeSync(fd); }
    const written = readMetadataFile(temporary);
    if (!written || !written.bytes.equals(bytes) || identity(lstatSync(temporary, { bigint: true })) !== identity(opened) ||
      identity(directory(root, false)) !== identity(parent) || !sameFile(expected, readMetadataFile(path))) throw new VNextError("conflict");
    renameSync(temporary, path); syncDirectory(root);
  }
  compareAndSwap(expected: CatalogSnapshot | null, input: Catalog): CatalogSnapshot {
    const catalog = validate(catalogSchema, input);
    if (expected && JSON.stringify(validate(catalogSchema, parseMetadata(expected.file.bytes))) !== JSON.stringify(expected.catalog)) throw new VNextError("conflict");
    if (expected && catalog.revision !== expected.catalog.revision + 1 || !expected && catalog.revision !== 0) throw new VNextError("conflict");
    const root = this.location(true)!;
    return this.claim(root, "lock", () => {
      requireAbsent(join(root, "catalog.json.tmp"), "temporary-file-present");
      this.replace(join(root, "catalog.json"), expected?.file ?? null, Buffer.from(JSON.stringify(catalog)));
      const file = readMetadataFile(join(root, "catalog.json"))!;
      return { catalog, file };
    });
  }
  readOperation(operationId: string): OperationSnapshot | null {
    this.validId(operationId);
    const root = this.location(false); if (!root) return null;
    const dir = join(root, "operations"); if (!stat(dir)) return null; directory(dir, false);
    requireAbsent(join(dir, `${operationId}.lock`), "lock-present");
    requireAbsent(join(dir, `${operationId}.json.tmp`), "temporary-file-present");
    const file = readMetadataFile(join(dir, `${operationId}.json`)); if (!file) return null;
    const operation = validate(operationSchema, parseMetadata(file.bytes));
    if (operation.operationId !== operationId) throw new VNextError("invalid-data");
    requireAbsent(join(dir, `${operationId}.lock`), "lock-present");
    return { operation, file };
  }
  saveOperation(expected: OperationSnapshot | null, input: Operation): OperationSnapshot {
    const operation = validate(operationSchema, input);
    if (expected && JSON.stringify(validate(operationSchema, parseMetadata(expected.file.bytes))) !== JSON.stringify(expected.operation)) throw new VNextError("conflict");
    if (expected && expected.operation.operationId !== operation.operationId) throw new VNextError("conflict");
    if (expected) {
      const { state: oldState, timestamps: oldTimes, effects: oldEffects, ...oldBasis } = expected.operation;
      const { state: newState, timestamps: newTimes, effects: newEffects, ...newBasis } = operation;
      const transitions: Record<string, string[]> = { "not-started": ["not-started", "possible"],
        possible: ["possible", "completed", "failed", "unknown"], completed: ["completed"], failed: ["failed"], unknown: ["unknown"] };
      const effectsValid = ["cloudflare-use", "vercel-use", "github-use", "local-launch"].includes(operation.kind) ? oldEffects.length === newEffects.length &&
        oldEffects.every((effect, i) => effect.targetId === newEffects[i].targetId && transitions[effect.state].includes(newEffects[i].state)) :
        JSON.stringify(oldEffects) === JSON.stringify(newEffects);
      if (JSON.stringify(oldBasis) !== JSON.stringify(newBasis) || oldTimes.createdAt !== newTimes.createdAt || newTimes.updatedAt < oldTimes.updatedAt ||
        !effectsValid ||
        ["committed", "cancelled", "conflict", "completed", "exited", "failed", "expired", "incomplete"].includes(oldState) && oldState !== newState ||
        operation.kind === "local-launch" && oldState === "changed" && oldState !== newState) throw new VNextError("conflict");
    }
    const root = this.location(true)!, dir = join(root, "operations"); directory(dir, true);
    if (!expected && readdirSync(dir).length >= 8192) throw new VNextError("capacity");
    return this.claim(dir, `${operation.operationId}.lock`, () => {
      const path = join(dir, `${operation.operationId}.json`);
      this.replace(path, expected?.file ?? null, Buffer.from(JSON.stringify(operation)));
      return { operation, file: readMetadataFile(path)! };
    });
  }
  listUseOperations(bindingId: string, targetId: string): Operation[] {
    this.validId(bindingId); this.validId(targetId);
    return this.listOperations().filter(o => ["cloudflare-use", "vercel-use", "github-use"].includes(o.kind) && o.bindingId === bindingId && o.boundBasis.targetId === targetId);
  }
  listLaunchOperations(profileId: string): Operation[] {
    this.validId(profileId);
    return this.listOperations().filter(o => o.kind === "local-launch" && o.boundBasis.targetId === profileId);
  }
  listRegistrationOperations(): Operation[] {
    return this.listOperations().filter(o => o.kind === "registration");
  }
  private listOperations(): Operation[] {
    const root = this.location(false); if (!root) return [];
    const path = join(root, "operations"); if (!stat(path)) return [];
    directory(path, false);
    const names = readdirSync(path);
    if (names.length > 8192) throw new VNextError("capacity");
    const operations: Operation[] = [];
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw new VNextError("lock-present");
      const record = this.readOperation(name.slice(0, -5));
      if (!record) throw new VNextError("conflict");
      operations.push(record.operation);
    }
    return operations;
  }
  /** Held across the independent dialog and execution. A process death leaves a visible lock. */
  async withUseLock<T>(bindingId: string, targetId: string, action: (owns: () => boolean) => Promise<T>): Promise<T> {
    this.validId(bindingId); this.validId(targetId);
    const root = this.location(true)!, dir = join(root, "use-locks"); directory(dir, true);
    const lock = join(dir, `${bindingId}-${targetId}`);
    if (stat(lock)) throw new VNextError("lock-present");
    try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new VNextError("lock-present"); }
    const owned = directory(lock, false), parent = directory(dir, false);
    const owns = () => {
      try { noLinks(lock); const current = stat(lock), currentParent = stat(dir);
        return Boolean(current && currentParent && current.isDirectory() && !current.isSymbolicLink() &&
          identity(current) === identity(owned) && identity(currentParent) === identity(parent));
      } catch { return false; }
    };
    try { return await action(owns); }
    finally {
      if (owns()) { rmdirSync(lock); syncDirectory(dir); }
    }
  }
  private validId(id: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new VNextError("invalid-data");
  }
}
