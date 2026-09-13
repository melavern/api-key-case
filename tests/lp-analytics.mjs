import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(resolve(repoDir, "index.html"), "utf8");
const scriptMatch = [...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .find((match) => !/type=["']application\/ld\+json["']/i.test(match[0]));
assert.ok(scriptMatch, "index.html must contain an executable inline script");
const script = scriptMatch[1];

const syntaxCheck = spawnSync(process.execPath, ["--check", "--input-type=module"], {
  input: script,
  encoding: "utf8"
});
assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr || syntaxCheck.stdout);
assert.doesNotThrow(() => new vm.Script(script), "inline LP script must compile");

assert.match(page, /id="pro-checkout"[^>]*data-lp-action="checkout"/);
assert.match(page, /data-lp-action="github"/);
assert.match(page, /data-lp-action="setup-prompt"/);
assert.match(page, /data-lp-action="review-prompt"/);
assert.doesNotMatch(page, /テレメトリなし/);
for (const eventName of [
  "lp_view",
  "lp_pricing_view",
  "lp_free_start",
  "lp_review_prompt_copy",
  "lp_github_click",
  "lp_checkout_click",
  "lp_os_support_click", "lp_macos_apply_click",
  "lp_video_start", "lp_video_progress", "lp_video_complete"
]) {
  assert.match(script, new RegExp(`"${eventName}"`), `${eventName} must be allowlisted`);
}
// The demo player left the page with the old landing copy, so nothing can emit
// its event any more. See docs/analytics/MEASUREMENT.md.
assert.doesNotMatch(script, /lp_demo_play/, "a retired event must not stay in the allowlist");
assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon/);
assert.doesNotMatch(script, /\$pageview|\$autocapture/);
assert.doesNotMatch(script, /posthog-js/);

class FakeElement {
  constructor({ dataset = {}, attributes = {}, textContent = "", value = "" } = {}) {
    this.dataset = { ...dataset };
    this.attributes = { ...attributes };
    this.textContent = textContent;
    this.value = value;
    this.listeners = new Map();
    this.focused = false;
    this.selected = false;
    this.open = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatch(type) {
    const results = (this.listeners.get(type) ?? []).map((listener) => listener({
      currentTarget: this,
      target: this,
      type
    }));
    await Promise.all(results.map((result) => Promise.resolve(result)));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name) {
    return Object.hasOwn(this.attributes, name);
  }

  focus() {
    this.focused = true;
  }

  select() {
    this.selected = true;
  }
}

class FakeIntersectionObserver {
  static instances = [];

  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.target = null;
    this.disconnected = false;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target) {
    this.target = target;
  }

  disconnect() {
    this.disconnected = true;
  }
}

const priceTitle = new FakeElement();

const setupPromptText = "このプロジェクトで API Key Case を使えるようにして、";
const reviewPromptText = "次のツールを使ってよいか、私の代わりに評価してください。";
const setupPrompt = new FakeElement({ value: setupPromptText });
const reviewPrompt = new FakeElement({ value: reviewPromptText });

const makePromptCta = (action, location) => {
  const status = new FakeElement({
    attributes: { role: "status", "aria-live": "polite" }
  });
  const disclosure = new FakeElement();
  const button = new FakeElement({
    dataset: {
      promptTarget: action === "setup-prompt" ? "prompt-agent" : "prompt-review",
      promptSource: `prompt-source-${location}-${action}`,
      promptStatus: `cta-status-${location}-${action}`,
      lpAction: action,
      lpLocation: location,
      promptDone: "コピーしました。"
    }
  });
  return { button, status, disclosure };
};

const heroSetup = makePromptCta("setup-prompt", "hero");
const proofReview = makePromptCta("review-prompt", "proof");
const finalSetup = makePromptCta("setup-prompt", "final");
const promptCtas = [heroSetup, proofReview, finalSetup];

const elementsById = new Map([
  ["prompt-agent", setupPrompt],
  ["prompt-review", reviewPrompt],
  ["price-title", priceTitle],
  ...promptCtas.map(({ button, status }) => [button.dataset.promptStatus, status]),
  ...promptCtas.map(({ button, disclosure }) => [button.dataset.promptSource, disclosure])
]);

const headerGithub = new FakeElement();
const pricingGithub = new FakeElement();
const footerGithub = new FakeElement();
const checkout = new FakeElement();
const video = new FakeElement();
video.duration = 100;
video.played = { length: 1, start: () => 0, end: () => 0 };
const application = new FakeElement();
application.closest = (selector) => selector === "#price";
const support = new FakeElement();
support.closest = (selector) => selector === ".hero";

const querySelectors = new Map([
  ["video", [video]],
  ["a[href='https://tally.so/r/RGAYLK']", [application]],
  ['a[href="os-support.html"], a[href="os-support.html#macos-contributors"]', [support]],
  ["[data-prompt-target]", promptCtas.map(({ button }) => button)],
  ['[data-lp-action="github"]', [headerGithub, pricingGithub, footerGithub]],
  ['[data-lp-action="checkout"]', [checkout]]
]);

const requests = [];
const copiedTexts = [];
let clipboardMode = "success";
const fakeWindow = {
  API_KEY_CASE_POSTHOG_CONFIG: {
    apiHost: "https://us.i.posthog.com",
    projectToken: "public-test-project-token"
  },
  location: {
    protocol: "https:",
    hostname: "apikeycase.melavern.com"
  },
  referrer: "https://github.com/melavern/api-key-case?secret=must-not-send",
  innerWidth: 1440,
  crypto: {
    randomUUID: () => "00000000-0000-4000-8000-000000000001"
  },
  navigator: {
    clipboard: {
      async writeText(value) {
        copiedTexts.push(value);
        if (clipboardMode === "failure") throw new Error("clipboard unavailable");
      }
    }
  },
  IntersectionObserver: FakeIntersectionObserver,
  fetch(url, options) {
    requests.push({ url, options });
    return Promise.resolve({ ok: true });
  },
  AbortController,
  setTimeout,
  clearTimeout
};

const fakeDocument = {
  referrer: fakeWindow.referrer,
  querySelectorAll(selector) {
    return querySelectors.get(selector) ?? [];
  },
  getElementById(id) {
    return elementsById.get(id) ?? null;
  }
};

const context = vm.createContext({
  window: fakeWindow,
  document: fakeDocument,
  URL,
  Uint8Array,
  Array,
  Number,
  Object,
  Promise,
  Error,
  AbortController,
  setTimeout,
  clearTimeout
});
vm.runInContext(script, context);

const analytics = fakeWindow.API_KEY_CASE_LP_ANALYTICS;
assert.ok(analytics, "LP analytics hook must be exposed for payload tests");
const toPlain = (value) => JSON.parse(JSON.stringify(value));
assert.equal(requests.length, 1, "page view must be captured once on load");
const pageView = JSON.parse(requests[0].options.body);
assert.equal(requests[0].url, "https://us.i.posthog.com/i/v0/e/");
assert.deepEqual(pageView.properties, {
  product: "api_key_case",
  surface: "lp",
  "$process_person_profile": false,
  device_bucket: "desktop",
  source_bucket: "github"
});
assert.equal(pageView.event, "lp_view");
assert.match(pageView.distinct_id, /^lp-00000000-0000-4000-8000-000000000001$/);
assert.equal(requests[0].options.credentials, "omit");
assert.equal(requests[0].options.referrerPolicy, "no-referrer");
assert.equal(requests[0].options.keepalive, true);
assert.equal(JSON.stringify(pageView).includes("must-not-send"), false);

const forbidden = {
  device_bucket: "mobile",
  source_bucket: "other",
  location: "hero",
  copy_result: "success",
  apiKey: "shh-test-secret",
  secretName: "OPENAI_API_KEY",
  path: "C:\\Users\\test-user\\private-project",
  repository: "melavern/api-key-case",
  project: "customer-project",
  projectId: "project-123",
  product: "user-controlled-product",
  surface: "user-controlled-surface",
  account: "customer-account",
  licenseKey: "LS-purchase-key",
  orderId: "order-123",
  email: "person@example.invalid",
  ip: "192.0.2.10",
  referrer: "https://evil.invalid/?token=must-not-send",
  prompt: setupPromptText
};
const forbiddenMarkers = [
  forbidden.apiKey,
  forbidden.secretName,
  forbidden.path,
  forbidden.repository,
  forbidden.project,
  forbidden.projectId,
  forbidden.account,
  forbidden.licenseKey,
  forbidden.orderId,
  forbidden.email,
  forbidden.ip,
  forbidden.referrer,
  forbidden.prompt
];
for (const eventName of [
  "lp_view",
  "lp_pricing_view",
  "lp_free_start",
  "lp_review_prompt_copy",
  "lp_github_click",
  "lp_checkout_click",
  "lp_os_support_click", "lp_macos_apply_click",
  "lp_video_start", "lp_video_progress", "lp_video_complete"
]) {
  const payload = analytics.buildEventPayload(eventName, forbidden);
  assert.ok(payload, `${eventName} must build a payload`);
  assert.equal(payload.properties.product, "api_key_case");
  assert.equal(payload.properties.surface, "lp");
  const serialized = JSON.stringify(payload);
  for (const value of forbiddenMarkers) {
    assert.equal(serialized.includes(value), false, `${eventName} leaked ${value}`);
  }
}
assert.equal(analytics.buildEventPayload("not-an-allowed-event", forbidden), null);
assert.equal(analytics.buildEventPayload("lp_demo_play", forbidden), null, "the retired demo event must not be accepted");
for (const eventName of ["lp_free_start", "lp_review_prompt_copy"]) {
  assert.deepEqual(toPlain(analytics.buildEventPayload(eventName, forbidden).properties), {
    product: "api_key_case",
    surface: "lp",
    "$process_person_profile": false,
    location: "hero",
    copy_result: "success"
  });
  assert.deepEqual(toPlain(analytics.buildEventPayload(eventName, {
    location: "somewhere-else",
    copy_result: "maybe"
  }).properties), {
    product: "api_key_case",
    surface: "lp",
    "$process_person_profile": false
  }, `${eventName} must drop values outside the closed set`);
}
assert.equal(analytics.sourceBucket("https://x.com/post?token=secret", "apikeycase.melavern.com"), "x");
assert.equal(analytics.sourceBucket("https://t.co/abc123", "apikeycase.melavern.com"), "x", "t.co share links must classify as x");
assert.equal(analytics.sourceBucket("https://search.brave.com/search?q=secret", "apikeycase.melavern.com"), "search");
assert.equal(analytics.sourceBucket("https://apikeycase.melavern.com/?token=secret", "apikeycase.melavern.com"), "direct");
assert.equal(analytics.deviceBucket(), "desktop");
fakeWindow.innerWidth = 390;
assert.equal(analytics.deviceBucket(), "mobile");
fakeWindow.innerWidth = 1440;

const eventsNamed = (name) => requests
  .map(({ options }) => JSON.parse(options.body))
  .filter((payload) => payload.event === name);

await heroSetup.button.dispatch("click");
assert.deepEqual(copiedTexts, [setupPromptText], "the setup CTA must copy the setup prompt");
assert.equal(heroSetup.status.dataset.state, "success");
assert.match(heroSetup.status.textContent, /コピーしました/);
assert.deepEqual(eventsNamed("lp_free_start").at(-1).properties, {
  product: "api_key_case",
  surface: "lp",
  "$process_person_profile": false,
  location: "hero",
  copy_result: "success"
});
assert.equal(JSON.stringify(eventsNamed("lp_free_start").at(-1)).includes(setupPromptText), false);

await proofReview.button.dispatch("click");
assert.deepEqual(copiedTexts, [setupPromptText, reviewPromptText], "the review CTA must copy the review prompt");
assert.deepEqual(eventsNamed("lp_review_prompt_copy").at(-1).properties, {
  product: "api_key_case",
  surface: "lp",
  "$process_person_profile": false,
  location: "proof",
  copy_result: "success"
});
assert.equal(JSON.stringify(eventsNamed("lp_review_prompt_copy").at(-1)).includes(reviewPromptText), false);

await finalSetup.button.dispatch("click");
assert.equal(eventsNamed("lp_free_start").at(-1).properties.location, "final", "each placement must report its own location");

clipboardMode = "failure";
await heroSetup.button.dispatch("click");
assert.equal(heroSetup.status.dataset.state, "failure");
assert.match(heroSetup.status.textContent, /手動でコピー/);
assert.equal(heroSetup.disclosure.open, true, "a failed copy must open the prompt body");
assert.equal(setupPrompt.focused && setupPrompt.selected, true, "a failed copy must select the prompt body for manual copying");
assert.deepEqual(eventsNamed("lp_free_start").at(-1).properties, {
  product: "api_key_case",
  surface: "lp",
  "$process_person_profile": false,
  location: "hero",
  copy_result: "failure"
});
clipboardMode = "success";

const beforeGithub = requests.length;
await headerGithub.dispatch("click");
assert.equal(requests.length, beforeGithub + 1, "one GitHub click must produce one event");
assert.equal(JSON.parse(requests.at(-1).options.body).event, "lp_github_click");

const beforeCheckout = requests.length;
await checkout.dispatch("click");
assert.equal(requests.length, beforeCheckout + 1, "one checkout click must produce one event");
assert.equal(JSON.parse(requests.at(-1).options.body).event, "lp_checkout_click");

await application.dispatch("click");
assert.equal(eventsNamed("lp_macos_apply_click").at(-1).properties.location, "pricing");
await support.dispatch("click");
assert.equal(eventsNamed("lp_os_support_click").at(-1).properties.location, "hero");
await video.dispatch("timeupdate");
assert.equal(eventsNamed("lp_video_progress").length, 0);
await video.dispatch("playing");
await video.dispatch("playing");
assert.equal(eventsNamed("lp_video_start").length, 1);
video.currentTime = 99;
await video.dispatch("timeupdate");
assert.equal(eventsNamed("lp_video_progress").length, 0, "seeking past unwatched content must not count");
video.played.end = () => 80;
video.seeking = true;
await video.dispatch("timeupdate");
assert.equal(eventsNamed("lp_video_progress").length, 0);
video.seeking = false;
await video.dispatch("timeupdate");
await video.dispatch("timeupdate");
assert.deepEqual(eventsNamed("lp_video_progress").map(p => p.properties.percent), [25, 50, 75]);
await video.dispatch("ended");
await video.dispatch("playing");
await video.dispatch("ended");
assert.equal(eventsNamed("lp_video_start").length, 1);
assert.equal(eventsNamed("lp_video_complete").length, 1);
assert.equal(analytics.buildEventPayload("lp_video_progress", {percent: 99, video_id: "private-url"}).properties.percent, undefined);
assert.equal(analytics.buildEventPayload("lp_video_start", {video_id: "private-url"}).properties.video_id, "launch_ja");
assert.equal(analytics.buildEventPayload("lp_macos_apply_click", {location: "private-text"}).properties.location, undefined);

assert.equal(FakeIntersectionObserver.instances.length, 1, "the pricing sentinel must be observed exactly once");
const pricingObserver = FakeIntersectionObserver.instances[0];
assert.equal(pricingObserver.target, priceTitle, "the small heading, not the whole (much taller) section, must be observed");
assert.equal(pricingObserver.options.threshold, 0.5);

const beforePricingView = requests.length;
pricingObserver.callback([{ isIntersecting: true, intersectionRatio: 0.2 }]);
assert.equal(requests.length, beforePricingView, "a partial view below the threshold must not fire");
pricingObserver.callback([{ isIntersecting: false, intersectionRatio: 0.9 }]);
assert.equal(requests.length, beforePricingView, "an entry reported as not intersecting must not fire");
pricingObserver.callback([{ isIntersecting: true, intersectionRatio: 0.5 }]);
assert.equal(eventsNamed("lp_pricing_view").length, 1);
assert.deepEqual(toPlain(eventsNamed("lp_pricing_view").at(-1).properties), {
  product: "api_key_case",
  surface: "lp",
  "$process_person_profile": false
});
assert.equal(pricingObserver.disconnected, true, "the observer must disconnect once the event has fired");
pricingObserver.callback([{ isIntersecting: true, intersectionRatio: 1 }]);
assert.equal(eventsNamed("lp_pricing_view").length, 1, "pricing view must fire at most once per page load");

fakeWindow.fetch = () => { throw new Error("analytics offline"); };
assert.doesNotThrow(() => analytics.capture("lp_checkout_click"), "analytics failure must be ignored");
assert.doesNotThrow(() => analytics.capture("lp_view", forbidden), "malformed analytics input must be ignored safely");

// Configuration failures disable analytics without disabling the UI.
for (const config of [undefined, {}, {apiHost: "https://evil.invalid", projectToken: "public-test-token"},
  {apiHost: "https://us.i.posthog.com", projectToken: "phx_private-test"}]) {
  const isolatedWindow = {...fakeWindow, API_KEY_CASE_POSTHOG_CONFIG: config};
  let sent = 0;
  isolatedWindow.fetch = () => { sent++; return Promise.resolve({ok: true}); };
  vm.runInNewContext(script, {window: isolatedWindow, document: fakeDocument, URL, Uint8Array, AbortController, setTimeout, clearTimeout});
  assert.equal(sent, 0);
  assert.equal(isolatedWindow.API_KEY_CASE_LP_ANALYTICS.buildEventPayload("lp_video_start"), null);
}
console.log("LP analytics tests passed");
