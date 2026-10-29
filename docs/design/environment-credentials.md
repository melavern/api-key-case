# Environment credential candidate

Status: Environment separation is integrated for development. Portable and installed-package verification passed on Linux / Node 24.19.0;
Windows functional acceptance was user-reported as passed on 2026-10-02 at 100% scaling. The 150% visual release check and macOS native acceptance remain unverified. Published 0.9.2 is unchanged.

## Exact local slots

The closed Resend flow now stores the same logical `RESEND_API_KEY` separately in
each project's `development`, `preview` and `production` OS-store account:

```text
v2|credential|project|<projectId>|resend|<environment>|RESEND_API_KEY
```

The candidate commands require an explicit service and environment:

```text
api-key-case connection credential save --service resend --env development [path]
api-key-case connection credential check --service resend --env development --json [path]
api-key-case connection credential remove --service resend --env development [path]
```

`save` always uses the existing supported Human Plane; it accepts no Secret value,
stdin, terminal fallback or arbitrary provider. Existing slots require `--force`,
and the human still enters the value in the exact-slot dialog. The dialog names
service, environment, project ID and project path. `remove` uses the existing
Human Plane confirmation (including Windows OS verification); `check` is presence
only. These commands do not select intent, validate a provider, deploy or send mail.
There is no v2 user scope, MCP mutation, getter, export or generic execution API.

Legacy v1 save/check/list/remove/deploy, index, entitlement and destination trust remain unchanged.
History retains legacy receipt semantics with an explicit mixed-version journal extension for the new hosted route. Existing v1 values are neither read for migration nor
copied/deleted. A human must re-enter a value into the intended environment. The
legacy deployment handoff explicitly rejects v2 slots. The separate development
[`connection deploy` route](connection-deployment.md) now binds an exact v2 slot to an explicitly selected managed
Vercel/Cloudflare destination. It does not support local-app handoff or complete application acceptance. Provider-native/manual
routes and existing external secret-manager workflows remain available.

## Status and verification

`connection check --service resend --json [path]` now uses only the active intent's
exact v2 slot. It never falls back to another environment, legacy project key or
legacy user key. It rechecks the slot's revision and intent/executable snapshots
around the existing fixed Resend doctor operation. Without `--env`, the existing
four-field result (`service`, `status`, `resultCode`, `recorded`) remains unchanged.

The private continuation path also accepts `connection check --service resend
--env <development|preview|production> --json [path]`. Agents must pass the exact
saved selected `connection.report.environment`, including after inventory rediscovery;
never infer an environment or default to development. The guard does not select or
change an intent. A mismatch returns `status: unknown`, `resultCode: unknown`,
`recorded: false`, the requested `environment`, and `reason: environment-mismatch`
before vault availability/presence, CLI resolution, provider work or journal writes.
Guarded results always include the bounded requested environment, not evidence that
that environment was actually checked (especially for unknown/mismatch); invalid direct core
input returns `environment: null` and `reason: invalid-environment`. CLI missing
flag values, duplicates and unknown environments are usage errors. An omitted flag
retains legacy behavior and must not be used for fresh Agent continuation.

Unknown/missing intent, pending/locked/unreadable registration and unsupported routes
remain unknown, never invented absence or provider rejection. Selection identity and
revision, credential revision, pending journal and executable snapshots are rechecked
after awaited reads and execution; changing away and back cannot preserve a success.
These response-only guard fields do not broaden persisted Resend result codes or
change storage schemas, MCP, accepted doctor/handoff behavior or public 0.9.2.

`next` retains schema 4 and its compatibility projections. `connection.report`
owns environment-scoped readiness. `credential.source=legacy-unscoped` together
with `status=missing` means an old key exists, but the selected environment still
needs its own key. The legacy `guidedSetup`, `secrets` and general deployment fields
continue reporting v1 facts; they must not be interpreted as environment readiness.
A missing managed slot yields the closed `register-connection-credential` action
with exact service/environment. No legacy registration action is emitted for it.

Provider receipts retain their existing schema and history. Their non-secret
credential identity fingerprint now includes v2 service/environment. Old v1
receipts cannot validate a v2 slot. Application verifier basis advances from
`resend-application-check-v1` to `resend-application-check-v2` so coincidentally equal
legacy/v2 timestamps cannot revive a legacy app pass. This does not add app execution
or claim any current application pass. Environment identity isolates observations;
changing one slot does not invalidate another environment's current receipts.

## Interruption-safe metadata

Each environment has a separate non-secret file beneath the existing guarded
project connection metadata directory: `credential-<environment>.json`. It contains
only schema version, fixed name/scope/project/service/environment, creation/update
timestamps, and a `pending`/`settled` mutation marker. The marker is an implementation
safety detail for the closed design's registration revision, never authorization.
The file uses the existing bounded, exact-schema, symlink/special-file refusal,
0600/0700 and atomic-write handling. No value, partial value, hash or length is kept.

Before opening a human save/remove dialog, the flow takes an exact-slot lock and
persists a newer pending revision. Checks cannot claim validity while it is pending.
Only a confirmed successful store operation settles it. Cancellation, helper
failure or metadata completion failure leaves prior receipts unverified. A normal
explicit retry can re-enter the key after a returned failure; it never restores an
old pass or copies the old value. A process crash leaves its exact-slot lock in
place, and the product does not automatically clear it. Other slots remain usable.
A future supported recovery flow may guide a human after verifying no operation is
running; no unsafe lock-removal flag is introduced in this candidate.

## Platform boundary and acceptance

The CLI/state/slot account model is portable. Secret entry/removal still requires
the existing supported Windows or macOS Human Plane; Linux returns unavailable
without a terminal fallback. The first accepted product path is registration, configuration and application use
on the same Windows PC (user-confirmed 2026-10-02). OS stores are machine-local;
cross-machine secret transport is outside this slice. This does not change the
existing portable CLI contract or claim a new Windows-only product restriction.

Portable tests cover same-name isolation, legacy preservation, explicit identity,
no value leakage, failed/cancelled/in-flight operations, stale/unknown receipts,
corrupt metadata/symlink refusal, and separate-process metadata recovery. Native
script/fake-helper tests cover both Windows and macOS without executing real input.
CI's opt-in real-keyring lane uses synthetic values only.

Acceptance is staged by risk, following the user's 2026-10-02 direction to do
final visual coverage at the release stage rather than create per-change exceptions.

- **Development integration:** relevant automated tests and independent review,
  plus affected native functional/security checks. Secret non-return, exact
  environment identity, storage isolation, cancellation, deletion authorization,
  corruption/interruption handling and data integrity cannot be deferred merely
  because release is later. A known visual defect that obscures destination,
  environment, consent or safe operation is also a development blocker.
- **Public release:** complete the final supported display-scale matrix (100% and
  150% for these Windows save/removal dialogs) on the release candidate and record
  unresolved platform limits. Ordinary missing visual-matrix coverage does not
  block private development integration after functional acceptance. It is not
  evidence of a pass and does not authorize publication.
- Agents perform repeatable setup, dialog operation and evidence capture when
  supported UI access is available. Humans supply OS authentication, real-secret
  entry and any observation/judgment the agent cannot establish. Do not repeat a
  complete functional acceptance solely to fill a missing display-scale result.

The reported 100% Windows run satisfies this candidate's native functional gate;
150% visual coverage remains a release gate. macOS native input/rendering remains
separately unverified under the existing collaborative-verification status. A real
Resend provider check requires the user's supported secret-entry flow. No email,
deployment, release, new provider or public positioning change is authorized here.

## Verification — 2026-10-02

- Shared-foundation preflight and roadmap validation passed using ai-config
  `caf52eedd060864efab7f87fd930bda7db8cf7a5` (SHA-verified snapshot).
- CLI/core/MCP and license Worker TypeScript builds passed.
- Full `npm test` passed, including core, connection, generated Human Plane,
  environment isolation, LP analytics, license Worker, site-content and preview
  server gates. No baseline assertion or media check was skipped; tracked public
  media was materialized and matched against the private tree's Git blob hashes.
- Fresh consumer `npm run test:package` passed with the package allowlist and runtime
  dependency audit. The runner uses a writable npm cache; no package code/test was
  relaxed for the cloud filesystem.
- One independent source/diff/test review found a stale-presence overwrite race.
  Save/remove preconditions are now rechecked under the exact-slot lock before
  opening a dialog, and a deterministic concurrent-save regression passes. The
  reviewer found no other material issue. This was a dot-native read-only review;
  it did not execute native dialogs or establish platform acceptance.
- No actual key, provider request, email, deployment or public npm release occurred.
  The Windows functional result below supplements these automated checks; 150%
  rendering remains a release gate, and macOS native acceptance remains unverified.

## Guided native acceptance

The reviewed development checkout includes `npm run accept:environment:windows`.
It builds the candidate, creates a uniquely named temporary project, and runs the
fixed existing CLI save/check/remove sequence. The user performs six native dialog
actions (two synthetic inputs, two cancellations, two confirmed deletions) and
reports whether the identity labels are readable at the current display scale.
The helper never changes display settings, reads a value, checks a provider, sends
email or touches another project's slots. It checks every expected exit/status in
fresh CLI processes and stops on unexpected results without retry or automatic
secret deletion. Only closed status evidence, candidate SHA, Windows/Node versions
and reported display scale are written to `acceptance-result.json` in the temporary
project. Failure remains failed/in-progress; the directory is retained for diagnosis.
The helper's synthetic tests do not replace running it on Windows. A result at one
scale does not claim verification at another scale. Functional acceptance and the final visual release matrix are reviewed separately
under the stage-based gates above.

## User-reported Windows result — 2026-10-02

On 2026-10-02, the user reported `passed`, 19/19 checks, for the environment candidate: development/production save, overwrite
and removal cancellation, isolated deletion, fresh-process checks, and final
absence in all environments. They reported no clipped text or incorrect environment
labels at 100% scaling. Both exact-head CI runs passed all 11 jobs:
PR run (private development evidence) and
push run (private development evidence).

This record is based on the user's report, not an independent read of the retained
acceptance JSON or direct agent screen inspection. Input-value equality was not
checked by the helper. No 150% result, macOS result, real-provider operation or
public release is claimed. The user explicitly deferred final visual coverage to
the release stage; the requirement remains open rather than waived.


## Standalone Clerk registration foundation (private candidate)

The private CLI accepts `connection credential <save|check|remove> --service clerk --env
<development|preview|production> [--json] [path]`. It addresses only the fixed server-side
`CLERK_SECRET_KEY` slot. Resend v2 account names/files and legacy v1 behavior are unchanged;
Clerk uses `v2|credential|project|PROJECT|clerk|ENV|CLERK_SECRET_KEY` and separate literal
`credential-clerk-ENV.json` metadata. No environment or legacy fallback exists.

`check` calls only exact-slot presence; the backend may internally read/discard a value, but
no value leaves it and no availability probe is written. `save`/`remove` are enabled for Windows after review of the subsequent scoped functional
receipt; `CLERK_CREDENTIAL_NATIVE_ACCEPTED=true` retains the independent win32 guard. The existing native input/removal code can render the validated Clerk
identity; Linux generated-script and mock lifecycle tests are not native acceptance.

When enabled after that review, mutation will retain the existing pending-before-write,
serialized-dialog, cancellation, revision and interrupted-lock rules. Cancellation can leave
an existing value present while its registration revision remains unverified. Never infer
permission to retry/remove from a receipt or file. Existing Vercel-native Clerk setup does not
need duplicate vault registration. The public `CLERK_PUBLISHABLE_KEY` or framework-specific
publishable setting remains ordinary SDK/app configuration, not this secret slot.

`next` schema6 preserves `connection` for Resend and `clerkNative` for Vercel-native. The separate
`clerkManaged` projection reports selected standalone registration and historical preparation facts, never application readiness. Existing or unreadable Clerk registration metadata suppresses
misleading generic v1 register/remove advice for the fixed Clerk roles without selecting an
environment. Use the explicit credential check. Legacy arbitrary-name APIs remain unchanged.

Both inner local and hosted handoffs explicitly reject Clerk before key/child access. Clerk
provider validation, local execution, placement, provisioning and authenticated-app success
remain unsupported. In particular, ordinary Wrangler `secret put` can create a missing Worker
and immediately deploy a version; it cannot serve a no-provisioning staging contract merely
because local config exists. A future versions-secret route needs separate reviewed semantics.

The affected native milestone is one disposable Clerk development slot: save/fresh-process
presence, other-service/environment isolation, cancelled mutation with unverified revision,
and approved OS-verified removal. It does not repeat unrelated native or release-scale suites.
No real Clerk credential, provider request or native operation is performed by this unit's tests.


Verification of this registration-only increment: the isolated Linux aggregate passed in
211.6s with mock keyring, blocked native loading, fake provider commands and candidate-byte
checks. After that behavioral snapshot, only two guidance sentences were clarified and
matching guidance assertions added; the final build passed, Agent guidance passed in 3.9s,
and the final lifecycle/guidance suite passed in 0.7s. The final offline package passed in 20.7s
with 168 installed application files unchanged. The aggregate is evidence for the preceding
behavioral snapshot, not a claim that those later wording bytes ran through every suite.
Independent review found and corrected a lock-without-metadata legacy-fallback advisory;
regressions include directory/file/symlink slot locks and temporary files. Native lifecycle
acceptance was unperformed and the source gate remained false at that original checkpoint.
The subsequent scoped receipt and development enablement are recorded in VERIFICATION.md. No real key/store/provider
operation occurred. Preflight was attempted but unavailable because this materialization has
no Git metadata; exact remote-tree verification is separate evidence. Hosted Actions remain
unavailable under the previously observed account startup limit; no hosted-CI pass is claimed.
