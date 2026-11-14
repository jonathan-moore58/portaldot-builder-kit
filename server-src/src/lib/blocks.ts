// Reading blocks, extrinsics and their events, for get_block, get_transaction and get_contract_events.
// Everything here only reads. A block's extrinsics and events are decoded with the runtime of that
// block (api.rpc.chain.getBlock and api.at(hash) both pick it), so old blocks decode correctly too.
//
// Measured on the V3 testnet on Nov 14, 2026:
// - an Ethereum transaction is an unsigned Revive.ethTransact extrinsic whose only argument, payload,
//   is the raw signed transaction; keccak-256 of the payload is the Ethereum transaction hash;
// - revive.blockHash(n) read at block n is the Ethereum-side hash of block n (it equals
//   eth_getBlockByNumber's hash for blocks 0, 1, 1000, 200000 and nine blocks with Ethereum
//   transactions), while read at the head it keeps only the newest 256 blocks: 256 back is still
//   there, 257 back reads zero;
// - the account that pays an Ethereum transaction's fee (TransactionFeePaid.who) is the account
//   that holds the balance of its "from" address: its 0x form equals "from" in all 10 transactions
//   checked;
// - an Ethereum deployment holds two deposits: Balances.Held with reason CodeUploadDepositReserve
//   (the code; held on the Revive module's account "modlpy/reviv" in the two deployments checked)
//   and StorageDepositReserve (the contract); the receipt's gas used x price was the fee plus both,
//   plus less than the price of one unit of gas, in all 8 transactions checked with a non-zero cost.
import { stringCamelCase } from '@polkadot/util';
import { blake2AsHex, keccakAsHex } from '@polkadot/util-crypto';
import { h160OfAccountId } from './address.ts';
import { ethRpc, hasEvmRpc, type Conn } from './chain.ts';
import { toPlain } from './codec.ts';
import { ToolError } from './errors.ts';
import { formatUnits, hideInvisible, untrusted } from './format.ts';
import { NATIVE_DECIMALS, type Network } from './networks.ts';

// The chain API is dynamic: every module of this chain is read by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const ZERO_HASH = `0x${'0'.repeat(64)}`;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** How many requests go to the node at once when many blocks are read. */
export const CHUNK = 10;

/** Text cut to at most n characters, ending in "..." when it was cut (plain ASCII). */
export const cut = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, Math.max(0, n - 3))}...` : s);

/* ---------- input checks ---------- */

/** Refuses an input that looks like a secret recovery phrase. */
export function refuseSecret(text: string): void {
  if (text.trim().split(/\s+/).length >= 12) {
    throw new ToolError('That looks like a secret recovery phrase, not a block or a hash. Never paste a secret phrase or a private key into a tool: these tools are read-only and need only public data. If that phrase is real, treat the account as exposed and move its funds.');
  }
}

export const isHash32 = (s: string): boolean => HASH_RE.test(s.trim());

/* ---------- finding a block ---------- */

export interface BlockRef {
  number: number;
  hash: string;
  /** Set when the block was found another way than asked, for example from an Ethereum-side hash. */
  note?: string;
}

async function headNumber(conn: Conn): Promise<number> {
  const header = await (conn.api as Loose).rpc.chain.getHeader();
  return header.number.toNumber();
}

/** The block hashes of these numbers, in one request per 100 numbers. Null for a block that does not exist yet. */
export async function blockHashes(conn: Conn, numbers: number[]): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (let i = 0; i < numbers.length; i += 100) {
    const part = numbers.slice(i, i + 100);
    const res = (await conn.provider.send('chain_getBlockHash', [part])) as Array<string | null>;
    out.push(...part.map((_, j) => (res?.[j] && res[j] !== ZERO_HASH ? (res[j] as string) : null)));
  }
  return out;
}

async function byNumber(conn: Conn, n: number): Promise<BlockRef> {
  const head = await headNumber(conn);
  if (n > head) throw new ToolError(`Block ${n} does not exist yet: the newest block on the ${conn.network.label} is ${head}. A block comes every 6 s.`);
  const [hash] = await blockHashes(conn, [n]);
  if (!hash) throw new ToolError(`The node of the ${conn.network.label} gave no hash for block ${n} (its newest block is ${head}). Try again in a moment.`);
  return { number: n, hash };
}

/**
 * The block a reference names: a number (or digits as text), a 0x block hash, "latest" or "finalized".
 * A hash the node does not know is tried as an Ethereum-side block hash on a network with an Ethereum RPC.
 */
export async function resolveBlock(conn: Conn, ref: number | string | undefined): Promise<BlockRef> {
  const api = conn.api as Loose;
  if (ref === undefined || (typeof ref === 'string' && ref.trim().toLowerCase() === 'latest')) {
    const header = await api.rpc.chain.getHeader();
    return { number: header.number.toNumber(), hash: header.hash.toHex() };
  }
  if (typeof ref === 'number') {
    if (!Number.isSafeInteger(ref) || ref < 0) throw new ToolError(`A block number is a whole number of 0 or more; got ${ref}.`);
    return byNumber(conn, ref);
  }
  const text = ref.trim();
  refuseSecret(text);
  if (text.toLowerCase() === 'finalized' || text.toLowerCase() === 'finalised') {
    const hash = (await api.rpc.chain.getFinalizedHead()).toHex();
    const header = await api.rpc.chain.getHeader(hash);
    return { number: header.number.toNumber(), hash };
  }
  if (/^\d+$/.test(text)) return byNumber(conn, Number(text));
  if (isHash32(text)) {
    const hash = text.toLowerCase();
    const header = (await conn.provider.send('chain_getHeader', [hash])) as { number: string } | null;
    if (header) return { number: Number(BigInt(header.number)), hash };
    // Not a Substrate block hash. The Ethereum side names the same block by another hash.
    if (hasEvmRpc(conn.network)) {
      const eth = await ethRpc<{ number?: unknown } | null>(conn.network, 'eth_getBlockByHash', [hash, false]).catch(() => null);
      // Used only when the Ethereum RPC writes the number as a 0x number, as it should.
      if (typeof eth?.number === 'string' && /^0x[0-9a-fA-F]{1,12}$/.test(eth.number)) {
        const n = Number(BigInt(eth.number));
        const found = await byNumber(conn, n);
        return { ...found, note: `${hash} is the Ethereum-side hash of block ${n}. On the node the same block has the hash ${found.hash}: the two sides share block numbers, not hashes.` };
      }
    }
    throw new ToolError(
      `No block with the hash ${hash} is known to the node of the ${conn.network.label}${hasEvmRpc(conn.network) ? ' or to its Ethereum RPC' : ''}. ` +
        'Check the network, or pass the block number instead. If this is a transaction hash, use get_transaction.',
    );
  }
  throw new ToolError(`"${cut(text, 80)}" is not a block. Give a block number (452626), a 0x block hash (0x and 64 hex characters), "latest" or "finalized".`);
}

/* ---------- reading a block ---------- */

export interface LoadedBlock {
  number: number;
  hash: string;
  parentHash: string;
  /** The API decorated for this block's runtime: at.query reads state as it was after this block. */
  at: Loose;
  /** The type registry of this block's runtime. */
  registry: Loose;
  specVersion: number;
  extrinsics: Loose[];
  events: Loose[];
  /** timestamp.now at this block, in ms, or null when it could not be read. */
  timeMs: number | null;
}

export async function loadBlock(conn: Conn, ref: BlockRef): Promise<LoadedBlock> {
  const api = conn.api as Loose;
  const [signed, at] = await Promise.all([api.rpc.chain.getBlock(ref.hash), api.at(ref.hash)]);
  const [events, now] = await Promise.all([at.query.system.events(), at.query.timestamp?.now ? at.query.timestamp.now().catch(() => null) : null]);
  return {
    number: ref.number,
    hash: ref.hash,
    parentHash: signed.block.header.parentHash.toHex(),
    at,
    registry: at.registry,
    specVersion: at.runtimeVersion?.specVersion?.toNumber?.() ?? api.runtimeVersion.specVersion.toNumber(),
    extrinsics: [...signed.block.extrinsics],
    events: [...events],
    timeMs: now ? Number(now.toString()) : null,
  };
}

/** The Ethereum-side hash of a block: revive.blockHash(number) read at that block. Null when it is not there. */
export async function ethBlockHash(block: LoadedBlock): Promise<string | null> {
  try {
    if (!block.at.query.revive?.blockHash) return null;
    const h = (await block.at.query.revive.blockHash(block.number)).toHex();
    return h === ZERO_HASH ? null : h;
  } catch {
    return null;
  }
}

export interface Finality {
  finalized: boolean;
  /** False when the main chain now has another block at this height (the block was on a fork). */
  onMainChain: boolean;
  finalizedNumber: number;
  /** One line for the reader. */
  text: string;
}

export async function finalityOf(conn: Conn, ref: { number: number; hash: string }): Promise<Finality> {
  const api = conn.api as Loose;
  const finHash = (await api.rpc.chain.getFinalizedHead()).toHex();
  const [finHeader, [canonical]] = await Promise.all([api.rpc.chain.getHeader(finHash), blockHashes(conn, [ref.number])]);
  const finalizedNumber = finHeader.number.toNumber();
  const onMainChain = canonical === ref.hash.toLowerCase();
  if (!onMainChain) {
    return {
      finalized: false,
      onMainChain,
      finalizedNumber,
      text: `NO: this block is not on the main chain now (block ${ref.number} there has the hash ${canonical ?? 'unknown'}). It was on a side fork, so its extrinsics may never have taken effect.`,
    };
  }
  if (ref.number <= finalizedNumber) return { finalized: true, onMainChain, finalizedNumber, text: `yes (the finalized head is block ${finalizedNumber})` };
  return {
    finalized: false,
    onMainChain,
    finalizedNumber,
    text: `not yet: the finalized head is block ${finalizedNumber}, ${ref.number - finalizedNumber} block(s) behind. Treat what happened in this block as settled only once it is finalized.`,
  };
}

/* ---------- names ---------- */

const moduleNames = new WeakMap<object, Map<string, string>>();

/** The chain's own module name ("TransactionPayment") for a section as @polkadot/api writes it ("transactionPayment"). */
export function moduleName(registry: Loose, section: string): string {
  let map = moduleNames.get(registry);
  if (!map) {
    map = new Map();
    try {
      for (const p of registry.metadata.pallets) {
        const name = p.name.toString();
        map.set(stringCamelCase(name), name);
      }
    } catch {
      /* fall back to the plain rule below */
    }
    moduleNames.set(registry, map);
  }
  return map.get(section) ?? `${section.charAt(0).toUpperCase()}${section.slice(1)}`;
}

/** "Balances.transferKeepAlive". */
export const callName = (registry: Loose, call: Loose): string => `${moduleName(registry, call.section)}.${call.method}`;

/** "Balances.Transfer". */
export const eventName = (registry: Loose, rec: Loose): string => `${moduleName(registry, rec.event.section)}.${rec.event.method}`;

/* ---------- extrinsics ---------- */

export const isEthTransact = (x: Loose): boolean => x.method.section === 'revive' && x.method.method === 'ethTransact';

/** The Ethereum transaction hash of a Revive.ethTransact extrinsic: keccak-256 of its payload. */
export function ethHashOf(x: Loose): string | null {
  if (!isEthTransact(x)) return null;
  try {
    return keccakAsHex(x.method.args[0].toU8a(true));
  } catch {
    return null;
  }
}

/** The events an extrinsic raised, in order. */
export const eventsOf = (block: LoadedBlock, index: number): Loose[] =>
  block.events.filter((r: Loose) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === index);

/** True for an inherent: an unsigned extrinsic of the Mandatory class that the block author adds (timestamp.set and the like). */
export function isInherent(x: Loose, records: Loose[]): boolean {
  if (x.isSigned || isEthTransact(x)) return false;
  const done = records.find((r) => r.event.section === 'system' && (r.event.method === 'ExtrinsicSuccess' || r.event.method === 'ExtrinsicFailed'));
  const info = done ? done.event.data[done.event.method === 'ExtrinsicSuccess' ? 0 : 1] : null;
  return info?.class?.toString?.() === 'Mandatory';
}

/* ---------- results ---------- */

/** "Balances.InsufficientBalance: Balance too low to send value." or "Token.FundsUnavailable". */
export function describeDispatchError(registry: Loose, err: Loose): string {
  if (err?.isModule) {
    try {
      const m = registry.findMetaError(err.asModule);
      // The text of the error, without its final period, so callers can build a sentence around it.
      const docs = (m.docs ?? []).map((d: Loose) => d.toString()).join(' ').trim().replace(/\.$/, '');
      return `${moduleName(registry, m.section)}.${m.name}${docs ? `: ${docs}` : ''}`;
    } catch {
      const m = err.asModule;
      const e = m?.error;
      const first = typeof e === 'number' ? e : typeof e?.toU8a === 'function' ? e.toU8a()[0] : '?';
      return `a module error (module ${String(m?.index)}, error ${first}) that this block's metadata does not name`;
    }
  }
  const type = String(err?.type ?? err?.toString?.() ?? 'unknown');
  const inner = err?.value;
  const sub = inner && typeof inner.type === 'string' ? `.${inner.type}` : '';
  return `${type}${sub}`;
}

export interface Outcome {
  /** True when the extrinsic raised System.ExtrinsicSuccess. */
  ok: boolean;
  /** "success" or "FAILED: Module.Error: docs". */
  text: string;
  /** The error of Revive.EthExtrinsicRevert: the Ethereum transaction reverted although the extrinsic succeeded. */
  ethRevert: string | null;
  /** Inner calls that failed although the extrinsic succeeded (multisig, batch, proxy, sudo). */
  inner: string[];
}

const fieldTypeName = (rec: Loose, i: number): string => {
  try {
    const f = rec.event.meta.fields[i];
    return f.typeName.isSome ? f.typeName.unwrap().toString() : '';
  } catch {
    return '';
  }
};

export function outcomeOf(registry: Loose, records: Loose[]): Outcome {
  const failed = records.find((r) => r.event.section === 'system' && r.event.method === 'ExtrinsicFailed');
  const success = records.some((r) => r.event.section === 'system' && r.event.method === 'ExtrinsicSuccess');
  const revert = records.find((r) => r.event.section === 'revive' && r.event.method === 'EthExtrinsicRevert');
  const inner: string[] = [];
  for (const rec of records) {
    const name = eventName(registry, rec);
    if (name === 'System.ExtrinsicFailed' || name === 'Revive.EthExtrinsicRevert') continue;
    rec.event.data.forEach((v: Loose, i: number) => {
      const tn = fieldTypeName(rec, i);
      if (/DispatchResult/.test(tn) && v?.isErr) inner.push(`${name}: ${describeDispatchError(registry, v.asErr)}`);
      else if (/^DispatchError$/.test(tn)) inner.push(`${name}: ${describeDispatchError(registry, v)}`);
    });
  }
  return {
    ok: success && !failed,
    text: failed ? `FAILED: ${describeDispatchError(registry, failed.event.data[0])}` : success ? 'success' : 'no result event (System.ExtrinsicSuccess or System.ExtrinsicFailed) was found',
    ethRevert: revert ? describeDispatchError(registry, revert.event.data[0]) : null,
    inner,
  };
}

export interface FeePaid {
  who: Uint8Array;
  whoText: string;
  fee: bigint;
  tip: bigint;
  /** Set when the fee was paid in another asset (an AssetTxFeePaid event). */
  assetId: string | null;
}

/** The fee an extrinsic paid: the actualFee of TransactionPayment.TransactionFeePaid (it includes the tip). */
export function feeOf(records: Loose[]): FeePaid | null {
  const rec = records.find((r) => r.event.section === 'transactionPayment' && r.event.method === 'TransactionFeePaid');
  if (rec) {
    const [who, fee, tip] = rec.event.data;
    return { who: who.toU8a(), whoText: who.toString(), fee: BigInt(fee.toString()), tip: BigInt(tip.toString()), assetId: null };
  }
  const asset = records.find((r) => r.event.method === 'AssetTxFeePaid');
  if (asset) {
    const d = asset.event.data;
    return { who: d[0].toU8a(), whoText: d[0].toString(), fee: BigInt(d[1].toString()), tip: BigInt(d[2].toString()), assetId: d[3] ? JSON.stringify(toPlain(d[3])) : 'unknown' };
  }
  return null;
}

/** The 0x address that sent an Ethereum transaction, from the native account that paid its fee. */
export const ethSenderOf = (fee: FeePaid | null): string | null => (fee ? h160OfAccountId(fee.who) : null);

/**
 * Deposits held by an extrinsic, from its Balances.Held and Balances.Released events: `held` for
 * Revive's StorageDepositReserve (the contract's storage), `code` for CodeUploadDepositReserve (the
 * code of a deployment, held on the Revive module's account).
 */
export function depositHeld(records: Loose[]): { held: bigint; code: bigint; released: bigint } {
  let held = 0n;
  let code = 0n;
  let released = 0n;
  for (const r of records) {
    if (r.event.section !== 'balances' || (r.event.method !== 'Held' && r.event.method !== 'Released')) continue;
    const reason = JSON.stringify(toPlain(r.event.data[0]) ?? '');
    const isCode = /CodeUploadDeposit/i.test(reason);
    if (!isCode && !/StorageDeposit/i.test(reason)) continue;
    const amount = BigInt(r.event.data[2].toString());
    if (r.event.method === 'Released') released += amount;
    else if (isCode) code += amount;
    else held += amount;
  }
  return { held, code, released };
}

/* ---------- events as short text ---------- */

// Sections whose Balance fields are amounts of the chain's own token (other modules may count in another token).
const NATIVE_AMOUNT_SECTIONS = new Set(['balances', 'transactionPayment']);

// A value of the chain as text. Numbers, hex and addresses are shown as they are. Any other text
// (a remark, a name, a message) was written by whoever sent the transaction, so it is shown as one
// quoted, escaped string, and the same holds for text inside a larger value.
function plainText(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return /^[0-9a-zA-Z]*$/.test(v) ? v : untrusted(v, 400);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return hideInvisible(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

/** One event as "Balances.Transfer { from: 5..., to: 5..., amount: 1000000000000 (0.01 tPOT) }", cut to max characters. */
export function shortEvent(registry: Loose, rec: Loose, network: Network, max = 200): string {
  const name = eventName(registry, rec);
  const fields: Loose[] = rec.event.meta?.fields ?? [];
  const parts: string[] = [];
  rec.event.data.forEach((v: Loose, i: number) => {
    const f = fields[i];
    const label = f?.name?.isSome ? stringCamelCase(f.name.unwrap().toString()) : `value${i + 1}`;
    let text: string;
    const raw = typeof v?.toRawType === 'function' ? v.toRawType() : '';
    if (raw === 'Bytes') text = v.toHex();
    else text = plainText(toPlain(v));
    const tn = fieldTypeName(rec, i);
    if (/Balance/.test(tn) && NATIVE_AMOUNT_SECTIONS.has(rec.event.section) && /^\d+$/.test(text)) text = `${text} (${formatUnits(BigInt(text), NATIVE_DECIMALS)} ${network.token})`;
    parts.push(`${label}: ${text}`);
  });
  return cut(parts.length ? `${name} { ${parts.join(', ')} }` : name, max);
}

/** An argument value as short text, with long values cut. Empty bytes show as "0x (empty)". */
export function argText(v: Loose, max = 200): string {
  const text = plainText(toPlain(v));
  if (text === '' && typeof v?.toRawType === 'function' && v.toRawType() === 'Bytes') return '0x (empty)';
  return cut(text, max);
}

/* ---------- finding an extrinsic by hash ---------- */

export interface Found {
  number: number;
  hash: string;
  index: number;
  /** "extrinsic" when the hash is the extrinsic's own hash, "ethereum" when it is the Ethereum transaction hash of a Revive.ethTransact. */
  kind: 'extrinsic' | 'ethereum';
}

/** The extrinsic in a loaded block whose own hash, or whose Ethereum transaction hash, is this hash. */
export function findInBlock(block: LoadedBlock, hash: string): { index: number; kind: Found['kind'] } | null {
  const h = hash.toLowerCase();
  for (let i = 0; i < block.extrinsics.length; i++) {
    const x = block.extrinsics[i];
    if (x.hash.toHex() === h) return { index: i, kind: 'extrinsic' };
    if (ethHashOf(x) === h) return { index: i, kind: 'ethereum' };
  }
  return null;
}

/**
 * Looks for a hash among the extrinsics of the newest `count` blocks, newest first, a few blocks at a
 * time. No node can look an extrinsic up by its hash, so reading the blocks is the only way.
 */
export async function scanForHash(conn: Conn, hash: string, count: number): Promise<{ found: Found | null; from: number; to: number }> {
  const api = conn.api as Loose;
  const h = hash.toLowerCase();
  const head = await headNumber(conn);
  const lowest = Math.max(0, head - count + 1);
  const numbers: number[] = [];
  for (let n = head; n >= lowest; n--) numbers.push(n);
  const hashes = await blockHashes(conn, numbers);
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const part = numbers.slice(i, i + CHUNK);
    const blocks = await Promise.all(
      part.map(async (n, j) => {
        const bh = hashes[i + j];
        if (!bh) return null;
        const raw = (await conn.provider.send('chain_getBlock', [bh])) as { block: { extrinsics: string[] } } | null;
        return raw ? { n, bh, xs: raw.block.extrinsics } : null;
      }),
    );
    for (const b of blocks) {
      if (!b) continue;
      for (let k = 0; k < b.xs.length; k++) {
        if (blake2AsHex(b.xs[k], 256) === h) return { found: { number: b.n, hash: b.bh, index: k, kind: 'extrinsic' }, from: lowest, to: head };
        // An Ethereum transaction: compare keccak-256 of its payload. Decoded with the current runtime,
        // which is right for recent blocks; an extrinsic it cannot decode is skipped.
        if (b.xs[k].length < 200) continue;
        try {
          const x = api.registry.createType('Extrinsic', b.xs[k]);
          if (ethHashOf(x) === h) return { found: { number: b.n, hash: b.bh, index: k, kind: 'ethereum' }, from: lowest, to: head };
        } catch {
          /* not decodable with this runtime */
        }
      }
    }
  }
  return { found: null, from: lowest, to: head };
}

/* ---------- links ---------- */

/** The explorer's page of one extrinsic (the explorer shows the Substrate side only). Null for an endpoint set by environment variable. */
export const explorerExtrinsicUrl = (network: Network, block: number, index: number): string | null =>
  network.overridden ? null : `${network.explorer}/#/extrinsics/${block}-${index}`;

/** The Node Console's page of one block. For an endpoint set by hand, whose address is never printed, the link says where it goes. */
export const nodeConsoleBlockUrl = (network: Network, block: number): string =>
  `https://node-console.portaldot.dev/?rpc=${network.wsVar ? network.wsCopy : encodeURIComponent(network.ws)}#/explorer/query/${block}`;

/* ---------- contract events on both sides ---------- */

export interface NodeEvent {
  block: number;
  /** The extrinsic index, or null when the event was raised outside an extrinsic. */
  extrinsic: number | null;
  phase: string;
  topics: string[];
  data: string;
}

export interface EthLog {
  blockNumber: string;
  topics: string[];
  data: string;
  transactionHash?: string;
  logIndex?: string;
  address?: string;
}

/**
 * Pairs the node's ContractEmitted events with eth_getLogs entries: same block, same topics, same
 * data, taken in order. Returns, for each node event, the index of its log (or -1), and the logs
 * that no node event matched.
 */
export function matchEvents(nodeEvents: NodeEvent[], logs: EthLog[]): { logOf: number[]; unmatched: number[] } {
  const used = new Array<boolean>(logs.length).fill(false);
  const norm = (s: string): string => s.toLowerCase();
  const logOf = nodeEvents.map((ev) => {
    const i = logs.findIndex(
      (l, j) =>
        !used[j] &&
        Number(BigInt(l.blockNumber)) === ev.block &&
        norm(l.data ?? '0x') === norm(ev.data) &&
        l.topics.length === ev.topics.length &&
        l.topics.every((t, k) => norm(t) === norm(ev.topics[k])),
    );
    if (i >= 0) used[i] = true;
    return i;
  });
  return { logOf, unmatched: used.flatMap((u, j) => (u ? [] : [j])) };
}
