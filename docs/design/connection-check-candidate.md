# Resend credential check candidate

Status: reviewed Private development feature; Windows npm and supported-host
sending-only real-key acceptance passed. Published 0.9.2 does not include it.
No new published 0.9.x feature, deployment or release is claimed.

## Environment-split follow-up

The following historical contract describes the accepted connection-check implementation.
The subsequent [environment credential candidate](environment-credentials.md) uses
only the selected v2 environment slot for new checks, preserving historical records
and legacy 0.9.x commands. No silent v1 fallback or migration remains in that flow.
Its optional `--env` guard binds fresh Agent continuation to the exact saved selected
environment before any vault/provider/journal effect; no-flag four-field output
remains compatible. Guard response fields are not persisted provider result codes.

## Behavior and compatibility

`api-key-case connection check --service resend --json [path]` is a Free CLI-only
read-only check for an explicitly selected `api-key-case-managed` intent and an
existing OS-store credential. Project registration takes precedence over user
registration. No environment slot is added; `next` still calls it `legacy-unscoped`.
It never acquires, saves or returns a key. Existing MCP surfaces remain status-only.

The adapter supports the reviewed official Resend CLI 2.23.0. Trusted native binaries
are independent of API Key Case's Node >=20 host; a bound interpreter must be Node
>=22. Windows npm installs use the fixed `node_modules/resend-cli/dist/cli.cjs`
layout with the reviewed bundle SHA-256 and a separately bound `node.exe` from
OS-derived trusted directories. No `.cmd`/`.bat` is parsed or executed. A trusted
native executable remains eligible and is preferred. Linux production trusted
execution is unsupported by the existing resolver. Missing/unsupported versions,
runtime or CLI stay unknown; no product runtime bump or `resend login` fallback.

### Windows npm investigation and contract (2026-10-02)

The [official 2.23.0 manifest](https://github.com/resend/resend-cli/blob/v2.23.0/package.json)
requires Node >=22 and exposes `dist/cli.cjs` as `resend`. The npm artifact is a
self-contained bundle for this fixed doctor operation; no provider SDK or npm
module lookup is needed at execution. Secure-backend and other-command loaders
are outside this operation (`RESEND_CREDENTIAL_STORE=file`, empty config, fixed argv).
The official npm artifact was retrieved with scripts disabled:

- tarball: `https://registry.npmjs.org/resend-cli/-/resend-cli-2.23.0.tgz`
- npm integrity: `sha512-60NX+0kHpIJkBCptXV5goaa1BQnIvazEitAxerO6EL1e420l37nHjbE0/KZof2EJcXwqIpUMWB0hbNHjwM+WaQ==`
- `dist/cli.cjs` SHA-256: `213dfe31a4855c472ea8bcce4d20c0b2c850ab8d18e4d82f00a598d85f20b82a`

Resolution verifies package name/version/bin/engines and bundle digest, rejects
workspace realpaths, and snapshots both bundle and Node. The runtime is selected
from the persistent OS PATH, not process PATH, the shim's selected runtime, or
`process.execPath`. Its `--version` must report Node >=22 before the value-bearing
read. This is a trusted-installation boundary, not Node publisher authentication
or protection against arbitrary same-user code. Snapshot/awaited-guard checks
cover both executable identities. The documented final path-to-spawn race remains.
No new runtime is automatically downloaded or installed by the product.

User prerequisite: install `resend-cli@2.23.0` normally with npm and provide Node
>=22 in the persistent Windows PATH. Other npm layouts/CLI versions, missing
runtime and changed bytes fail closed. API Key Case's own Node >=20 contract and
all 0.9.x save/check/remove/storage scopes remain unchanged. A different official
bundle version requires a new review and digest, never accepting `--version` alone.

Doctor `Domains` pass or known no/pending-domain warn proves full-access acceptance.
Known `API Validation` sending-only warn proves restricted acceptance. Only a known
authentication rejection is invalid. Transient/rate-limit/server errors, timeout and
malformed/new/duplicate/contradictory/oversized output remain unknown. Exit 0/ok alone
is insufficient. Acceptance does not prove domain, sending or application readiness.

## Security and recovery

`handoff.ts` remains the sole value-bearing read boundary. Its closed operation
injects only `RESEND_API_KEY` into a fresh child environment and runs fixed
`doctor --json`, following a non-secret `--version` probe. Private fixed-temp
config isolation prevents doctor's metadata read from touching existing profiles.
Node options, profiles, proxies, custom URLs and inherited credentials are excluded.
`NODE_ENV=production` is fixed only for the child SDK's log mode. The pinned SDK
logs API errors on stderr outside production, including valid sending-only keys'
expected permission denial. Production mode prevents that debug output at its
source; any remaining stderr is still rejected. This does not select a production
credential, change the intent environment, or authorize a production operation.
No plaintext credential, getter or generic injection callback is introduced.

The response contains only service, valid/invalid/unknown status, closed result code
and recorded status. Raw output, masked suffixes, domains, error strings and child
environment never leave the handoff or enter the journal. Capture is bounded;
timeout stops the child. A durable unknown entry precedes execution. Revision,
selected non-secret credential identity, intent and exact executable/interpreter
are rechecked around read/spawn and after execution. Failed completion returns
unknown and retains the interrupted entry. Finished credential validity survives
destination-only changes for the same credential identity/revision/verifier.

The final executable/interpreter snapshot check follows the awaited state guard,
so a replacement during that guard is rejected before dispatch. This remains a
path-based launch with a residual OS-level interval between snapshot and spawn;
it is not an atomic executable-handle launch or isolation from an attacker able
to rewrite a trusted installation as the same OS user. Such stronger isolation
needs a separately reviewed execution design and is not claimed by this candidate.

Receipts never authorize human approval, destination trust, entitlement or blind
retries. Diagnose unknown first. Deployment, email send, application checks,
environment mapping and public positioning remain separate work.

## Verification and integration

Focused synthetic tests cover parser outcomes, fixed argv/env, bounded capture,
key/error containment, unsupported version/shim, host-vs-child runtime, executable
replacement, revision/intent changes, locks/write failure and interrupted receipts.
POSIX subprocess fixtures are platform-gated; Windows parser/orchestrator/native
snapshot fixtures require a Windows runner. Linux synthetic tests do not establish
real-provider or supported-platform acceptance. Independent boundary review and
existing Free/Pro/save/check/list/remove/deploy/history/MCP gates precede integration.

### Local verification, 2026-10-01

- TypeScript CLI/core/MCP and license Worker builds passed on Linux / Node 24.19.0.
- Core suite passed, including connection parser, secret-boundary, interruption,
  snapshot/race and journal tests. The three review regressions are covered:
  Node 20 host vs supported native/bound child runtime, rejected Windows shims
  before credential reads, and destination-only changes preserving validity.
  A replacement during the awaited pre-spawn guard is also rejected without
  executing the substituted fixture.
- LP analytics, license Worker and preview-server allowlist suites passed.
- Fresh npm consumer package smoke and runtime dependency audit passed (zero
  vulnerabilities). Includes the installed check command's closed unknown path.
- Aggregate `npm test` remains blocked at the unchanged site-content gate because
  the reconstructed checkout lacks baseline launch MP4 files. GitHub file retrieval
  returned empty binary bodies, blob retrieval failed binary decoding, and the
  official public site's media fetch returned HTTP 403. No placeholder files or
  weakened assertions were used. Rerun the aggregate gate in a complete checkout.
- No live credential, provider call, supported-OS keyring acceptance, remote push,
  deployment or release was performed. Linux fixtures do not establish Windows
  or macOS execution acceptance. The candidate remains pending integration.

## Windows implementation verification, 2026-10-02

- Node 24.15.0 / Windows: CLI/core/MCP and Worker TypeScript builds passed.
- Focused connection tests passed, including npm-layout direct Node execution,
  valid/invalid/unknown projections, malformed/oversized/stderr output, network
  failures/timeouts, unsupported bundle/runtime and executable replacement in
  the awaited pre-spawn guard. Synthetic values only; no real provider acceptance.
- Independent Critical implementation review found no material findings. It
  confirmed the official bundle digest and non-secret version probe, fixed argv,
  sole value-bearing boundary, state journal and runtime/bundle revalidation.
- Local aggregate tests reached the connection gates successfully, then stopped
  at the unchanged public-blocker symlink fixture: this host lacks Windows symlink
  privileges (`EPERM`). This is not reported as a passing aggregate gate; CI is
  required for the complete checkout/OS matrix.
- The installed package gate initially exposed a pre-existing LF-only LICENSE
  heading assertion on this CRLF checkout. Only that assertion was made CRLF-aware;
  license content and packaging allowlist are unchanged. The fresh installed npm
  package gate then passed, including a zero-vulnerability runtime dependency audit.
- The first CI follow-up passed Linux Node 20/22/24 and package gates but exposed
  an additional fixture-only macOS `/tmp` realpath mismatch. The fixture now
  canonicalizes config/cwd paths like the existing suite; no product check changed.
- The fixture-corrected code passed all 11 CI jobs on both push and pull request:
  Linux Node 20/22/24,
  Windows/macOS portable and real OS-keyring lanes, package, web and scope.
  CodeQL was intentionally skipped for the private repository. These CI lanes
  use synthetic credentials and do not substitute for the real-key gate.
- This check implementation changes no version, tag, npm publication, deployment, storage scope, environment
  separation or Sites MCP.
- The first real-key check, after a human saved a sending-only key through the
  installed Windows Human Plane, returned/persisted `unknown/unexpected-output`.
  A local diagnostic inside the handoff projected only fixed check-name/status
  enums and booleans (no raw output/message/detail/key material). It showed the
  expected sending-only stdout with nonempty stderr. Inspection of the exact
  pinned SDK identified its non-production API-error logger. The diagnostic was
  removed; fixed child production log mode and inherited-development-mode
  regressions were added without accepting arbitrary stderr. Builds and focused
  regressions passed again.
- The updated installed code passed the real
  sending-only-key check on Windows build 26200 / Node 24.15.0 with normal global
  npm `resend-cli@2.23.0`: `valid / valid-sending-access / recorded=true`.
  A separate process read the persisted completed observation and recovered
  `providerCheck=passed`, `credential=registered`, `stage=configure-destination`.
  The earlier unknown observations remain preserved. No email was sent, and
  domain/destination/application readiness is not established. The dedicated
  project credential remains in the existing OS store; no value was copied to
  project files or a provider profile. Full-access/rejected live credentials and
  macOS native Human Plane were not exercised by this real-key acceptance.
- The final executable code passed all 11 private-development CI jobs on both
  pull request and push.
  This is the code used for the successful installed real-key acceptance above.

## Future task: Sites-hosted onboarding and status MCP

Design a separate Sites-hosted onboarding guide and non-secret status-sync MCP.
Keep vault, credential reads, fixed provider checks and execution local. Hosted
payloads need explicit identity/consent/access rules and a minimal non-secret
projection; never transmit values, masked suffixes or raw provider logs. Local
revision and verification bases remain authoritative for freshness.

Synced observations are advisory and may be stale. They never authorize deploy,
human approval, destination trust or retries. Hosted MCP differs from browser
WebMCP. Define freshness, revocation, scope, retention, offline behavior and exact
local/hosted interface first. No Sites, OAuth/persistent access, deploy or sync
implementation is included here.
