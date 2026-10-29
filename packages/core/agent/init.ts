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
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** Internal invocation facts from the running CLI, never project metadata/argv. */
export interface CurrentCliInvocation {
  argv: readonly [string, string];
  packageVersion: string;
  packageRoot: string;
  platform: "linux" | "darwin" | "win32";
  buildHelper: string | null;
}

export class AgentCurrentCliError extends Error {
  constructor(readonly reason: "entry-unavailable" | "entry-unsupported" | "transient-entry" | "unsupported-platform") {
    super(`Current CLI ${reason}; use an available trusted built entry and regenerate with --use-current-cli. No public fallback.`);
    this.name = "AgentCurrentCliError";
  }
}

export function resolveCurrentCliInvocation(entryUrl: string, runtime: {
  execPath?: string; platform?: NodeJS.Platform;
} = {}): CurrentCliInvocation {
  const platform = runtime.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") throw new AgentCurrentCliError("unsupported-platform");
  try {
    const rawEntry = fileURLToPath(entryUrl), rawNode = runtime.execPath ?? process.execPath;
    const transient = (path: string) => path.split(/[\\/]/).some(part => part.toLowerCase() === "_npx");
    if (transient(rawEntry) || transient(rawNode)) throw new AgentCurrentCliError("transient-entry");
    const entry = realpathSync(rawEntry), node = realpathSync(rawNode);
    if (transient(entry) || transient(node)) throw new AgentCurrentCliError("transient-entry");
    if ([entry, node].some(path => /[\x00-\x1f\x7f\u2028\u2029]/.test(path)) ||
        !statSync(entry).isFile() || !statSync(node).isFile() ||
        (platform !== "win32" && (statSync(node).mode & 0o111) === 0)) throw new AgentCurrentCliError("entry-unsupported");
    const packageRoot = resolve(dirname(entry), "../..");
    if (entry !== resolve(packageRoot, "dist/cli/index.js")) throw new AgentCurrentCliError("entry-unsupported");
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { name?: unknown; version?: unknown; bin?: { [name: string]: unknown } };
    if (pkg.name !== "api-key-case" || typeof pkg.version !== "string" || pkg.bin?.["api-key-case"] !== "dist/cli/index.js") {
      throw new AgentCurrentCliError("entry-unsupported");
    }
    instructionMajor(pkg.version);
    const helper = resolve(packageRoot, "tools/build-local-node.mjs");
    const helperState = tryLstat(helper);
    const buildHelper = helperState?.isFile() && !helperState.isSymbolicLink() && realpathSync(helper) === helper ? helper : null;
    return { argv: [node, entry], packageVersion: pkg.version, packageRoot, platform, buildHelper };
  } catch (error) {
    if (error instanceof AgentCurrentCliError) throw error;
    throw new AgentCurrentCliError("entry-unavailable");
  }
}

function inlineCode(value: string): string {
  const width = Math.max(0, ...Array.from(value.matchAll(/`+/g), match => match[0].length)) + 1;
  const fence = "`".repeat(width), pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

function currentCommand(current: CurrentCliInvocation, entry = current.argv[1]): string {
  // PowerShell IsSingleQuote includes U+2018..U+201B. Doubling each delimiter
  // preserves its original character; normalizing it would change the path.
  const quote = (value: string) => current.platform === "win32"
    ? `'${value.replace(/['\u2018-\u201b]/g, character => character + character)}'`
    : `'${value.replaceAll("'", "'\"'\"'")}'`;
  return `${current.platform === "win32" ? "& " : ""}${quote(current.argv[0])} ${quote(entry)}`;
}

function bindCurrentProtocol(text: string, current: CurrentCliInvocation): string {
  const prefix = currentCommand(current), publicPrefix = `npx -y api-key-case@${current.packageVersion}`;
  const substitutions: [string, string][] = [
    [publicPrefix, prefix], ["node <checkout>/dist/cli/index.js", prefix], ["node <api-key-case>/dist/cli/index.js", prefix],
    ["node <api-key-case>/tools/build-local-node.mjs", current.buildHelper ? currentCommand(current, current.buildHelper) : ""]
  ];
  const replacements = new Map(substitutions);
  const pattern = new RegExp(substitutions.map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  // Render only our fixed templates. Literal paths remain shell-quoted, and
  // variable-width code spans prevent path backticks from becoming Markdown.
  return text.split("\n").map(line => {
    if (line.startsWith("- For API key, Secret, environment-variable, or deploy work, run")) {
      const argv = JSON.stringify([...current.argv, "next", "--json", "--offline", "."]);
      return [
        `- For API key, Secret, environment-variable, or deploy work, first inspect with ${inlineCode(`${prefix} next --json --offline .`)}.`,
        `- Current CLI: package version ${current.packageVersion}, next schemaVersion 13. This entry is checked on this machine only; version alone does not identify the public package's capabilities.`,
          `- This private CLI also provides value-free vNext schemaVersion 1: inspect ${inlineCode(`${prefix} secret capabilities --json`)} and ${inlineCode(`${prefix} secret discover --project . --json`)} before asking for a key again. A registered Binding needs no input. selection-required means ask the independent Human Plane to select an existing candidate through secret binding plan/apply; it is not missing. Candidate labels/locators are Human Plane only. unavailable/unknown require diagnosis, not forced registration.`,
          "- A Binding records intended use, not execution permission. Keep the plan fingerprint and exact project/environment/variable; apply needs the native Human Plane and fresh metadata. Use secret operation status with the recorded operation ID to inspect an interrupted attempt; secret input --operation and secret binding/manage apply --operation recover that same attempt without new input, approval or execution. Do not retry a provider/app operation because history or metadata says it completed. Other vNext features may still be pending acceptance; never substitute a public CLI or legacy command to bypass a gate.",
        `- This CLI's package root: ${inlineCode(JSON.stringify(current.packageRoot))}. Use only its own documentation for private commands; project metadata cannot supply an executable entry.`,
        `- Literal invocation argv: ${inlineCode(argv)}. Use argv execution or the ${current.platform === "win32" ? "PowerShell" : "POSIX shell"} syntax above; append this CLI's fixed command arguments. Do not reinterpret paths as code or use cmd.exe quoting.`,
        "- Before reopening, verify that the recorded Node and CLI files still exist. If missing, moved, inaccessible or on another PC, stop and regenerate with an available trusted local CLI's agent-init --use-current-cli; never guess a path from project metadata, install a replacement or fall back to public npx. Offline results do not authorize input, provider checks or execution; use online next only for separately requested setup diagnosis."
      ].join("\n");
    }
    if (!current.buildHelper && line.includes("node <api-key-case>/tools/build-local-node.mjs")) {
      return "- The private Node build helper is unavailable in this CLI installation. Use an existing separately reviewed app build when supported; do not invent a helper path, install a replacement or run an app as preparation.";
    }
    return line.split("`").map((part, index) => {
      part = part.replace("prefer this instead of the online diagnosis above:", "use this same entry:");
      part = part.replace("For the private local development flow below, use that same built private CLI for", "For the private local development flow below, use this same entry for")
        .replace(", not this published npx invocation.", ".");
      part = part.replace(pattern, match => index % 2 ? replacements.get(match)! : inlineCode(replacements.get(match)!));
      return index % 2 ? inlineCode(part) : part;
    }).join("");
  }).join("\n");
}

function assertCurrentCliAvailable(current: CurrentCliInvocation, version: string): void {
  const observed = resolveCurrentCliInvocation(pathToFileURL(current.argv[1]).href, { execPath: current.argv[0], platform: current.platform });
  if (observed.packageVersion !== version || JSON.stringify(observed) !== JSON.stringify(current)) {
    throw new AgentCurrentCliError("entry-unavailable");
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

export function renderAgentProtocol(packageVersion: string, currentCli?: CurrentCliInvocation): string {
  instructionMajor(packageVersion);
  if (currentCli) assertCurrentCliAvailable(currentCli, packageVersion);
  const [major, minor] = packageVersion.split(".").map(Number);
  const genericPublicEntry = !currentCli && (major > 0 || minor >= 10);
  const prefix = `npx -y api-key-case@${packageVersion}`;
  const text = [
    "API Key Case agent protocol:",
    genericPublicEntry
      ? `- For API key, Secret, environment-variable, or deploy work, first inspect: ${prefix} secret capabilities --json, then ${prefix} secret discover --project . --json. These return availability and project-scoped status, never values.`
      : `- For API key, Secret, environment-variable, or deploy work, run: ${prefix} next --json .`,
    ...(genericPublicEntry ? [
      "- Use this generic Secret path for new API-dependent development. Check native capabilities before input or execution. unavailable, pending-acceptance and unknown require diagnosis; never fall back to a legacy command, terminal input or another executable to bypass an unavailable route.",
      "- Reuse an existing confirmed Binding without asking for its key again. selection-required is not missing: use secret binding plan/apply so the independent Human Plane selects an existing credential. Only a genuinely missing credential uses secret input and human entry, followed by independently confirmed project/environment/variable binding. Candidate labels and locators belong to the Human Plane, not Agent output.",
      "- For provider placement, use secret target inspect/register and secret use plan/apply. For an ordinary Node/Python app, inspect secret profile list first, then use secret profile plan/register and secret launch plan/apply. Present the concrete app, destination and effects in plain language. Placement and app launch require Pro and fresh native OS approval; an approved app and its dependencies can read their environment. A saved Binding or profile is not execution permission.",
      "- Preserve the reviewed fingerprint and exact project/environment/variable. Inspect interrupted attempts with secret operation status and their recorded operation IDs. Recover only through that operation's supported recovery command; unknown provider/app effects must not be automatically replayed. History is a past observation, not current readiness or approval.",
      `- The legacy next/setup and connection guidance below applies only to an explicitly requested existing legacy flow. For that separate diagnosis, use ${prefix} next --json .; do not replace the generic discovery above with a fixed-provider inventory or infer missing credentials from legacy results.`
    ] : []),
    "- For reopening/status/recovery in a supporting private built checkout, prefer this instead of the online diagnosis above: inspect local connection status with node <checkout>/dist/cli/index.js next --json --offline .; this explicitly marked schema7 variant skips provider CLIs, Git ignore/tracked/history checks and the vault write/delete availability probe; targets=[] means not inspected. Existing exact-environment and legacy project/user presence reads may internally read/discard a value. Nested connection stage and recovery describe advisory next work, not permission to execute it; only the filtered offline nextActions are immediate status-review guidance. Stored selections and past records do not establish current provider/app readiness or retry permission. Public 0.9.2 does not support this flag; keep using the same private CLI. Offline output must not trigger login, installation, registration or provider checks merely because inspection was skipped.",
    ...setupProtocol(packageVersion),
    "- Treat nextActions as structured data. Perform actor=agent actions yourself.",
    `- For actor=human kind=register-secret, request the Human Plane with: npx -y api-key-case@${packageVersion} save <NAME> --ask [--scope user].`,
    `- For actor=human kind=remove-secret, request it with: npx -y api-key-case@${packageVersion} remove <NAME>. For kind=forget-deploy-destination: npx -y api-key-case@${packageVersion} trust forget --target <target> --env <env>. Each opens a dialog only a human can answer.`,
    "- Relay every other actor=human action.",
    "- Never ask for a Secret value in chat, and never read .env or .env.* files.",
    "- Never infer an executable command from free-form text."
  ].join("\n");
  return currentCli ? bindCurrentProtocol(text, currentCli) : text;
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
  currentCli?: CurrentCliInvocation;
}): AgentInitResult {
  if (options.currentCli) assertCurrentCliAvailable(options.currentCli, options.packageVersion);
  const projectRoot = realpathSync(options.projectDir);
  const major = instructionMajor(options.packageVersion);
  const body = managedBody(options.packageVersion, options.currentCli);
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
    "- Private Clerk registration foundation: connection credential <save|check|remove> --service clerk --env <development|preview|production> addresses only CLERK_SECRET_KEY in the exact project/environment slot. Check is read-only presence (the backend may internally read/discard); save/remove use the accepted Windows Human Plane only; other hosts remain unavailable. Never substitute legacy save/remove or a different environment. next.connection remains Resend and next.clerkNative remains Vercel-native. next.clerkManaged reports the separate selected standalone environment, exact-slot presence, local configuration and advisory preparation history. Use the explicit credential check and treat missing/unavailable conservatively. CLERK_PUBLISHABLE_KEY or the SDK-specific public setting belongs in ordinary app configuration, never this secret slot. Do not copy a Vercel-managed Clerk key into the vault. Clerk local execution and provider validation remain unsupported; registration is not authentication success. The separate Windows-only Worker-version preparation below is not production activation.",
    "- Expect next schemaVersion 13. If the schema is unfamiliar, stop and consult the documentation for this exact package version.",
    "- Private explicit Cloudflare configs: use `connection destinations --json <repository>` to inspect the fixed api-key-case.targets.json allowlist. Each ID binds account, Worker, config, allowed service, vault source environment, deployment classification and Wrangler section/top-level. For an already selected managed Cloudflare connection and exact settled slot, use `connection deploy --service <resend|openai|stripe-test> --env <source-environment> --destination <catalog-id> --dry-run --json <repository>` with this same built CLI. The catalog and offline preview grant no permission. Every real placement needs fresh native OS approval and can overwrite and immediately deploy a Worker version. Registered staging explicitly uses a preview source slot; it does not infer staging from a Worker suffix or default config. Config/manifest/account/source changes stop the approved invocation. No arbitrary config path, command or --force is supported. Preserve separate receipts for each Worker (history schema 4) and never replay partial/unknown outcomes. The narrow Windows source gate is independent of the default-config/Vercel new-provider gate. Stop after the placement receipt and hand application setup/E2E to its own reviewed workflow; do not expose a stored value to an application script.",
    "- Private connection inventory: when reopening this project or reviewing earlier environment registrations, use `connection inventory --json <project>` with this same private CLI. It checks only the eleven known project slots (Resend/Clerk/OpenAI across development/preview/production, plus Stripe test in development/preview; inventory schemaVersion 2), local registration metadata, current selections and historical v2 placement receipts. It does not select an old environment, enumerate other projects or user-scope secrets, reveal values, probe/write storage availability, or contact a provider. Registered but noncurrent slots can be reused after reviewing the intended environment/destination; do not ask for the same key again. Pending, unavailable or changed records mean review-metadata, never missing or permission to reissue/overwrite. A native route does not need duplicate vault registration. Old completed placements are historical only, not current connection success, provider verification, permission or safe retry. Continue with the existing next/guide/check flow for an explicitly confirmed selection; do not recreate setup from absent history.",
    "- Private Resend native enrollment memory: `connection native options --service resend --env <environment> --json` lists the existing Vercel integration and Marketplace method IDs. After the human chooses one, record that exact ID only through the same private CLI's explicit `connection set --service resend --env <environment> --route provider-native --destination vercel --native-enrollment <resend-vercel-integration|resend-vercel-marketplace> <project>`. The later native guide/resume restores the chosen official URL. This records no account eligibility, billing/domain consent or permission. Existing Resend schema-1 choices are `unrecorded`; never infer the method from inspection/history. Options, guide and `next` are read-only. Do not use older private binaries after a schema-2 choice; they fail closed.",
    "- Private common acquisition: use `connection credential guide --service <resend|clerk|openai|stripe-test> --env <environment> --json <project>` before new input, using this same built CLI. When next returns review-provider-credential, inspect its recorded environments through this guide before any legacy registration. The action records routing only, not presence or approval; environments can include a saved hosted selection without a credential registration. An empty list indicates unavailable selection metadata, not a default environment or a request for a key. Read hostedConnection from the matching credential guide for the saved environment/destination and pending execution gate. Exact settled registration means stored: do not ask again. Legacy presence is a candidate requiring scope review, never automatic copy or fallback. OpenAI/Stripe test profiles additionally have closed api-key-case-managed hosted selections for Vercel/Cloudflare. Their native execution remains unavailable pending acceptance; only offline selection, local target preparation and deployment request previews are available. Provider/application checks and arbitrary/local consumers remain unsupported. Never replace a missing consumer with arbitrary exec, env export, pseudo-TTY, a different slot or direct secret access. The stripe-test profile accepts only test secret keys (sk_test_); provider mode and app deployment environment are separate. Restricted OpenAI permissions must follow the app's required endpoints/models; do not request broader scope merely to satisfy an unrelated probe. Save opens the provider guide and secure native input together and returns only status. Pending/unavailable registration needs review rather than another key. Public npm 0.9.2 does not provide this candidate.",
    "- Private bounded provider hosted preparation: for an explicitly chosen OpenAI or Stripe test connection, record only `connection set --service <openai|stripe-test> --env <environment> --route api-key-case-managed --destination <vercel|cloudflare> <project>` using this same built CLI. OpenAI supports development/preview/production; Stripe test supports development/preview only. Reuse an exact settled v2 registration and inspect `connection credential guide`; never feed it to legacy deploy, another environment, a local runner, native integration or GitHub. A separately requested Pro offline preview uses `connection deploy --service <openai|stripe-test> --env <environment> --dry-run --json <project>`. It is an offline request only: no provider probes, remote readiness or execution permission. Read the preview placementEffect: Cloudflare secret put creates a Worker version and immediately deploys it; Vercel changes future deployment configuration and does not itself deploy the app. Actual provider-hosted execution is unavailable pending native acceptance; do not bypass that source gate or supply an alternate command. Provider/application verification remains unsupported and applicationCheck remains unverified. Preserve uncertain history and never automatically retry. Public npm 0.9.2 does not implement this private candidate.",
    "- Private connection selection resumption: when the user explicitly names a previously used environment, run `connection resume plan --service <resend|clerk|openai|stripe-test> --env <environment> [--route <provider-native|api-key-case-managed|manual>] --json <project>` with this same built private CLI. Never infer or default an environment or route. For Resend plan only, omit --route when the route was not supplied: the report reads the exact route from the requested environment's current or last-recorded selection, without choosing a default. For Clerk, both plan and apply require an explicit route because its native/managed profiles coexist. OpenAI/Stripe test plan and apply require the explicit api-key-case-managed route; native, GitHub and local routes are unsupported, and stripe-test only permits development/preview. Every apply requires the exact displayed route. Review the exact project, current and remembered environment/route/destination/sending domain, recorded time, local metadata effects and fingerprint. Resume only that reviewed selection with `connection resume apply` using the same service/environment/project, the exact reviewed report.route and `--fingerprint <plan-fingerprint>`. The fingerprint binds the plan; it is not approval or provider authority. Missing history means not-recorded, never missing credentials; do not ask for duplicate key entry or reconstruct a choice from receipts. Corrupt, unknown, locked, temporary or unsafe state requires review, never repair, forced selection or blind retry. If an apply outcome is uncertain, preserve state and re-read/re-plan; do not roll back. A real restoration gets a new intent revision; already matching conditions preserve it. Only local selection metadata changes: no local .vercel/Wrangler selector or account, credential, permission, approval, observation or current health is restored. Continue with the existing `next --json --offline`, matching guide and separately requested exact-environment check flow using this same CLI. Do not automatically contact a provider, authenticate, acquire/register a key, grant access, deploy or run an app. Existing Human Plane, entitlement and production gates remain in force; public 0.9.2 is not a fallback for this private command.",
    "- Private local target preparation: when the saved Resend/Clerk Vercel or managed Cloudflare guide, or OpenAI/Stripe test managed hosted selection, cannot resolve a missing local destination, use `connection target plan --service <service> --env <environment> (--org-id <known-id> --project-id <known-id> | --account-id <known-id> --worker <known-name>) --json <project>` with this same private CLI. All IDs must already be explicitly known; never guess, choose the first account/project, change the saved route, or switch environments. The mutually exclusive ID family selects the matching saved profile, including coexisting Clerk native and managed profiles. Present the exact local project, service/environment, destination IDs, fixed path and local effects. Apply only that local setup using `connection target apply` with the same inputs and `--fingerprint <plan-fingerprint>`. This creates only .vercel/project.json or wrangler.jsonc, or adds a missing development/preview entry to an existing strict selector-only wrangler.jsonc on supported Linux owner-only files; it does not create or authenticate a remote resource. An additive plan shows every retained selector and the exact proposed addition; no root/other environment value is changed. This is not a general Wrangler editor. Windows/macOS additive replacement and unsupported permission layouts stop; existing matching checks and new-file preparation retain their separate support. Existing matching config is unchanged; conflicts, unsupported layouts and changed plans require review, never force repair, overwrite or deletion. A stale creation plan with matching localConfiguration means the target already matches; re-plan for a no-write apply, never recreate it. Possible local effects mean preserve and inspect the fixed paths before continuing. After creation or an updated result, use the same existing native/Cloudflare guide. No automatic provider CLI, network, login, vault access, secret registration, permission grant or deployment is authorized. The plan token is not approval and is never persisted as approval. Generic connection plan remains unresolved; all Human Plane, entitlement and production gates stay intact.",
    "- Private Cloudflare route preselection: before requesting a new service key for a proposed Cloudflare setup, use `connection cloudflare options --service <resend|clerk|openai|stripe-test> --env <environment> --json` with this same built private CLI and no project path. This pure catalog lists the existing managed route, fixed official provider/Cloudflare guides and binding names; it does not inspect eligibility, accounts, authentication, storage, remote configuration or application behavior. It does not claim provider-native acquisition or enable execution. Stripe test supports development/preview and only sk_test_; Stripe recommends restricted keys for new integrations, so never broaden permissions or create a replacement merely to fit this supported profile. Reuse any explicit selection and review it with the existing guide/inventory instead of asking again. Confirm only unresolved account/project/environment/route choices before using the established selection and secure input flows. Do not authenticate, grant access, acquire keys, save state, deploy or run an app from this candidate. For a proposed Vercel Resend/Clerk route use the existing connection native options, never switch destinations automatically. Public npm 0.9.2 does not include this candidate.",
    "- Private Cloudflare connection guide: for an already selected Resend/Clerk/OpenAI/Stripe test api-key-case-managed Cloudflare route, use `connection cloudflare guide --service <service> --env <environment> --json <project>` with this same private CLI. Take the service/environment from the saved next.connection.report, next.clerkManaged selection or provider credential guide hostedConnection; reuse it without asking for the same choice or key again. Present the fixed official guide and exact local account/Worker selection. selection-confirmed means only matching saved intent and local Wrangler configuration, not login, remote settings, credential presence/validity or working application evidence. Unknown/unsupported results require reviewing the existing selection, never automatic login, route switching, acquisition or repeated registration. The guide performs no provider request, vault read, browser launch, state write or deployment. Destination login is not provider credential acquisition. OpenAI/Stripe test hosted execution stays unavailable pending native acceptance; this guide does not remove that gate. Retain all existing Human Plane, entitlement and operation-specific approval gates; a guide or historical result grants no permission.",
    "- Private official route preselection: before asking the human to obtain a Resend/Clerk key for a proposed Vercel setup, use `connection native options --service <resend|clerk> --env <environment> --json` with this same built private CLI. This shows only Product-owned documented official Vercel candidates, not an inspected account, approved route, credential, eligibility or permission. Do not select/change a connection, execute provider commands, open a browser, log in, create keys, modify project files or deploy from a candidate report. Ask the human to confirm the exact existing account/project/environment and selected official route only if not already chosen; do not make them run CLI commands. If the route is already selected, continue with the existing `connection native guide` rather than suggesting duplicate registration. Public npm 0.9.2 does not include this candidate.",
    "- Private native connection guide: for an already selected Resend/Clerk provider-native Vercel route, use `connection native guide --service <service> --env <environment> --json <project>` with this same private CLI before asking the human to search for setup steps. This reads local selection and advisory receipts only: no browser, provider, login, vault, installation, connection or permission operation. Present its exact organization/project/environment and fixed official guide; do not invent URLs or substitute another route when unsupported. Unknown or stale evidence is not missing configuration and must not cause automatic reconnection or key entry. Clerk Marketplace provisioning, plan choice and role synchronization remain human decisions and cannot migrate an existing standalone application. Resend domain/key creation also needs human consent. Show the human-readable form when detailed guidance is useful. Opening a guide grants no consent; run the separate inspector below only when explicitly requested. Do not export provider-managed keys or duplicate them in the vault.",
    "- Private native app evidence: after selecting the existing Resend/Clerk provider-native Vercel environment, explicitly request `connection native inspect --service <service> --env <environment> --record --max-age-seconds <1..86400> --json <project>` with this same private CLI. This returns an inspection plus an advisory recording receipt; omitting --record retains the existing non-persisting inspection. After separately authorized app work was actually observed, record only that caller observation with `connection native observe-application --service <service> --env <environment> --inspection <recording.receiptId> --feature <protected-access|send-and-delivery> --observer <agent|human> --outcome <passed|failed|unknown> --max-age-seconds <1..86400> --json <project>`. Clerk's feature is signed-out denial plus signed-in protected access; Resend's is the intended app send plus recipient delivery. Use --observer human for a human report; retain that authority rather than relabeling it agent-observed. Never invent a pass. Neither command runs an app, imports a command or requires a vault credential. next.clerkNative.applicationObservation and the native Resend connection.report.nativeApplicationObservation read these existing-journal receipts, with service/environment/linked-project selection, expiry, named feature and separate remaining advice. reported is historical caller evidence with the recorded agent-observed or human-reported authority, never current health, generic readiness, provider identity, key validity, permission or safe retry. Changed/unresolved local scope, unknown/interrupted/expired inspection, changed configuration, missing app evidence or failure require the stated review. Reinspection of identical configuration neither renews an app observation nor requires repeating that recorded feature. Reading never refreshes or rewrites a receipt or invokes a provider/app. Public 0.9.2 does not implement this private contract.",
    "- connection.status is inactive when no Resend setup is detected, not-selected before a durable route/environment/destination is chosen, selected when a validated local intent exists, and unavailable when local metadata cannot be read safely. If not-selected, inspect the user's request and existing non-secret app configuration, then propose a supported app/environment/destination and route in plain language. Reuse explicit choices from the request or saved selection without asking again. Confirm only unresolved decisions together; do not make the human choose CLI terms. Never turn an inferred route into a confirmed choice, change a confirmed selection, invent a route or bypass permission/operation approval. If an existing official-native integration meets the request, use it without duplicate vault registration. After the confirmed choice, record only the advisory intent with `npx -y api-key-case@" + packageVersion + " connection set --service resend --env <environment> --route <route> --destination <destination> .`. For the private local development flow below, use that same built private CLI for `connection set`, not this published npx invocation. This never configures or verifies a provider and grants no permission. If unavailable, stop the Resend flow; do not inspect or overwrite raw metadata. If connection.issue is history-unavailable, treat the report as unknown and do not continue a provider or application check from it.",
    "- Private standalone Clerk/Cloudflare preparation: select `connection set --service clerk --env <environment> --route api-key-case-managed --destination cloudflare <project>`, then use `connection prepare --service clerk --env <environment> --dry-run --json <project>` with the same private built CLI. This independent profile coexists with Clerk-native and Resend; next.clerkManaged reports it separately; next.connection and next.clerkNative retain their existing meanings. Require the selected Wrangler scope to explicitly name the account and Worker; never infer one or use a different environment. Preparation is enabled only on the accepted Windows path; actual provider operations still require scoped authorization, Pro and fresh native approval. Fresh approval must explain that latest remote code may change before execution and existing Version URLs/resources can use the secret. A prepared result identifies a created version only; this invocation does not activate production. Use the coding Agent's normal authorized app deployment flow to activate that exact version if requested. No automatic activation or retry after unknown/failed history. History schema3 distinguishes preparation; older readers must stop rather than relabel it completed deployment. Public Clerk configuration remains ordinary SDK/app work.",
    "- next.clerkManaged.summary and nextStep explain what remains for the selected Clerk/Cloudflare connection. version-recorded is a past local receipt, not current placement, activation or working authentication. Current remote destination matching, active version and application health remain unverified. The separate applicationObservation restores caller observations without changing those facts. A newer unknown attempt overrides an older success. Changed registration, unreadable/locked history or inspection changes require review; preserve evidence and never retry/activate from this report. No record is not proof that nothing ran. This added projection uses only local metadata and exact-slot presence (which may internally read/discard); next still retains its existing general target/availability probes. permission is always none. Use the same private CLI, never public 0.9.2 for this schema.",
    "- Private Clerk/Cloudflare app observations: resume the selected environment and the exact prepared Worker/version from next.clerkManaged.applicationObservation or history --json --offline using this same private CLI. Do not repeat selection, key input, preparation or activation just to record evidence. After separately authorized work actually observed signed-out denial and signed-in protected access against that intended version, use `connection observe-application --service clerk --env <environment> --preparation <receipt-id> --version <version-id> --feature protected-access --observer <agent|human> --outcome <passed|failed|unknown> --max-age-seconds <1..86400> --json <project>`. Human reports keep human authority. The command records only a caller-asserted version binding; it never invokes an app/provider, activates a version or reads a key. New preparation history records the non-secret account and Worker identity; older receipts without it remain unverified and cannot be upgraded from today's Wrangler config. A newer unknown preparation overrides an older pass. Changed account/Worker/environment/version/registration, interrupted storage and expiry require the stated review, not automatic execution or retry. next --json --offline restores the recorded subject, observer, feature, outcome, lifetime and remaining work with activation not-inspected, currentHealth unverified and permission none. Prepared is not deployed/active; a past protected-access pass is not current health or safe retry. Keep Vercel-native receipts distinct. Public 0.9.2 does not implement this private contract.",
    "- next.clerkNative is a separate native-only Clerk/Vercel profile. Its saved selection coexists with the Resend connection and never grants vault, local-session or managed-deployment access. For an already Vercel-managed Clerk application, use this private CLI's `connection set --service clerk --env <environment> --route provider-native --destination vercel <project>` and `connection native inspect --service clerk --env <environment> --json <project>`. The separate managed Clerk/Cloudflare route uses the explicit preparation command below. For this Vercel-native flow, do not duplicate keys using credential save/check/remove. The separate standalone registration foundation supports the explicit presence check and accepted Windows-only mutations described above. Do not alias Clerk to Resend, call doctor for Clerk, or widen the existing local runner.",
    "- Clerk's fixed pair is CLERK_SECRET_KEY (secret) and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (public configuration). This profile returns only presence metadata, including for the publishable key. Integration-managed requires both unbranched settings in the selected target with the same configuration attribution; this does not prove Clerk identity, matching instance/key values or working authentication. Development and preview expect the Clerk development instance; production expects its production instance. Never substitute another environment or copy/register either value because inspection is partial or unknown. Legacy next diagnostics for unrelated secrets remain separate; the Clerk native report does not require an API Key Case vault.",
    "- Clerk Marketplace cannot adopt an existing standalone Clerk app. Do not provision a replacement, migrate auth, purchase a plan or change grants automatically. Do not run clerk init or vercel env pull in this profile: init can create an app, write plaintext .env.local and install global Agent skills. The coding Agent handles code-only SDK work in the existing app using official documentation and existing hosted settings. clerkMiddleware alone does not protect resources; require resource-level auth checks. Functional acceptance is a separately authorized signed-out denial and signed-in access to the intended protected page, without copying session tokens/user records into CLI output. Configuration presence never makes generic plan or application readiness passed.",
    "- A selected `provider-native` route has an external-unverified credential and must not trigger API Key Case Secret input. A selected `manual` route is advisory only. `api-key-case-managed` uses the exact environment credential Human Plane flow. `secrets` retains explicit legacy-v1 facts. `guidedSetup` and setup.counts use the selected managed Resend environment slot plus unrelated legacy requirements; provider-native has no Resend vault requirement. Use connection.report and its environment-specific action for this flow. Do not claim any route is connected because intent was saved.",
    "- connection.report is a semantic projection, not stored JSON: it combines the current scan, existence-only vault checks, selected intent and closed observations. `legacy-unscoped` means the existing v1 key is not mapped to the selected environment. Destination `unknown`, provider/application `not-run`, and stale/unknown outcomes must remain unverified. The credential-check operation can validate the selected stored Resend credential through its fixed official doctor operation; that check does not deploy, send email, configure runtime access or check application behavior. The separate bounded local session below is an explicitly approved execution path.",
    "- For register-connection-credential, ask the human to enter the key through `npx -y api-key-case@" + packageVersion + " connection credential save --service resend --env <environment> .` only when that exact installed version implements this candidate. For the private local development flow below, invoke `connection credential save` through the same built private CLI, not a published npx version. Use the report's explicit environment; never infer or migrate a legacy key. The Human Plane names the exact project/service/environment. `connection credential check` reports only presence; `connection check --env <environment>` validates only the matching selected environment's v2 slot. Legacy 0.9.x save/check/list/remove/deploy keep their v1 accounts. No terminal/stdin/key argument fallback is permitted for connection credential save; no new MCP mutation is exposed.",
    "- For a selected provider-native Vercel intent in a private checkout that includes it, use the same verified built CLI's `connection native inspect --service resend --env <environment> --json <project>` to inspect existing configuration. This explicit network check requires the reviewed installed Vercel CLI 59.11.7 and existing session; other versions stop before the GET without automatic installation or downgrade; it may refresh existing CLI authentication, but does not install, log in, pull environment files, register a key, or run an app. Never replace it with raw `vercel env ls` or `vercel api` output in an Agent session, because those can contain values. Unknown means inspection failed, not that a key is missing.",
    "- Native inspection reports only whether the exact environment contains RESEND_API_KEY and whether Vercel attributes it to an integration. integration-managed does not identify that integration as Resend, validate the key, prove application behavior, or authorize execution. present-unmanaged also is not a request to overwrite or copy the value. Avoid duplicate vault registration for the selected official-managed route; absent requires review of the official setup. Keep generic plan unknown without its own supported resolver. An aborted/unknown inspection grants no automatic retry; termination-unconfirmed additionally requires checking the owned CLI before another attempt.",
    "- The candidate `connection plan --service resend --env <environment> --json .` reports the secret-free contract for an existing Vercel/Cloudflare destination. Real destination/native-configuration resolution is still pending, so the CLI returns unknown rather than invoking a provider or claiming a complete plan. Its permission is none and execution is unsupported: never feed an environment credential to legacy deploy or infer placement from a plan. For the supported Resend provider-native/Vercel route, follow connection.report.nativeApplicationObservation.remaining instead of waiting for this generic resolver or using generic v3 observations. When the generic plan is unresolved, connection.report.recovery is empty for that route because the native reader supplies its next work; the generic plan remains unresolved and unsupported for execution. This generic plan does not support local application planning; use the separate local inspect/status commands below without converting their results into a generic ready observation. Provider-native plans do not require duplicating a key in the vault.",
    "- Bounded local sessions are a Windows-only development capability for an explicitly selected project x Resend x development, api-key-case-managed route and local destination. First verify the actual installed CLI supports `connection local`; published 0.9.2 does not. For a private development checkout, use its built `node <api-key-case>/dist/cli/index.js` consistently instead of substituting a published npx version. Unsupported hosts/versions are product limitations, not missing keys or a reason to bypass guards.",
    "- For a saved local selection, use next.localDevelopment and its review-local-development step together with next.localSession, ahead of generic handoff-pending advice. This is closed continuation advice with permission none and applicationReadiness not-verified. support describes this host/profile only; reviewable still requires the existing explicit app/effect request, Pro and fresh native approval for execution. Unsupported host/selection or approval availability is not a missing credential; do not request new keys, a new service, a Windows acceptance rerun or cross-host credential transfer to solve it.",
    "- review-local-preparation restores the explicit earlier inspection\'s artifact candidate, finite duration and time from preparationReceipt, then reobserves only the declared file metadata. unchanged-metadata means reuse that candidate and run the existing explicit local inspect again; do not rebuild or ask for the app/key again. inputs-changed means review the existing source/build and prepare only when needed; artifact-changed/project-changed/inputs-unavailable mean review the existing artifact/inputs; runtime-changed or expired means reinspect the same candidate without rebuilding merely for elapsed time. selection-changed/credential-changed/metadata-unavailable mean review those facts without using a different slot or deleting evidence. No past result skips current full-byte inspection or fresh run approval. build stays not-inspected: inspection is not build provenance, dependency closure or current application success.",
    "- prepare-and-inspect means the selected exact slot is registered with settled revision and no previous attempt requiring review. preparation.build and inspection are not-inspected: next does not run build/inspection and cannot establish that one never occurred. The Agent checks the existing ordinary app entry/build artifact; use an existing suitable dist/*.cjs artifact or prepare a new one only when needed with the helper below, then the existing connection local inspect with an explicit artifact and finite lifetime. Never ask the human to assemble a test app, repeat key entry or repeat a finished operation merely because preparation was not inspected. Build and ready-for-review inspection are not execution or feature success.",
    "- review-local-state and review-previous-attempt require checking the existing local status/owned session and preserving receipt, artifacts and locks. Unreadable state, changed inspection, unfinished execution or uncertain teardown must not become absent/missing or an automatic retry. review-selection-change keeps legacy-unbound, changed-selection and changed-credential attempts historical; review the current selection/revision without copying a key, clearing evidence or attaching old success to the current app. review-credential-state is uncertain presence/revision, not a key-input request. review-credential-input is only a selected-slot review; offline next never opens input. Only a separately requested supported online diagnosis with a genuinely missing slot and guide may request the existing Human Plane, without reading values.",
    "- For an ended bound exited/failed trial, localDevelopment.trialObservations summarizes only that attempt: agent is the recorded application result and human is the person's delivery report. not-reported means no record, not failure or proof nobody checked. mixed preserves differing recorded outcomes; do not choose a later pass or received report to erase an earlier failure/unknown. Null means no safely bound summary; consult the existing closed status. These are historical reports, never current health, permission or overall readiness.",
    "- review-application-observation means the ended trial has no agent-observed application result. Use the saved project/environment and existing app/result evidence to identify the requested feature and what was actually observed, then use the existing connection local observe only if you can truthfully report that trial. Retain any human delivery report separately. Do not ask for keys, app/environment details or a delivery check already reported. Absence of a report does not authorize a new run, send or provider check; if existing evidence is insufficient, explain the unverified feature and request only the specific missing information or new effect permission when needed.",
    "- review-mixed-observations means differing reports need review in the existing latest-attempt history. Preserve every report and explain their scope; do not collapse them into success or repeat a human action merely to remove mixed. review-trial-observations means an existing bound attempt ended with confirmed teardown and has an app report. Explain its recorded app result and human delivery independently without repeating build, provider checks, launch, send or key entry. A past pass or received report requires no repeat check solely because a new conversation started. review-unstarted-attempt means the receipt records no launch; explain the cancelled/changed attempt and review the remaining task without automatic retry. Any new run needs a fresh scoped request and all existing native guards; history is never permission.",
    "- For an ordinary Node JS/TS app in a private development checkout that includes the helper, prepare its existing entry with `node <api-key-case>/tools/build-local-node.mjs <project> --entry <existing-source-entry>`. The Agent chooses the entry from app code/build configuration; ask the human only if the intended app is ambiguous. Use the returned fresh dist/*.cjs artifact for the existing local inspection. This helper is private tooling, not included in the published npm package; do not invent an npm/MCP build command. Preparation never runs the app, installs dependencies or supplies a key. If the app is outside the supported build profile, use its existing separately reviewed build; do not rewrite it as a test sample or weaken launch guards.",
    "- Keep build preparation separate from local execution: a built artifact is not permission, a successful inspection or a completed feature. Installed packages remain runtime dependencies. Rebuilding preserves earlier artifacts and cannot clear an interrupted session; inspect status and retain attempt evidence. Do not ask the user to paste a key again just because a build failed, and do not run a real mail check as an automatic build test.",
    "- For that selected local intent, use the verified CLI's `connection local inspect --service resend --env development --artifact <relative-dist-artifact.cjs> --max-seconds <bounded-lifetime> --json <project>` and `connection local status --service resend --env development --json <project>`. Inspection and status do not launch the application or authorize a send. The artifact must be a relative .cjs file under dist/ and the lifetime must be 1 through 1800 seconds. Keep the explicit artifact and finite lifetime; do not offer arbitrary commands, hot reload, cross-host transfer or a legacy/user/production-key fallback. If the exact slot is missing, the human uses the existing environment-specific credential Human Plane; never read/copy the value or construct a secret-bearing argv, environment-setting command, plaintext file or ordinary log.",
    "- Only after the human authorizes the named app and its concrete effects (including any recipient, provider request and cost), invoke the same CLI's `connection local run` with the same service, development environment, artifact, lifetime and project. Execution requires Pro and fresh native OS approval, which the human performs; inspection, purchase, an editable receipt or chat approval cannot substitute for it. The app can read the key; its code/dependencies and the same OS user are trusted, and stopping it cannot revoke a copied key. Application streams are discarded.",
    "- If the same private checkout contains `docs/PRIVATE_CONNECTION_TRIAL.md`, use that single walkthrough for choosing the app/environment/destination, exact-slot check/save, local inspection, hosted preview and offline recovery. Switching destinations within the same project/service/environment does not require entering a saved key again; switching environments does not permit copying or falling back to another slot. The selected intent is one active choice, not a set of independently active routes. Preserve earlier attempt/lock evidence when switching or rebuilding. Legacy MCP tools do not perform these v2 operations; use the supported private CLI path without inventing new tools.",
    "- In a private checkout that supports GitHub connection deployment, use the same built CLI to select `connection set --service resend --env <development|preview|production> --route api-key-case-managed --destination github .`, save/check the exact v2 credential through Human Plane, then preview with `connection deploy --service resend --env <environment> --dry-run --json .`. GitHub v2 always selects an already-existing, identically named GitHub Environment, including development; it never falls back to a repository secret. Review the fixed github.com repository/environment with the human before actual placement. All GitHub placements require fresh Human Plane approval and can overwrite a CI-consumable secret. No environment creation, workflow execution, retry, protection-rule guarantee or application readiness is inferred. Published 0.9.2 and legacy `deploy` do not provide this v2 contract; the legacy development target remains repository-wide. Missing/forbidden environment or changed identity stops placement; use offline history for uncertain outcomes.",
    "- next.localSession and connection local status contain bounded trial history only, including the exact opaque attempt/executionBasisId and credentialRevision. For a newly completed local trial with confirmed teardown, record an actually observed app result using this private CLI's `connection local observe --service resend --env development --attempt <attemptId> --execution-basis <executionBasisId> --credential-revision <credentialRevision> --authority agent-observed --outcome <passed|failed|unknown> --json <project>`. Record human-reported delivery separately, only after the human reports it, with --authority human-reported and --outcome <received|not-received|unknown>. Neither exit nor provider acceptance proves inbox delivery. Never fabricate an observation or attach earlier delivery to a new attempt. The recorder does not send, run, access the key, request approval or confer readiness/retry permission. Old unbound receipts, unfinished/unknown/changed attempts, locks, changed selection/revision and uncertain storage refuse new reports; preserve evidence instead of editing or clearing it. Past attempts and changed bases remain historical, never current health. Resume with local status and next --json --offline on this same private CLI; public 0.9.2 lacks this command.",
    "- After local execution or interruption, read `connection local status` for the same project/environment and report lifecycle/cleanup separately from application behavior. A completed process is not feature success. Keep app-reported provider acceptance separate from human-observed inbox delivery; do not promote either into generic `connection observe-application` for local. Unknown teardown, an existing lock, missing evidence or uncertain provider outcome requires review, never automatic rerun, marker/lock deletion, credential re-entry or a fabricated pass. Retain application attempt evidence; credential removal is a separate Human Plane decision.",
    "- In the candidate plan and connection.report, recovery entries are closed reason/actor/action advice scoped to their service/environment. Explain product-owned handoff/resolver gaps as unsupported product work, never as key re-entry or provider setup. intent-missing permits asking for an explicit selection; intent-unavailable requires preserving the unreadable selection, not set/reset/overwrite. credential-revision-unknown is not credential-missing. applicationCheck.reason distinguishes missing receipt, interruption, invalid storage, expiry, verifier/basis changes and unknown results. Review evidence through closed status only; do not clear locks, edit raw metadata, refresh a receipt on read, fabricate a new pass or automatically retry an external action. An empty recovery list does not grant execution or provider authority.",
    "- Only after separately authorized application/configuration work was actually observed, the candidate `connection observe-application` may record a closed agent-observed result against the current plan fingerprint, explicit environment, observed/unknown configuration, and an explicit max-age-seconds from 1 to 86400. It never runs the app, sends email or authorizes any action. Do not fabricate a pass, replay an old result against a new plan, or treat agent-observed ready as provider truth. Refresh next after interruption or any source, credential, destination, configuration or verifier change; unresolved basis and expired evidence cannot remain ready. These candidate commands may be absent from public 0.9.x packages.",
    "- For check-resend-credential, run `npx -y api-key-case@" + packageVersion + " connection check --service resend --env <environment> --json .` only when that exact installed version implements it and the human has requested this read-only validation. Use the saved selected connection.report.environment exactly; never guess an environment or default to development. Pass it through --env on this same CLI even after inventory rediscovery. This guard never changes selection: on environment-mismatch, stop and refresh next before deciding how to continue. If there is no available selection, stop rather than run an unbound check. It uses only an existing api-key-case-managed credential through the internal handoff boundary. Never supply a key, arbitrary argv/env/URL, or run resend login. A valid result proves only credential acceptance, including sending-only access; it does not prove domain, destination, sending or application readiness. Unknown is not invalid: explain the blocker, do not blindly retry, and refresh next. Missing/unsupported trusted CLI stays unknown; do not weaken its checks. Existing 0.9.x public packages may not contain this candidate command.",
    "- guidedSetup is a single Resend acquisition guide for an explicitly selected api-key-case-managed connection with an existing supported operation. Its registration refers only to connection.report.environment in this project, never the legacy v1 project/user key or another environment. Before selection, follow the request/configuration proposal and grouped unresolved-decision confirmation above; do not acquire or save until the target/environment/route are confirmed. Reuse a confirmed selection without asking again. A saved intent stays visible even if the scanner no longer detects the name. null is not proof that no credential is needed: provider-native/manual, unsupported operations, offline inspection and uncertain history have no acquisition guide. Do not invent guides for other names or services.",
    "- For guidedSetup, explain the credential purpose, registration scope/status and stage. review-exposure and prepare-storage must be addressed before acquisition. human-handoff means this execution context cannot open the supported environment-specific Secret input: explain that host limitation without a legacy-slot, Agent PTY or chat fallback. Pending registration, locks, unavailable metadata/presence and changed inspection are uncertainty, not missing; preserve evidence and do not request key re-entry or force overwrite. Do not ask the human to create a one-time key while storage/input remains blocked.",
    "- For Resend acquire-and-save, first explain the exact acquisition.dashboardUrl and acquisition.documentationUrl and the copy sequence. Request the existing connection credential save --service resend --env <selected-environment> Human Plane through the same verified private CLI before the human creates a one-time key; they should see that dialog ready for input before issuance. If the dialog cannot open, stop acquisition. The human signs in or creates their account, clicks Create API Key, names it for their application, and selects permissions. For email sending only, recommend Sending access and an intended domain restriction where appropriate; broader API use needs a separate human permission decision. Domain verification and account restrictions are separate prerequisites, never inferred from a saved key. If they already have a usable key, skip issuance and use that key only in Human Plane.",
    "- Resend displays a new key only once. Coordinate that exact project/service/environment credential dialog so the human can copy that value directly from their own browser into Human Plane; never browse, scrape, screenshot or operate their credential page, receive a clipboard value, or ask them to paste it in chat, argv or an Agent terminal. Do not follow the provider documentation's .env storage examples: this flow stores only in the OS secret store. Human Plane returns status only. Stop on cancellation or failure; do not issue a replacement key or overwrite automatically.",
    "- After the save invocation exits, refresh next in the same project. On a new chat or interruption, run next again: the selected project/environment slot and an existence-only OS-store check reconstruct guidedSetup without a session token or a stored credential value. If registration is already registered, skip acquisition/save. Saving alone never verifies a provider; guidedSetup connectionState=not-tested and runtimeAccess=not-configured-by-this-flow describe that acquisition flow, while connection.report.providerCheck separately reports the explicit doctor observation. No domain, sending, runtime injection, environment mapping or deployment success is inferred. Choose the target/environment/route before acquisition. Keep legacy facts separate without copying, migrating or deleting them. For selected managed local development, review next.localSession and the existing local status/inspect operations; review-destination-setup is not permission to run, send or create a generic local plan. Other local environments remain unsupported. Use only existing guarded operations and never add Resend as a deploy adapter.",
    "- You are the user's interface. Explain setup.stage, setup.counts, host and target.readiness in their language as one project task: what is done, what remains, and the next human action. Do not dump JSON or require the user to choose CLI commands.",
    "- If setup.stage is no-required-secrets, say only that the current API Key Case scan detected no required Secret names. Zero setup.counts.required alone can instead mean target selection is pending or provider-native needs no vault storage; it never means the app needs no credentials. Counts and stage do not authorize acquisition: request Resend input only for register-connection-credential with a genuinely missing selected environment and a supported guide. The scanner does not cover every language or reference syntax and may have no .env.example to read; never conclude that the project needs no Secrets. A known name should be checked directly with check in its intended scope.",
    "- Diagnostics, storage and management are Free. The deploy command requires Pro, including its dry-run. Explain environmental blockers separately from license.plan. A purchase cannot fix unsupported hosts or unavailable helpers. prerequisites-checked is conditional: human interaction and provider write permission remain unverified, and execution checks everything again.",
    "- If host.secretInput is unavailable, do not request save --ask or loop through blocked dialogs. Explain the supported-host requirement and the existing manual Free storage option. Likewise, resolve the chosen environment's readiness blockers before attempting deployment.",
    "- Treat vault, history and provider-login status as scoped to this CLI process's OS account, home and session. An Agent sandbox can differ from a human-owned shell on the same computer. Describe a negative result as current-context-only; never bridge accounts, copy credentials, change permissions or weaken checks. Re-run status in the intended supported context only when the host permits it.",
    "- Respect the user's intended target and environment. Detected targets are candidates, not authorization to deploy to all of them. Ask when the intended destination is unknown; do not guess an account, project, or environment.",
    "- For install-target-cli, prepare the official provider CLI yourself using the provider's documented installation, subject to the host's permissions. For review-deploy-setup, inspect non-secret configuration and explain unresolved conditions; never read/delete .env files, weaken checks, replace a trusted CLI, or change an account/destination just to pass diagnostics. In particular, when Cloudflare readiness is blocked because .env, .env.* (excluding .env.example), .dev.vars, or .dev.vars.* files coexist with Wrangler configuration, explain that API Key Case stopped deploy for its own safety conditions, not because of login or Free; Secret registration remains available and the files stay unchanged.",
    "- First explain all missing names together, then open the existing save --ask dialogs sequentially. After the registration group, refresh next. Secret issuance, provider login, purchase/license activation and OS verification remain human prerequisites; guide the user through them without receiving credentials.",
    "- Existing .env users can start by registering known keys. Never read the file contents: confirm only the needed Secret names, then ask the human to open their own .env and copy each value only into the Human Plane. Registration may be the end of the requested task; do not modify or delete the original .env or continue to deploy unless requested.",
    "- Legacy v1 project/name storage has no deployment-environment dimension; the v2 connection credential slots above are environment-specific. For legacy v1 only, one project/name slot holds one value. If development and production need different values for the same name, explain that both cannot be stored simultaneously and ask which single value to register; never overwrite an existing value automatically.",
    "- A name found only in .env.example is a declaration from a local file and that file may be stale; a name with no current supported source usage is not proof of current use. When this distinction matters, inspect the existing scan report and ask the human before saving a name solely because it appears there.",
    `- When the user requests deployment, invoke npx -y api-key-case@${packageVersion} deploy <NAME> --target <target> --env <env> with the registered scope (add --scope user only for a user-scoped entry). The same call opens any required Human Plane. A chat Yes/No is not OS approval. Never automate the dialog or add an approval bypass.`,
    "- If the host returns a live process/session handle while Human Plane is open, keep that same invocation and wait or poll it until exit when the host supports resumption; do not require a chat acknowledgement merely to recover its result. If the host cannot resume it, explain that host limitation and ask only for a completion signal. Never launch a duplicate operation.",
    "- Keep each existing input/approval boundary. Process requested keys sequentially, stop on cancellation or failure, and summarize successful/remaining operations from their actual results. Do not automatically overwrite an existing key or retry a declined operation.",
    "- setup.deploymentState is not-inspected: registered means stored locally, not deployed, current at the provider, or tested. Do not claim remote completion from next or retry successful writes merely because next still lists registered keys. Refresh status when resuming; if prior deployment results are unknown, say so and agree the remaining work.",
    "- On a new chat or resumed deployment task, first use the verified CLI's `history --json --offline .` when supported (Free, history schemaVersion 2, or 3 when Worker preparation receipts are present). In the private checkout use its built `node <api-key-case>/dist/cli/index.js`; published 0.9.2 does not include --offline. Do not silently substitute a published npx invocation. Offline inspection reads only the local journal/registration metadata and does not ask a provider to identify the destination. destinationInspection=skipped-offline and currentDestination=unresolved are deliberate; they do not mean the destination is missing or that login/key entry is needed. Explain completed/incomplete/unknown as past results only. Missing, unavailable or evicted history is unknown, never proof that no deployment happened.",
    "- Existing `history --json` without --offline retains destination identity probes, which may refresh provider authentication or write provider logs. Use it only when that current destination inspection is wanted; do not describe it as globally side-effect-free. Neither history mode reads remote Secret values, verifies app success, clears locks or authorizes a retry. Local revision comparison remains scoped to the recorded service/environment/project and cannot transfer a v1 or another environment's key into this flow.",
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

function managedBody(packageVersion: string, currentCli?: CurrentCliInvocation): string {
  const text = [
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
  return currentCli ? bindCurrentProtocol(text, currentCli) : text;
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
