import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";

import { assertValidSecretName } from "../vault/types.js";
import { toAccount, VAULT_SERVICE } from "../vault/naming.js";
import type { ApprovalPlan, ApprovalTrustState } from "../deploy/types.js";
import type {
  HumanApprovalStatus,
  HumanPlane,
  HumanSecretInputStatus,
  RemovalPlan,
  SecretInputRequest
} from "./types.js";

/** The only executable that may host the macOS Human Plane. */
export const MACOS_OSASCRIPT_PATH = "/usr/bin/osascript";

export interface MacOSHumanPlaneHelperRequest {
  executable: string;
  args: string[];
  cwd: "/usr/bin";
  env: Record<string, string>;
  detached: false;
  shell: false;
  stdio: "ignore";
}

export type MacOSHumanPlaneHelperLauncher = (
  request: MacOSHumanPlaneHelperRequest
) => Promise<number | null>;

const TRUST_STATE_TEXT: Readonly<Record<ApprovalTrustState, string>> = Object.freeze({
  "first-use": "first use of this destination on this machine",
  changed: "CHANGED since the last time you approved this project/target/environment",
  "always-approve": "this operation always requires approval"
});

/**
 * Resolve only the fixed, system-owned JXA helper.
 *
 * The real path must remain exactly `/usr/bin/osascript`: a symlink, a
 * repository-provided replacement, or a writable executable is never a Human
 * Plane. The caller receives no alternate path on failure.
 */
export function resolveMacOSOsascript(): string | null {
  try {
    const resolved = realpathSync.native(MACOS_OSASCRIPT_PATH);
    if (resolved !== MACOS_OSASCRIPT_PATH) return null;

    const stats = statSync(resolved);
    if (stats.uid !== 0 || !stats.isFile()) return null;
    if ((stats.mode & 0o022) !== 0) return null;
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

export class MacOSHumanPlane implements HumanPlane {
  constructor(
    private readonly helperPath: string | null,
    private readonly launch: MacOSHumanPlaneHelperLauncher = launchHelper
  ) {}

  capability(): "os-dialog" | "handoff-only" {
    return this.helperPath ? "os-dialog" : "handoff-only";
  }

  async askSecret(request: SecretInputRequest): Promise<HumanSecretInputStatus> {
    if (!this.helperPath) return "unavailable";
    validateSecretInputRequest(request);

    const script = buildMacOSSecretInputScript(request);
    let exitCode: number | null;
    try {
      exitCode = await this.launch(this.createRequest(script));
    } catch {
      return "unavailable";
    }
    if (exitCode === 0) return "saved";
    if (exitCode === 2) return "cancelled";
    return "unavailable";
  }

  async askApproval(plan: ApprovalPlan): Promise<HumanApprovalStatus> {
    if (!this.helperPath) return "unavailable";
    validateApprovalPlan(plan);

    const script = buildMacOSApprovalScript(plan);
    let exitCode: number | null;
    try {
      exitCode = await this.launch(this.createRequest(script));
    } catch {
      return "unavailable";
    }
    if (exitCode === 0) return "approved";
    if (exitCode === 2) return "declined";
    return "unavailable";
  }

  async askRemoval(plan: RemovalPlan): Promise<HumanApprovalStatus> {
    if (!this.helperPath) return "unavailable";
    validateRemovalPlan(plan);

    const script = buildMacOSRemovalScript(plan);
    let exitCode: number | null;
    try {
      exitCode = await this.launch(this.createRequest(script));
    } catch {
      return "unavailable";
    }
    if (exitCode === 0) return "approved";
    if (exitCode === 2) return "declined";
    return "unavailable";
  }

  private createRequest(script: string): MacOSHumanPlaneHelperRequest {
    if (!this.helperPath) {
      throw new Error("Human Plane helper is unavailable.");
    }

    return {
      executable: this.helperPath,
      args: ["-l", "JavaScript", "-e", script],
      cwd: "/usr/bin",
      // A fresh empty allowlist: no Agent-controlled PATH, flags, provider
      // credentials, or runtime injection variables reach the helper.
      env: {},
      detached: false,
      shell: false,
      stdio: "ignore"
    };
  }
}

/**
 * Build the one-shot JXA secret dialog. The only Secret-bearing operation in
 * this source is the helper-local `field.stringValue` read. The parent gets an
 * exit code, while Security.framework receives the value directly in this
 * same `osascript` process.
 */
export function buildMacOSSecretInputScript(request: SecretInputRequest): string {
  validateSecretInputRequest(request);

  const secretName = jxaStringLiteral(request.name);
  const account = jxaStringLiteral(toAccount(request));
  const service = jxaStringLiteral(VAULT_SERVICE);
  const destinationLabel = jxaStringLiteral(
    request.scope === "project"
      ? "Registration destination: This project"
      : "Registration destination: Current user (shared across projects)"
  );
  const projectDir = jxaStringLiteral(request.projectDir ?? "");

  return [
    "ObjC.import('AppKit');",
    "ObjC.import('Foundation');",
    "ObjC.import('Security');",
    "ObjC.import('stdlib');",
    `const secretName = ${secretName};`,
    `const account = ${account};`,
    `const service = ${service};`,
    `const destinationLabel = ${destinationLabel};`,
    `const projectDir = ${projectDir};`,
    "const app = $.NSApplication.sharedApplication;",
    "app.setActivationPolicy($.NSApplicationActivationPolicyRegular);",
    "app.activateIgnoringOtherApps(true);",
    "const alert = $.NSAlert.alloc.init;",
    "alert.messageText = 'API Key Case - Secret Input';",
    "const destination = destinationLabel + (projectDir ? '\\n' + projectDir : '');",
    "alert.informativeText = 'Enter the value for ' + secretName + '.\\n\\n' + destination + '\\n\\nIt will be stored directly in the macOS Keychain.';",
    "const field = $.NSSecureTextField.alloc.initWithFrame($.NSMakeRect(0, 0, 360, 24));",
    "field.placeholderString = 'Secret value';",
    "alert.accessoryView = field;",
    "alert.addButtonWithTitle('Save');",
    "alert.addButtonWithTitle('Cancel');",
    "alert.window.initialFirstResponder = field;",
    "const response = alert.runModal;",
    "if (Number(response) !== Number($.NSAlertFirstButtonReturn)) {",
    "  field.stringValue = '';",
    "  $.exit(2);",
    "}",
    "let value = ObjC.unwrap(field.stringValue);",
    "if (value.length === 0 || /^\\s*$/.test(value)) {",
    "  field.stringValue = '';",
    "  $.exit(2);",
    "}",
    "let resultCode = 10;",
    "let valueData = null;",
    "try {",
    "  valueData = $.NSString.stringWithString(value).dataUsingEncoding($.NSUTF8StringEncoding);",
    "  if (!valueData) throw new Error('Secret encoding failed.');",
    "  const item = $.NSMutableDictionary.alloc.init;",
    "  item.setObjectForKey($.kSecClassGenericPassword, $.kSecClass);",
    "  item.setObjectForKey($.NSString.stringWithString(service), $.kSecAttrService);",
    "  item.setObjectForKey($.NSString.stringWithString(account), $.kSecAttrAccount);",
    "  item.setObjectForKey(valueData, $.kSecValueData);",
    "  const query = $.NSMutableDictionary.alloc.init;",
    "  query.setObjectForKey($.kSecClassGenericPassword, $.kSecClass);",
    "  query.setObjectForKey($.NSString.stringWithString(service), $.kSecAttrService);",
    "  query.setObjectForKey($.NSString.stringWithString(account), $.kSecAttrAccount);",
    "  const update = $.NSMutableDictionary.alloc.init;",
    "  update.setObjectForKey(valueData, $.kSecValueData);",
    "  let status = Number($.SecItemUpdate(query, update));",
    "  if (status === Number($.errSecItemNotFound)) status = Number($.SecItemAdd(item, null));",
    "  if (status === Number($.errSecSuccess)) resultCode = 0;",
    "} catch (_) {",
    "  resultCode = 10;",
    "}",
    "field.stringValue = '';",
    "value = '';",
    "valueData = null;",
    "$.exit(resultCode);"
  ].join("\n");
}

/** Build the one-shot, deny-by-default approval dialog. */
export function buildMacOSApprovalScript(plan: ApprovalPlan): string {
  validateApprovalPlan(plan);

  const preCommandLiterals = plan.preCommands.map(jxaStringLiteral).join(", ");

  return [
    "ObjC.import('AppKit');",
    "ObjC.import('Foundation');",
    "ObjC.import('Security');",
    "ObjC.import('stdlib');",
    `const secretName = ${jxaStringLiteral(plan.name)};`,
    `const scope = ${jxaStringLiteral(plan.scope)};`,
    `const target = ${jxaStringLiteral(plan.target)};`,
    `const environment = ${jxaStringLiteral(plan.env)};`,
    `const projectId = ${jxaStringLiteral(plan.projectId ?? "(user scope)")};`,
    `const projectDir = ${jxaStringLiteral(plan.projectDir)};`,
    `const destination = ${jxaStringLiteral(plan.destination)};`,
    `const cliPath = ${jxaStringLiteral(plan.cliPath)};`,
    `const command = ${jxaStringLiteral(plan.command)};`,
    `const force = ${plan.force ? "true" : "false"};`,
    `const trustState = ${jxaStringLiteral(TRUST_STATE_TEXT[plan.trustState])};`,
    `const preCommands = [${preCommandLiterals}];`,
    "const app = $.NSApplication.sharedApplication;",
    "app.setActivationPolicy($.NSApplicationActivationPolicyRegular);",
    "app.activateIgnoringOtherApps(true);",
    "const alert = $.NSAlert.alloc.init;",
    "alert.messageText = 'API Key Case - Approve Operation';",
    "alert.informativeText = [",
    "  'A high-risk operation needs your approval.',",
    "  '',",
    "  'Secret name: ' + secretName,",
    "  'Scope: ' + scope,",
    "  'Target: ' + target,",
    "  'Environment: ' + environment,",
    "  'Project ID: ' + projectId,",
    "  'Project: ' + projectDir,",
    "  'Destination: ' + destination,",
    "  'Destination status: ' + trustState,",
    "  'CLI: ' + cliPath,",
    "  'Command: ' + command,",
    "  'Force overwrite: ' + (force ? 'yes' : 'no'),",
    "  'Pre-step(s): ' + (preCommands.length > 0 ? preCommands.join('\\n') : '(none)'),",
    "  '',",
    "  'Choose No unless you have reviewed every line.'",
    "].join('\\n');",
    "alert.addButtonWithTitle('No');",
    "alert.addButtonWithTitle('Yes');",
    "const noButton = alert.buttons.objectAtIndex(0);",
    "noButton.keyEquivalent = '\\r';",
    "alert.window.initialFirstResponder = noButton;",
    "const response = alert.runModal;",
    "$.exit(Number(response) === Number($.NSAlertSecondButtonReturn) ? 0 : 2);"
  ].join("\n");
}

/** Build the one-shot, deny-by-default lifecycle removal dialog. */
export function buildMacOSRemovalScript(plan: RemovalPlan): string {
  validateRemovalPlan(plan);

  const isSecret = plan.kind === "secret";
  const title = isSecret
    ? "API Key Case - Delete Secret"
    : "API Key Case - Forget Destination";
  const heading = isSecret
    ? "Delete this stored secret?"
    : "Forget this confirmed deploy destination?";
  const consequence = isSecret
    ? "The stored value is deleted from the OS secret store. This cannot be undone; you would have to get the value from the provider again."
    : "Future deploys to this project/target/environment will require your approval again. No secret is deleted.";
  const detailLines = isSecret
    ? [
        `Secret name: ${plan.name}`,
        `Scope: ${plan.scope}`,
        `Project: ${plan.projectDir ?? "(user scope: every project on this machine)"}`,
        "",
        consequence
      ]
    : [
        `Target: ${plan.target}`,
        `Environment: ${plan.env}`,
        `Project: ${plan.projectDir}`,
        "",
        consequence
      ];

  return [
    "ObjC.import('AppKit');",
    "ObjC.import('Foundation');",
    "ObjC.import('Security');",
    "ObjC.import('stdlib');",
    `const title = ${jxaStringLiteral(title)};`,
    `const heading = ${jxaStringLiteral(heading)};`,
    `const detailLines = [${detailLines.map(jxaStringLiteral).join(", ")}];`,
    "const app = $.NSApplication.sharedApplication;",
    "app.setActivationPolicy($.NSApplicationActivationPolicyRegular);",
    "app.activateIgnoringOtherApps(true);",
    "const alert = $.NSAlert.alloc.init;",
    "alert.messageText = title;",
    "alert.informativeText = [heading, ''].concat(detailLines).join('\\n');",
    "alert.addButtonWithTitle('No');",
    "alert.addButtonWithTitle('Delete');",
    "const noButton = alert.buttons.objectAtIndex(0);",
    "noButton.keyEquivalent = '\\r';",
    "alert.window.initialFirstResponder = noButton;",
    "const response = alert.runModal;",
    "$.exit(Number(response) === Number($.NSAlertSecondButtonReturn) ? 0 : 2);"
  ].join("\n");
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
  jxaStringLiteral(toAccount(request));
  if (request.projectDir !== null) jxaStringLiteral(request.projectDir);
}

function validateApprovalPlan(plan: ApprovalPlan): void {
  if (!plan || typeof plan !== "object") {
    throw new Error("Invalid approval plan.");
  }
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
  if (
    !(plan.target === "cloudflare" || plan.target === "vercel" || plan.target === "github") ||
    !/^(production|preview|development)$/.test(plan.env)
  ) {
    throw new Error("Invalid approval target or environment.");
  }
  if (typeof plan.force !== "boolean") {
    throw new Error("Invalid approval overwrite flag.");
  }
  if (
    typeof plan.projectDir !== "string" ||
    typeof plan.destination !== "string" ||
    typeof plan.cliPath !== "string" ||
    typeof plan.command !== "string" ||
    !plan.projectDir ||
    !plan.destination ||
    !plan.cliPath ||
    !plan.command ||
    !Array.isArray(plan.preCommands) ||
    plan.preCommands.some((item) => typeof item !== "string" || !item)
  ) {
    throw new Error("Invalid approval display data.");
  }
  if (!Object.prototype.hasOwnProperty.call(TRUST_STATE_TEXT, plan.trustState)) {
    throw new Error("Invalid approval trust state.");
  }

  jxaStringLiteral(plan.name);
  jxaStringLiteral(plan.scope);
  jxaStringLiteral(plan.target);
  jxaStringLiteral(plan.env);
  jxaStringLiteral(plan.projectId ?? "(user scope)");
  jxaStringLiteral(plan.projectDir);
  jxaStringLiteral(plan.destination);
  jxaStringLiteral(plan.cliPath);
  jxaStringLiteral(plan.command);
  jxaStringLiteral(TRUST_STATE_TEXT[plan.trustState]);
  for (const preCommand of plan.preCommands) jxaStringLiteral(preCommand);
}

function validateRemovalPlan(plan: RemovalPlan): void {
  if (!plan || typeof plan !== "object") {
    throw new Error("Invalid removal plan.");
  }

  if (plan.kind === "secret") {
    assertValidSecretName(plan.name);
    if (plan.scope !== "user" && plan.scope !== "project") {
      throw new Error("Invalid removal scope.");
    }
    if (plan.scope === "user" && (plan.projectId !== null || plan.projectDir !== null)) {
      throw new Error("Invalid user-scoped removal plan.");
    }
    if (
      plan.scope === "project" &&
      (!/^[0-9a-f]{16}$/.test(plan.projectId ?? "") ||
        typeof plan.projectDir !== "string" ||
        !plan.projectDir)
    ) {
      throw new Error("Invalid project-scoped removal plan.");
    }
    if (plan.projectDir !== null) jxaStringLiteral(plan.projectDir);
    return;
  }

  if (plan.kind !== "destination-trust") {
    throw new Error("Invalid removal plan.");
  }
  if (
    !(plan.target === "cloudflare" || plan.target === "vercel" || plan.target === "github") ||
    !/^(production|preview|development)$/.test(plan.env)
  ) {
    throw new Error("Invalid removal target or environment.");
  }
  if (typeof plan.projectDir !== "string" || !plan.projectDir) {
    throw new Error("Invalid removal display data.");
  }
  jxaStringLiteral(plan.projectDir);
}

/** JSON is the only interpolation boundary for display/account identifiers. */
function jxaStringLiteral(value: string): string {
  if (typeof value !== "string" || /[\r\n\0\u2028\u2029]/.test(value)) {
    throw new Error("Unsafe Human Plane text.");
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Unsafe Human Plane text.");
  }
  return encoded;
}

function launchHelper(request: MacOSHumanPlaneHelperRequest): Promise<number | null> {
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
        stdio: request.stdio
      });
      child.once("error", () => settle(null));
      child.once("exit", (code) => settle(code));
    } catch {
      settle(null);
    }
  });
}
