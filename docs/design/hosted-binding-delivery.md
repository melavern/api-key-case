# Vercel and GitHub Actions Binding delivery

Windows synthetic native acceptance passed for each provider on 2026-10-22 JST,
using dedicated OS slots, fresh verification and offline fixed CLIs. The source
gates are enabled on Windows. Real provider writes have not been accepted by
these synthetic tests. Cloudflare and local
application gates are independent. No trust or approval from an old route is
inherited; default MCP remains unchanged.

`secret target inspect|register --kind vercel|github-actions --environment ...`
reads only the physical project's existing link/origin. Registration requires
an independent native metadata review and a fresh Catalog CAS. Agent output
contains IDs and state, not raw account/project/repo/path or key labels.
Registration does not send a key. Operation recovery observes the metadata CAS.

Vercel starts with a direct `.vercel/project.json` team/project link. Repository
links and personal-account links are explicitly unsupported in this bounded
route. Duplicate JSON keys, links/reparse traversal, hardlinks and oversized
metadata are rejected. GitHub starts with the existing strict github.com origin
parser and refuses includes, rewritten/multiple remotes and worktree config.
Target environment `repository` means repository-level Actions Secret; other
accepted names mean an existing named Actions environment. Source Binding
environment and provider target are independently shown to the human.

`secret use plan|apply` uses any approved Binding with that registered target.
Both plan and apply are Pro. Per-use native review shows key label/classification,
source risk/generation, exact provider resource/scope and CLI. Every apply
requires a fresh HWND-bound OS verification. Remote principal/resource identity
is checked before review and again after verification; changed identity, config,
generation, presence, license, lock or approval age blocks the handoff.

The initial supported CLIs are Vercel 59.x and GitHub CLI 2.x. Local help was
checked on Vercel 59.11.7 and gh 2.96.0. Vercel whoami JSON must identify the
requested team, and non-interactive project inspect must identify the linked
project. Both are metadata-only probes; environment values are never listed.
Vercel 59.11.7's human-readable `project inspect` table is on stderr, including
its ANSI-colored ID row. The adapter requires exactly one matching project ID
there, a successful exit, bounded output and matching whoami team JSON on stdout.
GitHub uses only fixed GET projections of user/repo/owner/environment IDs.

Vercel's fixed command is `env add NAME ENV --sensitive --yes --force` with
explicit team/project and non-interactive flags. No remove-first pre-step is
used. It may overwrite the named variable, stores Secret type in each supported
environment, and does not redeploy existing apps. Preview selects all Preview
branches. Framework-public prefixes are refused rather than downgraded to Config.
GitHub's fixed command is `secret set NAME --app actions --repo github.com/OWNER/REPO`
with `--env NAME` only for the named-environment target. No body/URL/env-file,
org/user/Agents/Codespaces/Dependabot sink is accepted. Actions workflows can
read the key; the native review states this.

Only `deploy/handoff.ts` reads the OS value and passes it to fixed stdin. No
caller argv/env map or value output is provided. Provider output is bounded
and suppressed. An owned persistent lock and journal precede the value-bearing
call; effects only advance. Unknown/incomplete/pending attempts cannot reopen
review or retry. Operation-ID calls are observation only. A reported completed
CLI result is historical provider execution evidence, not app-level validation.

The 60-second approval limit is a start deadline, checked through the final
pre-spawn boundary. After the fixed command starts, completion can be observed
within its separate 120-second process timeout. Completion still checks the
destination, physical project, active generation, presence, license, CLI/config
identity and lock ownership. Elapsed approval age alone cannot turn exit 0 into
unknown. Unknown/incomplete effects still prohibit automatic replay. Cloudflare's
generic Binding delivery uses the same separation.

Official references consulted:

- [Vercel env](https://vercel.com/docs/cli/env)
- [Vercel project](https://vercel.com/docs/cli/project)
- [Vercel whoami implementation](https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/whoami/index.ts)
- [GitHub secret set](https://cli.github.com/manual/gh_secret_set)

Native acceptance uses dedicated random synthetic Credential Manager slots,
fake Pro signing keys and offline CLI fixtures. It never writes actual cloud
resources. Real Secret/cloud/production/publication requires a separate concrete
plan and human approval. See VERIFICATION.md for observed results and gaps.
