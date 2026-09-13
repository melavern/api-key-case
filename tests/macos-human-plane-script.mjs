// Execute the generated JavaScript with a small, in-memory framework double.
// This checks control flow, not JXA bridging, Keychain, GUI, TCC, or architecture
// compatibility. Only synthetic input exists here; no OS store or helper runs.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { MacOSHumanPlane, MACOS_OSASCRIPT_PATH } from "../dist/core/human/macos.js";
import { toAccount, VAULT_SERVICE } from "../dist/core/vault/naming.js";

const ref = {
  name: "MACOS_SCRIPT_CANARY",
  scope: "project",
  projectId: "0123456789abcdef",
  projectDir: "/Users/test/日本語 project"
};
const approval = {
  ...ref, target: "vercel", env: "preview", force: true,
  projectDir: "/Users/test/日本語 project", destination: "Vercel project canary",
  cliPath: "/opt/homebrew/bin/vercel",
  command: "vercel env add MACOS_SCRIPT_CANARY preview --sensitive --yes",
  preCommands: ["vercel env rm MACOS_SCRIPT_CANARY preview --yes"],
  trustState: "changed"
};
const removals = [
  { ...ref, kind: "secret", projectDir: approval.projectDir },
  { kind: "secret", name: ref.name, scope: "user", projectId: null, projectDir: null },
  { kind: "destination-trust", target: "vercel", env: "preview", projectDir: approval.projectDir }
];

// Model documented outcomes rather than a successful status-only launcher:
// refusal must never call storage; update failure must never become an add.
function frameworkDouble(options = {}) {
  const state = { writes: [], alerts: [], fields: [], valueReads: 0 };
  const exitSignal = {};
  const input = options.input ?? "  synthetic local test input  ";
  const api = {
    NSApplication: { sharedApplication: { setActivationPolicy() {}, activateIgnoringOtherApps() {} } },
    NSApplicationActivationPolicyRegular: 0,
    NSAlertFirstButtonReturn: 1000,
    NSAlertSecondButtonReturn: 1001,
    NSUTF8StringEncoding: 4,
    NSMakeRect: (...args) => args,
    kSecClass: "class", kSecClassGenericPassword: "generic-password",
    kSecAttrService: "service", kSecAttrAccount: "account", kSecValueData: "data",
    errSecSuccess: 0, errSecItemNotFound: -25300,
    NSString: { stringWithString(value) {
      return { value, dataUsingEncoding() {
        if (options.encodingThrows) throw new Error("synthetic encoding failure");
        return options.encodingNull ? null : { bytes: value };
      } };
    } },
    NSMutableDictionary: { alloc: { get init() {
      return { entries: new Map(), setObjectForKey(value, key) { this.entries.set(key, value); } };
    } } },
    SecItemUpdate(query, update) {
      state.writes.push({ kind: "update", query: query.entries, value: update.entries });
      if (options.updateThrows) throw new Error("synthetic store failure");
      return options.updateStatus ?? 0;
    },
    SecItemAdd(item, result) {
      assert.equal(result, null, "the helper must not request a returned item");
      state.writes.push({ kind: "add", value: item.entries });
      if (options.addThrows) throw new Error("synthetic store failure");
      return options.addStatus ?? 0;
    },
    exit(code) { state.exitCode = code; throw exitSignal; }
  };
  api.NSSecureTextField = { alloc: { initWithFrame() {
    let value = "";
    const field = {
      get stringValue() { state.valueReads++; return value; },
      set stringValue(next) { value = next; },
      isEmpty: () => value === ""
    };
    state.fields.push(field);
    return field;
  } } };
  api.NSAlert = { alloc: { get init() {
    const buttons = [];
    const alert = {
      window: {}, buttons: { objectAtIndex: (index) => buttons[index] },
      addButtonWithTitle(title) { buttons.push({ title }); },
      get runModal() {
        if (this.accessoryView) this.accessoryView.stringValue = input;
        state.buttons = buttons;
        if (options.dialogThrows) throw new Error("synthetic dialog failure");
        return Object.hasOwn(options, "response") ? options.response : 1000;
      }
    };
    state.alerts.push(alert);
    return alert;
  } } };
  return {
    state,
    run(script) {
      const context = { $: api, ObjC: { import() {}, unwrap: (value) => value } };
      try {
        runInNewContext(script, context, { timeout: 1000 });
        assert.fail("helper must exit explicitly");
      } catch (error) {
        if (error !== exitSignal) throw error;
      }
      assert.equal(context.injected, undefined, "plan text executed as code");
      return state.exitCode;
    }
  };
}

async function exercise(method, plan, options) {
  const fixture = frameworkDouble(options);
  const plane = new MacOSHumanPlane(MACOS_OSASCRIPT_PATH, async (request) => {
    assert.equal(request.stdio, "ignore");
    assert.deepEqual(request.env, {});
    return fixture.run(request.args[3]);
  });
  return { status: await plane[method](plan), ...fixture.state };
}

export async function runMacOSHumanPlaneScriptTests() {
  for (const scopeRef of [
    ref,
    { name: ref.name, scope: "user", projectId: null, projectDir: null }
  ]) {
    for (const updateStatus of [0, -25300]) {
      const result = await exercise("askSecret", scopeRef, { updateStatus });
      assert.equal(result.status, "saved");
      assert.deepEqual(result.writes.map((write) => write.kind), updateStatus === 0 ? ["update"] : ["update", "add"]);
      const query = result.writes[0].query;
      assert.equal(query.get("class"), "generic-password");
      assert.equal(query.get("service").value, VAULT_SERVICE);
      assert.equal(query.get("account").value, toAccount(scopeRef));
      assert.ok(result.alerts[0].informativeText.includes(scopeRef.scope === "project"
        ? `Registration destination: This project\n${scopeRef.projectDir}`
        : "Registration destination: Current user (shared across projects)"));
      for (const write of result.writes) {
        assert.equal(write.value.get("data").bytes, "  synthetic local test input  ");
        if (write.kind === "add") {
          assert.equal(write.value.get("service").value, VAULT_SERVICE);
          assert.equal(write.value.get("account").value, toAccount(scopeRef));
          assert.equal(write.value.get("class"), "generic-password");
        }
      }
      assert.ok(result.fields.every((field) => field.isEmpty()));
    }
  }

  for (const response of [1001, 1002, -1000, 0, null, undefined]) {
    const result = await exercise("askSecret", ref, { response });
    assert.equal(result.status, "cancelled");
    assert.equal(result.valueReads, 0, "refusal must not read the field");
    assert.equal(result.writes.length, 0);
    assert.ok(result.fields.every((field) => field.isEmpty()));
  }
  for (const input of ["", " \t\n "]) {
    const result = await exercise("askSecret", ref, { input });
    assert.equal(result.status, "cancelled");
    assert.equal(result.writes.length, 0);
    assert.ok(result.fields.every((field) => field.isEmpty()));
  }
  for (const [options, expectedWrites] of [
    [{ updateStatus: -25293 }, ["update"]], // access denied is not item-not-found
    [{ updateStatus: -128 }, ["update"]], // OS cancellation is not success
    [{ updateStatus: 12345 }, ["update"]],
    [{ updateThrows: true }, ["update"]],
    [{ updateStatus: -25300, addStatus: -25299 }, ["update", "add"]],
    [{ updateStatus: -25300, addThrows: true }, ["update", "add"]],
    [{ encodingNull: true }, []],
    [{ encodingThrows: true }, []]
  ]) {
    const result = await exercise("askSecret", ref, options);
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.writes.map((write) => write.kind), expectedWrites);
    assert.ok(result.fields.every((field) => field.isEmpty()));
  }

  for (const [method, plan] of [["askApproval", approval], ...removals.map((plan) => ["askRemoval", plan])]) {
    for (const response of [1000, 1001, 1002, -1000, 0, null, undefined]) {
      const result = await exercise(method, plan, { response });
      // This pins the CURRENT button-only behavior, not OS identity verification
      // or proof that a human, rather than Accessibility, chose that button.
      assert.equal(result.status, response === 1001 ? "approved" : "declined");
      assert.equal(result.writes.length, 0, "decision helpers must not mutate storage");
      assert.equal(result.fields.length, 0);
      assert.equal(result.buttons[0].title, "No");
      assert.equal(result.buttons[0].keyEquivalent, "\r");
      assert.equal(result.alerts[0].window.initialFirstResponder, result.buttons[0]);
      assert.equal(result.buttons[1].title, method === "askApproval" ? "Yes" : "Delete");
      const text = result.alerts[0].informativeText;
      if (method === "askApproval") {
        for (const detail of [plan.name, plan.scope, plan.target, plan.env, plan.projectId,
          plan.projectDir, plan.destination, plan.cliPath, plan.command, ...plan.preCommands,
          "CHANGED", "Force overwrite: yes"]) assert.ok(text.includes(detail), "missing plan detail");
      } else {
        assert.ok(text.includes(plan.name ?? plan.target));
        assert.ok(text.includes(plan.projectDir ?? "user scope"));
        assert.ok(text.includes(plan.kind === "secret" ? "cannot be undone" : "No secret is deleted"));
      }
    }
  }
  for (const [method, plan] of [["askSecret", ref], ["askApproval", approval], ...removals.map((plan) => ["askRemoval", plan])]) {
    const result = await exercise(method, plan, { dialogThrows: true });
    assert.equal(result.status, "unavailable");
    assert.equal(result.writes.length, 0);
  }

  const hostileText = "日本語 '\"; globalThis.injected = true; // \\ $(ignored) `ignored`";
  const escaped = await exercise("askApproval", {
    ...approval, projectDir: hostileText, destination: hostileText, cliPath: hostileText,
    command: hostileText, preCommands: [hostileText]
  }, { response: 1000 });
  assert.equal(escaped.status, "declined");
  assert.ok(escaped.alerts[0].informativeText.includes(hostileText));
  for (const plan of removals.filter((plan) => plan.projectDir)) {
    const escapedRemoval = await exercise("askRemoval", { ...plan, projectDir: hostileText }, { response: 1000 });
    assert.equal(escapedRemoval.status, "declined");
    assert.ok(escapedRemoval.alerts[0].informativeText.includes(hostileText));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMacOSHumanPlaneScriptTests();
  console.log("macOS helper portable control-flow tests passed (framework doubles; no native acceptance)");
}
