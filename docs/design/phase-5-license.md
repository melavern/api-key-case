# Phase 5 Design — Lemon Squeezy purchase exchange and offline Pro license

> This document is subordinate to `CLAUDE.md`; its security boundary wins on conflict.
> Phase 2 Vault, Phase 3 Deploy, and Phase 4 MCP invariants remain in force.
>
> Current license status: beginning with v0.9.1, the product code is source
> available under the Elastic License 2.0 (`Elastic-2.0`). The v0.9.0 release
> remains under the MIT license shipped with that version. This status note
> supersedes the original v0.9.0 licensing characterization below without
> changing this document's runtime design.

## 1. Decision and scope

`deploy` in the CLI and `deploy_secret` in MCP are unlocked by a buy-once Pro license. Lemon Squeezy handles checkout and delivery of a unique purchase license key. The buyer runs:

```text
api-key-case license activate
```

The CLI accepts the purchase key through hidden TTY input, sends it once to the fixed Cloudflare Worker endpoint, locally verifies the returned Ed25519-signed `AKC1`, and stores it. Every later Pro decision is an offline signature verification.

The free/paid boundary is unchanged:

- Free: scan, save, check, list, remove, env/example generation, leak scan, targets, and all MCP tools except the execution path of `deploy_secret`.
- Pro: CLI `deploy` and MCP `deploy_secret`.

For v0.9.0, this was released as a public MIT codebase with a good-faith gate. Beginning with v0.9.1, the product source remains public under ELv2, whose standard limitations include the license-key restriction; the purchase entitlement, offline implementation, and Free/Pro runtime boundary are unchanged.

## 2. ADR: validate, authenticated order check, and no D1

### 2.1 Use License API `validate`, not `activate`

The exchange does not implement machine binding or Lemon instance management. `activate` creates an instance, consumes an activation allowance, and makes a harmless retry capable of failing after a network interruption. `validate` has no such side effect and returns the license ID/status/expiry plus store, order, product, and variant identifiers required here.

Accepted license statuses are `inactive` and `active`. `disabled`, `expired`, `valid: false`, malformed responses, and expired `expires_at` values are rejected.

### 2.2 Also retrieve the order

Lemon's current License API documentation does not guarantee that a one-time product license is automatically disabled when its order is refunded. Therefore `valid: true` alone is insufficient. After validation, the Worker calls the authenticated Orders API once using `meta.order_id` and requires:

- matching order and store IDs;
- `status === "paid"`;
- `refunded === false`;
- `refunded_amount === 0` (also rejects partial refunds);
- the configured test/live mode.

This requires `LEMON_API_KEY`. No additional Lemon API calls are made.

### 2.3 No D1 or webhook in v1

The `AKC1` payload uses immutable Lemon data:

```json
{ "v": 1, "plan": "pro", "id": "ls_license_<license-id>", "issuedAt": "<license-created-date>" }
```

Ed25519 signatures are deterministic, so identical Lemon license information produces an identical `AKC1`. Concurrent retries and lost responses need no exchange ledger. D1 would add state without preventing transfer of an already-offline key. Webhooks would not revoke an already-issued offline key, so they are also omitted.

Refunded or disabled licenses cannot perform a future exchange. An `AKC1` already issued cannot be remotely revoked; this is accepted under the good-faith offline model.

## 3. Key roles and format

- Lemon purchase key: buyer-specific proof of purchase delivered by Lemon. Used only as hidden input to the one-time online exchange. Never saved by the CLI.
- `AKC1`: local API Key Case entitlement returned by the Worker and stored at `~/.api-key-case/license.key`.

The existing format is unchanged:

```text
AKC1.<base64url(payloadJson)>.<base64url(ed25519Signature)>
```

The payload contains no email, name, purchase-key text, or other personal information. The signing input is `AKC1.<payloadPart>`. The public key remains embedded in `packages/core/license.ts`; the matching existing PKCS#8 private key is configured only as the Worker secret `AKC_ED25519_PRIVATE_KEY`.

The signed JSON field remains `id` for compatibility. After verification, core exposes that value as `LicenseStatus.entitlementId`; CLI output labels it `license`. It is not called or displayed as an order ID. This terminology change does not alter the AKC1 prefix, payload JSON, signing input, signature, public key, or private key.

## 4. Exchange Worker

Location: `workers/license-exchange`. Endpoint: `POST /license/exchange`.

Required secrets in each Worker:

- `LEMON_STORE_ID`
- `LEMON_PRODUCT_ID`
- `LEMON_VARIANT_ID`
- `LEMON_API_KEY`
- `AKC_ED25519_PRIVATE_KEY`

Required bindings/config:

- `PURCHASE_KEY_RATE_LIMITER`: 5 calls per 60 seconds, keyed by a SHA-256 digest of the purchase key
- `IP_RATE_LIMITER`: 30 calls per 60 seconds, keyed by `CF-Connecting-IP`
- `LEMON_TEST_MODE`: config-fixed `true` for test and `false` for live

The IP limiter runs before reading the request body and suppresses attacks that rotate purchase keys. A missing or blank `CF-Connecting-IP` uses the shared `ip:unavailable` fallback bucket, so missing metadata does not bypass the limit. After strict body parsing, the Worker hashes the purchase key with SHA-256 and passes only the digest-derived key to the purchase-key limiter. Neither the purchase key nor digest is written to logs, errors, or responses. Any Rate Limiter exception fails closed before Lemon validation or AKC1 signing.

The Worker otherwise bounds request/upstream response bodies, accepts only the exact JSON shape `{ "licenseKey": "..." }`, uses timeouts for Lemon calls, validates all untrusted JSON structurally, and fails closed. It returns only `{ "licenseKey": "AKC1..." }` or a fixed error code. It sends no CORS allow-origin header.

Logs contain event names only. They never contain the purchase key, body, customer fields, upstream response, API token, or private key.

Test and live are separate Cloudflare resources. `wrangler.test.jsonc` names `api-key-case-license-exchange-test`, fixes `LEMON_TEST_MODE=true`, and uses rate-limit namespaces `2001`/`2002`. `wrangler.live.jsonc` names `api-key-case-license-exchange`, fixes `LEMON_TEST_MODE=false`, and uses namespaces `1001`/`1002`. Their secrets are set independently against the respective Worker. The CLI may compile only the live Worker URL.

## 5. CLI and MCP

Commands:

```text
api-key-case license activate
api-key-case license status [--json]
api-key-case license deactivate
```

`activate` requires an interactive TTY, hides input, rejects argv and piped stdin, and uses a compiled HTTPS endpoint. There is no environment variable or config file that can redirect the purchase key. Test-only function injection is not reachable from the CLI.

The existing license file is replaced only after the returned AKC1 passes local signature verification. A failed exchange therefore preserves a valid existing license.

`status` never prints either key body. `deactivate` only deletes the local AKC1. Runtime `assertProFeature("deploy")` stays offline.

MCP adds no tools or fields. It never receives a purchase key and continues to tell a human to buy and activate via the CLI.

## 6. Security invariants

1. Phase 2–4 secret-value paths and MCP schemas do not change.
2. Purchase-key input is hidden TTY only and is sent only to the fixed HTTPS exchange endpoint.
3. No purchase key, personal data, API key, or signing key appears in logs, errors, fixtures, Git, or npm artifacts.
4. Exact store/product/variant/test-mode and paid/non-refunded order checks are mandatory.
5. Lemon failures, timeouts, malformed JSON, unknown statuses, or configuration errors fail closed.
6. Rate Limiter failures fail closed and cannot issue AKC1.
7. Only a locally verified AKC1 may replace the saved license.
8. Missing/invalid licenses gate only deploy paths; free commands are unaffected.
9. The Worker private key must match the public key already embedded in the CLI. No replacement production key is generated in this repository.

## 7. Selling and release

The storefront is Lemon Squeezy. The current price is maintained on the storefront and landing page rather than hardcoded into runtime code; entitlement covers the current Pro v1 line, and `AKC1` carries no version field, so a later major version would gate by shipping a different check rather than by expiring an issued license. The purchase link and live exchange URL are configured in `packages/core/license.ts` and `packages/core/license-exchange.ts`; the publish workflow blocks if either file still contains its explicit placeholder marker. The purchase link the CLI and MCP relay points at the site's purchase section (`https://apikeycase.melavern.com/#purchase`), not at the bare checkout, so a buyer sees the price, host conditions, Terms and refund policy before the Lemon Squeezy button; the checkout URL itself lives only on the site.

`tools/issue-license.mjs` is retained only as an issuer-side recovery/testing tool. It is not the normal fulfillment flow and remains excluded from npm.

## 8. Tests and acceptance

Automated tests cover successful exchange; invalid/disabled/expired licenses; store/product/variant mismatch; full/partial refund rejection; timeouts; malformed JSON; deterministic re-exchange and SHA-256 hashing; same-key and rotating-key rate limits; low-volume shared-IP acceptance; plaintext-canary exclusion from limiter records/logs/errors; Rate Limiter fail-closed behavior; AKC1 tampering and unchanged payload shape; failed activation preserving an existing license; non-TTY and argv rejection; unchanged MCP surface; free-feature regression; and package exclusions.

For the v0.9.x pre-stable gate, reuse the existing Lemon test-mode checkout → receipt key → deployed test Worker → CLI activation verification record; do not repeat the purchase or use a real card for this release-preparation task. A live purchase/refund is not required for this gate. Before opening sales, a human must separately confirm the live checkout, provider settings, and final operating decision.

## 9. Official references checked (2026-07-14)

- Lemon License API validate: https://docs.lemonsqueezy.com/api/license-api/validate-license-key
- Lemon license statuses: https://docs.lemonsqueezy.com/api/license-api
- Lemon order/refund fields: https://docs.lemonsqueezy.com/api/orders/the-order-object
- Lemon test/live separation: https://docs.lemonsqueezy.com/help/getting-started/test-mode
- Cloudflare Workers best practices: https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- Cloudflare Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cloudflare Wrangler environments: https://developers.cloudflare.com/workers/wrangler/environments/
- Cloudflare Worker secrets: https://developers.cloudflare.com/workers/configuration/secrets/
