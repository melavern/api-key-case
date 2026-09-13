// Local-only preview server for the landing and policy pages.
//
// The route table deliberately mirrors the static files assembled by
// publish-demo.mjs. It is an allowlist, not a repository file server: the
// working tree also contains source, tests, docs, and local-only configuration
// that must never become HTTP-visible just because this preview is running.

import { createReadStream, lstatSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/main.mjs";

const repoDir = fileURLToPath(new URL("../", import.meta.url));
// Hubはverify.jsonで解決したレーン番号をPORTへ渡す。単独実行の引数も後方互換で残す。
const port = Number.parseInt(process.argv[2] ?? process.env.PORT ?? "4173", 10);

const PREVIEW_ROUTES = new Map([
  ["/", { source: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/index.html", { source: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/os-support.html", { source: "os-support.html", contentType: "text/html; charset=utf-8" }],
  ["/tokushoho.html", { source: "tokushoho.html", contentType: "text/html; charset=utf-8" }],
  ["/terms.html", { source: "terms.html", contentType: "text/html; charset=utf-8" }],
  ["/privacy.html", { source: "privacy.html", contentType: "text/html; charset=utf-8" }],
  ["/refund.html", { source: "refund.html", contentType: "text/html; charset=utf-8" }],
  ["/robots.txt", { source: "robots.txt", contentType: "text/plain; charset=utf-8" }],
  ["/sitemap.xml", { source: "sitemap.xml", contentType: "application/xml; charset=utf-8" }],
  // The committed 28-second announcement embedded in index.html (EV section).
  ["/launch-ja.mp4", { source: "launch-ja.mp4", contentType: "video/mp4" }],
  ["/launch-ja-poster.jpg", { source: "launch-ja-poster.jpg", contentType: "image/jpeg" }],
  ["/launch-ja.vtt", { source: "launch-ja.vtt", contentType: "text/vtt; charset=utf-8" }],
  // Brand assets referenced from every page head (icons) and the landing
  // page Open Graph / Twitter Card metadata (og-image).
  ["/favicon.ico", { source: "favicon.ico", contentType: "image/x-icon" }],
  ["/brand/favicon.svg", { source: "brand/favicon.svg", contentType: "image/svg+xml; charset=utf-8" }],
  ["/brand/mark.svg", { source: "brand/mark.svg", contentType: "image/svg+xml; charset=utf-8" }],
  ["/brand/logo.svg", { source: "brand/logo.svg", contentType: "image/svg+xml; charset=utf-8" }],
  ["/brand/apple-touch-icon.png", { source: "brand/apple-touch-icon.png", contentType: "image/png" }],
  ["/brand/og-image.png", { source: "brand/og-image.png", contentType: "image/png" }]
]);

// Check every path component instead of relying only on a normalized string.
// This keeps an allowed URL from becoming a symlink-based escape hatch if a
// local build directory is replaced or tampered with.
function regularFileWithoutSymlink(rootDir, relativePath) {
  let current = rootDir;
  let rootStats;
  try {
    rootStats = lstatSync(current);
  } catch {
    return null;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return null;

  const parts = relativePath.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      return null;
    }
    if (stats.isSymbolicLink()) return null;
    if (index < parts.length - 1 && !stats.isDirectory()) return null;
    if (index === parts.length - 1 && !stats.isFile()) return null;
  }
  return current;
}

/**
 * Resolve a request pathname to one of the explicitly allowed preview files.
 * Query strings are intentionally handled by the HTTP layer and never affect
 * this lookup.
 */
export function resolvePreviewAsset(pathname, rootDir = repoDir) {
  const route = PREVIEW_ROUTES.get(pathname);
  if (!route) return null;
  const filePath = regularFileWithoutSymlink(rootDir, route.source);
  return filePath ? { ...route, filePath } : null;
}

function sendNotFound(response) {
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

function sendMethodNotAllowed(response) {
  response.writeHead(405, {
    Allow: "GET, HEAD",
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end("Method Not Allowed");
}

/**
 * Parse a single-range `Range` header against a file of `size` bytes.
 *
 * iOS Safari (and the AVFoundation media stack behind `<video>`) probes a
 * media URL with `Range: bytes=0-1` and refuses to play unless the server
 * answers 206 with a Content-Range; a 200 with the whole file is treated as
 * "no range support" and playback silently fails. Returns `null` when there
 * is no usable single range (the caller then serves the whole file, which
 * RFC 9110 allows), or `{ unsatisfiable: true }` when the range lies outside
 * the file, which must be a 416 rather than a silent full response.
 */
export function parseByteRange(header, size) {
  if (typeof header !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === "" && last === "") return null;
  if (size === 0) return { unsatisfiable: true };
  let start;
  let end;
  if (first === "") {
    // Suffix range: the last N bytes.
    const suffix = Number.parseInt(last, 10);
    if (suffix === 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(first, 10);
    end = last === "" ? size - 1 : Math.min(Number.parseInt(last, 10), size - 1);
    if (start >= size || start > end) return { unsatisfiable: true };
  }
  return { start, end };
}

export function createPreviewServer({ rootDir = repoDir } = {}) {
  return createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendMethodNotAllowed(response);
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      sendNotFound(response);
      return;
    }

    const asset = resolvePreviewAsset(pathname, rootDir);
    if (!asset) {
      sendNotFound(response);
      return;
    }

    let size;
    try {
      const stats = lstatSync(asset.filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("not a regular file");
      size = stats.size;
    } catch {
      sendNotFound(response);
      return;
    }

    const headers = {
      "Content-Type": asset.contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes"
    };

    const range = parseByteRange(request.headers.range, size);
    if (range?.unsatisfiable) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
      response.end();
      return;
    }

    let status = 200;
    let streamOptions;
    let contentLength = size;
    if (range) {
      status = 206;
      streamOptions = { start: range.start, end: range.end };
      contentLength = range.end - range.start + 1;
      headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    }

    response.writeHead(status, { ...headers, "Content-Length": contentLength });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(asset.filePath, streamOptions).pipe(response);
  });
}

if (isMain(import.meta.url)) {
  const server = createPreviewServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`API Key Case site preview: http://127.0.0.1:${actualPort}/`);
  });
}
