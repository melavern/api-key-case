# macOS Human Plane verification

Status (2026-09-13, 0.9.1): **collaborative verification edition**. Windows 11
+ Windows Hello proceeds as the normal release target. macOS native acceptance
is a separate follow-up, not a Windows publication blocker. Verification toward
regular macOS support is still in progress. Do not purchase Pro relying on
macOS deployment.

This document is the standalone handoff for later Mac work. Implementation is
retained without relaxing any input, approval, deletion or destination boundary.
The current AppKit affirmative button is not an OS identity check; resistance
to an Accessibility-enabled sibling process is unknown. Use disposable canaries
for collaboration, not production Secrets or production destinations.

## Evidence and gaps

| Area | Confirmed evidence | Still unverified |
| --- | --- | --- |
| Portable helper control flow | Ubuntu generated-script tests cover store failures, cancellation, approval/refusal and both removal plans | Native JXA/framework bridging and real dialogs |
| OS store / provider history | Earlier 2026-08 CI recorded arm64 Keychain and provider flows; see VERIFICATION's historical runner results | Current 0.9.1 Agent-first native flow; earlier TTY flows do not establish acceptance |
| GitHub Actions | On 2026-09-12, run `34670958401` for candidate `255ab6e` passed all nine jobs; the sequence also has real login-Keychain E2E evidence in run `34670069746` | An interactive user's input/resumption, native GUI approval, Accessibility/TCC, real-Mac provider deployment and Intel coverage; runner success cannot establish these |
| Approval / deletion | Fixed helper, sanitized environment, default No and snapshot checks are implemented | Human-only actuation: deploy approval, Secret deletion and trust deletion remain button-based |
| Distribution / discovery | Architecture-aware trusted CLI and Node paths have portable fixture coverage | Installed tarball on arm64 and x64, real install locations and selected official CLI versions |

No current native acceptance result is claimed. [VERIFICATION](../VERIFICATION.md)
holds dated observations; preserve earlier results as historical evidence.
On 2026-09-08 the Private repository's Actions API reported `enabled: false`;
the candidate push therefore produced no CI run. That was the state at that
checkpoint, not the current CI state. On 2026-09-12, run `34670958401` for
`255ab6e` passed all nine jobs, including the macOS keyring lane; this updates
the CI evidence only and does not establish native GUI, human approval,
Accessibility, Intel or real-Mac provider acceptance. Enabling the repository's
Actions was an operator follow-up; this task did not change the product
boundary.

## Resume with a contributor

Start with the reviewed candidate commit and its locally packed 0.9.1 artifact
(until that exact version is published). Run the portable and CI checks first,
then the native checklist below on an interactive Mac. Record each case as
PASS / FAIL / NOT RUN / INCONCLUSIVE, with OS/build/architecture, Node/Agent/
provider CLI versions, candidate SHA and CI run/job URL where applicable.
Record only names, status and sanitized metadata, never Secret values or input
screenshots. Report security findings privately via SECURITY.md; contributor
coordination or real provider writes require their own explicit authorization.

Native acceptance remains open. This plan can be
prepared on Ubuntu; executing its native checks requires an interactive Mac.
No hosted Mac, CI dispatch, new service, or change to the product boundary is
needed for the portable work. [RELEASING](../RELEASING.md) owns the release gate;
[VERIFICATION](../VERIFICATION.md) records observations, not this plan.

## What can run on Ubuntu

After `npm run build`, run `node tests/macos-human-plane-script.mjs`.
The same checks are included in `npm test`.

The test executes the generated helper JavaScript against in-memory doubles
for AppKit/Foundation/Security.framework. It exercises:

- User/project service-account selection, updating an existing item, and adding
  only after item-not-found. Access denied, cancellation, unknown errors,
  duplicate items, exceptions and encoding failure never report saved.
- Cancel/unknown dialog responses and blank input without a store write;
  cancel does not even read the input field. Handled completion paths clear it.
- Approval and both removal plans: default No, explicit affirmative result,
  refusal/unknown results, dialog failure, no credential mutation by a decision
  helper, and visible operation details.
- Quoted, backslashed and Japanese display text remains literal rather than
  executing as JavaScript.

These checks extend the existing launcher, validation, pinned-interpreter and
readiness tests. They **do not emulate native JXA bridging**, actually use a
Keychain, open a GUI, exercise Accessibility/TCC, or establish arm64/x64
compatibility. The affirmative-result test explicitly describes the current
button-only mapping; it is not proof of human identity.

## Native checks still required

Record the candidate commit/artifact, macOS version, architecture, Node version,
terminal/Agent host, interactive session and the permission state of the
actual attacker process. Use synthetic names and canary plans. Never record
Secret input, lengths, hashes, screenshots of input, or unrelated Keychain
items. An existing OS permission must not be inferred from a process name.

1. **Framework and distribution compatibility.** Build and test on each
   advertised architecture, then install the actual tarball into a disposable
   consumer. Exercise its exact-version bootstrap, trusted CLI discovery and
   sanitized provider probes. This does not authorize a provider write.
2. **Input and resumption.** Use the real `save --ask` dialog with synthetic
   input: save FIRST, cancel SECOND, inspect registration by name/status, then
   resume only SECOND. Check the intended service/account independently using
   existence-only Keychain metadata. Repeat an authorized overwrite and a
   refused overwrite. Keep input in the Human Plane.
3. **Manual decisions.** Use non-executing canary plans for deploy approval,
   Secret removal and trust removal. Verify the complete destination/operation
   text, initial refusal, affirmative action and unavailable/canceled GUI
   behavior. Then use separately authorized disposable entries to check that
   actual refusal preserves values/trust and actual approval deletes only the
   intended entry. A test double is not native evidence.
4. **Accessibility measurement.** First prove the driver can actuate dummy
   affirmative controls and independently observe their action callbacks.
   Bind every target to the PID and window started by that test. Only then
   attempt the product's approval, Secret-removal and trust-removal buttons
   with canary plans that perform no deploy or deletion. The human must not
   click the product button during that attempt. Record both driver evidence
   and the helper's decision. Measure the developer-terminal/IDE context with
   Accessibility permission, not only a process denied that permission.
   Any permission changes require the human's explicit choice on that Mac.
5. **Interpret failures honestly.** Driver crash, timeout, wrong PID/window,
   missing permission, or failed positive control is inconclusive about the
   product's defense. A sibling-actuated affirmative result is a boundary
   failure even though the canary performed no write. A successful manual
   click or a noninteractive CI pass cannot settle that attack path.

The current repository has no macOS Accessibility driver with native evidence;
the Windows MSAA driver is not a substitute. Do not mark these checks complete
from the portable doubles or silently skip native cases as passed.

## Decision after measurement

The current macOS helper uses the AppKit button result; Windows additionally
requires OS verification. [SECURITY](../../SECURITY.md#known-limitations) states
this asymmetry without claiming TCC closes it. A measured bypass stops macOS
approval acceptance. Human review must decide the repair or narrower support
claim before promoting macOS into normal support. Do not add a TTY,
chat, `--yes`, or automatic approval fallback. Disclosure does not establish
macOS acceptance; the separate Windows-first publication decision is already
settled and does not wait on this measurement.
