import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { locatorAccount } from "../dist/core/vnext/model.js";

function child(home, mode, point = "", operationId = "") {
  return spawnSync(process.execPath, [resolve("tests/helpers/vnext-registration-child.mjs"), home, mode, point, operationId], { encoding: "utf8", timeout: 90_000, windowsHide: true });
}
for (const point of ["before-prepared", "after-prepared", "after-fake-save", "after-stored-uncommitted", "after-catalog", "after-committed"]) {
  test(`real fresh-process recovery at ${point}, with synthetic slot presence only`, () => {
    const home = mkdtempSync(join(tmpdir(), "akc-vnext-process-"));
    try {
      const seed = child(home, "seed"); assert.equal(seed.status, 0, "seed fixture process must complete"); assert.equal(JSON.parse(seed.stdout).status, "committed");
      const root = join(home, ".api-key-case", "vnext"), catalogPath = join(root, "catalog.json");
      const before = JSON.parse(readFileSync(catalogPath, "utf8"));
      const crashed = child(home, "rotate", point); assert.equal(crashed.status, 71, "fault must terminate the real child at the declared point");
      const operations = readdirSync(join(root, "operations")).filter(p => p.endsWith(".json"))
        .map(p => JSON.parse(readFileSync(join(root, "operations", p), "utf8")));
      const operation = operations.find(o => o.boundBasis.candidateCredential.label === "Synthetic rotated");
      const slots = JSON.parse(readFileSync(join(home, "fake-presence.json"), "utf8"));
      assert.ok(slots.accounts.includes(locatorAccount(before.credentials[0].locator)));
      const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
      if (!["after-catalog", "after-committed"].includes(point)) assert.deepEqual(catalog, before);
      if (point === "before-prepared") { assert.equal(operation, undefined); assert.equal(slots.saves, 1); return; }
      assert.equal(crashed.stdout, "", "the killed caller never received an operation ID");
      const resumed = point === "after-committed" ? child(home, "resume", "", operation.operationId) : child(home, "retry");
      assert.equal(resumed.status, 0, "fresh recovery process must complete");
      assert.equal(JSON.parse(resumed.stdout).operationId, operation.operationId);
      assert.equal(JSON.parse(resumed.stdout).status, point === "after-prepared" ? "unknown" : "committed");
      const afterSlots = JSON.parse(readFileSync(join(home, "fake-presence.json"), "utf8"));
      assert.deepEqual(afterSlots, slots); // no second save or duplicate input
      if (point !== "after-prepared") assert.equal(JSON.parse(readFileSync(catalogPath, "utf8")).credentials[0].generation, 2);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
