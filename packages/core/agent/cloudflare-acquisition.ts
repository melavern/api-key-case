import { realpathSync } from "node:fs";
import { deriveProjectId } from "../vault/naming.js";
import { resolveClerkWorkerDestination } from "../deploy/snapshot.js";
import { ConnectionStateStore, type ConnectionEnvironment } from "./connection-state.js";

type Service = "resend" | "clerk" | "openai" | "stripe-test";
const GUIDE = "https://developers.cloudflare.com/workers/configuration/secrets/" as const;
const SETTINGS = Object.freeze({ resend: "RESEND_API_KEY", clerk: "CLERK_SECRET_KEY", openai: "OPENAI_API_KEY", "stripe-test": "STRIPE_API_KEY" } as const);
const LABELS = { resend: "Resend", clerk: "Clerk", openai: "OpenAI", "stripe-test": "Stripe test" } as const;

/** Advisory selection facts only. Destination login is not provider acquisition. */
export interface CloudflareAcquisitionGuide {
  schemaVersion: 1;
  service: Service | null;
  environment: ConnectionEnvironment | null;
  destination: "cloudflare";
  route: "api-key-case-managed";
  state: "selection-confirmed" | "unknown" | "unsupported";
  reason: "local-selection-only" | "selection-missing" | "selection-mismatch" | "selection-unavailable" | "configuration-unresolved" | "selection-changed";
  selection: { localProjectId: string; accountId: string; worker: string } | null;
  guideUrl: typeof GUIDE | null;
  requiredSettings: readonly (typeof SETTINGS[Service])[];
  configuration: "explicit-local" | "unresolved" | "not-inspected";
  authentication: "not-inspected";
  remoteConfiguration: "not-inspected";
  credentialPresence: "not-inspected";
  credentialValidity: "not-checked";
  application: "not-checked";
  nativeAcquisition: "not-supported-by-this-guide";
  nativeExecution?: "pending-acceptance";
  permission: "none";
  executed: false;
}

/** Reuse the existing bounded Wrangler selector. No CLI, vault, network or writes. */
export function readCloudflareAcquisitionGuide(projectDir: string, service: Service,
  environment: ConnectionEnvironment, baseDir?: string): CloudflareAcquisitionGuide {
  const result: CloudflareAcquisitionGuide = {
    schemaVersion: 1, service: ["resend", "clerk", "openai", "stripe-test"].includes(service) ? service : null,
    environment: ["development", "preview", "production"].includes(environment) ? environment : null,
    destination: "cloudflare", route: "api-key-case-managed", state: "unknown", reason: "selection-unavailable",
    selection: null, guideUrl: null, requiredSettings: [], configuration: "not-inspected",
    authentication: "not-inspected", remoteConfiguration: "not-inspected", credentialPresence: "not-inspected",
    credentialValidity: "not-checked", application: "not-checked", nativeAcquisition: "not-supported-by-this-guide",
    ...((service === "openai" || service === "stripe-test") ? { nativeExecution: "pending-acceptance" as const } : {}),
    permission: "none", executed: false
  };
  if (!result.service || !result.environment || (service === "stripe-test" && environment === "production")) return { ...result, state: "unsupported", reason: "selection-mismatch" };
  try {
    const project = realpathSync(projectDir), store = new ConnectionStateStore(project, baseDir);
    const readIntent = () => service === "clerk" ? store.readClerkManagedIntent() : service === "resend" ? store.readIntent() : store.readProviderHostedIntent(service);
    const selected = readIntent();
    if (selected.status === "missing") return { ...result, state: "unsupported", reason: "selection-missing" };
    if (selected.status !== "available") return result;
    if (selected.value.service !== service || selected.value.environment !== environment ||
        selected.value.route !== "api-key-case-managed" || selected.value.destination.kind !== "cloudflare") {
      return { ...result, state: "unsupported", reason: "selection-mismatch" };
    }
    const destination = resolveClerkWorkerDestination(project, environment);
    if (!destination) return { ...result, configuration: "unresolved", reason: "configuration-unresolved" };
    const after = readIntent(), destinationAfter = resolveClerkWorkerDestination(project, environment);
    if (realpathSync(projectDir) !== project || after.status !== "available" ||
        JSON.stringify(after.value) !== JSON.stringify(selected.value) ||
        JSON.stringify(destinationAfter) !== JSON.stringify(destination)) return { ...result, reason: "selection-changed" };
    return { ...result, state: "selection-confirmed", reason: "local-selection-only", configuration: "explicit-local",
      selection: { localProjectId: deriveProjectId(project), accountId: destination.accountId, worker: destination.name },
      guideUrl: GUIDE, requiredSettings: [SETTINGS[service]] };
  } catch { return result; }
}

export function renderCloudflareAcquisitionGuide(guide: CloudflareAcquisitionGuide): string {
  if (!guide.selection || !guide.service || !guide.environment || guide.state !== "selection-confirmed") {
    return "保存済みのCloudflare接続と、選択した環境のWrangler設定を確認してください。Worker名とaccount_idを明示した設定が1つ必要です。接続先の変更、ログイン、キーの取得・登録は行っていません。";
  }
  return [
    `${LABELS[guide.service]} / Cloudflare / ${guide.environment}`,
    `対象: account ${guide.selection.accountId} / Worker ${guide.selection.worker}（このプロジェクト: ${guide.selection.localProjectId}）`,
    `公式ガイド: ${GUIDE}`,
    `既存の配置経路で使う設定: ${SETTINGS[guide.service]}`,
    "確認できたのはローカルの接続先設定です。ログイン状態、Cloudflare上の設定、キーの有効性、アプリ動作は未確認です。",
    "Wranglerへのログインは配置先の認証です。サービスのキー取得や、公式連携による自動取得の完了を意味しません。",
    guide.nativeExecution ? "OpenAI / Stripe testのhosted配置実行はnative受入待ちのため無効です。offline計画とローカル設定を確認できます。provider確認・アプリ動作確認は未対応です。" :
      "既存のキー登録・配置経路を使います。この案内は新しいキーを作成せず、キー本文を表示・コピー・ファイル出力しません。",
    "既存の保存状態と過去の結果は、同じプロジェクトで api-key-case next --json と api-key-case history --json --offline を確認してください。記録は現在の配置や実行許可を証明しません。",
    guide.service === "clerk" ?
      "Clerkの既存経路はWorkerの新しいversionを準備します。有効化とは別の操作で、稼働中のversionや保護されたアクセスの成功は確認していません。" :
      guide.service === "resend" ? "Resendの配置とメール送信・受信の確認は別の操作です。キーの配置記録だけで送信可能とは判断しません。" :
      "配置記録はproviderの権限・有効性・アプリ動作やStripe testの実行時モードを証明しません。",
    "公式ガイドのSecret変更はversion作成や公開反映を伴う場合があります。案内を開くことを実行への同意として扱わず、既存の計画・人間承認を維持してください。",
    "この案内はローカル情報だけを読みます。自動ログイン、権限変更、インストール、配置、有効化は行いません。"
  ].join("\n");
}
