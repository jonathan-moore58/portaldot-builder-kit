// Smoke test of a built server. It starts the server over stdio the way an MCP client does, lists
// the tools, calls three that need no network (convert_amount, convert_address and read_guide), and
// lists the resources and the prompts. It needs only
// Node.js 20 or newer and no packages, so it runs before "npm ci". The server is given endpoints
// that it refuses at once, so no call can reach a node; only --npx uses the network, for npx to
// fetch the package.
//
// Usage, from server-src:
//   node test/smoke.test.mjs                  the committed bundle, plugins/portaldot-dev/server/index.mjs
//   node test/smoke.test.mjs --server=<path>  another build of the server
//   node test/smoke.test.mjs --npx=<spec>     the server the way npx starts it, for example
//                                             --npx=github:jonathan-moore58/portaldot-builder-kit
// Exit code 0 when every check passes.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COMMITTED = resolve(ROOT, 'plugins/portaldot-dev/server/index.mjs');

const argv = process.argv.slice(2);
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const unknown = argv.find((a) => !/^--(server|npx)=./.test(a));
if (unknown) {
  console.error(`Unknown option: ${unknown}. The options are --server=<path> and --npx=<spec>.`);
  process.exit(2);
}
const npxSpec = opt('npx');
const serverPath = npxSpec ? null : resolve(opt('server') ?? COMMITTED);
const isCommitted = serverPath === COMMITTED;
// On Windows npx is a .cmd file, which Node starts only through the shell, so the spec is passed
// through cmd.exe: anything the shell would read as an instruction is refused.
if (npxSpec && !/^[\w@.:/\\#+~=-]+$/.test(npxSpec)) {
  console.error(`--npx takes a package spec such as github:jonathan-moore58/portaldot-builder-kit, without spaces or shell characters. Got: ${npxSpec}`);
  process.exit(2);
}
// npx runs an existing file as a command instead of installing it (Windows then opens a tarball in
// the file manager), so a local package is given as file:<path>.
if (npxSpec && existsSync(npxSpec)) {
  console.error(`${npxSpec} is a file or folder, which npx would run as a command instead of installing it. Write it as file:${npxSpec}`);
  process.exit(2);
}
if (serverPath && !existsSync(serverPath)) {
  console.error(`No server at ${serverPath}. Build it with "npm run build", or give its path with --server=<path>.`);
  process.exit(2);
}

// npx may first have to fetch and install the package; a server file starts in about a second.
const START_LIMIT_MS = npxSpec ? 300_000 : 30_000;
const CALL_LIMIT_MS = 30_000;
const EXIT_LIMIT_MS = 10_000;

const TREASURY_SS58 = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const TREASURY_H160 = '0x8ddee436166f311ddeed36d714b08f512670d16e';
const TREASURY_ID = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'; // "modlpy/trsry", then zeros
// A public test phrase from the BIP-39 test vectors: it must be refused like a real one.
const TEST_PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

let failed = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `\n       ${String(detail).replace(/\n/g, '\n       ').slice(0, 900)}` : ''}`);
};

// The server's own settings are replaced: an endpoint with a scheme that is not ws:// or http:// is
// refused before anything is opened, so a tool that wants the chain answers at once that it could not ask it.
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^PORTALDOT_/i.test(key)) delete env[key];
for (const key of ['PORTALDOT_TESTNET_WS', 'PORTALDOT_MAINNET_WS', 'PORTALDOT_TESTNET_EVM', 'PORTALDOT_MAINNET_EVM']) env[key] = 'offline://smoke-test';

const stdio = ['pipe', 'pipe', 'pipe'];
const child = !npxSpec
  ? spawn(process.execPath, [serverPath], { env, stdio, windowsHide: true })
  : process.platform === 'win32'
    ? spawn(`npx -y ${npxSpec}`, { env, stdio, shell: true, windowsHide: true })
    : spawn('npx', ['-y', npxSpec], { env, stdio });
console.log(`server: ${npxSpec ? `npx -y ${npxSpec}` : serverPath}; node ${process.version} on ${process.platform}`);

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => (stderr += chunk));

// Requests waiting for their answer, by id.
const pending = new Map();
let exited = null;
const exitWaiters = [];
child.on('exit', (code, signal) => {
  exited = { code, signal };
  for (const [, waiter] of pending) waiter.reject(new Error(`the server ended (exit code ${code}${signal ? `, signal ${signal}` : ''}) before it answered`));
  pending.clear();
  for (const done of exitWaiters) done();
});
child.on('error', (err) => {
  console.log(`FAIL could not start the server: ${err.message}`);
  process.exit(1);
});

// stdout carries the protocol: one JSON-RPC message per line, and nothing else.
const stray = [];
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
    const line = buffer.slice(0, nl).replace(/\r$/, '');
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      stray.push(line);
      continue;
    }
    const waiter = msg && msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (waiter) {
      pending.delete(msg.id);
      waiter.resolve(msg);
    }
  }
});

// Writing to a server that has already ended fails with EPIPE; the exit handler above reports that.
child.stdin.on('error', () => undefined);
let nextId = 0;
const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
function request(method, params, limitMs = CALL_LIMIT_MS) {
  const id = ++nextId;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`no answer to ${method} within ${limitMs / 1000} s`));
    }, limitMs);
    pending.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method} answered with error ${msg.error.code}: ${msg.error.message}`));
        else resolvePromise(msg.result);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    send({ id, method, params });
  });
}

async function callTool(name, args) {
  const result = await request('tools/call', { name, arguments: args });
  const text = (result.content ?? []).map((part) => part.text ?? '').join('\n');
  return { text, isError: result.isError === true };
}

function stopChild() {
  if (exited) return;
  // With the shell in between (npx on Windows), killing the shell would leave the server running.
  if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
}

async function main() {
  const t0 = performance.now();
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'portaldot-smoke-test', version: '1.0.0' } }, START_LIMIT_MS);
  const startMs = performance.now() - t0;
  send({ method: 'notifications/initialized' });
  const info = init.serverInfo ?? {};
  console.log(`answered initialize in ${startMs.toFixed(0)} ms; protocol ${init.protocolVersion}; server ${info.name} ${info.version}`);
  check(info.name === 'portaldot-dev' && typeof info.version === 'string', 'the server names itself portaldot-dev and gives a version', JSON.stringify(info));
  check(Boolean(init.capabilities?.tools), 'the server offers tools', JSON.stringify(init.capabilities));
  check(typeof init.instructions === 'string' && init.instructions.includes('Bridge Zero'), 'the server sends its instructions');

  if (isCommitted) {
    // One version in three places; a release that forgets one of them fails here.
    const versionOf = (rel) => JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8')).version;
    const versions = { server: info.version, 'package.json': versionOf('package.json'), 'server-src/package.json': versionOf('server-src/package.json') };
    check(new Set(Object.values(versions)).size === 1, `the version is the same in the server, package.json and server-src/package.json (${info.version})`, JSON.stringify(versions));
  }

  const tools = [];
  let cursor;
  do {
    const page = await request('tools/list', cursor ? { cursor } : {});
    tools.push(...(page.tools ?? []));
    cursor = page.nextCursor;
  } while (cursor);
  const names = tools.map((t) => t.name);
  check(names.includes('convert_amount') && names.includes('convert_address'), `the tool list has convert_amount and convert_address (${tools.length} tools)`, names.join(', '));
  const notReadOnly = tools.filter((t) => t.annotations?.readOnlyHint !== true || t.annotations?.destructiveHint !== false).map((t) => t.name);
  check(notReadOnly.length === 0, 'every tool is marked read-only and not destructive', notReadOnly.join(', '));

  const amount = await callTool('convert_amount', { amount: '1.5', unit: 'token' });
  const amountWants = ['150000000000000', '1500000000000000000', '0x14d1120d7b160000'];
  check(!amount.isError && amountWants.every((s) => amount.text.includes(s)), 'convert_amount: 1.5 tokens is 150000000000000 base units and 1500000000000000000 wei', amount.text.slice(0, 500));

  const address = await callTool('convert_address', { address: TREASURY_SS58 });
  const lower = address.text.toLowerCase();
  check(!address.isError && lower.includes(TREASURY_H160) && lower.includes(TREASURY_ID), 'convert_address: the 0x form and the account id of the Treasury account', address.text.slice(0, 500));
  check(address.text.includes('could not ask the chain'), 'convert_address: answers from the rule alone when it cannot ask the chain', address.text.slice(0, 500));

  const phrase = await callTool('convert_address', { address: TEST_PHRASE });
  check(phrase.isError && phrase.text.includes('secret recovery phrase'), 'convert_address: a secret phrase is refused', phrase.text.slice(0, 500));

  // The knowledge pack: read_guide, the resources and the prompt, all offline.
  const guide = await callTool('read_guide', { topic: 'E12' });
  check(!guide.isError && /^errors\/E12: /.test(guide.text), 'read_guide reads one section of the knowledge pack, offline', guide.text.slice(0, 300));
  const res = await request('resources/list', {});
  check((res.resources ?? []).some((r) => r.uri === 'portaldot://guide/errors'), 'the knowledge files are listed as resources', JSON.stringify((res.resources ?? []).map((r) => r.uri)));
  const prompts = await request('prompts/list', {});
  check((prompts.prompts ?? []).some((p) => p.name === 'start_project'), 'the start_project prompt is offered', JSON.stringify((prompts.prompts ?? []).map((p) => p.name)));

  check(stray.length === 0, 'stdout carried only protocol messages', stray.slice(0, 3).join('\n'));

  // The client closes stdin at the end of a session; the server must then end by itself.
  child.stdin.end();
  if (!exited) await new Promise((done) => {
    exitWaiters.push(done);
    setTimeout(done, EXIT_LIMIT_MS).unref();
  });
  check(exited !== null && exited.code === 0, `the server ended with exit code 0 after stdin closed`, exited ? JSON.stringify(exited) : `still running after ${EXIT_LIMIT_MS / 1000} s`);
}

try {
  await main();
} catch (err) {
  check(false, 'the smoke test ran to its end', err instanceof Error ? err.message : String(err));
}
stopChild();
check(!/Unhandled|TypeError|ReferenceError/.test(stderr), 'nothing crashed on stderr', stderr.slice(-600));
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
