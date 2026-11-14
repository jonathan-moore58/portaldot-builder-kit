// Runs several tool calls in one process (one connection) and prints each answer.
// Usage: node scripts/batch.ts '<json array of [tool, args]>'
//        node scripts/batch.ts --file <path to a JSON file holding that array>   (for arguments too long for a command line)
import '../src/stdout-guard.ts';
import { readFileSync } from 'node:fs';
import { closeAll } from '../src/lib/chain.ts';
import { runTool } from '../src/lib/tool.ts';
import { TOOLS } from '../src/tools/index.ts';

const argv = process.argv.slice(2);
const source = argv[0] === '--file' ? readFileSync(argv[1], 'utf8') : argv[0];
const calls = JSON.parse(source) as Array<[string, unknown]>;
for (const [name, args] of calls) {
  const tool = TOOLS.find((t) => t.name === name);
  process.stdout.write(`\n=================== ${name} ${JSON.stringify(args).slice(0, 300)}\n`);
  if (!tool) {
    process.stdout.write('no such tool\n');
    continue;
  }
  const started = performance.now();
  const { text, isError } = await runTool(tool, args);
  process.stdout.write(`${isError ? '[tool error]\n' : ''}${text}\n(${(performance.now() - started).toFixed(0)} ms, ${text.length} chars)\n`);
}
await closeAll();
