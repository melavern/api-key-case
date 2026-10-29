# Windows 0.10.0 candidate scope

Version 0.10.0 is prepared for release. Published api-key-case 0.9.2 remains
separate; this document does not announce npm availability.

The candidate adds named key registrations, project bindings, guarded provider
placement and approved local Node.js / Python application sessions. The ordinary
Agent setup begins with capabilities and project discovery, reusing an existing
registration before asking for missing input. Key values enter through the
native input window and are stored in the OS credential store. Agent-facing
CLI and MCP outputs contain status and metadata, never key values.

The common input window shows the key name, masked input and Save/Cancel.
Additional context is available under Details. Replacing a key also identifies
the existing registration and affected bindings.

## Availability and limits

New generic routes are Windows-only. High-risk operations require Windows 11
Build 22000 or newer and successful Windows identity verification. Registration,
discovery, association and status are free; provider placement and local-app
plans and execution require Pro. Existing legacy support is unchanged.

| Route | Evidence |
| --- | --- |
| Registration, replacement and binding selection | Synthetic Windows native acceptance |
| Cloudflare, Vercel and GitHub placement | Synthetic OS-store and fixed-CLI acceptance with Windows verification |
| Node entry, npm script and Python application sessions | Synthetic OS-store and process-owner acceptance with Windows verification |
| Optional fixed-project local MCP | Two independent SDK stdio clients; chat-host connection remains unaccepted |
| New Ubuntu Desktop and macOS routes | Not accepted |

Synthetic acceptance does not establish a real provider configuration or
application result. See [verification](../VERIFICATION.md) for the checks and
their limits.

An approved app, its dependencies, child processes and the same OS user can read
its environment. Application sessions are limited to at most 120 minutes and
require fresh native confirmation. Disconnecting stdout/stderr does not prevent
an approved application from disclosing a key through its own code or network
access. This tool reduces accident risk; it does not guarantee complete safety.

Cloudflare placement deploys a Worker version immediately. Registering a Vercel
variable does not update an existing application deployment. GitHub Actions can
consume the configured Secret. Unknown or interrupted operations are observed
by operation ID and never automatically replayed. A completion record is history,
not approval for another operation.

Public source, the exact npm artifact and website publication each require the
[release checks](../RELEASING.md). Prepared source and portable tests alone do
not establish publication or renew native/provider acceptance.
