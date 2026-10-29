# Local destination preparation

Status: private implementation candidate for the user-approved local setup goal.
This document records AI implementation choices inside that goal, not new human
product decisions. It does not complete the broader acquisition roadmap, change
Windows acceptance, adopt the input/preparation flows, or change public 0.9.2 claims.

## Smallest useful operation

A project with a saved matching connection intent but no local destination file
can now prepare that file using already known explicit identifiers. A bounded
Linux-only exception also adds an absent development/preview selector to an
existing strict selector-only `wrangler.jsonc`, retaining every existing selector. The existing
native Vercel or managed Cloudflare guide then resolves its normal selected-local
identity. No account/resource is created or verified by this operation.

The private CLI has two steps:

```
connection target plan --service <resend|clerk> --env <development|preview|production> --org-id <known-id> --project-id <known-id> --json [project]
connection target apply --service <resend|clerk> --env <development|preview|production> --org-id <known-id> --project-id <known-id> --fingerprint <plan-sha256> --json [project]
```

For Cloudflare, replace the two Vercel flags with `--account-id <known-id>` and
`--worker <known-name>`. The ID families are mutually exclusive, complete and
strictly validated using the existing selectors' formats. There is no destination
URL/path/JSON/environment-variable/shell/plugin input, forced repair or overwrite
flag. The existing optional project argument chooses the local project, never an
arbitrary output path. Unknown and repeated flags are rejected.

The ID family identifies which existing intent profile to read. The intent must
independently match the service, exact requested environment, route and destination.
This matters because Clerk native Vercel and managed Cloudflare profiles can
coexist, even in the same environment. No first/default account, Worker, project,
route or environment is guessed, selected or saved. Supported profiles are:

- Resend and Clerk `provider-native` / Vercel, all three environments
- Resend's already supported `api-key-case-managed` / Vercel, all three environments
- Resend and Clerk `api-key-case-managed` / Cloudflare, all three environments

Managed Resend/Vercel preparation does not turn its intent into native acquisition;
the native guide still refuses that route. No other routes are enabled.

## Closed local effects

For Vercel, the only new file is `.vercel/project.json`, with `orgId` and
`projectId`. The helper creates `.vercel/` only if absent. A local
`.vercel/repo.json` stops the operation: project.json can shadow that monorepo
mapping. No mapping parser or parent-project search is introduced. An existing
`vercel.json` must be a bounded valid strict JSON object without duplicate keys;
its provider semantics are not interpreted or broadened.

For Cloudflare, the only new file is `wrangler.jsonc`. Production has explicit
root `name` and `account_id`; development/preview have those fields only inside
`env.<selected>`. There is no root fallback or automatic account inference. This
is a destination selector, not a complete Worker deployment config: application
entrypoint, compatibility date and other independently required app setup remain
outside this operation. It never adds bindings, routes or resource declarations.

Existing matching safe configuration is a no-write result. For Cloudflare this
includes one of the already supported TOML, JSON or JSONC files; it is not migrated.
Conflicting, malformed, duplicate, oversized, symlink/hardlink or unsupported
selectors stop. Existing matching files are never rewritten or reformatted.
The one additive exception below may atomically replace a selector-only JSONC
file; it is not a general Wrangler editor. No existing object is chmodded/chowned.
The helper never writes `.gitignore`, secret files, intent/state/approval records,
application files or any provider-generated metadata beyond the fixed selector.
New directories request mode 0700 and files 0600, subject to the host's creation
semantics; there is no permissions change to an existing object.

## Adding a missing Cloudflare environment

Only a sole `wrangler.jsonc` is eligible. Its contents must be strict UTF-8 JSON
(no comments, trailing commas or duplicate keys), at most 64 KiB, with at least
one existing selector and no fields except:

- A complete root `name` / `account_id` pair, representing production; and/or
- An `env` object with one or both of `development` / `preview`, each containing
  exactly its complete `name` / `account_id` pair.

Every existing Worker name and account ID must satisfy the same grammar as new
explicit inputs. Partial pairs, empty env objects, extra environments, unknown
fields, `main`, `compatibility_date`, vars, bindings and general Wrangler config
refuse addition. Existing matching TOML/JSON/JSONC still returns a no-write result
under the original resolver. Missing environments in TOML/JSON are not converted.
This shape is an eligibility check, never evidence that API Key Case owns or
created the file. There is no marker, ownership receipt or database.

The requested development/preview entry must be genuinely absent. An existing
conflicting entry is not changed, and neither root production fields nor any
other environment is added/changed implicitly. Adding production to an env-only
file remains unsupported. A root production selector can be retained while a
named environment is added. Non-secret selector values survive exactly; formatting
is regenerated as the proposed JSON shown in the plan.

Replacement is deliberately limited to Linux regular single-link files with
mode 0600 and the current uid/gid. Original and replacement mode/uid/gid must
match. Linux owner-only mode leaves no effective group/other or extended POSIX
ACL-mask access to expand when replacing the inode. This is a narrow mode-based
access boundary, not evidence of ACL inspection: arbitrary ACL entries, xattrs,
security labels, timestamps and inode identity are not copied or claimed to be
preserved. Windows/macOS permission layouts and other modes/owners stop with
`unsupported-update-layout`; the helper does not inspect/manage ACLs or change
permissions to make a file eligible. This limitation applies only to addition,
not the original matching/no-write or new-file paths. A restrictive umask can
make the temp file fail the metadata check; that file is retained for inspection.

An additive plan reports `localConfiguration: missing-environment`, the current
validated `existingSelectors`, the complete `proposedConfig` and two explicit
effects: create `.wrangler.jsonc.api-key-case-target.tmp`, then add the exact named
environment by atomic replacement of `wrangler.jsonc`. Inputs, saved intent,
canonical root/ancestors, source stats and exact source bytes are bound to the
fingerprint. Planning never writes.

Apply creates that fixed same-directory temporary file exclusively, checks its
mode/uid/gid and identity, writes the proposed bytes, fsyncs and closes it, then
rechecks its bytes/identity, original bytes/stats, root and saved intent before
rename. It never opens the existing selector for writing. Existing temp objects
are conflicts, including links/directories; there is no force or stale-temp
cleanup. A successful rename atomically replaces the pathname with a new inode.
This is not filesystem compare-and-swap, a rollback transaction, directory-fsync
crash durability, or isolation from a malicious same-OS-user process; there is
still a check-to-rename race. Already-open readers may retain the old inode.

A successful addition returns `status: updated`, `reason: local-config-updated`,
`localEffects: updated`, and `updatedPaths: ["wrangler.jsonc"]`. CLI exit is 0.
`createdPaths` records the temp creation, not a surviving new selector: the rename
has consumed that temp pathname. New-file `created` and no-write `unchanged`
results keep their existing meanings. On later errors, path arrays only record
actions that returned successfully, never current path ownership or complete
rollback evidence.

Before rename, write/fsync/close/check failures leave the original selector
untouched by the helper and may leave the temp file. A rename that takes effect
but has an interrupted/uncertain result, or a failed post-rename check, can leave
the new configuration in place. Such results are blocked with `localEffects:
possible`, no usable fingerprint and instructions to preserve/inspect and replan;
they do not claim the original file is unchanged. No automatic deletion or repair
is attempted. Fresh planning reports matching state if the new selector exists;
it refuses another addition while the fixed temp path is occupied. A prior token
never authorizes blind retry.

## Plan and apply meaning

Plan is read-only. It presents the exact service/environment/route, canonical local
project and local project ID, intent revision, explicit destination identifiers,
fixed relative selector path, existing path, exact generated non-secret
configuration, local effects and deterministic SHA-256 fingerprint.

The fingerprint binds the canonical path and its directory identities, complete
current matching intent including revision, normalized explicit inputs, and the
relevant file/directory state. For an additive plan, it also binds the exact
validated selector-only source bytes, including formatting. Other configurations
retain the existing stats/known-selector comparison without arbitrary value
hashing. Unknown config fields are neither returned nor copied. Control/bidi/newline paths
are refused; human-readable canonical paths are also JSON-quoted.

Apply requires the same explicit inputs and fingerprint and regenerates/rechecks
the plan before mutation. A missing, mismatched, changed-intent or stale-state
fingerprint cannot write. Exclusive creation (`O_CREAT|O_EXCL`, no-follow where
supported), bounded fixed paths, directory/file identity checks and descriptor
checks protect against collisions and detectable races. Intent and path identity
are rechecked immediately before mutations and again after creation/write/sync and before an additive replacement.
This is not a filesystem transaction or isolation from a malicious same-OS-user
process; no claim of atomic rollback or same-user isolation is made.

Successful apply returns a fingerprint for the resulting current local state;
repeating apply with that fingerprint is `unchanged` and performs no writes. A
fresh plan on matching configuration likewise yields an unchanged apply. Reusing
the older pre-creation token is refused as `plan-mismatch`, with
`localConfiguration: matching` and the matching existing path explicitly shown.
That means the target already matches, not that it needs to be recreated.

If a write attempt, close/sync or later check fails, the result reports
`localEffects: possible` and the fixed paths whose creation or replacement returned successfully.
These are evidence of this invocation's actions, not proof of present ownership.
The helper performs no automatic cleanup: another writer may now own the path.
It preserves partial or uncertain state, returns no usable fingerprint, and asks
for inspection rather than claiming no local effects or permitting blind repair.
Before a write attempt, failures report no local effects from this invocation.

## Authority and remaining work

Output always distinguishes local configuration from authenticated account
identity, remote resource existence and current remote/application health.
`permission: none`, `credentialAccess: none`, `providerExecution: false`,
authentication/resource `not-inspected` and health `unverified` remain explicit.
The fingerprint is a state comparison, not authorization, is not secret and is
never persisted as approval. No vault calls, provider CLI/network/browser,
login/link, resource creation, grant, deployment/publish or installation occurs.
Existing Human Plane, entitlement, trust and production gates stay unchanged.

After successful local creation or addition the same existing guide can show the selected
local identity; remote inspection and app evidence retain their separate existing
contracts. The broader generic `connection plan` resolver stays unresolved: this
helper does not supply its authenticated destination/source/configuration basis.
No database, persisted schema, `next` schema or remote resolver is added.

## Verification

`tests/connection-target.mjs` uses synthetic files, intent metadata and denied-effect
CLI runs. It covers both services, both destinations and all three environments,
including the before/after existing-guide transition, managed Vercel, coexisting
Clerk profiles, exact file-only writes, deterministic dry plans, no-write repeats,
stale tokens, bad/mixed IDs, mismatched intent, supported existing config formats,
malformed/duplicate/conflicting/unsafe config, locks, changed revisions, exclusive
collisions, late replacement and partial-write/sync failures. It checks preserved
application and metadata bytes/modes, closed output and no secret-canary leakage.
Additive cases cover Resend/Clerk in both directions, retained production roots,
exact existing values, matching repeats, closed field/grammar boundaries,
unsupported permission/platform layouts, temp collisions, source/intent/temp
races and write/fsync/close/rename interruption both before and after effects.
Fresh-process CLI cases move from an unresolved new environment to its exact
selected identity and then resolve the preserved original environment. Actual
CLI runs deny provider/child/network/vault calls. The suite is in `npm test`;
current-CLI Agent guidance and existing native/Cloudflare guide regressions remain
required. Real Windows acceptance and real provider/credential/app operations are
not part of these synthetic local tests.

## Existing external shapes

- [Linux acl(5)](https://man7.org/linux/man-pages/man5/acl.5.html), checked
  2026-10-06, describes the group-bit/ACL-mask mapping and creation-mode limit
  used for the narrow Linux 0600 access reasoning above. It does not establish
  that a particular filesystem's labels or arbitrary metadata were inspected.

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
  documents JSONC and explicit environment sections. This implementation emits
  only the already supported local selector fields, not deploy-ready app config.
- [Vercel CLI getting started](https://github.com/vercel/vercel/blob/main/skills/vercel-cli/references/getting-started.md)
  documents `.vercel/project.json` and its precedence over `.vercel/repo.json`.
  This helper refuses that mapping layout rather than overriding it.

## Additive candidate verification, 2026-10-06

The Linux additive candidate passed `npm run build`, `node
tests/connection-target.mjs` (316 checks), `node tests/agent-current-cli.mjs`
(41 cases), `node tests/native-acquisition.mjs` (95 checks) and `node
tests/cloudflare-acquisition.mjs` (54 checks). Development preflight returned no
problems. Source/test freeze manifest SHA-256:
`13d85c29acac23d1f941ce3489b4a31ee223a1eb07026911eafb321a9fb3282b`.
Only this evidence section changed after that verification; implementation and
tests remained at the frozen hashes. The generated-guidance snapshot was updated
for the scoped additive guidance before the freeze, with new behavioral assertions.

These are synthetic local filesystem/CLI results on Linux, including denied
provider/credential/child/network effects. They do not verify an actual Windows
or macOS additive edit, arbitrary ACL/xattr preservation, native Human Plane,
provider operations, deployment or application health. The focused gates cover
the modified helper and its existing-guide/guidance boundary; no full aggregate
run or public release acceptance is claimed. Review and integration are separate
from these candidate results.
