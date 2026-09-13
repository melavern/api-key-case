import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  assertActuationDecision, assertProcessEvidence, buildMsaaAttacker,
  buildMsaaControl, observeProcess, runVerificationMode
} from "./helpers/windows-verification.mjs";

const passed = (stage = "action-returned") => ({ label: "fixture", kind: "exited", code: 0, stages: [stage] });

export async function runWindowsVerificationHarnessTests() {
  await testProbeGate();
  await testDecisionRaces();
  await testClosedProcessEvidence();
  await testRealProcessLifecycle();
  testDriverInputs();
}

async function testProbeGate() {
  const events = [];
  const scenarios = {
    probe: async () => { events.push("probe"); },
    attack: async () => { events.push("attack"); },
    unconfigured: async () => { events.push("unconfigured"); },
    cancel: async () => { events.push("cancel"); },
    verified: async () => { events.push("verified"); }
  };
  await runVerificationMode("probe", scenarios);
  assert.deepEqual(events.splice(0), ["probe"], "probe alone must not launch a product approval");
  await runVerificationMode("attack", scenarios);
  assert.deepEqual(events.splice(0), ["probe", "attack"]);
  await runVerificationMode("unconfigured", scenarios);
  assert.deepEqual(events.splice(0), ["probe", "unconfigured"]);
  await runVerificationMode("verified", scenarios);
  assert.deepEqual(events.splice(0), ["verified"], "manual verification must not actuate buttons automatically");
  await assert.rejects(runVerificationMode("attack", {
    ...scenarios, probe: async () => { throw new Error("driver crashed"); }
  }), /driver crashed/);
  assert.deepEqual(events, [], "an inoperative attacker cannot produce a product test pass");
  await assert.rejects(runVerificationMode("unknown", scenarios), /unknown Windows/);
}

async function testDecisionRaces() {
  // A quick human cancel, before accDoDefaultAction returns, is valid.
  let cancel;
  await assertActuationDecision({
    startDecision: () => new Promise((resolvePromise) => { cancel = resolvePromise; }),
    startAttacker: async () => { cancel("declined"); await Promise.resolve(); return passed(); },
    expected: "declined"
  });
  // A driver that exits before the user acts is also valid once canceled.
  await assertActuationDecision({
    startDecision: () => new Promise((resolvePromise) => { cancel = resolvePromise; }),
    startAttacker: async () => { setTimeout(() => cancel("declined"), 1); return passed(); },
    expected: "declined"
  });
  for (const result of [
    { ...passed(), code: 0xc0000409 },
    { ...passed(), kind: "timeout", code: null },
    { ...passed(), kind: "spawn-error", code: null },
    passed("root-request")
  ]) {
    await assert.rejects(assertActuationDecision({
      startDecision: async () => "declined", startAttacker: async () => result, expected: "declined"
    }));
  }
  for (const decision of ["approved", "unavailable", null]) {
    await assert.rejects(assertActuationDecision({
      startDecision: async () => decision, startAttacker: async () => passed(), expected: "declined"
    }), /unexpected Human Plane/);
  }
  await assert.rejects(assertActuationDecision({
    startDecision: async () => "approved", startAttacker: () => new Promise(() => {}), expected: "declined"
  }), /unexpected Human Plane/, "an approval bypass must fail immediately even if the attacker hangs");
  await assert.rejects(assertActuationDecision({
    startDecision: () => new Promise(() => {}), startAttacker: async () => passed(), expected: "declined", timeoutMs: 10
  }), /timed out/);
  await assertActuationDecision({
    startDecision: async () => "unavailable", startAttacker: async () => passed(), expected: "unavailable"
  });
}

class FakeChild extends EventEmitter {
  stderr = new PassThrough();
  killed = false;
  kill() { this.killed = true; queueMicrotask(() => this.emit("close", null)); }
}

async function testClosedProcessEvidence() {
  const active = new Set();
  const child = new FakeChild();
  const observed = observeProcess(child, { label: "fixture", timeoutMs: 1000, activeChildren: active });
  child.stderr.write("raw-output-canary\nAKC_MSAA_STA");
  child.stderr.write("GE=root-request\nAKC_MSAA_STAGE=not-a-closed-stage\n");
  child.stderr.write("AKC_MSAA_STAGE=action-returned\r\n");
  child.emit("close", 0xc0000409);
  const result = await observed;
  assert.deepEqual(result.stages, ["root-request", "action-returned"]);
  assert.equal(JSON.stringify(result).includes("raw-output-canary"), false);
  assert.throws(() => assertProcessEvidence(result, "action-returned"), /0xc0000409/);
  assert.equal(active.size, 0);

  const noisy = new FakeChild();
  const bounded = observeProcess(noisy, { label: "fixture", timeoutMs: 1000, activeChildren: active });
  for (let i = 0; i < 100; i++) noisy.stderr.write("AKC_MSAA_STAGE=visit\nAKC_MSAA_STAGE=match\n");
  noisy.stderr.write("x".repeat(16000) + "\nAKC_MSAA_STAGE=action-returned\n");
  noisy.emit("close", 0);
  const boundedResult = await bounded;
  assert.equal(boundedResult.stages.length, 64);
  assertProcessEvidence(boundedResult, "action-returned");

  const missing = new FakeChild();
  const failed = observeProcess(missing, { label: "fixture", timeoutMs: 1000, activeChildren: active });
  missing.emit("error", new Error("raw-spawn-error-canary"));
  missing.emit("close", null);
  const failedResult = await failed;
  assert.equal(failedResult.kind, "spawn-error");
  assert.equal(JSON.stringify(failedResult).includes("raw-spawn-error-canary"), false);
  assert.equal(active.size, 0);
}

async function testRealProcessLifecycle() {
  const activeChildren = new Set();
  const launch = (source) => spawn(process.execPath, ["-e", source], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const child = launch('process.stderr.write("AKC_MSAA_STAGE=action-returned\\n");');
  const result = await observeProcess(child, { label: "fixture", timeoutMs: 5000, activeChildren });
  assertProcessEvidence(result, "action-returned");
  assert.equal(activeChildren.size, 0);

  const hung = launch("setInterval(() => {}, 1000)");
  const closed = once(hung, "close");
  const timed = await observeProcess(hung, { label: "fixture", timeoutMs: 100, activeChildren });
  assert.equal(timed.kind, "timeout");
  assert.equal(hung.killed, true, "timed-out test drivers must be terminated");
  await closed;
  assert.equal(activeChildren.size, 0);
}

function testDriverInputs() {
  for (const pid of [undefined, 0, -1, "123", 1.5]) {
    assert.throws(() => buildMsaaAttacker("fixture", "Yes", pid), /target PID/);
  }
  assert.throws(() => buildMsaaAttacker("fixture", "No", 123), /unsupported MSAA button/);
  assert.throws(() => buildMsaaAttacker([], "Yes", 123), /caption is required/);
  assert.throws(() => buildMsaaAttacker("fixture", ["Yes", ""], 123), /must be non-empty/);
  const script = buildMsaaAttacker("fixture's title", "Yes", 123);
  assert.ok(script.includes("'fixture''s title'"), "PowerShell literals must preserve quoting");
  assert.ok(script.includes("GetWindowThreadProcessId(window, out pid)"));
  assert.ok(script.includes("pid == targetPid"), "another process with the same caption must not be targeted");
  assert.ok(script.includes("[string[]]@('Yes'), 123)"));
  // The product dialog is localized, so the driver has to be able to look for
  // every spelling the same window can legitimately carry.
  const localized = buildMsaaAttacker(["English title", "日本語のタイトル"], ["Yes", "はい"], 123);
  assert.ok(localized.includes("[string[]]@('English title', '日本語のタイトル')"));
  assert.ok(localized.includes("[string[]]@('Yes', 'はい')"));
  assert.ok(localized.includes("Array.IndexOf(buttonNames, name) >= 0"));
  assert.ok(
    localized.includes("foreach (string expectedCaption in expectedCaptions)"),
    "every candidate caption must still be bound to the target PID"
  );
  assert.match(script, /AccessibleChildren\(\[MarshalAs\(UnmanagedType\.Interface\)\] IAccessible container,/,
    "the native container must marshal as IAccessible, not its default COM interface");
  for (const forbidden of ["SendInput", "keybd_event", "mouse_event", "SendKeys", "PostMessage", "SetWindowText"]) {
    assert.equal(script.includes(forbidden), false, `driver must not use ${forbidden}`);
  }
  const control = buildMsaaControl("fixture's title", "Delete");
  assert.ok(control.includes("'fixture''s title'"));
  assert.ok(control.includes("AKC_MSAA_STAGE=control-clicked"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWindowsVerificationHarnessTests();
  console.log("Windows verification harness portable tests passed");
}
