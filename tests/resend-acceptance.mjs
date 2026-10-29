import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { prepareResendAcceptance, readResendAcceptance } from '../tools/prepare-resend-acceptance.mjs';
import { LocalLaunchSnapshot } from '../dist/core/local/snapshot.js';

export async function runResendAcceptanceTests() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'akc-named-acceptance-')));
  const key = 're_synthetic_acceptance_canary_742';
  let number = 0, checks = 0;
  function fixture(mode = 'live') {
    const project = join(root, `app-${++number}`);
    const result = prepareResendAcceptance(project, mode === 'live' ? { mode, from: 'sender@example.com', to: 'recipient@example.com' } : {});
    assert.equal(result.permission, 'none');
    const plan = JSON.parse(fs.readFileSync(join(project, 'acceptance-plan.json'), 'utf8'));
    return { project, plan, artifact: join(project, 'dist', 'app.cjs'), directory: join(project, 'acceptance-results', plan.id) };
  }
  async function execute(f, options = {}) {
    const seen = { requests: 0, keyReads: 0, logs: [], syncs: 0 };
    const environment = new Proxy(options.key === null ? {} : { RESEND_API_KEY: options.key ?? key }, {
      get(target, property) { if (property === 'RESEND_API_KEY') seen.keyReads++; return target[property]; }
    });
    const processStub = { argv: [process.execPath, f.artifact, ...(options.extraArg ? ['unexpected'] : [])], env: environment, exitCode: 0 };
    const resultFds = new Set();
    const fakeFs = { ...fs,
      fsyncSync(fd) { seen.syncs++; if (options.diskFailure || (options.resultSyncFailure && resultFds.has(fd))) throw new Error(key); return fs.fsyncSync(fd); },
      openSync(path, flags, mode) {
        const result = String(path).endsWith('result.pending.json');
        if (options.resultFailure && result) throw new Error(key);
        const fd = fs.openSync(path, flags, mode); if (result) resultFds.add(fd); return fd;
      },
      closeSync(fd) { const result = resultFds.delete(fd); fs.closeSync(fd); if (options.resultCloseFailure && result) throw new Error(key); },
      linkSync(from, to) { if (options.resultLinkFailure) throw new Error(key); fs.linkSync(from, to); },
      unlinkSync(file) { if (options.resultUnlinkFailure) throw new Error(key); fs.unlinkSync(file); }
    };
    const https = { request(configuration, responseCallback) {
      seen.requests++;
      assert.ok(seen.syncs > 0, 'durable unknown must precede transport');
      assert.equal(JSON.parse(fs.readFileSync(join(f.directory, 'attempt.json'), 'utf8')).outcome, 'unknown');
      assert.equal(configuration.hostname, 'api.resend.com');assert.equal(configuration.servername, 'api.resend.com');
      assert.equal(configuration.port, 443);assert.equal(configuration.path, '/emails');assert.equal(configuration.method, 'POST');
      assert.equal(configuration.agent, false);assert.equal(configuration.rejectUnauthorized, true);
      assert.equal(configuration.headers.authorization, 'Bearer ' + key);
      assert.equal(configuration.headers['idempotency-key'], 'akc-resend-acceptance/' + f.plan.id);
      const request = new EventEmitter();request.destroy = () => {};
      request.end = body => {
        assert.deepEqual(JSON.parse(body), { from: f.plan.from, to: [f.plan.to], subject: f.plan.subject, text: f.plan.text });
        if (options.timeout) return;
        queueMicrotask(() => {
          if (options.transportError) { request.emit('error', new Error(key)); return; }
          const response = new EventEmitter();response.statusCode = options.status ?? 200;response.destroy = () => {};
          response.headers = { location: 'https://unapproved.example.invalid/' };
          responseCallback(response);
          response.emit('data', Buffer.from(options.body ?? '{"id":"synthetic-email-id"}'));
          response.emit('end');response.emit('close');request.emit('close');
        });
      };
      return request;
    } };
    class TestDate extends Date { static now() { return Date.now() + (options.clockOffset ?? 0); } }
    const context = { require(name) {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:https') return https;
      if (name === 'node:path') return { join, dirname };
      throw new Error('Unexpected dependency');
    }, __dirname: options.wrongDirectory ?? dirname(f.artifact), process: processStub, Buffer, Date: TestDate,
      console: { log: (...args) => seen.logs.push(args), error: (...args) => seen.logs.push(args) },
      setTimeout(callback) { if (options.timeout) queueMicrotask(callback); return 1; }, clearTimeout() {} };
    await vm.runInNewContext(fs.readFileSync(f.artifact, 'utf8'), context);
    assert.deepEqual(seen.logs, [], 'no application diagnostics or response bytes');
    for (const name of fs.readdirSync(f.directory)) assert.ok(!fs.readFileSync(join(f.directory, name), 'utf8').includes(key));
    assert.ok(!JSON.stringify(readResendAcceptance(f.project)).includes('sender@example.com'));
    checks++;return { ...seen, exitCode: processStub.exitCode, report: readResendAcceptance(f.project) };
  }
  try {
    const offline = fixture('offline');
    assert.equal(fs.readFileSync(offline.artifact, 'utf8'), fs.readFileSync(join(offline.project, 'src', 'app.cjs'), 'utf8'));
    const snapshot = new LocalLaunchSnapshot(offline.project, 'dist/app.cjs');assert.equal(snapshot.current(), true);
    const real = spawnSync(process.execPath, [offline.artifact], { encoding: 'utf8', cwd: offline.project,
      env: { PATH: dirname(process.execPath), ...(process.platform === 'win32' ? { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' } : {}) } });
    assert.equal(real.status, 0);assert.equal(real.stdout + real.stderr, '');
    assert.equal(readResendAcceptance(offline.project).outcome, 'offline-checked');assert.equal(snapshot.current(), true);
    const second = spawnSync(process.execPath, [offline.artifact], { encoding: 'utf8', env: {} });
    assert.equal(second.status, 1);assert.equal(second.stdout + second.stderr, '');checks++;
    const special = join(root, "special-$&-$$-$'-$`");
    prepareResendAcceptance(special);
    const specialChild = spawnSync(process.execPath, [join(special,'dist','app.cjs')], {encoding:'utf8',env:{}});
    assert.equal(specialChild.status,0);assert.equal(specialChild.stdout+specialChild.stderr,'');
    assert.equal(readResendAcceptance(special).outcome,'offline-checked');checks++;
    assert.throws(() => prepareResendAcceptance(offline.project));
    assert.throws(() => prepareResendAcceptance(join(root, 'bad'), { mode: 'live', from: 'bad\nheader', to: 'recipient@example.com' }));
    assert.throws(() => prepareResendAcceptance(join(root, 'bad'), { endpoint: 'https://unapproved.invalid' }));
    const noTransport = await execute(fixture('offline'));assert.equal(noTransport.requests + noTransport.keyReads, 0);
    for (const [options, expected, calls] of [
      [{}, 'provider-accepted', 1], [{ status: 401 }, 'provider-rejected', 1],
      [{ status: 302 }, 'unknown', 1], [{ status: 500 }, 'unknown', 1],
      [{ status: 408 }, 'unknown', 1], [{ status: 409 }, 'unknown', 1], [{ status: 429 }, 'unknown', 1],
      [{ body: 'not-json' }, 'unknown', 1], [{ body: 'x'.repeat(4097) }, 'unknown', 1],
      [{ timeout: true }, 'unknown', 1], [{ transportError: true }, 'unknown', 1],
      [{ key: null }, 'blocked', 0], [{ key: 're_bad\nheader' }, 'blocked', 0],
      [{ clockOffset: 31 * 60 * 1000 }, 'blocked', 0], [{ clockOffset: -60000 }, 'blocked', 0],
      [{ extraArg: true }, 'unknown', 0], [{ diskFailure: true }, 'unknown', 0],
      [{ resultFailure: true }, 'unknown', 1], [{ resultSyncFailure: true }, 'unknown', 1],
      [{ resultCloseFailure: true }, 'unknown', 1], [{ resultLinkFailure: true }, 'unknown', 1],
      [{ resultUnlinkFailure: true }, 'unknown', 1]
    ]) {
      const f = fixture(), result = await execute(f, options);
      assert.equal(result.report.outcome, expected);assert.equal(result.requests, calls);
      if (options.diskFailure || options.extraArg) assert.equal(result.keyReads, 0);
      if (!options.extraArg) { const retry = await execute(f);assert.equal(retry.requests + retry.keyReads, 0, 'attempts cannot retry'); }
    }
    const concurrent = fixture();const runs = await Promise.all([execute(concurrent), execute(concurrent)]);
    assert.equal(runs.reduce((total, r) => total + r.requests, 0), 1);
    const corrupt = fixture();await execute(corrupt);
    const resultFile = join(corrupt.directory, 'result.json');
    fs.writeFileSync(resultFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(resultFile, 'utf8')), secret: key }));
    assert.equal(readResendAcceptance(corrupt.project).outcome, 'unknown');
    assert.ok(!JSON.stringify(readResendAcceptance(corrupt.project)).includes(key));
    for(const mode of ['offline', 'live']) {
      const f=fixture(mode);await execute(f);
      const file=join(f.directory,'result.json'), original=JSON.parse(fs.readFileSync(file,'utf8'));
      fs.writeFileSync(file,JSON.stringify({...original,outcome:'provider-accepted',request:'not-started'}));
      assert.equal(readResendAcceptance(f.project).outcome,'unknown');
      fs.writeFileSync(file,JSON.stringify({...original,outcome:mode==='offline'?'provider-accepted':'offline-checked',request:mode==='offline'?'attempted':'not-started'}));
      assert.equal(readResendAcceptance(f.project).outcome,'unknown');
      const planFile=join(f.project,'acceptance-plan.json');
      fs.writeFileSync(planFile,JSON.stringify({...f.plan,version:99}));assert.equal(readResendAcceptance(f.project).outcome,'unknown');
    }
    const moved = fixture(), other = fixture();assert.equal((await execute(moved, { wrongDirectory: dirname(other.artifact) })).requests, 0);
    console.log(`Named Resend acceptance app: ${checks} offline checks passed; HTTPS transport mocked, no provider/key/store operation.`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runResendAcceptanceTests();
