/**
 * Windows-only functional acceptance for the fixed, currently disabled local owner.
 * Run after the TypeScript build: node --test tests/local-owner-windows.mjs
 * All credentials/apps are synthetic. No OS credential store, verifier, provider or network.
 * This suite really launches processes, holds locks and observes tree death. Portable
 * source checks below are deliberately NOT counted as native lifecycle acceptance.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { buildWindowsLocalOwnerScript, WINDOWS_LOCAL_OWNER_NATIVE_SOURCE, spawnWindowsLocalOwner } from "../dist/core/local/windows-owner.js";
import { resolveWindowsPowerShell, resolveWindowsHelperScratch } from "../dist/core/human/windows.js";

const here = fileURLToPath(import.meta.url);
const windows = process.platform === "win32";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const terminal = new Set(["EXITED", "FAILED", "CANCELLED", "EXPIRED", "PARENT_LOST", "UNKNOWN"]);
const helpers = new Set();
const state = { fixtureRoot: null, interpreterPath: null };

function protocol(child) {
  let buffer = "", ended = false, failure;
  const lines = [], listeners = new Set(), all = [];
  function wake() { for (const wake of listeners) wake(); }
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 4096) { failure = new Error("Helper protocol exceeded fixed output bound"); wake(); return; }
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n"), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!["READY", "CREATED", "STARTED", ...terminal].includes(line)) failure = new Error("Unexpected helper protocol token");
      all.push(line); lines.push(line);
    }
    wake();
  });
  child.on("error", () => { failure = new Error("Helper spawn failed"); wake(); });
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve) => child.once("close", () => { ended = true; wake(); resolve(); }));
  return {
    child, all, closed,
    async next(timeout = 20000) {
      const until = Date.now() + timeout;
      while (true) {
        if (failure) throw failure;
        if (lines.length) return lines.shift();
        if (ended) throw new Error("Helper ended before the expected protocol token");
        if (Date.now() >= until) throw new Error("Helper protocol timeout");
        await new Promise((resolve) => {
          const timer = setTimeout(done, Math.min(100, until - Date.now()));
          function done() { clearTimeout(timer); listeners.delete(done); resolve(); }
          listeners.add(done);
        });
      }
    }
  };
}
function configFor(project, overrides = {}) {
  return { version: 1, projectDir: project, artifactPath: join(project, "app.cjs"), interpreterPath: state.interpreterPath,
    artifactSha256: hash(join(project, "app.cjs")), interpreterSha256: hash(state.interpreterPath), maxDurationMs: 20000, parentPid: process.pid, ...overrides };
}
function owned(config) {
  const child = spawnWindowsLocalOwner(config); helpers.add(child); child.once("close", () => helpers.delete(child));
  return protocol(child);
}
function rawOwned(config, { source = WINDOWS_LOCAL_OWNER_NATIVE_SOURCE, configLine = JSON.stringify(config) } = {}) {
  const executable = resolveWindowsPowerShell(), trusted = resolveWindowsHelperScratch();
  assert.ok(executable && trusted);
  const scratch = mkdtempSync(join(trusted.root, "akc-owner-acceptance-"));
  let script = buildWindowsLocalOwnerScript();
  // Test-only crash probes compile a copy of the fixed source. No runtime fault option is
  // shipped in the product API, and no credential is interpolated into either source.
  const encoded = gzipSync(Buffer.from(source), { level: 9 }).toString("base64");
  script = script.replace(/FromBase64String\('[A-Za-z0-9+/=]+'\)/, `FromBase64String('${encoded}')`);
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    cwd: win32.dirname(executable), shell: false, detached: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", SYSTEMDRIVE: "C:",
      PATH: "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
      PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe", TEMP: scratch, TMP: scratch,
      USERPROFILE: trusted.home, HOMEDRIVE: trusted.home.slice(0, 2), HOMEPATH: trusted.home.slice(2) }
  });
  helpers.add(child); child.once("close", () => { helpers.delete(child); rmSync(scratch, { recursive: true, force: true }); });
  const result = protocol(child); child.stdin.write(`${configLine}\n`); return result;
}
const fixtureApp = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const role = process.argv[2] || 'root';
const record = (name, value) => fs.writeFileSync(path.join(__dirname, name + '.json'), JSON.stringify(value));
if (role === 'grandchild') {
  record(role, { pid: process.pid }); setInterval(() => {}, 1000);
} else if (role === 'descendant') {
  const child = spawn(process.execPath, [__filename, 'grandchild'], { detached: true, stdio: 'ignore' });
  record(role, { pid: process.pid, child: child.pid }); setInterval(() => {}, 1000);
} else {
  const forbidden = ['NODE_OPTIONS', 'NODE_PATH', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'CUSTOM_CREDENTIAL'];
  const names = Object.keys(process.env).map(x => x.toUpperCase()).sort();
  const secret = process.env.RESEND_API_KEY || '';
  const clean = forbidden.every(name => !(name in process.env)) &&
    /^akc_synthetic_local_owner_[a-f0-9]{32}$/.test(secret) && process.env.NODE_ENV === 'development';
  let stdinNull = false; try { stdinNull = fs.readSync(0, Buffer.alloc(1), 0, 1, null) === 0; } catch {}
  record('environment', { clean, names, stdinNull, argv: process.argv.length });
  record('root', { pid: process.pid });
  const child = spawn(process.execPath, [__filename, 'descendant'], { detached: true, stdio: 'ignore' });
  const block = Buffer.alloc(65536, 97);
  // Includes key-bearing output, intentionally discarded to native NUL, never a test log.
  for (let i = 0; i < 128; i++) { fs.writeSync(1, block); fs.writeSync(2, block); }
  fs.writeSync(1, secret + '\nUNKNOWN\n'); fs.writeSync(2, secret);
  record('output-done', { done: true });
  setInterval(() => {
    if (fs.existsSync(path.join(__dirname, 'exit-ok'))) process.exit(0);
    if (fs.existsSync(path.join(__dirname, 'exit-failed'))) process.exit(7);
  }, 15);
}
`;
function project() {
  const dir = mkdtempSync(join(state.fixtureRoot, "project-"));
  writeFileSync(join(dir, "app.cjs"), fixtureApp); return dir;
}
async function eventual(probe, message, milliseconds = 10000) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) { if (await probe()) return; await pause(25); }
  assert.fail(message);
}
async function treePids(dir) {
  await eventual(() => ["root", "descendant", "grandchild", "output-done"].every((name) => existsSync(join(dir, `${name}.json`))), "Synthetic tree did not start");
  return ["root", "descendant", "grandchild"].map((name) => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")).pid);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function assertGone(pids) { await eventual(() => pids.every((pid) => !alive(pid)), "Owned process tree outlived the helper/session"); }
async function start(owner, secret) {
  assert.equal(await owner.next(), "READY"); owner.child.stdin.write(`${JSON.stringify({ secret })}\n`);
  assert.equal(await owner.next(), "CREATED"); owner.child.stdin.write("RELEASE\n"); assert.equal(await owner.next(), "STARTED");
}
function cannotMutate(file) {
  let descriptor;
  try { assert.throws(() => { descriptor = openSync(file, "r+"); }, "A locked artifact/interpreter accepted write access"); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
  assert.throws(() => renameSync(file, `${file}.renamed`), "A locked artifact/interpreter could be renamed");
}
async function childProcessIds(parentPid, applicationOnly = false) {
  // Native OS query scoped to this exact synthetic helper, including a suspended root
  // that never ran long enough to write a PID marker. No kill-by-name cleanup.
  const executable = resolveWindowsPowerShell();
  const filter = `ParentProcessId = ${Number(parentPid)}${applicationOnly ? " AND Name = 'node.exe'" : ""}`;
  const command = `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { [Console]::Out.WriteLine($_.ProcessId) }`;
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { cwd: win32.dirname(executable), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, "Synthetic process inventory failed");
  assert.match(output, /^(?:[0-9]+\r?\n)*$/); return output.trim() ? output.trim().split(/\r?\n/).map(Number) : [];
}
async function shortPath(path) {
  const command = String.raw`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class ShortName { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathNameW(string path, StringBuilder result, uint size); }' | Out-Null
$path = [Console]::In.ReadLine()
$result = New-Object System.Text.StringBuilder(2048)
$size = [ShortName]::GetShortPathNameW($path, $result, 2048)
if ($size -le 0 -or $size -ge 2048) { exit 1 }
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::Out.Write($result.ToString())`;
  const executable = resolveWindowsPowerShell();
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    cwd: win32.dirname(executable), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"]
  });
  let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { output += chunk; }); child.stdin.end(`${path}\n`);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, "Native short-path lookup failed"); return output;
}
function assertNoValueFiles(dir, secret) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) assertNoValueFiles(path, secret);
    else if (item.name !== "node.exe") assert.equal(readFileSync(path).includes(Buffer.from(secret)), false, "Synthetic credential reached a file");
  }
}

// The separate parent process lets the test kill the real owner parent, not a fake PID.
if (process.argv[2] === "--synthetic-parent") {
  process.once("message", async ({ config, secret }) => {
    try {
      const owner = owned({ ...config, parentPid: process.pid }); await start(owner, secret);
      process.send({ status: "started", helperPid: owner.child.pid });
      await owner.closed;
    } catch { process.send?.({ status: "failed" }); }
  });
} else {
  test("portable helper shape is not Windows acceptance", () => {
    const script = buildWindowsLocalOwnerScript();
    assert.ok(Buffer.from(script, "utf16le").toString("base64").length + 256 < 32767);
    const encoded = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1];
    assert.equal(gunzipSync(Buffer.from(encoded, "base64")).toString(), WINDOWS_LOCAL_OWNER_NATIVE_SOURCE);
    assert.ok(!script.includes("RESEND_API_KEY="));
    if (!windows) assert.throws(() => spawnWindowsLocalOwner({}), { message: "Local application ownership unavailable." });
  });

  test("Windows native owner functional acceptance (synthetic only)", { skip: !windows, timeout: 300000 }, async (t) => {
    const trusted = resolveWindowsHelperScratch(); assert.ok(trusted && resolveWindowsPowerShell());
    state.fixtureRoot = mkdtempSync(join(trusted.root, "akc-owner-native-tests-"));
    state.interpreterPath = join(state.fixtureRoot, "node.exe"); copyFileSync(process.execPath, state.interpreterPath);
    const secret = `akc_synthetic_local_owner_${randomBytes(16).toString("hex")}`;
    t.after(async () => {
      for (const child of helpers) child.kill();
      await pause(500);
      // Failed ownership tests intentionally retain their fixtures for diagnosis. They
      // never fall back to killing arbitrary process names or pretending cleanup passed.
      if (helpers.size === 0) { try { rmSync(state.fixtureRoot, { recursive: true, force: true }); } catch {} }
    });

    await t.test("8.3 project/interpreter aliases preserve physical identity", async (t) => {
      const dir = project(), shortProject = await shortPath(dir), shortInterpreter = await shortPath(state.interpreterPath);
      if (shortProject.toLowerCase() === dir.toLowerCase() && shortInterpreter.toLowerCase() === state.interpreterPath.toLowerCase()) {
        t.skip("This volume does not provide distinct 8.3 aliases"); return;
      }
      // Mixed long artifact + short project simulates physical expansion at one boundary
      // while the existing project/ref identity deliberately keeps its original spelling.
      const config = configFor(dir, { projectDir: shortProject, interpreterPath: shortInterpreter });
      const owner = owned(config); await start(owner, secret); const pids = await treePids(dir);
      owner.child.stdin.write("CANCEL\n"); assert.equal(await owner.next(), "CANCELLED"); await owner.closed; await assertGone(pids);
      assert.equal(config.projectDir, shortProject);
    });
    await t.test("NUL streams, clean exact environment, denied writes/deletes and cancellation", async () => {
      const dir = project(), config = configFor(dir), previous = new Map();
      const pollution = { NODE_OPTIONS: "--require=must-not-load-owner-test-canary", NODE_PATH: "must-not-resolve", RESEND_API_KEY: "must-not-inherit", AWS_SECRET_ACCESS_KEY: "must-not-inherit", GITHUB_TOKEN: "must-not-inherit", CUSTOM_CREDENTIAL: "must-not-inherit" };
      for (const [key, value] of Object.entries(pollution)) { previous.set(key, process.env[key]); process.env[key] = value; }
      let owner;
      try { owner = owned(config); } finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
      assert.equal(await owner.next(), "READY"); cannotMutate(config.artifactPath); cannotMutate(config.interpreterPath);
      owner.child.stdin.write(`${JSON.stringify({ secret })}\n`); assert.equal(await owner.next(), "CREATED");
      assert.equal(existsSync(join(dir, "root.json")), false, "Suspended child ran before release");
      owner.child.stdin.write("RELEASE\n"); assert.equal(await owner.next(), "STARTED");
      const pids = await treePids(dir), environment = JSON.parse(readFileSync(join(dir, "environment.json"), "utf8"));
      assert.deepEqual(environment, { clean: true, names: ["NODE_ENV", "PATH", "RESEND_API_KEY", "SYSTEMROOT", "WINDIR"], stdinNull: true, argv: 2 });
      cannotMutate(config.artifactPath); cannotMutate(config.interpreterPath);
      owner.child.stdin.write("CANCEL\n"); assert.equal(await owner.next(), "CANCELLED"); await owner.closed; await assertGone(pids);
      assert.deepEqual(owner.all, ["READY", "CREATED", "STARTED", "CANCELLED"]); assertNoValueFiles(state.fixtureRoot, secret);
      const fd = openSync(config.artifactPath, "r+"); closeSync(fd);
    });
    for (const [name, marker, outcome] of [["normal root exit kills detached descendants", "exit-ok", "EXITED"], ["abnormal root exit kills detached descendants", "exit-failed", "FAILED"]]) {
      await t.test(name, async () => {
        const dir = project(), owner = owned(configFor(dir)); await start(owner, secret); const pids = await treePids(dir);
        writeFileSync(join(dir, marker), "stop"); assert.equal(await owner.next(), outcome); await owner.closed; await assertGone(pids);
      });
    }
    await t.test("expiry kills the full process tree", async () => {
      const dir = project(), owner = owned(configFor(dir, { maxDurationMs: 5000 })); await start(owner, secret); const pids = await treePids(dir);
      assert.equal(await owner.next(), "EXPIRED"); await owner.closed; await assertGone(pids);
    });
    for (const action of ["eof", "cancel", "malformed-release", "helper-crash"]) {
      await t.test(`${action} before release never executes suspended app`, async () => {
        const dir = project(), owner = owned(configFor(dir)); assert.equal(await owner.next(), "READY");
        owner.child.stdin.write(`${JSON.stringify({ secret })}\n`); assert.equal(await owner.next(), "CREATED");
        // PowerShell may also own conhost.exe. Require exactly one suspended
        // application, but still verify teardown of ALL observed helper children.
        const pids = await childProcessIds(owner.child.pid);
        assert.equal((await childProcessIds(owner.child.pid, true)).length, 1, "A created suspended root must really exist");
        if (action === "eof") owner.child.stdin.end();
        if (action === "cancel") owner.child.stdin.write("CANCEL\n");
        if (action === "malformed-release") owner.child.stdin.write("RELEASE extra\n");
        if (action === "helper-crash") owner.child.kill();
        if (action !== "helper-crash") assert.equal(await owner.next(), action === "malformed-release" ? "UNKNOWN" : "CANCELLED");
        await owner.closed; await assertGone(pids); assert.equal(existsSync(join(dir, "root.json")), false);
      });
    }
    await t.test("explicit HANDLE_LIST excludes an unrelated inheritable handle", async () => {
      const dir = project(), marker = join(dir, "inheritance-probe"); writeFileSync(marker, "synthetic handle probe");
      const source = WINDOWS_LOCAL_OWNER_NATIVE_SOURCE
        .replace("ProcessInfo created; Guard();", 'IntPtr probe = CreateFileW(Path.Combine(cwd, "inheritance-probe"), 0x80000000, 1, ref inherit, 3, 0, IntPtr.Zero); Check(probe != INVALID); ProcessInfo created; Guard();')
        .replace("rootProcess = created.process;", "Check(CloseHandle(probe)); rootProcess = created.process;");
      const owner = rawOwned(configFor(dir), { source }); assert.equal(await owner.next(), "READY");
      owner.child.stdin.write(`${JSON.stringify({ secret })}\n`); assert.equal(await owner.next(), "CREATED");
      // The helper's own copy is now closed. An inherited copy in the still-suspended
      // root would deny this write-open, without relying on root code to report it.
      const fd = openSync(marker, "r+"); closeSync(fd);
      owner.child.stdin.write("CANCEL\n"); assert.equal(await owner.next(), "CANCELLED"); await owner.closed;
    });
    await t.test("helper crash after release kills children despite detached process groups", async () => {
      const dir = project(), owner = owned(configFor(dir)); await start(owner, secret); const pids = await treePids(dir);
      owner.child.kill(); await owner.closed; await assertGone(pids);
    });
    await t.test("parent HANDLE signals even while a separate writer keeps stdin open", async () => {
      const watched = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
      try {
        const dir = project(), owner = rawOwned(configFor(dir, { parentPid: watched.pid }));
        await start(owner, secret); const pids = await treePids(dir);
        watched.kill(); assert.equal(await owner.next(), "PARENT_LOST"); await owner.closed; await assertGone(pids);
        assert.equal(owner.child.stdin.writableEnded, false, "Parent-loss test accidentally relied on EOF");
      } finally { if (watched.exitCode === null) watched.kill(); }
    });
    await t.test("real parent death destroys the complete native-owned tree", async () => {
      const dir = project(), config = configFor(dir);
      const controller = spawn(process.execPath, [here, "--synthetic-parent"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const started = new Promise((resolve, reject) => {
        controller.once("error", reject); controller.once("message", resolve);
        controller.once("exit", () => reject(new Error("Synthetic parent exited before start")));
      });
      try {
        controller.send({ config, secret }); assert.equal((await started).status, "started"); const pids = await treePids(dir);
        controller.kill(); await assertGone(pids);
      } finally { if (controller.exitCode === null) controller.kill(); }
    });
    await t.test("protocol failures and changed hashes never release a child", async () => {
      const dir = project();
      for (const mutate of [
        (c) => ({ ...c, artifactSha256: "0".repeat(64) }),
        (c) => ({ ...c, interpreterSha256: "0".repeat(64) }),
        (c) => ({ ...c, maxDurationMs: 0 }),
        (c) => ({ ...c, maxDurationMs: 1800001 }),
        (c) => ({ ...c, argv: ["--eval", "never"] }),
        (c) => ({ ...c, env: { NODE_OPTIONS: "never" } }),
        (c) => ({ ...c, artifactPath: `${c.artifactPath}:stream` }),
        (c) => ({ ...c, projectDir: `${c.projectDir}\\.` }),
        (c) => ({ ...c, projectDir: `${c.projectDir}\\..` }),
        (c) => ({ ...c, interpreterPath: `${c.interpreterPath}.` })
      ]) {
        const owner = rawOwned(mutate(configFor(dir))); assert.equal(await owner.next(), "UNKNOWN"); await owner.closed;
      }
      const duplicate = JSON.stringify(configFor(dir)).replace('"version":1', '"version":1,"version":1');
      const owner = rawOwned(configFor(dir), { configLine: duplicate }); assert.equal(await owner.next(), "UNKNOWN"); await owner.closed;
      for (const line of ['{"secret":"x","url":"https://invalid.example"}', '{"secret":"x\\u0000y"}', "x".repeat(16385)]) {
        const invalid = owned(configFor(dir)); assert.equal(await invalid.next(), "READY"); invalid.child.stdin.write(`${line}\n`);
        assert.equal(await invalid.next(), "UNKNOWN"); await invalid.closed;
      }
      assert.equal(existsSync(join(dir, "root.json")), false);
    });
    await t.test("crashes adjacent to native creation and racing creation leave no orphan", async () => {
      const crash = "Process.GetCurrentProcess().Kill(); Thread.Sleep(Timeout.Infinite);";
      const probes = [
        WINDOWS_LOCAL_OWNER_NATIVE_SOURCE.replace("ProcessInfo created; Guard();", `ProcessInfo created; Guard(); ${crash}`),
        WINDOWS_LOCAL_OWNER_NATIVE_SOURCE.replace("rootProcess = created.process;", `${crash} rootProcess = created.process;`)
      ];
      for (const source of probes) {
        const dir = project(), owner = rawOwned(configFor(dir), { source }); assert.equal(await owner.next(), "READY");
        owner.child.stdin.write(`${JSON.stringify({ secret })}\n`); await owner.closed;
        assert.deepEqual(await childProcessIds(owner.child.pid), [], "Crash around CreateProcessW left a suspended orphan");
        assert.equal(existsSync(join(dir, "root.json")), false);
      }
      // A timing race brackets the actual syscall with the unmodified production helper.
      // Deterministic adjacent probes above cover both sides; this loop does not claim to
      // prove a kernel-internal instruction was hit in every run.
      for (const delay of [0, 1, 2, 4, 8, 16]) {
        const dir = project(), owner = owned(configFor(dir)); assert.equal(await owner.next(), "READY");
        owner.child.stdin.write(`${JSON.stringify({ secret })}\n`); await pause(delay); owner.child.kill(); await owner.closed;
        assert.deepEqual(await childProcessIds(owner.child.pid), [], "Creation race left an orphan");
        assert.equal(existsSync(join(dir, "root.json")), false);
      }
    });
    assertNoValueFiles(state.fixtureRoot, secret);
  });
}
