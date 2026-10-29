import { realpathSync } from "node:fs";
import { ConnectionStateStore, type ConnectionEnvironment } from "./connection-state.js";
import { clerkCredentialRef } from "./connection-credential.js";
import { clerkManagedIntentFingerprint } from "./clerk-managed.js";
import { DeploymentHistory, type HistoryIssue } from "../deploy/history.js";
import { resolveClerkWorkerDestination } from "../deploy/snapshot.js";
import type { Vault } from "../vault/types.js";
import {readClerkWorkerApplicationEvidence,type ClerkWorkerApplicationEvidence} from "./clerk-worker-observations.js";

export interface ClerkManagedReport {
  service: "clerk";
  route: "api-key-case-managed";
  destination: "cloudflare";
  status: "inactive" | "not-selected" | "selected" | "unavailable";
  issue: "metadata-unavailable" | "inspection-changed" | null;
  environment: ConnectionEnvironment | null;
  registration: { presence: "not-inspected" | "registered" | "missing" | "unavailable"; revision: "recorded" | "unverified" };
  configuration: { status: "not-inspected" | "explicit-local" | "unresolved"; worker: string | null; accountId: string | null };
  preparation: {
    status: "not-inspected" | "none-recorded" | "version-recorded" | "unknown" | "history-unavailable";
    versionId: string | null;
    registrationBasis: "unchanged-record" | "changed" | "unverified";
    issue: HistoryIssue | null;
    authority: "advisory-local-history";
    currentDestination: "unverified";
  };
  application: "not-checked";
  applicationObservation: ClerkWorkerApplicationEvidence;
  permission: "none";
  nextStep: "none" | "review-selection" | "review-metadata" | "review-configuration" | "review-credential" | "review-history" | "review-preparation" | "review-recorded-version" | "review-application-observation" | "review-recorded-failure";
  summary: string;
}

/** Additional projection only: no provider, availability probe, mutation or raw value. */
export async function readClerkManagedReport(projectDir: string, deps: {
  vault: Pick<Vault, "hasSecret">;
  baseDir?: string;
}): Promise<ClerkManagedReport> {
  const empty: Omit<ClerkManagedReport,"applicationObservation"> = {
    service: "clerk", route: "api-key-case-managed", destination: "cloudflare",
    status: "unavailable", issue: "metadata-unavailable", environment: null,
    registration: { presence: "not-inspected", revision: "unverified" },
    configuration: { status: "not-inspected", worker: null, accountId: null },
    preparation: { status: "not-inspected", versionId: null, registrationBasis: "unverified", issue: null,
      authority: "advisory-local-history", currentDestination: "unverified" },
    application: "not-checked", permission: "none", nextStep: "review-metadata",
    summary: "Clerk接続の保存記録を確認できません。記録を残して確認してください。",
  };
  const finish=(report:typeof empty):ClerkManagedReport=>{
    const applicationObservation=readClerkWorkerApplicationEvidence(projectDir,deps.baseDir);
    const result={...report,applicationObservation};
    if(report.status==="selected"&&(applicationObservation.selected?.environment!==report.environment||
      applicationObservation.selected.accountId!==report.configuration.accountId||applicationObservation.selected.worker!==report.configuration.worker||
      (report.preparation.status==="version-recorded"&&applicationObservation.preparation?.versionId!==report.preparation.versionId))) {
      return {...result,status:"unavailable",issue:"inspection-changed",nextStep:"review-history",
        summary:"確認中にClerk接続の条件が変わりました。記録した対象と現在の選択を確認してください。"};
    }
    if(report.status!=="selected"||report.preparation.status!=="version-recorded"||report.registration.presence!=="registered"||
      report.preparation.registrationBasis!=="unchanged-record"||report.configuration.status!=="explicit-local")return result;
    if(applicationObservation.status==="reported") {
      result.nextStep=applicationObservation.application?.outcome==="failed"?"review-recorded-failure":"review-recorded-version";
      result.summary=applicationObservation.application?.outcome==="failed"?
        "準備versionに結び付いた保護機能の失敗が記録されています。結果を確認してください。稼働versionと現在の正常性は未確認です。":
        "準備versionに結び付いた保護機能の観測が記録されています。稼働versionと現在の正常性は未確認です。";
    }else if(["application-missing","application-expired","application-reported"].includes(applicationObservation.reason)) {
      result.nextStep="review-application-observation";
      result.summary="準備versionの記録があります。保護機能の観測が未確認・期限切れ・不明です。既存アプリの結果を確認してください。稼働versionは未確認です。";
    }else {
      result.nextStep="review-history";
      result.summary="準備versionと機能観測の対応を確定できません。記録した対象と現在の選択を確認してください。再準備や有効化を自動で繰り返さないでください。";
    }
    return result;
  };
  try {
    const project = realpathSync(projectDir), store = new ConnectionStateStore(project, deps.baseDir);
    const selected = store.readClerkManagedIntent();
    if (selected.status === "missing") {
      const registered = store.hasClerkRegistrationRecord();
      return finish({ ...empty, status: registered ? "not-selected" : "inactive", issue: null,
        nextStep: registered ? "review-selection" : "none",
        summary: registered ? "Clerkの保存記録があります。利用する環境と配置先を確認してください。" : "ClerkのCloudflare接続は選択されていません。" });
    }
    if (selected.status !== "available") return finish(empty);
    const intent = selected.value, fingerprint = clerkManagedIntentFingerprint(intent);
    const ref = clerkCredentialRef(project, intent.environment), registration = store.readCredentialRegistration(ref);
    const revision = registration.status === "available" && registration.value.state === "settled" ? registration.value.revision : null;
    const destination = resolveClerkWorkerDestination(project, intent.environment);
    let presence: ClerkManagedReport["registration"]["presence"] = "unavailable";
    // Interrupted/unreadable registration is not evidence that the key is absent.
    if (registration.status !== "unavailable" && registration.value?.state !== "pending") {
      try { presence = await deps.vault.hasSecret(ref) ? "registered" : "missing"; } catch { /* closed status only */ }
    }
    const after = store.readClerkManagedIntent();
    if (realpathSync(projectDir) !== project || after.status !== "available" ||
        clerkManagedIntentFingerprint(after.value) !== fingerprint ||
        JSON.stringify(store.readCredentialRegistration(ref)) !== JSON.stringify(registration) ||
        JSON.stringify(resolveClerkWorkerDestination(project, intent.environment)) !== JSON.stringify(destination)) {
      return finish({ ...empty, issue: "inspection-changed", summary: "確認中にClerk接続の条件が変わりました。現在の選択を確認し直してください。" });
    }
    const history = new DeploymentHistory(project, deps.baseDir).read();
    // The existing journal is append-ordered (also used by history --offline),
    // not sorted by wall-clock timestamps. Never skip a newer unknown attempt.
    const latest = [...history.entries].reverse().find(entry => entry.preparation?.kind === "cloudflare-worker-version" &&
      entry.name === "CLERK_SECRET_KEY" && entry.scope === "project" && entry.target === "cloudflare" && entry.env === intent.environment &&
      entry.connection?.service === "clerk" && entry.connection.projectId === ref.projectId && entry.connection.environment === intent.environment);
    const preparation: ClerkManagedReport["preparation"] = { ...empty.preparation,
      status: history.status === "unavailable" ? "history-unavailable" : latest ?
        latest.outcome === "completed" && latest.finishedAt && latest.preparation?.versionId ? "version-recorded" : "unknown" : "none-recorded",
      issue: history.issue,
      versionId: latest?.outcome === "completed" && latest.finishedAt ? latest.preparation?.versionId ?? null : null,
      registrationBasis: latest && revision ? latest.connection?.credentialRevision === revision &&
        latest.connection?.intentFingerprint === fingerprint ? "unchanged-record" : "changed" : "unverified" };
    let nextStep: ClerkManagedReport["nextStep"];
    let summary: string;
    if (preparation.status === "history-unavailable" || preparation.status === "unknown") {
      nextStep = "review-history"; summary = "準備の結果を確定できません。再送せず、過去の記録を確認してください。";
    } else if (!destination) {
      nextStep = "review-configuration"; summary = "選択した環境のWorkerとaccount設定を確認してください。";
    } else if (presence !== "registered" || !revision || preparation.registrationBasis === "changed") {
      nextStep = "review-credential"; summary = presence === "missing" ?
        "選択した環境のキーは未登録です。保存記録と登録手順を確認してください。" :
        "現在の保存枠と準備記録の対応を確認してください。別環境へ切り替えないでください。";
    } else if (preparation.status === "version-recorded") {
      nextStep = "review-recorded-version"; summary = "過去のversion作成記録があります。現在の対象との対応とアプリ動作を確認してください。";
    } else {
      nextStep = "review-preparation"; summary = "キーの登録とローカル設定を確認できました。過去の操作を確認してから準備手順へ進んでください。";
    }
    return finish({ ...empty, status: "selected", issue: null, environment: intent.environment,
      registration: { presence, revision: revision ? "recorded" : "unverified" },
      configuration: { status: destination ? "explicit-local" : "unresolved", worker: destination?.name ?? null, accountId: destination?.accountId ?? null },
      preparation, nextStep, summary });
  } catch { return finish(empty); }
}
