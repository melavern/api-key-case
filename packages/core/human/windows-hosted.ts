import { buildWindowsMetadataReview } from "./windows-target.js";
import { hostedTargetRequestSchema, type HostedTargetPlan } from "../vnext/hosted-target.js";
import type { HostedUsePlan } from "../vnext/hosted-use.js";
import { catalogSchema, destinationSchema, validate } from "../vnext/model.js";
import { hostedDeploymentPlan } from "../deploy/hosted-targets.js";

export function buildWindowsHostedTargetScript(plan: HostedTargetPlan): string {
  validate(hostedTargetRequestSchema, plan.request); validate(catalogSchema, plan.catalog);
  return buildWindowsMetadataReview("配置先を登録", `${plan.context.canonicalPath}\r\n登録だけではキーを配置しません。 / Registration does not send a key.`,
    [`${plan.request.kind}\r\nAccount: ${plan.selection.account}\r\nResource: ${plan.selection.resource}\r\nTarget environment: ${plan.request.environment}\r\n${plan.request.kind === "vercel" ? "Vercelのteam/projectを固定します。" : "github.comのActions用Secretに限定します。ワークフローはキーを読めます。"}`], false, "hosted-target");
}
export function buildWindowsHostedUseScript(plan: HostedUsePlan, cliPath: string): string {
  validate(catalogSchema, plan.catalog); validate(destinationSchema, plan.destination);
  if (typeof cliPath !== "string" || !/^[A-Za-z]:[\\/]/.test(cliPath) || /[\x00-\x1f]/.test(cliPath)) throw Error("CLI unavailable.");
  const source = plan.catalog.environments.find(e => e.id === plan.binding.environmentId)!, vercel = plan.destination.kind === "vercel";
  return buildWindowsMetadataReview("内容を確認して配置", `${plan.context.canonicalPath}\r\n${vercel ? "Vercelへ変数を登録します。既存のアプリdeploymentは更新しません。" : "GitHub Actions用Secretを設定します。ワークフローはキーを読めます。"}`,
    [`${plan.destination.kind}\r\nKey: ${plan.credential.label}\r\nClassification: ${plan.credential.classification}\r\nSource: ${source.label} / ${source.risk}\r\nVariable: ${plan.binding.variableName}\r\nGeneration: ${plan.credential.generation} (${plan.credential.locator.kind})\r\nAccount: ${plan.destination.providerAccountId}\r\nResource: ${plan.destination.resourceId}\r\nTarget environment: ${plan.destination.applicationEnvironment}\r\nProvider identity: ${plan.providerIdentity ?? "unavailable"}\r\nCLI: ${cliPath}\r\n${hostedDeploymentPlan(plan.destination, plan.binding.variableName).displayCommand}\r\n既存の同名キーを上書きする場合があります。 / May overwrite the existing key.\r\n${vercel ? `SensitiveなSecretとして登録します。${plan.destination.applicationEnvironment === "preview" ? "全Preview branchが対象です。" : ""}` : "対象はActionsのみです。Agents/Codespaces/Dependabot用には設定しません。"}`], true);
}
