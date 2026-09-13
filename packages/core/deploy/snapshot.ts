import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { userInfo } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { parse as parseJsonc, parseTree as parseJsoncTree, type Node, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import type {
  ApprovalPlan,
  ApprovalTrustState,
  DeployEnv,
  DeployPlan,
  TargetId
} from "./types.js";
import {
  currentResolvedCli,
  isSameResolvedCli,
  resolveTrustedCli,
  type ResolvedCli
} from "./which.js";
import { resolveTrustedHomeDirectory } from "./which.js";
import type { SecretScope } from "../vault/types.js";

/**
 * A value-free description of the exact deploy operation. This object is
 * intentionally internal to one runDeploy call and is never returned to the
 * caller, written to disk, or sent to the Human Plane helper.
 */
export interface ExecutionSnapshot {
  readonly projectDir: string;
  readonly processCwd: string;
  readonly homeDir: string;
  readonly name: string;
  readonly scope: SecretScope;
  readonly projectId: string | null;
  readonly target: TargetId;
  readonly env: DeployEnv;
  readonly force: boolean;
  readonly destinationLabel: string;
  readonly argv: readonly string[];
  readonly preSteps: readonly (readonly string[])[];
  readonly cli: ResolvedCli;
  readonly destinationConfig: readonly FileFingerprint[];
  readonly providerAuthFiles: readonly FileFingerprint[];
  readonly projectEnvFiles: readonly FileFingerprint[];
  /** Names only. Values and value-derived hashes are never captured. */
  readonly providerEnvNames: readonly string[];
  /** Non-credential account identity returned by the fixed provider CLI. */
  readonly providerIdentity: string | null;
}

export interface TrustedExecution {
  readonly cwd: string;
  readonly processCwd: string;
  readonly env: Record<string, string>;
  readonly resolvedCli: ResolvedCli;
  readonly snapshot: ExecutionSnapshot;
}

export interface FileFingerprint {
  readonly path: string;
  readonly exists: boolean;
  readonly kind: "file" | "directory" | "other" | null;
  readonly realPath: string | null;
  readonly mtimeMs: number | null;
  readonly ctimeMs: number | null;
  readonly birthtimeMs: number | null;
  readonly mode: number | null;
  readonly dev: number | null;
  readonly ino: number | null;
  readonly contentHash: string | null;
  readonly destinationLabel: string | null;
  readonly readable: boolean;
}

export type TrustedExecutionFailure =
  | "unsupported-platform"
  | "unsafe-environment"
  | "cli-unavailable"
  | "invalid-project";

export type TrustedExecutionResult =
  | { ok: true; execution: TrustedExecution }
  | { ok: false; reason: TrustedExecutionFailure };

export interface SnapshotRequest {
  readonly name: string;
  readonly scope: SecretScope;
  readonly projectId: string | null;
  readonly env: DeployEnv;
  readonly force: boolean;
  readonly adapterId: TargetId;
  readonly cliCommand: string;
  readonly providerIdentity: string | null;
}

const PROVIDER_ENV: Record<TargetId, readonly string[]> = {
  cloudflare: [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "CLOUDFLARE_ACCOUNT_ID"
  ],
  vercel: ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"],
  github: [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
    "GH_REPO",
    "GH_CONFIG_DIR"
  ]
};

const DESTINATION_CONFIGS: Record<TargetId, readonly string[]> = {
  cloudflare: ["wrangler.toml", "wrangler.json", "wrangler.jsonc"],
  vercel: [".vercel/project.json", "vercel.json"],
  github: [".git", ".git/config", ".git/config.worktree"]
};

// What binding a destination actually requires, kept beside the checks that
// enforce it. A config that satisfies the provider's own CLI can still fail
// these — `wrangler` infers the account from the login when there is only one,
// while this tool refuses to let a login decide where a Secret lands. Without
// this line the denial leaves a user with a working wrangler.toml and no way
// to tell what is missing.
export const DESTINATION_REQUIREMENT: Readonly<Record<TargetId, string>> = Object.freeze({
  cloudflare:
    'exactly one readable wrangler.toml/.json/.jsonc holding both "name" and "account_id" ' +
    "(at the root, or in the [env.<name>] section for a non-production environment)",
  vercel:
    'a readable .vercel/project.json holding both "projectId" and "orgId" (create it with: vercel link)',
  github:
    'a readable .git/config with exactly one remote, "origin", whose url is on github.com, ' +
    "and no .git/config.worktree"
});

const AUTH_FILE_RELATIVE_PATHS: Record<TargetId, readonly string[]> = {
  cloudflare: [
    ".config/.wrangler/config/default.toml",
    ".config/.wrangler/config/default.enc",
    ".wrangler/config/default.toml",
    ".wrangler/config/default.enc",
    "AppData/Roaming/.wrangler/config/default.toml",
    "AppData/Roaming/.wrangler/config/default.enc"
  ],
  vercel: [
    "AppData/Roaming/xdg.data/com.vercel.cli/config.json",
    "AppData/Roaming/xdg.data/com.vercel.cli/auth.json",
    "Library/Application Support/com.vercel.cli/config.json",
    "Library/Application Support/com.vercel.cli/auth.json",
    ".local/share/com.vercel.cli/config.json",
    ".local/share/com.vercel.cli/auth.json"
  ],
  github: [
    "AppData/Roaming/GitHub CLI/hosts.yml",
    "AppData/Roaming/GitHub CLI/config.yml",
    ".config/gh/hosts.yml",
    ".config/gh/config.yml"
  ]
};

export function buildTrustedExecution(
  request: SnapshotRequest,
  plan: DeployPlan,
  options: { pathOverride?: string; projectDir: string }
): TrustedExecutionResult {
  let projectDir: string;
  let processCwd: string;
  let homeDir: string;
  try {
    projectDir = realpathSync.native(options.projectDir);
    if (!statSync(projectDir).isDirectory()) {
      return { ok: false, reason: "invalid-project" };
    }
    processCwd = realpathSync.native(process.cwd());
    const trustedHome = trustedHomeDirectory(options.pathOverride !== undefined);
    if (!trustedHome || !statSync(trustedHome).isDirectory()) {
      return { ok: false, reason: "unsafe-environment" };
    }
    homeDir = trustedHome;
  } catch {
    return { ok: false, reason: "invalid-project" };
  }

  // Provider auth/destination environment values are intentionally not
  // fingerprinted. Their mere presence makes a high-risk Agent-first flow
  // unavailable, so no credential value or credential hash can enter this
  // process's snapshot or the Human Plane helper.
  const providerEnvNames = providerEnvironmentNames(request.adapterId, process.env);
  if (providerEnvNames.length > 0) {
    return { ok: false, reason: "unsafe-environment" };
  }

  const projectEnvFiles = fingerprintProjectEnvFiles(projectDir, request.adapterId);
  // Wrangler explicitly loads project .env variants. Do not guess which value
  // wins; require a human-owned handoff whenever one exists.
  if (projectEnvFiles.some((file) => file.exists)) {
    return { ok: false, reason: "unsafe-environment" };
  }

  const destinationConfig = DESTINATION_CONFIGS[request.adapterId].map((relativePath) =>
    fingerprintFile(join(projectDir, ...relativePath.split("/")), request.adapterId, request.env)
  );
  if (destinationConfig.some((file) => file.exists && !file.readable)) {
    return { ok: false, reason: "unsafe-environment" };
  }
  if (!hasConcreteDestination(request.adapterId, destinationConfig)) {
    return { ok: false, reason: "unsafe-environment" };
  }

  const resolvedCli = resolveTrustedCli(request.cliCommand, {
    pathOverride: options.pathOverride,
    projectDir
  });
  if (!resolvedCli) {
    return {
      ok: false,
      reason: process.platform === "win32" || process.platform === "darwin"
        ? "cli-unavailable"
        : "unsupported-platform"
    };
  }

  const snapshot = createSnapshot(
    request,
    plan,
    projectDir,
    processCwd,
    homeDir,
    resolvedCli,
    providerEnvNames,
    projectEnvFiles,
    destinationConfig
  );
  if (snapshot.providerAuthFiles.some((file) => file.exists && !file.readable)) {
    return { ok: false, reason: "unsafe-environment" };
  }

  const execution: TrustedExecution = Object.freeze({
    cwd: projectDir,
    processCwd,
    env: Object.freeze(buildTrustedExecutionEnvironment(resolvedCli, options.pathOverride, homeDir)),
    resolvedCli,
    snapshot
  });

  return { ok: true, execution };
}

export function makeApprovalPlan(
  request: SnapshotRequest,
  plan: DeployPlan,
  execution: TrustedExecution,
  trustState: ApprovalTrustState
): ApprovalPlan {
  return Object.freeze({
    trustState,
    name: request.name,
    scope: request.scope,
    projectId: request.projectId,
    target: request.adapterId,
    env: request.env,
    force: request.force,
    projectDir: execution.cwd,
    destination: execution.snapshot.destinationLabel,
    cliPath: execution.resolvedCli.absolutePath,
    // Render only the closed argv that will be executed. Adapter-provided
    // prose is not a security anchor and must not be able to smuggle data into
    // the approval UI.
    command: plan.argv.join(" "),
    preCommands: Object.freeze((plan.preSteps ?? []).map((step) => step.argv.join(" ")))
  });
}

export function matchesTrustedExecution(
  request: SnapshotRequest,
  plan: DeployPlan,
  execution: TrustedExecution
): boolean {
  let currentProjectDir: string;
  try {
    currentProjectDir = realpathSync.native(execution.cwd);
  } catch {
    return false;
  }
  if (currentProjectDir !== execution.snapshot.projectDir) return false;
  let currentProcessCwd: string;
  try {
    currentProcessCwd = realpathSync.native(process.cwd());
  } catch {
    return false;
  }
  if (currentProcessCwd !== execution.snapshot.processCwd) return false;

  const currentHomeDir = trustedHomeDirectory(execution.resolvedCli.trustedPath === undefined);
  if (!currentHomeDir || currentHomeDir !== execution.snapshot.homeDir) return false;

  const providerEnvNames = providerEnvironmentNames(request.adapterId, process.env);
  if (providerEnvNames.length > 0) return false;

  const currentCli = currentResolvedCli(execution.resolvedCli);
  if (!currentCli || !isSameResolvedCli(currentCli, execution.snapshot.cli)) return false;

  const currentEnvFiles = fingerprintProjectEnvFiles(currentProjectDir, request.adapterId);
  if (currentEnvFiles.some((file) => file.exists)) return false;

  const currentDestinationConfig = DESTINATION_CONFIGS[request.adapterId].map((relativePath) =>
    fingerprintFile(join(currentProjectDir, ...relativePath.split("/")), request.adapterId, request.env)
  );
  if (currentDestinationConfig.some((file) => file.exists && !file.readable)) return false;
  if (!hasConcreteDestination(request.adapterId, currentDestinationConfig)) return false;

  const current = createSnapshot(
    request,
    plan,
    currentProjectDir,
    currentProcessCwd,
    currentHomeDir,
    currentCli,
    providerEnvNames,
    currentEnvFiles,
    currentDestinationConfig
  );
  if (current.providerAuthFiles.some((file) => file.exists && !file.readable)) return false;
  return snapshotsEqual(execution.snapshot, current);
}

function createSnapshot(
  request: SnapshotRequest,
  plan: DeployPlan,
  projectDir: string,
  processCwd: string,
  homeDir: string,
  resolvedCli: ResolvedCli,
  providerEnvNames: readonly string[],
  projectEnvFiles: readonly FileFingerprint[],
  destinationConfig: readonly FileFingerprint[]
): ExecutionSnapshot {
  return Object.freeze({
    projectDir,
    processCwd,
    homeDir,
    name: request.name,
    scope: request.scope,
    projectId: request.projectId,
    target: request.adapterId,
    env: request.env,
    force: request.force,
    destinationLabel: describeDestination(
      request.adapterId,
      destinationConfig,
      request.providerIdentity
    ),
    argv: Object.freeze([...plan.argv]),
    preSteps: Object.freeze(
      (plan.preSteps ?? []).map((step) => Object.freeze([...step.argv]))
    ),
    cli: resolvedCli,
    destinationConfig: Object.freeze(destinationConfig),
    providerAuthFiles: Object.freeze(
      AUTH_FILE_RELATIVE_PATHS[request.adapterId].map((relativePath) =>
        fingerprintFile(join(homeDir, ...relativePath.split("/")), null)
      )
    ),
    projectEnvFiles: Object.freeze(projectEnvFiles),
    providerEnvNames: Object.freeze([...providerEnvNames]),
    providerIdentity: request.providerIdentity
  });
}

function trustedHomeDirectory(allowUnsupportedTestFixture = false): string | null {
  const trustedHome = resolveTrustedHomeDirectory();
  if (trustedHome) return trustedHome;
  // pathOverride is an explicit test-only seam used by cross-platform attack
  // tests. It must not turn production Linux into a supported high-risk path.
  if (!allowUnsupportedTestFixture) return null;
  try {
    const home = realpathSync.native(userInfo().homedir);
    return statSync(home).isDirectory() ? home : null;
  } catch {
    return null;
  }
}

function snapshotsEqual(left: ExecutionSnapshot, right: ExecutionSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function providerEnvironmentNames(
  target: TargetId,
  environment: NodeJS.ProcessEnv
): string[] {
  const names = new Set<string>();
  const present = new Set(Object.keys(environment).map((key) => key.toUpperCase()));
  for (const key of PROVIDER_ENV[target]) {
    if (present.has(key)) names.add(key);
  }

  if (target === "github") {
    for (const key of present) {
      if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key.startsWith("GIT_CONFIG_")) {
        names.add(key);
      }
    }
  }
  return [...names].sort();
}

function fingerprintProjectEnvFiles(projectDir: string, target: TargetId): FileFingerprint[] {
  if (target !== "cloudflare") return [];
  const names = new Set<string>([".env", ".dev.vars"]);
  try {
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (entry.name.startsWith(".env.") && entry.name !== ".env.example") names.add(entry.name);
      if (entry.name.startsWith(".dev.vars.")) names.add(entry.name);
    }
  } catch {
    // A project that cannot be enumerated is unsafe for a high-risk operation.
    return [
      Object.freeze({
        path: resolve(join(projectDir, ".env.__unreadable__")),
        exists: true,
        kind: null,
        realPath: null,
        mtimeMs: null,
        ctimeMs: null,
        birthtimeMs: null,
        mode: null,
        dev: null,
        ino: null,
        contentHash: null,
        destinationLabel: null,
        readable: false
      })
    ];
  }

  return [...names]
    .sort()
    .map((name) => fingerprintFile(join(projectDir, name), null));
}

function fingerprintFile(
  path: string,
  target: TargetId | null,
  env?: DeployEnv
): FileFingerprint {
  try {
    const stats = statSync(path);
    const realPath = realpathSync.native(path);
    const regular = stats.isFile();
    const config = target && regular && env ? fingerprintConfigFile(path, target, env) : null;
    return Object.freeze({
      path: resolve(path),
      exists: true,
      kind: regular ? "file" : stats.isDirectory() ? "directory" : "other",
      realPath,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      birthtimeMs: stats.birthtimeMs,
      mode: stats.mode,
      dev: stats.dev,
      ino: stats.ino,
      contentHash: config?.contentHash ?? null,
      destinationLabel: config?.destinationLabel ?? null,
      readable: !target || !regular || config !== null
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    const exists = code !== "ENOENT" && code !== "ENOTDIR";
    return Object.freeze({
      path: resolve(path),
      exists,
      kind: null,
      realPath: null,
      mtimeMs: null,
      ctimeMs: null,
      birthtimeMs: null,
      mode: null,
      dev: null,
      ino: null,
      contentHash: null,
      destinationLabel: null,
      readable: false
    });
  }
}

function fingerprintConfigFile(
  path: string,
  target: TargetId,
  env: DeployEnv
): { contentHash: string; destinationLabel: string | null } | null {
  try {
    const content = readFileSync(path, "utf8");
    const parsedCloudflare = target === "cloudflare"
      ? parseCloudflareConfig(content, path)
      : undefined;
    if (target === "cloudflare" && !parsedCloudflare) return null;
    return {
      contentHash: createHash("sha256")
        .update(destinationConfigProjection(content, path, target, parsedCloudflare), "utf8")
        .digest("hex"),
      destinationLabel: destinationLabelFromContent(content, path, target, env, parsedCloudflare)
    };
  } catch {
    return null;
  }
}

function describeDestination(
  target: TargetId,
  files: readonly FileFingerprint[],
  providerIdentity: string | null
): string {
  const labels = files
    .filter((file) => file.exists && file.destinationLabel)
    .map((file) => file.destinationLabel as string);
  if (labels.length > 0) {
    return `${labels.join(" | ")}; provider identity ${providerIdentity ?? "unavailable"}`;
  }
  const provider = target === "github" ? "GitHub" : target === "vercel" ? "Vercel" : "Cloudflare";
  return `${provider} destination selected by the bound project config and provider auth state`;
}

function hasConcreteDestination(target: TargetId, files: readonly FileFingerprint[]): boolean {
  const bySuffix = (suffix: string): FileFingerprint | undefined =>
    files.find((file) => file.path.replace(/\\/g, "/").toLowerCase().endsWith(suffix));

  if (target === "cloudflare") {
    // Wrangler accepts several mutually exclusive config filenames. If more
    // than one exists, precedence/version differences make the effective
    // worker ambiguous; require exactly one closed config instead.
    const existing = files.filter((file) => file.exists);
    return existing.length === 1 &&
      existing[0].kind === "file" &&
      existing[0].readable &&
      Boolean(existing[0].destinationLabel);
  }
  if (target === "vercel") {
    const linked = bySuffix("/.vercel/project.json");
    return Boolean(linked && linked.kind === "file" && linked.readable && linked.destinationLabel);
  }

  const dotGit = bySuffix("/.git");
  const config = bySuffix("/.git/config");
  const worktreeConfig = bySuffix("/.git/config.worktree");
  return Boolean(
    dotGit?.kind === "directory" &&
    config?.kind === "file" &&
    config.readable &&
    config.destinationLabel &&
    !worktreeConfig?.exists
  );
}

function destinationLabelFromContent(
  content: string,
  path: string,
  target: TargetId,
  env: DeployEnv,
  parsedCloudflare?: Record<string, unknown> | null
): string | null {
  const normalizedPath = path.replace(/\\/g, "/").toLowerCase();
  const fileName = path.replace(/\\/g, "/").split("/").pop() ?? "config";

  if (target === "vercel") {
    if (!normalizedPath.endsWith("/.vercel/project.json")) return null;
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!isRecord(parsed)) return null;
      const projectId = safeDestinationIdentifier(parsed.projectId);
      const orgId = safeDestinationIdentifier(parsed.orgId);
      if (!projectId || !orgId) return null;
      return `Vercel org/project ${orgId}/${projectId} via .vercel/project.json`;
    } catch {
      return null;
    }
  }

  if (target === "github") {
    if (!normalizedPath.endsWith("/.git/config") &&
        !normalizedPath.endsWith("/.git/config.worktree")) return null;
    let section = "";
    const remotes = new Map<string, string>();
    let unsafeDestinationDirective = false;
    for (const line of content.split(/\r?\n/)) {
      const sectionMatch = /^\s*\[([^\]\r\n]+)\]\s*(?:[#;].*)?$/.exec(line);
      if (sectionMatch) {
        section = sectionMatch[1].trim().toLowerCase();
        // Included Git config can redirect remotes from outside the approved
        // repository snapshot. High-risk GitHub operations require a closed
        // local config instead of chasing arbitrary include paths.
        if (/^include(?:if)?(?:\s|$)/i.test(section) || /^url\s+["']/i.test(section)) return null;
        continue;
      }
      const remote = /^remote\s+["']([A-Za-z0-9_.-]+)["']$/i.exec(section);
      if (!remote) continue;
      const assignment = /^\s*(url|pushurl)\s*=\s*(.*?)\s*$/.exec(line);
      if (!assignment) continue;
      if (assignment[1].toLowerCase() !== "url") {
        unsafeDestinationDirective = true;
        continue;
      }
      const remoteName = remote[1].toLowerCase();
      if (remotes.has(remoteName)) {
        unsafeDestinationDirective = true;
        continue;
      }
      const projected = projectRemoteUrl(unquoteConfigText(assignment[2]));
      if (!isGitHubDestination(projected)) {
        unsafeDestinationDirective = true;
        continue;
      }
      remotes.set(remoteName, projected);
    }
    const selected = remotes.get("origin");
    return !unsafeDestinationDirective && selected && remotes.size === 1
      ? `GitHub repository ${selected} via ${fileName}`
      : null;
  }

  const values = readCloudflareDestinationFields(parsedCloudflare, env);
  if (!values.name || !values.accountId) return null;
  return `Cloudflare worker ${values.name ?? "(bound config worker)"}; account ${values.accountId ?? "(bound provider auth)"} via ${fileName}`;
}

function readCloudflareDestinationFields(
  parsed: Record<string, unknown> | null | undefined,
  env: DeployEnv
): { name: string | null; accountId: string | null } {
  if (!parsed) return { name: null, accountId: null };
  const environment =
    env !== "production" && isRecord(parsed.env) && isRecord(parsed.env[env])
      ? parsed.env[env]
      : null;
  return {
    name: safeDestinationIdentifier(environment?.name) ?? safeDestinationIdentifier(parsed.name),
    accountId:
      safeDestinationIdentifier(environment?.account_id) ??
      safeDestinationIdentifier(parsed.account_id)
  };
}

function parseCloudflareConfig(content: string, path: string): Record<string, unknown> | null {
  try {
    if (/\.jsonc$/i.test(path) || /\.json$/i.test(path)) {
      const errors: ParseError[] = [];
      const options = {
        allowTrailingComma: /\.jsonc$/i.test(path),
        disallowComments: /\.json$/i.test(path)
      };
      const parsed = parseJsonc(content, errors, options) as unknown;
      const tree = parseJsoncTree(content, errors, options);
      return errors.length === 0 && tree && !hasDuplicateObjectKeys(tree) && isRecord(parsed)
        ? parsed
        : null;
    }

    const parsed = parseToml(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasDuplicateObjectKeys(node: Node): boolean {
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key === "string") {
        if (keys.has(key)) return true;
        keys.add(key);
      }
    }
  }
  return (node.children ?? []).some((child) => hasDuplicateObjectKeys(child));
}

function unquoteConfigText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 &&
      ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+[#;].*$/, "").trim();
}

function safeDestinationIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)
    ? value
    : null;
}

function isGitHubDestination(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === "github.com";
  } catch {
    return /^github\.com:[A-Za-z0-9_./-]+$/i.test(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function destinationConfigProjection(
  content: string,
  path: string,
  target: TargetId,
  parsedCloudflare?: Record<string, unknown> | null
): string {
  // A destination config can itself contain credentials or application
  // secrets. Hash only a closed projection of known destination fields;
  // every other scalar becomes a type marker. This preserves useful
  // destination change detection without ever creating a Secret-derived
  // hash, partial value, or length oracle.
  if (target === "cloudflare") {
    if (!parsedCloudflare) return "<invalid-cloudflare-config>";
    return JSON.stringify(projectJsonConfig(parsedCloudflare, target, path, []));
  }

  if (/\.json$/i.test(path)) {
    try {
      const parsed: unknown = JSON.parse(content);
      return JSON.stringify(projectJsonConfig(parsed, target, path, []));
    } catch {
      // Invalid/JSONC input is projected line-by-line below. Raw values are
      // never retained by the fallback.
    }
  }

  let section = "";
  return content
    .split(/\r?\n/)
    .map((line) => {
      const sectionMatch = /^\s*\[([^\]\r\n]+)\]\s*(?:[#;].*)?$/.exec(line);
      if (sectionMatch) {
        section = sectionMatch[1].trim().toLowerCase();
        return `[${projectSectionName(section, target)}]`;
      }

      const assignment = /^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*(.*)$/.exec(line);
      if (assignment) {
        const key = assignment[1].toLowerCase();
        const prefix = `${projectSectionName(section, target)}|${key}=`;
        return shouldRetainLineDestinationValue(target, path, section, key)
          ? `${prefix}${projectLineDestinationValue(assignment[2], target, key)}`
          : `${prefix}<redacted>`;
      }

      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) return "";
      return "<syntax>";
    })
    .join("\n");
}

function projectJsonConfig(
  value: unknown,
  target: TargetId,
  path: string,
  keys: readonly string[]
): unknown {
  const key = (keys[keys.length - 1] ?? "").toLowerCase();
  if (isSecretBearingConfigKey(key, target)) return "<redacted>";
  if (Array.isArray(value)) {
    const destinationArray = target === "cloudflare" && (key === "route" || key === "routes");
    return destinationArray
      ? value.map((item) => projectJsonConfig(item, target, path, keys))
      : "<redacted>";
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, projectJsonConfig(child, target, path, [...keys, key])])
    );
  }

  if (shouldRetainJsonDestinationValue(target, path, keys)) {
    return projectSafeScalar(value, target, keys[keys.length - 1] ?? "");
  }
  return "<redacted>";
}

function isSecretBearingConfigKey(key: string, target: TargetId): boolean {
  if (!key) return false;
  if (target === "cloudflare" && key === "env") return false;
  return /^(?:vars?|env|environment|secrets?|token|password|passwd|credentials?|authorization|extraheader|api[_-]?key|private[_-]?key)$/i.test(
    key
  );
}

function shouldRetainJsonDestinationValue(
  target: TargetId,
  path: string,
  keys: readonly string[]
): boolean {
  const key = (keys[keys.length - 1] ?? "").toLowerCase();
  const parents = keys.slice(0, -1).map((entry) => entry.toLowerCase());
  const normalizedPath = path.replace(/\\/g, "/").toLowerCase();

  if (target === "vercel" && normalizedPath.endsWith("/.vercel/project.json")) {
    return parents.length === 0 && (key === "projectid" || key === "orgid");
  }
  if (target !== "cloudflare" || parents.includes("vars")) return false;

  const atRoot = parents.length === 0;
  const inNamedEnvironment = parents.length === 2 && parents[0] === "env";
  if ((atRoot || inNamedEnvironment) &&
      ["name", "account_id", "zone_id", "workers_dev"].includes(key)) {
    return true;
  }
  const inRoute = parents.some((entry) => entry === "route" || entry === "routes");
  return inRoute && ["pattern", "zone_id", "zone_name", "custom_domain"].includes(key);
}

function shouldRetainLineDestinationValue(
  target: TargetId,
  path: string,
  section: string,
  key: string
): boolean {
  if (target === "github") {
    return /^remote\s+["'][A-Za-z0-9_.-]+["']$/i.test(section) &&
      (key === "url" || key === "pushurl");
  }
  // Valid JSON was handled structurally above. For JSONC or invalid JSON we
  // cannot prove a line is outside a Secret-bearing object such as `vars`,
  // so retain structure and scalar types only.
  if (/\.jsonc?$/i.test(path)) return false;
  if (target === "vercel") {
    const normalizedPath = path.replace(/\\/g, "/").toLowerCase();
    return normalizedPath.endsWith("/.vercel/project.json") &&
      section === "" && (key === "projectid" || key === "orgid");
  }
  if (section.includes("vars")) return false;
  const destinationSection = section === "" || /^env\.[A-Za-z0-9_.-]+$/i.test(section);
  return destinationSection &&
    ["name", "account_id", "zone_id", "workers_dev", "route", "routes"].includes(key);
}

function projectSectionName(section: string, target: TargetId): string {
  if (!section) return "<root>";
  if (target === "github") {
    const remote = /^remote\s+["']([A-Za-z0-9_.-]+)["']$/i.exec(section);
    return remote ? `remote:${remote[1].toLowerCase()}` : "<section>";
  }
  const environment = /^env\.([A-Za-z0-9_.-]+)$/i.exec(section);
  return environment ? `env:${environment[1].toLowerCase()}` : "<section>";
}

function projectLineDestinationValue(raw: string, target: TargetId, key: string): string {
  const trimmed = raw.trim();
  const unquoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1)
      : trimmed.replace(/\s+[#;].*$/, "").trim();
  if (target === "github" && (key === "url" || key === "pushurl")) {
    return projectRemoteUrl(unquoted);
  }
  return /^[A-Za-z0-9_.:\/?*{}@-]{1,512}$/.test(unquoted)
    ? unquoted
    : "<destination-value>";
}

function projectSafeScalar(value: unknown, target: TargetId, key: string): unknown {
  if (typeof value === "string") {
    if (target === "github" && (key === "url" || key === "pushurl")) {
      return projectRemoteUrl(value);
    }
    return /^[A-Za-z0-9_.:\/?*{}@-]{1,512}$/.test(value)
      ? value
      : "<destination-value>";
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  return "<redacted>";
}

function projectRemoteUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!url.hostname) return "<remote>";
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch {
    const scpLike = /^(?:[^@/:\\]+@)?([^/:\\]+):([A-Za-z0-9_./-]+)$/.exec(value);
    return scpLike ? `${scpLike[1].toLowerCase()}:${scpLike[2]}` : "<remote>";
  }
}

function buildTrustedExecutionEnvironment(
  resolvedCli: ResolvedCli,
  pathOverride: string | undefined,
  home: string
): Record<string, string> {
  const trustedPath =
    resolvedCli.trustedPath ??
    [pathOverride, dirname(process.execPath)].filter(Boolean).join(delimiter);

  const env: Record<string, string> = process.platform === "win32"
    ? {
        SystemRoot: String.raw`C:\Windows`,
        WINDIR: String.raw`C:\Windows`,
        HOME: home,
        USERPROFILE: home,
        PATH: trustedPath,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
        TEMP: join(home, "AppData", "Local", "Temp"),
        TMP: join(home, "AppData", "Local", "Temp"),
        GIT_TERMINAL_PROMPT: "0"
      }
    : {
        HOME: home,
        PATH: trustedPath,
        TMPDIR: "/tmp",
        GIT_TERMINAL_PROMPT: "0"
      };

  // GitHub destination resolution must use only the bound repository config.
  // Do not allow global/system `insteadOf`, include, or remote rewrites to sit
  // outside the approval snapshot. These values are fixed constants, never
  // inherited from the caller.
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";

  if (process.platform === "win32") {
    env.APPDATA = join(home, "AppData", "Roaming");
    env.LOCALAPPDATA = join(home, "AppData", "Local");
  }
  return env;
}
