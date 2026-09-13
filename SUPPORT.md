# Support

API Key Case is maintained as an individual source-available project under the Elastic License 2.0. Support is best-effort; response times and fixes are not guaranteed.

[Website](https://apikeycase.melavern.com/) · [npm](https://www.npmjs.com/package/api-key-case) · [Changelog](CHANGELOG.md) · [Security policy](SECURITY.md)

## Product questions and bug reports

Use [GitHub Issues](https://github.com/melavern/api-key-case/issues) for reproducible, non-sensitive product questions, bug reports, and feature requests. For private context, purchase questions, or a request that includes an order or account detail, email [dev@melavern.com](mailto:dev@melavern.com).

Before posting:

- search existing issues;
- use the latest published version;
- reduce the report to a minimal project using fake canary values;
- remove usernames, local paths, account IDs, repository names, and other private context when they are not needed;
- include the operating system, Node.js version, API Key Case version, command shape, expected result, and redacted actual result.

Never post a real API key, access token, `.env` file, private key, Lemon Squeezy purchase key, `AKC1` license, order number, email address, or unredacted scan output. If a credential was exposed, rotate it at its provider before doing anything else. Deleting an Issue does not undo exposure.

## Purchases and refunds

Do not put transaction details in a public Issue. Use the support or refund route in the Lemon Squeezy order email or order page, or email [dev@melavern.com](mailto:dev@melavern.com) for private purchase and refund support. The product's [14-day refund policy](https://apikeycase.melavern.com/refund) applies.

If you only need help finding that route, open an Issue without including your order number, purchase key, email address, or other buyer information.

## Security vulnerabilities

Do not report vulnerabilities in a public Issue. Use GitHub Private Vulnerability Reporting from the repository's Security tab, or email [dev@melavern.com](mailto:dev@melavern.com) if that route is unavailable, and follow [SECURITY.md](SECURITY.md). Use fake canary credentials in every reproduction.

## What support does not cover

- macOS Agent-first use as a regular workflow: 0.9.1 is a collaborative verification edition. Current CI and real Keychain evidence exist, but native GUI/Accessibility acceptance, Intel hardware and real-Mac provider deployment remain open. Do not purchase Pro relying on macOS deploy; see the [OS support status](https://apikeycase.melavern.com/os-support) and [macOS verification plan](docs/design/macos-human-plane-verification.md).
- obtaining or recovering API keys from a provider;
- account administration for Cloudflare, Vercel, GitHub, Lemon Squeezy, npm, or an operating system;
- writing application-specific deployment or compliance policy;
- emergency incident response, forensic analysis, or a guarantee that a credential was not exposed;
- non-API-Key-Case problems in third-party CLIs, services, networks, or local machines.

For a suspected credential leak, follow the rotation steps in [SECURITY.md](SECURITY.md#if-a-credential-was-exposed).
