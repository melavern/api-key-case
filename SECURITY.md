# Security Policy

## Scope

API Key Case is an experimental local safety tool. It is designed to reduce accidental disclosure while preparing API integrations for AI coding agents. It does not guarantee complete safety — it is a tool that reduces the probability of an incident, not one that eliminates it — and it does not guarantee detection or prevention of every secret leak.

The CLI is expected to:

- avoid reading the contents of `.env` and `.env.*` files, except example templates;
- avoid network requests during scans;
- avoid emitting full or partial detected secret values;
- preserve generated files unless replacement is explicitly requested with `--force`;
- report only variable names, file locations, Git state, and redacted findings.

### Secret storage boundary (`save` / `check` / `list` / `remove`)

- A secret value's only path is: interactive hidden-input prompt → local process memory → the OS secret store (Keychain / Credential Manager / libsecret). No other function in this codebase returns a secret value.
- `check`/`hasSecret` uses the OS secret store's read API only to determine whether an entry exists, then immediately reduces the result to a boolean. It does not return, persist, log, or expose the value. This is distinct from the deploy handoff, which is the only path that must retain a value long enough to pass it to an official CLI.
- `save` refuses a value passed as a command-line argument or as piped/non-TTY stdin, and tells you to rotate the key if you did so accidentally (either path can leave the value in shell history or a process log).
- `check` and `list` report only registered/missing status, names, scopes, and timestamps. The on-disk metadata index (`~/.api-key-case/index.json`) never contains a value, a hash of a value, or a value's length.
- The `Vault` interface deliberately has no method that returns a secret value; this is enforced by source review and by tests that grep for forbidden helper names.

### Deploy boundary (`deploy` / `targets`)

- A secret value's only path during `deploy` is: the OS secret store → `packages/core/deploy/handoff.ts` reads it once → it is written to the target CLI's (`wrangler` / `vercel` / `gh`) stdin → the in-memory reference is discarded. It is never placed in argv, an environment variable, a temporary file, or a log line. `handoff.ts` is the only module in this codebase allowed to retain the value for deployment; `vault/keyring.ts` may call the OS read API only for the boolean existence check described above. A test enumerates every deploy-related source file and confines value-bearing reads to those two modules.
- Captured child-process stdout/stderr is scrubbed for the value before it is shown, in case the target CLI ever echoes it back. If the value is shorter than 8 characters, the entire output is withheld instead of redacted in place, to avoid an unsafe partial match.
- `deploy` resolves `wrangler` / `vercel` / `gh` from your PATH only, never from a project's `node_modules/.bin`, so a malicious repository cannot substitute a fake CLI to steal a value in transit.
- Deploying to `production` — and every deploy to `github`, since a GitHub secret of either kind (repository or environment) exists to be consumed by CI runs this tool cannot see — requires typing the exact word `yes` at an interactive prompt after the plan is displayed. There is no flag that bypasses this.
- The deploy target is a closed list (`cloudflare` | `vercel` | `github`) fixed in source; it cannot be extended or redirected by a config file or environment variable.

### MCP boundary (`mcp`)

- `api-key-case mcp` exposes exactly 7 tools, a subset of the tools above: `list_required_secrets`, `check_secret`, `save_secret`, `deploy_secret`, `generate_env_example`, `scan_secret_leaks`, `check_gitignore`. None of their input schemas has a `value`, `secret`, or `password` property, checked by a test that inspects the actual registered schema, not just source review.
- `save_secret` never calls the vault. It always returns a fixed instruction asking a human to run `api-key-case save` in their own terminal.
- `deploy_secret` never completes a `production` deploy, or any `github` deploy (CI-reachable regardless of `--env`); it returns a fixed instruction asking a human to run `api-key-case deploy` in a terminal instead. The engine's production-confirmation callback is hardwired to always return false in this path, as a second layer of defense independent of that branch.
- Every tool response is built only from the same status objects the CLI renders. An unexpected exception inside a handler is converted to a fixed `NG:` message; the original exception message and stack are never forwarded.
- Transport is stdio only; there is no network listener, port, or multi-client session.

### License boundary (`license`, and the `deploy` gate)

- `license activate` is the only license operation that uses the network. It accepts a Lemon Squeezy purchase key only from hidden interactive TTY input; argv, piped stdin, and environment-configured destination URLs are rejected. The key is sent over HTTPS only to the exchange URL fixed in the published CLI.
- The exchange Worker validates the Lemon License API response, exact store/product/variant IDs, expiry/status, and the authenticated order's paid/refund/test-mode state before signing. It SHA-256 hashes the purchase key before using it as a 5/minute rate-limit key and separately limits `CF-Connecting-IP` to 30/minute; a missing IP shares a conservative fallback bucket. Neither the purchase key nor its digest is logged or returned. Rate Limiter errors fail closed before Lemon validation or AKC1 signing.
- Test and live use different Worker names, secret sets, and rate-limit namespaces. `LEMON_TEST_MODE` is fixed to `true` in the test Wrangler file and `false` in the live file; only the live Worker URL may be compiled into the CLI.
- The returned `AKC1` is verified locally before replacing any existing license file. Its signed payload shape and `id` field are unchanged; verified application state exposes that value as `entitlementId`, not an order ID. After activation, every Pro check is a fully offline Ed25519 signature check against the public key embedded in source; there is no periodic revalidation, telemetry, or machine binding.
- The license key (`~/.api-key-case/license.key`) is stored in plaintext, unlike vault secrets — this is a deliberate, documented exception to the Vault boundary above, not an oversight. A leaked license key only lets someone else use the paid `deploy` feature; it never grants access to a stored API key, and its payload never contains personal information (no email, no name). See `docs/design/phase-5-license.md` §4.2 for the full rationale.
- The private signing key never lives in this repository, the published npm package, or test fixtures. It is configured only as the Worker's `AKC_ED25519_PRIVATE_KEY` secret. The legacy `tools/issue-license.mjs` remains excluded from npm as an emergency/manual recovery tool and refuses repository-local key material.
- Refunds and disabled licenses prevent future exchanges. An `AKC1` already issued for offline use cannot be remotely revoked; this is an explicit consequence of the good-faith, offline gate.
- An invalid, missing, or corrupted license file only ever blocks `deploy` / `deploy_secret`. It has no effect on `scan`, `save`, `check`, `list`, `remove`, or any other MCP tool.
- This is a good-faith gate, not DRM: the source is public under MIT, so a determined fork can remove the gate. It funds continued development rather than technically preventing bypass — see the ADR in `docs/design/phase-5-license.md` §2.

## Known limitations

These follow directly from the boundaries above; they are the edge of what a local CLI can promise, not gaps scheduled to be fixed.

- **Once handed off, it's out of this tool's hands.** `deploy` writes a value to `wrangler`, `vercel`, or `gh` on their stdin and discards its own reference — but the value now lives inside that official CLI's own process, subject to its logging and behavior. Output scrubbing (Deploy boundary, above) covers what comes back to this CLI, not what the target CLI does internally. In particular, a value deployed to Vercel's `development` environment is readable again afterwards: Vercel's API does not permit sensitive variables there, so `vercel env pull` can write it back out to a local `.env` file. `production` and `preview` default to sensitive; Cloudflare Worker secrets and GitHub secrets — repository or environment — are not readable back.
- **A person can always paste a secret by hand.** Nothing here stops someone from reading a value out of the OS secret store's own UI and typing or pasting it into a chat window, ticket, or AI conversation themselves. The Vault, deploy, and MCP boundaries only close paths this code itself controls.
- **The OS secret store is only as strong as the OS account.** This CLI relies on the platform's own access control (macOS Keychain, Windows Credential Manager, or libsecret) rather than adding a second layer of its own; anything that can already authenticate as your OS user is operating inside the same trust boundary as this CLI.
- **Scanning is heuristic, not exhaustive.** `scan` matches a closed set of known token shapes, only reads specific text file extensions, skips `node_modules`/`dist`/build/vendor directories, and ignores files over 1 MB. An unfamiliar key format, a binary asset, or a skipped path will not be flagged. Treat a clean scan as "nothing obvious found," not "nothing there."
- **A Pro license, once exchanged, is offline and cannot be pulled back.** A refund or disabled license blocks the *next* exchange; it does not revoke an `AKC1` a machine already holds (License boundary, above).
- **Detecting a leak does not undo it.** See "If a credential was exposed" below — rotation at the provider is the only thing that actually closes an exposure.

## Reporting a vulnerability

Do not include a real credential, `.env` file, access token, private key, or unredacted scan output in a report.

Once the GitHub repository is public, use GitHub Private Vulnerability Reporting. Until then, or when that route is unavailable, email [dev@melavern.com](mailto:dev@melavern.com). Do not include credentials or other sensitive values in the email; use fake canaries and redact output.

Include:

- the affected version;
- operating system and Node.js version;
- minimal reproduction steps using fake canary values;
- the output after manually removing any sensitive material.

## If a credential was exposed

`scan` finding a leak — or you noticing one yourself — does not undo it. The credential is compromised from the moment it left your control, not from the moment someone spots it in a diff.

1. **Rotate it at the provider first, before anything else.** Generate a new key/token and revoke the old one from the provider's dashboard or API. Every minute the old value stays valid is a minute someone else can use it.
2. **Update everywhere the old value was actually used**: `api-key-case save <NAME> --force` to overwrite the local vault entry, then re-`deploy` the new value to any Cloudflare/Vercel/GitHub target that had the old one.
3. **Review the provider's audit or usage logs** for the exposure window to check whether the old key was used by anyone else.
4. **Clean up the exposure as a follow-up, not a substitute for step 1**: remove the value from the working tree, and if it reached Git history, rewrite history (for example with `git filter-repo` or BFG) and force-push, keeping in mind that any existing clone or fork already has it.

Deleting a local file or rewriting Git history does not invalidate a leaked credential — only revoking it at the provider does.

## Supported versions

Before the first stable release, security fixes are provided only for the latest published version.
