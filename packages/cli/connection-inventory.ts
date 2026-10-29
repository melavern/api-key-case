import { resolve } from "node:path";
import { createVault } from "../core/vault/index.js";
import { readConnectionInventory, renderConnectionInventory } from "../core/agent/connection-inventory.js";

/** Fixed local inventory; no selector overrides or generic vault-list flags. */
export async function runConnectionInventoryCommand(args: string[]): Promise<number> {
  let json = false, pathSeen = false, project = process.cwd();
  for (const arg of args) {
    if (arg === "--json" && !json) json = true;
    else if (!arg.startsWith("-") && !pathSeen) { pathSeen = true; project = resolve(arg); }
    else {
      console.error("Usage: api-key-case connection inventory [--json] [path]. Eleven known project slots only; local presence and historical receipts, no selection changes or provider operations.");
      return 1;
    }
  }
  const vault = createVault();
  const result = await readConnectionInventory(project, { vault: { hasSecret: ref => vault.hasSecret(ref) } });
  console.log(json ? JSON.stringify(result) : renderConnectionInventory(result));
  return result.status === "unavailable" ? 1 : 0;
}
