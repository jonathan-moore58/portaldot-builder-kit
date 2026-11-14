// The node's own dry run of a contract call or deployment (pallet-revive's runtime API ReviveApi),
// read the same way for both, plus the money side: limits to pass, fee, and the balance check.
// Nothing here signs or sends. Shapes and numbers below were checked against both networks on
// Nov 14, 2026.
import { Metadata, TypeRegistry } from '@polkadot/types';
import { u8aConcat } from '@polkadot/util';
import { keccakAsU8a } from '@polkadot/util-crypto';
import { resolveHolder, type Holder } from './accounts.ts';
import { checksummed, h160OfAccountId, parseAddress, type ParsedAddress } from './address.ts';
import type { Conn } from './chain.ts';
import { ToolError } from './errors.ts';
import { clip, hexToBytes, nativeAmount, toHex } from './format.ts';
import type { Network } from './networks.ts';
import { redact, untrusted } from './text.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** The Treasury, a module account ("modlpy/trsry") that holds funds on both networks and never signs. */
export const TREASURY_SS58 = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';

const U128_MAX = (1n << 128n) - 1n;

/* ---------- input ---------- */

const looksLikePhrase = (s: string): boolean => s.trim().split(/\s+/).length >= 12;

/** A 0x hex string of whole bytes. Returns it in lower case, with the 0x. */
export function parseHexInput(text: string, what: string, opts: { exactBytes?: number; maxBytes?: number } = {}): string {
  if (looksLikePhrase(text)) {
    throw new ToolError(`${what} looks like a secret recovery phrase. Never paste a secret phrase or a private key into a tool: these tools are read-only and need only public data. If that phrase is real, treat the account as exposed and move its funds.`);
  }
  const t = text.trim();
  const body = t.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]*$/.test(body)) throw new ToolError(`${what} must be hex: 0x followed by hex digits (0-9, a-f). Got something else${t.length > 20 ? '' : `: "${t}"`}.`);
  if (body.length % 2) throw new ToolError(`${what} has an odd number of hex digits (${body.length}), so it is not whole bytes. Check that nothing was cut off.`);
  const bytes = body.length / 2;
  if (opts.exactBytes !== undefined && bytes !== opts.exactBytes) throw new ToolError(`${what} must be exactly ${opts.exactBytes} bytes (0x and ${opts.exactBytes * 2} hex digits); got ${bytes} bytes.`);
  if (opts.maxBytes !== undefined && bytes > opts.maxBytes) throw new ToolError(`${what} is ${bytes} bytes; this tool takes at most ${opts.maxBytes}.`);
  return `0x${body.toLowerCase()}`;
}

/** An amount in native base units (14 decimals), as a whole number that fits in u128. */
export function parseNativeValue(input: string | number): bigint {
  if (typeof input === 'number' && !Number.isSafeInteger(input)) {
    throw new ToolError(
      Number.isInteger(input)
        ? `value ${input} is above 2^53 - 1 as a JSON number, so digits may already be lost. Pass it as a string of digits, in native base units (1 tPOT is "100000000000000").`
        : `value must be a whole number of native base units, not ${input} (1 tPOT is "100000000000000"). Pass it as a string of digits; convert_amount turns an amount such as "1.5" into base units.`,
    );
  }
  const text = String(input);
  const t = text.trim().replace(/_/g, '');
  if (t === '') throw new ToolError('value is empty. Leave it out, or write "0", for a call that sends no tokens.');
  if (/^-\d+$/.test(t)) throw new ToolError(`value cannot be negative (got ${t}). It is the amount of native tokens sent with the call, in base units.`);
  if (!/^\d+$/.test(t)) {
    throw new ToolError(`value must be a whole number of native base units, written with digits only (1 tPOT is "100000000000000", 14 zeros). Got "${clip(text, 100)}". convert_amount turns "1.5" into base units.`);
  }
  const v = BigInt(t);
  if (v > U128_MAX) throw new ToolError('value is larger than a u128 can hold, so no account could ever send it. value counts native base units (14 decimals), not wei: convert_amount converts an amount in tokens or in wei.');
  return v;
}

/** A contract address: 0x and 40 hex characters. */
export function parseContractAddress(text: string, what = 'to'): string {
  const t = text.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return t.toLowerCase();
  if (/^5[1-9A-HJ-NP-Za-km-z]{40,}$/.test(t)) {
    throw new ToolError(`${what} must be the contract's 0x address (0x and 40 hex characters); "${clip(t, 100)}" is a native 5... address. convert_address gives the 0x form of an address.`);
  }
  throw new ToolError(`${what} must be a 0x address: 0x and 40 hex characters. "${clip(t, 100)}" has ${Math.max(0, t.replace(/^0x/i, '').length)} characters after 0x.`);
}

/* ---------- the sender ---------- */

export interface Sender {
  parsed: ParsedAddress;
  holder: Holder;
  /** The account id the dry run runs as. */
  holderId: Uint8Array;
  holderSs58: string;
  /** What a contract sees as msg.sender, with its checksum capitals. */
  msgSender: string;
}

/** "from" in either form becomes the native account that holds its balance (resolveHolder). */
export async function resolveSender(conn: Conn, input: string): Promise<Sender> {
  const parsed = parseAddress(input);
  const holder = await resolveHolder(conn, parsed);
  return { parsed, holder, holderId: holder.holderId, holderSs58: holder.holderSs58, msgSender: checksummed(h160OfAccountId(holder.holderId)) };
}

export function senderLine(s: Sender, network: Network): string {
  if (s.parsed.kind === 'h160') {
    const where = s.holder.linked ? 'the native account linked to it' : 'its fallback account: the 20 bytes followed by twelve 0xEE bytes';
    return `- from: ${checksummed(s.parsed.h160)}, an Ethereum-style address. Its ${network.token} sits on ${s.holderSs58} (${where}), so the dry run runs as that account.`;
  }
  return `- from: ${s.holderSs58}, a native account${s.parsed.isFallbackForm ? ` (the fallback form of ${checksummed(s.parsed.h160)})` : ''}.`;
}

export interface Balance {
  exists: boolean;
  free: bigint;
  reserved: bigint;
  frozen: bigint;
  nonce: bigint;
}

export async function readBalance(conn: Conn, id: Uint8Array): Promise<Balance> {
  const a = await (conn.api as Loose).query.system.account(id);
  const n = (x: Loose): bigint => BigInt(x.toString());
  return {
    exists: Number(a.providers) + Number(a.consumers) + Number(a.sufficients) > 0,
    free: n(a.data.free),
    reserved: n(a.data.reserved),
    frozen: n(a.data.frozen ?? 0),
    nonce: n(a.nonce),
  };
}

/* ---------- running the dry run ---------- */

interface RuntimeMethod {
  registry: TypeRegistry;
  inputs: string[];
  output: string;
}

const methodCache = new WeakMap<object, { spec: string; methods: Promise<Map<string, RuntimeMethod>> }>();

/** ReviveApi's methods and their types, from the chain's own metadata version 15 (which lists runtime APIs). */
function reviveMethods(api: Loose): Promise<Map<string, RuntimeMethod>> {
  const spec = String(api.runtimeVersion.specVersion);
  const cached = methodCache.get(api);
  if (cached && cached.spec === spec) return cached.methods;
  const methods = (async () => {
    const opt = await api.call.metadata.metadataAtVersion(15);
    if (opt.isNone) throw new ToolError('The node offers no metadata version 15, so its ReviveApi types cannot be read.');
    const registry = new TypeRegistry();
    const metadata = new Metadata(registry, opt.unwrap().toU8a(true));
    // the two V3 transaction extensions @polkadot/api does not know; both are empty (as in chain.ts)
    registry.setMetadata(metadata, undefined, { AuthorizeCall: { extrinsic: {}, payload: {} }, EthSetOrigin: { extrinsic: {}, payload: {} } }, true);
    const revive = metadata.asLatest.apis.find((a: Loose) => a.name.toString() === 'ReviveApi');
    const map = new Map<string, RuntimeMethod>();
    for (const m of revive?.methods ?? []) {
      map.set(m.name.toString(), { registry, inputs: m.inputs.map((i: Loose) => registry.createLookupType(i.type)), output: registry.createLookupType(m.output) });
    }
    return map;
  })();
  methods.catch(() => methodCache.delete(api));
  methodCache.set(api, { spec, methods });
  return methods;
}

/**
 * Runs ReviveApi.call or ReviveApi.instantiate in the node (a read-only state_call) and returns its JSON.
 * Uses api.call.reviveApi when @polkadot/api has it. When the connection was made from metadata
 * version 14, which lists no runtime APIs, it reads the types from version 15 and calls the node itself.
 */
export async function reviveDryRun(conn: Conn, method: 'call' | 'instantiate', args: unknown[]): Promise<Loose> {
  const api = conn.api as Loose;
  const decorated = api.call?.reviveApi?.[method];
  if (typeof decorated === 'function') return (await decorated(...args)).toJSON();
  const def = (await reviveMethods(api)).get(method);
  if (!def) throw new ToolError(`The ${conn.network.label} runtime offers no ReviveApi.${method}, so this cannot be dry-run there.`);
  if (def.inputs.length !== args.length) throw new ToolError(`ReviveApi.${method} on the ${conn.network.label} takes ${def.inputs.length} arguments, not the ${args.length} these tools were written for (Nov 14, 2026). The runtime may have been upgraded.`);
  const input = u8aConcat(...def.inputs.map((type, i) => def.registry.createType(type, args[i]).toU8a()));
  const raw = await api.rpc.state.call(`ReviveApi_${method}`, toHex(input));
  return def.registry.createType(def.output, raw.toU8a(true)).toJSON();
}

/* ---------- the dry run's answer ---------- */

export interface Weight {
  refTime: bigint;
  proofSize: bigint;
}

export interface DryRun {
  weight: Weight;
  /** storageDeposit as one signed number: a charge is positive, a refund negative. */
  net: bigint;
  /** maxStorageDeposit, the most held at any point; null when the chain did not report it. */
  max: bigint | null;
  ok: { reverted: boolean; flags: number; data: string; addr: string | null } | null;
  err: Loose;
}

/** A storage deposit as one signed number, from { charge } or { refund }. */
export function depositValue(d: Loose): bigint | null {
  if (!d || typeof d !== 'object') return null;
  if (d.charge !== undefined && d.charge !== null) return BigInt(d.charge);
  if (d.refund !== undefined && d.refund !== null) return -BigInt(d.refund);
  return null;
}

/** Reads the JSON of reviveApi.call or reviveApi.instantiate. Throws when the shape is not the one checked on Nov 14, 2026. */
export function readDryRun(json: Loose, kind: 'call' | 'instantiate'): DryRun {
  const w = json?.weightRequired;
  const result = json?.result;
  if (!w || !result || (result.ok === undefined && result.err === undefined)) {
    throw new ToolError(`The node answered the ${kind} dry run in a shape these tools do not know (fields: ${Object.keys(json ?? {}).join(', ') || 'none'}). The runtime may have been upgraded. The raw answer starts: ${JSON.stringify(json).slice(0, 300)}`);
  }
  const weight = { refTime: BigInt(w.refTime ?? 0), proofSize: BigInt(w.proofSize ?? 0) };
  const net = depositValue(json.storageDeposit) ?? 0n;
  const max = depositValue(json.maxStorageDeposit);
  if (result.err !== undefined && result.err !== null) return { weight, net, max, ok: null, err: result.err };
  const inner = kind === 'instantiate' ? result.ok?.result : result.ok;
  const flags = Number(inner?.flags?.bits ?? 0);
  return { weight, net, max, ok: { reverted: (flags & 1) === 1, flags, data: String(inner?.data ?? '0x'), addr: kind === 'instantiate' ? (result.ok?.addr ? String(result.ok.addr) : null) : null }, err: null };
}

/** The weight limit to pass: the dry run's weight + 10% on both parts. */
export const weightLimitOf = (w: Weight): Weight => ({ refTime: w.refTime + w.refTime / 10n, proofSize: w.proofSize + w.proofSize / 10n });

/** The storage deposit limit to pass: the larger of net and maximum (never below 0), + 2%. */
export function depositLimitOf(net: bigint, max: bigint | null): bigint {
  const held = [net, max ?? net, 0n].reduce((a, b) => (a > b ? a : b));
  return held + held / 50n;
}

export const weightText = (w: Weight): string => `refTime ${w.refTime}, proofSize ${w.proofSize}`;
export const weightCode = (w: Weight): string => `{ refTime: ${w.refTime}n, proofSize: ${w.proofSize}n }`;

/** "a charge of 3.8415 tPOT (...)" or "a refund of ...". */
export function depositText(v: bigint, network: Network): string {
  if (v < 0n) return `a refund of ${nativeAmount(-v, network)}`;
  return v === 0n ? `0 ${network.token}` : `a charge of ${nativeAmount(v, network)}`;
}

/* ---------- errors in a dry run ---------- */

// What we saw cause each error, Nov 14, 2026. The chain's own text is always shown too.
const SEEN: Record<string, string> = {
  'Revive.TransferFailed': 'Seen on Nov 14, 2026 when the value is more than "from" can pay: lower the value, or fund "from" first.',
  'Revive.StorageDepositNotEnoughFunds': 'Seen on Nov 14, 2026 from an account that holds nothing: "from" cannot pay the storage deposit. Fund it first.',
  'Revive.BlobTooLarge': 'On Nov 14, 2026 the testnet refused runtime code above 24576 bytes and init code above 49152 bytes, the limits Ethereum uses (EIP-170 and EIP-3860). Make the contract smaller or split it.',
  'Revive.UnsupportedPrecompileAddress': 'The address is in the range kept for built-in precompiles, and this chain has none there (seen at 0x000000000000000000000000000000000000000a on Nov 14, 2026).',
  'Revive.EvmConstructorNonEmptyData': 'For EVM code the constructor arguments go at the end of the init code, and data stays 0x (seen on Nov 14, 2026).',
  'Revive.InvalidInstruction': 'Seen on Nov 14, 2026 for code that runs the INVALID opcode (0xfe) or a byte that is no opcode (0x0c). If this is compiler output, check the EVM version it was built for: solc output for cancun runs on this chain.',
};

export interface ChainErrorText {
  /** "Revive.TransferFailed (module 80, error 4)", or a short phrase for other shapes. */
  title: string;
  /** "Revive.TransferFailed", or null when it is not a module error. */
  name: string | null;
  lines: string[];
}

/** Names a dry run's error: a module error by registry.findMetaError, anything else as JSON. */
export function explainDryRunError(api: Loose, err: Loose): ChainErrorText {
  const mod = err?.module;
  if (mod && typeof mod.index === 'number') {
    const first = typeof mod.error === 'number' ? mod.error : typeof mod.error === 'string' && /^0x[0-9a-fA-F]{2}/.test(mod.error) ? Number.parseInt(mod.error.slice(2, 4), 16) : null;
    if (first !== null) {
      try {
        const m = api.registry.findMetaError(Uint8Array.of(mod.index, first));
        const section = String(m.section);
        const name = `${section.charAt(0).toUpperCase()}${section.slice(1)}.${m.name}`;
        const docs = (m.docs ?? []).map((d: Loose) => String(d)).join(' ').trim();
        return { title: `${name} (module ${mod.index}, error ${first})`, name, lines: [docs && `The chain's text: "${docs}"`, SEEN[name] ?? ''].filter(Boolean) };
      } catch {
        /* an index the metadata does not know: shown as JSON below */
      }
    }
    return { title: `module error ${JSON.stringify(mod)}`, name: null, lines: ["The chain's metadata has no error with that index. explain_error may know it."] };
  }
  return { title: 'an error that is not a module error', name: null, lines: [`The node's answer: ${JSON.stringify(err)}. explain_error may know what it means.`] };
}

/* ---------- fees and the balance check ---------- */

/** The fee of an extrinsic from paymentInfo (payment_queryInfo). Null with a reason when the node does not answer. */
export async function feeOf(tx: Loose, payerSs58: string): Promise<{ fee: bigint | null; why: string }> {
  try {
    const info = await tx.paymentInfo(payerSs58);
    return { fee: BigInt(info.partialFee.toString()), why: '' };
  } catch (e) {
    // The node's or the library's own words, shown as one quoted string.
    return { fee: null, why: untrusted(redact(e instanceof Error ? e.message : String(e)), 300) };
  }
}

/**
 * The balance check for a native contract call or deployment:
 * value + storage deposit limit + fee + the existential deposit, against what "from" can use.
 */
export function budgetLines(network: Network, parts: { value: bigint; depositLimit: bigint; fee: bigint | null; ed: bigint }, bal: Balance, payerSs58: string): { lines: string[]; enough: boolean; total: bigint } {
  const total = parts.value + parts.depositLimit + (parts.fee ?? 0n) + parts.ed;
  // Frozen funds (staking, vesting) overlap with reserved ones; only the frozen part above reserved binds free funds.
  const lockedInFree = bal.frozen > bal.reserved ? bal.frozen - bal.reserved : 0n;
  const usable = bal.free - lockedInFree;
  const out: string[] = [
    `- total needed: value + deposit limit + fee + ${nativeAmount(parts.ed, network, false)} existential deposit = ${nativeAmount(total, network)}${parts.fee === null ? ' (without the fee, which could not be estimated)' : ''}`,
    `- free balance of ${payerSs58}: ${nativeAmount(bal.free, network)}${bal.exists ? '' : ' (the account does not exist yet: it has never held a balance)'}`,
  ];
  if (lockedInFree > 0n) out.push(`- ${nativeAmount(lockedInFree, network, false)} of it is frozen (for example by staking or vesting), so the check counts ${nativeAmount(usable, network, false)} as usable.`);
  const enough = usable >= total;
  out.push(enough ? `- verdict: enough, with ${nativeAmount(usable - total, network, false)} to spare.` : `- verdict: NOT enough. ${payerSs58} is short by ${nativeAmount(total - usable, network)}.`);
  return { lines: out, enough, total };
}

/* ---------- contract addresses ---------- */

function rlpNonce(n: bigint): number[] {
  if (n === 0n) return [0x80];
  if (n < 0x80n) return [Number(n)];
  let h = n.toString(16);
  if (h.length % 2) h = `0${h}`;
  const b = [...Buffer.from(h, 'hex')];
  return [0x80 + b.length, ...b];
}

/** CREATE: the last 20 bytes of keccak-256(rlp([deployer, nonce])). */
export function createAddress(deployerH160: string, nonce: bigint): string {
  const body = [0x94, ...hexToBytes(deployerH160), ...rlpNonce(nonce)];
  return toHex(keccakAsU8a(Uint8Array.from([0xc0 + body.length, ...body]), 256).subarray(12));
}

/** CREATE2: the last 20 bytes of keccak-256(0xff ++ deployer ++ salt ++ keccak-256(init code)). */
export function create2Address(deployerH160: string, salt: string, initcode: string): string {
  const all = Uint8Array.from([0xff, ...hexToBytes(deployerH160), ...hexToBytes(salt), ...keccakAsU8a(hexToBytes(initcode), 256)]);
  return toHex(keccakAsU8a(all, 256).subarray(12));
}

/* ---------- small text helpers ---------- */

/** Hex shown in full, unless it is longer than max hex characters. Plain ASCII. */
export function hexShown(hex: string, max = 2000): string {
  if (hex.length <= max + 2) return hex;
  return `${hex.slice(0, max + 2)}... (cut: ${(hex.length - 2) / 2} bytes in all)`;
}

export const byteLen = (hex: string): number => Math.max(0, (hex.length - 2) / 2);
