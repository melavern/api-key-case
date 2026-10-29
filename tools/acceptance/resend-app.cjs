// A named acceptance application, not an API Key Case adapter or key getter.
// Preparation embeds one fixed non-secret plan. No arguments or endpoint override.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const PLAN = /* acceptance-plan */ null;

async function main() {
  if (!PLAN || process.argv.length !== 2 || PLAN.version !== 1 ||
      !['offline', 'live'].includes(PLAN.mode) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(PLAN.id) ||
      fs.realpathSync(path.join(__dirname, '..')) !== PLAN.projectRoot) {
    process.exitCode = 1; return;
  }
  const directory = path.join(PLAN.projectRoot, 'acceptance-results', PLAN.id);
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink() ||
      fs.realpathSync(directory) !== directory) { process.exitCode = 1; return; }
  // Exclusive, file-fsynced unknown precedes key access/transport. This protects
  // process interruption, not a power failure that loses the directory entry.
  // This file is never removed or overwritten, including on failure.
  let fd;
  try {
    fd = fs.openSync(path.join(directory, 'attempt.json'), 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ version: 1, planId: PLAN.id, outcome: 'unknown' }));
    fs.fsyncSync(fd);
  } catch { process.exitCode = 1; return; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  let finished = false;
  function finish(outcome, request) {
    if (finished) return;
    finished = true;
    const result = { version: 1, planId: PLAN.id, outcome, request,
      inbox: 'not-observed', authority: 'application-reported', permission: 'none' };
    const provisional = path.join(directory, 'result.pending.json');
    let output;
    try {
      output = fs.openSync(provisional, 'wx', 0o600);
      fs.writeFileSync(output, JSON.stringify(result)); fs.fsyncSync(output);
      fs.closeSync(output); output = undefined;
      // Publish exclusively only after persistence/close succeeded. If unlink
      // fails, nlink remains two and the status reader must keep it unknown.
      fs.linkSync(provisional, path.join(directory, 'result.json'));
      fs.unlinkSync(provisional);
    } catch { process.exitCode = 1; return; }
    finally { if (output !== undefined) { try { fs.closeSync(output); } catch {} } }
    process.exitCode = ['offline-checked', 'provider-accepted'].includes(outcome) ? 0 : 1;
  }
  if (PLAN.mode === 'offline') { finish('offline-checked', 'not-started'); return; }
  if (!Number.isFinite(PLAN.expiresAt) || Date.now() > PLAN.expiresAt || Date.now() < PLAN.createdAt) {
    finish('blocked', 'not-started'); return;
  }
  let key = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  if (typeof key !== 'string' || !/^re_[A-Za-z0-9_-]{1,256}$/.test(key)) {
    key = ''; finish('blocked', 'not-started'); return;
  }
  const body = JSON.stringify({ from: PLAN.from, to: [PLAN.to], subject: PLAN.subject, text: PLAN.text });
  await new Promise(resolve => {
    let request, timer, responseSeen = false;
    const done = outcome => { clearTimeout(timer); key = ''; finish(outcome, 'attempted'); resolve(); };
    try {
      // Fixed official HTTPS destination. No redirects, retry loop, proxy option,
      // custom CA, caller headers, arbitrary body, or raw-response persistence.
      request = https.request({ hostname: 'api.resend.com', servername: 'api.resend.com',
        port: 443, path: '/emails', method: 'POST', agent: false, rejectUnauthorized: true,
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json',
          'content-length': Buffer.byteLength(body), 'idempotency-key': 'akc-resend-acceptance/' + PLAN.id }
      }, response => {
        responseSeen = true;
        let bytes = 0, chunks = [];
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 4096) { chunks = []; response.destroy(); request.destroy(); done('unknown'); }
          else chunks.push(chunk);
        });
        response.once('error', () => done('unknown'));
        response.once('close', () => { if (!finished) done('unknown'); });
        response.once('end', () => {
          if (finished) return;
          if (response.statusCode >= 400 && response.statusCode < 500 && ![408, 409, 429].includes(response.statusCode)) { done('provider-rejected'); return; }
          if (response.statusCode !== 200) { done('unknown'); return; }
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            done(typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.id) ? 'provider-accepted' : 'unknown');
          } catch { done('unknown'); }
          chunks = [];
        });
      });
      request.once('error', () => done('unknown'));
      request.once('close', () => { if (!responseSeen && !finished) done('unknown'); });
      timer = setTimeout(() => { request.destroy(); done('unknown'); }, 10000);
      request.end(body);
    } catch { if (request) request.destroy(); done('unknown'); }
  });
}
main().catch(() => { process.exitCode = 1; });
