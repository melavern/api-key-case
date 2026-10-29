# Use an existing Node.js / TypeScript app with the local development path

Private development helper; published 0.9.2 is unchanged. The existing Windows
local handoff remains limited to an explicit project × Resend × development,
a fixed Node artifact, fresh native approval and a session of 1–1800 seconds.

An Agent can now prepare a normal multi-file Node JS/TS entry for that path. The
user need not rewrite the app as the acceptance example or manually assemble a
CommonJS bundle. Build preparation is separate from key entry and execution.

## Prepare the app without a key

Use the built private API Key Case checkout with its existing development dependencies.
From that checkout:

```sh
node tools/build-local-node.mjs <app-project> --entry src/main.ts
```

The Agent chooses the actual existing app entry from its code/build configuration;
ask the user only if the intended application is ambiguous. The helper returns
closed JSON with a fresh relative `dist/akc-<opaque-id>.cjs` artifact. It never runs
an app, an npm script, install hook or project build configuration. It does not
install dependencies, read a vault, open approval, call Resend or create a connection.
Do not supply a key or invoke preparation with RESEND_API_KEY in its environment.

Supported first profile: JS/TS Node modules and already installed ordinary JS
packages available to the app at runtime. The helper bundles application modules
as one CommonJS output; installed packages remain external dependencies. The entry is below an
existing src/app/server/lib/pages root. The app retains package.json and exactly
one supported lockfile. Ordinary files/ancestors are required; linked source paths, unresolved local imports, non-Node assets and compiler
warnings fail closed. Dependency compatibility is checked by the app, not by this
build helper; installed dependency code and metadata are not loaded during compilation. Project tsconfig/build plugins are not loaded; path aliases,
framework build pipelines and compiler-specific transforms may require the app's
existing separately reviewed build instead. This is not a replacement framework.
Relative app imports stay within the declared source roots (or package.json),
so ordinary imported helper edits remain in the existing snapshot change set.
Nonliteral dynamic import/require calls are rejected. Relative imports resolve
ordinary JS/TS/JSON files and index files, without
package-directory manifests; bare package imports remain for Node at runtime.
The helper does not claim arbitrary dynamic resources, imports or installed
dependencies are self-contained.

Existing app/package files and earlier artifacts are preserved. Each build writes
a new artifact rather than overwriting a file potentially held by a live session.
Compiler diagnostics and source snippets are not printed by this helper. A closed
unavailable result is a build/input issue, not a reason to re-enter a key or weaken
native guards. Inspect ordinary source/build configuration without opening private
credential files; use the existing app build separately when outside this profile.

## Use the existing product path

With the explicit managed/local/development intent already selected, use the same
private checkout's built CLI, substituting the returned artifact:

```sh
node dist/cli/index.js connection local inspect --service resend --env development --artifact <returned-artifact> --max-seconds 1800 --json <app-project>
```

A successful build is not a complete inspection or permission. The existing
inspection validates supported inputs and the exact environment credential.
If registration is missing, the user uses the existing credential Human Plane;
never copy a key into code, argv, a file, a shell environment command or chat.

Only after the app and its concrete effects are authorized, use the existing
`connection local run` with those same arguments. The existing Pro and fresh
native OS verification still apply. No shell/extra argv/env map, automatic run,
restart or hot reload is added. App streams remain discarded; use the app's
existing interface/closed result and separate user observation for feature success.
No debug log forwarding is introduced to compensate for discarded streams.

Inspection returns `recovery-required` when a prior local-session lock is present,
and `metadata-unavailable` when its state cannot be safely read. It checks before
credential presence access and again after that await. Keep the prior receipt,
lock and artifacts; use `connection local status` and review the owned session
instead of requesting another run or entering the key again. `ready-for-review`
is only a point-in-time inspection, not a lock reservation or execution permission;
the actual run retains its independent checks and atomic session claim.

For edits, let the old session stop and inspect its status; changes to declared
inputs invalidate it. Build a new artifact and request a new bounded session only
when its effects are authorized. Uncertain cleanup or provider outcomes require
review, not a retry. Keep previous attempt evidence and artifacts until their
retention/cleanup is separately resolved. Stopping does not revoke a copied key.

The builder does not prove artifact provenance, full dependency coverage or current
feature success. Application code/dependencies/same-user behavior remain trusted.
It does not make Windows-only key handoff available on another OS. Offline compiler
and fake-provider tests are not a new real Windows/provider acceptance receipt.

## Development verification (2026-10-03)

47 focused checks passed on Linux, including an ordinary multi-file TypeScript
app with a fake notification sender, installed runtime dependency use, unchanged
launcher-snapshot compatibility, source-change invalidation, no app/config/script
execution during build, metadata-resolution refusals/avoidance, dynamic-import
refusal, preserved outputs and closed diagnostics. Independent review repeated the
focused suite and reproduced the resolver-metadata boundary before and after its fix.
Final isolated mock-keyring aggregate passed in 181.3 seconds with candidate byte
equality checks; offline installed-package smoke passed in 22.9 seconds (159 files,
unavailable mock keyring and native loading blocked). The helper/tests/guide are
excluded from the npm artifact; only a direct dev declaration of the already-locked
compiler was added. No new compiler version or runtime dependency was introduced.
The gitless materialization cannot run repository preflight; exact remote-tree/blob
verification is recorded separately and is not called a preflight pass. No new
Windows-native, real-key, provider or inbox acceptance is claimed by this unit.

## Agent discovery and application/session coverage

Newly generated Agent instructions point to this private helper before the existing
local inspection, while keeping the installed-version caveat explicit. The Agent
can choose the ordinary app entry from its source/configuration instead of asking
the user to prepare an acceptance example. No npm or MCP build command is invented.
Existing generated instruction files still use agent-init's normal managed update
and drift-refusal behavior; this change does not overwrite user-edited instructions.

The synthetic session feature fixture now builds a two-module TypeScript mail app
through the helper and runs its artifact behind the existing disposable test owner.
A loopback fake provider observes exactly one bounded request for success/failure,
and zero for declined approval, changed imported source, changed credential revision
or an interrupted prior session. Rebuilding after interruption preserves the old
artifact, receipt and lock; execution still requires owner review. Child output and
synthetic credential/provider-error canaries remain suppressed. These are portable
app/session integration checks, not fresh Windows-native or real-mail acceptance.

This guidance/integration unit passed Agent setup tests (4.3 seconds), all six
focused app/session scenarios (8.9 seconds), the final isolated mock-keyring
aggregate (178.5 seconds with candidate byte-equality checks), offline package
smoke (20.0 seconds, 159 allowlisted files), and independent source/fixture review.
No native, secret handoff, builder runtime or roadmap code changed in this unit.

## Interrupted-session inspection verification (2026-10-03)

The core-only recovery correction passed the TypeScript build and the disposable
local-session suite: 144 synthetic checks and six loopback feature cases, with no
skips. Added cases cover active/uncertain locks, a lock without a receipt, malformed
lock metadata, absent locks, and lock arrival across the awaited presence check,
including a missing credential. Existing receipts, revisions and artifacts remain
unchanged. All keyring/owner/provider activity was synthetic; no Windows-native or
real-provider acceptance is implied. The existing execution lock/approval boundary
is unchanged, so no new full Windows run is requested. Gitless preflight was
attempted but unavailable; exact remote base/blob verification is separate. Full
aggregate/package and hosted CI were not rerun for this bounded draft.
