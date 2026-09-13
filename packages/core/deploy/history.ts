import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync,
  readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveProjectId } from "../vault/naming.js";
import type { SecretRef, SecretScope } from "../vault/types.js";
import { resolveDestinationIdentity } from "./destination.js";
import type { DeployEnv, DeployTarget, TargetId } from "./types.js";

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
export interface DeploymentReceipt {
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
}
type Journal = { schemaVersion: 1; entries: DeploymentReceipt[] };
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
    "wait-and-inspect": "A lock is present. Another writer may be active; a crash or stale lock is not established. Check for running deploys, let them finish, then run history --json again.",
    "review-history-metadata": "After confirming no deploy is running, review the local history storage. If discarding metadata is necessary, explain the loss of past results and obtain an explicit decision for that project. Do not read raw history contents into chat.",
    "use-compatible-version": "Use the package version that wrote this history or consult its history documentation. Do not overwrite an unfamiliar schema.",
    "review-storage-access": "Check the project path and the current OS user's access to local history storage, including read-only storage. Do not change permissions or discard history automatically.",
    "free-storage-space": "Ask the user to check free disk space or quota for local history storage. Do not delete history to make space automatically."
  };
  return `History diagnostic: ${JSON.stringify(diagnostic)}\n${advice[diagnostic.recovery]}\n` +
    "Reinspect with history --json after addressing the cause; inspection does not test write access. Never delete an existing lock/history or repeat deploy automatically. A later deploy requires a fresh request and all existing approval, license and destination checks.";
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
function validReceipt(value: unknown): value is DeploymentReceipt {
  if (!object(value) || !exactKeys(value, ["id", "name", "scope", "target", "env", "destinationId", "force",
    "startedAt", "finishedAt", "registrationUpdatedAt", "outcome"])) return false;
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
  private readonly home: string;
  private readonly projectKey: string;
  private lastWriteIssue: HistoryIssue | null = null;
  /** Diagnostic of this instance's most recent write, never a writability probe. */
  get writeIssue(): HistoryIssue | null { return this.lastWriteIssue; }
  constructor(projectDir: string, baseDir?: string) {
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
    if (object(parsed) && Object.hasOwn(parsed, "schemaVersion") && parsed.schemaVersion !== 1) {
      throw new HistoryStorageError("unsupported-schema");
    }
    if (!object(parsed) || !exactKeys(parsed, ["schemaVersion", "entries"]) || parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.entries) || parsed.entries.length > LIMIT || !parsed.entries.every(validReceipt) ||
      new Set(parsed.entries.map((entry) => entry.id)).size !== parsed.entries.length) throw new HistoryStorageError("invalid-data");
    return { schemaVersion: 1, entries: parsed.entries };
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
      if (!entries.every(validReceipt)) throw new HistoryStorageError("invalid-data");
      let fd: number;
      try { fd = openSync(join(dir, "history.tmp"), "wx", 0o600); }
      catch (error) {
        if (object(error) && error.code === "EEXIST") throw new HistoryStorageError("temporary-file-present");
        throw error;
      }
      temporaryCreated = true;
      try { writeFileSync(fd, JSON.stringify({ schemaVersion: 1, entries })); fsyncSync(fd); }
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
      const projectId = ref.scope === "user" ? null : deriveProjectId(this.projectDir);
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
  schemaVersion: 2;
  status: ReadResult["status"];
  diagnostic: HistoryDiagnostic;
  writeAccess: "not-tested";
  authority: "advisory-local-history";
  currentRemoteState: "not-inspected";
  retentionLimit: 200;
  entries: Array<DeploymentReceipt & {
    localRegistration: "update-recorded" | "unverified";
    currentDestination: "selection-matches" | "selection-changed" | "unresolved";
  }>;
}

export async function buildHistoryReport(projectDir: string, options: {
  adapters: ReadonlyMap<TargetId, DeployTarget>;
  baseDir?: string;
  resolveDestination?: typeof resolveDestinationIdentity; // test-only
}): Promise<HistoryReport> {
  const history = new DeploymentHistory(projectDir, options.baseDir);
  const stored = history.read();
  const destinations = new Map<string, string | null>();
  const entries: HistoryReport["entries"] = [];
  for (const entry of [...stored.entries].reverse()) {
    const slot = `${entry.target}:${entry.env}`;
    if (!destinations.has(slot)) {
      let fingerprint: string | null = null;
      try {
        const adapter = options.adapters.get(entry.target);
        if (adapter) fingerprint = (await (options.resolveDestination ?? resolveDestinationIdentity)({
          adapter, projectDir, env: entry.env
        }))?.fingerprint ?? null;
      } catch { /* no provider errors or output belong in history */ }
      destinations.set(slot, fingerprint);
    }
    const current = destinations.get(slot);
    const updatedAt = history.registrationUpdatedAt(entry);
    entries.push({
      ...entry,
      localRegistration: updatedAt && entry.registrationUpdatedAt && updatedAt !== entry.registrationUpdatedAt
        ? "update-recorded" : "unverified",
      currentDestination: !current ? "unresolved" : current === entry.destinationId ? "selection-matches" : "selection-changed"
    });
  }
  return {
    schemaVersion: 2, status: stored.status, diagnostic: historyDiagnostic("inspect", stored.issue),
    writeAccess: "not-tested", authority: "advisory-local-history",
    currentRemoteState: "not-inspected", retentionLimit: LIMIT, entries
  };
}
