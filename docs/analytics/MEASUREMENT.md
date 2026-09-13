# API Key Case — Usage measurement

Status: Implemented v0.9.1 measurement contract. This document describes the
events currently sent and the decisions the data is allowed to support.

The LP side of the contract moved with the landing page on 2026-08-31, when the
Agent-first page became `index.html`. The transport, the payload allowlist and
the privacy guardrails are unchanged; only the events that the page can emit
follow its calls to action:

- `lp_demo_play` is retired. The old demo was replaced by the launch illustration; new video events below distinguish it from the old demo. It is not in the page's event allowlist.
- `lp_free_start` keeps its funnel meaning — the free first action — but its
  trigger is now the setup-prompt copy instead of a quick-start command copy.
- `lp_review_prompt_copy` is new. It is the page's second call to action and
  would otherwise be unmeasured.
- `location` gained the two extra CTA placements the page has.
- `lp_pricing_view` is new. It marks whether a visitor reached the pricing
  section at all, so a low `lp_checkout_click` rate can be told apart from a
  low pricing-reach rate. `sourceBucket()` also classifies `t.co` as `x`,
  since link-shortened shares from X arrive with that host as the referrer.

## Business outcome

The first business question is not "how many events can we collect?" It is:

> After a visitor understands the boundary between a secret value and safe
> execution context, can they start the free CLI, adopt OS-backed storage, and
> decide whether Pro deployment is worth purchasing?

The minimum observable path is:

`Acquisition → LP → free-start intent → scan → save → Pro intent → purchase → license activation → deploy`

The source of truth for a purchase is Lemon Squeezy. A checkout click is an
intent proxy, and a successful license activation is product activation; neither
is a purchase event.

## Funnel and interpretation

| Stage | Signal | Classification | What it can answer | What it cannot answer |
| --- | --- | --- | --- | --- |
| LP reach | `lp_view` | direct, aggregate | Did the page receive traffic? | Who the visitor is or whether they are a prospect |
| Pricing reach | `lp_pricing_view` | direct, aggregate | Did a visitor scroll far enough to see pricing? | Whether they read it, understood it, or intended to buy |
| Independent verification | `lp_review_prompt_copy` | proxy, aggregate | Did a visitor take the "have your own AI review it" path? | Whether a review happened or what it concluded |
| Free start | `lp_free_start` | proxy, aggregate | Did a visitor try to copy the setup prompt for their Coding Agent? | Whether the prompt was pasted or acted on |
| Free use | `cli_command_result(command=scan,outcome=success)` | direct, aggregate | Did a CLI scan complete? | Whether it came from this LP or what the project contained |
| Deeper adoption | `cli_command_result(command=save,outcome=success)` | direct, aggregate | Did a save complete? | Which secret was saved or to which project |
| Pro intent | `lp_checkout_click` | proxy, aggregate | Did a visitor select the checkout? | Whether checkout completed |
| Purchase | Lemon Squeezy order data | external, aggregate | How many purchases completed/refunded | Which anonymous event came from the buyer |
| Activation | `cli_command_result(command=license_activate,outcome=success)` | direct, aggregate | Did a purchased user activate locally? | Whether the source purchase can be linked to this event |
| Deployment | `cli_command_result(command=deploy,outcome=success,target=...)` | direct, aggregate | Did Pro deployment complete by target? | Which secret, repository, account, or purchase was involved |

These are period-level comparisons, not a person-level funnel. The LP uses a
page-lifetime anonymous ID and the CLI uses a separately generated installation
ID. They are intentionally never joined. A high or low ratio is a signal for a
product decision, not proof of causality or a conversion rate for the same
users.

## Event definitions

### LP events

The landing page sends only these explicit custom events. No automatic pageview,
autocapture, session replay, heatmap, form capture, or performance event is part
of this contract.

| Event | Trigger | Allowed properties |
| --- | --- | --- |
| `lp_view` | Once per page load | `device_bucket`, `source_bucket` |
| `lp_pricing_view` | Once per page load, when the pricing heading (`#price-title`) crosses 50% visible in the viewport | none |
| `lp_free_start` | Each deliberate setup-prompt copy attempt | `location`, `copy_result` |
| `lp_review_prompt_copy` | Each deliberate review-prompt copy attempt | `location`, `copy_result` |
| `lp_github_click` | Click on the primary product repository link | none |
| `lp_checkout_click` | Click that opens the Lemon Squeezy checkout | none |
| `lp_os_support_click` | LP link to OS support or contributor conditions | `location` |
| `lp_macos_apply_click` | LP link to the existing Tally application form | `location` |
| `lp_video_start` | First native `playing` event per page load | fixed `video_id: launch_ja` |
| `lp_video_progress` | Unique played ranges reach 25/50/75% of duration, once each per page load | fixed `video_id`, `percent` (25, 50, 75) |
| `lp_video_complete` | First native `ended` after playback starts | fixed `video_id` |

The two new link events use only `hero`, `proof`, `pricing`, `footer` as locations.
They do not capture form submissions or OS detail page activity. Application clicks
are intent, not completed applications. Video progress uses native `played` ranges,
so seeking over content does not count as watching it and replays do not double count.
Completion means reaching the end, including seeking; it is not proof of watching
all content. No current time, duration, media URL, errors, or user input is sent.
Pause/resume never adds another start; reloading creates a fresh anonymous ID.

For analysis, filter `product=api_key_case`, `surface=lp`. Compare `lp_view` to
successful `lp_free_start`, application intent by placement, and video starts to
25/50/75% reach. Same-page IDs can compare video engagement with subsequent copy
intent, but do not identify visitors across pages, visits, CLI use or purchases.

`lp_pricing_view` exists only to separate two failure modes that
`lp_checkout_click` alone cannot distinguish: visitors who never scrolled far
enough to see pricing, and visitors who saw pricing but did not click
checkout. It uses a single one-shot `IntersectionObserver` at a 50% threshold on the
section's own heading — not the whole `#price` section, which is taller than
the viewport on mobile and would rarely or never cross that ratio there — and
is not a scroll-depth or per-section tracker, nor extended to other sections. It is not a CTA and is not counted as intent; `lp_checkout_click`
remains the only Pro-intent signal, and it is still only an intent proxy, not
a purchase. Likewise, `lp_macos_apply_click` stays an application-intent
signal, not a completed application.

Every LP event also carries the fixed properties `product: "api_key_case"`
and `surface: "lp"`. They are source-controlled constants and are never
derived from visitor input.

LP property values are closed values:

- `device_bucket`: `mobile` or `desktop`.
- `source_bucket`: `direct`, `x`, `github`, `search`, or `other`. It is derived
  locally from a small host/category allowlist (`x` includes `x.com`,
  `twitter.com`, and the `t.co` link shortener); the raw referrer, path,
  query, fragment, and arbitrary campaign value are not sent. No campaign
  parameter (e.g. UTM) is parsed or added by this change.
- `location`: `hero`, `two`, `proof`, or `final` — the placement of the CTA that was
  used. Setup appears in Hero, below the three steps and in the final CTA;
  review appears only beside the public sources within Security (`proof`).
  `two` is retained as the historical identifier for the middle setup CTA;
  the former two-prompt section was removed on 2026-09-12. It is a
  source-controlled closed value, not a selector, URL, text label, or DOM
  value: the page carries it in `data-lp-location` and the script drops
  anything outside the closed set.
- `copy_result`: `success` or `failure`.

The event payload is built from an allowlist. The page may use a random
page-lifetime `distinct_id` to satisfy PostHog's event format, but it does not
write it to cookies, localStorage, sessionStorage, IndexedDB, or any other
persistent store. It never calls `identify`, `alias`, `group`, or person-property
APIs.

### CLI event

The CLI uses one event name for the initial release:

`cli_command_result`

It is emitted only for `scan`, `save`, `license_activate`, and `deploy` after
the local command result is known. The product properties are allowlisted:

| Property | Allowed values |
| --- | --- |
| `command` | `scan`, `save`, `license_activate`, `deploy` |
| `outcome` | `success`, `failure`, `cancelled`, `blocked` |
| `error_category` | Optional closed value: `invalid_input`, `non_interactive`, `dependency_unavailable`, `already_registered`, `not_registered`, `confirmation_declined`, `license_required`, `license_activation_failed`, `operation_failed`, `strict_findings`, `dry_run`, `timeout`, or `unexpected_error`; never derived from user text |
| `cli_version` | The package version shipped by API Key Case |
| `os_family` | `windows`, `macos`, `linux`, `other` |
| `target` | Only for `deploy`: `cloudflare`, `vercel`, or `github` |

The event contains no command arguments or operation context. In particular, it
does not contain a secret name, environment variable name, scan result, warning,
file name, path, repository/project information, Git data, account data,
license key, entitlement ID, order ID, email, hostname, OS username, hardware
fingerprint, or an IP address as a property.

Every CLI event also carries the fixed properties `product: "api_key_case"`
and `surface: "cli"`. They are source-controlled constants and are never
derived from command input.

The PostHog transport may include the provider's own protocol fields (including
the project token and an anonymous `distinct_id`) but those are not product
properties. Anonymous person-profile processing is disabled for the event.

### Configuration hooks

#### CLI distribution configuration

The CLI has a source-controlled public distribution configuration in
`packages/core/telemetry-config.ts`. It contains the PostHog region and the API
Key Case project token that are compiled into `dist/` and therefore shipped in
the npm package:

```ts
export const POSTHOG_PUBLIC_API_HOST = POSTHOG_PUBLIC_API_HOSTS.us;
export const POSTHOG_PUBLIC_PROJECT_TOKEN = "<configured public Project Token>";
```

The official v0.9.1 distribution is configured with the existing project's
public Project Token and the US project region
(`POSTHOG_PUBLIC_API_HOSTS.us`). When the PostHog project changes, update only
those source-controlled public distribution settings before publishing.
Do not infer the value from a key prefix; copy the Project Token field, not a
Personal API Key or Project Secret API Key. End users must not need to set an
environment variable. A non-empty
`API_KEY_CASE_POSTHOG_PROJECT_TOKEN` still overrides the distribution token for
development, tests, and maintainer troubleshooting.

PostHog's Project Token is the public event-ingestion credential. It is not a
Personal API Key and it is not a Project Secret API Key. Never put a Personal
API Key, Project Secret API Key, or any other secret credential in the source,
compiled `dist/`, npm tarball, LP, or deploy environment intended for the public
site. Capture events are not a security, licensing, or purchase source of truth;
the public token means a third party could theoretically submit forged events.

#### LP deployment configuration

The LP has a deployment-time hook immediately before its analytics script:

```html
<script>
  window.API_KEY_CASE_POSTHOG_CONFIG = {
    apiHost: "https://us.i.posthog.com",
    projectToken: "<API Key Case client project token>"
  };
</script>
```

The repository's `demo/publish-demo.mjs` Preview path injects that hook from
these deploy-only settings. It checks the process environment first, then the
repository-root `.env.local`, and ignores other `.env` files:

```sh
API_KEY_CASE_LP_POSTHOG_PROJECT_TOKEN=<API Key Case public Project Token>
API_KEY_CASE_LP_POSTHOG_API_HOST=https://us.i.posthog.com
node demo/publish-demo.mjs --preview
```

For repeated local Preview updates, put the same two lines in the ignored
repository-root `.env.local` once. Process environment variables still take
precedence, so a one-off PowerShell override can be used without editing the
file. The host must be exactly PostHog's US
(`https://us.i.posthog.com`) or EU (`https://eu.i.posthog.com`) capture host;
the page appends `/i/v0/e/`. If the token is absent, staging removes the marker
and produces a safe no-op page. If a token is present but the host or token
shape is invalid, staging fails before deployment. The hook is not a secret and
must contain only the public Project Token; never substitute a Personal API Key
or Project Secret API Key. The `--deploy` Production path remains separate and
does not read `.env.local`.

The public review build is deployed to the existing `api-key-case-lp` Pages
project with the fixed `preview` branch alias. Run
`node demo/publish-demo.mjs --preview` after setting the process variables or
the ignored `.env.local`; the command refuses to deploy the Preview when the
public token is missing. The Preview URL is obtained from the Wrangler
deployment output and is not inferred or hard-coded here. The `--deploy`
production path is separate and is not part of this review flow; while
`LANDING_PAGE_PUBLISH_GATE_MET` is false it is refused outright, and the
Preview build is staged with a noindex tag and a `Disallow: /` robots.txt
(docs/landing-page/PAGE_SPEC.md §8).

## Privacy and security guardrails

- The scanner core remains fully local and has no telemetry dependency or
  network call. CLI telemetry runs in a separate best-effort path only after
  the scan output/result is complete.
- Secret values remain inside the existing OS secret-store and deploy handoff
  boundaries. Telemetry never receives a vault value or a value-bearing result.
- The CLI installation ID is generated from cryptographically random data only.
  It is not derived from hostname, MAC address, OS account, repository,
  project, license, or hardware information. It lives only in the telemetry
  file, not the vault index or license file.
- The LP has no persistent identifier. The LP and CLI identifiers are never
  cross-linked, and no URL token or command tracking token is added.
- Telemetry is best-effort with a short timeout. A PostHog outage, DNS failure,
  offline machine, or timeout must not change command output, JSON, exit code,
  or the product operation.
- The default CLI setting is enabled, but the first eligible run with
  interactive stdin shows a one-time stderr notice before sending. A run
  without interactive stdin sends nothing while that notice has not yet been
  shown; later non-interactive runs may send after the notice. CI and
  `DO_NOT_TRACK=1` always override the saved setting.
- `api-key-case telemetry status` reports configured and effective state without
  printing the installation ID. `enable` and `disable` are persistent controls;
  disabling stops communication and deletes the installation ID, while a later
  enable starts with a new random ID.
- A missing PostHog project token is a safe no-op. The CLI production token is
  a public distribution setting, while the non-empty environment variable is
  only an override. The LP token is injected during site staging. No token is
  invented, logged, or treated as a secret credential.

## Decision rules

Use a fixed review period and compare aggregate counts in the same period.
Do not call these ratios user conversion rates.

| Observation | First decision to investigate |
| --- | --- |
| LP views high, free-start intent low | Clarify the first-view promise and the setup-prompt CTA; do not add more tracking first. |
| Free-start intent high, scan success low | Check command copy, npm availability, Node 20 expectations, and first-run friction. |
| Scan success high, save success low | Review the hidden-input explanation, OS-store availability guidance, and recovery path. |
| Checkout clicks high, Lemon purchases low | Inspect price/terms/checkout trust and Lemon checkout availability using Lemon as source of truth. |
| Purchases high, license activation success low | Review delivery email instructions, activation errors, endpoint availability, and version compatibility. |
| Activation success high, deploy success low | Break down only by the closed deploy target and inspect CLI installation/login, confirmation, and target-specific errors. |
| Telemetry delivery or coverage is low | Treat the data as incomplete; do not compensate by collecting secret/project context. |

Before changing the funnel, first verify the event contract and PostHog project
filters. If a stage is low, use documentation, support questions, and a small
human usability check to distinguish comprehension from environment or
third-party failure.

## External sources

- **npm:** distribution and quick-start execution are external to PostHog.
  Package downloads/runs are not silently attributed to an LP event.
- **GitHub:** repository traffic, stars, issues, and referrer information are
  separate aggregate signals. The repository link event does not identify a
  GitHub account.
- **Lemon Squeezy:** completed orders, refunds, and payment state are the
  purchase source of truth. `lp_checkout_click` and license activation are not
  purchase substitutes.
- **PostHog:** the API Key Case LP and CLI may use the same Product project for
  aggregate reporting, but their event taxonomies remain separate. Google
  Analytics and other analytics services are out of scope.

## Release review checklist

- [x] The public PostHog Project Token and its US/EU region are configured in
      `POSTHOG_PUBLIC_PROJECT_TOKEN` and `POSTHOG_PUBLIC_API_HOST` in
      `packages/core/telemetry-config.ts` for the v0.9.1 npm candidate.
- [x] The same public Project Token and region are supplied through the LP
      staging environment variables before the production site is deployed.
      Observed 2026-09-11: the Pages `preview` alias injects the CLI's token
      with the US host; the production site did not carry the hook yet.
      Done 2026-09-14: the production deployment injects the CLI's public
      Project Token with `https://us.i.posthog.com`.
- [ ] PostHog project settings do not re-enable autocapture, replay, heatmaps,
      automatic form capture, or person identification for this page.
      Observed 2026-09-11 from the project's public remote config: session
      replay off, heatmaps off, exception capture off, identified-only person
      profiles (the page and CLI also send `$process_person_profile: false`);
      the project-level autocapture flag is still on. It has no effect on this
      page, which never loads posthog-js, but switch it off before the deploy
      so the setting and the contract match.
- [x] Payload tests assert the actual object and the forbidden-property set.
- [x] Telemetry failure tests prove the original stdout, JSON, exit code, and
      operation remain unchanged.
- [x] The privacy and security pages describe the actual sender and data flow.
- [ ] Lemon Squeezy purchase/refund counts are reviewed separately from event
      counts before a launch decision.

### 2026-09-13 LP verification and release check

Transport contract checked against [PostHog Capture API](https://posthog.com/docs/api/capture)
and [provider privacy policy](https://posthog.com/privacy). Keep explicit allowlisted
anonymous events and the existing deployment-time public-token injection.
Run `node tests/lp-analytics.mjs`, `node tests/site-content.mjs`, and
`node tests/serve-site.mjs`. Browser QA must intercept ingestion requests with a
synthetic public token (no production analytics pollution), click current CTAs and
play/seek/replay the video. Verify one start, unique milestones and one completion.
After an authorized site deployment, verify the injected public token/US host,
then inspect Network and PostHog Live events for a deliberate test visit. A local
payload test or HTTP acceptance alone does not prove dashboard ingestion. Blockers,
network failure and page closure can lose events; analytics remain best effort.
