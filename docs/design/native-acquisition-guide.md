# Vercel native connection guide

Status: private development candidate for `roadmap:native-acquisition`. The human
selected the existing Vercel integration guide and state-checking unit on
2026-10-06 UTC, explicitly excluding live connection and permission grants. This
narrows the first proposal without adopting its separate local OAuth architecture.
The implementation focuses on native acquisition after structured input. The
2026-10-08 continuity acceptance below adds synthetic coverage of existing
contracts, not automatic issuance, live acceptance or roadmap completion.

## Entry and boundary

From the selected project, run:

```
api-key-case connection native guide --service <resend|clerk> --env <development|preview|production> [--json] [path]
```

This is a local-only projection of the saved native intent, the existing bounded
`.vercel/project.json` selector and existing advisory observations. It does not
run a provider command, resolve a CLI, open a browser, read a vault, save state,
refresh a receipt, log in, connect a provider or grant permission. `--open`,
`--url`, `--record` and arbitrary operation flags are not accepted. Closing a
terminal, ignoring a link, browser failure or rerunning the guide cannot leave
an approval or acquisition-progress record: none is written.

Generated private Agent instructions point to the guide before asking the human
to search for setup steps. This changes no `next` schema or runtime inspection.

Only Resend and Clerk with a saved provider-native Vercel intent are supported.
The requested service/environment must match. A missing/malformed/unsafe selector,
unavailable intent, wrong route or a change during reading produces no usable
handoff. A different project cannot reuse the original project's receipt.
No unsupported case falls back to vault input or changes the saved route.

### Before selection: read-only official route options (2026-10-08 candidate)

The Agent can now ask what documented provider-native path exists **before**
a Resend/Clerk/Vercel selection has been recorded:

```
api-key-case connection native options --service <resend|clerk> --env <development|preview|production> [--json]
```

This is a closed, deterministic provider-owned lookup, with a fixed official
guide URL and expected setting names. For Resend it also shows the separate,
conditional 2026 Vercel Marketplace alternative with a **domain purchased
through Vercel** prerequisite and human review of plan, billing and domain
authorization. The prerequisite is displayed, not checked by this lookup.
The earlier Resend dashboard/Vercel integration is retained as a distinct
official path; the Product does not silently switch routes. It does **not** read
a project, OS store,
provider session or observation; it cannot tell whether the Vercel project is
linked or the provider account is eligible. All candidate values are explicitly
`not-checked`, `humanSelection: required`, `permission: none`, `executed: false`.
Unknown services, arbitrary URLs/flags and project paths are rejected. For
Resend, choose one of the two existing Vercel enrollment methods explicitly on
the existing `connection set` operation:

```
api-key-case connection set --service resend --env <environment> --route provider-native --destination vercel \
  --native-enrollment <resend-vercel-integration|resend-vercel-marketplace> <project>
```

This records only the human-selected route label. It does not prove account
eligibility, billing consent, domain ownership, provider connection or
permission. A later `connection native guide` restores the matching official
URL. For the selected Marketplace method, guide text and JSON state the
`domain-purchased-through-vercel` prerequisite and mark domain eligibility as
`unverified`. Selecting the method does not prove the prerequisite is met.
Other methods, Clerk and existing v1 selections do not receive this condition;
v1 remains `unrecorded`, and the guide never infers a method from
inspection/history.
Options, guide and `next` remain read-only. No automatic switch, authorization,
key material, provisioning, generic execution or status promotion is added.

Research for other official alternatives lives in
the 2026-10-08 provider-route evidence (maintainer-only evidence; omitted from the public tree).
The route candidates are intentionally limited to the two already-supported
Vercel native integrations rather than claiming that an account-tool MCP grants
an app-runtime credential.

## Fixed handoff

URLs are internal constants, never supplied by an Agent, state file or provider
response. The human sees the exact Vercel organization/project IDs, local project
identity, selected environment and required setting names. These local IDs are
selection facts, not proof of the signed-in account or resource ownership.

Official primary sources were rechecked on 2026-10-06 UTC:

- [Resend Vercel integration](https://resend.com/blog/vercel-integration): the
  provider creates a domain-linked key and places it in chosen Vercel projects.
  The guide narrows the human selection to one explicit project, never all
  projects. Inspect the actual environment afterward; do not infer its mapping.
- [Clerk Marketplace guide](https://clerk.com/docs/guides/development/integrations/platforms/vercel-marketplace):
  provisioning, plan choice and team-membership/role synchronization are material
  human decisions. Existing standalone Clerk applications cannot migrate into
  this integration. Development/preview map to Clerk development, production
  maps to Clerk production. Both setting names must be attributed to the same
  integration in the existing inspector. The guide does not recommend the
  documentation's plaintext `vercel env pull` path.

The output explains these consequences without executing the steps or treating
the guide itself as consent. It does not provide authorization URLs containing
session material, tokens, provider errors or response bodies.

## Recorded state and explicit inspection

The guide reuses the existing native evidence reader's exact intent revision,
destination fingerprint, timestamp, expiry and journal-integrity checks. It
preserves the distinction between:

- `human-needed`: no inspection, absent configuration, or existing unmanaged
  configuration. This is a request to review, never an instruction to reinstall
  or overwrite automatically.
- `integration-managed`: an applicable unexpired record reports integration
  management. It is still historical configuration evidence, not current health,
  provider identity, credential validity or permission.
- `partial`: the recorded configuration was incomplete.
- `unknown`: stale, changed, unavailable or unverifiable evidence.
- `unsupported`: no matching saved native route for the requested service/env.

An absent record is not evidence that settings are missing. For an `absent`
configuration result, all fixed required setting names are shown as missing.
Existing receipts store aggregate configuration only; for `partial`, individual
missing names are unknown (`missingSettings: null`) and the guide lists the
required names to review. It must not invent a per-setting finding or widen the
journal schema. The existing inspector's immediate Clerk result has individual
presence states when available.

The human/Agent may separately request the already-existing bounded inspection:

```
api-key-case connection native inspect --service <resend|clerk> --env <environment> --json [path]
```

That is the explicit network boundary and requires the existing inspected Vercel
CLI/session contract (59.11.7). This guide does not install/login/upgrade it.
Inspection alone does not persist; use its existing `--record --max-age-seconds`
options explicitly when an advisory receipt is wanted. The guide does not choose
a retention interval. Application observations remain separate; this projection
always says application and credential validity are not checked. Ordinary
`next`/plan behavior and their network contracts are unchanged.

## Verification and scope separation

`tests/native-acquisition.mjs` covers both providers in all three environments,
matching and mismatched intent/project/route, fixed URLs, repeated read-only
resumption, the five configuration states, expiry, unsafe or changed selectors,
unavailable metadata, cross-project receipts, Clerk attribution mismatch,
provider-value/error canaries and strict actual-CLI arguments. A preload rejects
child processes, browser launch and network entrypoints while the guide runs.
The suite is wired into `npm test` without editing the earlier aggregate test file.

The only existing reader change exposes its already-validated non-secret selector
IDs alongside the unchanged fingerprint; native inspection/observation regression
suites cover compatibility. No UI renderer, native input/consent transport,
credential lifecycle, provider API, vault, release gate or package version changes.

Validation results for the candidate are recorded in its pull request. Synthetic
tests do not claim live Vercel/Resend/Clerk, browser consent or native UI acceptance.

## Fresh-process native route continuity (2026-10-08)

`tests/native-continuity.mjs` connects the existing public CLI steps for Resend
and Clerk in development, preview and production. Each invocation is a fresh
Node process with a synthetic local project and home. A new Agent can recover
from the same saved metadata without an in-memory session, a provider login,
a copied secret or a previous Agent's authority.

The sequence is:

1. `connection native options` leaves the fixture unselected and unchanged.
   A guide before selection has no usable handoff.
2. The real `connection set` CLI records an explicitly supplied synthetic
   provider-native/Vercel selection. It remains advisory local intent.
3. The real guide and `next --json --offline` recover the exact service and
   environment, local linked-project identity and missing inspection state.
4. A test-only recorder passes a synthetic provider-shaped response through
   the existing closed parser and journal API. This deliberately does **not**
   call or claim to test the live `connection native inspect` transport.
5. The real `observe-application` CLI records only a synthetic human report of
   the named feature. A later process restores `human-reported` authority,
   inspection binding, feature, outcome and lifetime. No app is executed.
6. Reinspection with only different raw values retains the same configuration
   fingerprint and does not renew the earlier app report. A superseded receipt
   cannot be used for a new observation.
7. Expiry, a configuration metadata change, a different environment and a changed
   linked destination recover the appropriate review step. Historical success
   remains visible as history, never current health, permission or safe retry.
8. Coexisting Resend and Clerk selections reject each other's valid fixture
   receipt IDs. Unknown and failed app reports preserve their own service,
   human authority and remaining work without contaminating the other profile.

The fixture includes actual source references to the selected setting names.
Offline `next` may retain legacy-v1 existence facts as already documented;
those probes receive only a test keyring value and must not become duplicate
registration advice for the provider-native route. All real native keyring
loading/access, provider/network calls, app execution and child processes are
blocked inside the tested CLI invocations. Read phases also reject writes and
compare project/home contents before and after. Only the explicitly designated
synthetic selection/receipt phases may change fixture metadata. Canary values
are checked against stdout, stderr and persisted journal content.

The restored reports continue to separate selected intent, recorded destination
configuration and caller-reported app behavior. Credential validity and provider
identity stay unverified; current health stays unverified and permission stays
none. Generic readiness is not promoted to ready. No runtime, provider, native
input, approval, vault schema or public command contract is changed by this
acceptance suite. This remains a bounded part of `native-acquisition`; live
provider handoff and execution acceptance are separate work.

Resend `state.json` retains strict schema 1 for existing route-only selections.
An explicit `--native-enrollment` choice writes strict schema 2 with one of the
two closed Resend/Vercel methods. New readers preserve v1 data without
rewriting it and never infer a method from an inspection/history receipt.
Schema-2 unknown fields and methods fail closed. The method participates in the
intent revision/fingerprint; changing it invalidates intent-bound inspection
and app observations. Repeating the same choice is byte-stable. Existing
connection-resume history carries the validated method so a fresh process can
restore it with the environment and route. Earlier private binaries that only
understand schema 1 fail closed on schema 2 and must not edit that project
state.

Portable fixtures cover both methods, strict v1/v2 parsing, unknown and
cross-route rejection, fresh-process recovery, stale receipt binding, read-only
guide/options and secret canaries. They do not claim live provider acceptance,
account eligibility, domain/billing authorization, browser consent or app
execution.

Validation checkpoint (2026-10-08, dot Linux / Node 24.19.0): CLI/core and license
worker build passed using the existing lockfile-matching restored dependencies.
The final continuity suite passed 136 fresh-process checks, including all six
service/environment flows plus coexisting-profile isolation. The existing native
observation suite passed 126 checks and acquisition suite passed 113 checks.
`git diff --check` and the new test syntax check passed. Read-only phases left fixture state unchanged;
raw values were absent from output and journal data. The initial harness was
corrected to permit read-only file-open flags and use the existing text-only
connection-set interface; no Product behavior needed changing. Full npm test,
other Node/OS versions, live provider inspection, native input and application
execution were not run. GitHub CI and review remain separate from these local
synthetic results; this checkpoint does not mark native-acquisition complete.
