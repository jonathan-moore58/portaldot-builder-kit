// Bundles the server into ONE file that needs no node_modules, puts it inside the plugin, and
// writes the notices of every third-party package that ended up in the bundle next to it.
// The build stops when the licence text of one of them cannot be found.
//
// Usage (from any folder; a relative --outdir is read from the folder you are in):
//   node build.mjs                    build into the plugin: plugins/portaldot-dev/server
//   node build.mjs --outdir=<folder>  build into another folder; the plugin folder is not touched
//   node build.mjs --check            build into a folder of its own in the system's temp folder (or
//                                     into --outdir), then fail when the bundle or the notices differ
//                                     from the ones committed in the plugin folder. It does not
//                                     regenerate src/generated: "node scripts/gen-knowledge.mjs --check" checks that.
// Nothing in the output may depend on the folder it is written to or on the machine's language
// settings, so that --check can compare it byte for byte on every machine.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const unknown = args.find((a) => a !== '--check' && !/^--outdir=./.test(a));
if (unknown) {
  console.error(`Unknown option: ${unknown}. The options are --outdir=<folder> and --check.`);
  process.exit(2);
}
const check = args.includes('--check');
const outdirArg = args.find((a) => a.startsWith('--outdir='))?.slice('--outdir='.length);
// --outdir is read from the folder the command was given in; everything else from server-src.
const outdirGiven = outdirArg ? resolve(outdirArg) : null;
const HERE = dirname(fileURLToPath(import.meta.url));
process.chdir(HERE);

const PLUGIN_SERVER = resolve('../plugins/portaldot-dev/server');
const OUTPUTS = ['index.mjs', 'THIRD-PARTY-NOTICES.txt'];
const outdir = outdirGiven ?? (check ? join(tmpdir(), 'portaldot-builder-kit-check') : PLUGIN_SERVER);
if (check && relative(outdir, PLUGIN_SERVER) === '') {
  console.error('--check compares a fresh build with the committed one, so it cannot build into the plugin folder. Give another --outdir, or none.');
  process.exit(2);
}
const outfile = join(outdir, 'index.mjs');

// Code points, not localeCompare: the order of the notices must not depend on the machine's language settings.
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The first line lets npm and npx start the bundle as a command (the "bin" of the package.json at
// the root of the repository); Node skips it. On Windows, npm's command wrapper reads it to know that
// node runs the file.
// CommonJS code inside the bundle (ws, bn.js and others) calls require('events') and the like.
// An ES module has no `require`, so it is given one. Without that line the bundle stops at start
// with: Dynamic require of "events" is not supported.
const banner = "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

const result = await build({
  // esbuild keeps the folder it was loaded in, so it is told; the paths in its metafile are read from here too.
  absWorkingDir: HERE,
  entryPoints: ['src/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: true,
  legalComments: 'none',
  banner: { js: banner },
  // The WebSocket library would look for two optional native add-ons in node_modules of every
  // folder above the plugin. They are not needed, and a folder above the plugin is not ours.
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
  metafile: true,
  logLevel: 'warning',
});

// Which packages are inside the bundle: every input path under node_modules names one.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const at = input.lastIndexOf('node_modules/');
  if (at < 0) continue;
  const rest = input.slice(at + 'node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  const dir = join(input.slice(0, at), 'node_modules', name);
  if (!packages.has(dir)) packages.set(dir, name);
}

// Licence texts that cannot be read from node_modules are kept in third-party-licences/, one folder
// per package and version (LICENSE, and meta.json with the licence name and the source): for a
// package that ships no licence file, and for packages that arrive inside another package's build files.
function stored(name, version) {
  const dir = join('third-party-licences', `${name.replace('/', '+')}@${version}`);
  if (!existsSync(join(dir, 'LICENSE'))) return null;
  const meta = existsSync(join(dir, 'meta.json')) ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) : {};
  return { ...meta, text: readFileSync(join(dir, 'LICENSE'), 'utf8').trim() };
}

const notices = [];
const missing = [];
const listed = new Set();
for (const [dir, name] of [...packages].sort((a, b) => byName(a[1], b[1]))) {
  // A package may nest its package.json above a build folder; walk up to the one that names it.
  let pkgDir = dir;
  while (!existsSync(join(pkgDir, 'package.json')) && dirname(pkgDir) !== pkgDir) pkgDir = dirname(pkgDir);
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  // Sorted, because each file system lists a folder in its own order, and a package may ship two licence files.
  const licenceFile = readdirSync(pkgDir).sort().find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
  const text = (licenceFile ? readFileSync(join(pkgDir, licenceFile), 'utf8').trim() : '') || stored(pkg.name, pkg.version)?.text || '';
  if (!text) missing.push(`${pkg.name}@${pkg.version}`);
  listed.add(pkg.name);
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
  notices.push({
    name: pkg.name,
    text: [`${pkg.name} ${pkg.version}`, `Licence: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'not stated')}`, repo && `Source: ${repo}`, '', text]
      .filter((l) => l !== false && l !== undefined)
      .join('\n'),
  });
}

// Packages inside packages. Some packages ship build files with their own dependencies already
// bundled in (the MCP SDK carries ajv and others this way), so esbuild sees one package where there
// are several. The source map beside such a file names them. Only files that put bytes into the
// output count, so a dependency that was left out of the bundle is not listed.
const inner = new Map();
for (const [input, info] of Object.entries(Object.values(result.metafile.outputs)[0].inputs)) {
  const at = input.lastIndexOf('node_modules/');
  if (at < 0 || !info.bytesInOutput || !existsSync(`${input}.map`)) continue;
  const rest = input.slice(at + 'node_modules/'.length).split('/');
  const outer = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  let sources = [];
  try {
    sources = JSON.parse(readFileSync(`${input}.map`, 'utf8')).sources ?? [];
  } catch {
    continue; // not a source map
  }
  for (const source of sources) {
    // .../node_modules/.pnpm/<name>@<version>[_<peers>]/node_modules/<name>/..., or plain .../node_modules/<name>/...
    const m = /node_modules\/(?:\.pnpm\/([^/]+)\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(source);
    if (!m || m[2] === outer || listed.has(m[2])) continue;
    const version = m[1] ? /^@?[^@]+@([^_]+)/.exec(m[1])?.[1] : undefined;
    inner.set(`${m[2]}@${version ?? '?'}`, { name: m[2], version, inside: outer });
  }
}
for (const { name, version, inside } of inner.values()) {
  const found = version ? stored(name, version) : null;
  if (!found) {
    missing.push(`${name}@${version ?? 'unknown version'} (inside ${inside})`);
    continue;
  }
  notices.push({
    name,
    text: [`${name} ${version}`, `Licence: ${found.license ?? 'not stated'}`, found.repository && `Source: ${found.repository}`, `Bundled inside ${inside}, which ships it in its own build files.`, '', found.text]
      .filter((l) => l !== false && l !== undefined)
      .join('\n'),
  });
}
if (missing.length) {
  console.error(`No licence text for: ${missing.join(', ')}.`);
  console.error('Put the text from the package itself in third-party-licences/<name>@<version>/LICENSE (a scoped name with + for /), then build again.');
  process.exit(1);
}
notices.sort((a, b) => byName(a.name, b.name));

const header = [
  'THIRD-PARTY NOTICES',
  '',
  `The file index.mjs in this folder is a bundle. Besides this project's own code it contains code from the ${notices.length} packages listed below,`,
  'each under its own licence. Their notices and licence texts follow.',
  '',
].join('\n');
writeFileSync(join(outdir, 'THIRD-PARTY-NOTICES.txt'), `${header}\n${notices.map((n) => `${'='.repeat(78)}\n${n.text}\n`).join('\n')}`);

console.log(`${outfile}  ${(statSync(outfile).size / 1024).toFixed(1)} KB`);
console.log(`${join(outdir, 'THIRD-PARTY-NOTICES.txt')}  ${notices.length} packages, ${inner.size} of them inside another package's build files`);

if (check) {
  const sha256 = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null);
  let differ = 0;
  for (const name of OUTPUTS) {
    const fresh = sha256(join(outdir, name));
    const committed = sha256(join(PLUGIN_SERVER, name));
    if (fresh !== committed) differ++;
    console.log(`${fresh === committed ? 'same     ' : 'DIFFERENT'} ${name}  fresh build sha256 ${fresh}, committed ${committed ?? '(missing)'}`);
  }
  if (differ) {
    console.error('The committed bundle is not what this source builds. Run "npm run build" in server-src, then commit both files in plugins/portaldot-dev/server.');
    process.exit(1);
  }
  console.log('The committed bundle and its notices are exactly what this source builds.');
}
