// Connections to the chain: one lazy WebSocket per network for the Substrate side, and plain
// HTTP requests for the Ethereum side. Nothing here can sign or send.
import { AsyncLocalStorage } from 'node:async_hooks';
import { gunzipSync } from 'node:zlib';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { SAVED_METADATA } from '../generated/metadata.ts';
import { EthRpcError, ToolError } from './errors.ts';
import { messageText } from './text.ts';
import { NETWORKS, type Network, type NetworkKey } from './networks.ts';

// With the saved metadata a connection takes about 1.5 s. Without it (after a runtime upgrade, or on
// an endpoint set by hand) the node has to send the metadata, which has taken up to 15 s.
const CONNECT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_WAIT_MS = 8_000;
const IDLE_CLOSE_MS = 5 * 60_000;
const ETH_TIMEOUT_MS = 20_000;

// Two of the twelve transaction extensions of V3 are unknown to @polkadot/api. Both are empty.
// Declaring them keeps fee estimates (which build a mock-signed transaction) free of warnings.
const V3_EXTENSIONS = {
  AuthorizeCall: { extrinsic: {}, payload: {} },
  EthSetOrigin: { extrinsic: {}, payload: {} },
};

export interface Conn {
  network: Network;
  api: ApiPromise;
  provider: WsProvider;
  /** Things the reader must know about this connection, such as an unexpected genesis hash. */
  warnings: string[];
}

interface Slot {
  promise: Promise<Conn>;
  idle?: NodeJS.Timeout;
}

const slots = new Map<NetworkKey, Slot>();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What one tool call collects on its way: the warnings of every connection it used. */
export const callContext = new AsyncLocalStorage<{ warnings: Set<string> }>();

/**
 * The runtime metadata saved at build time, keyed the way @polkadot/api wants it. The library uses
 * it only when the live chain reports the same genesis hash and runtime version, and otherwise
 * downloads the metadata (about 1 MB) itself. So a saved copy can make a session start faster, but
 * can never make it wrong.
 */
function savedMetadata(network: Network): Record<string, `0x${string}`> {
  const saved = SAVED_METADATA[network.key];
  if (!saved) return {};
  try {
    return { [`${saved.genesis}-${saved.specVersion}`]: `0x${gunzipSync(Buffer.from(saved.gzipBase64, 'base64')).toString('hex')}` };
  } catch {
    return {};
  }
}

/**
 * Measured on Nov 14, 2026 with Node 24: when Node has its own WebSocket (Node 22 and later), the
 * WsProvider uses it and sends no headers, and that WebSocket sends no Authorization for a user name
 * and password in the URL either. With the ws library (Node 20, or node --no-experimental-websocket)
 * the header is sent.
 */
function authNote(network: Network): string {
  if (!network.wsHeaders.Authorization || typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function') return '';
  return ` The user name and password of ${network.wsVar} go to the node as an Authorization header, which the WebSocket built into this Node version does not send; if the node needs them, set NODE_OPTIONS=--no-experimental-websocket for the server.`;
}

async function open(network: Network): Promise<Conn> {
  let provider: WsProvider | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    provider = new WsProvider(network.wsUrl, 2_500, network.wsHeaders, REQUEST_TIMEOUT_MS);
    const api = await Promise.race([
      ApiPromise.create({ provider, noInitWarn: true, signedExtensions: V3_EXTENSIONS, metadata: savedMetadata(network) }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${CONNECT_TIMEOUT_MS / 1000} s`)), CONNECT_TIMEOUT_MS);
      }),
    ]);
    const warnings: string[] = [];
    const genesis = api.genesisHash.toHex();
    if (genesis !== network.genesis) {
      warnings.push(
        `WARNING: the node at ${network.ws} has genesis ${genesis}, not the ${network.label} genesis recorded on Nov 14, 2026 (${network.genesis}). ` +
          (network.overridden ? 'The endpoint comes from an environment variable, so it may be another chain.' : 'The network may have been reset.') +
          ' Facts in these tools that are not read live may no longer hold.',
      );
    }
    return { network, api, provider, warnings };
  } catch (err) {
    provider?.disconnect().catch(() => undefined);
    // Only whether a proxy is set: its value may hold a password, so it is never printed.
    const viaProxy = process.env.NODE_USE_ENV_PROXY === '1' && Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
    throw new ToolError(
      `Could not reach the ${network.label} node at ${network.ws} (${messageText(err instanceof Error ? err.message : String(err), 300)}).${network.wsVar ? ` The endpoint comes from ${network.wsVar}.${authNote(network)}` : ''}${viaProxy ? ' The server connects through the proxy set in HTTPS_PROXY or HTTP_PROXY (the plugin sets NODE_USE_ENV_PROXY=1): check that proxy, or add the host to NO_PROXY.' : ''} ` +
        'All public Portaldot nodes are run by one operator and the testnet has stopped before, so this is probably not a fault in your code. ' +
        'Try again in a moment. Tools that need no network (convert_amount, and convert_address for the offline rule) still work.',
    );
  } finally {
    clearTimeout(timer);
  }
}

async function waitConnected(provider: WsProvider, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (provider.isConnected) return true;
    await sleep(250);
  }
  return provider.isConnected;
}

async function drop(key: NetworkKey): Promise<void> {
  const slot = slots.get(key);
  if (!slot) return;
  slots.delete(key);
  clearTimeout(slot.idle);
  const conn = await slot.promise.catch(() => null);
  await conn?.api.disconnect().catch(() => undefined);
}

function touch(key: NetworkKey): void {
  const slot = slots.get(key);
  if (!slot) return;
  clearTimeout(slot.idle);
  // An idle session should not hold a socket open on a public node.
  slot.idle = setTimeout(() => void drop(key), IDLE_CLOSE_MS);
  slot.idle.unref();
}

/**
 * The facts in these tools that carry a date were measured on the runtime whose metadata is saved in
 * the source (testnet spec 3002 and mainnet spec 3001 for version 0.3.0). After a runtime upgrade
 * they may no longer hold, while everything read live stays right. Null when the spec is the saved
 * one, and for a node of another chain, which the genesis warning covers.
 */
export function specWarning(network: Network, live: { genesis: string; specVersion: number }): string | null {
  const saved = SAVED_METADATA[network.key];
  if (!saved || saved.genesis !== network.genesis || live.genesis !== network.genesis) return null;
  if (!Number.isSafeInteger(live.specVersion) || live.specVersion === saved.specVersion) return null;
  return (
    `WARNING: the ${network.label} now runs runtime spec ${live.specVersion}, and the facts in these tools that carry a date were measured on spec ${saved.specVersion}: after this runtime upgrade they may no longer hold. ` +
    'What the tools read live is still right. Update the Portaldot Builder Kit to its newest version: it may have the facts checked on the new runtime.'
  );
}

/** The connection to a network, opened on first use and reopened if it was lost. */
export async function getConn(key: NetworkKey): Promise<Conn> {
  const conn = await connect(key);
  const store = callContext.getStore();
  if (store) {
    for (const w of conn.warnings) store.warnings.add(w);
    // Asked on every call: the library follows a runtime upgrade while the connection stays open.
    let spec: string | null = null;
    try {
      spec = specWarning(conn.network, { genesis: conn.api.genesisHash.toHex(), specVersion: conn.api.runtimeVersion.specVersion.toNumber() });
    } catch {
      spec = null; // no runtime version known yet: nothing to compare
    }
    if (spec) store.warnings.add(spec);
  }
  return conn;
}

async function connect(key: NetworkKey): Promise<Conn> {
  // An endpoint set by hand that cannot be a node's address is reported before anything is opened.
  const problem = NETWORKS[key].wsProblem;
  if (problem) throw new ToolError(problem);
  const existing = slots.get(key);
  if (existing) {
    const conn = await existing.promise.catch(() => null);
    if (conn && (conn.provider.isConnected || (await waitConnected(conn.provider, RECONNECT_WAIT_MS)))) {
      touch(key);
      return conn;
    }
    await drop(key);
  }
  const slot: Slot = { promise: open(NETWORKS[key]) };
  slots.set(key, slot);
  try {
    const conn = await slot.promise;
    touch(key);
    return conn;
  } catch (err) {
    if (slots.get(key) === slot) slots.delete(key);
    throw err;
  }
}

/** Closes every connection. Called when the session ends. */
export async function closeAll(): Promise<void> {
  await Promise.all([...slots.keys()].map((key) => drop(key)));
}

let ethId = 0;

// An Ethereum endpoint set by hand is asked for its chain id once. A wrong one earns a warning on
// every answer that used it, the way a wrong genesis hash does for the node.
const evmWarning = new Map<NetworkKey, Promise<string | null>>();

async function checkEvmChain(network: Network): Promise<string | null> {
  try {
    const res = await fetch(network.evmUrl as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...network.evmHeaders },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++ethId, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json()) as { result?: string };
    const id = Number(BigInt(body.result ?? '0x0'));
    if (id === network.evmChainId) return null;
    return `WARNING: the Ethereum RPC at ${network.evm} (set by an environment variable) reports chain id ${id}, not the ${network.label}'s ${network.evmChainId}. Its answers are about another chain.`;
  } catch {
    return null; // an endpoint that does not answer is reported by the request that follows
  }
}

/**
 * One Ethereum JSON-RPC request. Tries twice when the server gives no usable answer.
 * An error answer from the node (a revert, a refused transaction) is thrown as EthRpcError at once.
 */
export async function ethRpc<T = unknown>(network: Network, method: string, params: unknown[] = [], opts: { tries?: number; timeoutMs?: number } = {}): Promise<T> {
  if (!network.evmUrl) {
    throw new ToolError(
      `The ${network.label} has no public Ethereum JSON-RPC (checked Nov 13, 2026), so ${method} cannot be asked there. ` +
        'Ethereum-side values of that network can still be read through the node: get_account and simulate_contract_call do that.',
    );
  }
  // An endpoint set by hand that cannot be an Ethereum RPC is reported before anything is sent.
  if (network.evmProblem) throw new ToolError(network.evmProblem);
  if (network.overridden) {
    if (!evmWarning.has(network.key)) evmWarning.set(network.key, checkEvmChain(network));
    const warning = await evmWarning.get(network.key);
    if (warning) callContext.getStore()?.warnings.add(warning);
  }
  const tries = opts.tries ?? 2;
  let reason = '';
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(network.evmUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...network.evmHeaders },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++ethId, method, params }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? ETH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { code: unknown; message: unknown; data?: unknown } };
      if (body.error && typeof body.error === 'object') {
        const code = Number.isSafeInteger(body.error.code) ? (body.error.code as number) : 0;
        throw new EthRpcError(method, code, String(body.error.message ?? ''), body.error.data);
      }
      return body.result as T;
    } catch (err) {
      if (err instanceof EthRpcError) throw err;
      // A parser's message quotes the answer it could not read, which could be any text, so it is not passed on.
      reason = err instanceof SyntaxError ? 'its answer was not valid JSON' : messageText(err instanceof Error ? err.message : String(err), 200);
      if (attempt < tries - 1) await sleep(1_500);
    }
  }
  throw new ToolError(
    `The Ethereum RPC of the ${network.label} (${network.evm}) gave no usable answer to ${method} after ${tries === 1 ? 'one try' : `${tries} tries`} (${reason}). ` +
      'It is run by the same operator as the nodes, and other builders have reported 503 and 429 answers from it. Try again in a moment.',
  );
}

/** True when the network has an Ethereum JSON-RPC to ask. */
export const hasEvmRpc = (network: Network): boolean => network.evmUrl !== null;

// What an Ethereum RPC answers is text from another server. A field that should be hex (an address,
// a hash, a topic, data, a quantity) is used and printed only when it is 0x followed by hex.

/** True for a value written the way an Ethereum RPC writes hex: 0x followed by hex digits. */
export const isEthHex = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v);

/** A quantity of an Ethereum RPC answer as a BigInt. A ToolError when it is not a 0x number of at most 256 bits. */
export function ethQuantity(v: unknown, method: string): bigint {
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  throw new ToolError(`The Ethereum RPC answered ${method} with something that is not a 0x number, so that answer was not used.`);
}
