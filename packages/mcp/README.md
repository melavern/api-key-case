# API Key Case MCP

Optional, for intermediate users. The CLI remains the primary interface —
this just lets an agent host (Claude Code, Cursor, Codex) call the same
status-only operations directly. The [current setup contract](../../docs/design/agent-setup-readiness.md)
uses the CLI; this MCP setup is not a prerequisite for it. The
[Phase 4 design](../../docs/design/phase-4-mcp.md) records the original design.

Executing `deploy_secret` uses the common value-free history journal. If only
result persistence fails, its observed operation result is preserved and
`historySaved: false` warns the Agent to stop the group without automatic retry.
`history-unavailable` means the start could not be saved and no provider write
was attempted. History inspection uses the Free CLI `history --json`; the MCP
tool allowlist is unchanged. Past receipts never supply approval or trust.
History failures also carry a closed `historyDiagnostic` with `phase: start`
or `result`, an observed cause and recovery code. A lock does not prove a crash.
The CLI history report is now schema 2; its `inspect` diagnostic distinguishes
missing storage from access/format/lock failures and never tests write access.
No raw errors, existing-lock cleanup, automatic discard or deployment retry is
added; a result-save failure does not change an observed deployment success.
An empty `list_required_secrets` result means only that the current scanner
found no supported required references; it does not prove that the project
needs no Secrets. A `unused` project entry is only a cleanup candidate because
manual use and unsupported syntax remain possible. If a known name is absent
from local listing after an interrupted save, use the CLI's `check <NAME>` in
the intended scope before treating it as missing.

Provider failures, timeouts and unknown results are advisory outcomes. The
Agent must inspect history and agree the next step with the human; `--force`
is relevant only when the provider explicitly confirms a duplicate existing
Secret and the human agrees. An incomplete or unknown force operation is never
replayed automatically.

Start it with:

```
npx api-key-case mcp [path]
```

The repository's [Registry card](../../server.json) describes this same npm
package and its existing `mcp` subcommand. It adds no MCP package, listener,
or new execution path. The card is publishable only after the matching npm
version is released with the `mcpName` ownership marker; see the
[Registry publication steps](../../docs/RELEASING.md#mcp-registry-publication).

Register it with a client:

```
# Claude Code
claude mcp add api-key-case -- npx -y api-key-case mcp

# Cursor (mcp.json)
{ "mcpServers": { "api-key-case": { "command": "npx", "args": ["-y", "api-key-case", "mcp"] } } }
```

## Security boundary

This package exposes exactly 7 tools, all within the product's
allowlist: `list_required_secrets`, `check_secret`, `save_secret`,
`deploy_secret`, `generate_env_example`, `scan_secret_leaks`,
`check_gitignore`. No MCP input or response can contain a secret value.
An allowed deploy internally hands the stored value to the official CLI's
stdin; it does not transmit the value through MCP:

- `save_secret` has no `value`/`secret`/`password` parameter and never
  touches the vault — it returns an `action_required` response asking a
  separate `api-key-case save --ask` Human Plane to open, preserving the
  requested `--scope user` when applicable. MCP elicitation is
  never used for the value; only the resulting status is visible to the Agent.
- `deploy_secret` never completes a `production` deploy (or a `github`
  deploy, whose secret is CI-consumed regardless of `--env`). Those return an
  `action_required` response asking a human to run `api-key-case deploy`
  in their own terminal, where the separate Human Plane makes the decision.
  Typing `yes` into that terminal is not approval. The MCP server has no Human Plane, approval
  parameter/token, or elicitation path, so Vercel `development`, overwrite,
  destructive, and any other high-risk plan also fails closed in the engine.
- `deploy_secret`, including an allowed dry-run, is a Pro feature
  ([license design](../../docs/design/phase-5-license.md)). Without
  an active license it returns a normal (non-`isError`) status with a
  purchase link instead of deploying — every other tool stays free
  regardless of license state.
- Free `next --json` readiness is available through the CLI before purchase.
  It is not an eighth MCP tool, a remote Secret-presence check, or proof of
  provider write permission. Production/GitHub handoffs occur before the MCP
  license check and do not execute or produce a deploy plan in this server.
- Every tool response is built only from the same status objects the CLI
  itself renders — never from a secret value, and never from a raw
  exception message or stack trace.
- Transport is stdio only. There is no network listener.

API Key Case reduces the risk of an accidental secret leak; it does not
guarantee complete safety.


## Explicit guidance-only profile (development candidate)

`api-key-case mcp <fixed-project> --guidance-only` exposes only
`inspect_setup_requirements`, with no input arguments. The default invocation
continues to expose the seven legacy tools unchanged. This is a stdio profile,
not an active ChatGPT connection or a hosted service.

The profile uses the existing local scanner with Git inspection and all writes
omitted. It returns counts and a small closed service-name catalog, not variable
names, source paths/text, findings, credentials or provider output. The project is
bound at process startup; a changed real path is rejected. Its dependencies contain
no vault factory, deployment adapter, Human Plane callback or provider request.
Existing credentials, provider/destination state and Git history are explicitly
not inspected. No detected references means none detected, not no secrets needed.
Do not turn this response into a request to re-register an existing key.

This is the first narrow implementation toward the owner's chat-access goal.
Human entry/approval, connection-state resume and provider qualification still use
the existing independent flows. It installs no tunnel, listener, OAuth grant or
persistent access. Do not connect a real project/account merely because this
profile exists. Review notes: guidance profile (maintainer-only evidence; omitted from the public tree).
