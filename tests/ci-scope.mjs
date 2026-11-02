import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BREADTHS, ciPlan, classifyChanges, needsProductTests } from '../demo/web-ci-scope.mjs';

test('prose skips heavy jobs; executable examples, mixed changes and unknown files retain them', () => {
  assert.equal(needsProductTests(['docs/design/security.md', 'README.ja.md', 'CHANGELOG.md']), false);
  for (const path of ['docs/example.mjs', 'package-lock.json', 'packages/cli/index.ts', '.github/workflows/ci.yml', 'new-surface']) {
    assert.equal(needsProductTests(['docs/VERIFICATION.md', path]), true);
  }
});

test('PR scope uses the merge base; unavailable refs and dispatch select full product checks', t => {
  const root = mkdtempSync(join(tmpdir(), 'akc-ci-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'); return git('rev-parse', 'HEAD'); };
  git('init', '--initial-branch=main');
  writeFileSync(join(root, 'README.md'), 'initial');
  const shared = commit();
  git('checkout', '-b', 'feature');
  writeFileSync(join(root, 'README.md'), 'prose');
  const head = commit();
  git('checkout', 'main');
  writeFileSync(join(root, 'product.ts'), 'changed only on base');
  const base = commit();
  const script = fileURLToPath(new URL('../demo/web-ci-scope.mjs', import.meta.url));
  const eventPath = join(root, 'event.json');
  const run = (event, eventName = 'push') => {
    writeFileSync(eventPath, JSON.stringify(event));
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: eventName } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n')[0];
  };
  assert.equal(run({ pull_request: { base: { sha: base }, head: { sha: head } } }, 'pull_request'), 'product=false');
  assert.equal(run({ before: shared, after: base }), 'product=true');
  assert.equal(run({}), 'product=true');
  assert.equal(run({ before: shared, after: head, inputs: {} }, 'workflow_dispatch'), 'product=true');
  assert.equal(run({ before: 'a'.repeat(40), after: head }), 'product=true');
});

test('classification keeps prose, static Web and product apart; mixed changes stay product', () => {
  assert.equal(classifyChanges(['docs/design/security.md', '.development/roadmap.json']), 'prose');
  assert.equal(classifyChanges(['index.html', 'README.md']), 'web');
  assert.equal(classifyChanges(['index.html', 'packages/core/vault.ts']), 'product');
  assert.equal(classifyChanges(['brand/new-mark.svg', 'unknown-file']), 'product');
});

test('breadth: Public product changes run Linux Node range plus OS stores; dispatch defaults to one environment', () => {
  const full = ciPlan({ eventName: 'pull_request', product: true });
  assert.deepEqual(full.test.map(entry => entry.os), ['ubuntu-latest', 'ubuntu-latest', 'ubuntu-latest']);
  assert.deepEqual(full.keyring, ['ubuntu-latest', 'macos-latest', 'windows-latest']);
  assert.equal(full.package, true);

  const prose = ciPlan({ eventName: 'push', product: false });
  assert.deepEqual([prose.test, prose.keyring, prose.package], [[], [], false]);

  const representative = ciPlan({ eventName: 'workflow_dispatch', product: true });
  assert.deepEqual(representative.test, [{ os: 'ubuntu-latest', 'node-version': 22 }]);
  assert.deepEqual(representative.keyring, []);
  assert.equal(representative.package, true);

  // Even a prose-classified dispatch is a request for evidence; the input alone sets breadth.
  const keyring = ciPlan({ eventName: 'workflow_dispatch', product: false, breadth: 'keyring' });
  assert.equal(keyring.test.length, 1);
  assert.equal(keyring.keyring.length, 3);
  assert.equal(ciPlan({ eventName: 'workflow_dispatch', breadth: 'full' }).test.length, 5);

  assert.deepEqual(BREADTHS, ['representative', 'windows', 'macos', 'keyring', 'full']);
  assert.throws(() => ciPlan({ eventName: 'workflow_dispatch', breadth: 'everything' }), /unknown breadth/);
});

test('OS-specific dispatch runs that portable suite without stores or a Linux package job', () => {
  for (const breadth of ['windows', 'macos']) {
    const plan = ciPlan({ eventName: 'workflow_dispatch', product: false, breadth });
    assert.equal(plan.product, true);
    assert.deepEqual(plan.test, [{ os: `${breadth}-latest`, 'node-version': 24 }]);
    assert.deepEqual(plan.keyring, []);
    assert.equal(plan.package, false);
    const publicPlan = ciPlan({ eventName: 'push', product: true, breadth });
    assert.deepEqual(publicPlan.test, ciPlan({ eventName: 'push', product: true }).test, 'a breadth input cannot change automatic Public product CI');
    assert.equal(publicPlan.test.length, 3);
    assert.equal(publicPlan.keyring.length, 3);
    assert.equal(publicPlan.package, true);
  }
});

test('dispatch outputs are GitHub output lines whose matrices parse as JSON', t => {
  const root = mkdtempSync(join(tmpdir(), 'akc-ci-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const eventPath = join(root, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ inputs: { breadth: 'keyring' } }));
  const script = fileURLToPath(new URL('../demo/web-ci-scope.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'workflow_dispatch' } });
  assert.equal(result.status, 0, result.stderr);
  const outputs = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
  assert.equal(outputs.product, 'true');
  assert.equal(JSON.parse(outputs.test).length, 1);
  assert.equal(JSON.parse(outputs.keyring).length, 3);
  assert.equal(outputs.package, 'true');
  for (const breadth of ['windows', 'macos']) {
    writeFileSync(eventPath, JSON.stringify({ inputs: { breadth } }));
    const run = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'workflow_dispatch' } });
    assert.equal(run.status, 0, run.stderr);
    const selected = Object.fromEntries(run.stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
    assert.deepEqual(JSON.parse(selected.test), [{ os: `${breadth}-latest`, 'node-version': 24 }]);
    assert.deepEqual(JSON.parse(selected.keyring), []);
    assert.equal(selected.package, 'false');
  }
});
