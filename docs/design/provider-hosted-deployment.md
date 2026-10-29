# Bounded provider hosted placement

Private candidate, 2026-10-07. OpenAI and Stripe test registrations can now be
selected, remembered, previewed and bound to the existing guarded hosted deploy
engine. Real execution remains source-gated pending new-provider Windows
acceptance. Existing accepted Resend and Clerk execution is unchanged. This is
not a public 0.9.2 capability or functional application acceptance.

## Closed selections and requests

- OpenAI: `openai`, `OPENAI_API_KEY`, development / preview / production.
- Stripe test: `stripe-test`, `STRIPE_API_KEY`, development / preview only.
- Both require `api-key-case-managed` with `vercel` or `cloudflare` and no sending
  domain. Native, manual, GitHub and local routes are unsupported for these
  profiles. Clerk keeps its separate version-preparation operation.
- The only source is the exact existing v2 project × service × application
  environment × name slot and its settled registration revision. No v1/user
  fallback, copying, export or migration occurs.

`connection set`, `credential guide`, `inventory`, `target plan|apply`,
`cloudflare guide`, `next` and `resume plan|apply` use these closed profiles.
Resume requires the explicit service, application environment and managed route.
Target apply changes only the reviewed local non-secret selector. Neither guide,
target plan, resume nor inventory runs a provider or deploy operation.

`connection deploy --service <openai|stripe-test> --env <environment> --dry-run`
requires Pro, just like execution. Its offline request preview shows exact
source/destination environment, name, force, overwrite and remove-first effects,
provider mode, native acceptance state and a machine-readable `placementEffect`.
It probes no provider, writes no history/trust and grants `permission: none`.
The existing Resend application-oriented `connection plan` and application
observation APIs remain scoped to Resend; they are not generalized by placement.

## Effects and native boundary

Cloudflare uses the existing fixed `wrangler secret put NAME [--env ENV]` argv.
This creates a Worker version **and immediately deploys it**. Preview JSON/text
and native approval identify that effect. This matches the [official Cloudflare
secret documentation](https://developers.cloudflare.com/workers/configuration/secrets/#adding-secrets-to-your-project),
checked 2026-10-07; `versions secret put` has a different activation contract.
The default/top-level config is
production; development/preview requires the matching named environment with
its own explicit account ID and Worker name. A root field or a Worker name's
suffix never supplies a missing environment. Ambiguous/custom config paths and
new versions-based modes are not added on that default-config route. The
owner-requested [explicit config destination extension](cloudflare-config-destinations.md)
adds a separately gated repository allowlist selected by ID, with exact
account/Worker/config/source/target-environment binding and approval every time.

Vercel uses the existing fixed `env add` stdin route. Its existing `--force`
remove-first step and development sensitive-option behavior stay visible. All
Cloudflare, production, force and Vercel-development operations still require
native approval for every operation. Only the existing exact Vercel preview
non-force class can reuse confirmed matching destination trust. First use or a
changed destination requires new consent.

The source constant `PROVIDER_HOSTED_NATIVE_ACCEPTED = false` guards both the
outer entrypoint and innermost handoff. It is not a CLI option, environment flag,
metadata field or stored receipt. Windows-only execution remains an additional
check. New-provider acceptance cannot be inherited from Resend or manufactured
by old successful history. Windows production consent requires the existing
HWND-bound OS verification and `Verified` result.

## Binding, handoff and Stripe mode

Execution reuses `runConnectionDeploy`, `runDeployEngine`, the existing snapshot,
trust, native approval and durable history machinery. Current invocation checks
bind project, service, exact registration revision, intent identity/fingerprint,
selector, provider account, official CLI and argv across awaited boundaries,
before each pre-step, before value read, before spawn and before completion.
A durable unknown attempt must precede destructive/value-bearing effects.

Only `deploy/handoff.ts` retains the value. It reconstructs official argv and a
sanitized child environment; no caller executable, argv, environment map,
callback getter, shell, pseudo-TTY, custom URL, plaintext file or export is added.
Provider stdout/stderr and raw errors do not cross the status boundary.

Stripe provider test/live mode is separate from application environment. The
inner value-bearing boundary independently rejects values that are not a
non-whitespace `sk_test_` secret-key form before sending stdin to the CLI. It
returns only a closed changed status, with no raw value, prefix, length or
value-derived identifier. This local check does not authenticate the account,
sandbox or permissions; no Stripe API verification or test payment is added.
Stripe mode validation precedes every destructive pre-step as well as the
value-bearing spawn. Early reads retain the same current-basis checks and
finally-discard boundary. Durable unknown history and possible-effects warnings
remain conservative. There is never an automatic retry.

OpenAI gets no models-list or other API probe. Restricted permissions are not
escalated to satisfy a probe. Neither service gains provider validity or an
application check: registration, placement, remote configuration and working
application evidence remain distinct, and application health remains unverified.

## State and compatibility

Two closed active intent files (`provider-openai.json`,
`provider-stripe-test.json`) use the existing schema-1 metadata and locking
mechanics. Existing schema-1 intent history gains `provider-openai` and
`provider-stripe-test` profiles; the closed valid profile/environment set is
bounded. Existing deployment journal schema 2 gains the two exact service/name
pairs, while Clerk preparation retains schema 3. No registry/database or stored
approval token is added. Historical v1 and v2 receipts remain distinct.

Registered Cloudflare destinations additionally use journal schema 4 to retain
their closed nonsecret target identity. See the extension contract.

Older readers reject an unknown profile/service in mixed history as unavailable,
rather than ignoring entries, rewriting state or falling back to v1. New active
files do not alias Resend/Clerk active files. Existing Resend/Clerk data and
behavior remain readable. Use this same compatible private CLI for continuation;
public npm 0.9.2 is not a fallback. Historical completion never proves current
remote values, application health, entitlement or approval.

Acceptance checklist (maintainer-only evidence; omitted from the public tree) and
synthetic verification (maintainer-only evidence; omitted from the public tree) are separate from
live/native evidence.
