import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createPreviewServer, parseByteRange } from "../demo/serve-site.mjs";

const fixtureRoot = mkdtempSync(join(tmpdir(), "api-key-case-preview-test-"));
const allowedFiles = new Map([
  ["index.html", "<h1>LP fixture</h1>"],
  ["os-support.html", "OS support fixture"],
  ["tokushoho.html", "tokushoho fixture"],
  ["terms.html", "terms fixture"],
  ["privacy.html", "privacy fixture"],
  ["refund.html", "refund fixture"],
  ["robots.txt", "User-agent: *\n"],
  ["sitemap.xml", "<urlset />"],
  ["launch-ja.mp4", "announcement video fixture"],
  ["launch-ja-poster.jpg", "announcement poster fixture"],
  ["launch-ja.vtt", "WEBVTT\n"],
  ["favicon.ico", "favicon fixture"],
  ["brand/favicon.svg", "<svg>favicon fixture</svg>"],
  ["brand/mark.svg", "<svg>mark fixture</svg>"],
  ["brand/logo.svg", "<svg>logo fixture</svg>"],
  ["brand/apple-touch-icon.png", "touch icon fixture"],
  ["brand/og-image.png", "og image fixture"],
  ["demo/build/demo.mp4", "english video fixture"],
  ["demo/build/demo-poster.jpg", "english poster fixture"],
  ["demo/build/captions.vtt", "WEBVTT\n"],
  ["demo/build/demo-ja.mp4", "japanese video fixture"],
  ["demo/build/demo-ja-poster.jpg", "japanese poster fixture"],
  ["demo/build/captions-ja.vtt", "WEBVTT\n"]
]);

for (const [relativePath, content] of allowedFiles) {
  const filePath = join(fixtureRoot, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

const withheldFiles = new Map([
  ["README.md", "private repository documentation"],
  ["package.json", "private project configuration"],
  ["docs/release-notes.md", "private release notes"],
  ["packages/cli/index.ts", "private source code"],
  ["demo/serve-site.mjs", "private development server source"],
  ["demo/build/scene.html", "private generated development artifact"]
]);
for (const [relativePath, content] of withheldFiles) {
  const filePath = join(fixtureRoot, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

const server = createPreviewServer({ rootDir: fixtureRoot });
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(pathname, options) {
    const response = await fetch(`${baseUrl}${pathname}`, options);
    return {
      status: response.status,
      headers: response.headers,
      body: await response.text()
    };
  }

  const expectedRoutes = [
    ["/", "<h1>LP fixture</h1>", "text/html; charset=utf-8"],
    ["/index.html", "<h1>LP fixture</h1>", "text/html; charset=utf-8"],
    ["/os-support.html", "OS support fixture", "text/html; charset=utf-8"],
    ["/tokushoho.html", "tokushoho fixture", "text/html; charset=utf-8"],
    ["/terms.html", "terms fixture", "text/html; charset=utf-8"],
    ["/privacy.html", "privacy fixture", "text/html; charset=utf-8"],
    ["/refund.html", "refund fixture", "text/html; charset=utf-8"],
    ["/robots.txt", "User-agent: *\n", "text/plain; charset=utf-8"],
    ["/sitemap.xml", "<urlset />", "application/xml; charset=utf-8"],
    ["/launch-ja.mp4", "announcement video fixture", "video/mp4"],
    ["/launch-ja-poster.jpg", "announcement poster fixture", "image/jpeg"],
    ["/launch-ja.vtt", "WEBVTT\n", "text/vtt; charset=utf-8"],
    ["/favicon.ico", "favicon fixture", "image/x-icon"],
    ["/brand/favicon.svg", "<svg>favicon fixture</svg>", "image/svg+xml; charset=utf-8"],
    ["/brand/mark.svg", "<svg>mark fixture</svg>", "image/svg+xml; charset=utf-8"],
    ["/brand/logo.svg", "<svg>logo fixture</svg>", "image/svg+xml; charset=utf-8"],
    ["/brand/apple-touch-icon.png", "touch icon fixture", "image/png"],
    ["/brand/og-image.png", "og image fixture", "image/png"]
  ];

  for (const [pathname, body, contentType] of expectedRoutes) {
    const response = await request(pathname);
    assert.equal(response.status, 200, `${pathname} must be served`);
    assert.equal(response.body, body, `${pathname} must serve its allowlisted file`);
    assert.equal(response.headers.get("content-type"), contentType, `${pathname} content type`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }

  const queryResponse = await request("/?file=package.json");
  assert.equal(queryResponse.status, 200, "query strings must not change the selected LP route");
  assert.equal(queryResponse.body, "<h1>LP fixture</h1>");

  for (const pathname of [
    ...withheldFiles.keys(),
    "/demo.mp4", "/demo-ja.mp4", "/demo.vtt", "/demo-ja.vtt",
    "/demo-poster.jpg", "/demo-ja-poster.jpg",
    "/%2e%2e/package.json",
    "/demo%2Fbuild%2Fscene.html",
    "/does-not-exist.html"
  ]) {
    const response = await request(pathname.startsWith("/") ? pathname : `/${pathname}`);
    assert.equal(response.status, 404, `${pathname} must not be available over HTTP`);
    assert.equal(response.body, "Not found");
  }

  const headResponse = await request("/index.html", { method: "HEAD" });
  assert.equal(headResponse.status, 200, "HEAD must work for the Hub's read-only checks");
  assert.equal(headResponse.body, "", "HEAD must not return a response body");
  assert.equal(headResponse.headers.get("content-length"), String(Buffer.byteLength("<h1>LP fixture</h1>")));

  const methodResponse = await request("/", { method: "POST" });
  assert.equal(methodResponse.status, 405, "the preview must not accept write methods");
  assert.equal(methodResponse.headers.get("allow"), "GET, HEAD");

  // Byte ranges: iOS Safari probes media with `Range: bytes=0-1` and will not
  // play the video unless it gets a 206, so the preview must answer ranges the
  // same way the Cloudflare Pages deployment does.
  const video = allowedFiles.get("launch-ja.mp4");
  const videoSize = Buffer.byteLength(video);
  const fullVideo = await request("/launch-ja.mp4");
  assert.equal(fullVideo.headers.get("accept-ranges"), "bytes", "full responses must advertise range support");

  const probe = await request("/launch-ja.mp4", { headers: { Range: "bytes=0-1" } });
  assert.equal(probe.status, 206, "the iOS media probe must get a partial response");
  assert.equal(probe.body, video.slice(0, 2));
  assert.equal(probe.headers.get("content-range"), `bytes 0-1/${videoSize}`);
  assert.equal(probe.headers.get("content-length"), "2");
  assert.equal(probe.headers.get("content-type"), "video/mp4");
  assert.equal(probe.headers.get("x-content-type-options"), "nosniff");

  const tail = await request("/launch-ja.mp4", { headers: { Range: "bytes=5-" } });
  assert.equal(tail.status, 206);
  assert.equal(tail.body, video.slice(5));
  assert.equal(tail.headers.get("content-range"), `bytes 5-${videoSize - 1}/${videoSize}`);

  const suffix = await request("/launch-ja.mp4", { headers: { Range: "bytes=-4" } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.body, video.slice(-4));
  assert.equal(suffix.headers.get("content-range"), `bytes ${videoSize - 4}-${videoSize - 1}/${videoSize}`);

  const clamped = await request("/launch-ja.mp4", { headers: { Range: `bytes=0-${videoSize + 100}` } });
  assert.equal(clamped.status, 206, "an end past EOF is clamped, not rejected");
  assert.equal(clamped.body, video);

  const beyond = await request("/launch-ja.mp4", { headers: { Range: `bytes=${videoSize}-` } });
  assert.equal(beyond.status, 416, "a range starting past EOF is unsatisfiable");
  assert.equal(beyond.headers.get("content-range"), `bytes */${videoSize}`);
  assert.equal(beyond.body, "");

  const rangeHead = await request("/launch-ja.mp4", { method: "HEAD", headers: { Range: "bytes=0-1" } });
  assert.equal(rangeHead.status, 206);
  assert.equal(rangeHead.body, "");
  assert.equal(rangeHead.headers.get("content-length"), "2");

  for (const malformed of ["apples", "bytes=", "bytes=1-2,4-5", "items=0-1"]) {
    const response = await request("/launch-ja.mp4", { headers: { Range: malformed } });
    assert.equal(response.status, 200, `unusable Range "${malformed}" falls back to the whole file`);
    assert.equal(response.body, video);
  }

  const withheldRange = await request("/package.json", { headers: { Range: "bytes=0-1" } });
  assert.equal(withheldRange.status, 404, "ranges must not widen the allowlist");

  assert.deepEqual(parseByteRange("bytes=0-1", 10), { start: 0, end: 1 });
  assert.deepEqual(parseByteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange("bytes=-30", 10), { start: 0, end: 9 });
  assert.deepEqual(parseByteRange("bytes=3-1", 10), { unsatisfiable: true });
  assert.deepEqual(parseByteRange("bytes=-0", 10), { unsatisfiable: true });
  assert.deepEqual(parseByteRange("bytes=0-1", 0), { unsatisfiable: true });
  assert.equal(parseByteRange(undefined, 10), null);
} finally {
  if (server.listening) {
    server.close();
    await once(server, "close");
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log("serve-site allowlist tests passed");
