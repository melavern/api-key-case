// Disposable compiled candidate only; production gates and the native store remain untouched.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
export function runFixture() {
  const repo = fileURLToPath(new URL("..", import.meta.url)), root = mkdtempSync(join(tmpdir(), "akc-generic-delivery-"));
  try {
    cpSync(join(repo, "dist"), join(root, "dist"), { recursive: true });
    mkdirSync(join(root, "tests")); mkdirSync(join(root, "node_modules"));
    for (const name of ["vnext-cloudflare.mjs", "vnext-cloudflare-fixture.mjs"]) cpSync(join(repo, "tests", name), join(root, "tests", name));
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", private: true }));
    for (const name of readdirSync(join(repo, "node_modules"))) {
      if (name === "@napi-rs") continue;
      const from = join(repo, "node_modules", name), to = join(root, "node_modules", name);
      if (statSync(from).isDirectory()) symlinkSync(from, to, process.platform === "win32" ? "junction" : undefined); else cpSync(from, to);
    }
    const mock = join(root, "node_modules", "@napi-rs", "keyring"); mkdirSync(mock, { recursive: true });
    writeFileSync(join(mock, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
    writeFileSync(join(mock, "index.js"), `export class Entry { constructor(service,account){this.account=account;} getPassword(){return globalThis.syntheticRead(this.account);} setPassword(){throw Error('No store writes');} deleteCredential(){throw Error('No deletion');} }`);
    const gatesPath = join(root, "dist/core/vnext/gates.js"), gates = readFileSync(gatesPath, "utf8"), guard = /VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED = (?:false|true)/g;
    assert.equal([...gates.matchAll(guard)].length, 1); writeFileSync(gatesPath, gates.replace(guard, "VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED = true"));
    for (const name of ["dist/core/vnext/use.js", "dist/core/deploy/handoff.js"]) {
      const path = join(root, name), source = readFileSync(path, "utf8"), hostGuard = '!VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED || process.platform !== "win32"';
      const count = source.split(hostGuard).length - 1; assert.ok(count >= 1 && count <= 2);
      writeFileSync(path, source.replaceAll(hostGuard, "!VNEXT_WINDOWS_CLOUDFLARE_ACCEPTED"));
    }
    const handoffPath = join(root, "dist/core/deploy/handoff.js"), handoff = readFileSync(handoffPath, "utf8");
    const timeoutCall = "deployment.argv.slice(1), value, 120_000";
    assert.equal(handoff.split(timeoutCall).length, 2);
    // Shorten only this disposable generic transport timeout, never the shipped default.
    writeFileSync(handoffPath, handoff.replace(timeoutCall, "deployment.argv.slice(1), value, 1000"));
    const env = { ...process.env, AKC_DISPOSABLE_GENERIC_TEST: "1" };
    delete env.NODE_TEST_CONTEXT; // A nested Node test runner otherwise skips every child test.
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(root, "tests/vnext-cloudflare.mjs")], {
      env, encoding: "utf8", timeout: 240_000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-generic-stdin-canary-QZ91|provider-partial-canary-AB72/);
    process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.equal(result.status, 0);
    assert.ok(Number(result.stdout.match(/^# tests (\d+)$/m)?.[1]) >= 25, "child tests actually ran");
  } finally { rmSync(root, { recursive: true, force: true }); }
}
