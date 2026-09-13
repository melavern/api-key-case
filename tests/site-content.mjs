import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  applyPublishGate,
  checkLandingPage,
  deploy,
  loadLocalPostHogConfig,
  renderLandingPage,
  resolvePreviewPostHogEnvironment,
  stageSite
} from "../demo/publish-demo.mjs";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(repoDir, "package.json"), "utf8"));
const readme = readFileSync(resolve(repoDir, "README.md"), "utf8");
const readmeJa = readFileSync(resolve(repoDir, "README.ja.md"), "utf8");
// Editorial source documents are deliberately withheld from the Public export.
// Public HTML, purchase conditions and the executable publish gate are still
// tested unconditionally below, including in a standalone Public clone.
const editorialSources = ["MESSAGING.md", "PAGE_SPEC.md"]
  .map((name) => resolve(repoDir, "docs/landing-page", name))
  .filter((path) => existsSync(path))
  .map((path) => readFileSync(path, "utf8"));
const pageNames = ["index.html", "os-support.html", "tokushoho.html", "terms.html", "privacy.html", "refund.html"];
const pages = new Map(pageNames.map((name) => [name, readFileSync(resolve(repoDir, name), "utf8")]));

for (const [name, content] of pages) {
  assert.equal(content.includes("【要記入"), false, `${name} contains an unfinished legal placeholder`);
  assert.equal(content.includes("TODO-api-key-case"), false, `${name} contains a release placeholder`);
  assert.equal(content.includes("free forever"), false, `${name} makes an unlimited free-pricing promise`);
  assert.equal(content.includes("ずっと無料"), false, `${name} makes an unlimited free-pricing promise`);
  assert.match(content, /<html lang="ja">/, `${name} must declare Japanese content`);
  assert.match(content, /<meta name="description" content="[^"]+">/, `${name} must have a description`);
  assert.match(content, /<link rel="canonical" href="https:\/\/apikeycase\.melavern\.com\//, `${name} must have a production canonical URL`);
  assert.match(content, /<link rel="icon" href="favicon\.ico" sizes="48x48">/, `${name} must link the ICO favicon`);
  assert.match(content, /<link rel="icon" href="brand\/favicon\.svg" type="image\/svg\+xml">/, `${name} must link the SVG favicon`);
  assert.match(content, /<link rel="apple-touch-icon" href="brand\/apple-touch-icon\.png">/, `${name} must link the touch icon`);
  assert.match(content, /<span class="brand-mark" aria-hidden="true">\s*<svg viewBox="0 0 256 256">\s*<rect width="256" height="256" rx="52" fill="#c2fb60"\/>/, `${name} header must use the inline SVG brand mark`);
  assert.doesNotMatch(content, /<span class="brand-mark"[^>]*>\s*<img\b/, `${name} header must not embed a raster logo`);
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
      "launch-ja-poster.jpg",
      "demo-ja.vtt"
    ].includes(localPath)) continue;
    assert.equal(existsSync(resolve(repoDir, localPath)), true, `${name} links to missing ${localPath}`);
  }
}

const landing = pages.get("index.html");
for (const content of [landing, pages.get("os-support.html"), pages.get("tokushoho.html"), readmeJa]) {
  assert.match(content, /macOS.{0,80}協力検証版/s, "macOS must be disclosed as a collaborative verification edition");
  assert.match(content, /macOSではProの配置機能を実機検証中です。購入はできますが、現時点では正常な動作を保証していません。/, "purchase guidance must disclose the macOS limit");
  assert.doesNotMatch(content, /macOSでの配置を前提にProを購入しないでください|macOSでの利用や購入を配置成功の前提にしないでください/, "purchase guidance must not restore the retired macOS wording");
}
assert.match(readme, /macOS is a collaborative verification edition/, "English entry must disclose macOS status");
const setupPrompt = landing.match(/id="prompt-agent"[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
assert.ok(setupPrompt, "the primary CTA must have an Agent setup prompt");
assert.ok(setupPrompt.includes(`npx -y api-key-case@${manifest.version} agent-init .`), "bootstrap must use the candidate's exact protocol version");
assert.match(setupPrompt, /next --json/);
assert.match(setupPrompt, /無料診断/);
assert.match(setupPrompt, /保存済みを配置済みと扱わず/);
assert.match(setupPrompt, /チャットでのYes \/ Noを承認の代わりに使ったり/);
assert.match(setupPrompt, /既存の \.env にあるキーも登録できます/);
assert.match(setupPrompt, /本文は読まず、私自身が値だけを専用画面へ入力します/);
assert.match(setupPrompt, /登録だけで終了しても構いません/);
assert.equal(landing.split("今の <code>.env</code> から始められます。").length - 1, 1);
assert.match(landing, /Agentに <code>\.env<\/code> を読ませたり、値をチャットへ貼ったりする必要はありません/);
assert.match(landing, /登録しても <code>\.env<\/code> は自動で置き換えない/);
assert.match(landing, /保存・登録状況の確認・Agentによる案内まで/);
assert.match(landing, /配置にはプロジェクト構成上の条件があります。購入前に、セットアップ用プロンプトから無料診断で確認してください/);
assert.match(landing, /Windows Hello が条件です/);
assert.match(landing, /Linuxは診断・状態確認・利用可能なOS保管庫への人間所有ターミナルからの保管まで/);
assert.match(landing, /Windows 11＋Hello：<\/strong>通常対応/);
assert.match(landing, /href="os-support\.html">対応状況と利用条件を見る/);
assert.match(landing, /お使いの環境を確認してください/);
assert.match(landing, /Macの実機検証にご協力いただける方へ/);
for (const content of [landing, pages.get("os-support.html"), ...editorialSources]) {
  assert.doesNotMatch(content, /参加は無料|参加無料|無料参加|macOS.{0,20}(?:通常対応|Beta|ベータ)/i);
  assert.match(content, /協力者向け(?:価格は)?980円/);
  assert.match(content, /通常Pro(?:は)? ?2,980円/);
  assert.match(content, /https:\/\/tally\.so\/r\/RGAYLK/);
}
assert.match(landing, /href="os-support\.html#macos-contributors"/);
assert.equal([...landing.matchAll(/href="https:\/\/tally\.so\/r\/RGAYLK"/g)].length, 2, "Hero and pricing must both offer direct applications");
assert.match(landing, /class="button button--quiet" href="https:\/\/tally\.so\/r\/RGAYLK">macOS協力検証に応募する/);
assert.match(landing, /Macの協力検証者を募集中 <span/);
assert.doesNotMatch(landing, /Macの協力検証者を募集中：協力者向け980円/);
for (const content of [landing, pages.get("os-support.html")]) {
  assert.match(content, /href="https:\/\/tally\.so\/r\/RGAYLK">macOS協力検証に応募する/);
}
assert.match(landing, /通常対応の配置は Windows 11 Build 22000以降＋Windows Hello が条件です/);
assert.match(landing, /dry-runもPro機能で、計画確認だけです/);
const osSupport = pages.get("os-support.html");
assert.match(osSupport, /最終更新：2026-09-13/);
assert.match(osSupport, /Windows 11＋Windows Hello/);
assert.match(osSupport, /macOS正式対応に向けて、実際のMacでの確認/);
assert.match(osSupport, /専用画面での入力・承認の仕組みが未提供のため、AIに任せる形での配置も現在提供していません/);
assert.match(osSupport, /2026-09-08時点の「macOS CI未実行」は当時の観測/);
assert.match(osSupport, /APIキー、<code>\.env<\/code>、購入キー（ライセンスキー）、アクセストークン、未加工ログは送らないでください/);
assert.match(osSupport, /初回は30〜60分程度/);
assert.match(osSupport, /必要な場合のみ10〜20分程度/);
assert.match(osSupport, /応募 → Mac環境の確認 → 対象の方へ個別案内 → 実機検証/);
assert.match(osSupport, /Apple Silicon \/ Intelの両方から応募できます。環境や現在の検証状況に応じて、お願いする内容が異なる場合があります/);
assert.match(osSupport, /セキュリティ問題は公開Issueに投稿せず/);
assert.match(osSupport, /href="mailto:dev@melavern\.com"/);
for (const policy of ["tokushoho.html", "terms.html", "privacy.html", "refund.html"]) {
  assert.match(landing, new RegExp(`href="${policy}"`), `index.html must link to ${policy}`);
}
assert.match(landing, /2,980/, "landing price must be current");
assert.match(landing, /14日/, "landing refund window must be current");
assert.match(landing, /Lemon Squeezy/, "landing must identify the payment provider");
assert.doesNotMatch(landing, /テレメトリなし/, "landing must not claim that all telemetry is absent");
for (const forbidden of [".envを卒業", ".env を卒業", ".envの自動削除", ".envの自動同期"]) {
  assert.equal(landing.includes(forbidden), false, `landing must not imply automatic env replacement: ${forbidden}`);
}

for (const [content, label] of [[readme, "English README"], [readmeJa, "Japanese README"]]) {
  assert.match(content, /current `?\.env`?|今の `\.env` から始める/, `${label} must explain the existing env path`);
  assert.match(content, /cannot hold different development and production values|development用と\s*production用の別々の値を同時には保持できません/, `${label} must explain the single project\/name slot`);
  assert.match(content, /scanner|scanner/, `${label} must explain scanner limitations`);
  assert.match(content, /Cloudflare/, `${label} must explain provider constraints`);
  assert.match(content, /registration remains available|Secretの登録自体は\s*可能/, `${label} must separate registration from deploy readiness`);
  assert.match(content, /excluding `\.env\.example`|`\.env\.example`を除く/, `${label} must exclude .env.example from the Cloudflare blocker`);
}

// Production plumbing the landing page keeps whatever its copy becomes.
assert.match(landing, /<meta property="og:url" content="https:\/\/apikeycase\.melavern\.com\/">/, "landing must keep the production Open Graph URL");
assert.match(landing, /<meta property="og:image" content="https:\/\/apikeycase\.melavern\.com\/brand\/og-image\.png">/, "landing must point Open Graph at the brand social preview image");
assert.match(landing, /<meta name="twitter:image" content="https:\/\/apikeycase\.melavern\.com\/brand\/og-image\.png">/, "landing must point the Twitter Card at the same social preview image");
assert.doesNotMatch(landing, /<meta (?:property|name)="(?:og|twitter):image" content="[^"]*launch-ja-poster\.jpg"/, "the video poster must no longer double as the social preview image");
assert.match(landing, /<meta property="og:image:width" content="1200">\s*<meta property="og:image:height" content="630">/, "landing must declare the social preview image size");
assert.match(landing, /<meta name="twitter:card" content="summary_large_image">/, "landing must keep the Twitter card type");
assert.doesNotMatch(landing, /<meta name="robots"/, "the committed landing page is the published page and must not ship a noindex tag");
assert.match(landing, /<!-- API_KEY_CASE_POSTHOG_CONFIG -->/, "landing must keep the deployment-time analytics hook");
assert.match(landing, new RegExp(`"softwareVersion": "${manifest.version.replaceAll(".", "\\.")}"`), "JSON-LD version must match package.json");
assert.match(landing, /"downloadUrl": "https:\/\/www\.npmjs\.com\/package\/api-key-case"/, "JSON-LD must link to npm");
assert.match(landing, /"codeRepository": "https:\/\/github\.com\/melavern\/api-key-case"/, "JSON-LD must link to GitHub");
assert.match(landing, /href="https:\/\/www\.npmjs\.com\/package\/api-key-case"/, "landing must link to npm");
assert.match(landing, /href="https:\/\/github\.com\/melavern\/api-key-case\/security\/policy"/, "landing must link to the security policy");

const stagedWithoutToken = renderLandingPage(landing, {});
assert.doesNotMatch(stagedWithoutToken, /API_KEY_CASE_POSTHOG_CONFIG\s*=/, "LP without a token must remain a safe no-op");
assert.throws(
  () => stageSite({ requirePostHog: true, environment: {} }),
  /must be set to a public Project Token before deploying the fixed Preview/
);

const localConfigDir = mkdtempSync(join(tmpdir(), "api-key-case-publish-test-"));
try {
  const localConfigPath = join(localConfigDir, ".env.local");
  writeFileSync(
    localConfigPath,
    [
      "# Only the two LP settings below are consumed.",
      "API_KEY_CASE_LP_POSTHOG_PROJECT_TOKEN=phc_local-test-token",
      "API_KEY_CASE_LP_POSTHOG_API_HOST=https://eu.i.posthog.com/",
      "UNRELATED_SECRET=must-not-be-used"
    ].join("\n"),
    "utf8"
  );
  const localConfig = loadLocalPostHogConfig(localConfigPath);
  assert.deepEqual(localConfig, {
    API_KEY_CASE_LP_POSTHOG_PROJECT_TOKEN: "phc_local-test-token",
    API_KEY_CASE_LP_POSTHOG_API_HOST: "https://eu.i.posthog.com/"
  });

  const fromLocal = resolvePreviewPostHogEnvironment({}, localConfig);
  assert.deepEqual(fromLocal, localConfig, "Preview settings must load from .env.local");
  const stagedFromLocal = renderLandingPage(landing, fromLocal);
  assert.equal(stagedFromLocal.includes('"apiHost":"https://eu.i.posthog.com"'), true);
  assert.equal(stagedFromLocal.includes('"projectToken":"phc_local-test-token"'), true);

  const fromProcess = resolvePreviewPostHogEnvironment({
    API_KEY_CASE_LP_POSTHOG_PROJECT_TOKEN: "phc_process-test-token",
    API_KEY_CASE_LP_POSTHOG_API_HOST: "https://us.i.posthog.com"
  }, localConfig);
  assert.deepEqual(fromProcess, {
    API_KEY_CASE_LP_POSTHOG_PROJECT_TOKEN: "phc_process-test-token",
    API_KEY_CASE_LP_POSTHOG_API_HOST: "https://us.i.posthog.com"
  }, "process environment must override .env.local");

  const explicitEmpty = resolvePreviewPostHogEnvironment({
    API_KEY_CASE_LP_POSTHOG_PROJECT_TOKEN: ""
  }, localConfig);
  assert.equal(explicitEmpty.API_KEY_CASE_LP_POSTHOG_PROJECT_TOKEN, "", "an explicit empty process value must not fall back to .env.local");
  assert.equal(explicitEmpty.API_KEY_CASE_LP_POSTHOG_API_HOST, "https://eu.i.posthog.com/");
} finally {
  rmSync(localConfigDir, { recursive: true, force: true });
}

const stagedForProduction = renderLandingPage(landing, {
  API_KEY_CASE_LP_POSTHOG_PROJECT_TOKEN: "phc_public-test-token",
  API_KEY_CASE_LP_POSTHOG_API_HOST: "https://eu.i.posthog.com/"
});
assert.match(stagedForProduction, /window\.API_KEY_CASE_POSTHOG_CONFIG/);
assert.equal(stagedForProduction.includes('"apiHost":"https://eu.i.posthog.com"'), true);
assert.equal(stagedForProduction.includes('"projectToken":"phc_public-test-token"'), true);
assert.throws(
  () => renderLandingPage(landing, { API_KEY_CASE_LP_POSTHOG_PROJECT_TOKEN: "phx_personal-secret" }),
  /public Project Token/
);
assert.throws(
  () => renderLandingPage(landing, { API_KEY_CASE_LP_POSTHOG_PROJECT_TOKEN: "phs_project-secret" }),
  /public Project Token/
);
assert.throws(
  () => renderLandingPage(landing, {
    API_KEY_CASE_LP_POSTHOG_PROJECT_TOKEN: "phc_public-test-token",
    API_KEY_CASE_LP_POSTHOG_API_HOST: "https://evil.invalid"
  }),
  /approved US or EU capture host/
);

for (const name of ["index.html", "tokushoho.html", "terms.html"]) {
  assert.match(pages.get(name), /2,980/, `${name} price must be current`);
}
for (const name of ["index.html", "tokushoho.html", "terms.html", "refund.html"]) {
  assert.match(pages.get(name), /14日/, `${name} refund window must be current`);
}

const terms = pages.get("terms.html");
assert.match(terms, /Elastic License 2\.0/, "terms must identify the v0.9.1 source-code license");
assert.match(terms, /v0\.9\.0 には、その版に同梱された MIT ライセンス/, "terms must preserve v0.9.0 MIT rights");
assert.match(terms, /managed instruction block[^<]*標準 0BSD/, "terms must limit 0BSD to generated instructions");
assert.match(terms, /ソースコードライセンスとは別の層/, "terms must separate Pro sales from the source-code license");
assert.doesNotMatch(terms, /オープンソースライセンスとの関係/, "terms must not describe ELv2 as an open-source license");
assert.match(terms, /故意もしくは重大な過失/, "liability limit must preserve the intent/gross-negligence carve-out");
assert.match(terms, /生命もしくは身体/, "liability limit must preserve non-excludable personal-injury claims");
// 2026-09-11 legal review: the limitation must not read as a blanket
// third-party exemption, must stay a slight-negligence cap, and must keep the
// refund / non-conformity remedies out of the damages cap.
assert.match(terms, /本条の制限は、開発者の故意もしくは重大な過失/, "the carve-outs must reach the whole liability article, not only the cap");
assert.match(terms, /開発者に責めに帰すべき事由がない限り、開発者は責任を負いません/, "third-party causes may be excluded only without developer fault");
assert.match(terms, /外部サービス等を経由して生じたことだけを理由に免責されず/, "a product defect must not be escaped as a third-party cause");
assert.match(terms, /軽過失（重大な過失に至らない過失）/, "the partial limitation must state that it applies to slight negligence only");
assert.doesNotMatch(terms, /秘密情報の再発行費用、データ復旧費用または代替サービス費用を含みません/, "direct re-issue/recovery costs must not be excluded by name");
assert.match(terms, /直接かつ通常の損害に当たり合理的な範囲である限り、本項により除外されません/, "reasonable direct re-issue/recovery costs stay inside the cap");
assert.match(terms, /返金ポリシーに基づく返金、ならびに Pro が提供されない場合または契約内容に適合しない場合/, "refund and non-conformity rights must be separated from the damages cap");
assert.equal(terms.split("一切責任を負").length - 1, 0, "terms must not add a blanket no-liability clause");
// Consent model: Free use rides on the bundled license and privacy policy; an
// Agent launching the CLI is not the human's consent; Pro consent is at
// purchase/activation.
assert.doesNotMatch(terms, /本サービスを利用した時点で、本規約に同意/, "terms must not deem consent from mere software use");
assert.match(terms, /AI エージェント等が利用者の指示で本ソフトウェアを起動しただけでは、本規約への同意とは扱いません/, "terms must not treat an Agent launch as consent");
assert.match(terms, /Free 利用そのものは、ソースコードライセンスと<a href="privacy\.html">プライバシーポリシー<\/a>に従います/, "terms must scope Free software use to the license and privacy policy");
assert.match(terms, /購入手続を行い、または購入キーを有効化した時点で/, "terms must name purchase and activation as the Pro consent points");
assert.match(terms, /医療、生命維持、緊急対応/, "terms must define excluded high-stakes uses");

const privacy = pages.get("privacy.html");
assert.match(privacy, /license activate/, "privacy must describe license activation traffic");
assert.match(privacy, /公式CLIへの配置/, "privacy must distinguish deploy traffic from activation traffic");
assert.match(privacy, /購入キーの SHA-256 ダイジェスト/, "privacy must describe purchase-key rate limiting");
assert.match(privacy, /PostHog/, "privacy must disclose the usage analytics provider");
assert.match(privacy, /cli_command_result/, "privacy must disclose the CLI usage event");
assert.match(privacy, /telemetry disable/, "privacy must disclose the CLI telemetry opt-out");
assert.match(privacy, /CLIのテレメトリ設定は初期状態で有効です/, "privacy must disclose the CLI telemetry default");
assert.match(privacy, /DO_NOT_TRACK=1/, "privacy must disclose the CLI DNT override");
assert.match(privacy, /LPには製品内のopt-out設定はありません/, "privacy must distinguish the LP from the CLI opt-out");
assert.match(privacy, /秘密値やスキャン内容を開発者またはPostHogへ送信しません/, "privacy must preserve the telemetry secret-content boundary");
assert.match(privacy, /deploy時は保存済みの秘密値を対象プラットフォームの公式CLIへ渡します/, "privacy must disclose the intentional deploy handoff");
assert.match(privacy, /送信時の接続元 IP アドレスは通信上 PostHog に到達します/, "privacy must not imply that no IP address reaches PostHog");
assert.match(privacy, /開発者が設定する PostHog のプロジェクト設定/, "privacy must defer IP storage/geo/retention to the project settings rather than assert them");
assert.match(privacy, /PostHog の米国リージョン/, "privacy must name the analytics region the CLI is compiled for");
assert.match(privacy, /記録上の販売者（Merchant of Record）として、決済・注文情報を購入者から直接取得/, "privacy must describe Lemon Squeezy as a direct collector");
assert.match(privacy, /<strong>PostHog：<\/strong>[^<]*開発者の委託先として/, "privacy must describe PostHog's processor role");

// index.html is the Agent-first landing page (docs/landing-page/PAGE_SPEC.md).
// PAGE_SPEC §4 keeps setup in Hero and moves its review action to Proof.
// Each prompt keeps identical wording across its own placements.
const countOf = (needle) => landing.split(needle).length - 1;
const proCard = landing.match(/<article class="price-card price-card--pro" id="purchase">[\s\S]*?<\/article>/)?.[0];
const priceSection = landing.match(/<section class="section" id="price"[\s\S]*?<\/section>/)?.[0];
const purchaseNote = priceSection?.match(/<p class="purchase-note">[\s\S]*?<\/p>/)?.[0];
assert.ok(proCard, "the Pro pricing card must remain present");
assert.ok(purchaseNote, "purchase conditions must have a note below the pricing cards");
assert.match(proCard, /保存済みの値を、各サービスへ配置するところまで任せられます。/, "the Pro card must lead with its deployment value");
assert.doesNotMatch(proCard, /dry-run/, "the Pro card must not promote dry-run");
assert.match(proCard, /通常対応の配置は Windows 11 Build 22000以降＋Windows Hello が条件です/, "the Pro card must repeat the normal Windows condition before purchase");
assert.match(purchaseNote, /<strong>購入前に確認：<\/strong>/, "purchase conditions must use the small purchase-check note");
assert.match(purchaseNote, /通常対応の配置はWindows 11 Build 22000以降＋Windows Helloが条件です。/, "the purchase note must preserve the Windows condition");
assert.match(purchaseNote, /Linuxは診断・状態確認・利用可能なOS保管庫への人間所有ターミナルからの保管まで/, "the purchase note must distinguish Linux free support from Agent-first deploy");
assert.equal(countOf(">セットアップ用プロンプトをコピー<"), 3, "the primary CTA must appear in HERO, setup and the final CTA with identical wording");
assert.equal(countOf(">AIに安全性をレビューさせる<"), 1, "the review CTA must appear only beside public evidence");
assert.equal(countOf("ChatGPT / Claudeに公開内容を確認してもらう"), 1, "the review microcopy must appear beside its sole CTA");
assert.doesNotMatch(landing, /Coding Agent用プロンプトをコピー|使って安全かAIに聞く|ChatGPT \/ Claude 等に貼って、自分でレビューする/, "the landing page must not retain an old CTA string");
assert.match(landing, /<b>確認する<\/b><span>専用画面で、重要な操作を承認<\/span>/, "the third step must be framed as confirmation");
assert.doesNotMatch(landing, />決める</, "the old third-step label must not remain");
assert.equal(countOf('id="prompt-agent"'), 1, "the Coding Agent prompt must have a single source of truth");
assert.equal(countOf('id="prompt-review"'), 1, "the review prompt must have a single source of truth");
for (const target of [...landing.matchAll(/data-prompt-target="([^"]+)"/g)].map((match) => match[1])) {
  assert.match(landing, new RegExp(`id="${target}"`), `CTA references a missing prompt source: ${target}`);
}
for (const statusId of [...landing.matchAll(/data-prompt-status="([^"]+)"/g)].map((match) => match[1])) {
  assert.match(landing, new RegExp(`id="${statusId}"[^>]*role="status"[^>]*aria-live="polite"`), `CTA status region must announce: ${statusId}`);
}

// Measurement attributes. Every CTA on the page is measured, and every value a
// payload can carry is source-controlled here rather than read from a label.
const promptButtons = [...landing.matchAll(/<button\b[^>]*>/g)]
  .map((match) => match[0])
  .filter((tag) => tag.includes("data-prompt-target="));
assert.equal(promptButtons.length, 4, "every prompt CTA must be a measured button");
for (const button of promptButtons) {
  assert.match(button, /data-lp-action="(?:setup-prompt|review-prompt)"/, "every prompt CTA must declare its measured action");
  assert.match(button, /data-lp-location="(?:hero|two|proof|final)"/, "every prompt CTA must declare a closed location value");
}
// Counted on the markup only: the inline script names the same attributes in
// its selectors.
const landingMarkup = landing.replace(/<script[\s\S]*?<\/script>/gi, "");
const countInMarkup = (needle) => landingMarkup.split(needle).length - 1;
assert.equal(countInMarkup('data-lp-action="setup-prompt"'), 3, "the setup prompt CTA must be measured in all three placements");
assert.equal(countInMarkup('data-lp-action="review-prompt"'), 1, "the sole review prompt CTA must be measured");
assert.equal(countInMarkup('data-lp-action="checkout"'), 1, "the checkout link must be measured exactly once");
assert.equal(countInMarkup('id="pro-checkout"'), 1, "the checkout link must keep its stable id");
assert.equal(countInMarkup('id="purchase"'), 1, "the purchase section anchor is the CLI/MCP purchase link target and must stay");
assert.match(landing, /class="purchase-terms">[^<]*<a href="terms\.html">利用規約<\/a>と<a href="refund\.html">返金ポリシー<\/a>に同意したものとします/, "the Terms and refund links must sit beside the checkout button");
assert.ok(countInMarkup('data-lp-action="github"') >= 1, "repository links must be measured");
for (const [location, count] of [["hero", 1], ["two", 1], ["proof", 1], ["final", 1]]) {
  assert.equal(countInMarkup(`data-lp-location="${location}"`), count, `${location} must measure its intended CTAs`);
}
const heroSection = landing.match(/<section class="hero"[\s\S]*?<\/section>/)[0];
const securitySection = landing.match(/<section[^>]*id="security"[\s\S]*?<\/section>/)[0];
const proofSection = securitySection.slice(securitySection.indexOf('id="proof"'));
assert.doesNotMatch(heroSection, /data-lp-action="review-prompt"/, "Hero must focus on setup");
assert.match(proofSection, /data-lp-action="review-prompt"/, "Proof must offer the trust review");

// Copy boundaries the page must not cross (MESSAGING §6).
assert.doesNotMatch(landing, /中身は全部見られ/, "the landing page must not claim the whole repository is public");
assert.match(landing, /"license": "https:\/\/www\.elastic\.co\/licensing\/elastic-license"/, "JSON-LD must identify the ELv2 license URL");
assert.match(landing, /Elastic License 2\.0（ELv2）/, "the proof section must identify the current source license");
assert.match(landing, /生成instruction限定の0BSD/, "the proof section must scope the generated-output license");
assert.doesNotMatch(proofSection, /開発用の内部メモは公開していません/, "the public-source proof must omit the internal-note disclosure");
assert.doesNotMatch(landing, /MITライセンス/, "the current landing page must not present the product as MIT-licensed");
assert.doesNotMatch(landing, /状態だけ/, "the boundary must be stated as the Secret value, not as status-only");
assert.match(landing, /秘密値そのものは、AIに渡しません。/, "the hero must keep the safety distinction line");
assert.match(landing, /「AIに渡さない」のは、API Key Case自身の経路（CLI・MCP・入力\/確認画面）についてです/, "the limits must scope the boundary claim to the product's own paths");
assert.doesNotMatch(landing, /作者/, "user-facing trust copy must refer to the developer, not the author");
assert.doesNotMatch(landing, /production だけ手で止める|production など、人間|production を完全自動/, "user-facing copy must say 本番環境 rather than production");
assert.match(landing, /本番環境（production）への配置/, "the Agent prompt may retain the technical environment name with a Japanese explanation");
assert.equal(countOf("対応済みの外部配置先: Cloudflare / Vercel / GitHub"), 1, "the pricing copy must identify the three services as external destinations");
assert.match(securitySection, /配置時はCloudflare \/ Vercel \/ GitHubの公式CLIへ渡します/, "security copy must identify the actual handoff and the three destinations");
assert.equal(countOf("GitGuardianの調査では、2025年のGitHub公開コミットから、コードに埋め込まれた新しい認証情報（Secret）が約2,865万件検出されました。検出件数は前年比34%増です。"), 1, "the landing page must include exactly one market-evidence statement");
assert.equal(countOf("https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026/"), 1, "the market evidence must link once to GitGuardian's official 2026 source");

// The announcement's opening is the sole Hero headline; EV stays an illustration.
assert.match(heroSection, /<h1>APIキーの設定も、<br>Agentに任せたい。<br><span class="hero-last-line">でも、<span class="marker">値は渡したくない。<\/span><\/span><\/h1>/);
assert.doesNotMatch(landing, /hero-hook|AIに実装を任せる。|考えなくていい。/, "the old headline and extra hook must not compete");
const sectionOffset = (id) => landing.indexOf(`id="${id}"`);
assert.ok(sectionOffset("three") < sectionOffset("ev") && sectionOffset("ev") < sectionOffset("security"), "the video must connect the three steps to security");
assert.ok(sectionOffset("security") < sectionOffset("proof") && sectionOffset("proof") < sectionOffset("price"), "security must lead through public evidence into pricing");
assert.match(landing, /id="ev-title">「GitHubにAPIキーを設定して。」<\/h2>/, "the video heading must introduce a concrete request");
for (const id of ["bound", "two", "mech", "limit"]) {
  assert.equal(countOf(`id="${id}"`), 0, `${id} must no longer split the story into a separate section`);
}
assert.doesNotMatch(landing, /ev-steps|AIに貼るものは、2種類あります。/);
assert.match(landing, /href="#setup">無料セットアップへ/, "Free pricing must lead to setup");
assert.match(securitySection, /外部コンテンツの悪意ある指示/, "the human boundary must have a concrete reason");
assert.match(securitySection, /チャットのYes \/ Noやボタン操作だけで承認せず、Windows Helloの本人確認が成功した場合だけ/, "a button or chat answer must not substitute for Windows verification");
assert.match(securitySection, /承認後も送り先や実行するCLIを再確認し、変更があれば停止/);
assert.match(securitySection, /完全な安全は保証しません/);
assert.match(securitySection, /製品コードの改変/);
assert.match(securitySection, /macOSは協力検証版です。実装とCIのKeychain連携は確認済み/);
assert.match(securitySection, /Linuxは診断・状態確認・履歴と、利用できるOS保管庫への人間所有ターミナルからの保管を維持/);
assert.match(securitySection, /操作はAgentに任せても、重要な判断までAgent自身には任せません/);
assert.match(securitySection, /自動で配置できるのは、確認済みの同じ送り先へのVercel preview/);
const reviewPrompt = landing.match(/id="prompt-review"[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
assert.match(reviewPrompt, /0\.9\.1に対応する公開ソースが取得できるか確認/);
assert.match(reviewPrompt, /未確認としてください/);
assert.match(reviewPrompt, /公開資料だけを読み/);
assert.match(reviewPrompt, /人間の承認として扱わないでください/);
assert.match(landing, /同じプロジェクトの同じキー名には、開発用と本番用の別々の値を同時に保存できません/);
assert.match(landing, /Cloudflareへの配置では、設定ファイルと同じ場所に実際の/);
assert.match(landing, /ローカルアプリへの値の注入は行いません/);
for (const asset of ["favicon.ico", "brand/favicon.svg", "brand/mark.svg", "brand/logo.svg", "brand/apple-touch-icon.png", "brand/og-image.png"]) {
  assert.equal(existsSync(resolve(repoDir, asset)), true, `${asset} must be committed beside the pages`);
}
for (const media of ["launch-ja.mp4", "launch-ja-poster.jpg", "launch-ja.vtt"]) {
  assert.equal(countOf(`"${media}"`), 1, `the landing page must reference ${media} exactly once`);
  assert.equal(existsSync(resolve(repoDir, media)), true, `${media} must be committed beside the page`);
}
const announcementVideo = landing.match(/<video\b[^>]*>/)?.[0];
assert.ok(announcementVideo, "the EV section must embed the announcement video");
for (const attribute of ["controls", "playsinline", 'preload="metadata"', 'poster="launch-ja-poster.jpg"', 'width="1080"', 'height="1920"']) {
  assert.ok(announcementVideo.includes(attribute), `the announcement video must declare ${attribute}`);
}
assert.doesNotMatch(announcementVideo, /\b(?:autoplay|loop|muted)\b/, "the announcement must be played deliberately, not autoplayed or looped");
assert.match(announcementVideo, /aria-label="[^"]*操作イメージ[^"]*"/, "the video's accessible name must say it is an illustration");
assert.equal(countOf("<video"), 1, "the landing page must embed exactly one video");
assert.match(landing, /<source src="launch-ja\.mp4" type="video\/mp4">/, "the video source must be the committed announcement");
assert.match(landing, /<track kind="captions" src="launch-ja\.vtt" srclang="ja" label="日本語">/, "the video must offer its Japanese captions");
assert.equal(countOf("図解による操作イメージ（実機の録画ではありません）"), 1, "the EV copy must state once that the video is an illustration, not a recording");
assert.match(landing, /GitHubへの配置はPro、Windows 11とWindows Helloの環境が前提です。/, "the EV copy must keep the video's Pro and Windows conditions");
assert.doesNotMatch(landingMarkup.replace(/<!--[\s\S]*?-->/g, ""), />28 seconds<|28秒|動画の最後にある/, "EV must omit duration promotion and redundant CTA explanations");
for (const forbidden of ["実機の録画です", "本当に進みます", "初の", "唯一の", "世界で最も"]) {
  assert.equal(landing.includes(forbidden), false, `the EV copy must not overclaim: ${forbidden}`);
}
assert.match(readFileSync(resolve(repoDir, "launch-ja.vtt"), "utf8"), /^WEBVTT\r?\n/, "the committed captions must be WebVTT");

// PAGE_SPEC §8 publish gate. The page no longer protects itself by being a
// separate file, so the gate lives in the publish script. Both assertions below
// are meant to fail the day someone flips LANDING_PAGE_PUBLISH_GATE_MET, so the
// decision to publish these claims is made deliberately and not as a side effect.
assert.doesNotThrow(() => checkLandingPage(landing), "the landing page must pass its publish checks");
assert.throws(() => checkLandingPage(landing + "<p>npx api-key-case scan</p>"), /must not teach CLI usage/);
assert.throws(() => checkLandingPage('<textarea id="unrelated">npx api-key-case scan</textarea>'), /must not teach CLI usage/);
assert.throws(() => deploy(), /PAGE_SPEC\.md §8/, "production deployment must stay refused while AC-1..AC-4 are unmet");
assert.match(applyPublishGate(landing), /<meta name="robots" content="noindex, nofollow">/, "a gated Preview build must be staged noindex");

for (const source of editorialSources) {
  assert.match(source, /APIキーの設定も、Agentに任せたい。/, "the LP copy source must record the hero hook shared with the announcement video");
  assert.match(source, /貼る \/ 入れる \/ 確認する/, "the LP copy source must use the revised three-step wording");
  assert.match(source, /セットアップ用プロンプトをコピー/, "the LP copy source must preserve the primary CTA");
  assert.match(source, /AIに安全性をレビューさせる/, "the LP copy source must preserve the review CTA");
  assert.match(source, /GitGuardian, State of Secrets Sprawl 2026/, "the LP copy source must preserve the official evidence attribution");
}

assert.equal(existsSync(resolve(repoDir, "CHANGELOG.md")), true, "public release notes must exist");
assert.match(readFileSync(resolve(repoDir, "CHANGELOG.md"), "utf8"), new RegExp(`## \\[${manifest.version.replaceAll(".", "\\.")}\\]`), "changelog must include the package version");
assert.match(readme, new RegExp(`v${manifest.version.replaceAll(".", "\\.")}`), "English README must name the package version");
assert.match(readmeJa, new RegExp(`v${manifest.version.replaceAll(".", "\\.")}`), "Japanese README must name the package version");
assert.doesNotMatch(readme, /Alpha software/, "English README must not retain the old alpha label");
assert.doesNotMatch(readmeJa, /アルファ版/, "Japanese README must not retain the old alpha label");
assert.match(readme, /https:\/\/www\.npmjs\.com\/package\/api-key-case/, "English README must link to npm");
assert.match(readmeJa, /https:\/\/www\.npmjs\.com\/package\/api-key-case/, "Japanese README must link to npm");
assert.equal(manifest.author?.name, "Melavern", "package author must use the public product identity");
assert.equal(manifest.author?.email, "dev@melavern.com", "package author must expose the reviewed support contact");
assert.equal(manifest.license, "Elastic-2.0", "package metadata must identify the product license");
assert.equal(manifest.files.includes("CHANGELOG.md"), true, "npm package must include the changelog");
assert.equal(manifest.files.includes("LICENSES/0BSD.txt"), true, "npm package must include the generated-output license");

const disclosure = pages.get("tokushoho.html");
assert.match(disclosure, /請求があれば遅滞なく開示します/, "commercial disclosure must provide a delayed-disclosure commitment");
assert.doesNotMatch(disclosure, /最終確認画面で商品、価格、税、支払方法および返金条件/, "commercial disclosure must not claim the checkout screen shows refund conditions");
assert.match(disclosure, /<a href="refund\.html">返金ポリシー<\/a>で返金条件と動作環境/, "commercial disclosure must route refund conditions to this site");
assert.match(disclosure, /特商法に基づく表示の開示請求/, "commercial disclosure must provide a concrete request route");
assert.match(disclosure, /Sold through Link, LLC/, "commercial disclosure must identify the Merchant of Record entity");
assert.match(disclosure, /mailto:dev@melavern\.com/, "commercial disclosure must provide a private email route");

for (const name of pageNames) {
  assert.match(pages.get(name), /dev@melavern\.com/, `${name} must expose the private contact address`);
}

console.log("site content tests passed");
