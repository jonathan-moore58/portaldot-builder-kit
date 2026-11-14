// The two Portaldot V3 networks and where to reach them.
// Every value here was read from the live chains on Nov 14, 2026.
import { rememberSecret } from './text.ts';

export type NetworkKey = 'testnet' | 'mainnet';

export interface Network {
  key: NetworkKey;
  /** How the network is named in text. */
  label: string;
  /** The chain's own name for itself (system_chain). */
  chainName: string;
  /** Symbol of the native token. */
  token: string;
  /** Substrate JSON-RPC over WebSocket, as it may be shown in text. The same host answers over https. */
  ws: string;
  /** Ethereum JSON-RPC over HTTP, as it may be shown in text, or null when the network has no public one. */
  evm: string | null;
  /**
   * The addresses the server really connects to. They are never printed: one set by hand may carry a
   * key. A user name and password are taken out of them and sent in wsHeaders and evmHeaders instead.
   */
  wsUrl: string;
  evmUrl: string | null;
  /** Headers sent with each connection: an Authorization header when the endpoint carried a user name and password. */
  wsHeaders: Record<string, string>;
  evmHeaders: Record<string, string>;
  /** Set when an endpoint from an environment variable cannot be used (not a URL, or the wrong scheme). Never quotes the value. */
  wsProblem: string | null;
  evmProblem: string | null;
  /** What a line meant to be copied (MetaMask settings, a cast command) writes for the endpoint. */
  wsCopy: string;
  evmCopy: string | null;
  /** The environment variable each endpoint was set by, or null for the built-in address. */
  wsVar: string | null;
  evmVar: string | null;
  /** Genesis hash, to tell a reset or a wrong endpoint. */
  genesis: string;
  /** The Ethereum chain id (pallet-revive's chainId constant). */
  evmChainId: number;
  /** The official explorer. It shows the Substrate side only. */
  explorer: string;
  explorerApi: string;
  /** True when one of the endpoints comes from an environment variable. */
  overridden: boolean;
}

/** What lines meant to be copied write for an endpoint set by hand, whose real value is never printed. */
export const YOUR_ENDPOINT = '<your endpoint>';

/**
 * An endpoint as it may appear in a tool's answer. An address set through an environment variable
 * can carry a user name, a password, or a key in its path or query, so only its scheme and host are
 * shown. The built-in addresses have none of these and are shown whole.
 */
export function shownUrl(raw: string, setByHand: boolean): string {
  try {
    const u = new URL(raw);
    if (!setByHand) return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
    return `${u.protocol}//${u.host}${u.pathname === '/' && !u.search ? '' : '/...'}`;
  } catch {
    return '(an endpoint set by an environment variable that is not a valid URL)';
  }
}

interface Endpoint {
  url: string;
  shown: string;
  copy: string;
  headers: Record<string, string>;
  problem: string | null;
  from: string | null;
}

const builtIn = (url: string): Endpoint => ({ url, shown: shownUrl(url, false), copy: url, headers: {}, problem: null, from: null });

const decoded = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * An endpoint set by an environment variable. Every part of it that could be a secret is remembered,
 * so that redact() (text.ts) hides it wherever a library or a node quotes it: the whole value, its
 * URL form, its path and query, its user name and password, and every query value of 6 characters
 * or more. A user name and password are taken out of the address and sent as an Authorization
 * header, so they are never part of a URL that a message could quote. A wrong scheme is reported by
 * the first call that needs the endpoint, without printing the value.
 */
function handSet(raw: string, name: string, kind: 'ws' | 'evm', official: string | null): Endpoint {
  rememberSecret(raw);
  const schemes = kind === 'ws' ? ['ws:', 'wss:'] : ['http:', 'https:'];
  const expected = kind === 'ws' ? 'ws:// or wss://' : 'http:// or https://';
  const what = kind === 'ws' ? "a node's WebSocket address" : 'an Ethereum JSON-RPC address';
  const problem = (why: string): string =>
    `${name} ${why}, so the endpoint set there cannot be used. Set it to ${what} that starts with ${expected}${official ? `, or remove it to use the official ${official}` : ''}. Its value is not shown here, because it may hold a key.`;
  const unusable = (why: string): Endpoint => ({ url: raw, shown: shownUrl(raw, true), copy: YOUR_ENDPOINT, headers: {}, problem: problem(why), from: name });
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return unusable('is not a valid URL');
  }
  rememberSecret(u.href);
  const pathAndQuery = `${u.pathname}${u.search}`;
  if (pathAndQuery.length > 1) rememberSecret(pathAndQuery);
  for (const part of [u.username, u.password]) {
    rememberSecret(part);
    rememberSecret(decoded(part));
  }
  for (const pair of u.search.slice(1).split('&')) {
    const value = pair.slice(pair.indexOf('=') + 1);
    if (pair.includes('=') && value.length >= 6) {
      rememberSecret(value);
      rememberSecret(decoded(value));
    }
  }
  for (const value of u.searchParams.values()) if (value.length >= 6) rememberSecret(value);
  if (!schemes.includes(u.protocol)) return unusable(`does not start with ${expected}`);
  let url = raw;
  const headers: Record<string, string> = {};
  if (u.username || u.password) {
    const token = Buffer.from(`${decoded(u.username)}:${decoded(u.password)}`).toString('base64');
    rememberSecret(token);
    headers.Authorization = `Basic ${token}`;
    const bare = new URL(u.href);
    bare.username = '';
    bare.password = '';
    url = bare.href;
    rememberSecret(url);
  }
  return { url, shown: shownUrl(raw, true), copy: YOUR_ENDPOINT, headers, problem: null, from: name };
}

/** The networks, with the endpoints these environment variables set. Exported for tests; the server uses NETWORKS. */
export function buildNetworks(env: Record<string, string | undefined>): Record<NetworkKey, Network> {
  const point = (name: string, kind: 'ws' | 'evm', official: string | null): Endpoint | null => {
    const raw = env[name]?.trim();
    if (raw) return handSet(raw, name, kind, official);
    return official ? builtIn(official) : null;
  };
  const testWs = point('PORTALDOT_TESTNET_WS', 'ws', 'wss://test-node-v3.portaldot.dev') as Endpoint;
  const testEvm = point('PORTALDOT_TESTNET_EVM', 'evm', 'https://test-evm-rpc-v3.portaldot.dev') as Endpoint;
  const mainWs = point('PORTALDOT_MAINNET_WS', 'ws', 'wss://live-v3-node.portaldot.dev') as Endpoint;
  const mainEvm = point('PORTALDOT_MAINNET_EVM', 'evm', null);
  const fields = (ws: Endpoint, evm: Endpoint | null) => ({
    ws: ws.shown,
    evm: evm ? evm.shown : null,
    wsUrl: ws.url,
    evmUrl: evm ? evm.url : null,
    wsHeaders: ws.headers,
    evmHeaders: evm ? evm.headers : {},
    wsProblem: ws.problem,
    evmProblem: evm ? evm.problem : null,
    wsCopy: ws.copy,
    evmCopy: evm ? evm.copy : null,
    wsVar: ws.from,
    evmVar: evm ? evm.from : null,
    overridden: Boolean(ws.from || evm?.from),
  });
  return {
    testnet: {
      key: 'testnet',
      label: 'Portaldot V3 testnet',
      chainName: 'PortaldotV3 Test',
      token: 'tPOT',
      ...fields(testWs, testEvm),
      genesis: '0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd',
      evmChainId: 420420777,
      explorer: 'https://scanner-testnet-v3.portaldot.dev',
      explorerApi: 'https://scanner-testnet-v3-api.portaldot.dev',
    },
    mainnet: {
      key: 'mainnet',
      label: 'Portaldot V3 mainnet',
      chainName: 'PortaldotV3 Live',
      token: 'POT',
      ...fields(mainWs, mainEvm),
      genesis: '0x6e7f1f24628d2fa3a1ac81a8b45157c63b1037fee4123a7664aae2c55cdbbc36',
      evmChainId: 780780777,
      explorer: 'https://scanner-live-v3.portaldot.dev',
      explorerApi: 'https://scanner-live-v3-api.portaldot.dev',
    },
  };
}

export const NETWORKS: Record<NetworkKey, Network> = buildNetworks(process.env);

/** Native amounts have 14 decimals on both networks; the Ethereum side shows 18. */
export const NATIVE_DECIMALS = 14;
export const EVM_DECIMALS = 18;
/** 1 native base unit is this many wei (pallet-revive's nativeToEthRatio, the same on both networks). */
export const NATIVE_TO_WEI = 10_000n;

/** The address a 0x account sends an Ethereum transaction to when it wants to run a native call ("modlpy/paddr"). */
export const PALLETS_ADDRESS = '0x6d6f646c70792f70616464720000000000000000';

export function defaultNetworkKey(): NetworkKey {
  const v = process.env.PORTALDOT_DEFAULT_NETWORK?.trim().toLowerCase();
  return v === 'mainnet' ? 'mainnet' : 'testnet';
}

export function pickNetwork(key?: NetworkKey): Network {
  return NETWORKS[key ?? defaultNetworkKey()];
}
