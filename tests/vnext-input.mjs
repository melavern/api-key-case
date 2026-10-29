import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emptyCatalog, locatorAccount } from "../dist/core/vnext/model.js";
import { registerCredential, inputRequestSchema } from "../dist/core/vnext/input.js";
import { prepareRegistration } from "../dist/core/vnext/registration.js";
import { VNEXT_WINDOWS_REGISTRATION_ACCEPTED } from "../dist/core/vnext/gates.js";
import { buildWindowsVNextSecretInputScript, buildWindowsVNextPresenceScript, encodeWindowsHelperCommand, WindowsHumanPlane, WINDOWS_POWERSHELL_PATH } from "../dist/core/human/windows.js";

const clock = () => "2026-10-21T00:00:00.000Z";
const request = { label: "Example personal", classification: "nonproduction" };
for (const point of ["after-prepared", "before-stored-uncommitted", "after-stored-uncommitted", "before-catalog", "after-catalog", "before-committed"]) {
  for (const rotation of [false, true]) test(`normal retry without a received operation ID at ${point}, rotation=${rotation}`, async () => {
    const f = setup(); const initial = rotation ? await registerCredential(request, f.io) : null;
    const r = { ...request, ...(initial ? { replaceCredentialId: initial.credentialId } : {}) };
    f.fault(point); await registerCredential(r, f.io);
    const pending = [...f.operations.values()].at(-1).operation, inputs = f.calls.input, saves = f.slots.size;
    const retry = await registerCredential(r, f.io);
    assert.equal(retry.operationId, pending.operationId);
    assert.equal(retry.status, point === "after-prepared" ? "unknown" : "committed");
    assert.equal(f.calls.input, inputs); assert.equal(f.slots.size, saves);
  });
}
test("an unresolved candidate cannot be bypassed with changed classification or label case", async () => {
  const f = setup(); f.fault("before-catalog"); await registerCredential(request, f.io);
  const result = await registerCredential({ ...request, classification: "production" }, f.io);
  assert.equal(result.status, "conflict"); assert.ok(result.operationId); assert.equal(f.calls.input, 1);
  assert.equal((await registerCredential({ ...request, label: request.label.toUpperCase() }, f.io)).status, "conflict"); assert.equal(f.calls.input, 1);
});
function setup() {
  let catalog = emptyCatalog(), serial = 0; const operations = new Map(), slots = new Set(), calls = { input: 0, presence: 0 };
  let fault = null;
  const fail = name => { if (fault === name) { fault = null; throw Error("SYNTHETIC_PRIVATE_ERROR"); } };
  const snapshot = () => ({ catalog: structuredClone(catalog), file: { bytes: Buffer.from(JSON.stringify(catalog)), basis: String(serial) } });
  const io = {
    clock,
    store: {
      readCatalog: () => { fail("read-catalog"); return snapshot(); },
      compareAndSwap: (expected, next) => {
        fail("before-catalog"); assert.equal(expected.file.basis, String(serial)); catalog = structuredClone(next); serial++;
        fail("after-catalog"); return snapshot();
      },
      listRegistrationOperations: () => [...operations.values()].map(r => r.operation),
      readOperation: id => operations.has(id) ? structuredClone(operations.get(id)) : null,
      saveOperation: (expected, next) => {
        fail(`before-${next.state}`);
        if (expected) assert.deepEqual(expected.operation, operations.get(next.operationId).operation);
        else assert.equal(operations.has(next.operationId), false);
        const s = { operation: structuredClone(next), file: { bytes: Buffer.from(JSON.stringify(next)), basis: randomUUID() } };
        operations.set(next.operationId, s); fail(`after-${next.state}`); return structuredClone(s);
      }
    },
    human: { ask: async ({ operation }) => {
      calls.input++; assert.ok(operations.has(operation.operationId));
      slots.add(locatorAccount(operation.boundBasis.candidateCredential.locator)); return "saved";
    } },
    presence: async locator => { calls.presence++; return slots.has(locatorAccount(locator)) ? "present" : "absent"; }
  };
  return { io, calls, operations, slots, catalog: () => structuredClone(catalog),
    fault: name => { fault = name; }, change: () => { catalog.revision++; serial++; } };
}

test("generic input journals before native save, same operation never prompts twice", async () => {
  const f = setup(); const result = await registerCredential(request, f.io);
  assert.equal(result.status, "committed"); assert.equal(f.calls.input, 1);
  assert.equal(f.catalog().credentials.length, 1);
  assert.equal((await registerCredential({ operationId: result.operationId }, f.io)).status, "committed");
  assert.equal(f.calls.input, 1); assert.equal(f.slots.size, 1);
  assert.equal((await registerCredential({ ...request, operationId: result.operationId, label: "Different" }, f.io)).status, "conflict");
  assert.equal(f.calls.input, 1);
});

test("same issuer supports separate credentials; exact existing label requests selection", async () => {
  const f = setup(); const a = await registerCredential(request, f.io);
  assert.equal((await registerCredential(request, f.io)).status, "selection-required");
  const b = await registerCredential({ label: "Example production", classification: "production" }, f.io);
  assert.notEqual(a.credentialId, b.credentialId); assert.equal(f.slots.size, 2); assert.equal(f.calls.input, 2);
});

test("rotation retains the old OS slot and Binding references", async () => {
  const f = setup(); const first = await registerCredential(request, f.io); const old = f.catalog().credentials[0];
  const next = await registerCredential({ ...request, replaceCredentialId: first.credentialId }, f.io);
  assert.equal(next.status, "committed"); assert.equal(f.catalog().credentials[0].generation, 2);
  assert.equal(f.slots.has(locatorAccount(old.locator)), true); assert.equal(f.slots.size, 2);
  const calls = f.calls.input; f.io.presence = async () => "unavailable";
  assert.equal((await registerCredential({ ...request, replaceCredentialId: first.credentialId }, f.io)).status, "recovery-required");
  assert.equal(f.calls.input, calls);
});

test("cancel before save is terminal and has no OS effect", async () => {
  const f = setup(); f.io.human.ask = async () => { f.calls.input++; return "cancelled"; };
  const result = await registerCredential(request, f.io); assert.equal(result.status, "cancelled");
  assert.equal(f.catalog().credentials.length, 0); assert.equal(f.slots.size, 0);
  assert.equal((await registerCredential({ operationId: result.operationId }, f.io)).status, "cancelled");
  assert.equal(f.calls.input, 1);
});

for (const point of ["before-prepared", "after-prepared", "before-stored-uncommitted", "after-stored-uncommitted", "before-catalog", "after-catalog", "before-committed", "after-committed"]) {
  test(`fault ${point} preserves old data and resumes without another input`, async () => {
    const f = setup(); await registerCredential(request, f.io); const old = f.catalog().credentials[0];
    f.fault(point);
    const result = await registerCredential({ ...request, replaceCredentialId: old.id }, f.io);
    assert.notEqual(result.status, "committed");
    assert.equal(f.slots.has(locatorAccount(old.locator)), true);
    const operation = [...f.operations.values()].at(-1).operation;
    const calls = f.calls.input;
    if (point !== "before-prepared") {
      const recovery = await registerCredential({ operationId: operation.operationId }, f.io);
      assert.equal(recovery.status, point === "after-prepared" ? "unknown" : "committed");
      assert.equal(f.calls.input, calls);
    } else assert.equal(f.calls.input, 1);
  });
}

test("catalog changes while native input is open preserve the losing candidate", async () => {
  const f = setup(); const ask = f.io.human.ask;
  f.io.human.ask = async plan => { const r = await ask(plan); f.change(); return r; };
  const result = await registerCredential(request, f.io);
  assert.equal(result.status, "conflict"); assert.equal(f.catalog().credentials.length, 0); assert.equal(f.slots.size, 1);
  assert.equal((await registerCredential({ operationId: result.operationId }, f.io)).status, "conflict");
  assert.equal(f.calls.input, 1);
});

test("helper response loss after save is reconciled, not treated as a failed write", async () => {
  const f = setup(); const ask = f.io.human.ask;
  f.io.human.ask = async plan => { await ask(plan); return "unavailable"; };
  assert.equal((await registerCredential(request, f.io)).status, "committed"); assert.equal(f.calls.input, 1);
});

test("new request shape has no value, approval, URL, account or shell parameter", () => {
  for (const name of ["value", "approved", "url", "account", "command", "force"]) assert.equal(inputRequestSchema.safeParse({ ...request, [name]: "CANARY" }).success, false);
});

test("native generic builder keeps values in its existing secure body and pins v3 identity", async () => {
  const f = setup(); let plan;
  f.io.human.ask = async p => { plan = p; return "cancelled"; }; await registerCredential(request, f.io);
  const script = buildWindowsVNextSecretInputScript(plan);
  assert.ok(script.includes(locatorAccount(plan.operation.boundBasis.candidateCredential.locator)));
  assert.match(script, /UseSystemPasswordChar/); assert.match(script, /GetByteCount\(\$value\)/);
  assert.match(script, /Exists\(\$script:account/); assert.match(script, /ZeroFreeCoTaskMemUnicode/);
  assert.match(script, /SetThreadDpiAwarenessContext/); assert.doesNotMatch(script, /WriteAllText|Write-Output|Write-Host|Console\]::Out/);
  assert.ok(encodeWindowsHelperCommand(script).length < 29000);
  assert.throws(() => buildWindowsVNextSecretInputScript({ ...plan, catalog: { ...plan.catalog, revision: 99 } }));
  const probe = buildWindowsVNextPresenceScript(plan.operation.boundBasis.candidateCredential.locator);
  assert.match(probe, /CredFree/); assert.doesNotMatch(probe, /PtrToString|CredentialBlob|GetPassword/);
  let transport;
  const human = new WindowsHumanPlane(WINDOWS_POWERSHELL_PATH, async r => { transport = r; return 2; }, () => ({ root: tmpdir(), home: tmpdir() }));
  assert.equal(await human.askVNextSecret(plan), "cancelled"); assert.equal(transport.stdio, "ignore"); assert.equal(transport.shell, false);
});

test("real CLI rejects value/approval input and keeps native acceptance fail closed", () => {
  const home = mkdtempSync(join(tmpdir(), "akc-vnext-cli-"));
  try {
    for (const argv of [["capabilities", "--json"], ...(!VNEXT_WINDOWS_REGISTRATION_ACCEPTED ? [["input", "--label", "Example", "--classification", "unknown", "--json"]] : [["input", "--classification", "unknown", "--json"]]),
      ["input", "--value", "SYNTHETIC_PRIVATE_VALUE", "--json"], ["input", "--approved", "true", "--json"]]) {
      const child = spawnSync(process.execPath, [resolve("dist/cli/index.js"), "secret", ...argv], { cwd: home, encoding: "utf8" });
      const report = JSON.parse(child.stdout); assert.equal(report.permission, "none");
      assert.doesNotMatch(child.stdout + child.stderr, /SYNTHETIC_PRIVATE_VALUE/);
      if (argv[0] === "input") assert.notEqual(child.status, 0);
    }
    assert.deepEqual(readdirSync(home), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
