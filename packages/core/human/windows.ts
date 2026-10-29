import { buildWindowsAcquisitionLayout } from "./windows-acquisition.js";
import { buildGenericInputLayout } from "./windows-generic-layout.js";
import { buildWindowsBindingScript, buildWindowsManagementScript } from "./windows-binding.js";
import type { BindingPlan, BindingIO } from "../vnext/binding.js";
import type { TargetPlan, TargetIO } from "../vnext/target.js";
import type { UsePlan } from "../vnext/use.js";
import { buildWindowsTargetScript, buildWindowsVNextUseScript } from "./windows-target.js";
import { buildWindowsLaunchReview } from "./windows-launch.js";
import type { LaunchPlan, ProfilePlan } from "../vnext/launch.js";
import { buildWindowsHostedTargetScript, buildWindowsHostedUseScript } from "./windows-hosted.js";
import type { HostedTargetPlan } from "../vnext/hosted-target.js";
import type { HostedUsePlan } from "../vnext/hosted-use.js";
import type { ManagePlan } from "../vnext/manage.js";
import { catalogSchema, operationSchema, locatorAccount, validate, VNextError, type Catalog, type Operation } from "../vnext/model.js";
import { catalogFingerprint } from "../vnext/registration.js";
import type { Locator } from "../vnext/model.js";
import { buildCredentialAcquisitionPanel, STRIPE_TEST_INPUT_ERROR } from "./acquisition.js";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 as pathWin32 } from "node:path";
import { resolveTrustedHomeDirectory } from "../deploy/which.js";
import { assertValidSecretName } from "../vault/types.js";
import { toAccount } from "../vault/naming.js";
import { approvalSourceLabel, assertApprovalConnectionSource, type ApprovalPlan, type ApprovalTrustState } from "../deploy/types.js";
import type {
  HumanApprovalStatus,
  LocalApplicationApproval,
  HumanPlane,
  HumanSecretInputStatus,
  RemovalPlan,
  SecretInputRequest
} from "./types.js";

const WINDOWS_ROOT = String.raw`C:\Windows`;

// The helper's own PATH. libuv fills PATH in from the parent when it is
// absent, so this has to be set rather than omitted. It holds the fixed system
// directories only; no caller, project, or package-manager directory.
const WINDOWS_HELPER_PATH = [
  pathWin32.join(WINDOWS_ROOT, "System32"),
  WINDOWS_ROOT,
  pathWin32.join(WINDOWS_ROOT, "System32", "Wbem"),
  pathWin32.join(WINDOWS_ROOT, "System32", "WindowsPowerShell", "v1.0")
].join(";");

export interface LocalizedText {
  readonly en: string;
  readonly ja: string;
}

// Fixed text for the closed Phase D trust states. The dialog never renders
// caller-supplied prose for this line.
const TRUST_STATE_TEXT: Readonly<Record<ApprovalTrustState, LocalizedText>> = Object.freeze({
  "first-use": Object.freeze({
    en: "first use of this destination on this machine",
    ja: "このPCでこの配置先を使うのは初めてです"
  }),
  changed: Object.freeze({
    en: "CHANGED since the last time you approved this project/target/environment",
    ja: "前回このプロジェクト／配置先／環境を承認したときから変更されています"
  }),
  "always-approve": Object.freeze({
    en: "this operation always requires approval",
    ja: "この操作は毎回承認が必要です"
  })
});

// Window captions and button labels. Exported because the interactive Windows
// verification harness has to locate the same controls in either language.
export const WINDOWS_DIALOG_TEXT = Object.freeze({
  secretInputCaption: Object.freeze({
    en: "API Key Case - Secret Input",
    ja: "API Key Case - シークレットの入力"
  }),
  approvalCaption: Object.freeze({
    en: "API Key Case - Approve Operation",
    ja: "API Key Case - 操作の承認"
  }),
  deleteSecretCaption: Object.freeze({
    en: "API Key Case - Delete Secret",
    ja: "API Key Case - シークレットの削除"
  }),
  forgetDestinationCaption: Object.freeze({
    en: "API Key Case - Forget Destination",
    ja: "API Key Case - 配置先の記憶の削除"
  }),
  approveButton: Object.freeze({ en: "Yes", ja: "はい" }),
  declineButton: Object.freeze({ en: "No", ja: "いいえ" }),
  deleteButton: Object.freeze({ en: "Delete", ja: "削除" }),
  saveButton: Object.freeze({ en: "Save", ja: "保存" }),
  cancelButton: Object.freeze({ en: "Cancel", ja: "キャンセル" })
});

// The dialog language is derived from the signed-in user's own Windows
// settings inside the helper, never from an environment variable: the helper
// receives a fixed env allowlist, and CultureInfo does not read one on
// Windows. Both language tables are compiled into every script, so an Agent
// cannot choose which prose a human is shown. A Japanese developer commonly
// runs an English display language with a Japanese regional format, so either
// signal selects Japanese.
const LANGUAGE_PREAMBLE: readonly string[] = Object.freeze([
  "$script:akcJa = ([System.Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName -eq 'ja') -or ([System.Globalization.CultureInfo]::CurrentCulture.TwoLetterISOLanguageName -eq 'ja')",
  "function Get-AkcText { param([string]$En, [string]$Ja) if ($script:akcJa) { return $Ja } return $En }",
  // Visual styles have to be enabled before the first control is created, or
  // the dialog is drawn with the pre-XP theme.
  "[System.Windows.Forms.Application]::EnableVisualStyles()"
]);

// WinForms defaults to Microsoft Sans Serif 8.25pt, which is two decades older
// than the OS it runs on. Child controls inherit the form's font.
const DIALOG_FONT = "$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)";
export const WINDOWS_POWERSHELL_PATH = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
// CRED_MAX_CREDENTIAL_BLOB_SIZE from wincred.h. Compare the exact UTF-16 byte
// count before CredWrite so an oversized value is refused rather than clipped.
export const WINDOWS_CREDENTIAL_BLOB_MAX_BYTES = 5 * 512;
// IUserConsentVerifierInterop::RequestVerificationForWindowAsync is supported
// by Microsoft only from Windows build 22000. Secret input intentionally does
// not use this gate; it keeps the existing Credential Manager boundary.
export const WINDOWS_USER_VERIFICATION_MIN_BUILD = 22_000;

// Reserve room below CreateProcessW's command-line limit for the executable
// and flags. Generated code contains display metadata, never an entered value.
export const WINDOWS_HELPER_COMMAND_MAX_CHARS = 30_000;

export function encodeWindowsHelperCommand(script: string): string {
  const direct = Buffer.from(script, "utf16le").toString("base64");
  if (direct.length < WINDOWS_HELPER_COMMAND_MAX_CHARS - 1_000) return direct;
  // Keep the existing ignored stdio and avoid a new script file or pipe. Only
  // fixed builder output is compressed; the Secret still enters inside the UI.
  const compressed = gzipSync(Buffer.from(script, "utf8")).toString("base64");
  const bootstrap = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $akcBytes = [Convert]::FromBase64String('${compressed}')`,
    "  $akcStream = New-Object System.IO.MemoryStream(,$akcBytes)",
    "  $akcGzip = New-Object System.IO.Compression.GZipStream($akcStream, [System.IO.Compression.CompressionMode]::Decompress)",
    "  $akcReader = New-Object System.IO.StreamReader($akcGzip, [System.Text.Encoding]::UTF8)",
    "  try { $akcSource = $akcReader.ReadToEnd() } finally { $akcReader.Dispose(); $akcStream.Dispose() }",
    "  & ([ScriptBlock]::Create($akcSource))",
    "} catch { exit 10 }",
    // A builder must finish with its own explicit status. Returning or failing
    // before that point never becomes approval through PowerShell's default 0.
    "exit 10"
  ].join("\n");
  return Buffer.from(bootstrap, "utf16le").toString("base64");
}

export interface HumanPlaneHelperRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  detached: false;
  shell: false;
  stdio: "ignore";
  windowsHide: false;
}

export type HumanPlaneHelperLauncher = (
  request: HumanPlaneHelperRequest
) => Promise<number | null>;

export class WindowsHumanPlane implements HumanPlane {
  constructor(
    private readonly helperPath: string | null,
    private readonly launch: HumanPlaneHelperLauncher = launchHelper,
    private readonly resolveScratch: () => WindowsHelperScratch | null = resolveWindowsHelperScratch
  ) {}

  capability(): "os-dialog" | "handoff-only" {
    return this.helperPath ? "os-dialog" : "handoff-only";
  }

  async askSecret(request: SecretInputRequest): Promise<HumanSecretInputStatus> {
    if (!this.helperPath) return "unavailable";
    validateSecretInputRequest(request);

    const exitCode = await this.run(buildWindowsSecretInputScript(request));
    if (exitCode === 0) return "saved";
    if (exitCode === 2) return "cancelled";
    return "unavailable";
  }

  /** Separate v3 input path. It cannot accept a value or an arbitrary OS account. */
  async askVNextSecret(plan: { operation: Operation; catalog: Catalog }): Promise<HumanSecretInputStatus> {
    // Native primitive, also used by independent synthetic acceptance. The CLI
    // source-gates this route until that exact acceptance has passed.
    if (!this.helperPath) return "unavailable";
    const exitCode = await this.run(buildWindowsVNextSecretInputScript(plan));
    return exitCode === 0 ? "saved" : exitCode === 2 ? "cancelled" : "unavailable";
  }

  async probeVNextPresence(locator: Locator): Promise<"present" | "absent" | "unavailable"> {
    if (!this.helperPath) return "unavailable";
    const exitCode = await this.run(buildWindowsVNextPresenceScript(locator));
    return exitCode === 0 ? "present" : exitCode === 2 ? "absent" : "unavailable";
  }

  /** Closed presence bits only; no OS-store enumeration or value decoding. */
  async probeVNextPresenceBatch(locators: Locator[]): Promise<("present" | "absent" | "unavailable")[]> {
    const states: ("present" | "absent" | "unavailable")[] = [];
    for (let offset = 0; offset < locators.length; offset += 20) {
      const chunk = locators.slice(offset, offset + 20);
      const code = this.helperPath ? await this.run(buildWindowsVNextPresenceBatchScript(chunk)) : null;
      if (code === null || code < 0 || code >= 2 ** chunk.length) states.push(...chunk.map(() => "unavailable" as const));
      else states.push(...chunk.map((_, i) => (code & (1 << i)) !== 0 ? "present" as const : "absent" as const));
    }
    return states;
  }

  async chooseVNextBinding(plan: BindingPlan): ReturnType<BindingIO["human"]["choose"]> {
    if (!this.helperPath) return { status: "unavailable" };
    const code = await this.run(buildWindowsBindingScript(plan));
    return code !== null && code >= 100 && code < 100 + plan.candidates.length ? { status: "confirmed", index: code - 100 } :
      { status: code === 2 ? "cancelled" : "unavailable" };
  }

  async confirmVNextManagement(plan: ManagePlan): Promise<"confirmed" | "cancelled" | "unavailable"> {
    if (!this.helperPath) return "unavailable";
    const code = await this.run(buildWindowsManagementScript(plan));
    return code === 0 ? "confirmed" : code === 2 ? "cancelled" : "unavailable";
  }

  async askApproval(plan: ApprovalPlan): Promise<HumanApprovalStatus> {
    if (!this.helperPath) return "unavailable";
    validateApprovalPlan(plan);

    const exitCode = await this.run(buildWindowsApprovalScript(plan));
    if (exitCode === 0) return "approved";
    if (exitCode === 2) return "declined";
    return "unavailable";
  }

  async chooseVNextTarget(plan: TargetPlan): ReturnType<TargetIO["human"]["choose"]> {
    if (!this.helperPath) return { status: "unavailable" };
    const code = await this.run(buildWindowsTargetScript(plan));
    return code !== null && code >= 100 && code < 100 + plan.candidates.length ? { status: "confirmed", index: code - 100 } :
      { status: code === 2 ? "cancelled" : "unavailable" };
  }

  async approveVNextUse(plan: UsePlan, cliPath: string): Promise<HumanApprovalStatus> {
    if (!this.helperPath) return "unavailable";
    const code = await this.run(buildWindowsVNextUseScript(plan, cliPath));
    return code === 0 ? "approved" : code === 2 ? "declined" : "unavailable";
  }

  async confirmVNextProfile(plan: ProfilePlan): Promise<HumanApprovalStatus> {
    if (!this.helperPath) return "unavailable";
    const code = await this.run(buildWindowsLaunchReview(plan, false));
    return code === 100 ? "approved" : code === 2 ? "declined" : "unavailable";
  }

  async confirmVNextHostedTarget(plan: HostedTargetPlan): Promise<HumanApprovalStatus> {
    if (!this.helperPath) return "unavailable";
    const code = await this.run(buildWindowsHostedTargetScript(plan));
    return code === 100 ? "approved" : code === 2 ? "declined" : "unavailable";
  }

  async approveVNextHostedUse(plan: HostedUsePlan, cliPath: string): Promise<HumanApprovalStatus> {
    if (!this.helperPath) return "unavailable";
    const code = await this.run(buildWindowsHostedUseScript(plan, cliPath));
    return code === 0 ? "approved" : code === 2 ? "declined" : "unavailable";
  }

  async approveVNextLaunch(plan: LaunchPlan): Promise<HumanApprovalStatus> {
    if (!this.helperPath) return "unavailable";
    const code = await this.run(buildWindowsLaunchReview(plan, true));
    return code === 0 ? "approved" : code === 2 ? "declined" : "unavailable";
  }

  async askRemoval(plan: RemovalPlan): Promise<HumanApprovalStatus> {
    if (!this.helperPath) return "unavailable";
    validateRemovalPlan(plan);

    const exitCode = await this.run(buildWindowsRemovalScript(plan));
    if (exitCode === 0) return "approved";
    if (exitCode === 2) return "declined";
    return "unavailable";
  }

  async askLocalApplication(plan: LocalApplicationApproval): Promise<HumanApprovalStatus> {
    if (!this.helperPath) return "unavailable";
    try {
      const exitCode = await this.run(buildWindowsLocalApplicationScript(plan));
      return exitCode === 0 ? "approved" : exitCode === 2 ? "declined" : "unavailable";
    } catch { return "unavailable"; }
  }

  // Runs one helper inside a private scratch directory that exists only for
  // that call. A directory that cannot be created is unavailable, not a
  // fallback to an inherited temp path.
  private async run(script: string): Promise<number | null> {
    const trusted = this.resolveScratch();
    if (!trusted) return null;

    let scratch: string;
    try {
      scratch = mkdtempSync(join(trusted.root, "api-key-case-helper-"));
    } catch {
      return null;
    }

    try {
      const request = this.createRequest(script, scratch, trusted.home);
      return request ? await this.launch(request) : null;
    } finally {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // The helper never writes a Secret here; a leftover directory is
        // hygiene, not a boundary failure.
      }
    }
  }

  private createRequest(
    script: string,
    scratch: string,
    home: string
  ): HumanPlaneHelperRequest | null {
    if (!this.helperPath) {
      throw new Error("Human Plane helper is unavailable.");
    }

    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encodeWindowsHelperCommand(script)];
    if (this.helperPath.length + 2 + args.reduce((size, arg) => size + arg.length + 1, 0) >= WINDOWS_HELPER_COMMAND_MAX_CHARS) return null;
    return {
      executable: this.helperPath,
      args,
      // Do not let an Agent-controlled repository become the helper's DLL or
      // script resolution directory.
      cwd: pathWin32.dirname(this.helperPath),
      // A fresh allowlist, not a filtered copy of process.env: NODE_OPTIONS,
      // provider credentials, and process-injection values never enter the
      // helper.
      //
      // Every name below that this process does not set is filled in by libuv
      // from the parent environment on Windows — PATH, TEMP, USERPROFILE,
      // HOMEDRIVE, HOMEPATH and SYSTEMDRIVE among them — so leaving one out is
      // the same as inheriting the Agent's value. Measured 2026-09-05; see
      // docs/design/windows-human-verification.md. The path-bearing ones are
      // therefore pinned here to fixed system locations, this call's own
      // scratch directory, and the OS-resolved profile.
      //
      // USERNAME, USERDOMAIN and LOGONSERVER are still filled in by libuv.
      // They name the caller rather than resolving code or files, and the
      // helper reads none of them.
      env: {
        SystemRoot: WINDOWS_ROOT,
        WINDIR: WINDOWS_ROOT,
        SYSTEMDRIVE: WINDOWS_ROOT.slice(0, 2),
        PATH: WINDOWS_HELPER_PATH,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        ComSpec: pathWin32.join(WINDOWS_ROOT, "System32", "cmd.exe"),
        TEMP: scratch,
        TMP: scratch,
        USERPROFILE: home,
        HOMEDRIVE: home.slice(0, 2),
        HOMEPATH: home.slice(2)
      },
      detached: false,
      shell: false,
      stdio: "ignore",
      // This is intentionally visible: SW_HIDE also hides the first WinForms
      // window on some Windows versions.
      windowsHide: false
    };
  }
}

// Where the per-call helper scratch directory is created, and the profile the
// helper is told to treat as its home.
//
// Both come from the OS profile lookup the deploy path already uses, not from
// the caller's TEMP/TMP/USERPROFILE. That matters because
// `Add-Type -TypeDefinition` compiles the helper's P/Invoke definitions with
// csc and then loads the resulting assembly out of the temp directory:
// whoever picks that directory picks where the helper's own code is written
// and read back.
//
// Off Windows this class is only ever constructed by tests, which is the sole
// reason for the tmpdir() branch; createHumanPlane() uses it on win32 only.
export interface WindowsHelperScratch {
  root: string;
  home: string;
}

export function resolveWindowsHelperScratch(
  platform: NodeJS.Platform = process.platform
): WindowsHelperScratch | null {
  try {
    if (platform !== "win32") {
      const root = realpathSync.native(tmpdir());
      return { root, home: root };
    }

    const home = resolveTrustedHomeDirectory();
    if (!home) return null;
    const root = realpathSync.native(join(home, "AppData", "Local", "Temp"));
    if (!statSync(root).isDirectory()) return null;
    return { root, home };
  } catch {
    return null;
  }
}

export function resolveWindowsPowerShell(): string | null {
  try {
    const root = realpathSync.native(WINDOWS_ROOT);
    const expected = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const resolved = realpathSync.native(WINDOWS_POWERSHELL_PATH);
    if (resolved.toLowerCase() !== expected.toLowerCase()) return null;
    if (!statSync(resolved).isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

export function buildWindowsSecretInputScript(request: SecretInputRequest): string {
  validateSecretInputRequest(request);
  return buildWindowsInputBody(request);
}

type GenericInput = { name: string; scope: "user"; projectId: null; projectDir: null;
  generic: { operation: Operation; catalog: Catalog } };
export function buildWindowsVNextPresenceScript(locator: Locator): string {
  const account = psTextLiteral(locatorAccount(locator) + ".api-key-case");
  return ["$ErrorActionPreference='Stop'", "try {", "Add-Type -TypeDefinition @'",
    "using System; using System.Runtime.InteropServices;",
    "public static class AkcVNextPresence {",
    "[DllImport(\"Advapi32.dll\", EntryPoint=\"CredReadW\", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool Read(string target, UInt32 type, UInt32 flags, out IntPtr pointer);",
    "[DllImport(\"Advapi32.dll\")] private static extern void CredFree(IntPtr pointer);",
    "public static int Status(string target) { IntPtr p; if(Read(target,1,0,out p)){CredFree(p);return 0;} return Marshal.GetLastWin32Error()==1168 ? 2 : 10; }", "}", "'@",
    `exit ([AkcVNextPresence]::Status(${account}))`, "} catch { exit 10 }", "exit 10"].join("\n");
}
export function buildWindowsVNextPresenceBatchScript(locators: Locator[]): string {
  if (!locators.length || locators.length > 20) throw new VNextError("invalid-data");
  return ["$ErrorActionPreference='Stop'", "try {", "Add-Type -TypeDefinition @'",
    "using System; using System.Runtime.InteropServices; public static class AkcPresenceBits {",
    "[DllImport(\"Advapi32.dll\", EntryPoint=\"CredReadW\", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool Read(string target, UInt32 type, UInt32 flags, out IntPtr pointer);",
    "[DllImport(\"Advapi32.dll\")] private static extern void CredFree(IntPtr pointer);",
    "public static int Status(string target) {IntPtr p; if(Read(target,1,0,out p)){CredFree(p);return 1;} return Marshal.GetLastWin32Error()==1168?0:-1;}", "}", "'@", "$mask=0",
    ...locators.flatMap((l, i) => [`$s=[AkcPresenceBits]::Status(${psTextLiteral(locatorAccount(l) + ".api-key-case")})`,
      "if($s -lt 0){exit 1073741824}", `if($s -eq 1){$mask=$mask -bor ${2 ** i}}`]), "exit $mask", "} catch {exit 1073741824}", "exit 1073741824"].join("\n");
}
export function buildWindowsVNextSecretInputScript(input: { operation: Operation; catalog: Catalog }): string {
  const operation = validate(operationSchema, input.operation), catalog = validate(catalogSchema, input.catalog);
  const candidate = operation.boundBasis.candidateCredential;
  if (operation.kind !== "registration" || operation.state !== "prepared" || !candidate ||
    catalog.revision !== operation.expectedCatalogRevision || catalogFingerprint(catalog) !== operation.boundBasis.fingerprint) throw new VNextError("conflict");
  return buildWindowsInputBody({ name: candidate.label, scope: "user", projectId: null, projectDir: null, generic: { operation, catalog } });
}

function buildWindowsInputBody(request: SecretInputRequest | GenericInput): string {
  const generic = "generic" in request ? request.generic : null;
  const candidate = generic?.operation.boundBasis.candidateCredential;
  const name = generic ? psTextLiteral(request.name) : psLiteral(request.name);
  const account = psLiteral(candidate ? locatorAccount(candidate.locator) : toAccount(request));
  const destinationLabel = request.scope === "project"
    ? {
        en: "Registration destination: This project",
        ja: "登録先：このプロジェクト"
      }
    : {
        en: "Registration destination: Current user (shared across projects)",
        ja: "登録先：現在のユーザー共通"
      };
  const connectionDetails: readonly LocalizedText[] = "environment" in request
    ? [
        { en: `Service: ${request.service}`, ja: `サービス: ${request.service}` },
        { en: `Environment: ${request.environment}`, ja: `環境: ${request.environment}` },
        { en: `Project ID: ${request.projectId}`, ja: `プロジェクト ID: ${request.projectId}` }
      ]
    : [];
  const acquisition = generic ? null : buildCredentialAcquisitionPanel(request);
  const dpi = Boolean(acquisition || generic);
  const stripeTest = "environment" in request && request.service === "stripe-test";
  const extraHeight = (connectionDetails.length > 0 ? 60 : 0);
  const baseDestinationText = request.scope === "project"
    ? `(${psText(destinationLabel)} + [Environment]::NewLine + ${psTextLiteral(request.projectDir ?? "")})`
    : psText(destinationLabel);
  const destinationText = connectionDetails.length > 0
    ? `(${psText(destinationLabel)} + [Environment]::NewLine + ${connectionDetails.map(psText).join(" + [Environment]::NewLine + ")} + [Environment]::NewLine + ${psTextLiteral(request.projectDir ?? "")})`
    : baseDestinationText;

  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    ...LANGUAGE_PREAMBLE.filter(line => !dpi || !line.includes("EnableVisualStyles")),
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "namespace ApiKeyCaseHumanPlane {",
    "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
    "  public struct Credential {",
    "    public UInt32 Flags;",
    "    public UInt32 Type;",
    "    public string TargetName;",
    "    public string Comment;",
    "    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;",
    "    public UInt32 CredentialBlobSize;",
    "    public IntPtr CredentialBlob;",
    "    public UInt32 Persist;",
    "    public UInt32 AttributeCount;",
    "    public IntPtr Attributes;",
    "    public string TargetAlias;",
    "    public string UserName;",
    "  }",
    "  public static class Native {",
    "    [DllImport(\"Advapi32.dll\", EntryPoint = \"CredWriteW\", CharSet = CharSet.Unicode, SetLastError = true)]",
    "    public static extern bool CredWrite(ref Credential credential, UInt32 flags);",
    "    [DllImport(\"user32.dll\")]",
    "    public static extern bool ShowWindow(IntPtr window, int command);",
    ...(generic ? [
      "    [DllImport(\"Advapi32.dll\", EntryPoint = \"CredReadW\", CharSet = CharSet.Unicode, SetLastError = true)]",
      "    private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);",
      "    [DllImport(\"Advapi32.dll\")] private static extern void CredFree(IntPtr credential);",
      "    public static bool Exists(string target) { IntPtr p; if (CredRead(target, 1, 0, out p)) { CredFree(p); return true; } if (Marshal.GetLastWin32Error() == 1168) return false; throw new InvalidOperationException(); }"
    ] : []),
    ...(dpi ? [
      "    [DllImport(\"user32.dll\", SetLastError = true)]",
      "    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);",
      "    [DllImport(\"user32.dll\")]",
      "    public static extern UInt32 GetDpiForWindow(IntPtr window);"
    ] : []),
    "  }",
    "}",
    "'@",
    `$secretName = ${name}`,
    `$account = ${account}`,
    "$script:account = $account",
    "$script:resultCode = 2",
    ...(generic ? ["try { if ([ApiKeyCaseHumanPlane.Native]::Exists($account + '.api-key-case')) { exit 10 } } catch { exit 10 }"] : []),
    ...(dpi ? [
      "try { if ([ApiKeyCaseHumanPlane.Native]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) { exit 10 } } catch { exit 10 }",
      "[System.Windows.Forms.Application]::EnableVisualStyles()"
    ] : []),
    ...(generic && candidate ? buildGenericInputLayout(candidate, generic.catalog.bindings.filter(b => b.credentialId === candidate.id).map(b => {
      const project = generic.catalog.projects.find(p => p.id === b.projectId)!;
      const environment = generic.catalog.environments.find(e => e.id === b.environmentId)!;
      return { projectPath: project.canonicalPath, environment: environment.label, risk: environment.risk, variable: b.variableName };
    }), generic.catalog.credentials.find(c => c.id === candidate.id)) : acquisition ? buildWindowsAcquisitionLayout(acquisition, request) : [
    "$form = New-Object System.Windows.Forms.Form",
    "$script:form = $form",
    `$form.Text = ${psText(WINDOWS_DIALOG_TEXT.secretInputCaption)}`,
    DIALOG_FONT,
    "$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
    "$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog",
    "$form.MaximizeBox = $false",
    "$form.MinimizeBox = $false",
    "$form.ShowInTaskbar = $true",
    "$form.TopMost = $true",
    `$form.ClientSize = New-Object System.Drawing.Size(480, ${282 + extraHeight})`,
    "$label = New-Object System.Windows.Forms.Label",
    "$label.AutoSize = $true",
    "$label.MaximumSize = New-Object System.Drawing.Size(444, 0)",
    "$label.Location = New-Object System.Drawing.Point(18, 18)",
    // A long Secret name reorders the sentence rather than the label, so this
    // one line is composed per language instead of swapping a prefix.
    "$label.Text = (Get-AkcText ('Enter the value for ' + $secretName + '.') ($secretName + ' の値を入力してください。'))",
    "$form.Controls.Add($label)",
    "$destination = New-Object System.Windows.Forms.TextBox",
    "$destination.Location = New-Object System.Drawing.Point(18, 50)",
    `$destination.Size = New-Object System.Drawing.Size(444, ${56 + extraHeight})`,
    ...(connectionDetails.length > 0
      ? ["$destination.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical"]
      : []),
    "$destination.Multiline = $true",
    "$destination.ReadOnly = $true",
    "$destination.BorderStyle = [System.Windows.Forms.BorderStyle]::None",
    "$destination.BackColor = $form.BackColor",
    "$destination.TabStop = $false",
    `$destination.Text = ${destinationText}`,
    "$form.Controls.Add($destination)",
    "$detail = New-Object System.Windows.Forms.Label",
    "$detail.AutoSize = $true",
    "$detail.MaximumSize = New-Object System.Drawing.Size(444, 0)",
    `$detail.Location = New-Object System.Drawing.Point(18, ${114 + extraHeight})`,
    `$detail.Text = ${psText({
      en: "It will be stored directly in Windows Credential Manager.",
      ja: "この値は Windows 資格情報マネージャーへ直接保存されます。"
    })}`,
    "$form.Controls.Add($detail)",
    "$input = New-Object System.Windows.Forms.TextBox",
    "$script:input = $input",
    `$input.Location = New-Object System.Drawing.Point(20, ${150 + extraHeight})`,
    "$input.Size = New-Object System.Drawing.Size(440, 26)",
    "$input.UseSystemPasswordChar = $true",
    // Zero disables the WinForms character cap. Oversized values are rejected
    // by the exact OS byte limit below; the input itself must never be clipped.
    "$input.MaxLength = 0",
    "$form.Controls.Add($input)",
    "$errorLabel = New-Object System.Windows.Forms.Label",
    "$script:errorLabel = $errorLabel",
    "$errorLabel.AutoSize = $true",
    "$errorLabel.MaximumSize = New-Object System.Drawing.Size(444, 0)",
    "$errorLabel.ForeColor = [System.Drawing.Color]::Firebrick",
    `$errorLabel.Location = New-Object System.Drawing.Point(18, ${184 + extraHeight})`,
    "$form.Controls.Add($errorLabel)",
    "$saveButton = New-Object System.Windows.Forms.Button",
    `$saveButton.Text = ${psText(WINDOWS_DIALOG_TEXT.saveButton)}`,
    `$saveButton.Location = New-Object System.Drawing.Point(272, ${230 + extraHeight})`,
    "$saveButton.Size = New-Object System.Drawing.Size(88, 30)",
    "$form.Controls.Add($saveButton)",
    "$cancelButton = New-Object System.Windows.Forms.Button",
    `$cancelButton.Text = ${psText(WINDOWS_DIALOG_TEXT.cancelButton)}`,
    `$cancelButton.Location = New-Object System.Drawing.Point(372, ${230 + extraHeight})`,
    "$cancelButton.Size = New-Object System.Drawing.Size(88, 30)",
    "$form.Controls.Add($cancelButton)",
    ]),
    "$form.AcceptButton = $saveButton",
    "$form.CancelButton = $cancelButton",
    "$cancelButton.Add_Click({",
    "  $script:input.Clear()",
    "  $script:resultCode = 2",
    "  $script:form.Close()",
    "})",
    "$saveButton.Add_Click({",
    "  $value = $script:input.Text",
    "  if ([String]::IsNullOrWhiteSpace($value)) {",
    `    $script:errorLabel.Text = ${psText({
      en: "Value cannot be empty.",
      ja: "値を入力してください。"
    })}`,
    "    $script:input.Focus()",
    "    return",
    "  }",
    ...(stripeTest ? [
      // The value never reaches Node. Refuse other key kinds before encoding or writing.
      "  if (-not $value.StartsWith('sk_test_', [StringComparison]::Ordinal) -or $value.Length -le 8 -or [Text.RegularExpressions.Regex]::IsMatch($value, '\\s')) {",
      `    $script:errorLabel.Text = ${psText(STRIPE_TEST_INPUT_ERROR)}`,
      "    $script:input.Clear()",
      "    $value = $null",
      "    Remove-Variable value -ErrorAction SilentlyContinue",
      "    $script:input.Focus()",
      "    return",
      "  }"
    ] : []),
    "  $blobSize = [Text.Encoding]::Unicode.GetByteCount($value)",
    `  if ($blobSize -gt ${WINDOWS_CREDENTIAL_BLOB_MAX_BYTES}) {`,
    "    $script:resultCode = 10",
    `    [System.Windows.Forms.MessageBox]::Show(${psText({
      en: "This value exceeds the OS storage limit and cannot be registered. Do not modify the value; cancel this registration.",
      ja: "この値はOSの保存上限を超えているため登録できません。値を加工せず、今回は登録を中止してください。"
    })}, 'API Key Case', 'OK', 'Error') | Out-Null`,
    "    $script:input.Clear()",
    "    $value = $null",
    "    $blobSize = $null",
    "    $script:form.Close()",
    "    return",
    "  }",
    "  $blob = [IntPtr]::Zero",
    "  try {",
    ...(generic ? ["    $saveButton.Enabled = $false", "    if ([ApiKeyCaseHumanPlane.Native]::Exists($script:account + '.api-key-case')) { throw 'Candidate already exists.' }"] : []),
    "    $blob = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($value)",
    "    $credential = New-Object ApiKeyCaseHumanPlane.Credential",
    "    $credential.Flags = 0",
    "    $credential.Type = 1",
    "    $credential.TargetName = ($script:account + '.api-key-case')",
    "    $credential.Comment = $null",
    "    $credential.CredentialBlobSize = $blobSize",
    "    $credential.CredentialBlob = $blob",
    "    $credential.Persist = 3",
    "    $credential.AttributeCount = 0",
    "    $credential.Attributes = [IntPtr]::Zero",
    "    $credential.TargetAlias = $null",
    "    $credential.UserName = $script:account",
    "    if (-not [ApiKeyCaseHumanPlane.Native]::CredWrite([ref]$credential, 0)) {",
    "      throw 'Credential Manager write failed.'",
    "    }",
    "    $script:resultCode = 0",
    "  } catch {",
    "    $script:resultCode = 10",
    `    [System.Windows.Forms.MessageBox]::Show(${psText({
      en: "The secret could not be saved. No value was returned to the requesting process.",
      ja: "保存できませんでした。値は呼び出し元のプロセスへ返していません。"
    })}, 'API Key Case', 'OK', 'Error') | Out-Null`,
    "  } finally {",
    "    if ($blob -ne [IntPtr]::Zero) {",
    "      [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($blob)",
    "    }",
    "    $script:input.Clear()",
    "    $value = $null",
    "    $blobSize = $null",
    "    Remove-Variable value -ErrorAction SilentlyContinue",
    "  }",
    "  $script:form.Close()",
    "})",
    "$form.Add_Shown({ [void][ApiKeyCaseHumanPlane.Native]::ShowWindow($script:form.Handle, 5); $script:input.Focus() })",
    "$form.Add_FormClosing({ $script:input.Clear() })",
    "$form.ShowDialog() | Out-Null",
    "$form.Dispose()",
    "[Environment]::Exit($script:resultCode)"
  ].join("\n");
}

// The approval dialog is deliberately a one-shot UI primitive. It returns
// only an exit status to the already-running deploy call; it never emits a
// token, a serialized plan, or any Secret-bearing data to the parent.
export function buildWindowsApprovalScript(plan: ApprovalPlan): string {
  validateApprovalPlan(plan);

  const name = psTextLiteral(plan.name);
  const scope = psTextLiteral(plan.scope);
  const target = psTextLiteral(plan.target);
  const env = psTextLiteral(plan.env);
  const projectDir = psTextLiteral(plan.projectDir);
  const destination = psTextLiteral(plan.destination);
  const cliPath = psTextLiteral(plan.cliPath);
  const command = psTextLiteral(plan.command);
  const force = plan.force ? "$true" : "$false";
  const trustState = psText(TRUST_STATE_TEXT[plan.trustState]);
  const preCommands = plan.preCommands.map(psTextLiteral);
  const preCommandArray = preCommands.length > 0 ? `@(${preCommands.join(", ")})` : "@()";
  const verificationMessage = psText({
    en: `Confirm API Key Case ${plan.connectionSource?.service === "clerk" ? "Worker version creation" : "deploy"}: ${plan.name} (${plan.scope} scope)${plan.connectionSource ? `; v2 ${approvalSourceLabel(plan.connectionSource.service)} source ${plan.connectionSource.environment}` : ""} to ${plan.target} (${plan.env}).`,
    ja: `API Key Case の${plan.connectionSource?.service === "clerk" ? "Workerバージョン作成" : "配置"}を承認します: ${plan.name}（${plan.scope} スコープ）${plan.connectionSource ? `; v2 ${approvalSourceLabel(plan.connectionSource.service)} 保存元 ${plan.connectionSource.environment}` : ""}→ ${plan.target}（${plan.env}）。`
  });

  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    ...LANGUAGE_PREAMBLE,
    ...buildWindowsUserVerificationScript(),
    `$secretName = ${name}`,
    `$scope = ${scope}`,
    `$target = ${target}`,
    `$environment = ${env}`,
    `$projectDir = ${projectDir}`,
    `$destination = ${destination}`,
    `$cliPath = ${cliPath}`,
    `$command = ${command}`,
    `$force = ${force}`,
    `$trustState = ${trustState}`,
    `$preCommands = ${preCommandArray}`,
    `$verificationMessage = ${verificationMessage}`,
    `$preText = if ($preCommands.Count -gt 0) { [String]::Join([Environment]::NewLine, $preCommands) } else { ${psText({ en: "(none)", ja: "（なし）" })} }`,
    "$script:resultCode = 2",
    "$form = New-Object System.Windows.Forms.Form",
    "$script:form = $form",
    `$form.Text = ${psText(WINDOWS_DIALOG_TEXT.approvalCaption)}`,
    DIALOG_FONT,
    "$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
    "$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog",
    "$form.MaximizeBox = $false",
    "$form.MinimizeBox = $false",
    "$form.ShowInTaskbar = $true",
    "$form.TopMost = $true",
    "$form.ClientSize = New-Object System.Drawing.Size(660, 400)",
    "$title = New-Object System.Windows.Forms.Label",
    "$title.AutoSize = $true",
    "$title.MaximumSize = New-Object System.Drawing.Size(624, 0)",
    "$title.Location = New-Object System.Drawing.Point(18, 16)",
    `$title.Text = ${psText({
      en: "Review the plan, then verify your Windows identity to approve.",
      ja: "内容を確認し、承認する場合は Windows の本人確認を完了してください。"
    })}`,
    "$form.Controls.Add($title)",
    "$details = New-Object System.Windows.Forms.TextBox",
    "$details.Location = New-Object System.Drawing.Point(18, 48)",
    "$details.Size = New-Object System.Drawing.Size(624, 268)",
    "$details.Multiline = $true",
    "$details.ReadOnly = $true",
    "$details.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical",
    "$details.TabStop = $false",
    `$details.Text = (${[
      ...(plan.target === "cloudflare" && plan.connectionSource?.operation !== "cloudflare-version-preparation" ? [
        [psText({en:"This secret put creates a Worker version and deploys it immediately.",ja:"このキー設定はWorkerの新しいバージョンを作り、直ちに配備します。"}), "''"]
      ] : []),
      ...(plan.connectionSource?.service === "clerk" ? [
        [psText({en:"Creates a Worker version using latest remote code, which may change before execution.",ja:"最新のWorkerコードへキーを設定します。実行前にコードが変わる場合があります。"}), "''"],
        [psText({en:"Existing Version URLs may expose this version; it can use existing resources.",ja:"既存のVersion URLから呼べる場合があり、既存リソースを利用できます。"}), "''"],
        [psText({en:"This invocation does not activate production traffic.",ja:"この操作では本番バージョンを切り替えません。"}), "''"]
      ] : []),
      [psText({ en: "Secret name: ", ja: "シークレット名: " }), "$secretName"],
      ...(plan.connectionSource ? [[psText({ en: "Source: ", ja: "保存元: " }),
        psTextLiteral(`v2 ${approvalSourceLabel(plan.connectionSource.service)} / ${plan.connectionSource.environment}`)],
        [psText({ en: "Registration revision: ", ja: "登録リビジョン: " }), psTextLiteral(plan.connectionSource.credentialRevision)]] : []),
      [psText({ en: "Scope: ", ja: "スコープ: " }), "$scope"],
      [psText({ en: "Target: ", ja: "配置先サービス: " }), "$target"],
      [psText({ en: "Destination: ", ja: "配置先: " }), "$destination"],
      [psText({ en: "Destination status: ", ja: "配置先の状態: " }), "$trustState"],
      [psText({ en: "Environment: ", ja: "環境: " }), "$environment"],
      [psText({ en: "Project: ", ja: "プロジェクト: " }), "$projectDir"],
      [psText({ en: "CLI: ", ja: "CLI: " }), "$cliPath"],
      [psText({ en: "Command: ", ja: "コマンド: " }), "$command"],
      [psText({ en: "Force: ", ja: "強制上書き: " }), "$force"],
      [psText({ en: "Pre-step(s):", ja: "事前ステップ:" }), "$preText"]
    ]
      .map(([label, value]) => `${label} + ${value}`)
      .join(" + [Environment]::NewLine + ")})`,
    "$form.Controls.Add($details)",
    "$noButton = New-Object System.Windows.Forms.Button",
    `$noButton.Text = ${psText(WINDOWS_DIALOG_TEXT.declineButton)}`,
    "$noButton.Location = New-Object System.Drawing.Point(454, 340)",
    "$noButton.Size = New-Object System.Drawing.Size(88, 32)",
    "$form.Controls.Add($noButton)",
    "$yesButton = New-Object System.Windows.Forms.Button",
    `$yesButton.Text = ${psText(WINDOWS_DIALOG_TEXT.approveButton)}`,
    "$yesButton.Location = New-Object System.Drawing.Point(554, 340)",
    "$yesButton.Size = New-Object System.Drawing.Size(88, 32)",
    "$form.Controls.Add($yesButton)",
    "$noButton.Add_Click({ $script:resultCode = 2; $script:form.Close() })",
    "$yesButton.Add_Click({",
    "  $script:resultCode = 10",
    "  $yesButton.Enabled = $false",
    "  $noButton.Enabled = $false",
    "  try {",
    "    $verificationResult = Invoke-ApiKeyCaseUserVerification $script:form.Handle $verificationMessage",
    "    switch ($verificationResult) {",
    "      0 { $script:resultCode = 0 }  # Verified",
    "      1 { $script:resultCode = 10 } # DeviceNotPresent",
    "      2 { $script:resultCode = 10 } # NotConfiguredForUser",
    "      3 { $script:resultCode = 10 } # DisabledByPolicy",
    "      4 { $script:resultCode = 10 } # DeviceBusy",
    "      5 { $script:resultCode = 10 } # RetriesExhausted",
    "      6 { $script:resultCode = 2 }  # Canceled",
    "      default { $script:resultCode = 10 }",
    "    }",
    "  } catch {",
    "    $script:resultCode = 10",
    "  } finally {",
    "    $verificationResult = $null",
    "    $script:form.Close()",
    "  }",
    "})",
    "$form.Add_FormClosing({ if ($script:resultCode -ne 0 -and $script:resultCode -ne 10) { $script:resultCode = 2 } })",
    "$form.CancelButton = $noButton",
    // Enter and the initial focus are deny-safe. Approval requires an
    // explicit activation of the Yes button.
    "$form.AcceptButton = $noButton",
    "$form.Add_Shown({ $noButton.Focus() })",
    "$form.ShowDialog() | Out-Null",
    "$form.Dispose()",
    "$preCommands = $null",
    "$preText = $null",
    "$trustState = $null",
    "$verificationMessage = $null",
    "$command = $null",
    "$cliPath = $null",
    "$destination = $null",
    "$projectDir = $null",
    "[Environment]::Exit($script:resultCode)"
  ].join("\n");
}

/** Closed local profile, freshly verified for each foreground session. */
export function buildWindowsLocalApplicationScript(plan: LocalApplicationApproval): string {
  if (!plan || Object.keys(plan).sort().join(",") !== "artifactPath,credentialRevision,environment,interpreterPath,maxDurationMs,projectDir,service" ||
      plan.service !== "resend" || plan.environment !== "development" ||
      !Number.isInteger(plan.maxDurationMs) || plan.maxDurationMs < 1000 || plan.maxDurationMs > 1800000 ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(plan.credentialRevision)) throw new Error("Invalid local application approval.");
  for (const value of [plan.projectDir, plan.artifactPath, plan.interpreterPath]) {
    if (typeof value !== "string" || !pathWin32.isAbsolute(value) || value.length > 1024 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new Error("Invalid local application approval.");
  }
  const rows = [
    psText({ en: "Project: ", ja: "プロジェクト: " }) + " + " + psTextLiteral(plan.projectDir),
    psText({ en: "Application: ", ja: "アプリ: " }) + " + " + psTextLiteral(plan.artifactPath),
    psText({ en: "Node: ", ja: "Node: " }) + " + " + psTextLiteral(plan.interpreterPath),
    psText({ en: "Credential: project / Resend / development / RESEND_API_KEY (v2)", ja: "キー: project / Resend / development / RESEND_API_KEY（v2）" }),
    psText({ en: "Registration revision: ", ja: "登録リビジョン: " }) + " + " + psTextLiteral(plan.credentialRevision),
    psText({ en: `Maximum duration: ${plan.maxDurationMs / 1000} seconds. One session only.`, ja: `最長 ${plan.maxDurationMs / 1000} 秒。この1回だけ実行します。` }),
    psText({ en: "The app and its dependencies can read the key. Trust them and this OS account. Stopping cannot revoke a copied key.", ja: "アプリと依存コードはキーを読めます。このコードとOSユーザーを信頼する場合だけ承認してください。停止してもコピー済みのキーは失効しません。" }),
    psText({ en: "No build, install, restart, app output, or readiness check. Declared inputs are monitored; arbitrary imports are not covered.", ja: "ビルド・インストール・再起動・アプリ出力の転送・動作確認は行いません。宣言済み入力の変更を検知しますが、任意の読み込み先までは確認しません。" })
  ];
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms", "Add-Type -AssemblyName System.Drawing",
    ...LANGUAGE_PREAMBLE, ...buildWindowsUserVerificationScript(),
    "$script:resultCode = 2", "$form = New-Object System.Windows.Forms.Form", "$script:form = $form",
    `$form.Text = ${psText({ en: "API Key Case - Run local application", ja: "API Key Case - ローカルアプリの実行" })}`,
    "$form.Font = New-Object System.Drawing.Font('Yu Gothic UI', 9)",
    "$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi",
    "$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
    "$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog",
    "$form.MaximizeBox = $false", "$form.MinimizeBox = $false", "$form.ShowInTaskbar = $true", "$form.TopMost = $true",
    "$form.ClientSize = New-Object System.Drawing.Size(720, 440)",
    "$details = New-Object System.Windows.Forms.TextBox", "$details.Location = New-Object System.Drawing.Point(18, 18)",
    "$details.Size = New-Object System.Drawing.Size(684, 350)", "$details.Multiline = $true", "$details.ReadOnly = $true",
    "$details.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical", "$details.TabStop = $false",
    `$details.Text = (${rows.join(" + [Environment]::NewLine + [Environment]::NewLine + ")})`, "$form.Controls.Add($details)",
    "$yesButton = New-Object System.Windows.Forms.Button", `$yesButton.Text = ${psText({ en: "Run once", ja: "1回実行" })}`,
    "$yesButton.Location = New-Object System.Drawing.Point(496, 388)", "$yesButton.Size = New-Object System.Drawing.Size(96, 32)",
    "$form.Controls.Add($yesButton)", "$noButton = New-Object System.Windows.Forms.Button",
    `$noButton.Text = ${psText(WINDOWS_DIALOG_TEXT.cancelButton)}`, "$noButton.Location = New-Object System.Drawing.Point(606, 388)",
    "$noButton.Size = New-Object System.Drawing.Size(96, 32)", "$form.Controls.Add($noButton)",
    "$noButton.Add_Click({ $script:resultCode = 2; $script:form.Close() })", "$yesButton.Add_Click({",
    "  $script:resultCode = 10", "  $yesButton.Enabled = $false", "  $noButton.Enabled = $false", "  try {",
    `    $verified = Invoke-ApiKeyCaseUserVerification $script:form.Handle ${psText({ en: "Approve one Resend development session for the displayed local application.", ja: "表示されたローカルアプリへResend開発キーを渡し、1回の実行を承認します。" })}`,
    "    if ($verified -eq 0) { $script:resultCode = 0 } elseif ($verified -eq 6) { $script:resultCode = 2 }",
    "  } catch { $script:resultCode = 10 } finally { $script:form.Close() }", "})",
    "$form.AcceptButton = $noButton", "$form.CancelButton = $noButton", "$form.Add_Shown({ $noButton.Focus() })",
    "$form.ShowDialog() | Out-Null", "$form.Dispose()", "[Environment]::Exit($script:resultCode)"
  ].join("\n");
}

// The Phase E lifecycle dialog. Like the approval dialog it is one-shot: it
// returns an exit status to the single call that opened it and never emits a
// token, a Secret value, or a reusable permission. Deny is the default on
// every close path.
export function buildWindowsRemovalScript(plan: RemovalPlan): string {
  validateRemovalPlan(plan);

  const caption =
    plan.kind === "secret"
      ? WINDOWS_DIALOG_TEXT.deleteSecretCaption
      : WINDOWS_DIALOG_TEXT.forgetDestinationCaption;
  const heading: LocalizedText =
    plan.kind === "secret"
      ? {
          en: "Delete this stored secret? Windows verification is required.",
          ja: "保存されているシークレットを削除しますか？ Windows の本人確認が必要です。"
        }
      : {
          en: "Forget this confirmed deploy destination? Windows verification is required.",
          ja: "承認済みの配置先の記憶を削除しますか？ Windows の本人確認が必要です。"
        };
  const consequence: LocalizedText =
    plan.kind === "secret"
      ? {
          en: "The stored value is deleted from the OS secret store. This cannot be undone; you would have to get the value from the provider again.",
          ja: "保存された値を OS のシークレットストアから削除します。元に戻せません。もう一度必要になったら、発行元から取り直すことになります。"
        }
      : {
          en: "Future deploys to this project/target/environment will require your approval again. No secret is deleted.",
          ja: "今後このプロジェクト／配置先／環境へ配置するときは、再び承認が必要になります。シークレットは削除されません。"
        };
  const details: readonly LocalizedText[] =
    plan.kind === "secret"
      ? [
          { en: `Secret name: ${plan.name}`, ja: `シークレット名: ${plan.name}` },
          { en: `Scope: ${plan.scope}`, ja: `スコープ: ${plan.scope}` },
          ...("environment" in plan ? [
            { en: `Service: ${plan.service}`, ja: `サービス: ${plan.service}` },
            { en: `Environment: ${plan.environment}`, ja: `環境: ${plan.environment}` },
            { en: `Project ID: ${plan.projectId}`, ja: `プロジェクト ID: ${plan.projectId}` }
          ] : []),
          {
            en: `Project: ${plan.projectDir ?? "(user scope: every project on this machine)"}`,
            ja: `プロジェクト: ${plan.projectDir ?? "（ユーザースコープ: このPCのすべてのプロジェクト）"}`
          }
        ]
      : [
          { en: `Target: ${plan.target}`, ja: `配置先サービス: ${plan.target}` },
          { en: `Environment: ${plan.env}`, ja: `環境: ${plan.env}` },
          { en: `Project: ${plan.projectDir}`, ja: `プロジェクト: ${plan.projectDir}` }
        ];

  // Every line is interpolated as its own validated single-quoted literal and
  // joined by PowerShell, so no display string can carry a line break of its
  // own into the script.
  const detailLines: readonly LocalizedText[] = [...details, { en: " ", ja: " " }, consequence];
  const detailArray = (language: keyof LocalizedText): string =>
    `@(${detailLines.map((line) => psTextLiteral(line[language])).join(", ")})`;
  const verificationMessage = psText(
    plan.kind === "secret"
      ? {
          en: `Confirm API Key Case deletion: ${plan.name} (${plan.scope} scope)${"environment" in plan ? `; ${plan.service}, ${plan.environment}, project ${plan.projectId}` : ""}.`,
          ja: `API Key Case の削除を承認します: ${plan.name}（${plan.scope} スコープ）${"environment" in plan ? `; ${plan.service}, ${plan.environment}, プロジェクト ${plan.projectId}` : ""}。`
        }
      : {
          en: `Confirm API Key Case trust removal: ${plan.target} (${plan.env}).`,
          ja: `API Key Case の配置先の記憶の削除を承認します: ${plan.target}（${plan.env}）。`
        }
  );

  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    ...LANGUAGE_PREAMBLE,
    ...buildWindowsUserVerificationScript(),
    `$detailLines = if ($script:akcJa) { ${detailArray("ja")} } else { ${detailArray("en")} }`,
    "$detailText = [String]::Join([Environment]::NewLine, $detailLines)",
    `$verificationMessage = ${verificationMessage}`,
    "$script:resultCode = 2",
    "$form = New-Object System.Windows.Forms.Form",
    "$script:form = $form",
    `$form.Text = ${psText(caption)}`,
    DIALOG_FONT,
    "$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
    "$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog",
    "$form.MaximizeBox = $false",
    "$form.MinimizeBox = $false",
    "$form.ShowInTaskbar = $true",
    "$form.TopMost = $true",
    "$form.ClientSize = New-Object System.Drawing.Size(600, 300)",
    "$title = New-Object System.Windows.Forms.Label",
    "$title.AutoSize = $true",
    "$title.MaximumSize = New-Object System.Drawing.Size(564, 0)",
    "$title.Location = New-Object System.Drawing.Point(18, 16)",
    `$title.Text = ${psText(heading)}`,
    "$form.Controls.Add($title)",
    "$details = New-Object System.Windows.Forms.TextBox",
    "$details.Location = New-Object System.Drawing.Point(18, 48)",
    "$details.Size = New-Object System.Drawing.Size(564, 178)",
    "$details.Multiline = $true",
    "$details.ReadOnly = $true",
    "$details.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical",
    "$details.TabStop = $false",
    "$details.Text = $detailText",
    "$form.Controls.Add($details)",
    "$noButton = New-Object System.Windows.Forms.Button",
    `$noButton.Text = ${psText(WINDOWS_DIALOG_TEXT.declineButton)}`,
    "$noButton.Location = New-Object System.Drawing.Point(394, 250)",
    "$noButton.Size = New-Object System.Drawing.Size(88, 32)",
    "$form.Controls.Add($noButton)",
    "$yesButton = New-Object System.Windows.Forms.Button",
    `$yesButton.Text = ${psText(WINDOWS_DIALOG_TEXT.deleteButton)}`,
    "$yesButton.Location = New-Object System.Drawing.Point(494, 250)",
    "$yesButton.Size = New-Object System.Drawing.Size(88, 32)",
    "$form.Controls.Add($yesButton)",
    "$noButton.Add_Click({ $script:resultCode = 2; $script:form.Close() })",
    "$yesButton.Add_Click({",
    "  $script:resultCode = 10",
    "  $yesButton.Enabled = $false",
    "  $noButton.Enabled = $false",
    "  try {",
    "    $verificationResult = Invoke-ApiKeyCaseUserVerification $script:form.Handle $verificationMessage",
    "    switch ($verificationResult) {",
    "      0 { $script:resultCode = 0 }  # Verified",
    "      1 { $script:resultCode = 10 } # DeviceNotPresent",
    "      2 { $script:resultCode = 10 } # NotConfiguredForUser",
    "      3 { $script:resultCode = 10 } # DisabledByPolicy",
    "      4 { $script:resultCode = 10 } # DeviceBusy",
    "      5 { $script:resultCode = 10 } # RetriesExhausted",
    "      6 { $script:resultCode = 2 }  # Canceled",
    "      default { $script:resultCode = 10 }",
    "    }",
    "  } catch {",
    "    $script:resultCode = 10",
    "  } finally {",
    "    $verificationResult = $null",
    "    $script:form.Close()",
    "  }",
    "})",
    "$form.Add_FormClosing({ if ($script:resultCode -ne 0 -and $script:resultCode -ne 10) { $script:resultCode = 2 } })",
    "$form.CancelButton = $noButton",
    // Enter and the initial focus are deny-safe. Deleting requires an
    // explicit activation of the Delete button.
    "$form.AcceptButton = $noButton",
    "$form.Add_Shown({ $noButton.Focus() })",
    "$form.ShowDialog() | Out-Null",
    "$form.Dispose()",
    "$detailText = $null",
    "$detailLines = $null",
    "$verificationMessage = $null",
    "[Environment]::Exit($script:resultCode)"
  ].join("\n");
}

export function buildWindowsUserVerificationScript(): string[] {
  return [
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "namespace ApiKeyCaseHumanPlane {",
    "  public static class UserConsentVerifierNative {",
    "    private const uint RoInitSingleThreaded = 0;",
    "    private static readonly Guid UserConsentVerifierInteropIid = new Guid(\"39E050C3-4E74-441A-8DC0-B81104DF949C\");",
    "    private static readonly Guid AsyncInfoIid = new Guid(\"00000036-0000-0000-C000-000000000046\");",
    "    [UnmanagedFunctionPointer(CallingConvention.StdCall)]",
    "    private delegate int RequestVerificationForWindowAsyncDelegate(IntPtr self, IntPtr appWindow, IntPtr message, ref Guid iid, out IntPtr operation);",
    "    [UnmanagedFunctionPointer(CallingConvention.StdCall)]",
    "    private delegate int QueryInterfaceDelegate(IntPtr self, ref Guid iid, out IntPtr value);",
    "    [UnmanagedFunctionPointer(CallingConvention.StdCall)]",
    "    private delegate int GetStatusDelegate(IntPtr self, out int status);",
    "    [UnmanagedFunctionPointer(CallingConvention.StdCall)]",
    "    private delegate int GetResultsDelegate(IntPtr self, out int result);",
    "    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
    "    private struct RtlOsVersionInfoEx {",
    "      public uint Size;",
    "      public uint MajorVersion;",
    "      public uint MinorVersion;",
    "      public uint BuildNumber;",
    "      public uint PlatformId;",
    "      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string ServicePack;",
    "      public ushort ServicePackMajor;",
    "      public ushort ServicePackMinor;",
    "      public ushort SuiteMask;",
    "      public byte ProductType;",
    "      public byte Reserved;",
    "    }",
    "    [DllImport(\"ntdll.dll\", CharSet = CharSet.Unicode)]",
    "    private static extern int RtlGetVersion(ref RtlOsVersionInfoEx version);",
    "    [DllImport(\"combase.dll\")]",
    "    private static extern int RoInitialize(uint initType);",
    "    [DllImport(\"combase.dll\")]",
    "    private static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);",
    "    [DllImport(\"combase.dll\", CharSet = CharSet.Unicode)]",
    "    private static extern int WindowsCreateString(string source, uint length, out IntPtr value);",
    "    [DllImport(\"combase.dll\")]",
    "    private static extern int WindowsDeleteString(IntPtr value);",
    "    public static bool IsSupportedBuild(uint minimumBuild) {",
    "      var version = new RtlOsVersionInfoEx();",
    "      version.Size = (uint)Marshal.SizeOf(typeof(RtlOsVersionInfoEx));",
    "      return RtlGetVersion(ref version) >= 0 && version.BuildNumber >= minimumBuild;",
    "    }",
    "    public static IntPtr Begin(IntPtr appWindow, string message, Guid asyncOperationIid) {",
    "      if (appWindow == IntPtr.Zero) throw new ArgumentException(\"An owning window is required.\");",
    "      ThrowIfFailed(RoInitialize(RoInitSingleThreaded));",
    "      IntPtr className = IntPtr.Zero;",
    "      IntPtr messageValue = IntPtr.Zero;",
    "      IntPtr factory = IntPtr.Zero;",
    "      try {",
    "        const string runtimeClass = \"Windows.Security.Credentials.UI.UserConsentVerifier\";",
    "        ThrowIfFailed(WindowsCreateString(runtimeClass, (uint)runtimeClass.Length, out className));",
    "        ThrowIfFailed(WindowsCreateString(message, (uint)message.Length, out messageValue));",
    "        Guid factoryIid = UserConsentVerifierInteropIid;",
    "        ThrowIfFailed(RoGetActivationFactory(className, ref factoryIid, out factory));",
    "        var request = (RequestVerificationForWindowAsyncDelegate)GetVtableDelegate(factory, 6, typeof(RequestVerificationForWindowAsyncDelegate));",
    "        IntPtr operation;",
    "        ThrowIfFailed(request(factory, appWindow, messageValue, ref asyncOperationIid, out operation));",
    "        if (operation == IntPtr.Zero) throw new InvalidOperationException(\"Verification operation was unavailable.\");",
    "        return operation;",
    "      } finally {",
    "        if (factory != IntPtr.Zero) Marshal.Release(factory);",
    "        if (messageValue != IntPtr.Zero) WindowsDeleteString(messageValue);",
    "        if (className != IntPtr.Zero) WindowsDeleteString(className);",
    "      }",
    "    }",
    "    public static int GetStatus(IntPtr operation) {",
    "      IntPtr asyncInfo = IntPtr.Zero;",
    "      try {",
    "        var query = (QueryInterfaceDelegate)GetVtableDelegate(operation, 0, typeof(QueryInterfaceDelegate));",
    "        Guid iid = AsyncInfoIid;",
    "        ThrowIfFailed(query(operation, ref iid, out asyncInfo));",
    "        var getStatus = (GetStatusDelegate)GetVtableDelegate(asyncInfo, 7, typeof(GetStatusDelegate));",
    "        int status;",
    "        ThrowIfFailed(getStatus(asyncInfo, out status));",
    "        return status;",
    "      } finally {",
    "        if (asyncInfo != IntPtr.Zero) Marshal.Release(asyncInfo);",
    "      }",
    "    }",
    "    public static int GetResults(IntPtr operation) {",
    "      var getResults = (GetResultsDelegate)GetVtableDelegate(operation, 8, typeof(GetResultsDelegate));",
    "      int result;",
    "      ThrowIfFailed(getResults(operation, out result));",
    "      return result;",
    "    }",
    "    public static void Release(IntPtr operation) {",
    "      if (operation != IntPtr.Zero) Marshal.Release(operation);",
    "    }",
    "    private static Delegate GetVtableDelegate(IntPtr instance, int slot, Type delegateType) {",
    "      if (instance == IntPtr.Zero) throw new ArgumentNullException(\"instance\");",
    "      IntPtr vtable = Marshal.ReadIntPtr(instance);",
    "      IntPtr entry = Marshal.ReadIntPtr(vtable, slot * IntPtr.Size);",
    "      return Marshal.GetDelegateForFunctionPointer(entry, delegateType);",
    "    }",
    "    private static void ThrowIfFailed(int hresult) {",
    "      if (hresult < 0) Marshal.ThrowExceptionForHR(hresult);",
    "    }",
    "  }",
    "}",
    "'@",
    "function Invoke-ApiKeyCaseUserVerification {",
    "  param([IntPtr]$Window, [string]$Message)",
    `  if (-not [ApiKeyCaseHumanPlane.UserConsentVerifierNative]::IsSupportedBuild(${WINDOWS_USER_VERIFICATION_MIN_BUILD})) { return -1 }`,
    "  $operation = [IntPtr]::Zero",
    "  try {",
    "    $resultType = [Type]::GetType('Windows.Security.Credentials.UI.UserConsentVerificationResult, Windows.Security.Credentials.UI, ContentType=WindowsRuntime', $true)",
    "    $asyncType = [Type]::GetType('Windows.Foundation.IAsyncOperation`1, Windows.Foundation, ContentType=WindowsRuntime', $true).MakeGenericType([Type[]]@($resultType))",
    "    $operation = [ApiKeyCaseHumanPlane.UserConsentVerifierNative]::Begin($Window, $Message, $asyncType.GUID)",
    "    $status = [ApiKeyCaseHumanPlane.UserConsentVerifierNative]::GetStatus($operation)",
    "    while ($status -eq 0) {",
    "      [System.Windows.Forms.Application]::DoEvents()",
    "      [System.Threading.Thread]::Sleep(25)",
    "      $status = [ApiKeyCaseHumanPlane.UserConsentVerifierNative]::GetStatus($operation)",
    "    }",
    "    if ($status -ne 1) { return -1 }",
    "    return [ApiKeyCaseHumanPlane.UserConsentVerifierNative]::GetResults($operation)",
    "  } catch {",
    "    return -1",
    "  } finally {",
    "    if ($operation -ne [IntPtr]::Zero) { [ApiKeyCaseHumanPlane.UserConsentVerifierNative]::Release($operation) }",
    "  }",
    "}"
  ];
}

function validateRemovalPlan(plan: RemovalPlan): void {
  if (plan.kind === "secret") {
    assertValidSecretName(plan.name);
    if (plan.scope !== "user" && plan.scope !== "project") {
      throw new Error("Invalid removal scope.");
    }
    if (plan.scope === "user" && (plan.projectId !== null || plan.projectDir !== null)) {
      throw new Error("Invalid user-scoped removal plan.");
    }
    if (plan.scope === "project" &&
        (!/^[0-9a-f]{16}$/.test(plan.projectId ?? "") || !plan.projectDir)) {
      throw new Error("Invalid project-scoped removal plan.");
    }
    psLiteral(toAccount(plan));
    if (plan.projectDir !== null) psTextLiteral(plan.projectDir);
    return;
  }

  if (plan.kind !== "destination-trust") {
    throw new Error("Invalid removal plan.");
  }
  if (!(plan.target === "cloudflare" || plan.target === "vercel" || plan.target === "github") ||
      !/^(production|preview|development)$/.test(plan.env)) {
    throw new Error("Invalid removal target or environment.");
  }
  if (!plan.projectDir) {
    throw new Error("Invalid removal display data.");
  }
  psTextLiteral(plan.projectDir);
}

function validateSecretInputRequest(request: SecretInputRequest): void {
  if (!request || typeof request !== "object") {
    throw new Error("Invalid Secret input request.");
  }
  assertValidSecretName(request.name);
  if (request.scope !== "user" && request.scope !== "project") {
    throw new Error("Invalid Secret scope.");
  }
  if (request.scope === "user" && (request.projectId !== null || request.projectDir !== null)) {
    throw new Error("Invalid user-scoped Secret reference.");
  }
  if (
    request.scope === "project" &&
    (!/^[0-9a-f]{16}$/.test(request.projectId ?? "") ||
      typeof request.projectDir !== "string" ||
      !request.projectDir)
  ) {
    throw new Error("Invalid project-scoped Secret reference.");
  }
  psLiteral(toAccount(request));
  if (request.projectDir !== null) psTextLiteral(request.projectDir);
}

function psLiteral(value: string): string {
  if (!/^[A-Za-z0-9_|-]+$/.test(value)) {
    throw new Error("Unsafe Human Plane label.");
  }
  return `'${value}'`;
}

function psTextLiteral(value: string): string {
  if (!value || /[\r\n\0]/.test(value)) {
    throw new Error("Unsafe Human Plane text.");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

// Both languages are emitted; the helper picks one at run time from the OS
// user profile. Each side is validated as its own single-quoted literal.
function psText(text: LocalizedText): string {
  return `(Get-AkcText ${psTextLiteral(text.en)} ${psTextLiteral(text.ja)})`;
}

function validateApprovalPlan(plan: ApprovalPlan): void {
  assertApprovalConnectionSource(plan);
  assertValidSecretName(plan.name);
  if (plan.scope !== "user" && plan.scope !== "project") {
    throw new Error("Invalid approval scope.");
  }
  if (plan.scope === "user" && plan.projectId !== null) {
    throw new Error("Invalid user-scoped approval plan.");
  }
  if (plan.scope === "project" && !/^[0-9a-f]{16}$/.test(plan.projectId ?? "")) {
    throw new Error("Invalid project-scoped approval plan.");
  }
  if (!(plan.target === "cloudflare" || plan.target === "vercel" || plan.target === "github") ||
      !/^(production|preview|development)$/.test(plan.env)) {
    throw new Error("Invalid approval target or environment.");
  }
  if (!plan.projectDir || !plan.destination || !plan.cliPath || !plan.command || plan.preCommands.some((item) => !item)) {
    throw new Error("Invalid approval display data.");
  }
  if (!Object.prototype.hasOwnProperty.call(TRUST_STATE_TEXT, plan.trustState)) {
    throw new Error("Invalid approval trust state.");
  }
  // Validate all displayed values before interpolating them into a
  // single-quoted PowerShell literal. No command or path is shell-parsed.
  psTextLiteral(plan.projectDir);
  psTextLiteral(plan.destination);
  psTextLiteral(plan.cliPath);
  psTextLiteral(plan.command);
  for (const preCommand of plan.preCommands) psTextLiteral(preCommand);
}

function launchHelper(request: HumanPlaneHelperRequest): Promise<number | null> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolvePromise(code);
    };

    try {
      const child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        detached: request.detached,
        env: request.env,
        shell: request.shell,
        stdio: request.stdio,
        windowsHide: request.windowsHide
      });
      child.once("error", () => settle(null));
      child.once("exit", (code) => settle(code));
    } catch {
      settle(null);
    }
  });
}
