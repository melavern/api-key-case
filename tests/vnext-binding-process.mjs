import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CatalogStore } from "../dist/core/vnext/files.js";
import { emptyCatalog } from "../dist/core/vnext/model.js";
const child = resolve("tests/helpers/vnext-binding-crash-child.mjs");
for (const point of ["after-prepared", "before-cas", "after-cas", "after-completed"]) test(`binding real process death ${point}: fresh recovery observes, never repeats`, () => {
  const root = mkdtempSync(join(tmpdir(), "akc-binding-process-")), home = join(root, "home");
  try {
    mkdirSync(home); mkdirSync(join(root, "app"));
    const store = new CatalogStore(home), catalog = emptyCatalog(), id = randomUUID(), time = new Date().toISOString();
    catalog.credentials.push({ id, label: "Synthetic process fixture", locator: { kind: "v3", id, generationId: randomUUID() }, generation: 1,
      classification: "nonproduction", createdAt: time, revisedAt: time }); store.compareAndSwap(null, catalog);
    const killed = spawnSync(process.execPath, [child, root, point], { encoding: "utf8", timeout: 90_000 });
    assert.equal(killed.status, 85, "test child reaches the intended death point");
    const completed = point === "after-cas" || point === "after-completed";
    const revision = store.readCatalog().catalog.revision;
    for (let i = 0; i < 2; i++) {
      const fresh = spawnSync(process.execPath, [child, root, "recover"], { encoding: "utf8", timeout: 90_000 });
      assert.equal(fresh.status, 0); const result = JSON.parse(fresh.stdout);
      assert.equal(result.status, completed ? "completed" : "recovery-required"); assert.equal(result.permission, "none"); assert.equal(result.executed, false);
      assert.equal(store.readCatalog().catalog.revision, revision); assert.equal(store.readCatalog().catalog.bindings.length, completed ? 1 : 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
