// End-to-end check of the BUILT server (the single file inside the plugin), over stdio, the way an
// MCP client talks to it. It lists the tools and calls each one against the live chain, then lists
// the resources and the prompts and reads one of each.
//
// test/server-cases.json holds "tools" (the exact tool list), "calls", and optionally "prompts" (the
// exact prompt list) and "resource" (the address of the resource to read; portaldot://guide/errors
// when it is left out).
//
// Usage: node test/server.test.mjs [--era=legacy|auto] [--server=<path>] [--cases=<path>]
// --cases reads another file of the same form, for example to run only the calls that need no network.
// Exit code 0 when every check passes.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const serverPath = resolve(opt('server') ?? '../plugins/portaldot-dev/server/index.mjs');
const era = opt('era') ?? 'legacy';
const cases = JSON.parse(readFileSync(opt('cases') ? resolve(opt('cases')) : new URL('./server-cases.json', import.meta.url), 'utf8'));

let failed = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `\n       ${String(detail).replace(/\n/g, '\n       ').slice(0, 900)}` : ''}`);
};

const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', (chunk) => (stderr += chunk.toString('utf8')));
const client = new Client({ name: 'portaldot-dev-test', version: '0.0.1' }, era === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {});

const t0 = performance.now();
await client.connect(transport);
console.log(`connected in ${(performance.now() - t0).toFixed(0)} ms; protocol ${client.getNegotiatedProtocolVersion()}; server ${JSON.stringify(client.getServerVersion())}`);

const instructions = client.getInstructions() ?? '';
check(instructions.includes('Bridge Zero') && instructions.length < 4096, `instructions name the makers and fit in 4,096 characters (${instructions.length})`);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
check(JSON.stringify([...names].sort()) === JSON.stringify([...cases.tools].sort()), `the tool list is exactly the expected ${cases.tools.length}`, `got: ${names.join(', ')}`);
for (const t of tools) {
  const problems = [];
  if (!t.description || t.description.length < 120) problems.push('description shorter than 120 characters');
  if ((t.description ?? '').length > 2000) problems.push('description longer than 2,000 characters');
  if (t.annotations?.readOnlyHint !== true || t.annotations?.destructiveHint !== false) problems.push('not marked read-only');
  for (const [key, prop] of Object.entries(t.inputSchema?.properties ?? {})) if (!prop.description) problems.push(`field "${key}" has no description`);
  check(problems.length === 0, `${t.name}: description, read-only marks and field descriptions`, problems.join('; '));
}
// the resources: one per knowledge file, each with a title, one line on what it holds, and Markdown
const caps = client.getServerCapabilities() ?? {};
check(Boolean(caps.resources) && !caps.resources.subscribe && caps.resources.listChanged === false, 'resources are declared, without subscriptions, as a list that does not change', JSON.stringify(caps.resources));
const { resources } = await client.listResources();
const badResources = resources.filter((r) => !r.uri.startsWith('portaldot://guide/') || !r.title || !r.description || /\n/.test(r.description) || r.mimeType !== 'text/markdown' || !(r.size > 0));
check(resources.length >= 1 && badResources.length === 0, `${resources.length} resources at portaldot://guide/<name>, each with a title, a one-line description, text/markdown and a size`, badResources.map((r) => r.uri).join(', '));
const resourceUri = cases.resource ?? 'portaldot://guide/errors';
try {
  const read = await client.readResource({ uri: resourceUri });
  const c = read.contents?.[0] ?? {};
  const listed = resources.find((r) => r.uri === resourceUri);
  check(read.contents?.length === 1 && c.uri === resourceUri && c.mimeType === 'text/markdown' && /^#{1,3} \S/m.test(c.text ?? '') && Buffer.byteLength(c.text ?? '', 'utf8') === listed?.size,
    `reading ${resourceUri} gives its Markdown (${(c.text ?? '').length} chars), as large as listed`, JSON.stringify(read).slice(0, 300));
} catch (err) {
  check(false, `reading ${resourceUri}`, err.message);
}

// the prompts: exactly the ones the cases name (none when they name none); each one is read
const { prompts } = caps.prompts ? await client.listPrompts() : { prompts: [] };
const promptNames = prompts.map((p) => p.name);
const wantPrompts = cases.prompts ?? [];
check(JSON.stringify([...promptNames].sort()) === JSON.stringify([...wantPrompts].sort()), `the prompt list is exactly the expected ${wantPrompts.length}${wantPrompts.length ? ` (${wantPrompts.join(', ')})` : ''}`, `got: ${promptNames.join(', ') || 'none'}`);
check(Boolean(caps.prompts) === prompts.length > 0, prompts.length ? 'prompts are declared' : 'no prompts capability without a prompt', JSON.stringify(caps.prompts));
for (const p of prompts) {
  const args = Object.fromEntries((p.arguments ?? []).map((a) => [a.name, `a test value for ${a.name}`]));
  try {
    const got = await client.getPrompt({ name: p.name, arguments: args });
    const text = (got.messages ?? []).map((m) => m.content?.text ?? '').join('\n');
    const problems = [];
    if (!p.title || !p.description) problems.push('no title or description');
    if (got.messages?.length !== 1 || got.messages[0].role !== 'user') problems.push('not one user message');
    if (text.length < 40) problems.push('almost no text');
    for (const v of Object.values(args)) if (!text.includes(v)) problems.push(`the argument "${v}" is not in the text`);
    check(problems.length === 0, `prompt ${p.name} ("${p.title}"): ${text.length} chars, arguments ${(p.arguments ?? []).map((a) => `${a.name}${a.required ? '' : ' (optional)'}`).join(', ') || 'none'}`, problems.join('; '));
  } catch (err) {
    check(false, `prompt ${p.name}`, err.message);
  }
}

// every tool or prompt the instructions mention must exist
for (const word of instructions.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) check(names.includes(word) || promptNames.includes(word), `instructions mention ${word}, which exists`);

for (const c of cases.calls) {
  const started = performance.now();
  let text = '';
  let isError = false;
  try {
    const res = await client.callTool({ name: c.tool, arguments: c.args });
    text = (res.content ?? []).map((p) => p.text ?? '').join('\n');
    isError = res.isError === true;
  } catch (err) {
    text = `THREW ${err.message}`;
    isError = true;
  }
  const ms = performance.now() - started;
  const wantError = c.error === true;
  const missing = (c.includes ?? []).filter((s) => !text.includes(s));
  const present = (c.excludes ?? []).filter((s) => text.includes(s));
  const ok = isError === wantError && missing.length === 0 && present.length === 0;
  check(ok, `${c.tool} ${JSON.stringify(c.args)} (${ms.toFixed(0)} ms, ${text.length} chars)${c.note ? ` - ${c.note}` : ''}`,
    [isError !== wantError ? `isError was ${isError}, expected ${wantError}` : '', missing.length ? `missing: ${JSON.stringify(missing)}` : '', present.length ? `must not contain: ${JSON.stringify(present)}` : '', `answer: ${text.slice(0, 500)}`].filter(Boolean).join('\n'));
}

const pid = transport.pid;
await client.close();
await new Promise((r) => setTimeout(r, 1500));
let alive = true;
try { process.kill(pid, 0); } catch { alive = false; }
check(!alive, 'the server process ended after the client closed');
check(!/Unhandled|TypeError|ReferenceError/.test(stderr), 'nothing crashed on stderr', stderr.slice(-600));

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exitCode = failed ? 1 : 0;
