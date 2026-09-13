import assert from "node:assert/strict";

// Test infrastructure only. No product code imports this module.
const STAGES = new Set([
  "starting", "non-admin", "locating-window", "window-found", "pid-mismatch",
  "window-bound", "root-request", "root-received", "visit", "match",
  "children-request", "children-received", "action-start", "action-returned",
  "control-ready", "control-clicked"
]);

export const VERIFICATION_MODES = new Set(["probe", "verified", "cancel", "unconfigured", "attack"]);

export async function runVerificationMode(mode, { probe, ...scenarios }) {
  assert.ok(VERIFICATION_MODES.has(mode), "unknown Windows verification mode");
  // Never mistake an inoperative driver for a successful defense.
  if (["probe", "attack", "unconfigured"].includes(mode)) await probe();
  if (mode !== "probe") await scenarios[mode]();
}

export function observeProcess(child, { label, timeoutMs, activeChildren }) {
  activeChildren.add(child);
  // Attach listeners immediately, before any asynchronous companion starts.
  // Results contain bounded, closed diagnostics rather than raw PowerShell output.
  const stages = [];
  let partial = "";
  let done = false;
  return new Promise((resolvePromise) => {
    const finish = (kind, code = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ label, kind, code, stages });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish("timeout");
    }, timeoutMs);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      if (done) return;
      partial = (partial + chunk).slice(-8192);
      const lines = partial.split(/\r?\n/);
      partial = lines.pop();
      for (const line of lines) {
        const stage = line.startsWith("AKC_MSAA_STAGE=") ? line.slice(15) : "";
        if (STAGES.has(stage) && stages.at(-1) !== stage) {
          stages.push(stage);
          if (stages.length > 64) stages.shift();
        }
      }
    });
    child.once("error", () => finish("spawn-error"));
    child.once("close", (code) => {
      activeChildren.delete(child);
      finish("exited", code);
    });
  });
}

export function assertProcessEvidence(result, requiredStage) {
  const code = Number.isInteger(result.code) ? `0x${(result.code >>> 0).toString(16)}` : "none";
  const detail = `${result.label}: ${result.kind}; exit=${code}; stages=${result.stages.join(",") || "none"}`;
  assert.equal(result.kind, "exited", detail);
  assert.equal(result.code, 0, detail);
  assert.ok(result.stages.includes(requiredStage), `${detail}; missing ${requiredStage}`);
}

export async function assertActuationDecision({ startDecision, startAttacker, expected, timeoutMs = 120_000 }) {
  let timer;
  try {
    const decision = startDecision();
    const checkedDecision = Promise.race([
      decision,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Human Plane decision timed out")), timeoutMs); })
    ]).then((actual) => assert.equal(actual, expected, "unexpected Human Plane decision"));
    // MSAA may synchronously wait for the click handler's OS verification.
    // A fast cancellation is valid; sleeping after attacker exit is not evidence
    // of an approval bypass. Both the actuation and expected OS result must pass.
    const attacker = Promise.resolve().then(startAttacker).then((result) => assertProcessEvidence(result, "action-returned"));
    await Promise.all([checkedDecision, attacker]);
  } finally {
    clearTimeout(timer);
  }
}

export function psLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildMsaaControl(caption, buttonName) {
  assert.ok(["Yes", "Delete"].includes(buttonName));
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$form = New-Object System.Windows.Forms.Form",
    `$form.Text = ${psLiteral(caption)}`,
    "$form.Width = 360; $form.Height = 140; $form.Tag = $false",
    "$button = New-Object System.Windows.Forms.Button",
    `$button.Text = ${psLiteral(buttonName)}`,
    "$button.Left = 20; $button.Top = 20; $form.Controls.Add($button)",
    "$timer = New-Object System.Windows.Forms.Timer",
    "$timer.Interval = 25000",
    "$timer.Add_Tick({ $timer.Stop(); $form.Close() })",
    "$button.Add_Click({",
    "  $form.Tag = $true",
    "  [Console]::Error.WriteLine('AKC_MSAA_STAGE=control-clicked'); [Console]::Error.Flush()",
    // Give the cross-process COM call time to return before the fixture exits.
    "  $timer.Stop(); $timer.Interval = 500; $timer.Start()",
    "})",
    "$form.Add_Shown({ [Console]::Error.WriteLine('AKC_MSAA_STAGE=control-ready'); [Console]::Error.Flush(); $timer.Start() })",
    "$form.ShowDialog() | Out-Null",
    "$clicked = $form.Tag; $timer.Dispose(); $form.Dispose()",
    "if ($clicked) { [Environment]::Exit(0) }",
    "[Environment]::Exit(21)"
  ].join("\n");
}

// The product dialog is localized from the OS user profile, so the driver is
// given every caption/button spelling it may legitimately carry. Widening the
// accepted names does not widen the target: the window is still bound to the
// helper PID this run created.
export function buildMsaaAttacker(caption, buttonName, targetPid) {
  const captions = [].concat(caption);
  const buttonNames = [].concat(buttonName);
  assert.ok(Number.isSafeInteger(targetPid) && targetPid > 0, "MSAA target PID is required");
  assert.ok(
    captions.length > 0 && captions.every((value) => typeof value === "string" && value.length > 0),
    "MSAA window caption is required"
  );
  assert.ok(["Yes", "Delete"].includes(buttonNames[0]), "unsupported MSAA button");
  assert.ok(
    buttonNames.every((value) => typeof value === "string" && value.length > 0),
    "MSAA button names must be non-empty"
  );
  const psStringArray = (values) => `[string[]]@(${values.map(psLiteral).join(", ")})`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::Error.WriteLine('AKC_MSAA_STAGE=starting'); [Console]::Error.Flush()",
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
    "$principal = New-Object Security.Principal.WindowsPrincipal($identity)",
    "if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { [Environment]::Exit(30) }",
    "[Console]::Error.WriteLine('AKC_MSAA_STAGE=non-admin'); [Console]::Error.Flush()",
    "Add-Type -AssemblyName Accessibility",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "using Accessibility;",
    "public static class ApiKeyCaseMsaaAttacker {",
    // Avoid managed EnumWindows callbacks, but do not claim this repairs the
    // measured PowerShell/COM CFG crash; emit checkpoints to locate it.
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string className, string windowName);",
    "  [DllImport(\"user32.dll\")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);",
    "  [DllImport(\"oleacc.dll\")] private static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object value);",
    // The native parameter is IAccessible*, not the object's default IDispatch.
    // An untyped object can select another COM vtable on recursive traversal.
    "  [DllImport(\"oleacc.dll\")] private static extern int AccessibleChildren([MarshalAs(UnmanagedType.Interface)] IAccessible container, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] object[] children, out int obtained);",
    "  private static string lastStage;",
    "  private static void Trace(string stage) { if (lastStage == stage) return; lastStage = stage; Console.Error.WriteLine(\"AKC_MSAA_STAGE=\" + stage); Console.Error.Flush(); }",
    "  public static bool Invoke(string[] captions, string[] buttonNames, uint targetPid) {",
    "    Trace(\"locating-window\");",
    "    IntPtr window = FindWindow(captions, targetPid);",
    "    if (window == IntPtr.Zero) return false;",
    "    Guid iid = new Guid(\"618736E0-3C3D-11CF-810C-00AA00389B71\");",
    "    object root;",
    "    Trace(\"root-request\");",
    "    if (AccessibleObjectFromWindow(window, 0, ref iid, out root) < 0) return false;",
    "    Trace(\"root-received\");",
    "    return Visit((IAccessible)root, buttonNames, 0);",
    "  }",
    "  private static IntPtr FindWindow(string[] expectedCaptions, uint targetPid) {",
    "    foreach (string expectedCaption in expectedCaptions) {",
    "      IntPtr window = IntPtr.Zero;",
    "      for (int index = 0; index < 256; index++) {",
    "        window = FindWindowExW(IntPtr.Zero, window, null, expectedCaption);",
    "        if (window == IntPtr.Zero) break;",
    "        Trace(\"window-found\");",
    "        uint pid; GetWindowThreadProcessId(window, out pid);",
    "        if (pid == targetPid) { Trace(\"window-bound\"); return window; }",
    "        Trace(\"pid-mismatch\");",
    "      }",
    "    }",
    "    return IntPtr.Zero;",
    "  }",
    "  private static bool Visit(IAccessible node, string[] buttonNames, int depth) {",
    "    if (depth > 32) return false;",
    "    Trace(\"visit\");",
    "    if (Matches(node, 0, buttonNames)) { Trace(\"action-start\"); node.accDoDefaultAction(0); Trace(\"action-returned\"); return true; }",
    "    int count = node.accChildCount;",
    "    if (count <= 0 || count > 4096) return false;",
    "    var children = new object[count];",
    "    int obtained;",
    "    Trace(\"children-request\");",
    "    if (AccessibleChildren(node, 0, count, children, out obtained) < 0) return false;",
    "    Trace(\"children-received\");",
    "    for (int index = 0; index < obtained; index++) {",
    "      var child = children[index] as IAccessible;",
    "      if (child != null && Visit(child, buttonNames, depth + 1)) return true;",
    "      if (children[index] is int) {",
    "        int childId = (int)children[index];",
    "        if (Matches(node, childId, buttonNames)) { Trace(\"action-start\"); node.accDoDefaultAction(childId); Trace(\"action-returned\"); return true; }",
    "        try {",
    "          child = node.get_accChild(childId) as IAccessible;",
    "          if (child != null && Visit(child, buttonNames, depth + 1)) return true;",
    "        } catch { }",
    "      }",
    "    }",
    "    return false;",
    "  }",
    "  private static bool Matches(IAccessible node, object childId, string[] buttonNames) {",
    "    try {",
    "      Trace(\"match\");",
    "      object role = node.get_accRole(childId);",
    "      string name = node.get_accName(childId);",
    "      return Convert.ToInt32(role) == 0x2B && Array.IndexOf(buttonNames, name) >= 0;",
    "    } catch { return false; }",
    "  }",
    "}",
    "'@ -ReferencedAssemblies Accessibility",
    `$deadline = [DateTime]::UtcNow.AddSeconds(20)`,
    `$acted = $false`,
    `while (-not $acted -and [DateTime]::UtcNow -lt $deadline) {`,
    `  Start-Sleep -Milliseconds 50`,
    `  $acted = [ApiKeyCaseMsaaAttacker]::Invoke(${psStringArray(captions)}, ${psStringArray(buttonNames)}, ${targetPid})`,
    `}`,
    `if (-not $acted) { [Environment]::Exit(20) }`,
    `[Environment]::Exit(0)`
  ].join("\n");
}
