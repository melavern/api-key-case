# Value-free deployment history

> **適用範囲:** 以下は既存schema 1–4の履歴互換・Advisory意味の正本。2026-10-21以降のvNextでは値なしOperation journalを別namespaceに持ち、[開発候補の操作契約](../releases/windows-vnext-candidate.md)に従ってoperationIdで登録/配送の中断復旧を照会する。旧履歴を移行/削除/書換せず、過去の成功を新方式の現在状態・権限・自動再配置の証拠にしない。

Status: legacy receipts remain supported; environment-scoped v2 receipts are
implemented in the private Resend connection flow, with distinct schema3 Clerk
Worker-version preparation and schema4 registered Cloudflare destination records.
This is a small local
resumption aid, not a remote-state service or a new publication prerequisite.
Existing release acceptance remains in [RELEASING](../RELEASING.md).

## Meaning of the report

`api-key-case history --json [--offline] [path]` is Free. The private development
CLI adds `--offline` for the first inspection on a new chat or resumed deployment
task. Published 0.9.2 does not include this option; use the verified built checkout
and do not substitute a public npx version. Existing invocation without the flag
retains destination identity probing for compatibility.
The Agent explains what was observed for each requested name/scope and
target/environment. There is no inferred project-wide deployment completion,
batch manifest, automatic retry, or command to replay history.

History report schemas 2, 3 and 4 have `authority: advisory-local-history` and always report
`currentRemoteState: not-inspected`. `next` retains
`setup.deploymentState: not-inspected` (schema 5 in the current private candidate,
schema 2 in released 0.9.2). These are separate contracts. Report
schemas 2/3/4 include closed diagnostics and untested write access, with an optional
closed `connection` identity on v2 deployment entries. The on-disk journal
version is separate: schemas 1–4 are readable. A first Resend v2 start upgrades
schema1 to2; a first Clerk preparation start upgrades to3; a first registered
Cloudflare target start upgrades to4, preserving retained entries. Reports use
schema4 for registered targets, schema3 for other preparation entries, and
schema2 for older operations.

### Offline recovery inspection

The private [explicit Cloudflare config route](cloudflare-config-destinations.md)
adds journal/report schema 4 and an optional closed nonsecret `cloudflareTarget`
on connection receipts. It records catalog ID, account, Worker, config,
source/deployment environment, Wrangler section and allowed services. It never
records Secret content, CLI captures, approval tokens or application results.
Schemas 1–3 remain readable and retained entries survive an upgrade. Schema 4 is
never downgraded on disk; older readers refuse it. Config receipts remain
`currentDestination: unresolved` instead of comparing against a root config.

`--offline` reads the existing local journal and registration metadata only. It
never accesses an adapter or calls a destination resolver, launches an official
CLI, refreshes provider authentication, reads a credential value, writes/probes
metadata, clears a lock or retries placement. It works without provider login or
provider CLI availability. Existing journal/metadata path and schema guards remain.

The additive report field `destinationInspection` is `skipped-offline` in this mode
and `requested` otherwise. All offline entries have `currentDestination: unresolved`;
this is intentionally uninspected, not evidence of a missing/changed destination.
The selected mode is not proof that a probe succeeded. `currentRemoteState` remains
`not-inspected` in both modes. Local revision comparisons still use the exact v2
service/environment/project; another environment or legacy v1 key is never reused.
Past completed/incomplete/unknown outcomes retain their meaning and do not authorize
another operation. Review an interrupted or partially completed placement with the
human before any fresh request. Reading history cannot settle uncertain effects.

If a fresh destination-selection comparison is actually wanted, the existing
`history --json` mode is available. Official identity probes may refresh auth or
write provider logs/metrics, so that mode must not be described as globally
side-effect-free. Neither mode reads remote key values or proves application success.

| Past operation outcome | Meaning | What the Agent may explain |
| --- | --- | --- |
| `completed` | A deployment CLI returned exit0 without timeout after all pre-steps; a schema3 preparation additionally has exactly one validated created-version UUID and a current basis | This operation reported success; a Worker preparation is version creation, not production activation |
| `incomplete` | The CLI returned a nonzero code, or a legacy bound operation changed during handoff | This operation did not finish successfully; remote changes may already exist |
| `unknown` | A start has no saved result, an exception occurred, the child timed out/exited without a code, or the v2 connection basis changed | The result is unknown; agree remaining work with the human |

`incomplete` never means “nothing changed.” For example, Vercel `--force` may
remove an old variable before adding its replacement fails. This minimal
implementation records the whole attempt, not individual provider steps.
Timeout and exception cannot distinguish a rejected write from an accepted
write whose response was lost. Even a retained `completed` cannot prove the
provider still holds the same value, that it works, or that every requested
operation completed.

Entries are returned newest-started first; an older success is not substituted
for a later incomplete/unknown attempt. Concurrent attempts remain separate
entries, and their order is not proof of provider write order. Missing,
cleared, evicted or unreadable history means unknown, never “never deployed.”
Preflight refusal, license refusal, dry-run, and declined/unavailable approval
do not start an attempt and are not deployment receipts. They retain their
existing immediate command results. The Agent must not reinterpret an older
receipt as the result of a later request with no receipt.

## Key replacement and destination changes

No value revision or value-bearing vault API is added. A legacy start records
only the existing v1 registry's `updatedAt` when safely available. A Resend v2 start
records the approved exact v2 ref's `credentialRevision` and intent fingerprint,
with `registrationUpdatedAt: null`. Its identity includes `credentialVersion: 2`,
`service: resend`, environment and project ID; name/scope remain fixed to
`RESEND_API_KEY` / `project`. The receipt cannot be confused with a legacy
registration of the same name or with another environment/project.
A Clerk preparation instead has `service: clerk`, fixed `CLERK_SECRET_KEY` / `project`,
the same exact environment/revision fields, and its distinct schema3 `preparation` shape.

Inspection compares each v2 receipt only with
`ConnectionStateStore.credentialRevision` for that exact ref. It never reads the
v1 index for a v2 comparison, copies a legacy registration, or treats a missing,
locked or unsettled v2 revision as the legacy value. The canonical
`realpathSync` spelling is retained for project/ref and connection-metadata
identity; native path resolution is not substituted into those identities.
The captured intent fingerprint identifies past selection only and does not
establish that the current intent or app is ready.

The comparison remains advisory:

- `localRegistration: update-recorded` means the metadata timestamp differs.
  A legacy user-scoped update is visible in each project's own history. A v2
  update applies only to the recorded service/environment/project slot.
- `unverified` means no update can be established from those timestamps. It
  **does not mean unchanged**. Out-of-tool edits, delete/re-create, concurrent
  save, equal timestamps, index write failure, missing/invalid metadata and
  edits made during the operation cannot establish value identity. An index
  update failure after a value was saved therefore cannot make an old receipt
  evidence about that saved value.

The existing destination-only fingerprint binds project realpath, provider,
environment, destination configuration projection and non-credential provider
identity. It contains no Secret-derived material. Non-offline history reuses that
identity without creating or reading destination trust. An official provider
identity probe is performed only for recorded target/environment pairs, through
the existing trusted CLI/context; it may refresh auth or write provider logs.
Changes during inspection produce `unresolved`. Offline history skips this probe.

`currentDestination` is `selection-matches`, `selection-changed` or `unresolved`.
Matching compares destination selection only. An account/config change cannot
transfer old success to the new selection; switching back still does not prove
remote equivalence. Unsupported hosts and failed provider probes remain
unresolved. No remote Secret is read or queried.

## Persistence and failure order

1. Existing entitlement, project/scope, allowlist, CLI, destination and human
   approval checks run unchanged. History never grants entitlement, approval or trust; the new v2
   execution route additionally requires its exact pending receipt to remain readable before each handoff boundary.
2. Immediately before the handoff (including any destructive pre-step), an
   `unknown` start must be persisted. Failure returns `history-unavailable`
   (CLI exit 5) before any provider write or retained value read. A new call
   must go through all existing checks again; approval is never reusable.
3. The existing handoff rechecks the bound execution before value retrieval
   and every spawn. It passes no output or value to history.
4. The engine saves only the closed operation outcome. Result-save failure
   leaves the start unknown and prints a fixed warning. An observed successful
   deploy stays successful; the returned `historySaved` is false. The MCP
   result carries the same status and warning. The Agent stops the group and
   explains both facts rather than retrying the successful operation.
5. Process interruption leaves an unknown start, or an unavailable journal if
   it interrupted a metadata write. There is no background reconciliation.

## Unavailable history: diagnosis and guidance

`history --json` returns `diagnostic: { phase, issue, recovery }` alongside its
status. The codes describe observations, not inferred process state. An
existing valid empty journal is `available`; `missing` / `not-created` means
no journal was found at the expected path. The latter does not establish
whether one ever existed or whether any past deployment happened.

`writeAccess: not-tested` is always explicit: inspection creates no files and
does not test permission, free space or the ability to save a later start.
For example, a readable file in an unwritable directory can be `available`
while a subsequent deployment's start correctly fails with `access-denied`.
Known lock/temporary-file blockers make inspection `unavailable` without
echoing old entries. Failure to resolve the requested project/home path keeps
the existing CLI exit 1 and prints an `inspect` diagnostic instead of raw errors.

| `issue` | Confirmed observation | `recovery` and explanation for the Agent |
| --- | --- | --- |
| `null` / `not-created` | Readable valid journal / no journal found | `none`: no repair indicated; absence is not a deployment result |
| `lock-present` | A lock exists or creating this call's exclusive lock found one | `wait-and-inspect`: check running deploys, let them finish, then inspect again; a crash or stale lock is **not** established |
| `temporary-file-present` | The fixed temporary pathname exists | `review-history-metadata`: first confirm no deployment is running; do not overwrite/remove it automatically |
| `invalid-data` | JSON or the closed record shape is invalid | `review-history-metadata`: discuss the affected project's metadata without copying file contents into chat |
| `unsupported-schema` | The stored schema is not supported | `use-compatible-version`: consult the writing version's documentation; do not overwrite it as corruption |
| `unsafe-path` / `too-large` | Path/file safety checks or metadata read limits failed | `review-history-metadata`: preserve the boundary; do not follow a link or increase the limit to proceed |
| `access-denied` / `read-only-storage` / `path-unavailable` | The filesystem reported denied access, read-only storage, or a missing path during a write/setup | `review-storage-access`: review the current OS user's project/storage access; no automatic permission changes |
| `storage-full` | The filesystem reported exhausted space or quota | `free-storage-space`: ask the user to review disk/quota; no automatic deletion |
| `record-unavailable` | The result's start is absent or already finished | `review-history-metadata`: do not recreate the receipt or infer safe retry |
| `io-error` | Other unclassified storage failure | `review-storage-access`: cause remains unspecified; never expose raw error text |

The deploy engine and MCP retain their existing operation status and add
`historyDiagnostic` on a history failure. CLI text includes that same closed
diagnostic and fixed recovery guidance:

- `phase: start`, `kind: history-unavailable`, CLI exit 5: **this invocation
  stopped before provider writes**. This says nothing about an earlier or
  concurrent operation. No stored value is retained for handoff.
- `phase: result`, `historySaved: false`: **saving the operation result failed**.
  Preserve its observed success/failure/unknown outcome. A successful placement
  stays successful; failed/unknown operations may have partial remote effects.
  Do not reinterpret this as a start failure or automatically place the value
  again. Changed/exception paths also print any known result-save failure.
- A provider failure, timeout or unknown result does not make `--force` a
  general retry. Mention it only after the provider explicitly confirms a
  duplicate existing Secret and the human agrees. An incomplete or unknown
  force operation may have removed the old value before the add failed, so do
  not replay the same force operation automatically.
- `phase: inspect`: diagnosis itself executes no deployment and cannot recover
  a lost operation outcome. A new successful read does not establish writability
  or retroactively resolve an earlier result-save failure.

The generated exact-version Agent protocol explains these facts in the user's
language, stops the group, and proposes the relevant next step. After resolving
the cause, inspect history again and agree any fresh deploy request; it must
pass all existing entitlement, approval and destination checks. No diagnostic
is an approval credential or an instruction to replay an operation.

For persistent metadata problems, first confirm no deploy is active, explain
that discarding the affected project's history loses past results, and obtain
an explicit decision before any discard. Do not delete an existing lock/history
or change permissions automatically. Normal cleanup releases only the lock and
temporary file created by that one write; it is not a recovery mechanism.
No new repair command, background process or management screen is added.

## Data and lifecycle

Storage is outside the repository at
`~/.api-key-case/deployment-history/<project-directory-sha256>/history.json`.
The directory hash uses the exact canonical project path (without the vault
index's lowercase normalization); moving/cloning the project creates a
separate history. User-scoped values still have separate deployment histories
for each consuming project. Project/account names and raw paths are not stored.

The closed receipt contains a random operation UUID, Secret name and scope,
allowlisted target/environment, destination-only fingerprint, force flag,
start/finish timestamps, optional legacy registration metadata timestamp, and
outcome. A v2 receipt additionally contains the closed `connection` identity
listed above, its registration metadata revision and intent fingerprint.
Resend v2 deployment receipts support Vercel, Cloudflare and named GitHub Environments. Clerk v2 receipts require Cloudflare and a closed `preparation` object with `kind: cloudflare-worker-version`. Its `versionId` is null for pending/unknown results and a UUID only for completed preparation. Existing Version URLs may expose the created version; the receipt only says this invocation did not activate production. Legacy receipts retain their meaning.
New Clerk preparation entries also retain optional closed `preparation.destination: {accountId, worker}` from the
existing validated local selection. Environment remains the receipt's exact `env`; destination fingerprint and v2
registration/intent identity are unchanged. Begin and completion preserve this subject for offline inspection even
when the outcome is unknown. Older entries without it stay readable and unmodified, but cannot support a new named
Worker/version app observation by inferring their target from today's config. Strict older readers refuse the added
shape; use the current private CLI. There is no new history file, lock or schema number, no remote destination match,
activation or key-validity claim. See the [managed observation contract](connection-plan-observation.md#clerkcloudflare-prepared-version-observations-private-next-schema-12).
It contains no value, partial value, value hash/length, raw provider output,
arbitrary error, argv, credential, license, approval or trust token. An explicit
field projection on write excludes caller extras; strict validation on read
rejects extra fields, malformed or cross-project v2 identities, inconsistent
environments, and v2 receipts disguised as schema 1.
The module has no Vault or Human Plane dependency and never receives a handoff
result object. Size and symlink/special-file checks bound metadata reads.

Each project retains its last 200 started attempts; a new start evicts the
oldest, even if its result is unknown. There is no expiry timer: retained
records stay until displaced or explicitly removed. A project journal is
bounded to 256 KiB on both read and serialized write. Legacy and v2 entries
share the same 200-attempt limit. A short exclusive directory lock serializes
read/modify/write, a private temporary file is flushed, and rename replaces the
journal atomically. Concurrent lock contention fails the metadata operation
without overwriting another writer. This is ordinary editable local storage,
not a tamper-proof audit trail or a guarantee against power loss/backups.

### Journal compatibility

- A missing journal starts at schema 1 for legacy `begin` calls. Legacy-only
  writes preserve their original shape and version.
- `beginConnection` projects the exact v2 identity and approved metadata basis.
  Its first durable `unknown` start atomically upgrades a supported schema-1
  journal to schema 2, preserving retained legacy receipts unchanged. No
  credential or Secret-store migration is performed.
- Schema 2 permits a strictly validated mixture of legacy and v2 receipts.
  Later legacy writes remain supported. Eviction of all v2 receipts does not
  downgrade the journal.
- `beginClerkPreparation` writes an unknown receipt before the value-bearing call and upgrades the journal to schema3. It preserves existing entries. `finishClerkPreparation` only accepts a UUID for completed preparation; unknown/incomplete carry null. Readers supporting only schema1/2 must reject schema3, not relabel preparation as deployment completion. New writers never downgrade schema3 after eviction.
- Inspection does not migrate the file. Unknown schema versions, malformed
  records and cross-project v2 identities are unavailable; neither legacy nor
  v2 writers overwrite them. An older package that supports only schema 1 must
  refuse a schema-2 journal rather than resetting it; use a compatible version.

Reading does not create, prune or repair files. Corruption and existing
writer locks are reported as unavailable; a lock alone does not establish an
interrupted process. Old records are not echoed or
silently overwritten. To discard or repair local history, first ensure no
deploy is running, then explicitly delete this `deployment-history` directory
(all projects), or its selected project subdirectory, with the OS file manager.
This removes metadata only; it neither deletes stored/remote values nor changes
destination trust. Never remove the sibling `index.json` or license files as a
history repair. The Agent does not clear history to make a deployment proceed.

No new network destination or telemetry field is added. Reading may invoke the
same official provider identity probes as existing diagnosis. The report is
visible to the user's chosen Agent through normal tool output, subject to that
host's processing/retention settings; the local file itself is not uploaded.
The [Privacy Policy](../../privacy.html) describes these product facts.

## Scope and evidence

No legacy-to-v2 credential conversion, remote readback, team storage, automatic recovery,
new MCP history tool, generalized event database or publishing gate is added.
The existing `deploy_secret` uses the common engine; the CLI remains the
history inspection entry. The Free/Pro contract, OS-store-only value boundary,
high-risk approval and three-provider allowlist remain in force.

Portable tests: `node tests/deployment-history.mjs` after build, also included
in `npm test`. V2 coverage uses synthetic value-free metadata only, including
mixed-schema compatibility, exact-slot revision comparisons, corruption and
unknown-schema preservation, durable interruption/results, and bounded retention.
It does not use a real OS store, provider or network. Real-store handoff assertions are in the existing isolated
Linux-store lane and use synthetic values and a provider fixture. Observed
runs and their limits are recorded in [VERIFICATION](../VERIFICATION.md).

## Offline recovery verification (2026-10-03)

The history suite exercises offline CLI parsing, rejects duplicate/off-command flags,
uses a throwing adapter proxy/resolver to prove no provider capability is touched,
retains journal bytes/outcomes, and checks exact v2 revision comparisons without
legacy/other-environment fallback. The default mode still resolves a recorded
provider/environment once, preserving its existing behavior. Build and focused
history/Agent suites passed (7.3/3.3 seconds). Final isolated mock-keyring aggregate
passed in 184.4 seconds with candidate byte equality; offline installed-package
smoke passed in 20.4 seconds (159 allowlisted files; native loading blocked).
No real provider/native/key operation was used. Repository preflight remains
unavailable in the gitless materialization; remote tree verification is separate,
not a claimed preflight pass. This change does not alter placement/approval,
GitHub environment mapping, runtime handoff or roadmap state.
