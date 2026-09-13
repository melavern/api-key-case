# Value-free deployment history

Status: implemented in the unreleased 0.9.1 candidate. This is a small local
resumption aid, not a remote-state service or a new publication prerequisite.
Existing release acceptance remains in [RELEASING](../RELEASING.md).

## Meaning of the report

`api-key-case history --json [path]` is Free. On a new chat or resumed deployment
task, the exact-version Agent protocol asks for this report alongside `next`.
The Agent explains what was observed for each requested name/scope and
target/environment. There is no inferred project-wide deployment completion,
batch manifest, automatic retry, or command to replay history.

History report schema 2 has `authority: advisory-local-history` and always reports
`currentRemoteState: not-inspected`. `next` remains schema 2 with
`setup.deploymentState: not-inspected`. These are separate contracts. Report
schema 2 adds closed diagnostics and untested write access; the on-disk journal
remains schema 1, so existing receipts need no migration or reset.

| Past operation outcome | Meaning | What the Agent may explain |
| --- | --- | --- |
| `completed` | The official CLI returned exit 0, without timeout, after all pre-steps | This operation reported success at the recorded time |
| `incomplete` | The CLI returned a nonzero code or the bound operation changed during handoff | This operation did not finish successfully; remote changes may already exist |
| `unknown` | A start has no saved result, an exception occurred, or the child timed out/exited without a code | The result is unknown; agree remaining work with the human |

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

No value revision or value-bearing vault API is added. Each start records the
existing registry's `updatedAt` when safely available. Inspection compares it
with current registration metadata in the same scope:

- `localRegistration: update-recorded` means the metadata timestamp differs.
  A user-scoped update is visible in each project's own history.
- `unverified` means no update can be established from those timestamps. It
  **does not mean unchanged**. Out-of-tool edits, delete/re-create, concurrent
  save, equal timestamps, index write failure, missing/invalid metadata and
  edits made during the operation cannot establish value identity. An index
  update failure after a value was saved therefore cannot make an old receipt
  evidence about that saved value.

The existing destination-only fingerprint binds project realpath, provider,
environment, destination configuration projection and non-credential provider
identity. It contains no Secret-derived material. History reuses that identity
without creating or reading destination trust. A read-only provider identity
probe is performed only for recorded target/environment pairs, through the
existing trusted CLI/context; changes during inspection produce `unresolved`.

`currentDestination` is `selection-matches`, `selection-changed` or `unresolved`.
Matching compares destination selection only. An account/config change cannot
transfer old success to the new selection; switching back still does not prove
remote equivalence. Unsupported hosts and failed provider probes remain
unresolved. No remote Secret is read or queried.

## Persistence and failure order

1. Existing entitlement, project/scope, allowlist, CLI, destination and human
   approval checks run unchanged. History is never an input to these checks.
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
start/finish timestamps, optional registration metadata timestamp, and outcome.
It contains no value, partial value, value hash/length, provider output,
arbitrary error, argv, credential, license, approval or trust token. An explicit
field projection on write and strict validation on read reject extra fields.
The module has no Vault or Human Plane dependency and never receives a handoff
result object. Size and symlink/special-file checks bound metadata reads.

Each project retains its last 200 started attempts; a new start evicts the
oldest, even if its result is unknown. There is no expiry timer: retained
records stay until displaced or explicitly removed. A project journal is
bounded to 256 KiB on read. A short exclusive directory lock serializes
read/modify/write, a private temporary file is flushed, and rename replaces the
journal atomically. Concurrent lock contention fails the metadata operation
without overwriting another writer. This is ordinary editable local storage,
not a tamper-proof audit trail or a guarantee against power loss/backups.

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

No key revision migration, remote readback, team storage, automatic recovery,
new MCP history tool, generalized event database or publishing gate is added.
The existing `deploy_secret` uses the common engine; the CLI remains the
history inspection entry. The Free/Pro contract, OS-store-only value boundary,
high-risk approval and three-provider allowlist remain in force.

Portable tests: `node tests/deployment-history.mjs` after build, also included
in `npm test`. Real-store handoff assertions are in the existing isolated
Linux-store lane and use synthetic values and a provider fixture. Observed
runs and their limits are recorded in [VERIFICATION](../VERIFICATION.md).
