// A fresh D-Bus session and fresh XDG data directory keep all synthetic values
// away from the user's existing keyring. No desktop login keyring is replaced.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repo = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(import.meta.url);
assert.equal(process.platform, "linux", "This verification lane requires Linux.");
assert.ok(process.env.npm_execpath, "Run with npm run test:keyring:linux.");

if (process.argv[2] !== "--session") {
  const root = mkdtempSync(join(tmpdir(), "akc-linux-keyring-"));
  try {
    for (const name of ["data", "runtime", "control"]) mkdirSync(join(root, name), { mode: 0o700 });
    const result = spawnSync("dbus-run-session", ["--", process.execPath, script, "--session", root,
      ...(process.argv.includes("--offline") ? ["--offline"] : [])], {
      cwd: repo,
      env: { ...process.env, XDG_DATA_HOME: join(root, "data"), XDG_RUNTIME_DIR: join(root, "runtime"),
        GNOME_KEYRING_CONTROL: join(root, "control"), AKC_ISOLATED_KEYRING_TEST: "1" },
      stdio: "inherit", timeout: 300_000
    });
    assert.equal(result.error, undefined, "could not run the isolated D-Bus session");
    assert.equal(result.status, 0, "isolated keyring verification failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} else {
  const root = process.argv[3];
  assert.equal(process.env.AKC_ISOLATED_KEYRING_TEST, "1");
  assert.equal(process.env.XDG_DATA_HOME, join(root, "data"));
  const daemon = spawn("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets", "--control-directory", join(root, "control")], {
    cwd: root, stdio: ["pipe", "ignore", "ignore"]
  });
  let daemonError;
  daemon.on("error", (error) => { daemonError = error; });
  daemon.stdin.on("error", () => {});
  daemon.stdin.end("api-key-case-disposable-test-keyring\n");
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (daemonError || daemon.exitCode !== null) break;
      const probe = spawnSync("dbus-send", ["--session", "--print-reply", "--dest=org.freedesktop.DBus",
        "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames"], { encoding: "utf8", timeout: 2000 });
      if (probe.status === 0 && probe.stdout.includes('"org.freedesktop.secrets"')) { ready = true; break; }
      await delay(100);
    }
    assert.equal(ready, true, "gnome-keyring must start in the disposable Secret Service session");
    console.log("Isolated Linux Secret Service started.");
    const suite = spawnSync(process.execPath, [process.env.npm_execpath, "test"], {
      cwd: repo, stdio: "inherit", timeout: 180_000,
      env: { ...process.env, AGENT_KEY_CASE_E2E: "1", AGENT_KEY_CASE_E2E_STRICT: "1" }
    });
    assert.equal(suite.error, undefined);
    assert.equal(suite.status, 0, "strict OS-store suite must pass without skips");
    const artifact = spawnSync(process.execPath, [join(repo, "tests/package-smoke.mjs"), "--with-keyring",
      ...(process.argv.includes("--offline") ? ["--offline"] : [])], {
      cwd: repo, stdio: "inherit", timeout: 180_000
    });
    assert.equal(artifact.error, undefined);
    assert.equal(artifact.status, 0, "installed artifact must work against the real test keyring");
    console.log("Linux keyring and installed package verification passed.");
  } finally {
    daemon.kill("SIGTERM");
    for (let attempt = 0; daemon.exitCode === null && daemon.signalCode === null && attempt < 20; attempt++) await delay(50);
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
  }
}
