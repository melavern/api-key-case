// Fail fast with closed diagnostics for the disposable metadata fixture only.
// Does not read the OS credential store or execute any provider/application.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { privateHomeFixture } from "./helpers/private-home-fixture.mjs";
import { CatalogStore } from "../dist/core/vnext/files.js";
import { emptyCatalog } from "../dist/core/vnext/model.js";

if (process.platform === "win32") {
  const home = privateHomeFixture("akc-native-metadata-probe-");
  const original = childProcess.spawnSync;
  let probes = 0;
  try {
    childProcess.spawnSync = function(command, args, options) {
      const start = Date.now(), result = original.call(this, command, args, options);
      const encoded = Array.isArray(args) && args.includes("-EncodedCommand") ? args.at(-1) : null;
      const script = typeof encoded === "string" ? Buffer.from(encoded, "base64").toString("utf16le") : "";
      if (script.includes("$a=Get-Acl") && script.includes("[Console]::Out.Write('SAFE')")) {
        probes++;
        if (result.status !== 0 || result.stdout !== "SAFE") {
          throw Error("Disposable metadata native check failed: " + JSON.stringify({
            exitCode: result.status, error: result.error?.code ?? null,
            elapsedMs: Date.now() - start, stdoutBytes: result.stdout?.length ?? null
          }));
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    const store = new CatalogStore(home);
    store.compareAndSwap(null, emptyCatalog());
    assert.equal(store.readCatalog().catalog.revision, 0);
    assert.ok(probes > 0, "the real fixed native ACL checker ran");
    console.log("Disposable Windows metadata owner/ACL preflight passed.");
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
    rmSync(home, { recursive: true, force: true });
  }
}
