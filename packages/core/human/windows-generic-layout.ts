import type { Credential } from "../vnext/model.js";

const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";

/** Display metadata only. The existing native input body owns the value. */
export function buildGenericInputLayout(credential: Credential,
  impacts: { projectPath: string; environment: string; risk: Credential["classification"]; variable: string }[], previous?: Credential): string[] {
  const risk = { unknown: { en: "Unconfirmed", ja: "未確認" }, nonproduction: { en: "Development / testing", ja: "開発・検証" }, production: { en: "Production", ja: "本番" } };
  const details = (language: "en" | "ja") => [credential.label,
    `${language === "ja" ? "用途区分" : "Use"}: ${risk[credential.classification][language]}`,
    previous ? `${language === "ja" ? "差し替える既存のキー" : "Existing key being replaced"}: ${previous.label} (${risk[previous.classification][language]})` : (language === "ja" ? "新しいキーを登録" : "Register a new key"),
    language === "ja" ? "影響するアプリ・環境:" : "Affected applications / environments:",
    ...(impacts.length ? impacts.map(i => `${i.projectPath} / ${i.environment} (${risk[i.risk][language]}) / ${i.variable}`) : [language === "ja" ? "関連付けはありません" : "No associations"])].join("\r\n");
  return [
    "$form = New-Object System.Windows.Forms.Form", "$script:form = $form",
    "$form.Text = 'API Key Case - Secret Input'",
    "$form.Font = New-Object System.Drawing.Font('Yu Gothic UI', 10)",
    "$form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96,96)",
    "$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi",
    "$form.StartPosition = 'CenterScreen'", "$form.FormBorderStyle = 'FixedDialog'",
    "$form.MaximizeBox = $false", "$form.MinimizeBox = $false", "$form.ShowInTaskbar = $true",
    "$form.ClientSize = New-Object System.Drawing.Size(480,240)",
    "$body = New-Object System.Windows.Forms.TableLayoutPanel",
    "$body.ColumnCount = 1; $body.RowCount = 0; $body.Dock = 'Fill'; $body.AutoScroll = $true",
    "$body.Padding = New-Object System.Windows.Forms.Padding(20,16,20,0); $body.TabIndex=0",
    "[void]$body.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent',100)))",
    "$form.Controls.Add($body)",
    "function Add-AkcGenericRow($c) { $row=$body.RowCount; $body.RowCount++; [void]$body.RowStyles.Add((New-Object System.Windows.Forms.RowStyle('AutoSize'))); $c.Dock='Fill'; $c.Margin=New-Object System.Windows.Forms.Padding(0,0,0,8); $body.Controls.Add($c,0,$row) }",
    "$keyName = New-Object System.Windows.Forms.Label; $keyName.AutoSize=$true; $keyName.UseMnemonic=$false; $keyName.MaximumSize=New-Object System.Drawing.Size(440,0)",
    `$keyName.Text = ${literal(credential.label)}`,
    "$keyName.Font = New-Object System.Drawing.Font('Yu Gothic UI',12,[System.Drawing.FontStyle]::Bold); Add-AkcGenericRow $keyName",
    ...(previous ? [
      "$replacement = New-Object System.Windows.Forms.Label; $replacement.AutoSize=$true; $replacement.UseMnemonic=$false; $replacement.MaximumSize=New-Object System.Drawing.Size(440,0)",
      `$replacement.Text=(Get-AkcText ${literal(`Replacing: ${previous.label}\r\nAffected associations: ${impacts.length}`)} ${literal(`入れ替え対象: ${previous.label}\r\n影響先: ${impacts.length}件`)}); Add-AkcGenericRow $replacement`
    ] : []),
    "$input = New-Object System.Windows.Forms.TextBox; $script:input=$input",
    "$input.UseSystemPasswordChar=$true; $input.MaxLength=0; $input.AccessibleName='Secret value'; $input.TabIndex=0",
    "Add-AkcGenericRow $input",
    "$errorLabel = New-Object System.Windows.Forms.Label; $script:errorLabel=$errorLabel",
    "$errorLabel.AutoSize=$true; $errorLabel.MaximumSize=New-Object System.Drawing.Size(440,0); $errorLabel.ForeColor=[System.Drawing.Color]::Firebrick; $errorLabel.Visible=$false",
    "Add-AkcGenericRow $errorLabel",
    "$detailsToggle=New-Object System.Windows.Forms.Button; $detailsToggle.AutoSize=$true; $detailsToggle.AutoSizeMode='GrowAndShrink'; $detailsToggle.Text=(Get-AkcText '> Details' '▸ 詳細'); $detailsToggle.TabIndex=1; $detailsToggle.AccessibleName=(Get-AkcText 'Details' '詳細')",
    "Add-AkcGenericRow $detailsToggle; $detailsToggle.Dock='None'; $detailsToggle.Anchor='Top,Left'; $detailsToggle.FlatStyle='Flat'; $detailsToggle.FlatAppearance.BorderSize=0",
    "$context = New-Object System.Windows.Forms.TextBox; $context.Multiline=$true; $context.ReadOnly=$true; $context.Visible=$false; $context.TabIndex=2",
    "$context.Height=220; $context.ScrollBars='Vertical'; $context.AccessibleName=(Get-AkcText 'Registration details' '登録の詳細')",
    `$context.Text = (Get-AkcText ${literal(details("en"))} ${literal(details("ja"))}) + "\r\n\r\n" + (Get-AkcText ${literal("Storage: Windows Credential Manager\r\nYour Agent receives status only.\r\nRegistration does not run or deploy an app.")} ${literal("保存先: Windows 資格情報マネージャー\r\nAgentには状態だけを返します。\r\n登録だけではアプリの起動・配置は行いません。")})`,
    "Add-AkcGenericRow $context",
    "$buttons = New-Object System.Windows.Forms.FlowLayoutPanel; $buttons.Dock='Bottom'; $buttons.Height=60; $buttons.FlowDirection='RightToLeft'; $buttons.TabIndex=1",
    "$buttons.Padding=New-Object System.Windows.Forms.Padding(16,8,16,8)",
    "$cancelButton=New-Object System.Windows.Forms.Button; $cancelButton.Text=(Get-AkcText 'Cancel' 'キャンセル'); $cancelButton.AutoSize=$true; $cancelButton.MinimumSize=New-Object System.Drawing.Size(100,36); $cancelButton.TabIndex=1",
    "$saveButton=New-Object System.Windows.Forms.Button; $saveButton.Text=(Get-AkcText 'Save' '保存'); $saveButton.AutoSize=$true; $saveButton.MinimumSize=New-Object System.Drawing.Size(100,36); $saveButton.TabIndex=0",
    "$buttons.Controls.Add($cancelButton); $buttons.Controls.Add($saveButton); $form.Controls.Add($buttons); $buttons.BringToFront()",
    "function Resize-AkcGenericInput { $body.PerformLayout(); $area=[System.Windows.Forms.Screen]::FromControl($form).WorkingArea; $chrome=$form.Height-$form.ClientSize.Height; $h=[Math]::Min($body.GetPreferredSize((New-Object System.Drawing.Size($form.ClientSize.Width,0))).Height+$buttons.Height,$area.Height-$chrome-32); $form.ClientSize=New-Object System.Drawing.Size($form.ClientSize.Width,$h); if($form.Bottom -gt $area.Bottom){$form.Top=[Math]::Max($area.Top,$area.Bottom-$form.Height)} }",
    "$detailsToggle.Add_Click({ $inputFocus=$script:input.Focused; $detailFocus=$context.Focused; $context.Visible=-not $context.Visible; $detailsToggle.Text=if($context.Visible){Get-AkcText 'v Details' '▾ 詳細'}else{Get-AkcText '> Details' '▸ 詳細'}; Resize-AkcGenericInput; if($inputFocus){[void]$script:input.Focus()}elseif($detailFocus){[void]$detailsToggle.Focus()} })",
    "$errorLabel.Add_TextChanged({ $errorLabel.Visible=-not [String]::IsNullOrEmpty($errorLabel.Text); Resize-AkcGenericInput })",
    "$form.Add_Shown({ Resize-AkcGenericInput })"
  ];
}
