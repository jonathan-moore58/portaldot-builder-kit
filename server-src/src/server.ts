// Builds the MCP server and serves it on stdio.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { closeAll } from './lib/chain.ts';
import { registerTools } from './lib/tool.ts';
import { TOOLS } from './tools/index.ts';

export const SERVER_INFO = {
  name: 'portaldot-dev',
  title: 'Portaldot V3 chain tools, by the Bridge Zero team',
  version: '0.2.1',
};

// Read by the model at the start of a session, so it is short and says when to use what.
export const INSTRUCTIONS = [
  'Portaldot V3 chain tools, by the Bridge Zero team. An independent tool, not an official Portaldot one.',
  'Read-only: no tool needs a key, and none signs or sends. The most a tool returns is unsigned call data. Never pass a private key or secret phrase to a tool.',
  '',
  'Use these tools whenever a task touches Portaldot V3 (tokens POT and tPOT, the Revive module, endpoints on portaldot.dev) instead of answering from memory. Habits from Polkadot, Substrate and Ethereum are wrong here in several places:',
  '1. Two address forms. Native accounts are SS58 and start with 5; contracts and MetaMask use 0x. They are linked by a rule, not by a shared key, and the wrong form loses funds. Call convert_address before using an address on the other side.',
  '2. Two scales. Native amounts have 14 decimals; the Ethereum side shows the same token with 18 (1 native unit = 10000 wei). Call convert_amount instead of doing the arithmetic.',
  '3. Gas on the Ethereum side includes the storage deposit, so estimates look huge, and the node refuses a transaction (error 1010) when gas limit x base fee, plus the value, is more than the balance. Call estimate_eth_transaction before sending one.',
  '4. eth_getLogs misses contract events from native calls. Call get_contract_events.',
  "5. Never guess a call's name, arguments or index. Call search_chain, then describe_item; encode_call gives the exact bytes.",
  '6. The default network is the testnet (tPOT, Ethereum chain id 420420777). The mainnet (POT, 780780777) has no public Ethereum RPC and held no contracts or tokens on Nov 13, 2026.',
  '',
  'Also: get_chain_facts (endpoints, live constants, whether the chain is moving or in safe mode), get_account, read_storage, simulate_contract_call, simulate_contract_deploy, get_transaction (takes a 0x hash the explorer cannot look up), get_block, and explain_error (paste any error text).',
  'Results say when a fact was measured and when it is only reported by others. Pass that on rather than stating it as certain.',
].join('\n');

const log = (...parts: unknown[]): void => console.error('[portaldot-dev]', ...parts);

export function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  registerTools(server, TOOLS);
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

  log(`ready on stdio, ${TOOLS.length} tools, node ${process.version}`);
}
