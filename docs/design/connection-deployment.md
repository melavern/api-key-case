# Bounded hosted connection deployment

Status: development contract; original hosted unit 2026-10-02, named GitHub extension 2026-10-03. Extends the accepted v2 environment storage and
integrated secret-free plan/recovery contract. This unit does not complete `vertical-complete`, choose
a local-app trust model, prove a working application, or change published 0.9.2 claims.

OpenAI/Stripe test have a separate bounded [hosted source extension](provider-hosted-deployment.md),
with real execution source-gated pending native acceptance. The historical Resend
contract below and existing Clerk preparation remain compatible.

## Closed request

`api-key-case connection deploy --service resend --env <development|preview|production> [--dry-run] [--force] [--json] [path]`

The selected intent must name that exact environment, route `api-key-case-managed`, and destination `vercel`,
`cloudflare`, or the bounded named `github` Environment path below. The source is only `v2|credential|project|<projectId>|resend|<environment>|RESEND_API_KEY`.
The command rejects other services, scopes, targets, route/environment mismatches, missing/unreadable intent or
registration revision, and absent credentials before value read or placement. It never falls back to v1, user scope,
another environment or a hosted destination for a local app. Provider-native/manual/local intents remain unsupported
by this command. Their mere existence does not authorize a managed placement.

No raw value, target override, arbitrary URL/command/argv/environment map, application runner, export or environment-file
writer is accepted. The existing seven MCP tools and legacy deploy behavior remain unchanged. Direct
`runWithSecret(v2)` still rejects. No app launch, email, new provider integration or cross-host bridge is added.

## Entitlement and the offline preview

The existing Pro entitlement check gates both actual execution and `--dry-run` inside the new core entrypoint.
The new dry-run is an **offline request preview**, not legacy deploy's auth-probing dry-run and not an executable plan:

- Read only the requested project's intent, exact v2 registration metadata and vault presence; validate the fixed adapter plan.
- No adapter detection, CLI/version/account probe, auth refresh, value-bearing handoff, Human Plane approval, or history,
  observation or trust write occurs.
- The preview identifies the fixed Resend/name/project source, source/destination environment, selected hosted target,
  force, remove-first and overwrite implications. It explicitly says `permission: none`.
- Destination/account/CLI readiness is **not verified**. JSON labels this `preview.kind: offline-request`,
  `destinationReadiness: not-verified`, `providerProbes: not-run`.
- A later execution independently resolves its current destination and CLI and applies all current trust/approval checks.
  The preview, a stored receipt, and a synthetic complete application plan grant nothing.

Legacy deploy dry-run behavior is unchanged. Actual connection deployment does invoke official CLI readiness/account
probes, which may refresh authentication state or create provider logs/metrics. It is not globally read-only even if
placement stops before a write. `placementEffects: none` means no credential-placement handoff was attempted by this
invocation, not that its provider probes had no effects. `possible` requires treating remote placement/removal as possible;
there is no automatic retry. The separate `connection plan` inspection remains side-effect-free and gains no CLI probes.

## Binding and approval

Execution uses the existing guarded deploy engine: fixed official CLI/argv, independently resolved destination,
sanitized child environment, concrete execution snapshot, destination-trust policy and Agent-independent Human Plane.
Production, overwrite/force, Cloudflare and Vercel development retain approval on every operation. Only the existing
Vercel preview non-force class may use a previously confirmed matching destination. First-use/changed destinations still
ask. Windows retains its HWND-bound OS verifier and accepts only Verified; unavailable/cancelled consent cannot run.

Before approval, the engine fixes the exact service/environment/project/v2 reference, presence, non-secret registration
revision, intent ID/fingerprint, destination/configuration, CLI and provider identity. The approval display adds a closed
v2 Resend source/environment and registration revision. Both native builders strictly validate source fields and reject
source/destination environment mismatch; legacy rendering is unchanged. This does not claim arbitrary app-code isolation.

The original metadata identity uses `realpathSync` consistently with v2 registration. Native realpath expansion is used
only for physical execution/destination equality and the existing history-directory identity, not to rename a v2 slot.
Each awaited presence/probe/approval/trust boundary is followed by current-basis checks. The exact basis and pending receipt
are revalidated before every destructive pre-step, before the sole value-bearing read, before every provider spawn, and
before completion evidence. An initial auth readiness probe may refresh auth metadata before approval, but cannot replace
the initial destination/CLI. Any later snapshot/revision/intent/presence mismatch fails closed.

The only value-retaining implementation remains `deploy/handoff.ts`. Its new closed operation regenerates official argv
and a sanitized environment internally; it never accepts a caller environment map. It writes the exact credential only
to official CLI stdin. Provider stdout/stderr are discarded, including partial-value or arbitrary-error canaries. Native
store/spawn exceptions are converted to closed unknown status. No value, value-derived hash/length or provider output is
returned or persisted.

## History, interruption and limits

A durable unknown attempt must exist before any destructive pre-step or value read. Locked, corrupt, unsupported or
unwritable history blocks that invocation. Pending receipt identity is checked again after awaits. The existing bounded
journal is extended with explicit v2 identity/revision/intent metadata; [history schema migration and comparison rules](deployment-history.md)
keep legacy v1 receipts distinct. A v2 comparison never reads the v1 registration index.

After a pre-step, timeout, exception or changed basis, preserve unknown/partial evidence and state that placement may have
occurred. Never report that nothing happened or replay automatically. If saving a result fails, report `historySaved: false`
and its closed diagnostic separately from the observed outcome. A success followed by failed result persistence is not a
safe reason to deploy again. A changed result with a successfully saved unknown receipt has `historySaved: true`.
Unexpected execution errors conservatively return unknown/possible and leave the started evidence in place.

A completed receipt means the fixed CLI returned success with a still-current deployment basis. There is no remote value
readback, email send or application check. It cannot authenticate provider/app observations, mark an application ready,
grant approval/trust/entitlement, or complete the real application/value acceptance gate. Application source/dependency
coverage remains a separate advisory contract and is not artificially required or declared complete for hosted placement.

## Original hosted-candidate verification scope (2026-10-02; historical)

Synthetic tests use MemoryVault, Entry stubs, fixed fake official CLIs and Human Plane helpers. They cover exact-slot
selection/no fallback, Pro/free/preview boundaries, guarded force pre-steps, cancellation/unavailable consent, revision,
intent/destination/CLI/account/presence changes across awaits and after execution, canary suppression, durable unknown
starts, locked/corrupt history, result-save failure, no replay, path aliases, v2 history identity, and legacy/MCP regressions.
Generated approval-script/fake-helper checks do not replace native visual acceptance. No real store/account/provider,
registry, app, email or deployment is part of these tests. The prior user-reported Windows functional 19/19 at 100% remains
valid for its accepted surface; 150% visual coverage remains release-only. At that original checkpoint, the new source-label
display still needed a narrow affected-surface native check. Subsequent user-reported consent acceptance is recorded in
[VERIFICATION](../VERIFICATION.md); this historical paragraph does not request a repeat.


## Named GitHub Environment development extension (2026-10-03)

The private development CLI supports reusing an exact saved Resend environment credential for GitHub Actions.
After selecting the intended project/environment with the human, use the same private built CLI throughout:

```text
node <private-checkout>/dist/cli/index.js connection set --service resend --env development --route api-key-case-managed --destination github <app>
node <private-checkout>/dist/cli/index.js connection credential check --service resend --env development --json <app>
node <private-checkout>/dist/cli/index.js connection deploy --service resend --env development --dry-run --json <app>
```

Only a missing credential calls for the existing Human Plane `connection credential save` flow. Once the human has
reviewed the selected repository/environment and authorized placement, the same `connection deploy` without `--dry-run`
uses the existing Pro and fresh native approval boundaries on the accepted Windows execution path. This documentation
is not permission to perform that live operation. Public 0.9.2 does not implement this private path.

For all three supported environment names, the sole placement argv is
`gh secret set RESEND_API_KEY --repo github.com/OWNER/REPO --env ENV`, with the value only on stdin.
The repository comes from the same closed local Git configuration used by the execution snapshot. A single github.com
origin with a strict owner/repository slug is required; ambiguous remotes, custom hosts/ports, rewriting/includes,
worktree configuration and linked destination files are refused. The generic connection application plan remains
unsupported for GitHub; neither intent nor preview is execution authority.

The offline preview displays the repository and named-environment scope and runs no provider probes. Actual execution
uses fixed github.com account, repository and environment GET probes through the bound CLI. Positive safe-integer user,
repository and environment IDs plus the account login are bound into the existing destination/approval identity.
Missing, forbidden, malformed or changed remote identity prevents handoff. Repeated checks surround approval, value read,
spawn and completion; there is no automatic environment creation, login, repository-secret fallback or retry.
A race between the last GET and the provider write is still possible. A nonzero CLI exit records incomplete with possible placement effects; timeout/no exit status or changed basis after
a started attempt records unknown/possible. Every uncertain outcome requires human review rather than replay.
History keeps v2 GitHub destination comparison unresolved because the legacy login-only resolver cannot compare this
user/repository/environment ID contract; saved outcomes and exact credential revisions remain inspectable offline.

Legacy GitHub command and environment mapping are unchanged: development remains repository-wide. The shared
destination parser now correctly recognizes its already-intended SCP-style github.com remote fallback. The v2 GitHub path always needs
fresh approval because placement can overwrite a secret reachable by Actions. Jobs must themselves select the matching
GitHub Environment and use the secret; environment secrets take precedence over repository/organization secrets in that
context. API Key Case does not edit/run workflows, freeze remote workflow code/protection settings, or claim the app works.

Official references: [gh secret set](https://cli.github.com/manual/gh_secret_set),
[GitHub environment secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).
Official CLI source was inspected for its environment public-key GET followed by the environment-secret PUT; no
Environment creation endpoint is part of that branch. Tests use synthetic fake CLI responses and a stubbed keyring only.
Native helper source is unchanged; new source-field rendering is checked synthetically, not reported as a new live send,
provider placement, native visual acceptance or release.

Verification for this extension: build and focused tests passed; independent review reran 23 repository/race checks,
118 isolated hosted cases, mixed history, generated native approval scripts, generic-plan refusal and Agent guidance.
The final Linux aggregate passed in 202.3s using an isolated mock keyring, blocked native-store loading and fake provider
commands, with candidate byte-equality proof. Offline installed-package smoke passed in 24.3s with 162 allowlisted files
and unchanged installed-file hashes. No real key/store, GitHub placement, workflow execution or new Windows/macOS native
acceptance occurred. The shared preflight could not run in this gitless materialization; remote base/tree/blob verification
is recorded separately and is not described as a preflight pass. Hosted Actions remains unavailable under the previously
verified runner-start billing limitation; these are local fallback results, not successful hosted CI or public release.


## Explicit provider-native metadata inspection

The private `connection native inspect --service resend --env <environment> --json [path]` entry inspects a selected
provider-native Vercel intent without duplicate vault registration. It uses the existing trusted CLI snapshot and exact
project/org IDs from its closed destination projection. A bounded `--version` probe first requires the reviewed Vercel CLI 59.11.7; unknown/older/newer versions stop before any API command. This prevents an old CLI from interpreting an unsupported command as a deploy path. The only network command is a fixed official-CLI API GET:
`vercel api /v10/projects/PROJECT_ID/env?target=ENV --method GET --raw --non-interactive --api https://api.vercel.com --scope ORG_ID`.
No endpoint/body/decrypt/input/pagination option is exposed. CI=1, closed stdin, sanitized environment and telemetry
opt-outs prevent interactive login/SAML flows in the reviewed CLI contract. Existing-session refresh and CLI-internal GET
retry remain possible. An auth/config/CLI/intent change invalidates the observation. No API Key Case retry is performed.

The parser accepts only a bounded envs response, rejects error ambiguity and duplicate JSON keys, and projects presence
for the exact target. Branch-restricted, duplicate or unsupported matching entries remain unknown. Configuration-ID
attribution is distinct from verified Resend integration identity. Values are neither returned nor included in fingerprints;
no state cache or generic-plan resolver is installed. The output grants no execution permission and checks no app behavior.

Current `vercel env ls` is deliberately not used: its successful-command hook can automatically migrate Claude plugins
under saved preferences. The fixed api command path avoids that hook. Official source reviewed 2026-10-03:
[API dispatch](https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/api/index.ts),
[request builder](https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/api/request-builder.ts),
[missing-login behavior](https://github.com/vercel/vercel/blob/main/packages/cli/src/util/login/prompt-missing-credentials.ts),
[SAML behavior](https://github.com/vercel/vercel/blob/main/packages/cli/src/util/login/reauthenticate.ts), and
[environment endpoint](https://vercel.com/docs/rest-api/projects/retrieve-the-environment-variables-of-a-project-by-id-or-name).
Unsupported CLI versions fail closed; this development change does not claim real provider or native acceptance.

The version-specific audit additionally inspected the actual official
[vercel 59.11.7 registry artifact](https://registry.npmjs.org/vercel/-/vercel-59.11.7.tgz), without installing or executing it.
Its registry integrity is `sha512-C+L/JKmlGDypKGcTU/atckydeK/AKa/7fKwUbvcwveguV1QPlY8beiIGgbwkdbb80bbIpPFHRQYrhi5XPAmCBA==`
and tarball SHA-256 is `34432b6f0ddd6501ab17140dcf6c5baa2e68fa1ce91eabcb2afef4fbf4db44eb`.
The bundled API dispatch, missing-session CI refusal, SAML non-TTY/CI refusal, noninteractive refresh behavior and update
notifier opt-out were checked from those bytes. Runtime uses the existing trusted executable snapshot and exact version
check; it does not attest the installed package against this tarball. Other versions need review before expanding this
new command's allowlist. It never automatically installs or downgrades the user's CLI.

Final verification for this inspection: build and all 49 focused synthetic cases passed; independent review reran the
49 cases, the actual generic-plan suite and Agent guidance, and checked all 212 materialized files against the verified
registry artifact. The final Linux aggregate passed in 209.2s in the isolated mock-keyring harness with native loading
blocked, fake provider commands and candidate byte-equality proof. Offline installed-package smoke passed in 23.0s;
all 165 allowlisted installed files remained unchanged. No real vault, provider account, integration, native popup or app
operation ran. The shared preflight was attempted but cannot resolve Git metadata in this materialization; exact remote
tree/blob verification is separate evidence. Hosted Actions results remain unavailable under the recorded runner-start
billing limitation. These local fallback results do not constitute hosted CI, live Vercel acceptance or a public release.


## Native-only Clerk profile

The private extension adds only Clerk + provider-native + Vercel, with an explicit development/preview/production target.
A separate literal `clerk-native.json` reuses guarded metadata operations; the default Resend `state.json`, its IDs,
credential references, observations and local-session locks are unchanged. The service-specific validator refuses all
other Clerk routes/destinations and any sending domain. No generic service registry, dynamic names or provider URLs.

Schema5 added `next.clerkNative` independently of scanner detection; current schema6 retains it alongside the Resend projection and separate `clerkManaged` report. This branch accepts
no vault/provider dependency and never says configured/ready. The fixed pair is excluded from generic vault advice when
native intent is selected or unreadable, while unrelated diagnostics remain. Existing whole-project next behavior is not
relabelled as offline or side-effect-free.

The existing version-bound Vercel inspector explicitly binds the requested service to its matching saved intent. Resend
keeps its original schema1 result; opt-in Clerk returns schema2 with closed secret/publishable presence roles. Exactly one
unbranched row for each name in the requested target and equal nonempty configuration IDs yields integration-managed.
Different attribution is unknown; missing rows are partial/absent; both un-attributed rows are present-unmanaged. Metadata
fingerprints exclude values. Public configuration is not a reason to expose raw environment JSON or either key value.

[Clerk's Marketplace contract](https://clerk.com/docs/guides/development/integrations/platforms/vercel-marketplace)
maps its development instance to Vercel development/preview and its production instance separately. It cannot adopt an
existing standalone Clerk app. This profile assumes an already managed application; it does not create one or migrate it.
The coding Agent handles existing app SDK work without init/env pull or auth-provider migration. The official
[resource-protection guidance](https://clerk.com/docs/reference/nextjs/clerk-middleware) makes clear that middleware alone
is not protection. Signed-out denial and signed-in protected-page access are a separate authorized acceptance milestone.
Presence is never promoted to that outcome, and no generic application observation or execution authority is added.

This native profile does not implement standalone credential storage or placement. The separate registration foundation is described in environment-credentials.md; the gated Cloudflare preparation candidate is below. Clerk local sessions, provider credential checks, GitHub placement and standalone public
configuration handoff remain unsupported. The existing closed Resend execution guards are not widened by this unit.

On an unknown aggregate inspection, role presence may also be returned as unknown. Existing legacy v1 generic Secret operations remain a separate contract; this profile never falls back to them.

Final verification for this Clerk extension: 54 Linux synthetic cases passed, including actual CLI service forwarding and
refusal, exact pair/environment checks, damaged metadata without fallback and preservation of Resend state/receipts/locks.
Independent review also passed the original 49 Resend inspector cases, same-app journey and Agent guidance. The final
isolated Linux aggregate passed in 213.6s with mock keyring, blocked native loading, fake provider commands and candidate
byte-equality proof. Offline installed-package smoke passed in 20.3s; all 168 allowlisted installed files stayed unchanged.
Native helpers, vault naming, value handoff, local runtime, deploy engine and roadmap were unchanged. No real provider,
key, login, app-authentication or new native acceptance was performed. Preflight was attempted but Git metadata is absent
in this materialization; exact remote tree/blob verification is separate. These approved local fallback results are not
hosted Actions success under the recorded runner-start billing limitation, or a public-release/app-readiness claim.


## Clerk: create a Cloudflare Worker version (private candidate)

This separate managed profile targets an existing Worker and the exact Clerk project/environment
slot. It uses `connection set --service clerk --env ENV --route api-key-case-managed --destination
cloudflare PROJECT`, then `connection prepare --service clerk --env ENV [--dry-run] --json PROJECT`.
Use the same private built CLI; published 0.9.2 has neither route. Clerk-native Vercel and Resend
intents coexist in their existing files. Public Clerk settings and SDK/auth coding remain the
coding Agent's ordinary application work; no public value or Secret pair is collected here.

The Windows preparation path is enabled after the scoped synthetic lifecycle/consent
receipt was reviewed. `CLERK_PREPARATION_NATIVE_ACCEPTED=true` retains the independent
Windows host guard. Pro applies, including dry-run; execution still requires fresh approval.
The dry-run reads exact-slot presence/revision and local explicit destination metadata; it does
not probe a provider, approve, create history or send a Secret. Presence may internally
read/discard an OS-store value. Registration mutation is separately restricted to the accepted Windows Human Plane.

The fixed candidate uses Wrangler 4.131.2 `versions secret put CLERK_SECRET_KEY`, adding only
`--env ENV` for development/preview. The selected config scope must explicitly contain both
Worker name and account_id; production uses root config. No name suffix is guessed and no
already-expanded --name is combined with --env. A bounded fd-checked read obtains this closed
projection; existing execution snapshots bind config, CLI, provider auth identity and unsafe
project dotenv context. The selected account must occur in the existing session's account list.

Fresh native approval is required in every environment and explicitly covers the selected
account/Worker, latest remote code (which may change before the operation), and existing Version
URL/resource exposure. This is the existing hosted-target trust boundary: app code can use its
Secret. It does not promise immutable source, inaccessible staging or no remote execution.
The official command patches the server's latest Worker version and has no missing-Worker
creation fallback. It makes no production activation call; an enabled Version URL may still
make the created version callable. Later activation belongs to the coding Agent's separately
authorized ordinary app-deployment flow using the returned exact version ID.

The reviewed installed 4.131.2 bundle hash is
d57dc4633d667dc20d210afc7f54afc5f4b29e8494174ecaacb7c56f379a902a.
This static inspection did not independently attest the npm archive. Runtime exact-version and
existing file snapshot binding are not an artifact provenance guarantee. Other installed versions
fail closed; no installation, downgrade or login is performed. Fixed environment controls disable
Wrangler logger files, raw sanitized-data logging, telemetry/error reporting and skill-update prompts;
output-file environment variables and temporary-account flags are absent. Existing-session auth
refresh may still update the CLI's own authentication storage. API Key Case adds no retry.

Only the separate closed preparation function inside handoff.ts reads the Clerk Secret. Both
previous Resend-only handoffs stay Resend-only. It rechecks the current basis before key access
and spawn, sends stdin, bounds internal stdout/stderr and returns exactly one validated version
UUID. Raw provider output/errors never enter Agent results/logs. Malformed/duplicate output,
nonzero exit, overflow, stream error, timeout, abort or changed basis remains unknown/possible;
no automatic retry or activation follows. A killed child whose close was not observed is reported
with unconfirmed termination; this is not a process-tree cleanup guarantee.

Journal schema3 explicitly marks `preparation.kind=cloudflare-worker-version` and the created
version ID on completed preparation. That means the preparation operation completed, not that
production uses it. An unknown receipt with null version ID precedes every value-bearing call.
Older journal readers reject schema3; new readers retain legacy and Resend semantics. History
and version IDs remain advisory and cannot mint approval/currentness. A result-save failure is
separate from observed provider outcome, never permission to retry. History reports use schema3
when preparation records are present; reports containing only prior operations retain schema2.

The affected Windows acceptance is bundled with the scoped Clerk storage milestone, using
synthetic data and fake provider execution plus the changed consent text. No live account, Worker,
Secret, authentication check, production activation or release is authorized by this candidate.

Official semantics: https://developers.cloudflare.com/workers/configuration/secrets/ and
https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/ .


Final verification of this gated preparation candidate: 39 isolated Linux fake-CLI/keyring
cases passed (final focused run 19.6s), including exact keyring service/account, unsupported
version before account probing, root-directory replacement, stream/UTF-8/cancellation/timeout
failures, unconfirmed-child cleanup, Free-plan refusal and mixed/evicted schema3 history.
The existing 118 hosted cases, generated Human Plane, history, Clerk-native, registration and
Agent guidance suites passed. Independent source review is clear after the documented fixes.
The final isolated aggregate passed in 250.8s with mock keyring, native loading blocked, fake
provider commands and candidate-byte equality. An earlier aggregate stopped at the obsolete
single-Pro-entrypoint static assertion; the corrected test checks both closed entrypoints and
ordering, with a separate behavioral Free refusal case. No production change was needed for
that assertion. The final offline package passed in 27.2s with 174 installed application files
unchanged. At that original checkpoint native lifecycle/consent acceptance was unperformed and both
Clerk source gates remained false. Subsequent acceptance and development enablement are
recorded in VERIFICATION.md. No real key/store/provider/app operation or public release occurred. Preflight
was attempted but unavailable in the gitless materialization; remote-tree checks are separate.
Hosted CI was not run under the approved local fallback after the observed Actions startup block.
