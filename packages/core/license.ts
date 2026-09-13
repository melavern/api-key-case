// Single insertion point for Phase 5 license gating (CLAUDE.md §1, §5).
// Runtime Pro checks are offline Ed25519 verification only. The separate
// first-run purchase exchange lives in license-exchange.ts.
import { createPublicKey, verify as verifyEd25519, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Public half of the license-signing keypair (phase-5-license.md §3.2).
// The private half is held only by the issuer, outside this repository —
// The same existing private half must be configured as a Worker secret.
const EMBEDDED_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2h2jC83HL2Q+gSqXNgIxsiCsIUJIZ7P2hoXAMcajvbM=
-----END PUBLIC KEY-----
`;

const KEY_PREFIX = "AKC1";

// Single source of truth so the CLI and MCP purchase prompts never drift apart.
// This points at the site's purchase section rather than the bare Lemon
// Squeezy checkout: the human has to pass the price, host conditions, Terms
// and refund policy before the checkout button, and an Agent relaying this
// link never lands anyone directly on a payment form.
export const PURCHASE_URL = "https://apikeycase.melavern.com/#purchase";

export class ProFeatureError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(`${feature} is a Pro feature (one-time purchase).`);
    this.name = "ProFeatureError";
    this.feature = feature;
  }
}

interface LicensePayload {
  v: 1;
  plan: "pro";
  id: string;
  issuedAt: string;
}

export type LicenseStatus =
  | { plan: "pro"; entitlementId: string; issuedAt: string }
  | { plan: "free"; reason: "missing" | "invalid" };

// Test-only DI points (mirrors the pathOverride/baseDir pattern used
// elsewhere in this codebase — see deploy/which.ts, vault/registry.ts).
// Production call sites always call these with no arguments.
export interface LicenseOptions {
  publicKey?: KeyObject;
  baseDir?: string;
}

let cachedEmbeddedKey: KeyObject | undefined;
function embeddedPublicKey(): KeyObject {
  if (!cachedEmbeddedKey) {
    cachedEmbeddedKey = createPublicKey(EMBEDDED_PUBLIC_KEY_PEM);
  }
  return cachedEmbeddedKey;
}

function licenseKeyPath(baseDir?: string): string {
  return join(baseDir ?? homedir(), ".api-key-case", "license.key");
}

function isLicensePayload(value: unknown): value is LicensePayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    record.plan === "pro" &&
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.issuedAt === "string" &&
    record.issuedAt.length > 0
  );
}

// Verifies format + signature only; never reveals which check failed
// (phase-5-license.md §4.1 — don't help key-forgery trial and error).
export function parseLicenseKey(key: string, publicKey: KeyObject = embeddedPublicKey()): LicenseStatus {
  const trimmed = key.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) {
    return { plan: "free", reason: "invalid" };
  }
  const [prefix, payloadPart, signaturePart] = parts;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return { plan: "free", reason: "invalid" };
  }
  if (!isLicensePayload(payload)) {
    return { plan: "free", reason: "invalid" };
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(signaturePart, "base64url");
  } catch {
    return { plan: "free", reason: "invalid" };
  }

  const signedData = Buffer.from(`${prefix}.${payloadPart}`, "utf8");
  let valid: boolean;
  try {
    valid = verifyEd25519(null, signedData, publicKey, signature);
  } catch {
    return { plan: "free", reason: "invalid" };
  }
  if (!valid) {
    return { plan: "free", reason: "invalid" };
  }

  return { plan: "pro", entitlementId: payload.id, issuedAt: payload.issuedAt };
}

export function readLicenseStatus(opts: LicenseOptions = {}): LicenseStatus {
  const path = licenseKeyPath(opts.baseDir);
  if (!existsSync(path)) {
    return { plan: "free", reason: "missing" };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { plan: "free", reason: "invalid" };
  }

  return parseLicenseKey(raw, opts.publicKey ?? embeddedPublicKey());
}

// Deliberately stored in plaintext, unlike the API-key Vault (Phase 2):
// a leaked license key only lets someone else use Pro deploy features,
// which is out of scope for the secret-protection boundary in CLAUDE.md §3
// (phase-5-license.md §4.2).
export function saveLicenseKey(key: string, baseDir?: string): void {
  const dir = join(baseDir ?? homedir(), ".api-key-case");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(licenseKeyPath(baseDir), `${key.trim()}\n`, { encoding: "utf8", mode: 0o600 });
}

export function deactivateLicense(baseDir?: string): boolean {
  const path = licenseKeyPath(baseDir);
  if (!existsSync(path)) {
    return false;
  }
  rmSync(path);
  return true;
}

// free / scan / save / check / list / remove never call this (§5-23):
// this is the only function in the codebase that can block a command.
export function assertProFeature(feature: "deploy", opts: LicenseOptions = {}): void {
  const status = readLicenseStatus(opts);
  if (status.plan !== "pro") {
    throw new ProFeatureError(feature);
  }
}
