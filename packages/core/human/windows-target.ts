import { buildWindowsUserVerificationScript } from "./windows.js";
import { targetRequestSchema, type TargetPlan } from "../vnext/target.js";
import { useRequestSchema, type UsePlan } from "../vnext/use.js";
import { catalogSchema, validate } from "../vnext/model.js";
import { cloudflareTargetPlan } from "../deploy/cloudflare-targets.js";

const literal = (text: string) => "'" + text.replaceAll("'", "''") + "'";
/** Closed metadata review; delivery additionally invokes the existing fail-closed OS verifier. */
export function buildWindowsMetadataReview(title: string, context: string, details: string[], delivery: boolean, local?: "profile" | "launch" | "hosted-target"): string {
  if (!details.length || details.length > 128) throw Error("Invalid review.");
  return ["$ErrorActionPreference='Stop'", "try {", "Add-Type -AssemblyName System.Windows.Forms", "Add-Type -AssemblyName System.Drawing",
    ...(delivery ? buildWindowsUserVerificationScript() : []),
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AkcTargetDpi { [DllImport(\"user32.dll\")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context); }'",
    "[void][AkcTargetDpi]::SetThreadDpiAwarenessContext([IntPtr](-4)); [System.Windows.Forms.Application]::EnableVisualStyles()",
    "$script:resultCode=2; $form=New-Object System.Windows.Forms.Form; $script:form=$form",
    `$form.Text='API Key Case - ${local === "profile" ? "Register Launch Profile" : local === "launch" ? "Launch Application" : local === "hosted-target" ? "Register Hosted Target" : delivery ? "Deploy Binding" : "Register Target"}'`,
    "$form.Font=New-Object System.Drawing.Font('Yu Gothic UI',10); $form.AutoScaleDimensions=New-Object System.Drawing.SizeF(96,96); $form.AutoScaleMode='Dpi'",
    "$form.ClientSize=New-Object System.Drawing.Size(700,630); $form.StartPosition='CenterScreen'; $form.FormBorderStyle='FixedDialog'; $form.MaximizeBox=$false; $form.MinimizeBox=$false",
    "$body=New-Object System.Windows.Forms.TableLayoutPanel; $body.Dock='Fill'; $body.ColumnCount=1; $body.RowCount=4; $body.Padding=New-Object System.Windows.Forms.Padding(20,16,20,8)",
    "[void]$body.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent',100))); [void]$body.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize'))); foreach($height in @(130,50)){[void]$body.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Absolute',$height)))}; [void]$body.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent',100))); $form.Controls.Add($body)",
    `$heading=New-Object System.Windows.Forms.Label; $heading.Text=${literal(title)}; $heading.Font=New-Object System.Drawing.Font('Yu Gothic UI',16,[Drawing.FontStyle]::Bold); $heading.AutoSize=$true; $heading.Dock='Fill'; $heading.Padding=New-Object System.Windows.Forms.Padding(0,0,0,16); $body.Controls.Add($heading,0,0)`,
    `$context=New-Object System.Windows.Forms.TextBox; $context.Text=${literal(context)}; $context.Multiline=$true; $context.ReadOnly=$true; $context.ScrollBars='Vertical'; $context.Dock='Fill'; $context.TabStop=$false; $body.Controls.Add($context,0,1)`,
    "$selection=New-Object System.Windows.Forms.ComboBox; $script:selection=$selection; $selection.DropDownStyle='DropDownList'; $selection.Dock='Fill'; $selection.Margin=New-Object System.Windows.Forms.Padding(0,10,0,8); $selection.TabIndex=0; $selection.AccessibleName='Destination'; $body.Controls.Add($selection,0,2)",
    ...details.map((detail, index) => `[void]$selection.Items.Add(${literal(`${index + 1}: ${detail.split("\r\n")[0]}`)})`),
    `$script:details=[string[]]@(${details.map(literal).join(",")})`,
    "$detail=New-Object System.Windows.Forms.TextBox; $script:detail=$detail; $detail.Multiline=$true; $detail.ReadOnly=$true; $detail.ScrollBars='Vertical'; $detail.Dock='Fill'; $detail.TabStop=$false; $body.Controls.Add($detail,0,3)",
    "$detail.Text=($script:details -join \"`r`n`r`n\")",
    "$selection.add_SelectedIndexChanged({if($script:selection.SelectedIndex -ge 0){$script:detail.Text=$script:details[$script:selection.SelectedIndex]}})",
    `$selection.SelectedIndex=${delivery || local ? "0; $selection.Enabled=$false" : "-1"}`,
    "$buttons=New-Object System.Windows.Forms.FlowLayoutPanel; $buttons.Dock='Bottom'; $buttons.Height=64; $buttons.FlowDirection='RightToLeft'; $buttons.Padding=New-Object System.Windows.Forms.Padding(16,10,16,10)",
    "$cancel=New-Object System.Windows.Forms.Button; $cancel.Text='キャンセル / Cancel'; $cancel.AutoSize=$true; $cancel.MinimumSize=New-Object System.Drawing.Size(130,36); $cancel.TabIndex=2; $cancel.add_Click({$script:form.Close()})",
    `$confirm=New-Object System.Windows.Forms.Button; $confirm.Text=${literal(local === "launch" ? "本人確認して起動 / Launch" : delivery ? "本人確認して配置 / Deploy" : "登録する / Register")}; $confirm.AutoSize=$true; $confirm.MinimumSize=New-Object System.Drawing.Size(150,36); $confirm.TabIndex=1`,
    "$confirm.add_Click({ if($script:selection.SelectedIndex -lt 0){return}; $confirm.Enabled=$false; $cancel.Enabled=$false; try {",
    delivery ? `$code=Invoke-ApiKeyCaseUserVerification $script:form.Handle '${local === "launch" ? "API Key Case: 表示したアプリの起動を承認 / Approve this application launch" : "API Key Case: 配置内容を確認して承認 / Approve the displayed deployment"}'; if($code -eq 0){$script:resultCode=0}else{if($code -eq 6){$script:resultCode=2}else{$script:resultCode=10}}` : "$script:resultCode=100+$script:selection.SelectedIndex",
    "} catch {$script:resultCode=10} finally {$script:form.Close()} })",
    "$buttons.Controls.Add($cancel); $buttons.Controls.Add($confirm); $form.Controls.Add($buttons); $buttons.BringToFront(); $form.CancelButton=$cancel; $form.AcceptButton=$cancel; $form.Add_Shown({$cancel.Focus()})",
    "[void]$form.ShowDialog(); $form.Dispose(); exit $script:resultCode", "} catch {exit 10}", "exit 10"].join("\n");
}
export function buildWindowsTargetScript(plan: TargetPlan): string {
  validate(targetRequestSchema, plan.request); validate(catalogSchema, plan.catalog);
  return buildWindowsMetadataReview("Cloudflareの配置先を登録", `${plan.context.canonicalPath}\r\n${plan.request.environment}\r\n登録だけではキーを配置しません。 / Registration does not deploy a key.`,
    plan.candidates.map(({ target }) => `${target.worker} (${target.wranglerEnvironment ?? "top-level"})\r\nAccount: ${target.accountId}\r\nConfig: ${target.config}\r\nSection: ${target.wranglerEnvironment ?? "top-level (no --env)"}`), false);
}
export function buildWindowsVNextUseScript(plan: UsePlan, cliPath: string): string {
  validate(useRequestSchema, plan.request); validate(catalogSchema, plan.catalog);
  if (typeof cliPath !== "string" || !/^[A-Za-z]:[\\/]/.test(cliPath) || /[\x00-\x1f]/.test(cliPath)) throw Error("Invalid CLI identity.");
  const environment = plan.catalog.environments.find(e => e.id === plan.binding.environmentId)!;
  return buildWindowsMetadataReview("内容を確認して配置", `${plan.context.canonicalPath}\r\nWorkerの新しいバージョンを作り、直ちに配備します。\r\nCreates a Worker version and deploys it immediately.`,
    [`Key: ${plan.credential.label}\r\nClassification: ${plan.credential.classification}\r\nSource: ${environment.label} / ${environment.risk}\r\nVariable: ${plan.binding.variableName}\r\nGeneration: ${plan.credential.generation} (${plan.credential.locator.kind})\r\nAccount: ${plan.target.accountId}\r\nWorker: ${plan.target.worker}\r\nConfig: ${plan.target.config}\r\nSection: ${plan.target.wranglerEnvironment ?? "top-level (no --env)"}\r\nCLI: ${cliPath}\r\n${cloudflareTargetPlan(plan.target, plan.binding.variableName).displayCommand}\r\n既存の同名キーを上書きする場合があります。 / May overwrite the existing key.`], true);
}
