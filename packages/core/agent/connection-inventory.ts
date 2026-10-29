import { realpathSync } from "node:fs";
import { deriveProjectId } from "../vault/naming.js";
import type { Vault, CredentialService, ConnectionCredentialRef } from "../vault/types.js";
import { DeploymentHistory } from "../deploy/history.js";
import { ConnectionStateStore, type ConnectionEnvironment, type ConnectionRoute, type ConnectionDestinationKind } from "./connection-state.js";
import { CREDENTIAL_SERVICES, credentialEnvironments, credentialRefForService } from "./connection-credential.js";

type Service = CredentialService;
export interface ConnectionInventoryRow {
  service: Service;
  environment: ConnectionEnvironment;
  credential: ConnectionCredentialRef["name"];
  scope: "project";
  presence: "registered" | "missing" | "unavailable";
  registration: "settled" | "pending" | "not-recorded" | "unavailable";
  revision: string | null;
  selection: {
    status: "selected" | "not-selected" | "unavailable";
    routes: Array<{ route: ConnectionRoute; destination: ConnectionDestinationKind }>;
  };
  history: {
    status: "available" | "not-recorded" | "unavailable";
    /** Latest-by-journal-order v2 receipt per fixed target; always historical. */
    placements: Array<{
      target: "cloudflare" | "vercel" | "github";
      outcome: "completed" | "incomplete" | "unknown";
      recordedAt: string;
      registrationRelation: "same-recorded-revision" | "different-recorded-revision" | "unverified";
      authority: "historical-local-receipt";
    }>;
  };
  nextStep: "review-metadata" | "review-selected-native-route" | "resume-selected-connection" |
    "review-recorded-environment" | "review-slot-state" | "review-consumer-contract";
}
export interface ConnectionInventory {
  schemaVersion: 2;
  projectId: string | null;
  status: "available" | "partial" | "unavailable";
  inspection: "local-only";
  slots: ConnectionInventoryRow[];
  currentHealth: "unverified";
  permission: "none";
  executed: false;
}
interface Dependencies {
  /** Exact known-slot boolean reads only; no list/get/isAvailable capability. */
  vault: Pick<Vault, "hasSecret">;
  /** Test-only seam. Neither CLI flags nor environment can select another metadata root. */
  baseDir?: string;
}

/** Fixed eleven project slots. No provider, child, writes, generic enumeration or value output. */
export async function readConnectionInventory(projectDir: string, deps: Dependencies): Promise<ConnectionInventory> {
  const report: ConnectionInventory = { schemaVersion: 2, projectId: null, status: "unavailable",
    inspection: "local-only", slots: [], currentHealth: "unverified", permission: "none", executed: false };
  try {
    const canonical = realpathSync(projectDir), projectId = deriveProjectId(canonical);
    const store = new ConnectionStateStore(canonical, deps.baseDir), history = new DeploymentHistory(canonical, deps.baseDir);
    const selection = (service: Service) => service === "resend" ? [store.readIntent()] :
      service === "clerk" ? [store.readClerkNativeIntent(), store.readClerkManagedIntent()] : [store.readProviderHostedIntent(service)];
    const initialHistory = history.read();
    const initialSelections = { resend: selection("resend"), clerk: selection("clerk"), openai: selection("openai"), "stripe-test": selection("stripe-test") };
    for (const service of CREDENTIAL_SERVICES) for (const environment of credentialEnvironments(service)) {
      const ref = credentialRefForService(canonical, environment, service);
      const before = store.readCredentialRegistration(ref);
      const row: ConnectionInventoryRow = {
        service, environment, credential: ref.name, scope: "project", presence: "unavailable",
        registration: before.status === "available" ? before.value.state : before.status === "missing" ? "not-recorded" : "unavailable",
        revision: before.status === "available" && before.value.state === "settled" ? before.value.revision : null,
        selection: { status: "not-selected", routes: [] },
        history: { status: initialHistory.status === "missing" ? "not-recorded" : initialHistory.status, placements: [] },
        nextStep: "review-metadata"
      };
      // Pending/locked/corrupt metadata must not masquerade as a missing key.
      if (before.status !== "unavailable" && !(before.status === "available" && before.value.state === "pending")) {
        try {
          const present = await deps.vault.hasSecret(ref);
          row.presence = present === true ? "registered" : present === false ? "missing" : "unavailable";
        } catch { /* closed unknown */ }
      }
      const after = store.readCredentialRegistration(ref);
      if (realpathSync(projectDir) !== canonical || JSON.stringify(before) !== JSON.stringify(after)) {
        row.registration = "unavailable"; row.revision = null; row.presence = "unavailable";
      }
      const choices = initialSelections[service];
      for (const choice of choices) {
        if (choice.status === "unavailable") row.selection.status = "unavailable";
        else if (choice.status === "available" && choice.value.environment === environment) {
          row.selection.routes.push({ route: choice.value.route, destination: choice.value.destination.kind });
        }
      }
      if (row.selection.status !== "unavailable" && row.selection.routes.length) row.selection.status = "selected";
      if (initialHistory.status === "available") {
        for (const target of ["cloudflare", "vercel", "github"] as const) {
          const receipt = [...initialHistory.entries].reverse().find(entry => entry.connection?.service === service &&
            entry.connection.projectId === projectId && entry.connection.environment === environment && entry.target === target);
          if (!receipt) continue;
          row.history.placements.push({ target, outcome: receipt.outcome, recordedAt: receipt.startedAt,
            registrationRelation: row.revision === null ? "unverified" : receipt.connection!.credentialRevision === row.revision ?
              "same-recorded-revision" : "different-recorded-revision", authority: "historical-local-receipt" });
        }
      }
      report.slots.push(row);
    }
    // Recheck after the last awaited presence read, not just each early row.
    // No prior row may retain a settled result if its metadata changed later.
    const changedHistory = JSON.stringify(history.read()) !== JSON.stringify(initialHistory);
    const changedSelections = { resend: JSON.stringify(selection("resend")) !== JSON.stringify(initialSelections.resend),
      clerk: JSON.stringify(selection("clerk")) !== JSON.stringify(initialSelections.clerk),
      openai: JSON.stringify(selection("openai")) !== JSON.stringify(initialSelections.openai),
      "stripe-test": JSON.stringify(selection("stripe-test")) !== JSON.stringify(initialSelections["stripe-test"]) };
    if (realpathSync(projectDir) !== canonical || deriveProjectId(canonical) !== projectId) return { ...report, slots: [] };
    for (const row of report.slots) {
      const ref = credentialRefForService(canonical, row.environment, row.service);
      const final = store.readCredentialRegistration(ref);
      const stable = row.registration === "settled" ? final.status === "available" && final.value.state === "settled" && final.value.revision === row.revision :
        row.registration === "not-recorded" ? final.status === "missing" :
          row.registration === "pending" ? final.status === "available" && final.value.state === "pending" : false;
      if (!stable) { row.registration = "unavailable"; row.revision = null; row.presence = "unavailable"; }
      if (changedSelections[row.service]) row.selection = { status: "unavailable", routes: [] };
      if (changedHistory) row.history = { status: "unavailable", placements: [] };
      if (row.revision === null) for (const receipt of row.history.placements) receipt.registrationRelation = "unverified";
      row.nextStep = row.registration === "pending" || row.registration === "unavailable" || row.selection.status === "unavailable" || row.history.status === "unavailable" ?
        "review-metadata" : row.selection.routes.some(route => route.route === "provider-native") ? "review-selected-native-route" :
          row.presence === "registered" ? row.registration !== "settled" ? "review-metadata" :
            row.selection.status === "selected" ? "resume-selected-connection" :
              row.service === "openai" || row.service === "stripe-test" ? "review-consumer-contract" : "review-recorded-environment" : "review-slot-state";
    }
    report.projectId = projectId;
    report.status = report.slots.some(row => row.presence === "unavailable" || row.selection.status === "unavailable" || row.history.status === "unavailable") ? "partial" : "available";
    return report;
  } catch { return { ...report, projectId: null, status: "unavailable", slots: [] }; }
}

export function renderConnectionInventory(report: ConnectionInventory): string {
  if (!report.projectId) return "このプロジェクトの接続記録を安全に確認できません。キーの未登録とは判断せず、対象と記録を確認してください。";
  const labels = { registered: "登録あり", missing: "この保存枠に登録なし", unavailable: "確認できません" };
  const registration = { settled: "保存記録あり", pending: "保存処理の確認が必要", "not-recorded": "保存記録なし", unavailable: "保存記録を確認できません" };
  const routes = { "provider-native": "公式連携", "api-key-case-managed": "API Key Case管理", manual: "手動" };
  const outcomes = { completed: "過去に完了", incomplete: "過去に未完了", unknown: "結果不明" };
  const lines = [`プロジェクト ${report.projectId} の既知11枠（Resend / Clerk / OpenAI / Stripe test）`,
    "現在の選択にない環境も確認します。選択変更・キー入力・配置は行いません。"];
  for (const row of report.slots) {
    lines.push(`${row.service} / ${row.environment}: ${labels[row.presence]} / ${registration[row.registration]}`);
    if (row.selection.routes.length) lines.push(`  現在の選択: ${row.selection.routes.map(route => `${routes[route.route]} → ${route.destination}`).join(", ")}`);
    if (row.selection.status === "unavailable") lines.push("  現在の選択は未確認です。");
    for (const receipt of row.history.placements) lines.push(`  過去の配置記録: ${receipt.target} / ${outcomes[receipt.outcome]} / ${receipt.recordedAt}（現在の状態は未確認）`);
    if (row.nextStep === "review-recorded-environment") lines.push("  既存登録が見つかりました。再入力せず、使う環境・配置先を確認してください。");
    else if (row.nextStep === "resume-selected-connection") {
      lines.push("  同じCLIの next --json --offline で、選択済み接続の続きと記録を確認できます。");
      if (row.service === "openai" || row.service === "stripe-test") lines.push("  hosted配置の実行はnative受入待ちのため無効です。選択・ローカル設定・offline計画だけ確認でき、アプリ動作は未確認です。");
    }
    else if (row.nextStep === "review-selected-native-route") lines.push("  公式連携の選択を確認してください。vaultへの二重登録は不要です。");
    else if (row.nextStep === "review-consumer-contract") lines.push("  登録済みです。再入力せず、同じCLIの connection credential guide で対応する受け渡し手順を確認してください。");
    else if (row.nextStep === "review-metadata") lines.push("  保存・選択・履歴の記録を確認してください。不明を理由にキーを作り直さないでください。");
  }
  lines.push("配置先・公式連携の全履歴を復元する一覧ではありません。未登録の枠があっても、キーが必要とは限りません。",
    "登録や過去の成功は、現在の接続成功・有効性・実行許可を証明しません。秘密値は返しません。");
  return lines.join("\n");
}
