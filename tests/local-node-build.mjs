import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildLocalNode } from '../tools/build-local-node.mjs';
import { LocalLaunchSnapshot } from '../dist/core/local/snapshot.js';

export async function runLocalNodeBuildTests() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'akc-node-build-')));
  const require = createRequire(import.meta.url); let checks = 0, index = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks++; };
  function fixture() {
    const project = join(root, `project ${++index}`);
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'test-app', private: true, type: 'module', scripts: { build: 'node do-not-run.cjs', postinstall: 'node do-not-run.cjs' } }));
    writeFileSync(join(project, 'package-lock.json'), '{"lockfileVersion":3}');
    writeFileSync(join(project, 'do-not-run.cjs'), 'throw new Error("must not execute");');
    writeFileSync(join(project, 'esbuild.config.mjs'), 'throw new Error("must not load config");');
    writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ extends: './missing-config.json' }));
    writeFileSync(join(project, 'src', 'message.ts'), 'export const message = (name: string): string => "Hello " + name;');
    writeFileSync(join(project, 'src', 'main.ts'), 'import { message } from "./message"; export async function notify(send: (s: string) => Promise<string>) { return send(message("test")); }');
    return project;
  }
  async function rejected(project, entry) {
    const result = await buildLocalNode(project, entry);
    check(result.status === 'unavailable' && result.artifact === null, 'closed build refusal');
    check(result.permission === 'none' && result.applicationReadiness === 'not-verified', 'no readiness/permission');
    return result;
  }
  try {
    const project = fixture(), packageBefore = readFileSync(join(project, 'package.json'), 'utf8');
    const built = await buildLocalNode(project, 'src/main.ts');
    check(built.status === 'built' && /^dist\/akc-[a-f0-9-]+\.cjs$/.test(built.artifact), 'ordinary TS modules bundle into accepted artifact shape');
    check(built.permission === 'none' && built.applicationReadiness === 'not-verified', 'build is not launch authority');
    check(readFileSync(join(project, 'package.json'), 'utf8') === packageBefore, 'app manifest untouched');
    const app = require(join(project, built.artifact)); let sent = 0;
    check(await app.notify(async text => { sent++; assert.equal(text, 'Hello test'); return 'mock-accepted'; }) === 'mock-accepted' && sent === 1, 'normal app feature uses only in-process fake provider');
    const snapshot = new LocalLaunchSnapshot(project, built.artifact);
    check(snapshot.current(), 'existing unchanged launcher snapshot accepts generated artifact');
    const rebuilt = await buildLocalNode(project, 'src/main.ts');
    check(rebuilt.status === 'built' && rebuilt.artifact !== built.artifact && existsSync(join(project, built.artifact)), 'rebuild preserves prior artifact');
    writeFileSync(join(project, 'src', 'message.ts'), 'export const message = () => "changed";');
    check(!snapshot.current(), 'source edit invalidates existing snapshot');

    const dep = fixture(); mkdirSync(join(dep, 'node_modules', 'tiny-greeting'), { recursive: true });
    writeFileSync(join(dep, 'node_modules', 'tiny-greeting', 'package.json'), '{"name":"tiny-greeting","main":"index.js","scripts":{"postinstall":"node never.js"}}');
    writeFileSync(join(dep, 'node_modules', 'tiny-greeting', 'index.js'), 'module.exports = "bundled dependency";');
    writeFileSync(join(dep, 'src', 'main.ts'), 'import value from "tiny-greeting"; export const answer: string = value;');
    const depBuilt = await buildLocalNode(dep, 'src/main.ts');
    check(depBuilt.status === 'built' && require(join(dep, depBuilt.artifact)).answer === 'bundled dependency', 'installed ordinary JS dependency resolves at runtime; no install hooks');
    check(readFileSync(join(dep, depBuilt.artifact), 'utf8').includes('tiny-greeting'), 'package remains an explicit runtime dependency');

    const opaqueDependency = fixture(); mkdirSync(join(opaqueDependency, 'node_modules', 'unread-package'), { recursive: true });
    writeFileSync(join(opaqueDependency, 'node_modules', 'unread-package', 'package.json'), 'not valid JSON: PRIVATE_METADATA_CANARY');
    writeFileSync(join(opaqueDependency, 'src', 'main.ts'), 'import value from "unread-package"; export const answer = value;');
    check((await buildLocalNode(opaqueDependency, 'src/main.ts')).status === 'built', 'build does not parse dependency manifests');
    const localDirectory = fixture(); mkdirSync(join(localDirectory, 'src', 'folder'));
    writeFileSync(join(localDirectory, 'src', 'folder', 'package.json'), 'not valid JSON: PRIVATE_METADATA_CANARY');
    writeFileSync(join(localDirectory, 'src', 'folder', 'index.ts'), 'export default "index module";');
    writeFileSync(join(localDirectory, 'src', 'main.ts'), 'import value from "./folder"; export const answer = value;');
    const directoryBuild = await buildLocalNode(localDirectory, 'src/main.ts');
    check(directoryBuild.status === 'built' && require(join(localDirectory, directoryBuild.artifact)).answer === 'index module', 'local directory resolution ignores manifests');

    const noRun = fixture(), marker = join(noRun, 'app-ran');
    writeFileSync(join(noRun, 'src', 'main.ts'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad');`);
    check((await buildLocalNode(noRun, 'src/main.ts')).status === 'built' && !existsSync(marker), 'compiler never runs app top-level code');
    for (const entry of ['../outside.ts', 'dist/app.cjs', 'src/main.ts --watch', '/absolute.ts', 'src/.env']) await rejected(project, entry);
    const missing = fixture(); rmSync(join(missing, 'package-lock.json')); await rejected(missing, 'src/main.ts');
    const multiple = fixture(); writeFileSync(join(multiple, 'yarn.lock'), 'synthetic'); await rejected(multiple, 'src/main.ts');
    const invalid = fixture(); writeFileSync(join(invalid, 'src', 'main.ts'), 'const PRIVATE_DIAGNOSTIC_CANARY = ;');
    const error = await rejected(invalid, 'src/main.ts'); check(!JSON.stringify(error).includes('PRIVATE_DIAGNOSTIC_CANARY'), 'compiler diagnostics omitted');
    for (const code of ['const path = process.argv[2]; import(path);', 'const path = process.argv[2]; require(path);']) {
      const dynamic = fixture(); writeFileSync(join(dynamic, 'src', 'main.ts'), code); await rejected(dynamic, 'src/main.ts');
    }
    const outsideInputs = fixture(); writeFileSync(join(outsideInputs, 'untracked.ts'), 'export const value = 1;');
    writeFileSync(join(outsideInputs, 'src', 'main.ts'), 'import {value} from "../untracked"; console.log(value);'); await rejected(outsideInputs, 'src/main.ts');
    const unsupported = fixture(); writeFileSync(join(unsupported, 'src', 'main.ts'), 'import "./missing.node";'); await rejected(unsupported, 'src/main.ts');
    const outputFile = fixture(); writeFileSync(join(outputFile, 'dist'), 'preserve'); await rejected(outputFile, 'src/main.ts'); check(readFileSync(join(outputFile, 'dist'), 'utf8') === 'preserve', 'existing output object preserved');
    if (process.platform !== 'win32') {
      const linked = fixture(); symlinkSync(join(root, 'absent'), join(linked, 'dist')); await rejected(linked, 'src/main.ts');
      const sourceLink = fixture(); rmSync(join(sourceLink, 'src', 'main.ts')); symlinkSync(join(project, 'src', 'main.ts'), join(sourceLink, 'src', 'main.ts')); await rejected(sourceLink, 'src/main.ts');
    }
    const tool = fileURLToPath(new URL('../tools/build-local-node.mjs', import.meta.url));
    const cli = spawnSync(process.execPath, [tool, project, '--entry', 'src/main.ts'], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? '' } });
    check(cli.status === 0 && cli.stderr === '' && JSON.parse(cli.stdout).status === 'built', 'closed CLI output');
    const blocked = spawnSync(process.execPath, [tool, project, '--entry', 'src/main.ts'], { encoding: 'utf8', env: { PATH: process.env.PATH, RESEND_API_KEY: 'synthetic-build-canary' } });
    check(blocked.status === 1 && !blocked.stdout.includes('synthetic-build-canary') && blocked.stderr === '', 'secret-bearing environment refuses before compiler');
    check(readdirSync(project).every(name => !name.startsWith('.env')), 'helper creates no secret/config input file');
    console.log(`Local Node build: ${checks} checks passed (mock provider only).`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runLocalNodeBuildTests();
