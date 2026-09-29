// Assembles the public site bundle (landing page, policy pages, demo video)
// for local review. Provider uploads use the checked Web publication plan.
//
//   node publish-demo.mjs            # stage build/site/ and print the command
//   npm run web:apply   # stage, then deploy to production
//   npm run web:preview  # deploy index.html to the fixed preview branch
//
// The Pages project holds only the files listed in ASSETS, so a deployment
// replaces the whole site and removes nothing else in the account.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMain } from "./lib/main.mjs";
import {
  BUILD_DIR,
  REPO_DIR
} from "./config.mjs";

const SITE_DIR = join(BUILD_DIR, "site");

// index.html is now the Agent-first landing page, so the publish gate can no
// longer be a separate file name that no deploy lane reaches. While
// docs/landing-page/PAGE_SPEC.md §8 (AC-1..AC-4) is unmet, production
// deployment is refused and the review Preview is staged noindex, so a page
// that claims an unimplemented experience cannot be read as the live site.
// Opened on 2026-09-14 for 0.9.1: AC-1..AC-4 were accepted on the Windows
// 11 + Hello host, and the exact-version package plus its public source were
// verified from an external path before this flag changed (PAGE_SPEC §9).
// Flip it back to false only as a deliberate withdrawal of the page's claims.
export const LANDING_PAGE_PUBLISH_GATE_MET = true;
const LP_POSTHOG_PROJECT_TOKEN_ENV = "API_KEY_CASE_LP_POSTHOG_PROJECT_TOKEN";
const LP_POSTHOG_API_HOST_ENV = "API_KEY_CASE_LP_POSTHOG_API_HOST";
const DEFAULT_POSTHOG_API_HOST = "https://us.i.posthog.com";
const POSTHOG_CAPTURE_HOSTS = new Set([
  "https://us.i.posthog.com",
  "https://eu.i.posthog.com"
]);
const POSTHOG_PROJECT_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{8,256}$/;
const PRIVATE_CREDENTIAL_PREFIXES = ["phx_", "phs_"];
const POSTHOG_CONFIG_MARKER = "<!-- API_KEY_CASE_POSTHOG_CONFIG -->";
const LOCAL_POSTHOG_CONFIG_KEYS = [LP_POSTHOG_PROJECT_TOKEN_ENV, LP_POSTHOG_API_HOST_ENV];
const LOCAL_POSTHOG_CONFIG_PATH = join(REPO_DIR, ".env.local");

const PAGES = ["index.html", "os-support.html", "tokushoho.html", "terms.html", "privacy.html", "refund.html"];

// Three 28-second announcements rendered by the private marketing-video harness
// from the pinned product source and committed as finished assets. The bundle
// needs no second build tool. Provenance: docs/landing-page/PAGE_SPEC.md §7.
// SNS media (3): README movie/poster public URLs and companion captions.
const SNS_MEDIA = ["launch-ja.mp4", "launch-ja-poster.jpg", "launch-ja.vtt"];
// LP media (6): vertical/landscape video, poster and captions embedded by the LP.
const LP_MEDIA = ["launch-ja-lp-vertical.mp4", "launch-ja-lp-vertical-poster.jpg", "launch-ja-lp-vertical.vtt", "launch-ja-landscape.mp4", "launch-ja-landscape-poster.jpg", "launch-ja-landscape.vtt"];

// Brand assets: the favicon set linked from every page head, the SVG marks the
// inline header logo is reconstructed from, and the social preview image the
// landing page's Open Graph / Twitter Card metadata points at. Sources are the
// selected PNGs in docs/branding/ (see docs/landing-page/PAGE_SPEC.md §7).
const BRAND_ASSETS = [
  "favicon.ico",
  "brand/favicon.svg",
  "brand/mark.svg",
  "brand/logo.svg",
  "brand/apple-touch-icon.png",
  "brand/og-image.png"
];

const ASSETS = [
  ...PAGES.map((name) => ({ from: join(REPO_DIR, name), to: name })),
  { from: join(REPO_DIR, "robots.txt"), to: "robots.txt" },
  { from: join(REPO_DIR, "sitemap.xml"), to: "sitemap.xml" },
  // The legacy recordings contain the retired brand and pre-0.9.1 behavior.
  // Never silently pick them up from an existing local demo/build directory.
  ...[...SNS_MEDIA, ...LP_MEDIA].map((name) => ({ from: join(REPO_DIR, name), to: name })),
  ...BRAND_ASSETS.map((name) => ({ from: join(REPO_DIR, name), to: name }))
];

export const SITE_ASSET_PATHS = Object.freeze(ASSETS.map((asset) => asset.to));

// Legal pages must never regress to an unfinished template. This refuses any
// reintroduced 【要記入】 marker rather than publishing a half-filled disclosure.
const PLACEHOLDER = "【要記入";

function parseLocalValue(value) {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
      return value.slice(1, -1);
    }
  }
  return value.replace(/\s+#.*$/u, "").trim();
}

export function loadLocalPostHogConfig(filePath = LOCAL_POSTHOG_CONFIG_PATH) {
  if (!existsSync(filePath)) return {};

  const content = readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
  const config = {};
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || !LOCAL_POSTHOG_CONFIG_KEYS.includes(match[1])) continue;
    config[match[1]] = parseLocalValue(match[2]);
  }
  return config;
}

export function resolvePreviewPostHogEnvironment(
  environment = process.env,
  localEnvironment = loadLocalPostHogConfig()
) {
  const resolved = {};
  for (const key of LOCAL_POSTHOG_CONFIG_KEYS) {
    if (Object.hasOwn(environment, key)) {
      resolved[key] = environment[key];
    } else if (Object.hasOwn(localEnvironment, key)) {
      resolved[key] = localEnvironment[key];
    }
  }
  return resolved;
}

export function renderLandingPage(page, environment = process.env) {
  if (!page.includes(POSTHOG_CONFIG_MARKER)) {
    throw new Error("index.html is missing the PostHog configuration marker.");
  }

  const projectToken = typeof environment[LP_POSTHOG_PROJECT_TOKEN_ENV] === "string"
    ? environment[LP_POSTHOG_PROJECT_TOKEN_ENV].trim()
    : "";
  const apiHostValue = typeof environment[LP_POSTHOG_API_HOST_ENV] === "string"
    ? environment[LP_POSTHOG_API_HOST_ENV].trim().replace(/\/+$/, "")
    : DEFAULT_POSTHOG_API_HOST;

  if (!projectToken) {
    return page.replace(POSTHOG_CONFIG_MARKER, "");
  }
  if (!POSTHOG_CAPTURE_HOSTS.has(apiHostValue)) {
    throw new Error("API Key Case LP PostHog API host must be the approved US or EU capture host.");
  }
  if (
    !POSTHOG_PROJECT_TOKEN_PATTERN.test(projectToken) ||
    PRIVATE_CREDENTIAL_PREFIXES.some((prefix) => projectToken.startsWith(prefix))
  ) {
    throw new Error("API Key Case LP PostHog configuration requires a public Project Token.");
  }

  const configScript = `<script>window.API_KEY_CASE_POSTHOG_CONFIG = ${JSON.stringify({
    apiHost: apiHostValue,
    projectToken
  })};</script>`;
  return page.replace(POSTHOG_CONFIG_MARKER, configScript);
}

export function stageSite({ requirePostHog = false, environment = process.env, sourceDir = REPO_DIR, siteDir = SITE_DIR, quiet = false } = {}) {
  const page = checkLandingPage(readFileSync(join(sourceDir, "index.html"), "utf8"));
  // Require all six LP media references. SNS assets are staged for the README
  // public URLs; they are not embedded in the LP.
  for (const required of LP_MEDIA) {
    if (!page.includes(required)) {
      throw new Error(`index.html does not reference ${required}; refusing to publish a broken page.`);
    }
  }
  for (const required of ["favicon.ico", "brand/favicon.svg", "brand/apple-touch-icon.png", "brand/og-image.png"]) {
    if (!page.includes(`"${required}"`) && !page.includes(`/${required}"`)) {
      throw new Error(`index.html does not reference ${required}; refusing to publish a page without its brand assets.`);
    }
  }
  for (const name of PAGES) {
    if (!page.includes(`href="${name}"`) && name !== "index.html") {
      throw new Error(`index.html does not link to ${name}; refusing to publish an unreachable page.`);
    }
  }

  for (const name of ["index.html", "tokushoho.html", "terms.html"]) {
    const content = readFileSync(join(sourceDir, name), "utf8");
    if (!content.includes("2,980")) {
      throw new Error(`${name} does not contain the current 2,980 price.`);
    }
  }
  for (const name of ["index.html", "tokushoho.html", "terms.html", "refund.html"]) {
    const content = readFileSync(join(sourceDir, name), "utf8");
    if (!content.includes("14日")) {
      throw new Error(`${name} does not contain the current 14-day refund term.`);
    }
  }

  const unfilled = PAGES.map((name) => {
    const count = readFileSync(join(sourceDir, name), "utf8").split(PLACEHOLDER).length - 1;
    return count > 0 ? `${name} (${count})` : null;
  }).filter(Boolean);
  if (unfilled.length > 0) {
    throw new Error(
      `${PLACEHOLDER}】 placeholders remain in: ${unfilled.join(", ")}.\n` +
        "Fill them in before publishing — a public 特定商取引法 page with a missing seller name " +
        "is worse than no page at all."
    );
  }

  const renderedLandingPage = applyPublishGate(renderLandingPage(page, environment));
  if (requirePostHog && !renderedLandingPage.includes("window.API_KEY_CASE_POSTHOG_CONFIG = ")) {
    throw new Error(
      `${LP_POSTHOG_PROJECT_TOKEN_ENV} must be set to a public Project Token before deploying the fixed Preview.`
    );
  }

  // Validate configuration before requiring generated video assets. This keeps
  // configuration checks usable in a clean clone, with no staging side effect.
  for (const asset of ASSETS) {
    if (!existsSync(join(sourceDir, asset.to))) {
      throw new Error(`missing ${join(sourceDir, asset.to)} — run \`npm run demo:all\` first.`);
    }
  }

  rmSync(siteDir, { recursive: true, force: true });
  mkdirSync(siteDir, { recursive: true });

  for (const asset of ASSETS) {
    const destination = join(siteDir, asset.to);
    mkdirSync(dirname(destination), { recursive: true });
    if (asset.to === "index.html") {
      writeFileSync(destination, renderedLandingPage, "utf8");
    } else if (asset.to === "robots.txt" && !LANDING_PAGE_PUBLISH_GATE_MET) {
      // A review Preview of a gated page must not be indexable, whatever a
      // crawler does with the meta tag.
      writeFileSync(destination, "User-agent: *\nDisallow: /\n", "utf8");
    } else {
      copyFileSync(join(sourceDir, asset.to), destination);
    }
    const size = statSync(destination).size;
    if (!quiet) console.log(`  ${asset.to.padEnd(18)} ${(size / 1024).toFixed(0)} KB`);
  }
  if (!quiet) console.log(`staged: ${siteDir}`);
  return siteDir;
}

// Command shapes that must not appear in the landing page body. The page
// claims the reader never has to learn the CLI, so a visible command example
// would contradict the page itself (PAGE_SPEC §5).
const LANDING_FORBIDDEN_COMMAND_STRINGS = [
  "npx ",
  "api-key-case scan",
  "api-key-case save",
  "api-key-case deploy",
  "api-key-case check",
  "api-key-case list",
  "api-key-case remove",
  "api-key-case license",
  "wrangler secret",
  "vercel env",
  "gh secret"
];

export function checkLandingPage(page) {
  // The copied Agent protocol needs exact commands; the human-facing marketing
  // copy still must not teach CLI usage. Only this named source is exempt.
  const marketingCopy = page.replace(/<textarea\b[^>]*\bid="prompt-agent"[^>]*>[\s\S]*?<\/textarea>/gi, "");
  for (const forbidden of LANDING_FORBIDDEN_COMMAND_STRINGS) {
    if (marketingCopy.includes(forbidden)) {
      throw new Error(`index.html contains the command example "${forbidden.trim()}"; the page must not teach CLI usage.`);
    }
  }
  return page;
}

// While the publish gate is unmet the page may only exist on the review
// Preview, so it is staged noindex regardless of what the committed file says.
export function applyPublishGate(page) {
  if (LANDING_PAGE_PUBLISH_GATE_MET) return page;
  if (page.includes('name="robots"')) return page;
  return page.replace(
    '<meta charset="utf-8">',
    '<meta charset="utf-8">\n  <meta name="robots" content="noindex, nofollow">'
  );
}

// Production and provider Preview uploads must use the checked publication plan.
// This compatibility entry deliberately cannot upload an unchecked working tree.
export function deploy() {
  throw new Error("Use npm run web:plan, web:check, then web:apply after explicit Production approval (docs/WEB_PUBLICATION.md).");
}

export function deployPreview() {
  throw new Error("Use npm run web:preview after web:plan and web:check (docs/WEB_PUBLICATION.md).");
}

if (isMain(import.meta.url)) {
  try {
    const wantsProduction = process.argv.includes("--deploy");
    const wantsPreview = process.argv.includes("--preview");
    if (wantsProduction && wantsPreview) {
      throw new Error("Choose one of --deploy or --preview.");
    }
    if (wantsPreview) {
      deployPreview();
    } else if (wantsProduction) {
      deploy();
    } else {
      stageSite();
      console.log("\nNot deployed. To update the fixed Preview branch, run:");
      console.log("  npm run web:preview");
      if (LANDING_PAGE_PUBLISH_GATE_MET) {
        console.log("\nTo publish this to https://apikeycase.melavern.com run:");
        console.log("  npm run web:apply");
      } else {
        console.log("\nProduction deployment is gated by docs/landing-page/PAGE_SPEC.md §8 (AC-1..AC-4).");
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
