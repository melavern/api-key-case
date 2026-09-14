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

## `next --json` schema 2

The report retains `vault`, `license`, `hygiene`, `secrets`, `targets`, and
`nextActions`. The schema version changes because the closed contract and the
actor for `install-target-cli` change. The generated exact-version protocol
describes schema 2; unfamiliar schemas must not be guessed.

- `host`: closed platform, Secret-input and approval capability, requirements,
  and issue codes. Unsupported hosts/builds/helpers are reported before any
  provider preflight. Windows Hello enrollment and a usable interactive desktop
  are **not** inferred from a helper executable's existence. Old Windows keeps
  Secret input even when high-risk approval is unavailable.
- `setup`: counts of required/registered/missing/unavailable/unsupported names
  and cleanup candidates, plus the next overall registration stage. These are
  counts of names/statuses, never measurements of Secret values.
- `setup.stage: no-required-secrets` and `setup.counts.required: 0` mean only
  that the current API Key Case scan detected no required Secret names. The
  scanner does not cover every language or reference syntax and may have no
  `.env.example` to read, so this result never proves that the project needs no
  Secrets. A known name should be checked directly in its intended scope.
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

`next` remains schema 2 with `setup.deploymentState: not-inspected`.
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
