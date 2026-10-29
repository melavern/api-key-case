import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { buildVNextHandler } from "../dist/mcp/vnext.js";
import { emptyCatalog } from "../dist/core/vnext/model.js";
import { inspectProject } from "../dist/core/vnext/project.js";
import { makeBindingOperation } from "../dist/core/vnext/binding.js";
import { saveLicenseKey } from "../dist/core/license.js";
const root = mkdtempSync(join(tmpdir(), "akc-mcp-vnext-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  const project = join(root, randomUUID()); mkdirSync(project);
  const catalog = emptyCatalog(), projectId = randomUUID(), environmentId = randomUUID(), credentialId = randomUUID(), now = new Date().toISOString();
  catalog.projects.push({ ...inspectProject(project), id: projectId, revision: 1 });
  catalog.environments.push({ id: environmentId, projectId, label: "development", risk: "nonproduction", revision: 1 });
  catalog.credentials.push({ id: credentialId, label: "SYNTHETIC_PRIVATE_LABEL", locator: { kind: "v3", id: credentialId, generationId: randomUUID() }, generation: 1, classification: "unknown", createdAt: now, revisedAt: now });
  catalog.bindings.push({ id: randomUUID(), projectId, environmentId, variableName: "CUSTOM_API_KEY", credentialId, revision: 1 });
  let operation = makeBindingOperation(catalog, { ...catalog, revision: catalog.revision + 1 }, projectId);
  operation = { ...operation, state: "completed" };
  let state = "present", reads = 0;
  const io = { store: { readCatalog: () => { reads++; return { catalog }; }, readOperation: id => id === operation.operationId ? { operation } : null,
    listUseOperations: () => [], listLaunchOperations: () => [] },
    presence: async () => state, legacy: async () => ({ status: "available", locators: [] }), backend: async () => "available" };
  return { project, catalog, io, operation, state: value => state = value, reads: () => reads };
}
test("discovery projects only current bindings and closed fresh presence", async () => {
  const f = fixture(), h = buildVNextHandler(f.project, f.io);
  for (const [presence, status] of [["present", "registered"], ["absent", "missing"], ["unavailable", "unavailable"]]) {
    f.state(presence); const r = await h("discover_credentials", { environment: "development" });
    assert.equal(r.structuredContent.status, status); assert.equal(r.structuredContent.permission, "none"); assert.equal(r.structuredContent.executed, false);
    assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC_PRIVATE|generationId|canonicalPath|directoryIdentity|locator/);
  }
});
test("input request guides reuse first without opening or submitting input", async () => {
  const f = fixture(), r = await buildVNextHandler(f.project, f.io)("request_secret_input", {});
  assert.equal(r.structuredContent.discovery.status, "registered"); assert.equal(r.structuredContent.inputRequested, false);
  assert.match(r.structuredContent.humanAction, /existing-registration-first/);
});
test("binding plans use core projection without exposing candidate labels or locators", async () => {
  const f = fixture(), r = await buildVNextHandler(f.project, f.io)("plan_secret_binding", { environment: "development", variable: "CUSTOM_API_KEY" });
  assert.equal(r.structuredContent.status, "reviewable"); assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC_PRIVATE|locator|candidates|canonicalPath/);
});
test("unknown/value/approval/path inputs and raw errors never escape or access metadata", async () => {
  const f = fixture(), h = buildVNextHandler(f.project, f.io);
  for (const args of [null, [], { value: "SYNTHETIC_PRIVATE_VALUE" }, { approved: true }, { project: "/other" }, { url: "https://other" }, { argv: [] }]) {
    const r = await h("discover_credentials", args); assert.equal(r.structuredContent.status, "unavailable"); assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC_PRIVATE|https:|\/other/);
  }
  assert.equal(f.reads(), 0);
  f.io.store.readCatalog = () => { throw Error("SYNTHETIC_PRIVATE_VALUE"); };
  assert.doesNotMatch(JSON.stringify(await h("discover_credentials", {})), /SYNTHETIC_PRIVATE/);
});
test("use plans and use requests enforce Pro before catalog access", async () => {
  const f = fixture(); f.io.licenseOptions = { baseDir: f.project };
  const h = buildVNextHandler(f.project, f.io);
  for (const name of ["plan_secret_use", "request_secret_use"]) assert.equal((await h(name, { bindingId: randomUUID(), targetId: randomUUID() })).structuredContent.status, "pro-required");
  assert.equal(f.reads(), 0);
});
test("paid placement plan is core-only, path-free and never grants execution", async () => {
  const f = fixture(), keys = generateKeyPairSync("ed25519"), payload = Buffer.from(JSON.stringify({ v: 1, plan: "pro", id: "synthetic-mcp", issuedAt: "2026-10-21" })).toString("base64url"), body = `AKC1.${payload}`;
  saveLicenseKey(`${body}.${sign(null, Buffer.from(body), keys.privateKey).toString("base64url")}`, f.project);
  f.io.licenseOptions = { baseDir: f.project, publicKey: keys.publicKey };
  writeFileSync(join(f.project, "wrangler.json"), JSON.stringify({ name: "synthetic-mcp", account_id: "a".repeat(32) }));
  const target = { id: randomUUID(), projectId: f.catalog.projects[0].id, kind: "cloudflare", canonicalConfigRelativePath: "wrangler.json", configSection: "top-level", providerAccountId: "a".repeat(32), resourceId: "synthetic-mcp", applicationEnvironment: "development", revision: 1, reviewedAt: new Date().toISOString() };
  f.catalog.destinations.push(target);
  const args = { bindingId: f.catalog.bindings[0].id, targetId: target.id }, h = buildVNextHandler(f.project, f.io);
  for (const name of ["plan_secret_use", "request_secret_use"]) {
    const r = (await h(name, args)).structuredContent; assert.equal(r.status, name.startsWith("plan") ? "reviewable" : "action-required");
    assert.equal(r.permission, "none"); assert.equal(r.executed, false); assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC_PRIVATE|canonicalPath|wrangler.json|account_id|locator/);
  }
});
test("operation status is project-scoped and never serializes the journal basis", async () => {
  const f = fixture(), h = buildVNextHandler(f.project, f.io), id = f.operation.operationId;
  const r = (await h("get_secret_operation_status", { operationId: id })).structuredContent;
  assert.equal(r.status, "completed"); assert.equal(r.operationId, id); assert.equal(r.replay, "not-permitted");
  assert.doesNotMatch(JSON.stringify(r), /candidateCatalog|boundBasis|SYNTHETIC_PRIVATE|fingerprint|canonicalPath/);
  f.operation.projectId = randomUUID(); assert.equal((await h("get_secret_operation_status", { operationId: id })).structuredContent.status, "unavailable");
});
test("fixed project replacement during an awaited observation fails closed", async () => {
  const f = fixture(), other = fixture(), alias = join(root, randomUUID());
  symlinkSync(f.project, alias, process.platform === "win32" ? "junction" : "dir");
  f.io.presence = async () => { unlinkSync(alias); symlinkSync(other.project, alias, process.platform === "win32" ? "junction" : "dir"); return "present"; };
  const r = await buildVNextHandler(alias, f.io)("discover_credentials", {}); assert.equal(r.structuredContent.status, "unavailable");
});
function client(entry, args) {
  const child = spawn(process.execPath, [resolve(entry), ...args], { stdio: ["pipe", "pipe", "pipe"] }); let raw = "", buffer = "", id = 0; const pending = new Map();
  child.stdout.on("data", chunk => { raw += chunk; buffer += chunk; let cut; while ((cut = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1); try { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id); } catch {} } }); child.stderr.on("data", chunk => raw += chunk);
  const send = (method, params) => new Promise((done, fail) => { const rid = ++id, timer = setTimeout(() => fail(Error("MCP fixture timeout")), 15000); pending.set(rid, m => { clearTimeout(timer); done(m); }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n"); });
  return { send, raw: () => raw, close: () => { child.stdin.end(); child.kill(); } };
}
const init = c => c.send("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-chat", version: "1" } });
test("two fresh real stdio chats observe the same binding and operation without re-entry", async () => {
  const f = fixture(), file = join(f.project, "synthetic-metadata.json"), expected = f.operation.operationId;
  writeFileSync(file, JSON.stringify({ catalog: f.catalog, operation: f.operation })); const before = readFileSync(file);
  for (let i = 0; i < 2; i++) {
    const c = client("tests/helpers/vnext-mcp-server.mjs", [f.project, file]); try {
      assert.equal((await init(c)).error, undefined);
      const names = (await c.send("tools/list", {})).result.tools.map(t => t.name); assert.equal(names.length, 7); assert.ok(names.includes("discover_credentials"));
      const call = (name, args) => c.send("tools/call", { name, arguments: args });
      assert.equal((await call("discover_credentials", {})).result.structuredContent.status, "registered");
      assert.equal((await call("get_secret_operation_status", { operationId: expected })).result.structuredContent.status, "completed");
      const bad = await call("discover_credentials", { SYNTHETIC_PRIVATE_ARGUMENT: "SYNTHETIC_PRIVATE_VALUE", approved: true });
      assert.equal(bad.result.structuredContent.status, "unavailable");
      assert.doesNotMatch(c.raw(), /SYNTHETIC_PRIVATE|candidateCatalog|canonicalPath|generationId/);
    } finally { c.close(); }
  }
  assert.deepEqual(readFileSync(file), before);
});
test("production stdio profile is explicit and mutually exclusive with guidance", async () => {
  const f = fixture(), c = client("dist/cli/index.js", ["mcp", f.project, "--vnext"]);
  try { await init(c); const list = (await c.send("tools/list", {})).result.tools; assert.equal(list.length, 7); assert.ok(list.every(t => t.annotations.readOnlyHint)); assert.ok(list.some(t => t.name === "discover_credentials")); } finally { c.close(); }
  for (const flags of [["--vnext", "--vnext"], ["--vnext", "--guidance-only"], ["--vnext", "--approved"]]) {
    const r = spawnSync(process.execPath, [resolve("dist/cli/index.js"), "mcp", f.project, ...flags], { encoding: "utf8", timeout: 15000 }); assert.notEqual(r.status, 0); assert.equal(r.stderr, "Unexpected error.\n");
  }
});
