// Runs the real api-key-case CLI against the sandbox project and records what
// it printed, verbatim, into build/transcript.json.
//
// Nothing in the pipeline downstream of this file invents CLI output. Every
// terminal line in the finished video comes from this transcript.
//
// Each command runs inside a genuine pty (see lib/pty.mjs), so the interactive
// paths — the hidden `save` prompt and the production confirmation — exercise
// exactly the same code a human hits, including the TTY checks that reject
// piped input.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  BUILD_DIR,
  CLI_ENTRY,
  DEMO_SECRET_NAME,
  DEMO_SECRET_VALUE,
  PTY,
  REPO_DIR,
  SANDBOX_DIR,
  TRANSCRIPT_PATH
} from "./config.mjs";
import { removeDemoSecret } from "./cleanup-demo.mjs";
import { isMain } from "./lib/main.mjs";
import { runInPty } from "./lib/pty.mjs";
import { trimLeadingBlank } from "./lib/screen.mjs";
import { setupSandbox } from "./setup-demo.mjs";

const SHIM_DIR = join(BUILD_DIR, "bin");

// A launcher named exactly like the published bin, so the pty really does run
// `api-key-case ...` rather than `node dist/cli/index.js ...`. It resolves the
// local build instead of the npm registry copy, which is the point: the video
// shows this working tree, not a release.
function writeShim() {
  mkdirSync(SHIM_DIR, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(join(SHIM_DIR, "api-key-case.cmd"), `@node "${CLI_ENTRY}" %*\r\n`, "utf8");
  } else {
    const shim = join(SHIM_DIR, "api-key-case");
    writeFileSync(shim, `#!/bin/sh\nexec node "${CLI_ENTRY}" "$@"\n`, { encoding: "utf8", mode: 0o755 });
  }
}

function shimEnv() {
  return { PATH: `${SHIM_DIR}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` };
}

async function record(step) {
  const started = Date.now();
  const argv = ["api-key-case", ...step.args];
  const spawn =
    process.platform === "win32"
      ? { file: "cmd.exe", args: ["/d", "/s", "/c", argv.join(" ")] }
      : { file: "/bin/sh", args: ["-c", argv.join(" ")] };

  const result = await runInPty({
    ...spawn,
    cwd: step.cwd ?? SANDBOX_DIR,
    env: shimEnv(),
    cols: PTY.cols,
    rows: PTY.rows,
    steps: step.steps,
    timeoutMs: step.timeoutMs
  });

  const lines = trimLeadingBlank(result.lines);
  console.log(`  ${argv.join(" ")}  ->  exit ${result.exitCode}, ${lines.length} lines`);

  return {
    id: step.id,
    display: argv.join(" "),
    argv,
    cwd: step.cwd ?? SANDBOX_DIR,
    exitCode: result.exitCode,
    expectedExitCode: step.expectExit ?? 0,
    durationMs: Date.now() - started,
    lines
  };
}

async function clearSandboxSecret() {
  if (await removeDemoSecret()) {
    console.log(`  cleared a leftover ${DEMO_SECRET_NAME} from the sandbox scope`);
  }
}

function cliVersion() {
  const pkg = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf8"));
  return pkg.version;
}

function ensureBuilt() {
  if (existsSync(CLI_ENTRY)) return;
  console.log("dist/ missing — running npm run build ...");
  const result = spawnSync("npm", ["run", "build"], {
    cwd: REPO_DIR,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    throw new Error("npm run build failed; cannot capture a demo against a stale build.");
  }
}

export async function capture() {
  ensureBuilt();
  mkdirSync(BUILD_DIR, { recursive: true });
  writeShim();

  console.log("building sandbox project ...");
  setupSandbox();

  // The sandbox path is stable, so a previous run's demo secret may still be
  // registered under it and `save` would refuse to overwrite. Clearing it
  // keeps capture repeatable. Scope is derived from the sandbox cwd, so this
  // can only ever match the demo's own entry.
  await clearSandboxSecret();

  console.log("capturing real CLI runs ...");

  const commands = [];

  commands.push(await record({ id: "scan", args: ["scan", "."], expectExit: 0 }));

  commands.push(
    await record({
      id: "save",
      args: ["save", DEMO_SECRET_NAME],
      expectExit: 0,
      steps: [{ waitFor: "(input is hidden):", send: `${DEMO_SECRET_VALUE}\r` }]
    })
  );

  commands.push(await record({ id: "check", args: ["check"], expectExit: 0 }));

  commands.push(await record({ id: "targets", args: ["targets"], expectExit: 0 }));

  commands.push(
    await record({
      id: "deployDryRun",
      args: ["deploy", DEMO_SECRET_NAME, "--target", "cloudflare", "--env", "production", "--dry-run"],
      expectExit: 0
    })
  );

  // Answered "no" on purpose: the point of the shot is that production cannot
  // proceed without a typed confirmation. Nothing is sent to Cloudflare, and
  // the CLI returns before it ever reads the stored value.
  commands.push(
    await record({
      id: "deployConfirm",
      args: ["deploy", DEMO_SECRET_NAME, "--target", "cloudflare", "--env", "production"],
      expectExit: 4,
      steps: [{ waitFor: "Type 'yes' to deploy to production:", send: "no\r" }]
    })
  );

  const transcript = {
    recordedAt: new Date().toISOString(),
    // Repo-relative on purpose: an absolute path would carry the account name
    // into an artifact that gets published alongside the video.
    cli: { version: cliVersion(), entry: relative(REPO_DIR, CLI_ENTRY).replace(/\\/g, "/") },
    environment: { platform: process.platform, node: process.version },
    sandbox: SANDBOX_DIR,
    secretName: DEMO_SECRET_NAME,
    commands
  };

  assertNoSecretLeaked(transcript);
  assertExpectedExitCodes(transcript);

  writeFileSync(TRANSCRIPT_PATH, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
  console.log(`transcript written: ${TRANSCRIPT_PATH}`);
  return transcript;
}

// The demo value is typed into a non-echoing prompt, so it should never reach
// the transcript. This asserts it rather than assuming it.
function assertNoSecretLeaked(transcript) {
  const serialized = JSON.stringify(transcript);
  if (serialized.includes(DEMO_SECRET_VALUE)) {
    throw new Error("SECURITY: the demo secret value appeared in the transcript. Aborting.");
  }
}

function assertExpectedExitCodes(transcript) {
  for (const command of transcript.commands) {
    if (command.exitCode !== command.expectedExitCode) {
      throw new Error(
        `${command.display} exited ${command.exitCode}, expected ${command.expectedExitCode}.\n` +
          command.lines.join("\n")
      );
    }
  }
}

if (isMain(import.meta.url)) {
  capture().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
