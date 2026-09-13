import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pageNames = ["index.html", "tokushoho.html", "terms.html", "privacy.html", "refund.html"];
const pages = new Map(pageNames.map((name) => [name, readFileSync(resolve(repoDir, name), "utf8")]));

for (const [name, content] of pages) {
  assert.equal(content.includes("【要記入"), false, `${name} contains an unfinished legal placeholder`);
  assert.equal(content.includes("TODO-api-key-case"), false, `${name} contains a release placeholder`);
  assert.equal(content.includes("free forever"), false, `${name} makes an unlimited free-pricing promise`);
  assert.equal(content.includes("ずっと無料"), false, `${name} makes an unlimited free-pricing promise`);
  assert.match(content, /<html lang="ja">/, `${name} must declare Japanese content`);
  assert.match(content, /<meta name="description" content="[^"]+">/, `${name} must have a description`);
  assert.match(content, /<link rel="canonical" href="https:\/\/apikeycase\.melavern\.com\//, `${name} must have a production canonical URL`);
  if (name !== "index.html") {
    assert.doesNotMatch(content, /<link rel="canonical" href="https:\/\/apikeycase\.melavern\.com\/[^\"]+\.html/, `${name} canonical URL must use the live extensionless route`);
  }

  assert.doesNotMatch(
    content,
    /(?:href|src|poster)="\/(?:index\.html|terms\.html|privacy\.html|refund\.html|tokushoho\.html|demo(?:-ja)?\.(?:mp4|vtt)|demo(?:-ja)?-poster\.jpg)"/,
    `${name} must use file://-compatible relative links for local pages and media`
  );

  const localLinks = [...content.matchAll(/href="(?!https?:\/\/|mailto:|tel:|#)([^"#?]+)"/g)].map((match) => match[1]);
  for (const localPath of localLinks) {
    if ([
      "demo.mp4",
      "demo-poster.jpg",
      "demo.vtt",
      "demo-ja.mp4",
      "demo-ja-poster.jpg",
      "demo-ja.vtt"
    ].includes(localPath)) continue;
    assert.equal(existsSync(resolve(repoDir, localPath)), true, `${name} links to missing ${localPath}`);
  }
}

const landing = pages.get("index.html");
for (const policy of ["tokushoho.html", "terms.html", "privacy.html", "refund.html"]) {
  assert.match(landing, new RegExp(`href="${policy}"`), `index.html must link to ${policy}`);
}
assert.match(landing, /data-local-path="demo\/build\/demo\.mp4"/, "file:// mode must resolve the local demo video");
assert.match(landing, /data-local-poster-src="demo\/build\/demo-poster\.jpg"/, "file:// mode must resolve the local English demo poster");
assert.match(landing, /data-local-path="demo\/build\/demo-ja\.mp4"/, "file:// mode must resolve the Japanese demo video");
assert.match(landing, /data-local-poster="demo\/build\/demo-ja-poster\.jpg"/, "file:// mode must resolve the Japanese demo poster");
assert.match(landing, /data-demo-locale="ja"/, "landing must offer the Japanese demo");
assert.match(landing, /data-demo-locale="en"/, "landing must preserve the English demo");
assert.match(landing, /href="#demo-player"/, "demo links must jump directly to the compact player");
assert.match(landing, /class="demo-figure" id="demo-player"/, "compact demo player must expose its anchor");
assert.match(landing, /Mesmerizing Galaxy/, "landing must credit the Japanese demo BGM");
assert.match(landing, /Kevin MacLeod/, "landing must credit the BGM artist");
assert.match(landing, /creativecommons\.org\/licenses\/by\/4\.0/, "landing must link the BGM license");
assert.match(landing, /日本語テロップ · CLI出力は英語 · 1080p · BGMあり/, "Japanese demo must disclose its BGM");
assert.match(landing, /English · 1080p · 音声なし/, "English demo must remain unchanged and silent");
assert.match(landing, /2,980/, "landing price must be current");
assert.match(landing, /14日/, "landing refund window must be current");
assert.match(landing, /Lemon Squeezy/, "landing must identify the payment provider");

for (const name of ["index.html", "tokushoho.html", "terms.html"]) {
  assert.match(pages.get(name), /2,980/, `${name} price must be current`);
}
for (const name of ["index.html", "tokushoho.html", "terms.html", "refund.html"]) {
  assert.match(pages.get(name), /14日/, `${name} refund window must be current`);
}

const terms = pages.get("terms.html");
assert.match(terms, /MIT ライセンス/, "terms must preserve MIT rights");
assert.match(terms, /故意もしくは重大な過失/, "liability limit must preserve the intent/gross-negligence carve-out");
assert.match(terms, /生命もしくは身体/, "liability limit must preserve non-excludable personal-injury claims");
assert.match(terms, /医療、生命維持、緊急対応/, "terms must define excluded high-stakes uses");

const privacy = pages.get("privacy.html");
assert.match(privacy, /api-key-case@0\.9\.0/, "privacy must distinguish the immutable published package");
assert.match(privacy, /apikeycase-license\.leoneapps\.com/, "privacy must disclose npm 0.9.0's legacy endpoint");
assert.match(privacy, /apikeycase-license\.melavern\.com/, "privacy must disclose the rebranded source endpoint");
assert.match(privacy, /license activate/, "privacy must describe license activation traffic");
assert.match(privacy, /公式CLIによる配置/, "privacy must distinguish deploy traffic from activation traffic");
assert.match(privacy, /購入キーの SHA-256 ダイジェスト/, "privacy must describe purchase-key rate limiting");

const disclosure = pages.get("tokushoho.html");
assert.match(disclosure, /請求があれば遅滞なく開示します/, "commercial disclosure must provide a delayed-disclosure commitment");
assert.match(disclosure, /特商法に基づく表示の開示請求/, "commercial disclosure must provide a concrete request route");
assert.match(disclosure, /Sold through Link, LLC/, "commercial disclosure must identify the Merchant of Record entity");
assert.match(disclosure, /mailto:dev@melavern\.com/, "commercial disclosure must provide a private email route");

for (const name of ["index.html", "tokushoho.html", "terms.html", "privacy.html", "refund.html"]) {
  assert.match(pages.get(name), /dev@melavern\.com/, `${name} must expose the private contact address`);
}

console.log("site content tests passed");
