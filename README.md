# API Key Case

[![CI](https://github.com/melavern/api-key-case/actions/workflows/ci.yml/badge.svg)](https://github.com/melavern/api-key-case/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: Elastic-2.0](https://img.shields.io/badge/License-Elastic--2.0-0d1714.svg)](LICENSE)

**Hand an AI coding agent the work, not the key.** API Key Case scans a project locally, reports likely secret-handling risks, and generates redacted context for Claude Code, Codex, Cursor, and similar tools. Values live in your OS secret store, and Pro `deploy` places them into Cloudflare, Vercel, or GitHub through those platforms' official CLIs — a secret value is never returned, printed, or logged.

日本語版のREADMEは **[README.ja.md](https://github.com/melavern/api-key-case/blob/main/README.ja.md)** にあります。

> **This README describes the v0.9.1 pre-stable Agent-first release.** `@latest` follows npm's published dist-tag, which can lag during staged publication. Confirm that the exact `0.9.1` package is available before testing or purchasing for this workflow; the [release checklist](docs/RELEASING.md) records its acceptance evidence and publication gates.
>
> This pre-stable tool reduces accidental exposure risk. It does not guarantee complete secret protection. Always review generated files before sharing them.
>
> 完全な安全は保証しない。事故確率を下げるツールです。生成物はAIや外部サービスへ渡す前に必ずご自身で確認してください。

**[Website](https://apikeycase.melavern.com/)** · **[OS support status](https://apikeycase.melavern.com/os-support)** · **[npm](https://www.npmjs.com/package/api-key-case)** · **[Changelog](CHANGELOG.md)** · **[Security](SECURITY.md)** · **[Support](SUPPORT.md)** · **[Terms](https://apikeycase.melavern.com/terms)** · **[Privacy](https://apikeycase.melavern.com/privacy)** · **[Brand and third-party notices](NOTICE)**

## Quick start

The normal Agent-first support baseline is Windows 11 with Windows Hello.
macOS is a collaborative verification edition: its implementation, current
CI and real Keychain evidence exist, while native GUI approval, Accessibility
resistance, Intel hardware and real-Mac provider deployment remain unverified.
macOS verification is still in progress; do not purchase Pro relying on macOS
deploy. See the [OS support status](https://apikeycase.melavern.com/os-support)
and the [macOS verification plan](docs/design/macos-human-plane-verification.md).

Requires Node.js 20 or later on Windows, macOS, or Linux. On Windows, high-risk
approval, `remove`, and `trust forget` in v0.9.1 require Windows 11 build 22000 or later
**and Windows Hello (PIN, fingerprint, or face) set up for that account**;
Windows 10 and accounts without Hello fail closed for those decisions and hand
off to a human instead, while scan, vault, and Secret input remain available.
Because `deploy` is the paid feature, check that before buying. Linux supports
local diagnosis, status/history, and human-owned-terminal storage when an OS
store is available; Agent-first input, approval, executing deploy, and
approval-required value/trust removal are not provided. Linux keyring backend
selection and login/reboot persistence remain environment-dependent.

The published release's basic commands can be tried independently:

```sh
# Scan the current project locally. Real .env contents are not read.
npx -y api-key-case@latest scan .

# Generate redacted context for an AI coding agent.
npx -y api-key-case@latest scan . --agent-report

# Save a value through a hidden interactive prompt.
npx -y api-key-case@latest save OPENAI_API_KEY

# Check status only. The value is never returned.
npx -y api-key-case@latest check OPENAI_API_KEY
```

Never put a real secret in a command argument, Issue, chat message, or generated report. Human-owned terminal use keeps the hidden prompt; Agent-first use must request `save --ask` and enter the value only in the Human Plane dialog.

### Start with your current `.env`

You can register keys you already use without letting the Agent read `.env`. Confirm only the Secret name, open the file yourself, and copy only its value into the Human Plane. This is not automatic ingestion: API Key Case does not delete, synchronize, replace, or otherwise change the original `.env`, so you can keep using it where needed. Registration can be the end of the task; deploy is separate.

The scanner currently recognizes `.env.example` plus common JavaScript/TypeScript references. A missed name in another language or unsupported syntax does not mean the Secret is unnecessary: if you know its name, you can still save or check it directly. Storage has no deployment-environment dimension, so one project/name cannot hold different development and production values at the same time; choose which single value to register and do not overwrite an existing entry unintentionally.

Deployment has additional provider/project constraints. In particular, Cloudflare Agent-first deploy stops under API Key Case's safety conditions when a Wrangler project also has a real `.env`, `.env.*` (excluding `.env.example`), `.dev.vars`, or `.dev.vars.*` file, because Wrangler can load those files. This is not a login or Free-plan failure: local Secret registration remains available, and API Key Case does not modify the file. Run the Free readiness diagnosis before purchasing Pro.

## Agent-first Control and Human Planes (Phase A/B/C/D/E)

The following commands require v0.9.1. Confirm
`npx -y api-key-case@0.9.1 --version` resolves to `0.9.1` before use. Until npm
lists that exact version, use an installed candidate tarball as described in
[candidate testing](docs/RELEASING.md#testing-the-candidate-before-publication).

```sh
api-key-case agent-init .          # print the session protocol and manage existing host instructions
api-key-case agent-init . --check  # no-write drift/symlink safety check
api-key-case agent-init . --host agents # explicitly create AGENTS.md in a fresh project
api-key-case next --json .         # closed semantic status and nextActions
api-key-case save OPENAI_API_KEY --ask # separate Windows/macOS Human Plane
api-key-case history --json .      # Free: past deploy results, never current values
```

`agent-init` preserves content outside its managed block, writes only inside the project, rejects symlinks/junctions, and does not edit global or MCP configuration. Persistent instructions pin the exact version that runs `agent-init` (for example, `api-key-case@0.9.1`), never `@latest` or a floating major line; this prevents a later pre-stable minor release from changing an existing repository's Agent protocol without an explicit `agent-init` rerun.

`next --json` returns closed enums and names/status only. It has no `command`, `argv`, or free-form execution field, and never includes a secret value, partial value, value-derived hash, or value length. For `actor: "human"`, `kind: "register-secret"`, the exact-version Agent protocol requests `save <NAME> --ask`; the value is entered only in the separate Human Plane and only status returns to the Agent side.

Schema 2 adds Free readiness and a project setup summary for **your existing Coding Agent** to explain in your language. `setup.stage` and `setup.counts` show what is registered, what is missing, and what needs attention. `host` describes input/approval requirements; each target's `readiness` checks its environments using the same trusted CLI/configuration rules as executing deploy, without placing a Secret or opening a dialog. Environmental blockers are separate from `license.plan`: purchasing Pro cannot fix an unsupported host. `prerequisites-checked` still leaves human interaction and provider write permission unverified; deploy always rechecks its own boundaries. Local registration is not remote deployment: `setup.deploymentState` remains `not-inspected`.

The Agent groups missing names, opens existing input dialogs sequentially, prepares the requested destination, and summarizes actual operation results. Cancellation or failure stops the group; it does not create a reusable or batch approval. Provider login, key issuance, purchase/license activation and OS verification remain human prerequisites. For a fresh repository, the current Agent can explicitly use `agent-init --host agents`, `--host claude`, or `--host cursor`; this creates only that host's project instructions with the same path/drift checks. Without `--host`, only existing host markers are used. See [the setup contract](docs/design/agent-setup-readiness.md).

Each target in `next --json` also carries a `deployment` block: `automatic` lists the environments an agent may deploy to right now with no human interaction, `humanApproval` lists the rest, and `destinationTrust` reports whether this project's destination is `trusted`, `unconfirmed`, `changed`, `unresolved`, or `not-applicable`. An unconfirmed or changed destination adds an `actor: "human"`, `kind: "approve-deploy-destination"` action. The agent relays it; it can never satisfy it.

Phase B Secret input and Phase C high-risk approval use separate OS dialogs on Windows and macOS. On Windows 11 build 22000+ with Windows Hello set up, the plan dialog's Yes/Delete button only starts `IUserConsentVerifierInterop::RequestVerificationForWindowAsync`; only the OS result `Verified` approves, and every other result fails closed. Linux, Windows 10, accounts without Hello, headless sessions, and hosts where the fixed system helper cannot be verified hand off instead. There is no Agent-owned PTY fallback. Production, GitHub, Vercel development (provider-readable), destructive/overwrite-capable operations, and other high-risk plans require this boundary. Phase C binds the verified decision to one in-process execution snapshot.

Phase D adds the destination side of that boundary. Every deploy that actually runs is bound to one Destination Identity — the fixed project realpath, target, environment, destination-selecting repository config, and the provider account identity resolved through the same trusted CLI and sanitized environment. A human confirming an operation once records that identity in the OS secret store; a first use or any change to it goes back through the Human Plane. Only Vercel `preview` on a confirmed destination, in `project` scope and without `--force`, can then repeat without asking again.

### Past deployment results

On a new chat or resumed deployment task, the Agent also reads `history --json`.
It reports past `completed`, `incomplete` or `unknown` operations. A failed
`--force` may already have changed the provider; interrupted or unsaved results
remain unknown. A later registration timestamp flags an update, but matching
timestamps and destination selection never prove the current value is the same.
History supplies no approval, trust, automatic retry or automatic redeployment.

The local metadata file at `~/.api-key-case/deployment-history/` retains the
last 200 attempts per project. It contains names, scopes, target/environment,
destination-only identifiers and operation timestamps/results; no values,
partial values, value hashes/lengths or provider output. When no deploy is
running, you can explicitly delete that directory (or one project subdirectory)
to discard history; stored values and destination trust are separate. Missing
or unreadable history is unknown. A start-save failure blocks before a provider
write; a result-save failure warns even if the deployment succeeded. Stop and
agree remaining work instead of automatically repeating that operation.
History report schema 2 distinguishes an absent journal from lock, invalid-data,
access and other closed failure codes, with recovery guidance for your Agent.
A lock may belong to a running operation; it does not prove a crash. A successful
inspection does not test write access. Start failures identify that this
invocation made no provider write; result-save failures retain the actual
operation result. Reinspect after addressing the cause, and explicitly decide
any metadata discard or fresh deployment. No existing lock/history is removed
automatically to recover. Existing journal files remain schema 1.
See the [history contract](docs/design/deployment-history.md).

## Demo

[![API Key Case workflow illustration](https://apikeycase.melavern.com/launch-ja-poster.jpg)](https://apikeycase.melavern.com/launch-ja.mp4)

**[Watch the 28-second workflow illustration](https://apikeycase.melavern.com/launch-ja.mp4)** (Japanese captions and audio) — an Agent guides GitHub Secret setup while the human enters and approves the value through the dedicated interface.

This is a composed illustration, not a recording of a live credential deployment. It contains no real secret. The legacy CLI demo generator remains in [`demo/`](demo/) for reference, but its old recordings are not part of the current site or npm package.

## What it does

- Checks whether `.env` and `.env.*` are ignored.
- Detects current and historical Git tracking of env files, including nested files.
- Finds required environment variable names from `.env.example` and common code references.
- Reports likely secret values without reproducing the source line or value.
- Generates an empty-value `.env.example`.
- Generates `AGENT_CONTEXT.safe.md` and `AI_SAFE_PROMPT.md` for an AI coding agent.
- Supports JSON output and a strict CI exit code.
- Stores secret values in your OS secret store (Keychain / Credential Manager / Linux OS keyring) and reports only registered/missing status — never the value itself.

The scanner core does not read the contents of real `.env` files and does not make network requests. After a targeted command finishes, a separate best-effort anonymous usage event may be sent when telemetry is enabled; scan data is never passed to that module.

## Anonymous usage telemetry

The CLI uses one privacy-limited PostHog event, `cli_command_result`, for aggregate product decisions. It is sent only for `scan`, `save`, `license_activate`, and `deploy`, and contains the fixed context `product: api_key_case`, `surface: cli`, plus closed values such as the command, outcome, CLI version, OS family, and (for `deploy`) the allowlisted target. It never contains secret values or names, environment variable names, paths, scan findings, argv, project or license information, or raw terminal input.

Telemetry is enabled by default, but the first eligible interactive command prints a one-time notice before sending anything. The v0.9.1 distribution build includes API Key Case's public PostHog Project Token, so this build needs no user-provided telemetry token. `API_KEY_CASE_POSTHOG_PROJECT_TOKEN` remains a development/test/override hook and takes precedence when non-empty. The package never contains a Personal API Key or Project Secret API Key. A custom build with no distribution token safely no-ops. Telemetry is suppressed before the notice in non-interactive runs, and is always suppressed in CI or when `DO_NOT_TRACK=1` is set. PostHog failures and timeouts are ignored so they cannot change the command result. The anonymous installation ID is a random value stored only in `~/.api-key-case/telemetry.json`; it is not derived from the machine, user, repository, license, or hardware.

```sh
api-key-case telemetry status
api-key-case telemetry enable
api-key-case telemetry disable
```

`disable` stops telemetry and removes the anonymous installation ID. Enabling it later creates a new ID. The full event contract and interpretation rules are in [`docs/analytics/MEASUREMENT.md`](docs/analytics/MEASUREMENT.md).

## What it does not do

- It does not obtain API keys for you. There is no integration that logs into Cloudflare, Vercel, OpenAI or anyone else to fetch or mint a credential — you get the value from the provider and type it in once.
- It does not replace `wrangler`, `vercel`, or `gh`. `deploy` runs the real CLI you already have installed and logged in; if one is missing, it prints the manual steps instead of installing or working around anything.
- MCP never completes a `production` or GitHub deploy and has no approval parameter or elicitation path. High-risk CLI deploys require the separate Human Plane; Agent-owned stdin/PTY input cannot approve them.
- It does not guarantee that a secret stays secret. See [Security model and limitations](#security-model-and-limitations) for what it actually covers and what it cannot.

## Secret storage (`save` / `check` / `list` / `remove`)

A secret has one of two local paths. In a human-owned terminal: hidden prompt → local CLI process memory → OS secret store. In Windows/macOS Agent-first use: Human Plane password dialog → sanitized fixed-path helper memory → Credential Manager/Keychain. The helper writes directly and returns only status to the parent. The macOS helper calls Security.framework in the same `/usr/bin/osascript` process; it does not invoke the `security` CLI or a value-bearing child process. Neither path prints, exports, logs, or writes the value to a file, and no path accepts the value in argv or piped stdin.

```sh
api-key-case save OPENAI_API_KEY          # prompts for the value (hidden input, TTY required)
api-key-case save OPENAI_API_KEY --ask    # Windows/macOS Human Plane; Agent-side stdin is ignored
api-key-case check                        # status of every secret referenced by scan
api-key-case check OPENAI_API_KEY --json  # status of one secret
api-key-case list                         # names and metadata only, never values
api-key-case remove OPENAI_API_KEY        # deletes from the OS secret store (Human Plane decision)
```

Options:

```text
--scope user|project   Store per-machine (user) or per-project (project, default).
--force                (save) overwrite an existing secret without the confirmation error.
--ask                  (save) request Agent-independent Human Plane Secret input.
--json                 (check, list) machine-readable output.
--strict               (check) exit with code 2 when one or more secrets are missing.
```

`remove` deletes a value only after a human answers the same Agent-independent
Human Plane dialog used for high-risk deploys. There is no `--yes` and no stdin
confirmation, so an agent that controls this process's terminal cannot complete
a deletion. Where that dialog is unavailable, `remove` fails closed and points
at the OS secret store's own UI instead.

Exit code `3` means no usable OS secret store was available for the operation.
On Linux the current keyring dependency can fall back from Secret Service to
kernel keyutils. Missing D-Bus alone does not imply this exit code, and an
`available` status does not prove persistence across login/reboot. See
[the observed storage limits](SECURITY.md#known-limitations).

## Deploying secrets (`deploy` / `targets`) — Pro feature

`deploy` sends a value already saved with `save` to Cloudflare, Vercel, or GitHub through that platform's official CLI (`wrangler`, `vercel`, `gh`) — never through a direct API call. For `check`/`hasSecret`, the OS secret-store read result is immediately reduced to a boolean; the value is not returned, stored, or logged. During `deploy`, the value's only retained path is: OS secret store → this CLI reads it once → writes it to the target CLI's stdin → discards it. The value is never placed in a command-line argument, an environment variable, a temporary file, or a log line, and captured CLI output is scrubbed of the value before it is ever printed.

`deploy`, including `--dry-run`, is a one-time-purchase Pro feature. Free covers
`scan`, `save`, `check`, `list`, `remove`, `targets`, `agent-init`, `next`, `history`,
`trust status`, `trust forget`, and every MCP tool except `deploy_secret`.
Free access does not bypass the host/approval conditions. See [Licensing](#licensing-deploy) below.

```sh
api-key-case targets                                    # what's detected here, and is each CLI installed/logged in?
api-key-case deploy OPENAI_API_KEY --target cloudflare   # development env by default
api-key-case deploy OPENAI_API_KEY --target vercel --env preview
api-key-case deploy OPENAI_API_KEY --target cloudflare --env production --dry-run
```

Options:

```text
--target <cloudflare|vercel|github>   Required. This is a closed list; no other target is supported.
--env production|preview|development  Default: development. production is never the default.
                                      On github this also decides repository vs environment
                                      secret — see "What each platform does" below.
--scope user|project                  Default: project. Does not fall back to user if not found there.
--dry-run                             Show the plan and stop before reading the value or running anything.
--force                               Vercel only: remove an existing value first, then add the new one.
```

Deploying to `production`, every deploy to `github`, Vercel `development` (provider-readable), every `--force` operation, every `--scope user` deploy, and provider operations that can overwrite an existing value require the Agent-independent Human Plane. On Windows 11 build 22000+ with Windows Hello set up, a fixed-path PowerShell plan dialog is followed by HWND-bound OS user verification, and only `Verified` approves. The existing macOS AppKit dialog remains unchanged. Approval and execution remain inside one call. Linux, Windows 10, accounts without Hello, and unavailable/headless Human Plane sessions fail closed with a human handoff instead of accepting stdin or a reusable token.

Everything else needs a destination a human already confirmed. Vercel `preview`, in `project` scope and without `--force`, is the only operation class that may repeat without asking — and only while its Destination Identity is unchanged. Cloudflare stays out of it because `wrangler secret put` always overwrites; GitHub stays out because a GitHub secret is CI-reachable at any `--env`.

Every deploy that runs requires one concrete local destination: exactly one Wrangler config with `name` and `account_id`, Vercel `.vercel/project.json` with org and project IDs, or the GitHub repository root with one unambiguous `origin` remote on `github.com`. The dialog shows that destination, whether it is a first use or has changed since your last approval, the fixed provider identity, cwd, CLI path, environment, command, and destructive pre-steps. Ambiguous or changing state is denied. Windows resolves the trusted CLI/profile independently from registry state; macOS uses the OS user database and a closed, architecture-aware set of common install locations. Both pass a fresh sanitized environment and pin/recheck the exact CLI; macOS also pins the exact Node runtime for Node-shebang provider CLIs. Linux currently hands off executing deploy and prints the manual provider steps instead.

If a target's CLI isn't installed or isn't logged in, `deploy` prints the manual steps to do it yourself instead of guessing or installing anything for you.

### Reviewing confirmed destinations (`trust`)

```sh
api-key-case trust status                                 # which destinations you confirmed here
api-key-case trust forget --target vercel --env preview   # make it ask for approval again
```

`trust status` is read-only. `trust forget` deletes the confirmation through the
same Human Plane dialog, which can only ever cause the next deploy to ask for
approval again — it never grants one. Only the classes that may repeat without
asking record anything at all, so the list is short by construction.

### What each platform does with the value after that

Once handed over, the value lives under the platform's rules, not this tool's:

- **Vercel `--env development` values are readable back.** `deploy` does not pass `--sensitive` there, so `vercel` stores a Config variable: anyone with access to the project can read the value back with `vercel env pull`, and it lands in a local `.env` file. If you want a value that stays unreadable, don't put it in `development`. Older Vercel releases rejected sensitive variables in `development` outright; on `vercel` 59.11.7 the flag is accepted there (measured 2026-09-08), so this is now this tool's own conservative default rather than a provider restriction. For `production` and `preview`, `deploy` passes `--sensitive` itself rather than relying on Vercel's default, so the value is stored write-only and cannot be read back — the plan shown before every deploy includes that flag. `preview` also passes `--yes`, which takes the CLI's documented default for its Git-branch question, every Preview branch; without it a non-interactive run stops at that prompt and exits successfully having created nothing. (A `vercel` CLI too old to know these flags fails the deploy instead of quietly storing a readable value.)
- **Cloudflare** stores it as a Worker secret (`secret_text`) — not readable afterwards, only overwritable.
- **GitHub** stores it as one of two different things, depending on `--env`. `development` (the default) writes a **repository secret**, usable by every workflow in the repository. `production` and `preview` write an **environment secret** under a GitHub Environment of that name, which only a job declaring `environment: <name>` can read — and that environment must already exist on GitHub, or `gh` fails. So on GitHub the *default* is the widest scope of the three, which is the opposite of what the name suggests; the plan shown before every deploy names which kind you are about to create. Neither kind is readable back afterwards, only overwritable.

## Licensing (`deploy`)

Diagnosis/readiness, Agent setup, local storage and trust management, and MCP
tools other than `deploy_secret` are Free within their supported conditions.
`deploy`, including dry-run, unlocks with a one-time Pro purchase from Lemon
Squeezy — ¥2,980, not a subscription. The purchase includes v0.9.1 and updates
within Pro v1 (the 1.x line); a future major version may be licensed separately.

| Capability | Free | Pro |
| --- | :---: | :---: |
| Local scan and redacted agent reports | ✓ | ✓ |
| OS secret store (`save` / `check` / `list` / `remove`) | ✓ | ✓ |
| Target/readiness diagnostics, Agent setup and trust management | ✓ | ✓ |
| Optional MCP tools other than `deploy_secret` | ✓ | ✓ |
| Cloudflare / Vercel / GitHub `deploy`, including dry-run | — | ✓ |

One purchase is for one person and can be used on that person's own devices and projects. Organizations need one purchase per user. Refund requests are accepted for 14 days under the [refund policy](https://apikeycase.melavern.com/refund). The [Terms of Use](https://apikeycase.melavern.com/terms) govern the official Pro entitlement and services. Source-code use is a separate layer governed by the `LICENSE` shipped with each version.

```sh
api-key-case license activate     # interactive hidden input; argv and non-TTY input are rejected
api-key-case license status [--json]
api-key-case license deactivate
```

Lemon Squeezy emails a buyer-specific purchase key. `license activate` sends that key over HTTPS to the fixed API Key Case exchange Worker once. The Worker validates the Lemon license, exact store/product/variant, and the paid/non-refunded order, then returns an Ed25519-signed `AKC1` license. The CLI verifies and stores that response. Every later Pro check is local and offline — there is no license revalidation, machine binding, or expiry check. This is separate from the privacy-limited, opt-out usage telemetry described above. A refunded order cannot perform a new exchange, but an `AKC1` already stored offline cannot be remotely revoked.

Successful activation and status output identify the generic entitlement as a license, never as an order:

```text
OK: pro license activated (license ls_license_xxx).
plan: pro (license ls_license_xxx, issued YYYY-MM-DD)
```

The signed AKC1 payload remains `{ "v": 1, "plan": "pro", "id": "...", "issuedAt": "..." }`; the verified in-process/JSON status names that `id` value `entitlementId`.

API Key Case 0.9.1 product code is source available under the Elastic License 2.0 (`Elastic-2.0`). The source, security-sensitive implementation, tests, and design records remain public so their behavior and boundaries can be inspected; this is not a claim that the project has been independently audited. The Pro entitlement and license-key implementation are unchanged and are separate from the source-code license. See [NOTICE](NOTICE) for the generated-instruction, brand, and third-party material boundaries, and [docs/design/phase-5-license.md](docs/design/phase-5-license.md) for the full design and threat model.

## MCP server (optional, for agents)

The CLI above is the primary interface. `api-key-case mcp` additionally starts an MCP (stdio) server exposing the same status-only operations directly to an agent host — no secret value ever flows over the MCP protocol.

```sh
api-key-case mcp [path]   # path defaults to the current directory
```

Register it with a client:

```sh
# Claude Code
claude mcp add api-key-case -- npx -y api-key-case mcp
```

```json
// Cursor (mcp.json)
{ "mcpServers": { "api-key-case": { "command": "npx", "args": ["-y", "api-key-case", "mcp"] } } }
```

It exposes 7 tools: `list_required_secrets`, `check_secret`, `save_secret`, `deploy_secret`, `generate_env_example`, `scan_secret_leaks`, `check_gitignore`. `save_secret` has no value parameter and never touches the vault — it returns a fixed `save --ask` Human Plane action. MCP elicitation is never used for the value. `deploy_secret` never completes a `production` or `github` deploy; it likewise hands off to a human running `api-key-case deploy` in a terminal. Without an active Pro license, `deploy_secret` returns a normal (non-error) status pointing at the purchase link instead of deploying. See [packages/mcp/README.md](packages/mcp/README.md) for the full security boundary.

## Requirements

- Node.js 20 or later
- Git is recommended for tracking and history checks

## Development checkout

```sh
npm install
npm test
node dist/cli/index.js scan .
```

## Commands

```sh
api-key-case agent-init [path] [--check] [--host agents|claude|cursor]
api-key-case next --json [path]
api-key-case history --json [path]
api-key-case scan [path] [options]
```

`agent-init` bootstraps the status-only Agent protocol and updates recognized project instruction markers, or the current host explicitly selected with `--host`. `--check` performs no writes and exits `2` when persistence is missing or drifted. `next` requires `--json` and emits the closed schema described above.

Options:

```text
--json                Emit a machine-readable report.
--strict              Exit with code 2 when warnings are found.
--write-env-example   Generate .env.example with empty values.
--agent-report        Generate agent-safe context and prompt files.
--force               Replace generated files that already exist.
```

Examples:

```sh
api-key-case scan .
api-key-case scan . --strict
api-key-case scan . --json
api-key-case scan . --write-env-example
api-key-case scan . --agent-report
api-key-case scan . --agent-report --force
```

Generated files are preserved by default. Existing files are replaced only when `--force` is supplied.

## Agent report

`--agent-report` generates:

- `.env.example`: detected variable names with empty values
- `AGENT_CONTEXT.safe.md`: variable names, usage locations, and implementation constraints
- `AI_SAFE_PROMPT.md`: a reusable prompt for an AI coding agent

The generated Markdown contains names and file locations, not secret values. Treat every generated file as a draft and review it before sharing.

## Exit codes

- `0`: command completed; `check` warnings/missing secrets may exist unless `--strict` was used (a completed `deploy --dry-run` is also `0`)
- `1`: invalid command, option, path, scan failure, a rejected save/remove, an operation changed after approval, a secret not registered for `deploy`, or a target CLI error
- `2`: `scan --strict` / `check --strict` found warnings/missing secrets, or `agent-init --check` found missing/drifted persistence
- `3`: no OS secret store is available on this system (`save`, `check`, `list`, `remove`, `deploy`)
- `4`: Human Plane Secret input was cancelled, or a high-risk deploy was explicitly declined
- `5`: the `deploy` target's CLI is not installed/logged in, the trusted CLI/Human Plane boundary is unavailable, or deployment history cannot save a start before provider writes
- `6`: `deploy` requires a Pro license (`api-key-case license activate`)

## Security model and limitations

- Findings use `***REDACTED***`; source lines and partial values are not shown.
- Real env files are inspected by filename and Git state, not by content.
- Token detection is heuristic, matches a closed set of known key shapes, and only scans specific text file extensions (skipping `node_modules`, `dist`, build output, and files over 1 MB) — it can produce false positives or miss an unfamiliar format or an unscanned file. A clean scan means "nothing obvious found," not "nothing there."
- Git history checks detect env filenames, not every historical secret value.
- A malicious repository may contain misleading source text or filenames. Review generated context before giving it to an agent.
- This is not a replacement for GitHub secret scanning, Gitleaks, TruffleHog, a secret manager, or credential rotation.
- Once `deploy` hands a value to `wrangler`, `vercel`, or `gh` on its stdin, that value is inside the official CLI's own process — subject to its logging and behavior, not this project's. Output scrubbing covers what comes back to this CLI, not what the target CLI does internally.
- Nothing here stops a person from reading a value out of the OS secret store's own UI (Keychain Access, Credential Manager, or a Secret Service front end on Linux) and pasting or typing it into a chat, ticket, or AI conversation by hand — this tool only closes the paths it directly controls.
- The OS secret store is only as strong as your OS account and whatever per-application access control your OS keychain enforces. This CLI relies on that platform protection rather than adding a second one of its own.
- An `AKC1` Pro license, once exchanged for offline use, cannot be revoked remotely; a refund only blocks the *next* exchange (see [Licensing](#licensing-deploy)). This offline license check is independent of the opt-out anonymous usage telemetry.
- If a real credential was committed or otherwise exposed, rotating it at the provider is the only thing that undoes the exposure — a clean scan and a deleted file do not. Removing the file is not sufficient.
- Every executing `deploy` freezes a trusted absolute CLI path and a sanitized environment, then aborts if the project cwd, destination config, auth metadata, provider environment presence, plan, or CLI identity changes before spawn. `--dry-run` still uses plain PATH resolution because it runs nothing.
- High-risk deploy has no flag, stdin approval, approval parameter, or reusable approval credential. If the Human Plane is unavailable, use the platform's own CI-native secret injection instead.
- A destination trust record is not an approval. It stores only a destination fingerprint in the OS secret store, grants nothing on its own, and never covers `production`, `github`, Vercel `development`, `--force`, or a destination that has changed. It also cannot be created by writing a file: anything able to call the OS credential API directly is already inside the OS-account trust boundary this tool relies on.

See [SECURITY.md](SECURITY.md) for reporting guidance, known limitations, and what to do if a credential was exposed.

## Development

```sh
npm test
npm run build
npm pack --dry-run
```

`npm pack` runs the complete verification suite through the `prepack` lifecycle.

`npm run test:package` builds a real tarball, checks its file boundary, installs
it into a disposable consumer project without development dependencies, and
exercises executable discovery, fresh Agent-host setup, drift refusal and
diagnosis. It also audits that consumer's runtime dependencies. Add
`-- --offline` to use cached packages and skip the network audit.

On Linux with `dbus-run-session`, `gnome-keyring-daemon`, `dbus-send` and `gdbus`
already installed, `npm run test:keyring:linux` creates a disposable D-Bus
session and XDG data directory. It runs the complete suite with strict real
OS-store checks, then verifies the installed tarball against that store. All
values are synthetic; the user's existing login keyring is not replaced.
This does not add Linux Human Plane/deploy support or verify Windows/macOS
dialogs. See [the verification record](docs/VERIFICATION.md).

The repository intentionally contains synthetic canary values in tests and demo fixtures so the scanner's redaction behavior can be verified. A root-level `npm run scan` may therefore report expected warnings from those fixtures; do not weaken the scanner or add broad skip rules to silence them. Review the paths and confirm they are test-only before treating a finding as a release blocker.

### License exchange Worker environments

The test and live exchange services use separate Wrangler files, Worker names, secrets, and rate-limit namespaces. `LEMON_TEST_MODE` is fixed by each file and is not entered as a secret. Enter only values from the matching Lemon mode; do not reuse test store/product/variant IDs in live or vice versa.

```sh
# Test secrets (repeat for LEMON_PRODUCT_ID, LEMON_VARIANT_ID,
# LEMON_API_KEY, and AKC_ED25519_PRIVATE_KEY)
npx wrangler secret put LEMON_STORE_ID --config workers/license-exchange/wrangler.test.jsonc
npx wrangler deploy --dry-run --config workers/license-exchange/wrangler.test.jsonc
npx wrangler deploy --config workers/license-exchange/wrangler.test.jsonc

# Live secrets (repeat for the same five names, using live Lemon values)
npx wrangler secret put LEMON_STORE_ID --config workers/license-exchange/wrangler.live.jsonc
npx wrangler deploy --dry-run --config workers/license-exchange/wrangler.live.jsonc
npx wrangler deploy --config workers/license-exchange/wrangler.live.jsonc
```

The test Worker is `api-key-case-license-exchange-test`; live is `api-key-case-license-exchange`. Only the deployed live HTTPS endpoint may replace `LICENSE_EXCHANGE_URL` in the published CLI. See [workers/license-exchange/README.md](workers/license-exchange/README.md) for the complete setup matrix and all secret commands.

## Status and roadmap

Current source version: **v0.9.1 (pre-stable)**. Security fixes are provided for the latest published pre-stable release only. Code completion and portable tests do not establish acceptance on real Agent hosts, Windows/macOS dialogs or provider accounts. See the [release checklist](docs/RELEASING.md), [verification record](docs/VERIFICATION.md) and [changelog](CHANGELOG.md). Version 1.0 remains reserved until external users have validated real projects.

- Phase 1: local scanning and safe file generation
- Phase 2: OS secret store save / check / list / remove (`user` / `project` scope)
- Phase 3: deploy to Cloudflare / Vercel / GitHub via their official CLIs, plus `targets` diagnostics
- Phase 4: optional MCP server (`api-key-case mcp`) exposing the same status-only operations to an agent host
- Phase 5: Lemon Squeezy purchase-key exchange followed by an offline Pro gate for `deploy` (see [Licensing](#licensing-deploy))
- Phase 6A/B/C/D/E: exact-version Agent Control Plane, Windows/macOS Human Plane Secret input, single-use high-risk approval bound to an execution snapshot, persistent destination trust with a deny-by-default automatic policy, and a removal/cleanup lifecycle in which an agent can propose deletions but never complete one. Linux Human Plane and executing deploy are not included

## License

API Key Case 0.9.1 product code is source available under the Elastic License 2.0 (`Elastic-2.0`); the full source, including `deploy`, remains public. The managed instruction text generated by `agent-init`—and only that text—is available under the standard 0BSD license so it can be kept, edited, and shared in a user's repository without changing that repository's license. API Key Case 0.9.0 remains available under the MIT license shipped with that release. See [LICENSE](LICENSE), [the 0BSD text](LICENSES/0BSD.txt), and [NOTICE](NOTICE) for the exact scope.

Product support and contribution guidance: [SUPPORT.md](SUPPORT.md) · [CONTRIBUTING.md](https://github.com/melavern/api-key-case/blob/main/CONTRIBUTING.md). Commercial disclosures: [Terms](https://apikeycase.melavern.com/terms) · [Privacy](https://apikeycase.melavern.com/privacy) · [Refunds](https://apikeycase.melavern.com/refund) · [特定商取引法に基づく表記](https://apikeycase.melavern.com/tokushoho).
