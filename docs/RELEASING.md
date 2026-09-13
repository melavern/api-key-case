# Release checklist

This checklist describes the human-controlled steps between the current
private repository and a public npm release. It is deliberately documentation
only: reading it or running the verification commands below must not make the
GitHub repository public, push a commit, create a tag, deploy a Worker, or
publish to npm.

## Brand migration checkpoint

The repository is already Public at `melavern/api-key-case`, managed with the
dedicated `melavern-dev` identity. npm `api-key-case@0.9.0` is already published.
The brand-only migration does not create a release/tag, publish or unpublish a
package, change license terms, or release new product functionality. Do not
repeat the historical first-publication/bootstrap steps below for a rebrand.
Keep published npm metadata and the existing tag unchanged; source metadata
and current links use Melavern. Existing 0.9.0 installs retain the old license
endpoint, which must continue direct handling during compatibility support.

Sender/reply setup and product acceptance remain follow-up release preparation,
not authorization to advance the release during brand migration. Review the
exact brand-only diff and public operation identity before any Public push.

## 1. Local gate before changing visibility

Run these checks from a clean checkout and review their output:

```sh
npm test
npm audit --omit=dev
npm pack --dry-run
npm pack --dry-run --json        # optional machine-readable file-list review
```

The packed tarball must contain only the CLI build, `package.json`, public
README files, `LICENSE`, `NOTICE`, `SECURITY.md`, and `SUPPORT.md`. It must not contain
Workers source/configuration, `tools/`, tests, `.dev.vars`, key material,
purchase keys, or private operator notes. Do not run `npm publish` as a local
verification shortcut.

Before the final review, also confirm:

- `git status --short` is empty and the intended release commit is on `main`.
- `npm test` passes on the advertised Node.js/OS matrix, including the gated
  keyring end-to-end checks when the CI runners provide the OS secret store.
- The live checkout URL and live license-exchange Worker URL are real, and the
  test Worker URL is not compiled into the CLI.
- The existing record for a controlled test-mode purchase → exchange →
  `license activate` → deploy dry-run flow is the evidence for this pre-stable
  gate; reuse it rather than repeating the purchase. Do not use a real card or
  perform a live purchase/refund for v0.9.x release preparation. Before opening
  sales, a human must separately confirm the live checkout, provider settings,
  and final operating decision. An already issued offline `AKC1` cannot be
  remotely revoked.
- `dev@melavern.com` receives support, privacy, security, and commercial
  disclosure requests. Do not use a public Issue for an order, purchase key,
  personal information, or a vulnerability.
- Test both receipt at `dev@melavern.com` and sending/replying with that
  address as the sender. Configure DKIM for the selected mail provider. MX and
  SPF must match the selected provider. Read back the current DMARC settings;
  introduce policy changes in a monitoring/gradual phase first, verify SPF/DKIM
  alignment and reports, then tighten the policy. Do not change DNS as part of
  this code-preparation task.
- The maintainer has reviewed the four security boundaries in `AGENTS.md`,
  `SECURITY.md`, the vault code, and the deploy handoff code. In particular,
  `hasSecret` may reduce an OS-store read to a boolean, while only the deploy
  handoff may retain a value long enough to pass it to an official CLI.
- Every branch and tag intended for publication has been reviewed. The public
  `main` history must begin at the reviewed clean root commit, and obsolete
  private branches must be removed before changing visibility. Keep any
  pre-public backup bundle local under `.git/`; never push or publish it.

## 2. Public repository settings

Historical initial-publication procedure (already completed; do not change
visibility during the brand migration): keep the publication repository Private until the reviewed export is the only
history that the repository can expose. A deletion commit is not sufficient if
an earlier commit or another branch contains withheld development files. After
the clean public history is pushed, change visibility to Public and configure
the repository settings before the first tag:

1. Set the homepage to `https://apikeycase.melavern.com/` and add useful
   topics such as `cli`, `secrets`, `dotenv`, `mcp`, and `typescript`.
2. Require pull requests, required CI checks, conversation resolution, and
   no force-push/deletion on `main`. Protect `v*` release tags from accidental
   changes as well. GitHub Free may require the repository to be Public before
   some ruleset options are available.
3. Enable Dependabot alerts/security updates, secret scanning, and push
   protection. Review every alert before release; never dismiss a finding just
   to make the release green.
4. Enable GitHub Private Vulnerability Reporting and keep it separate from
   public Issues. The public Issue templates are for non-sensitive bugs only.
5. Confirm the pinned action SHAs in `.github/workflows/` are still the
   intended releases. Dependabot is configured to propose updates weekly.

## 3. First npm publication and Trusted Publishing

Historical bootstrap procedure (already completed for 0.9.0): the unscoped
package was initially unpublished. npm cannot register the
GitHub trusted publisher against a package that does not exist yet. Use this
one-time bootstrap sequence:

1. Create the GitHub Environment named `npm`, require a reviewer for it, and
   restrict deployments to the protected `main`/release workflow policy.
2. The package does not exist yet, so npm may not offer a package-scoped
   granular-token choice. Create the shortest-lived granular token available
   with `Packages and scopes = Read and write` and `All Packages`, and enable
   its temporary `Bypass 2FA` setting so CI can publish once while account 2FA
   remains enabled. This is broader than the desired steady-state permission
   and is a one-time risk: add it only as `NPM_TOKEN` to the protected `npm`
   environment, never to the repository, a regular repository secret, a local
   `.env`, or a command argument. Delete the Environment secret and revoke the
   token immediately after the first publish.
3. Confirm the package version in `package.json` and the tag name will be
   identical (`0.9.0` → `v0.9.0`, or the deliberately chosen release version).
   The publish workflow rejects mismatches and rejects tags not reachable from
   `origin/main`.
4. After Public visibility and the final repository review, create the release
   tag and let `.github/workflows/publish.yml` run with the protected Environment
   approval. The workflow runs its tests and dry-run first, then uses the
   temporary token only when `NPM_TOKEN` is present. Provenance is requested.
5. Immediately delete `NPM_TOKEN` from the GitHub Environment and revoke the
   npm token. In npm package settings, register the Trusted Publisher as:
   GitHub Actions, owner `melavern`, repository `api-key-case`, workflow
   filename `publish.yml` (npm expects the filename, not the `.github/workflows/`
   path), and Environment `npm`. Set Allowed actions to `npm publish`.
   After the switch, set Publishing access to `Require 2FA and disallow
   tokens`.
6. For every later release, leave `NPM_TOKEN` absent. The same tag-only job
   authenticates with npm's short-lived GitHub OIDC exchange and requires the
   repository to remain Public. A manual workflow dispatch can only perform a
   dry run.

Do not reuse a published version. npm versions are immutable; a failed or
partially completed release needs a new version and a documented recovery
decision.

## 4. Final public smoke check

After the first publish, from a disposable directory run:

```sh
npx --yes api-key-case@<published-version> --version
npx --yes api-key-case@<published-version> scan .
```

Confirm the npm page, README links, legal pages, support email, checkout, and
license exchange endpoint are reachable. Rotate or revoke any temporary
bootstrap credential and review the first provenance attestation before
announcing the release.
