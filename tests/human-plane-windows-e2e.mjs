import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WINDOWS_DIALOG_TEXT,
  WINDOWS_POWERSHELL_PATH
} from "../dist/core/human/windows.js";
import { createVault, removeSecret } from "../dist/core/vault/index.js";

if (process.platform !== "win32") {
  console.log("skipping Windows Human Plane e2e: not running on Windows");
  process.exit(0);
}

const cliPath = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "api-key-case-human-plane-"));
const fakeBin = join(root, "fake-bin");
const fakeHelperMarker = join(root, "fake-helper-ran.txt");
const name = "AKC_HUMAN_PLANE_CANCEL_E2E";
const agentStdinCanary = ["sk-", "agent-owned-stdin-012345678901234"].join("");

mkdirSync(fakeBin, { recursive: true });
writeFileSync(
  join(fakeBin, "powershell.exe"),
  `This fake PATH helper must not run. Marker: ${fakeHelperMarker}\n`,
  "utf8"
);
writeFileSync(join(root, ".gitignore"), ".env\n.env.*\n!.env.example\n", "utf8");
writeFileSync(join(root, ".env.example"), `${name}=\n`, "utf8");

const hostileEnv = sanitizedTestParentEnv(fakeBin);

try {
  const argv = [cliPath, "save", name, "--scope", "user", "--force", "--ask"];
  const cli = spawn(process.execPath, argv, {
    cwd: root,
    env: hostileEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  cli.stdout.setEncoding("utf8");
  cli.stderr.setEncoding("utf8");
  cli.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  cli.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // Agent-owned stdin is hostile. --ask must never read this value or fall
  // back to the legacy terminal prompt.
  cli.stdin.end(`${agentStdinCanary}\n`);

  const automation = spawn(
    WINDOWS_POWERSHELL_PATH,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-EncodedCommand",
      Buffer.from(buildCancellationDriver(), "utf16le").toString("base64")
    ],
    {
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    }
  );
  let automationError = "";
  automation.stderr.setEncoding("utf8");
  automation.stderr.on("data", (chunk) => {
    automationError += chunk;
  });

  const automationCode = await exitCode(automation, 30_000, "dialog automation");
  if (automationCode !== 0) cli.kill();
  const cliCode = await exitCode(cli, 30_000, "Human Plane CLI");

  assert.equal(automationCode, 0, automationError);
  assert.equal(cliCode, 4, stderr);
  assert.match(stderr, /cancelled; nothing was saved/);
  assert.equal(stdout.includes(agentStdinCanary), false);
  assert.equal(stderr.includes(agentStdinCanary), false);
  assert.equal(argv.join(" ").includes(agentStdinCanary), false);
  assert.equal(JSON.stringify(hostileEnv).includes(agentStdinCanary), false);
  assert.equal(existsSync(fakeHelperMarker), false, "PATH-controlled helper was executed");

  const check = runCli(["check", name, "--scope", "user", "--json"]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).status, "missing");

  const next = runCli(["next", "--json", root]);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(
    JSON.parse(next.stdout).nextActions.some(
      (action) => action.actor === "human" && action.kind === "register-secret"
    ),
    true
  );
  assertProjectFilesContainNoCanary(root);
  console.log("Windows Human Plane cancellation e2e passed");
} finally {
  // Removal is a Human Plane decision with no unattended path (Phase 6E), so
  // this harness cleans up through the vault module directly instead of asking
  // the CLI to bypass its own boundary.
  await removeSecret(createVault(), { name, scope: "user", projectId: null });
  rmSync(root, { recursive: true, force: true });
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: hostileEnv
  });
}

function exitCode(child, timeoutMs, label) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} timed out.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

function sanitizedTestParentEnv(pathValue) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.toLowerCase() === "path") continue;
    if (key === "NODE_OPTIONS") continue;
    env[key] = value;
  }
  env.Path = pathValue;
  env.PATH = pathValue;
  env.NODE_OPTIONS = "--no-warnings";
  env.LD_PRELOAD = "agent-owned-injection.so";
  env.DYLD_INSERT_LIBRARIES = "agent-owned-injection.dylib";
  env.GH_TOKEN = "agent-owned-provider-auth";
  env.CLOUDFLARE_API_TOKEN = "agent-owned-provider-auth";
  env.VERCEL_TOKEN = "agent-owned-provider-auth";
  env.CI = "1";
  return env;
}

function assertProjectFilesContainNoCanary(dir) {
  for (const path of walkFiles(dir)) {
    assert.equal(
      readFileSync(path).toString("utf8").includes(agentStdinCanary),
      false,
      `${path} exposed the Agent-owned stdin canary`
    );
  }
}

function walkFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walkFiles(path));
    else files.push(path);
  }
  return files;
}

function buildCancellationDriver() {
  const secretInputCaptions = [
    WINDOWS_DIALOG_TEXT.secretInputCaption.en,
    WINDOWS_DIALOG_TEXT.secretInputCaption.ja
  ]
    .map((caption) => JSON.stringify(caption))
    .join(", ");

  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "public static class ApiKeyCaseCancelDriver {",
    "  private delegate bool EnumProc(IntPtr hwnd, IntPtr data);",
    "  [DllImport(\"user32.dll\")] private static extern bool EnumWindows(EnumProc callback, IntPtr data);",
    "  [DllImport(\"user32.dll\")] private static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr data);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);",
    "  [DllImport(\"user32.dll\", EntryPoint = \"GetWindowLongW\")] private static extern int GetWindowLong(IntPtr hwnd, int index);",
    "  [DllImport(\"user32.dll\")] private static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);",
    `  private static readonly string[] SecretInputCaptions = new[] { ${secretInputCaptions} };`,
    "  public static IntPtr FindDialog() {",
    "    IntPtr found = IntPtr.Zero;",
    "    EnumWindows((hwnd, data) => {",
    "      var caption = new StringBuilder(256);",
    "      GetWindowText(hwnd, caption, caption.Capacity);",
    "      if (Array.IndexOf(SecretInputCaptions, caption.ToString()) >= 0) { found = hwnd; return false; }",
    "      return true;",
    "    }, IntPtr.Zero);",
    "    return found;",
    "  }",
    "  public static IntPtr FindPasswordInput(IntPtr parent) {",
    "    IntPtr found = IntPtr.Zero;",
    "    EnumChildWindows(parent, (hwnd, data) => {",
    "      var cls = new StringBuilder(256);",
    "      GetClassName(hwnd, cls, cls.Capacity);",
    "      if (cls.ToString().IndexOf(\"EDIT\", StringComparison.OrdinalIgnoreCase) >= 0 && (GetWindowLong(hwnd, -16) & 0x20) != 0) { found = hwnd; return false; }",
    "      return true;",
    "    }, IntPtr.Zero);",
    "    return found;",
    "  }",
    "  public static bool IsPasswordInput(IntPtr hwnd) { return (GetWindowLong(hwnd, -16) & 0x20) != 0; }",
    "  public static void Close(IntPtr hwnd) { PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); }",
    "}",
    "'@",
    "$deadline = [DateTime]::UtcNow.AddSeconds(20)",
    "$dialog = [IntPtr]::Zero",
    "$input = [IntPtr]::Zero",
    "while (($dialog -eq [IntPtr]::Zero -or $input -eq [IntPtr]::Zero) -and [DateTime]::UtcNow -lt $deadline) {",
    "  Start-Sleep -Milliseconds 50",
    "  $dialog = [ApiKeyCaseCancelDriver]::FindDialog()",
    "  if ($dialog -ne [IntPtr]::Zero) { $input = [ApiKeyCaseCancelDriver]::FindPasswordInput($dialog) }",
    "}",
    "if ($dialog -eq [IntPtr]::Zero -or $input -eq [IntPtr]::Zero) { [Environment]::Exit(20) }",
    "if (-not [ApiKeyCaseCancelDriver]::IsPasswordInput($input)) { [Environment]::Exit(21) }",
    "[ApiKeyCaseCancelDriver]::Close($dialog)",
    "[Environment]::Exit(0)"
  ].join("\n");
}
