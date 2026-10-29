// Isolated test entry for the real CLI parser/projections and native presence.
// A synthetic home is injected as a module dependency, never a product option.
import { runSecretCommand } from "../../dist/cli/secret.js";
import { WindowsHumanPlane, resolveWindowsPowerShell } from "../../dist/core/human/windows.js";
import { CatalogStore } from "../../dist/core/vnext/files.js";
import { inspectLegacyCandidates, inspectLegacyStatus } from "../../dist/core/vnext/discovery.js";
const home = process.argv[2], human = new WindowsHumanPlane(resolveWindowsPowerShell());
const presence = Object.assign(locator => human.probeVNextPresence(locator), { all: locators => human.probeVNextPresenceBatch(locators) });
const io = { store: new CatalogStore(home), presence, legacy: context => inspectLegacyCandidates(context, presence, home),
  legacyStatus: (locator, catalog, context) => inspectLegacyStatus(locator, catalog, context, home),
  human: { choose: async () => { throw Error("Status child must never open selection"); } },
  managementHuman: { confirm: async () => { throw Error("Status child must never confirm"); } } };
process.exitCode = await runSecretCommand(process.argv.slice(3), io);
