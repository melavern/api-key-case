// TEST ONLY: a real harmless app behind the existing disposable owner seam.
// This does not implement native suspension, Windows ownership, or real Resend.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { buildLocalNode } from '../tools/build-local-node.mjs';
import { readLocalApplicationStatus } from '../dist/core/local/session.js';

function applicationSource(port, output, expectedEnvironment) {
  // The endpoint is fixed into this synthetic artifact before approval. Node's
  // http client does not follow redirects and no caller URL/env override exists.
  return `import { payload } from './message';
const http = require('node:http');
const names: string[] = Object.keys(process.env).map(name => name.toLowerCase()).sort();
if (JSON.stringify(names) !== ${JSON.stringify(JSON.stringify(expectedEnvironment))} ||
    process.env.NODE_ENV !== 'development' || !process.env.RESEND_API_KEY || process.argv.length !== 2) process.exit(23);
// Deliberately hostile output is discarded by the synthetic owner, as app streams
// are in the native profile. These bytes must never become test/Agent output.
process.stdout.write(process.env.RESEND_API_KEY + ${JSON.stringify(output)});
process.stderr.write(process.env.RESEND_API_KEY + ${JSON.stringify(output)});
const request = http.request({ hostname: '127.0.0.1', port: ${port}, path: '/emails', method: 'POST',
  agent: false, headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' }
}, response => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', chunk => { body += chunk; if (body.length > 4096) request.destroy(); });
  response.on('error', () => { process.exitCode = 24; });
  response.on('end', () => {
    if (response.statusCode !== 200) { process.exitCode = 19; return; }
    try { process.exitCode = JSON.parse(body).id === 'synthetic-email-accepted' ? 0 : 25; }
    catch { process.exitCode = 25; }
  });
});
request.setTimeout(2000, () => request.destroy());
request.on('error', () => { process.exitCode = 24; });
request.end(JSON.stringify(payload));
`;
}

function childEnvironment(config, dir, secret) {
  // Never spread process.env. The extra Windows values prevent libuv from filling
  // its special environment names from the parent; no native-env acceptance claim.
  return {
    NODE_ENV: 'development', PATH: dirname(config.interpreterPath), RESEND_API_KEY: secret,
    ...(process.platform === 'win32' ? {
      SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', SYSTEMDRIVE: 'C:',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe', TEMP: dir, TMP: dir,
      PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: dir,
      HOMEDRIVE: dir.slice(0, 2), HOMEPATH: dir.slice(2),
      USERNAME: 'synthetic-user', USERDOMAIN: 'SYNTHETIC', LOGONSERVER: '\\\\SYNTHETIC',
    } : {}),
  };
}

function installApplicationOwner(f) {
  // This owner launches the harmless synthetic app, so retain the real Node runtime.
  f.useSyntheticRuntime = false;
  let child = null, childClosed = Promise.resolve(), secret = null, finish;
  f.childStarts = 0;
  f.childExit = null;
  f.ownerClosed = false;
  f.owner = config => {
    assert.equal(config.interpreterPath, realpathSync(process.execPath), 'synthetic app owner receives the real Node runtime');
    f.config = config;
    f.spawns++;
    const owner = new EventEmitter();
    owner.stdout = new PassThrough();
    owner.stderr = null;
    let closed = false, stopping = false, timer;
    const emit = line => { if (!closed) owner.stdout.write(line + '\n'); };
    finish = status => {
      if (closed) return;
      secret = null;
      clearTimeout(timer);
      emit(status);
      closed = true;
      f.ownerClosed = true;
      owner.stdout.end();
      owner.emit('close', 0);
    };
    const stop = async status => {
      if (closed || stopping) return;
      stopping = true;
      secret = null;
      if (child) child.kill('SIGKILL'); // Only the exact owned harmless child.
      await childClosed;
      finish(status);
    };
    owner.kill = () => { void stop('UNKNOWN'); return true; };
    owner.stdin = new Writable({ write(chunk, _encoding, callback) {
      const line = chunk.toString().trim();
      if (line === 'CANCEL') {
        void stop('CANCELLED');
      } else if (line === 'RELEASE') {
        f.releases++;
        assert.equal(f.childStarts, 0, 'one child at most per approved session');
        const env = childEnvironment(config, f.dir, secret);
        secret = null;
        const argv = [config.artifactPath];
        f.childStarts++;
        child = spawn(config.interpreterPath, argv, {
          cwd: config.projectDir, env, shell: false, detached: false,
          windowsHide: true, stdio: 'ignore',
        });
        assert.ok(child.stdin === null && child.stdout === null && child.stderr === null,
          'application streams must be discarded');
        childClosed = new Promise(resolve => {
          child.once('error', () => {}); // No raw platform/child errors escape.
          child.once('close', (code, signal) => {
            f.childExit = code;
            f.childSignal = signal;
            child = null;
            resolve();
            if (!stopping) finish(code === 0 ? 'EXITED' : 'FAILED');
          });
        });
        child.once('spawn', () => {
          emit('STARTED');
          timer = setTimeout(() => { void stop('EXPIRED'); }, config.maxDurationMs);
        });
      } else {
        const value = JSON.parse(line);
        assert.ok(Object.keys(value).join() === 'secret' && typeof value.secret === 'string',
          'only the closed private secret message is accepted');
        secret = value.secret;
        f.secretMessages++;
        assert.equal(f.childStarts, 0, 'the app must not execute before RELEASE');
        f.onSecret?.();
        // This is protocol simulation only. No suspended native child is created.
        queueMicrotask(() => emit('CREATED'));
      }
      callback();
    } });
    queueMicrotask(() => emit('READY'));
    return owner;
  };
  return async () => {
    secret = null;
    if (child) child.kill('SIGKILL');
    await childClosed;
    if (finish && !f.ownerClosed) finish('UNKNOWN');
    assert.equal(child, null, 'owned application must be closed before cleanup');
  };
}

function assertNoSecretFiles(root, secret) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) assertNoSecretFiles(path, secret);
    else if (entry.isFile()) assert.ok(!readFileSync(path).includes(secret), 'no synthetic key in fixture files');
  }
}

export async function runSyntheticApplicationFeatureTests(fixture, secret, output) {
  assert.ok(process.argv.includes('--synthetic-fixture'), 'feature owner only runs in disposable compiled fixture');
  let checks = 0;
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const parentCanaryName = 'AKC_PARENT_TEST_TOKEN';
  assert.equal(Object.hasOwn(process.env, parentCanaryName), false);
  process.env[parentCanaryName] = 'synthetic-inherited-credential';
  process.env.NODE_OPTIONS = '--require=synthetic-parent-preload-must-not-run';
  try {
    for (const mode of ['success', 'provider-failure', 'refused', 'changed-source', 'changed-revision', 'interrupted']) {
      const f = await fixture();
      f.request.maxDurationMs = 5000;
      const counts = { requests: 0, valid: 0 };
      const sockets = new Set();
      const server = createServer((request, response) => {
        counts.requests++;
        const authenticated = request.headers.authorization === `Bearer ${secret}`;
        const route = request.method === 'POST' && request.url === '/emails';
        let body = '', oversized = false;
        request.setEncoding('utf8');
        request.on('error', () => {});
        request.on('data', chunk => {
          if (body.length + chunk.length > 4096) { oversized = true; request.destroy(); }
          else body += chunk;
        });
        request.on('end', () => {
          let valid = false;
          try {
            const value = JSON.parse(body);
            valid = !oversized && authenticated && route &&
              JSON.stringify(value) === JSON.stringify({ from: 'sender@example.invalid', to: ['recipient@example.invalid'],
                subject: 'Synthetic feature check', text: 'No email is sent.' });
          } catch { /* Keep request/header/body bytes out of errors and logs. */ }
          body = '';
          if (valid) counts.valid++;
          response.writeHead(mode === 'provider-failure' ? 503 : valid ? 200 : 400, {
            'content-type': 'application/json', connection: 'close',
          });
          response.end(JSON.stringify(mode === 'provider-failure'
            ? { error: secret + output } : { id: 'synthetic-email-accepted' }));
        });
      });
      server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => {});
      });
      const disposeOwner = installApplicationOwner(f);
      try {
        await new Promise((resolve, reject) => {
          server.once('error', () => reject(new Error('Synthetic loopback provider unavailable.')));
          server.listen(0, '127.0.0.1', resolve);
        });
        const expectedEnvironment = Object.keys(childEnvironment({ interpreterPath: process.execPath }, f.dir, ''))
          .map(name => name.toLowerCase()).sort();
        const source = applicationSource(server.address().port, output, expectedEnvironment);
        writeFileSync(f.source, source);
        const originalArtifact = f.artifact, originalBytes = readFileSync(originalArtifact);
        const message = join(f.project, 'src', 'message.ts');
        writeFileSync(message, `type Mail = { from: string; to: string[]; subject: string; text: string };
export const payload: Mail = { from: 'sender@example.invalid', to: ['recipient@example.invalid'],
subject: 'Synthetic feature check', text: 'No email is sent.' };`);
        const built = await buildLocalNode(f.project, 'src/app.ts');
        assert.equal(built.status, 'built');
        assert.equal(built.permission, 'none');
        f.request.artifact = built.artifact;
        f.artifact = join(f.project, built.artifact);
        assert.deepEqual(readFileSync(originalArtifact), originalBytes, 'build preserves previous artifact');
        // Mutate an imported TS module, proving the ordinary multi-file app stays in the snapshot change set.
        f.edit = () => writeFileSync(message, 'export const payload = {};');
        let priorReceipt = null, interruptedArtifact = null;
        if (mode === 'interrupted') {
          assert.equal(f.store.beginLocalSession(f.store.credentialRevision(f.ref), 5000).ok, true);
          priorReceipt = readFileSync(join(f.metadata, 'local-session.json'), 'utf8');
          interruptedArtifact = { path: f.artifact, bytes: readFileSync(f.artifact) };
          const rebuilt = await buildLocalNode(f.project, 'src/app.ts');
          assert.equal(rebuilt.status, 'built');
          f.request.artifact = rebuilt.artifact; f.artifact = join(f.project, rebuilt.artifact);
        }
        if (mode === 'refused') f.decision = 'declined';
        if (mode === 'changed-source') f.onSecret = f.edit;
        if (mode === 'changed-revision') f.onSecret = f.rotate;
        const approvedRevision = f.store.credentialRevision(f.ref);
        const result = await f.run();
        const executed = mode === 'success' || mode === 'provider-failure';
        assert.equal(result.status, mode === 'success' ? 'exited' : mode === 'provider-failure' ? 'failed'
          : mode === 'refused' ? 'declined' : mode === 'interrupted' ? 'recovery-required' : 'changed');
        assert.equal(f.childStarts, executed ? 1 : 0);
        assert.equal(f.releases, executed ? 1 : 0);
        assert.equal(counts.requests, executed ? 1 : 0, 'exactly one bounded operation, or none after invalidation');
        assert.equal(counts.valid, executed ? 1 : 0, 'app must use the exact Resend development credential and payload');
        assert.equal(f.childExit, mode === 'success' ? 0 : mode === 'provider-failure' ? 19 : null);
        assert.equal(f.approvals, mode === 'interrupted' ? 0 : 1);
        if (mode !== 'interrupted') {
          assert.equal(f.approval.projectDir, f.project);
          assert.equal(f.approval.service, 'resend');
          assert.equal(f.approval.environment, 'development');
          assert.equal(f.approval.credentialRevision, approvedRevision);
          assert.equal(f.approval.artifactPath, f.artifact);
          assert.equal(f.approval.interpreterPath, realpathSync(process.execPath));
        }
        assert.equal(result.applicationReadiness, 'not-verified');
        assert.equal(result.permission, 'none');
        if (mode === 'interrupted') {
          assert.equal(f.reads + f.spawns + f.secretMessages, 0);
          assert.equal(f.store.localSessionLockStatus(), 'present');
          assert.equal(readFileSync(join(f.metadata, 'local-session.json'), 'utf8'), priorReceipt);
          assert.deepEqual(readFileSync(interruptedArtifact.path), interruptedArtifact.bytes);
          assert.equal(readLocalApplicationStatus(f.project, f.home).retry, 'owner-review-required');
        } else if (mode === 'refused') {
          assert.equal(f.reads + f.spawns + f.secretMessages, 0);
          assert.equal(readLocalApplicationStatus(f.project, f.home).status, 'not-started');
        } else {
          assert.equal(f.reads, 1);
          assert.equal(f.secretMessages, 1);
          assert.equal(f.ownerClosed, true);
          assert.equal(result.treeTermination, 'confirmed', 'synthetic owner confirmation only');
          assert.equal(result.receiptSaved, true);
          assert.equal(f.store.localSessionLockStatus(), 'absent');
          const receipt = readLocalApplicationStatus(f.project, f.home);
          assert.equal(receipt.status, result.status);
          assert.equal(receipt.applicationReadiness, 'not-verified');
          assert.equal(receipt.permission, 'none');
          const disk = readFileSync(join(f.metadata, 'local-session.json'), 'utf8');
          for (const forbidden of [secret, output, f.source, f.artifact, f.config.artifactSha256, f.config.interpreterSha256]) {
            assert.ok(!disk.includes(forbidden), 'receipt must not retain private app/provider bytes');
          }
        }
        assertNoSecretFiles(f.dir, secret);
        checks++;
      } finally {
        await disposeOwner();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        assert.equal(server.listening, false);
      }
    }
  } finally {
    delete process.env[parentCanaryName];
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
  }
  console.log(`Local application loopback feature checks: ${checks} passed; synthetic owner only, native and real-provider execution are not exercised by this suite.`);
}
