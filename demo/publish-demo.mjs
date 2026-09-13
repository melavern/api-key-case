// Assembles the public site bundle (landing page, policy pages, demo video)
// and, only when explicitly asked, deploys it to the existing Cloudflare Pages
// project.
//
//   node publish-demo.mjs            # stage build/site/ and print the command
//   node publish-demo.mjs --deploy   # stage, then deploy to production
//
// The Pages project holds only the files listed in ASSETS, so a deployment
// replaces the whole site and removes nothing else in the account.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "./lib/main.mjs";
import {
  BUILD_DIR,
  CAPTIONS_VTT_PATH,
  JAPANESE_CAPTIONS_VTT_PATH,
  JAPANESE_POSTER_PATH,
  JAPANESE_VIDEO_PATH,
  POSTER_PATH,
  REPO_DIR,
  VIDEO_PATH
} from "./config.mjs";

const SITE_DIR = join(BUILD_DIR, "site");
const PROJECT = "api-key-case-lp";

const PAGES = ["index.html", "tokushoho.html", "terms.html", "privacy.html", "refund.html"];

const ASSETS = [
  ...PAGES.map((name) => ({ from: join(REPO_DIR, name), to: name })),
  { from: join(REPO_DIR, "robots.txt"), to: "robots.txt" },
  { from: join(REPO_DIR, "sitemap.xml"), to: "sitemap.xml" },
  { from: VIDEO_PATH, to: "demo.mp4" },
  { from: POSTER_PATH, to: "demo-poster.jpg" },
  { from: CAPTIONS_VTT_PATH, to: "demo.vtt" },
  { from: JAPANESE_VIDEO_PATH, to: "demo-ja.mp4" },
  { from: JAPANESE_POSTER_PATH, to: "demo-ja-poster.jpg" },
  { from: JAPANESE_CAPTIONS_VTT_PATH, to: "demo-ja.vtt" }
];

// Legal pages must never regress to an unfinished template. This refuses any
// reintroduced 【要記入】 marker rather than publishing a half-filled disclosure.
const PLACEHOLDER = "【要記入";

export function stageSite() {
  for (const asset of ASSETS) {
    if (!existsSync(asset.from)) {
      throw new Error(`missing ${asset.from} — run \`npm run demo:all\` first.`);
    }
  }

  const page = readFileSync(join(REPO_DIR, "index.html"), "utf8");
  for (const required of [
    "demo.mp4",
    "demo-poster.jpg",
    "demo.vtt",
    "demo-ja.mp4",
    "demo-ja-poster.jpg",
    "demo-ja.vtt"
  ]) {
    if (!page.includes(required)) {
      throw new Error(`index.html does not reference ${required}; refusing to publish a broken page.`);
    }
  }
  for (const name of PAGES) {
    if (!page.includes(`href="${name}"`) && name !== "index.html") {
      throw new Error(`index.html does not link to ${name}; refusing to publish an unreachable page.`);
    }
  }

  for (const name of ["index.html", "tokushoho.html", "terms.html"]) {
    const content = readFileSync(join(REPO_DIR, name), "utf8");
    if (!content.includes("2,980")) {
      throw new Error(`${name} does not contain the current 2,980 price.`);
    }
  }
  for (const name of ["index.html", "tokushoho.html", "terms.html", "refund.html"]) {
    const content = readFileSync(join(REPO_DIR, name), "utf8");
    if (!content.includes("14日")) {
      throw new Error(`${name} does not contain the current 14-day refund term.`);
    }
  }

  const unfilled = PAGES.map((name) => {
    const count = readFileSync(join(REPO_DIR, name), "utf8").split(PLACEHOLDER).length - 1;
    return count > 0 ? `${name} (${count})` : null;
  }).filter(Boolean);
  if (unfilled.length > 0) {
    throw new Error(
      `${PLACEHOLDER}】 placeholders remain in: ${unfilled.join(", ")}.\n` +
        "Fill them in before publishing — a public 特定商取引法 page with a missing seller name " +
        "is worse than no page at all."
    );
  }

  rmSync(SITE_DIR, { recursive: true, force: true });
  mkdirSync(SITE_DIR, { recursive: true });
  for (const asset of ASSETS) {
    copyFileSync(asset.from, join(SITE_DIR, asset.to));
    const size = statSync(join(SITE_DIR, asset.to)).size;
    console.log(`  ${asset.to.padEnd(18)} ${(size / 1024).toFixed(0)} KB`);
  }
  console.log(`staged: ${SITE_DIR}`);
  return SITE_DIR;
}

export function deploy() {
  const dir = stageSite();
  console.log(`deploying to Cloudflare Pages project "${PROJECT}" (production)`);
  const result = spawnSync(
    "npx",
    ["wrangler", "pages", "deploy", dir, "--project-name", PROJECT, "--branch", "main", "--commit-dirty=true"],
    { cwd: REPO_DIR, stdio: "inherit", shell: process.platform === "win32" }
  );
  if (result.status !== 0) {
    throw new Error(`wrangler pages deploy failed with exit code ${result.status}`);
  }
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.includes("--deploy")) {
      deploy();
    } else {
      stageSite();
      console.log("\nNot deployed. To publish this to https://apikeycase.melavern.com run:");
      console.log("  node publish-demo.mjs --deploy");
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
