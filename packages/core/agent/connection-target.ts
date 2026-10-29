import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, writeSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getNodeValue, parseTree, type Node, type ParseError } from "jsonc-parser";
import { deriveProjectId } from "../vault/naming.js";
import { resolveClerkWorkerDestination } from "../deploy/snapshot.js";
import { ConnectionStateStore, type ConnectionEnvironment } from "./connection-state.js";
import { readNativeDestinationSelection } from "./native-observations.js";

type Service = "resend" | "clerk" | "openai" | "stripe-test";
export type ConnectionTargetInput = { service: Service; environment: ConnectionEnvironment } &
  ({ orgId: string; projectId: string; accountId?: never; worker?: never } |
   { accountId: string; worker: string; orgId?: never; projectId?: never });
type Target = "vercel" | "cloudflare";
type SelectorPair = { name: string; account_id: string };
type SelectorConfig = Partial<SelectorPair> & { env?: Partial<Record<"development" | "preview", SelectorPair>> };
const UPDATE_TEMP = ".wrangler.jsonc.api-key-case-target.tmp" as const;
type Reason = "local-plan" | "local-config-created" | "local-config-updated" | "matching-local-config" | "invalid-input" |
  "selection-missing" | "selection-unavailable" | "selection-mismatch" | "unsafe-path" |
  "unsupported-layout" | "unsupported-update-layout" | "configuration-conflict" | "plan-mismatch" | "local-state-changed" | "local-write-failed";
export interface ConnectionTargetResult {
  schemaVersion: 1;
  operation: "plan" | "apply";
  status: "planned" | "created" | "updated" | "unchanged" | "blocked";
  reason: Reason;
  service: Service | null;
  environment: ConnectionEnvironment | null;
  destination: Target | null;
  route: "provider-native" | "api-key-case-managed" | null;
  selection: { localProjectId: string; canonicalProject: string; intentRevision: string } | null;
  identifiers: { orgId: string; projectId: string } | { accountId: string; worker: string } | null;
  relativePath: ".vercel/project.json" | "wrangler.jsonc" | null;
  existingPath: string | null;
  localConfiguration: "missing" | "missing-environment" | "matching" | "not-inspected";
  plannedEffects: readonly string[];
  /** Only strictly validated non-secret selector fields; never arbitrary config. */
  existingSelectors: SelectorConfig | null;
  proposedConfig: string | null;
  fingerprint: string | null;
  localEffects: "none" | "created" | "updated" | "possible";
  createdPaths: readonly string[];
  updatedPaths: readonly string[];
  authentication: "not-inspected";
  remoteResource: "not-inspected";
  currentHealth: "unverified";
  credentialAccess: "none";
  providerExecution: false;
  nativeExecution?: "pending-acceptance";
  permission: "none";
}
class TargetError extends Error { constructor(readonly reason: Reason) { super(reason); } }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identity = (s: Stats) => ({ dev: s.dev, ino: s.ino, mode: s.mode, uid: s.uid, gid: s.gid, birthtimeMs: s.birthtimeMs });
const fileState = (s: Stats) => ({ ...identity(s), nlink: s.nlink, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
function stat(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new TargetError("unsafe-path"); }
}
function directory(path: string): ReturnType<typeof identity> {
  const s = stat(path);
  if (!s?.isDirectory() || s.isSymbolicLink()) throw new TargetError("unsafe-path");
  return identity(s);
}
function ancestors(path: string) {
  const result: { path: string; identity: ReturnType<typeof identity> }[] = [];
  for (let p = path; ; p = dirname(p)) {
    result.push({ path: p, identity: directory(p) });
    if (p === dirname(p)) return result;
  }
}
function optionalFile(path: string) {
  const s = stat(path);
  if (!s) return null;
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 64 * 1024) throw new TargetError("unsafe-path");
  return fileState(s);
}
function duplicates(node: Node): boolean {
  const keys = node.type === "object" ? (node.children ?? []).map(p => p.children?.[0]?.value) : [];
  return new Set(keys).size !== keys.length || (node.children ?? []).some(duplicates);
}
/** Strict bounded JSON read. Byte binding is only used for selector-only update checks. */
function readStrictJsonObject(path: string, bindBytes = false) {
  const before = optionalFile(path);
  if (!before) throw new TargetError("local-state-changed");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!same(before, fileState(fstatSync(fd)))) throw new TargetError("local-state-changed");
    const bytes = Buffer.alloc(64 * 1024 + 1); let length = 0, n = 0;
    while (length < bytes.length && (n = readSync(fd, bytes, length, bytes.length - length, length)) > 0) length += n;
    if (length !== before.size || length > 64 * 1024 || !same(before, fileState(fstatSync(fd))) || !same(before, optionalFile(path))) throw new TargetError("local-state-changed");
    const errors: ParseError[] = [];
    const tree = parseTree(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)), errors,
      { disallowComments: true, allowTrailingComma: false });
    if (!tree || tree.type !== "object" || errors.length || duplicates(tree)) throw new TargetError("configuration-conflict");
    return { value: bindBytes ? getNodeValue(tree) as Record<string, unknown> : null, bytesDigest: bindBytes ? createHash("sha256").update(bytes.subarray(0, length)).digest("hex") : null };
  } finally { if (fd !== undefined) closeSync(fd); }
}
function selectorPair(value: unknown): value is SelectorPair {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(",") === "account_id,name" && typeof v.name === "string" &&
    typeof v.account_id === "string" && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(v.name) && /^[a-f0-9]{32}$/.test(v.account_id);
}
/** A shape is not provenance or ownership. Reject everything outside this selector-only contract. */
function additiveSelector(root: string, input: ConnectionTargetInput, state: FilesState) {
  if (input.environment === "production") throw new TargetError("configuration-conflict");
  const original = state.files["wrangler.jsonc"]!;
  // Replacement cannot preserve Windows ACLs or arbitrary POSIX metadata. No chmod/chown fallback.
  if (process.platform !== "linux" || (original.mode & 0o7777) !== 0o600 ||
      original.uid !== process.getuid?.() || original.gid !== process.getgid?.()) throw new TargetError("unsupported-update-layout");
  const { value, bytesDigest } = readStrictJsonObject(join(root, "wrangler.jsonc"), true);
  if (!value) throw new TargetError("configuration-conflict");
  const keys = Object.keys(value);
  if (keys.some(k => !["name", "account_id", "env"].includes(k))) throw new TargetError("configuration-conflict");
  const hasRoot = keys.includes("name") || keys.includes("account_id");
  if (hasRoot && !selectorPair({ name: value.name, account_id: value.account_id })) throw new TargetError("configuration-conflict");
  const env = value.env;
  if (keys.includes("env") && (!env || typeof env !== "object" || Array.isArray(env) ||
      !Object.keys(env).length || Object.keys(env).some(k => !["development", "preview"].includes(k)) ||
      Object.values(env).some(v => !selectorPair(v)))) throw new TargetError("configuration-conflict");
  if (!hasRoot && !env) throw new TargetError("configuration-conflict");
  const existing = JSON.parse(JSON.stringify(value)) as SelectorConfig;
  if (existing.env?.[input.environment]) throw new TargetError("configuration-conflict");
  // An occupied fixed temporary path is a conflict, never a stale lock to remove.
  if (stat(join(root, UPDATE_TEMP))) throw new TargetError("configuration-conflict");
  const proposed: SelectorConfig = { ...existing, env: { ...existing.env, [input.environment]: { name: input.worker!, account_id: input.accountId! } } };
  return { existing, bytesDigest, proposed };
}
function validateInput(input: ConnectionTargetInput): Target {
  if (!input || !["resend", "clerk", "openai", "stripe-test"].includes(input.service) || !["development", "preview", "production"].includes(input.environment) || (input.service === "stripe-test" && input.environment === "production")) throw new TargetError("invalid-input");
  const keys = Object.keys(input).sort().join(",");
  if (keys === "environment,orgId,projectId,service" && typeof input.orgId === "string" && typeof input.projectId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.orgId ?? "") && /^[A-Za-z0-9_-]{1,128}$/.test(input.projectId ?? "")) return "vercel";
  if (keys === "accountId,environment,service,worker" && typeof input.accountId === "string" && typeof input.worker === "string" && /^[a-f0-9]{32}$/.test(input.accountId ?? "") && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(input.worker ?? "")) return "cloudflare";
  throw new TargetError("invalid-input");
}
function readSelection(root: string, input: ConnectionTargetInput, target: Target, baseDir?: string) {
  const store = new ConnectionStateStore(root, baseDir);
  const result = input.service === "resend" ? store.readIntent() : input.service === "clerk" ?
    target === "vercel" ? store.readClerkNativeIntent() : store.readClerkManagedIntent() : store.readProviderHostedIntent(input.service);
  if (result.status !== "available") throw new TargetError(result.status === "missing" ? "selection-missing" : "selection-unavailable");
  const intent = result.value;
  if (intent.service !== input.service || intent.environment !== input.environment || intent.destination.kind !== target ||
      (target === "cloudflare" ? intent.route !== "api-key-case-managed" :
        !((input.service === "resend" || input.service === "clerk") && intent.route === "provider-native" ||
          input.service !== "clerk" && intent.route === "api-key-case-managed"))) throw new TargetError("selection-mismatch");
  return intent;
}
type FilesState = { parent: ReturnType<typeof identity> | null; files: Record<string, ReturnType<typeof fileState> | null> };
function inspectFiles(root: string, target: Target): FilesState {
  if (target === "vercel") {
    const parent = stat(join(root, ".vercel"));
    if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw new TargetError("unsafe-path");
    // A project file would shadow a monorepo mapping. Do not interpret or repair it.
    if (parent && stat(join(root, ".vercel/repo.json"))) throw new TargetError("unsupported-layout");
    return { parent: parent ? identity(parent) : null,
      files: { ".vercel/project.json": parent ? optionalFile(join(root, ".vercel/project.json")) : null,
        "vercel.json": optionalFile(join(root, "vercel.json")) } };
  }
  return { parent: null, files: Object.fromEntries(["wrangler.toml", "wrangler.json", "wrangler.jsonc"].map(path => [path, optionalFile(join(root, path))])) };
}
function inspect(projectDir: string, input: ConnectionTargetInput, baseDir?: string) {
  const target = validateInput(input), requested = resolve(projectDir);
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(requested)) throw new TargetError("unsafe-path");
  const chain = ancestors(requested), root = realpathSync(requested);
  // Reject symlink aliases as well as non-directory/reparse selectors. No parent search.
  if (root !== requested) throw new TargetError("unsafe-path");
  const intent = readSelection(root, input, target, baseDir), state = inspectFiles(root, target);
  const relativePath = target === "vercel" ? ".vercel/project.json" as const : "wrangler.jsonc" as const;
  const identifiers = target === "vercel" ? { orgId: input.orgId!, projectId: input.projectId! } : { accountId: input.accountId!, worker: input.worker! };
  if (target === "vercel" && state.files["vercel.json"]) readStrictJsonObject(join(root, "vercel.json"));
  const existing = Object.entries(state.files).filter(([path, value]) => value !== null && path !== "vercel.json").map(([path]) => path);
  if (existing.length > 1) throw new TargetError("configuration-conflict");
  let update: ReturnType<typeof additiveSelector> | null = null;
  if (existing.length) {
    if (target === "vercel") {
      readStrictJsonObject(join(root, relativePath));
      const selected = readNativeDestinationSelection(root, input.environment);
      if (!selected || selected.orgId !== input.orgId || selected.projectId !== input.projectId) throw new TargetError("configuration-conflict");
    } else {
      const selected = resolveClerkWorkerDestination(root, input.environment);
      if (!selected || selected.accountId !== input.accountId || selected.name !== input.worker) {
        if (existing[0] !== "wrangler.jsonc") throw new TargetError("configuration-conflict");
        update = additiveSelector(root, input, state);
      }
    }
  }
  if (!same(chain, ancestors(requested)) || realpathSync(requested) !== root ||
      !same(intent, readSelection(root, input, target, baseDir)) || !same(state, inspectFiles(root, target))) throw new TargetError("local-state-changed");
  if (update && readStrictJsonObject(join(root, relativePath), true).bytesDigest !== update.bytesDigest) throw new TargetError("local-state-changed");
  const selected = target === "vercel" ? identifiers : { name: input.worker, account_id: input.accountId };
  const proposedConfig = JSON.stringify(update?.proposed ?? (target === "vercel" || input.environment === "production" ? selected : { env: { [input.environment]: selected } }), null, 2) + "\n";
  const unchanged = existing.length === 1 && !update;
  const fingerprint = digest({ version: 1, root, chain, intent, input: { service: input.service, environment: input.environment, ...identifiers }, state, ...(update ? { sourceBytes: update.bytesDigest } : {}) });
  return { root, chain, intent, state, target, identifiers, relativePath, proposedConfig, unchanged, fingerprint, update, existingPath: existing[0] ?? null };
}
type Inspection = ReturnType<typeof inspect>;
function empty(operation: "plan" | "apply", input: ConnectionTargetInput): ConnectionTargetResult {
  return { schemaVersion: 1, operation, status: "blocked", reason: "invalid-input",
    service: input && ["resend", "clerk", "openai", "stripe-test"].includes(input.service) ? input.service : null,
    environment: input && ["development", "preview", "production"].includes(input.environment) ? input.environment : null,
    destination: null, route: null, selection: null, identifiers: null, relativePath: null, existingPath: null, localConfiguration: "not-inspected",
    plannedEffects: [], existingSelectors: null, proposedConfig: null, fingerprint: null, localEffects: "none", createdPaths: [], updatedPaths: [],
    ...((input?.service === "openai" || input?.service === "stripe-test") ? { nativeExecution: "pending-acceptance" as const } : {}),
    authentication: "not-inspected", remoteResource: "not-inspected", currentHealth: "unverified", credentialAccess: "none", providerExecution: false, permission: "none" };
}
function project(result: ConnectionTargetResult, s: Inspection): ConnectionTargetResult {
  return { ...result, destination: s.target, route: s.intent.route as "provider-native" | "api-key-case-managed",
    selection: { localProjectId: deriveProjectId(s.root), canonicalProject: s.root, intentRevision: s.intent.updatedAt },
    identifiers: s.identifiers, relativePath: s.relativePath, existingPath: s.existingPath, localConfiguration: s.unchanged ? "matching" : s.update ? "missing-environment" : "missing",
    existingSelectors: s.update?.existing ?? null,
    plannedEffects: s.unchanged ? [] : s.update ? [`create ${UPDATE_TEMP}`, `add env.${s.intent.environment} to wrangler.jsonc by atomic replacement`] : [...(s.target === "vercel" && !s.state.parent ? ["create .vercel/"] : []), `create ${s.relativePath}`],
    proposedConfig: s.unchanged ? null : s.proposedConfig, fingerprint: s.fingerprint };
}
const reason = (error: unknown): Reason => error instanceof TargetError ? error.reason : "unsafe-path";
export function planConnectionTarget(projectDir: string, input: ConnectionTargetInput, baseDir?: string): ConnectionTargetResult {
  const result = empty("plan", input);
  try {
    const s = inspect(projectDir, input, baseDir);
    return { ...project(result, s), status: s.unchanged ? "unchanged" : "planned", reason: s.unchanged ? "matching-local-config" : "local-plan" };
  } catch (error) { return { ...result, reason: reason(error) }; }
}

/** Bounded local creation or selector-only addition. A fingerprint is never approval. */
export function applyConnectionTarget(projectDir: string, input: ConnectionTargetInput, fingerprint: string, baseDir?: string): ConnectionTargetResult {
  let result = empty("apply", input), fd: number | undefined;
  const createdPaths: string[] = [], updatedPaths: string[] = [];
  let mayHaveEffects = false;
  try {
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new TargetError("plan-mismatch");
    const s = inspect(projectDir, input, baseDir);
    result = project(result, s);
    if (s.fingerprint !== fingerprint) throw new TargetError("plan-mismatch");
    // Recreate the entire plan immediately before the first possible mutation.
    if (inspect(projectDir, input, baseDir).fingerprint !== fingerprint) throw new TargetError("local-state-changed");
    if (s.unchanged) return { ...result, status: "unchanged", reason: "matching-local-config" };
    let expectedState = s.state;
    const recheck = () => {
      if (!same(s.chain, ancestors(resolve(projectDir))) || realpathSync(projectDir) !== s.root ||
          !same(s.intent, readSelection(s.root, input, s.target, baseDir)) || !same(expectedState, inspectFiles(s.root, s.target))) throw new TargetError("local-state-changed");
      if (s.update && readStrictJsonObject(join(s.root, s.relativePath), true).bytesDigest !== s.update.bytesDigest) throw new TargetError("local-state-changed");
    };
    recheck();
    if (s.update) {
      const original = s.state.files[s.relativePath]!, temporary = join(s.root, UPDATE_TEMP);
      mayHaveEffects = true;
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), original.mode & 0o777);
      createdPaths.push(UPDATE_TEMP);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.size !== 0 || opened.mode !== original.mode ||
          opened.uid !== original.uid || opened.gid !== original.gid) throw new TargetError("unsupported-update-layout");
      let expectedTemporary = fileState(opened);
      const recheckTemporary = () => {
        recheck();
        if (!same(expectedTemporary, optionalFile(temporary)) || (fd !== undefined && !same(expectedTemporary, fileState(fstatSync(fd))))) throw new TargetError("local-state-changed");
      };
      const bytes = Buffer.from(s.proposedConfig); let offset = 0;
      while (offset < bytes.length) {
        recheckTemporary();
        const n = writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (n <= 0) throw new TargetError("local-write-failed");
        offset += n;
        const current = fstatSync(fd);
        if (!same(identity(opened), identity(current)) || current.nlink !== 1 || current.size !== offset) throw new TargetError("local-state-changed");
        expectedTemporary = fileState(current);
      }
      fsyncSync(fd);
      recheckTemporary();
      const completedFd = fd; fd = undefined; closeSync(completedFd);
      // Check exact temp bytes too: stats and identities alone cannot detect every in-place edit.
      if (readStrictJsonObject(temporary, true).bytesDigest !== createHash("sha256").update(bytes).digest("hex")) throw new TargetError("local-state-changed");
      recheckTemporary();
      // Atomic replacement of a fixed path, not filesystem CAS or hostile same-user isolation.
      renameSync(temporary, join(s.root, s.relativePath));
      updatedPaths.push(s.relativePath);
      const after = inspect(projectDir, input, baseDir);
      const replaced = after.state.files[s.relativePath];
      if (!after.unchanged || !same(after.intent, s.intent) || !same(after.chain, s.chain) || !replaced ||
          !same(identity(opened), { dev: replaced.dev, ino: replaced.ino, mode: replaced.mode, uid: replaced.uid, gid: replaced.gid, birthtimeMs: replaced.birthtimeMs }) ||
          readStrictJsonObject(join(s.root, s.relativePath), true).bytesDigest !== createHash("sha256").update(bytes).digest("hex") || stat(temporary)) throw new TargetError("local-state-changed");
      return { ...project(result, after), status: "updated", reason: "local-config-updated", localEffects: "updated", createdPaths, updatedPaths };
    }
    if (s.target === "vercel" && !s.state.parent) {
      mayHaveEffects = true;
      mkdirSync(join(s.root, ".vercel"), { mode: 0o700 }); // no recursive creation, no chmod
      createdPaths.push(".vercel/");
      expectedState = { ...s.state, parent: directory(join(s.root, ".vercel")) };
    }
    recheck();
    mayHaveEffects = true;
    fd = openSync(join(s.root, s.relativePath), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    createdPaths.push(s.relativePath);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== 0) throw new TargetError("local-state-changed");
    expectedState = { ...expectedState, files: { ...expectedState.files, [s.relativePath]: fileState(opened) } };
    recheck();
    const bytes = Buffer.from(s.proposedConfig);
    let offset = 0;
    while (offset < bytes.length) {
      recheck();
      const n = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n <= 0) throw new TargetError("local-write-failed");
      offset += n;
      const current = fstatSync(fd);
      if (!same(identity(opened), identity(current)) || current.nlink !== 1 || current.size !== offset) throw new TargetError("local-state-changed");
      expectedState = { ...expectedState, files: { ...expectedState.files, [s.relativePath]: fileState(current) } };
    }
    fsyncSync(fd);
    recheck();
    const completedFd = fd; fd = undefined; closeSync(completedFd);
    const after = inspect(projectDir, input, baseDir);
    if (!after.unchanged || !same(after.intent, s.intent) || !same(after.state, expectedState) || !same(after.chain, s.chain)) throw new TargetError("local-state-changed");
    return { ...project(result, after), status: "created", reason: "local-config-created", localEffects: "created", createdPaths };
  } catch (error) {
    // Preserve uncertain state: never unlink, repair or roll back a file another
    // writer may now own. Raw exceptions can contain arbitrary config content.
    return { ...result, status: "blocked", reason: error instanceof TargetError ? error.reason : mayHaveEffects ? "local-write-failed" : "unsafe-path",
      localEffects: mayHaveEffects ? "possible" : "none", createdPaths, updatedPaths,
      localConfiguration: mayHaveEffects ? "not-inspected" : result.localConfiguration, fingerprint: mayHaveEffects ? null : result.fingerprint };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* failure already reports possible local effects */ }
  }
}

export function renderConnectionTarget(result: ConnectionTargetResult): string {
  const lines = [`Local target ${result.operation}: ${result.status} (${result.reason})`];
  if (result.selection) lines.push(`${result.service} / ${result.environment} / ${result.destination} / ${result.route}`,
    `Local project: ${JSON.stringify(result.selection.canonicalProject)} (${result.selection.localProjectId})`, `Intent revision: ${result.selection.intentRevision}`);
  if (result.identifiers) lines.push(`Explicit IDs: ${JSON.stringify(result.identifiers)}`);
  if (result.relativePath) lines.push(`Fixed selector path: ${result.relativePath}`);
  if (result.reason === "unsupported-update-layout") lines.push(`Adding an environment requires Linux with an owner-only 0600 selector owned by the current uid/gid; other permission/platform layouts are unsupported.${result.localEffects === "none" ? " No local file was changed by this operation." : " Preserve and inspect the reported paths."} Existing matching checks and new-file preparation keep their separate support.`);
  if (result.reason === "plan-mismatch" && result.localConfiguration === "matching") lines.push("The exact local target already matches. This older plan is stale; a fresh plan permits a no-write apply. Do not recreate the configuration.");
  if (result.existingPath) lines.push(`${result.localConfiguration === "matching" ? "Matching existing config" : "Existing selector to update"}: ${result.existingPath}`);
  lines.push(`Planned local effects: ${result.plannedEffects.join(", ") || "none"}`, `Local effects: ${result.localEffects}`);
  if (result.createdPaths.length) lines.push(`Created paths (action evidence, not current ownership): ${result.createdPaths.join(", ")}`);
  if (result.updatedPaths.length) lines.push(`Replaced selectors (action evidence): ${result.updatedPaths.join(", ")}`);
  if (result.existingSelectors) lines.push(`Existing non-secret selectors: ${JSON.stringify(result.existingSelectors)}`);
  if (result.proposedConfig) lines.push(result.proposedConfig.trimEnd());
  if (result.fingerprint) lines.push(`Plan fingerprint: ${result.fingerprint}`);
  if (result.localEffects === "possible") lines.push("Local preparation may be incomplete; an attempted replacement may already have taken effect. Preserve and inspect the fixed paths; do not force repair or retry with a stale plan.");
  if (result.service === "openai" || result.service === "stripe-test") lines.push("Hosted provider execution is unavailable pending native acceptance. Offline selection, local selector preparation and planning remain available; provider/application checks remain unsupported.");
  lines.push("Local destination configuration only. Authentication, remote resource existence and current health remain unverified. No credential or provider operation occurred. This fingerprint grants no permission for secret, remote or production operations.");
  return lines.join("\n");
}
