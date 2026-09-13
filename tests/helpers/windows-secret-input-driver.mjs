// Win32 test driver for the product's Windows Human Plane secret-input dialog.
//
// Test infrastructure only. No product code imports this module, and it adds
// nothing to the product: no test bypass, no Secret read API, no relaxed
// boundary.
//
// Controls are identified structurally, never by child-enumeration order and
// never by fuzzy matching on a Secret name:
//   - the Secret field is the EDIT control carrying ES_PASSWORD
//   - Save/Cancel are BUTTON controls whose text is one of the product's own
//     English/Japanese labels, passed in from the built product module
//
// The driver never reads a password control's characters back, and the fixture
// value reaches it only over stdin — never as an argument, an environment
// variable or a file. Only the helper process this run started is acted on:
// the dialog window must belong to a powershell.exe child of the CLI process
// whose id the caller supplies.
import assert from "node:assert/strict";

export const DRIVER_MODES = Object.freeze(["inspect", "save"]);

// Exit codes the driver may return. 0 means the requested interaction
// completed; every other value names where it stopped.
export const DRIVER_EXIT = Object.freeze({
  ok: 0,
  dialogNotFound: 20,
  passwordFieldNotFound: 21,
  buttonNotFound: 22,
  dialogDidNotClose: 23,
  fixtureNotReceived: 24
});

function psLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function psStringArray(values) {
  return `[string[]]@(${values.map(psLiteral).join(", ")})`;
}

export function buildSecretInputDriver({
  mode,
  cliPid,
  captions,
  saveLabels,
  cancelLabels,
  messageBoxCaptions = ["API Key Case"]
}) {
  assert.ok(DRIVER_MODES.includes(mode), "unknown driver mode");
  assert.ok(Number.isSafeInteger(cliPid) && cliPid > 0, "a CLI process id is required");
  for (const [label, values] of Object.entries({ captions, saveLabels, cancelLabels, messageBoxCaptions })) {
    assert.ok(
      Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === "string" && value),
      `${label} must be a non-empty list of product labels`
    );
  }

  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Collections.Generic;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "public class AkcControl {",
    "  public string ClassName;",
    "  public int Style;",
    "  public bool IsEdit;",
    "  public bool IsButton;",
    "  public bool IsPassword;",
    "  public bool IsReadOnly;",
    "  public bool IsMultiline;",
    "  public int TextLength;",
    "  public string Text;",
    "  public IntPtr Handle;",
    "}",
    "public static class AkcSecretInputDriver {",
    "  private delegate bool EnumProc(IntPtr hwnd, IntPtr data);",
    "  [DllImport(\"user32.dll\")] private static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr data);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string className, string windowName);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hwnd, StringBuilder text, int count);",
    "  [DllImport(\"user32.dll\", EntryPoint = \"GetWindowLongW\")] private static extern int GetWindowLong(IntPtr hwnd, int index);",
    "  [DllImport(\"user32.dll\")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);",
    "  [DllImport(\"user32.dll\")] private static extern bool IsWindow(IntPtr hwnd);",
    "  [DllImport(\"user32.dll\")] private static extern bool GetClientRect(IntPtr hwnd, out RECT rect);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode, EntryPoint = \"SendMessageW\")] private static extern IntPtr SendText(IntPtr hwnd, uint msg, IntPtr wParam, string lParam);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode, EntryPoint = \"SendMessageW\")] private static extern IntPtr ReadText(IntPtr hwnd, uint msg, IntPtr wParam, StringBuilder lParam);",
    "  [DllImport(\"user32.dll\", EntryPoint = \"SendMessageW\")] private static extern IntPtr Send(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);",
    "  [DllImport(\"user32.dll\", EntryPoint = \"PostMessageW\")] private static extern bool Post(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);",
    "  [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
    "  private const int GWL_STYLE = -16;",
    "  private const int ES_MULTILINE = 0x0004;",
    "  private const int ES_PASSWORD = 0x0020;",
    "  private const int ES_READONLY = 0x0800;",
    "  private const uint WM_SETTEXT = 0x000C;",
    "  private const uint WM_GETTEXT = 0x000D;",
    "  private const uint WM_GETTEXTLENGTH = 0x000E;",
    "  private const uint WM_CLOSE = 0x0010;",
    "  private const uint WM_LBUTTONDOWN = 0x0201;",
    "  private const uint WM_LBUTTONUP = 0x0202;",
    "  private const uint BM_CLICK = 0x00F5;",
    // Exact class and exact caption only, and the window must belong to one of
    // this run's own helper processes.
    // The dialog is matched on caption alone; the message box additionally has
    // to be the standard dialog class. Both entry points pass the class from
    // C# so that a null is never produced by a script-side conversion.
    "  public static IntPtr FindDialog(string[] captions, uint[] processIds) { return FindTopLevel(null, captions, processIds); }",
    "  public static IntPtr FindMessageBox(string[] captions, uint[] processIds) { return FindTopLevel(\"#32770\", captions, processIds); }",
    "  private static IntPtr FindTopLevel(string className, string[] captions, uint[] processIds) {",
    "    foreach (string caption in captions) {",
    "      IntPtr window = IntPtr.Zero;",
    "      for (int index = 0; index < 256; index++) {",
    "        window = FindWindowExW(IntPtr.Zero, window, className, caption);",
    "        if (window == IntPtr.Zero) break;",
    "        uint processId; GetWindowThreadProcessId(window, out processId);",
    "        if (Array.IndexOf(processIds, processId) >= 0) return window;",
    "      }",
    "    }",
    "    return IntPtr.Zero;",
    "  }",
    "  public static AkcControl[] Inspect(IntPtr parent) {",
    "    var found = new List<AkcControl>();",
    "    EnumChildWindows(parent, delegate(IntPtr hwnd, IntPtr data) { found.Add(Describe(hwnd)); return true; }, IntPtr.Zero);",
    "    return found.ToArray();",
    "  }",
    "  private static AkcControl Describe(IntPtr hwnd) {",
    "    var className = new StringBuilder(256);",
    "    GetClassNameW(hwnd, className, className.Capacity);",
    "    string name = className.ToString();",
    "    int style = GetWindowLong(hwnd, GWL_STYLE);",
    "    var control = new AkcControl();",
    "    control.Handle = hwnd;",
    "    control.ClassName = name;",
    "    control.Style = style;",
    "    control.IsEdit = name.IndexOf(\"EDIT\", StringComparison.OrdinalIgnoreCase) >= 0;",
    "    control.IsButton = name.IndexOf(\"BUTTON\", StringComparison.OrdinalIgnoreCase) >= 0;",
    "    control.IsPassword = control.IsEdit && (style & ES_PASSWORD) != 0;",
    "    control.IsReadOnly = control.IsEdit && (style & ES_READONLY) != 0;",
    "    control.IsMultiline = control.IsEdit && (style & ES_MULTILINE) != 0;",
    "    control.TextLength = (int)Send(hwnd, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero);",
    // A password field's characters are never read into this driver.
    "    control.Text = control.IsPassword ? null : ReadCaption(hwnd, control.TextLength);",
    "    return control;",
    "  }",
    "  private static string ReadCaption(IntPtr hwnd, int length) {",
    "    if (length <= 0 || length > 65536) return String.Empty;",
    "    var buffer = new StringBuilder(length + 1);",
    "    ReadText(hwnd, WM_GETTEXT, (IntPtr)(length + 1), buffer);",
    "    return buffer.ToString();",
    "  }",
    "  public static void SetText(IntPtr hwnd, string value) { SendText(hwnd, WM_SETTEXT, IntPtr.Zero, value); }",
    "  public static int TextLength(IntPtr hwnd) { return (int)Send(hwnd, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero); }",
    "  public static void Click(IntPtr hwnd) { Post(hwnd, BM_CLICK, IntPtr.Zero, IntPtr.Zero); }",
    "  public static void ClickMouse(IntPtr hwnd) {",
    "    RECT rect; GetClientRect(hwnd, out rect);",
    "    int x = (rect.Right - rect.Left) / 2;",
    "    int y = (rect.Bottom - rect.Top) / 2;",
    "    IntPtr position = (IntPtr)((y << 16) | (x & 0xFFFF));",
    "    Post(hwnd, WM_LBUTTONDOWN, (IntPtr)1, position);",
    "    Post(hwnd, WM_LBUTTONUP, IntPtr.Zero, position);",
    "  }",
    "  public static void Close(IntPtr hwnd) { Post(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }",
    "  public static bool Alive(IntPtr hwnd) { return IsWindow(hwnd); }",
    "}",
    "'@",
    `$mode = ${psLiteral(mode)}`,
    `$cliPid = ${cliPid}`,
    `$captions = ${psStringArray(captions)}`,
    `$saveLabels = ${psStringArray(saveLabels)}`,
    `$cancelLabels = ${psStringArray(cancelLabels)}`,
    `$messageBoxCaptions = ${psStringArray(messageBoxCaptions)}`,
    "$script:report = @{ mode = $mode; ok = $false; reason = 'not-started'; controls = @() }",
    "function Write-AkcReport {",
    "  $json = $script:report | ConvertTo-Json -Depth 6 -Compress",
    "  [Console]::Out.WriteLine('AKC_JSON=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))",
    "  [Console]::Out.Flush()",
    "}",
    "function Stop-AkcDriver { param([int]$Code, [string]$Reason)",
    "  $script:report.reason = $Reason",
    "  $script:report.ok = ($Code -eq 0)",
    "  Write-AkcReport",
    "  [Environment]::Exit($Code)",
    "}",
    // Only powershell.exe children of this run's own CLI process qualify.
    "function Get-AkcHelperPids { param([int]$ParentPid)",
    "  $processes = $null",
    "  try { $processes = Get-CimInstance -ClassName Win32_Process -Filter \"ParentProcessId=$ParentPid\" -ErrorAction Stop }",
    "  catch { try { $processes = Get-WmiObject -Class Win32_Process -Filter \"ParentProcessId=$ParentPid\" -ErrorAction Stop } catch { $processes = $null } }",
    "  $ids = New-Object System.Collections.Generic.List[uint32]",
    "  if ($null -ne $processes) {",
    "    foreach ($process in $processes) { if ($process.Name -eq 'powershell.exe') { $ids.Add([uint32]$process.ProcessId) } }",
    "  }",
    "  return ,($ids.ToArray())",
    "}",
    "$deadline = [DateTime]::UtcNow.AddSeconds(60)",
    "$dialog = [IntPtr]::Zero",
    "$helperPids = [uint32[]]@()",
    "while ($dialog -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline) {",
    "  Start-Sleep -Milliseconds 200",
    "  $helperPids = Get-AkcHelperPids $cliPid",
    "  if ($helperPids.Length -gt 0) { $dialog = [AkcSecretInputDriver]::FindDialog($captions, $helperPids) }",
    "}",
    "$script:report.helperPidCount = $helperPids.Length",
    `if ($dialog -eq [IntPtr]::Zero) { Stop-AkcDriver ${DRIVER_EXIT.dialogNotFound} 'dialog-not-found' }`,
    "$controls = [AkcSecretInputDriver]::Inspect($dialog)",
    "$described = @()",
    "foreach ($control in $controls) {",
    "  $described += @{ className = $control.ClassName; style = $control.Style; isEdit = $control.IsEdit; isButton = $control.IsButton; isPassword = $control.IsPassword; isReadOnly = $control.IsReadOnly; isMultiline = $control.IsMultiline; textLength = $control.TextLength; text = $control.Text }",
    "}",
    "$script:report.controls = @($described)",
    "$field = $controls | Where-Object { $_.IsPassword } | Select-Object -First 1",
    `if ($null -eq $field) { Stop-AkcDriver ${DRIVER_EXIT.passwordFieldNotFound} 'password-field-not-found' }`,
    "if ($mode -eq 'inspect') {",
    "  $cancel = $controls | Where-Object { $_.IsButton -and ($cancelLabels -contains $_.Text) } | Select-Object -First 1",
    `  if ($null -eq $cancel) { Stop-AkcDriver ${DRIVER_EXIT.buttonNotFound} 'cancel-button-not-found' }`,
    "  [AkcSecretInputDriver]::Click($cancel.Handle)",
    "  $closeDeadline = [DateTime]::UtcNow.AddSeconds(30)",
    "  $retryAt = [DateTime]::UtcNow.AddSeconds(8)",
    "  $retried = $false",
    "  while ([AkcSecretInputDriver]::Alive($dialog) -and [DateTime]::UtcNow -lt $closeDeadline) {",
    "    Start-Sleep -Milliseconds 150",
    "    if (-not $retried -and [DateTime]::UtcNow -gt $retryAt) { $retried = $true; [AkcSecretInputDriver]::ClickMouse($cancel.Handle) }",
    "  }",
    `  if ([AkcSecretInputDriver]::Alive($dialog)) { Stop-AkcDriver ${DRIVER_EXIT.dialogDidNotClose} 'dialog-did-not-close' }`,
    "  Stop-AkcDriver 0 'cancelled'",
    "}",
    "$save = $controls | Where-Object { $_.IsButton -and ($saveLabels -contains $_.Text) } | Select-Object -First 1",
    `if ($null -eq $save) { Stop-AkcDriver ${DRIVER_EXIT.buttonNotFound} 'save-button-not-found' }`,
    // The fixture value arrives only on stdin and is dropped as soon as the
    // control holds it. It is never written to stdout, stderr or a file.
    "$fixture = [Console]::In.ReadLine()",
    `if ([String]::IsNullOrEmpty($fixture)) { Stop-AkcDriver ${DRIVER_EXIT.fixtureNotReceived} 'fixture-not-received' }`,
    "[AkcSecretInputDriver]::SetText($field.Handle, $fixture)",
    "$fixture = $null",
    "Remove-Variable fixture -ErrorAction SilentlyContinue",
    "$script:report.setLength = [AkcSecretInputDriver]::TextLength($field.Handle)",
    "[AkcSecretInputDriver]::Click($save.Handle)",
    "$script:report.messageBox = $false",
    "$script:report.messageBoxTexts = @()",
    "$saveDeadline = [DateTime]::UtcNow.AddSeconds(60)",
    "$retryAt = [DateTime]::UtcNow.AddSeconds(8)",
    "$retried = $false",
    "$seenMessageBox = $false",
    "while ([DateTime]::UtcNow -lt $saveDeadline) {",
    "  Start-Sleep -Milliseconds 150",
    "  if (-not $seenMessageBox) {",
    "    $box = [AkcSecretInputDriver]::FindMessageBox($messageBoxCaptions, $helperPids)",
    "    if ($box -ne [IntPtr]::Zero) {",
    "      $seenMessageBox = $true",
    "      $script:report.messageBox = $true",
    "      $boxControls = [AkcSecretInputDriver]::Inspect($box)",
    "      $texts = @()",
    "      foreach ($control in $boxControls) { if ($control.Text) { $texts += $control.Text } }",
    "      $script:report.messageBoxTexts = @($texts)",
    "      $boxButton = $boxControls | Where-Object { $_.IsButton } | Select-Object -First 1",
    "      if ($null -ne $boxButton) { [AkcSecretInputDriver]::Click($boxButton.Handle) } else { [AkcSecretInputDriver]::Close($box) }",
    "      continue",
    "    }",
    "  }",
    "  if (-not [AkcSecretInputDriver]::Alive($dialog)) { break }",
    "  if (-not $retried -and -not $seenMessageBox -and [DateTime]::UtcNow -gt $retryAt) { $retried = $true; [AkcSecretInputDriver]::ClickMouse($save.Handle) }",
    "}",
    `if ([AkcSecretInputDriver]::Alive($dialog)) { Stop-AkcDriver ${DRIVER_EXIT.dialogDidNotClose} 'dialog-did-not-close' }`,
    "Stop-AkcDriver 0 'save-completed'"
  ].join("\n");
}
