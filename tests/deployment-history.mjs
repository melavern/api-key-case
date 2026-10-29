import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeploymentHistory, buildHistoryReport, historyDiagnostic, historyIssueFromError, renderHistoryDiagnostic } from "../dist/core/deploy/history.js";
import { ConnectionStateStore } from "../dist/core/agent/connection-state.js";
import { connectionCredentialRef } from "../dist/core/agent/connection-credential.js";
import { deriveProjectId } from "../dist/core/vault/naming.js";
import { renderAgentProtocol } from "../dist/core/agent/init.js";

const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const destinationId = "a".repeat(64);
const input = { name: "HISTORY_API_KEY", scope: "project", target: "vercel", env: "preview", destinationId, force: false };
const canary = "synthetic-history-output-must-never-escape";
const journalDir = (home, project) => join(home, ".api-key-case", "deployment-history",
  createHash("sha256").update(realpathSync.native(project)).digest("hex"));

export async function runDeploymentHistoryTests() {
  // Canonical form, as a shell hands the CLI its cwd. On the GitHub Windows
  // runner os.tmpdir() is an 8.3 short name (C:\Users\RUNNER~1\...), which
  // realpathSync keeps and realpathSync.native expands, so index and journal
  // identities would otherwise be derived from two spellings of one directory.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "akc-history-")));
  try {
    const project = join(root, "project");
    const other = join(root, "other project");
    mkdirSync(project); mkdirSync(other);
    const history = new DeploymentHistory(project, root);
    assert.equal(history.read().status, "missing");
    assert.equal(history.read().issue, "not-created");
    assert.equal(existsSync(join(root, ".api-key-case")), false, "inspection must not create metadata");
    const ids = [];
    const run = (args, expected = 0) => {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: project, env: { ...process.env, HOME: root, USERPROFILE: root, DO_NOT_TRACK: "1" }, encoding: "utf8"
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expected, result.stderr);
      assert.equal((result.stdout + result.stderr).includes(canary), false);
      return result;
    };
    const missing = JSON.parse(run(["history", "--json"]).stdout);
    assert.equal(missing.status, "missing");
    assert.equal(missing.schemaVersion, 2);
    assert.equal(missing.destinationInspection, "requested");
    assert.equal(JSON.parse(run(["history", "--json", "--offline"]).stdout).destinationInspection, "skipped-offline");
    run(["history", "--json", "--offline", "--offline"], 1);
    run(["next", "--json", "--offline", "--offline"], 1);
    assert.deepEqual(missing.diagnostic, { phase: "inspect", issue: "not-created", recovery: "none" });
    assert.equal(missing.writeAccess, "not-tested");
    run(["history"], 1);
    run(["history", "--json", "--force"], 1);
    assert.match(run(["history", "--json", join(root, "absent")], 1).stderr, /"issue":"path-unavailable"/);
    writeFileSync(join(root, "plain-file"), "fixture");
    assert.match(run(["history", "--json", join(root, "plain-file")], 1).stderr, /"issue":"unsafe-path"/);
    // Every registration timestamp is metadata, supplied without a value.
    const index = join(root, ".api-key-case", "index.json");
    mkdirSync(join(root, ".api-key-case"));
    const setIndex = (scope, updatedAt) => writeFileSync(index, JSON.stringify({ version: 1, entries: [{
      name: input.name, scope, projectId: scope === "user" ? null : deriveProjectId(project), updatedAt
    }] }));
    setIndex("project", "2026-01-01T00:00:00.000Z");
    ids.push(history.begin({ ...input, rawOutput: canary, value: canary }));
    assert.ok(ids[0]);
    assert.equal(history.read().entries[0].outcome, "unknown", "interrupted operation remains unknown");
    assert.equal(history.finish(ids[0], "completed"), true);
    assert.equal(history.finish(ids[0], "incomplete"), false, "cannot rewrite a finished result");
    assert.equal(history.writeIssue, "record-unavailable");
    ids.push(history.begin({ ...input, force: true }));
    assert.equal(history.finish(ids[1], "incomplete"), true, "failed force may already have removed the old remote entry");
    assert.equal(history.writeIssue, null, "a later successful write clears only the in-memory diagnostic");
    ids.push(history.begin(input)); // interrupted third operation

    let probes = 0;
    let currentId = destinationId;
    const options = {
      baseDir: root, adapters: new Map([["vercel", { id: "vercel" }]]),
      resolveDestination: async () => { probes++; return currentId ? { fingerprint: currentId } : null; }
    };
    const offlineBefore = JSON.stringify(history.read());
    let forbiddenReads = 0;
    const offlineReport = await buildHistoryReport(project, { ...options, offline: true,
      adapters: new Proxy(new Map(), { get() { forbiddenReads++; throw new Error(canary); } }),
      resolveDestination: async () => { forbiddenReads++; throw new Error(canary); }
    });
    assert.equal(forbiddenReads, 0, "offline mode must not even access adapter or resolver capabilities");
    assert.equal(offlineReport.destinationInspection, "skipped-offline");
    assert.ok(offlineReport.entries.every(entry => entry.currentDestination === "unresolved"));
    assert.deepEqual(offlineReport.entries.map(entry => entry.outcome), ["unknown", "incomplete", "completed"]);
    assert.equal(offlineReport.authority, "advisory-local-history");
    assert.equal(offlineReport.currentRemoteState, "not-inspected");
    assert.equal(JSON.stringify(history.read()), offlineBefore, "offline inspection does not rewrite history or locks");
    const offlineCli = JSON.parse(run(["history", "--json", "--offline"]).stdout);
    assert.equal(offlineCli.destinationInspection, "skipped-offline");
    assert.ok(offlineCli.entries.every(entry => entry.currentDestination === "unresolved"));
    let report = await buildHistoryReport(project, options);
    assert.deepEqual(report.entries.map((entry) => entry.outcome), ["unknown", "incomplete", "completed"]);
    assert.equal(probes, 1, "one closed destination probe per recorded target/environment");
    assert.equal(report.currentRemoteState, "not-inspected");
    assert.equal(report.authority, "advisory-local-history");
    assert.ok(report.entries.every((entry) => entry.localRegistration === "unverified"));
    assert.ok(report.entries.every((entry) => entry.currentDestination === "selection-matches"));
    assert.equal(report.entries[1].force, true);
    setIndex("project", "2026-01-02T00:00:00.000Z");
    currentId = "b".repeat(64);
    report = await buildHistoryReport(project, options);
    assert.ok(report.entries.every((entry) => entry.localRegistration === "update-recorded"));
    assert.ok(report.entries.every((entry) => entry.currentDestination === "selection-changed"));
    assert.equal(report.entries[2].outcome, "completed", "past result is retained without claiming current completion");
    writeFileSync(index, "broken");
    report = await buildHistoryReport(project, { ...options, resolveDestination: async () => { throw new Error(canary); } });
    assert.ok(report.entries.every((entry) => entry.localRegistration === "unverified" && entry.currentDestination === "unresolved"));
    assert.equal(JSON.stringify(report).includes(canary), false);

    // Shared user metadata updates apply across projects, but receipts do not.
    setIndex("user", "2026-01-03T00:00:00.000Z");
    const otherHistory = new DeploymentHistory(other, root);
    const shared = otherHistory.begin({ ...input, scope: "user" });
    assert.ok(shared); assert.ok(otherHistory.finish(shared, "completed"));
    setIndex("user", "2026-01-04T00:00:00.000Z");
    const otherReport = await buildHistoryReport(other, options);
    assert.equal(otherReport.entries.length, 1);
    assert.equal(otherReport.entries[0].localRegistration, "update-recorded");
    assert.equal(history.read().entries.length, 3);
    if (process.platform !== "win32") {
      const alias = join(root, "alias"); symlinkSync(project, alias, "dir");
      assert.equal(new DeploymentHistory(alias, root).read().entries.length, 3);
    }
    if (process.platform === "linux") {
      const caseProject = join(root, "PROJECT"); mkdirSync(caseProject);
      assert.equal(new DeploymentHistory(caseProject, root).read().status, "missing");
    }

    const dir = journalDir(root, project);
    const file = join(dir, "history.json");
    const disk = readFileSync(file, "utf8");
    assert.equal(disk.includes(canary), false);
    assert.equal(disk.includes(project), false);
    assert.equal(disk.includes("hash"), false);
    assert.equal(disk.includes("length"), false);
    // Fresh CLI process can recover outcomes without an OS store or license.
    const fresh = JSON.parse(run(["history", "--json"]).stdout);
    assert.equal(fresh.entries.length, 3);
    assert.equal(fresh.currentRemoteState, "not-inspected");
    assert.equal(fresh.diagnostic.issue, null);
    assert.equal(fresh.writeAccess, "not-tested");

    // Real metadata write failure: lock contention cannot overwrite an earlier
    // result or lose the pending attempt. No auto-repair of interrupted locks.
    mkdirSync(join(dir, "lock"));
    assert.equal(history.begin(input), null);
    assert.equal(history.writeIssue, "lock-present");
    assert.equal(history.finish(ids[2], "completed"), false);
    assert.equal(history.writeIssue, "lock-present");
    assert.equal(history.read().status, "unavailable");
    const locked = JSON.parse(run(["history", "--json"]).stdout);
    assert.deepEqual(locked.diagnostic, { phase: "inspect", issue: "lock-present", recovery: "wait-and-inspect" });
    assert.equal(readFileSync(file, "utf8"), disk);
    assert.ok(existsSync(join(dir, "lock")), "inspection/failed writes must not delete an existing lock");
    assert.match(renderHistoryDiagnostic(locked.diagnostic), /crash or stale lock is not established/);
    rmSync(join(dir, "lock"), { recursive: true });
    assert.equal(history.read().entries[2].outcome, "unknown");
    writeFileSync(join(dir, "history.tmp"), canary);
    assert.equal(history.finish(ids[2], "completed"), false);
    assert.equal(history.writeIssue, "temporary-file-present");
    assert.equal(history.read().issue, "temporary-file-present");
    assert.equal(readFileSync(join(dir, "history.tmp"), "utf8"), canary, "do not remove a pre-existing temporary file");
    assert.equal(readFileSync(file, "utf8"), disk);
    rmSync(join(dir, "history.tmp"));
    assert.equal(history.read().entries[2].outcome, "unknown");

    // Do not echo, silently repair, or write over arbitrary/corrupt records.
    for (const [corrupt, issue] of [["{", "invalid-data"], [JSON.stringify({ ...JSON.parse(disk), unknown: canary }), "invalid-data"],
      [disk.replace('"outcome":"completed"', `"outcome":"${canary}"`), "invalid-data"],
      [disk.replace(input.name, canary), "invalid-data"], [" ".repeat(256 * 1024 + 1), "too-large"],
      [JSON.stringify({ ...JSON.parse(disk), schemaVersion: 999 }), "unsupported-schema"]]) {
      writeFileSync(file, corrupt);
      assert.equal(history.read().status, "unavailable");
      assert.equal(history.begin(input), null);
      assert.equal(history.writeIssue, issue);
      const closed = JSON.parse(run(["history", "--json"]).stdout);
      assert.equal(closed.diagnostic.issue, issue);
      assert.deepEqual(closed.entries, []);
      assert.equal(readFileSync(file, "utf8"), corrupt, "failed start must preserve the existing journal");
    }
    writeFileSync(file, disk);
    if (process.platform !== "win32") {
      rmSync(file); symlinkSync(index, file);
      assert.equal(history.read().status, "unavailable");
      assert.equal(history.read().issue, "unsafe-path");
      assert.equal(history.begin(input), null);
      assert.equal(history.writeIssue, "unsafe-path");
      rmSync(file); writeFileSync(file, disk);
    }
    // Readability and writability are different observations. The report does
    // not create a test file or promise that a later start can be saved.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      chmodSync(dir, 0o500);
      try {
        assert.equal(history.read().status, "available");
        assert.equal(history.begin(input), null);
        assert.equal(history.writeIssue, "access-denied");
        const readable = JSON.parse(run(["history", "--json"]).stdout);
        assert.equal(readable.status, "available");
        assert.equal(readable.writeAccess, "not-tested");
      } finally { chmodSync(dir, 0o700); }
      chmodSync(file, 0o000);
      try {
        const denied = JSON.parse(run(["history", "--json"]).stdout);
        assert.equal(denied.status, "unavailable");
        assert.equal(denied.diagnostic.issue, "access-denied");
        assert.equal(history.begin(input), null);
        assert.equal(history.writeIssue, "access-denied");
      } finally { chmodSync(file, 0o600); }
    }
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries: [] }));
    const empty = JSON.parse(run(["history", "--json"]).stdout);
    assert.equal(empty.status, "available", "a valid empty journal is distinct from an absent file");
    assert.equal(empty.diagnostic.issue, null);
    assert.deepEqual(empty.entries, []);
    writeFileSync(file, disk);
    for (const [code, issue] of [["EACCES", "access-denied"], ["EPERM", "access-denied"],
      ["EROFS", "read-only-storage"], ["ENOSPC", "storage-full"], ["EDQUOT", "storage-full"],
      ["ENOENT", "path-unavailable"], ["ELOOP", "unsafe-path"], ["ENOTDIR", "unsafe-path"],
      ["EEXIST", "io-error"], [canary, "io-error"]]) {
      const raw = Object.assign(new Error(canary), { code, path: canary });
      const mapped = historyIssueFromError(raw);
      assert.equal(mapped, issue);
      const diagnostic = historyDiagnostic("start", mapped);
      assert.equal(renderHistoryDiagnostic(diagnostic).includes(canary), false);
      assert.deepEqual(Object.keys(diagnostic), ["phase", "issue", "recovery"]);
    }
    // Bounded retention preserves the latest interrupted attempt. Absence or
    // eviction is never transformed into a 'never deployed' assertion.
    for (let i = 0; i < 205; i++) assert.ok(history.begin(input));
    const retained = history.read().entries;
    assert.equal(retained.length, 200);
    assert.ok(retained.every((entry) => entry.outcome === "unknown"));
    assert.equal(history.finish(ids[0], "completed"), false);
    assert.deepEqual(readdirSync(dir), ["history.json"]);
    rmSync(dir, { recursive: true });
    assert.equal(history.read().status, "missing");
    assert.equal(otherHistory.read().entries.length, 1, "local history deletion does not clear other projects");
    const protocol = renderAgentProtocol("0.9.1");
    assert.match(protocol, /history --json/);
    assert.match(protocol, /history --json --offline/);
    assert.match(protocol, /published 0\.9\.2 does not include --offline/);
    assert.match(protocol, /destinationInspection=skipped-offline/);
    assert.match(protocol, /not current remote state or authority to skip approval/);
    assert.match(protocol, /Stop the group on history-save failure/);
    assert.match(protocol, /history schemaVersion 2/);
    assert.match(protocol, /start-phase history failure blocks this invocation before provider writes/);
    assert.match(protocol, /result-phase failure only concerns saving its result/);
    assert.match(protocol, /not a crash, stale lock or completed deployment/);
    assert.match(protocol, /Any metadata discard needs an explicit decision/);
    assert.match(protocol, /A provider failure, timeout, or unknown result does not justify a force retry/);
    assert.match(protocol, /never repeat the same force operation automatically/);
    assert.match(protocol, /A known Secret that is absent from list or next/);
  } finally { rmSync(root, { recursive: true, force: true }); }
  await runConnectionDeploymentHistoryTests();
}

async function runConnectionDeploymentHistoryTests() {
  // Preserve realpathSync's spelling, including Windows 8.3 paths. Metadata
  // and v2 refs must not switch identities after native physical resolution.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "akc-connection-history-")));
  try {
    const project = join(root, "project"), other = join(root, "other");
    const connectionHome = join(root, "connection-home");
    mkdirSync(project); mkdirSync(other); mkdirSync(connectionHome);
    const history = new DeploymentHistory(project, root);
    const ref = connectionCredentialRef(project, "preview");
    const legacyInput = { ...input, name: ref.name };
    const legacy = history.begin(legacyInput);
    assert.ok(legacy); assert.equal(history.finish(legacy, "completed"), true);
    const dir = journalDir(root, project), file = join(dir, "history.json");
    const legacyDisk = readFileSync(file, "utf8"), legacyReceipt = history.read().entries[0];
    assert.equal(JSON.parse(legacyDisk).schemaVersion, 1, "legacy-only writes retain the original journal schema");
    assert.equal(Object.hasOwn(legacyReceipt, "connection"), false);

    // This store contains only synthetic value-free metadata. No Vault,
    // provider executable, network request or real home directory is used.
    const store = new ConnectionStateStore(project, connectionHome);
    const register = (selectedRef) => {
      const mutation = store.beginCredentialMutation(selectedRef);
      assert.equal(mutation.ok, true);
      assert.equal(store.finishCredentialMutation(selectedRef, mutation.value, true), true);
      return mutation.value;
    };
    const revision = register(ref);
    const connectionInput = { ref, target: "vercel", destinationId, force: false,
      credentialRevision: revision, intentFingerprint: "c".repeat(64) };
    const id = history.beginConnection({ ...connectionInput, rawOutput: canary, value: canary,
      ref: { ...ref, value: canary } });
    assert.ok(id);
    const mixedDisk = readFileSync(file, "utf8"), mixed = JSON.parse(mixedDisk);
    assert.equal(mixed.schemaVersion, 2, "first v2 start explicitly upgrades the journal");
    assert.deepEqual(mixed.entries[0], legacyReceipt, "migration preserves the entire legacy receipt");
    const pending = mixed.entries[1];
    assert.equal(pending.id, id);
    assert.equal(pending.outcome, "unknown");
    assert.equal(pending.finishedAt, null, "start is durable before any handoff");
    assert.equal(pending.registrationUpdatedAt, null, "v2 does not reuse legacy registration metadata");
    assert.deepEqual(pending.connection, { credentialVersion: 2, service: "resend", environment: "preview",
      projectId: ref.projectId, credentialRevision: revision, intentFingerprint: connectionInput.intentFingerprint });
    assert.equal(mixedDisk.includes(canary), false, "both ref and outer extras are projected away");
    assert.equal(mixedDisk.includes(project), false);
    assert.deepEqual(new DeploymentHistory(project, root).read().entries, mixed.entries);
    assert.equal(readFileSync(file, "utf8"), mixedDisk, "inspection never migrates or mutates the journal");

    const options = { adapters: new Map(), baseDir: root, connectionBaseDir: connectionHome };
    const inspect = async () => (await buildHistoryReport(project, { ...options, offline: true,
      resolveDestination: async () => assert.fail("offline v2 inspection must not probe providers") })).entries.find((entry) => entry.id === id);
    assert.equal((await inspect()).localRegistration, "unverified");
    const index = join(root, ".api-key-case", "index.json");
    writeFileSync(index, JSON.stringify({ version: 1, entries: [{ name: ref.name, scope: ref.scope,
      projectId: ref.projectId, updatedAt: "2099-01-01T00:00:00.000Z" }] }));
    assert.equal((await inspect()).localRegistration, "unverified", "a v1 index change cannot update a v2 receipt");
    register(connectionCredentialRef(project, "production"));
    assert.equal((await inspect()).localRegistration, "unverified", "another v2 environment does not update this slot");
    const changedRevision = register(ref);
    assert.notEqual(changedRevision, revision);
    assert.equal((await inspect()).localRegistration, "update-recorded", "the exact v2 revision is compared");
    const noConnectionMetadata = await buildHistoryReport(project, { adapters: new Map(), baseDir: root });
    assert.equal(noConnectionMetadata.entries.find((entry) => entry.id === id).localRegistration, "unverified",
      "missing v2 metadata never falls back to a matching v1 index");
    const mutation = store.beginCredentialMutation(ref);
    assert.equal(mutation.ok, true);
    assert.equal((await inspect()).localRegistration, "unverified", "an in-progress registration is not a revision");
    assert.equal(store.finishCredentialMutation(ref, mutation.value, false), true);
    assert.equal((await inspect()).localRegistration, "unverified", "unsettled registration remains unknown");

    const extraPending = history.beginConnection({ ...connectionInput, intentFingerprint: "d".repeat(64), force: true });
    assert.ok(extraPending); assert.notEqual(extraPending, id);
    assert.equal(history.finish(extraPending, "unknown"), true);
    assert.equal(history.finish(extraPending, "completed"), false, "there is no receipt replay/rewrite");
    assert.equal(history.read().entries[2].connection.intentFingerprint, "d".repeat(64));
    const beforeResult = readFileSync(file, "utf8");
    mkdirSync(join(dir, "lock"));
    assert.equal(history.finish(id, "completed"), false);
    assert.equal(history.beginConnection(connectionInput), null);
    assert.equal(history.writeIssue, "lock-present");
    assert.equal(readFileSync(file, "utf8"), beforeResult);
    rmSync(join(dir, "lock"), { recursive: true });
    assert.equal(history.read().entries[1].outcome, "unknown", "failed result persistence retains the durable unknown");
    assert.equal(history.finish(id, "completed"), true);
    const validDisk = readFileSync(file, "utf8");

    for (const invalidInput of [
      { ...connectionInput, ref: { ...ref, projectId: deriveProjectId(other) } },
      { ...connectionInput, ref: { ...ref, scope: "user" } },
      { ...connectionInput, ref: { ...ref, service: "other" } },
      { ...connectionInput, ref: { ...ref, environment: "other" } },
      { ...connectionInput, ref: { name: ref.name, scope: ref.scope, projectId: ref.projectId } },
      { ...connectionInput, target: "other" },
      { ...connectionInput, credentialRevision: null },
      { ...connectionInput, intentFingerprint: canary }
    ]) {
      assert.equal(history.beginConnection(invalidInput), null);
      assert.equal(history.writeIssue, "invalid-data");
      assert.equal(readFileSync(file, "utf8"), validDisk, "invalid v2 starts cannot change retained history");
    }
    const invalidReceipts = [
      { ...pending, connection: { ...pending.connection, extra: canary } },
      { ...pending, connection: { ...pending.connection, credentialVersion: 1 } },
      { ...pending, connection: { ...pending.connection, service: "other" } },
      { ...pending, connection: { ...pending.connection, environment: "production" } },
      { ...pending, connection: { ...pending.connection, projectId: deriveProjectId(other) } },
      { ...pending, connection: { ...pending.connection, credentialRevision: null } },
      { ...pending, connection: { ...pending.connection, intentFingerprint: canary } },
      { ...pending, connection: null }, { ...pending, name: "OTHER_KEY" },
      { ...pending, scope: "user" }, { ...pending, target: "other" },
      { ...pending, registrationUpdatedAt: revision }, { ...pending, rawOutput: canary }
    ];
    for (const [journal, issue] of [
      ...[2,4].flatMap(schemaVersion=>invalidReceipts.map((receipt) => [{ schemaVersion, entries: [receipt] }, "invalid-data"])),
      [{ schemaVersion: 1, entries: [pending] }, "invalid-data"],
      [{ schemaVersion: 2, entries: [pending, pending] }, "invalid-data"],
      [{ schemaVersion: 2, entries: [pending], extra: canary }, "invalid-data"],
      [{ schemaVersion: 5, entries: [] }, "unsupported-schema"]
    ]) {
      const corrupt = JSON.stringify(journal);
      writeFileSync(file, corrupt);
      const report = await buildHistoryReport(project, options);
      assert.equal(report.diagnostic.issue, issue); assert.deepEqual(report.entries, []);
      assert.equal(JSON.stringify(report).includes(canary), false);
      assert.equal(history.beginConnection(connectionInput), null);
      assert.equal(history.begin(legacyInput), null);
      assert.equal(history.writeIssue, issue);
      assert.equal(readFileSync(file, "utf8"), corrupt, "neither writer overwrites invalid/unknown schemas");
    }
    writeFileSync(file,JSON.stringify({...JSON.parse(validDisk),schemaVersion:4}));
    assert.equal(history.read().status,'available','schema 4 retains compatible legacy/v2 entries');
    const retainedSchema4=history.beginConnection(connectionInput);
    assert.ok(retainedSchema4);assert.equal(history.finish(retainedSchema4,'unknown'),true);
    assert.equal(JSON.parse(readFileSync(file,'utf8')).schemaVersion,4,'compatible writes never downgrade schema 4');
    writeFileSync(file, validDisk);
    const cloudflare = history.beginConnection({ ...connectionInput, target: "cloudflare" });
    assert.ok(cloudflare, "the second allowed deployment provider retains the same v2 identity contract");
    assert.equal(history.finish(cloudflare, "incomplete"), true);
    {
      const previous = readFileSync(file, "utf8");
      const legacyGitHub = history.begin({ ...legacyInput, target: "github", env: ref.environment });
      const namedGitHub = history.beginConnection({ ...connectionInput, target: "github" });
      assert.ok(legacyGitHub && namedGitHub);
      let probes = 0;
      const report = await buildHistoryReport(project, {baseDir:root, adapters:new Map([["github", {id:"github"}]]),
        resolveDestination:async()=>{probes++;return {fingerprint:connectionInput.destinationId};}});
      assert.equal(probes,1,"only the compatible legacy GitHub receipt probes");
      assert.equal(report.entries.find(entry=>entry.id===namedGitHub).currentDestination,"unresolved");
      assert.equal(report.entries.find(entry=>entry.id===legacyGitHub).currentDestination,"selection-matches");
      writeFileSync(file,previous);
    }
    if (process.platform !== "win32") {
      const alias = join(root, "alias"); symlinkSync(project, alias, "dir");
      assert.equal(new DeploymentHistory(alias, root).read().entries.length, 4);
    }
    const otherHistory = new DeploymentHistory(other, root);
    assert.equal(otherHistory.beginConnection(connectionInput), null, "a v2 ref cannot cross project identity");
    assert.equal(otherHistory.read().status, "missing");
    for (let index = 0; index < 205; index++) assert.ok(history.beginConnection(connectionInput));
    assert.equal(history.read().entries.length, 200);
    assert.ok(history.read().entries.every((entry) => entry.connection && entry.outcome === "unknown"));
    assert.ok(Buffer.byteLength(readFileSync(file, "utf8")) <= 256 * 1024);
    assert.equal(history.finish(id, "completed"), false, "evicted v2 starts are never resurrected");
    for (let index = 0; index < 200; index++) assert.ok(history.begin(legacyInput));
    assert.ok(history.read().entries.every((entry) => !Object.hasOwn(entry, "connection")));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).schemaVersion, 2, "eviction never downgrades a migrated journal");
    assert.deepEqual(readdirSync(dir), ["history.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runDeploymentHistoryTests();
  console.log("Deployment history tests passed.");
}
