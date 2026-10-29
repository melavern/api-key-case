import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync, type Stats, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc, parseTree, type Node, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import type { DeployEnv, DeployPlan } from "./types.js";
import type { FileFingerprint } from "./snapshot.js";
import { isHostedDeployService, type HostedDeployService } from "./provider-hosted.js";

/** Fixed repository allowlist, never an execution authority or a CLI config-path option. */
export const CLOUDFLARE_TARGETS_FILE = "api-key-case.targets.json";
export interface CloudflareConfigDestination {
  readonly id: string;
  readonly config: string;
  readonly accountId: string;
  readonly worker: string;
  readonly wranglerEnvironment: string | null;
}
export interface CloudflareTarget extends CloudflareConfigDestination {
  readonly sourceEnvironment: DeployEnv;
  readonly deploymentEnvironment: DeployEnv | "staging";
  readonly services: readonly HostedDeployService[];
}
export interface CloudflareTargetBinding {
  readonly target: CloudflareTarget;
  readonly files: readonly FileFingerprint[];
  readonly envDirectories: readonly string[];
}
export interface CloudflareConfigBinding {
  readonly target: CloudflareConfigDestination;
  readonly files: readonly FileFingerprint[];
  readonly envDirectories: readonly string[];
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
  a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

function duplicates(node: Node): boolean {
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const child of node.children ?? []) {
      const key = child.children?.[0]?.value;
      if (typeof key !== "string" || keys.has(key)) return true;
      keys.add(key);
    }
  }
  return (node.children ?? []).some(duplicates);
}
function parseConfig(content: string, path: string): Record<string, unknown> | null {
  try {
    if (path.endsWith(".toml")) {
      const parsed: unknown = parseToml(content);
      return record(parsed) ? parsed : null;
    }
    const errors: ParseError[] = [], options = { disallowComments: path.endsWith(".json"), allowTrailingComma: path.endsWith(".jsonc") };
    const tree = parseTree(content, errors, options), parsed: unknown = parseJsonc(content, errors, options);
    return errors.length === 0 && tree && !duplicates(tree) && record(parsed) ? parsed : null;
  } catch { return null; }
}

/** Ordinary in-repository metadata only: no links, hardlinks, special files or unbounded reads. */
function readMetadata(root: string, relative: string, exact = false): { content: string; files: FileFingerprint[]; directories: string[] } {
  let fd: number | undefined;
  try {
    const segments = relative.split("/");
    const directories = [root];
    for (let i = 1; i < segments.length; i++) directories.push(join(root, ...segments.slice(0, i)));
    const states = directories.map(path => {
      const state = lstatSync(path);
      if (!state.isDirectory() || state.isSymbolicLink() || realpathSync.native(path) !== path) throw new Error("Unsafe target metadata.");
      return state;
    });
    const version = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.birthtimeNs}:${s.mode}:${s.nlink}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    const exactDirectories = exact ? directories.map(path => version(lstatSync(path, { bigint: true }))) : [];
    const path = join(root, ...segments), state = lstatSync(path);
    const exactFile = exact ? version(lstatSync(path, { bigint: true })) : undefined;
    if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > 65536 || realpathSync.native(path) !== path) throw new Error("Unsafe target metadata.");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!same(state, fstatSync(fd))) throw new Error("Changed target metadata.");
    if (exact && version(fstatSync(fd, { bigint: true })) !== exactFile) throw new Error("Changed target metadata.");
    const bytes = Buffer.alloc(65537); let length = 0, count = 0;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, length)) > 0) length += count;
    if (length !== state.size || !same(state, fstatSync(fd)) || !same(state, lstatSync(path)) ||
        directories.some((path, index) => !same(states[index], lstatSync(path)) || realpathSync.native(path) !== path)) throw new Error("Changed target metadata.");
    if (exact && (version(fstatSync(fd, { bigint: true })) !== exactFile || version(lstatSync(path, { bigint: true })) !== exactFile ||
      directories.some((path, index) => version(lstatSync(path, { bigint: true })) !== exactDirectories[index]))) throw new Error("Changed target metadata.");
    const fingerprint = (path: string, state: Stats): FileFingerprint => Object.freeze({ path, exists: true,
      kind: state.isFile() ? "file" : "directory", realPath: path, mtimeMs: state.mtimeMs, ctimeMs: state.ctimeMs,
      birthtimeMs: state.birthtimeMs, mode: state.mode, dev: state.dev, ino: state.ino,
      // No config content or value-derived hash escapes this reader.
      contentHash: null, destinationLabel: null, readable: true });
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
      files: [...directories.map((path, index) => Object.freeze({ ...fingerprint(path, states[index]), ...(exact ? { exactIdentity: exactDirectories[index] } : {}) })),
        Object.freeze({ ...fingerprint(path, state), ...(exact ? { exactIdentity: exactFile } : {}) })], directories };
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function isCloudflareDestinationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(value);
}
export function validCloudflareTarget(value: unknown): value is CloudflareTarget {
  if (!record(value) || Object.keys(value).sort().join(",") !== "accountId,config,deploymentEnvironment,id,services,sourceEnvironment,worker,wranglerEnvironment" ||
      !isCloudflareDestinationId(value.id) || typeof value.accountId !== "string" || !/^[a-f0-9]{32}$/.test(value.accountId) ||
      typeof value.worker !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value.worker) ||
      typeof value.config !== "string" || value.config.length > 240 ||
      !/^(?:[A-Za-z0-9_-]+\/){0,12}[A-Za-z0-9_-]+\.(?:jsonc?|toml)$/.test(value.config) || value.config === CLOUDFLARE_TARGETS_FILE ||
      !(value.wranglerEnvironment === null || (typeof value.wranglerEnvironment === "string" && /^[a-z][a-z0-9_-]{0,47}$/.test(value.wranglerEnvironment))) ||
      !Array.isArray(value.services) || value.services.length < 1 || value.services.length > 3 ||
      !value.services.every(isHostedDeployService) || new Set(value.services).size !== value.services.length) return false;
  const source = value.deploymentEnvironment === "staging" ? "preview" : value.deploymentEnvironment;
  return ["development", "preview", "production", "staging"].includes(String(value.deploymentEnvironment)) &&
    value.sourceEnvironment === source && !(value.services.includes("stripe-test") && source === "production");
}
function catalog(projectDir: string): { root: string; targets: CloudflareTarget[]; files: FileFingerprint[] } {
  const root = realpathSync.native(projectDir), metadata = readMetadata(root, CLOUDFLARE_TARGETS_FILE);
  const parsed = parseConfig(metadata.content, CLOUDFLARE_TARGETS_FILE);
  if (!parsed || Object.keys(parsed).sort().join(",") !== "cloudflare,version" || parsed.version !== 1 ||
      !Array.isArray(parsed.cloudflare) || parsed.cloudflare.length < 1 || parsed.cloudflare.length > 16 ||
      !parsed.cloudflare.every(validCloudflareTarget) || new Set(parsed.cloudflare.map(target => target.id)).size !== parsed.cloudflare.length ||
      new Set(parsed.cloudflare.map(target => `${target.accountId}/${target.worker}`)).size !== parsed.cloudflare.length) throw new Error("Invalid target catalog.");
  const targets = parsed.cloudflare.map(target => Object.freeze({ ...target, services: Object.freeze([...target.services]) }));
  // Hash only the closed validated nonsecret catalog, never a config's arbitrary fields.
  const last = metadata.files.length - 1;
  metadata.files[last] = Object.freeze({ ...metadata.files[last], contentHash: createHash("sha256").update(JSON.stringify(targets)).digest("hex") });
  return { root, targets, files: metadata.files };
}

export function listCloudflareTargets(projectDir: string): { status: "available" | "unavailable"; targets: readonly CloudflareTarget[] } {
  try { return { status: "available", targets: catalog(projectDir).targets }; }
  catch { return { status: "unavailable", targets: [] }; }
}

export function resolveCloudflareTarget(projectDir: string, id: string, service: HostedDeployService, environment: DeployEnv): CloudflareTargetBinding | null {
  try {
    if (!isCloudflareDestinationId(id) || !isHostedDeployService(service)) return null;
    const selected = catalog(projectDir), target = selected.targets.find(target => target.id === id);
    if (!target || target.sourceEnvironment !== environment || !target.services.includes(service)) return null;
    const metadata = readMetadata(selected.root, target.config), config = parseConfig(metadata.content, target.config);
    const section: Record<string, unknown> | null = target.wranglerEnvironment === null ? config : config && record(config.env) && record(config.env[target.wranglerEnvironment]) ? config.env[target.wranglerEnvironment] as Record<string, unknown> : null;
    if (!config || !section || section.name !== target.worker ||
        (config.account_id !== undefined && config.account_id !== target.accountId) ||
        (section.account_id !== undefined && section.account_id !== target.accountId)) return null;
    const label = `Cloudflare destination ${target.id}; account ${target.accountId}; Worker ${target.worker}; config ${target.config}; deployment ${target.deploymentEnvironment}; Wrangler ${target.wranglerEnvironment ?? "top-level (no --env)"}; source ${target.sourceEnvironment}`;
    const last = metadata.files.length - 1;
    metadata.files[last] = Object.freeze({ ...metadata.files[last], destinationLabel: label });
    return Object.freeze({ target, files: Object.freeze([...selected.files, ...metadata.files]), envDirectories: Object.freeze([...new Set(metadata.directories)]) });
  } catch { return null; }
}

/** Only a resolved catalog entry can construct this fixed official operation. */
export function cloudflareTargetPlan(target: CloudflareConfigDestination, name: string): DeployPlan {
  const argv = ["wrangler", "secret", "put", name, "--config", target.config, "--name", target.worker,
    ...(target.wranglerEnvironment === null ? [] : ["--env", target.wranglerEnvironment])];
  return { argv, valueVia: "stdin", displayCommand: argv.join(" "), overwriteWarning: true };
}

/** Fixed transport settings; the account comes only from the revalidated target. */
export function cloudflareTargetEnvironment(base: Record<string, string>, target: CloudflareConfigDestination): Record<string, string> {
  return { ...base, CLOUDFLARE_ACCOUNT_ID: target.accountId, WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_LOG_PATH: String.raw`C:\Windows\System32\NUL.log`,
    WRANGLER_SEND_METRICS: "false", WRANGLER_SEND_ERROR_REPORTS: "false", CI: "1" };
}

/** Shared safe config reader for the independent generic catalog. No provider placeholders. */
export function inspectCloudflareConfig(projectDir: string, relative: string): CloudflareConfigBinding[] {
  if (typeof relative !== "string" || relative.length > 240 ||
      !/^(?:[A-Za-z0-9_-]+\/){0,12}[A-Za-z0-9_-]+\.(?:jsonc?|toml)$/.test(relative) || relative === CLOUDFLARE_TARGETS_FILE) throw new Error("Invalid config path.");
  const root = realpathSync.native(projectDir), metadata = readMetadata(root, relative, true), config = parseConfig(metadata.content, relative);
  if (!config || (config.env !== undefined && !record(config.env))) throw new Error("Invalid config.");
  const sections: [string | null, Record<string, unknown>][] = [[null, config]];
  for (const [name, value] of Object.entries(config.env ?? {})) {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name) || name === "top-level" || !record(value)) throw new Error("Invalid config section.");
    sections.push([name, value]);
  }
  return sections.flatMap(([environment, section]) => {
    const account = section.account_id ?? config.account_id;
    if (typeof account !== "string" || !/^[a-f0-9]{32}$/.test(account) || typeof section.name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(section.name)) return [];
    // Conflicting account declarations must not be silently inherited.
    if (config.account_id !== undefined && config.account_id !== account) throw new Error("Conflicting account.");
    const target = Object.freeze({ id: "generic", config: relative, accountId: account, worker: section.name, wranglerEnvironment: environment });
    const label = `Cloudflare account ${account}; Worker ${target.worker}; config ${relative}; Wrangler ${environment ?? "top-level (no --env)"}`;
    const files = metadata.files.map((file, i) => i === metadata.files.length - 1 ? Object.freeze({ ...file, destinationLabel: label }) : file);
    return [Object.freeze({ target, files: Object.freeze(files), envDirectories: Object.freeze(metadata.directories) })];
  });
}

/** Re-resolve the exact human-registered identity on every use. */
export function resolveGenericCloudflareTarget(projectDir: string, selected: CloudflareConfigDestination): CloudflareConfigBinding | null {
  try {
    if (!selected || Object.keys(selected).sort().join(",") !== "accountId,config,id,worker,wranglerEnvironment" ||
        !/^[0-9a-f-]{36}$/.test(selected.id)) return null;
    const binding = inspectCloudflareConfig(projectDir, selected.config).find(b => b.target.accountId === selected.accountId &&
      b.target.worker === selected.worker && b.target.wranglerEnvironment === selected.wranglerEnvironment);
    return binding ? Object.freeze({ ...binding, target: Object.freeze({ ...binding.target, id: selected.id }) }) : null;
  } catch { return null; }
}
