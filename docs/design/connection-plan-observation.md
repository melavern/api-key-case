# Closed destination plan and application observations

Status: plan/observation and recovery guidance are integrated for development, following accepted environment integration. Published 0.9.2 is unchanged.
This implements the secret-free unit in [vertical slice §22](external-connection-vertical-slice.md#223-small-next-implementation-task).
Environment functional acceptance is recorded separately; this unit does not complete the real application vertical slice.

## Commands and authority

- `connection plan --service resend --env <development|preview|production> --json [path]`
- `connection observe-application --service resend --env <environment> --plan <fingerprint> --outcome <passed|failed|unknown> --configuration <observed|unknown> --max-age-seconds <1..86400> --json [path]`
- `next --json` projects the current plan, the separately labelled application observation, and destination configuration observation.

The existing seven MCP tools are unchanged. No MCP command, raw key parameter, URL, arbitrary process, shell,
environment injection, app launch or network listener is added. A plan always says `permission: none` and
`execution: unsupported`. The v2 legacy-deploy rejection is unchanged. The separate [bounded hosted deployment](connection-deployment.md) entrypoint
independently resolves and authorizes its operation; this plan never grants execution or skips its checks. Local/manual destinations remain
`unsupported` / `handoff-pending`; a hosted deployment is never substituted for a local application.

The production plan path does not invoke an official CLI or contact a provider. Existing destination identity probes
can refresh credentials or write logs/metrics, so they are not reused in this side-effect-free contract. A reviewed
non-mutating destination resolver is not yet installed: the real CLI returns unresolved/unsupported, never a complete
plan or a new current application pass. Internal synthetic test seams provide closed destination/native-config bases.
The existing `next` command's unrelated legacy readiness probes are unchanged; this candidate adds no probe to them.

## Binding

A complete plan binds the selected Resend intent, explicit environment, current value-free credential registration
revision and credential identity, current destination identity (including its existing closed configuration projection),
current supported source-syntax fingerprint, and application verifier version. Resolution failures return closed reasons.
Missing credentials never fall back to v1/user/another environment. Missing or unsupported source/configuration/destination
basis is not a complete plan. A plan is recomputed rather than persisted as permission.

Provider-native plans require a separate explicit native-configuration fingerprint in addition to destination identity.
They do not query or require the vault. A selected project/account cannot stand in for that native configuration. The current production resolver is absent,
so that basis is unknown. Even a resolved synthetic basis is not proof the integration is usable; those claims remain
separate caller observations. There is no inference from a
provider login, a configured project, or the existence of a plan to a completed integration.

The new conservative application fingerprint covers every supported JS/TS source in the project, including helper files
that do not reference the secret. Unknown configuration/dependency inputs (including package metadata or node_modules),
symlinks, oversized trees and behavior-bearing literals make the basis unavailable. Environment files are never read.
The old secret-reference-only fingerprint remains for unrelated compatibility, not current application evidence. This
small source-only subset supports synthetic contract tests; it is not a general proof of arbitrary application closure.
A future production resolver needs its own reviewed source/configuration/dependency coverage contract before enabling it.

## Advisory observation and lifetime

The new receipt version is `resend-application-check-v3`. The command records only `agent-observed`, with a server-side
local check time, the plan fingerprint, matching individual basis fields, configuration-observed boolean and expiry.
It accepts no authority parameter. Provider-observed/human-reported records cannot masquerade as this version. Existing
historical records stay readable, but older application verifier versions are stale rather than upgraded to current passes.

Lifetime is required per observation, a whole number of seconds in 1..86400. The one-day ceiling is an AI implementation
choice limiting advisory cache duration, not an external guarantee or a newly adopted product SLA. Callers should select
the shortest useful validity interval. There is no default or indefinite validity, and no renewal on read. At expiry,
clock rollback/future times, an invalid interval, missing completion or missing basis, the record cannot preserve ready.

`configuration: observed` retains `destination.authority: agent-observed` in the report. `configuration: unknown` cannot
make the destination configured, even if the app outcome is passed. Unknown external results remain unknown. Human reports
and provider evidence remain distinct authorities; this entry point cannot create either. A native route may reach an
advisory ready projection without a vault credential only with current configuration and app observations.

Editable metadata is not authenticated evidence. A same-user editor can fabricate an agent claim; neither that claim nor
a plan grants secret access, provider write permission, approval, entitlement, destination trust or safe retry authority.
`ready` always retains the application/configuration authority. It is not proof that the requested feature actually works.

## Interruption and invalidation

An unknown begin record is persisted before completion. The current plan is recomputed before finishing; a changed or
unresolved basis leaves the interrupted record unknown. There is no app execution and no automatic retry or resumption.
Repeated commands record repeated observations only; they never repeat an external operation. Result persistence failure
retains the unknown record. A malformed/missing journal or lock follows existing fail-closed storage rules.

Credential update/deletion, selected environment/route, destination/configuration identity, supported source, or verifier
change invalidates dependent app evidence. Unknown current inputs cannot be treated as unchanged. Provider credential
validation remains independently bound to its credential basis and is not upgraded by an app observation.

## Closed recovery projection (candidate)

`connection plan` now also inspects the selected environment's latest application receipt. It returns
`applicationCheck: { status, reason, configured, authority }` and `recovery: [{ reason, actor, action }]`.
`next --json` projects the same application reason and recovery under `connection.report`; its existing
provider check remains independent. These are additive candidate fields (plan schema 1 / next schema 4).
Recovery is advice for the containing `service` / `environment`, never a shell command, permission, approval,
execution request or automatic retry. A different chat can explain both the missing fact and who owns its resolution.
There are no raw paths, values, metadata bodies, provider errors or caller-authored messages in this projection.

Plan reasons retain the existing vocabulary, adding only `intent-missing` and `credential-revision-unknown`:

| Reason | Actor / action | Meaning and limit |
| --- | --- | --- |
| `intent-missing` | human / `select-connection-intent` | No intent was found. Ask for an explicit service/environment/route/destination choice. Never infer it. |
| `intent-unavailable` | agent / `review-connection-intent` | Cannot safely read the selection (including a lock, pending write, corrupt or unsafe metadata). Explain the closed blocker; preserve it. Do not suggest set/reset/overwrite as if it were absent. |
| `environment-mismatch` | human / `review-environment-selection` | The requested environment differs from the selected one. Confirm the intended scope without overwriting another environment. No receipt from that other environment is projected. |
| `handoff-pending` | product / `await-supported-handoff` | Local/manual application handoff is not implemented. Key re-entry and hosted deployment do not resolve it. |
| `credential-missing` | human / `register-environment-credential` | Existence check found no key in this exact v2 slot. Use only the separately requested Human Plane flow; no legacy/other-environment fallback. |
| `credential-unavailable` | human / `restore-vault-access` | The store cannot answer an existence check; it does not establish a missing key. |
| `credential-revision-unknown` | agent / `review-credential-metadata` | The key exists but its non-secret registration revision is unavailable/pending. Do not ask for re-entry or clear a lock automatically. |
| `destination-unresolved` | product / `await-destination-resolver`, or agent / `review-destination-basis` | No production resolver is installed; an internal synthetic resolver can instead report an unresolved basis. |
| `native-configuration-unresolved` | product / `await-native-configuration-resolver`, or agent / `review-native-configuration-basis` | Native configuration is distinct from provider login/project identity and vault storage. |
| `source-unresolved` | agent / `review-source-coverage` | Supported source syntax, configuration or dependency closure is unknown. Explain the coverage limit; do not remove application inputs or rewrite code merely to obtain a fingerprint. Broader coverage requires product implementation. |
| `basis-changed` | agent / `inspect-current-plan` | Inputs changed during inspection. Re-inspect only; do not repeat an external action. |

Absent production resolver work is listed first even when a separate credential/source prerequisite also fails.
It stays `actor: product`, never a request to enter another key or complete provider setup. Local/manual unsupported
plans do not ask for credential registration. The selected connection's `nextActions` suppress misleading native/manual
setup hints while the plan is unresolved; unrelated legacy setup/deploy/MCP behavior is unchanged. Legacy `guidedSetup`
and top-level secret status are not environment completion instructions.

Application reasons are closed and do not promote metadata into authenticated evidence:

| Reason | Status | Agent action |
| --- | --- | --- |
| `observation-missing` | not-run | `review-application-evidence` — no matching receipt exists; this is not an interrupted attempt |
| `observation-unavailable` / `observation-invalid` | unknown | `review-observation-storage` — unreadable/pending/unsupported storage versus malformed or invalid-schema data; preserve the journal |
| `observation-interrupted` | unknown | `review-interrupted-observation` — a valid begin record lacks completion; investigate without replaying work |
| `authority-mismatch` | unknown | `review-observation-authority` — a readable historical claim has the wrong authority; do not relabel it |
| `verifier-changed` / `observation-expired` / `basis-changed` | stale | `review-application-evidence` — obtain current evidence only after separately authorized work; never renew or copy an old pass |
| `observation-basis-missing` / `basis-unresolved` / `outcome-unknown` | unknown | `review-application-evidence` — the required basis or result is not established |
| `observation-time-invalid` | stale | `review-observation-time` — invalid interval or clock/future-time inconsistency |
| `application-failed` | failed | `review-application-failure` — diagnose without automatic retry or provider/app execution |
| `application-passed` | passed | No application recovery; when configuration is unobserved, a separate `configuration-unobserved` / `review-destination-configuration` item remains |

A forbidden v3 authority or extra receipt field fails storage validation as `observation-invalid`, rather than making a
usable claim. Historical human reports keep their authority and stay unknown. Storage problems can be diagnosed alongside
plan blockers; other application advice waits for a complete current plan. A current synthetic native configuration/app
success produces an empty recovery list and no connection work, without becoming permission or closing real acceptance.
No receipt, lock, registration, intent, source or expiry is created, cleared, refreshed or rewritten by inspection.

## Native inspection and named application history (private next schema 11)

The generic production plan still lacks a reviewed destination/source/dependency resolver. The explicit native
inspection already resolves a fixed Vercel metadata result, but previously discarded it; Clerk also had no
application receipt entrypoint. The private native commands now connect that result to a named caller observation:

- `connection native inspect --service <resend|clerk> --env <environment> --record --max-age-seconds <1..86400> --json [path]`
- `connection native observe-application --service <resend|clerk> --env <environment> --inspection <receipt-id> --feature <protected-access|send-and-delivery> --observer <agent|human> --outcome <passed|failed|unknown> --max-age-seconds <1..86400> --json [path]`

Inspection without `--record` keeps its existing non-persisting JSON contract. With opt-in recording, JSON is a
schema-1 envelope containing the unchanged `inspection` and a closed `recording` result. Inspection keeps its
existing trusted CLI, fixed metadata request and supported-host guards. Recording does not introduce another
provider call, login, CLI installation or execution helper. The application command records an observation made
in separately authorized work; it never executes an app, provider or caller command.

Both receipts use the existing schema-1 `observations.json`, lock, bounded retention and begin/finish transactions.
There is no new journal or lock format. The closed basis family is `native-app-observation-v1`: exact service,
environment, intent revision/fingerprint, linked Vercel project selection fingerprint, configuration classification
and fingerprint, and explicit expiry. Only guarded `.vercel/project.json` identity fields are read for local
selection comparison; environment/credential files and app code are not read. Credential revision and source
fingerprint remain null: this family does not claim generic v3 source/configuration/dependency coverage.

Destination receipts retain `local-observed`. Application receipts require the exact latest completed configured
inspection ID and a service-specific feature: Clerk `protected-access`, or Resend `send-and-delivery`.
The explicit observer retains either `agent-observed` or `human-reported`; provider authority, free text,
arbitrary paths/commands and extra basis fields are refused. Partial, absent, unknown, expired or changed
inspection cannot support a new application pass. Application expiry cannot exceed its inspection expiry.
A begin/completion failure stays unknown, and no operation is retried automatically.

Read-only `next` exposes Clerk `clerkNative.applicationObservation` and selected Resend
`connection.report.nativeApplicationObservation`. These show historical receipt IDs, feature, outcome, observer,
record time, expiry, the historical target fingerprint, the current local selection fingerprint and closed
remaining-work codes. Fresh matching history is `reported`, never current health: `currentHealth: unverified`
and `permission: none` are unconditional. A passed recorded feature needs no repeated observation solely for
this projection; current app health and broader source/dependency coverage are still unverified.

A new inspection with identical configuration does not renew or re-date the old application observation.
Repeating the same Clerk native selection reuses the strict saved intent under the existing metadata lock:
project/environment-derived ID, service, environment, slot, route, destination kind and sending domain must all match.
The state file and both timestamps stay unchanged. Lock, pending-write, corrupt and unsafe-path refusals still apply.
An actual environment change advances the revision even if the clock has not advanced; changing away and back
does not revive an old observation. Reuse never renews inspection/application expiry.
Changed configuration/selection, unknown inspection, interrupted storage, clock inconsistency or expiry retain
history while requiring review. The reader uses one journal snapshot and rechecks local selection; it performs
no writes, child processes, provider/app calls, expiry renewal or lock cleanup. Generic plan and legacy next
readiness exclude this family rather than converting it into v3 evidence. For the supported Resend
provider-native/Vercel route with an unresolved generic plan, `next.connection.report.recovery` is empty and the dedicated
`nativeApplicationObservation.remaining` supplies next work, including missing, expired, changed or
unreadable evidence. A missing generic resolver is not a prerequisite for this existing route.
The nested generic plan, standalone plan command, generic observations and their unresolved/unsupported
contract remain unchanged; neither an empty recovery list nor reported native history makes the app ready.
Editable local receipts remain caller claims, not authenticated proof. Published 0.9.2 and the seven MCP tools are unchanged.

## Clerk/Cloudflare prepared-version observations (private next schema 12)

The managed Clerk route uses an existing Worker and its schema-3 preparation history, independently of Vercel-native
receipts. Previously that history retained only an opaque destination fingerprint and created-version UUID, which cannot
reconstruct past account/Worker names offline. New preparation starts retain closed non-secret
`preparation.destination: {accountId, worker}` from the already validated Wrangler selection; completion preserves it,
including unknown/incomplete outcomes. Trusted execution, approval, native helpers, provider commands and activation
behavior are unchanged. Older entries remain readable; missing identity is never filled from today's configuration.

`connection observe-application --service clerk --env <environment> --preparation <receipt-id> --version <version-id>
--feature protected-access --observer <agent|human> --outcome <passed|failed|unknown> --max-age-seconds <1..86400>
--json [path]` records only an observation made in separately authorized app work. Protected access means signed-out
denial and signed-in access to the intended protected feature. The command has no runner, URL, key parameter, provider
probe or activation operation. Its association with the prepared version remains `caller-asserted`, not independently
verified evidence of an active/deployed version. It never substitutes a Vercel receipt or another environment.

Recording requires the exact latest completed preparation ID/version for this project/environment, recorded account
and Worker matching the explicit local selection, and matching existing registration revision and managed intent
fingerprint. Unknown/incomplete/pending history, missing original identity, registration change, unreadable/locked
storage and target change refuse a new pass. The existing observations journal/lock and begin/finish lifecycle retain
interrupted writes as unknown. The strict `clerk-worker-app-observation-v1` basis references the preparation ID/version,
original destination fingerprint, account/Worker/environment, selection revision, credential revision, feature and
bounded expiry. It claims no source/dependency closure or credential validity.

`next.clerkManaged.applicationObservation` separately restores the current local selection, latest preparation subject
and historical app subject, with authority, outcome, record time, expiry and remaining work. An environment change can
show the old subject as stale; it never satisfies the new selection. A newer unknown preparation overrides prior success
without erasing the old observation. Preparation/version changes, storage interruption, expiry and clock inconsistency
remain visible. Reading never renews evidence, writes or cleans storage. The added reader uses existing local
metadata/history and no vault dependency; the surrounding managed report retains its existing exact-slot presence
reads. Generic plan/readiness excludes this family.

Repeating the same Clerk managed selection uses the same locked full-identity comparison and no-rewrite behavior
as Clerk native. It preserves the selection revision and existing observation expiry; actual changes, including
changing away and back, advance the revision and leave the old application subject stale. Credential revision
and preparation/version checks remain independent. Reuse does not refresh preparation history or activation.

`summary`, `nextStep` and `review-clerk-managed` distinguish missing/unknown/expired app evidence, recorded failure and
recorded feature observations. Every result keeps `activation: not-inspected`, `currentHealth: unverified` and
`permission: none`. A matching caller pass still leaves activation/current version use unverified; prepared is never
relabelled deployed, active or healthy. There is no automatic preparation, login, resource creation, activation or retry.
Public npm 0.9.2 remains unchanged.

## Acceptance limits

Synthetic coverage exercises save metadata → plan → configuration/app observation → current advisory state → target change,
including native-without-vault, environment mismatch, no fallback, fake authority, expiry, unsupported fingerprint, missing/
malformed/interrupted journal, and closed CLI input rejection. Recovery fixtures run all three environments, distinguish
missing/corrupt/locked intent and missing/interrupted receipt, test unavailable vault versus unknown revision, closed output
keys, product-owned resolver/handoff blockers, source/config/dependency coverage, failure/expiry/version/basis/authority,
repeated inspection snapshots and success without unnecessary work. Fresh package smoke checks the installed projection.
Existing source/ASI invalidation regressions use v3 receipts.

No real key, provider request, email, app launch, registry/OS-store mutation, deployment, release or publication is part of
this acceptance. The environment candidate's Windows native functional gate was satisfied by the user-reported 100% run; 150% visual
coverage remains a public-release gate. A value-bearing local-app trust contract and a separately authorized real
application outcome remain pending under §22.

Initial recovery candidate validation (2026-10-02): TypeScript build, focused plan/recovery fixtures, full `npm test`, and
fresh `npm run test:package` passed (installed runtime dependency audit: zero vulnerabilities). The independent
read-only implementation review reported no findings. Cross-platform exact-head CI evidence belongs to the respective integrated PR;
these checks do not replace the user-reported native functional evidence, the still-open 150% public-release gate,
or real application/value acceptance.
