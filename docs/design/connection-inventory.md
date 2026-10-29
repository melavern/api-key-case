# Rediscover existing connection registrations

Private development candidate for `roadmap:connection-memory`. The existing
roadmap order and current guided-acquisition focus are unchanged. This bounded
read-only inventory can proceed independently of the existing Windows/macOS panel
acceptance; it does not complete either roadmap stage.

## User outcome and entry

```
api-key-case connection inventory [--json] [path]
```

A new Agent/terminal can find a registered development or preview slot even
after the currently selected connection moved to another environment. It can
show the existing registration and historical placement targets rather than
asking the human for the same key again. Generated private Agent instructions
point to this command using the same captured, built CLI. Public npm 0.9.2 is
not promoted to support this private command.

Existing `next` describes the current selected profiles. Legacy `list` is not a
v2 environment inventory and uses the registry/availability lifecycle. Neither
is replaced. This command adds the fixed-eleven cross-environment view without
adding a connection registry, a new database or a persisted schema.

Explicit restoration of a previously recorded selection is a separate,
metadata-only [connection resume plan/apply flow](connection-intent-memory.md).
Inventory itself remains read-only and never changes the selected environment.

## Fixed sources

- Resend / `RESEND_API_KEY`, Clerk / `CLERK_SECRET_KEY`, and OpenAI / `OPENAI_API_KEY` each in development, preview and production; Stripe test / `STRIPE_API_KEY` in development and preview. All eleven slots belong to the requested project only. Stripe provider test mode is separate from the application environment.
- Existing `ConnectionStateStore.readCredentialRegistration` for the exact
  environment slot and existing validated current Resend/Clerk selections.
- Existing `hasSecret` for at most eleven explicit v2 references. It returns only
  booleans; the backend may internally read/discard a value. No `getSecret`,
  registry or vault enumeration, user-scope lookup, legacy fallback, availability
  probe, write or delete is available to the projection.
- Existing validated v2 `DeploymentHistory` for this project. The latest receipt
  per service/environment/allowlisted target is projected as historical metadata.
  Unbound legacy receipts cannot satisfy a v2 slot. No other project is scanned.

No provider/CLI/browser call, network request, authentication, grant, secret
issuance, deployment, app run, current selection change or metadata write occurs.
The CLI accepts only one project path and an optional `--json`; there is no
`--all`, `--scope`, arbitrary name, metadata-root or repair override.

## Conservative report

The command's output schema is version 2; all stored schemas stay unchanged. The common-provider candidate uses `next` schema 13 for recorded-profile continuation. Each row separates presence, registration metadata, current
selection and historical placements. `permission: none`, `executed: false` and
`currentHealth: unverified` apply to the whole report.

- Settled metadata plus a positive exact-slot read identifies a reusable
  registration. If not currently selected, `review-recorded-environment` asks
  the Agent to review the intended environment/destination, not switch it.
- Presence without settled metadata remains visible but needs metadata review;
  it must not lead to duplicate key entry.
- Pending, locked, temporary, invalid, unreadable or changed metadata remains
  unavailable. No absence claim is made from a failed lookup or uncertain write.
- Missing metadata is `not-recorded`, not proof that the OS-store slot is empty.
  A clean negative exact-slot read can say `missing`, but that still does not
  mean the application needs that credential or authorize creating it.
- A selected provider-native route requires no duplicate vault registration.
- OpenAI and Stripe test currently have registration only. `review-consumer-contract` means reuse the stored slot and inspect `connection credential guide`; it does not select or authorize a consumer. No receipt or provider success is invented for these new profiles.
- A historical `completed` placement is never current remote configuration,
  credential validity, application success, execution permission or safe retry.
  Equality to a current registration revision means only the recorded revision
  matches; it does not establish the same remote value or current intent.
- Current selections, per-slot metadata and history are rechecked after the
  awaited presence reads. A change clears the affected claim instead of mixing
  old and new selections. This is advisory point-in-time inspection, not an
  atomic snapshot of OS-store changes performed outside the product.

No unknown becomes an automatic save, overwrite, reissue, migration, cleanup or
route change. Safe continuation uses the existing `next`, guide and exact-slot
check flows after confirming the intended selection, retaining their gates.

## Deliberate limits

This is not a general secret catalog or restoration of every historical account,
Worker, Vercel project, local session or native integration. Only the eleven known
credential slots and the closed target classes in their v2 placement receipts
are shown. Current native/application/local-session evidence remains in the
existing reports. Moving a checkout or switching OS users is not automatic
project migration, and this command never bridges those security boundaries.

## Verification

The dedicated offline suite uses fake storage and synthetic metadata. It covers
all eleven slots, discovery after selection changes, registration without metadata,
uncertain/pending states, wrong-project isolation, historical receipts, races,
canary non-disclosure and fresh CLI resumption with forbidden effects denied.
Tests must show that the previously registered environment can be found while
the current selection and existing files remain unchanged. Portable tests are
not OS-store/native UI/provider acceptance.
