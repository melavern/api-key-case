# Verification record

What has actually been run against real systems, with the evidence to back it
up. A separate, unpublished release checklist decides *whether we may ship*;
this file records *what was proven, when, and how to reproduce it*.

A claim belongs here only if it was observed. "The code does X" is not
verification; a run that shows X is. Where something is unverified, or rests
on a memory rather than an artifact, this file says so — an honest gap is more
useful than a checkbox that nobody can trace back.

Read the dated sections as observations of their stated revision, not as
interchangeable results for the current candidate. The [release checklist](RELEASING.md#agent-first-candidate-status--2026-09-08)
tracks remaining acceptance. In particular, the [later Windows v1 decision](design/windows-human-verification.md#7-elevated-broker-v1では採用しない)
retains in-process verification and does not adopt the elevated-broker PoC;
the older research stop below is not a requirement to finish that broker.

## 0.9.1 published and verified from the outside — 2026-09-14

Base: Public `main` `f0c2a931cf1eeb7e0e6bddb351ee220bba77da2e`, exported from
Private `main` `c656505`; annotated tag `v0.9.1` (tag object `de6f931`,
tagger the public maintainer identity) points at that commit.

**Observed, not inferred.**

- The Public CI run on `f0c2a93` passed all nine jobs (Node 20/22/24 on
  Ubuntu, Node 24 on macOS and Windows, package lane, keyring e2e on all
  three OSes) and CodeQL passed. The tag-triggered Publish run
  `34772659529` passed its actor/repository, version, annotated-tag identity
  and target, `origin/main` ancestry and Public-visibility checks, then
  `npm ci`, `npm test` and a dry run, and published with no `NPM_TOKEN`
  through npm Trusted Publishing; npm attached SLSA v1 provenance naming
  `melavern/api-key-case@refs/tags/v0.9.1` at `f0c2a93` from
  `.github/workflows/publish.yml` (Sigstore log index 2820561074).
- Registry: `api-key-case@0.9.1`, `latest` → `0.9.1`, integrity
  `sha512-HLwOOUaoU1QTbr/…` identical to a local `npm pack --dry-run` of the
  same source, 129 files, `gitHead f0c2a93`, `license Elastic-2.0`.
- From a disposable directory with an empty npm cache and no repository
  checkout: `npx --yes api-key-case@0.9.1 --version` printed `0.9.1`;
  `npx --yes api-key-case@0.9.1 scan .` produced the expected report for a
  fixture project; `npx --yes api-key-case@latest --version` printed `0.9.1`;
  the installed consumer's `npm audit --omit=dev` reported 0 vulnerabilities
  and `npm audit signatures` verified registry signatures and attestations.
- An anonymous `git clone` of the Public repository resolved `HEAD` and
  `v0.9.1^{}` to `f0c2a93`; reachable authors are the public maintainer
  identity (current and pre-rename spellings of the same account) and
  Dependabot.
- The landing page publish gate was opened after those checks and the site
  deployed to Pages production (deployment `f4d7b6c5-7653-43c4-90ac-2bd75dcb44e3`).
  All 17 deployed assets are byte-identical on `api-key-case-lp.pages.dev`;
  the custom domain whose TLS this Ubuntu host can verify serves the same
  pages (after reversing Cloudflare's email obfuscation only), with the
  exact-version setup prompt, the live checkout link, and the legal,
  os-support, npm and GitHub links.

**Not verified here.** `https://apikeycase.melavern.com` and
`https://apikeycase-license.melavern.com` could not be fetched with a trusted
certificate chain from this host's network (an intercepting proxy certificate
is presented); their external check was handed to the owner's browser. No
purchase, license exchange or `license activate` was performed for this
release; the earlier controlled test-mode record remains the evidence.

## GitHub Actions re-enabled; portable/keyring CI on all three OSes — 2026-09-12

Base: Private `main`, candidate 0.9.1. This closes the gap noted in the
[2026-09-08 Ubuntu follow-up](#ubuntu-follow-up-after-windows-acceptance--2026-09-08):
"After Private push `69129bb`, Actions reported repository-wide `enabled: false`
and no CI runs; the repository setting was not changed." That prior observation
only recorded the fact; this entry changes it, on explicit authorization to do
so for this repository only.

**Root cause, measured, not assumed.** the repository's Actions permissions endpoint
returned `enabled: false`. This is a per-repository setting on a personal
(User-owned, non-org) account, so it has no owner-wide or other-repository
scope. `ci.yml` and `codeql.yml` were registered with workflow `state: active`
and had run count 0 against `main` despite real pushes landing there; GitHub's
own "dynamic" system workflows (Dependabot version updates, the Copilot
PR-review agent) had continued to run because they are not gated by this
switch, which is what made the repository look active in a run-history glance.
Separately, `e2e-deploy.yml` and `publish.yml` carry their own **per-workflow**
`disabled_manually` state, set roughly one minute after each was first
registered — a distinct, deliberate control, left untouched here.

**Change made.** the repository's Actions permissions update with
`enabled: true, allowed_actions: all`, scoped to this one repository via the
GitHub REST API (not a UI-wide or org setting). No other repository was
touched. `ci.yml` gained a `workflow_dispatch` trigger (commit `93ade82`) so a
rerun can be requested without a new push; its existing `push`/`pull_request`
triggers are unchanged. `e2e-deploy.yml` and `publish.yml` were left
`disabled_manually`.

**Bugs this uncovered, all previously invisible because this CI had never
actually executed:**

1. `tests/run-tests.mjs` `testPhaseELifecycle` compared a removal plan's
   `projectDir` against a raw `mkdtempSync`/`os.tmpdir()` path, but
   `packages/core/lifecycle.ts` always resolves it with `realpathSync` before
   building the plan. Linux/Windows runner tmp paths have no symlink in them,
   so the raw and resolved paths happened to be identical there; macOS's
   `/var` → `/private/var` symlink finally exposed the mismatch. Fixed
   (commit `cf5975c`) with the same `realpathSync.native(...)` wrapping
   already used for the equivalent comparison elsewhere in the same file.
2. The same commit that added a new force-recovery line to the Agent protocol
   text (`packages/core/agent/init.ts`, `a3d7bab` "Clarify U5 recovery
   guidance") also added a test assertion in `testDeployE2E` expecting
   different wording than what it actually wrote. This code path only runs
   when `AGENT_KEY_CASE_E2E=1` drives a real OS vault, so it never ran locally
   (plain `npm test` skips it) and never ran in CI. Fixed (commit `e576484`)
   by matching the test's regex to the wording actually shipped; the
   user-facing guidance text itself was not changed. Verified locally first
   against the real Linux Secret Service (`npm run test:keyring:linux`: all 3
   strict real-store E2E blocks passed) before pushing.
3. **Fixed (commit `255ab6e`), test-harness only; no product change.**
   `test (windows-latest, node 24)` failed `runDeploymentHistoryTests`
   (`tests/deployment-history.mjs:84`, `assert.ok(report.entries.every((entry) =>
   entry.localRegistration === "update-recorded"))`), and `keyring e2e
   (windows-latest)` failed on the same crash before reaching the real-vault
   section. The prior entry suspected the `realpathSync` vs
   `realpathSync.native` split between `deriveProjectId` and
   `packages/core/deploy/history.ts`; that was measured, not assumed, with a
   throwaway probe run on `windows-latest` (run `34670571371`, on a temporary
   branch since deleted, never on `main`):

   - `os.tmpdir()` on the hosted Windows runner is the 8.3 short name
     `C:\Users\RUNNER~1\AppData\Local\Temp`. `realpathSync` keeps
     `RUNNER~1`; `realpathSync.native` expands it to `runneradmin`.
     `process.cwd()` (`D:\a\...`) and `RUNNER_TEMP` (`D:\a\_temp`) have no
     8.3 component and the two resolvers agree there.
   - So `deriveProjectId(project)` (`c755e0a8b37b8292`) differed from
     `deriveProjectId(realpathSync.native(project))` (`05485fa035ff2496`), and
     `DeploymentHistory.registrationUpdatedAt()` returned `null` for an index
     entry the fixture had keyed by the short-name identity.
   - **Why this is not a product defect.** The test fixture wrote
     `~/.api-key-case/index.json` directly with `deriveProjectId(<8.3 path>)`
     and then opened `DeploymentHistory` on the same raw path. The product
     cannot reach that pairing: `runDeploy` (`packages/core/deploy/engine.ts`,
     "the project identity changed") refuses every executing project-scoped
     deploy whose `request.projectId` is not `deriveProjectId(realpathSync.native(dir))`,
     *before* a receipt is written, so every recorded `registrationUpdatedAt`
     and every later inspection derive the identity from the same
     native-canonical directory. The developer's own Windows machine never
     showed this because `%TEMP%` there is `C:\Users\<account>\...`, not an 8.3 name.
   - **Fix.** `tests/deployment-history.mjs` and `tests/run-tests.mjs` now
     canonicalize their `mkdtempSync` root with `realpathSync.native` — the
     form a shell hands the CLI as cwd. `run-tests.mjs` needed the same
     treatment because its Phase D/E deploy tests, which had never executed
     on this runner (they sit after the history test in the same process),
     would otherwise have tripped the engine's identity recheck for the same
     reason. `deriveProjectId`, vault account naming, the history journal key,
     destination trust fingerprints and the engine recheck are unchanged, so
     existing stored Secrets, receipts and trust records keep their identities
     on every OS.
   - **Residual, by design.** On Windows a cwd that itself contains an 8.3
     component yields a different vault project identity than its long-name
     spelling, and `deploy` from such a cwd is refused by the identity recheck
     (fail closed) rather than deployed under a merged identity. Real shells
     hand over long names, so this was not changed here; unifying the two
     resolvers would re-key existing project-scoped vault entries and is a
     separate, reviewed decision if ever wanted.

**Runs, in order, each on `main`:**

- Actions run `34669580280`
  (commit `93ade82`): first run after re-enabling Actions. `package` and
  `test (ubuntu-latest, node 20/22/24)` passed. `test (macos-latest, node 24)`
  failed on bug 1 above. `test (windows-latest, node 24)` failed on bug 3.
  `keyring e2e (ubuntu/macos/windows)` all failed on bug 2 (windows also hit
  bug 3 first).
- Actions run `34669785922`
  (commit `cf5975c`, bug 1 fixed): `test (macos-latest, node 24)` passed.
  `test (windows-latest, node 24)` and all three `keyring e2e` legs still
  failed as before (bugs 2 and 3 unfixed at this point).
- Actions run `34670069746`
  (commit `e576484`, bug 2 also fixed): `package`; `test` on ubuntu-latest
  (node 20/22/24) and macos-latest (node 24); `keyring e2e` on ubuntu-latest
  and **macos-latest** all passed. `test (windows-latest, node 24)` and
  `keyring e2e (windows-latest)` still fail on the open bug 3.
- Actions run `34670958401`
  (commit `255ab6e`, bug 3 fixed): **all nine jobs passed** — `package`,
  `test` on ubuntu-latest (node 20/22/24), macos-latest (node 24) and
  windows-latest (node 24), and `keyring e2e` on ubuntu-latest, macos-latest
  and windows-latest. The Windows keyring leg logged `real keyring e2e blocks
  passed: 3` under `AGENT_KEY_CASE_E2E_STRICT=1`, i.e. against the runner's
  real Credential Manager, not a skip. The same nine were green first on the
  temporary probe branch (run `34670730786`) before the fix was moved to `main`.
  No Windows real-machine (Human Plane / ConPTY) verification was rerun; the
  change touches test temp-path setup only.

**macOS Keychain E2E, specifically confirmed.** In run `34670069746`,
`keyring e2e (macos-latest)` ran `AGENT_KEY_CASE_E2E=1 AGENT_KEY_CASE_E2E_STRICT=1`
against the runner's real login keychain
(`/Users/runner/Library/Keychains/login.keychain-db`, observed via the job's
own `security default-keychain`/`show-keychain-info` diagnostics step) with no
keychain unlock or setup step — matching this workflow's existing design
comment that the runner's login keychain is directly usable. The suite
reported `real keyring e2e blocks passed: 3`. This is the first time this
exact check has actually executed on macOS; it had never run before because
Actions was repository-wide disabled since this repository's creation.

**macOS real-service E2E (Cloudflare/Vercel/GitHub), not run.** `e2e-deploy.yml`
requires `AKC_PRO_LICENSE_KEY`, and per target `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID`, `VERCEL_TOKEN`, or `GH_PAT_E2E` as repository secrets.
`gh secret list` and `gh variable list` on this repository both returned
empty, and the only configured Environment is `copilot` (unrelated, created
by the Copilot PR-review agent). No repository secret exists to satisfy this
workflow's own preflight check. No secret was created as a substitute; this
item is recorded as not executed, not as a pass, per this task's explicit
instruction not to fabricate or work around missing repository secrets.
`e2e-deploy.yml` itself was left `disabled_manually` and was not enabled or
dispatched.

**What GitHub Actions can and cannot settle, restated for this entry.** A
green `macos-latest` runner proves portable behavior, the real Keychain via
`@napi-rs/keyring`, and CLI/provider-adapter logic that does not require a
human. It does not touch, and this entry makes no claim about, the Human
Plane GUI on real hardware, actual button/Touch ID input, Accessibility-based
same-user attack resistance, Intel Mac compatibility, or any other
desktop-environment-specific behavior; those remain exactly the open items
already tracked in [the macOS verification plan](design/macos-human-plane-verification.md)
and are not narrowed by this entry.

**Current public handling — 2026-09-13.** Windows 11 with Windows Hello is the
normal support baseline. macOS is a collaborative verification edition while
native GUI approval, Accessibility resistance, Intel hardware and real-Mac
provider deployment remain open; the 2026-09-12 CI result does not change
those limits. Linux retains diagnosis, status/history and human-owned-terminal
storage where its OS store is available, but does not provide Agent-first
input, approval or executing deployment. Its keyring backend and reboot
persistence remain environment-dependent. See the [OS support status](https://apikeycase.melavern.com/os-support)
for the public summary.

## Windows secret input: user scope, real save and the 2560-byte boundary — 2026-09-10

Base: `e54e6a213a896edc8ae347ba78e7b522a2a226a9` (Private `main`), candidate
0.9.1, Windows 11 Home 10.0.26200, Node 24.15.0 / npm 11.12.1, Japanese display
language. Reproduce with `npm run test:secret-input:windows`.

This closes the remaining Windows secret-input acceptance. It does not re-open
the already-accepted project-scope display, long-path layout or Windows Hello
approval results, and no product code was changed for it.

The harness drives the product's own dialog through standard Win32 control
messages. Controls are located structurally, so the run does not depend on
child-enumeration order or on matching a Secret name as a screen-search key:
the Secret field is the `EDIT` control carrying `ES_PASSWORD`, and Save/Cancel
are `BUTTON` controls carrying the product's own English/Japanese labels
imported from the built module. The dialog window must belong to a
`powershell.exe` child of that run's own CLI process, so only the helper the
run started is ever acted on. The driver never reads a password control's
characters back, and the synthetic fixture reaches it only over its stdin —
never as an argument, an environment variable or a file.

Observed, twice in a row:

- **User scope.** The dialog showed the Secret name and exactly the product's
  user-scope destination line (`登録先：現在のユーザー共通`). No project path and
  no project-scope destination line appeared in any control. Closing with the
  product's own Cancel button returned exit 4 with the cancellation message and
  left the name `missing`.
- **Real save.** A short synthetic value entered into the password field and
  saved through the dialog reached Windows Credential Manager: the CLI exited 0
  reporting a Human Plane save, and `check --json` returned `registered`. The
  value was never read back, never appeared in CLI or driver output, and never
  appeared in any project file. After cleanup the name was `missing` again.
- **2558 bytes** (1279 ASCII characters) and **2560 bytes** (1280) were both
  stored successfully. The field reported the full entered length in each case,
  so the dialog did not clip the input.
- **2562 bytes** (1281) was refused whole. The product's fixed over-limit error
  box appeared with its own text, nothing was written to the OS store
  (`check` returned `missing`), the CLI did not report a save, and it exited
  non-zero with the "secure Human Plane secret input is unavailable" message.
  Because the name did not exist beforehand, `missing` is also evidence that no
  truncated value was written.

Every synthetic name the run creates is removed again on the way out whatever
the outcome; a post-run `cmdkey /list` and the registry index showed none of
them left behind.

Not verified here: a **general** Credential Manager write failure. There is no
safe seam for it — reproducing it would mean damaging Credential Manager or
changing OS permissions, which this record will not do. The unit suite covers
the Windows helper's exit-status contract (a helper exit of 10 becomes
`unavailable`, never a claimed save), but the dialog-side `CredWrite`-returned-
false path itself remains **UNVERIFIED** on real hardware.

## Windows-first candidate finalization on Ubuntu — 2026-09-08

Base: clean fast-forward to `fbf120b`, candidate 0.9.1, Linux x64,
Node 22.22.2 / npm 10.9.7. This follow-up changes support wording and public
test portability, not the accepted Windows protocol or approval mechanism.
Windows fresh-consumer and force acceptance below remain the source of truth.
At this 2026-09-08 checkpoint, macOS was recorded as an experimental
contributor-testing edition outside normal support, not a Windows publication
blocker. The current public status is the collaborative verification edition
described above. Its standalone [status and contributor checklist](design/macos-human-plane-verification.md)
separates implementation, historical CI, portable checks and native gaps.

Observed on this candidate with the support-copy changes:

- `npm test`: passed core, generated macOS helper, Agent protocol, LP analytics,
  Worker and site-content checks. The first restricted-sandbox attempt could
  not execute a Git fixture; the normal-context run passed.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `npm pack --dry-run` and `npm pack --dry-run --json`: passed with lifecycle
  checks. The JSON run prepended test stdout; its final JSON array was reviewed.
  128 files, only built CLI/core/MCP and the allowlisted package documentation;
  no Worker, operator notes, tests or unexpected package paths.
- `npm run test:package`: passed actual fresh-consumer installation, runtime
  audit (0 vulnerabilities), exact-version resolution, Agent initialization,
  drift refusal, history/resumption and unsupported-host handling.
- `npm run test:keyring:linux`: passed all 3 strict real-store E2E blocks and
  installed-artifact checks inside a disposable D-Bus/Secret Service session.
  It did not use or replace the user's desktop keyring.
- Local Chromium, 390px and 1440px: the changed LP purchase note and commercial
  disclosure show the macOS limitation and purchase warning with no horizontal
  overflow or page exceptions. External browser requests were blocked. This
  was a copy/reflow check, not a repeat of the previously accepted setup flow.
- Read-only registry check: only 0.9.0 exists and `latest` is 0.9.0. Public main
  was `a19c5a7e12d772f84dc10e88b85aaec7041a910d`. No release or production action
  was performed. The LP publication flag remains false.

The public export review also found that site tests unconditionally opened
withheld LP editorial documents. They now check those sources only when
present; public HTML, pricing/refund/OS copy and the executable publication
gate remain unconditional checks. The targeted site suite passed afterwards.

Limits: no new Windows or macOS native acceptance, no provider writes, no
purchase/refund, mail delivery or DNS change. Price/refund/data-flow wording
was compared with the existing implementation and local pages; this is not a
new legal opinion or live merchant-settings approval. The workspace doctor
reported one unrelated `ai-evidence` lane missing `verify.json`; this did not
block these local checks. New CI results must be read by exact commit; an
existing workflow definition is not a passing run. After Private push
`69129bb`, Actions reported repository-wide `enabled: false` and no CI runs;
the repository setting was not changed.

The first actual export of `69129bb` passed its isolated install/test/pack,
but correctly failed publication checks on private identity fragments in an
older verification paragraph and a synthetic analytics path, plus 10
unclassified paths (8 frozen PoC files and 2 Git-quoted Unicode paths).
The paragraph/path were anonymized without changing the observations or
analytics assertion. The eight PoC files are now explicitly withheld; new
files there still require classification. Path inventories now use Git's
NUL-delimited output so Japanese filenames undergo the existing allowlist
and content checks. No identity/secret scan exception was added.

## Fresh consumer Coding Agent and Vercel force acceptance — 2026-09-08

Scope: a disposable local consumer repository on the same Windows host already
characterized below, candidate 0.9.1 installed from the pre-publication tarball,
Codex CLI 0.153.4, Node 24.15.0, npm 11.12.1 and Vercel CLI 59.11.7. The run
started from the LP-style bootstrap prompt rather than from repository-specific
operator knowledge. The consumer repository and its dedicated Vercel project
remain available for follow-up; neither was deleted after this run.
The installed package reported 0.9.1. The retained candidate tarball's SHA-256
was `66F08ADC700C1EF1B2EBA670A69D411A6DB6974790DF0BB45DE7A062622F69A4`.

### Fresh setup and bounded destination

- `agent-init --host agents` created AGENTS.md in the fresh consumer.
  `next --json` returned schemaVersion 2 and identified `OPENAI_API_KEY` as the
  required missing name. A new Agent chat later resumed API Key Case use from
  that generated file and refreshed status/history without a repeated bootstrap
  explanation.
- A synthetic value was entered and stored only through the Windows Human Plane.
  No Secret value, fragment, hash, length, credential or dialog screenshot was
  requested, read, displayed or retained in this evidence. `.env` and `.env.*`
  contents were not read.
- The operator authorized creation and linking of only the dedicated project
  `api-key-case-preview-verification-20260908` to the disposable consumer. No
  existing Vercel project was linked or changed. No application deployment was
  run, and the selected Secret destination was Preview only.
- The initial preview placement completed. An independent Vercel read-back
  showed `OPENAI_API_KEY` in Preview with Secret type and Hidden display. The
  production environment had no entry for that name.

### Preview `--force` refusal and approval

The same stored synthetic value and the same dedicated project were used for
both attempts. No new project or Secret input was introduced.

1. On the first `--force` attempt, the operator declined/cancelled in Human
   Plane. The CLI returned the high-risk decline result. Independent Vercel
   inspection showed the pre-existing Preview Secret still present with its
   earlier metadata; no deletion/re-add occurred. History gained no completed
   force receipt for the declined operation.
2. On the second identical attempt, the operator approved in Human Plane. The
   provider delete-then-add path completed. Independent Vercel inspection showed
   `OPENAI_API_KEY` still present as Preview / Secret / Hidden with refreshed
   creation metadata, while production still had no entry. History schema 2
   reported the operation as `force: true`, `outcome: "completed"`, destination
   `selection-matches`, local registration `unverified`, and current remote state
   `not-inspected`. Those last two fields correctly avoid claiming value equality
   or turning history into current provider authority.

### Two host observations and classification

| Observation | Evidence and boundary | Classification / action |
| --- | --- | --- |
| A new Coding Agent sandbox could not see the desktop user's Windows Credential Manager entry, project deployment history or Vercel login, while the user's own PowerShell on the same computer could | The vault uses the current OS account's keyring, history uses that process's home directory, and provider readiness/deploy starts the trusted Vercel CLI from the current sanitized execution environment. The negative sandbox result was therefore limited to that account/home/session; it did not establish an unsupported Windows host | **Agent-host execution-context constraint.** Do not bridge profiles, copy credentials, change permissions, elevate, or add a broker/service. **Product-side documentation improvement:** the exact-version Agent protocol now labels status as current-context-only and permits a recheck in the intended supported context only when the host already allows it |
| After Human Plane completed, the Agent did not collect the yielded CLI result until the user sent a completion message | Windows Human Plane already waits for its fixed helper child to exit, and deploy awaits that result before updating history and returning. The Coding Agent terminal yielded a live process/session handle but did not itself trigger a new Agent turn when the process later exited | **Agent-host process-resumption constraint.** A CLI cannot wake the conversational Agent without a separate callback/resident mechanism. **Product-side guidance improvement:** retain and wait/poll the same invocation when the host supports it; if it cannot be resumed, explain the limitation and request only a completion signal. Never launch a duplicate operation or treat chat as approval |

These classifications do not change Human Plane, Secret-value isolation,
approval, provider trust or entitlement boundaries. No resident service,
privilege expansion, approval bypass or cross-account credential mechanism was
added. The first issue remains host-specific unless reproduced from the same OS
account/home/session; the second remains host-specific unless a retained CLI
invocation itself exits before its Human Plane child completes.

### Follow-up product validation

The follow-up changed only generated Agent guidance, its assertions and
documentation; Human Plane, vault, history execution, entitlement and provider
adapter code were not changed. After the change:

- `node tests/agent-setup.mjs` passed.
- `npm test` passed the core, LP analytics, Worker and site-content suites.
- `npm run test:package` passed with package version 0.9.1, 128 allowlisted
  artifact files, a zero-vulnerability fresh-consumer runtime audit, all fresh
  Agent host formats, installed history/resumption and offline exact-version
  candidate resolution.
- Verification hub doctor reported only the already-known missing `verify.json`
  files in the separate `ai-evidence` and `aifree` projects. No hub server was
  started and no external project was changed.

The real Vercel write was not repeated after this guidance-only follow-up. The
accepted Preview Secret and disposable project were deliberately left in place
as requested.

## Ubuntu follow-up after Windows acceptance — 2026-09-08

Baseline: `311adc1` on private `feat/agent-setup-readiness`, candidate 0.9.1,
fast-forwarded from a clean Ubuntu worktree. This includes the Windows provider
acceptance, Vercel preview `--yes` repair, destination-error guidance, and the
macOS approval gap recorded on Windows. Host: Linux x64, kernel
6.11.0-26-generic, Node 22.22.2, npm 10.9.7.

Changes in this follow-up are tests and documentation only. The production
Human Plane, approval/trust/entitlement gates and provider adapters are unchanged.

- `node tests/macos-human-plane-script.mjs` passed. Generated helper JavaScript
  executed against in-memory framework doubles: user/project storage naming,
  update/add selection, refusal without reading input or writing storage,
  blank input, encoding/storage errors, field clearing on handled completion,
  all three decision plans, unknown dialog results, dialog exceptions and
  literal display-text interpolation. The same tests passed inside `npm test`.
  These are portable control-flow results, **not** native JXA, Keychain,
  Accessibility/TCC, GUI or architecture acceptance. In particular the
  affirmative-result test observes the current button-only mapping.
- `npm run test:keyring:linux -- --offline` passed: full build and `npm test`,
  all three strict real-keyring E2E blocks, LP/Worker/site tests, and the
  separately installed tarball against a disposable Secret Service. Installed
  registration/resumption and fail-closed Linux input/removal checks passed.
  The existing runner creates its own bus, data/runtime directories and
  synthetic entries, then cleans them up; it does not use the desktop keyring.
- `npm run test:package -- --offline` passed again with the final SECURITY.md:
  128 allowlisted artifact files, fresh consumer, all Agent-host formats,
  spaces in paths, idempotence/drift refusal, history and offline exact-version
  npx. No dependency audit, registry publication or public bootstrap is claimed.
- The Windows driver's portable tests passed in the full suite and standalone
  outside the sandbox. One standalone sandbox run failed because the child
  exited 0 without an observed `action-returned` marker. A minimal child-pipe
  check and five subsequent complete harness iterations inside the sandbox
  passed. The cause was not reproduced or established; the failed run is not
  a pass, and no missing-evidence check was weakened to accommodate it.
- Initial sandbox attempts could not create the disposable D-Bus socket or
  inspect network interfaces for the verification hub. The same commands ran
  with the required host access. Hub doctor reported only the existing missing
  `verify.json` in the separate `ai-evidence` project; no server was started.

SECURITY.md now discloses that macOS approval lacks the Windows OS identity
check. The [native verification plan](design/macos-human-plane-verification.md)
separates portable evidence from the remaining input, decision, lifecycle,
CLI-discovery and Accessibility measurements, including driver positive controls
and a developer host with Accessibility permission. Disclosure does not close
macOS acceptance or authorize a weaker boundary. No Mac service was provisioned
or remote verification workflow dispatched. No real provider was written, no
user Secret or license was inspected, and no release or LP gate was opened.
Node 20/24 and native Windows/macOS were not rerun in this follow-up.

## Windows native candidate acceptance — 2026-09-08

Baseline: private PR #18, `feat/agent-setup-readiness`, commit
`4c06439efbc085029e441a370d93efa0c0c0d38a`, candidate 0.9.1. The starting
worktree was clean; the previous branch matched its remote, and the requested
branch was seven commits ahead. Fetch, switch and `pull --ff-only` completed
without discarding changes. The observations below include the test-driver
argument-type correction in this section; product code was unchanged.

Environment: native Windows 11 Home 25H2, build 26200.9168, x64;
Node 24.15.0, npm 11.12.1, Windows PowerShell 5.1.26100.9168. The interactive
tests ran as the desktop-owning user at medium integrity, not elevated, in
the Explorer session. The default Codex sandbox uses a different account;
its results were not substituted for that user's desktop/store. Installed
Codex CLI reported 0.153.4; the active session is Codex. No WSL result was used.
The verification hub doctor reported missing `verify.json` in the separate
`ai-evidence` and `aifree` projects. No server was started.

### Observed failure and local correction

- The first `npm run test:human-verification:windows -- probe` failed with
  attacker exit `0xc0000409`. Fixed checkpoints reached `root-received`, then
  `children-received`, and stopped at the second `children-request`. Neither
  `action-start` nor `control-clicked` was established. This was a failure.
- `AccessibleChildren` declared its container as a marshalled `object` even
  though the [native API](https://learn.microsoft.com/en-us/windows/win32/api/oleacc/nf-oleacc-accessiblechildren)
  requires `IAccessible*`. An untyped object can marshal as its default COM
  interface. Changing only that parameter to `IAccessible` made the same probe
  pass for both Yes and Delete, with driver exit 0/action completion and
  independently observed dummy Click events. A portable regression assertion
  now pins the interface declaration. This supersedes the earlier investigation's
  exclusion of the marshaling signature; it does not retroactively make that
  failed run pass. No crash dump containing process memory was collected and
  no OS mitigation, CFG setting or product approval boundary was changed.

### Observed successes

- `probe`: both dummy buttons were actuated by the driver; the human did not
  click them. This establishes driver operation, not a product approval.
- `cancel`: the human selected Yes/Delete and canceled each Hello request.
  Approval and Secret-removal decisions both returned `declined`; exit 0.
- `verified`: the human selected Yes/Delete and completed Hello separately.
  Both decisions returned `approved`; exit 0. This used the already-built
  candidate via `node tests/human-plane-windows-verification.mjs verified`.
- `attack`: its required probe passed again. The sibling MSAA driver actuated
  both product buttons, the human canceled Hello without authenticating, and
  both decisions returned `declined`; exit 0. Crash, timeout, unavailable and
  missing actuation evidence remain failures. These modes use canary plans:
  none executes a provider or deletes a stored value.
- `node tests/windows-verification-harness.mjs` and native `npm test` passed.
  The latter is the portable/fixture suite; its opt-in real-store blocks were
  not enabled and are not counted as real-store acceptance.
- `npm run test:package` passed on Windows: 128 allowlisted files, fresh
  installed consumer, spaces in paths, all three Agent host formats,
  idempotence/drift refusal, history inspection and exact-version offline npx
  resolution. Development and fresh-consumer runtime audits each reported
  zero vulnerabilities.

### Installed candidate and ongoing human acceptance

A separate disposable consumer installed the actual tarball with
`npm install --no-save --ignore-scripts <tarball>`. Artifact SHA-256:
`74048b2edd19d88f5512fc4763c3761e6799f491b76a675d78d6a67d474a3e34`.
With npm offline, the LP's `npx -y api-key-case@0.9.1 --version` resolved to
0.9.1 and its `agent-init .` preserved existing AGENTS.md content and added the
exact-version protocol. No registry `@latest` package was substituted.

Initial `next --json` reported schema 2, available OS store, interactive
Windows input/approval requirements and two missing synthetic project names.
All provider environments were blocked by absent destination configuration;
Vercel CLI was missing, while Cloudflare/GitHub advisory CLI status was ready.
The installed product reported the existing entitlement as Pro through its
status-only interface; no purchase key was returned to the Agent. `history`
reported schema 1, missing local history and `currentRemoteState: not-inspected`.
The Agent explained that registration and past CLI success cannot establish
current remote values. Actual input/resumption/lifecycle and provider acceptance
remain pending below; the initial diagnosis is not their success evidence.

Unverified at this checkpoint: Hello-unconfigured account, actual stored-value
and destination-trust deletion/refusal, human input/resumption, real provider
writes, a separate fresh-chat Agent session, other Windows builds/Node versions,
and macOS. Normal Hello enrollment was not changed. The human also noted that
the product-provided verification copy is English; localization is a usability
follow-up, not an OS verification requirement. No Secret input or Hello input
was captured in screenshots or logs. Nothing was published, merged or deployed.

The correction and the checkpoint above were committed/pushed to the private
PR branch as `9c6b516`; the installed tarball's product files match the baseline
because that commit changes tests/docs only.

Real-provider preparation (read-only): installed `targets --json` observed
Wrangler 4.104.0 and GitHub CLI 2.96.0 with advisory login status true;
Vercel CLI was absent. This does not identify an authorized test account or
prove write permission. Before a provider write, select the account and a
disposable Worker/project/private repository, the environment and one synthetic
name, and obtain explicit approval for that concrete operation. Existing
entitlement status is Pro, but test-use authorization must still be agreed.
Do not provision destinations, install/login to Vercel, or reuse production
resources based only on these probes. Read-back must be names/status only;
cleanup requires a separate decision.

A disposable local fixture was prepared for the remaining human lifecycle
test. It imports the installed tarball, keeps the actual entitlement check,
Human Plane and OS vault, and substitutes only a no-network provider sink.
The sink discards stdin and writes a fixed invocation marker, never a value.
Its initial read-only inspection resolved the synthetic Vercel/preview identity
with trust `unconfirmed`, zero invocations and zero receipts. It has not yet
performed an operation. The planned sequence is input FIRST/save and
SECOND/cancel, resume only SECOND, decline/approve local fixture placement,
decline/approve trust removal, then separately approved Secret cleanup. This
fixture can establish local orchestration, not official-provider compatibility.

### Installed Human Plane input and resumption

Continued on the same native host and installed artifact. The human entered a
synthetic value only in `save AKC_WINDOWS_ACCEPTANCE_FIRST --ask` and saved it.
The following SECOND request was canceled without input. The group stopped
with exit 4 and the fixed message that nothing was saved for that request.
Separate installed CLI processes then reported FIRST `registered` and SECOND
`missing`, both with backend `keyring`. `next` counted one registered/one
missing and requested registration only for SECOND. Targeted Windows
`cmdkey /list:<this-test-account>` independently showed FIRST present and
SECOND absent, without retrieving either value or listing unrelated entries.

After the human agreed to resume, only SECOND's dialog was reopened. Its save
returned exit 0. A fresh `next` reported two registered/zero missing and stage
`review-deployment`; targeted `cmdkey /list` independently confirmed SECOND.
FIRST was not re-entered or overwritten. Throughout both steps,
`setup.deploymentState` remained `not-inspected`, and `history` remained missing
with zero entries and `currentRemoteState: not-inspected`. The Agent described
these as local registrations, not completed remote deployments. These are real
Human Plane/OS-store results, not injected successful save decisions. The
conversation resumed in this existing Codex thread; a separate new-chat host
session remains untested. No input values, partial values, value hashes/lengths,
screenshots or Hello input were collected.

### Real Windows decisions with a local provider fixture

Four sequential human tests used the separately installed artifact's deploy
engine/lifecycle functions, real `assertProFeature`, real Windows Human Plane
and Credential Manager. The adapter and its account identity were explicitly
synthetic, and its fixed local sink consumed/discarded stdin without inspecting,
echoing or saving it. A fixed invocation marker counted executions. This is
**not** a Vercel CLI or real-provider compatibility result.

1. FIRST's first-use Vercel/preview fixture plan was declined with No. The engine
   returned `declined`, fixture invocations stayed zero, trust stayed
   `unconfirmed`, and history stayed empty. The refusal did not place a value.
2. The same plan was requested afresh and approved with Yes plus actual Hello.
   The sink ran exactly once and exited 0, the engine returned `executed` with
   `historySaved: true`, the receipt was `completed`, and the destination trust
   became `trusted`. No approval result was injected or reused by the test.
3. The real destination-trust removal dialog was canceled. Lifecycle returned
   `declined`; trust stayed `trusted`, with the same single invocation/receipt.
4. A fresh removal request was accepted with Delete plus actual Hello. Lifecycle
   returned `forgotten` with both destination and slot records `removed`, and
   a new existence-only read returned `unconfirmed`. The fixture was still
   invoked only once. Neither Secret value was deleted in these four steps.

A separate installed `history --json` invocation returned the retained past
`completed`, `localRegistration: unverified`, `currentDestination: unresolved`
and `currentRemoteState: not-inspected`. The ordinary CLI has no real Vercel
installation/account matching this fixture. The Agent explicitly identified
the receipt as the earlier **local fixture** success, not a current remote
value or permission to retry. Trust removal did not erase that past receipt.
The remaining Secret cleanup requires a separate human decision and actual
removal/refusal evidence; it is not inferred from these trust results.

### Approved Secret cleanup and final scope

The human separately authorized cleanup of the two synthetic project entries.
FIRST's initial removal returned exit 4/`declined`; the installed `check` still
reported `registered`, and targeted `cmdkey /list` still showed its entry.
The intended initial-screen rejection button is **No**, not Cancel; Cancel is
the Secret-input button, while Delete followed by canceling Hello is a different
OS-verification test. This distinction was clarified after the human queried
the wording. No screen or input capture was used to infer an exact gesture.

Fresh removal calls for FIRST and SECOND then each used Delete plus actual
Hello completion and exited 0. Subsequent installed `check` reported both
`missing`, targeted Windows listings each returned no entry, and `next` counted
zero registered/two missing. The fixture's final inspection still showed one
invocation and trust `unconfirmed`. Both synthetic values and both test trust
records are removed; the values cannot be recovered through the product.
The local test files/tarball and value-free past fixture receipt were retained
as reproduction evidence, not counted as credentials or a remote deployment.
Even after removal, history retained that past `completed` while current remote
state remained `not-inspected`; this must not be treated as current storage.
All 120 installed product build files matched the tested checkout by file hash.

The human confirmed no Hello-unconfigured test environment is available here;
a separate PC could be prepared later. `unconfigured` is explicitly unverified,
not skipped-as-passed. Normal enrollment was not changed. The current supported
Windows path is now measured through input, cancellation/resumption, guarded
local handoff, history explanation and approved cleanup. A fresh-chat host
session, real-provider writes, other Windows builds/Node versions and macOS
remain outside this run's evidence. No additional product-code repair was
needed after the MSAA test-driver correction.

Read-only provider preparation additionally confirmed GitHub CLI's active
account as the authorized test account. The proposed disposable repository
in that account did not resolve through the metadata
query; it has not been created or authorized as a write target. Repository
creation, dummy Secret registration and any later cleanup require their
concrete approval. GitHub documents repository Secrets write permission for
[creating a repository Secret](https://docs.github.com/en/rest/actions/secrets#create-or-update-a-repository-secret);
login alone does not prove it. Cloudflare account selection and disposable
Worker, Vercel installation/account/project, and permission to use the observed
entitlement for those external tests remain to be agreed. No live purchase or
license activation was attempted.

One provider-documentation discrepancy was observed while preparing that work:
the current [Vercel documentation](https://vercel.com/docs/environment-variables/sensitive-environment-variables)
describes write-only Secret types, now including Development, and continues to
accept `--sensitive` for type selection. This differs from the older recorded
provider restriction. The candidate's Development plan does not request
`--sensitive` and remains human-approved; no environment/approval policy was
relaxed. Actual official CLI compatibility/type metadata must be measured
before updating public support claims. This documentation observation is not
an executed Vercel test or a claim about the current remote value.

Concrete next external test, **not yet authorized or executed at this point**;
it was authorized and run afterwards, recorded in
[the GitHub section below](#authorized-real-github-provider-write--2026-09-08):
create the private GitHub repository the disposable acceptance repository with
no workflows, bind a new disposable consumer to it, and have the human register
`AKC_WINDOWS_PROVIDER_CANARY` through the Human Plane. After checking the
existing entitlement and destination, use the installed candidate's
`deploy AKC_WINDOWS_PROVIDER_CANARY --target github --env development`:
this adapter maps `development` to a repository Actions Secret, not a GitHub
Environment. Exercise refusal before a fresh approved/Hello-verified call,
then list only Secret names/metadata. Repository creation and that exact write
need prior approval; later Secret/repository cleanup needs separate approval.
Cloudflare needs an explicitly selected account/disposable Worker; Vercel needs
an approved CLI installation, account/team and disposable project first.

### Authorized real GitHub provider write — 2026-09-08

The first real-service provider write. Same native host, same installed
candidate artifact (SHA-256 `74048b2e…4a3e34`) and same repository baseline
`d433476bbf98ce0390a4a93dfef38e6abf66f9d5` as the section above; environment
re-checked as Windows 11 Home 25H2 build 26200.9168 x64, Node 24.15.0,
npm 11.12.1, Windows PowerShell 5.1.26100.9168, ordinary user at medium
integrity in the Explorer desktop session. The human explicitly authorized the
repository creation, the single write, the use of the existing entitlement, and
each cleanup step separately. Cloudflare and Vercel were explicitly out of scope.

Setup. A private, empty, workflow-free repository
the disposable acceptance repository was created with the GitHub CLI. A new
disposable consumer directory (path containing a space) received the same
tarball through `npm install --no-save --ignore-scripts` and reported 0.9.1. It
was bound to that repository as its single `origin` remote, which is what the
GitHub destination projection requires. Installed `targets --json` detected
GitHub from that remote with `gh` 2.96.0 logged in as the authorized test account; Wrangler
4.104.0 was ready but unconfigured and the Vercel CLI was still absent.
`next --json` reported schema 2, plan `pro`, one missing project-scoped name,
`deploymentState: not-inspected`, and GitHub `prerequisites-checked` for all
three environments with `human-interaction` / `provider-write-permission`
unverified, `automatic: []` and `destinationTrust: not-applicable`.

- The human entered a synthetic value only in the product's Human Plane via
  `save AKC_WINDOWS_PROVIDER_CANARY --ask`; exit 0. Installed `check --json`
  reported `registered` with backend `keyring`, and a targeted
  `cmdkey /list:<this-test-target>` independently showed the entry without
  retrieving a value or listing unrelated credentials. Before any deploy, the
  repository's Actions Secrets were `total_count: 0` and history was `missing`.
- **Refusal.** `deploy AKC_WINDOWS_PROVIDER_CANARY --target github --env development`
  printed the plan (`gh secret set AKC_WINDOWS_PROVIDER_CANARY`) and was declined
  with No. Exit 4. The repository still reported zero Secrets, history was still
  `missing` — a declined approval starts no attempt, as specified — and no
  GitHub destination record appeared in `trust status`.
- **Approved write.** A fresh request was approved with Yes plus actual Windows
  Hello completion. Exit 0 with `OK: AKC_WINDOWS_PROVIDER_CANARY deployed to
  github (development)`. The service then listed exactly one repository Actions
  Secret named `AKC_WINDOWS_PROVIDER_CANARY`, created and updated
  `2026-09-08T00:34:32Z`, while the repository's environment list stayed empty.
  That confirms on the real service what the adapter documents: `development`
  maps to a repository Actions Secret, not a GitHub Environment Secret. GitHub
  Actions Secrets cannot be read back through the API at all, so this read-back
  is names/metadata by construction, not by test discipline alone.
- History then reported schema 1, one entry with `outcome: completed`,
  `currentDestination: selection-matches`, `localRegistration: unverified` and
  `currentRemoteState: not-inspected`. `next` moved to stage `review-deployment`
  while `deploymentState` stayed `not-inspected`.
- **Approval is not reusable.** Repeating the identical deploy after that success
  opened the dialog again and was declined with No; exit 4. The remote Secret's
  `updated_at` was unchanged, so the declined repeat neither overwrote the value
  nor consumed a stored approval. `trust status` still listed no GitHub
  destination: a successful GitHub deploy creates no trust record.
- **Cleanup.** `gh secret delete` removed the test Secret and the repository then
  reported zero Secrets. Installed `remove AKC_WINDOWS_PROVIDER_CANARY` was
  approved with Delete plus actual Hello; exit 0, `check` reported `missing`, and
  the targeted `cmdkey` listing returned `* NONE *`. Deleting the repository
  itself was left to the human in the browser: the active `gh` token carries
  `gist`, `read:org`, `repo` and `workflow` only, and the token was deliberately
  not refreshed with `delete_repo` for this test.

Limits of this result. It covers one provider, one environment, one repository
and one Windows host/build/Node version. Cloudflare and Vercel real writes
remain unverified, so the Vercel Development `--sensitive` documentation
discrepancy recorded above is still unmeasured; the Vercel CLI is still not
installed. Neither the value, a partial value, a value hash or length, Hello
input, nor any screenshot was captured, and the placed value was never read back
to the Agent. Nothing was published, merged, tagged or deployed outside this
disposable repository.

This handoff was also the first resumption from a **separate new chat in a
different Agent product** (Claude Code, not the earlier Codex thread). It
correctly treated the retained local-fixture receipt as a past local result
rather than current remote state, and obtained explicit approval before each
external write. It is not evidence for the managed bootstrap protocol: the LP
setup prompt was not pasted and `agent-init` was not run in this new consumer,
so a fresh-host protocol session remains untested.

### Localized and restyled Human Plane — 2026-09-08

The dialogs a human reads were English and drawn with the WinForms defaults.
Three presentation defects were fixed without touching the approval logic:
no font was set, so the dialogs used Microsoft Sans Serif 8.25pt;
`EnableVisualStyles()` ran after the controls were built, too late to apply the
current theme; and there was no Japanese text. The helper now derives its
language inside the fixed PowerShell process from `CultureInfo.CurrentUICulture`
and `CurrentCulture` — either being Japanese selects Japanese — and both
language tables are compiled into every script. No environment variable takes
part in that choice. The helper path, env allowlist, exit-code mapping, HWND
binding, `Verified`-only approval, and the Secret input value path are unchanged.
Display scaling on this host was 100%, so no DPI-awareness P/Invoke was added.

- Portable evidence: `npm test` and `node tests/windows-verification-harness.mjs`
  passed on this Windows host. New assertions pin the OS-derived language
  signals, the absence of any `$env:` read in the dialog scripts, the Segoe UI
  font, `EnableVisualStyles()` preceding the first control, and the presence of
  both language tables in the Secret-input, approval and removal scripts. The
  win32 leg still parses each generated script with the fixed PowerShell.
- Real-hardware evidence on Windows 11 Home build 26200.9168, Node 24.15.0,
  ordinary user at medium integrity: `probe` actuated both dummy buttons by
  driver, `cancel` returned `declined` for approval and removal, `verified`
  returned `approved` for both with actual Hello completion, and `attack`
  returned `declined` for both while the sibling MSAA driver actuated the real
  product buttons and the human never authenticated. All four exited 0.
- This host runs an English display language with a Japanese regional format,
  and the human confirmed the dialogs rendered in Japanese. The `attack` driver
  therefore located and actuated the **localized** window captions and button
  names; widening the driver's accepted spellings did not weaken the result,
  because the window is still bound to the helper PID that run created.

Unverified by this work: an English-only host's rendering on real hardware, a
Hello-unconfigured account, other Windows builds or Node versions, and macOS,
whose dialogs were not changed. Dark mode and per-monitor DPI awareness are not
implemented. The retained 0.9.1 tarball with SHA-256 `74048b2e…4a3e34` predates
this change and no longer matches the checkout; a new artifact must be built
before any further installed-candidate acceptance.

### Authorized real Cloudflare provider write — 2026-09-08

Second real-service provider write, on the same native host and ordinary user.
It used a **rebuilt** candidate: the localization commit above changed product
code, so `npm run test:package` was re-run (128 allowlisted files, fresh
consumer runtime audit clean) and a new tarball was packed from
`0d14b549b4c2c598c09501091e83d245156070b4` with SHA-256
`15cc6272b31e8c4dd9fb5c99f852022c72a8360a5e17dba466629b928eecffd2`. The GitHub
result above was measured on the earlier artifact; these are two different
builds of 0.9.1 and are recorded separately rather than merged.

Setup. The human authorized one disposable Worker in the single account
reported by `wrangler whoami`. `wrangler deploy` was run by the operator, not by
the product — this tool never creates a Worker — producing
`akc-win-acceptance-canary` with `workers_dev = false` and no routes, so it has
no public hostname. A new consumer directory with a space in its path received
the rebuilt tarball.

- **Observed defect, fixed here.** The first deploy was denied before any
  dialog: `wrangler secret put` binds a destination, and the project's
  `wrangler.toml` carried `name` but no `account_id`. That is deliberate —
  wrangler infers the account from a single login, and this tool refuses to let
  a login decide where a Secret lands — and README already documents the
  requirement. But the point of failure did not: the CLI printed only
  `could not be bound to one trusted destination` plus the generic manual
  steps, `next --json` reported `blocked` / `unsafe-deploy-context`, and
  `targets --json` still showed Cloudflare `detected`, CLI ready and logged in.
  A user with a wrangler.toml that works for wrangler had no next step. The
  engine now prints the fixed per-target requirement sentence, held beside the
  checks that enforce it, and a test asserts the denial names it without
  leaking the value. No boundary, schema, issue code or approval policy changed.
- With `account_id` added, readiness moved to `prerequisites-checked` for all
  three environments and `wrangler secret list` was still `[]`.
- **Refusal.** `deploy AKC_WINDOWS_PROVIDER_CANARY --target cloudflare --env production`
  showed the plan (`wrangler secret put AKC_WINDOWS_PROVIDER_CANARY`) and was
  declined with No; exit 4. The Worker still listed zero secrets, history was
  still `missing`, and no Cloudflare destination appeared in `trust status`.
- **Approved write.** A fresh request was approved with Yes plus actual Windows
  Hello. Exit 0 with `OK: ... deployed to cloudflare (production)`.
  `wrangler secret list` then returned exactly one entry,
  `AKC_WINDOWS_PROVIDER_CANARY` of type `secret_text`. Cloudflare does not
  return a Worker secret's value at all, so this read-back is name and type by
  construction. History recorded one `completed` entry with
  `currentDestination: selection-matches` and `currentRemoteState:
  not-inspected`, and `trust status` still listed no Cloudflare destination:
  Cloudflare is never on the automatic-safe allowlist because
  `wrangler secret put` always overwrites.

Limits. One Worker, one account, one environment (`production`), one Windows
host. Vercel remains unverified: its CLI is now installed (59.11.7) but reports
`Logged out`, so the Development `--sensitive` documentation discrepancy is
still unmeasured. Neither value, partial value, hash, length nor Hello input was
captured, and no placed value was read back to the Agent. The Worker was deleted
later in the session under a separate authorization; see the Vercel section's
cleanup note.

### Authorized real Vercel write, and a silent-success defect — 2026-09-08

Third real-service provider write, same native host and ordinary user. It found
the most serious defect of this acceptance run: **the product reported a
successful deploy while the provider had created nothing.**

Setup. The human authorized one disposable project. `vercel project add
akc-win-acceptance-canary` created it in the single team scope of account
the authorized test team; a new consumer with a space in its path was bound with
`vercel link --yes`. That link step also wrote a `.env.local` holding a
short-lived OIDC token; it was never read and is removed in cleanup. The
project `.env` guard applies to Cloudflare only — wrangler loads those files —
so it did not block this target. Vercel CLI 59.11.7.

- **Refusal** behaved correctly: the `preview` plan
  (`vercel env add … preview --sensitive`) was declined with No, exit 4,
  `vercel env ls` stayed empty, destination trust stayed `unconfirmed`, and
  history stayed `missing`.
- **The approved write reported success and wrote nothing.** Yes plus actual
  Hello returned exit 0 and `OK: … deployed to vercel (preview)`, history
  recorded `completed`, and destination trust became `trusted` — while
  `vercel env ls` still listed no variable. A second deploy of a different name
  through the now-trusted destination ran **with no dialog**, as designed for
  the only automatic-safe class in the product, and also reported success while
  writing nothing.
- **Root cause, measured.** `vercel env add <name> preview` asks which Git
  branch a Preview variable applies to. The product's child is non-interactive
  by construction — sanitized environment, piped stdin, no TTY — so the prompt
  cannot be answered. The CLI skips it by itself only when it detects an agent
  in the environment, which is exactly what the sanitizer strips; it then exits
  0 having created nothing, and the engine maps exit 0 to `completed`. A hand
  test from an ordinary shell had succeeded precisely because the agent markers
  were still present, which is how the gap survived until a real write was
  attempted. Reproduced with a diagnostic that re-uses the installed product's
  own `buildTrustedExecution` and `spawnResolvedCli` with a synthetic value; no
  product code was modified to reproduce it.
- Measured against 59.11.7 in the disposable project, synthetic values only:
  `preview --sensitive` created nothing; `preview --sensitive --yes` and
  `preview --sensitive --non-interactive` both created Preview/Secret;
  `production --sensitive` created Production/Secret and never prompts;
  `development` with no flag created Development/**Config**, whose value
  `vercel env ls` then displays; `development --sensitive` created
  Development/Secret.
- **Fix and re-verification.** The adapter now plans `--yes` for `preview`
  only, taking the CLI's documented default of every Preview branch;
  `production` and `development` were measured working and are untouched. After
  rebuilding the candidate (artifact SHA-256
  `de45c5a0a66804eeee761642a3ce6221b41dd0e284cdd6b3029eef7d9597adc7`, 128 files)
  and reinstalling it, the product's own deploy created
  `AKC_WINDOWS_PROVIDER_CANARY` and `vercel env ls` reported it as Preview,
  type `Secret`. Portable tests pin the flag in both the adapter plan and the
  bound execution snapshot.
- **Documentation correction.** The long-standing claim that Vercel's API
  forbids sensitive variables in `development` is false for 59.11.7. Both
  READMEs, SECURITY.md and the adapter comment now say what was measured: the
  value stays readable back because this tool chooses not to send the flag
  there, not because the provider refuses it. The automatic-safe allowlist was
  **not** changed; moving `development` onto it would be a reviewed change of
  that premise, not a flag edit. The older statement in
  [Findings that changed the product or its docs](#findings-that-changed-the-product-or-its-docs)
  is history superseded by this measurement.

Limits. One project, one account, one Windows host. The `--force` pre-step
(`vercel env rm … preview --yes`) was not exercised and may face the same branch
question. Vercel CLI versions older than 59.11.7 were not tested with `--yes`,
and a CLI that does not know the flag fails the deploy rather than storing
something readable. Values, partial values, hashes, lengths and Hello input were
not captured, and no placed value was read back to the Agent — the one visible
`Config` value in `vercel env ls` was the diagnostic's own synthetic string.

Cleanup, separately authorized, corroborated the same defect class a second
time: `vercel project rm <name> --non-interactive` printed its confirmation
question and **exited 0 without deleting the project**, which a caller trusting
the exit code would have read as a completed teardown. Piping an answer from
PowerShell failed too, because PowerShell 5.1 prefixes piped stdin with a BOM
and the CLI read it as "no". Answering from a POSIX shell removed the project,
and `vercel project ls` then showed only the unrelated pre-existing project.
`wrangler delete` behaved differently and correctly: it announced a
non-interactive fallback of "yes" and deleted the Worker, after which
`wrangler deployments list` reported `code: 10007`, the Worker does not exist.
The disposable GitHub repository had already been deleted by the human. The
leftover `.env.local` was removed. The three synthetic Credential Manager
entries were deliberately retained by the human's decision; they hold dummy
values only.

## History failure diagnostics and recovery guidance — 2026-09-08

Baseline: `d433476` on private `feat/agent-setup-readiness`, including the
three Windows verification commits after `4c06439`. They were fetched and
fast-forwarded into a clean worktree before implementation. Their measured
Windows results above remain observations of those builds; this follow-up does
not repeat or supersede that real-host acceptance.
Before committing, the subsequent real GitHub acceptance and localized Windows
Human Plane commits (`5a25173`, `0d14b54`) were also fetched and fast-forwarded;
both their implementation/tests and their verification records were preserved.

On Ubuntu / Node 22.22.2, `npm run test:keyring:linux -- --offline` passed
after the final CLI/MCP wording changes, and again after integrating `0d14b54`.
This ran the full `npm test`, all three strict real-store E2E blocks and the
installed-tarball lane. `node tests/windows-verification-harness.mjs` also passed
its portable checks on the integrated checkout; it did not exercise Windows GUI.

- History inspection distinguished absent and valid-empty journals, confirmed
  lock/temporary-file presence, invalid data, unsupported schemas, unsafe paths
  and oversized metadata. CLI reports carried only the closed `phase`, `issue`
  and `recovery` fields; arbitrary error messages/paths and fixture file contents
  were not returned. Existing locks, temporary files and invalid journals were
  preserved after inspection and failed writes.
- Actual non-root POSIX permission fixtures verified unreadable metadata and
  a readable journal in an unwritable directory. The latter inspected as
  available with `writeAccess: not-tested`, then refused a start with
  `access-denied`. Read-only-filesystem and disk/quota errors were verified by
  closed error-code mapping, not by filling a disk or changing mount state.
- Engine and MCP fixtures verified `phase: start` / `lock-present`, clear
  no-provider-write wording for that invocation, recovery guidance and zero
  provider spawn. After a successful isolated real-store handoff, a fixture
  acquired the actual history lock at result-save time. Engine/MCP retained
  success with `historySaved: false` and `phase: result` / `lock-present`, kept
  the pending receipt unknown, and did not describe it as a start failure.
- Generated instructions distinguished active-or-leftover locks without
  asserting a crash, required inspection after addressing the cause, and kept
  history discard, permission changes and redeployment out of automatic
  recovery. Existing approval, entitlement and destination tests passed.
- The actual tarball remained 128 allowlisted files. Fresh installed history
  report schema 2, unchanged journal schema 1 compatibility, host instructions,
  exact-version offline npx, registration/resumption and removal-refusal checks
  passed. The run was offline; no new online dependency audit is claimed.
- The verification hub doctor reported the existing missing `verify.json` in
  the separate `ai-evidence` project. No verification lane or release gate was
  changed.

This evidence covers Linux and provider fixtures. The new diagnostics have
not been exercised on native Windows/macOS, with real providers, or through a
separate fresh-chat user session. See the [diagnostic contract](design/deployment-history.md#unavailable-history-diagnosis-and-guidance).

## Value-free deployment history — 2026-09-08

On Ubuntu / Node 22.22.2, `npm run test:keyring:linux -- --offline` passed
after the history implementation and its final bounded-read/path checks.
This ran the full `npm test`, all three strict real-store E2E blocks, and the
installed-tarball lane inside the disposable Secret Service.

- Portable history tests passed for fresh-process CLI resumption, missing and
  interrupted attempts, completed/incomplete outcomes, recorded registration
  updates (including user scope across projects), destination changes and
  unresolved probes, project/realpath separation, explicit metadata deletion,
  lock contention, failed final writes, corrupt/oversized/symlink files, closed
  error output and retention of at most 200 attempts. Inspection created no
  metadata, and injected extra fields/provider errors were not returned.
- Existing engine/approval tests ran with a retained past success and still
  rejected unconfirmed destinations, decline, high-risk and cross-project
  operations. A history-start failure blocked before value retrieval/provider
  spawn. A handoff exception left an unknown result. A destination config
  changed during its probe was rejected as unresolved.
- In the isolated real-store deploy fixture, successful handoff produced a
  completed receipt without the synthetic canary or echoed provider output.
  Injected final-record failure preserved the observed successful operation,
  retained an unknown start and warned through both engine and MCP. A
  successful destructive pre-step followed by failed main step was recorded
  incomplete, with the force flag; it was not inferred to have rolled back.
- The actual candidate tarball contained 128 allowlisted files. Its fresh
  install passed history CLI inspection, the generated resumption protocol,
  exact-version offline npx resolution, existing Agent-host/drift checks and
  the installed real-store registration/removal-refusal checks. This run was
  offline; it did not repeat the earlier online dependency audit.
- `node ../ai-config/verify/hub.mjs doctor` reported one workspace issue:
  the separate `ai-evidence` entry has no `verify.json`. No server or lane
  configuration was changed for this task.

These are Linux/fixture results, not real provider writes, Windows/macOS
filesystem/GUI acceptance, an actual Coding Agent following the protocol, or
proof of current remote value identity. History's closed outcomes and timestamp
comparisons deliberately cannot establish that identity. Publication gates and
the remaining acceptance list were not expanded or opened. See the
[history contract](design/deployment-history.md) for retention, interruption,
local deletion, metadata-save failure and the advisory-only boundary.

## Windows test-driver preparation on Ubuntu — 2026-09-08

The Windows verification harness now has a `probe` mode with unprotected
dummy Yes/Delete controls. `attack` and `unconfigured` must pass that probe
before they can test the product. Each actuation is bound to the helper PID
created by this run, in addition to its caption. Both driver completion and
the control's click event are required; failure to operate the control cannot
be reported as a repaired approval boundary.

Ubuntu/Node 22 portable tests passed for probe ordering, blocking product
tests after a failed probe, early and late cancellation, immediate unexpected
approval, driver crash/timeout/spawn failure, missing actuation evidence,
bounded closed diagnostics and actual Node-child timeout cleanup. These tests
are part of `npm test`. The generated JavaScript passed syntax checks; invoking
the real Windows `probe` entry on Ubuntu reported its platform skip.

`npm run test:keyring:linux` then passed with all three strict real-store E2E
blocks, the full suite, and the actual installed tarball. The package remained
125 allowlisted files, the fresh consumer's runtime dependency audit reported
zero vulnerabilities, and partial registration/resumption and Linux removal
refusal passed against the disposable Secret Service.

This is test-infrastructure verification, **not** a Windows API/PowerShell
compilation, MSAA positive-control or Windows Hello result. The previously
observed `0xC0000409` remains unresolved until a real Windows run. Fixed API
checkpoints now retain the last observed stage without returning raw stderr;
no Windows mitigation was disabled. The former fixed delay after attacker
exit was removed because synchronous actuation and a quick human cancellation
can legitimately finish in the opposite order. `attack` now requires actual
driver completion and `declined`; unavailable/crash/timeout does not pass.

Next Windows step: `npm run test:human-verification:windows -- probe`, then
the manual and attack modes in the [Windows verification spec](design/windows-human-verification.md#6-実機検証).
No product behavior, deployment history, provider write or publication was
added by this work. History's unresolved stale-result and interruption rules
are recorded in the [setup follow-up](design/agent-setup-readiness.md#deployment-history-follow-up--deferred-2026-09-08).

## Documentation and release-contract alignment — 2026-09-08

npm still reported 0.9.0 for `latest` when checked; the public `main` commit
was `a19c5a7e12d772f84dc10e88b85aaec7041a910d`. Candidate notices and the
0.9.1 changelog now distinguish that published state from the unreleased work.
Current documentation identifies Free readiness, paid deploy/dry-run, Human
Plane decisions, OS limitations and the user's own Agent as the explanation
surface. Older TTY/design examples are explicitly historical. Legal-page
changes describe existing product behavior and data flows; they do not change
price, refund period or license entitlement, or establish legal compliance.

`npm test` passed on Ubuntu/Node 22, including the revised MCP handoff wording,
LP analytics, Worker and site-content checks. Package dry-run with lifecycle
scripts suppressed after that suite listed the same 125 package files.
The 51 added/changed local Markdown links and their heading anchors resolved.
Local Chromium at 1440 × 900 and 390 × 844 rendered the Terms, Privacy and
commercial-disclosure changes without horizontal overflow or page exceptions;
the edited sections were visually checked. HTTP(S) requests were blocked.
These checks did not publish the documents or establish actual Agent, OS
approval, provider write or sales acceptance.

## Ubuntu artifact and real-store verification — 2026-09-08

The 0.9.1 candidate was additionally exercised on the Linux development host
with Node 22.22.2 through two repeatable lanes:

- `npm run test:package`: the actual tarball contained 125 allowlisted files.
  It installed in a fresh directory with spaces, without the development
  checkout's node_modules or development dependencies. Both the installed CLI
  and npm executable discovery returned the candidate version. Fresh
  `agents`/`claude`/`cursor` bootstrap, no-write checks, repeat initialization,
  edited-instruction refusal, schema-2 diagnosis and a closed missing-path error
  passed. No package was published.
  An offline invocation of the generated exact-version `npx` command also
  resolved the locally installed candidate and returned schema 2. This allows
  pre-publication testing by installing the candidate tarball in a disposable
  project first, rather than fetching an older registry release.
- `npm run test:keyring:linux`: a new D-Bus session and new XDG data/runtime
  directories hosted a foreground gnome-keyring daemon. The full `npm test`
  passed with `AGENT_KEY_CASE_E2E=1` and `AGENT_KEY_CASE_E2E_STRICT=1`; all three
  real-store E2E blocks ran, rather than skipping an unavailable backend.
  These cover save/check/delete, lifecycle refusal/preservation, and the
  store-to-fixture-CLI handoff/redaction path. Approval and destination trust
  are fixtures in this lane, not OS decisions or a real provider write.
- The installed tarball then used that same disposable Secret Service for
  two synthetic entries. Independent D-Bus `SearchItems` queries observed
  zero, one, then two item paths, proving the values went to this service.
  No D-Bus value retrieval was used. Separate CLI invocations reported partial
  registration and completion of local storage without claiming remote
  deployment. Linux `save --ask` declined the unavailable Human Plane and
  `remove` refused without deleting the stored entry. Test entries, the daemon,
  bus and temporary directories were cleaned up.

The same built candidate also passed the four portable test scripts on official
Linux x64 Node v20.20.2 and v24.20.0 archives, checked against Node's published
SHA-256 sums before execution. The strict real-store and installed-artifact
lanes above were run on Node 22.22.2; this does not imply those lanes ran on
every Node version or on another OS.

The attempt to model a wholly unavailable vault by removing D-Bus exposed a
test assumption: `@napi-rs/keyring` 1.3.0 can fall back to kernel keyutils, and
availability remained true on this host. That matches its
[Linux builder](https://github.com/Brooooooklyn/keyring-node/blob/v1.3.0/src/linux_credential_builder.rs).
The artifact test now checks the observed status and continued Human Plane
handoff; it does not call this a failed vault. The total-unavailability case
remains covered by the existing injected-vault tests. Neither availability nor
this run proves persistence across login/reboot or backend migration.

Runtime dependency audit initially reported `fast-uri` as high and `qs` as
moderate. The locked dependencies were updated to 3.1.7 and 6.16.0 respectively;
the existing fast-uri override floor is now 3.1.6. Maintainer advisories document
the [fast-uri fix](https://github.com/fastify/fast-uri/security/advisories/GHSA-f65p-4m7j-42xc)
and [qs fix](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g).
`npm audit --omit=dev` subsequently reported zero vulnerabilities for both the
development lockfile and the fresh consumer installation. This is a dependency
audit result, not evidence that the application was exploitable or a general
security guarantee. The initial offline install lacked cached registry metadata;
online installation succeeded without changing the SDK version requirement.

Remaining before the Agent-first release: an actual user's Coding Agent
following the bootstrap protocol, real Windows Hello and macOS dialog results,
and actual authorized provider writes. Windows's previously broken attack
harness still needs a valid test run. The npm release/public-export checks and
LP human publish gate also remain separate; this work did not publish, deploy,
purchase, alter provider accounts, or introduce Linux deployment support.

## Agent-mediated setup and Free readiness — 2026-09-08

The candidate was built and tested on the Linux development host with Node
22.22.2. `npm test` passed: the portable core/CLI/MCP suite, LP analytics,
license-exchange Worker, and site-content checks. The new
`tests/agent-setup.mjs` cases cover Free/Pro readiness parity, host/build
limitations, trusted provider probes, mid-probe CLI replacement, closed errors,
partial registration/resumption, and explicit first-run host instructions.
The Windows helper's fixed system paths now use `path.win32.join` so these
existing boundary assertions also run with correct Windows paths on Linux.

The local LP was exercised in headless Chromium at 1440 × 900 and 390 × 844
using CDP mouse and keyboard input. All three primary CTA placements copied
the setup prompt. With a synthetic Clipboard API denial, the source disclosure
opened, the textarea received focus, and the full prompt was selected for
manual copying. Enter activated the focused CTA after restoring clipboard
success. Both widths had no horizontal overflow and no page-script exceptions.
Screenshots of the three-step and pricing sections, including the newly added
prerequisite copy, were visually checked at both widths.

This browser review loaded the repository HTML locally with external network
requests blocked and a controlled Clipboard API stub. It verifies the page's
success/failure handling, not real OS clipboard permissions or deployed assets.
The actual user's Coding Agent following the whole setup protocol, Windows
Hello, macOS dialogs, real OS-store E2E and provider writes were not exercised
in this run. Their existing release checks remain open; the LP publish gate
was not changed.

## Windows elevated broker decision-point PoC — 2026-09-05

Commit `3f87fdb` is not a completed repair. Although its fixed PowerShell
helper requests Windows Hello, the Agent-facing parent still converts a helper
exit code into `approved`; a sibling able to substitute that observed process
result can therefore bypass the intended boundary. Production integration is
stopped.

An isolated native PoC lives under `poc/windows-elevated-broker/`. It does
not read Credential Manager, use a real Secret or provider credential, contact
a provider, or modify `packages/`. The high-integrity broker—not an Agent-side
parent—keeps the `UserConsentVerifier` result and conditionally launches only a
local canary provider fixture with the bound interactive user's medium token.
The durable sanitized run record and exact remaining conditions are in
`poc/windows-elevated-broker/EVIDENCE.md`.

Measured on Windows `10.0.26200.9168`:

- The dependency-free x64 PoC built successfully with the OS .NET Framework
  compiler.
- A direct medium-integrity broker launch failed closed with exit 70 before
  identity lookup, Windows Hello, canary generation, or provider spawn.
- In the completed UAC run, the broker was primary/high/full; fixed Explorer
  was primary/medium/limited; and the broker's linked context was
  impersonation/medium/limited. Their OS-derived SID and session facts matched,
  and Explorer/linked `AuthenticationId` matched. The broker-owned HWND then
  received `UserConsentVerificationResult.Verified`.
- Provider path, file identity, timestamp, size, and SHA-256 matched at every
  boundary. A held lease made a mutation open fail with
  `ERROR_SHARING_VIOLATION`.
- `CreateProcessAsUserW` failed with Win32 error 1314. The documented
  `CreateProcessWithTokenW` alternative launched the snapshotted native fixture
  with the duplicated bound shell token. The child was primary/medium/limited
  in the same SID/session/authentication context, the broker stayed high/full,
  the fresh environment was allowlisted, the image matched, and the 32-byte
  in-memory canary round trip matched exactly; child exit was 0.

Both Decision Points are **条件付き成立**, not a production approval. DP1 was
proved only for a same-account split-token administrator; a standard desktop
user entering another administrator's UAC credentials remains unsupported.
DP2 was proved only with the native fixture and the
`CreateProcessWithTokenW` ordinary-`STARTUPINFO` fallback; the tested explicit
handle-list variant returned Win32 error 87. A real provider/profile, protected
installation, bootstrap/IPC, and multi-threaded handle policy remain unproved.
The product decision that followed is **not adopted for v1**, recorded in
`docs/design/windows-human-verification.md` §7. It rests on the trust boundary
rather than on these mechanics: the stored value stays readable by any same-user
process, the code that consumes an approval lives in an agent-writable
`node_modules`, and Microsoft does not treat UAC or integrity levels as a
security boundary against the same user. The unproved items above are therefore
not a v1 backlog; the broker is kept as an input for a possible future tier.

## Windows Human Plane OS verification repair — 2026-09-02

Baseline: `docs/linux-support-research` commit `e89908b` D-W measured that a
same-user, same-session, medium-integrity sibling `powershell.exe` could invoke
the real WinForms Yes button through MSAA `IAccessible.accDoDefaultAction` and
make `WindowsHumanPlane.askApproval()` return `approved`, without input
injection. The protected Secret field still denied accessibility value access.

The implementation now keeps the fixed system PowerShell helper but makes the
WinForms affirmative button start the HWND-bound
`IUserConsentVerifierInterop::RequestVerificationForWindowAsync` flow. Only
`UserConsentVerificationResult.Verified` maps to helper exit 0. Every other
documented result, unknown result, interop failure, and Windows build below
22000 fails closed. Secret input, the Free/Pro boundary, Linux, and macOS were
not changed. This is not recorded as a Secure Desktop guarantee.

Portable evidence completed on the Ubuntu development worker:

- `npm run build` passed.
- `node tests/run-tests.mjs` passed, including structural assertions for the
  owner HWND, build gate, every result mapping, removal parity, no direct
  WinForms-to-approved branch, and unchanged Secret input script.
- `npm run test:human-verification:windows -- attack` built the product and
  skipped as designed because that worker is not Windows.

Real Windows evidence is still required before this section can claim the
boundary is repaired: `verified`, `cancel`, `unconfigured`, and `attack` modes
of `npm run test:human-verification:windows`, including both approval and
removal. Do not infer those results from the portable tests.

### First real-hardware attempt — 2026-09-05, Windows `10.0.26200`

The interactive harness had never been executed. Running it produced three
findings and no passing mode; the boundary is still **unverified on hardware**.

- The harness crashed on its first line: it read the OS version with
  `process.getSystemVersion()`, which is an Electron API and does not exist in
  Node. It now uses `os.release()`. On Linux the platform guard returned before
  reaching that line, which is why no earlier run caught it.
- **The Windows helper environment was not the allowlist the code appeared to
  set.** On Windows, Node fills `PATH`, `TEMP`, `USERPROFILE`, `HOMEDRIVE`,
  `HOMEPATH`, `SYSTEMDRIVE`, `USERNAME`, `USERDOMAIN` and `LOGONSERVER` in from
  the parent process whenever `spawn` omits them, so passing only
  `{ SystemRoot, WINDIR }` handed the helper the Agent's `PATH` and `TEMP`
  verbatim. Measured by dumping the child's own `Get-ChildItem env:`. The
  path-bearing names are now set explicitly — fixed system `PATH`, a per-call
  scratch directory for `TEMP`/`TMP`, and the OS-resolved profile for
  `USERPROFILE`/`HOMEDRIVE`/`HOMEPATH` — and `tests/run-tests.mjs` asserts the
  whole set rather than asserting that names are absent. SECURITY.md's claim
  about not inheriting the Agent's `PATH` was inaccurate for Windows until this
  change and has been corrected.
- **The `attack` mode still does not run.** The sibling MSAA driver dies with
  `STATUS_STACK_BUFFER_OVERRUN` (`0xC0000409`, fast-fail subcode `0xa` =
  Control Flow Guard indirect-call check) inside `powershell.exe` as soon as a
  WinForms target window exists; with no target window it exits cleanly. It was
  reproduced in isolation against a plain probe form, so it is not specific to
  the product dialog, and the button is never pressed (`clicked=0`). Two
  candidate causes were tested and ruled out: the `AccessibleChildren`
  marshaling signature and the `EnumWindows` callback lifetime — the callback
  was replaced with `FindWindowW` anyway, since it needs no callback at all.
  The original D-W driver that did reach `approved` on this same host was
  deliberately never committed, so it cannot be compared against.
- The `verified` mode opened its dialog and timed out after 120 s with nobody
  at the keyboard. That is the harness behaving correctly, not a result.

Consequences worth stating plainly. Until `attack` runs, there is no measured
evidence that the repair closes the path D-W measured — only that the code
requires `Verified`. And because the crash prevents the sibling from actuating
the button at all on this build, the harness currently cannot demonstrate the
original vulnerability either, so a passing run would need to show the attack
working against an unfixed dialog before it can show the fix blocking it.

## Phase 6 macOS boundary implementation — 2026-08-31

- On a local Windows host, `npm test` passed after the macOS implementation was
  integrated. This covers the full portable suite plus the new synthetic
  Human Plane and attack tests without regressing the existing Windows path.
- The synthetic tests assert fixed `/usr/bin/osascript`, fixed `/usr/bin` cwd,
  empty helper environment, ignored stdio, no Secret in helper argv/environment,
  direct Security.framework `SecItemUpdate`/`SecItemAdd`, status-only results,
  deny-safe approval/removal, fake `PATH`/`HOME`/helper rejection, provider-env
  stripping, exact CLI replacement detection, and the existing destination,
  account, config, cwd, and pre-spawn TOCTOU checks. A separate attack fixture
  pins a Node-shebang CLI's exact interpreter and CLI realpaths, proves the
  spawn argv uses both, rejects unknown interpreters, and detects interpreter
  replacement after approval. Linux production resolution remains unavailable.
- Not yet verified on a real macOS host at the time of this local run: the
  `/usr/bin/osascript` AppKit/Security.framework smoke, a human entering a value
  into the real dialog, direct helper-created Keychain entry recognition by
  `@napi-rs/keyring`, approval/removal clicks, or an executing real-provider
  deploy through the new trusted resolver. No product test bypass was added to
  manufacture that evidence.
- The private review branch was pushed, but the repository reported GitHub
  Actions as disabled (`enabled: false`), so no macOS runner evidence was
  produced. The repository setting was not changed for this implementation.
- Intel paths are implemented but have not been run on Intel hardware.

## Phase 6B local Windows verification — 2026-08-30

- `AGENT_KEY_CASE_E2E=1 AGENT_KEY_CASE_E2E_STRICT=1 npm test` passed on the
  local Windows host, including the real Credential Manager synthetic
  set/status/delete round-trip and every existing security, analytics, Worker,
  and site test.
- `npm run test:human-plane:windows` passed against the real Windows password
  dialog. It verified the password-control input surface, fixed helper path
  despite a fake `PATH`, ignored Agent-owned stdin canary, status-only
  cancellation, no saved credential, and no generated-file canary.
- The successful Human Plane contract is covered with an injected trusted
  launcher and synthetic MemoryVault: the helper-side write produces only
  `saved`, and subsequent `check`/`next` state is `registered` without exposing
  the canary. The production helper script is also parsed by the fixed Windows
  PowerShell executable and checked for direct `CredWriteW`, ignored stdio,
  sanitized environment, trusted cwd, and value-free argv.

## Phase 6C high-risk approval implementation

- High-risk approval is now routed through the same fixed Windows Human Plane
  helper used by Phase 6B. The helper returns only an in-process approval
  status; the approved operation is executed in that one deploy call.
- Before Secret retrieval and immediately before each target CLI spawn, the
  deploy engine rechecks the fixed project realpath, destination-config
  fingerprints, provider-auth environment presence, auth-file metadata, plan
  argv/pre-steps, and resolved CLI file identity. Any mismatch fails closed.
- Synthetic tests cover Agent-owned stdin/PTY denial, decline/close/unavailable,
  single-call approval use, config/cwd/provider-env/CLI changes, fixed helper
  path plus sanitized helper/provider environments, Agent-owned PATH
  replacement, ambiguous Wrangler/Git config denial, Vercel development
  fail-closed without a Human Plane, MCP production/GitHub refusal, and Phase B
  `save --ask` regression. Config projection tests also prove that two different
  Secret-bearing values do not change the stored content hash.
- At the time of this Phase 6C run, macOS and Linux were handoff-only. This
  historical run does not verify the later macOS extension above. A real
  Windows dialog run for Phase 6C has not yet been recorded in this document.

## Phase 6E lifecycle — 2026-08-31

- `npm test` and `AGENT_KEY_CASE_E2E=1 AGENT_KEY_CASE_E2E_STRICT=1 npm test`
  both passed on the local Windows host, so the Phase E changes were exercised
  against the real Windows Credential Manager as well as the synthetic suite.
- The real-store leg is the load-bearing one for removal: with a synthetic
  credential actually written to Credential Manager, a declined dialog and an
  unavailable Human Plane each leave the credential in place, and only the
  approved path deletes it. The same leg round-trips a destination trust record
  through save → has → delete → delete-again in the real store.
- The synthetic suite covers the rest: an unused project-scoped secret appears
  as a `remove-secret` cleanup candidate and disappears once removed; removing
  a still-required secret returns `next` to `missing` with a `register-secret`
  action; an unknown name is an error rather than a dialog; an index row whose
  stored value is already gone is pruned as metadata without opening one; a
  crashing dialog fails closed; and the then-current implementation returned
  `unavailable` on linux/darwin. This predates the macOS extension above.
- Destination cleanup is covered the same way: `resolveDestinationIdentity`
  matches the slot fingerprint derived without a provider call; a decline and an
  unavailable Human Plane both keep the two records; an approved forget removes
  both and returns the destination to `unconfirmed`, after which a real
  `runDeploy` against the fake provider CLI prints "first use of this
  destination" and refuses to place the value; and `trust status` reads trust
  without changing the record set.
- Structural checks: `remove --yes` is rejected as an unknown option; the CLI
  source has no `--yes` parse branch left; `lifecycle.ts` contains no
  `process.stdin`, prompt, or confirm call; deletion in both flows is matched
  by regex as occurring only after an approved Human Plane decision; MCP exposes
  no removal/trust tool and no MCP source reaches the lifecycle module; and
  `deleteDestinationTrust` / `forgetDestinationTrust` are confined to the same
  small file sets as the Phase D write path.
- The real Windows removal dialogs (secret and destination-trust variants) are
  parsed by the fixed Windows PowerShell executable and asserted deny-safe:
  Enter, Escape, initial focus, and every close path return "declined". Seven
  malformed plans are rejected before the helper is launched.
- Not verified in this historical run: a human actually clicking Delete in the
  real Phase 6E dialog (the Phase 6C dialog note applies equally here), or any
  Phase E behaviour on macOS/Linux. See the newer macOS section above.

## Phase 6D destination boundary — 2026-08-31

- `npm test` and `AGENT_KEY_CASE_E2E=1 AGENT_KEY_CASE_E2E_STRICT=1 npm test`
  both passed on the local Windows host, so the Phase D changes were exercised
  against the real Windows Credential Manager as well as the synthetic suite.
- The real-store leg proves the destination trust lifecycle end to end with a
  fake provider CLI: a first-use Vercel `preview` deploy opens the Human Plane
  once, the approval records exactly two entries (the destination identity and
  its slot), and an identical second deploy runs with no Human Plane call while
  still delivering the value through the bound trusted execution. The recorded
  account names contain no canary and match `v1|destination(-slot)|<sha256>`.
- The synthetic suite covers the attacker cases: a first-use destination is not
  automatic; a decline records nothing; a redirected `.vercel/project.json`,
  a swapped provider account identity, another project directory, and a
  cross-project Secret all stop reusing an existing trust record; a provider
  credential in the environment and an unlinked Vercel project fail closed; a
  CLI upgrade does not invalidate the destination, while a CLI swapped between
  the trust decision and the spawn aborts the run; `production`, Vercel
  `development`, `--force`, and `--scope user` still require approval on a
  trusted destination; and MCP can neither create nor bypass destination trust.
- The automatic policy is asserted against every shipped adapter, environment,
  and `--force` combination: only Vercel `preview` in `project` scope without
  `--force` is automatic-safe.
- Not verified in this historical run: a real Windows approval dialog for a
  Phase D first-use deploy (the Phase 6C dialog note below still applies), or
  any Phase D behaviour on macOS/Linux. See the newer macOS section above.
- The write-only premise behind the one automatic-safe operation no longer
  rests on a Vercel or team default. The adapter plans
  `vercel env add <NAME> preview --sensitive` (and the same for `production`),
  and a test asserts every automatic-safe environment still plans that flag.
  `--sensitive` was confirmed as a current, accepted option of `vercel env add`
  against Vercel CLI 59.10.0 on 2026-08-31 — `--help` lists it as "Store the
  value as a Secret", and an unlinked invocation was rejected for `not_linked`
  rather than for an unknown option. The same CLI rejects a made-up flag with
  `invalid_arguments: unknown or unexpected option`, so a `vercel` too old to
  know `--sensitive` fails the deploy instead of silently creating a readable
  variable. No value was deployed for any of these checks.
- Not verified by a real deploy: that a `preview` variable created this way is
  actually listed as sensitive by the provider. The 2026-08-18 E2E run
  (`vercel env ls` → `AKC_E2E_CANARY | Non-sensitive | Development`) predates
  this change and only covered `development`. Re-check `vercel env ls` on the
  next Vercel E2E run.

## v0.9.0 soft launch — 2026-08-29

- Public `main` was verified at
  `a19c5a7e12d772f84dc10e88b85aaec7041a910d`. An anonymous fresh clone
  succeeded, its three reachable commits used only the reviewed public noreply
  identity, and content-only scans found no private identity fragments in the
  current tree or reachable history.
- Annotated tag `v0.9.0` resolves to that commit and uses the reviewed public
  tagger identity. The protected tag-triggered
  [Publish workflow](https://github.com/leone-develop/api-key-case/actions/runs/33189670713)
  completed its tests, package dry-run and npm publish.
- npm returned `api-key-case@0.9.0` as `latest`, with package integrity and a
  SLSA provenance attestation at
  `https://registry.npmjs.org/-/npm/v1/attestations/api-key-case@0.9.0`.
  The published tarball had 88 files, excluded `docs/design/`, and a
  content-only identity/local-path scan returned zero findings.
- From a clean directory outside the development repository,
  `npx --yes api-key-case@latest --version` returned `0.9.0` and
  `npx --yes api-key-case@latest scan .` exited successfully.
- The production LP root, Terms, Privacy, Refund and 特商法 routes returned
  HTTP 200. The live purchase URL also returned HTTP 200. README contained all
  required legal links.
- CodeQL had zero open alerts after the initial High findings were fixed and
  re-analyzed. Repository secret scanning/push protection, dependency alerts,
  Private Vulnerability Reporting, main protection and release-tag protection
  were enabled before launch.
- The one-time `NPM_TOKEN` name was confirmed absent from the protected GitHub
  Environment after publication; its value was never read. Provider-side token
  revocation and Trusted Publisher configuration are write-only/account-side
  facts and must be re-confirmed before the next release rather than inferred
  from the GitHub secret state.

## Status at a glance

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Unit + integration suite | ✅ 2026-08-10 | ✅ 2026-08-10 | ✅ 2026-08-10 |
| Real OS secret store round-trip | ✅ 2026-08-10 | ✅ 2026-08-10 | ✅ 2026-08-10 |
| **Real `deploy` to Cloudflare / Vercel / GitHub** | ✅ **2026-08-18** | ✅ **2026-08-18** | ✅ **2026-08-18** |
| Survives a host with no secret store | n/a | ✅ Docker, 2026-08-10 | n/a |

All three advertised platforms are now covered by a reproducible run against
the real services. Runner images: `macos-latest` (macos-26, arm64),
`ubuntu-latest` (ubuntu-24.04), `windows-latest` (windows-2025-vs2026). Intel
macOS is not covered by any of this.

These pre-launch runs were made in a Private publication-staging repository.
That staging repository was retired instead of being made Public because its
pre-release history contained development-only files. The records remain in
the Private evidence archive and are intentionally not linked from this Public
history. The workflow and assertions needed to reproduce them are published
below; new runs made from the Public repository can be linked directly.

## Real deploy end-to-end (the headline result)

Workflow: `.github/workflows/e2e-deploy.yml` → `tests/e2e/deploy-e2e.sh`.
Manual dispatch only, because every run creates and destroys real resources in
real accounts.

- **macOS**, 2026-08-18, `macos-latest` (macos-26, arm64). Cloudflare, Vercel, GitHub: all green. Vendor CLIs: wrangler 4.123.0, vercel 59.1.4, gh 2.96.0.
- **Linux**, 2026-08-18, `ubuntu-latest` (ubuntu-24.04). Cloudflare, Vercel, GitHub: all green. Vendor CLIs: wrangler 4.124.0, vercel 59.1.4, gh 2.97.0.
- **Windows**, 2026-08-18, `windows-latest` (windows-2025-vs2026). Cloudflare, Vercel, GitHub: all green. Vendor CLIs: wrangler 4.124.0, vercel 59.1.4, gh 2.97.0. Node 24.19.0. Runs under Git Bash, which ships with the runner image.

The vendor CLIs are installed globally on purpose — `resolveCli()` searches
`PATH` only and never `node_modules/.bin`
(`packages/core/deploy/which.ts`), so anything else would test a path users
never take.

### What each run actually asserted

Per platform, in order. Every one of these is a hard assertion; the script
fails the job rather than warning. These 2026-08-18 runs predate Phase 6C, so
their terminal-confirmation/deploy steps are historical evidence and do not
claim to validate the current Human Plane approval boundary.

1. **A throwaway resource is provisioned** in the real account — a Worker (with `workers_dev = false`, so it never gets a public hostname), a Vercel project, or a private GitHub repo.
2. **`targets` sees a real, logged-in CLI** — detection reason, version and login state all come from the shipped adapter, not from the harness.
3. **The value is stored in the real OS secret store.** `check --json` must report `backend=keyring`; a fall back to an in-memory backend fails the run, so this can never silently pass against a dead vault.
4. **The store is confirmed from outside the product** — `security find-generic-password` on macOS, `secret-tool` on Linux (matched on attribute `service`), `cmdkey /list` on Windows (target `{account}.api-key-case`). None is ever asked for the value: `security` runs without `-w`, `cmdkey` never prints passwords at all, and `secret-tool`'s stdout — which does include the value — goes only into `grep`, never to a file or the log.
5. **`--dry-run` prints the plan and changes nothing.**
6. **Declining the confirmation deploys nothing.** Typing `no` at the production prompt must exit 4. Checked for Cloudflare (`--env production`) and GitHub (which always confirms, since a GitHub secret of either kind is CI-consumed regardless of `--env`).
7. **The real deploy runs** and reports `OK: ... deployed to ...`.
8. **The service itself confirms the registration** — this is the point of the whole exercise, and it is read back from the platform, not from our own output:
   - Cloudflare: `wrangler secret list` → `[{"name":"AKC_E2E_CANARY","type":"secret_text"}]`
   - Vercel: `vercel env ls` → `AKC_E2E_CANARY | Non-sensitive | Development`
   - GitHub: `gh api repos/.../actions/secrets` → `AKC_E2E_CANARY`
9. **The value leaked nowhere.** A fresh random canary per run must appear in no transcript, plan, service listing, or file in the project directory.
10. **Everything is deleted, and the deletion is verified** — CLI delete plus a direct REST delete, then a `GET` that must return 404 (`gh repo view` must fail for GitHub). A resource that might survive raises a `::warning::` naming it.

### Why the harness types into a pseudo-terminal

`save` refuses non-TTY input, and AGENTS.md §3 forbids adding a bypass. The
high-risk deploy approval is no longer a terminal prompt: it uses the
Agent-independent Windows Human Plane and is unavailable on headless hosts.
The harness must not gain a `--stdin` escape hatch to make itself testable — it
allocates a real terminal and types like a human for Secret input: a pty on macOS and Linux
(`tests/e2e/pty-drive.py`), a ConPTY on Windows (`tests/e2e/pty-drive.mjs`,
see [below](#how-windows-gets-a-terminal)). The product under test is the
shipped one, with no test-only flag in its path.

Three consequences worth knowing before editing the harness:

- **Echo has to be suppressed, or the harness frames the product.** A terminal echoes typed input straight back. A human never hits that window because `readHiddenLine()` turns echo off first, but the harness answers within microseconds and does. Leaving it on made the first real run (32129207315) fail the leak check on all three platforms against a value the *harness* had typed, not one the product printed. POSIX clears `ECHO` on the pty; ConPTY does not expose that, so the Windows driver waits 250 ms after the prompt — roughly a human's reaction time — before typing.
- **The leak check reads an unmasked transcript.** The driver writes a masked copy for the log and a mode-600 raw copy that is never printed; the assertion greps the raw one. Grepping the masked copy would be circular — the mask would hide the leak it was looking for.
- **A wrapped line could hide a leak.** A terminal may hard-wrap a long line, splitting a leaked value across a newline where a plain `grep` would miss it. The leak check therefore also greps a whitespace-flattened copy. ConPTY repaints make this a real possibility rather than a theoretical one.

### Reproducing or re-running

> **The credentials this needs were deliberately removed on 2026-08-19.** The
> harness is kept for regression use, not run on a schedule, so leaving live
> tokens sitting in a repository that is due to go public bought nothing. A
> dispatch today fails at the preflight step, by design, naming what is
> missing. That is expected, not a regression.

```sh
gh workflow run e2e-deploy.yml                                         # defaults: all platforms, ubuntu only
gh workflow run e2e-deploy.yml -f platforms=cloudflare                 # one leg, cheapest
gh workflow run e2e-deploy.yml -f platforms=all -f os=all              # everything (9 legs; macOS bills 10x)
```

Needs five repository secrets. Only three are actually tokens to mint:

| Secret | To restore |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | New token, "Edit Cloudflare Workers" template |
| `VERCEL_TOKEN` | New token at vercel.com/account/tokens |
| `GH_PAT_E2E` | New classic PAT, `repo` + `delete_repo` only — `GITHUB_TOKEN` can neither write Actions secrets nor delete repos |
| `CLOUDFLARE_ACCOUNT_ID` | Not a secret: `wrangler whoami` prints it |
| `AKC_PRO_LICENSE_KEY` | The maintainer license already on disk at `~/.api-key-case/license.key` (deploy is Pro-gated; exit 6 without it) |

The three tokens above were revoked at their providers, not just unset here,
so they cannot be reused. Note that GitHub Actions secrets are write-only —
there is no API to read one back — which is also why revoking them had to be
done by hand in each dashboard.

Linux needs a Secret Service that the vault can reach, so the whole flow runs
inside one `dbus-run-session`. Starting the daemon in an earlier step does not
work: the bus address dies with that step's shell. The workflow asserts
`org.freedesktop.secrets` is on the bus *before* running the flow, so an
infrastructure failure is never misread as a product defect.

## How Windows gets a terminal

Windows needed its own solution, because the product's TTY requirement is a
guarantee rather than an inconvenience. `tests/e2e/pty-drive.py` uses
`pty`/`termios`, which do not exist on Windows, and the tempting alternative —
giving the CLI a non-TTY input path so a test could reach it — would have
deleted the very property the test exists to confirm.

ConPTY (Windows 10 1809+) is the equivalent primitive: it gives the child a
real console handle, so `process.stdin.isTTY` is true and the hidden-input
path runs exactly as it does for a user. `tests/e2e/pty-drive.mjs` drives it
through `node-pty`, taking the same arguments as the Python driver so
`deploy-e2e.sh` picks one by `uname`. `node-pty` is installed with
`--no-save` on the Windows leg only — a harness dependency must not appear in
what users install.

Two Windows-specific things worth knowing before touching this:

- **The whole flow runs under Git Bash**, which rewrites arguments that look like absolute paths. That silently broke the first attempt: `cmdkey /list` arrived as a Windows path and was rejected as a bad parameter, which the check then reported as "the credential is missing". `//list` is the MSYS escape that arrives as `/list`, and the check now separates "cmdkey listed nothing at all" from "the credential is absent".
- **`node-pty` does no PATH lookup on Windows** and fails with `File not found` on a bare command name, so the driver resolves its own launcher. That is unrelated to the product's deliberately PATH-only vendor-CLI resolution.

### What was already known about Windows

Independently of the runs above, and still true:

- Real Credential Manager behaviour: `getPassword()` returns `null` (not a throw) for a missing entry, and `deleteCredential()` returns `false`. Checked on real hardware 2026-07, which is why `packages/core/deploy/handoff.ts` tests existence by return value rather than by exception (`docs/design/phase-2-vault.md` §4.3).
- The older `deploy` value-path e2e ran against real Credential Manager but with a **fake CLI fixture** on `pathOverride` (`docs/design/phase-3-deploy.md`). It covered vault → stdin only. The 2026-08-18 Windows pre-launch run closes the remaining half, against the real vendor CLIs.

## Supporting verification

- **Unit + integration suite and real-keyring round-trip**, 2026-08-10 Private pre-launch record. Five `test` legs (ubuntu 20/22/24, macos 24, windows 24) plus `keyring-e2e` on all three OSes. `keyring-e2e` runs with `AGENT_KEY_CASE_E2E_STRICT=1`, which turns "backend unavailable → skip" into a hard error and asserts at least one e2e block ran, so it cannot pass by silently skipping.
- **No secret store at all**, Docker `node:24-slim` (Debian bookworm), 2026-08-10, installed from the packed tarball with no libsecret and `DBUS_SESSION_BUS_ADDRESS` unset. `--version` / `scan` / `targets` exit 0; `list` / `check` print the guidance and exit 3 with no stack trace. Confirms the static `createVault` import does not break vault-free commands. CI structurally cannot cover this, because the Linux leg installs gnome-keyring first.

## Findings that changed the product or its docs

Things the runs surfaced that were not known beforehand:

- **Vercel's `development` environment cannot hold a sensitive variable** (Vercel's API disallows it), so a value deployed there is readable again via `vercel env pull`. `production` and `preview` default to sensitive; Cloudflare and GitHub secrets are not readable back at all. Documented in README ("What each platform does with the value after that") and in SECURITY.md's known limitations, since it changes what a user should expect from `--env development`.
- **Teardown depended on `vercel project rm --yes`**, a flag Vercel does not document. A failed run could have left a project behind in a real account. Cleanup now deletes via CLI *and* REST and asserts the resource is gone.
- **Windows Credential Manager stores the entry as `{account}.{service}`** — established by writing a throwaway entry and reading `cmdkey /list` back, rather than assumed from the keyring library's source. The Linux attribute name (`service`) was pinned the same way, by trying the known spellings and reporting which matched.

## Not verified

Deliberately listed so nobody mistakes silence for coverage:

- **Intel macOS** — `macos-latest` is arm64.
- **Windows versions other than the runner image.** The Windows leg proves the flow on `windows-2025-vs2026`. ConPTY needs Windows 10 1809 or newer; older builds are not covered, and neither is a Windows host without Git Bash (the script's shell).
- **Dogfooding the license backend**: placing the live Worker's five secrets with the product itself is still an open checklist item.
- **Long-lived behaviour** — every run here is a single-shot create/deploy/delete on a fresh runner. Nothing covers a value that has sat in a store across OS updates, keychain re-locks, or credential rotation.
