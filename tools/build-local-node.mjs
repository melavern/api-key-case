// Separate, offline compiler helper. Never runs the app, package scripts or key handoff.
import { builtinModules } from 'node:module';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIVATE = /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519)$/i;
const BUILTINS = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const LOADERS = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.json': 'json' };
function reject() { throw new Error('Unsupported build input.'); }
function ordinary(path, directory = false) {
  for (let part = path; ; part = dirname(part)) {
    const stat = lstatSync(part);
    if (stat.isSymbolicLink()) reject();
    if (dirname(part) === part) break;
  }
  const stat = lstatSync(path);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) reject();
  return stat;
}
function contained(root, path) {
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).some(x => PRIVATE.test(x))) reject();
}
function sourcePath(root, requested) {
  contained(root, requested);
  if (requested !== join(root, 'package.json') && !['src', 'app', 'server', 'lib', 'pages'].includes(relative(root, requested).split(sep)[0])) reject();
  const candidates = [requested];
  if (!extname(requested)) for (const extension of Object.keys(LOADERS)) candidates.push(requested + extension);
  if (requested.endsWith('.js')) candidates.push(requested.slice(0, -3) + '.ts');
  for (const extension of Object.keys(LOADERS)) candidates.push(join(requested, 'index' + extension));
  for (const path of candidates) {
    try { contained(root, path); const stat = lstatSync(path); if (stat.isDirectory()) continue; ordinary(path); return path; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  reject();
}
function readInput(root, path) {
  contained(root, path);
  const before = ordinary(path);
  if (before.size > 2 * 1024 * 1024) reject();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = fstatSync(fd);
    if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) reject();
    const content = Buffer.alloc(before.size + 1); let bytes = 0;
    while (bytes < content.length) { const count = readSync(fd, content, bytes, content.length - bytes, bytes); if (!count) break; bytes += count; }
    const final = fstatSync(fd);
    if (bytes !== before.size || final.size !== before.size || final.mtimeMs !== before.mtimeMs || final.ctimeMs !== before.ctimeMs) reject();
    return content.subarray(0, bytes);
  } finally { closeSync(fd); }
}

/** Result is compiler output only, never permission, launch readiness or provenance. */
export async function buildLocalNode(projectDir, entry) {
  const unavailable = { status: 'unavailable', artifact: null, permission: 'none', applicationReadiness: 'not-verified' };
  try {
    if (typeof projectDir !== 'string' || typeof entry !== 'string' ||
        !/^(?:src|app|server|lib|pages)\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:[cm]?js|[cm]?ts)$/.test(entry) ||
        Object.hasOwn(process.env, 'ESBUILD_BINARY_PATH') || Object.hasOwn(process.env, 'RESEND_API_KEY')) return unavailable;
    const requested = resolve(projectDir); ordinary(requested, true);
    const root = realpathSync(requested);
    readInput(root, join(root, 'package.json'));
    const locks = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].filter(name => {
      try { ordinary(join(root, name)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    });
    if (locks.length !== 1) return unavailable;
    readInput(root, join(root, locks[0]));
    const { build, version } = await import('esbuild');
    if (version !== '0.28.1') return unavailable;
    const seen = new Set(); let total = 0;
    const output = await build({ absWorkingDir: root, entryPoints: [join(root, entry)],
      bundle: true, platform: 'node', format: 'cjs', target: 'node20', write: false,
      outfile: 'dist/api-key-case.cjs', sourcemap: false, metafile: true, logLevel: 'silent',
      tsconfigRaw: '{}', preserveSymlinks: true, nodePaths: [],
      logOverride: { 'unsupported-dynamic-import': 'error', 'unsupported-require-call': 'error' },
      plugins: [{ name: 'bounded-local-source', setup(context) {
        // Own every resolution: the compiler never loads project/dependency metadata.
        // Installed packages remain runtime dependencies under the adopted app trust boundary.
        context.onResolve({ filter: /.*/ }, args => {
          try {
            if (args.kind === 'entry-point') return { path: sourcePath(root, args.path), namespace: 'app-source' };
            if (BUILTINS.has(args.path)) return { path: args.path, external: true };
            if (args.path.startsWith('./') || args.path.startsWith('../')) {
              return { path: sourcePath(root, resolve(dirname(args.importer), args.path)), namespace: 'app-source' };
            }
            if (/^(?:@[A-Za-z0-9_-]+\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(args.path)) {
              return { path: args.path, external: true };
            }
            reject();
          } catch { return { errors: [{ text: 'Unsupported build input.' }] }; }
        });
        context.onLoad({ filter: /.*/ }, args => {
          try {
            const loader = LOADERS[extname(args.path)]; if (!loader) reject();
            const contents = readInput(root, args.path);
            if (!seen.has(args.path)) { seen.add(args.path); total += contents.length; }
            if (seen.size > 1024 || total > 16 * 1024 * 1024) reject();
            return { contents, loader };
          } catch { return { errors: [{ text: 'Unsupported build input.' }] }; }
        });
      } }]
    });
    if (output.warnings.length || output.outputFiles.length !== 1 || output.outputFiles[0].contents.length > 16 * 1024 * 1024 ||
        Object.keys(output.metafile.outputs).length !== 1) return unavailable;
    // New artifact every time: never replace an app's build output or an active session artifact.
    if (realpathSync(requested) !== root) return unavailable;
    ordinary(root, true);
    const dist = join(root, 'dist');
    try { mkdirSync(dist); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    ordinary(dist, true);
    const artifact = `dist/akc-${randomUUID()}.cjs`;
    writeFileSync(join(root, artifact), output.outputFiles[0].contents, { flag: 'wx', mode: 0o600 });
    return { ...unavailable, status: 'built', artifact };
  } catch { return unavailable; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [project, flag, entry, ...extra] = process.argv.slice(2);
  const result = flag === '--entry' && extra.length === 0
    ? await buildLocalNode(project, entry)
    : { status: 'unavailable', artifact: null, permission: 'none', applicationReadiness: 'not-verified' };
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'built' ? 0 : 1;
}
