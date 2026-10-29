# Fixed-project local MCP profile

`api-key-case mcp <project> --vnext` opts in to a separate, read-only profile.
Default MCP retains its existing seven tools. `--guidance-only` retains its
single requirement-summary tool. The flags are mutually exclusive. Nothing
edits a client's settings, starts a network listener or creates a tunnel.

The server binds the project's physical directory at startup and checks it
again before returning observations. MCP arguments cannot select a path,
account, URL, command, environment map, key value or approval result. Unknown
arguments fail with a fixed status; SDK errors do not echo caller-controlled
field names or validator details. A profile instance is not authentication
against another process running as the same OS user.

| Tool | Closed metadata arguments | Result |
| --- | --- | --- |
| `secret_capabilities` | none | Actual OS/backend and source acceptance gates |
| `discover_credentials` | optional environment and variable | Existing project Binding IDs and fresh presence state |
| `request_secret_input` | optional environment and variable | Reuse-first guidance; no input window or write |
| `plan_secret_binding` | environment, variable; optional credential ID and risk | Existing core plan projection; candidate labels/locators stay private |
| `plan_secret_use` | binding ID + target ID, or profile ID | Pro-gated placement/launch plan without provider probes or execution |
| `request_secret_use` | same as plan | Plan plus action-required guidance; no operation or approval |
| `get_secret_operation_status` | operation ID | Project-scoped closed status; no replay or journal contents |

IDs are metadata, never permission. Native input, Binding selection and fresh
Windows verification remain in the local CLI Human Plane. Missing, unknown
and unavailable are different states: review existing registrations/assignments
before requesting new input. A receipt does not establish the current provider
value or authorize another execution. An unbound registration operation is
not exposed through another project's MCP instance; inspect it with the local
CLI instead. A running/executing operation is observed conservatively as unknown.

Use a reviewed local build from the same source revision as the CLI. For a
stdio-capable client, review a server definition with the exact installed Node
executable, the absolute `dist/cli/index.js` entry, and arguments
`mcp`, the fixed project directory, `--vnext`. No credential environment block is
needed. This candidate has not been published through npm or the MCP Registry;
do not substitute the older public npx version. Global client configuration is
left to the user's explicit connection action.

Acceptance uses two fresh SDK stdio clients against synthetic persisted metadata:
both find the same existing Binding and operation without another key entry.
Separate protocol tests exercise the actual CLI profile and preserve the default
and guidance-only profiles. This proves local protocol behavior, not an actual
connection to every chat host.

## Cloud chat transport remains a separate acceptance

The official [ChatGPT MCP documentation](https://learn.chatgpt.com/docs/extend/mcp)
describes local stdio in desktop clients; hosted ChatGPT does not simply inherit
a PC's local Codex MCP settings. The official
[Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
also provides private connectivity, with workspace/plugin authorization and an
actual ChatGPT tool call required to establish success. Its private testing route
is distinct from distributing a public plugin. References checked 2026-10-21.

No remote route has been configured or accepted for this product. Before using
one, independently review the fixed client/device identity, authentication,
network exposure, least privilege, grant expiry/revocation, replay handling,
local Human Plane and audit output. Obtain explicit connection consent, then
prove the real host call without returning a key. The existence of a provider
tunnel does not itself meet those product requirements. Until then, cloud chat
access to this local vault is unsupported by this candidate.
