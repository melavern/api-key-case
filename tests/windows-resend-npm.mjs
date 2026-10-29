import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { Entry } from "@napi-rs/keyring";
import { runResendCredentialValidation } from "../dist/core/deploy/handoff.js";
import { currentResolvedCli, isSameResolvedCli, resolveTrustedCli } from "../dist/core/deploy/which.js";

export async function runWindowsResendNpmTests() {
  const root = mkdtempSync(join(tmpdir(), "akc npm & unicode-日本語-"));
  const original = Entry.prototype.getPassword;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  const synthetic = "re_synthetic_windows_npm_42abcd";
  let reads = 0;
  Entry.prototype.getPassword = () => { reads++; return synthetic; };
  try {
    const bin = join(root, "bin"), runtimeDir = join(root, "runtime"), project = join(root, "project");
    const packageDir = join(bin, "node_modules", "resend-cli"), bundle = join(packageDir, "dist", "cli.cjs");
    for (const dir of [project, runtimeDir, join(packageDir, "dist")]) mkdirSync(dir, { recursive: true });
    const runtime = join(runtimeDir, "node.exe"), shimMarker = join(root, "shim-executed");
    // A disposable copy avoids symlink privileges/cross-volume hard links and
    // never changes the installed runtime during replacement tests.
    copyFileSync(process.execPath, runtime);
    const manifest = { name: "resend-cli", version: "2.23.0", engines: { node: ">=22" }, bin: { resend: "./dist/cli.cjs" } };
    writeFileSync(join(packageDir, "package.json"), JSON.stringify(manifest));
    for (const extension of ["cmd", "bat"]) writeFileSync(join(bin, `resend.${extension}`), `@echo ${synthetic} > "${shimMarker}"\n`);
    const output = (status, message) => JSON.stringify({ ok: status !== "fail", checks: [
      { name: "CLI Version", status: "warn", message: "v2.23.0 (could not check for updates)" },
      { name: "API Key", status: "pass", message: "re_...abcd (source: env)" },
      { name: "Credential Storage", status: "warn", message: "plaintext file" },
      { name: status === "pass" ? "Domains" : "API Validation", status, message }
    ] });
    const fixture = (data = output("pass", "1 verified, 0 pending"), exit = 0, version = "2.23.0", extra = "") => {
      writeFileSync(bundle, `if(process.argv.slice(2).join(' ')==='--version'){console.log(${JSON.stringify(version)});process.exit(0)}\n` +
        `if(process.argv.slice(2).join(' ')!=='doctor --json'||process.argv.includes(${JSON.stringify(synthetic)}))process.exit(9);\n` +
        `if(process.env.RESEND_API_KEY!==${JSON.stringify(synthetic)})process.exit(10);\n` +
        `for(const k of ['NODE_OPTIONS','NODE_PATH','RESEND_PROFILE','HTTPS_PROXY','RESEND_BASE_URL'])if(process.env[k])process.exit(11);\n` +
        `if(process.env.NODE_ENV!=='production')console.error('[Resend API Error]: synthetic SDK debug output');\n` +
        `const canonical=p=>require('node:fs').realpathSync.native(p);\n` +
        `if(canonical(process.env.HOME)!==canonical(process.cwd())||canonical(process.env.XDG_CONFIG_HOME)!==canonical(process.cwd()))process.exit(12);\n` +
        extra + `console.log(${JSON.stringify(data)});process.exit(${exit});\n`);
      return createHash("sha256").update(readFileSync(bundle)).digest("hex");
    };
    const resolve = (digest) => resolveTrustedCli("resend", { pathOverride: [bin, runtimeDir].join(delimiter),
      projectDir: project, platformOverride: "win32", resendBundleHashOverride: digest });
    const ref = { name: "RESEND_API_KEY", scope: "user", projectId: null };
    const run = (cli, stillCurrent = () => true) => runResendCredentialValidation({ ref, cli, stillCurrent });
    let digest = fixture(), cli = resolve(digest);
    assert.ok(cli?.interpreter);
    assert.equal(cli.isWindowsScript, false);
    assert.equal(cli.realPath, currentResolvedCli(cli).realPath);
    assert.equal(resolve(undefined), null, "unreviewed bytes cannot use the production bundle digest");
    for (const change of [{ version: "99.0.0" }, { name: "resend" }, { bin: { resend: "../../attacker.cjs" } }, { engines: { node: ">=20" } }]) {
      writeFileSync(join(packageDir, "package.json"), JSON.stringify({ ...manifest, ...change }));
      assert.equal(resolve(digest), null);
    }
    writeFileSync(join(packageDir, "package.json"), JSON.stringify(manifest));
    assert.equal(resolveTrustedCli("resend", { pathOverride: bin, projectDir: project, platformOverride: "win32", resendBundleHashOverride: digest }), null,
      "runtime must be resolved from trusted directories, never ambient PATH");
    assert.equal(resolveTrustedCli("resend", { pathOverride: [bin, runtimeDir].join(delimiter), projectDir: root, platformOverride: "win32", resendBundleHashOverride: digest }), null,
      "workspace-owned installations are rejected");
    if (Number(process.versions.node.split('.')[0]) >= 22) {
      // Actual process launches on Windows as well as portable CI. No real key/store/provider.
      for (const [data, exit, expected] of [
        [output("pass", "1 verified, 0 pending"), 0, "valid-full-access"],
        [output("warn", "Sending-only API key"), 0, "valid-sending-access"],
        [output("fail", "Invalid API key: API key is invalid"), 1, "invalid-credential"],
        [output("warn", "Network error. Check your connection and try again"), 0, "network-unavailable"],
        ["not json", 0, "unexpected-output"],
        [output("pass", "1 verified, 0 pending"), 1, "unexpected-output"],
        ["x".repeat(70000), 0, "unexpected-output"],
        [output("fail", "Invalid API key: Internal server error"), 1, "unknown"]
      ]) {
        digest = fixture(data, exit); cli = resolve(digest);
        const code = await run(cli);
        assert.equal(code, expected);
        assert.ok(!JSON.stringify(code).includes(synthetic));
      }
      digest = fixture(undefined, 0, "99.0.0");
      const beforeVersion = reads;
      assert.equal(await run(resolve(digest)), "cli-unavailable");
      assert.equal(reads, beforeVersion);
      digest = fixture(undefined, 0, "2.23.0", `console.error(${JSON.stringify(synthetic)});`);
      assert.equal(await run(resolve(digest)), "unexpected-output");
      digest = fixture(undefined, 0, "2.23.0", "while(true){}\n");
      assert.equal(await run(resolve(digest)), "network-unavailable", "hung child is bounded and never a successful check");
      for (const target of [bundle, runtime]) {
        digest = fixture(); cli = resolve(digest);
        let guards = 0;
        assert.equal(await run(cli, async () => {
          if (++guards === 3) {
            if (target === runtime) rmSync(runtime);
            writeFileSync(target, "replaced executable");
          }
          return true;
        }), "unknown", "replacement during awaited pre-spawn guard prevents dispatch");
        assert.equal(isSameResolvedCli(cli, currentResolvedCli(cli)), false);
        if (target === runtime) { rmSync(runtime); copyFileSync(process.execPath, runtime); }
      }
      digest = fixture(); cli = resolve(digest);
      rmSync(runtime); writeFileSync(runtime, "not a supported Node runtime"); chmodSync(runtime, 0o700);
      const beforeRuntime = reads;
      assert.ok(["cli-unavailable", "unknown"].includes(await run(resolve(digest))),
        "OS spawn errors stay unknown; neither result permits credential reads");
      assert.equal(reads, beforeRuntime, "unavailable runtime is rejected before value-bearing read");
    }
    assert.equal(existsSync(shimMarker), false, "cmd/bat are never executed");
  } finally {
    Entry.prototype.getPassword = original;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
    rmSync(root, { recursive: true, force: true });
  }
}
