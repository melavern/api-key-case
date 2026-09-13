import type { KeyObject } from "node:crypto";
import {
  parseLicenseKey,
  saveLicenseKey,
  type LicenseStatus
} from "./license.js";

// Fixed at build time and deliberately not configurable through argv or the
// environment: a purchase key must never be redirected to an arbitrary host.
export const LICENSE_EXCHANGE_URL = "https://apikeycase-license.melavern.com/license/exchange";

const MAX_RESPONSE_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LicenseActivationOptions {
  // Test-only DI. Production CLI call sites pass no options.
  endpoint?: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
  publicKey?: KeyObject;
  baseDir?: string;
}

export class LicenseActivationError extends Error {
  constructor() {
    super("License activation failed.");
    this.name = "LicenseActivationError";
  }
}

export async function activatePurchaseLicense(
  purchaseKey: string,
  options: LicenseActivationOptions = {}
): Promise<Extract<LicenseStatus, { plan: "pro" }>> {
  if (purchaseKey.length === 0 || purchaseKey.length > 4096 || /[\r\n]/.test(purchaseKey)) {
    throw new LicenseActivationError();
  }

  const endpoint = options.endpoint ?? LICENSE_EXCHANGE_URL;
  if (!isHttpsEndpoint(endpoint)) {
    throw new LicenseActivationError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let raw: string;
  try {
    const response = await (options.fetcher ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ licenseKey: purchaseKey }),
      // The reviewed exchange host must answer directly. Never forward a
      // purchase key through a redirect to a different or retired domain.
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) throw new LicenseActivationError();
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
      throw new LicenseActivationError();
    }
    raw = await readBoundedResponse(response);
  } catch {
    throw new LicenseActivationError();
  } finally {
    clearTimeout(timeout);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new LicenseActivationError();
  }
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "licenseKey") || typeof body.licenseKey !== "string") {
    throw new LicenseActivationError();
  }

  const status = parseLicenseKey(body.licenseKey, options.publicKey);
  if (status.plan !== "pro") {
    throw new LicenseActivationError();
  }

  // The existing license file is touched only after the Worker response has
  // passed local AKC1 signature verification.
  saveLicenseKey(body.licenseKey, options.baseDir);
  return status;
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) throw new LicenseActivationError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return text + decoder.decode();
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new LicenseActivationError();
      }
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function isHttpsEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
