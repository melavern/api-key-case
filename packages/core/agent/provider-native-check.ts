import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { parseTree, type Node, type ParseError } from "jsonc-parser";
import { buildTrustedExecution, matchesTrustedExecution, type SnapshotRequest, type TrustedExecution } from "../deploy/snapshot.js";
import { spawnResolvedCli } from "../deploy/which.js";
import type { DeployPlan } from "../deploy/types.js";
import { ConnectionStateStore, type ConnectionEnvironment } from "./connection-state.js";
import { CLERK_NATIVE_SETTINGS, clerkNativeIntentFingerprint } from "./clerk-native.js";
import { connectionIntentFingerprint } from "./fingerprints.js";

export const VERCEL_NATIVE_INSPECTION_VERSION = "59.11.7";
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 15_000;
const CLOSE_GRACE_MS = 2_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ENVIRONMENTS = ["development", "preview", "production"];
type Configuration = "integration-managed" | "present-unmanaged" | "absent" | "partial" | "unknown";
type NativeService = "resend" | "clerk";
type SettingPresence = { role: "secret" | "publishable"; name: "CLERK_SECRET_KEY" | "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"; presence: "present" | "absent" | "unknown" };
type Reason = "inspected" | "intent-mismatch" | "cli-unavailable" | "basis-unavailable" | "basis-changed" |
  "unsupported-cli-version" | "unexpected-output" | "command-failed" | "timed-out" | "aborted" | "output-too-large" | "termination-unconfirmed";
type Projection = { configuration: Configuration; configurationFingerprint: string | null; settings?: SettingPresence[] };
type InternalProjection = Projection & { attributionFingerprint?: string | null };
export interface NativeInspectionResult extends Projection {
  schemaVersion: 1 | 2;
  service: NativeService;
  environment: ConnectionEnvironment;
  destination: "vercel";
  status: "inspected" | "unknown";
  reason: Reason;
  intentFingerprint: string | null;
  destinationSelectionFingerprint: string | null;
  observedAt: string | null;
  integrationIdentity: "unverified";
  credentialValidity: "not-checked";
  application: "not-checked";
  permission: "none";
}

/** Human-readable projection of the same closed inspection; never records or checks an app. */
export function renderNativeInspectionResult(result: NativeInspectionResult): string {
  const service = result.service === "clerk" ? "Clerk" : "Resend";
  const configuration = result.status === "inspected" ? result.configuration : "unknown";
  const summaries: Record<Configuration, string> = {
    "integration-managed": "必要な設定があります。Vercelは公式連携の管理下として報告しています。",
    "present-unmanaged": "設定はあります。公式連携の管理下かは未確認です。",
    absent: "選択した環境では、必要な設定を確認できませんでした。",
    partial: "必要な設定の一部だけを確認しました。",
    unknown: "設定の状態は不明です。",
  };
  const reasons: Record<Reason, string> = {
    inspected: "",
    "intent-mismatch": "保存済みの接続先と、今回指定したサービス・環境・配置先が一致しません。",
    "cli-unavailable": "対応するVercel CLIを確認できませんでした。",
    "basis-unavailable": "選択した配置先や確認に必要な情報を安全に読み取れませんでした。",
    "basis-changed": "確認中に接続先や設定が変わりました。",
    "unsupported-cli-version": "このVercel CLIのバージョンには対応していません。",
    "unexpected-output": "Vercelの応答を安全に解釈できませんでした。",
    "command-failed": "Vercel CLIでの確認に失敗しました。",
    "timed-out": "確認が制限時間を超えました。",
    aborted: "確認を中断しました。",
    "output-too-large": "Vercelの応答が確認可能なサイズを超えました。",
    "termination-unconfirmed": "確認用CLIの終了が不明です。終了を確認してから次の操作を判断してください。",
  };
  const lines = [`今回の確認対象は${service} / Vercel / ${result.environment}です。`, summaries[configuration]];
  if (result.destinationSelectionFingerprint && /^[a-f0-9]{64}$/.test(result.destinationSelectionFingerprint)) {
    lines.push(`配置先選択の識別子は${result.destinationSelectionFingerprint}です。`);
  }
  if (result.status !== "inspected") lines.push(reasons[result.reason]);
  lines.push("アプリ機能は未確認です。連携元の同一性とキーの有効性も未確認です。");
  if (configuration === "integration-managed") {
    lines.push("この公式連携では、API Key Caseへのキーの二重登録は不要です。");
    lines.push(result.service === "clerk"
      ? "次の確認は、別途許可された対象アプリでのログアウト時のアクセス拒否と、ログイン後の保護ページへのアクセスです。"
      : "次の確認は、別途許可された対象アプリでの意図した送信機能と、宛先での受信です。");
  } else {
    lines.push("選択した環境の既存設定を確認してください。この結果からキーの再入力や別環境への切り替えは判断できません。");
  }
  lines.push("通常のplanやnextを完了扱いにはしません。操作の許可も与えません。");
  return lines.filter(Boolean).join("\n");
}
/** Internal test seams; never accepted through flags, metadata or environment. */
interface InspectionOptions {
  connectionBaseDir?: string;
  pathOverride?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
const unknownProjection = (): Projection => ({ configuration: "unknown", configurationFingerprint: null });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function uniqueKeys(node: Node, depth = 0): boolean {
  if (depth > 32) return false;
  if (node.type === "object") {
    const names = (node.children ?? []).map(child => child.children?.[0]?.value);
    if (new Set(names).size !== names.length) return false;
  }
  return (node.children ?? []).every(child => uniqueKeys(child, depth + 1));
}

/** Closed metadata projection only. Values never enter returned data or fingerprints. */
function parseConfiguration(stdout: string, environment: ConnectionEnvironment, name: "RESEND_API_KEY" | "CLERK_SECRET_KEY" | "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"): InternalProjection {
  try {
    if (!ENVIRONMENTS.includes(environment) || Buffer.byteLength(stdout) > MAX_BYTES) return unknownProjection();
    const errors: ParseError[] = [];
    const tree = parseTree(stdout, errors, { disallowComments: true, allowTrailingComma: false });
    if (!tree || errors.length || !uniqueKeys(tree)) return unknownProjection();
    const data: unknown = JSON.parse(stdout);
    // Error bodies can have exit code zero in some official CLI versions.
    if (!object(data) || Object.keys(data).join(",") !== "envs" || !Array.isArray(data.envs) || data.envs.length > 1000) return unknownProjection();
    const matches: Record<string, unknown>[] = [];
    for (const entry of data.envs) {
      if (!object(entry) || typeof entry.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(entry.key) ||
          !Array.isArray(entry.target) || entry.target.length < 1 || entry.target.length > 3 ||
          !entry.target.every(target => typeof target === "string" && ENVIRONMENTS.includes(target)) ||
          new Set(entry.target).size !== entry.target.length || !entry.target.includes(environment)) return unknownProjection();
      if (entry.key === name) matches.push(entry);
    }
    if (!matches.length) return { configuration: "absent", configurationFingerprint: hash({ environment, present: false }) };
    if (matches.length !== 1) return unknownProjection();
    const entry = matches[0];
    if (typeof entry.type !== "string" || !["encrypted", "plain", "sensitive"].includes(entry.type) ||
        (entry.gitBranch !== undefined && entry.gitBranch !== null && entry.gitBranch !== "") ||
        (entry.visibility !== undefined && (typeof entry.visibility !== "string" || !["config", "secret"].includes(entry.visibility))) ||
        (entry.configurationId !== undefined && entry.configurationId !== null &&
          (typeof entry.configurationId !== "string" || !ID.test(entry.configurationId))) ||
        (entry.updatedAt !== undefined && (!Number.isSafeInteger(entry.updatedAt) || Number(entry.updatedAt) < 0))) return unknownProjection();
    const configuration = entry.configurationId ? "integration-managed" : "present-unmanaged";
    return { configuration, attributionFingerprint: entry.configurationId ? hash(entry.configurationId) : null, configurationFingerprint: hash({ version: 1, environment,
      key: name, type: entry.type, visibility: entry.visibility ?? null,
      target: [...entry.target as string[]].sort(), configurationId: entry.configurationId ?? null,
      updatedAt: entry.updatedAt ?? null }) };
  } catch { return unknownProjection(); }
}

export function parseNativeConfiguration(stdout: string, environment: ConnectionEnvironment): Projection {
  const {configuration,configurationFingerprint} = parseConfiguration(stdout,environment,"RESEND_API_KEY");
  return {configuration,configurationFingerprint};
}
export function parseClerkNativeConfiguration(stdout: string, environment: ConnectionEnvironment): Projection {
  const rows = CLERK_NATIVE_SETTINGS.map(setting => ({setting,parsed:parseConfiguration(stdout,environment,setting.name)}));
  const settings: SettingPresence[] = rows.map(({setting,parsed}) => ({...setting,
    presence:parsed.configuration === "unknown" ? "unknown" : parsed.configuration === "absent" ? "absent" : "present"}));
  if (settings.some(setting => setting.presence === "unknown")) return {...unknownProjection(),settings};
  const present = settings.filter(setting => setting.presence === "present").length;
  if (present < 2) return {configuration:present === 0 ? "absent" : "partial",settings,
    configurationFingerprint:hash({service:"clerk",environment,settings,rows:rows.map(row => row.parsed.configurationFingerprint)})};
  const [secret,publishable] = rows.map(row => row.parsed);
  if (secret.attributionFingerprint !== publishable.attributionFingerprint) return {...unknownProjection(),settings};
  return {configuration:secret.attributionFingerprint ? "integration-managed" : "present-unmanaged",settings,
    configurationFingerprint:hash({service:"clerk",environment,secret:secret.configurationFingerprint,publishable:publishable.configurationFingerprint})};
}

function selectedIds(execution: TrustedExecution): { project: string; org: string } | null {
  const labels = execution.snapshot.destinationConfig.map(file => file.destinationLabel).filter(Boolean);
  if (labels.length !== 1) return null;
  const match = /^Vercel org\/project ([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128}) via \.vercel\/project\.json$/.exec(labels[0]!);
  return match ? { org: match[1], project: match[2] } : null;
}
function planFor(args: string[]): DeployPlan {
  return { argv: ["vercel", ...args], valueVia: "stdin", displayCommand: "Vercel native configuration inspection", overwriteWarning: false };
}

/** Explicit network inspection; ordinary connection plan never invokes this function. */
export async function inspectProviderNative(projectDir: string, environment: ConnectionEnvironment,
  options: InspectionOptions = {}, service: NativeService = "resend"): Promise<NativeInspectionResult> {
  const result = (reason: Reason): NativeInspectionResult => ({ schemaVersion: service === "clerk" ? 2 : 1, service: service === "clerk" ? "clerk" : "resend", environment,
    destination: "vercel", status: "unknown", reason, ...unknownProjection(), intentFingerprint: null,
    destinationSelectionFingerprint: null, observedAt: null, integrationIdentity: "unverified",
    credentialValidity: "not-checked", application: "not-checked", permission: "none",
    ...(service === "clerk" ? {settings:CLERK_NATIVE_SETTINGS.map(setting => ({...setting,presence:"unknown" as const}))} : {}) });
  try {
    if (options.signal?.aborted) return result("aborted");
    if (!ENVIRONMENTS.includes(environment) || !["resend","clerk"].includes(service)) return result("intent-mismatch");
    const canonical = realpathSync(projectDir);
    const store = new ConnectionStateStore(canonical, options.connectionBaseDir);
    const readIntent = () => service === "clerk" ? store.readClerkNativeIntent() : store.readIntent();
    const selected = readIntent();
    if (selected.status !== "available" || selected.value.service !== service || selected.value.environment !== environment ||
        selected.value.route !== "provider-native" || selected.value.destination.kind !== "vercel") return result("intent-mismatch");
    const fingerprint = (intent: typeof selected.value) => intent.service === "clerk" ? clerkNativeIntentFingerprint(intent) : connectionIntentFingerprint(intent);
    const intentFingerprint = fingerprint(selected.value);
    const request: SnapshotRequest = { name: service === "clerk" ? "CLERK_SECRET_KEY" : "RESEND_API_KEY", scope: "project", projectId: null, env: environment,
      force: false, adapterId: "vercel", cliCommand: "vercel", providerIdentity: null };
    const capture = (plan: DeployPlan) => buildTrustedExecution(request, plan, {projectDir:canonical,pathOverride:options.pathOverride});
    // First resolve the already-closed linked-project projection without executing.
    const initial = capture(planFor([]));
    if (!initial.ok) return result(initial.reason === "cli-unavailable" || initial.reason === "unsupported-platform" ? "cli-unavailable" : "basis-unavailable");
    const ids = selectedIds(initial.execution);
    if (!ids) return result("basis-unavailable");
    const args = ["api", `/v10/projects/${ids.project}/env?target=${environment}`, "--method", "GET", "--raw",
      "--non-interactive", "--api", "https://api.vercel.com", "--scope", ids.org];
    const plan = planFor(args), captured = capture(plan);
    if (!captured.ok || JSON.stringify(selectedIds(captured.execution)) !== JSON.stringify(ids)) return result("basis-changed");
    const execution = captured.execution;
    const current = () => {
      const now = readIntent();
      return realpathSync(projectDir) === canonical && now.status === "available" && now.value.id === selected.value.id &&
        now.value.service === service && fingerprint(now.value) === intentFingerprint && matchesTrustedExecution(request, plan, execution);
    };
    if (!current()) return result("basis-changed");
    const version = await collectConfiguration(execution, ["--version"], environment, options, service, true);
    if (version.reason !== "inspected") return result(version.reason);
    if (options.signal?.aborted) return result("aborted");
    if (!current()) return result("basis-changed");
    const inspection = await collectConfiguration(execution, args, environment, options, service);
    if (inspection.reason !== "inspected") return result(inspection.reason);
    if (options.signal?.aborted) return result("aborted");
    if (!current()) return result("basis-changed");
    return { ...result("inspected"), status: "inspected", ...inspection.projection, intentFingerprint,
      destinationSelectionFingerprint: hash({ version: 1, projectDir: canonical, environment, ...ids }),
      observedAt: new Date().toISOString() };
  } catch { return result("basis-unavailable"); }
}

// This module alone consumes potentially value-bearing CLI output for this check.
// No raw string/error is returned to another module or emitted to ordinary logs.
async function collectConfiguration(execution: TrustedExecution, args: string[], environment: ConnectionEnvironment,
  options: InspectionOptions, service: NativeService, versionOnly = false): Promise<{ reason: Reason; projection: Projection }> {
  if (options.signal?.aborted) return { reason: "aborted", projection: unknownProjection() };
  return new Promise(resolve => {
    let chunks: Buffer[] = [], bytes = 0, stopped: Reason | null = null, settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined, grace: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawnResolvedCli>;
    const discard = () => { for (const chunk of chunks) chunk.fill(0); chunks = []; };
    const finish = (reason: Reason, projection = unknownProjection()) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace); options.signal?.removeEventListener("abort", abort);
      discard(); resolve({ reason, projection });
    };
    const stop = (reason: Reason) => {
      if (settled || stopped) return;
      stopped = reason; discard();
      try { child.kill("SIGKILL"); } catch { /* No termination claim without close. */ }
      grace = setTimeout(() => {
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
        finish("termination-unconfirmed");
      }, CLOSE_GRACE_MS);
    };
    const abort = () => stop("aborted");
    try {
      child = spawnResolvedCli(execution.resolvedCli, args, { cwd: execution.cwd,
        env: { ...execution.env, CI: "1", DO_NOT_TRACK: "1", VERCEL_TELEMETRY_DISABLED: "1", NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      child.on("error", () => {
        if (child.pid) stop("command-failed"); else finish("command-failed");
      });
      child.stdin?.on("error", () => stop("command-failed"));
      child.stdin?.end();
      const data = (chunk: Buffer, retain: boolean) => {
        if (settled || stopped) return;
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { stop("output-too-large"); return; }
        if (retain) chunks.push(Buffer.from(chunk));
      };
      child.stdout?.on("error", () => stop("command-failed"));
      child.stderr?.on("error", () => stop("command-failed"));
      child.stdout?.on("data", chunk => data(chunk, true));
      child.stderr?.on("data", chunk => data(chunk, false));
      child.on("close", code => {
        if (settled) return;
        if (stopped) { finish(stopped); return; }
        if (code !== 0) { finish("command-failed"); return; }
        const buffer = Buffer.concat(chunks);
        let projection = unknownProjection(), supportedVersion = false;
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
          if (versionOnly) supportedVersion = text.trim() === VERCEL_NATIVE_INSPECTION_VERSION;
          else projection = service === "clerk" ? parseClerkNativeConfiguration(text,environment) : parseNativeConfiguration(text, environment);
        }
        catch { /* Invalid UTF-8 is not a provider observation. */ }
        buffer.fill(0);
        if (versionOnly) finish(supportedVersion ? "inspected" : "unsupported-cli-version");
        else finish(projection.configuration === "unknown" ? "unexpected-output" : "inspected", projection);
      });
      const timeout = options.timeoutMs === undefined ? TIMEOUT_MS : Math.max(1, Math.min(TIMEOUT_MS, options.timeoutMs));
      timer = setTimeout(() => stop("timed-out"), timeout);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    } catch { finish("command-failed"); }
  });
}
