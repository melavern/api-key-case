# Resend credential acquisition handoff

Status: the private development guide uses the selected project × Resend ×
environment managed slot. Public npm 0.9.2 is unchanged. Provider/application
readiness and the bounded local attempt history remain separate. Their closed
design is [external-connection-vertical-slice.md](external-connection-vertical-slice.md).

## Scope and choice

The human request of 2026-09-30 authorizes one real service's credential
acquisition → Human Plane storage → refreshed Agent status. Resend is the AI's
implementation choice: it has a single conventional `RESEND_API_KEY`, a direct
official dashboard issuance flow, and the existing scanner recognizes its
Node.js environment-variable reference. No Resend adapter, SDK, CLI, MCP tool,
generic provider registry or new vault operation is added.

A canonical `RESEND_API_KEY` scan reference or declaration is a candidate for
asking which target/environment/route the human intends. It never selects one
or authorizes key acquisition. A validated saved Resend intent remains visible
even without scanner coverage. Only selected managed Vercel/Cloudflare/GitHub
operations and the existing bounded local development operation have an
acquisition guide. Provider-native, manual and unsupported local environments
have no vault acquisition guide. No values select the guide.

## Official evidence (checked 2026-09-30)

- [Create an API key](https://resend.com/docs/create-an-api-key): the human opens
  the API keys page, chooses Create API Key, a name, permissions and an optional
  sending-domain restriction. Sending access is the documented choice for
  sending-only use. Broader API use needs the human's own permission decision.
  The new value is displayed once.
- [API keys dashboard](https://resend.com/api-keys): the official direct entry,
  redirecting unauthenticated visitors to Resend login. Login/account creation
  remains the human's task.
- [Manage API keys](https://resend.com/docs/dashboard/api-keys/introduction):
  existing key values cannot be viewed after creation. A usable existing key may
  be saved directly; this flow never creates replacements automatically.
- [Node.js quickstart](https://resend.com/docs/send-with-nodejs): identifies
  `RESEND_API_KEY` and domain prerequisites. This product uses the OS store and
  Human Plane instead of following the quickstart's `.env` storage example.

These are acquisition instructions, not proof of the account's permissions,
domain verification, key validity, or delivery. Recheck official evidence before
changing this flow; runtime status does not fetch external pages.

## Closed status and flow

`next --json` remains schema 7 with the existing closed guide shape.
`guidedSetup.registration` now describes only the selected managed environment
slot in the containing `connection.report`, at project scope. Its status comes
from exact-slot presence plus the existing non-secret registration metadata.
Pending, locked, temporary, invalid or changed metadata is unavailable, never
missing. A positive presence with no settled revision remains unverified for
provider/execution purposes and never requests key re-entry. No stored metadata
file, value or provider output is returned.

`secrets` retains explicit legacy v1 facts. Those entries never satisfy another
environment's v2 slot. Overall counts and storage stage use the selected managed
slot plus unrelated legacy requirements; native Resend needs no vault copy.
Before selection, Resend acquisition and registration are suppressed in favor
of the explicit target selection action. Zero active storage requirements does
not mean the app needs no external credentials.

Before requesting a Resend save, `nextActions` asks the Agent to review the
route/environment/destination when no intent exists. The human chooses these
values; the Agent records them with the fixed-enum `connection set` command.
That command writes advisory metadata only. The `provider-native` route never
requests duplicate API Key Case storage, and `manual` never claims configuration
is complete. Only a supported `api-key-case-managed` selection continues through the existing
`connection credential save --service resend --env <selected-environment>` Human
Plane flow in this project, using the same verified private built CLI. No route selection or metadata write grants permission.

| Stage | Meaning and next action |
| --- | --- |
| `review-exposure` | Existing exposure diagnosis takes priority. Resolve it before acquisition. |
| `prepare-storage` | Exact-slot presence or registration metadata is unavailable/pending/locked. Preserve evidence and review it; this is not missing and must not trigger key issuance or overwrite. |
| `human-handoff` | Selected environment slot is missing and supported Human Plane input is unavailable here. Explain the host limitation; no legacy-slot, chat or Agent-terminal fallback. |
| `acquire-and-save` | Selected environment slot is genuinely missing on a host with supported input. Explain purpose and exact official links, open its existing `connection credential save` Human Plane in the same project before issuance, then let the human issue/copy the key directly into that dialog. Stop acquisition if input cannot open. Helper readiness remains conditional on an interactive desktop. |
| `stored` | Existence was confirmed only in the selected project/environment v2 slot. Skip issuance/save and resume non-secret development; this does not prove provider/app health or retry permission. |

`agent-init` persists these instructions in the already supported host file;
its stdout protocol has the same guidance. It explains account/login,
permission choice, one-time copy, cancellation, existing entries, unsupported
input, and the distinction between storage and working external functionality.
The Agent waits/polls the same synchronous Human Plane invocation, then refreshes
`next` after completion. Cancellation/failure stops the group. It never controls
the human's credential page, clipboard, or dialog and never receives the value.

No acquisition progress journal is introduced. A fresh chat reruns status with
the same private CLI and saved selection. Exact-slot presence restores stored
without duplicate human input, even when v1 is absent or scanning misses the
name. v1-only, user-scope legacy and a different environment do not satisfy the
selected target. Cancellation leaves the existing pending metadata unverified,
not a prompt to issue another key. Read-time selection/registration changes stop
input guidance. The connection snapshot and rechecks run after the final awaited
target readiness/trust diagnostic, before synchronous guide/action construction;
a selection or pending-registration change during that diagnostic cannot leave
old acquisition advice in the response. Nothing copies, migrates or deletes a legacy entry.

Generic local planning remains unsupported. For selected managed development
local storage, use the separate local status/inspect operations; a session lock,
unknown lifecycle or unavailable history suppresses input guidance and retains
the existing review requirement. Past reports never become current health,
generic ready, or permission to run/send/retry. An old unbound receipt is still
historical. Offline next omits the acquisition guide and immediate input/check
actions and retains its no-execution contract.

The existing environment-specific Human Plane, native helper, credential supply,
Pro and fresh approval boundaries are unchanged. This guide performs no API
request, email send or app launch. No public LP/README positioning, package
version or release is changed.

## Verification

`tests/agent-setup.mjs --selected-guidance-only` covers unselected and exact-slot
missing → one synthetic Human Plane save → stored without v1 → fresh status,
duplicate-save prevention, wrong environment/project/user legacy, unavailable
store, pending/cancelled/locked/temp/changed metadata, unrelated diagnostics,
provider-native without vault storage, unsupported local environments and
unknown/old local history. Actual regular CLI code runs in an owned copy with a
fake keyring and denied provider/child operations, followed by new-chat generated
instructions and a separate-process offline resume. Only synthetic input is
used. This is not new native GUI, provider or real-delivery acceptance.

The MCP Registry publication work `keycase-260930-0310-0e67` was rechecked and
integrated into the internal repository on 2026-10-01. Its receipts are in
`docs/RELEASING.md` and `docs/VERIFICATION.md`. It records the public 0.9.2
Registry card and does not mean this unpublished schema 4 candidate was
released.

## Resend acquisition panel candidate — 2026-10-07

Status: private draft implementation; native Windows/macOS rendering and link
activation are not accepted yet. Roadmap `guided-acquisition` remains in progress.

The existing v2 Resend input dialog now combines the exact project/environment
storage destination, a fixed `https://resend.com/api-keys` link, account-selection
instruction, an environment-specific key name, Sending access permission,
sending-domain choice, the secure input and the Agent's next work. The guide
uses the [official creation flow](https://resend.com/docs/create-an-api-key)
checked on 2026-10-06 UTC. This bounded sending profile does not need Full access.
No account is inferred as authorized: the human must select the account owning
the app's sending domain. A missing domain is shown as a decision still needed;
the panel does not silently recommend All Domains.

`connection credential save` supplies display-only domain and destination from
a validated managed intent only when the service and environment match the slot
being saved. Other slots, provider-native routes and absent intents never borrow
that context. Direct v2 saves still show the bounded Resend guide without
asserting a selected destination. Legacy v1 and Clerk input remain unchanged.
The optional display context cannot provide URLs, commands, permissions or values.

Windows uses an OS-selected Japanese/English guide, explicit fonts and thread
Per-Monitor V2 DPI awareness. Controls below the guide follow measured control
bounds; a window that cannot fit exits unavailable. macOS retains an NSAlert
and secure field with a fixed attributed provider link. Browser navigation is a
human action and does not read, scrape or send the field content.

Save still means OS-store registration only. It returns only status, finishes the
existing credential mutation, and does not run verification, deploy, a local app,
OAuth or credential issuance. The panel explains that the Agent can resume the
existing status/check/setup flow, while separate approvals and feature evidence
remain required. The save handler, cancellation, OS-store API and isolated helper
transport are retained. No live provider or release operation is part of this
candidate.

Before integration: run the synthetic input path on Windows and macOS, activate
the fixed link, verify keyboard navigation/cancellation/storage failure and
confirm all essential content fits at the required display scales. Linux cannot
establish that evidence. Scope this review to the acquisition input surface;
The separate preparation flow owns the separate Clerk preparation approval presentation.

## Common provider candidate — 2026-10-07

The independent candidate builds on the fixed input panel and adds OpenAI and
Stripe test-secret registration, guide and inventory reuse through the existing
credential lifecycle. Resend guidance remains generic. See
[common provider acquisition](provider-credential-acquisition.md) and
the combined native acceptance (maintainer-only evidence; omitted from the public tree).
The new profiles have no supported consumer transfer/provider check; native
acceptance remains pending and public claims/version are unchanged.
