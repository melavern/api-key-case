import { realpathSync } from "node:fs";
import { deriveProjectId } from "../vault/naming.js";
import type { CredentialService, Vault } from "../vault/types.js";
import type { HumanPlane } from "../human/types.js";
import { ConnectionStateStore, type ConnectionEnvironment } from "./connection-state.js";
import { CREDENTIAL_SERVICES, credentialRefForService } from "./connection-credential.js";
import { buildCredentialAcquisitionPanel } from "../human/acquisition.js";
import { listCloudflareTargets, resolveCloudflareTarget } from "../deploy/cloudflare-targets.js";
import { CLOUDFLARE_TARGET_NATIVE_ACCEPTED } from "../deploy/provider-hosted.js";

type Presence = "registered" | "missing" | "unavailable";
export interface CredentialGuide {
  registeredCloudflare?: {
    destinationIds: readonly string[];
    sourceEnvironment: ConnectionEnvironment;
    nativeExecution: "pending-acceptance" | "accepted-windows-only";
    permission: "none";
  };
  schemaVersion: 1;
  projectId: string | null;
  service: CredentialService;
  environment: ConnectionEnvironment;
  providerMode: "test" | "not-applicable";
  status: "available" | "unavailable" | "unsupported";
  stage: "review-registration" | "review-existing-registration" | "review-selected-native-route" | "review-connection-selection" | "human-input-unavailable" | "acquire-and-save" | "stored";
  registration: {
    presence: Presence;
    metadata: "settled" | "pending" | "not-recorded" | "unavailable";
    revision: string | null;
    legacyProject: Presence;
    legacyUser: Presence;
    legacyUse: "none";
  };
  acquisition: ReturnType<typeof buildCredentialAcquisitionPanel>;
  input: "os-dialog" | "handoff-only";
  operationPlan: {
    operation: "credential-registration";
    consumer: "existing-resend-connection" | "existing-clerk-connection" | "provider-hosted-managed" | "unsupported";
    consumerAction: "inspect-selected-connection" | "review-standard-input-contract";
    secretTransfer: "none";
    resourceCreation: false;
    deployment: false;
    providerCheck: "not-run";
    applicationCheck: "not-run";
  };
  hostedConnection?: {
    status: "selected" | "not-selected" | "unavailable";
    environment: ConnectionEnvironment | null;
    destination: "vercel" | "cloudflare" | null;
    matchesRequestedEnvironment: boolean;
    nativeExecution: "pending-acceptance";
    providerCheck: "unsupported";
    applicationCheck: "unsupported";
    currentHealth: "unverified";
  };
  permission: "none";
  executed: false;
}

/** Read-only recovery from existing per-environment metadata and OS presence.
 * No value API, receipt write, provider probe, input dialog, child or execution. */
export async function readCredentialGuide(projectDir: string, service: CredentialService, environment: ConnectionEnvironment,
  deps: { vault: Pick<Vault, "hasSecret">; humanPlane: Pick<HumanPlane, "capability">; baseDir?: string }): Promise<CredentialGuide> {
  const report: CredentialGuide = { schemaVersion: 1, projectId: null, service, environment, providerMode: service === "stripe-test" ? "test" : "not-applicable", status: "unavailable",
    stage: "review-registration", registration: { presence: "unavailable", metadata: "unavailable", revision: null,
      legacyProject: "unavailable", legacyUser: "unavailable", legacyUse: "none" }, acquisition: null, input: "handoff-only",
    operationPlan: { operation: "credential-registration", consumer: service === "resend" ? "existing-resend-connection" :
      service === "clerk" ? "existing-clerk-connection" : "unsupported", consumerAction: service === "resend" || service === "clerk" ?
        "inspect-selected-connection" : "review-standard-input-contract", secretTransfer: "none", resourceCreation: false,
      deployment: false, providerCheck: "not-run", applicationCheck: "not-run" }, permission: "none", executed: false };
  try {
    if (!CREDENTIAL_SERVICES.includes(service) || (service === "stripe-test" && environment === "production")) {
      report.status = "unsupported"; return report;
    }
    const canonical = realpathSync(projectDir), ref = credentialRefForService(canonical, environment, service);
    const store = new ConnectionStateStore(canonical, deps.baseDir), before = store.readCredentialRegistration(ref);
    report.projectId = deriveProjectId(canonical);
    const hostedIntent = service === "openai" || service === "stripe-test" ? store.readProviderHostedIntent(service) : null;
    if (hostedIntent) {
      report.hostedConnection = {
        status: hostedIntent.status === "available" ? "selected" : hostedIntent.status === "missing" ? "not-selected" : "unavailable",
        environment: hostedIntent.status === "available" ? hostedIntent.value.environment : null,
        destination: hostedIntent.status === "available" ? hostedIntent.value.destination.kind : null,
        matchesRequestedEnvironment: hostedIntent.status === "available" && hostedIntent.value.environment === environment,
        nativeExecution: "pending-acceptance", providerCheck: "unsupported", applicationCheck: "unsupported", currentHealth: "unverified"
      };
      if (report.hostedConnection.matchesRequestedEnvironment) {
        report.operationPlan.consumer = "provider-hosted-managed";
        report.operationPlan.consumerAction = "inspect-selected-connection";
      }
      if (hostedIntent.status === "unavailable") { report.stage = "review-connection-selection"; return report; }
    }
    report.input = deps.humanPlane.capability() === "os-dialog" ? "os-dialog" : "handoff-only";
    report.registration.metadata = before.status === "available" ? before.value.state : before.status === "missing" ? "not-recorded" : "unavailable";
    if (before.status === "unavailable" || (before.status === "available" && before.value.state === "pending")) return report;
    const presence = async (source: Parameters<Vault["hasSecret"]>[0]): Promise<Presence> => {
      try { const found = await deps.vault.hasSecret(source); return found === true ? "registered" : found === false ? "missing" : "unavailable"; }
      catch { return "unavailable"; }
    };
    report.registration.presence = await presence(ref);
    report.registration.legacyProject = await presence({ name: ref.name, scope: "project", projectId: ref.projectId });
    report.registration.legacyUser = await presence({ name: ref.name, scope: "user", projectId: null });
    if (realpathSync(projectDir) !== canonical || deriveProjectId(canonical) !== ref.projectId ||
        JSON.stringify(store.readCredentialRegistration(ref)) !== JSON.stringify(before)) {
      report.registration = { presence: "unavailable", metadata: "unavailable", revision: null,
        legacyProject: "unavailable", legacyUser: "unavailable", legacyUse: "none" };
      if (report.hostedConnection) {
        report.hostedConnection = { ...report.hostedConnection, status: "unavailable", environment: null,
          destination: null, matchesRequestedEnvironment: false };
        report.operationPlan.consumer = "unsupported";
        report.operationPlan.consumerAction = "review-standard-input-contract";
      }
      return report;
    }
    // Selection is advisory, but an awaited registration probe must not leave
    // stale destination guidance behind. No provider or value access is added.
    if (hostedIntent && (service === "openai" || service === "stripe-test") &&
        JSON.stringify(store.readProviderHostedIntent(service)) !== JSON.stringify(hostedIntent)) {
      report.hostedConnection = { status: "unavailable", environment: null, destination: null,
        matchesRequestedEnvironment: false, nativeExecution: "pending-acceptance", providerCheck: "unsupported",
        applicationCheck: "unsupported", currentHealth: "unverified" };
      report.operationPlan.consumer = "unsupported";
      report.operationPlan.consumerAction = "review-standard-input-contract";
      report.stage = "review-connection-selection"; return report;
    }
    report.registration.revision = before.status === "available" ? before.value.revision : null;
    if (report.registration.presence === "unavailable") return report;
    if (report.registration.presence === "registered") {
      report.stage = before.status === "available" ? "stored" : "review-registration";
    } else if ([report.registration.legacyProject, report.registration.legacyUser].includes("registered")) {
      report.stage = "review-existing-registration";
    } else if ([report.registration.legacyProject, report.registration.legacyUser].includes("unavailable")) return report;
    else report.stage = report.input === "os-dialog" ? "acquire-and-save" : "human-input-unavailable";
    // Only the existing validated Resend intent may supply its display context.
    const intent = service === "resend" ? store.readIntent() : null;
    const acquisition = intent?.status === "available" && intent.value.environment === environment &&
      intent.value.route === "api-key-case-managed" && intent.value.destination.kind !== "manual" &&
      (intent.value.destination.kind !== "local" || environment === "development")
      ? { sendingDomain: intent.value.sendingDomain, destination: intent.value.destination.kind } : undefined;
    if (intent?.status === "available" && intent.value.environment === environment && intent.value.route === "provider-native") {
      report.stage = "review-selected-native-route";
    }
    if (service === "resend" && (report.stage === "acquire-and-save" || report.stage === "human-input-unavailable") && !acquisition) {
      report.stage = "review-connection-selection";
    }
    if (report.stage === "acquire-and-save" || report.stage === "human-input-unavailable") {
      report.acquisition = buildCredentialAcquisitionPanel({ ...ref, projectDir: canonical.replace(/\\/g, "/"),
        ...(acquisition ? { acquisition } : {}) });
    }
    report.status = "available";
    const selectedCloudflare = service === "resend" ? intent?.status === "available" && intent.value.environment === environment &&
      intent.value.route === "api-key-case-managed" && intent.value.destination.kind === "cloudflare"
      : report.hostedConnection?.matchesRequestedEnvironment && report.hostedConnection.destination === "cloudflare";
    if (service !== "clerk" && selectedCloudflare) {
      const catalog = listCloudflareTargets(canonical);
      const destinationIds = catalog.targets.filter(target => target.sourceEnvironment === environment && target.services.includes(service) &&
        resolveCloudflareTarget(canonical, target.id, service, environment)).map(target => target.id);
      if (destinationIds.length) report.registeredCloudflare = { destinationIds, sourceEnvironment: environment,
        nativeExecution: CLOUDFLARE_TARGET_NATIVE_ACCEPTED ? "accepted-windows-only" : "pending-acceptance", permission: "none" };
    }
    return report;
  } catch { return report; }
}

export function renderCredentialGuide(report: CredentialGuide): string {
  const lines = [`${report.service} / ${report.environment}: ${report.stage}`];
  if (report.stage === "stored") lines.push("登録済みです。キーを再作成・再入力せず、対応する接続手順の確認へ進めます。");
  else if (report.stage === "review-existing-registration") lines.push("別の保存枠に登録があります。再入力や自動コピーはせず、保存元と対象環境を確認してください。");
  else if (report.stage === "review-selected-native-route") lines.push("公式連携が選択されています。キーを二重登録せず、その連携の確認へ戻ってください。");
  else if (report.stage === "review-connection-selection") lines.push("対象環境と接続方法を先に確認してください。選択前にキーの取得・登録へ進まないでください。");
  else if (report.stage === "review-registration") lines.push("保存状態の確認が必要です。不明を未登録と扱わず、キーを作り直さないでください。");
  else if (report.stage === "human-input-unavailable") lines.push("このホストでは安全な入力画面を利用できません。Chat・引数・Agentの端末へキーを貼らないでください。");
  if (report.acquisition) {
    lines.push(report.acquisition.title.ja, report.acquisition.linkUrl, ...report.acquisition.steps.map(step => step.ja));
  }
  if (report.hostedConnection) {
    if (report.hostedConnection.status === "selected") lines.push(
      `保存済みの接続先: ${report.hostedConnection.destination} / ${report.hostedConnection.environment}（今回の環境${report.hostedConnection.matchesRequestedEnvironment ? "と一致" : "とは別"}）`);
    else lines.push(report.hostedConnection.status === "not-selected" ? "hosted配置先は未選択です。環境・配置先を確認してから接続を選択してください。" : "保存済みのhosted接続先を確認できません。選択を復元・変更する前に記録を確認してください。");
    lines.push("OpenAI / Stripe testの既定config／Vercel配置はnative受入待ちのため無効です。登録済みCloudflare配置先IDの経路は別の受入状態を確認してください。",
      "provider確認・アプリ動作確認は未対応です。登録や配置履歴から有効性・権限・接続成功を判断しないでください。");
  }
  if (report.registeredCloudflare) lines.push(
    `登録済みCloudflare配置先ID: ${report.registeredCloudflare.destinationIds.join(", ")} / 保存元 ${report.registeredCloudflare.sourceEnvironment} / native実行 ${report.registeredCloudflare.nativeExecution}`,
    "connection destinationsでaccount・Worker・config・配置環境を確認し、connection deploy --destination <ID>のoffline計画へ進めます。計画は許可ではなく、各実配置で本人承認が必要です。");
  lines.push(report.operationPlan.consumer === "unsupported" ?
    (report.hostedConnection ? "選択済みの対応hosted接続はありません。任意の受取側への受け渡し・接続確認は未実装です。保存だけを接続完了とせず、対象環境と対応経路を確認してください。" :
      "この保存枠に対応する受け渡し・接続確認は未実装です。保存だけを接続完了とせず、受取側の標準入力契約を確認してください。") :
    "選択済みの接続手順を別途確認してください。登録だけでは配置先や接続成功を確認できません。");
  lines.push("この案内は入力・配置・外部リソース作成・接続確認を実行せず、実行許可も与えません。");
  return lines.join("\n");
}
