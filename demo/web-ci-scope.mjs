// CI scope is deliberately conservative: only known static Web/maintenance paths
// and prose paths can skip the cross-platform CLI/OS-store suite. Unknown paths run that suite.
//
// It also decides how wide a run is. A push or PR is a hand-off between agents, not a
// request for evidence: in the Private repository only an explicit manual dispatch reaches
// this script (ci.yml gates the scope job on visibility), and the dispatch chooses its
// breadth. The Public repository keeps the automatic PR/main gate for outside changes.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isMain } from './lib/main.mjs';

const PROSE = /^(?:docs\/.*\.md$|README(?:\.ja)?\.md$|CHANGELOG\.md$|SECURITY\.md$|SUPPORT\.md$|AGENTS\.md$|\.development\/(?:roadmap|decisions)\.json$)/;
const WEB = /^(?:index\.html$|(?:os-support|privacy|terms|refund|tokushoho)\.html$|robots\.txt$|sitemap\.xml$|favicon\.ico$|brand\/|launch-ja[^/]*\.(?:mp4|jpg|vtt)$|demo\/|tests\/(?:site-content|lp-analytics|serve-site)\.mjs$|tools\/web-|docs\/(?:landing-page|analytics)\/|docs\/(?:PUBLISHING|WEB_PUBLICATION)\.md$|docs\/publication\/|verify\.json$)/;

export function needsProductTests(paths) {
  return paths.filter(path => !PROSE.test(path)).some(path => !WEB.test(path));
}

/** prose: nothing executable changed; web: only the static site lane; product: anything else. */
export function classifyChanges(paths) {
  if (needsProductTests(paths)) return 'product';
  return paths.some(path => !PROSE.test(path)) ? 'web' : 'prose';
}

const REPRESENTATIVE = [{ os: 'ubuntu-latest', 'node-version': 22 }];
const PORTABLE = [
  { os: 'ubuntu-latest', 'node-version': 20 },
  { os: 'ubuntu-latest', 'node-version': 22 },
  { os: 'ubuntu-latest', 'node-version': 24 },
  { os: 'macos-latest', 'node-version': 24 },
  { os: 'windows-latest', 'node-version': 24 },
];
const KEYRING_OS = ['ubuntu-latest', 'macos-latest', 'windows-latest'];
export const BREADTHS = ['representative', 'keyring', 'full'];

/**
 * Plan for one CI run. Manual dispatch always means product evidence was requested, so
 * its width comes from the input alone: one representative environment unless OS stores
 * or the full Node/OS range were asked for. An unknown breadth fails instead of narrowing.
 */
export function ciPlan({ eventName, product, breadth }) {
  if (eventName === 'workflow_dispatch') {
    const chosen = breadth || 'representative';
    if (!BREADTHS.includes(chosen)) throw new Error(`unknown breadth: ${chosen}`);
    return {
      product: true,
      test: chosen === 'full' ? PORTABLE : REPRESENTATIVE,
      keyring: chosen === 'representative' ? [] : KEYRING_OS,
      package: true,
    };
  }
  return { product, test: product ? PORTABLE : [], keyring: product ? KEYRING_OS : [], package: product };
}

export function planOutputs(plan) {
  return [
    `product=${plan.product}`,
    `test=${JSON.stringify(plan.test)}`,
    `keyring=${JSON.stringify(plan.keyring)}`,
    `package=${plan.package}`,
  ].join('\n');
}

function eventProduct(event) {
  const base = event.pull_request?.base?.sha ?? event.before;
  const head = event.pull_request?.head?.sha ?? event.after;
  if (![base, head].every(s => /^[a-f0-9]{40}$/.test(s ?? '') && !/^0+$/.test(s))) return true; // initial push, unknown event
  // PR validation follows GitHub's three-dot diff, not changes made only on the base branch.
  const range = event.pull_request ? [`${base}...${head}`] : [base, head];
  const result = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', ...range], { encoding: 'utf8' });
  return result.status !== 0 || needsProductTests(result.stdout.split('\0').filter(Boolean));
}

if (isMain(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  const product = eventName === 'workflow_dispatch' || eventProduct(event);
  console.log(planOutputs(ciPlan({ eventName, product, breadth: event.inputs?.breadth })));
}
