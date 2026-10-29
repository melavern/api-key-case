import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CatalogStore } from "../dist/core/vnext/files.js";
import { launchOperationStatus } from "../dist/core/vnext/launch.js";

if (process.argv[2] === "--child") {
  const store = new CatalogStore(process.argv[3]), profileId = randomUUID(), operationId = randomUUID(), time = new Date().toISOString();
  await store.withUseLock(profileId, profileId, async () => {
    let record = store.saveOperation(null, { schemaVersion: 1, operationId, kind: "local-launch", expectedCatalogRevision: 0,
      boundBasis: { fingerprint: "0".repeat(64), previousGenerationId: null, targetId: profileId, targetRevision: 1, projectRevision: 1, bindingRevision: null },
      state: "consent-needed", timestamps: { createdAt: time, updatedAt: time }, effects: [{ targetId: profileId, state: "not-started" }], authority: "none" });
    if (process.argv[4] === "running") {
      record = store.saveOperation(record, { ...record.operation, state: "prepared", effects: [{ targetId: profileId, state: "possible" }] });
      record = store.saveOperation(record, { ...record.operation, state: "running" });
    }
    process.stdout.write(JSON.stringify({ profileId, operationId }) + "\n"); process.exit(73);
  });
} else {
  for (const phase of ["consent-needed", "running"]) test(`local journal survives actual process death at ${phase}; no replay or expired-lock cleanup`, async () => {
    const root = mkdtempSync(join(tmpdir(), "akc-launch-death-"));
    try {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", root, phase], { encoding: "utf8", timeout: 120000 });
      assert.equal(child.status, 73, child.stderr); const { profileId, operationId } = JSON.parse(child.stdout);
      const store = new CatalogStore(root), path = join(root, ".api-key-case/vnext/operations", `${operationId}.json`), before = readFileSync(path);
      for (let i = 0; i < 2; i++) {
        const status = launchOperationStatus(operationId, new CatalogStore(root));
        assert.equal(status.status, phase === "running" ? "unknown" : phase); assert.equal(status.executed, false); assert.equal(status.replay, "not-permitted");
      }
      assert.ok(before.equals(readFileSync(path))); assert.equal(store.listLaunchOperations(profileId).length, 1); assert.equal(store.listLaunchOperations(randomUUID()).length, 0);
      await assert.rejects(store.withUseLock(profileId, profileId, async () => assert.fail("must not acquire")), /lock-present/);
      if (phase === "running") {
        const record = store.readOperation(operationId); assert.throws(() => store.saveOperation(record, { ...record.operation, effects: [{ targetId: profileId, state: "not-started" }] }), /conflict/);
        const exited = store.saveOperation(record, { ...record.operation, state: "exited", effects: [{ targetId: profileId, state: "completed" }] });
        assert.equal(launchOperationStatus(operationId, store).treeTermination, "confirmed");
        assert.throws(() => store.saveOperation(exited, { ...exited.operation, state: "running", effects: [{ targetId: profileId, state: "possible" }] }), /conflict/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
