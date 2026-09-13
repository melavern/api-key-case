// Windows Human Plane secret-input acceptance harness.
//
// Test infrastructure only. It drives the product's own dialog through the
// shared Win32 test driver and adds nothing to the product: no test bypass, no
// Secret read API, no relaxed boundary. See
// tests/helpers/windows-secret-input-driver.mjs for how controls are located.
//
// Covered here:
//   1. user scope shows the Secret name and the user-scope destination, and no
//      project path
//   2. a real Human Plane save reaches Windows Credential Manager
//   3. the 2560-byte UTF-16 Credential Blob boundary, including whole refusal
//      above it
//
// Every synthetic name this file may create is removed again on the way out,
// whatever the outcome.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
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
  WINDOWS_CREDENTIAL_BLOB_MAX_BYTES,
  WINDOWS_DIALOG_TEXT,
  WINDOWS_POWERSHELL_PATH,
  buildWindowsSecretInputScript
} from "../dist/core/human/windows.js";
import { createVault, removeSecret } from "../dist/core/vault/index.js";
import { buildSecretInputDriver } from "./helpers/windows-secret-input-driver.mjs";

if (process.platform !== "win32") {
  console.log("skipping Windows Human Plane secret-input acceptance: not running on Windows");
  process.exit(0);
}

const cliPath = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "api-key-case-secret-input-"));
const driverTemp = mkdtempSync(join(tmpdir(), "api-key-case-driver-"));

// Every name this harness may create in the real Credential Manager. Cleanup
// walks this list whatever the outcome.
const NAMES = {
  userScope: "AKC_HP_USER_SCOPE_DISPLAY_E2E",
  shortSave: "AKC_HP_SAVE_SHORT_E2E",
  bytes2558: "AKC_HP_SAVE_2558_E2E",
  bytes2560: "AKC_HP_SAVE_2560_E2E",
  bytes2562: "AKC_HP_SAVE_2562_E2E"
};

// ASCII only, so one character is exactly one UTF-16 code unit (2 bytes).
const SYNTHETIC_PREFIX = ["akc", "synthetic", "fixture"].join("-") + "-";
function syntheticValue(byteCount) {
  assert.equal(byteCount % 2, 0, "UTF-16 fixtures are sized in whole code units");
  const characters = byteCount / 2;
  assert.ok(characters > SYNTHETIC_PREFIX.length, "fixture is too short to be distinguishable");
  return SYNTHETIC_PREFIX + "a".repeat(characters - SYNTHETIC_PREFIX.length);
}

// One single-quoted PowerShell literal, as emitted by the product's own script
// builder. Used to read the expected display text back out of that script.
const PS_LITERAL = "'((?:[^']|'')*)'";

const MAX = WINDOWS_CREDENTIAL_BLOB_MAX_BYTES;
assert.equal(MAX, 2560, "the product's Credential Blob limit changed; re-derive these fixtures");

const results = [];
let failed = false;

try {
  await userScopeDisplay();
  await realSave();
  await boundary(NAMES.bytes2558, MAX - 2, "accept");
  await boundary(NAMES.bytes2560, MAX, "accept");
  await boundary(NAMES.bytes2562, MAX + 2, "refuse");
} catch (error) {
  failed = true;
  console.error(error?.stack ?? String(error));
} finally {
  await cleanup();
  rmSync(root, { recursive: true, force: true });
  rmSync(driverTemp, { recursive: true, force: true });
}

console.log("");
for (const line of results) console.log(line);
if (failed) process.exit(1);
console.log("Windows Human Plane secret-input acceptance passed");

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

// 1. User scope shows the Secret name and the user-scope destination, and does
//    not show a project path. Closing with the product's Cancel button leaves
//    nothing stored.
async function userScopeDisplay() {
  const name = NAMES.userScope;
  const expected = destinationLabels(
    buildWindowsSecretInputScript({ name, scope: "user", projectId: null, projectDir: null })
  );
  const projectLabels = destinationLabels(
    buildWindowsSecretInputScript({
      name,
      scope: "project",
      projectId: "0123456789abcdef",
      projectDir: root
    })
  );

  const run = await drive({ name, mode: "inspect" });
  assert.equal(run.driver.code, 0, run.diagnostics);

  const controls = run.report.controls;
  const texts = controls.filter((control) => control.text).map((control) => control.text);

  const password = controls.filter((control) => control.isPassword);
  assert.equal(password.length, 1, "expected exactly one ES_PASSWORD field");
  assert.equal(password[0].isEdit, true, "the Secret field must be an EDIT control");

  const destination = controls.filter(
    (control) => control.isEdit && control.isReadOnly && control.isMultiline && !control.isPassword
  );
  assert.equal(destination.length, 1, "expected exactly one read-only destination field");
  const destinationText = destination[0].text;
  assert.ok(
    destinationText === expected.en || destinationText === expected.ja,
    `destination field did not carry the product's user-scope text: ${JSON.stringify(destinationText)}`
  );

  assert.ok(
    texts.some((text) => text.includes(name)),
    "the dialog did not show the Secret name"
  );
  for (const text of texts) {
    assert.equal(text.includes(root), false, `a project path was shown: ${JSON.stringify(text)}`);
    assert.equal(
      text.includes(projectLabels.en) || text.includes(projectLabels.ja),
      false,
      `the project-scope destination line was shown: ${JSON.stringify(text)}`
    );
  }

  assert.ok(
    controls.some((control) => control.isButton && labelled(control, WINDOWS_DIALOG_TEXT.saveButton)),
    "the Save button was not present"
  );
  assert.ok(
    controls.some((control) => control.isButton && labelled(control, WINDOWS_DIALOG_TEXT.cancelButton)),
    "the Cancel button was not present"
  );

  assert.equal(run.cli.code, 4, run.cli.stderr);
  assert.match(run.cli.stderr, /cancelled; nothing was saved/);
  assert.equal(checkStatus(name), "missing");
  results.push("User scope display: PASS");
  results.push("Cancel / non-leak (re-observed): PASS");
}

// 2. A real Human Plane save reaches Windows Credential Manager, and the
//    fixture value never reaches this process, the CLI output or the project.
async function realSave() {
  const name = NAMES.shortSave;
  const value = syntheticValue(64);
  const run = await drive({ name, mode: "save", value });

  assert.equal(run.driver.code, 0, run.diagnostics);
  assert.equal(run.report.messageBox, false, "an error dialog was shown for a valid value");
  assert.equal(run.report.setLength, value.length, "the dialog clipped the entered value");
  assert.equal(run.cli.code, 0, run.cli.stderr);
  assert.match(run.cli.stdout, /saved to user scope by the Human Plane/);
  assert.equal(checkStatus(name), "registered");

  assertNoValueLeak(run, value);

  await removeSecret(createVault(), { name, scope: "user", projectId: null });
  assert.equal(checkStatus(name), "missing", "cleanup did not remove the stored secret");
  results.push("Human Plane real save: PASS");
}

// 3. The UTF-16 byte boundary. Below and at the limit the value is storable;
//    above it the value is refused whole — not clipped, not stored, and not
//    reported to the Agent as saved.
async function boundary(name, byteCount, expectation) {
  const value = syntheticValue(byteCount);
  const run = await drive({ name, mode: "save", value });
  const label = `${byteCount} bytes (${value.length} chars)`;

  assert.equal(run.driver.code, 0, run.diagnostics);
  assert.equal(run.report.setLength, value.length, `${label}: the dialog clipped the entered value`);
  assertNoValueLeak(run, value);

  if (expectation === "accept") {
    assert.equal(run.report.messageBox, false, `${label}: an error dialog was shown`);
    assert.equal(run.cli.code, 0, `${label}: ${run.cli.stderr}`);
    assert.match(run.cli.stdout, /saved to user scope by the Human Plane/);
    assert.equal(checkStatus(name), "registered", `${label}: the value was not stored`);
    await removeSecret(createVault(), { name, scope: "user", projectId: null });
    assert.equal(checkStatus(name), "missing", `${label}: cleanup did not remove the stored secret`);
    results.push(`${byteCount} bytes: PASS (stored, then cleaned up)`);
    return;
  }

  const oversize = oversizeMessage(
    buildWindowsSecretInputScript({ name, scope: "user", projectId: null, projectDir: null })
  );
  assert.equal(run.report.messageBox, true, `${label}: no over-limit error dialog appeared`);
  assert.ok(
    run.report.messageBoxTexts.some((text) => text === oversize.en || text === oversize.ja),
    `${label}: the error dialog did not carry the product's fixed over-limit text: ${JSON.stringify(
      run.report.messageBoxTexts
    )}`
  );
  assert.notEqual(run.cli.code, 0, `${label}: the CLI reported success`);
  assert.equal(run.cli.stdout.includes("saved to user scope"), false, `${label}: the CLI claimed a save`);
  assert.match(run.cli.stderr, /Human Plane secret input is unavailable/);
  assert.equal(checkStatus(name), "missing", `${label}: something was written to the OS store`);
  results.push(`${byteCount} bytes: PASS (refused whole, nothing stored)`);
}

async function cleanup() {
  const vault = createVault();
  for (const name of Object.values(NAMES)) {
    try {
      await removeSecret(vault, { name, scope: "user", projectId: null });
    } catch (error) {
      console.error(`cleanup failed for ${name}: ${error?.message ?? error}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Run one CLI invocation with the driver attached to its own helper process
// ---------------------------------------------------------------------------

async function drive({ name, mode, value }) {
  const projectDir = mkdtempSync(join(root, "project-"));
  writeFileSync(join(projectDir, ".gitignore"), ".env\n.env.*\n!.env.example\n", "utf8");
  writeFileSync(join(projectDir, ".env.example"), `${name}=\n`, "utf8");

  const cli = spawn(
    process.execPath,
    [cliPath, "save", name, "--scope", "user", "--force", "--ask"],
    { cwd: projectDir, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  );
  // --ask must never read an Agent-owned stdin. Close it immediately.
  cli.stdin.end();
  const cliResult = collect(cli, 180_000, "CLI");

  const driver = spawn(
    WINDOWS_POWERSHELL_PATH,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-EncodedCommand",
      Buffer.from(driverScript(mode, cli.pid), "utf16le").toString("base64")
    ],
    { env: driverEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  );
  // The fixture value reaches the driver only over this pipe: never as a
  // command-line argument, an environment variable, or a file.
  driver.stdin.end(value === undefined ? "" : `${value}\n`);
  const driverResult = collect(driver, 180_000, "driver");

  const driverOutcome = await driverResult;
  if (driverOutcome.code !== 0) cli.kill();
  const cliOutcome = await cliResult;

  const report = parseReport(driverOutcome.stdout);
  return {
    projectDir,
    cli: cliOutcome,
    driver: driverOutcome,
    report,
    // Diagnostics for a failed run. Control text is product prose; a password
    // control never contributes text here.
    diagnostics: [
      `driver exit=${driverOutcome.code} reason=${report?.reason ?? "no-report"} helperPids=${report?.helperPidCount ?? "n/a"}`,
      `cli exit=${cliOutcome.code}`,
      `cli stdout: ${cliOutcome.stdout.trim()}`,
      `cli stderr: ${cliOutcome.stderr.trim()}`,
      `driver stderr: ${driverOutcome.stderr.trim()}`,
      `controls: ${JSON.stringify(report?.controls ?? null)}`
    ].join("\n")
  };
}

function parseReport(stdout) {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("AKC_JSON="));
  if (!line) return null;
  return JSON.parse(Buffer.from(line.slice("AKC_JSON=".length), "base64").toString("utf8"));
}

function collect(child, timeoutMs, label) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      // Only this run's own child is signalled.
      child.kill();
      reject(new Error(`${label} timed out. stderr: ${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function driverEnv() {
  const system = "C:\\Windows";
  return {
    SystemRoot: system,
    WINDIR: system,
    SYSTEMDRIVE: "C:",
    PATH: [
      `${system}\\System32`,
      system,
      `${system}\\System32\\Wbem`,
      `${system}\\System32\\WindowsPowerShell\\v1.0`
    ].join(";"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PSModulePath: `${system}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
    TEMP: driverTemp,
    TMP: driverTemp
  };
}

function checkStatus(name) {
  const check = spawnSync(
    process.execPath,
    [cliPath, "check", name, "--scope", "user", "--json"],
    { cwd: root, encoding: "utf8" }
  );
  assert.equal(check.status, 0, check.stderr);
  return JSON.parse(check.stdout).status;
}

function labelled(control, text) {
  return control.text === text.en || control.text === text.ja;
}

function assertNoValueLeak(run, value) {
  assert.equal(run.cli.stdout.includes(value), false, "the CLI stdout carried the fixture value");
  assert.equal(run.cli.stderr.includes(value), false, "the CLI stderr carried the fixture value");
  assert.equal(run.driver.stdout.includes(value), false, "the driver stdout carried the fixture value");
  assert.equal(run.driver.stderr.includes(value), false, "the driver stderr carried the fixture value");
  assert.equal(
    JSON.stringify(run.report ?? null).includes(value),
    false,
    "the driver report carried the fixture value"
  );
  for (const path of walkFiles(run.projectDir)) {
    assert.equal(
      readFileSync(path).toString("utf8").includes(value),
      false,
      `${path} carried the fixture value`
    );
  }
}

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walkFiles(path));
    else files.push(path);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Expected display text, read out of the product's own generated helper script
// ---------------------------------------------------------------------------

function unquote(value) {
  return value.replaceAll("''", "'");
}

function destinationLabels(script) {
  const line = script.split("\n").find((entry) => entry.startsWith("$destination.Text = "));
  assert.ok(line, "the product no longer assigns $destination.Text on its own line");
  const literals = [...line.matchAll(new RegExp(PS_LITERAL, "g"))].map((match) => unquote(match[1]));
  assert.ok(literals.length >= 2, "could not read the product's destination labels");
  return { en: literals[0], ja: literals[1] };
}

function oversizeMessage(script) {
  const pattern = new RegExp(`MessageBox\\]::Show\\(\\(Get-AkcText ${PS_LITERAL} ${PS_LITERAL}\\)`, "g");
  for (const match of script.matchAll(pattern)) {
    const en = unquote(match[1]);
    if (en.includes("exceeds the OS storage limit")) return { en, ja: unquote(match[2]) };
  }
  throw new Error("could not read the product's over-limit message");
}

// ---------------------------------------------------------------------------
// The Win32 driver
// ---------------------------------------------------------------------------

function driverScript(mode, cliPid) {
  return buildSecretInputDriver({
    mode,
    cliPid,
    captions: [
      WINDOWS_DIALOG_TEXT.secretInputCaption.en,
      WINDOWS_DIALOG_TEXT.secretInputCaption.ja
    ],
    saveLabels: [WINDOWS_DIALOG_TEXT.saveButton.en, WINDOWS_DIALOG_TEXT.saveButton.ja],
    cancelLabels: [WINDOWS_DIALOG_TEXT.cancelButton.en, WINDOWS_DIALOG_TEXT.cancelButton.ja]
  });
}
