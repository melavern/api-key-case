// Snapshot-only synthetic files: no vault, native owner, application or provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { LocalLaunchSnapshot } from '../dist/core/local/snapshot.js';

const CHUNK = 64 * 1024;
const original = Object.fromEntries(['openSync', 'closeSync', 'readSync', 'lstatSync', 'fstatSync'].map(name => [name, fs[name]]));
const allocate = Buffer.alloc;
let cases = 0;
function fixture(root, bytes = CHUNK * 2 + 17) {
  const dir = join(root, `fixture-${++cases}`), project = join(dir, 'project');
  fs.mkdirSync(join(project, 'src'), { recursive: true });
  fs.mkdirSync(join(project, 'dist'));
  const files = { source: join(project, 'src', 'app.ts'), artifact: join(project, 'dist', 'app.cjs'),
    runtime: join(dir, process.platform === 'win32' ? 'node.exe' : 'node') };
  const data = allocate(bytes);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 255;
  for (const path of Object.values(files)) fs.writeFileSync(path, data);
  fs.writeFileSync(join(project, 'package.json'), '{}');
  fs.writeFileSync(join(project, 'package-lock.json'), '{}');
  return { project, ...files, snapshot: () => new LocalLaunchSnapshot(project, 'dist/app.cjs', files.runtime) };
}
function intercept(callback, options = {}) {
  const descriptors = new Map(), buffers = new Set(), reads = [];
  let allocations = 0, maximumAllocation = 0, opened = 0, closed = 0;
  fs.openSync = (...args) => {
    const fd = original.openSync(...args); descriptors.set(fd, args[0]); opened++; return fd;
  };
  fs.closeSync = fd => { closed++; descriptors.delete(fd); return original.closeSync(fd); };
  fs.readSync = (fd, buffer, offset, length, position) => {
    assert.ok(buffer.length <= CHUNK && length <= CHUNK, 'file reads must be fixed-size');
    buffers.add(buffer); const path = descriptors.get(fd);
    reads.push({ path, position, length });
    if (options.read) return options.read({ fd, buffer, offset, length, position, path });
    return original.readSync(fd, buffer, offset, length, position);
  };
  if (options.lstat) fs.lstatSync = options.lstat;
  if (options.fstat) fs.fstatSync = options.fstat;
  Buffer.alloc = (size, ...rest) => {
    allocations++; maximumAllocation = Math.max(size, maximumAllocation);
    assert.ok(size <= CHUNK, 'snapshot must not allocate complete file buffers');
    return allocate(size, ...rest);
  };
  syncBuiltinESMExports();
  let value;
  try { value = callback(); }
  finally {
    Object.assign(fs, original); Buffer.alloc = allocate; syncBuiltinESMExports();
    assert.equal(opened, closed, 'all snapshot descriptors close even on failure');
  }
  return { value, reads, buffers: buffers.size, allocations, maximumAllocation };
}
function sameMetadata(path, snapshot) {
  const before = original.lstatSync(path);
  const restore = stat => stat.ino === before.ino && stat.dev === before.dev ? before : stat;
  return intercept(snapshot, { lstat: (...args) => restore(original.lstatSync(...args)),
    fstat: (...args) => restore(original.fstatSync(...args)), read: ({ fd, buffer, offset, length, position, path: actual }) => {
      const n = original.readSync(fd, buffer, offset, length, position);
      // Deterministically change one byte in a later chunk without changing any
      // filesystem metadata. Only the content comparison can detect this.
      if (actual === path && position <= CHUNK + 3 && position + n > CHUNK + 3) buffer[offset + CHUNK + 3 - position] ^= 1;
      return n;
    } });
}

export function runLocalSnapshotTests() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'akc-snapshot-')));
  let checks = 0;
  const unverified = [];
  const check = condition => { assert.ok(condition); checks++; };
  try {
    for (const size of [1, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 2 + 17]) {
      const f = fixture(root, size), captured = intercept(f.snapshot), snapshot = captured.value;
      check(captured.buffers === 1 && captured.allocations === 1 && captured.maximumAllocation === CHUNK);
      const config = snapshot.ownerConfig(1000);
      for (const [path, digest] of [[f.artifact, config.artifactSha256], [f.runtime, config.interpreterSha256]]) {
        check(createHash('sha256').update(fs.readFileSync(path)).digest('hex') === digest);
        check(captured.reads.some(read => read.path === path && read.position === size && read.length === 1));
      }
      const checked = intercept(() => snapshot.current());
      check(checked.value && checked.buffers === 1 && checked.allocations === 1);
      check(checked.reads.some(read => read.path === f.runtime && read.position === size));
      const locked = intercept(() => snapshot.currentWithNativeLocks());
      check(locked.value && locked.reads.every(read => ![f.artifact, f.runtime].includes(read.path)));
      check(locked.reads.some(read => read.path === f.source));
      check(!JSON.stringify(snapshot).includes(config.artifactSha256) && !JSON.stringify(snapshot).includes(config.interpreterSha256));
      const partial = intercept(f.snapshot, { read: ({ fd, buffer, offset, length, position }) => original.readSync(fd, buffer, offset, Math.min(length, 997), position) });
      check(partial.value.current());
      check(partial.value.ownerConfig(1000).artifactSha256 === config.artifactSha256);
    }
    {
      const f = fixture(root); fs.truncateSync(f.source, 0);
      const snapshot = intercept(f.snapshot).value;
      check(snapshot.current());
      fs.appendFileSync(f.source, 'synthetic'); check(snapshot.current() === false);
    }
    for (const target of ['source', 'artifact', 'runtime']) {
      const f = fixture(root), snapshot = f.snapshot();
      check(sameMetadata(f[target], () => snapshot.current()).value === false);
      if (target === 'source') check(sameMetadata(f.source, () => snapshot.currentWithNativeLocks()).value === false);
      fs.writeFileSync(f[target], allocate(CHUNK * 2 + 17, 9));
      check(snapshot.current() === false);
      check(snapshot.currentWithNativeLocks() === false);
    }
    for (const fault of ['growth', 'shrink', 'edit', 'read-error', 'opened-identity', 'path-identity']) {
      const f = fixture(root), snapshot = f.snapshot(); let changed = false;
      const options = { read: ({ fd, buffer, offset, length, position, path }) => {
        if (path === f.source && !changed) {
          changed = true;
          if (fault === 'growth') fs.appendFileSync(path, 'x');
          if (fault === 'shrink') fs.truncateSync(path, 3);
          if (fault === 'edit') fs.writeFileSync(path, allocate(CHUNK * 2 + 17, 8));
          if (fault === 'read-error') throw new Error('synthetic read failure');
        }
        return original.readSync(fd, buffer, offset, length, position);
      } };
      if (fault === 'opened-identity') options.fstat = (...args) => { const s = original.fstatSync(...args); s.mtimeMs++; return s; };
      if (fault === 'path-identity') options.lstat = (...args) => { const s = original.lstatSync(...args); if (changed && args[0] === f.source) s.mtimeMs++; return s; };
      check(intercept(() => snapshot.current(), options).value === false);
    }
    for (const change of ['add', 'remove', 'symlink', 'hardlink', 'empty-artifact', 'source-limit', 'artifact-limit', 'runtime-limit', 'total-limit']) {
      const f = fixture(root), snapshot = f.snapshot();
      if (change === 'add') fs.writeFileSync(join(f.project, 'src', 'new.ts'), 'synthetic');
      if (change === 'remove') fs.unlinkSync(f.source);
      if (change === 'symlink') {
        fs.renameSync(f.source, f.source + '.original');
        try { fs.symlinkSync(f.source + '.original', f.source); }
        catch (error) {
          if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
          unverified.push('source symlink rejection after capture and on recapture: Windows file-symlink creation returned EPERM');
          continue;
        }
      }
      if (change === 'hardlink') fs.linkSync(f.source, join(root, `linked-${cases}`));
      if (change === 'empty-artifact') fs.truncateSync(f.artifact, 0);
      if (change === 'source-limit') fs.truncateSync(f.source, 2 * 1024 * 1024 + 1);
      if (change === 'artifact-limit') fs.truncateSync(f.artifact, 16 * 1024 * 1024 + 1);
      if (change === 'runtime-limit') fs.truncateSync(f.runtime, 128 * 1024 * 1024 + 1);
      if (change === 'total-limit') for (let i = 0; i < 8; i++) {
        const file = join(f.project, 'src', `extra-${i}.ts`); fs.writeFileSync(file, ''); fs.truncateSync(file, 2 * 1024 * 1024);
      }
      check(snapshot.current() === false);
      if (!['add', 'remove'].includes(change)) { assert.throws(f.snapshot); checks++; }
    }
    // Enumeration changed after capture, including an input with no content.
    const f = fixture(root); let added = false;
    assert.throws(() => intercept(f.snapshot, { read: ({ fd, buffer, offset, length, position, path }) => {
      if (path === f.source && !added) { added = true; fs.writeFileSync(join(f.project, 'src', 'late.ts'), ''); }
      return original.readSync(fd, buffer, offset, length, position);
    } })); checks++;
    for (const reason of unverified) console.log(`SKIP (unverified): ${reason}`);
    console.log(`Local snapshot checks: ${checks} passed; ${unverified.length} skipped (unverified).`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Optional, separate process measurement. Uses only generated synthetic files;
// prints counts, bytes, RSS and equivalence booleans, never content or digests.
async function measureChild(moduleUrl) {
  const Snapshot = moduleUrl ? (await import(moduleUrl)).LocalLaunchSnapshot : LocalLaunchSnapshot;
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'akc-snapshot-memory-')));
  try {
    const f = fixture(root, 1), chunk = allocate(CHUNK, 7);
    const sizes = { source: 2 * 1024 * 1024, artifact: 16 * 1024 * 1024, runtime: 64 * 1024 * 1024 };
    const expected = {};
    for (const [name, size] of Object.entries(sizes)) {
      const fd = fs.openSync(f[name], 'w'), hash = createHash('sha256');
      try { for (let count = 0; count < size; count += chunk.length) { fs.writeSync(fd, chunk); hash.update(chunk); } }
      finally { fs.closeSync(fd); }
      expected[name] = hash.digest('hex');
    }
    global.gc(); const before = process.memoryUsage();
    const snapshot = new Snapshot(f.project, 'dist/app.cjs', f.runtime);
    global.gc(); const retained = process.memoryUsage();
    const current = snapshot.current(), config = snapshot.ownerConfig(1000);
    const equivalence = config.artifactSha256 === expected.artifact && config.interpreterSha256 === expected.runtime;
    global.gc(); const after = process.memoryUsage();
    console.log(JSON.stringify({ fixtureBytes: Object.values(sizes).reduce((a, b) => a + b, 4), current, equivalence,
      retainedArrayBufferDelta: retained.arrayBuffers - before.arrayBuffers,
      retainedRssDelta: retained.rss - before.rss, afterCheckArrayBufferDelta: after.arrayBuffers - before.arrayBuffers,
      afterCheckRssDelta: after.rss - before.rss, maxRssBytes: process.resourceUsage().maxRSS * 1024 }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--measure-child')) await measureChild(process.argv[3]);
  else if (process.argv.includes('--measure')) {
    const result = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--measure-child', ...process.argv.slice(3)], { encoding: 'utf8', timeout: 30000, maxBuffer: 4096 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, 'synthetic measurement must finish');
    const measurement = JSON.parse(result.stdout); assert.ok(measurement.current && measurement.equivalence);
    console.log(JSON.stringify(measurement));
  } else runLocalSnapshotTests();
}
