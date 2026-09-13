import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanProject } from "../dist/core/scanner.js";
import { buildTrustedExecution } from "../dist/core/deploy/snapshot.js";
import { initializeAgentInstructions } from "../dist/core/agent/init.js";
import {
  buildMacOSSecretInputScript,
  buildWindowsSecretInputScript,
  WINDOWS_CREDENTIAL_BLOB_MAX_BYTES
} from "../dist/core/human/index.js";
import { deriveProjectId } from "../dist/core/vault/naming.js";
import { promptSecretValue } from "../dist/cli/prompt.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT_ID = "fedcba9876543210fedcba9876543210";
const CONFIG_SECRET = "synthetic-config-secret-0123456789";

export async function runPublicBlockerTests() {
  const root = mkdtempSync(join(tmpdir(), "api-key-case-public-blockers-"));
  try {
    testGeneratedFileBoundaries(root);
    testAgentInstructionBoundaries(root);
    testProjectIdentityBoundaries(root);
    await testSecretInputPreservesOpaqueValues();
    testCloudflareDestinationParsing(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testAgentInstructionBoundaries(root) {
  const project = join(root, "u1-agent-init-project");
  const outside = join(root, "u1-agent-init-outside");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const outsideFile = join(outside, "AGENTS.md");
  writeText(outside, "AGENTS.md", "outside agent instructions\n");
  const linked = join(project, "AGENTS.md");
  symlinkSync(outsideFile, linked);
  assert.throws(
    () => initializeAgentInstructions({ projectDir: project, packageVersion: "0.9.1", check: false }),
    /unsafe/i
  );
  assert.equal(readlinkSync(linked), outsideFile);
  assert.equal(readFileSync(outsideFile, "utf8"), "outside agent instructions\n");

  const hardlinkProject = join(root, "u1-agent-init-hardlink");
  mkdirSync(hardlinkProject, { recursive: true });
  const hardlink = join(hardlinkProject, "AGENTS.md");
  try {
    linkSync(outsideFile, hardlink);
  } catch {
    return;
  }
  assert.throws(
    () => initializeAgentInstructions({ projectDir: hardlinkProject, packageVersion: "0.9.1", check: false }),
    /unsafe/i
  );
  assert.equal(readFileSync(outsideFile, "utf8"), "outside agent instructions\n");
}

function testGeneratedFileBoundaries(root) {
  const project = join(root, "u1-project");
  const outside = join(root, "outside");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeText(project, "app.ts", "process.env.INSIDE_API_KEY;\n");

  const outsideEnv = join(outside, "env-example-target.txt");
  writeText(outside, "env-example-target.txt", "OUTSIDE_ONLY=must-not-be-read\n");
  const envExample = join(project, ".env.example");
  symlinkSync(outsideEnv, envExample);
  const linkBefore = readlinkSync(envExample);
  const outsideBefore = readFileSync(outsideEnv, "utf8");

  const readDenied = scanProject({ targetDir: project });
  assert.equal(readDenied.requiredSecrets.includes("OUTSIDE_ONLY"), false);
  assert.match(readDenied.envExample.reason ?? "", /unsafe|refus/i);

  const forceDenied = scanProject({ targetDir: project, writeEnvExample: true, force: true });
  assert.equal(forceDenied.envExample.written, false);
  assert.equal(readlinkSync(envExample), linkBefore);
  assert.equal(readFileSync(outsideEnv, "utf8"), outsideBefore);

  const outsideReport = join(outside, "agent-report-target.txt");
  writeText(outside, "agent-report-target.txt", "keep this outside file\n");
  const agentContext = join(project, "AGENT_CONTEXT.safe.md");
  symlinkSync(outsideReport, agentContext);
  const agentDenied = scanProject({ targetDir: project, agentReport: true, force: true });
  const agentContextState = agentDenied.agentReport.files.find(
    (file) => file.path === "AGENT_CONTEXT.safe.md"
  );
  assert.equal(agentContextState?.written, false);
  assert.match(agentContextState?.reason ?? "", /unsafe|refus/i);
  assert.equal(readlinkSync(agentContext), outsideReport);
  assert.equal(readFileSync(outsideReport, "utf8"), "keep this outside file\n");

  const normal = join(root, "u1-normal");
  mkdirSync(normal, { recursive: true });
  writeText(normal, "app.ts", "process.env.NORMAL_API_KEY;\n");
  writeText(normal, ".env.example", "NORMAL_API_KEY=\n");
  const normalReport = scanProject({ targetDir: normal });
  assert.equal(normalReport.requiredSecrets.includes("NORMAL_API_KEY"), true);
  const normalForced = scanProject({ targetDir: normal, writeEnvExample: true, force: true });
  assert.equal(normalForced.envExample.written, true);
  assert.match(readFileSync(join(normal, ".env.example"), "utf8"), /NORMAL_API_KEY=\n/);

  const hardlinkProject = join(root, "u1-hardlink");
  mkdirSync(hardlinkProject, { recursive: true });
  writeText(hardlinkProject, "app.ts", "process.env.HARDLINK_INSIDE;\n");
  const hardlinkTarget = join(outside, "hardlink-target.txt");
  writeText(outside, "hardlink-target.txt", "HARDLINK_OUTSIDE=must-not-be-read\n");
  const hardlinkExample = join(hardlinkProject, ".env.example");
  let hardlinkAvailable = true;
  try {
    linkSync(hardlinkTarget, hardlinkExample);
  } catch {
    // Hardlinks can be unavailable in restricted Windows test environments.
    hardlinkAvailable = false;
  }
  if (hardlinkAvailable) {
    const hardlinkBefore = readFileSync(hardlinkTarget, "utf8");
    const hardlinkReport = scanProject({ targetDir: hardlinkProject, writeEnvExample: true, force: true });
    assert.equal(hardlinkReport.requiredSecrets.includes("HARDLINK_OUTSIDE"), false);
    assert.equal(hardlinkReport.envExample.written, false);
    assert.match(hardlinkReport.envExample.reason ?? "", /unsafe|refus/i);
    assert.equal(readFileSync(hardlinkTarget, "utf8"), hardlinkBefore);
    assert.ok(lstatSync(hardlinkExample).nlink > 1);
  }

  if (process.platform === "win32") {
    const junctionTarget = join(outside, "junction-target");
    mkdirSync(junctionTarget, { recursive: true });
    const junction = join(project, "AI_SAFE_PROMPT.md");
    let junctionCreated = false;
    try {
      symlinkSync(junctionTarget, junction, "junction");
      junctionCreated = true;
    } catch {
      // Junction creation requires a Windows capability that may be disabled.
    }
    if (junctionCreated) {
      const junctionReport = scanProject({ targetDir: project, agentReport: true, force: true });
      const junctionState = junctionReport.agentReport.files.find(
        (file) => file.path === "AI_SAFE_PROMPT.md"
      );
      assert.equal(junctionState?.written, false);
      assert.match(junctionState?.reason ?? "", /unsafe|refus/i);
    }
  }
}

function testProjectIdentityBoundaries(root) {
  const parent = join(root, "u2-projects");
  const upper = join(parent, "Project");
  const lower = join(parent, "project");
  mkdirSync(upper, { recursive: true });
  mkdirSync(lower, { recursive: true });

  const upperStats = statSync(upper);
  const lowerStats = statSync(lower);
  const sameDirectory = upperStats.dev === lowerStats.dev && upperStats.ino === lowerStats.ino;
  const upperId = deriveProjectId(upper);
  const lowerId = deriveProjectId(lower);
  if (sameDirectory) {
    assert.equal(upperId, lowerId, "case-insensitive filesystems must keep normal case aliases together");
  } else {
    assert.notEqual(upperId, lowerId, "distinct case-sensitive directories must not collide");
  }

  const other = join(root, "u2-other", "Project");
  mkdirSync(other, { recursive: true });
  assert.notEqual(upperId, deriveProjectId(other), "same-name directories under different parents must differ");
  assert.equal(upperId, deriveProjectId(`${upper}/`));

  const alias = join(parent, "project-alias");
  let aliasCreated = false;
  try {
    symlinkSync(upper, alias, process.platform === "win32" ? "junction" : "dir");
    aliasCreated = true;
  } catch {
    // Symlink/junction creation can be unavailable on a restricted host.
  }
  if (aliasCreated) {
    assert.equal(upperId, deriveProjectId(alias), "an alias of the same directory must keep its project identity");
  }
}

async function testSecretInputPreservesOpaqueValues() {
  const tty = new FakeTty();
  const output = new CaptureOutput();
  const pending = promptSecretValue("SYNTHETIC_SECRET", tty, output);
  await typeLine(tty, "");
  await typeLine(tty, "   ");
  await typeLine(tty, " value ");
  assert.equal(await pending, " value ");
  assert.match(output.text, /Value cannot be empty/);

  const ref = {
    name: "SYNTHETIC_SECRET",
    scope: "user",
    projectId: null,
    projectDir: null
  };
  const windows = buildWindowsSecretInputScript(ref);
  const macos = buildMacOSSecretInputScript(ref);
  assert.doesNotMatch(windows, /\$script:input\.Text\.Trim\(\)/);
  assert.match(windows, /IsNullOrWhiteSpace\(\$value\)/);
  assert.match(windows, /\$input\.MaxLength = 0/);
  assert.equal(WINDOWS_CREDENTIAL_BLOB_MAX_BYTES, 2560);
  assert.match(windows, /\$blobSize -gt 2560/);
  assert.match(windows, /exceeds the OS storage limit and cannot be registered/);
  assert.match(windows, /この値はOSの保存上限を超えているため登録できません/);
  assert.match(windows, /\$credential\.CredentialBlobSize = \$blobSize/);
  assert.doesNotMatch(windows, /CredentialBlobSize = \[Text\.Encoding\]::Unicode\.GetByteCount\(\$value\)/);
  assert.doesNotMatch(macos, /value = value\.trim\(\)/);
  assert.match(macos, /value\.length === 0/);
}

function testCloudflareDestinationParsing(root) {
  const fixture = createCloudflareFixture(root);
  const json = {
    name: "json-worker",
    account_id: ACCOUNT_ID,
    env: {
      preview: {
        name: "json-preview-worker",
        account_id: OTHER_ACCOUNT_ID,
        vars: { TOKEN: CONFIG_SECRET }
      }
    },
    vars: { TOKEN: CONFIG_SECRET }
  };

  writeConfig(fixture.project, "wrangler.json", JSON.stringify(json, null, 2));
  const jsonExecution = assertCloudflareExecution(fixture, "preview");
  assert.match(jsonExecution.label, /json-preview-worker/);

  const jsonc = `{
  // Wrangler JSONC comment
  "name": "jsonc-worker",
  "account_id": "${ACCOUNT_ID}",
  "env": {
    /* named environment */
    "preview": {
      "name": "jsonc-preview-worker",
      "account_id": "${OTHER_ACCOUNT_ID}",
      "vars": { "TOKEN": "${CONFIG_SECRET}", },
    },
  },
  "vars": { "TOKEN": "${CONFIG_SECRET}", },
}`;
  writeConfig(fixture.project, "wrangler.jsonc", jsonc);
  const jsoncExecution = assertCloudflareExecution(fixture, "preview");
  assert.match(jsoncExecution.label, /jsonc-preview-worker/);
  assert.equal(jsoncExecution.serialized.includes(CONFIG_SECRET), false);

  const productionExecution = assertCloudflareExecution(fixture, "production");
  assert.match(productionExecution.label, /jsonc-worker/);

  writeConfig(fixture.project, "wrangler.jsonc", jsonc.replace("jsonc-preview-worker", "jsonc-preview-changed"));
  const changedExecution = assertCloudflareExecution(fixture, "preview");
  assert.match(changedExecution.label, /jsonc-preview-changed/);
  assert.notEqual(changedExecution.hash, jsoncExecution.hash, "destination changes must change the same projection used for display");

  const alternateSecret = "synthetic-config-secret-9876543210";
  writeConfig(
    fixture.project,
    "wrangler.jsonc",
    jsonc.replaceAll(CONFIG_SECRET, alternateSecret)
  );
  const alternateExecution = assertCloudflareExecution(fixture, "preview");
  assert.equal(alternateExecution.hash, jsoncExecution.hash, "vars values must not influence the destination fingerprint");
  assert.equal(alternateExecution.serialized.includes(alternateSecret), false);

  removeConfig(fixture.project, "wrangler.jsonc");
  const toml = `name = "toml-worker" # inline comment
account_id = "${ACCOUNT_ID}" # another comment

[env.preview] # named environment
name = "toml-preview-worker" # inline comment
account_id = "${OTHER_ACCOUNT_ID}" # inline comment

[vars]
TOKEN = "${CONFIG_SECRET}"
`;
  writeConfig(fixture.project, "wrangler.toml", toml);
  const tomlExecution = assertCloudflareExecution(fixture, "preview");
  assert.match(tomlExecution.label, /toml-preview-worker/);
  assert.equal(tomlExecution.serialized.includes(CONFIG_SECRET), false);

  writeConfig(fixture.project, "wrangler.toml", `name = "toml-worker"\naccount_id = "${ACCOUNT_ID}"\nthis is not TOML\n`);
  assert.equal(cloudflareExecution(fixture, "production").ok, false, "unknown TOML syntax must fail closed");

  removeConfig(fixture.project, "wrangler.toml");
  writeConfig(fixture.project, "wrangler.jsonc", `{
  "name": "duplicate-a",
  "name": "duplicate-b",
  "account_id": "${ACCOUNT_ID}"
}`);
  assert.equal(cloudflareExecution(fixture, "production").ok, false, "ambiguous JSONC fields must fail closed");
}

function createCloudflareFixture(root) {
  const project = join(root, "u4-cloudflare");
  const cli = join(root, "u4-cli");
  mkdirSync(project, { recursive: true });
  mkdirSync(cli, { recursive: true });
  const executable = process.platform === "win32" ? join(cli, "wrangler.cmd") : join(cli, "wrangler");
  writeFileSync(executable, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n", "utf8");
  if (process.platform !== "win32") chmodSync(executable, 0o755);
  return { project, pathOverride: cli };
}

function assertCloudflareExecution(fixture, env) {
  const result = cloudflareExecution(fixture, env);
  assert.equal(result.ok, true, `valid Wrangler ${env} config must resolve`);
  const config = result.execution.snapshot.destinationConfig.find((file) => file.exists);
  assert.ok(config?.destinationLabel);
  assert.ok(config?.contentHash);
  return {
    label: config.destinationLabel,
    hash: config.contentHash,
    serialized: JSON.stringify(result.execution)
  };
}

function cloudflareExecution(fixture, env) {
  return buildTrustedExecution(
    {
      name: "SYNTHETIC_CONFIG_KEY",
      scope: "project",
      projectId: deriveProjectId(fixture.project),
      env,
      force: false,
      adapterId: "cloudflare",
      cliCommand: "wrangler",
      providerIdentity: `accounts:${ACCOUNT_ID}`
    },
    {
      argv: ["wrangler", "secret", "put", "SYNTHETIC_CONFIG_KEY", "--env", env],
      valueVia: "stdin",
      displayCommand: `wrangler secret put SYNTHETIC_CONFIG_KEY --env ${env}`,
      overwriteWarning: true
    },
    { pathOverride: fixture.pathOverride, projectDir: fixture.project }
  );
}

function writeConfig(project, name, content) {
  for (const candidate of ["wrangler.toml", "wrangler.json", "wrangler.jsonc"]) {
    if (candidate !== name) removeConfig(project, candidate);
  }
  writeText(project, name, content);
}

function removeConfig(project, name) {
  rmSync(join(project, name), { force: true });
}

function writeText(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

class FakeTty extends EventEmitter {
  isTTY = true;
  isRaw = false;

  setRawMode(value) {
    this.isRaw = value;
    return this;
  }

  resume() {}
  pause() {}
}

class CaptureOutput {
  text = "";

  write(chunk) {
    this.text += String(chunk);
    return true;
  }
}

async function typeLine(tty, value) {
  for (const character of value) tty.emit("keypress", character, {});
  tty.emit("keypress", "", { name: "return" });
  await new Promise((resolve) => setImmediate(resolve));
}
