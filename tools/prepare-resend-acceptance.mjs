// Offline preparation/status only. Never reads a key, launches an app or calls a provider.
import { mkdirSync, realpathSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP = 'api-key-case-resend-acceptance';
const email = value => typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value);
const outcomes = new Set(['offline-checked', 'provider-accepted', 'provider-rejected', 'blocked', 'unknown']);
function jsonFile(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) throw new Error('Unavailable');
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function prepareResendAcceptance(destination, options = {}) {
  if (Object.keys(options).some(key => !['mode', 'from', 'to'].includes(key))) throw new Error('Unsupported preparation');
  const mode = options.mode ?? 'offline';
  if (!['offline', 'live'].includes(mode) || (mode === 'offline' && (options.from || options.to)) ||
      (mode === 'live' && (!email(options.from) || !email(options.to)))) throw new Error('Invalid preparation');
  const requested = resolve(destination), projectRoot = join(realpathSync(dirname(requested)), basename(requested));
  // Never overwrite/re-prepare an existing app, attempt or unrelated project.
  mkdirSync(projectRoot);
  const id = randomUUID(), createdAt = Date.now();
  const plan = { version: 1, id, mode, projectRoot, createdAt, expiresAt: createdAt + 30 * 60 * 1000,
    from: mode === 'live' ? options.from : 'sender@example.invalid',
    to: mode === 'live' ? options.to : 'recipient@example.invalid',
    subject: 'API Key Case connection acceptance ' + id.slice(0, 8),
    text: 'This is the single approved API Key Case Resend development acceptance message.' };
  const template = readFileSync(new URL('./acceptance/resend-app.cjs', import.meta.url), 'utf8');
  if (template.split('/* acceptance-plan */ null').length !== 2) throw new Error('Template unavailable');
  const artifact = template.replace('/* acceptance-plan */ null', () => 'Object.freeze(' + JSON.stringify(plan) + ')');
  for (const folder of ['src', 'dist', 'acceptance-results', 'acceptance-results/' + id]) mkdirSync(join(projectRoot, folder));
  const manifest = { name: APP, version: '0.0.0', private: true, type: 'commonjs' };
  const files = { 'package.json': JSON.stringify(manifest),
    'package-lock.json': JSON.stringify({ name: APP, version: '0.0.0', lockfileVersion: 3, packages: { '': manifest } }),
    'src/app.cjs': artifact, 'dist/app.cjs': artifact, 'acceptance-plan.json': JSON.stringify(plan, null, 2),
    '.gitignore': '.env\n.env.*\nacceptance-results/\n' };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(projectRoot, name), content, { flag: 'wx', mode: 0o600 });
  return { status: 'prepared', app: APP, mode, artifact: 'dist/app.cjs', permission: 'none' };
}
export function readResendAcceptance(destination) {
  const unknown = { app: APP, outcome: 'unknown', inbox: 'not-observed', authority: 'application-reported', permission: 'none' };
  try {
    const root = realpathSync(destination), plan = jsonFile(join(root, 'acceptance-plan.json'));
    if (plan.version !== 1 || !['offline', 'live'].includes(plan.mode) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(plan.id) || plan.projectRoot !== root) return unknown;
    const folder = join(root, 'acceptance-results', plan.id);
    if (realpathSync(folder) !== folder || lstatSync(folder).isSymbolicLink()) return unknown;
    const attempt = jsonFile(join(folder, 'attempt.json'));
    if (Object.keys(attempt).sort().join() !== 'outcome,planId,version' || attempt.version !== 1 || attempt.planId !== plan.id || attempt.outcome !== 'unknown') return unknown;
    const result = jsonFile(join(folder, 'result.json'));
    if (Object.keys(result).sort().join() !== 'authority,inbox,outcome,permission,planId,request,version' ||
        result.version !== 1 || result.planId !== plan.id || !outcomes.has(result.outcome) ||
        !['not-started', 'attempted'].includes(result.request) || result.inbox !== 'not-observed' ||
        result.authority !== 'application-reported' || result.permission !== 'none') return unknown;
    const coherent = plan.mode === 'offline'
      ? result.outcome === 'offline-checked' && result.request === 'not-started'
      : (result.outcome === 'blocked' && result.request === 'not-started') ||
        (['provider-accepted', 'provider-rejected', 'unknown'].includes(result.outcome) && result.request === 'attempted');
    if (!coherent) return unknown;
    return { ...unknown, outcome: result.outcome, request: result.request };
  } catch { return unknown; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [command, destination, ...args] = process.argv.slice(2);
    if (!destination) throw new Error('Missing project');
    let result;
    if (command === 'status' && args.length === 0) result = readResendAcceptance(destination);
    else if (command === 'prepare') {
      const options = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--live' && !options.mode) options.mode = 'live';
        else if (['--from', '--to'].includes(args[i]) && !options[args[i].slice(2)] && args[i + 1]) options[args[i].slice(2)] = args[++i];
        else throw new Error('Unsupported option');
      }
      result = prepareResendAcceptance(destination, options);
    } else throw new Error('Unsupported command');
    console.log(JSON.stringify(result));
  } catch { console.log(JSON.stringify({ status: 'unavailable', permission: 'none' })); process.exitCode = 1; }
}
