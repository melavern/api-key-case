import type { ConnectionResultCode } from "./connection-state.js";

export const RESEND_VERIFIER_VERSION = "resend-credential-validation-v1";
export const RESEND_CLI_VERSION = "2.23.0";
// Official registry.npmjs.org/resend-cli/-/resend-cli-2.23.0.tgz, dist/cli.cjs.
export const RESEND_NPM_BUNDLE_SHA256 = "213dfe31a4855c472ea8bcce4d20c0b2c850ab8d18e4d82f00a598d85f20b82a";
export type ResendValidationCode = Extract<ConnectionResultCode,
  "valid-full-access" | "valid-sending-access" | "invalid-credential" |
  "cli-unavailable" | "network-unavailable" | "unexpected-output" | "unknown">;

type Check = { name: string; status: "pass" | "warn" | "fail"; message: string; detail?: string };
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Internal only. No provider strings, masked suffixes, or domains escape this projection. */
export function parseResendDoctor(stdout: string, exitCode: number | null): ResendValidationCode {
  if (stdout.length > 64 * 1024 || ![0, 1].includes(exitCode ?? -1)) return "unexpected-output";
  let data: unknown;
  try { data = JSON.parse(stdout); } catch { return "unexpected-output"; }
  if (!object(data) || Object.keys(data).sort().join(",") !== "checks,ok" ||
      typeof data.ok !== "boolean" || !Array.isArray(data.checks) || data.checks.length !== 4) return "unexpected-output";
  const checks: Check[] = [];
  for (const check of data.checks) {
    if (!object(check) || Object.keys(check).some((key) => !["name", "status", "message", "detail"].includes(key)) ||
        typeof check.name !== "string" || !["pass", "warn", "fail"].includes(String(check.status)) ||
        typeof check.message !== "string" || (check.detail !== undefined && typeof check.detail !== "string")) return "unexpected-output";
    checks.push(check as Check);
  }
  if (new Set(checks.map((check) => check.name)).size !== checks.length) return "unexpected-output";
  const [version, key, storage, validation] = checks;
  if (version.name !== "CLI Version" || !["pass", "warn"].includes(version.status) ||
      !version.message.startsWith(`v${RESEND_CLI_VERSION} (`) || key.name !== "API Key" ||
      storage.name !== "Credential Storage" || !["pass", "warn"].includes(storage.status) ||
      !["Domains", "API Validation"].includes(validation.name)) return "unexpected-output";
  const failed = checks.some((check) => check.status === "fail");
  if (data.ok !== !failed || exitCode !== (failed ? 1 : 0)) return "unexpected-output";
  // Only our injected env credential can establish a result. A fallback profile never does.
  if (key.status !== "pass" || !/ \(source: env\)$/.test(key.message)) return "unknown";
  if (validation.name === "Domains") {
    if (validation.status === "pass" && /^\d+ verified, \d+ pending$/.test(validation.message)) return "valid-full-access";
    if (validation.status === "warn" && (validation.message === "No domains configured" ||
        /^\d+ domain\(s\) pending verification$/.test(validation.message))) return "valid-full-access";
    return "unexpected-output";
  }
  if (validation.status === "warn") {
    if (validation.message === "Sending-only API key" || validation.message === "Sending-only credential") return "valid-sending-access";
    if (validation.message === "Request timed out" ||
        validation.message === "Network error. Check your connection and try again") return "network-unavailable";
    return "unknown";
  }
  // doctor flattens non-restricted API errors, including 429/5xx, into a fail.
  // Only an exact known authentication rejection is invalid; the rest is unknown.
  if (validation.status === "fail" && /^(?:Invalid API key|Invalid credential): (?:API key is invalid|API key is invalid\.|Invalid API key|Invalid API key\.)$/.test(validation.message)) return "invalid-credential";
  return "unknown";
}
