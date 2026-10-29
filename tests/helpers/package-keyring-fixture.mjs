// Test-only replacement inside a disposable npm consumer, never in the artifact.
// D-Bus absence is not isolation: a native keyring may fall back to keyutils.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function isolatePackageKeyring(installed, root, env) {
  const require = createRequire(join(installed, "package.json"));
  const entry = require.resolve("@napi-rs/keyring"); // resolution only, no native load
  const scope = dirname(dirname(entry));
  const expected = join(realpathSync(dirname(installed)), "@napi-rs");
  assert.equal(realpathSync(scope), expected, "only mutate the fresh consumer dependency");
  assert.equal(realpathSync(dirname(entry)), join(expected, "keyring"), "never replace a linked native dependency");
  const nativeManifest = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8"));
  assert.equal(nativeManifest.name, "@napi-rs/keyring");
  // Remove both the JS loader and its optional native packages. Even a child
  // losing NODE_OPTIONS cannot fall through from this mock to the OS store.
  for (const name of readdirSync(scope)) {
    if (name === "keyring" || name.startsWith("keyring-")) rmSync(join(scope, name), { recursive: true });
  }
  const mock = join(scope, "keyring");
  mkdirSync(mock);
  writeFileSync(join(mock, "package.json"), JSON.stringify({
    name: "@napi-rs/keyring", version: "0.0.0-package-smoke-mock", main: "index.js"
  }));
  const markers = join(root, "native guard markers");
  mkdirSync(markers);
  const guard = join(root, "package-native-guard.cjs");
  writeFileSync(guard, `
const fs = require('node:fs');
const path = require('node:path');
// npm exec prepends ancestor node_modules/.bin entries in its child PATH.
// Restore the fixture path before that child imports any application code.
const allowedEnv = new Set(${JSON.stringify([...Object.keys(env), "NODE_OPTIONS"])});
for (const name of Object.keys(process.env)) if (!allowedEnv.has(name)) delete process.env[name];
process.env.PATH = ${JSON.stringify(env.PATH)};
const blocked = () => {
  process.stderr.write('PACKAGE_SMOKE_NATIVE_LOAD_BLOCKED\\n');
  process.exit(86); // cannot be swallowed by the vault's availability catch
};
Object.defineProperty(process, 'dlopen', { value: blocked, writable: false, configurable: false });
require('node:module')._extensions['.node'] = blocked;
globalThis[Symbol.for('api-key-case.package-smoke-native-guard')] = true;
fs.writeFileSync(path.join(${JSON.stringify(markers)}, String(process.pid)), 'guarded');
`);
  writeFileSync(join(mock, "index.js"), `
if (!globalThis[Symbol.for('api-key-case.package-smoke-native-guard')]) {
  process.stderr.write('PACKAGE_SMOKE_GUARD_MISSING\\n');
  process.exit(87);
}
require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(markers)}, 'mock-' + process.pid), 'unavailable-mock');
const unavailable = () => { throw new Error('Package smoke mock: OS keyring unavailable'); };
exports.Entry = class Entry {
  constructor(service, account) { this.service = service; this.account = account; }
  setPassword() { unavailable(); }
  getPassword() { unavailable(); }
  deleteCredential() { unavailable(); }
};
`);
  // Replace inherited options rather than allowing a preloaded module to run
  // before the guard. This is a disposable test-process environment only.
  return { env: { ...env, NODE_OPTIONS: `--require ${JSON.stringify(guard)}` }, markers, mock };
}
