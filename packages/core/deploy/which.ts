import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import { userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ResolvedExecutable {
  absolutePath: string;
  realPath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  dev: number;
  ino: number;
  contentHash: string;
}

export interface ResolvedCli extends ResolvedExecutable {
  isWindowsScript: boolean; // .cmd / .bat — needs the fixed cmd.exe wrapper below
  /** Frozen OS-derived PATH used for trusted execution; absent for legacy PATH resolution. */
  trustedPath?: string;
  /** Exact Node runtime for a trusted macOS `#!/usr/bin/env node` CLI. */
  interpreter?: ResolvedExecutable;
}

export interface TrustedCliOptions {
  /** Test-only fixture path. Production high-risk resolution never uses it. */
  pathOverride?: string;
  projectDir?: string;
  /** Test-only platform branch used with pathOverride attack fixtures. */
  platformOverride?: NodeJS.Platform;
  /** Test-only exact interpreter used with a darwin pathOverride fixture. */
  interpreterOverride?: string;
}

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat"] as const;
const TRUSTED_COMMANDS = new Set(["wrangler", "vercel", "gh"]);
const WINDOWS_ROOT = String.raw`C:\Windows`;
const WINDOWS_REG_PATH = String.raw`C:\Windows\System32\reg.exe`;
const WINDOWS_CMD_PATH = String.raw`C:\Windows\System32\cmd.exe`;
const WINDOWS_WHOAMI_PATH = String.raw`C:\Windows\System32\whoami.exe`;

// Resolves a CLI from the supplied PATH (or the normal process PATH for the
// existing low-risk path). High-risk deploys must use resolveTrustedCli,
// which obtains PATH from the Windows Machine/User registry instead of an
// Agent-controlled process environment.
export function resolveCli(command: string, pathOverride?: string): ResolvedCli | null {
  const pathValue = pathOverride ?? process.env.PATH ?? process.env.Path ?? "";
  const dirs = pathValue.split(delimiter).filter(Boolean);

  for (const dir of dirs) {
    if (process.platform === "win32") {
      for (const ext of WINDOWS_EXTENSIONS) {
        const candidate = join(dir, `${command}${ext}`);
        const resolved = inspectCandidate(candidate, ext === ".cmd" || ext === ".bat");
        if (resolved) return resolved;
      }
    } else {
      const candidate = join(dir, command);
      const resolved = inspectCandidate(candidate, false);
      if (resolved && isExecutable(resolved.absolutePath)) return resolved;
    }
  }

  return null;
}

// High-risk CLI resolution never consults the caller's PATH. Windows uses the
// persistent registry PATH; macOS uses a closed set of common installation
// directories derived only from OS-owned constants, the OS user database, and
// the already-running Node executable. Linux has no trusted executing-deploy
// path in this release.
// `pathOverride` is a test fixture seam and is never selected by the production CLI.
export function resolveTrustedCli(
  command: string,
  options: TrustedCliOptions = {}
): ResolvedCli | null {
  if (options.pathOverride !== undefined) {
    if (options.platformOverride === "darwin") {
      const projectDir = options.projectDir ? safeRealpath(options.projectDir) : null;
      if (options.projectDir && !projectDir) return null;
      const trustedDirs = options.pathOverride
        .split(delimiter)
        .map(safeRealpath)
        .filter((entry): entry is string => Boolean(entry))
        .filter((entry) => isSafeTrustedDirectory(entry, projectDir));
      return resolveMacOSTrustedCli(
        command,
        trustedDirs,
        projectDir,
        options.interpreterOverride
      );
    }
    return resolveCli(command, options.pathOverride);
  }
  if (!TRUSTED_COMMANDS.has(command)) {
    return null;
  }

  const projectDir = options.projectDir ? safeRealpath(options.projectDir) : null;
  if (options.projectDir && !projectDir) return null;
  const trustedHome = resolveTrustedHomeDirectory();
  if (!trustedHome) return null;
  const candidateDirs = process.platform === "win32"
    ? readWindowsTrustedCliDirectories(trustedHome)
    : process.platform === "darwin"
      ? macOSTrustedCliDirectories(trustedHome)
      : [];
  if (candidateDirs.length === 0) return null;

  // The same PATH is passed to npm-generated .cmd shims, which commonly
  // resolve `node` as a child command. Do not leave a repository-owned entry
  // in that child PATH after correctly selecting the provider shim itself.
  const trustedDirs: string[] = [];
  const seen = new Set<string>();
  for (const dir of candidateDirs) {
    const trustedDir = safeRealpath(dir);
    if (!trustedDir || !isSafeTrustedDirectory(trustedDir, projectDir)) continue;
    const normalized = normalizeForCompare(trustedDir);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    trustedDirs.push(trustedDir);
  }

  const trustedPath = trustedDirs.join(delimiter);
  if (process.platform === "win32") {
    for (const trustedDir of trustedDirs) {
      for (const ext of WINDOWS_EXTENSIONS) {
        const candidate = join(trustedDir, `${command}${ext}`);
        const resolved = inspectCandidate(candidate, ext === ".cmd" || ext === ".bat", trustedPath);
        if (resolved && isPathOutsideProject(resolved.realPath, projectDir)) return resolved;
      }
    }
  } else if (process.platform === "darwin") {
    return resolveMacOSTrustedCli(command, trustedDirs, projectDir);
  }
  return null;
}

/**
 * Resolve the current user's home without consulting Agent-owned HOME or
 * USERPROFILE. Windows uses the account SID and registry profile mapping;
 * macOS uses getpwuid-backed os.userInfo(). Linux is deliberately unsupported.
 */
export function resolveTrustedHomeDirectory(): string | null {
  if (process.platform === "darwin") {
    try {
      const home = realpathSync.native(userInfo().homedir);
      return statSync(home).isDirectory() ? home : null;
    } catch {
      return null;
    }
  }
  if (process.platform !== "win32") return null;

  try {
    const env = { SystemRoot: WINDOWS_ROOT, WINDIR: WINDOWS_ROOT };
    const whoami = spawnSync(WINDOWS_WHOAMI_PATH, ["/user"], {
      cwd: String.raw`C:\Windows\System32`,
      env,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      shell: false
    });
    if (whoami.status !== 0 || typeof whoami.stdout !== "string") return null;
    const sid = whoami.stdout.match(/S-1-\d(?:-\d+){1,15}/i)?.[0];
    if (!sid) return null;

    const result = spawnSync(
      WINDOWS_REG_PATH,
      [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\" + sid,
        "/v",
        "ProfileImagePath"
      ],
      {
        cwd: String.raw`C:\Windows\System32`,
        env,
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        shell: false
      }
    );
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const match = result.stdout
      .split(/\r?\n/)
      .map((line) => /^\s*ProfileImagePath\s+\S+\s+(.*?)\s*$/.exec(line))
      .find((entry): entry is RegExpExecArray => entry !== null);
    if (!match) return null;
    const profilePath = expandTrustedProfilePath(match[1]);
    if (!profilePath) return null;
    const profile = realpathSync.native(resolve(profilePath));
    if (statSync(profile).isDirectory()) return profile;
  } catch {
    // A missing/blocked profile lookup is an unavailable trusted path.
  }
  return null;
}

function readWindowsTrustedCliDirectories(trustedHome: string): string[] {
  const candidateDirs = readWindowsRegistryPath(trustedHome);
  // npm's per-user global bin is derived from the independently resolved OS
  // profile, not from process PATH/APPDATA. Some npm installations do not add
  // this directory to the persistent registry PATH.
  candidateDirs.unshift(join(trustedHome, "AppData", "Roaming", "npm"));
  return candidateDirs;
}

function macOSTrustedCliDirectories(trustedHome: string): string[] {
  const architectureDirs = process.arch === "arm64"
    ? ["/opt/homebrew/bin", "/usr/local/bin"]
    : ["/usr/local/bin", "/opt/homebrew/bin"];
  const nodeDirectory = trustedMacOSNodeDirectory(trustedHome);
  return [
    ...(nodeDirectory ? [nodeDirectory] : []),
    ...architectureDirs,
    "/opt/local/bin",
    join(trustedHome, ".local", "bin"),
    join(trustedHome, ".npm-global", "bin"),
    join(trustedHome, "Library", "pnpm"),
    join(trustedHome, ".volta", "bin"),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ];
}

function trustedMacOSNodeDirectory(trustedHome: string): string | null {
  const nodeDirectory = safeRealpath(dirname(process.execPath));
  if (!nodeDirectory) return null;

  if (
    nodeDirectory === "/opt/homebrew/bin" ||
    nodeDirectory === "/usr/local/bin" ||
    /^\/opt\/homebrew\/Cellar\/node(?:@[^/]+)?\/[^/]+\/bin$/.test(nodeDirectory) ||
    /^\/usr\/local\/Cellar\/node(?:@[^/]+)?\/[^/]+\/bin$/.test(nodeDirectory)
  ) {
    return nodeDirectory;
  }

  const withinHome = relative(trustedHome, nodeDirectory).replace(/\\/g, "/");
  if (withinHome.startsWith("../") || withinHome === "..") return null;
  return /^(?:\.nvm\/versions\/node\/[^/]+\/bin|\.fnm\/node-versions\/[^/]+\/installation\/bin|Library\/Application Support\/fnm\/node-versions\/[^/]+\/installation\/bin|\.asdf\/installs\/nodejs\/[^/]+\/bin|\.local\/share\/mise\/installs\/node\/[^/]+\/bin|\.volta\/(?:bin|tools\/image\/node\/[^/]+\/bin))$/.test(withinHome)
    ? nodeDirectory
    : null;
}

function expandTrustedProfilePath(value: string): string | null {
  if (!value) return null;
  const expanded = value
    .replace(/%SystemRoot%/gi, WINDOWS_ROOT)
    .replace(/%WINDIR%/gi, WINDOWS_ROOT)
    .replace(/%SystemDrive%/gi, WINDOWS_ROOT.slice(0, 2));
  if (/%[^%]+%/.test(expanded) || !isAbsolute(expanded)) return null;
  return expanded;
}

export function isSameResolvedCli(left: ResolvedCli, right: ResolvedCli): boolean {
  return (
    isSameExecutable(left, right) &&
    left.isWindowsScript === right.isWindowsScript &&
    left.trustedPath === right.trustedPath &&
    ((!left.interpreter && !right.interpreter) ||
      Boolean(left.interpreter && right.interpreter &&
        isSameExecutable(left.interpreter, right.interpreter)))
  );
}

// Re-stat the exact path captured by the approval snapshot. It intentionally
// does not resolve a fresh PATH entry: a replacement at the same path must be
// detected rather than silently accepted.
export function currentResolvedCli(resolved: ResolvedCli): ResolvedCli | null {
  const current = inspectCandidate(
    resolved.absolutePath,
    resolved.isWindowsScript,
    resolved.trustedPath
  );
  if (!current || !resolved.interpreter) return current;
  const interpreter = inspectExecutable(resolved.interpreter.absolutePath);
  return interpreter ? Object.freeze({ ...current, interpreter }) : null;
}

function inspectCandidate(
  candidate: string,
  isWindowsScript: boolean,
  trustedPath?: string
): ResolvedCli | null {
  try {
    const absolutePath = resolve(candidate);
    // A .cmd/.bat path is parsed by the fixed cmd.exe wrapper. Reject command
    // metacharacters instead of relying on shell quoting for an Agent-created
    // registry PATH entry or fixture path.
    if (process.platform === "win32" && isWindowsScript && /[\r\n\0&|<>^%!" ]/u.test(absolutePath)) {
      return null;
    }
    const executable = inspectExecutable(absolutePath);
    if (!executable) return null;
    return Object.freeze({
      ...executable,
      isWindowsScript,
      trustedPath
    });
  } catch {
    return null;
  }
}

function inspectExecutable(candidate: string): ResolvedExecutable | null {
  try {
    const absolutePath = resolve(candidate);
    const stats = statSync(absolutePath);
    if (!stats.isFile()) return null;
    const realPath = realpathSync.native(absolutePath);
    return Object.freeze({
      absolutePath,
      realPath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      birthtimeMs: stats.birthtimeMs,
      dev: stats.dev,
      ino: stats.ino,
      // Executables are code, not Secret-bearing state. Hashing closes
      // same-size/same-mtime replacement gaps for both CLI and interpreter.
      contentHash: createHash("sha256").update(readFileSync(realPath)).digest("hex")
    });
  } catch {
    return null;
  }
}

function resolveMacOSTrustedCli(
  command: string,
  trustedDirs: readonly string[],
  projectDir: string | null,
  interpreterOverride?: string
): ResolvedCli | null {
  const trustedPath = trustedDirs.join(delimiter);
  for (const trustedDir of trustedDirs) {
    const resolved = inspectCandidate(join(trustedDir, command), false, trustedPath);
    if (!resolved || !isExecutable(resolved.absolutePath) ||
        !isPathOutsideProject(resolved.realPath, projectDir)) continue;
    const pinned = pinMacOSInterpreter(
      resolved,
      trustedDirs,
      projectDir,
      interpreterOverride ?? process.execPath
    );
    if (pinned) return pinned;
  }
  return null;
}

function pinMacOSInterpreter(
  cli: ResolvedCli,
  trustedDirs: readonly string[],
  projectDir: string | null,
  interpreterPath: string
): ResolvedCli | null {
  let firstLine: string;
  try {
    firstLine = readFileSync(cli.realPath).subarray(0, 256).toString("utf8").split(/\r?\n/, 1)[0];
  } catch {
    return null;
  }
  if (!firstLine.startsWith("#!")) return cli;
  if (firstLine !== "#!/usr/bin/env node") return null;

  const interpreter = inspectExecutable(interpreterPath);
  if (!interpreter || !isExecutable(interpreter.absolutePath) ||
      !isPathOutsideProject(interpreter.realPath, projectDir)) return null;
  const interpreterDirectory = safeRealpath(dirname(interpreter.absolutePath));
  if (!interpreterDirectory || !trustedDirs.some(
    (directory) => normalizeForCompare(directory) === normalizeForCompare(interpreterDirectory)
  )) return null;
  return Object.freeze({ ...cli, interpreter });
}

function isSameExecutable(left: ResolvedExecutable, right: ResolvedExecutable): boolean {
  return (
    normalizeForCompare(left.absolutePath) === normalizeForCompare(right.absolutePath) &&
    normalizeForCompare(left.realPath) === normalizeForCompare(right.realPath) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.contentHash === right.contentHash
  );
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readWindowsRegistryPath(trustedHome: string): string[] {
  if (process.platform !== "win32") return [];

  const keys = [
    String.raw`HKCU\Environment`,
    String.raw`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`
  ];
  const dirs: string[] = [];
  for (const key of keys) {
    try {
      const result = spawnSync(WINDOWS_REG_PATH, ["query", key, "/v", "Path"], {
        cwd: String.raw`C:\Windows\System32`,
        env: { SystemRoot: WINDOWS_ROOT, WINDIR: WINDOWS_ROOT },
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        shell: false
      });
      if (result.status !== 0 || typeof result.stdout !== "string") continue;
      const line = result.stdout
        .split(/\r?\n/)
        .find((entry) => /^\s*Path\s+REG_/i.test(entry));
      if (!line) continue;
      const match = /^\s*Path\s+\S+\s+(.*)\s*$/i.exec(line);
      if (!match) continue;
      for (const raw of match[1].split(";")) {
        const expanded = expandTrustedWindowsPath(raw.trim(), trustedHome);
        if (expanded) dirs.push(expanded);
      }
    } catch {
      // A missing/blocked registry helper is an unavailable Human Plane.
    }
  }
  return [...new Set(dirs)];
}

function expandTrustedWindowsPath(value: string, trustedHome: string): string | null {
  if (!value) return null;
  const expanded = value
    .replace(/%SystemRoot%/gi, WINDOWS_ROOT)
    .replace(/%WINDIR%/gi, WINDOWS_ROOT)
    .replace(/%SystemDrive%/gi, WINDOWS_ROOT.slice(0, 2))
    .replace(/%USERPROFILE%/gi, trustedHome)
    .replace(/%APPDATA%/gi, join(trustedHome, "AppData", "Roaming"))
    .replace(/%LOCALAPPDATA%/gi, join(trustedHome, "AppData", "Local"));
  // Do not consult arbitrary process environment values to expand PATH. An
  // unresolved variable could point at an Agent-controlled directory.
  if (/%[^%]+%/.test(expanded) || !isAbsolute(expanded)) return null;
  return expanded;
}

function isSafeTrustedDirectory(directory: string, projectDir: string | null): boolean {
  const normalized = resolve(directory);
  if (!isAbsolute(normalized) || normalized === String.raw`C:\Windows`) return false;
  if (!projectDir) return true;
  const outside = relative(projectDir, normalized);
  // Registry PATH entries inside the repository (including a child `bin`
  // directory) are still Agent-controlled and cannot be the trusted CLI.
  const parentPrefix = process.platform === "win32" ? "..\\" : "../";
  return outside === ".." || outside.startsWith(parentPrefix);
}

function isPathOutsideProject(path: string, projectDir: string | null): boolean {
  if (!projectDir) return true;
  const outside = relative(projectDir, path);
  const parentPrefix = process.platform === "win32" ? "..\\" : "../";
  return outside === ".." || outside.startsWith(parentPrefix);
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function normalizeForCompare(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// Node 20+ throws EINVAL spawning a .cmd/.bat directly with shell:false
// (hardening for CVE-2024-27980). Workaround: invoke through the OS-fixed
// cmd.exe on Windows.
// `args` MUST already be validated tokens only (secret NAME regex, closed
// DeployEnv enum, static CLI subcommand literals) — never add an
// unvalidated string to this argv, since cmd.exe re-parses it.
export function spawnResolvedCli(
  resolved: ResolvedCli,
  args: string[],
  options: SpawnOptionsWithoutStdio
): ChildProcess {
  if (resolved.isWindowsScript) {
    const launcher = process.platform === "win32" ? WINDOWS_CMD_PATH : "cmd.exe";
    return spawn(launcher, ["/d", "/s", "/c", resolved.absolutePath, ...args], {
      ...options,
      shell: false
    });
  }
  if (resolved.interpreter) {
    return spawn(resolved.interpreter.realPath, [resolved.realPath, ...args], {
      ...options,
      shell: false
    });
  }
  return spawn(resolved.realPath, args, { ...options, shell: false });
}
