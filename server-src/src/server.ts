// Builds the MCP server and serves it on stdio: the tools, the knowledge files as resources, and the
// prompts made from the skills, so that any MCP client gets the whole kit, not only a client that
// loads the plugin's skill.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { closeAll } from './lib/chain.ts';
import { registerPrompts, servedPrompts, type ServedPrompt } from './lib/prompts.ts';
import { registerGuideResources } from './lib/resources.ts';
import { registerTools } from './lib/tool.ts';
import { TOOLS } from './tools/index.ts';

export const SERVER_INFO = {
  name: 'portaldot-dev',
  title: 'Portaldot V3 chain tools, by the Bridge Zero team',
  version: '0.3.0',
};

/** The prompts this build offers: one per skill whose SKILL.md has "mcp-prompt: <name>"; maybe none. */
const PROMPTS: ServedPrompt[] = servedPrompts();

/** One line on the prompts a person can pick, or nothing when there are none. */
function promptsLine(prompts: ServedPrompt[]): string | null {
  if (!prompts.length) return null;
  const start = prompts.some((p) => p.name === 'start_project') ? ' Suggest start_project to someone who begins a new project on this chain.' : '';
  return `Prompts a person can pick in the client: ${prompts.map((p) => `${p.name} ("${p.title}")`).join('; ')}.${start}`;
}

/**
 * Read by the model at the start of a session, so it is short and says when to use what. It must stay
 * under 4,096 characters (test/server.test.mjs and test/unit/surface.test.ts check it).
 */
export function instructionsFor(prompts: ServedPrompt[]): string {
  return [
    'Portaldot V3 chain tools and knowledge, by the Bridge Zero team. An independent tool, not an official Portaldot one.',
    'Read-only: no tool needs a key, and none signs or sends. The most a tool returns is unsigned call data. Never pass a private key or secret phrase to a tool.',
    '',
    'Use these tools whenever a task touches Portaldot V3 (tokens POT and tPOT, the Revive module, endpoints on portaldot.dev) instead of answering from memory. Habits from Polkadot, Substrate and Ethereum are wrong here in several places:',
    '1. Two address forms. Native accounts are SS58 and start with 5; contracts and MetaMask use 0x. They are linked by a rule, not by a shared key, and the wrong form loses funds. Call convert_address before using an address on the other side.',
    '2. Two scales. Native amounts have 14 decimals; the Ethereum side shows the same token with 18 (1 native unit = 10000 wei). Call convert_amount instead of doing the arithmetic.',
    '3. Gas on the Ethereum side includes the storage deposit, so estimates look huge. The node refuses a transaction (error 1010) when gas limit x base fee is more than the sender can spend; the max fee and the value are not part of that check. A transaction whose value cannot be paid is included, fails, and still costs the fee (measured with real transactions on Nov 15, 2026). Call estimate_eth_transaction before sending one.',
    '4. eth_getLogs misses contract events from native calls. Call get_contract_events.',
    "5. Never guess a call's name, arguments or index. Call search_chain, then describe_item; encode_call gives the exact bytes.",
    '6. The default network is the testnet (tPOT, Ethereum chain id 420420777). The mainnet (POT, 780780777) has no public Ethereum RPC and held no contracts or tokens on Nov 13, 2026.',
    '',
    "For how to do something and why the chain behaves as it does, call read_guide: the kit's knowledge by section: recipes, addresses, amounts and fees, contracts, native modules, open questions. " +
      'With no arguments it lists every section; {"query": "deploy deposit"} searches them; {"topic": "E12"} or {"topic": "recipe 4"} reads one. The same files are resources at portaldot://guide/<name>.',
    promptsLine(prompts),
    'Also: get_chain_facts (endpoints, live constants, whether the chain is moving or in safe mode), get_account, read_storage, simulate_contract_call, simulate_contract_deploy, get_transaction (takes a 0x hash the explorer cannot look up), get_block, and explain_error (paste any error text).',
    'Results say when a fact was measured and when it is only reported by others. Pass that on rather than stating it as certain.',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

export const INSTRUCTIONS = instructionsFor(PROMPTS);

const log = (...parts: unknown[]): void => console.error('[portaldot-dev]', ...parts);

export function buildServer(): McpServer {
  // Resources and prompts never change while the server runs, so their lists are not announced as changing.
  const capabilities = { tools: {}, resources: { listChanged: false }, ...(PROMPTS.length ? { prompts: { listChanged: false } } : {}) };
  const server = new McpServer(SERVER_INFO, { capabilities, instructions: INSTRUCTIONS });
  registerTools(server, TOOLS);
  registerGuideResources(server);
  registerPrompts(server);
  return server;
}

export function start(): void {
  const handle = serveStdio(() => buildServer(), { onerror: (err) => log('transport error:', err.message) });

  let stopping = false;
  const stop = (why: string): void => {
    if (stopping) return;
    stopping = true;
    log(`stopping (${why})`);
    // Close the chain connections and the MCP handle, then exit even if a socket or timer is still open.
    void Promise.allSettled([closeAll(), handle.close()]).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  // The client closed our stdin: the session is over. This is the dependable signal on every OS.
  process.stdin.once('end', () => stop('stdin end'));
  process.stdin.once('close', () => stop('stdin close'));
  // A stray error inside a library (for example while a socket reconnects) must not end the server
  // for the rest of the session: it is logged, and the next call is answered as usual.
  process.on('unhandledRejection', (reason) => log('unhandled rejection:', reason instanceof Error ? reason.message : String(reason)));
  process.on('uncaughtException', (err) => log('uncaught exception:', err instanceof Error ? err.message : String(err)));
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  log(`ready on stdio, ${TOOLS.length} tools, the knowledge files as resources, ${PROMPTS.length} prompt${PROMPTS.length === 1 ? '' : 's'}, node ${process.version}`);
}
