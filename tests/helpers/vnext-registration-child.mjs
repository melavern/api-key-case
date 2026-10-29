// Synthetic process-fault fixture only. Sidecar holds fake slot IDs/counts,
// never a value. Product code imports no fault flags or file-backed vault.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CatalogStore } from "../../dist/core/vnext/files.js";
import { registerCredential } from "../../dist/core/vnext/input.js";
import { locatorAccount } from "../../dist/core/vnext/model.js";

const [home, mode, point, operationId] = process.argv.slice(2), store = new CatalogStore(home);
const sidecar = join(home, "fake-presence.json");
function slots() { try { return JSON.parse(readFileSync(sidecar, "utf8")); } catch { return { accounts: [], saves: 0 }; } }
const crash = name => { if (mode === "rotate" && point === name) process.exit(71); };
const io = {
  store: {
    readCatalog: () => store.readCatalog(), listRegistrationOperations: () => store.listRegistrationOperations(),
    readOperation: id => store.readOperation(id),
    compareAndSwap: (expected, next) => { const saved = store.compareAndSwap(expected, next); if (next.revision > 0) crash("after-catalog"); return saved; },
    saveOperation: (expected, operation) => { crash(`before-${operation.state}`); const saved = store.saveOperation(expected, operation); crash(`after-${operation.state}`); return saved; }
  },
  human: { ask: async plan => {
    if (mode === "resume" || mode === "retry") throw Error("Recovery may not prompt");
    const s = slots(); s.accounts.push(locatorAccount(plan.operation.boundBasis.candidateCredential.locator)); s.saves++;
    writeFileSync(sidecar, JSON.stringify(s), { mode: 0o600 }); crash("after-fake-save"); return "saved";
  } },
  presence: async locator => slots().accounts.includes(locatorAccount(locator)) ? "present" : "absent"
};
const input = mode === "resume" ? { operationId } : mode === "seed" ? { label: "Synthetic seed", classification: "nonproduction" } :
  { label: "Synthetic rotated", classification: "nonproduction", replaceCredentialId: store.readCatalog().catalog.credentials[0].id };
console.log(JSON.stringify(await registerCredential(input, io)));
