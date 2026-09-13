import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  POSTHOG_CAPTURE_ENDPOINTS,
  POSTHOG_PUBLIC_API_HOST,
  resolvePostHogConfig
} from "./telemetry-config.js";

export {
  POSTHOG_CAPTURE_ENDPOINTS,
  POSTHOG_PROJECT_TOKEN_ENV,
  POSTHOG_PUBLIC_API_HOST,
  POSTHOG_PUBLIC_PROJECT_TOKEN,
  POSTHOG_PUBLIC_CONFIG,
  resolvePostHogConfig
} from "./telemetry-config.js";

// Backwards-compatible alias for the default public US destination. The
// resolver is the only production path that selects the endpoint.
export const POSTHOG_CAPTURE_ENDPOINT = POSTHOG_CAPTURE_ENDPOINTS[POSTHOG_PUBLIC_API_HOST];
export const TELEMETRY_PRIVACY_URL = "https://apikeycase.melavern.com/privacy";

const TELEMETRY_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 1_500;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

type Environment = Readonly<Record<string, string | undefined>>;
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type CliTelemetryCommand = "scan" | "save" | "license_activate" | "deploy";
export type CliTelemetryOutcome = "success" | "failure" | "cancelled" | "blocked";
export type CliTelemetryTarget = "cloudflare" | "vercel" | "github";
export type CliTelemetryErrorCategory =
  | "invalid_input"
  | "non_interactive"
  | "dependency_unavailable"
  | "already_registered"
  | "not_registered"
  | "confirmation_declined"
  | "license_required"
  | "license_activation_failed"
  | "operation_failed"
  | "strict_findings"
  | "dry_run"
  | "timeout"
  | "unexpected_error";

export type CliTelemetryResult = {
  command: CliTelemetryCommand;
  outcome: CliTelemetryOutcome;
  errorCategory?: CliTelemetryErrorCategory;
  target?: CliTelemetryTarget;
};

export type CliTelemetryProperties = {
  product: "api_key_case";
  surface: "cli";
  command: CliTelemetryCommand;
  outcome: CliTelemetryOutcome;
  cli_version: string;
  os_family: "windows" | "macos" | "linux" | "other";
  error_category?: CliTelemetryErrorCategory;
  target?: CliTelemetryTarget;
  // Required by PostHog's capture API to keep this anonymous and prevent
  // person profile creation. This is a fixed privacy control, not product
  // context and never contains user data.
  "$process_person_profile": false;
};

export type CliTelemetryEvent = {
  event: "cli_command_result";
  distinct_id: string;
  properties: CliTelemetryProperties;
};

type TelemetryFile = {
  version: 1;
  enabled: boolean;
  noticeShown: boolean;
  installationId?: string;
};

export type TelemetryStatus = {
  configured: boolean;
  effective: boolean;
  noticeShown: boolean;
  installationIdPresent: boolean;
  suppression:
    | "none"
    | "disabled"
    | "ci"
    | "do_not_track"
    | "not_configured"
    | "notice_required"
    | "id_missing";
};

export type CliTelemetryOptions = {
  // In production this is the user's home directory. Tests may inject a
  // temporary home without touching the real ~/.api-key-case directory.
  baseDir?: string;
  env?: Environment;
  platform?: NodeJS.Platform | string;
  isTTY?: boolean;
  cliVersion?: string;
  capture?: CaptureClient;
  fetcher?: Fetcher;
  timeoutMs?: number;
  randomId?: () => string;
  writeNotice?: (message: string) => void;
};

export type CaptureClient = (event: CliTelemetryEvent) => Promise<void> | void;

export const TELEMETRY_NOTICE = [
  "API Key Case sends anonymous usage statistics for selected CLI commands.",
  "It does not send API keys, secret names, paths, or scan results.",
  "To stop telemetry: api-key-case telemetry disable",
  `Privacy: ${TELEMETRY_PRIVACY_URL}`,
  ""
].join("\n");

export function telemetryFilePath(baseDir?: string): string {
  return join(baseDir ?? homedir(), ".api-key-case", "telemetry.json");
}

export function readTelemetryState(baseDir?: string): TelemetryFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(telemetryFilePath(baseDir), "utf8"));
    if (!isRecord(parsed) || parsed.version !== TELEMETRY_SCHEMA_VERSION) {
      return defaultTelemetryState();
    }

    return {
      version: 1,
      enabled: parsed.enabled !== false,
      noticeShown: parsed.noticeShown === true,
      ...(isInstallationId(parsed.installationId) ? { installationId: parsed.installationId } : {})
    };
  } catch {
    return defaultTelemetryState();
  }
}

export function getTelemetryStatus(options: Pick<CliTelemetryOptions, "baseDir" | "env" | "capture"> = {}): TelemetryStatus {
  const state = readTelemetryState(options.baseDir);
  const env = options.env ?? process.env;
  const configured = state.enabled;
  const hasCaptureConfiguration = Boolean(
    typeof options.capture === "function" || resolvePostHogConfig(env)
  );
  const suppression = getSuppression({
    state,
    env,
    hasCaptureConfiguration
  });

  return {
    configured,
    effective: suppression === "none",
    noticeShown: state.noticeShown,
    installationIdPresent: isInstallationId(state.installationId),
    suppression
  };
}

export function enableTelemetry(baseDir?: string): boolean {
  const state = readTelemetryState(baseDir);
  const wasEnabled = state.enabled;
  state.enabled = true;
  if (!wasEnabled) {
    // A later interactive run will create a fresh random installation ID.
    delete state.installationId;
  }
  return writeTelemetryState(state, baseDir);
}

export function disableTelemetry(baseDir?: string): boolean {
  const state = readTelemetryState(baseDir);
  state.enabled = false;
  // Do not retain the anonymous identifier in the disabled file.
  delete state.installationId;
  return writeTelemetryState(state, baseDir);
}

export function buildCliTelemetryEvent(
  result: CliTelemetryResult,
  options: {
    installationId: string;
    cliVersion: string;
    platform?: NodeJS.Platform | string;
  }
): CliTelemetryEvent | null {
  if (
    !isCommand(result.command) ||
    !isOutcome(result.outcome) ||
    !isInstallationId(options.installationId) ||
    typeof options.cliVersion !== "string" ||
    !VERSION_PATTERN.test(options.cliVersion)
  ) {
    return null;
  }

  const properties: CliTelemetryProperties = {
    product: "api_key_case",
    surface: "cli",
    command: result.command,
    outcome: result.outcome,
    cli_version: options.cliVersion,
    os_family: toOsFamily(options.platform ?? process.platform),
    "$process_person_profile": false
  };

  if (result.outcome !== "success" && isErrorCategory(result.errorCategory)) {
    properties.error_category = result.errorCategory;
  }

  if (result.command === "deploy" && isTarget(result.target)) {
    properties.target = result.target;
  }

  return {
    event: "cli_command_result",
    distinct_id: options.installationId,
    properties
  };
}

export function createCliTelemetry(options: CliTelemetryOptions = {}): {
  prepare(): void;
  record(result: CliTelemetryResult): Promise<void>;
} {
  const environment = options.env ?? process.env;
  const baseDir = options.baseDir;
  let state = readTelemetryState(baseDir);
  let installationId: string | undefined;
  let ready = false;

  function prepare(): void {
    try {
      const hasCaptureConfiguration = Boolean(
        typeof options.capture === "function" || resolvePostHogConfig(environment)
      );
      if (!hasCaptureConfiguration || !state.enabled || isEnvironmentSuppressed(environment)) {
        return;
      }

      if (!state.noticeShown) {
        // Without a real notice writer, fail closed. The first non-TTY or
        // agent invocation must never silently create an ID or send an event.
        if (options.isTTY !== true || !options.writeNotice) {
          return;
        }
        options.writeNotice(TELEMETRY_NOTICE);
        state.noticeShown = true;
        writeTelemetryState(state, baseDir);
      }

      if (!state.noticeShown) {
        return;
      }

      if (!isInstallationId(state.installationId)) {
        const candidate = options.randomId?.() ?? randomUUID();
        if (!isInstallationId(candidate)) {
          return;
        }
        state.installationId = candidate;
        writeTelemetryState(state, baseDir);
      }

      installationId = state.installationId;
      ready = isInstallationId(installationId);
    } catch {
      // Telemetry preparation is always best effort and must never affect the
      // command's result or output.
      ready = false;
    }
  }

  async function record(result: CliTelemetryResult): Promise<void> {
    try {
      if (!ready || !installationId) {
        return;
      }

      const event = buildCliTelemetryEvent(result, {
        installationId,
        cliVersion: options.cliVersion ?? "",
        platform: options.platform ?? process.platform
      });
      if (!event) {
        return;
      }

      const capture = options.capture ?? createPostHogCaptureClient(options, environment);
      if (!capture) {
        return;
      }
      await capture(event);
    } catch {
      // Network errors, timeout, malformed local telemetry state, and test
      // capture failures are intentionally invisible to the CLI user.
    }
  }

  return { prepare, record };
}

function createPostHogCaptureClient(
  options: CliTelemetryOptions,
  environment: Environment
): CaptureClient | null {
  const config = resolvePostHogConfig(environment);
  if (!config) {
    return null;
  }

  const fetcher = options.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    return null;
  }

  return async (event): Promise<void> => {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = fetcher(config.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        // The project token is PostHog request authentication. It is kept out
        // of the event properties and is never logged or exposed as product
        // context.
        body: JSON.stringify({
          api_key: config.projectToken,
          event: event.event,
          distinct_id: event.distinct_id,
          properties: event.properties
        }),
        signal: controller.signal
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("telemetry timeout"));
        }, timeoutMs);
      });
      const response = await Promise.race([request, timeoutPromise]);
      if (!response.ok) {
        return;
      }
    } catch {
      // Deliberately do not expose a request error, endpoint, or token.
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };
}

function getSuppression(options: {
  state: TelemetryFile;
  env: Environment;
  hasCaptureConfiguration: boolean;
}): TelemetryStatus["suppression"] {
  if (!options.state.enabled) {
    return "disabled";
  }
  if (isCiEnvironment(options.env)) {
    return "ci";
  }
  if (options.env.DO_NOT_TRACK === "1") {
    return "do_not_track";
  }
  if (!options.hasCaptureConfiguration) {
    return "not_configured";
  }
  if (!options.state.noticeShown) {
    return "notice_required";
  }
  if (!isInstallationId(options.state.installationId)) {
    return "id_missing";
  }
  return "none";
}

function isEnvironmentSuppressed(env: Environment): boolean {
  return isCiEnvironment(env) || env.DO_NOT_TRACK === "1";
}

function isCiEnvironment(env: Environment): boolean {
  const ciValue = env.CI;
  if (ciValue !== undefined && ciValue !== "" && ciValue !== "0" && ciValue.toLowerCase() !== "false") {
    return true;
  }

  for (const key of [
    "CONTINUOUS_INTEGRATION",
    "BUILD_NUMBER",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "JENKINS_URL",
    "BUILDKITE",
    "CIRCLECI",
    "TF_BUILD",
    "TEAMCITY_VERSION"
  ]) {
    if (env[key]) {
      return true;
    }
  }
  return false;
}

function defaultTelemetryState(): TelemetryFile {
  return { version: 1, enabled: true, noticeShown: false };
}

function writeTelemetryState(state: TelemetryFile, baseDir?: string): boolean {
  try {
    const path = telemetryFilePath(baseDir);
    const directory = join(baseDir ?? homedir(), ".api-key-case");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const payload: TelemetryFile = {
      version: 1,
      enabled: state.enabled,
      noticeShown: state.noticeShown,
      ...(isInstallationId(state.installationId) ? { installationId: state.installationId } : {})
    };
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    chmodSync(directory, 0o700);
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

function toOsFamily(platform: NodeJS.Platform | string): CliTelemetryProperties["os_family"] {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "other";
}

function isTarget(value: unknown): value is CliTelemetryTarget {
  return value === "cloudflare" || value === "vercel" || value === "github";
}

function isCommand(value: unknown): value is CliTelemetryCommand {
  return value === "scan" || value === "save" || value === "license_activate" || value === "deploy";
}

function isOutcome(value: unknown): value is CliTelemetryOutcome {
  return value === "success" || value === "failure" || value === "cancelled" || value === "blocked";
}

function isErrorCategory(value: unknown): value is CliTelemetryErrorCategory {
  return [
    "invalid_input",
    "non_interactive",
    "dependency_unavailable",
    "already_registered",
    "not_registered",
    "confirmation_declined",
    "license_required",
    "license_activation_failed",
    "operation_failed",
    "strict_findings",
    "dry_run",
    "timeout",
    "unexpected_error"
  ].includes(value as CliTelemetryErrorCategory);
}

function isInstallationId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
