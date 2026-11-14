// Bundles the server into ONE file that needs no node_modules, puts it inside the plugin, and
// writes the notices of every third-party package that ended up in the bundle next to it.
// The build stops when the licence text of one of them cannot be found.
// Usage: node build.mjs
import { build } from 'esbuild';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const outdir = '../plugins/portaldot-dev/server';
const outfile = `${outdir}/index.mjs`;

// CommonJS code inside the bundle (ws, bn.js and others) calls require('events') and the like.
// An ES module has no `require`, so it is given one. Without this line the bundle stops at start
// with: Dynamic require of "events" is not supported.
const banner = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

const result = await build({
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
for (const [dir, name] of [...packages].sort((a, b) => a[1].localeCompare(b[1]))) {
  // A package may nest its package.json above a build folder; walk up to the one that names it.
  let pkgDir = dir;
  while (!existsSync(join(pkgDir, 'package.json')) && dirname(pkgDir) !== pkgDir) pkgDir = dirname(pkgDir);
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const licenceFile = readdirSync(pkgDir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
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
notices.sort((a, b) => a.name.localeCompare(b.name));

const header = [
  'THIRD-PARTY NOTICES',
  '',
  `The file index.mjs in this folder is a bundle. Besides this project's own code it contains code from the ${notices.length} packages listed below,`,
  'each under its own licence. Their notices and licence texts follow.',
  '',
].join('\n');
writeFileSync(`${outdir}/THIRD-PARTY-NOTICES.txt`, `${header}\n${notices.map((n) => `${'='.repeat(78)}\n${n.text}\n`).join('\n')}`);

console.log(`${outfile}  ${(statSync(outfile).size / 1024).toFixed(1)} KB`);
console.log(`${outdir}/THIRD-PARTY-NOTICES.txt  ${notices.length} packages, ${inner.size} of them inside another package's build files`);
