// Runs one tool the way the server would and prints what the model would read.
// Usage: node scripts/call.ts <tool_name> '<json arguments>'
//        node scripts/call.ts --file <path to a tool file> '<json arguments>'   (a tool not yet in the list)
import '../src/stdout-guard.ts';
import { pathToFileURL } from 'node:url';
import { closeAll } from '../src/lib/chain.ts';
import { runTool, type AnyTool } from '../src/lib/tool.ts';
import { TOOLS } from '../src/tools/index.ts';

const argv = process.argv.slice(2);
let tool: AnyTool | undefined;
if (argv[0] === '--file') {
  tool = (await import(pathToFileURL(argv[1]).href)).default as AnyTool;
  argv.splice(0, 2);
} else {
  tool = TOOLS.find((t) => t.name === argv[0]);
  if (!tool) {
    console.error(`No tool named "${argv[0]}". Tools: ${TOOLS.map((t) => t.name).join(', ')}`);
    process.exitCode = 2;
  }
  argv.splice(0, 1);
}

if (tool) {
  const started = performance.now();
  const { text, isError } = await runTool(tool, argv[0] ? JSON.parse(argv[0]) : {});
  process.stdout.write(`${isError ? '[tool error]\n' : ''}${text}\n`);
  console.error(`\n(${tool.name}: ${(performance.now() - started).toFixed(0)} ms, ${text.length} characters${isError ? ', isError' : ''})`);
}
await closeAll();
