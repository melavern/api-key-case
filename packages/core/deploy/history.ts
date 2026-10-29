import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentialRefForService } from "../agent/connection-credential.js";
import { isHostedDeployService } from "./provider-hosted.js";
import { ConnectionStateStore } from "../agent/connection-state.js";
import { assertConnectionCredentialRef, deriveProjectId } from "../vault/naming.js";
import type { ConnectionCredentialRef, SecretRef, SecretScope } from "../vault/types.js";
import { resolveDestinationIdentity } from "./destination.js";
import type { DeployEnv, DeployTarget, TargetId } from "./types.js";
import { validCloudflareTarget, type CloudflareTarget } from "./cloudflare-targets.js";

// Advisory metadata only. This module has no Vault, Human Plane, value read,
// handoff result/output, or authority to execute/approve an operation.
const LIMIT = 200;
const MAX_BYTES = 256 * 1024;
const NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const targets = ["cloudflare", "vercel", "github"];
const envs = ["production", "preview", "development"];

export type HistoryOutcome = "completed" | "incomplete" | "unknown";
export interface ConnectionReceiptIdentity {
  credentialVersion: 2;
  service: ConnectionCredentialRef["service"];
  environment: DeployEnv;
  projectId: string;
  credentialRevision: string;
  intentFingerprint: string;
}
export interface DeploymentReceipt {
  cloudflareTarget?: CloudflareTarget;
  id: string;
  name: string;
  scope: SecretScope;
  target: TargetId;
  env: DeployEnv;
  destinationId: string;
  force: boolean;
  startedAt: string;
  finishedAt: string | null;
  registrationUpdatedAt: string | null;
  outcome: HistoryOutcome;
  /** Absent only for legacy v1 registrations; never inferred from the name. */
  connection?: ConnectionReceiptIdentity;
  preparation?: {kind:"cloudflare-worker-version";versionId:string|null;destination?:{accountId:string;worker:string}};
}
export interface ConnectionHistoryStart {
  cloudflareTarget?: CloudflareTarget;
  ref: ConnectionCredentialRef;
  target: TargetId;
  destinationId: string;
  force: boolean;
  credentialRevision: string;
  intentFingerprint: string;
}
type Journal = { schemaVersion: 1 | 2 | 3 | 4; entries: DeploymentReceipt[] };
export type HistoryIssue = "not-created" | "lock-present" | "temporary-file-present" |
  "invalid-data" | "unsupported-schema" | "unsafe-path" | "too-large" |
  "access-denied" | "read-only-storage" | "storage-full" | "path-unavailable" |
  "record-unavailable" | "io-error";
export interface HistoryDiagnostic {
  phase: "inspect" | "start" | "result";
  issue: HistoryIssue | null;
  recovery: "none" | "wait-and-inspect" | "review-history-metadata" |
    "use-compatible-version" | "review-storage-access" | "free-storage-space";
}
type ReadResult = {
  status: "available" | "missing" | "unavailable";
  issue: HistoryIssue | null;
  entries: DeploymentReceipt[];
};

class HistoryStorageError extends Error {
  constructor(readonly issue: HistoryIssue) { super("History metadata is unavailable."); }
}

// Only known codes cross this boundary; messages, paths, contents and stacks
// never do. ENOENT is 'not-created' only at an inspection's expected path.
export function historyIssueFromError(error: unknown): HistoryIssue {
  if (error instanceof HistoryStorageError) return error.issue;
  const code = object(error) ? error.code : null;
  if (code === "EACCES" || code === "EPERM") return "access-denied";
  if (code === "EROFS") return "read-only-storage";
  if (code === "ENOSPC" || code === "EDQUOT") return "storage-full";
  if (code === "ENOENT") return "path-unavailable";
  if (code === "ENOTDIR" || code === "ELOOP") return "unsafe-path";
  return "io-error";
}

export function historyDiagnostic(phase: HistoryDiagnostic["phase"], issue: HistoryIssue | null): HistoryDiagnostic {
  const recovery: HistoryDiagnostic["recovery"] = issue === null || issue === "not-created" ? "none"
    : issue === "lock-present" ? "wait-and-inspect"
      : issue === "unsupported-schema" ? "use-compatible-version"
        : issue === "storage-full" ? "free-storage-space"
          : ["access-denied", "read-only-storage", "path-unavailable", "io-error"].includes(issue)
            ? "review-storage-access" : "review-history-metadata";
  return { phase, issue, recovery };
}

export function renderHistoryDiagnostic(diagnostic: HistoryDiagnostic): string {
  const advice: Record<HistoryDiagnostic["recovery"], string> = {
    none: "No history repair is indicated. Missing history does not prove that a deployment never happened.",
    "wait-and-inspect": "A lock is present. Another writer may be active; a crash or stale lock is not established. Check for running deploys, let them finish, then run history --json --offline again.",
    "review-history-metadata": "After confirming no deploy is running, review the local history storage. If discarding metadata is necessary, explain the loss of past results and obtain an explicit decision for that project. Do not read raw history contents into chat.",
    "use-compatible-version": "Use the package version that wrote this history or consult its history documentation. Do not overwrite an unfamiliar schema.",
    "review-storage-access": "Check the project path and the current OS user's access to local history storage, including read-only storage. Do not change permissions or discard history automatically.",
    "free-storage-space": "Ask the user to check free disk space or quota for local history storage. Do not delete history to make space automatically."
  };
  return `History diagnostic: ${JSON.stringify(diagnostic)}\n${advice[diagnostic.recovery]}\n` +
    "Reinspect with history --json --offline after addressing the cause; inspection does not test write access. Never delete an existing lock/history or repeat deploy automatically. A later deploy requires a fresh request and all existing approval, license and destination checks.";
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && DATE.test(value) && Number.isFinite(Date.parse(value));
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(",") === keys.sort().join(",");
}
function validPreparationDestination(value: unknown): value is {accountId:string;worker:string} {
  return object(value)&&exactKeys(value,["accountId","worker"])&&typeof value.accountId==="string"&&/^[a-f0-9]{32}$/.test(value.accountId)&&
    typeof value.worker==="string"&&/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value.worker);
}
function validReceipt(value: unknown, projectId: string): value is DeploymentReceipt {
  if (!object(value)) return false;
  const connection = Object.hasOwn(value, "connection"), preparation = Object.hasOwn(value,"preparation");
  const explicitTarget = Object.hasOwn(value, "cloudflareTarget");
  if (explicitTarget && (!connection || preparation || value.target !== "cloudflare" || value.force !== false ||
      !validCloudflareTarget(value.cloudflareTarget) || value.cloudflareTarget.sourceEnvironment !== value.env ||
      !object(value.connection) || !isHostedDeployService(value.connection.service) || !value.cloudflareTarget.services.includes(value.connection.service))) return false;
  if(preparation && (!connection || !object(value.preparation) ||
    !exactKeys(value.preparation,["kind","versionId",...(Object.hasOwn(value.preparation,"destination")?["destination"]:[])]) ||
    (Object.hasOwn(value.preparation,"destination")&&!validPreparationDestination(value.preparation.destination)) || value.preparation.kind!=="cloudflare-worker-version" ||
    (value.outcome === "completed" ? typeof value.preparation.versionId!=="string" || !UUID.test(value.preparation.versionId) : value.preparation.versionId!==null)))return false;
  if (!exactKeys(value, ["id", "name", "scope", "target", "env", "destinationId", "force",
    "startedAt", "finishedAt", "registrationUpdatedAt", "outcome", ...(connection ? ["connection"] : []), ...(preparation ? ["preparation"] : []), ...(explicitTarget ? ["cloudflareTarget"] : [])])) return false;
  if (connection) {
    const identity = value.connection;
    if (!object(identity) || !exactKeys(identity, ["credentialVersion", "service", "environment", "projectId",
      "credentialRevision", "intentFingerprint"]) || identity.credentialVersion !== 2 ||
      !((identity.service === "resend" && value.name === "RESEND_API_KEY" && !preparation) ||
        (identity.service === "openai" && value.name === "OPENAI_API_KEY" && ["cloudflare", "vercel"].includes(value.target as string) && !preparation) ||
        (identity.service === "stripe-test" && value.name === "STRIPE_API_KEY" && ["development", "preview"].includes(value.env as string) && ["cloudflare", "vercel"].includes(value.target as string) && !preparation) ||
        (identity.service === "clerk" && value.name === "CLERK_SECRET_KEY" && value.target === "cloudflare" && preparation)) || value.scope !== "project" || identity.projectId !== projectId ||
      identity.environment !== value.env || !["vercel", "cloudflare", "github"].includes(value.target as string) ||
      value.registrationUpdatedAt !== null || !timestamp(identity.credentialRevision) ||
      typeof identity.intentFingerprint !== "string" || !HEX.test(identity.intentFingerprint)) return false;
  }
  return typeof value.id === "string" && UUID.test(value.id) &&
    typeof value.name === "string" && NAME.test(value.name) &&
    (value.scope === "user" || value.scope === "project") &&
    targets.includes(value.target as string) && envs.includes(value.env as string) &&
    typeof value.destinationId === "string" && HEX.test(value.destinationId) &&
    typeof value.force === "boolean" && timestamp(value.startedAt) &&
    (value.registrationUpdatedAt === null || timestamp(value.registrationUpdatedAt)) &&
    (value.outcome === "completed" || value.outcome === "incomplete" || value.outcome === "unknown") &&
    (value.finishedAt === null ? value.outcome === "unknown" : timestamp(value.finishedAt));
}

// Refuse links, special files and oversized input before reading. Never echo
// parser/filesystem errors or arbitrary fields from an editable metadata file.
function readJson(path: string): unknown {
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) throw new HistoryStorageError("unsafe-path");
  if (state.size > MAX_BYTES) throw new HistoryStorageError("too-large");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== state.ino || opened.dev !== state.dev) throw new HistoryStorageError("unsafe-path");
    if (opened.size > MAX_BYTES) throw new HistoryStorageError("too-large");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > MAX_BYTES) throw new HistoryStorageError("too-large");
    try { return JSON.parse(buffer.subarray(0, bytes).toString("utf8")); }
    catch { throw new HistoryStorageError("invalid-data"); }
  } finally { closeSync(fd); }
}
function absent(error: unknown): boolean {
  return object(error) && error.code === "ENOENT";
}
function directory(path: string, create: boolean): void {
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (!object(error) || error.code !== "EEXIST") throw error; }
  }
  const state = lstatSync(path);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new HistoryStorageError("unsafe-path");
}

function requireAbsent(path: string, issue: HistoryIssue): void {
  try { lstatSync(path); }
  catch (error) { if (absent(error)) return; throw error; }
  throw new HistoryStorageError(issue);
}

/** One bounded journal per exact project realpath, also for user-scoped keys.
 * baseDir is injection for tests only; there is no CLI/env override. */
export class DeploymentHistory {
  private readonly projectDir: string;
  private readonly projectId: string;
  private readonly home: string;
  private readonly projectKey: string;
  private lastWriteIssue: HistoryIssue | null = null;
  /** Diagnostic of this instance's most recent write, never a writability probe. */
  get writeIssue(): HistoryIssue | null { return this.lastWriteIssue; }
  constructor(projectDir: string, baseDir?: string) {
    // Keep the registry identity derived from the caller's canonical project
    // path before converting the filesystem path to a native representation.
    // On Windows, realpathSync.native() can otherwise produce a different
    // spelling than deriveProjectId() originally hashed during registration.
    this.projectId = deriveProjectId(projectDir);
    this.projectDir = realpathSync.native(projectDir);
    directory(this.projectDir, false);
    this.home = realpathSync.native(baseDir ?? homedir());
    // This hash identifies a directory, never a Secret or a value revision.
    this.projectKey = createHash("sha256").update(this.projectDir).digest("hex");
  }
  private location(create: boolean): string {
    const app = join(this.home, ".api-key-case");
    const history = join(app, "deployment-history");
    const project = join(history, this.projectKey);
    for (const path of [app, history, project]) directory(path, create);
    return project;
  }
  private readAt(dir: string): Journal {
    const parsed = readJson(join(dir, "history.json"));
    if (object(parsed) && Object.hasOwn(parsed, "schemaVersion") && parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3 && parsed.schemaVersion !== 4) {
      throw new HistoryStorageError("unsupported-schema");
    }
    if (!object(parsed) || !exactKeys(parsed, ["schemaVersion", "entries"]) ||
      (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3 && parsed.schemaVersion !== 4) ||
      !Array.isArray(parsed.entries) || parsed.entries.length > LIMIT ||
      !parsed.entries.every((entry) => validReceipt(entry, this.projectId) &&
        (parsed.schemaVersion !== 1 || entry.connection === undefined) && ((parsed.schemaVersion === 3 || parsed.schemaVersion === 4) || entry.preparation === undefined) &&
        (parsed.schemaVersion === 4 || entry.cloudflareTarget === undefined)) ||
      new Set(parsed.entries.map((entry) => entry.id)).size !== parsed.entries.length) throw new HistoryStorageError("invalid-data");
    return { schemaVersion: parsed.schemaVersion, entries: parsed.entries };
  }
  read(): ReadResult {
    try {
      const dir = this.location(false);
      // Existence alone does not distinguish an active writer from a leftover.
      // Do not remove a lock or infer whether another deployment ran.
      requireAbsent(join(dir, "lock"), "lock-present");
      requireAbsent(join(dir, "history.tmp"), "temporary-file-present");
      const journal = this.readAt(dir);
      return { status: "available", issue: null, entries: journal.entries };
    } catch (error) {
      return { status: absent(error) ? "missing" : "unavailable",
        issue: absent(error) ? "not-created" : historyIssueFromError(error), entries: [] };
    }
  }
  private change(edit: (entries: DeploymentReceipt[]) => DeploymentReceipt[]): boolean {
    this.lastWriteIssue = null;
    let dir: string;
    try {
      dir = this.location(true);
      try { mkdirSync(join(dir, "lock"), { mode: 0o700 }); }
      catch (error) {
        if (object(error) && error.code === "EEXIST") throw new HistoryStorageError("lock-present");
        throw error;
      }
    } catch (error) { this.lastWriteIssue = historyIssueFromError(error); return false; }
    let temporaryCreated = false;
    try {
      requireAbsent(join(dir, "history.tmp"), "temporary-file-present");
      let journal: Journal;
      try { journal = this.readAt(dir); }
      catch (error) { if (!absent(error)) throw error; journal = { schemaVersion: 1, entries: [] }; }
      const entries = edit(journal.entries).slice(-LIMIT);
      if (!entries.every((entry) => validReceipt(entry, this.projectId)) ||
        new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new HistoryStorageError("invalid-data");
      // Upgrade only when a v2 attempt is first retained; never downgrade an
      // already upgraded journal, even after all v2 entries have been evicted.
      const schemaVersion = journal.schemaVersion === 4 || entries.some(entry=>entry.cloudflareTarget) ? 4 : journal.schemaVersion === 3 || entries.some(entry=>entry.preparation) ? 3 : journal.schemaVersion === 2 || entries.some((entry) => entry.connection) ? 2 : 1;
      const serialized = JSON.stringify({ schemaVersion, entries });
      if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) throw new HistoryStorageError("too-large");
      let fd: number;
      try { fd = openSync(join(dir, "history.tmp"), "wx", 0o600); }
      catch (error) {
        if (object(error) && error.code === "EEXIST") throw new HistoryStorageError("temporary-file-present");
        throw error;
      }
      temporaryCreated = true;
      try { writeFileSync(fd, serialized); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(join(dir, "history.tmp"), join(dir, "history.json"));
      temporaryCreated = false;
      return true;
    } catch (error) { this.lastWriteIssue = historyIssueFromError(error); return false; }
    finally {
      if (temporaryCreated) { try { unlinkSync(join(dir, "history.tmp")); } catch { /* retain unknown */ } }
      try { rmdirSync(join(dir, "lock")); } catch { /* read() reports unavailable */ }
    }
  }
  registrationUpdatedAt(ref: Pick<SecretRef, "name" | "scope">): string | null {
    try {
      directory(join(this.home, ".api-key-case"), false);
      const index = readJson(join(this.home, ".api-key-case", "index.json"));
      if (!object(index) || index.version !== 1 || !Array.isArray(index.entries)) return null;
      const projectId = ref.scope === "user" ? null : this.projectId;
      const matches = index.entries.filter((entry) => object(entry) && entry.name === ref.name &&
        entry.scope === ref.scope && entry.projectId === projectId);
      return matches.length === 1 && timestamp(matches[0].updatedAt) ? matches[0].updatedAt : null;
    } catch { return null; }
  }
  begin(input: Pick<DeploymentReceipt, "name" | "scope" | "target" | "env" | "destinationId" | "force">): string | null {
    // Explicit projection: even an in-process caller cannot persist extra fields.
    const entry: DeploymentReceipt = {
      id: randomUUID(), name: input.name, scope: input.scope, target: input.target, env: input.env,
      destinationId: input.destinationId, force: input.force,
      startedAt: new Date().toISOString(), finishedAt: null,
      registrationUpdatedAt: this.registrationUpdatedAt(input), outcome: "unknown"
    };
    return this.change((entries) => [...entries, entry]) ? entry.id : null;
  }
  beginConnection(input: ConnectionHistoryStart): string | null {
    try { assertConnectionCredentialRef(input.ref);
      if (!isHostedDeployService(input.ref.service) || (input.ref.service !== "resend" && !["cloudflare", "vercel"].includes(input.target))) throw new Error("Unsupported connection history."); }
    catch { this.lastWriteIssue = "invalid-data"; return null; }
    // Capture the exact approved v2 metadata basis. The legacy index is never
    // read, and neither caller extras nor a raw ref object are persisted.
    const entry: DeploymentReceipt = {
      id: randomUUID(), name: input.ref.name, scope: input.ref.scope, target: input.target,
      env: input.ref.environment, destinationId: input.destinationId, force: input.force,
      startedAt: new Date().toISOString(), finishedAt: null, registrationUpdatedAt: null, outcome: "unknown",
      connection: { credentialVersion: 2, service: input.ref.service, environment: input.ref.environment,
        projectId: input.ref.projectId, credentialRevision: input.credentialRevision, intentFingerprint: input.intentFingerprint },
      ...(input.cloudflareTarget ? { cloudflareTarget: { ...input.cloudflareTarget, services: [...input.cloudflareTarget.services] } } : {})
    };
    return this.change((entries) => [...entries, entry]) ? entry.id : null;
  }
  beginClerkPreparation(input: ConnectionHistoryStart & {preparationDestination?:{accountId:string;worker:string}}): string | null {
    try { assertConnectionCredentialRef(input.ref); if(input.ref.service!=="clerk"||input.ref.name!=="CLERK_SECRET_KEY"||input.target!=="cloudflare")throw new Error("Unsupported preparation history."); }
    catch { this.lastWriteIssue="invalid-data";return null; }
    if(input.preparationDestination!==undefined&&!validPreparationDestination(input.preparationDestination)){this.lastWriteIssue="invalid-data";return null;}
    const entry: DeploymentReceipt={id:randomUUID(),name:"CLERK_SECRET_KEY",scope:"project",target:"cloudflare",env:input.ref.environment,
      destinationId:input.destinationId,force:input.force,startedAt:new Date().toISOString(),finishedAt:null,registrationUpdatedAt:null,outcome:"unknown",
      connection:{credentialVersion:2,service:"clerk",environment:input.ref.environment,projectId:input.ref.projectId,credentialRevision:input.credentialRevision,intentFingerprint:input.intentFingerprint},
      preparation:{kind:"cloudflare-worker-version",versionId:null,...(input.preparationDestination?{destination:{...input.preparationDestination}}:{})}};
    return this.change(entries=>[...entries,entry])?entry.id:null;
  }
  finishClerkPreparation(id:string,outcome:HistoryOutcome,versionId:string|null):boolean {
    return this.change(entries=>{
      const entry=entries.find(item=>item.id===id);
      if(!entry?.preparation||entry.connection?.service!=="clerk"||entry.finishedAt!==null||
        (outcome==="completed" ? typeof versionId!=="string"||!UUID.test(versionId) : versionId!==null))throw new HistoryStorageError("invalid-data");
      return entries.map(item=>item.id===id?{...item,outcome,finishedAt:new Date().toISOString(),preparation:{...item.preparation!,versionId}}:item);
    });
  }
  finish(id: string, outcome: HistoryOutcome): boolean {
    return this.change((entries) => {
      const entry = entries.find((item) => item.id === id);
      // A retained start is required; never resurrect a cleared/evicted attempt.
      if (!entry || entry.finishedAt !== null) throw new HistoryStorageError("record-unavailable");
      return entries.map((item) => item.id === id ? { ...item, outcome, finishedAt: new Date().toISOString() } : item);
    });
  }
}

export interface HistoryReport {
  schemaVersion: 2 | 3 | 4;
  status: ReadResult["status"];
  diagnostic: HistoryDiagnostic;
  writeAccess: "not-tested";
  authority: "advisory-local-history";
  currentRemoteState: "not-inspected";
  destinationInspection: "requested" | "skipped-offline";
  retentionLimit: 200;
  entries: Array<DeploymentReceipt & {
    localRegistration: "update-recorded" | "unverified";
    currentDestination: "selection-matches" | "selection-changed" | "unresolved";
  }>;
}

export async function buildHistoryReport(projectDir: string, options: {
  adapters: ReadonlyMap<TargetId, DeployTarget>;
  baseDir?: string;
  connectionBaseDir?: string; // test-only; defaults to baseDir
  offline?: boolean; // local journal/revision comparison only; never probe providers
  resolveDestination?: typeof resolveDestinationIdentity; // test-only
}): Promise<HistoryReport> {
  const history = new DeploymentHistory(projectDir, options.baseDir);
  const stored = history.read();
  let connections: ConnectionStateStore | null = null;
  if (stored.entries.some((entry) => entry.connection)) {
    try {
      // Preserve the legacy canonical spelling used by v2 registration and
      // intent metadata. native() is only appropriate for physical equality.
      connections = new ConnectionStateStore(realpathSync(projectDir), options.connectionBaseDir ?? options.baseDir);
    } catch { /* unavailable metadata cannot establish a registration update */ }
  }
  const destinations = new Map<string, string | null>();
  const entries: HistoryReport["entries"] = [];
  for (const entry of [...stored.entries].reverse()) {
    const namedGitHub = entry.target === "github" && entry.connection !== undefined;
    const slot = `${entry.target}:${entry.env}:${entry.cloudflareTarget ? `config:${entry.cloudflareTarget.id}` : namedGitHub ? "v2-environment" : "legacy-compatible"}`;
    if (!destinations.has(slot)) {
      let fingerprint: string | null = null;
      try {
        // Legacy GitHub resolves only a login-based identity. It cannot compare
        // the new named-environment user/repository/environment ID contract.
        // Registered config receipts must never be compared with the unrelated default config.
        const adapter = options.offline === true || namedGitHub || entry.cloudflareTarget ? null : options.adapters.get(entry.target);
        if (adapter) fingerprint = (await (options.resolveDestination ?? resolveDestinationIdentity)({
          adapter, projectDir, env: entry.env
        }))?.fingerprint ?? null;
      } catch { /* no provider errors or output belong in history */ }
      destinations.set(slot, fingerprint);
    }
    const current = destinations.get(slot);
    const updatedAt = entry.connection ? connections?.credentialRevision(credentialRefForService(projectDir, entry.connection.environment, entry.connection.service)) ?? null
      : history.registrationUpdatedAt(entry);
    const recordedRevision = entry.connection?.credentialRevision ?? entry.registrationUpdatedAt;
    entries.push({
      ...entry,
      localRegistration: updatedAt && recordedRevision && updatedAt !== recordedRevision
        ? "update-recorded" : "unverified",
      currentDestination: !current ? "unresolved" : current === entry.destinationId ? "selection-matches" : "selection-changed"
    });
  }
  return {
    schemaVersion: entries.some(entry=>entry.cloudflareTarget) ? 4 : entries.some(entry=>entry.preparation) ? 3 : 2, status: stored.status, diagnostic: historyDiagnostic("inspect", stored.issue),
    writeAccess: "not-tested", authority: "advisory-local-history",
    currentRemoteState: "not-inspected", destinationInspection: options.offline === true ? "skipped-offline" : "requested",
    retentionLimit: LIMIT, entries
  };
}
