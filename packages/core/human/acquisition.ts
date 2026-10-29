import type { CredentialPurpose, SecretInputRequest } from "./types.js";
import { assertConnectionCredentialRef } from "../vault/naming.js";

export const RESEND_ACQUISITION_URL = "https://resend.com/api-keys";
export const RESEND_ACQUISITION_DOCS = "https://resend.com/docs/create-an-api-key";
export const OPENAI_ACQUISITION_URL = "https://platform.openai.com/api-keys";
export const CLERK_ACQUISITION_URL = "https://dashboard.clerk.com/~/api-keys";
export const STRIPE_TEST_ACQUISITION_URL = "https://dashboard.stripe.com/test/apikeys";
export interface AcquisitionText { readonly en: string; readonly ja: string }
export interface AcquisitionItem {
  readonly id: string;
  readonly label: AcquisitionText;
  readonly value: AcquisitionText;
  readonly source: "product" | "project-intent";
  /** Exact validated non-secret metadata only. */
  readonly copyValue?: string;
}
export interface AcquisitionSection {
  readonly id: string;
  readonly title: AcquisitionText;
  /** Required settings and warnings must remain expanded. */
  readonly collapsible: boolean;
  readonly items: readonly AcquisitionItem[];
}
export interface CredentialAcquisitionPanel {
  readonly title: AcquisitionText;
  readonly linkText: AcquisitionText;
  readonly linkUrl: typeof RESEND_ACQUISITION_URL | typeof OPENAI_ACQUISITION_URL | typeof STRIPE_TEST_ACQUISITION_URL | typeof CLERK_ACQUISITION_URL;
  readonly sections: readonly AcquisitionSection[];
  /** Linear projection for existing CLI and macOS consumers. */
  readonly steps: readonly AcquisitionText[];
  readonly afterSave: AcquisitionText;
}
export interface ResendAcquisitionPanel extends CredentialAcquisitionPanel {}
const text = (en: string, ja: string): AcquisitionText => ({ en, ja });
const item = (id: string, label: AcquisitionText, value: AcquisitionText, copyValue?: string,
  source: AcquisitionItem["source"] = "product"): AcquisitionItem => ({ id, label, value, source, ...(copyValue ? { copyValue } : {}) });

export const CREDENTIAL_PURPOSES = ["email-sending", "text-generation", "embeddings", "image-generation", "test-payments"] as const;
const PURPOSES: Readonly<Record<CredentialPurpose, AcquisitionText>> = {
  "email-sending": text("Email sending", "メール送信"),
  "text-generation": text("Text generation", "テキスト生成"),
  embeddings: text("Embeddings", "埋め込みベクトルの生成"),
  "image-generation": text("Image generation", "画像生成"),
  "test-payments": text("Test payments", "決済のテスト")
};
export function assertCredentialPurpose(service: string, purpose: unknown): asserts purpose is CredentialPurpose | undefined {
  if (purpose === undefined) return;
  const allowed = service === "resend" ? ["email-sending"] : service === "openai"
    ? ["text-generation", "embeddings", "image-generation"] : service === "stripe-test" ? ["test-payments"] : [];
  if (typeof purpose !== "string" || !allowed.includes(purpose)) throw new Error("Invalid credential purpose.");
}
export const STRIPE_TEST_INPUT_ERROR = Object.freeze(text(
  "Use a Stripe test secret key beginning sk_test_. Live, publishable, restricted and webhook signing keys are not accepted. Nothing was saved.",
  "sk_test_で始まるStripeのテスト用シークレットキーを入力してください。本番用・公開用・制限付き・Webhook署名用のキーは使えません。保存していません。"
));

// Product-owned facts and actions, never caller prose. No service-specific layout.
const PROFILES = {
  clerk: {
    title: text("Set up Clerk backend access", "Clerkのサーバー用キーを登録"),
    linkText: text("Open Clerk API keys", "ClerkのAPIキー画面を開く"), linkUrl: CLERK_ACQUISITION_URL,
    account: text("Select the Clerk app and its Development or Production instance. App environment is separate; confirm the instance with your Agent.", "ClerkのアプリとDevelopmentまたはProductionのインスタンスを選んでください。アプリの対象環境とは別の選択です。Agentに確認してください。"),
    operation: text("Under Secret keys, select the needed key or Add new key. If creating one, enter the suggested name. Do not delete an existing key.", "Secret keysから必要なキーを選ぶか、Add new keyで発行してください。発行時は推奨キー名を入力してください。既存のキーは削除しないでください。"),
    permission: text("For Clerk Backend API access. Confirm that this app needs it with your Agent; storage does not verify access.", "Clerk Backend API用です。対象アプリに必要かAgentに確認してください。保存しても権限は検証されません。"),
    extra: [] as readonly AcquisitionItem[],
    warnings: [item("key-kinds", text("Secret Key only", "登録するキー"), text("Use the app Secret Key (sk_test_ / sk_live_), not a Publishable Key, webhook signing secret or user-issued machine API key. Never expose the Secret Key in frontend code.", "アプリのSecret Key（sk_test_ / sk_live_）を使ってください。Publishable Key・Webhook署名用・利用者向けAPIキーとは別です。フロントエンドのコードには含めないでください。"))],
    details: [] as readonly AcquisitionItem[]
  },
  resend: {
    title: text("Set up Resend email sending", "Resendのメール送信用キーを登録"),
    linkText: text("Open Resend API keys", "ResendのAPIキー画面を開く"), linkUrl: RESEND_ACQUISITION_URL,
    account: text("Sign in to the account that owns this app's sending domain.", "送信ドメインを管理するアカウントでログインしてください。"),
    operation: text("Choose Create API Key and enter the suggested name.", "Create API Keyを選び、推奨キー名を入力してください。"),
    permission: text("Sending access. Full access is unnecessary for sending.", "Sending accessを選んでください。送信にFull accessは不要です。"),
    extra: [] as readonly AcquisitionItem[],
    warnings: [] as readonly AcquisitionItem[],
    details: [] as readonly AcquisitionItem[]
  },
  openai: {
    title: text("Set up OpenAI API access", "OpenAI APIのキーを登録"),
    linkText: text("Open OpenAI API keys", "OpenAIのAPIキー画面を開く"), linkUrl: OPENAI_ACQUISITION_URL,
    account: text("Choose the account/organization and a dedicated OpenAI project for this app environment.", "対象環境に使うアカウント・組織と、専用のOpenAIプロジェクトを選んでください。"),
    operation: text("Choose Create new secret key for server-side API use and enter the suggested name.", "サーバー側API用にCreate new secret keyを選び、推奨キー名を入力してください。"),
    permission: text("Choose Restricted; allow only required API endpoints. If undecided, ask your Agent before creating the key.", "Restrictedで必要なAPIの権限だけを許可してください。未定なら発行前にAgentに確認してください。"),
    extra: [item("models", text("Model access", "モデルの利用設定"), text("In project Limits / Model Usage, allow only required models.", "プロジェクトのLimits / Model Usageで、必要なモデルだけを許可してください。"))],
    warnings: [] as readonly AcquisitionItem[],
    details: [item("service-account", text("Service account", "サービスアカウントの場合"), text("Service-account creation does not show these permission controls. Ask the project owner to review its permissions separately.", "サービスアカウントの発行画面には、この権限設定がありません。プロジェクトの管理者に別途確認してください。"))]
  },
  "stripe-test": {
    title: text("Set up Stripe test secret key (sk_test_)", "Stripeのテスト用キーを登録"),
    linkText: text("Open Stripe test API keys", "Stripeのテスト用APIキー画面を開く"), linkUrl: STRIPE_TEST_ACQUISITION_URL,
    account: text("Select the Stripe account and sandbox. Provider mode: test. App environment is a separate selection.", "Stripeのアカウントとサンドボックスを選んでください。Stripe側はtestです。アプリの対象環境とは別の選択です。"),
    operation: text("Reveal or create a test secret key (sk_test_). If creating one, enter the suggested name.", "テスト用シークレットキー（sk_test_）を表示するか発行してください。発行時は推奨キー名を入力してください。"),
    permission: text("sk_test_ has broad test privileges. This slot accepts sk_test_ only; confirm that your app requires it with your Agent.", "sk_test_はテスト環境で広い権限を持ちます。この登録先はsk_test_専用です。対象アプリに必要かAgentに確認してください。"),
    extra: [] as readonly AcquisitionItem[],
    warnings: [item("key-kinds", text("Unsupported key types", "使えないキー"), text("Never enter sk_live_, pk_test_, rk_test_ or a webhook signing secret (whsec_). Restricted rk_test_ keys are not supported by this slot.", "sk_live_・pk_test_・rk_test_・Webhook署名用（whsec_）は使えません。この登録先は制限付きのrk_test_に対応していません。"))],
    details: [] as readonly AcquisitionItem[]
  }
} as const;

/** Display-only guide for an exact slot. No value, account proof or authority. */
export function buildCredentialAcquisitionPanel(request: SecretInputRequest): CredentialAcquisitionPanel | null {
  if (!("environment" in request)) {
    if (request.acquisition !== undefined || request.purpose !== undefined) throw new Error("Invalid acquisition context.");
    return null;
  }
  assertConnectionCredentialRef(request);
  assertCredentialPurpose(request.service, request.purpose);
  const context = request.acquisition;
  if (context !== undefined && (request.service !== "resend" || !context || typeof context !== "object" || Array.isArray(context) ||
    Object.keys(context).sort().join(",") !== "destination,sendingDomain" ||
    !["local", "vercel", "cloudflare", "github"].includes(context.destination) ||
    (context.destination === "local" && request.environment !== "development") ||
    (context.sendingDomain !== null && (typeof context.sendingDomain !== "string" || context.sendingDomain.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(context.sendingDomain))))) throw new Error("Invalid acquisition context.");
  const profile = PROFILES[request.service];
  const keyName = "akc-" + request.projectId + "-" + request.environment;
  const setup: AcquisitionItem[] = [
    item("account", text("Account / project", "アカウント・プロジェクト"), profile.account),
    item("operation", text("Create / select key", "キーの発行・選択"), profile.operation),
    item("name", text("Suggested key name", "推奨キー名"), text(keyName, keyName), keyName),
    item("permission", text("Permissions", "権限"), profile.permission), ...profile.extra
  ];
  if (request.service === "resend") setup.push(item("domain", text("Sending domain", "送信ドメイン"), context?.sendingDomain
    ? text("Select the domain above. Confirm it is this app's sending domain.", "上のドメインを選んでください。このアプリの送信ドメインか確認してください。")
    : text("Choose this app's sending domain. If undecided, stop and ask your Agent.", "このアプリの送信ドメインを選んでください。未定ならAgentに確認してください。"),
    context?.sendingDomain ?? undefined, "project-intent"));
  const selected: AcquisitionItem[] = [];
  if (request.purpose) selected.push(item("purpose", text("Proposed app purpose — confirm", "アプリの用途（確認してください）"), PURPOSES[request.purpose], undefined, "project-intent"));
  if (context) selected.push(item("destination", text("Selected destination — not verified", "選択済みの配置先（未検証）"), text(context.destination, context.destination), undefined, "project-intent"));
  const sections: AcquisitionSection[] = [
    ...(selected.length ? [{ id: "context", title: text("Project selections — confirm", "プロジェクトの選択内容を確認"), collapsible: false, items: selected }] : []),
    { id: "setup", title: text("1. Get the key", "1. キーを取得"), collapsible: false, items: setup },
    ...(profile.warnings.length ? [{ id: "warnings", title: text("Before entering a key", "入力前の注意"), collapsible: false, items: profile.warnings }] : []),
    ...(profile.details.length ? [{ id: "details", title: text("Additional guidance", "補足を表示"), collapsible: true, items: profile.details }] : [])
  ];
  const afterSave = request.service === "clerk" ? text("After Save: stored only. Return to your Agent for the selected connection plan. Configuration, application checks and deployment need separate review.", "保存後は登録のみ完了します。Agentに戻り、選択済みの接続手順を確認してください。設定・アプリの動作・配置は別途確認が必要です。") : request.service === "resend" ? text(
    "After Save: only registration is complete. Return to your Agent for the selected setup. Sending, deployment and application health need separate checks and approvals.",
    "保存後は登録のみ完了します。Agentに戻り、選択済みの接続手順を確認してください。送信・配置・アプリの動作には別の確認と承認が必要です。") : text(
    "After Save: stored only. Return to your Agent to review the selected supported hosted plan. Provider/application checks and deployment acceptance are separate.",
    "保存後は登録のみ完了します。Agentに戻り、選択済みの対応する配置計画を確認してください。接続・アプリの動作確認と、配置の受け入れ確認は別途必要です。");
  return { title: profile.title, linkText: profile.linkText, linkUrl: profile.linkUrl, sections,
    steps: [text("App environment: " + request.environment + ".", "アプリの対象環境：" + request.environment + "。"),
      ...sections.flatMap(section => section.items.map(entry => text(entry.label.en + ": " + (entry.copyValue && entry.copyValue !== entry.value.en ? entry.copyValue + ". " : "") + entry.value.en, entry.label.ja + "：" + (entry.copyValue && entry.copyValue !== entry.value.ja ? entry.copyValue + "。 " : "") + entry.value.ja))),
      text("Account, project and permissions are not independently verified. Paste the key only into the secure field below, never in chat, files or command arguments.",
        "アカウント・プロジェクト・権限は未検証です。キーは下の入力欄だけに貼り、Chat・ファイル・コマンドの引数には貼らないでください。")], afterSave };
}
export function buildResendAcquisitionPanel(request: SecretInputRequest): ResendAcquisitionPanel | null {
  if (!("environment" in request) || request.service !== "resend") {
    if (request.acquisition !== undefined) throw new Error("Invalid acquisition context.");
    return null;
  }
  return buildCredentialAcquisitionPanel(request);
}
