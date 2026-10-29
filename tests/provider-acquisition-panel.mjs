await import("./acquisition-guide-structure.mjs");
// Synthetic fixtures only. Never launch a GUI/browser, contact a provider or use an OS store.
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import {
  buildCredentialAcquisitionPanel, buildResendAcquisitionPanel,
  CLERK_ACQUISITION_URL, OPENAI_ACQUISITION_URL, RESEND_ACQUISITION_URL, STRIPE_TEST_ACQUISITION_URL,
  STRIPE_TEST_INPUT_ERROR
} from '../dist/core/human/acquisition.js';
import { buildWindowsSecretInputScript, encodeWindowsHelperCommand, WINDOWS_HELPER_COMMAND_MAX_CHARS, WINDOWS_POWERSHELL_PATH } from '../dist/core/human/windows.js';
import { buildMacOSSecretInputScript } from '../dist/core/human/macos.js';

const projectId = '0123456789abcdef';
const base = { scope: 'project', projectId, projectDir: '/synthetic/日本語 project' };
const names = { openai: 'OPENAI_API_KEY', 'stripe-test': 'STRIPE_API_KEY', resend: 'RESEND_API_KEY', clerk: 'CLERK_SECRET_KEY' };
const request = (service, environment = 'development', extra = {}) => ({ ...base, service, name: names[service], environment, ...extra });
const builders = [buildCredentialAcquisitionPanel, buildWindowsSecretInputScript, buildMacOSSecretInputScript];
let checks = 0;

// Run generated JXA against an in-memory AppKit/Security stand-in. This tests
// value handling/control flow, not actual platform layout, APIs or OS storage.
function runSyntheticMac(script, inputValue, response = 1000, storeStatus = 0) {
  const fields = [], alerts = [], writes = [], links = [], encoded = [];
  const exit = {};
  let status;
  const dollar = {
    NSApplication: { sharedApplication: { setActivationPolicy() {}, activateIgnoringOtherApps() {} } },
    NSApplicationActivationPolicyRegular: 0,
    NSAlertFirstButtonReturn: 1000,
    NSAlert: { alloc: { get init() {
      const alert = { window: {}, addButtonWithTitle() {}, get runModal() { return response; } };
      alerts.push(alert); return alert;
    } } },
    NSSecureTextField: { alloc: { initWithFrame() {
      const field = { stringValue: inputValue, setFrame() {} }; fields.push(field); return field;
    } } },
    NSView: { alloc: { initWithFrame() { return { addSubview() {} }; } } },
    NSTextField: { alloc: { initWithFrame() { return {}; } } },
    NSMutableAttributedString: { alloc: { initWithString(text) {
      return { addAttributeValueRange(_attribute, url, range) { links.push({ text, url, range }); } };
    } } },
    NSLinkAttributeName: 'link',
    NSURL: { URLWithString(value) { return value; } },
    NSMakeRange(start, length) { return { start, length }; },
    NSMakeRect() { return {}; },
    NSString: { stringWithString(text) {
      return { text, dataUsingEncoding() { encoded.push(text); return { syntheticData: text }; } };
    } },
    NSUTF8StringEncoding: 4,
    NSMutableDictionary: { alloc: { get init() {
      return { entries: new Map(), setObjectForKey(value, key) { this.entries.set(key, value); } };
    } } },
    kSecClassGenericPassword: 'generic', kSecClass: 'class', kSecAttrService: 'service', kSecAttrAccount: 'account', kSecValueData: 'data',
    errSecItemNotFound: -25300, errSecSuccess: 0,
    SecItemUpdate(query, update) { writes.push({ query, update }); return -25300; },
    SecItemAdd(item) { writes.push({ item }); return storeStatus; },
    exit(code) { status = code; throw exit; }
  };
  try {
    new Script(script).runInNewContext({ $: dollar, ObjC: { import() {}, unwrap(value) { return value; } } }, { timeout: 1000 });
    assert.fail('The helper must return an explicit status');
  } catch (error) { if (error !== exit) throw error; }
  return { status, fields, alerts, writes, links, encoded };
}

for (const [service, environments, url] of [
  ['openai', ['development', 'preview', 'production'], OPENAI_ACQUISITION_URL],
  ['stripe-test', ['development', 'preview'], STRIPE_TEST_ACQUISITION_URL]
]) {
  for (const environment of environments) {
    const ref = request(service, environment), panel = buildCredentialAcquisitionPanel(ref);
    assert.equal(panel.linkUrl, url);
    assert.ok(panel.linkText.en.includes(service === 'openai' ? 'OpenAI' : 'Stripe'));
    assert.ok(panel.steps.some(step => step.en.includes(environment)));
    assert.ok(panel.steps.some(step => step.en.includes(`akc-${projectId}-${environment}`)));
    assert.ok(panel.afterSave.en.includes('stored only'));
    assert.ok(!panel.afterSave.en.includes('integration is not configured'));
    assert.ok(panel.afterSave.en.includes('Provider/application checks'));
    assert.ok(!panel.afterSave.ja.includes('連携は未設定'));
    assert.ok(panel.afterSave.en.includes('selected supported hosted plan'));
    assert.ok(panel.steps.some(step => step.en.includes('Account, project and permissions are not independently verified')));
    assert.ok(panel.steps.some(step => step.ja.includes('未検証')));
    const account = `v2|credential|project|${projectId}|${service}|${environment}|${names[service]}`;
    for (const build of [buildWindowsSecretInputScript, buildMacOSSecretInputScript]) {
      const script = build(ref);
      assert.ok(script.includes(url)); assert.ok(script.includes(account));
      assert.ok(!script.includes('Start-Process $'));
      assert.ok(!/console\.|process\.stdout|Write-Output|Write-Host|Out-File|Set-Content|fetch\(|XMLHttpRequest|doShellScript/.test(script));
      assert.ok(!script.includes('pk_live_'));
      assert.ok(!script.includes('RESEND_API_KEY'));
      const forged = build({ ...ref, url: 'https://attacker.invalid/', linkUrl: 'https://attacker.invalid/', linkText: 'untrusted-link-canary' });
      assert.ok(!forged.includes('attacker.invalid')); assert.ok(!forged.includes('untrusted-link-canary'));
      checks++;
    }
    const win = buildWindowsSecretInputScript(ref);
    assert.ok(win.includes('$input.UseSystemPasswordChar = $true'));
    assert.ok(win.includes('$input.MaxLength = 0'));
    assert.ok(win.includes('$root = New-Object System.Windows.Forms.TableLayoutPanel'));
    assert.ok(win.includes('SystemInformation]::HighContrast'));
    assert.ok(win.includes('Clipboard]::SetText([string]$sender.Tag)'));
    assert.ok(!win.includes('Clipboard]::SetText($script:input'));
    assert.ok(win.includes(`akc-${projectId}-${environment}`));
    assert.ok(win.includes('SetThreadDpiAwarenessContext([IntPtr](-4))'));
    assert.ok(win.includes('$scroll.AutoScroll = $true'));
    const shown = win.slice(win.indexOf('$form.Add_Shown({'), win.indexOf('$form.AcceptButton ='));
    assert.ok(shown.includes('Fit-AkcGuide'));
    assert.ok(!/\$input\./.test(shown), 'event callbacks must not use PowerShell automatic $input as the secure field');
    assert.ok(shown.includes('catch { $script:resultCode = 10; $script:form.Close() }'), 'layout failure closes without an unhandled WinForms dialog');
    assert.ok(win.includes('$form.CancelButton = $cancelButton'));
    assert.ok(win.includes('$form.Add_FormClosing({ $script:input.Clear() })'));
    assert.ok(win.includes('$credential.TargetName = ($script:account + \'.api-key-case\')'));
    const encoded = encodeWindowsHelperCommand(win);
    assert.ok(encoded.length < WINDOWS_HELPER_COMMAND_MAX_CHARS);
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
    const compressed = decoded.match(/FromBase64String\('([^']+)'\)/)?.[1];
    assert.equal(compressed ? gunzipSync(Buffer.from(compressed, 'base64')).toString('utf8') : decoded, win);
    const mac = buildMacOSSecretInputScript(ref);
    new Script(mac);
    const synthetic = service === 'stripe-test' ? 'sk_test_synthetic_test_only' : 'synthetic-format-not-constrained';
    const saved = runSyntheticMac(mac, synthetic);
    assert.equal(saved.status, 0); assert.equal(saved.writes.length, 2);
    assert.equal(saved.writes[0].query.entries.get('account').text, account);
    assert.equal(saved.writes[1].item.entries.get('data').syntheticData, synthetic);
    assert.equal(saved.fields[0].stringValue, '');
    assert.deepEqual(saved.links[0], { text: panel.linkText.en, url, range: { start: 0, length: panel.linkText.en.length } });
    const cancelled = runSyntheticMac(mac, synthetic, 1001);
    assert.equal(cancelled.status, 2); assert.equal(cancelled.writes.length, 0); assert.equal(cancelled.encoded.length, 0);
    assert.equal(cancelled.fields[0].stringValue, '');
    const failure = runSyntheticMac(mac, synthetic, 1000, -50);
    assert.equal(failure.status, 10); assert.equal(failure.fields[0].stringValue, '');
    checks++;
  }
}

const openai = buildCredentialAcquisitionPanel(request('openai'));
assert.ok(openai.steps.some(step => /dedicated OpenAI project/.test(step.en)));
assert.ok(openai.steps.some(step => /Restricted.*required API endpoints/.test(step.en)));
assert.ok(openai.steps.some(step => /required models/.test(step.en)));
assert.ok(!/gpt-|whisper|\/v1\/|example\.com/i.test(JSON.stringify(openai)));
const stripe = buildCredentialAcquisitionPanel(request('stripe-test'));
for (const expected of ['Provider mode: test', 'App environment:', 'broad test privileges', 'Restricted rk_test_', 'sk_live_', 'pk_test_', 'whsec_']) {
  assert.ok(JSON.stringify(stripe).includes(expected)); checks++;
}

const stripeWin = buildWindowsSecretInputScript(request('stripe-test'));
const stripeMac = buildMacOSSecretInputScript(request('stripe-test'));
const winGuard = stripeWin.indexOf("if (-not $value.StartsWith('sk_test_', [StringComparison]::Ordinal)");
assert.ok(winGuard > stripeWin.indexOf('$value = $script:input.Text'));
assert.ok(winGuard < stripeWin.indexOf('$blobSize = [Text.Encoding]::Unicode.GetByteCount($value)'));
assert.ok(winGuard < stripeWin.indexOf('[ApiKeyCaseHumanPlane.Native]::CredWrite([ref]$credential, 0)'));
const refusal = stripeWin.slice(winGuard, stripeWin.indexOf('$blobSize = [Text.Encoding]::Unicode.GetByteCount($value)'));
assert.ok(refusal.includes("$value.Length -le 8"));
assert.ok(refusal.includes("[Text.RegularExpressions.Regex]::IsMatch($value, '\\s')"));
assert.ok(refusal.includes(STRIPE_TEST_INPUT_ERROR.en)); assert.ok(refusal.includes(STRIPE_TEST_INPUT_ERROR.ja));
assert.ok(refusal.includes('$script:input.Clear()')); assert.ok(refusal.includes('$value = $null'));
assert.ok(refusal.includes('Remove-Variable value')); assert.ok(refusal.includes('return'));
assert.ok(!refusal.includes('Write(')); checks++;

for (const invalid of [
  'sk_live_synthetic_refusal', 'pk_test_synthetic_refusal', 'rk_test_synthetic_refusal',
  'whsec_synthetic_refusal', 'SK_TEST_synthetic_refusal', 'sk_test_',
  ' sk_test_synthetic_refusal', 'sk_test_synthetic_refusal\n', 'sk_test_synthetic refusal',
  'synthetic-unrecognized-kind'
]) {
  const result = runSyntheticMac(stripeMac, invalid);
  assert.equal(result.status, 2); assert.equal(result.writes.length, 0); assert.equal(result.encoded.length, 0);
  assert.equal(result.fields[0].stringValue, '');
  assert.equal(result.alerts[1].informativeText, STRIPE_TEST_INPUT_ERROR.en);
  if (invalid !== 'sk_test_') assert.ok(!JSON.stringify(result.alerts).includes(invalid));
  checks++;
}
for (const empty of ['', ' \t ']) {
  const result = runSyntheticMac(stripeMac, empty);
  assert.equal(result.status, 2); assert.equal(result.writes.length, 0); assert.equal(result.fields[0].stringValue, ''); checks++;
}

for (const extra of [
  { environment: 'production', service: 'stripe-test', name: 'STRIPE_API_KEY' },
  { environment: 'staging' }, { scope: 'user', projectId: null }, { projectId: 'invalid' },
  { name: 'OTHER_KEY' }, { service: 'stripe' }, { service: 'unknown' }
]) {
  for (const build of builders) { assert.throws(() => build(request('openai', 'development', extra))); checks++; }
}
for (const service of ['openai', 'stripe-test']) {
  for (const acquisition of [null, [], { sendingDomain: null, destination: 'vercel' }, { url: 'https://attacker.invalid/' }]) {
    for (const build of builders) { assert.throws(() => build(request(service, 'development', { acquisition }))); checks++; }
  }
}

// Resend's existing API, purpose/domain wording and account stay compatible.
for (const environment of ['development', 'preview', 'production']) {
  const ref = request('resend', environment, { acquisition: { sendingDomain: 'mail.example.com', destination: 'vercel' } });
  const panel = buildCredentialAcquisitionPanel(ref);
  assert.deepEqual(panel, buildResendAcquisitionPanel(ref)); assert.equal(panel.linkUrl, RESEND_ACQUISITION_URL);
  assert.ok(panel.steps.some(step => step.en.includes('Sending access')));
  assert.ok(panel.steps.some(step => step.en.includes('mail.example.com')));
  for (const build of [buildWindowsSecretInputScript, buildMacOSSecretInputScript]) {
    const script = build(ref); assert.ok(script.includes(`|resend|${environment}|RESEND_API_KEY`));
    assert.ok(script.includes(RESEND_ACQUISITION_URL)); assert.ok(!script.includes('Stripe test key'));
    assert.ok(!script.includes("StartsWith('sk_test_'")); assert.ok(!script.includes("indexOf('sk_test_')")); checks++;
  }
  new Script(buildMacOSSecretInputScript(ref));
}
const clerkPanel = buildCredentialAcquisitionPanel(request('clerk'));
assert.equal(clerkPanel.linkUrl, CLERK_ACQUISITION_URL);
assert.equal(CLERK_ACQUISITION_URL, "https://dashboard.clerk.com/~/api-keys");
assert.ok(clerkPanel.sections.some(section => section.id === 'warnings'));
assert.ok(buildWindowsSecretInputScript(request('clerk')).includes('$root.RowCount = 3'));
checks += 2;
for (const ref of [ { ...base, name: 'OPENAI_API_KEY' }, { ...base, name: 'STRIPE_API_KEY' },
  { scope: 'user', projectId: null, projectDir: null, name: 'LEGACY_KEY' }]) {
  assert.equal(buildCredentialAcquisitionPanel(ref), null);
  for (const build of [buildWindowsSecretInputScript, buildMacOSSecretInputScript]) {
    const script = build(ref);
    for (const url of [RESEND_ACQUISITION_URL, OPENAI_ACQUISITION_URL, STRIPE_TEST_ACQUISITION_URL]) assert.ok(!script.includes(url));
    assert.ok(!script.includes("StartsWith('sk_test_'")); assert.ok(!script.includes("indexOf('sk_test_')")); checks++;
  }
  new Script(buildMacOSSecretInputScript(ref));
}
console.log(`provider acquisition panel: ${checks} checks passed (synthetic; native rendering pending)`);
