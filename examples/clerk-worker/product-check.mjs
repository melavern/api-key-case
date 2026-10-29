// Optional integration check from a built private API Key Case source checkout.
// No native/store/provider action: the only value is synthetic and memory-only.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveClerkWorkerDestination } from '../../dist/core/deploy/snapshot.js';
import { ConnectionStateStore } from '../../dist/core/agent/connection-state.js';
import { clerkCredentialRef, runConnectionCredential } from '../../dist/core/agent/connection-credential.js';
import { MemoryVault } from '../../dist/core/vault/memory.js';

const root = mkdtempSync(join(tmpdir(), 'clerk-example-connection-'));
try {
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(home);
  const config = JSON.parse(readFileSync(new URL('./wrangler.example.jsonc', import.meta.url), 'utf8'));
  writeFileSync(join(project, 'wrangler.jsonc'), JSON.stringify(config));
  assert.equal(resolveClerkWorkerDestination(project, 'development'), null);
  config.env.development.account_id = '0123456789abcdef0123456789abcdef';
  config.env.development.name = 'synthetic-development-worker';
  writeFileSync(join(project, 'wrangler.jsonc'), JSON.stringify(config));
  assert.deepEqual(resolveClerkWorkerDestination(project, 'development'), {
    accountId: config.env.development.account_id, name: config.env.development.name,
  });
  for (const env of ['preview', 'production']) assert.equal(resolveClerkWorkerDestination(project, env), null);
  const state = new ConnectionStateStore(project, home), memory = new MemoryVault();
  const ref = clerkCredentialRef(project, 'development');
  await memory.setSecret(ref, 'synthetic-example-memory-only');
  const mutation = state.beginCredentialMutation(ref);
  assert.equal(mutation.ok, true);
  assert.equal(state.finishCredentialMutation(ref, mutation.value, true), true);
  const revision = state.credentialRevision(ref);
  assert.equal(state.saveClerkManagedIntent({ service: 'clerk', environment: 'development',
    route: 'api-key-case-managed', destination: { kind: 'cloudflare' }, sendingDomain: null }).ok, true);
  const deps = { vault: new Proxy({}, { get(_target, key) {
    assert.equal(key, 'hasSecret', 'presence must not access value or mutation methods');
    return value => memory.hasSecret(value);
  } }) };
  for (const env of ['development', 'preview', 'production']) {
    assert.equal((await runConnectionCredential(project, env, 'check', deps, false, 'clerk')).status,
      env === 'development' ? 'registered' : 'missing');
  }
  assert.equal((await runConnectionCredential(project, 'development', 'check', deps, false, 'resend')).status, 'missing');
  assert.equal(state.credentialRevision(ref), revision);
  assert.equal(state.readClerkManagedIntent().status, 'available');
  console.log('PASS existing exact-environment selection, registration presence and destination parsing; memory-only synthetic slot. No handoff/deployment/authentication proof.');
} finally { rmSync(root, { recursive: true, force: true }); }
