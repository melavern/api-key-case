# Ordinary local application launch

Private vNext candidate for `roadmap:local-app-handoff`. The old fixed
Resend/development Node route keeps its own entry, limits and acceptance gate.
This document describes the independent editable-app route, not public 0.9.2.

`secret profile plan|register` proposes and independently confirms a
`node-entry`, `node-package-script`, `python-entry` or `python-module`
LaunchProfile. It binds a physical Project, runtime path/SHA-256, a relative
entry or module, working directory, existing Binding IDs, and 1–7200 seconds.
`--profile` proposes an explicit revision update; registration alone does not
start an app or authorize value use. Recovery by operation ID observes the
metadata CAS and never reapplies a pending registration.

`secret profile list --project <app> --json` discovers only the verified physical
project's existing profile IDs, kinds, Binding IDs and duration limits. It returns
no runtime paths, source paths, labels or profiles belonging to other projects.
An identical `profile plan` also returns the existing ID. Identical registration
is `unchanged` without another dialog or Catalog write; launch still requires its
own new verification. Ambiguous existing duplicates require an explicit profile
ID; discovery does not silently choose one.

The first npm profile supports the installed Node's `npm-cli.js` and only
`dev`/`start`. A package.json and package-lock.json are required. Other package
manager locks are rejected. The manifest hash includes pre/post scripts and
dependency selection; the review displays the main script and explains that
scripts and children can run. No install hook is invoked by API Key Case.
Project `.npmrc` is refused without reading it. Fixed empty Windows device
config locations disable user/global npm settings, and a fixed system cmd.exe
is the script shell. npm logs and update checks are disabled. Python uses
`-E -s` and an exact `.py` entry or validated dotted module name; there is no
`-c`, `-e`, caller argv or caller environment-map interface.

`secret launch plan|apply --profile <id>` is Pro, including a read-only plan.
The plan returns IDs, revisions, state and the app-readable risk. Human-only
review includes key labels, variable/environment/risk/generation, runtime,
entry, working directory, scripts and time limit. Each launch requires fresh
HWND-bound OS verification; only Verified permits continuation. Plans,
registration, previous receipts and chat confirmation grant no authority.

The dedicated Windows owner shares the existing strict private parser,
file/path guards and Win32 Job primitives. It pins runtime and manifest/lock
selection, creates the root suspended and atomically in a kill-on-close Job,
then requires a fresh basis check before RELEASE. It inherits only NUL handles
and a small fixed environment plus the approved variables. All OS value reads
and construction of the private numbered-value payload remain within
`deploy/handoff.ts`. Reserved interpreter/loader/shell/environment-control
variable names are rejected. No value enters argv, files, operation records,
CLI/MCP output or ordinary logs.

Source bytes are intentionally editable. Entry/module names remain fixed;
manifest/dependency selection, runtime identity, Project, profile, Bindings and
credential generations are revalidated. Changed selection or generation stops
an owned session. Cancelling the CLI, closing its parent, terminating the owner
or reaching the deadline terminates descendants. A terminal result requires
native tree termination and helper closure; otherwise it is unknown.

The app, dependencies, children and the same OS user can read keys. The tool
does not prevent their file/network/log disclosure. stdio is disconnected,
including ordinary development server logs. Source editing does not imply
isolation from an Agent that can edit the app.

Each profile has a durable use lock and a value-free operation journal before
the handoff. Running/prepared observed after interruption becomes unknown;
unknown or pending operations block another launch and never reopen approval.
Locks are not cleared based on age. Settled operations are historical evidence,
not reusable grants. `secret launch apply --operation <id>` only observes.

Run `npm run test:vnext-local` for contract/process tests,
`npm run test:vnext-local:windows` for synthetic owner lifecycle tests and
`npm run test:vnext-local:verified` for human-operated verification with
dedicated synthetic OS slots. Actual observations belong in VERIFICATION.md.
Ubuntu acceptance is separate and remains deferred at the user's request.
