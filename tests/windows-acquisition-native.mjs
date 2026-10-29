// Explicit Windows native acceptance. Generated production helper, fake data only.
// Instrumentation is confined to this test; no product test switch or value getter.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildWindowsSecretInputScript, encodeWindowsHelperCommand, WINDOWS_POWERSHELL_PATH } from "../dist/core/human/windows.js";
import { deriveProjectId } from "../dist/core/vault/naming.js";
import { createVault } from "../dist/core/vault/index.js";

if (process.platform !== "win32") { console.log("SKIP Windows acquisition native acceptance: not Windows"); process.exit(0); }
const output = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "akc-acquisition-native-")));
mkdirSync(output, { recursive: true });
const projectDir = join(output, "日本語プロジェクト");
mkdirSync(projectDir, { recursive: true });
const projectId = deriveProjectId(projectDir), vault = createVault();
const monitorIndex = Number(process.argv[3] ?? 0);
assert.ok(Number.isInteger(monitorIndex) && monitorIndex >= 0 && monitorIndex <= 2);
const ps = value => "'" + value.replaceAll("'", "''") + "'";
const captureType = [
  "Add-Type -TypeDefinition @'",
  "using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;",
  "public static class AkcGuideCapture {",
  " [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }",
  " [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr w, out RECT r);",
  " [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr w);",
  " [DllImport(\"user32.dll\")] public static extern bool IsWindowEnabled(IntPtr w);",
  " [DllImport(\"user32.dll\")] public static extern bool PrintWindow(IntPtr w, IntPtr dc, uint flags);",
  " public static bool Capture(IntPtr w, string path) { RECT r; if(!GetWindowRect(w,out r)) return false;",
  " using(var b=new Bitmap(r.R-r.L,r.B-r.T)) { using(var g=Graphics.FromImage(b)) { var dc=g.GetHdc(); bool ok; try { ok=PrintWindow(w,dc,0); } finally {g.ReleaseHdc(dc);} if(!ok)return false; } b.Save(path,ImageFormat.Png); } return true; }",
  "}",
  "'@ -ReferencedAssemblies System.Drawing"
].join("\n");
const reports = [];
const names = { resend: "RESEND_API_KEY", openai: "OPENAI_API_KEY", "stripe-test": "STRIPE_API_KEY", clerk: "CLERK_SECRET_KEY" };
const onlyService = process.argv[4] === "all" ? undefined : process.argv[4];
const expectedDpi = process.argv[5] === undefined ? undefined : Number(process.argv[5]);
assert.ok(expectedDpi === undefined || [96, 144].includes(expectedDpi));
// Normal native acceptance must not inspect, overwrite or erase the user clipboard.
// The optional real clipboard check belongs on an explicitly isolated test desktop.
const clipboardFlag = process.argv[6];
assert.ok(clipboardFlag === undefined || clipboardFlag === "--allow-clipboard", "Only --allow-clipboard is supported as the optional final argument.");
const allowClipboard = clipboardFlag === "--allow-clipboard";
if (allowClipboard) console.warn("Clipboard opt-in: existing clipboard content WILL be overwritten by synthetic metadata and cannot be restored. Run only on an isolated test desktop.");
assert.ok(onlyService === undefined || Object.hasOwn(names, onlyService));
const variants = [...Object.keys(names).filter(service => !onlyService || service === onlyService).map(service => ({ service, long: false })), ...(!onlyService ? [{ service: "resend", long: true }] : [])];
for (const variant of variants) {
  const { service, long } = variant;
  const caseName = service + (long ? "-long" : "");
  const caseProject = long ? join(projectDir, "長い日本語のプロジェクト名と保存先の折り返し確認".repeat(3)) : projectDir;
  mkdirSync(caseProject, { recursive: true });
  const caseId = deriveProjectId(caseProject);
  const domain = long ? ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".") : "mail.example.com";
  const request = { name: names[service], service, environment: "preview", scope: "project", projectId: caseId, projectDir: caseProject,
    ...(service === "resend" ? { acquisition: { sendingDomain: domain, destination: "vercel" } } : {}),
    ...(service === "openai" ? { purpose: "text-generation" } : {}) };
  assert.equal(await vault.hasSecret(request), false, "fixture slot must be new");
  try {
    for (const mode of long ? ["cancel"] : ["cancel", "save"]) {
      const resultPath = join(output, caseName + "-" + mode + ".json"), imagePath = join(output, caseName + "-" + mode + ".png");
      const instrument = [
        captureType,
        "$screen = [System.Windows.Forms.Screen]::AllScreens[" + monitorIndex + "]; $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual; $form.Location = New-Object System.Drawing.Point(($screen.WorkingArea.Left + 40), ($screen.WorkingArea.Top + 40))",
        "$script:testTimer = New-Object System.Windows.Forms.Timer; $script:testTimer.Interval = 500",
        "$script:testTimer.Add_Tick({",
        " $script:testTimer.Stop()",
        " $form.Activate(); $script:input.Focus() | Out-Null; [System.Windows.Forms.Application]::DoEvents()",
        " try {",
        "  $report = @{service=" + ps(service) + "; mode=" + ps(mode) + "; dpi=[ApiKeyCaseHumanPlane.Native]::GetDpiForWindow($form.Handle); screenName=[System.Windows.Forms.Screen]::FromControl($form).DeviceName; width=$form.Width; height=$form.Height; caseName=" + ps(caseName) + "; screenWidth=[System.Windows.Forms.Screen]::FromControl($form).WorkingArea.Width; screenHeight=[System.Windows.Forms.Screen]::FromControl($form).WorkingArea.Height}",
        "  function Write-AkcTestReport { param([string]$Stage) $report.stage=$Stage; [IO.File]::WriteAllText(" + ps(resultPath) + ", ($report | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false))) }",
        "  Write-AkcTestReport 'shown'",
        "  $report.graphicsDpi = $form.CreateGraphics().DpiX; $report.active = $form.ContainsFocus; $report.saveVisible = $saveButton.Visible; $report.saveEnabled = $saveButton.Enabled; $report.saveCanSelect = $saveButton.CanSelect; $report.formVisible = $form.Visible",
        "  $report.nativeInputVisible = [AkcGuideCapture]::IsWindowVisible($script:input.Handle); $report.nativeInputEnabled = [AkcGuideCapture]::IsWindowEnabled($script:input.Handle); $report.sameForm = $script:input.FindForm() -eq $form; $report.parentVisible = [AkcGuideCapture]::IsWindowVisible($footer.Handle); $report.nativeRootVisible = [AkcGuideCapture]::IsWindowVisible($root.Handle); $report.nativeFormVisible = [AkcGuideCapture]::IsWindowVisible($form.Handle)",
        "  $report.initialFocusTarget = $form.ActiveControl -eq $script:input; $report.focusBeforeCapture = $script:input.Focused; $report.canFocusBeforeCapture = $script:input.CanFocus",
        "  $report.capture = [AkcGuideCapture]::Capture($form.Handle, " + ps(imagePath) + ")",
        "  $report.footerVisible = $footer.Visible -and $footer.Top -ge 0 -and $footer.Bottom -le $root.ClientSize.Height",
        "  $report.inputVisible = $script:input.Visible; $report.inputEnabled = $script:input.Enabled; $report.inputHandleCreated = $script:input.IsHandleCreated; $report.inputIsDisposed = $script:input.IsDisposed; $report.activeBounds = $form.ActiveControl.Bounds.ToString(); $report.formBoundsNow = $form.Bounds.ToString(); $report.footerBounds = $footer.Bounds.ToString(); $report.rootBounds = $root.Bounds.ToString()",
        "  $report.inputBounds = $script:input.Bounds.ToString(); $report.inputCanFocus = $script:input.CanFocus; $report.inputParent = $script:input.Parent.GetType().Name; $report.focusType = if ($form.ActiveControl) { $form.ActiveControl.GetType().Name } else { 'none' }",
        "  $report.guideHeight = $guide.Height; $report.viewportHeight = $scroll.ClientSize.Height",
        "  $report.horizontalScroll = $scroll.HorizontalScroll.Visible",
        "  $report.initialInputFocus = $report.focusBeforeCapture; $report.password = $script:input.UseSystemPasswordChar",
        "  $script:testLabels = @(); $script:testCopies = @(); $script:testToggles = @()",
        "  function Collect-AkcControls { param($parent)",
        "    foreach ($control in $parent.Controls) {",
        "      if ($control -is [ApiKeyCaseHumanPlane.GuideLabel] -and $control.Visible) { $script:testLabels += @{ text=$control.Text; width=$control.Width; height=$control.Height; preferred=$control.GetPreferredSize($control.Size).Height; measured=[System.Windows.Forms.TextRenderer]::MeasureText($control.CreateGraphics(), $control.Text, $control.Font, (New-Object System.Drawing.Size($control.Width, [int]::MaxValue)), ([System.Windows.Forms.TextFormatFlags]::WordBreak -bor [System.Windows.Forms.TextFormatFlags]::TextBoxControl -bor [System.Windows.Forms.TextFormatFlags]::NoPrefix)).Height } }",
        "      if ($control -is [System.Windows.Forms.Button] -and $control.Tag -is [string]) { $script:testCopies += $control }",
        "      if ($control -is [System.Windows.Forms.Button] -and $control.Tag -is [System.Windows.Forms.TableLayoutPanel]) { $script:testToggles += $control }",
        "      Collect-AkcControls $control",
        "    }",
        "  }",
        "  Collect-AkcControls $form; $report.labels = @($script:testLabels)",
        "  $report.copies = @()",
        "  foreach ($button in $script:testCopies) {",
        "    $matched=$null; $feedback='not-exercised'",
        "    if (" + (allowClipboard ? "$true" : "$false") + ") {",
        "      $matched=$false; for ($attempt=0; $attempt -lt 3 -and -not $matched; $attempt++) { $button.PerformClick(); $matched=([System.Windows.Forms.Clipboard]::GetText() -eq $button.Tag) }",
        "      $feedback=$button.Text",
        "    }",
        "    $report.copies += @{name=$button.AccessibleName; matched=$matched; feedback=$feedback; exercised=" + (allowClipboard ? "$true" : "$false") + "}",
        "  }",
        "  Write-AkcTestReport 'copied'",
        "  $report.toggles = @()",
        "  $report.expandedLabels = @()",
        "  foreach ($button in @($script:testToggles)) { $button.PerformClick(); $expanded=$button.Tag.Visible; $script:testLabels=@(); Collect-AkcControls $form; $report.expandedLabels=@($script:testLabels); $scroll.AutoScrollPosition = New-Object System.Drawing.Point(0, $guide.Height); [System.Windows.Forms.Application]::DoEvents(); [void][AkcGuideCapture]::Capture($form.Handle, " + ps(join(output, caseName + "-" + mode + "-details.png")) + "); $report.expandedFooterVisible = $footer.Bottom -le $root.ClientSize.Height; $button.PerformClick(); $report.toggles += @{expanded=$expanded; collapsed=(-not $button.Tag.Visible)} }",
        "  $scroll.AutoScrollPosition = New-Object System.Drawing.Point(0, $guide.Height); [System.Windows.Forms.Application]::DoEvents(); $report.bottomCapture = [AkcGuideCapture]::Capture($form.Handle, " + ps(join(output, caseName + "-" + mode + "-bottom.png")) + ")",
        "  $scroll.AutoScrollPosition = New-Object System.Drawing.Point(0, 0); $form.Activate(); $script:input.Focus() | Out-Null; [void]$form.SelectNextControl($script:input, $true, $true, $true, $true); $report.tabToSave=$saveButton.Focused; [void]$form.SelectNextControl($saveButton, $true, $true, $true, $true); $report.tabToCancel=$cancelButton.Focused;",
        "  Write-AkcTestReport 'layout-checked'",
        "  $form.Activate(); $script:input.Focus() | Out-Null; $saveButton.PerformClick(); $report.errorText = $script:errorLabel.Text; $report.emptyRefused = $script:input.Focused -and $script:errorLabel.Text.Length -gt 0",
        "  Write-AkcTestReport 'empty-refused'",
        "  $report.errorFooterVisible = $footer.Bottom -le $root.ClientSize.Height",
        // Reads only a fixture provided by this test through stdin, never a real key.
        "  $fixture = [Console]::In.ReadLine(); $script:input.Text = $fixture",
        "  $report.inputLengthMatched = $script:input.TextLength -eq $fixture.Length; $fixture = $null",
        "  [IO.File]::WriteAllText(" + ps(resultPath) + ", ($report | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))",
        "  " + (mode === "save" ? "$saveButton.PerformClick()" : "$cancelButton.PerformClick()"),
        " } catch { $script:resultCode = 11; $script:form.Close() }",
        "})",
        "$form.Add_Shown({ $script:testTimer.Start() })"
      ].join("\n");
      const script = buildWindowsSecretInputScript(request).replace("$form.ShowDialog() | Out-Null", instrument + "\n$form.ShowDialog() | Out-Null");
      const fixture = service === "stripe-test" ? "sk_test_synthetic_native_fixture_only" : "akc-synthetic-native-fixture-only";
      const outcome = await new Promise(resolveResult => {
        const child = spawn(WINDOWS_POWERSHELL_PATH, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encodeWindowsHelperCommand(script)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
        child.stdin.end(fixture + "\n");
        const timeout = setTimeout(() => child.kill(), 60000);
        child.once("exit", code => { clearTimeout(timeout); resolveResult({ code, stdout, stderr }); });
      });
      assert.equal(outcome.code, mode === "save" ? 0 : 2, outcome.stderr);
      assert.equal(outcome.stdout, ""); assert.ok(outcome.stderr === "" || outcome.stderr === "#< CLIXML\r\n");
      const report = JSON.parse(readFileSync(resultPath, "utf8"));
      if (expectedDpi !== undefined) assert.equal(report.dpi, expectedDpi, "actual window DPI must match the requested display-scale case");
      assert.ok(report.tabToSave && report.tabToCancel, "keyboard tab order");
      assert.ok(report.bottomCapture);
      if (report.toggles.length) assert.ok(report.expandedFooterVisible);
      assert.ok(report.capture && report.footerVisible && report.errorFooterVisible && report.initialFocusTarget && report.password && report.emptyRefused && report.inputLengthMatched);
      assert.ok(!report.horizontalScroll);
      assert.ok(report.height <= report.screenHeight && report.width <= report.screenWidth);
      assert.ok(report.copies.length >= 1, "copy controls must be present");
      if (allowClipboard) {
        assert.ok(report.copies.every(copy => copy.exercised && copy.matched), "opt-in clipboard copy must match the expected metadata");
      } else {
        assert.ok(report.copies.every(copy => !copy.exercised && copy.matched === null), "default native acceptance must not exercise the OS clipboard");
      }
      assert.ok(report.toggles.every(toggle => toggle.expanded && toggle.collapsed));
      assert.ok([...report.labels, ...report.expandedLabels].every(label => label.height >= Math.max(label.preferred, label.measured)), "a label is vertically clipped at actual paint DPI");
      assert.equal(await vault.hasSecret(request), mode === "save");
      reports.push({ caseName, service, mode, dpi: report.dpi, width: report.width, height: report.height, scrolling: report.guideHeight > report.viewportHeight, clipboard: allowClipboard ? "explicit-opt-in" : "not-exercised" });
      console.log("PASS native guide (clipboard " + (allowClipboard ? "opt-in verified" : "not exercised") + "): " + caseName + " " + mode + " @ " + report.dpi + "dpi");
    }
  } finally {
    if (await vault.hasSecret(request)) await vault.deleteSecret(request);
    assert.equal(await vault.hasSecret(request), false);
  }
}
console.log(JSON.stringify({ reports, evidence: output }));
