import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { extname, join } from "node:path";
import type { ConnectionIntent, ProviderHostedIntent } from "./connection-state.js";
import type { ScanReport } from "../scanner.js";
import type { StoredSecretRef } from "../vault/types.js";

const SCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

/** Names/scope/project identity only; never a value-derived hash. */
export function connectionCredentialFingerprint(ref: StoredSecretRef): string {
  // Preserve the v1 fingerprint for historical observations; v2 is disjoint.
  return sha256(JSON.stringify({ name: ref.name, scope: ref.scope, projectId: ref.projectId,
    ...("environment" in ref ? { service: ref.service, environment: ref.environment } : {}) }));
}

/**
 * Fingerprint only source syntax that can be safely separated from values.
 * Comment text is omitted but its line breaks are retained because they can
 * change automatic semicolon insertion. Any string/numeric/regex value makes
 * the basis unavailable so behavior-bearing values are never silently omitted
 * from the digest. Unsupported constructs fail closed.
 */
export function resendSourceFingerprint(scan: ScanReport): string | null {
  if (!scan.requiredSecrets.includes("RESEND_API_KEY")) return null;
  const usage = scan.secretUsages.find((entry) => entry.name === "RESEND_API_KEY");
  if (!usage || usage.files.length === 0) return null;

  const findings = new Set(scan.secretFindings.map((finding) => finding.file));
  const files: Array<{ path: string; syntax: string }> = [];
  for (const path of [...usage.files].sort()) {
    if (findings.has(path) || !SCRIPT_EXTENSIONS.has(extname(path).toLowerCase())) return null;
    let source: string;
    try {
      source = readFileSync(join(scan.targetDir, ...path.split("/")), "utf8");
    } catch {
      return null;
    }
    const syntax = safeScriptSyntax(source);
    if (syntax === null) return null;
    files.push({ path, syntax });
  }

  return sha256(JSON.stringify({ required: true, files }));
}

/** A stable, non-secret projection of the selected connection intent. */
export function connectionIntentFingerprint(intent: ConnectionIntent | ProviderHostedIntent): string {
  return sha256(JSON.stringify({
    service: intent.service,
    environment: intent.environment,
    slot: intent.slot,
    route: intent.route,
    ...(intent.service === "resend" && intent.nativeEnrollment ? { nativeEnrollment: intent.nativeEnrollment } : {}),
    destination: intent.destination.kind,
    sendingDomain: intent.sendingDomain
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeScriptSyntax(source: string): string | null {
  let output = "";
  let index = 0;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];

    if (current === "\r") {
      output += "\n";
      index += next === "\n" ? 2 : 1;
      continue;
    }
    if (current === "\n" || current === "\u2028" || current === "\u2029") {
      output += "\n";
      index += 1;
      continue;
    }
    if (/\s/.test(current)) {
      output += " ";
      index += 1;
      continue;
    }

    if (current === "'" || current === '"') return null;

    if (current === "`") return null;

    if (current === "/" && next === "/") {
      index += 2;
      while (index < source.length && !isLineTerminator(source[index])) index += 1;
      output += " ";
      continue;
    }
    if (current === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) return null;
      const comment = source.slice(index + 2, end);
      const lineBreaks = comment.match(/\r\n|[\r\n\u2028\u2029]/g) ?? [];
      index = end + 2;
      output += " ";
      output += "\n".repeat(lineBreaks.length);
      continue;
    }

    // Slash may begin a regular expression, whose payload cannot be safely
    // classified as non-secret without a full parser.
    if (current === "/" || /[0-9]/.test(current) || current.charCodeAt(0) > 0x7f) return null;

    if (/[A-Za-z_$]/.test(current)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      const token = source.slice(start, index);
      // Long opaque identifiers could be pasted credentials or tokens.
      if (token.length >= 24) return null;
      output += token;
      continue;
    }

    output += current;
    index += 1;
  }

  return output.trim();
}

function isLineTerminator(value: string): boolean {
  return value === "\n" || value === "\r" || value === "\u2028" || value === "\u2029";
}

/**
 * Conservative application closure for advisory observations. The earlier
 * secret-reference fingerprint is not a complete application basis. Inspect
 * all project scripts; dependency/configuration inputs we cannot classify stay
 * unknown. No raw values enter the digest. This intentionally supports only a
 * small source-only synthetic/project subset until a reviewed resolver exists.
 */
export function applicationSourceFingerprint(projectDir: string): string | null {
  const files: Array<{ path: string; syntax: string }> = [];
  let visited = 0, bytes = 0;
  function visit(relative: string): boolean {
    for (const name of readdirSync(join(projectDir, relative)).sort()) {
      if (++visited > 500) return false;
      if (!relative && name === ".git") continue;
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(join(projectDir, path));
      if (stat.isSymbolicLink()) return false;
      // Never read environment values; they are unresolved configuration.
      if (name === ".env" || name.startsWith(".env.")) return false;
      if (stat.isDirectory()) {
        if (name === "node_modules" || !visit(path)) return false;
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) return false;
      if (!relative && name === ".gitignore") continue;
      if (!SCRIPT_EXTENSIONS.has(extname(path).toLowerCase())) return false;
      bytes += stat.size;
      if (bytes > 1024 * 1024) return false;
      const syntax = safeScriptSyntax(readFileSync(join(projectDir, path), "utf8"));
      if (syntax === null) return false;
      files.push({ path, syntax });
    }
    return true;
  }
  try {
    if (!visit("") || files.length === 0) return null;
    return sha256(JSON.stringify({ version: "application-source-closure-1", files }));
  } catch { return null; }
}
