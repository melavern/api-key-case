import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';

// Synthetic keys exist only in this process. No Clerk account/session/provider is used.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = randomUUID();
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
const secret = 'sk_test_SYNTHETIC_CLERK_WORKER_CANARY';
const publishable = `pk_test_${Buffer.from('fixture.clerk.accounts.dev$').toString('base64')}`;
const env = { CLERK_SECRET_KEY: secret, CLERK_PUBLISHABLE_KEY: publishable,
  APP_ORIGIN: 'https://app.example.test' };
const originalFetch = globalThis.fetch;
const originalConsole = { log: console.log, warn: console.warn, error: console.error };
let requests = 0;
const unexpectedRequests = [];
const tokens = [];
const diagnostics = [];
globalThis.fetch = async (url, init) => {
  requests++;
  if (String(url) !== 'https://api.clerk.com/v1/jwks' ||
      new Headers(init?.headers).get('Authorization') !== `Bearer ${secret}`) {
    unexpectedRequests.push('unexpected-transport');
  }
  assert.equal(String(url), 'https://api.clerk.com/v1/jwks');
  assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${secret}`);
  return Response.json({ keys: [jwk] });
};
for (const name of Object.keys(originalConsole)) console[name] = (...args) => diagnostics.push(args.join(' '));
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
function token(patch = {}, signingKey = privateKey) {
  const data = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode({
    iss: 'https://fixture.clerk.accounts.dev', sub: 'user_synthetic', sid: 'sess_synthetic',
    azp: env.APP_ORIGIN, iat: now - 10, nbf: now - 10, exp: now + 300, ...patch,
  })}`;
  const value = `${data}.${sign('RSA-SHA256', Buffer.from(data), signingKey).toString('base64url')}`;
  tokens.push(value);
  return value;
}
let checks = 0;
try {
  const { default: worker } = await import('./worker.mjs');
  async function check(status, result, authorization, bindings = env, path = '/private', method = 'GET') {
    const response = await worker.fetch(new Request(`https://worker.example.test${path}`, {
      method, headers: authorization ? { Authorization: authorization } : {},
    }), bindings);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { result });
    for (const value of [secret, publishable, 'user_synthetic', 'sess_synthetic', authorization]) {
      if (value) assert.equal(body.includes(value), false);
    }
    checks++;
  }
  await check(401, 'sign-in-required');
  await check(401, 'sign-in-required', 'Basic pretend');
  await check(404, 'not-found', undefined, env, '/');
  await check(405, 'method-not-allowed', undefined, env, '/private', 'POST');
  assert.equal(requests, 0);
  await check(200, 'protected-feature-accessible', `Bearer ${token()}`);
  assert.equal(requests, 1);
  await check(401, 'sign-in-required', `Bearer ${token({ exp: now - 60 })}`);
  await check(401, 'sign-in-required', `Bearer ${token({ nbf: now + 60 })}`);
  await check(401, 'sign-in-required', `Bearer ${token({ azp: 'https://other.example.test' })}`);
  await check(401, 'sign-in-required', `Bearer ${token({ azp: undefined })}`);
  await check(401, 'sign-in-required', `Bearer ${token({ sub: undefined })}`);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await check(401, 'sign-in-required', `Bearer ${token({}, other.privateKey)}`);
  await check(401, 'sign-in-required', 'Bearer not-a-signed-token');
  await check(503, 'configuration-unavailable', `Bearer ${token()}`, { ...env, CLERK_SECRET_KEY: '' });
  await check(503, 'configuration-unavailable', `Bearer ${token()}`, { ...env, CLERK_PUBLISHABLE_KEY: '' });
  await check(503, 'configuration-unavailable', `Bearer ${token()}`, { ...env, APP_ORIGIN: 'https://app.example.test/path' });
  await check(503, 'configuration-unavailable', `Bearer ${token()}`, { ...env, APP_ORIGIN: 'http://app.example.test' });
  assert.deepEqual(unexpectedRequests, []);
  for (const value of [secret, publishable, ...tokens]) assert.equal(diagnostics.join('\n').includes(value), false);
} finally {
  globalThis.fetch = originalFetch;
  Object.assign(console, originalConsole);
}
console.log(`PASS ${checks} Worker cases with real Clerk SDK and synthetic signatures; ${requests} in-process JWKS request(s), zero network transport. Live Clerk sign-in remains unverified.`);
