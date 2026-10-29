# Common provider acquisition and reuse

Private candidate, 2026-10-07. This extends the existing credential lifecycle and
fixed input panel; it is not a release capability or native acceptance result.
There is no application-specific feature, command, domain, model, config path,
consumer shim or generic execution framework.

## Current implementation

The same `connection credential guide|save|check|remove --service <profile>
--env <environment> [--json] [project]` entry supports closed credential profiles:

- `resend`: RESEND_API_KEY, development / preview / production
- `clerk`: CLERK_SECRET_KEY, development / preview / production, with the existing
  Windows-only mutation boundary unchanged
- `openai`: OPENAI_API_KEY, development / preview / production
- `stripe-test`: STRIPE_API_KEY, development / preview only in this initial scope

`stripe-test` identifies Stripe's **test secret key (sk_test_)** profile, not all
Stripe credentials. Provider test/live mode and application deployment environment
are separate facts. A preview application may use a test-mode provider. The absence
of production in this candidate is a bounded implementation choice, not a rule
that test keys are inherently tied to development. Live, publishable, restricted
and webhook signing keys are not supported by this input profile. No live-mode
profile is inferred or added.

All profiles use the existing v2 project/environment OS-store namespace and
`ConnectionStateStore` registration revision/lock protocol. New files are only
closed registration metadata for the new profile names; no new registry/database,
secret field or value-derived digest is added. Older Resend/Clerk account names
and metadata are unchanged. `connection inventory` report schema 2 enumerates
eleven fixed slots. Stored schemas are unchanged; `next` schema 13 adds the closed `review-provider-credential` continuation action.

The new read-only `guide` returns exact-slot presence, settled/pending metadata,
revision, fixed provider guidance and a registration-only operation plan. A fresh
Agent or terminal reconstructs this from the existing OS store and metadata. A
positive exact-slot result is not key validity, provider identity, permission,
remote configuration or application health. `stored` does not ask for input again.

The guide also makes at most three exact boolean probes: the selected v2 slot and the
same name in legacy project/user slots. A legacy registration is a candidate for
human scope review, never an automatic copy, migration, deployment fallback or
reason to type the key again. Pending/unavailable/corrupt/changed metadata stops
input guidance. Successful OS storage with missing metadata remains visible as
registered but needing review. Reads do not use `isAvailable`, which writes a
probe entry; no dialog, process, network request or metadata write runs.

## One human input surface

Windows guides for Resend, Clerk, OpenAI and Stripe test use the existing native secure input surface with
fixed official links, explicit project/environment, required account selection,
credential purpose, least-privilege guidance and the next Agent action. Caller
URLs, commands and arbitrary instructions cannot be inserted into the panel.
Resend's optional domain/destination display comes only from its matching existing
managed intent. No application-specific account, domain or model is embedded.

OpenAI asks the human to select the appropriate project, needed API endpoints and
models. It does not require unrelated models-list permissions for a write-only
application. A future verification result of 403 must distinguish a verification
scope problem from invalid credentials and must never automatically request
broader permissions or a replacement key. This candidate makes **no OpenAI API
probe**, including an apparently read-only probe.

Stripe test prefix/format checks happen inside the native helper before the OS
write. Values never return to the parent. This syntactic check cannot establish
account, sandbox, permissions or server-side test mode. A future consumer must
independently enforce provider test mode before side effects. Resend and legacy
input behavior are preserved.

The input operation ends at OS storage plus closed local registration metadata.
It cannot chain into an application, remote key installation, webhook creation,
resource change, test payment, mail send or deployment. Windows structured-guide visual, keyboard and synthetic real OS-store acceptance
at 100%/150% is recorded in [VERIFICATION](../VERIFICATION.md); 100% real Copy and
other release checks remain separate. macOS native acceptance remains pending. Linux remains
handoff-only; there is no pseudo-TTY or Agent-terminal fallback.

### Structured Windows guide (2026-10-08)

The selected subdued-green B presentation now uses one layout for all four
existing Windows credential profiles. Product-owned bilingual sections describe
the official link, account/instance, key operation, suggested name, permissions,
additional setup and warnings. Optional supplementary details may collapse;
required settings and warnings never collapse. Existing CLI/macOS consumers
receive a linear projection of the same data. Clerk macOS mutation remains
unsupported, and its legacy generated dialog is unchanged.

One TableLayoutPanel separates identity, a vertically scrolling guide and a
fixed secure-input/footer area. Rows measure their text and grow; there are no
provider-specific control coordinates. Long Japanese paths and uninterrupted
metadata wrap. Work-area bounds and GetDpiForWindow determine size, pixel fonts
and scale; monitor movement refits the same form. High-contrast mode keeps OS
colors. The recommended identifier and an available sending domain each have
their own Copy action and feedback; displayed metadata is not repeated in prose.
Only validated non-secret metadata reaches the clipboard.

connection credential save --purpose <purpose> accepts a closed advisory set:
Resend email-sending; OpenAI text-generation, embeddings or image-generation;
Stripe test test-payments. Clerk has no purpose flag. Invalid, duplicate,
cross-provider and non-save values fail before a vault operation. Existing
matching Resend intent supplies domain/destination. The selected app environment
and canonical project stay explicit. These selections are labeled for human
confirmation; they do not establish provider identity, exact endpoint/model
permissions, verification, consent, entitlement or deployment authority. Purpose
is display-only and not persisted or used as continuation evidence.

Provider URLs, actions, permissions and warnings come only from the Product
catalog. There is no caller URL, free-form Agent instruction, permission claim,
new provider, automatic acquisition or settings engine. Clerk distinguishes its
app Secret Key from Publishable/webhook/machine API keys and asks the human
to confirm the instance separately from app environment. Official references:
[Clerk keys](https://clerk.com/docs/guides/development/clerk-environment-variables),
[Clerk key selection](https://clerk.com/docs/guides/secure/rotate-api-keys),
[Resend permissions](https://resend.com/docs/dashboard/api-keys/introduction),
[OpenAI permissions](https://help.openai.com/en/articles/8867743-assign-api-key-permissions)
and [Stripe key types](https://docs.stripe.com/keys), checked 2026-10-08.

Save still writes directly inside the native helper to the OS store and returns
only a closed status. Input clearing, size/Stripe-format refusal, existing
Windows Hello approval/removal, allowlists and provider execution gates remain
intact. Hidden-console startup now explicitly shows the input form before
initial focus; native testing exposed this existing startup defect. No after-save
action, provider request, application launch or release is added.

Actual Windows observations and reproduction commands belong in
[VERIFICATION](../VERIFICATION.md). They do not promote provider execution,
other OSes or the public npm release.

## Separate storage, transfer, configuration and evidence

OpenAI/Stripe test now have a bounded [hosted placement candidate](provider-hosted-deployment.md)
for the existing managed Cloudflare/Vercel route. Selection, offline preview and
continuation work; real execution remains source-gated pending native acceptance.
Provider and application checks remain unsupported/unverified. New slots are
rejected by legacy deployment and cannot enter the Resend-only local launcher.
Existing Resend/Clerk routes retain their selection, entitlement, trust and approval checks.

A compatible future consumer contract must bind the selected project, service,
provider mode, application environment, declared purpose and exact receiver to
one bounded operation. Its private input must not use caller argv, exported env,
plaintext files, generic URLs/commands or a secret-returning callback. Receiver
identity and dependency/configuration assumptions must be checked before reading
the OS-store value, inside the existing value-bearing handoff boundary. Same-user
application execution is not isolation from that application or the same OS user.

The displayed plan must include all intended effects and consent must cover them.
Installation, resource creation, app execution and deployment are distinct actions,
not implicit after-save hooks. Results must be closed status/receipt data without
stdout, raw exception text, screenshots or value-derived identifiers. Unknown
results prohibit automatic retry. Stored success, transfer receipt, remote
configuration and application verification must remain separate states.

The hosted placement candidate implements only that bounded receiver contract,
with its native execution gate still closed; it does not authorize a live consumer. There
is no arbitrary `exec`, injectable adapter or application-specific shim.

### Cloudflare effect audit

The existing Cloudflare adapter uses `wrangler secret put NAME` for the default
configuration (its API Key Case environment label is production) and appends
`--env development|preview` for named environments. Its plan and native approval
now explicitly state that `secret put` creates a Worker version and deploys it
immediately. It is never a no-deploy installation step. Existing Clerk
`versions secret put` preparation retains its separate version/Version-URL
exposure language and is not broadened by this candidate.

Some applications instead keep separate top-level config files whose Worker
names contain a staging suffix. That naming does not create an `env.staging`
selector and must not be silently mapped to a named environment. A custom config
receiver is unsupported until its exact standard contract is reviewed. Existing
Wrangler authentication may be reused only through the already authorized and
qualified path; do not mint a redundant token or bypass an unqualified executor.

## Official evidence checked 2026-10-07

- OpenAI: https://help.openai.com/en/articles/8867743-assign-api-key-permissions
  and https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform
- OpenAI API-key entry: https://platform.openai.com/api-keys
- Resend: https://resend.com/docs/create-an-api-key
  and https://resend.com/docs/dashboard/domains/introduction
- Stripe: https://docs.stripe.com/keys and https://dashboard.stripe.com/test/apikeys
- Cloudflare: https://developers.cloudflare.com/workers/configuration/secrets/
  and https://developers.cloudflare.com/workers/wrangler/environments/

The provider guidance is advisory. It is not proof of a user's current account,
project, permission or domain settings. No provider account was contacted in tests.

## Normal next continuation

After its final awaited diagnostic, `next` reads only existing registration
metadata for the five new profile/environment slots. Any recorded, pending or
unavailable slot returns `review-provider-credential` with its profile and
recorded environments, including in offline mode. It suppresses legacy v1
register/remove advice for that profile's name. It does not read a new key,
claim it exists or select an environment. The same `guide` verifies presence
and supplies the next safe action. Legacy facts remain separately visible;
v1 missing is not a request to duplicate a recorded v2 key.
