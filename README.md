# API Key Case

[![CI](https://github.com/melavern/api-key-case/actions/workflows/ci.yml/badge.svg)](https://github.com/melavern/api-key-case/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-0d1714.svg)](LICENSE)

**Hand an AI coding agent the work, not the key.** API Key Case scans a project locally, reports likely secret-handling risks, and generates redacted context for Claude Code, Codex, Cursor, and similar tools. Values live in your OS secret store, and Pro `deploy` places them into Cloudflare, Vercel, or GitHub through those platforms' official CLIs — a secret value is never returned, printed, or logged.

日本語版のREADMEは **[README.ja.md](https://github.com/melavern/api-key-case/blob/main/README.ja.md)** にあります。

Brand update: Leone Apps is now Melavern. This repository update does not
publish a new npm version or change the MIT license terms. The published
`api-key-case@0.9.0` package is unchanged and still uses its embedded legacy
license endpoint; builds from this source use the Melavern endpoint. Existing
0.9.0 demo recordings are historical and may show the former branding.

> **Alpha software:** This tool reduces accidental exposure risk. It does not guarantee complete secret protection. Always review generated files before sharing them.
>
> 完全な安全は保証しない。事故確率を下げるツールです。生成物はAIや外部サービスへ渡す前に必ずご自身で確認してください。

**[Website](https://apikeycase.melavern.com/)** · **[Security](SECURITY.md)** · **[Support](SUPPORT.md)** · **[Terms](https://apikeycase.melavern.com/terms)** · **[Privacy](https://apikeycase.melavern.com/privacy)** · **[Brand and third-party notices](NOTICE)**

## Quick start

Requires Node.js 20 or later on Windows, macOS, or Linux.

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

Never put a real secret in a command argument, Issue, chat message, or generated report. `save` deliberately accepts values only from its hidden terminal prompt.

## Demo

[![API Key Case demo](https://apikeycase.melavern.com/demo-ja-poster.jpg)](https://apikeycase.melavern.com/demo-ja.mp4)

**[日本語版を見る](https://apikeycase.melavern.com/demo-ja.mp4)** / **[Watch the English original](https://apikeycase.melavern.com/demo.mp4)** (no narration) — `scan` finding a committed `.env` and a hardcoded key, `save` storing a value through a hidden prompt, `check` reporting status only, and the Pro `deploy` handing a stored value to `wrangler`.

Every terminal line in it is captured from a real run of this repository's CLI; no secret value appears at any point. The generator lives in [`demo/`](demo/) and is not part of the published npm package.

## What it does

- Checks whether `.env` and `.env.*` are ignored.
- Detects current and historical Git tracking of env files, including nested files.
- Finds required environment variable names from `.env.example` and common code references.
- Reports likely secret values without reproducing the source line or value.
- Generates an empty-value `.env.example`.
- Generates `AGENT_CONTEXT.safe.md` and `AI_SAFE_PROMPT.md` for an AI coding agent.
- Supports JSON output and a strict CI exit code.
- Stores secret values in your OS secret store (Keychain / Credential Manager / libsecret) and reports only registered/missing status — never the value itself.

The scanner does not read the contents of real `.env` files and does not make network requests.

## What it does not do

- It does not obtain API keys for you. There is no integration that logs into Cloudflare, Vercel, OpenAI or anyone else to fetch or mint a credential — you get the value from the provider and type it in once.
- It does not replace `wrangler`, `vercel`, or `gh`. `deploy` runs the real CLI you already have installed and logged in; if one is missing, it prints the manual steps instead of installing or working around anything.
- It does not approve a `production` (or GitHub) deploy on your behalf, from a script or from an agent. There is no flag, environment variable, or MCP path that skips that prompt.
- It does not guarantee that a secret stays secret. See [Security model and limitations](#security-model-and-limitations) for what it actually covers and what it cannot.

## Secret storage (`save` / `check` / `list` / `remove`)

A secret's value only ever exists on this path: you type it at an interactive, non-echoing prompt → it stays in local process memory → it is written to your OS secret store. This CLI never prints, exports, logs, or writes a secret value to a file, and it refuses to accept a value as a command-line argument or piped stdin (both would leave a trace in shell history or process logs).

```sh
api-key-case save OPENAI_API_KEY          # prompts for the value (hidden input, TTY required)
api-key-case check                        # status of every secret referenced by scan
api-key-case check OPENAI_API_KEY --json  # status of one secret
api-key-case list                         # names and metadata only, never values
api-key-case remove OPENAI_API_KEY         # deletes from the OS secret store (asks to confirm)
```

Options:

```text
--scope user|project   Store per-machine (user) or per-project (project, default).
--force                (save) overwrite an existing secret without the confirmation error.
--yes                  (remove) skip the interactive confirmation prompt.
--json                 (check, list) machine-readable output.
--strict               (check) exit with code 2 when one or more secrets are missing.
```

Exit code `3` means no OS secret store is available on this system (for example, a headless Linux box with no Secret Service provider running).

## Deploying secrets (`deploy` / `targets`) — Pro feature

`deploy` sends a value already saved with `save` to Cloudflare, Vercel, or GitHub through that platform's official CLI (`wrangler`, `vercel`, `gh`) — never through a direct API call. For `check`/`hasSecret`, the OS secret-store read result is immediately reduced to a boolean; the value is not returned, stored, or logged. During `deploy`, the value's only retained path is: OS secret store → this CLI reads it once → writes it to the target CLI's stdin → discards it. The value is never placed in a command-line argument, an environment variable, a temporary file, or a log line, and captured CLI output is scrubbed of the value before it is ever printed.

`deploy` is a one-time-purchase Pro feature. The current Free feature set (`scan`, `save`, `check`, `list`, `remove`, `targets`, and every MCP tool except `deploy_secret`) costs ¥0. See [Licensing](#licensing-deploy) below.

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

Deploying to `production` (and every deploy to `github`, since a GitHub secret of either kind exists to be consumed by CI runs this tool cannot see) requires typing `yes` at an interactive prompt after the plan is shown. There is no flag to skip this — if you need this run to be non-interactive, do it as a human at a terminal, not from a script or an agent.

If a target's CLI isn't installed or isn't logged in, `deploy` prints the manual steps to do it yourself instead of guessing or installing anything for you.

### What each platform does with the value after that

Once handed over, the value lives under the platform's rules, not this tool's:

- **Vercel `--env development` values are not sensitive.** Vercel's API does not allow sensitive variables in `development`, so `vercel` stores them as merely encrypted: anyone with access to the project can read the value back with `vercel env pull`, and it lands in a local `.env` file. `production` and `preview` default to sensitive and cannot be read back. If you want a value that stays unreadable, don't put it in `development`.
- **Cloudflare** stores it as a Worker secret (`secret_text`) — not readable afterwards, only overwritable.
- **GitHub** stores it as one of two different things, depending on `--env`. `development` (the default) writes a **repository secret**, usable by every workflow in the repository. `production` and `preview` write an **environment secret** under a GitHub Environment of that name, which only a job declaring `environment: <name>` can read — and that environment must already exist on GitHub, or `gh` fails. So on GitHub the *default* is the widest scope of the three, which is the opposite of what the name suggests; the plan shown before every deploy names which kind you are about to create. Neither kind is readable back afterwards, only overwritable.

## Licensing (`deploy`)

The current `scan`, `save`, `check`, `list`, `remove`, `targets`, and MCP feature set (minus `deploy_secret`) costs ¥0. `deploy` unlocks with a one-time Pro purchase from Lemon Squeezy — ¥2,980, not a subscription. The purchase includes the current pre-release and updates within Pro v1 (the 1.x line); a future major version may be licensed separately.

| Capability | Free | Pro |
| --- | :---: | :---: |
| Local scan and redacted agent reports | ✓ | ✓ |
| OS secret store (`save` / `check` / `list` / `remove`) | ✓ | ✓ |
| Target diagnostics and optional MCP server | ✓ | ✓ |
| Cloudflare / Vercel / GitHub `deploy` | — | ✓ |

One purchase is for one person and can be used on that person's own devices and projects. Organizations need one purchase per user. Refund requests are accepted for 14 days under the [refund policy](https://apikeycase.melavern.com/refund). The [Terms of Use](https://apikeycase.melavern.com/terms) govern the official Pro entitlement and services; they do not narrow the rights granted to the source code under MIT.

```sh
api-key-case license activate     # interactive hidden input; argv and non-TTY input are rejected
api-key-case license status [--json]
api-key-case license deactivate
```

Lemon Squeezy emails a buyer-specific purchase key. `license activate` sends that key over HTTPS to the fixed API Key Case exchange Worker once. The Worker validates the Lemon license, exact store/product/variant, and the paid/non-refunded order, then returns an Ed25519-signed `AKC1` license. The CLI verifies and stores that response. Every later Pro check is local and offline — no telemetry, machine binding, periodic revalidation, or expiry. A refunded order cannot perform a new exchange, but an `AKC1` already stored offline cannot be remotely revoked.

Successful activation and status output identify the generic entitlement as a license, never as an order:

```text
OK: pro license activated (license ls_license_xxx).
plan: pro (license ls_license_xxx, issued YYYY-MM-DD)
```

The signed AKC1 payload remains `{ "v": 1, "plan": "pro", "id": "...", "issuedAt": "..." }`; the verified in-process/JSON status names that `id` value `entitlementId`.

This project is open source under MIT, not DRM-locked: the license is a good-faith gate that funds continued development, not a technical guarantee against a determined fork. See [NOTICE](NOTICE) for the brand and third-party material boundary, and [docs/design/phase-5-license.md](docs/design/phase-5-license.md) for the full design and threat model.

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

It exposes 7 tools: `list_required_secrets`, `check_secret`, `save_secret`, `deploy_secret`, `generate_env_example`, `scan_secret_leaks`, `check_gitignore`. `save_secret` has no value parameter and never touches the vault — it tells the agent to ask a human to run `api-key-case save` themselves. `deploy_secret` never completes a `production` or `github` deploy; it likewise hands off to a human running `api-key-case deploy` in a terminal. Without an active Pro license, `deploy_secret` returns a normal (non-error) status pointing at the purchase link instead of deploying. See [packages/mcp/README.md](packages/mcp/README.md) for the full security boundary.

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
api-key-case scan [path] [options]
```

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
- `1`: invalid command, option, path, scan failure, a rejected save/remove, a secret not registered for `deploy`, or a target CLI error
- `2`: `scan --strict` or `check --strict` found warnings/missing secrets
- `3`: no OS secret store is available on this system (`save`, `check`, `list`, `remove`, `deploy`)
- `4`: `deploy` to `production` (or to `github`, always) was not confirmed — non-interactive terminal, or anything other than typing `yes`
- `5`: the `deploy` target's CLI is not installed or not logged in (manual steps are printed instead)
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
- An `AKC1` Pro license, once exchanged for offline use, cannot be revoked remotely; a refund only blocks the *next* exchange (see [Licensing](#licensing-deploy)).
- If a real credential was committed or otherwise exposed, rotating it at the provider is the only thing that undoes the exposure — a clean scan and a deleted file do not. Removing the file is not sufficient.
- `deploy` only invokes `wrangler` / `vercel` / `gh` resolved from your PATH — never a `node_modules/.bin` copy, so a malicious repository cannot ship a fake CLI to intercept a value passed on the way to a real deploy.
- `deploy` never has a flag to skip the production confirmation prompt. If you need a non-interactive production rollout, that is out of scope for this tool by design; use the platform's own CI-native secret injection instead.

See [SECURITY.md](SECURITY.md) for reporting guidance, known limitations, and what to do if a credential was exposed.

## Development

```sh
npm test
npm run build
npm pack --dry-run
```

`npm pack` runs the complete verification suite through the `prepack` lifecycle.

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

Current release: **v0.9.0 (pre-stable)**. Security fixes are provided for the latest published pre-stable release only. The CLI is usable today, but 1.0 is reserved until external users have validated it across real projects.

- Phase 1: local scanning and safe file generation
- Phase 2: OS secret store save / check / list / remove (`user` / `project` scope)
- Phase 3: deploy to Cloudflare / Vercel / GitHub via their official CLIs, plus `targets` diagnostics
- Phase 4: optional MCP server (`api-key-case mcp`) exposing the same status-only operations to an agent host
- Phase 5: Lemon Squeezy purchase-key exchange followed by an offline Pro gate for `deploy` (see [Licensing](#licensing-deploy))

## License

MIT — the full source, including `deploy`, is public. `deploy` additionally requires a one-time-purchase license key to run (see [Licensing](#licensing-deploy)); this is a good-faith gate, not a technical restriction on the code itself. See [docs/design/phase-5-license.md](docs/design/phase-5-license.md) for the design and threat model.

Product support and contribution guidance: [SUPPORT.md](SUPPORT.md) · [CONTRIBUTING.md](https://github.com/melavern/api-key-case/blob/main/CONTRIBUTING.md). Commercial disclosures: [Terms](https://apikeycase.melavern.com/terms) · [Privacy](https://apikeycase.melavern.com/privacy) · [Refunds](https://apikeycase.melavern.com/refund) · [特定商取引法に基づく表記](https://apikeycase.melavern.com/tokushoho).
