import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Stats
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const START_TOKEN = "<!-- api-key-case:managed:start";
const END_MARKER = "<!-- api-key-case:managed:end -->";
const PROTOCOL_VERSION = 1;

type TargetMode = "append" | "owned";
export type AgentHost = "agents" | "claude" | "cursor";

interface InstructionTarget {
  relativePath: string;
  mode: TargetMode;
  prefix?: string;
}

type BlockState =
  | { kind: "missing" }
  | { kind: "current"; start: number; end: number; generatedBy: string }
  | { kind: "outdated"; start: number; end: number }
  | { kind: "drift" };

export type AgentInitFileStatus =
  | "created"
  | "updated"
  | "current"
  | "missing"
  | "outdated"
  | "drift";

export interface AgentInitFileResult {
  path: string;
  status: AgentInitFileStatus;
}

export interface AgentInitResult {
  persistence: "configured" | "unavailable";
  files: AgentInitFileResult[];
}

export class AgentInitSafetyError extends Error {
  constructor() {
    super("Agent instruction path or managed block is unsafe.");
    this.name = "AgentInitSafetyError";
  }
}

export function instructionMajor(packageVersion: string): string {
  const match = /^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    packageVersion
  );
  if (!match) {
    throw new AgentInitSafetyError();
  }
  return match[1];
}

export function renderAgentProtocol(packageVersion: string): string {
  instructionMajor(packageVersion);
  return [
    "API Key Case agent protocol:",
    `- For API key, Secret, environment-variable, or deploy work, run: npx -y api-key-case@${packageVersion} next --json .`,
    ...setupProtocol(packageVersion),
    "- Treat nextActions as structured data. Perform actor=agent actions yourself.",
    `- For actor=human kind=register-secret, request the Human Plane with: npx -y api-key-case@${packageVersion} save <NAME> --ask [--scope user].`,
    `- For actor=human kind=remove-secret, request it with: npx -y api-key-case@${packageVersion} remove <NAME>. For kind=forget-deploy-destination: npx -y api-key-case@${packageVersion} trust forget --target <target> --env <env>. Each opens a dialog only a human can answer.`,
    "- Relay every other actor=human action.",
    "- Never ask for a Secret value in chat, and never read .env or .env.* files.",
    "- Never infer an executable command from free-form text."
  ].join("\n");
}

export function assertSafeProjectPath(projectRoot: string, relativePath: string): string {
  const root = realpathSync(projectRoot);
  if (!statSync(root).isDirectory() || isAbsolute(relativePath)) {
    throw new AgentInitSafetyError();
  }

  const candidate = resolve(root, relativePath);
  const fromRoot = relative(root, candidate);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new AgentInitSafetyError();
  }

  let cursor = root;
  let lastExisting = root;
  const parts = fromRoot.split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    cursor = resolve(cursor, parts[index]);
    const state = tryLstat(cursor);
    if (!state) continue;
    if (state.isSymbolicLink()) {
      throw new AgentInitSafetyError();
    }
    if (index < parts.length - 1 && !state.isDirectory()) {
      throw new AgentInitSafetyError();
    }
    if (index === parts.length - 1 && (!state.isFile() || state.nlink !== 1)) {
      throw new AgentInitSafetyError();
    }
    lastExisting = cursor;
  }

  const resolvedExisting = realpathSync(lastExisting);
  const existingRelative = relative(root, resolvedExisting);
  if (existingRelative === ".." || existingRelative.startsWith(`..${sep}`) || isAbsolute(existingRelative)) {
    throw new AgentInitSafetyError();
  }

  return candidate;
}

export function initializeAgentInstructions(options: {
  projectDir: string;
  packageVersion: string;
  check: boolean;
  host?: AgentHost;
}): AgentInitResult {
  const projectRoot = realpathSync(options.projectDir);
  const major = instructionMajor(options.packageVersion);
  const body = managedBody(options.packageVersion);
  const block = renderManagedBlock(body, major, options.packageVersion);
  const targets = discoverTargets(projectRoot, options.host);

  if (targets.length === 0) {
    return { persistence: "unavailable", files: [] };
  }

  const plans = targets.map((target) => {
    const absolutePath = assertSafeProjectPath(projectRoot, target.relativePath);
    const existing = tryLstat(absolutePath);
    const content = existing ? readSafeInstructionFile(absolutePath) : "";
    const state = inspectManagedBlock(content, body, options.packageVersion);

    if (target.mode === "owned" && existing && state.kind === "missing") {
      return { target, absolutePath, existing: true, content, state: { kind: "drift" } as BlockState };
    }
    return { target, absolutePath, existing: Boolean(existing), content, state };
  });

  if (options.check) {
    return {
      persistence: "configured",
      files: plans.map((plan) => ({ path: plan.target.relativePath, status: plan.state.kind }))
    };
  }

  if (plans.some((plan) => plan.state.kind === "drift")) {
    throw new AgentInitSafetyError();
  }

  const results: AgentInitFileResult[] = [];
  for (const plan of plans) {
    if (plan.state.kind === "current") {
      if (plan.state.generatedBy === options.packageVersion) {
        results.push({ path: plan.target.relativePath, status: "current" });
        continue;
      }

      const nextContent =
        plan.content.slice(0, plan.state.start) + block + plan.content.slice(plan.state.end);
      assertSafeProjectPath(projectRoot, plan.target.relativePath);
      writeSafeInstructionFile(plan.absolutePath, nextContent, true);
      results.push({ path: plan.target.relativePath, status: "updated" });
      continue;
    }

    let nextContent: string;
    let status: "created" | "updated";
    if (plan.state.kind === "missing") {
      const prefix = plan.target.mode === "owned" ? (plan.target.prefix ?? "") : plan.content;
      nextContent = appendBlock(prefix, block);
      status = plan.existing ? "updated" : "created";
    } else {
      if (plan.state.kind !== "outdated") {
        throw new AgentInitSafetyError();
      }
      nextContent =
        plan.content.slice(0, plan.state.start) + block + plan.content.slice(plan.state.end);
      status = "updated";
    }

    assertSafeProjectPath(projectRoot, plan.target.relativePath);
    mkdirSync(dirname(plan.absolutePath), { recursive: true });
    assertSafeProjectPath(projectRoot, plan.target.relativePath);
    writeSafeInstructionFile(plan.absolutePath, nextContent, plan.existing);
    results.push({ path: plan.target.relativePath, status });
  }

  return { persistence: "configured", files: results };
}

function discoverTargets(projectRoot: string, host?: AgentHost): InstructionTarget[] {
  // An explicit current host supports a fresh repository without guessing or
  // installing instructions for unrelated hosts. Normal path checks still apply.
  if (host === "agents") return [{ relativePath: "AGENTS.md", mode: "append" }];
  if (host === "claude") return [{ relativePath: "CLAUDE.md", mode: "append" }];
  if (host === "cursor") return [cursorTarget()];
  const targets: InstructionTarget[] = [];
  const agentsPath = assertSafeProjectPath(projectRoot, "AGENTS.md");
  const claudePath = assertSafeProjectPath(projectRoot, "CLAUDE.md");
  const hasAgents = Boolean(tryLstat(agentsPath));
  const hasClaude = Boolean(tryLstat(claudePath));
  const cursorPath = resolve(projectRoot, ".cursor");
  const cursorState = tryLstat(cursorPath);
  if (cursorState && (cursorState.isSymbolicLink() || !cursorState.isDirectory())) {
    throw new AgentInitSafetyError();
  }
  const hasCursor = Boolean(cursorState);

  if (hasAgents) {
    targets.push({ relativePath: "AGENTS.md", mode: "append" });
  }

  if (hasClaude) {
    const content = readSafeInstructionFile(claudePath);
    const importsAgents = /^\s*@AGENTS\.md\s*$/m.test(content);
    if (!hasAgents || !importsAgents) {
      targets.push({ relativePath: "CLAUDE.md", mode: "append" });
    }
  }

  if (hasCursor) {
    targets.push(cursorTarget());
  }

  return targets;
}

function cursorTarget(): InstructionTarget {
  return {
    relativePath: ".cursor/rules/api-key-case.mdc", mode: "owned",
    prefix: "---\ndescription: Use API Key Case for API keys, environment variables, and deploy work.\nalwaysApply: true\n---\n"
  };
}

function setupProtocol(packageVersion: string): string[] {
  return [
    "- Expect next schemaVersion 2. If the schema is unfamiliar, stop and consult the documentation for this exact package version.",
    "- You are the user's interface. Explain setup.stage, setup.counts, host and target.readiness in their language as one project task: what is done, what remains, and the next human action. Do not dump JSON or require the user to choose CLI commands.",
    "- If setup.stage is no-required-secrets or setup.counts.required is 0, say only that the current API Key Case scan detected no required Secret names. The scanner does not cover every language or reference syntax and may have no .env.example to read; never conclude that the project needs no Secrets. A known name should be checked directly with check in its intended scope.",
    "- Diagnostics, storage and management are Free. The deploy command requires Pro, including its dry-run. Explain environmental blockers separately from license.plan. A purchase cannot fix unsupported hosts or unavailable helpers. prerequisites-checked is conditional: human interaction and provider write permission remain unverified, and execution checks everything again.",
    "- If host.secretInput is unavailable, do not request save --ask or loop through blocked dialogs. Explain the supported-host requirement and the existing manual Free storage option. Likewise, resolve the chosen environment's readiness blockers before attempting deployment.",
    "- Treat vault, history and provider-login status as scoped to this CLI process's OS account, home and session. An Agent sandbox can differ from a human-owned shell on the same computer. Describe a negative result as current-context-only; never bridge accounts, copy credentials, change permissions or weaken checks. Re-run status in the intended supported context only when the host permits it.",
    "- Respect the user's intended target and environment. Detected targets are candidates, not authorization to deploy to all of them. Ask when the intended destination is unknown; do not guess an account, project, or environment.",
    "- For install-target-cli, prepare the official provider CLI yourself using the provider's documented installation, subject to the host's permissions. For review-deploy-setup, inspect non-secret configuration and explain unresolved conditions; never read/delete .env files, weaken checks, replace a trusted CLI, or change an account/destination just to pass diagnostics. In particular, when Cloudflare readiness is blocked because .env, .env.* (excluding .env.example), .dev.vars, or .dev.vars.* files coexist with Wrangler configuration, explain that API Key Case stopped deploy for its own safety conditions, not because of login or Free; Secret registration remains available and the files stay unchanged.",
    "- First explain all missing names together, then open the existing save --ask dialogs sequentially. After the registration group, refresh next. Secret issuance, provider login, purchase/license activation and OS verification remain human prerequisites; guide the user through them without receiving credentials.",
    "- Existing .env users can start by registering known keys. Never read the file contents: confirm only the needed Secret names, then ask the human to open their own .env and copy each value only into the Human Plane. Registration may be the end of the requested task; do not modify or delete the original .env or continue to deploy unless requested.",
    "- One project/name storage slot has no deployment-environment dimension. If development and production need different values for the same name, explain that both cannot be stored simultaneously and ask which single value to register; never overwrite an existing value automatically.",
    "- A name found only in .env.example is a declaration from a local file and that file may be stale; a name with no current supported source usage is not proof of current use. When this distinction matters, inspect the existing scan report and ask the human before saving a name solely because it appears there.",
    `- When the user requests deployment, invoke npx -y api-key-case@${packageVersion} deploy <NAME> --target <target> --env <env> with the registered scope (add --scope user only for a user-scoped entry). The same call opens any required Human Plane. A chat Yes/No is not OS approval. Never automate the dialog or add an approval bypass.`,
    "- If the host returns a live process/session handle while Human Plane is open, keep that same invocation and wait or poll it until exit when the host supports resumption; do not require a chat acknowledgement merely to recover its result. If the host cannot resume it, explain that host limitation and ask only for a completion signal. Never launch a duplicate operation.",
    "- Keep each existing input/approval boundary. Process requested keys sequentially, stop on cancellation or failure, and summarize successful/remaining operations from their actual results. Do not automatically overwrite an existing key or retry a declined operation.",
    "- setup.deploymentState is not-inspected: registered means stored locally, not deployed, current at the provider, or tested. Do not claim remote completion from next or retry successful writes merely because next still lists registered keys. Refresh status when resuming; if prior deployment results are unknown, say so and agree the remaining work.",
    `- On a new chat or resumed deployment task, also run npx -y api-key-case@${packageVersion} history --json . (Free, history schemaVersion 2; stored journal schema remains 1). Explain completed/incomplete/unknown as past operation results only. Missing, unavailable or evicted history is unknown, never proof that no deployment happened.`,
    "- History is editable local metadata, not current remote state or authority to skip approval, retry, redeploy, or clear records. completed means a past CLI success; incomplete can include partial remote changes (especially --force); unknown can mean interruption or result-save failure. Stop the group on history-save failure even if that one operation succeeded, and agree remaining work with the user.",
    "- Explain history diagnostic.phase, issue and recovery in the user's language: what was observed, whether this invocation reached deployment, and the next safe step. missing/not-created means no journal was found, not a read/write failure or proof of no past deployment. available only proves readable metadata; writeAccess is not-tested. unavailable has a closed cause; never request raw errors or history file contents in chat.",
    "- A start-phase history failure blocks this invocation before provider writes. A result-phase failure only concerns saving its result: preserve any observed deployment success and explain possible partial/unknown remote changes separately. Neither failure authorizes automatic redeployment. After a cause is addressed, inspect history again and agree a fresh deploy request with all existing checks.",
    "- A known Secret that is absent from list or next after an interrupted save may be missing only from local index metadata. Run check <NAME> with the intended scope against the OS store before saying it is missing; do not repeat save or use a force overwrite automatically.",
    "- A save result can have two separate parts: the OS secret-store write and the local metadata/index update. If the CLI says the store write succeeded but index update failed, report both facts, use check <NAME> with its scope, and do not treat list/next absence as an unregistered Secret.",
    "- A provider failure, timeout, or unknown result does not justify a force retry. Mention force only when the provider explicitly confirms a duplicate existing Secret and the human agrees. If a force operation is incomplete or unknown, its removal step may have succeeded while the add failed; never repeat the same force operation automatically.",
    "- lock-present only establishes a lock's presence, not a crash, stale lock or completed deployment. Check for running deploys, let them finish and reinspect. For invalid-data, temporary-file-present, unsafe-path, too-large or record-unavailable, first confirm no deploy is running, then discuss local metadata review. unsupported-schema needs a compatible version. access-denied/read-only-storage/path-unavailable/io-error need storage/path access review; storage-full needs disk/quota review. Never delete history or locks, change permissions, or retry deploy automatically. Any metadata discard needs an explicit decision for the affected project after explaining that past results will be lost; it does not delete Secrets or trust.",
    "- update-recorded means local registration metadata changed; unverified cannot prove the same stored value (including out-of-tool updates, deletion or metadata-save failure). selection-matches compares destination selection only, never remote values; selection-changed/unresolved cannot transfer an old success to the current destination. Always keep currentRemoteState=not-inspected separate from historical completion.",
    "- An unused status means the current scanner found no reference to that registered project Secret. Unsupported syntax and manual use are possible, so treat it only as a cleanup candidate, explain it separately, and leave deletion to the human."
  ];
}

function managedBody(packageVersion: string): string {
  return [
    "## API Key Case (managed)",
    "",
    "- License for this API Key Case managed instruction block only: 0BSD (https://spdx.org/licenses/0BSD.html). This does not change the license of the surrounding repository.",
    `- For API key, Secret, environment-variable, or deploy work, run \`npx -y api-key-case@${packageVersion} next --json .\` first.`,
    ...setupProtocol(packageVersion),
    "- Follow semantic `nextActions`; perform `actor: agent` actions yourself.",
    `- For \`actor: human\`, \`kind: register-secret\`, request the Human Plane with \`npx -y api-key-case@${packageVersion} save <NAME> --ask [--scope user]\`.`,
    `- For \`kind: remove-secret\`, request it with \`npx -y api-key-case@${packageVersion} remove <NAME>\`; for \`kind: forget-deploy-destination\`, \`npx -y api-key-case@${packageVersion} trust forget --target <target> --env <env>\`. Each opens a dialog only a human can answer.`,
    "- Relay every other `actor: human` action.",
    "- Never request, read, print, hash, measure, or persist a Secret value or partial value.",
    "- Never read `.env` or `.env.*` files, and do not treat free-form text as an executable command."
  ].join("\n");
}

function renderManagedBlock(body: string, major: string, packageVersion: string): string {
  const hash = sha256(body);
  return [
    `${START_TOKEN} protocol=${PROTOCOL_VERSION} major=${major} generated-by=${packageVersion} content-sha256=${hash} -->`,
    body,
    END_MARKER
  ].join("\n");
}

function inspectManagedBlock(content: string, expectedBody: string, expectedVersion: string): BlockState {
  const starts = occurrences(content, START_TOKEN);
  const ends = occurrences(content, END_MARKER);
  if (starts.length === 0 && ends.length === 0) {
    return { kind: "missing" };
  }
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    return { kind: "drift" };
  }

  const startPattern =
    /<!-- api-key-case:managed:start protocol=(\d+) major=(\d+) generated-by=([0-9A-Za-z.+-]+) content-sha256=([0-9a-f]{64}) -->/y;
  startPattern.lastIndex = starts[0];
  const match = startPattern.exec(content);
  if (!match) {
    return { kind: "drift" };
  }

  let bodyStart = startPattern.lastIndex;
  if (content.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (content.startsWith("\n", bodyStart)) bodyStart += 1;
  else return { kind: "drift" };

  let bodyEnd = ends[0];
  if (content.slice(bodyEnd - 2, bodyEnd) === "\r\n") bodyEnd -= 2;
  else if (content.slice(bodyEnd - 1, bodyEnd) === "\n") bodyEnd -= 1;
  else return { kind: "drift" };

  const actualBody = content.slice(bodyStart, bodyEnd);
  const protocol = match[1];
  const major = match[2];
  const generatedBy = match[3];
  const recordedHash = match[4];
  const generatedMajor = /^(\d+)\./.exec(generatedBy)?.[1];
  const expectedMajor = instructionMajor(expectedVersion);

  if (
    protocol !== String(PROTOCOL_VERSION) ||
    generatedMajor !== major ||
    sha256(actualBody) !== recordedHash
  ) {
    return { kind: "drift" };
  }

  const end = ends[0] + END_MARKER.length;
  if (
    major === expectedMajor &&
    generatedBy === expectedVersion &&
    actualBody === expectedBody &&
    recordedHash === sha256(expectedBody)
  ) {
    return { kind: "current", start: starts[0], end, generatedBy };
  }
  return { kind: "outdated", start: starts[0], end };
}

function appendBlock(prefix: string, block: string): string {
  if (prefix.length === 0) return `${block}\n`;
  const separator = prefix.endsWith("\n") ? "\n" : "\n\n";
  return `${prefix}${separator}${block}\n`;
}

function occurrences(content: string, token: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(token, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + token.length;
  }
  return indexes;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readSafeInstructionFile(path: string): string {
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fileDescriptor);
    const current = lstatSync(path);
    if (!isSafeInstructionFile(opened) || !isSafeInstructionFile(current) || !sameFile(opened, current)) {
      throw new AgentInitSafetyError();
    }
    return readFileSync(fileDescriptor, "utf8");
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

function writeSafeInstructionFile(path: string, content: string, replaceExisting: boolean): void {
  let fileDescriptor: number | undefined;
  try {
    const flags = replaceExisting
      ? constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
      : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    fileDescriptor = openSync(path, flags, 0o666);
    const opened = fstatSync(fileDescriptor);
    const current = lstatSync(path);
    if (!isSafeInstructionFile(opened) || !isSafeInstructionFile(current) || !sameFile(opened, current)) {
      throw new AgentInitSafetyError();
    }
    if (replaceExisting) ftruncateSync(fileDescriptor, 0);
    writeFileSync(fileDescriptor, content, { encoding: "utf8" });
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

function isSafeInstructionFile(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}
