import assert from 'node:assert/strict';
import {unsafeMetadataLink} from './helpers/metadata-link-fixture.mjs';
import {canonicalProjectRealpath} from '../dist/core/vault/naming.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderAgentProtocol } from '../dist/core/agent/init.js';
import { ConnectionStateStore } from '../dist/core/agent/connection-state.js';
import { clerkNativeIntentFingerprint } from '../dist/core/agent/clerk-native.js';
import { connectionIntentFingerprint } from '../dist/core/agent/fingerprints.js';
import { recordNativeInspection, readNativeApplicationEvidence, readNativeDestinationSelection } from '../dist/core/agent/native-observations.js';
import { parseClerkNativeConfiguration, parseNativeConfiguration } from '../dist/core/agent/provider-native-check.js';
import { readNativeAcquisitionGuide, renderNativeAcquisitionGuide, projectNativeAcquisitionEvidence, readOfficialNativeRouteOption, renderOfficialNativeRouteOption } from '../dist/core/agent/native-acquisition.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const canary = 'synthetic-private-native-guide-canary';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'akc-native-guide-')));
let checks = 0, serial = 0;
function snapshot(root, prefix = '') {
  return Object.fromEntries(readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(row => {
    const path = join(prefix, row.name);
    return row.isDirectory() ? Object.entries(snapshot(root, path)) : row.isFile() ? [[path, readFileSync(join(root, path)).toString('base64')]] : [];
  }));
}
function fixture(service = 'resend', environment = 'development') {
  const dir = join(root, String(serial++)), home = join(dir, 'home'), project = join(dir, 'project');
  for (const path of [dir, home, project, join(project, '.vercel')]) mkdirSync(path, { mode: 0o700 });
  const linked = join(project, '.vercel', 'project.json');
  writeFileSync(linked, JSON.stringify({ orgId: 'team_fixture', projectId: 'prj_fixture', unused: canary }));
  const store = new ConnectionStateStore(project, home);
  const select = (extra = {}) => {
    const input = { service, environment, route: 'provider-native', destination: { kind: 'vercel' }, sendingDomain: null, ...extra };
    if (service === 'resend' && input.route === 'provider-native' && input.destination.kind === 'vercel' && input.nativeEnrollment === undefined) {
      input.nativeEnrollment = 'resend-vercel-integration';
    }
    return (service === 'clerk' ? store.saveClerkNativeIntent.bind(store) : store.saveIntent.bind(store))(input);
  };
  assert.equal(select().ok, true);
  const guide = (s = service, env = environment) => readNativeAcquisitionGuide(project, s, env, home);
  const record = (configuration = 'integration-managed', projection = {}) => {
    const intent = (service === 'clerk' ? store.readClerkNativeIntent() : store.readIntent()).value;
    return recordNativeInspection(project, {
      schemaVersion: service === 'clerk' ? 2 : 1, service, environment, destination: 'vercel',
      status: configuration === 'unknown' ? 'unknown' : 'inspected', reason: configuration === 'unknown' ? 'command-failed' : 'inspected',
      configuration, configurationFingerprint: configuration === 'unknown' ? null : hash(configuration),
      intentFingerprint: service === 'clerk' ? clerkNativeIntentFingerprint(intent) : connectionIntentFingerprint(intent),
      destinationSelectionFingerprint: readNativeDestinationSelection(project, environment).fingerprint,
      observedAt: new Date().toISOString(), integrationIdentity: 'unverified', credentialValidity: 'not-checked',
      application: 'not-checked', permission: 'none', value: canary, ...projection
    }, 600, home);
  };
  return { dir, home, project, linked, store, select, guide, record };
}
function closed(guide) {
  const rendered = renderNativeAcquisitionGuide(guide);
  assert.ok(!JSON.stringify(guide).includes(canary));
  assert.ok(!rendered.includes(canary));
  assert.equal(guide.permission, 'none'); assert.equal(guide.executed, false);
  assert.equal(guide.application, 'not-checked'); assert.equal(guide.credentialValidity, 'not-checked');
  assert.equal(guide.integrationIdentity, 'unverified'); assert.equal(guide.authority, 'human-required');
  return rendered;
}
try {
  // Candidates exist BEFORE route selection, without querying a vault or a provider.
  for (const service of ['resend', 'clerk']) for (const env of ['development', 'preview', 'production']) {
    const option = readOfficialNativeRouteOption(service, env);
    assert.equal(option.status, 'documented-candidate');
    assert.equal(option.route, 'provider-native'); assert.equal(option.destination, 'vercel');
    assert.equal(option.selection, 'not-checked'); assert.equal(option.providerAccount, 'not-checked');
    assert.equal(option.configuration, 'not-checked'); assert.equal(option.application, 'not-checked');
    assert.equal(option.humanSelection, 'required'); assert.equal(option.permission, 'none');
    assert.equal(option.executed, false);
    assert.ok(option.guideUrl.startsWith('https://'));
    const renderedOption = renderOfficialNativeRouteOption(option);
    assert.ok(renderedOption.includes('未選択'));
    if (service === 'resend') {
      assert.deepEqual(option.nativeEnrollmentOptions.map(choice => choice.method), ['resend-vercel-integration', 'resend-vercel-marketplace']);
      assert.equal(option.marketplaceAlternative.prerequisite, 'domain-purchased-through-vercel');
      assert.equal(option.marketplaceAlternative.humanDecision, 'plan-billing-domain-authorization');
      assert.equal(option.marketplaceAlternative.guideUrl, 'https://resend.com/changelog/vercel-marketplace-integration');
      assert.ok(renderedOption.includes('Vercelで購入したドメイン'));
    } else assert.equal(option.marketplaceAlternative, null);
    assert.ok(!JSON.stringify(option).includes(canary));
    checks++;
  }
  for (const [service, env] of [['stripe-test', 'preview'], ['resend', 'unknown'], [canary, canary], [null, null]]) {
    const option = readOfficialNativeRouteOption(service, env);
    assert.equal(option.status, 'unsupported'); assert.equal(option.guideUrl, null);
    assert.equal(option.route, null); assert.deepEqual(option.requiredSettings, []);
    assert.equal(option.marketplaceAlternative, null);
    assert.equal(option.executed, false); checks++;
  }
  for (const service of ['resend', 'clerk']) for (const environment of ['development', 'preview', 'production']) {
    const f = fixture(service, environment), before = snapshot(f.home);
    const first = f.guide(); assert.equal(first.state, 'human-needed'); assert.equal(first.reason, 'not-inspected');
    assert.equal(first.service, service); assert.equal(first.environment, environment);
    assert.equal(first.selection.orgId, 'team_fixture'); assert.equal(first.selection.projectId, 'prj_fixture');
    assert.equal(first.nativeEnrollmentPrerequisite, null); assert.equal(first.nativeEnrollmentEligibility, null);
    assert.equal(first.guideUrl, service === 'resend' ? 'https://resend.com/blog/vercel-integration' :
      'https://clerk.com/docs/guides/development/integrations/platforms/vercel-marketplace');
    if (service === 'resend') assert.equal(first.nativeEnrollment, 'resend-vercel-integration');
    assert.deepEqual(first.requiredSettings, service === 'resend' ? ['RESEND_API_KEY'] : ['CLERK_SECRET_KEY', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY']);
    assert.deepEqual(f.guide(), first); assert.deepEqual(snapshot(f.home), before);
    const text = closed(first); assert.ok(text.includes('--service ' + service + ' --env ' + environment));
    assert.ok(!text.includes('Vercelで購入したドメインが必要'));
    assert.ok(text.includes('全プロジェクトを選択しない')); assert.ok(text.includes('自動ログイン'));
    if (service === 'clerk') { assert.ok(text.includes('プラン選択')); assert.ok(text.includes('単独Clerkアプリ')); }
    checks++;
    for (const config of ['integration-managed', 'present-unmanaged', 'absent', 'partial', 'unknown']) {
      assert.equal(f.record(config).status, 'recorded');
      const stable = snapshot(f.home), guide = f.guide();
      assert.equal(guide.state, config === 'integration-managed' ? config : config === 'partial' ? 'partial' : config === 'unknown' ? 'unknown' : 'human-needed');
      assert.equal(guide.configuration, config); closed(guide); assert.deepEqual(snapshot(f.home), stable);
      assert.deepEqual(guide.missingSettings, config === 'absent' ? first.requiredSettings :
        ['integration-managed', 'present-unmanaged'].includes(config) ? [] : null);
      checks++;
    }
    f.record(); const now = Date.now;
    try { Date.now = () => now() + 601000; const stale = f.guide(); assert.equal(stale.state, 'unknown'); assert.equal(stale.configuration, 'unknown'); closed(stale); checks++; }
    finally { Date.now = now; }
    const changedEnv = environment === 'development' ? 'preview' : 'development';
    assert.equal(f.guide(service, changedEnv).state, 'unsupported'); assert.equal(f.guide(service, changedEnv).guideUrl, null); checks++;
    assert.equal(f.guide(service === 'resend' ? 'clerk' : 'resend').state, 'unsupported'); checks++;
    writeFileSync(f.linked, JSON.stringify({ orgId: 'team_other', projectId: 'prj_other' }));
    assert.equal(f.guide().configuration, 'unknown'); assert.equal(f.guide().selection.projectId, 'prj_other'); closed(f.guide()); checks++;
  }
  {
    const f = fixture('resend', 'preview');
    const selected = f.store.readIntent().value;
    assert.equal(selected.nativeEnrollment, 'resend-vercel-integration');
    const unchangedFiles = snapshot(f.home), repeated = f.select({ nativeEnrollment: 'resend-vercel-integration' });
    assert.equal(repeated.ok, true); assert.equal(repeated.value.updatedAt, selected.updatedAt);
    assert.deepEqual(snapshot(f.home), unchangedFiles, 'repeating a selected method must not rewrite v2 metadata');
    assert.equal(f.record().status, 'recorded');
    const oldFingerprint = connectionIntentFingerprint(f.store.readIntent().value);
    const changed = f.select({ nativeEnrollment: 'resend-vercel-marketplace' });
    assert.equal(changed.ok, true); assert.ok(changed.value.updatedAt > selected.updatedAt);
    assert.notEqual(connectionIntentFingerprint(changed.value), oldFingerprint);
    const guide = f.guide();
    assert.equal(guide.nativeEnrollment, 'resend-vercel-marketplace');
    assert.equal(guide.nativeEnrollmentPrerequisite, 'domain-purchased-through-vercel');
    assert.equal(guide.nativeEnrollmentEligibility, 'unverified');
    assert.equal(guide.guideUrl, 'https://resend.com/changelog/vercel-marketplace-integration');
    assert.equal(guide.state, 'unknown', 'an inspection bound to the old choice cannot transfer');
    assert.equal(guide.permission, 'none'); assert.equal(guide.executed, false);
    const marketplaceText = closed(guide);
    assert.ok(marketplaceText.includes('Vercelで購入したドメインが必要'));
    assert.ok(marketplaceText.includes('対象ドメインの適格性は未確認'));
    checks++;
    assert.equal(f.select({ route: 'manual', nativeEnrollment: 'resend-vercel-marketplace' }).ok, false);
    assert.equal(f.select({ route: 'provider-native', destination: { kind: 'cloudflare' }, nativeEnrollment: 'resend-vercel-marketplace' }).ok, false);

    const metadata = join(f.home, '.api-key-case', 'connections', hash(canonicalProjectRealpath(f.project)));
    const v2 = f.store.readIntent().value;
    const { nativeEnrollment: _method, ...v1Intent } = v2;
    writeFileSync(join(metadata, 'state.json'), JSON.stringify({ schemaVersion: 1, intent: v1Intent }), { mode: 0o600 });
    const v1 = f.guide();
    assert.equal(v1.nativeEnrollment, 'unrecorded'); assert.equal(v1.guideUrl, null);
    assert.equal(v1.nativeEnrollmentPrerequisite, null); assert.equal(v1.nativeEnrollmentEligibility, null);
    const v1Text = closed(v1);
    assert.ok(v1Text.includes('inspectionやhistoryから推定しません'));
    assert.ok(!v1Text.includes('Vercelで購入したドメインが必要'));
    assert.deepEqual(f.store.readIntent().value, v1Intent, 'v1 read must not rewrite or enrich old intent'); checks++;

    writeFileSync(join(metadata, 'state.json'), JSON.stringify({ schemaVersion: 2, intent: { ...v2, unexpected: true } }), { mode: 0o600 });
    const unknown = f.guide();
    assert.equal(unknown.selection, null); assert.equal(unknown.guideUrl, null); closed(unknown); checks++;
    assert.equal(f.store.saveIntent({ service: 'resend', environment: 'preview', route: 'api-key-case-managed',
      destination: { kind: 'vercel' }, sendingDomain: null, nativeEnrollment: 'resend-vercel-integration' }).ok, false);
    const other = join(f.dir, 'other-project'); mkdirSync(other, { mode: 0o700 }); mkdirSync(join(other, '.vercel'), { mode: 0o700 });
    writeFileSync(join(other, '.vercel', 'project.json'), JSON.stringify({ orgId: 'team_fixture', projectId: 'prj_fixture' }), { mode: 0o600 });
    const otherMetadata = join(f.home, '.api-key-case', 'connections', hash(canonicalProjectRealpath(other)));
    mkdirSync(otherMetadata, { recursive: true, mode: 0o700 });
    writeFileSync(join(otherMetadata, 'state.json'), JSON.stringify({ schemaVersion: 2, intent: v2 }), { mode: 0o600 });
    const crossProject = readNativeAcquisitionGuide(other, 'resend', 'preview', f.home);
    assert.equal(crossProject.selection, null); assert.notEqual(crossProject.nativeEnrollment, 'resend-vercel-marketplace'); closed(crossProject); checks++;
  }
  for (const extra of [{ route: 'manual' }, { route: 'api-key-case-managed' }, { destination: { kind: 'cloudflare' } }, { destination: { kind: 'local' } }]) {
    const f = fixture(); assert.equal(f.select(extra).ok, true); const result = f.guide();
    assert.equal(result.state, 'unsupported'); assert.equal(result.guideUrl, null); assert.equal(result.selection, null); closed(result); checks++;
  }
  const f = fixture();
  for (const [service, env] of [['other', 'development'], ['resend', 'staging'], [canary, canary]]) {
    const result = f.guide(service, env); assert.equal(result.state, 'unsupported'); closed(result); checks++;
  }
  // Raw provider values/errors are discarded by the existing bounded parser.
  const entry = (key, configurationId = 'icfg_fixture') => ({ key, target: ['development'], type: 'encrypted', configurationId, value: canary });
  const c = fixture('clerk');
  for (const rows of [[entry('CLERK_SECRET_KEY')], [entry('CLERK_SECRET_KEY', 'icfg_one'), entry('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'icfg_two')],
    [entry('CLERK_SECRET_KEY'), entry('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')]]) {
    const parsed = parseClerkNativeConfiguration(JSON.stringify({ envs: rows }), 'development');
    assert.equal(c.record(parsed.configuration, parsed).status, 'recorded');
    const guide = c.guide(); closed(guide);
    assert.equal(guide.state, rows.length === 1 ? 'partial' : rows[0].configurationId !== rows[1].configurationId ? 'unknown' : 'integration-managed'); checks++;
  }
  const rejected = parseNativeConfiguration(JSON.stringify({ envs: [], error: { message: canary } }), 'development');
  assert.equal(f.record(rejected.configuration, rejected).status, 'recorded'); assert.equal(f.guide().state, 'unknown'); closed(f.guide()); checks++;
  // Unsafe selectors and unavailable state must not produce a usable handoff.
  const metadata = join(f.home, '.api-key-case', 'connections', hash(canonicalProjectRealpath(f.project)));
  mkdirSync(join(metadata, 'lock')); assert.equal(f.guide().guideUrl, null); rmSync(join(metadata, 'lock'), { recursive: true }); checks++;
  for (const bytes of ['{}', '{"orgId":"team_a","orgId":"team_b","projectId":"prj_fixture"}', JSON.stringify({ orgId: canary + '!', projectId: 'prj_fixture' })]) {
    writeFileSync(f.linked, bytes); assert.equal(f.guide().selection, null); closed(f.guide()); checks++;
  }
  const backing = join(f.dir, 'selector.json'); writeFileSync(backing, JSON.stringify({ orgId: 'team_fixture', projectId: 'prj_fixture' }));
  rmSync(f.linked); unsafeMetadataLink(backing, f.linked); assert.equal(f.guide().selection, null); checks++;
  // A copied receipt cannot establish another local project's selection.
  const source = fixture(), other = fixture(); source.record();
  const originalRead = ConnectionStateStore.prototype.readObservations;
  try {
    ConnectionStateStore.prototype.readObservations = function () { return source.store === this ? originalRead.call(this) : originalRead.call(source.store); };
    assert.notEqual(other.guide().state, 'integration-managed'); checks++;
  } finally { ConnectionStateStore.prototype.readObservations = originalRead; }
  // Race during evidence read invalidates the handoff rather than mixing targets.
  const race = fixture(); race.record();
  try {
    ConnectionStateStore.prototype.readObservations = function () {
      const result = originalRead.call(this); writeFileSync(race.linked, JSON.stringify({ orgId: 'team_race', projectId: 'prj_race' })); return result;
    };
    const changed = race.guide(); assert.equal(changed.selection, null); assert.equal(changed.reason, 'selection-changed'); checks++;
  } finally { ConnectionStateStore.prototype.readObservations = originalRead; }
  // Pure projection cannot promote an unverified/stale evidence object.
  const evidence = readNativeApplicationEvidence(c.project, 'clerk', c.home);
  for (const extra of [{ status: 'stale' }, { binding: 'changed' }, { reason: 'observation-expired' }, { reason: 'inspection-unverified' }]) {
    const before = JSON.stringify(evidence); assert.equal(projectNativeAcquisitionEvidence({ ...evidence, ...extra, value: canary }).state, 'unknown');
    assert.equal(JSON.stringify(evidence), before); checks++;
  }
  const protocol = renderAgentProtocol('0.9.2');
  assert.ok(protocol.includes('connection native guide --service <service> --env <environment> --json <project>'));
  assert.ok(protocol.includes('connection native options --service <resend|clerk> --env <environment> --json'));
  assert.ok(protocol.includes('documented official Vercel candidates'));
  checks += 2;
  assert.ok(protocol.includes('do not invent URLs or substitute another route')); checks++;
  // Actual CLI: deny browser/child/network entrypoints and verify repeated reads
  // leave metadata unchanged. No Vercel session is required for this local guide.
  const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url)), fixtureCli = fixture('clerk', 'preview');
  const marker = join(root, 'forbidden-effect'), preload = join(root, 'deny-effects.cjs');
  writeFileSync(preload, `const fs=require('node:fs'); const deny=()=>{fs.writeFileSync(${JSON.stringify(marker)},'effect');throw Error(${JSON.stringify(canary)})};
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[n]=deny;
for(const module of ['node:http','node:https'])for(const n of ['request','get'])require(module)[n]=deny;
for(const n of ['connect','createConnection'])require('node:net')[n]=deny;
require('node:tls').connect=deny;global.fetch=deny;require('node:module').syncBuiltinESMExports();`);
  const run = args => spawnSync(process.execPath, ['--require', preload, cli, 'connection', 'native', ...args, fixtureCli.project], {
    env: { ...process.env, HOME: fixtureCli.home, USERPROFILE: fixtureCli.home, DO_NOT_TRACK: '1' }, encoding: 'utf8', timeout: 15000
  });
  const stable = snapshot(fixtureCli.home);
  for (const json of [[], ['--json'], ['--json']]) {
    const result = run(['guide', '--service', 'clerk', '--env', 'preview', ...json]); assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(canary)); if (json.length) closed(JSON.parse(result.stdout));
    assert.deepEqual(snapshot(fixtureCli.home), stable); checks++;
  }
  for (const args of [[], ['--service','resend','--env','development'], ['--service','clerk','--env','production'],
    ['--service','clerk','--env','preview','--url','https://example.test'], ['--service','clerk','--env','preview','--record'],
    ['--service','clerk','--env','preview','--json','--json'], ['--service','clerk','--env','preview','--open'], ['--service','clerk','--env','preview','--force']]) {
    const result = run(['guide', ...args]); assert.equal(result.status, 1); assert.ok(!(result.stdout + result.stderr).includes(canary)); checks++;
  }
  // In an actual CLI process, native options reads no project/account/keyring.
  for (const service of ['resend', 'clerk']) {
    const args = ['--service', service, '--env', 'preview', '--json'];
    const candidate = spawnSync(process.execPath, ['--require', preload, cli, 'connection', 'native', 'options', ...args], {
      cwd: fixtureCli.project, env: { ...process.env, HOME: fixtureCli.home, USERPROFILE: fixtureCli.home, DO_NOT_TRACK: '1' },
      encoding: 'utf8', timeout: 15000
    });
    assert.equal(candidate.status, 0, candidate.stderr);
    assert.equal(JSON.parse(candidate.stdout).status, 'documented-candidate');
    assert.ok(!candidate.stdout.includes(canary)); checks++;
  }
  for (const bad of [['--service', 'stripe-test', '--env', 'preview'], ['--service', 'resend', '--env', 'preview', '--url', 'https://example.test'],
    ['--service', 'resend', '--env', 'preview', '--json', '--json'], ['--service', 'resend', '--env', 'preview', fixtureCli.project]]) {
    const candidate = spawnSync(process.execPath, ['--require', preload, cli, 'connection', 'native', 'options', ...bad], {
      cwd: fixtureCli.project, env: { ...process.env, HOME: fixtureCli.home, USERPROFILE: fixtureCli.home, DO_NOT_TRACK: '1' },
      encoding: 'utf8', timeout: 15000
    });
    assert.equal(candidate.status, 1); assert.ok(!candidate.stdout.includes(canary)); checks++;
  }
  assert.equal(existsSync(marker), false); assert.deepEqual(snapshot(fixtureCli.home), stable); checks++;
  console.log(`native acquisition: ${checks} checks passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
