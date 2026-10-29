import type { ConnectionEnvironment } from "./connection-state.js";

type Service = "resend" | "clerk" | "openai" | "stripe-test";
const CLOUDFLARE_GUIDE = "https://developers.cloudflare.com/workers/configuration/secrets/" as const;
const PUT_GUIDANCE = "wrangler secret putはWorkerの新しいバージョンを作り、直ちにデプロイします。案内を見ることは配置への同意ではありません。";
const PREPARE_GUIDANCE = "Clerkの既存経路はwrangler versions secret putでバージョンを準備します。有効化は別の操作ですが、新しいバージョンも秘密値を扱うため、既存の承認が必要です。";
const PROVIDERS = Object.freeze({
  resend: Object.freeze({ name: "Resend", setting: "RESEND_API_KEY", guide: "https://resend.com/docs/dashboard/api-keys/introduction",
    guidance: "メール送信だけならSending accessと必要な送信ドメインへの制限を確認してください。ドメインの確認とキーの登録は別です。" }),
  clerk: Object.freeze({ name: "Clerk", setting: "CLERK_SECRET_KEY", guide: "https://clerk.com/docs/guides/development/clerk-environment-variables",
    guidance: "対象のClerkアプリとインスタンスを確認してください。Secret Keyは公開用キーやWebhook署名用キーとは別です。アプリ環境だけでインスタンスを推定しません。" }),
  openai: Object.freeze({ name: "OpenAI", setting: "OPENAI_API_KEY", guide: "https://help.openai.com/en/articles/8867743-assign-api-key-permissions",
    guidance: "対象のOpenAIプロジェクトと、アプリが必要とするAPI・モデルの権限を確認してください。無関係な一覧取得のために権限を広げる必要はありません。" }),
  "stripe-test": Object.freeze({ name: "Stripe test", setting: "STRIPE_API_KEY", guide: "https://docs.stripe.com/keys",
    guidance: "この取得経路はStripeのテスト用Secret Key（sk_test_）だけに対応します。Stripeが新規連携に推奨する制限付きキー（rk_test_）は未対応です。本案内を理由に権限を広げたり、別のキーを作ったりしないでください。公開用・本番用・Webhook署名用キーも対象外です。キーの接頭辞だけでは発行元や有効性を確認できません。" })
} as const);

/** Static preselection only. No project, account, vault or provider is inspected. */
export interface CloudflareRouteOption {
  schemaVersion: 1;
  service: Service | null;
  environment: ConnectionEnvironment | null;
  status: "documented-candidate" | "unsupported";
  destination: "cloudflare" | null;
  route: "api-key-case-managed" | null;
  guideUrl: typeof CLOUDFLARE_GUIDE | null;
  providerGuideUrl: typeof PROVIDERS[Service]["guide"] | null;
  requiredSettings: readonly (typeof PROVIDERS[Service]["setting"])[];
  providerGuidance: string | null;
  placementEffect: "creates-and-deploys-worker-version" | "prepares-worker-version-without-activation" | null;
  placementGuidance: string | null;
  nativeAcquisition: "not-supported-by-this-command";
  selection: "not-checked";
  providerAccount: "not-checked";
  destinationAuthentication: "not-checked";
  credentialPresence: "not-checked";
  credentialValidity: "not-checked";
  configuration: "not-checked";
  application: "not-checked";
  humanSelection: "required";
  permission: "none";
  executed: false;
}

export function readCloudflareRouteOption(service: unknown, environment: unknown): CloudflareRouteOption {
  const selectedService: Service | null = service === "resend" || service === "clerk" || service === "openai" || service === "stripe-test" ? service : null;
  const selectedEnvironment: ConnectionEnvironment | null = environment === "development" || environment === "preview" || environment === "production" ? environment : null;
  const supported = selectedService !== null && selectedEnvironment !== null && !(selectedService === "stripe-test" && selectedEnvironment === "production");
  const provider = supported ? PROVIDERS[selectedService] : null;
  return { schemaVersion: 1, service: selectedService, environment: selectedEnvironment,
    status: supported ? "documented-candidate" : "unsupported", destination: supported ? "cloudflare" : null,
    route: supported ? "api-key-case-managed" : null, guideUrl: supported ? CLOUDFLARE_GUIDE : null,
    providerGuideUrl: provider?.guide ?? null, requiredSettings: provider ? [provider.setting] : [], providerGuidance: provider?.guidance ?? null,
    placementEffect: !supported ? null : selectedService === "clerk" ? "prepares-worker-version-without-activation" : "creates-and-deploys-worker-version",
    placementGuidance: !supported ? null : selectedService === "clerk" ? PREPARE_GUIDANCE : PUT_GUIDANCE,
    nativeAcquisition: "not-supported-by-this-command", selection: "not-checked", providerAccount: "not-checked",
    destinationAuthentication: "not-checked", credentialPresence: "not-checked", credentialValidity: "not-checked", configuration: "not-checked", application: "not-checked",
    humanSelection: "required", permission: "none", executed: false };
}

/** Rebuild display text from the closed catalog, never caller-supplied report text. */
export function renderCloudflareRouteOption(report: CloudflareRouteOption): string {
  const option = readCloudflareRouteOption(report.service, report.environment);
  if (report.status !== "documented-candidate" || option.status !== "documented-candidate" || !option.service) {
    return "このサービス・環境のCloudflare向け取得案内は未対応です。キー取得・接続・配置は行っていません。";
  }
  return [
    `${PROVIDERS[option.service].name} / Cloudflare / ${option.environment}: 接続方法の候補（未選択）`,
    `サービス側の公式案内: ${option.providerGuideUrl}`,
    `Cloudflareの公式案内: ${option.guideUrl}`,
    `既存の配置経路で使う設定名: ${option.requiredSettings.join(", ")}`,
    option.providerGuidance!,
    "これは既存の安全な入力・保管とCloudflare配置を使う候補です。サービスのキーを自動取得する公式連携ではありません。",
    "WranglerへのログインはCloudflare側の認証です。サービスのキー取得・登録や接続完了を意味しません。",
    "対象アカウント・プロジェクト・環境・接続方法を先に確認してください。既に選択・登録済みなら、その記録を確認し、同じキーを作り直したり再入力したりしないでください。",
    option.placementGuidance!,
    "選択後はconnection cloudflare guideとconnection credential guideで対象と保存状態を確認してください。本文は対応するHuman Planeへだけ入力し、Chat・Agentの端末・引数には貼らないでください。",
    "この候補は入力や配置の実行可否を確認していません。既存の対応環境・受入・人間承認の条件を維持し、ログイン・入力・保存・配置へ自動で進みません。",
    "保存、配置記録、サービスの有効性、アプリの動作確認は別です。この案内ではすべて未確認で、実行の許可もありません。"
  ].join("\n");
}
