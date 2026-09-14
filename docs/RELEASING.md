# Release checklist

This checklist describes the human-controlled steps between the private
development repository and a public npm release, and records the acceptance
that each published version passed. It is deliberately documentation only:
reading it or running the verification commands below must not make the
GitHub repository public, push a commit, create a tag, deploy a Worker, or
publish to npm.

## Current OS support status — 2026-09-13

The public baseline is **Windows 11 with Windows Hello**. On that condition,
the accepted Agent-first path covers diagnosis, OS-store management, the
dedicated input and approval flow, and Pro deployment through the three
allowlisted official CLIs. Windows 10 and Hello-less accounts retain the
free diagnosis/storage boundary where available, but fail closed for the
high-risk decisions and normal deployment.

macOS is a **collaborative verification edition**, not a formal beta or a
regular-support claim. The 2026-09-12 Actions evidence includes all nine jobs
passing on candidate `255ab6e`, including the real-Keychain lane, but does not
establish native GUI approval, Accessibility resistance, Intel hardware, or a
real-Mac provider deployment. Native verification remains in progress; see the
[OS support status](https://apikeycase.melavern.com/os-support) and [macOS
verification plan](design/macos-human-plane-verification.md).

Linux continues to provide diagnosis, status/history, and human-owned-terminal
storage where an OS store is available. Agent-first input, approval, executing
deployment, and approval-required Secret/trust removal are not provided. The
Linux keyring backend and login/reboot persistence remain environment-dependent.
`deploy --dry-run` is still a Pro feature and only shows a plan; it is not free
deployment support.

## Release status — 2026-09-14

`api-key-case@0.9.1` is published on npm with Trusted Publishing provenance,
`latest` resolves to it, and the public repository carries the matching
source at annotated tag `v0.9.1` (commit `f0c2a93`). From a disposable
directory, `npx --yes api-key-case@0.9.1 --version` and `scan .` behave as
documented, and an anonymous clone resolves the tag to the same commit. The
landing page's publish gate was opened only after those external checks. Dated
observations remain in [VERIFICATION](VERIFICATION.md). The sections below
this one, up to "Normal path", are the 0.9.1 acceptance record and the
candidate-testing procedure; they are kept as history and as the template for
the next version, not as open work for 0.9.1.

## Agent-first candidate status — 2026-09-08

*Historical record; superseded by the 2026-09-14 release status above.*

The working candidate was 0.9.1. On this date npm `latest` still resolved to
0.9.0, and the public repository had not received the Agent-first changes.
The local LP therefore described a candidate, not the experience available
through a fresh registry download; its publish gate stayed closed until the
exact-version prompt and its public review links resolved to the reviewed
release. That condition was met on 2026-09-14 (see the release status above);
nothing in this section is still pending for 0.9.1.

Read documents in this order:

1. [README](../README.md) / [Japanese entry](../README.ja.md): current commands
   and supported conditions; [SECURITY](../SECURITY.md): security boundaries.
2. [Setup and readiness contract](design/agent-setup-readiness.md): what the
   user's Coding Agent coordinates and what remains a human action.
3. [Windows decision](design/windows-human-verification.md): the current
   in-process v1 boundary. Elevated-broker research is not a release dependency.
4. [Verification record](VERIFICATION.md): dated observations and their limits.
   Earlier Phase 2–4 designs and the Phase 6 investigation are history, not
   instructions to restore TTY approval or bypasses.

### 0.9.1 acceptance record (completed before publication)

| Work | Current evidence | Exit condition |
| --- | --- | --- |
| Ubuntu portable behavior and installed package | Passed; Node 20/22/24 portable scripts, Node 22 installed tarball and isolated real Secret Service; runtime audit clean | Re-run relevant checks for subsequent changes; these results do not establish Windows/macOS acceptance |
| Windows approval test driver | Native build 26200.9168 reproduced the crash; the typed `IAccessible` correction passed both positive controls and attack, recorded in [VERIFICATION](VERIFICATION.md#windows-native-candidate-acceptance--2026-09-08) | Keep `probe` first on subsequent hosts/changes. Both dummy buttons must be driver-actuated; crash/timeout is never a pass |
| Windows Human Plane | On that Windows 11/Hello host, cancel/Verified/attack, installed synthetic input/resumption, real Secret/trust deletion and refusal, zero provider-fixture spawn after refusal, fresh-consumer dummy storage, and Vercel preview force refusal/approval passed | Hello-unconfigured account remains unverified because no appropriate environment was available; retain fail-closed requirements and finish only the still-advertised host coverage |
| User's actual Coding Agent | Codex followed the LP exact-version prompt from a fresh disposable repository, ran `agent-init --host agents`, resumed in a new chat from generated AGENTS.md, and completed the selected Vercel preview flow without receiving Secret input. See [fresh-consumer acceptance](VERIFICATION.md#fresh-consumer-coding-agent-and-vercel-force-acceptance--2026-09-08) | Passed for Codex on this Windows host. Re-run after protocol/artifact changes; the sandbox/user-shell execution-context difference is a documented host constraint, not a product permission to bridge accounts |
| Real provider compatibility | All three advertised providers now have one authorized real Windows write: GitHub `development` (gh 2.96.0), Cloudflare `production` (wrangler 4.104.0) and Vercel `preview` (vercel 59.11.7). The Vercel run exposed a silent success — the CLI exited 0 without creating the variable — which is fixed and re-verified. Vercel preview `--force` also passed both refusal-without-mutation and approved delete/re-add with independent provider/history checks. See [GitHub](VERIFICATION.md#authorized-real-github-provider-write--2026-09-08), [Cloudflare](VERIFICATION.md#authorized-real-cloudflare-provider-write--2026-09-08), [Vercel](VERIFICATION.md#authorized-real-vercel-write-and-a-silent-success-defect--2026-09-08) and [fresh-consumer force acceptance](VERIFICATION.md#fresh-consumer-coding-agent-and-vercel-force-acceptance--2026-09-08) | Other provider CLI versions, advertised OSes and force paths outside this Vercel preview combination remain coverage limits, not evidence for broader compatibility. Treat a provider CLI's exit code as insufficient evidence on its own: only a real write with an independent name/metadata read-back catches a silent no-op |
| macOS contributor testing (not a Windows release blocker) | AppKit/Keychain implementation exists; 0.9.1's real GUI/architecture results remain unverified. Portable generated-script tests cover storage failure/refusal and decision control flow. [SECURITY](../SECURITY.md#known-limitations) records the button-only approval asymmetry; TCC protection against a same-user Accessibility caller remains unmeasured. See the [verification plan](design/macos-human-plane-verification.md) | Windows 11 + Hello is the normal release target. macOS remains a collaborative verification edition. Track native GUI, both removal kinds, architectures, provider discovery and Accessibility before any later promotion to regular support. CI cannot settle human/Accessibility acceptance |
| Publication and sales | Done 2026-09-14: `0.9.1` published through the gates below with provenance, exact-version bootstrap verified externally, LP gate opened afterwards | Live checkout facts were re-read the same day without a purchase |

The supported Windows path and three provider writes are accepted as recorded
above; that acceptance is not repeated for documentation-only changes, and the
macOS release-policy decision is not reopened by them. macOS native work is a
separate follow-up. Listing three adapters is not evidence that every
provider/environment/OS combination has been tested; the tested combinations
and their limitations are recorded in [VERIFICATION](VERIFICATION.md).
Environment-specific local storage, runtime injection, team support and extra
providers are outside 0.9.1's acceptance scope.
0.9.1 also includes [advisory deployment history](design/deployment-history.md).
It adds no acceptance gate: it explains past operation results and leaves
current remote values unverified.

Provider documentation must also be checked against the actual selected CLI.
Vercel's current [Secret documentation](https://vercel.com/docs/environment-variables/sensitive-environment-variables)
now permits write-only Secrets in Development and retains `--sensitive` as a
type-selection option. This was measured against vercel 59.11.7 on 2026-09-08:
the flag is accepted in Development and stores a Secret, while omitting it
stores a readable Config. Public wording in both READMEs, SECURITY.md and the
adapter now states that measured behaviour. The released adapter still omits
`--sensitive` on its Development path and requires human approval there, and
that environment stays off the automatic-safe allowlist. Moving it is a reviewed
change of the allowlist premise, not a flag edit, and must not be made from
documentation alone.

### Testing the candidate before publication

This procedure applies to an unpublished candidate of the next version. For
the published `0.9.1`, the registry package is the artifact to test:
`npx -y api-key-case@0.9.1 --version` resolves to `0.9.1` and no local
tarball is needed.

For repeatable Ubuntu verification, use `npm run test:package` and, when the
required tools are present, `npm run test:keyring:linux`. The latter creates its
own D-Bus session and store; its values and provider CLIs are fixtures.

For a human/Agent session, build and pack the reviewed checkout into a
temporary directory. Install that tarball in a **disposable consumer project**
with `npm install --no-save --ignore-scripts <absolute-path-to-tarball>`.
From that project's directory, check
`npx -y api-key-case@<candidate-version> --version` before using the LP
prompt. The locally installed version must match the prompt exactly. Do not
replace it with `@latest`, install it into a real user's project just for
testing, or publish a package to make a test resolve. The artifact lane
already verifies this local exact-version resolution.

Use this acceptance scenario on the intended Agent host:

1. Paste the LP setup prompt. The Agent identifies its project host and uses
   the exact-version protocol without asking for MCP configuration or
   overwriting existing instructions. Host shell approvals still apply.
2. Let the Agent explain Free readiness, missing names, unavailable conditions
   and unverified permissions before suggesting Pro. On Ubuntu it should
   explain the unavailable Human Plane/executing-deploy path and stop requesting dialogs.
3. On a supported desktop, enter synthetic values only in the product's
   Human Plane. Cancel one request, resume, and check that the Agent asks only
   for still-missing names. Local registration must not be called deployed.
4. For an explicitly selected disposable provider destination, use the test
   entitlement and approved test account. Review the plan in the Human Plane.
   Exercise No/cancel before approval; Windows also requires Hello Verified.
   Confirm only the requested operation runs. The Agent's chat answer cannot
   approve, and the Agent must not request a real key or purchase key in chat.
5. Interrupt and resume the conversation. Read `history --json` alongside
   `next`; distinguish past results, recorded updates and unknown current
   values. Missing/failed history must not cause blind redeployment. Propose
   cleanup separately, verify refusal preserves data, then let the human
   explicitly authorize cleanup. Keep no reusable or batch approval.

Record candidate commit/version, Agent host/version, OS/build/architecture,
Node/official CLI versions, environment, outcome and unverified conditions.
Store only sanitized evidence; never record input values, Hello input,
purchase keys or provider credentials. Fixtures are enough to test value
handling; real provider compatibility still needs authorized provider access.

## Normal path for 0.9.1 and later

The first repository publication and npm bootstrap are complete. A normal
release now follows this shorter path:

```text
Private development
  -> release candidate checks
  -> allowlisted Public export
  -> validation and security analysis
  -> reviewed Public main push
  -> reviewed immutable annotated tag
  -> protected Environment approval
  -> npm Trusted Publishing with provenance
  -> external clone and npx smoke checks
```

The Private/Public repository boundary and the exact export commands are
owned by a private maintainer runbook that is not part of this repository.
This public checklist owns package and release behavior. Initial repository
creation, visibility change, first CodeQL/security enablement and
bootstrap-token setup are not repeated.

## 1. Per-release candidate gate

Run these checks from a clean checkout and review their output:

```sh
npm test
npm audit --omit=dev
npm pack --dry-run
npm pack --dry-run --json        # optional machine-readable file-list review
npm run test:package             # actual artifact installed outside this checkout
```

On npm versions that prepend lifecycle stdout to `--json`, inspect the JSON
array after the test output, or use `npm pack --dry-run --ignore-scripts --json`
after the successful lifecycle run. Do not interpret the prepack messages as
part of the file-list JSON or omit the test gate.

On a Linux host with the Secret Service tools documented in README.md,
`npm run test:keyring:linux` additionally runs the full suite with strict
real-store E2E and the installed artifact inside a disposable D-Bus session.
Do not count this as evidence for Windows Hello, macOS dialogs or real provider
writes. The default package lane audits the fresh consumer's dependencies too:
the development repository's lockfile/overrides alone do not prove what a
new npm consumer will install.

The packed tarball must contain only the CLI build, `package.json`, public
README files, `CHANGELOG.md`, `LICENSE`, `LICENSES/0BSD.txt`, `NOTICE`, `SECURITY.md`, and `SUPPORT.md`. It must not contain
Workers source/configuration, `tools/`, tests, `.dev.vars`, key material,
purchase keys, or private operator notes. Do not run `npm publish` as a local
verification shortcut.

Before the final review, also confirm:

- `git status --short` is empty and the intended release commit is on `main`.
- Prepare the release wording in both READMEs for the reviewed export; do not
  describe an unpublished candidate as already available. Package version,
  LP exact-version prompt, schema, public
  source links, setup instructions, support claims and legal product facts
  must describe the same release. Keep dated verification history intact.
- `npm test` passes on the advertised Node.js/OS matrix, including the gated
  keyring end-to-end checks when the CI runners provide the OS secret store.
- The purchase link compiled into the CLI/MCP resolves to the live site's
  purchase section, that section's checkout URL is the live Lemon Squeezy
  checkout, the live license-exchange Worker URL is real, and the test Worker
  URL is not compiled into the CLI.
- The existing record for a controlled test-mode purchase → exchange →
  `license activate` → deploy dry-run flow is the evidence for this pre-stable
  gate; reuse it rather than repeating the purchase. Do not use a real card or
  perform a live purchase/refund for v0.9.x release preparation. Before each
  release, a human separately confirms the live checkout and provider settings.
  An already issued offline `AKC1` cannot be remotely revoked.
- `dev@melavern.com` receives support, privacy, security, and commercial
  disclosure requests. Do not use a public Issue for an order, purchase key,
  personal information, or a vulnerability.
- A human has confirmed, against the live checkout and analytics
  configuration, the sales and privacy facts the public legal pages rely on:
  the tax-inclusive one-time price, no trial, the 14-day refund conditions,
  the route to the Terms, and the analytics region/settings described in the
  Privacy Policy. Read them from the live services; do not infer them from
  the prepared text.
- `dev@melavern.com` can both receive and send/reply before release, so
  support, privacy, security and commercial requests actually reach a person.
- The maintainer has reviewed the four product security boundaries against
  `SECURITY.md`, the vault code, and the deploy handoff code: no secret value
  is ever returned to an Agent or printed; the only persistent storage for a
  Secret is the OS secret store (never a plaintext file, private database or
  log); production/GitHub and other high-risk operations require the
  Agent-independent Human Plane; and the deploy target list is a closed
  allowlist. In particular, `hasSecret` may reduce an OS-store read to a
  boolean, while only the deploy handoff may hold a value in memory long
  enough to pass it to an official CLI's stdin.
- The Public export commit and every reachable release tag have been reviewed.
  Private branches are never pushed to the Public repository. Keep any local
  backup bundle under `.git/`; never push or publish it.

## 2. One-time Public repository settings (completed for v0.9.0)

The Public repository was rebuilt from a reviewed clean root and made Public
for v0.9.0. These settings are baseline, not a checklist to recreate on every
release. Re-check them only when repository policy, plan capabilities or the
release path changes:

1. Set the homepage to `https://apikeycase.melavern.com/` and add useful
   topics such as `cli`, `secrets`, `dotenv`, `mcp`, and `typescript`.
2. Keep linear history and block force-push/deletion on `main`. The lightweight
   solo-maintainer baseline does not require a PR or status checks for every
   export push. Protect `v*` tags against deletion and non-fast-forward change.
3. Enable Dependabot alerts/security updates, secret scanning, and push
   protection. Review every alert before release; never dismiss a finding just
   to make the release green.
4. Enable GitHub Private Vulnerability Reporting and keep it separate from
   public Issues. The public Issue templates are for non-sensitive bugs only.
5. Confirm the pinned action SHAs in `.github/workflows/` are still the
   intended releases. Dependabot is configured to propose updates weekly.

## 3. npm release gate

`api-key-case@0.9.0` was the one-time bootstrap publication. Its GitHub
Environment secret was removed after success. The provider token revocation
and npm Trusted Publisher settings are separate provider-side facts: before
the next tag, inspect them rather than inferring them from the absent GitHub
secret. Do not recreate `NPM_TOKEN` for an ordinary release.

`api-key-case@0.9.1` was the first release through this path (2026-09-14):
the Trusted Publisher is Organization `melavern`, repository `api-key-case`,
workflow `publish.yml`, Environment `npm`, and npm recorded
`trustedPublisher: github` with SLSA provenance. Re-verify that configuration
and the public maintainer identity before each later tag. `0.9.0` remains
published; any unpublish requires a separate explicit approval, and removing
every version would impose npm's 24-hour republish restriction.

For each release:

1. Confirm the candidate version is not already present in the npm registry.
   Published versions are immutable and are never overwritten.
2. Confirm `package.json` version and the proposed annotated tag match exactly.
3. In the fresh Public staging clone, verify repo-local public Git identity.
   After creating the local tag, verify that it is an annotated `tag` object,
   its tagger name/email are the reviewed public identity, and its peeled
   target is the intended Public `main` commit.
4. Stop immediately before the tag push. The tag is protected against deletion
   and non-fast-forward changes and is treated as immutable.
5. `.github/workflows/publish.yml` rechecks the version, annotated tag identity
   and target, `origin/main` ancestry, Public visibility, tests and dry-run.
6. A human reviews the exact tag at the protected `npm` Environment gate. With
   `NPM_TOKEN` absent, npm authenticates using the configured Trusted Publisher
   and short-lived GitHub OIDC credential. Provenance is requested.
7. Verify registry version/latest, integrity and provenance before calling the
   release complete. A manual workflow dispatch remains validation-only and
   cannot publish.

If Trusted Publishing is absent or fails, stop and repair that provider setup.
Do not silently fall back to a long-lived token. A failed or partially
completed release needs a new version or a documented incident decision; tag
deletion/reattachment is not a normal retry mechanism.

## 4. Final public smoke check

After each publish, from a disposable directory run:

```sh
npx --yes api-key-case@<published-version> --version
npx --yes api-key-case@<published-version> scan .
npx --yes api-key-case@latest --version
```

The exact-version commands prove the intended immutable release. The `@latest`
check separately proves the registry's user-facing dist-tag resolves to that
release. Confirm an anonymous Public clone, npm page and provenance, README
links, legal pages, support email, checkout, and license exchange endpoint are
reachable. If a release used any temporary credential, verify both removal
from its CI/secret location and revocation at the credential provider.
