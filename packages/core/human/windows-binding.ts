import { bindingRequestSchema, type BindingPlan } from "../vnext/binding.js";
import { catalogSchema, credentialSchema, locatorAccount, validate, VNextError } from "../vnext/model.js";
import { manageRequestSchema, type ManagePlan } from "../vnext/manage.js";

const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const riskText = { unknown: { ja: "未確認", en: "Unconfirmed" }, nonproduction: { ja: "開発・検証", en: "Development / testing" }, production: { ja: "本番", en: "Production" } };

export function buildWindowsManagementScript(plan: ManagePlan): string {
  const request = validate(manageRequestSchema, plan.request), before = validate(catalogSchema, plan.before), after = validate(catalogSchema, plan.after);
  const project = before.projects.find(p => p.id === plan.projectId), next = after.projects.find(p => p.id === plan.projectId);
  const binding = before.bindings.find(b => b.id === request.bindingId);
  if (!project || !next || !binding || binding.projectId !== project.id) throw new VNextError("invalid-data");
  const environment = before.environments.find(e => e.id === binding.environmentId)!;
  const title = { ja: request.action === "relink" ? "アプリの場所を関連付け直す" : request.action === "unlink" ? "関連付けを解除" : "環境の用途区分を修正",
    en: request.action === "relink" ? "Relink app" : request.action === "unlink" ? "Unlink a key" : "Change environment classification" };
  const details = (language: "ja" | "en") => [project.canonicalPath, ...(request.action === "relink" ? ["↓", next.canonicalPath, language === "ja" ? "このアプリの全ての関連付けへ影響します。" : "Affects all bindings in this project."] : []),
    `${environment.label} / ${riskText[environment.risk][language]}${request.action === "classify-environment" ? ` → ${riskText[request.risk][language]}` : ""}`,
    binding.variableName, before.credentials.find(c => c.id === binding.credentialId)!.label,
    request.action === "classify-environment" ? language === "ja" ? "この環境の全ての関連付けへ影響します。" : "Affects all bindings in this environment." : "",
    language === "ja" ? "キー本文の変更・削除、アプリ起動、クラウド配置は行いません。" : "No key change or deletion, app launch, or deployment.",
    language === "ja" ? "以前の利用計画・承認を引き継ぎません。実際の利用は別途確認が必要です。" : "Prior use plans and approvals are not inherited. Actual use needs separate confirmation."
  ].filter(Boolean).join("\r\n");
  return ["$ErrorActionPreference='Stop'", "try {", "Add-Type -AssemblyName System.Windows.Forms", "Add-Type -AssemblyName System.Drawing",
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AkcManagementDpi { [DllImport(\"user32.dll\")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context); }'",
    "[void][AkcManagementDpi]::SetThreadDpiAwarenessContext([IntPtr](-4)); [System.Windows.Forms.Application]::EnableVisualStyles()",
    "$ja=([Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName -eq 'ja') -or ([Globalization.CultureInfo]::CurrentCulture.TwoLetterISOLanguageName -eq 'ja')",
    "$script:resultCode=2; $form=New-Object System.Windows.Forms.Form; $script:form=$form; $form.Text='API Key Case - Manage Binding'",
    "$form.Font=New-Object System.Drawing.Font('Yu Gothic UI',10); $form.AutoScaleDimensions=New-Object System.Drawing.SizeF(96,96); $form.AutoScaleMode='Dpi'",
    "$form.ClientSize=New-Object System.Drawing.Size(680,580); $form.StartPosition='CenterScreen'; $form.FormBorderStyle='FixedDialog'; $form.MaximizeBox=$false; $form.MinimizeBox=$false",
    "$body=New-Object System.Windows.Forms.TableLayoutPanel; $body.Dock='Fill'; $body.ColumnCount=1; $body.RowCount=3; $body.Padding=New-Object System.Windows.Forms.Padding(20,12,20,0)",
    "[void]$body.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent',100))); [void]$body.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize'))); [void]$body.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Percent',100))); [void]$body.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('Absolute',64))); $form.Controls.Add($body)",
    `$title=New-Object System.Windows.Forms.Label; $title.Text=if($ja){${literal(title.ja)}}else{${literal(title.en)}}; $title.Font=New-Object System.Drawing.Font('Yu Gothic UI',16,[Drawing.FontStyle]::Bold); $title.Dock='Fill'; $title.AutoSize=$true; $title.Padding=New-Object System.Windows.Forms.Padding(0,4,0,12); $body.Controls.Add($title,0,0)`,
    `$detail=New-Object System.Windows.Forms.TextBox; $detail.Text=if($ja){${literal(details("ja"))}}else{${literal(details("en"))}}; $detail.Multiline=$true; $detail.ReadOnly=$true; $detail.ScrollBars='Vertical'; $detail.Dock='Fill'; $detail.TabStop=$false; $body.Controls.Add($detail,0,1)`,
    "$buttons=New-Object System.Windows.Forms.FlowLayoutPanel; $buttons.Dock='Bottom'; $buttons.Height=64; $buttons.FlowDirection='RightToLeft'; $buttons.Padding=New-Object System.Windows.Forms.Padding(16,10,16,10)",
    "$cancel=New-Object System.Windows.Forms.Button; $cancel.Text='キャンセル / Cancel'; $cancel.AutoSize=$true; $cancel.MinimumSize=New-Object System.Drawing.Size(120,36); $cancel.TabIndex=1; $cancel.add_Click({$script:form.Close()})",
    "$confirm=New-Object System.Windows.Forms.Button; $confirm.Text='変更を確定 / Confirm'; $confirm.AutoSize=$true; $confirm.MinimumSize=New-Object System.Drawing.Size(130,36); $confirm.TabIndex=0; $confirm.add_Click({$script:resultCode=0; $script:form.Close()})",
    "$buttons.Controls.Add($cancel); $buttons.Controls.Add($confirm); $body.Controls.Add($buttons,0,2); $form.CancelButton=$cancel",
    "[void]$form.ShowDialog(); $form.Dispose(); exit $script:resultCode", "} catch {exit 10}", "exit 10"].join("\n");
}
/** Metadata-only selection. No keyring call, external operation or execution permission. */
export function buildWindowsBindingScript(plan: BindingPlan): string {
  const request = validate(bindingRequestSchema, plan.request), catalog = validate(catalogSchema, plan.catalog);
  const candidates = plan.candidates.map(c => validate(credentialSchema, c));
  if (!candidates.length || candidates.length > 4096 || new Set(candidates.map(c => locatorAccount(c.locator))).size !== candidates.length) throw new VNextError("invalid-data");
  const project = catalog.projects.find(p => p.canonicalPath === plan.context.canonicalPath);
  const environment = catalog.environments.find(e => e.projectId === project?.id && e.label.toLowerCase() === request.environment.toLowerCase());
  const previous = catalog.bindings.find(b => b.id === plan.previousBindingId);
  const previousCredential = catalog.credentials.find(c => c.id === previous?.credentialId);
  const context = [plan.context.canonicalPath, `${request.environment} / ${riskText[environment?.risk ?? request.risk ?? "unknown"].ja} (${riskText[environment?.risk ?? request.risk ?? "unknown"].en})`, request.variable,
    previousCredential ? `Existing / 現在: ${previousCredential.label}` : "New association / 新しい関連付け"].join("\r\n");
  const details = candidates.map(c => [c.label, `${riskText[c.classification].ja} / ${riskText[c.classification].en}`, c.locator.kind === "v3" ? `Managed generation / 管理世代: ${c.generation}` :
    `Legacy (unversioned / 世代保証なし): ${locatorAccount(c.locator)}`,
    ...(plan.sources[locatorAccount(c.locator)] ? [plan.sources[locatorAccount(c.locator)]] : []),
    ...catalog.bindings.filter(b => b.credentialId === c.id).map(b => `${catalog.projects.find(p => p.id === b.projectId)!.canonicalPath} / ${catalog.environments.find(e => e.id === b.environmentId)!.label} / ${b.variableName}`)
  ].join("\r\n"));
  return ["$ErrorActionPreference='Stop'", "try {", "Add-Type -AssemblyName System.Windows.Forms", "Add-Type -AssemblyName System.Drawing",
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AkcBindingDpi { [DllImport(\"user32.dll\")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context); }'",
    "[void][AkcBindingDpi]::SetThreadDpiAwarenessContext([IntPtr](-4))", "[System.Windows.Forms.Application]::EnableVisualStyles()",
    "$ja=([Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName -eq 'ja') -or ([Globalization.CultureInfo]::CurrentCulture.TwoLetterISOLanguageName -eq 'ja')",
    "$script:resultCode=2", "$form=New-Object System.Windows.Forms.Form; $script:form=$form", "$form.Text='API Key Case - Confirm Binding'",
    "$form.Font=New-Object System.Drawing.Font('Yu Gothic UI',10)", "$form.AutoScaleDimensions=New-Object System.Drawing.SizeF(96,96); $form.AutoScaleMode='Dpi'",
    "$form.ClientSize=New-Object System.Drawing.Size(660,640); $form.StartPosition='CenterScreen'; $form.FormBorderStyle='FixedDialog'; $form.MaximizeBox=$false; $form.MinimizeBox=$false",
    "$body=New-Object System.Windows.Forms.TableLayoutPanel; $body.Dock='Fill'; $body.AutoScroll=$true; $body.ColumnCount=1; $body.RowCount=0; $body.Padding=New-Object System.Windows.Forms.Padding(22,18,22,8)",
    "[void]$body.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent',100))); $form.Controls.Add($body)",
    "function AddRow($c) { $r=$body.RowCount; $body.RowCount++; [void]$body.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize'))); $c.Dock='Fill'; $c.Margin=New-Object System.Windows.Forms.Padding(0,0,0,12); $body.Controls.Add($c,0,$r) }",
    "$title=New-Object System.Windows.Forms.Label; $title.AutoSize=$true; $title.Text=if($ja){'保存済みのキーを関連付け'}else{'Associate a saved key'}; $title.Font=New-Object System.Drawing.Font('Yu Gothic UI',16,[Drawing.FontStyle]::Bold); AddRow $title",
    `$context=New-Object System.Windows.Forms.TextBox; $context.Multiline=$true; $context.ReadOnly=$true; $context.Height=160; $context.ScrollBars='Vertical'; $context.TabStop=$false; $context.Text=${literal(context)}; AddRow $context`,
    "$explanation=New-Object System.Windows.Forms.Label; $explanation.AutoSize=$true; $explanation.MaximumSize=New-Object System.Drawing.Size(600,0); $explanation.Text=if($ja){'このアプリで使うキーを選んでください。値のコピー・入力・アプリの起動・クラウド配置は行いません。実際の利用は別途確認が必要です。'}else{'Choose the key intended for this app. No value is copied or entered, and no app or deployment runs. Actual use needs separate confirmation.'}; AddRow $explanation",
    "$selection=New-Object System.Windows.Forms.ComboBox; $script:selection=$selection; $selection.DropDownStyle='DropDownList'; $selection.DropDownWidth=600; $selection.AccessibleName='Saved key'; $selection.TabIndex=0",
    ...candidates.map(c => `[void]$selection.Items.Add(${literal(c.label)})`), "$selection.SelectedIndex=-1; AddRow $selection",
    `$script:details=[string[]]@(${details.map(literal).join(",")})`,
    "$detail=New-Object System.Windows.Forms.TextBox; $script:detail=$detail; $detail.Multiline=$true; $detail.ReadOnly=$true; $detail.Height=150; $detail.ScrollBars='Vertical'; $detail.TabStop=$false; AddRow $detail",
    "$selection.add_SelectedIndexChanged({ if($script:selection.SelectedIndex -ge 0){$script:detail.Text=$script:details[$script:selection.SelectedIndex]} })",
    "$buttons=New-Object System.Windows.Forms.FlowLayoutPanel; $buttons.Dock='Bottom'; $buttons.Height=64; $buttons.FlowDirection='RightToLeft'; $buttons.Padding=New-Object System.Windows.Forms.Padding(16,10,16,10)",
    "$cancel=New-Object System.Windows.Forms.Button; $cancel.Text=if($ja){'キャンセル'}else{'Cancel'}; $cancel.AutoSize=$true; $cancel.MinimumSize=New-Object System.Drawing.Size(100,36); $cancel.TabIndex=2; $cancel.add_Click({$script:form.Close()})",
    "$confirm=New-Object System.Windows.Forms.Button; $confirm.Text=if($ja){'関連付ける'}else{'Associate'}; $confirm.AutoSize=$true; $confirm.MinimumSize=New-Object System.Drawing.Size(120,36); $confirm.TabIndex=1",
    "$confirm.add_Click({if($script:selection.SelectedIndex -ge 0){$script:resultCode=100+$script:selection.SelectedIndex; $script:form.Close()}})",
    "$buttons.Controls.Add($cancel); $buttons.Controls.Add($confirm); $form.Controls.Add($buttons); $buttons.BringToFront(); $form.CancelButton=$cancel; $form.Add_Shown({$script:selection.Focus()})",
    "[void]$form.ShowDialog(); $form.Dispose(); exit $script:resultCode", "} catch {exit 10}", "exit 10"
  ].join("\n");
}
