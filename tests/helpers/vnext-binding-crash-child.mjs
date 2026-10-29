// Real process death with a value-free presence simulation. No OS Secret I/O.
import { readdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CatalogStore } from "../../dist/core/vnext/files.js";
import { applyBinding, prepareBinding, recoverBinding } from "../../dist/core/vnext/binding.js";
const [root, point] = process.argv.slice(2), store = new CatalogStore(join(root, "home"));
if (point === "recover") {
  const files = readdirSync(join(root, "home", ".api-key-case", "vnext", "operations")).filter(p => p.endsWith(".json"));
  if (files.length !== 1) throw Error("One isolated operation required");
  console.log(JSON.stringify(recoverBinding(files[0].slice(0, -5), store)));
} else {
  const io = { store: {
    readCatalog: () => store.readCatalog(), readOperation: id => store.readOperation(id),
    saveOperation: (before, value) => { const result = store.saveOperation(before, value); if (point === "after-prepared" && value.state === "prepared" || point === "after-completed" && value.state === "completed") process.exit(85); return result; },
    compareAndSwap: (before, value) => { if (point === "before-cas") process.exit(85); const result = store.compareAndSwap(before, value); if (point === "after-cas") process.exit(85); return result; }
  }, presence: async () => "present", legacy: async () => ({ status: "available", locators: [] }), human: { choose: async () => ({ status: "confirmed", index: 0 }) } };
  const request = { project: join(root, "app"), environment: "development", variable: "SYNTHETIC_API_KEY", risk: "nonproduction" };
  const plan = await prepareBinding(request, io), result = await applyBinding(request, plan.fingerprint, io);
  writeSync(1, JSON.stringify(result)); process.exit(86);
}
