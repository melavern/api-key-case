# Explicit Cloudflare config destinations

> **適用範囲:** 本書は既存の固定Provider向けschema v1 `services`と実配置経路の正本。新しい任意issuer/Bindingを利用するvNext経路は[開発候補の対応範囲](../releases/windows-vnext-candidate.md)で区別する。vNextでは通常のWrangler設定から値なしtarget候補を検出し、人間確認で**独立vNext Destination ID**として登録する。既存target IDは人間確認付きで導入可能。旧`services`の固定Provider名を任意issuerに偽装させず、既存catalog schema1/従来配送の許容判定は変更しない。実配置は毎回の新native承認とsnapshotを必要とする。

Private implementation, 2026-10-07. Owner-requested extension of the bounded
provider placement candidate. Muhenkan Managed staging supplies the acceptance
use case; no application-specific logic or E2E enters API Key Case.

## Repository catalog

The one fixed file `api-key-case.targets.json` declares at most 16 Cloudflare
destinations. The execution CLI accepts a catalog **ID**, never a config path,
command, executable, arbitrary environment map, URL or custom adapter. A catalog
is a proposal, not approval/trust. Every Cloudflare placement still requires the
existing HWND-bound Windows OS verification, even if this destination ran before.
Editing a catalog never grants execution authority.

```json
{
  "version": 1,
  "cloudflare": [{
    "id": "api-staging",
    "config": "deploy/staging/api.jsonc",
    "accountId": "0123456789abcdef0123456789abcdef",
    "worker": "example-api-staging",
    "sourceEnvironment": "preview",
    "deploymentEnvironment": "staging",
    "wranglerEnvironment": null,
    "services": ["openai"]
  }]
}
```

All fields are closed and nonsecret. Unknown fields, duplicate JSON keys/IDs or
account/Worker pairs, invalid selectors, oversized metadata and conflicting
config identities are refused. Config paths must be ordinary relative JSON,
JSONC or TOML files inside this repository, through ordinary directories. Dot
segments, absolute/UNC/drive paths, shell metacharacters, links/junctions,
hardlinks and special files are refused before reading. The selected config
must explicitly name the declared Worker in its selected section. An account
ID already in the config must agree with the catalog. An omitted config account
is fixed by the catalog's nonsecret `CLOUDFLARE_ACCOUNT_ID`, reconstructed inside
the handoff. Provider identity must independently include that account.

`sourceEnvironment` identifies the existing v2 vault slot. `deploymentEnvironment`
is an explicit application classification: development, preview, production, or
staging. Only staging maps to the preview source slot; all other classifications
must match their source slot. `wranglerEnvironment` independently selects a
named config section, or `null` explicitly selects top-level with **no --env**.
No Worker suffix or absence of a section infers staging. This explicit registered
route permits top-level staging without changing the legacy default-config
contract (top-level production). Stripe test cannot select production.

## Invocation and boundary

```
node dist/cli/index.js connection destinations --json <repository>
node dist/cli/index.js connection deploy --service openai --env preview --destination api-staging --dry-run --json <repository>
```

The selected managed intent and settled credential revision must still match.
The offline preview runs no provider process and reads no value. Config readiness
in the destination list is local only. Execution requires Pro and the qualified
Windows host. `--force` is refused on this route: Cloudflare already overwrites
and each write requires a new approval.

Only the fixed official operation is reconstructed:

`wrangler secret put <fixed-service-secret-name> --config <registered-config> --name <verified-Worker> [--env <registered-section>]`.

The existing Windows approval shows project, service, source revision, source
environment, catalog ID, account, Worker, config, application classification,
Wrangler section/top-level and the immediate deployment/overwrite effect.
The selected catalog, config, path/directory identities, provider auth identity,
CLI and source revision are rechecked across awaited boundaries, after approval,
before value read, before spawn and before recording completion. Changes stop
the operation. Arbitrary config content is never returned or hashed; metadata
file identity changes invalidate the invocation. Only the validated nonsecret
catalog projection is hashed. `.env*`/`.dev.vars*` presence anywhere from the
repository to the selected config directory refuses execution without reading
those files (`.env.example` remains excluded).

Only `deploy/handoff.ts` reads the value, and only stdin sends it to the fixed
official CLI. Caller environment maps are discarded. Wrangler 4 is required.
Logging is forced to Windows' reserved `NUL.log` device path (no physical log),
sanitization is forced on, metrics/error reporting are disabled, and raw stdout,
stderr and exceptions are discarded. These are invocation settings, not changes
to the owner's normal CLI settings. Stripe mode is rechecked inside the
value-bearing boundary. No secret export or arbitrary runner is added.

Journal schema 4 retains the closed nonsecret `cloudflareTarget` with each
attempt. An unknown attempt is durable before the value is read. Historical
schemas 1–3 remain readable; an older reader must refuse schema 4. Receipts remain
advisory, never permission or remote-state proof. Config receipts are not compared
with an unrelated default root config during history inspection. Each Worker is
a separate invocation/receipt/approval; partial completion never triggers replay.

## Acceptance and application handoff

`CLOUDFLARE_TARGET_NATIVE_ACCEPTED` is a separate source gate checked in the engine
and the innermost handoff. The broader OpenAI/Stripe Vercel/default-config gate
remains unchanged. Mocked tests cannot accept either native gate. Developer-only
acceptance may qualify an exact disposable candidate with synthetic OS-store
entries, native Human Plane and a local CLI transport fixture; it performs no
Cloudflare upload. Record the candidate and observed evidence before changing
the narrow source gate. No runtime flag or stored approval can enable it.
The registered-config gate is now accepted on the supported Windows path;
observed candidate, 150% native acceptance and the independent broader disabled
gate are recorded in Windows verification (maintainer-only evidence; omitted from the public tree).

After approved real placement, API Key Case stops at the nonsecret placement
receipt. Product/price/webhook setup, purchase/mail/license, OpenAI restoration,
refund/cancel and application staging acceptance stay in the application's
existing operator workflow. Do not expose a stored value to such a script or
invent a shell workaround for an unsupported operation.
