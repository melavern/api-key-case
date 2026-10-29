# Agent-mediated setup and Free readiness

Status: shipped in 0.9.1 (published 2026-09-14); portable and isolated
Linux-store verification is recorded in [VERIFICATION](../VERIFICATION.md).
Real Agent/Windows/macOS/provider acceptance and the publication record are
in [RELEASING](../RELEASING.md).
This is the current setup contract; older Phase designs retain their history.

The user's existing Coding Agent is the conversational interface. API Key Case
does not add an LLM, account, network listener, chat service, or telemetry event.
The Agent reads a closed status report, explains it in the user's language, and
coordinates the existing CLI operations. Secret input and approval remain in the
existing Human Plane; a chat answer is never an approval credential.

### Generic candidate entry (0.10.0 and later)

The unreleased 0.10.0 candidate's ordinary `agent-init` protocol starts with its
exact-version `secret capabilities` and project-scoped `secret discover`, before
legacy setup. Existing confirmed registrations do not require new input;
selection-required uses the independent Human Plane. An unavailable native route
does not permit a legacy fallback. Placement/app startup retain Pro, exact plans
and fresh native approval, and interrupted effects never authorize replay.

The 0.9.2 protocol and explicit current-CLI mode are preserved. Legacy `next`
and connection guidance remains available for an explicitly requested existing
legacy workflow, not as a substitute for generic discovery. This protocol
change does not publish the candidate or change OS availability.

### Explicit current CLI instructions (private development)

`agent-init --use-current-cli [--host agents|claude|cursor]` binds stdout and the
existing managed block to the running module's built entry and `process.execPath`.
The CLI validates its own package identity/version, entry layout and file
availability, canonicalizes both paths, and rejects a transient `_npx` cache.
It accepts no arbitrary executable/path option and never derives command
authority from project metadata. Default instructions retain the published
version-pinned `npx` entry.

The private mode names version and schema separately, records literal invocation
argv and a POSIX-shell or PowerShell quoted command, and starts with offline
`next`. Registration and existing local operations use that same entry.
PowerShell quoting doubles ASCII apostrophe and all four U+2018..U+201B single
quote delimiters, preserving the exact path characters. See the official
[quoting rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules?view=powershell-5.1)
and [lexer quote set](https://github.com/PowerShell/PowerShell/blob/v7.5.4/src/System.Management.Automation/engine/parser/CharTraits.cs#L251-L260).
Private Node tooling, when present, is resolved only at the fixed path in that package.
It is unavailable otherwise; no helper, installer or public replacement is
invented. Existing owner text, managed-block drift refusal, read-only `--check`
and repeat idempotence still apply.

These paths identify this machine's available CLI, not a portable installation
or durable executable trust assertion. Missing/moved/inaccessible or unsupported
entries require stopping and regeneration from an available trusted built CLI.
Offline reports restore selected environment and advisory historical observations;
they never grant save, provider, execution or retry permission. The private trial
uses this mode as described in [PRIVATE_CONNECTION_TRIAL](../PRIVATE_CONNECTION_TRIAL.md).

## Product contract

- Free includes project diagnosis, readiness inspection, OS-store management,
  and persistent Agent instructions. Deployment still requires Pro, including
  the existing deploy dry-run. No license gate or approval policy is relaxed.
- The regular interaction is a bootstrap prompt, Secret input, and decisions.
  Provider account setup/login, Secret issuance, purchase/license activation,
  and required OS verification are explicit human prerequisites.
- Diagnose the environment before suggesting a purchase. Unsupported operation
  conditions cannot be resolved by purchasing Pro.
- Select the user's intended destination. A detected target is a candidate,
  never permission to configure or deploy to every detected provider.
- Existing `.env` users may register a known name without exposing the file to
  the Agent. The human opens the file and copies only the value into the Human
  Plane. Registration may end the task; the original file is not modified or
  deleted, and deployment remains a separate request.
- Local storage is keyed by scope/project/name, not deploy environment. One
  project/name cannot retain separate development and production values.

## Host conditions

| Host | Free diagnosis / human-terminal save and check | Agent-requested Secret input | Approval, value removal and executing deploy |
| --- | --- | --- | --- |
| Windows 11 build 22000+ with Hello | OS store required for storage | Verified fixed helper and interactive desktop required | Plan plus OS result `Verified`; trusted provider CLI/configuration also required for deploy |
| Older Windows or no Hello | Existing storage/input boundary retained | Available when the Secret-input helper can run | Unavailable; no terminal/chat approval fallback |
| macOS (collaborative verification edition) | Keychain required for storage | AppKit/Security.framework helper and interactive desktop required | AppKit Human Plane plus trusted provider CLI/configuration; actual GUI/Accessibility/architecture acceptance remains open |
| Linux | OS store required for storage; isolated Secret Service verified | Not provided | Not provided for Agent-first use; human-owned terminal and the OS store's own management tools remain the available path |

`agent-init`, `next` and `targets` do not require Pro. `deploy --dry-run` does,
but it never places a value and does not prove that executing deploy is
available. The current Linux dependency may fall back to kernel keyutils;
availability does not identify the backend or prove login/reboot persistence.
These conditions describe implementation limits, not completed OS acceptance.

Every vault, history and provider-login result is scoped to the OS account,
home directory and session of the CLI process that produced it. A Coding Agent
sandbox can therefore report unavailable storage, missing history or no provider
login while a human-owned shell on the same computer can use all three. That is
a current-execution-context result, not proof that the whole host is unsupported.
API Key Case does not inspect another account, copy credentials across contexts,
change permissions or introduce a broker to reconcile those views. The Agent
may re-run status in the intended supported context only when its host already
permits that execution.

## `next --json` schema 12 (development candidate)

The report retains `vault`, `license`, `hygiene`, `secrets`, `targets`, and
`nextActions`. Schema 3 added a nullable, single-service `guidedSetup` for Resend;
schema 4 retained it and added an advisory Resend `connection` projection. Schema 5 keeps those fields and adds
`clerkNative`, a separate metadata-only report for an explicitly selected Clerk/Vercel native profile. Released 0.9.2
returns schema 2. Schema 7 added bounded local trial history; schema 8 adds the advisory
`localDevelopment` continuation and `review-local-development` action described below. Schema 9 added the advisory preparation receipt review; schema 10 added the latest bound trial's separate application/delivery observation summary. Schema 11 added explicitly recorded native inspection/application history. Schema 12 adds managed Clerk/Cloudflare prepared-version app observations. The generated protocol describes schema 12;
unfamiliar schemas must not be guessed. Publishing a new package version remains
a separate gate.

- `clerkNative` reports `inactive`, `selected`, or `unavailable` independently of Resend source detection.
  It contains the exact selected environment, expected Clerk instance type and two fixed setting names/roles.
  It reads only guarded local metadata; configuration remains `not-inspected`, application remains `not-checked`
  and permission remains `none`. It never projects a prior native inspection as current or grants readiness.
  Selected or unreadable Clerk-native metadata suppresses vault registration/cleanup advice for those two names;
  unrelated legacy diagnostics are retained. The whole legacy `next` command is not an offline/no-vault operation.
- Schema 11 adds `clerkNative.applicationObservation` and, for selected Resend/Vercel native intents,
  `connection.report.nativeApplicationObservation`. These restore named caller observations from the existing
  journal against the selected service/environment/project and recorded configuration fingerprint. Observer,
  feature, receipt IDs, target fingerprints, record time/expiry and remaining work remain distinct.
  Matching historical passes are `reported` with `currentHealth: unverified` and `permission: none`;
  the existing `not-inspected` / `not-checked` fields and generic readiness are unchanged. Identical configuration
  reinspection does not renew the app observation. Changed/unknown/expired/interrupted records require review,
  never automatic provider/app calls or another key. See the [native history contract](connection-plan-observation.md#native-inspection-and-named-application-history-private-next-schema-11).
- Schema 6 adds `clerkManaged` for the separate Clerk/Cloudflare selection. It reports exact-environment
  presence/revision, explicit local Worker/account configuration, and the latest matching preparation receipt in
  the existing journal's append order. Resend/native fields and persistent schemas remain unchanged.
  `summary` is a short Japanese explanation; `nextStep` and `review-clerk-managed` suggest review, never execution.
  The projection calls only exact-slot `hasSecret` (a backend may internally read/discard), reads bounded local
  metadata/history, and rechecks intent/full registration state/configuration after the await. Pending, locked,
  temporary or corrupt registration metadata skips presence reads and retains `unavailable` / `unverified`,
  never missing-key guidance. Missing metadata alone still permits a presence check; a confirmed registration
  without a settled record keeps its revision unverified. A registration-state change during the await returns
  `inspection-changed`, including missing-to-pending changes. It adds no provider/availability
  probe, mutation, raw value, permission or retry. The rest of legacy `next` retains its existing probes.
  `version-recorded` is a historical local fact. The receipt's destination hash cannot be independently matched
  to today's configuration without the provider identity, so current destination matching is always unverified.
  Application is always `not-checked`; activation is never inferred. Changed revision/intent blocks reuse; a newer
  unknown attempt cannot fall back to an older success. Missing/evicted history is not proof of no prior effects.
  Locks, temporary files and invalid records remain unavailable and are preserved. With only a managed Clerk
  profile, the existing setup stage is `review-deployment`, not `no-required-secrets`; counts still describe
  legacy scanned secrets, and unrelated diagnostics remain intact.
- Schema 12 adds `clerkManaged.applicationObservation`, using the existing preparation history and observation journal.
  It shows recorded account/Worker/environment/version separately from the current local selection, plus named feature,
  caller authority, outcome, expiry and remaining work. `summary`/`nextStep` distinguish app evidence review from a
  recorded failure and review of a previously observed version. A prepared receipt cannot prove deployment/activation;
  version binding is caller asserted, and activation/current health remain unverified. No app/provider call, new native
  helper or secret read is added. Old target-unrecorded, newer unknown, changed scope/revision/version, interrupted or
  expired records remain inspectable and require review without automatic preparation, key input or activation.
- `connection.status` is `inactive` when there is neither a Resend scan candidate nor a saved intent,
  `not-selected` until the human chooses a route/environment/destination,
  `selected` when strict local intent metadata exists, or `unavailable` when
  that metadata cannot be read safely. `issue` is null or one of the closed
  `metadata-unavailable` / `history-unavailable` codes; neither path exposes
  file paths or parse errors. A selected connection with unavailable history
  remains selected but reports unknown and asks the human to resolve it.
- `connection.report` contains the active Resend environment and route, a
  separate credential/destination/provider/application status, their authority,
  and a derived stage. It never contains a connection ID, project path,
  credential revision, sending-domain value, or Secret value. `legacy-unscoped`
  explicitly marks current v1 vault registration as environment-unscoped.
- `connection set` records only an explicit, closed intent. It performs no
  provider call, Secret read/write, deploy, approval, trust creation, or verified
  claim. Its metadata is a resume hint with no authority.
- The local connection-check candidate adds only explicit fixed Resend credential
  validation through `connection check --service resend --env <environment> --json [path]`,
  using the exact saved selected environment. A mismatch stops before provider work
  and never changes selection. The optional flag preserves the legacy unbound
  invocation, but fresh Agent continuation must supply it. It does
  not check destination or application readiness, send email, or map a legacy key
  to an environment. Released 0.9.2 does not contain this candidate command.
  An absent journal means `not-run`; unreadable history, unsupported CLI/runtime
  and inconclusive external results stay `unknown`. Exact environment slots are implemented separately; live
  destination/application checks retain their own roadmap and acceptance. See
  [connection-check-candidate.md](connection-check-candidate.md).
- The existing MCP `next` surface remains status-only. `connection set` is a
  CLI operation; it is not exposed as an MCP mutation tool.

- `host`: closed platform, Secret-input and approval capability, requirements,
  and issue codes. Unsupported hosts/builds/helpers are reported before any
  provider preflight. Windows Hello enrollment and a usable interactive desktop
  are **not** inferred from a helper executable's existence. Old Windows keeps
  Secret input even when high-risk approval is unavailable.
- `setup`: counts of active required/registered/missing/unavailable/unsupported storage
  requirements and legacy cleanup candidates, plus the overall registration stage.
  With Resend selected, its managed exact environment slot replaces the v1 name
  in these counts. Native/manual and unselected Resend add no vault requirement;
  unrelated secrets keep their existing diagnostics. Legacy facts remain in
  `secrets`. These are statuses, never measurements of values.
- `setup.stage: no-required-secrets` means the current scan detected no required
  names and no Resend intent is active. Zero `setup.counts.required` alone can
  instead mean selection is pending or provider-native needs no vault copy.
  Neither proves that an app needs no credentials. A known name remains
  checkable in its intended scope; do not infer Resend input from counts.
- `secrets[].status: unused` means the current scanner found no reference to a
  registered project Secret. It remains possible that the Secret is used
  manually or through unsupported syntax, so this is a cleanup candidate for
  human review and does not authorize deletion.
- `setup.deploymentState` is always `not-inspected`. This report does not query
  remote Secret presence or equivalence and cannot prove deployment completion.
- `targets[].readiness`: per-environment `blocked` or
  `prerequisites-checked`, closed issue codes, and explicitly unverified human
  interaction / provider write permission. License state is separate.
- `install-target-cli` is an Agent preparation action, subject to host
  permissions and official installation instructions. `review-deploy-setup`
  asks the Agent to diagnose non-secret configuration. Neither action executes
  anything inside the product or grants permission to weaken a boundary.
  A missing login in the sanitized execution context still requests human
  authentication even if the advisory CLI probe reported a login.

Readiness uses the same trusted execution resolver as deploy: concrete provider
configuration, provider-environment restrictions, fixed CLI identity and fresh
sanitized environment. Provider identity/login is probed through that exact
CLI; snapshot changes during the probe produce a blocker. Probe output,
identity, paths, arbitrary errors, argv and credentials are not serialized.
The fixed probe plan is never spawned and does not name a stored Secret.
No vault or Human Plane is passed to this inspector, so it cannot obtain a
Secret, create trust, approve, delete, or deploy. Free and Pro use the same
inspector. `next` retains its pre-existing OS-store availability probe and
existence-only checks.

`prerequisites-checked` is advisory, not an executable permission or purchase
recommendation. Actual deploy rechecks entitlement, the intended operation,
destination, provider account, CLI identity and human approval. Existing remote
values and provider write permissions may still cause a deployment to fail.

For Cloudflare, a real `.env`, `.env.*` (excluding `.env.example`), `.dev.vars`, or `.dev.vars.*` beside
Wrangler configuration is an `unsafe-deploy-context`: Wrangler may load it, so
API Key Case stops Agent-first deploy without reading or changing the file. The
Agent must explain this as an API Key Case safety condition rather than a login
or license failure. Local Secret registration remains available.

## Project flow and resumption

The managed protocol instructs the Agent to explain missing names together,
then open existing input dialogs sequentially. After registration, it refreshes
`next`. It invokes the existing deploy command for each user-requested operation
using the registered scope and explicit target/environment; high-risk calls
open the existing bound Human Plane. Cancellation or failure stops the group.
Only actual operation results are summarized as deployed. The protocol does
not create batch approval, automatic retries, remote status guesses, or a new
unattended execution command. The separate advisory history contract below
adds local operation receipts.

For an existing `.env`, the Agent confirms only required names. The human opens
the file and enters each value directly into the Human Plane; the Agent never
reads the file contents or receives the value. A scanner miss in an unsupported
language or syntax is not a finding that no Secret is needed: a known name can
still be checked and registered directly. Existing entries are never
automatically overwritten.

After interruption the Agent rechecks registration and uses known operation
results for the remaining work. If past deployment results are unavailable,
it says so and clarifies the remaining task rather than redeploying blindly.
If a known Secret is absent from `list` or `next` after an interrupted save,
the Agent runs `check <NAME>` in the intended scope before calling it missing.
Secret-store saving and local metadata/index updating are separate results: if
the store write succeeded but the index update failed, the Agent reports both
facts and uses `check`; it does not repeat `save` or force an overwrite.
Cleanup suggestions remain separate human decisions.

For provider failures, timeouts and unknown outcomes, the Agent explains what
was observed and what remains unknown, then agrees the next action with the
human. It mentions `--force` only when the provider explicitly confirms a
duplicate existing Secret and the human agrees. An incomplete or unknown force
operation may have removed the old value before the add failed, so the same
force operation is never replayed automatically.
Unavailable input dialogs are not retried: the Agent explains the supported
host requirement and the existing manual Free storage option instead.

Human Plane calls remain one synchronous CLI invocation. If the Coding Agent
host yields a live process or session handle while the dialog is open, the
Agent keeps and waits or polls that same invocation for its exit when the host
supports resumption. It does not start a duplicate operation or treat chat text
as approval. A host that cannot resume a yielded process may require a minimal
human completion signal before the Agent can recover the result; API Key Case
does not add a resident service, callback channel or broader privilege to wake
the Agent.

<a id="deployment-history-follow-up--deferred-2026-09-08"></a>

### Deployment history follow-up — implemented in the candidate

The earlier deferral is resolved by the minimal
[value-free deployment history contract](deployment-history.md).
`history --json` is Free and reports past `completed` / `incomplete` / `unknown`
operations; current remote state always remains `not-inspected`. The protocol
reads it on a new chat or resumed deployment task. Existing registry timestamps
can flag a recorded update but never prove unchanged values; destination
selection comparisons cannot prove provider values either. Start persistence,
partial force operations, interruption, result-save failure, bounded retention
and explicit local deletion are specified there. History never grants trust,
approval, automatic replay or an authoritative decision to skip work.

`next` retains `setup.deploymentState: not-inspected` (schema 12 in the
current private candidate; schema 2 in released 0.9.2).
This follow-up adds no new public-release prerequisite.

History report schema 2 now distinguishes an absent journal from unavailable
storage and returns closed cause/recovery codes. The Agent explains start
failures (this invocation made no provider write) separately from result-save
failures (preserve the observed operation result). Lock presence does not prove
a crashed process; writable storage is not inferred from a successful read.
No automated cleanup or redeployment is added; see the history contract's
[diagnostic guidance](deployment-history.md#unavailable-history-diagnosis-and-guidance).

## First-run persistence

`agent-init --host agents|claude|cursor` explicitly selects the current host's
project instruction file, including in a fresh repository. Without the flag,
existing host detection remains unchanged. `--check` writes nothing. Existing
content, drift checks, exact package pins and symlink/junction rejection remain
in force. Global and MCP configuration are untouched.

## Validation boundary

`tests/agent-setup.mjs` exercises Free/Pro parity, unsupported hosts, Windows
build conditions, unresolved projects, sanitized provider probes, probe-time
CLI replacement, provider errors, zero trust/Secret writes, partial registration
and resumption, value-independent output, and fresh-host CLI bootstrap. It is
included in `npm test` and can also run alone after building.

These portable fixtures do not prove real Windows Hello, macOS GUI behavior,
provider write permissions, or every Coding Agent host. A dated fresh-consumer
Codex run is recorded separately in `docs/VERIFICATION.md`; it does not
generalize to other execution contexts. The release checks for 0.9.1 are
recorded there and in `docs/RELEASING.md`. Environment-specific Secret
storage and local application runtime injection are not implemented by this
change.

## Environment credential candidate (original schema-4 checkpoint)

The environment-split candidate originally kept schema 4 and the legacy projections.
Current schema 7 preserves that Resend projection: connection.report uses exact project/environment slots. A legacy key does not
satisfy an environment; register-connection-credential identifies the exact slot.
See [environment-credentials.md](environment-credentials.md) for command, revision,
interruption and native-acceptance boundaries.


### Managed Clerk projection verification (2026-10-04)

The final candidate passed 27 isolated projection cases, existing Clerk lifecycle/native-profile and Agent-guidance
checks, and the isolated full mock-keyring aggregate (240.9s), with unchanged source/compiled-byte evidence.
Final offline installed-package smoke passed with all 177 installed app files unchanged. The added module accounts
for three compiled files; public npm was not changed. No native/store/provider operation or real app authentication
was performed. The new projection adds no such operation; the rest of legacy next still performs existing probes.

An initial aggregate stopped on the newly added schema-key list's incorrect sort order; that assertion was corrected.
A subsequent run stopped in an existing fake-owner terminal classification case with cancelled instead of expired.
The common 1-second fixture lifetime can race the parent's independent deadline according to the code path; no
clock trace established that timing as the observed cause. Only the four terminal-classification cases now use a
30-second lifetime, leaving cancellation/range tests and the existing native 5-second expiry check unchanged.
The final aggregate passed; no new Windows test is claimed. Gitless development preflight was attempted but could
not run (`spawnSync git ENOENT`). Hosted-CI startup limitations remain disclosed, not counted as passed checks.

### Explicit offline status (private schema 6 variant)

The supporting private built CLI accepts `next --json --offline [path]` so a
project can be reopened without provider login/version probes or network waits.
The ordinary online form is unchanged; public npm 0.9.2 does not support this flag.
There is no new MCP tool or persistent metadata format.

Only offline reports include `inspection` with `mode: offline` and
`provider`, `vaultAvailability`, `gitExposure`, and `gitIgnore` all
`not-inspected`. In this variant `targets: []` means target inspection was
omitted, not that no target is configured. `vault.status: not-inspected` means
the write/delete availability probe was skipped. `hygiene.gitignoreOk: null`
means Git ignore coverage was not inspected. Local source findings still feed
`possibleExposure`; false cannot establish that tracked/history exposure is absent.

The offline branch does not access adapters, readiness/destination resolvers,
provider CLIs, Git subprocesses, destination trust, or `vault.isAvailable`.
Existing `hasSecret` presence reads remain, including legacy unrelated Secret
project/user slots and the selected exact-environment connection slots. The backend may internally read and
discard a value, while the report receives only presence or a closed failure.
These reads do not validate the credential or general store availability.
This is not a claim that every OS backend can answer without OS interaction.

Existing Resend intent/observations and both Clerk profiles remain visible.
An explicitly saved Resend intent is included even if no source reference is
currently detected. Selected exact environments never fall back to another
v2 slot. Clerk preparation remains a past local journal fact; current remote
identity and application use remain unverified. Offline inspection preserves
interrupted records and grants no retry, activation, or deployment authority.

The acquisition guide is omitted. Offline next actions are limited to reviewing
local exposure, unsupported names, selection, metadata, managed Clerk records,
and the local development continuation. Skipped checks never generate login, CLI install, vault-enable,
registration, provider-check, approval, cleanup, or ignore-rewrite directions.
`setup.stage` is advisory review (or review-exposure), not a readiness verdict.
Use the normal guarded operation only when the user intends that operation;
an Agent must not silently follow offline status with an online probe.

Nested `connection.report.stage` and recovery can still describe registration or
provider verification as unfinished work based on actual presence/recorded facts.
They are advisory, not executable permission; the filtered offline `nextActions`
is the immediate status-review guidance. A genuinely observed missing slot is
still missing. Do not infer it from skipped provider/store-availability checks.

Verification (2026-10-04): the frozen behavioral candidate passed the isolated
mock-keyring aggregate in 245.6 seconds, including the new 11-case offline suite
and prior service/placement/local-session coverage. Subsequent edits only clarify
generated guidance/docs and assert the advisory-stage distinction in that suite.
Final build passed; the updated 11-case offline suite passed in 1.7 seconds and
Agent guidance in 3.6 seconds. The final offline installed-package smoke passed
with 177 allowlisted files unchanged, using the explicit unavailable keyring mock. Shared
preflight was unavailable because this materialized checkout lacks Git metadata;
this is not a preflight pass. Hosted CI is not claimed passed. No actual native
store, provider login/write, live key, app use, release, or UI change was performed.


### Local trial history in next schema 7 (2026-10-04)

Schema 7 adds `localSession`, the same metadata-only projection as private
`connection local status`. It returns bounded timestamped reports for new local
Resend development attempts, separate from generic `connection.applicationCheck`.
An opaque execution basis binds each explicit report to its latest completed
attempt, settled credential revision and unchanged selection. Agent app observations
and human delivery reports use different closed outcomes. No report establishes
current health, generic ready state, permission or automatic retry. Past attempts
and changed selections/revisions remain visibly historical. Legacy receipts cannot
be backfilled. Offline reading performs no provider or application execution.
See [local-application-handoff.md](local-application-handoff.md#local-trial-observation-history-2026-10-04)
for the exact recorder and refusal contract. Published npm 0.9.2 is unchanged.


### Selected Resend acquisition guidance (2026-10-04)

The existing guide shape now uses only the selected managed project/environment
slot. It is omitted before selection, for provider-native/manual, unsupported
local environments, offline inspection or uncertain history/session ownership.
A v2-only registered credential is stored even with no v1 key; v1-only, user
legacy and another environment remain missing for this target. No legacy data
is copied, migrated or deleted, and no Resend cleanup action is proposed to
repair the selected route. Related legacy facts remain explicit.

The state store exposes a closed read of existing registration metadata only,
so pending, lock/temp/invalid storage and a read-time change cannot become
missing input guidance. This adds no persistent schema, native operation or
Secret value access. Genuine missing uses `register-connection-credential` and
the selected environment's existing Human Plane. A stored local development
selection guides the separate local status/inspect path; generic local planning
remains unsupported and trial history retains permission none/not-verified.
See [guided-setup.md](guided-setup.md) for acquisition and resumption details.

### Local development continuation in next schema 10 (2026-10-04)

`localDevelopment` is null for absent/non-local Resend selections. A saved local
selection receives closed host/profile support, exact-slot credential presence and
registration revision status, previous-attempt classification and a `nextStep`.
`review-local-development` is always an Agent review action, including offline.
It supersedes the generic local `handoff-pending` advice for this bounded workflow;
the generic plan itself remains unsupported. Schema 9 restores the metadata-only
preparation receipt from explicit inspection in the existing observations journal.
Schema 10 projects `trialObservations` from the existing latest bound exited/failed
trial with confirmed teardown. It adds no runner, build execution, destination
resolver, durable schema or execution authority.

| nextStep | Agent continuation |
| --- | --- |
| `review-local-state` | Metadata/history is unreadable or changed during inspection. Preserve it and review existing status. |
| `review-previous-attempt` | A lock, unfinished trial, uncertain teardown or interrupted outcome needs owned-session/result review. |
| `review-selection-change` | Selection/revision changed or the receipt is legacy-unbound. Keep prior evidence historical. |
| `review-host-support` | This profile/host/approval capability is unsupported. Explain the limitation without requesting new keys or acceptance reruns. |
| `review-credential-state` | Presence or settled revision is unresolved. Review existing registration; do not infer missing. |
| `review-credential-input` | The exact selected slot was observed missing on a supported profile. Offline only reviews; a separately requested supported online diagnosis may guide the existing Human Plane. |
| `review-local-preparation` | Review the earlier inspection candidate and current metadata. Reuse unchanged artifact for explicit inspection; distinguish input/artifact/runtime/selection/credential changes and expiry. Never grant readiness/permission or automatically rebuild/run. |
| `prepare-and-inspect` | Registered/settled selection with no prior attempt requiring review. Inspect ordinary app/build inputs, reuse an appropriate existing artifact or build only when needed, then use the existing explicit local inspection. |
| `review-trial-observations` | A bound exited/failed trial has confirmed teardown. Explain its app and human-delivery reports independently without repeating finished operations. |
| `review-application-observation` | The ended trial has no recorded Agent application result. Review the saved app and existing result evidence for the requested feature; record only what was actually observed. Preserve any delivery report separately. Missing records do not authorize another launch/send. |
| `review-mixed-observations` | One authority has differing recorded outcomes. Review the original reports and explain their scope, preserving all outcomes instead of selecting a later success. No mandatory repeat user action is created. |
| `review-unstarted-attempt` | The receipt records no launch. Explain the remaining task and require a fresh request before another run. |

Build and inspection are always `not-inspected` here: `next` neither runs them
nor treats a past preparation receipt as a current result. This does not establish that they never happened.
The Agent checks the app's existing ordinary files and the explicit
`connection local inspect` result; a human need not rebuild a test sample or
restate the app/environment/registration because a new conversation started.
No observation means not reported, not failed. App-source edits keep trial reports
historical and cannot make today's feature ready. `support: reviewable` describes
host prerequisites only, never Windows Hello enrollment or actual approval.

`trialObservations` is null without a safe current-selection/revision binding, on
unknown ownership, unfinished/unstarted/interrupted/legacy attempts, unavailable
history or a read-time state change. Otherwise it contains only the opaque
`attemptId`, `agent` (`not-reported`/`passed`/`failed`/`unknown`/`mixed`) and `human`
(`not-reported`/`received`/`not-received`/`unknown`/`mixed`). Equal repeated reports
keep their outcome; differing reports, including unknown then pass, remain mixed.
App and delivery results do not conflict merely because they differ across roles.
Only the latest trial is summarized; a new trial never inherits a prior pass or
received report. Full history remains unchanged. These are historical observations,
not current readiness, feature success inferred from process exit or retry authority.
No record means not reported, rather than proof that no one checked. Agent review
uses saved project/environment and existing evidence; it asks only for genuinely
missing information/effect consent, without repeating a delivery report already
present or asking for the same app/key setup because a conversation restarted.

The existing selected-slot/intent guards are retained. Local-session and preparation-record snapshots
before awaited presence reads must still match afterward, and selection/registration
are rechecked before continuation/input advice. Read-time changes produce review
rather than absence, another key request or a retry. Online selected-local advice
no longer automatically points back to a provider credential check or generic
destination setup. Unrelated diagnostics and hosted/Clerk profiles retain their
contracts. `localSession`, including its retry and history fields, is unchanged.
Permission is always `none`; current application readiness is `not-verified`.
Actual execution still requires an explicit scoped app/effect request, Pro and
fresh native approval through the existing operation. Published npm 0.9.2 is unchanged.
