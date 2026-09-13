// Removes everything the demo created outside build/: the sandbox project and
// the demo secret in the OS secret store.
//
// The secret is deleted through the product's own vault module, in this
// human-run maintenance script. It deliberately does not shell out to
// `api-key-case remove`: since Phase 6E that command is a Human Plane decision
// with no unattended path, which is the boundary itself and not something a
// demo script should try to route around.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMain } from "./lib/main.mjs";
import { DEMO_SECRET_NAME, REPO_DIR, SANDBOX_DIR, SANDBOX_ROOT } from "./config.mjs";

const VAULT_ENTRY = join(REPO_DIR, "dist", "core", "vault", "index.js");

export async function removeDemoSecret() {
  if (!existsSync(VAULT_ENTRY)) return false;
  // Project scope is derived from the directory's real path, so it has to
  // exist to resolve the same scope `save` used. Recreating it means a deleted
  // sandbox cannot orphan the demo secret in the store.
  mkdirSync(SANDBOX_DIR, { recursive: true });
  const vault = await import(pathToFileURL(VAULT_ENTRY).href);
  const store = vault.createVault();
  if (!(await store.isAvailable())) return false;
  return await vault.removeSecret(store, {
    name: DEMO_SECRET_NAME,
    scope: "project",
    projectId: vault.deriveProjectId(SANDBOX_DIR)
  });
}

export async function cleanup() {
  const removedSecret = await removeDemoSecret();
  if (existsSync(VAULT_ENTRY)) {
    console.log(
      removedSecret
        ? `removed ${DEMO_SECRET_NAME} from the OS secret store (project scope)`
        : `${DEMO_SECRET_NAME} was not registered in the sandbox scope; nothing to remove`
    );
  }

  if (existsSync(SANDBOX_ROOT)) {
    rmSync(SANDBOX_ROOT, { recursive: true, force: true });
    console.log(`removed sandbox: ${SANDBOX_ROOT}`);
  }

  return { removedSecret };
}

if (isMain(import.meta.url)) {
  await cleanup();
}
