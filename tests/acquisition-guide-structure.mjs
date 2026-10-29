import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildCredentialAcquisitionPanel, assertCredentialPurpose } from "../dist/core/human/acquisition.js";
import { buildWindowsSecretInputScript } from "../dist/core/human/windows.js";
import { runConnectionCredential } from "../dist/core/agent/connection-credential.js";
import { MemoryVault } from "../dist/core/vault/memory.js";

const names = { resend: "RESEND_API_KEY", openai: "OPENAI_API_KEY", "stripe-test": "STRIPE_API_KEY" };
const base = { scope: "project", projectId: "0123456789abcdef", projectDir: "/synthetic/日本語 project", environment: "preview" };
let checks = 0;
for (const [service, purpose] of [["resend", "email-sending"], ["openai", "text-generation"], ["openai", "embeddings"], ["openai", "image-generation"], ["stripe-test", "test-payments"]]) {
  const ref = { ...base, service, purpose, name: names[service] };
  const panel = buildCredentialAcquisitionPanel(ref), script = buildWindowsSecretInputScript(ref);
  const items = panel.sections.flatMap(section => section.items);
  assert.equal(items.filter(item => item.id === "name").length, 1);
  assert.equal(items.find(item => item.id === "purpose").source, "project-intent");
  assert.ok(items.find(item => item.id === "purpose").label.ja.includes("確認"));
  assert.ok(panel.sections.filter(section => section.collapsible).every(section => section.id === "details"));
  assert.equal((script.match(/akc-0123456789abcdef-preview/g) ?? []).length, 1, "suggested name is rendered once");
  assert.ok(!/System\.Drawing\.Point/.test(script.slice(script.indexOf("function New-AkcStack"), script.indexOf("$form.AcceptButton"))), "layout contains no individual coordinates");
  assert.ok(script.indexOf("SetThreadDpiAwarenessContext([IntPtr](-4))") < script.indexOf("Application]::EnableVisualStyles()"), "DPI is established before WinForms initialization");
  assert.ok(script.includes("ShowWindow($script:form.Handle, 5)"), "hidden console startup must not hide the native form");
  checks += 7;
}
for (const purpose of [null, {}, [], "unknown", "https://attacker.invalid/", "sk_test_fake", "text-generation'; exit 0; #", "text-generation\n"]) {
  assert.throws(() => assertCredentialPurpose("openai", purpose));
  assert.throws(() => buildWindowsSecretInputScript({ ...base, name: names.openai, service: "openai", purpose }));
  checks += 2;
}
for (const [service, purpose] of [["resend", "text-generation"], ["stripe-test", "email-sending"], ["clerk", "test-payments"]]) {
  assert.throws(() => assertCredentialPurpose(service, purpose)); checks++;
}
const domain = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
assert.equal(domain.length, 253);
const long = { ...base, service: "resend", name: names.resend, acquisition: { sendingDomain: domain, destination: "vercel" } };
assert.equal((buildWindowsSecretInputScript(long).match(new RegExp(domain.replaceAll(".", "\\."), "g")) ?? []).length, 1);
assert.throws(() => buildWindowsSecretInputScript({ ...long, acquisition: { ...long.acquisition, sendingDomain: domain + "a" } }));
checks += 2;

const root = mkdtempSync(join(tmpdir(), "akc-guidance-context-"));
try {
  const project = join(root, "project"), home = join(root, "home");
  mkdirSync(project); mkdirSync(home);
  const vault = new MemoryVault(); let shown;
  const deps = { vault, connectionBaseDir: home, credentialPurpose: "embeddings", humanPlane: {
    capability: () => "os-dialog", askSecret: async request => { shown = request; return "cancelled"; }
  }};
  assert.equal((await runConnectionCredential(project, "preview", "save", deps, false, "openai")).status, "cancelled");
  assert.equal(shown.purpose, "embeddings"); assert.equal(shown.environment, "preview");
  assert.equal(await vault.hasSecret(shown), false);
  let calls = 0;
  assert.equal((await runConnectionCredential(project, "preview", "save", { ...deps, credentialPurpose: "email-sending", vault: {
    isAvailable: async () => { calls++; return true; }
  } }, false, "openai")).status, "unavailable");
  assert.equal(calls, 0, "invalid context stops before any OS-store probe");
  checks += 6;
} finally { rmSync(root, { recursive: true, force: true }); }

const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
for (const args of [
  ["check", "--purpose", "text-generation"],
  ["save", "--purpose", "email-sending"],
  ["save", "--purpose", "text-generation", "--purpose", "text-generation"],
  ["save", "--purpose", "https://attacker.invalid/"]
]) {
  const run = spawnSync(process.execPath, [cli, "connection", "credential", ...args, "--service", "openai", "--env", "preview"], { encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 1); assert.match(run.stderr, /Usage:/); assert.equal(run.stdout, "");
  checks += 3;
}
console.log("structured acquisition guide: " + checks + " checks passed");
