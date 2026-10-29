# Cloudflare managed connection guide

Status: private development candidate for `roadmap:native-acquisition`. The
post-selection guide remains unchanged. The 2026-10-08 preselection extension
below follows the separate structured-input implementation.
It does not complete automatic acquisition, enable provider execution, or change
roadmap state/order, native acceptance gates or public release claims.

## Before selection: static Cloudflare options (2026-10-08)

```
api-key-case connection cloudflare options --service <resend|clerk|openai|stripe-test> --env <development|preview|production> [--json]
```

Use this only when a Cloudflare setup is proposed and its route has not yet been
selected. It returns the existing managed route, fixed official provider and
Workers secrets guides, and the fixed setting name. Resend, Clerk and OpenAI
support all three application environments; Stripe test supports development
and preview only, for eleven closed combinations. Unknown services/environments,
Stripe production, duplicate flags, project paths and arbitrary URLs/operations
are rejected without echoing caller values.

The pure catalog reads no project, selector, saved intent, OS store, provider
session or receipt. Existing or corrupt state cannot change its answer. It
cannot establish eligibility, a linked Worker, prior registration, authentication
or a working application. JSON and text are projections of the same fixed data;
`placementEffect`/`placementGuidance` explain the existing operation's consequences
without providing an executable plan. Every result keeps selection, provider
account, destination authentication, credential presence/validity, configuration
and application `not-checked`, human selection `required`, permission `none` and
executed `false`.

Cloudflare destination authorization is distinct from acquiring a Resend, Clerk,
OpenAI or Stripe key. The candidate explicitly says native acquisition is not
supported by this command; it does not assert that no Cloudflare-native option
could exist. Existing saved choices go to the post-selection guide/inventory
instead of repeated route selection or key creation. Vercel's already-implemented
Resend/Clerk `connection native options` remains separate and unchanged. Neither
candidate permits switching destinations, setting intent, granting permissions,
opening a browser, input, storage, placement or application execution.

The four credential profiles and all execution gates are unchanged. In
particular, `stripe-test` accepts only `sk_test_` as an existing compatibility
boundary. Current Stripe guidance recommends restricted keys for new integrations;
`rk_test_` is not supported by this profile. The candidate does not recommend
broader permissions or replacement issuance to fit its supported key type. A
prefix alone does not identify a provider or validate a credential. Stripe mode
and application environment remain separate facts. OpenAI guidance follows the
intended project's required API/model permissions and adds no models-list probe.

Official primary sources rechecked 2026-10-08:

- [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/):
  `wrangler secret put` creates and immediately deploys a Worker version;
  `wrangler versions secret put` creates a version without deploying it.
  Neither is a read-only step. The existing Clerk preparation keeps activation
  separate and retains its existing exposure/approval contract.
- [Wrangler login](https://developers.cloudflare.com/workers/wrangler/commands/general/#login):
  Cloudflare account OAuth authorization is not acquisition of another service's
  application credential. This command never invokes login or requests its scopes.
- [Resend keys](https://resend.com/docs/dashboard/api-keys/introduction) and
  [creation guide](https://resend.com/docs/create-an-api-key): sending access and
  a domain restriction can narrow email-only use; domain verification is separate.
- [Clerk environment variables](https://clerk.com/docs/guides/development/clerk-environment-variables):
  distinguish the backend secret, frontend publishable and webhook signing keys;
  confirm the actual instance rather than deriving it from an app environment label.
- [OpenAI permissions](https://help.openai.com/en/articles/8867743-assign-api-key-permissions):
  choose only the project/workload permissions needed. The separation of model
  requests from list-models permissions is described in
  [OpenAI RBAC](https://developers.openai.com/api/docs/guides/rbac).
- [Stripe keys](https://docs.stripe.com/keys): test, live, publishable and restricted
  keys are different; restricted keys are recommended for new integrations.
  `STRIPE_API_KEY` is this Product's fixed binding name.

`tests/cloudflare-options.mjs` covers all eleven Cloudflare and six existing
Vercel preselection combinations, deterministic repeat calls, absent/corrupt
project state, fixed URLs, structured effects, malformed/duplicate/unknown
arguments and canary non-disclosure. Its actual built CLI harness denies
project/home reads, keyring access/native loading, subprocesses, network and filesystem
mutations, including attempted effects caught by the CLI. Existing native,
Cloudflare and provider-hosted guide suites cover post-selection compatibility.
Synthetic checks do not assert provider, browser, Windows or macOS acceptance.

Validation checkpoint (2026-10-08, dot Linux / Node 24.19.0): `npm ci
--ignore-scripts` restored the lockfile's non-optional dependency versions;
`npm run build` passed for CLI/core and the license worker. The new options suite
passed 74 checks; existing native acquisition passed 113 checks, Cloudflare
acquisition 54 checks, and provider-hosted guides 36 synthetic cases. `git diff
--check` passed. The first new-harness attempt rejected the CLI's existing eager
keyring import; the corrected test substitutes a throwing keyring entry and
blocks native loading rather than changing the Product's keyring behavior.
The full npm suite, other Node/OS versions, native dialogs, live provider actions
and deployment were not run. Private branch/Draft PR validation is not main
integration or public-release acceptance.

## User-facing entry

```
api-key-case connection cloudflare guide --service <resend|clerk|openai|stripe-test> --env <development|preview|production> [--json] [path]
```

Generated private Agent instructions point to this command using the service and
environment already restored by `next --json --offline`. A fresh chat reuses the
captured current CLI and saved selection without asking for the same choice or
key again. This instruction does not promote local selection into remote health.

The user sees the saved service/environment, explicit Cloudflare account and
Worker, local project identity, fixed required secret name, and a fixed official
Workers secrets guide. These are local selection facts, not authentication,
ownership, current remote configuration or credential validity evidence.

The command reuses `ConnectionStateStore` and the existing bounded
`resolveClerkWorkerDestination` metadata reader, without broadening its rules:
one regular bounded Wrangler configuration; explicit account and Worker name;
root selection for production and an explicit named environment for development
or preview. No implicit root fallback is added. Intent and destination are read
again before returning so a changed selection produces no usable handoff.

Only the existing `api-key-case-managed` Cloudflare selections for Resend, Clerk,
OpenAI and Stripe test are supported; Stripe test excludes production. The
OpenAI/Stripe hosted guide does not remove its existing execution gates. A native, manual, different destination/environment, malformed, unsafe
or absent selection is not silently converted to managed placement. No state is
saved by the guide. Repeating it or ignoring the URL cannot create permission or
acquisition progress. Unknown CLI flags and duplicate options are rejected.

## Acquisition and connection-state limits

Cloudflare destination authentication must not be represented as Resend/Clerk
credential acquisition. This implementation does not provide a Cloudflare-native
provider integration, and does not claim that no such integration could exist.
It preserves the current managed-secret placement contract instead of pretending
Vercel's integration inspector works on Cloudflare.

`selection-confirmed` means only the saved intent and local Wrangler selector
match. The JSON output separately declares authentication, remote configuration
and credential presence `not-inspected`, validity and application `not-checked`,
permission `none`, and executed `false`. It never returns `connected`, `ready`,
`integration-managed` or a successful application result from local configuration.

The guide points to existing `next --json` and `history --json --offline` in the
same project for their existing status/history semantics. It does not call them,
read the vault, resolve/run Wrangler, open a browser, probe a network, refresh a
receipt, or introduce a remote inspector. Ordinary `next` remains unchanged and
network-free. Historical results do not prove current remote state or authorize
retries. Clerk Worker version preparation remains distinct from activation and
protected-access observation; Resend placement remains distinct from delivery.

## Official evidence and consequential steps

Official primary sources were retrieved on 2026-10-06 UTC:

- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
  distinguishes immediate deployment by `wrangler secret put` from version-only
  creation by `wrangler versions secret put`. Dashboard submission may deploy.
  The fixed link is reference material, not instruction or consent to run those
  operations. No secret file/export route in that documentation is adopted.
- [Wrangler login](https://developers.cloudflare.com/workers/wrangler/commands/general/#login)
  creates an OAuth grant. Existing destination login is separate from service
  credentials. This guide neither runs login nor chooses scopes, persistence,
  accounts or resources. Current documentation is not authority to upgrade the
  pinned/inspected CLI or broaden its permitted operations.

All existing Human Plane, entitlement, secret non-return, overwrite, production,
and destination trust gates remain intact. No login, new credential entry or
transmission, permission grant, deployment, activation or billing action was
performed by this development work.

## Verification and next boundary

The dedicated offline suite exercises Resend and Clerk across all three
environments and TOML/JSON/JSONC configuration formats; wrong route, destination
and environment; absent/malformed/oversized/duplicate/symlink/hardlink selectors;
locked intent state; changed selection; repeated reads; fixed URLs and canary
non-disclosure. Actual CLI tests deny child processes, HTTP(S), sockets, TLS and
fetch, and compare fixture contents before/after. The suite is included in
`npm test`; the existing Human Plane and provider adapters are unchanged.

This unit is intentionally a guide with local metadata confirmation, not a new
remote connection-status feature. A future metadata inspector or credential
acquisition path must define the specific supported operation and authentication
boundary before implementation. It cannot infer readiness from this result.
