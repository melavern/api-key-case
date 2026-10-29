import { buildWindowsMetadataReview } from "./windows-target.js";
import { catalogSchema, launchProfileSchema, validate } from "../vnext/model.js";
import type { LaunchPlan, ProfilePlan } from "../vnext/launch.js";

export function buildWindowsLaunchReview(plan: ProfilePlan | LaunchPlan, launch: boolean): string {
  validate(catalogSchema, plan.catalog); const profile = validate(launchProfileSchema, plan.profile);
  const bindings = profile.bindingIds.map(id => {
    const binding = plan.catalog.bindings.find(b => b.id === id)!, key = plan.catalog.credentials.find(c => c.id === binding.credentialId)!, env = plan.catalog.environments.find(e => e.id === binding.environmentId)!;
    return `${binding.variableName} ← ${key.label} (${env.label} / ${env.risk}; ${key.classification}; generation ${key.generation})`;
  });
  const script = profile.kind === "node-package-script" ? `\r\nScript: ${profile.packageManifestRevision.scriptDefinition}\r\nPackage manager: ${profile.packageManifestRevision.packageManagerIdentity.executable}\r\npackage.jsonのpre/post scriptと依存コードも起動対象です。` : "";
  return buildWindowsMetadataReview(launch ? "アプリへのキー受渡しを確認" : "アプリの起動設定を登録",
    `${plan.context.canonicalPath}\r\nアプリ・依存コード・子プロセスはキーを読めます。ソースの編集を許可します。\r\nApp, dependencies and children can read keys; source editing is allowed.`,
    [`${profile.kind}\r\nRuntime: ${profile.runtimeIdentity.executable}\r\nSHA256: ${profile.runtimeIdentity.fingerprint}\r\nEntry: ${profile.approvedEntryOrScript}\r\nWorking directory: ${profile.cwd}\r\nLimit: ${profile.maxDurationSeconds} seconds${script}\r\n${bindings.join("\r\n")}\r\n標準入出力は接続しません。別の起動には再び本人確認が必要です。\r\n同じOSユーザーやアプリ内部からの漏えいは防げません。`], launch, launch ? "launch" : "profile");
}
