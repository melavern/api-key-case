import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { captureProfile, launchFile, launchVariable, npmSelection } from "../dist/core/local/profile-snapshot.js";
import { spawnWindowsProfileOwner, WINDOWS_PROFILE_OWNER_SOURCE, profileOwnerConfig } from "../dist/core/local/windows-launch-owner.js";

const canary = "akc-synthetic-owner-CB91";
const pythonProbe = process.platform === "win32" ? spawnSync(join(homedir(), "AppData/Local/Programs/Python/Launcher/py.exe"), ["-0p"], { encoding: "utf8", windowsHide: true }) : null;
const python = (pythonProbe?.stdout ?? "").split(/\r?\n/).map(line => line.match(/([A-Za-z]:\\.+\\python.exe)\s*$/i)?.[1]).find(Boolean);
function fixture(kind = "node-entry", duration = 15) {
  const root = mkdtempSync(join(tmpdir(), "akc-profile-owner-")), app = join(root, "app"); mkdirSync(app);
  const runtime = kind.startsWith("node-") ? process.execPath : python, file = launchFile(runtime);
  const profile = { id: randomUUID(), projectId: randomUUID(), kind, runtimeIdentity: { executable: file.path, fingerprint: file.fingerprint },
    cwd: ".", approvedEntryOrScript: kind === "node-package-script" ? "dev" : kind === "python-module" ? "main" : kind === "node-entry" ? "main.cjs" : "main.py",
    bindingIds: [randomUUID(), randomUUID()], maxDurationSeconds: duration, revision: 1, reviewedAt: new Date().toISOString() };
  const marker = join(app, "result.json");
  writeFileSync(join(app, "main.cjs"), `const fs=require('fs');if(process.env.OTHER_KEY!==${JSON.stringify(canary)}||process.env.other_key2!==${JSON.stringify(canary)}||process.env.NODE_OPTIONS||process.env.PYTHONPATH)process.exit(31);console.log(process.env.OTHER_KEY);console.error(process.env.OTHER_KEY);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,ok:true}));setTimeout(()=>{},200);`);
  writeFileSync(join(app, "main.py"), `import os,json,sys,time\nassert os.environ['OTHER_KEY']==${JSON.stringify(canary)} and os.environ['other_key2']==${JSON.stringify(canary)}\nassert 'PYTHONPATH' not in os.environ\nprint(os.environ['OTHER_KEY'])\nprint(os.environ['OTHER_KEY'],file=sys.stderr)\nwith open(${JSON.stringify(marker)},'w') as f: json.dump({'pid':os.getpid(),'ok':True},f)\ntime.sleep(0.2)\n`);
  writeFileSync(join(app, "package.json"), JSON.stringify({ private: true, scripts: { dev: "node main.cjs" } }));
  writeFileSync(join(app, "package-lock.json"), JSON.stringify({ name: "synthetic", lockfileVersion: 3, packages: {} }));
  if (kind === "node-package-script") profile.packageManifestRevision = npmSelection(app, ".", runtime, "dev").revision;
  const snapshot = captureProfile(app, profile, ["OTHER_KEY", "other_key2"]);
  return { root, app, marker, profile, snapshot, close: () => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}
async function run(f, action) {
  const owner = spawnWindowsProfileOwner(f.snapshot, f.profile), lines = [], pending = []; let closed = false, transcript = "";
  const timer = setTimeout(() => owner.kill(), 30000);
  owner.stdout.setEncoding("utf8"); let buffer = "";
  owner.stdout.on("data", chunk => { transcript += chunk; assert.ok(!chunk.includes(canary)); buffer += chunk;
    for (;;) { const pos = buffer.indexOf("\n"); if (pos < 0) break; const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1); lines.push(line); pending.shift()?.(); } });
  const ended = new Promise(resolve => owner.once("close", () => { closed = true; for (const notify of pending.splice(0)) notify(); resolve(); }));
  const next = async () => { while (!lines.length && !closed) await new Promise(resolve => pending.push(resolve)); return lines.shift(); };
  try {
    assert.equal(await next(), "READY");
    owner.stdin.write(JSON.stringify({ value0: canary, value1: canary }) + "\n"); assert.equal(await next(), "CREATED");
    owner.stdin.write("RELEASE\n"); assert.equal(await next(), "STARTED");
    if (action) await action(owner, next); else assert.equal(await next(), "EXITED");
    await ended; assert.equal(buffer, ""); assert.doesNotMatch(transcript, /akc-synthetic-owner/);
  } finally { clearTimeout(timer); owner.stdin.destroy(); if (!closed) owner.kill(); await ended; }
}
test("profile owner has atomic job assignment, null stdio and no legacy fixed secret", () => {
  assert.match(WINDOWS_PROFILE_OWNER_SOURCE, /0x0002000D/); assert.match(WINDOWS_PROFILE_OWNER_SOURCE, /CREATE_SUSPENDED/);
  assert.match(WINDOWS_PROFILE_OWNER_SOURCE, /startup.basic.stdout = nul/); assert.doesNotMatch(WINDOWS_PROFILE_OWNER_SOURCE, /RESEND_API_KEY|extern bool AssignProcessToJobObject/);
  assert.match(WINDOWS_PROFILE_OWNER_SOURCE, /line.Length < 1048576/);
  for (const name of ["NODE_OPTIONS", "PYTHONPATH", "PATH", "npm_config_script_shell", "ComSpec", "__COMPAT_LAYER", "custom_key\n"]) assert.throws(() => launchVariable(name));
  assert.equal(launchVariable("custom_Api_Key"), "custom_Api_Key");
});
test("editable source stays current while manifest and runtime selection changes invalidate", () => {
  const f = fixture(); try {
    writeFileSync(join(f.app, "main.cjs"), "// edited ordinary source\n"); assert.equal(f.snapshot.current(), true);
    writeFileSync(join(f.app, "package.json"), "{}"); assert.equal(f.snapshot.current(), false);
    assert.ok(!JSON.stringify(profileOwnerConfig(f.snapshot, f.profile)).includes(canary));
  } finally { f.close(); }
});
for (const kind of ["node-entry", "node-package-script", "python-entry", "python-module"]) test(`Windows native owner ${kind}: multiple variables, null output, confirmed exit`, { skip: process.platform !== "win32" || kind.startsWith("python-") && !python }, async () => {
  const f = fixture(kind); try { await run(f); assert.equal(JSON.parse(readFileSync(f.marker, "utf8")).ok, true); } finally { f.close(); }
});
test("Windows timeout owns and terminates a real child tree", { skip: process.platform !== "win32" }, async () => {
  const f = fixture("node-entry", 3), heartbeat = join(f.app, "heartbeat");
  try {
    writeFileSync(join(f.app, "child.cjs"), `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),40);`);
    writeFileSync(join(f.app, "main.cjs"), `require('child_process').spawn(process.execPath,['child.cjs'],{stdio:'ignore'});setInterval(()=>{},100);`);
    await run(f, async (_owner, next) => assert.equal(await next(), "EXPIRED"));
    const before = readFileSync(heartbeat, "utf8"); await new Promise(resolve => setTimeout(resolve, 250)); assert.equal(readFileSync(heartbeat, "utf8"), before);
  } finally { f.close(); }
});
test("Windows cancellation closes ownership before returning", { skip: process.platform !== "win32" }, async () => {
  const f = fixture(); try {
    writeFileSync(join(f.app, "main.cjs"), "setInterval(()=>{},100)");
    await run(f, async (owner, next) => { owner.stdin.write("CANCEL\n"); assert.equal(await next(), "CANCELLED"); });
    assert.equal(existsSync(f.marker), false);
  } finally { f.close(); }
});
test("Windows abrupt owner death kills its live descendants", { skip: process.platform !== "win32" }, async () => {
  const f = fixture(), heartbeat = join(f.app, "heartbeat");
  try {
    writeFileSync(join(f.app, "child.cjs"), `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),30);`);
    writeFileSync(join(f.app, "main.cjs"), "require('child_process').spawn(process.execPath,['child.cjs'],{stdio:'ignore'});setInterval(()=>{},100)");
    await run(f, async (owner, next) => { while (!existsSync(heartbeat)) await new Promise(resolve => setTimeout(resolve, 30)); owner.kill(); assert.equal(await next(), undefined); });
    const before = readFileSync(heartbeat, "utf8"); await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(readFileSync(heartbeat, "utf8"), before);
  } finally { f.close(); }
});
test("Windows parent process.exit leaves no unowned descendants", { skip: process.platform !== "win32" }, async () => {
  const f = fixture(), heartbeat = join(f.app, "heartbeat");
  try {
    writeFileSync(join(f.app, "child.cjs"), `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),30);`);
    writeFileSync(join(f.app, "main.cjs"), "require('child_process').spawn(process.execPath,['child.cjs'],{stdio:'ignore'});setInterval(()=>{},100)");
    const request = join(f.root, "parent.json"); writeFileSync(request, JSON.stringify({ app: f.app, profile: f.profile }));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./helpers/vnext-owner-parent.mjs", import.meta.url)), request], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    assert.equal(child.status, 73); assert.equal(child.stdout, ""); assert.equal(child.stderr, "");
    await new Promise(resolve => setTimeout(resolve, 500)); const before = readFileSync(heartbeat, "utf8");
    await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(readFileSync(heartbeat, "utf8"), before);
  } finally { await new Promise(resolve => setTimeout(resolve, 300)); f.close(); }
});
test("Windows ordinary modules can reload after source edits during a session", { skip: process.platform !== "win32" }, async () => {
  const f = fixture(), loaded = join(f.app, "loaded.json"), editable = join(f.app, "editable.cjs");
  try {
    writeFileSync(editable, "module.exports='original'");
    writeFileSync(join(f.app, "main.cjs"), `const fs=require('fs');setInterval(()=>{delete require.cache[require.resolve('./editable.cjs')];fs.writeFileSync(${JSON.stringify(loaded)},JSON.stringify(require('./editable.cjs')))},40);`);
    await run(f, async (owner, next) => {
      while (!existsSync(loaded)) await new Promise(resolve => setTimeout(resolve, 30));
      writeFileSync(editable, "module.exports='edited'"); assert.equal(f.snapshot.current(), true);
      const until = Date.now() + 2000; while (JSON.parse(readFileSync(loaded, "utf8")) !== "edited" && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(JSON.parse(readFileSync(loaded, "utf8")), "edited"); owner.stdin.write("CANCEL\n"); assert.equal(await next(), "CANCELLED");
    });
  } finally { f.close(); }
});
