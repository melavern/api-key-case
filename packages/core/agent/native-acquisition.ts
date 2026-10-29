import { realpathSync } from "node:fs";
import { deriveProjectId } from "../vault/naming.js";
import { ConnectionStateStore, type ConnectionEnvironment, type NativeEnrollmentMethod } from "./connection-state.js";
import { readNativeApplicationEvidence, readNativeDestinationSelection, type NativeApplicationEvidence } from "./native-observations.js";

type Service = "resend" | "clerk";
type Setting = "RESEND_API_KEY" | "CLERK_SECRET_KEY" | "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY";
const GUIDES = Object.freeze({
  resend: "https://resend.com/blog/vercel-integration",
  clerk: "https://clerk.com/docs/guides/development/integrations/platforms/vercel-marketplace"
} as const);
const RESEND_VERCEL_MARKETPLACE_URL = "https://resend.com/changelog/vercel-marketplace-integration" as const;
const RESEND_VERCEL_MARKETPLACE_PREREQUISITE = "domain-purchased-through-vercel" as const;
const SETTINGS: Readonly<Record<Service, readonly Setting[]>> = Object.freeze({
  resend: Object.freeze(["RESEND_API_KEY"] as const),
  clerk: Object.freeze(["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] as const)
});

/** Advisory, non-secret projection. Neither links nor commands are executed. */
export interface NativeAcquisitionGuide {
  schemaVersion: 1;
  service: Service | null;
  environment: ConnectionEnvironment | null;
  destination: "vercel";
  state: "human-needed" | "integration-managed" | "partial" | "unknown" | "unsupported";
  reason: "not-inspected" | "configuration-recorded" | "review-existing-configuration" | "observation-unverified" |
    "selection-missing" | "selection-mismatch" | "selection-unavailable" | "selection-changed";
  selection: { localProjectId: string; orgId: string; projectId: string; fingerprint: string } | null;
  nativeEnrollment: NativeEnrollmentMethod | "unrecorded" | "not-selected" | null;
  nativeEnrollmentPrerequisite: typeof RESEND_VERCEL_MARKETPLACE_PREREQUISITE | null;
  nativeEnrollmentEligibility: "unverified" | null;
  guideUrl: typeof GUIDES[Service] | typeof RESEND_VERCEL_MARKETPLACE_URL | null;
  requiredSettings: readonly Setting[];
  /** null means the existing aggregate receipt cannot identify individual missing settings. */
  missingSettings: readonly Setting[] | null;
  configuration: "not-inspected" | "integration-managed" | "present-unmanaged" | "absent" | "partial" | "unknown";
  observation: "none" | "matching-record" | "unverified-record";
  application: "not-checked";
  credentialValidity: "not-checked";
  integrationIdentity: "unverified";
  authority: "human-required";
  permission: "none";
  executed: false;
}

/** Static provider-owned candidate, BEFORE selecting or connecting a Vercel project.
 * This is a list of documented options, never proof of eligibility, an operation
 * plan or permission to authenticate. Keep it independent of project state. */
export interface OfficialNativeRouteOption {
  schemaVersion: 1;
  service: Service | null;
  environment: ConnectionEnvironment | null;
  status: "documented-candidate" | "unsupported";
  route: "provider-native" | null;
  destination: "vercel" | null;
  guideUrl: typeof GUIDES[Service] | null;
  nativeEnrollmentOptions: readonly { method: NativeEnrollmentMethod; guideUrl: string }[];
  requiredSettings: readonly Setting[];
  /** Resend only; the separate Marketplace path has its own Vercel-domain prerequisite. */
  marketplaceAlternative: {
    readonly guideUrl: typeof RESEND_VERCEL_MARKETPLACE_URL;
    readonly prerequisite: typeof RESEND_VERCEL_MARKETPLACE_PREREQUISITE;
    readonly humanDecision: "plan-billing-domain-authorization";
  } | null;
  selection: "not-checked";
  providerAccount: "not-checked";
  configuration: "not-checked";
  application: "not-checked";
  humanSelection: "required";
  permission: "none";
  executed: false;
}

/** Pure catalog lookup. An unknown service/environment never becomes a usable route. */
export function readOfficialNativeRouteOption(service: unknown, environment: unknown): OfficialNativeRouteOption {
  const supportedService: Service | null = service === "resend" || service === "clerk" ? service : null;
  const supportedEnvironment: ConnectionEnvironment | null = environment === "development" ||
    environment === "preview" || environment === "production" ? environment : null;
  return { schemaVersion: 1, service: supportedService, environment: supportedEnvironment,
    status: supportedService && supportedEnvironment ? "documented-candidate" : "unsupported",
    route: supportedService && supportedEnvironment ? "provider-native" : null,
    destination: supportedService && supportedEnvironment ? "vercel" : null,
    guideUrl: supportedService && supportedEnvironment ? GUIDES[supportedService] : null,
    nativeEnrollmentOptions: supportedService === "resend" && supportedEnvironment ? [
      { method: "resend-vercel-integration", guideUrl: GUIDES.resend },
      { method: "resend-vercel-marketplace", guideUrl: RESEND_VERCEL_MARKETPLACE_URL }
    ] : [],
    requiredSettings: supportedService && supportedEnvironment ? SETTINGS[supportedService] : [],
    marketplaceAlternative: supportedService === "resend" && supportedEnvironment
      ? { guideUrl: RESEND_VERCEL_MARKETPLACE_URL, prerequisite: RESEND_VERCEL_MARKETPLACE_PREREQUISITE, humanDecision: "plan-billing-domain-authorization" } : null,
    selection: "not-checked", providerAccount: "not-checked", configuration: "not-checked",
    application: "not-checked", humanSelection: "required", permission: "none", executed: false };
}

/** A short decision handoff; never a request to print, export or re-register a key. */
export function renderOfficialNativeRouteOption(option: OfficialNativeRouteOption): string {
  if (option.status !== "documented-candidate" || !option.service || !option.environment || !option.guideUrl) {
    return "このサービス・環境の公式Vercel連携候補は登録されていません。認証・接続・キー取得は行っていません。";
  }
  const name = option.service === "clerk" ? "Clerk" : "Resend";
  return [
    `${name} / Vercel / ${option.environment}: 公式連携の候補（未選択）`,
    `公式ガイド: ${option.guideUrl}`,
    ...option.nativeEnrollmentOptions.map(choice => `取得経路 ${choice.method}: ${choice.guideUrl}`),
    `確認する設定: ${option.requiredSettings.join(", ")}`,
    option.service === "clerk"
      ? "ClerkのVercel Marketplace連携は新しいリソース作成・プラン選択・権限変更を伴う場合があります。既存単独アプリの移行先とは限りません。"
      : "ResendのVercel連携はキー発行と環境変数設定をまとめられる場合があります。対象ドメインとVercelプロジェクトを公式画面で確認してください。",
    ...(option.service === "resend" && option.marketplaceAlternative ? [
      `Vercelで購入したドメインがある場合は、新しいResend Marketplace連携でアカウント作成・DNS設定・キー配置をまとめられる場合があります: ${option.marketplaceAlternative.guideUrl}`,
      "この別経路はプラン選択・請求・ドメイン認可を伴います。利用条件と既存設定を人間が確認してください。自動実行しません。"
    ] : []),
    "これは公式経路の候補を示すだけです。対象のアカウント・プロジェクト・環境、既存連携の有無は未確認です。",
    "人間が接続先と課金・権限を確認して経路を選ぶまで、ログイン・キー生成・接続・上書き・配置は実行しません。",
    "公式連携を選択・記録した後は connection native guide で実際の接続先を確認してください。キーをChatやAgentの端末に貼らないでください。"
  ].join("\n");
}

function emptyGuide(service: unknown, environment: unknown): NativeAcquisitionGuide {
  return {
    schemaVersion: 1, service: service === "resend" || service === "clerk" ? service : null,
    environment: environment === "development" || environment === "preview" || environment === "production" ? environment : null,
    destination: "vercel", state: "unknown", reason: "selection-unavailable", selection: null,
    nativeEnrollment: service === "resend" ? "not-selected" : null,
    nativeEnrollmentPrerequisite: null, nativeEnrollmentEligibility: null,
    guideUrl: null, requiredSettings: [], missingSettings: null, configuration: "unknown", observation: "none",
    application: "not-checked", credentialValidity: "not-checked", integrationIdentity: "unverified",
    authority: "human-required", permission: "none", executed: false
  };
}

/** Pure closed projection of the existing reader's validated, exact-bound evidence. */
export function projectNativeAcquisitionEvidence(evidence: NativeApplicationEvidence): Pick<NativeAcquisitionGuide,
  "state" | "reason" | "configuration" | "observation"> {
  const unknown = { state: "unknown", reason: "observation-unverified", configuration: "unknown",
    observation: "unverified-record" } as const;
  if (evidence.status === "missing" && evidence.reason === "inspection-missing" && !evidence.configuration) {
    return { state: "human-needed", reason: "not-inspected", configuration: "not-inspected", observation: "none" };
  }
  // The existing reader verifies time, journal integrity, intent and destination
  // before these reasons. In particular, never promote stale/changed receipts.
  if (evidence.binding !== "matches-local-selection" || evidence.status === "stale" ||
      !["application-missing", "application-reported", "inspection-unverified"].includes(evidence.reason)) return unknown;
  const configuration = evidence.configuration?.state;
  if (configuration === "integration-managed") {
    if (evidence.reason === "inspection-unverified") return unknown;
    return { state: "integration-managed", reason: "configuration-recorded", configuration, observation: "matching-record" };
  }
  if (configuration === "partial" || configuration === "absent" || configuration === "present-unmanaged") {
    return { state: configuration === "partial" ? "partial" : "human-needed", reason: "review-existing-configuration",
      configuration, observation: "matching-record" };
  }
  return unknown;
}

/** Local metadata only: no CLI resolution, network, browser, vault or writes. */
export function readNativeAcquisitionGuide(projectDir: string, service: Service, environment: ConnectionEnvironment,
  baseDir?: string): NativeAcquisitionGuide {
  const result = emptyGuide(service, environment);
  if (!result.service || !result.environment) return { ...result, state: "unsupported", reason: "selection-mismatch" };
  try {
    const canonical = realpathSync(projectDir), store = new ConnectionStateStore(canonical, baseDir);
    const readIntent = () => service === "clerk" ? store.readClerkNativeIntent() : store.readIntent();
    const selected = readIntent();
    if (selected.status === "missing") return { ...result, state: "unsupported", reason: "selection-missing" };
    if (selected.status !== "available") return result;
    if (selected.value.service !== service || selected.value.environment !== environment ||
        selected.value.route !== "provider-native" || selected.value.destination.kind !== "vercel") {
      return { ...result, state: "unsupported", reason: "selection-mismatch" };
    }
    const nativeEnrollment = service === "resend" ?
      ("nativeEnrollment" in selected.value ? selected.value.nativeEnrollment ?? "unrecorded" : "unrecorded") : null;
    const selection = readNativeDestinationSelection(canonical, environment);
    if (!selection) return result;
    const evidence = readNativeApplicationEvidence(canonical, service, baseDir);
    const after = readIntent(), destinationAfter = readNativeDestinationSelection(canonical, environment);
    if (realpathSync(projectDir) !== canonical || after.status !== "available" ||
        JSON.stringify(after.value) !== JSON.stringify(selected.value) ||
        destinationAfter?.fingerprint !== selection.fingerprint || evidence.service !== service ||
        evidence.environment !== environment || evidence.destinationSelectionFingerprint !== selection.fingerprint) {
      return { ...result, reason: "selection-changed" };
    }
    const projection = projectNativeAcquisitionEvidence(evidence);
    return { ...result, ...projection,
      selection: { localProjectId: deriveProjectId(canonical), orgId: selection.orgId, projectId: selection.projectId, fingerprint: selection.fingerprint },
      nativeEnrollment,
      nativeEnrollmentPrerequisite: nativeEnrollment === "resend-vercel-marketplace" ? RESEND_VERCEL_MARKETPLACE_PREREQUISITE : null,
      nativeEnrollmentEligibility: nativeEnrollment === "resend-vercel-marketplace" ? "unverified" : null,
      guideUrl: service === "clerk" ? GUIDES.clerk : nativeEnrollment === "resend-vercel-integration" ? GUIDES.resend :
        nativeEnrollment === "resend-vercel-marketplace" ? RESEND_VERCEL_MARKETPLACE_URL : null,
      requiredSettings: SETTINGS[service],
      missingSettings: projection.configuration === "absent" ? SETTINGS[service] :
        ["integration-managed", "present-unmanaged"].includes(projection.configuration) ? [] : null
    };
  } catch { return result; }
}

/** Render only this module's closed projection, never provider output or errors. */
export function renderNativeAcquisitionGuide(guide: NativeAcquisitionGuide): string {
  if (!guide.selection || !guide.service || !guide.environment) {
    return "保存済みの接続先とVercelプロジェクトを確認してください。対応するサービス・環境・配置先が一致した場合だけ公式連携を案内します。接続、ログイン、キーの登録は行っていません。";
  }
  const name = guide.service === "clerk" ? "Clerk" : "Resend";
  const lines = [
    `${name} / Vercel / ${guide.environment}`,
    `対象: ${guide.selection.orgId} / ${guide.selection.projectId}（このプロジェクト: ${guide.selection.localProjectId}）`,
    ...(guide.guideUrl ? [`公式ガイド: ${guide.guideUrl}`] : [
      "取得経路: 未記録。inspectionやhistoryから推定しません。",
      `候補: api-key-case connection native options --service resend --env ${guide.environment} --json`,
      `人間が選択した後に同じ接続を記録: connection set --service resend --env ${guide.environment} --route provider-native --destination vercel --native-enrollment <resend-vercel-integration|resend-vercel-marketplace> <project>`
    ]),
    `確認する設定: ${SETTINGS[guide.service].join(", ")}`
  ];
  if (guide.state === "integration-managed") lines.push("有効期間内の記録では、公式連携が設定を管理しています。キーの二重登録は不要です。");
  else if (guide.configuration === "absent") lines.push("記録では、選択した環境の設定がありません。既存設定を確認してから、公式ガイドを参照してください。");
  else if (guide.configuration === "partial") lines.push("記録では、一部の設定だけが存在します。個別の不足名はこの記録から判断できません。上記の設定を確認し、上書きや再接続を自動で行わないでください。");
  else if (guide.configuration === "present-unmanaged") lines.push("設定は記録されていますが、公式連携の管理下かは未確認です。再接続や上書きの前に既存設定を確認してください。");
  else if (guide.configuration === "not-inspected") lines.push("設定はまだ確認していません。既に連携済みなら、作り直す前に下記の確認コマンドを使ってください。");
  else lines.push("記録が古い、変更された、または安全に確認できない状態です。接続済みとは判断せず、対象と既存の記録を確認してください。");
  lines.push("公式画面で対象のチームと、この1プロジェクトを確認してください。全プロジェクトを選択しないでください。");
  if (guide.service === "clerk") {
    lines.push("Clerk連携はリソース作成・プラン選択・メンバー権限の同期を伴います。既存の単独Clerkアプリはこの連携へ移せません。料金や権限への同意は人間が行います。");
    lines.push(`公式の環境対応: ${guide.environment === "production" ? "production → Clerk production" : `${guide.environment} → Clerk development`}。設定は同じ連携の組である必要があります。`);
  } else if (guide.nativeEnrollment === "resend-vercel-marketplace") {
    lines.push("選択されたMarketplace経路はVercelで購入したドメインが必要です。対象ドメインの適格性は未確認です。アカウント作成、DNS設定、プラン・請求・ドメイン認可の条件を人間が確認してください。");
  } else if (guide.nativeEnrollment === "resend-vercel-integration") {
    lines.push("選択された既存Vercel連携はドメインに紐づくキーを作成して配置します。対象ドメインと実際の環境設定を公式画面で確認してください。");
  } else {
    lines.push("取得経路が未記録のため、どちらのResend公式経路を選んだかは不明です。再接続やキー作成をせず、選択履歴を人間に確認してください。");
  }
  lines.push("キーを表示・コピーしたり、vercel env pullでファイルへ取り出したりする必要はありません。");
  lines.push(`設定確認は別の明示操作です。同じプロジェクトで: api-key-case connection native inspect --service ${guide.service} --env ${guide.environment} --json`);
  lines.push("この案内はローカルの記録だけを読みます。確認には既存のVercel CLIセッションが必要です。自動ログイン・インストール・接続・権限変更は行いません。");
  lines.push("キーの有効性とアプリ機能は未確認です。保存した記録やこの案内は、実行・送信・本番操作の許可にはなりません。");
  return lines.join("\n");
}
