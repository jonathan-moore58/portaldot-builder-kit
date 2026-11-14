// End-to-end check of the BUILT server (the single file inside the plugin), over stdio, the way an
// MCP client talks to it. It lists the tools and calls each one against the live chain.
//
// Usage: node test/server.test.mjs [--era=legacy|auto] [--server=<path>]
// Exit code 0 when every check passes.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const serverPath = resolve(opt('server') ?? '../plugins/portaldot-dev/server/index.mjs');
const era = opt('era') ?? 'legacy';
const cases = JSON.parse(readFileSync(new URL('./server-cases.json', import.meta.url), 'utf8'));

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
// every tool the instructions mention must exist
for (const word of instructions.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) check(names.includes(word), `instructions mention ${word}, which exists`);

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
