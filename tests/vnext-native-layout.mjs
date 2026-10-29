// Synthetic render-only acceptance: the real builder, empty masked input,
// one capture timer and a close. Save validation runs only with empty input;
// a disposable synthetic string tests disclosure retention, never OS storage.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const usage = "node tests/vnext-native-layout.mjs [output-directory] [monitor-index] [--open]";
if (args.includes("--help")) { console.log(usage); process.exit(0); }
if (process.platform !== "win32") { console.log("SKIP vNext native layout: Windows required"); process.exit(0); }
const positional = args.filter(arg => arg !== "--open");
assert.ok(positional.length <= 2 && !positional.some(arg => arg.startsWith("--")), usage);
const openImages = args.includes("--open");
const [{ emptyCatalog }, { prepareRegistration }, { buildWindowsVNextSecretInputScript, encodeWindowsHelperCommand, WINDOWS_POWERSHELL_PATH }] =
  await Promise.all([import("../dist/core/vnext/model.js"), import("../dist/core/vnext/registration.js"), import("../dist/core/human/windows.js")])
    .catch(error => { throw new Error("ビルド済みモジュールを読み込めません。repository直下で npm.cmd run build を実行してください。", { cause: error }); });
const output = resolve(positional[0] ?? mkdtempSync(join(tmpdir(), "akc-vnext-layout-")));
mkdirSync(output, { recursive: true });
const monitorIndex = Number(positional[1] ?? 0);
assert.ok(Number.isInteger(monitorIndex) && monitorIndex >= 0 && monitorIndex <= 2, usage);
const images = [];
const ps = s => "'" + s.replaceAll("'", "''") + "'";
const capture = `Add-Type -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class AkcVNextCapture {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr w,out RECT r);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr w,IntPtr dc,uint flags);
 public static bool Save(IntPtr w,string path) { RECT r; if(!GetWindowRect(w,out r))return false;
 using(var b=new Bitmap(r.R-r.L,r.B-r.T)) { using(var g=Graphics.FromImage(b)){var dc=g.GetHdc(); bool ok; try{ok=PrintWindow(w,dc,0);}finally{g.ReleaseHdc(dc);}if(!ok)return false;}b.Save(path,ImageFormat.Png);}return true; }
}
'@ -ReferencedAssemblies System.Drawing`;
for (const kind of ["new", "rotation"]) for (const expanded of [false, true]) {
  const now = new Date().toISOString(), id = randomUUID(), catalog = emptyCatalog();
  const prior = { id, label: "合成テスト・共有キー", locator: { kind: "v3", id, generationId: randomUUID() }, generation: 1,
    classification: "nonproduction", createdAt: now, revisedAt: now };
  if (kind === "rotation") {
    catalog.credentials.push(prior);
    for (const [i, name] of ["アプリA", "アプリB"].entries()) {
      const projectId = randomUUID(), environmentId = randomUUID();
      catalog.projects.push({ id: projectId, canonicalPath: `C:/synthetic/${name}`, directoryIdentity: { dev: "1", ino: String(i + 1), birthtimeNs: "3" }, revision: 1 });
      catalog.environments.push({ id: environmentId, projectId, label: i ? "preview" : "development", risk: "nonproduction", revision: 1 });
      catalog.bindings.push({ id: randomUUID(), projectId, environmentId, variableName: "EXAMPLE_API_KEY", credentialId: id, revision: 1 });
    }
  }
  const candidate = kind === "new" ? prior : { ...prior, locator: { ...prior.locator, generationId: randomUUID() }, generation: 2 };
  const operation = prepareRegistration(catalog, candidate, randomUUID(), now);
  const script = buildWindowsVNextSecretInputScript({ catalog, operation }), hook = "$form.ShowDialog() | Out-Null";
  assert.equal(script.split(hook).length, 2);
  const stem = `${kind}${expanded ? "-details" : ""}-monitor${monitorIndex}`;
  const image = join(output, `${stem}.png`), report = join(output, `${stem}.json`);
  const instrument = `${capture}
    $screen=[System.Windows.Forms.Screen]::AllScreens[${monitorIndex}]; if($null -eq $screen){[Console]::Error.WriteLine('Requested monitor ${monitorIndex} is unavailable; retry with monitor 0.'); exit 30}
    $form.StartPosition='Manual'; $form.Location=New-Object System.Drawing.Point(($screen.WorkingArea.Left+20),($screen.WorkingArea.Top+20))
    $script:probeTimer=New-Object System.Windows.Forms.Timer; $script:probeTimer.Interval=900
    $script:probeTimer.Add_Tick({
      $script:probeTimer.Stop()
      $r=@{}
      try {
      $r.defaultClosed=-not $context.Visible; $r.collapsedHeight=$form.Height
      [void]$form.SelectNextControl($detailsToggle,$true,$true,$true,$true); $r.collapsedSaveReachable=$saveButton.Focused
      $script:input.Text='synthetic-preview-only'; $script:input.Select(3,4); [void]$script:input.Focus()
      $detailsToggle.PerformClick()
      $r.retainedInput=($script:input.Text -eq 'synthetic-preview-only'); $r.retainedSelection=($script:input.SelectionStart -eq 3 -and $script:input.SelectionLength -eq 4); $r.retainedFocus=$script:input.Focused
      [void]$form.SelectNextControl($script:input,$true,$true,$true,$true); $r.toggleReachable=$detailsToggle.Focused
      [void]$form.SelectNextControl($detailsToggle,$true,$true,$true,$true); $r.detailReachable=$context.Focused
      [void]$form.SelectNextControl($context,$true,$true,$true,$true); $r.saveReachable=$saveButton.Focused
      [void]$form.SelectNextControl($saveButton,$true,$true,$true,$true); $r.cancelReachable=$cancelButton.Focused
      $context.SelectionStart=$context.Text.Length; $context.ScrollToCaret(); $last=$context.GetPositionFromCharIndex($context.Text.Length-1); $r.detailsScrollable=($last.Y -ge 0 -and $last.Y -lt $context.ClientSize.Height)
      $context.SelectionStart=0; $context.ScrollToCaret()
      [void]$context.Focus(); $detailsToggle.PerformClick(); $r.collapseFocus=$detailsToggle.Focused
      $r.retainedAfterCollapse=($script:input.Text -eq 'synthetic-preview-only'); $r.collapsedAgain=($form.Height -eq $r.collapsedHeight)
      $script:input.Clear()
      ${expanded ? "$detailsToggle.PerformClick()" : ""}
      $saveButton.PerformClick(); $r.emptyError=($errorLabel.Visible -and $script:input.Focused -and $errorLabel.Top -ge $script:input.Bottom -and $errorLabel.Top-$script:input.Bottom -le 16)
      $errorText=$errorLabel.Text; $detailsToggle.PerformClick(); $detailsToggle.PerformClick(); $r.errorRetained=($errorLabel.Text -eq $errorText -and $errorLabel.Visible -and $script:input.Focused)
      $errorLabel.Text=''; [void]$script:input.Focus(); $form.Refresh()
      $r.capture=[AkcVNextCapture]::Save($form.Handle,${ps(image)}); $r.dpi=[ApiKeyCaseHumanPlane.Native]::GetDpiForWindow($form.Handle)
      $r += @{
        inputVisible=$script:input.Visible; password=$script:input.UseSystemPasswordChar; focused=$script:input.Focused; saveVisible=$saveButton.Visible; cancelVisible=$cancelButton.Visible;
        inputInside=($script:input.Bottom -le $body.ClientSize.Height -and $script:input.Top -ge 0); width=$form.Width; height=$form.Height;
        screenWidth=$screen.WorkingArea.Width; screenHeight=$screen.WorkingArea.Height; horizontalScroll=$body.HorizontalScroll.Visible; context=$context.Text; detailsVisible=$context.Visible;
        detailsInside=($context.Bottom -le $body.ClientSize.Height); saveEnabled=$saveButton.Enabled}
      $script:input.Text='synthetic-cancel-only'; $cancelButton.PerformClick(); $r.cancelCleared=($script:input.Text.Length -eq 0 -and $script:resultCode -eq 2)
      } catch { $r.probeError=$_.Exception.Message; $form.Close() }
      [IO.File]::WriteAllText(${ps(report)},($r|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    }); $script:probeTimer.Start()
    ${hook}`;
  const result = spawnSync(WINDOWS_POWERSHELL_PATH, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encodeWindowsHelperCommand(script.replace(hook, instrument))],
    { cwd: output, encoding: "utf8", timeout: 30_000, windowsHide: false });
  assert.equal(result.status, 2, `render-only close for ${kind}: ${result.error?.message ?? result.stderr?.trim() ?? ""} (exit ${result.status}, signal ${result.signal})`);
  assert.ok(existsSync(report), `撮影結果がありません: ${report}\n${result.stderr?.trim() ?? ""}`);
  const r = JSON.parse(readFileSync(report, "utf8"));
  assert.ok(!r.probeError, r.probeError);
  for (const field of ["defaultClosed", "retainedInput", "retainedSelection", "retainedFocus", "toggleReachable", "detailReachable", "saveReachable", "collapsedSaveReachable", "cancelReachable", "detailsScrollable", "collapseFocus", "retainedAfterCollapse", "collapsedAgain", "emptyError", "errorRetained", "cancelCleared", "saveEnabled"]) assert.ok(r[field], `${stem}: ${field}`);
  if (expanded) assert.ok(r.detailsInside, `${stem}: detailsInside`);
  assert.equal(r.detailsVisible, expanded);
  assert.ok(r.width < 642 && r.collapsedHeight < 596, "normal dialog is smaller than the previous layout");
  assert.ok(r.capture && r.inputVisible && r.password && r.focused && r.saveVisible && r.cancelVisible && r.inputInside);
  assert.ok(!r.horizontalScroll && r.width <= r.screenWidth && r.height <= r.screenHeight);
  assert.ok(existsSync(image));
  if (kind === "rotation") assert.match(r.context, /アプリA[\s\S]*アプリB/);
  console.log(`PASS ${kind} ${expanded ? "details" : "compact"}, monitor ${monitorIndex}, DPI ${r.dpi}, ${r.width}x${r.height}, image ${image}`);
  images.push(image);
}
if (openImages) {
  // Open only the completed PNGs, never keep the real Secret input dialog alive.
  const result = spawnSync(WINDOWS_POWERSHELL_PATH, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    encodeWindowsHelperCommand(`$ErrorActionPreference='Stop'; ${images.map(path => `Invoke-Item -LiteralPath ${ps(path)}`).join("; ")}`)],
    { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(result.status, 0, `PNGを開けません。エクスプローラーで ${output} を開いてください。\n${result.error?.message ?? result.stderr?.trim() ?? ""}`);
  console.log(`OPEN requested for ${images.length} PNGs in ${output}; native dialogs closed without saving.`);
}
