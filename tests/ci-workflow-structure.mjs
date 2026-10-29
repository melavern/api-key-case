import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8").replace(/\r\n?/gu, "\n");

// The contract is "which events can start a runner, and how wide", not the exact old layout:
// a Private push/PR must reach zero runners, and only the scope job may decide breadth.
function jobBlocks(normalized) {
  const jobsStart = normalized.indexOf("\njobs:\n");
  assert.notEqual(jobsStart, -1, "CI jobs section must exist");
  const body = normalized.slice(jobsStart + "\njobs:\n".length);
  const parts = body.split(/^  (?=[a-z][a-z0-9-]*:\s*$)/m).filter(Boolean);
  return new Map(parts.map((part) => [part.slice(0, part.indexOf(":")), part]));
}

function validateWorkflow(input) {
  const normalized = input.replace(/\r\n?/gu, "\n");
  const jobs = jobBlocks(normalized);
  const others = [...jobs.keys()].filter((name) => name !== "scope");
  const checks = [
    ["workflow name remains CI", () => assert.match(normalized, /^name: CI$/m)],
    ["Public keeps main push and PR triggers; manual dispatch chooses a breadth", () => {
      assert.match(normalized, /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n  workflow_dispatch:\n    inputs:\n      breadth:\n/m);
      assert.match(normalized, /^        default: representative\n        options: \[representative, keyring, full\]$/m);
    }],
    ["one stable group per PR or ref cancels superseded read-only runs", () => {
      assert.ok(normalized.includes("group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}\n"));
      assert.ok(!normalized.includes("run_id"), "a per-run group never cancels anything");
      assert.match(normalized, /^  cancel-in-progress: true$/m);
    }],
    ["permissions remain contents: read", () => assert.match(normalized, /^permissions:\n  contents: read$/m)],
    ["Private push/PR starts no runner: scope is gated on dispatch or Public visibility", () => {
      assert.ok(jobs.get("scope").includes("    if: github.event_name == 'workflow_dispatch' || github.event.repository.private == false\n"));
    }],
    ["every other job depends on scope, so a skipped scope skips the whole run", () => {
      assert.deepEqual(others, ["web", "test", "keyring-e2e", "package"]);
      for (const name of others) assert.match(jobs.get(name), /^    needs: (?:scope|\[scope(?:, [a-z-]+)*\])$/m, name);
    }],
    ["breadth comes only from scope outputs", () => {
      assert.match(jobs.get("test"), /^    if: needs\.scope\.outputs\.test != '\[\]'$/m);
      assert.match(jobs.get("test"), /^        include: \$\{\{ fromJSON\(needs\.scope\.outputs\.test\) \}\}$/m);
      assert.match(jobs.get("keyring-e2e"), /^    if: needs\.scope\.outputs\.keyring != '\[\]'$/m);
      assert.match(jobs.get("keyring-e2e"), /^        os: \$\{\{ fromJSON\(needs\.scope\.outputs\.keyring\) \}\}$/m);
      assert.match(jobs.get("package"), /^    if: needs\.scope\.outputs\.package == 'true'$/m);
      for (const name of ["test", "keyring-e2e"]) assert.doesNotMatch(jobs.get(name), /^\s+- os: /m, `${name} must not hard-code a matrix`);
    }],
    ["validator is registered in the web job", () => assert.match(jobs.get("web"), /^      - name: Validate CI trigger and concurrency contract\n        run: node tests\/ci-workflow-structure\.mjs$/m)],
    ["keyring lane selects the strict real-store blocks", () => {
      const keyring = jobs.get("keyring-e2e");
      assert.equal((keyring.match(/node tests\/run-tests\.mjs --keyring-only/g) ?? []).length, 2);
      assert.doesNotMatch(keyring, /npm test/);
      assert.match(keyring, /AGENT_KEY_CASE_E2E: "1"/);
      assert.match(keyring, /AGENT_KEY_CASE_E2E_STRICT: "1"/);
      assert.match(keyring, /run: npm run build/);
    }],
    ["packaging waits for the tested SHA without repeating prepack", () => {
      const packaging = jobs.get("package");
      assert.match(packaging, /needs: \[scope, test\]/);
      assert.match(packaging, /run: npm run build/);
      assert.match(packaging, /run: npm pack --dry-run --ignore-scripts/);
    }],
    ["every hosted job has a bounded execution time", () => {
      for (const [name, block] of jobs) assert.match(block, /^    timeout-minutes: \d+$/m, name);
    }],
  ];
  for (const [, check] of checks) check();
  return checks.map(([name]) => name);
}

// Verify both native LF input and a Windows-style CRLF checkout without writing either form.
const lfChecks = validateWorkflow(workflow);
const crlfChecks = validateWorkflow(workflow.replace(/\n/gu, "\r\n"));
assert.deepEqual(crlfChecks, lfChecks);

// The old shape (push to every ref, no gate on scope, hard-coded matrix) must be rejected.
const legacy = workflow
  .replace("    if: github.event_name == 'workflow_dispatch' || github.event.repository.private == false\n", "")
  .replace("  push:\n    branches: [main]\n", "  push:\n");
assert.throws(() => validateWorkflow(legacy));

console.log(`CI workflow structure: ${lfChecks.length} checks passed for LF and CRLF`);
for (const name of lfChecks) console.log(`- ${name}`);
