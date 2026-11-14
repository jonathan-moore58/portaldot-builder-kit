// Measures how long the BUILT server takes to start: from spawning it to the tool list arriving.
// Usage: node scripts/bench-start.mjs [runs]
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';

const runs = Number(process.argv[2] ?? 8);
const serverPath = resolve('../plugins/portaldot-dev/server/index.mjs');
const times = [];
for (let i = 0; i < runs; i++) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], stderr: 'pipe' });
  transport.stderr?.on('data', () => undefined);
  const client = new Client({ name: 'bench', version: '0.0.1' });
  const t0 = performance.now();
  await client.connect(transport);
  await client.listTools();
  times.push(Math.round(performance.now() - t0));
  await client.close();
}
const sorted = [...times].sort((a, b) => a - b);
console.log(`runs ${times.join(', ')} ms`);
console.log(`min ${sorted[0]} ms, median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted[sorted.length - 1]} ms`);
