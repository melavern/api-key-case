// Render-only native verification of the real metadata builders. No save,
// confirmation, keyring access, Secret, or execution occurs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emptyCatalog } from "../dist/core/vnext/model.js";
import { prepareBinding } from "../dist/core/vnext/binding.js";
import { prepareManagement } from "../dist/core/vnext/manage.js";
import { buildWindowsBindingScript, buildWindowsManagementScript } from "../dist/core/human/windows-binding.js";
import { encodeWindowsHelperCommand, WINDOWS_POWERSHELL_PATH } from "../dist/core/human/windows.js";
assert.equal(process.platform, "win32");
const output = resolve(process.argv[2]), monitor = Number(process.argv[3] ?? 0); assert.ok(Number.isInteger(monitor) && monitor >= 0 && monitor < 3); mkdirSync(output, { recursive: true });
const catalog = emptyCatalog(), id = randomUUID(), projectId = randomUUID(), environmentId = randomUUID(), bindingId = randomUUID(), time = new Date().toISOString();
catalog.credentials.push({ id, label: "合成・共有キー", locator: { kind: "v3", id, generationId: randomUUID() }, generation: 1, classification: "nonproduction", createdAt: time, revisedAt: time });
const context = path => ({ canonicalPath: path, directoryIdentity: { dev: "1", ino: path.endsWith("other-app") ? "2" : "3", birthtimeNs: "4" } });
catalog.projects.push({ id: projectId, ...context("C:/synthetic/other-app"), revision: 1 });
catalog.environments.push({ id: environmentId, projectId, label: "development", risk: "nonproduction", revision: 1 });
catalog.bindings.push({ id: bindingId, projectId, environmentId, variableName: "SYNTHETIC_API_KEY", credentialId: id, revision: 1 });
const io = { store: { readCatalog: () => ({ catalog, file: {} }) }, project: context, presence: async () => "present", legacy: async () => ({ status: "available", locators: [] }) };
const plan = await prepareBinding({ project: "C:/synthetic/ordinary-app", environment: "development", variable: "SYNTHETIC_API_KEY", risk: "nonproduction" }, io);
const management = prepareManagement({ action: "relink", bindingId, project: "C:/synthetic/moved-app" }, io);
const ps = s => "'" + s.replaceAll("'", "''") + "'";
for (const [kind, script] of [["binding", buildWindowsBindingScript(plan)], ["management", buildWindowsManagementScript(management)]]) {
  const image = join(output, `${kind}-monitor${monitor}.png`), report = join(output, `${kind}-monitor${monitor}.json`), hook = "[void]$form.ShowDialog()";
  assert.equal(script.split(hook).length, 2);
  const capture = `
Add-Type -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class AkcMetadataCapture {
 [StructLayout(LayoutKind.Sequential)] struct RECT {public int L,T,R,B;}
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr w,out RECT r);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr w,IntPtr dc,uint f);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr w);
 public static bool Save(IntPtr w,string path){RECT r;if(!GetWindowRect(w,out r))return false;using(var b=new Bitmap(r.R-r.L,r.B-r.T)){using(var g=Graphics.FromImage(b)){var dc=g.GetHdc();bool ok;try{ok=PrintWindow(w,dc,0);}finally{g.ReleaseHdc(dc);}if(!ok)return false;}b.Save(path,ImageFormat.Png);}return true;}
}
'@ -ReferencedAssemblies System.Drawing
$screen=[Windows.Forms.Screen]::AllScreens[${monitor}]; if($null -eq $screen){exit 30}
$form.StartPosition='Manual'; $form.Location=New-Object Drawing.Point(($screen.WorkingArea.Left+20),($screen.WorkingArea.Top+20))
$script:timer=New-Object Windows.Forms.Timer; $script:timer.Interval=900
$form.Add_Shown({${kind === "binding" ? "$script:selection.SelectedIndex=0" : ""}})
$script:timer.Add_Tick({$script:timer.Stop(); $r=@{capture=[AkcMetadataCapture]::Save($form.Handle,${ps(image)}); dpi=[AkcMetadataCapture]::GetDpiForWindow($form.Handle);
  confirmVisible=$confirm.Visible; cancelVisible=$cancel.Visible; detail=${kind === "binding" ? "$script:detail.Text" : "$detail.Text"};
  width=$form.Width; height=$form.Height; screenWidth=$screen.WorkingArea.Width; screenHeight=$screen.WorkingArea.Height; horizontalScroll=$body.HorizontalScroll.Visible}
  [IO.File]::WriteAllText(${ps(report)},($r|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false)); $form.Close()}); $script:timer.Start()
${hook}`;
  const child = spawnSync(WINDOWS_POWERSHELL_PATH, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encodeWindowsHelperCommand(script.replace(hook, capture))], { cwd: output, encoding: "utf8", windowsHide: false, timeout: 35_000 });
  assert.equal(child.status, 2, `${kind} closes without confirmation`);
  const r = JSON.parse(readFileSync(report, "utf8")); assert.ok(r.capture && r.confirmVisible && r.cancelVisible);
  assert.ok(r.width <= r.screenWidth && r.height <= r.screenHeight && !r.horizontalScroll);
  assert.match(r.detail, kind === "binding" ? /合成・共有キー[\s\S]*other-app/ : /other-app[\s\S]*moved-app/);
  console.log(`PASS ${kind} render, selection details, monitor ${monitor}, DPI ${r.dpi}`);
}
