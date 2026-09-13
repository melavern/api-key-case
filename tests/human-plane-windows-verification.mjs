import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { release } from "node:os";
import {
  WINDOWS_DIALOG_TEXT,
  WINDOWS_POWERSHELL_PATH,
  WINDOWS_USER_VERIFICATION_MIN_BUILD,
  WindowsHumanPlane
} from "../dist/core/human/windows.js";
import {
  VERIFICATION_MODES, assertActuationDecision, assertProcessEvidence,
  buildMsaaAttacker, buildMsaaControl, observeProcess, runVerificationMode
} from "./helpers/windows-verification.mjs";

const mode = process.argv[2];
if (!VERIFICATION_MODES.has(mode)) {
  console.error("usage: node tests/human-plane-windows-verification.mjs <probe|verified|cancel|unconfigured|attack>");
  process.exit(2);
}
if (process.platform !== "win32") {
  console.log("skipping Windows user-verification e2e: not running on Windows");
  process.exit(0);
}

const activeHelpers = new Set();
let productHelper;
const plane = new WindowsHumanPlane(WINDOWS_POWERSHELL_PATH, launchTrackedHelper);
const approvalPlan = {
  name: "AKC_WINDOWS_VERIFICATION_CANARY",
  scope: "project",
  projectId: "0123456789abcdef",
  target: "cloudflare",
  env: "production",
  force: false,
  projectDir: "C:/api-key-case-verification-canary",
  destination: "worker:verification-canary",
  cliPath: "C:/api-key-case-verification-canary/wrangler.cmd",
  command: "wrangler secret put AKC_WINDOWS_VERIFICATION_CANARY --env production",
  preCommands: [],
  trustState: "always-approve"
};
const removalPlan = {
  kind: "secret",
  name: "AKC_WINDOWS_VERIFICATION_CANARY",
  scope: "user",
  projectId: null,
  projectDir: null
};

// os.release() is a Node API; process.getSystemVersion() is Electron-only.
console.log(`Windows ${release()}; interop minimum build ${WINDOWS_USER_VERIFICATION_MIN_BUILD}.`);
console.log("This harness uses canary plans only. It does not deploy or delete anything.");

try {
  await runVerificationMode(mode, {
    probe: runProbe,
    verified: async () => {
      console.log("For each dialog: review it, select the affirmative button, then complete Windows verification.");
      await assertManualDecision(() => plane.askApproval(approvalPlan), "approved");
      await assertManualDecision(() => plane.askRemoval(removalPlan), "approved");
    },
    cancel: async () => {
      console.log("For each dialog: select the affirmative button, then cancel the Windows verification prompt.");
      await assertManualDecision(() => plane.askApproval(approvalPlan), "declined");
      await assertManualDecision(() => plane.askRemoval(removalPlan), "declined");
    },
    unconfigured: async () => {
      console.log("Run only in an account with Windows verification not configured.");
      await runProductActuations("unavailable");
    },
    attack: async () => {
      console.log("The sibling invokes only the test helper's Yes/Delete button through MSAA. Do not authenticate; cancel each OS verification prompt when it appears.");
      await runProductActuations("declined");
    }
  });
  console.log(mode === "probe"
    ? "Windows MSAA driver positive controls passed; this is not a product approval result"
    : `Windows user-verification ${mode} e2e passed`);
} finally {
  for (const child of activeHelpers) child.kill();
}

async function runProbe() {
  console.log("Checking the driver against unprotected dummy Yes/Delete buttons. Do not click these controls yourself.");
  for (const buttonName of ["Yes", "Delete"]) {
    const caption = `API Key Case - MSAA Control ${process.pid} ${buttonName}`;
    const control = spawnPowerShell(buildMsaaControl(caption, buttonName));
    const controlResult = observeProcess(control, { label: "MSAA control", timeoutMs: 30_000, activeChildren: activeHelpers });
    await Promise.all([
      controlResult.then((result) => assertProcessEvidence(result, "control-clicked")),
      runMsaaAttacker(caption, buttonName, control.pid, 30_000)
        .then((result) => assertProcessEvidence(result, "action-returned"))
    ]);
    console.log(`MSAA ${buttonName} positive control passed`);
  }
}

async function runProductActuations(expected) {
  // The dialog language follows the OS user profile, so the driver is handed
  // both spellings rather than assuming this host renders English.
  await assertMsaaDecision(
    bothLanguages(WINDOWS_DIALOG_TEXT.approvalCaption),
    bothLanguages(WINDOWS_DIALOG_TEXT.approveButton),
    () => plane.askApproval(approvalPlan),
    expected
  );
  await assertMsaaDecision(
    bothLanguages(WINDOWS_DIALOG_TEXT.deleteSecretCaption),
    bothLanguages(WINDOWS_DIALOG_TEXT.deleteButton),
    () => plane.askRemoval(removalPlan),
    expected
  );
}

function bothLanguages(text) {
  return [text.en, text.ja];
}

async function assertMsaaDecision(caption, buttonName, start, expected) {
  productHelper = undefined;
  await assertActuationDecision({
    startDecision: start,
    startAttacker: () => runMsaaAttacker(caption, buttonName, productHelper?.pid),
    expected
  });
}

async function assertManualDecision(start, expected) {
  // The tracked product helper has its own timeout and returns unavailable on
  // timeout/crash. Neither can satisfy an expected approved/declined result.
  assert.equal(await start(), expected, "unexpected Human Plane decision");
}

function launchTrackedHelper(request) {
  try {
    productHelper = spawn(request.executable, request.args, {
      cwd: request.cwd, detached: request.detached, env: request.env,
      shell: request.shell, stdio: request.stdio, windowsHide: request.windowsHide
    });
    return observeProcess(productHelper, {
      label: "Human Plane helper", timeoutMs: 120_000, activeChildren: activeHelpers
    }).then((result) => {
      if (result.kind !== "exited" || ![0, 2, 10].includes(result.code)) {
        console.error(JSON.stringify(result));
      }
      return result.kind === "exited" ? result.code : null;
    });
  } catch {
    return Promise.resolve(null);
  }
}

function spawnPowerShell(script) {
  return spawn(WINDOWS_POWERSHELL_PATH, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")
  ], {
    cwd: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false
  });
}

async function runMsaaAttacker(caption, buttonName, targetPid, timeoutMs = 120_000) {
  const script = buildMsaaAttacker(caption, buttonName, targetPid);
  for (const forbidden of ["SendInput", "keybd_event", "mouse_event", "SendKeys", "PostMessage", "SetWindowText"]) {
    assert.equal(script.includes(forbidden), false, `attack harness unexpectedly uses ${forbidden}`);
  }
  return observeProcess(spawnPowerShell(script), {
    label: "MSAA attacker", timeoutMs, activeChildren: activeHelpers
  });
}
