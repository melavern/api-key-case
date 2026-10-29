# Bounded local application handoff

> **適用範囲:** 本書は既存の「Resend × development × 固定Node artifact × 最大30分」の実装・native受入・後方互換の正本。2026-10-21以降の**別の通常Node/Python LaunchProfile**は[通常アプリ起動契約](ordinary-local-launch.md)を正とし、本書の固定artifact/ソース変更即停止を新ルートへ流用しない。旧契約・guard・受入は変更しない。

Design checkpoint: 2026-10-02. The user adopted the application trust boundary; implementation and real application acceptance are separate stages. This document narrows the first implementation and does not claim it already works.

## Adopted boundary

API Key Case does not return the raw credential through Agent CLI, MCP or JSON, write it to plaintext configuration/temporary files, put it in argv, or include it in ordinary logs. Existing OS credential storage is retained. An explicitly selected project × Resend × development connection may pass its key to the explicitly approved application. That application can read the key. Application code, dependencies and the same OS user are trusted; this is not isolation from them. App-owned output, files or network effects cannot be made safe merely by filtering API Key Case output. Stopping an application does not revoke a key it already copied.

Evidence: the user's boundary statement (Sentinel_f39132f60fe4819189a391a89bfe4628) followed by adoption “まあそんな感じで進めといて” (Sentinel_88cec08e50dc81919a02d300f87102de). These authorize design and implementation, not a live secret/app execution or persistent credential grant.

## First implementation profile (AI-selected narrowing)

- Windows supported Human Plane only, using the existing OS-verification requirement. Other hosts fail closed until separately implemented and tested.
- One foreground session of a fixed, locally built Node application artifact under the canonical selected project. Require an explicit entry artifact and trusted Node executable; no PATH search after approval, shell, package-manager script, arbitrary command, caller argv or additional environment map.
- Only managed local intent for project-scoped Resend development v2. Derive RESEND_API_KEY and the credential reference internally. No user-scope, legacy, another environment, or another service fallback.
- Every launch requires a fresh native summary and OS verification binding project, artifact, interpreter, credential environment/revision and a finite session limit of at most 30 minutes (a shorter requested limit is allowed). Existing hosted destination trust never authorizes this launch. No permanent local approval, background service, hot reload or automatic restart.
- Build/install remains a separate secret-free operation. API Key Case does not build, install, download or execute package hooks as part of handoff.
- Bind the selected artifact/interpreter and a declared build-input change set: sorted files beneath fixed supported source roots, package.json, one supported lockfile and explicitly supported build configs. Use private SHA-256 and byte-count snapshots to detect edits/additions/deletions; reject missing, unreadable, symlinked, unsafe or oversized inputs and changed enumeration. Changes require a new session and approval. The author is trusted for inputs outside this set. Dynamic resources/imports and installed dependencies are not cryptographically covered. Artifact-to-source correspondence remains unverified: a .cjs hash and mtimes do not prove self-containment, a fresh build or build provenance.
- App stdout/stderr and stdin are not forwarded to the Agent and are not captured in history or logs. The fixed profile may still serve its own local application endpoint; API Key Case neither contacts it nor asserts feature success.
- Execution entitlement uses the existing paid-operation check as a conservative development gate, without changing public pricing or asserting a new sold capability. Secret-free inspection remains free.

## Value-bearing and lifecycle boundary

Keep credential retrieval inside the existing sole handoff module. Give the execution layer a closed structured request, never a getter or callback returning the key. Pass the key only through a private process pipe/environment construction inside the trusted handoff/native helper, never a filesystem artifact or command string. Child environment must be an explicit safe platform allowlist plus this exact key; strip Node preload/options and inherited credential variables. Do not inherit arbitrary parent descriptors.

The native launch primitive must create the approved child under owned process-tree lifetime control before it can execute, with no shell and with output handles discarded. Windows uses a reviewed fixed helper and kill-on-close Job Object atomically assigned during process creation through PROC_THREAD_ATTRIBUTE_JOB_LIST; suspended creation followed by assignment is insufficient because helper failure leaves an orphan window and the environment already carries the key. The ownership handle is non-inheritable and breakaway is disallowed. Failure to establish atomic ownership aborts without creating the secret-bearing child. Cancellation, expiry, parent loss, normal root exit and abnormal exit close the entire owned tree. Failures return closed lifecycle reasons, not provider/helper/child exception text. No PID-only detached launcher or kill-by-name cleanup.

Revalidate project/intent, exact credential reference/revision, artifact/interpreter identity and approval freshness after every awaited boundary and immediately before secret retrieval/launch. Mark an attempt durably before launch; an interrupted/uncertain attempt is unknown and never retried automatically. No history entry supplies permission. Parent or metadata failures must not silently spawn twice or report a clean stop when ownership is uncertain.

Private artifact integrity checks are distinct from the public source fingerprint contract: hashes of arbitrary file bytes must not become Agent-visible or persisted diagnostic identifiers. Use an internal launch snapshot and private integrity checks only, with public opaque attempt IDs and closed changed/unknown states. Do not put paths containing user input or raw source/errors in exception output. Hold artifact/interpreter identities stable with native read locks denying write/delete for the launch/session; revalidate the declared input set immediately before child release. Monitor declared inputs throughout the finite session and terminate/invalidate on detected changes or monitoring failure. Periodic detection is not zero-latency hostile same-user protection. It must not claim cryptographic coverage of arbitrary runtime imports, mutable external resources or same-user behavior.

## Acceptance before merging implementation

Synthetic tests must cover missing/corrupt intent, wrong project/env/service/ref, legacy collisions, revision rotation at every awaited boundary, artifact/interpreter replacement, denied/cancelled OS verification, helper protocol tampering, malicious output, inherited NODE_OPTIONS and credential variables, stream backpressure, timeout/cancellation/parent-loss cleanup, metadata failure before/after launch, and interruption with no automatic second launch. Free/paid paths must be explicit. Assert no secret body reaches JSON, argv, ordinary logs, plaintext files or receipt metadata.

Portable unit tests use fake vault/approval/process ownership interfaces. Fixed-helper structural tests do not substitute for actual Windows lifecycle acceptance with synthetic credentials. That functional process-ownership acceptance must pass before enabling this launcher in a development merge, including helper crash before/during creation, parent loss, normal root exit with descendants, timeout and cancellation; visual deferral does not apply. A development merge needs required security/functional tests and independent review; scale/visual matrix remains the public-release gate under RELEASING. Existing native acceptance cannot prove a newly added process launcher works.

## Remaining evidence

After implementation, a separately authorized named-app/key session must demonstrate the actual requested feature in that environment. Any provider request/email, charge or external exposure keeps its own approval. A started process or saved session receipt does not prove application readiness or close vertical-complete. Compare the resulting human effort with the best official path before capability/value claims or expansion.

Windows ownership references: https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812/ and https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute .

## Staged implementation (2026-10-02)

The development candidate adds `connection local inspect|run|status`, a real fixed
native launch primitive, and portable orchestration tests. The original candidate
kept native launch source-disabled pending Windows synthetic lifecycle acceptance.
The reviewed 2026-10-03 development decision below enables the existing Windows
ordinary-file path after the reported lifecycle, junction and consent results. No
CLI option, environment variable, metadata field, test result file or hosted trust
record enables it. Existing seven MCP tools and legacy v2 deployment rejection
are unchanged. This is not a supported release capability or live-app acceptance.

Closed requests:

```
api-key-case connection local inspect --service resend --env development --artifact dist/app.cjs --max-seconds 1800 --json [project]
api-key-case connection local run --service resend --env development --artifact dist/app.cjs --max-seconds 1800 --json [project]
api-key-case connection local status --service resend --env development --json [project]
```

Inspection and receipt status are free and confer no permission. Run applies the
existing execution entitlement check before any vault presence probe; it is a
conservative private development gate with no new public pricing claim. Runtime
selection is the already-running Node executable, outside the project, bound
before approval. Artifacts are relative `dist/<safe path>.cjs` entries only. No
caller-provided executable, args, environment, shell, URL, package-manager command,
install or build hook is accepted. SIGINT/SIGTERM request owned-tree cancellation.

### Preparation across conversations (private development, schema 9)

An explicit successful local inspection now stores one bounded `localPreparation`
receipt alongside the existing entries in guarded `observations.json`. It does not
modify trial receipts, observations, credential values or session ownership. The
receipt records the exact development connection, selection/registration revisions,
safe relative artifact identifier, finite duration, inspection time and expiry.
Expiry is the inspection time plus the explicitly chosen duration (1–1800 seconds).
Existing journal writes preserve it; unreadable/unsafe/locked metadata is never
overwritten to recover. A failed save reports `metadata-unavailable`.

Its four versioned identities hash only ordinary-file metadata: canonical project
directory identity, sorted declared input names/stat identities, artifact stat
identity and the running Node path/stat identity. No file contents, content-derived
hashes, Secret values, source syntax, argv, output or executable choice are persisted.
The existing private byte digests and owner configuration remain in memory only.

`next` reenumerates/reobserves those bounded metadata inputs without reading their
bytes, spawning, probing a provider or writing state. `unchanged-metadata` restores
the artifact candidate and duration so a new conversation need not ask the human
for the app/key or build again. It still calls the existing explicit inspection;
metadata equality is neither full integrity nor build/source provenance. Input
changes require source/build review and preparation only when needed. Artifact or
runtime changes require their current inspection; elapsed time alone does not
require rebuilding. Changed selection/credential hides the candidate until those
facts are reviewed. Missing/unreadable files, clock rollback/future dates, expiry
and read-time metadata races remain review/unknown, never approval or absence.
Build and current inspection remain `not-inspected` in `next`; past preparation
never makes application readiness verified. Runtime dependencies/resources outside
the existing declared set remain trusted and uncovered. Run continues to capture
all bytes anew, enforce the existing lock/Pro/native boundaries and require a fresh
scoped effects request and approval. There is no automatic build, inspection or run.

An exact repeat of Resend `connection set` (environment, route, destination and
sending domain) retains the existing selection revision and state file under the
same guarded metadata lock. It does not discard preparation or trial observations,
renew expiry, access a credential or grant permission. A real selection change,
including changing away and back, still advances the revision and invalidates the
earlier binding. Locked, interrupted, corrupt or unsafe metadata is still refused;
there is no unlocked fast path or overwrite to recover.

The declared input set is every regular file beneath any present `src`, `app`,
`server`, `lib`, `pages` root (at least one required), `package.json`, exactly one of
`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, and any present `tsconfig.json`,
`tsconfig.build.json`, `vite.config.ts`, `vite.config.js`, `esbuild.config.mjs`.
The set is sorted and enumerated again after capture/check. Symlinks, special files,
secret-bearing `.env*`/key filenames, nested `node_modules`/`.git`, unsafe display
characters, unreadable files, over 1,024 files, depth over 20, source files over
2 MiB, or total source bytes over 16 MiB fail closed. Artifacts are limited to
16 MiB and the runtime to 128 MiB. Capture and full integrity checks stream every
byte through a single reusable 64 KiB buffer per pass, including a bounded EOF
probe and the existing before/opened/after file-identity checks. Snapshots retain
only private SHA-256 digests, byte counts and metadata, not complete file buffers.
The artifact/runtime digests are the same SHA-256 binding used by the native
helper; source checks also compare private digests and counts. These remain only
in memory/private helper input. None becomes a public fingerprint, receipt,
diagnostics, or file. Inputs outside this declaration, imported resources
and dependency bytes remain trusted and uncovered; this is not source closure or
build provenance. Before launch, checks reread the complete bounded set, artifact and runtime. Once
the fixed native helper confirms the running child and its deny-write/delete locks,
500 ms polling rereads the declared source/config set and checks artifact/runtime
path and metadata identity under those locks, avoiding repeated runtime-byte reads.
After helper closure the final check again reads all bytes. Monitoring is periodic
detection, not hostile-user isolation.

The only exported executing entry takes the closed request and cancellation
signal. It constructs its own production vault, native approval, entitlement and
snapshot dependencies; the value-bearing helper and permission state are private
to the existing handoff module. Synthetic ownership and fake keyring seams exist
only in a disposable compiled test fixture, never in the shipped API.

Each launch uses the exact project v2 development slot and settled revision. It
rechecks after awaited vault/approval/native protocol boundaries, then durably saves
an opaque unknown attempt before retrieval or spawn. Fresh approval is usable for
at most 60 seconds until release. Helper startup is bounded; the helper locks
artifact/runtime bytes, acknowledges READY, receives the key privately, creates
the suspended process atomically in the Job Object, acknowledges CREATED, and
waits for RELEASE after another parent revalidation. Output is a strict bounded
ASCII lifecycle protocol; duplicate/out-of-order/unknown/high-bit/oversized output
fails closed. App handles point only to NUL. The helper monitors a real parent
process handle and has its own finite timer. Only confirmed native teardown plus
helper closure can produce a confirmed-tree result. Forced helper termination or
malformed protocol leaves unknown; it is never silently retried.

`local-session.json` beneath guarded project connection metadata holds bounded trial
receipts and closed observations. New receipts have an opaque attempt ID and separate
random execution basis ID, connection ID, selection/registration revisions, timestamps,
duration and closed lifecycle outcome. It has no path, argv, file-content hash, output or key. The original pending receipt
and exact lock identity are bound at every subsequent validation; changing any
receipt field or replacing/removing the lock invalidates the session. This
receipt is advisory and does not mean the application is ready. A pending receipt
reads as unknown, never proof of a running/stopped application. A session lock
prevents a second local launch; a stale lock returns `recovery-required`, and status
says `owner-review-required`. A later invocation does not clear it after expiry,
crash, unknown teardown, metadata failure, or another approval. A supported recovery
primitive across invocations is pending; ordinary interrupted-session recovery
is not solved.

The owning invocation may make one additional completion-only attempt after a
closed I/O failure if it already knows that no application launch occurred or that
the process tree terminated. It retains the original pending receipt, exact lock
identity and one fixed completed receipt in memory. An unsaved result requires the
original pending receipt to match; an already saved exact completion is verified
without rewriting it before releasing the same lock. Changed receipts, replaced
or unsafe locks, temporary files and unavailable ownership remain closed. Unknown
teardown is not retried. This never repeats approval, key retrieval, app launch or
provider work and adds no durable ownership authority or recovery CLI. A remaining
failure returns only `completionFailure.phase` (`result-save` or `lock-release`)
and a closed metadata `issue`; `receiptSaved: false` alone does not prove that no
receipt was written, because lock release can fail after a successful write.

Portable coverage: `node tests/local-snapshot.mjs` and
`node tests/local-application-session.mjs` after build. The dedicated
`node tests/local-session-completion.mjs` gate covers bounded completion I/O and
ownership/evidence changes in storage and the disposable coordinator. The
snapshot-only test uses
harmless synthetic files to check bounded reads, byte equivalence, file races and
limits, without any vault, native owner or application execution. The session suite
also runs `tests/local-application-feature.mjs` inside its disposable compiled
fixture; `node tests/local-application-session.mjs --feature-only` selects just
these five cases. It retains the fake v2 vault and native-approval binding, then
uses a synthetic owner to start one real harmless Node application only after
RELEASE. The app receives the synthetic `RESEND_API_KEY` and `NODE_ENV=development`
in an explicit platform allowlist, makes one Resend-shaped HTTP request to an
in-process `127.0.0.1` fake provider, and maps success/provider failure to distinct
exit codes. Its literal endpoint has no redirects or external fallback. Refusal,
source change and credential revision change before release produce zero app
starts and zero provider requests. App streams are discarded; tests check result,
receipt, fixture files and enclosing output for canary leakage, and close only
their owned child, server, sockets and temporary fixtures.

This proves portable coordinator-to-app behavior against a synthetic provider,
not real email delivery, native approval, actual OS-store access, suspended native
creation, Windows Job Object/descendant ownership, or artifact build provenance.
The synthetic owner starts the child on RELEASE instead of implementing native
suspension. Its confirmed closure and session receipt remain synthetic evidence;
`applicationReadiness` stays `not-verified`, with no application observation or
permission created. No shipped code, production gate or execution callback is
changed by these tests. Actual
Windows functional coverage: `npm run test:local:windows`, using synthetic fixtures
only, without the vault, real app/provider, or approval bypass in production code.
It covers native tree ownership and teardown; a Linux skip is not acceptance.
The Windows synthetic repair and observed functional results are recorded in
`docs/VERIFICATION.md` (2026-10-03). File-symlink safety scenarios remain
unverified on the permission-limited host; non-symlink checks continue. This
evidence does not enable the source gate or authorize a real app/key session.
At this original checkpoint, new-dialog visual checks at 100% and 150% were pending.
The later Windows receipt records the four dialogs at 150%; new-dialog 100% coverage,
real named-app/key acceptance and complete public-release checks remain separate.

### Directory-junction rejection evidence

`npm run test:local:reparse:windows` adds a separate, secret-free test fixture for
permission-limited Windows hosts. It uses `symlinkSync(target, link, 'junction')`
under its own temporary root, verifies `lstat().isSymbolicLink()` and the intended
target, and never requests elevation, Developer Mode or privilege changes. An
unavailable junction or helper is a failed/unverified test, not a passing skip.
This is test coverage only; it does not change the production source gate.

For each project, artifact-directory and interpreter-directory junction, first
capture normal synthetic inputs and obtain the fixed helper's `READY` followed by
`CANCELLED` and closure. Replace that directory with a junction to the same owned
directory and bytes (the artifact target remains within the project). Initial
snapshot capture must reject it; an existing snapshot's `current()` and
`currentWithNativeLocks()` must both return false. The unmodified native helper
must emit only `UNKNOWN`, then close before `READY` or key input. The fixture
never sends a credential envelope or `RELEASE`, requires no `CREATED`/`STARTED`,
and checks that the harmless app's execution marker is absent. This observes
rejection at the protocol boundary, not an exact internal rejection instruction.
Only owned helpers are stopped and awaited; owned junctions are unlinked without
traversing their target before the remaining ordinary temporary tree is removed.
Errors are closed test labels, not paths, input hashes or raw exception text.

The rationale for testing this common guard is narrow: Node v24.15.0's bundled
[libuv Windows implementation](https://raw.githubusercontent.com/nodejs/node/v24.15.0/deps/uv/src/win/fs.c)
(lines 1734–1747; link recognition also at lines 187–249) represents recognized
symlinks and directory junctions as links for `lstat`. The snapshot rejects that
predicate for the input and its ancestors. The native owner separately rejects
the [Windows `FILE_ATTRIBUTE_REPARSE_POINT` bit, 0x400](https://learn.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants)
on pinned handles, including directory ancestors. A successful actual Windows
fixture plus independent review can provide common rejection-guard evidence.
It does not prove coverage of every reparse tag or replace the exact Windows
file-symlink scenarios that previously failed fixture creation with `EPERM`.

Status: the user reported actual Windows acceptance for the junction/consent follow-up: all three native junction cases passed, with three portable-only skips; all four consent-only dialogs returned the expected result and were readable at 150%. See the dated receipt in [VERIFICATION](../VERIFICATION.md). The reviewed development decision below subsequently enables only the existing Windows path.
On other hosts this command runs only explicitly labeled directory-symlink
snapshot smoke tests; Windows junction/native cases remain skipped/unverified.
The prior Windows file-symlink skips remain unverified even if this new suite
passes. Enabling native launch, OS consent-dialog acceptance, a real named-app/key
session and public-release acceptance each retain their separate gates.

Independent review additionally distinguishes native leaf handling: directory
pins use OPEN_REPARSE_POINT, while FileStream can follow a leaf link before the
final-path comparison. The shared 0x400 attribute check alone is therefore not
proof of leaf-file rejection. Microsoft documents that
[GetFinalPathNameByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)
resolves the target, while
[GetLongPathName](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getlongpathnamew)
expands path spelling. Rejection of a redirected leaf by that comparison remains
a source/API inference until observed, not a junction-test result.

With the reported Windows junction results available, an independently reviewed
decision may combine those results with exact Linux file-link checks and the
repeated pre-key snapshot guards to support ordinary-file-only development under
the adopted trusted-app/dependency/same-user contract. It must record the precise
evidence and retain all three Windows file-symlink cases as unverified. That
bounded decision does not require changing OS security settings or pretending
the reparse tags have identical observed coverage. The decision is recorded in the following section; the exact file-tag gaps remain.


### Reviewed Windows development enablement (2026-10-03)

The source gate is enabled for the existing Windows-only ordinary-file path,
following independent source review of the snapshot/path/link checks, pinned
native handles, private protocol, approval and repeated checks before key access
and RELEASE. Evidence combines the reported Windows native lifecycle 17/0/0,
Windows junction 3/0 with no READY/key release on rejected paths, four consent-only
results and user-confirmed readability at 150%, and the Linux exact file-link
regressions. This is a bounded development decision under the already adopted
trusted-app/dependencies/same-OS-user contract.

The exact three Windows file-symlink cases remain unverified. Directory-junction
observations do not establish identical file-tag behavior; leaf final-path
rejection still includes source/API reasoning. No link, hardlink, ordinary-file,
canonical-path, credential-revision, approval or ownership guard is removed. The supported
input remains an ordinary fixed `.cjs` artifact with ordinary ancestors and the
running Node interpreter; unsupported linked paths fail closed. No OS setting
change or broader runner is introduced.

This source change is not permission to execute a user's actual application or
credential, and does not claim real provider functionality. MacOS hosted consent
remains a separate open gate. Public release, its complete display matrix, and
real named-app/key acceptance remain separate. The historical disabled-gate
sections above describe earlier candidates; this decision supersedes their
pending code-enable status only.

The `nativeLauncher` projection reports enabled only on Windows after source acceptance. Other hosts retain the existing closed disabled label; the unchanged runtime platform guard rejects them before approval, key read, native spawn or RELEASE. Status projection does not grant execution authority.


### Local trial observation history (2026-10-04)

The private development CLI adds `connection local observe` and next schema 7's
`localSession` projection. This records what was actually observed in one new
project × Resend × development trial; it does not run the application, contact a
provider, access a credential, request approval, or determine current health.

Before secret retrieval or launch, the existing coordinator durably creates a
schema-2 receipt with a random UUID `executionBasisId` distinct from `attemptId`.
Neither identifier derives from source, artifact, runtime, credential bytes or
recipient data. The existing private in-memory integrity checks and native
protocol remain unchanged. The coordinator saves the closed execution and tree
termination result on finish; process exit itself creates no application report.

An explicit report must match project-derived connection identity, Resend,
development, latest attempt ID, execution basis ID and settled credential revision.
The receipt must be finished with `exited` or `failed`, possible execution and
confirmed teardown, without a session/metadata/credential lock or temporary file.
The current selection must still be that receipt's local managed development
selection revision. Selection timestamps advance monotonically on save, so a
change-away-and-back cannot restore the old binding. Unknown, changed, unstarted,
unfinished, corrupt, legacy-unbound and uncertain-storage cases refuse reports
without clearing or replacing the evidence. A successful report does not grant a
retry, override another failure or enter generic application readiness.

Only these actor-specific closed outcomes are accepted:

- `agent-observed`: `passed`, `failed`, `unknown` for the app behavior actually observed.
- `human-reported`: `received`, `not-received`, `unknown` only from the person's delivery report.

Reports have product-generated timestamps and append in order. They contain no
body, recipient, arbitrary note, source/artifact digest, raw output or secret.
The existing guarded atomic local-session writer stores at most 20 reports per
attempt and 20 prior schema-2 attempts plus the latest attempt. This is bounded
local history, not a permanent audit or cryptographic evidence against the trusted
same OS user. Schema-1 receipts stay readable and cannot receive reports; prior
real delivery is not migrated or attached to new attempts.

`connection local status` and `next --json --offline` return the same history.
Each entry distinguishes latest/past attempt and whether its selection/revision
still matches, changed, is unavailable, or is legacy-unbound. Reading never updates
a report. Locks and unknown lifecycle results retain their recovery requirements;
`applicationReadiness` remains `not-verified` and permission remains `none`.
Next schema 10 additionally summarizes the latest safely bound ended trial's
Agent app result and human delivery report independently in
`localDevelopment.trialObservations`. An absent Agent report leads to existing
app/result evidence review; differing reports by one authority lead to history
review without selecting a later success. It does not infer a launched/running
process from a pending receipt, require a repeated user delivery report, carry an
old pass into a new trial or add an application/provider operation. Existing
receipt/history storage and all execution/report guards remain unchanged.
Generic `connection observe-application`, provider checks, Clerk, credential input,
fresh native approval and secret supply retain their separate contracts.

Portable acceptance is `node tests/local-observations.mjs` after build, also in
`tests/run-tests.mjs`. It invokes the actual private CLI through an owned disposable
compiled fixture with fake keyring/approval/owner seams, one harmless Node app and
no real provider. It observes explicit app/human reports, then restores them through
a separate-process offline next, checks wrong identity/unfinished/unknown/changed/
lock/storage failures and zero extra key retrieval/approval/owner/app during
record/resume. This is synthetic portable evidence, not new Windows native or
real mail delivery acceptance. `vertical-complete` remains open.
