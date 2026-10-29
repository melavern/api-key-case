/**
 * Secret-free, test-only reparse rejection probes for the fixed local owner.
 * Windows: real directory junctions; other hosts: snapshot-only directory-link
 * smoke, explicitly not Windows evidence. No keyring, verifier, provider or app
 * launch: the only post-config helper input this file can send is CANCEL.
 */
import test from 'node:test';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { LocalLaunchSnapshot } from '../dist/core/local/snapshot.js';
import { spawnWindowsLocalOwner } from '../dist/core/local/windows-owner.js';
import { resolveWindowsHelperScratch } from '../dist/core/human/windows.js';

const windows = process.platform === 'win32';
const cases = ['project', 'artifact-ancestor', 'interpreter-ancestor'];
const statuses = new Set(['READY', 'CREATED', 'STARTED', 'EXITED', 'FAILED', 'CANCELLED', 'EXPIRED', 'PARENT_LOST', 'UNKNOWN']);
const app = "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'unexpected-start'), 'started');\n";

// Never surface raw filesystem/helper errors, input paths, config or digests.
class ProbeFailure extends Error {}
function check(condition, code) { if (!condition) throw new ProbeFailure(code); }
function closedError(error, fallback) {
  return error instanceof ProbeFailure ? error : new ProbeFailure(fallback);
}
function identity(path) {
  const info = lstatSync(path);
  return `${info.dev}:${info.ino}`;
}
function beneath(root, path) {
  const rel = relative(root, path);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

function fixture() {
  const scratch = windows ? resolveWindowsHelperScratch()?.root : tmpdir();
  check(scratch, 'FIXTURE_ROOT_UNAVAILABLE');
  const root = realpathSync(mkdtempSync(join(realpathSync(scratch), 'akc-reparse-')));
  const owned = { root, rootIdentity: identity(root), links: [], helpers: new Set() };
  try {
    const project = join(root, 'project'), runtimeDir = join(root, 'runtime');
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(join(project, 'dist')); mkdirSync(runtimeDir);
    const runtime = join(runtimeDir, windows ? 'node.exe' : 'node');
    copyFileSync(process.execPath, runtime);
    writeFileSync(join(project, 'src', 'app.ts'), '// Harmless generated build input.\n');
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(join(project, 'package-lock.json'), '{}');
    writeFileSync(join(project, 'dist', 'app.cjs'), app);
    return { ...owned, project, runtimeDir, runtime,
      capture: () => new LocalLaunchSnapshot(project, 'dist/app.cjs', runtime),
      marker: join(project, 'dist', 'unexpected-start') };
  } catch {
    cleanup(owned);
    throw new ProbeFailure('FIXTURE_SETUP_UNVERIFIED');
  }
}

function replaceWithLink(f, name) {
  const link = name === 'project' ? f.project : name === 'artifact-ancestor' ? join(f.project, 'dist') : f.runtimeDir;
  const target = `${link}-original`;
  check(beneath(f.root, link) && beneath(f.root, target), 'FIXTURE_NOT_OWNED');
  renameSync(link, target);
  // On Windows this requests an IO_REPARSE_TAG_MOUNT_POINT directory junction.
  // Linux smoke uses a directory symlink and is never counted as that evidence.
  try { symlinkSync(target, link, windows ? 'junction' : 'dir'); }
  catch { throw new ProbeFailure('LINK_CREATION_UNVERIFIED'); }
  const entry = { link, target, identity: identity(link) };
  f.links.push(entry);
  const info = lstatSync(link);
  check(info.isSymbolicLink() && !info.isDirectory(), 'LINK_TYPE_UNVERIFIED');
  check(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink(), 'TARGET_TYPE_UNVERIFIED');
  check(realpathSync(link) === realpathSync(target), 'LINK_TARGET_UNVERIFIED');
}

function cleanup(f) {
  check(f.helpers.size === 0, 'HELPER_CLOSURE_UNVERIFIED');
  check(!lstatSync(f.root).isSymbolicLink() && identity(f.root) === f.rootIdentity, 'CLEANUP_ROOT_CHANGED');
  for (const entry of [...f.links].reverse()) {
    check(beneath(f.root, entry.link) && lstatSync(entry.link).isSymbolicLink() && identity(entry.link) === entry.identity,
      'CLEANUP_LINK_CHANGED');
    // Remove only the exact owned junction, never recursively through its target.
    try { unlinkSync(entry.link); }
    catch {
      check(windows && lstatSync(entry.link).isSymbolicLink() && identity(entry.link) === entry.identity,
        'CLEANUP_LINK_UNVERIFIED');
      rmdirSync(entry.link);
    }
    check(!existsSync(entry.link) && lstatSync(entry.target).isDirectory(), 'CLEANUP_TARGET_UNVERIFIED');
  }
  const noLinks = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), info = lstatSync(path);
      check(!info.isSymbolicLink(), 'CLEANUP_UNEXPECTED_LINK');
      if (info.isDirectory()) noLinks(path);
    }
  };
  noLinks(f.root);
  rmSync(f.root, { recursive: true });
  check(!existsSync(f.root), 'CLEANUP_INCOMPLETE');
}

function owner(f, config) {
  const child = spawnWindowsLocalOwner(config);
  f.helpers.add(child);
  let output = '', bytes = 0, ended = false, failed = false, exitCode, signal;
  const all = [], pending = [];
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 128 || [...chunk].some(byte => byte !== 10 && (byte < 65 || byte > 90) && byte !== 95)) {
      failed = true; return;
    }
    output += chunk.toString('ascii');
    while (output.includes('\n')) {
      const at = output.indexOf('\n'), token = output.slice(0, at); output = output.slice(at + 1);
      if (!statuses.has(token)) { failed = true; return; }
      all.push(token); pending.push(token);
    }
  });
  child.on('error', () => { failed = true; });
  child.stdin.on('error', () => {});
  child.once('close', (code, stoppedBy) => {
    ended = true; exitCode = code; signal = stoppedBy; f.helpers.delete(child);
  });
  async function until(probe) {
    const deadline = Date.now() + 30000;
    while (!probe()) {
      check(Date.now() < deadline, 'HELPER_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  return {
    async next() {
      await until(() => failed || pending.length || ended);
      check(!failed && pending.length > 0, 'HELPER_PROTOCOL_UNVERIFIED');
      return pending.shift();
    },
    cancel() { if (!ended) child.stdin.end('CANCEL\n'); },
    async closed(expected) {
      await until(() => ended);
      check(!failed && output === '' && exitCode === 0 && signal === null, 'HELPER_CLOSURE_UNVERIFIED');
      check(all.join(',') === expected.join(','), 'HELPER_STATUS_MISMATCH');
    },
    async dispose() {
      if (ended) return;
      child.stdin.end('CANCEL\n');
      try { await until(() => ended); }
      catch {
        // Only this exact owned helper may be stopped; no process-name cleanup.
        child.kill(); await until(() => ended);
        throw new ProbeFailure('HELPER_FORCED_STOP_UNVERIFIED');
      }
    },
  };
}

async function nativeCheck(f, config, positive) {
  const helper = owner(f, config);
  try {
    check(await helper.next() === (positive ? 'READY' : 'UNKNOWN'), 'HELPER_STATUS_MISMATCH');
    if (positive) helper.cancel();
    await helper.closed(positive ? ['READY', 'CANCELLED'] : ['UNKNOWN']);
    check(!existsSync(f.marker), 'APPLICATION_EXECUTED');
  } finally { await helper.dispose(); }
}

async function rejectionCase(name, native) {
  let f;
  try {
    f = fixture();
    const snapshot = f.capture(), config = snapshot.ownerConfig(20000);
    check(snapshot.current() && snapshot.currentWithNativeLocks(), 'SNAPSHOT_CONTROL_FAILED');
    // Same valid bytes/config before introducing the one link under test.
    if (native) await nativeCheck(f, config, true);
    replaceWithLink(f, name);
    check(snapshot.current() === false, 'SNAPSHOT_REPLACEMENT_ACCEPTED');
    check(snapshot.currentWithNativeLocks() === false, 'SNAPSHOT_LOCKED_REPLACEMENT_ACCEPTED');
    let rejected = false;
    try { f.capture(); } catch { rejected = true; }
    check(rejected, 'SNAPSHOT_INITIAL_LINK_ACCEPTED');
    if (native) await nativeCheck(f, config, false);
    check(!existsSync(f.marker), 'APPLICATION_EXECUTED');
  } catch (error) { throw closedError(error, 'REPARSE_PROBE_UNVERIFIED'); }
  finally {
    if (f) {
      try { cleanup(f); }
      catch (error) { throw closedError(error, 'CLEANUP_UNVERIFIED'); }
    }
  }
}

for (const name of cases) {
  test(`Windows junction ${name}: snapshot rejects; native READY/CANCEL control then UNKNOWN before READY`,
    { skip: windows ? false : 'UNVERIFIED: requires actual Windows junction/native helper' },
    () => rejectionCase(name, true));
  test(`Portable directory-link ${name}: snapshot smoke only, not Windows reparse acceptance`,
    { skip: windows ? 'Portable-only smoke; actual Windows case runs above' : false },
    () => rejectionCase(name, false));
}
