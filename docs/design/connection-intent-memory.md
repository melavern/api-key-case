# Resume a recorded connection selection

Private development candidate for `roadmap:connection-memory`. This is a bounded
addition to [connection inventory](connection-inventory.md), not a new vault or
general connection catalog. The human roadmap order and guided-acquisition focus
stay unchanged. This does not complete connection-memory or the input panel's native
Windows/macOS panel acceptance, and it makes no new public npm/LP claim.

## User outcome and command

After a project has moved from development to preview, a new Agent can review
and restore the previously recorded development conditions without asking for
the same key or guessing a new route. The user must name the intended environment.
Every apply and both commands for Clerk/OpenAI/Stripe test require an explicit route. Resend plan alone
may read the exact recorded route when it was not supplied. All commands use the
same supporting built private CLI, including generated instructions captured with `agent-init --use-current-cli`.
Public 0.9.2 is not a fallback.

```
api-key-case connection resume plan --service <resend|clerk|openai|stripe-test> \
  --env <development|preview|production> \
  [--route <provider-native|api-key-case-managed|manual>] [--json] [path]

api-key-case connection resume apply --service <resend|clerk|openai|stripe-test> \
  --env <development|preview|production> \
  --route <provider-native|api-key-case-managed|manual> \
  --fingerprint <64-lowercase-hex-plan-sha256> [--json] [path]
```

OpenAI and Stripe test support only the managed Cloudflare/Vercel hosted profile;
Stripe test excludes production. Their execution is separately source-gated
pending [native acceptance](provider-hosted-deployment.md).

Clerk supports only `provider-native` (Vercel) and `api-key-case-managed`
(Cloudflare), as distinct coexisting profiles. Omitting a Resend plan's route
reads only the current or last-recorded selection for that exact environment;
it does not choose a default, infer a route from credentials or search other
environments. The returned route must be supplied explicitly to apply. Clerk's
route remains required to distinguish its coexisting profiles. Both commands
reject duplicate/unknown flags, extra paths,
selector overrides, credential values, repair options and arbitrary profile
names. A fingerprint is required for apply and forbidden for plan.

Plan is a local metadata read. It presents the project, requested profile and
environment, current and remembered route/destination/sending domain, recorded
time, effects and fingerprint. Apply rechecks the exact same request and reviewed
fingerprint under the existing store lock before changing selection metadata.
The fingerprint uses the selected explicit route, so an omitted-route Resend
plan can be applied with exactly the route displayed in its report.
The fingerprint is a change detector, never human approval or provider authority.
An old or changed plan requires another read and review, not automatic retry.

## Bounded non-secret memory

Clerk-native, Clerk-managed and hosted profile documents remain closed schema 1.
Resend `state.json` keeps strict schema 1 for route-only selections and uses
strict schema 2 only when the explicit `nativeEnrollment` method is recorded.
Schema 2 accepts exactly `resend-vercel-integration` or
`resend-vercel-marketplace`, and only for Resend × provider-native × Vercel.
New readers keep v1 read-only and do not infer this field from inspection/history;
private binaries that only understand v1 fail closed on v2. Two closed hosted
profiles add provider-openai.json and provider-stripe-test.json using the same
mechanics. The project-bound, closed-schema
`intent-history.json` remains in the same protected connection metadata directory.
Its schema-1 envelope contains only `schemaVersion` and `entries`; each entry has
`profile`, `intent` and `recordedAt`. It contains at most fourteen records: three environments each for Resend,
Clerk-native, Clerk-managed and OpenAI, and development/preview for Stripe test.
Each records only the last previously active selection. Older readers fail
closed on unknown new profiles in mixed history; they must not repair or rewrite it. This is not a full timeline or
one record for every route, account, Worker or Vercel project.

Only previously committed active selections are archived, immediately before a
different active selection replaces them. Never archive the proposed selection
before its active write commits. A first selection needs no invented predecessor.
Writing the same selected conditions is unchanged and preserves its revision.
Every archived intent retains the existing validated, closed fields: connection
ID, service, environment, default slot, route, destination kind, sending domain,
creation time and update time. A Resend schema-2 intent also retains its exact
native enrollment method. The history record identifies its profile and
recording time; unknown fields, incompatible versions and wrong-project
identities cannot become candidates for restoration.

The archive stores selection conditions only. It contains no secret values,
credential references that grant access, account IDs, provider tokens, execution
commands, approvals or observations. A Resend history slot can remember only its
last recorded selection for that environment, including an explicitly saved
native enrollment method. If it does not match the explicitly requested route,
do not substitute it or infer another route.

The unchanged current selection is a valid source even if it has never been
archived. When current state already selects the requested environment, it takes
precedence over an older archived version for that environment. A mismatched
current route blocks rather than silently selecting a matching older route.
A different selection can be restored only from matching validated history.
A real restoration writes a fresh intent revision newer than current
and remembered revisions, so old intent-revision-bound native, local-session and
Clerk application evidence cannot silently become current again. Existing
credential-validation history for the same environment and credential revision
keeps its current historical-evidence semantics; no receipt is deleted or
rewritten. Restoring conditions is not restoring readiness or permission.

## Storage and interrupted operations

Use the existing project-global metadata lock and safe bounded file operations.
Do not introduce a second lock, database, broad scan, repair command or migration
of the active schemas. Missing history is normal `not-recorded`, never evidence
that a credential is missing. Older private binaries only understand Resend
schema 1 and fail closed on schema 2; use a current binary after recording a
method. Those binaries may still overwrite schema-1 active state without
archiving it, so an unrecorded old selection may be lost. Do not claim that old
binaries preserve every historical choice.

Corrupt, unknown-schema, oversized, unsafe, locked or temporary history blocks
changing to a different selection. Do not repair it, ignore it to overwrite a
selection, follow unsafe links, or silently start a new archive. Preserve the
existing data and surface the issue with no raw metadata or filesystem exception
dump. An unreadable project/home path also fails closed with a generic error.
The existing exact-current `connection set` no-write path can skip history
parsing. Resume always validates any recorded history, and apply also requires
a matching fingerprint, even when its selected conditions would be unchanged.

The two-file change has deliberate ordering, not a claim of multi-file atomicity:

1. Acquire the existing global lock, then validate active state and history.
2. Persist the previous committed active selection in the bounded archive.
3. Replace the active document with the new selection.

If the archive write fails, or execution is interrupted before the active rename,
the old active selection remains. A successful archive write followed by a failed
active replacement may leave a redundant archive of the still-current selection;
it must not make the proposed selection look committed. After the active rename,
a later failure can make success uncertain. Preserve both files, re-read and
re-plan; never roll back automatically or treat an error as proof that nothing
changed. A leftover temporary file or lock requires review rather than cleanup
or a forced retry.

An unchanged apply leaves data files byte-for-byte unchanged. Acquiring and
releasing a temporary lock is permitted; "no-write" here describes persistent
data files, not an assertion that no lock directory was touched.

## Report and continuation

The resume output is schema version 1, separate from existing `next` and active
storage schemas. It includes `projectId`, service, environment, route, profile,
status, issue, current and remembered validated intents, source, recorded time,
fingerprint, `permission: none` and `providerOperation: false`.
Invalid direct core inputs return `invalid-data`; request/profile fields are null
when they cannot be validated, and unvalidated strings are never echoed. A valid
omitted-route Resend plan with no recorded selection has `route: null` and
`issue: not-recorded`, rather than an invented route.
The current/remembered fields retain the reviewed conditions in an apply receipt;
they are not a refreshed snapshot of the active document after the write.

- `ready`: a matching recorded selection can be applied after plan review.
- `unchanged`: the selected conditions already match; its revision is retained.
- `applied`: selection metadata was restored with a fresh revision.
- `blocked`: selection could not safely be resumed. CLI exits with status 1.

Source is `current`, `last-recorded` or null. No source means not-recorded or an
unavailable result, never missing credentials. Text and JSON expose only the
validated non-secret report. No credential presence lookup, registry listing,
vault read/write/probe, provider CLI, browser, network request, authentication,
resource creation, permission grant, deployment or app execution is performed.

After a reviewed metadata-only apply, continue with the same private CLI's
`next --json --offline`, matching native/Cloudflare guide and separately requested
exact-environment check. A saved destination kind does not restore local
`.vercel/project.json`, Wrangler selectors, account identities or remote settings.
Those existing guides must reconcile the current local destination independently.
Resume also does not restore credentials, grants, authority, approvals, historical
observations or current provider/application health. All existing Human Plane,
entitlement and production gates still apply. Unknown results must not trigger
duplicate key entry, automatic provider setup or a fallback route.

## Verification boundary

Portable tests must cover profile/environment isolation, round trips, unchanged
revision preservation, fresh restore revisions, strict CLI parsing, stale
fingerprints, wrong-project/route refusal, legacy schema-1 compatibility,
bounded history, rejected corrupt/unknown/unsafe/locked/temporary files and
interruptions on both sides of the active rename. Data-file byte comparisons
distinguish unchanged results from the permitted temporary lock. Forbidden-effect
fakes and synthetic canaries must show no credential/provider operation or
unvalidated output. These tests do not replace native OS-store, provider,
application or input-panel UI acceptance.

## Portable verification result (2026-10-06 UTC)

The implemented private candidate passed the final source-frozen `npm test`
aggregate on Linux / Node 24.19.0 (393.7 seconds), including 89 bounded-state
cases, 73 fresh-process resume CLI cases and 41 current-CLI guidance cases. The
CLI fixtures carry registered Resend and Clerk credentials through set, switch,
plan, apply, offline next, matching guide and exact-slot presence check without
re-entry, provider effects or local selector changes. Native, local-session and
Clerk application observations remain stale after a real restoration; matching
environment/credential-revision validation history keeps its existing semantics.
The first aggregate attempt stopped at the expected generated-guidance hash;
that golden was updated for the new guidance with explicit assertions, then the
final frozen aggregate passed. This result paragraph is the only subsequent
change. Process-interruption fixtures do not establish stronger power-loss or
multi-file transaction guarantees than the existing temp/fsync/rename mechanism.
Real OS-store/native UI, provider and application acceptance remain separate.
