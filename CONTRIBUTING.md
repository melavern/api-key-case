# Contributing to API Key Case

Thanks for helping improve API Key Case. Small, focused changes with a clear security argument are easiest to review.

## Before opening a pull request

1. Open an Issue for a behavior change or a new deploy target so the security boundary can be reviewed first.
2. Use Node.js 20 or later and install with `npm ci`.
3. Make the smallest change that solves the reported problem.
4. Run `npm test` and `npm pack --dry-run` before requesting review.

## Non-negotiable security boundaries

- Do not add a generic value-retrieval, disclosure, export, or logging path.
  Value-bearing operations are limited to the reviewed OS-store save path,
  `hasSecret`/`check` reducing an OS-store read immediately to a boolean, and
  the deploy handoff passing a value to an official CLI's stdin. Do not add a
  new value-bearing path without security review.
- Do not add `get_secret`, `print_secret`, `show_raw_value`, `export_all_secrets`, `write_secret_to_env`, `send_secret_to_url`, or an equivalent path under another name.
- Do not add a secret value, password, or purchase key to command arguments, environment variables, fixtures, snapshots, errors, or telemetry.
- Do not read or modify a real `.env` file. Tests must use fake canary strings in isolated temporary repositories.
- Keep deploy targets allowlisted. A configurable URL, executable, or arbitrary service target is out of scope.
- Keep production, every GitHub deploy, other high-risk operations and first-use/changed destinations behind the Agent-independent Human Plane. Secret deletion and destination-trust deletion require it too. Windows approval requires Windows 11 build 22000+, configured Windows Hello and an OS result of `Verified`; a plan button alone is insufficient. Do not add stdin/TTY, chat, `--yes`, environment, config, MCP, or callback approval bypasses.
- Keep secret values in the OS secret store. Do not introduce a plaintext file or a custom encrypted database.
- Keep MCP responses status-only. MCP schemas must not accept `value`, `secret`, or `password` fields.
- Never commit signing material, provider credentials, `.env` files, or live purchase data.

If a proposed feature needs to cross one of these boundaries, do not implement it as a convenience option. Explain the use case and threat model in an Issue first.

Use [SECURITY.md](SECURITY.md) and the [current setup contract](docs/design/agent-setup-readiness.md)
for current behavior. Phase 2–4 designs and the initial Phase 6 investigation
retain historical proposals; their old TTY approval and `remove --yes` examples
are not implementation instructions for the current candidate.

## Pull request checklist

- [ ] The change is focused and documented.
- [ ] Tests use fake data and cannot print a canary value on failure.
- [ ] User-facing claims match the implementation and known limitations.
- [ ] Free/Pro behavior and production confirmation are unchanged, or the change is explicitly reviewed.
- [ ] `npm test` passes.
- [ ] `npm pack --dry-run` contains no private operator files, Workers source, test fixtures, or credentials.
- [ ] Documentation, CLI help, MCP messages, landing-page copy, and terms remain consistent where applicable.

## Reporting security issues

Use GitHub Private Vulnerability Reporting, not an Issue or pull request. If
that route is unavailable, email [dev@melavern.com](mailto:dev@melavern.com)
instead. See [SECURITY.md](SECURITY.md).
