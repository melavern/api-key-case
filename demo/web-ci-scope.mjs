// CI scope is deliberately conservative: only known static Web/maintenance paths
// can skip the cross-platform CLI/OS-store suite. Unknown paths run that suite.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isMain } from './lib/main.mjs';
export function needsProductTests(paths) {
  return paths.some(path => !/^(?:index\.html$|(?:os-support|privacy|terms|refund|tokushoho)\.html$|robots\.txt$|sitemap\.xml$|favicon\.ico$|brand\/|launch-ja[^/]*\.(?:mp4|jpg|vtt)$|demo\/|tests\/(?:site-content|lp-analytics|serve-site)\.mjs$|tools\/web-|docs\/(?:landing-page|analytics)\/|docs\/(?:PUBLISHING|WEB_PUBLICATION)\.md$|docs\/publication\/|verify\.json$)/.test(path));
}
if (isMain(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const base = event.pull_request?.base?.sha ?? event.before;
  const head = event.pull_request?.head?.sha ?? event.after;
  if (![base, head].every(s => /^[a-f0-9]{40}$/.test(s ?? '') && !/^0+$/.test(s))) {
    console.log('product=true'); // manual dispatch, initial push, unknown event
  } else {
    const result = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head], { encoding: 'utf8' });
    console.log(`product=${result.status !== 0 || needsProductTests(result.stdout.split('\0').filter(Boolean))}`);
  }
}
