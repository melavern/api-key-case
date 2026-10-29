import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CatalogStore } from "../dist/core/vnext/files.js";
import { useOperationStatus } from "../dist/core/vnext/use.js";

if (process.argv[2] === "--child") {
  const store = new CatalogStore(process.argv[3]), bindingId = randomUUID(), targetId = randomUUID(), operationId = randomUUID(), time = new Date().toISOString();
  await store.withUseLock(bindingId, targetId, async () => {
    let record = store.saveOperation(null, { schemaVersion: 1, operationId, kind: process.argv[5] ?? "cloudflare-use", bindingId,
      expectedCatalogRevision: 0, boundBasis: { fingerprint: "0".repeat(64), previousGenerationId: null, targetId, targetRevision: 1, projectRevision: 1, bindingRevision: 1 },
      state: "consent-needed", timestamps: { createdAt: time, updatedAt: time }, effects: [{ targetId, state: "not-started" }], authority: "none" });
    if (process.argv[4] === "executing") record = store.saveOperation(record, { ...record.operation, state: "executing", effects: [{ targetId, state: "possible" }] });
    process.stdout.write(JSON.stringify({ bindingId, targetId, operationId }) + "\n");
    process.exit(73); // Deliberately bypasses finally while this process owns the directory lock.
  });
} else {
  test("replaced async use lock is detected and a foreign replacement is never removed", async () => {
    const root = mkdtempSync(join(tmpdir(), "akc-use-owner-")), bindingId = randomUUID(), targetId = randomUUID(), store = new CatalogStore(root);
    try {
      const lock = join(root, ".api-key-case/vnext/use-locks", `${bindingId}-${targetId}`), moved = `${lock}-preserved`;
      await store.withUseLock(bindingId, targetId, async owns => {
        assert.equal(owns(), true); renameSync(lock, moved); mkdirSync(lock); assert.equal(owns(), false);
      });
      assert.equal(existsSync(lock), true); assert.equal(existsSync(moved), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const [kind, phase] of [["cloudflare-use", "consent-needed"], ["cloudflare-use", "executing"], ["vercel-use", "executing"], ["github-use", "executing"]]) test(`${kind} actual process death at ${phase}: status-only observer retains lock and forbids a second execution`, async () => {
    const root = mkdtempSync(join(tmpdir(), "akc-use-death-"));
    try {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", root, phase, kind], { encoding: "utf8", timeout: 120_000 });
      assert.equal(child.status, 73, child.stderr); const { bindingId, targetId, operationId } = JSON.parse(child.stdout);
      const store = new CatalogStore(root), path = join(root, ".api-key-case/vnext/operations", `${operationId}.json`), before = readFileSync(path);
      for (let observer = 0; observer < 2; observer++) {
        const status = useOperationStatus(operationId, new CatalogStore(root));
        assert.equal(status.status, phase === "executing" ? "unknown" : phase); assert.equal(status.executed, false); assert.equal(status.replay, "not-permitted");
        assert.equal(status.effects[0].state, phase === "executing" ? "unknown" : "not-started");
      }
      assert.ok(before.equals(readFileSync(path))); let calls = 0;
      await assert.rejects(store.withUseLock(bindingId, targetId, async () => { calls++; }), /lock-present/); assert.equal(calls, 0);
      const record = store.readOperation(operationId);
      if (phase === "executing") {
        assert.throws(() => store.saveOperation(record, { ...record.operation, effects: [{ targetId, state: "not-started" }] }), /conflict/);
        const completed = store.saveOperation(record, { ...record.operation, state: "completed", effects: [{ targetId, state: "completed" }] });
        assert.throws(() => store.saveOperation(completed, { ...completed.operation, effects: [{ targetId, state: "possible" }] }), /conflict/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
