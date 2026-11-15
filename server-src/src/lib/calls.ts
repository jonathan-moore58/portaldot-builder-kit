// Native calls and Ethereum transactions, before anything is signed.
//
// buildCall turns "Module.call" and its arguments into the call @polkadot/api would send, with the
// checks that catch the usual mistakes first: amounts with a decimal point, numbers that lost
// precision as JSON, a 0x address where a native account is wanted, a struct field left out. Each
// of these would otherwise be encoded without a word (an empty amount becomes 0, short call bytes
// are padded with zeros). echoCall reads the call back the way the chain will.
//
// readEthSide reads what an Ethereum transaction needs: the gas estimate, the gas price, the balance
// and the nonce. It asks the Ethereum JSON-RPC where there is one, and the node's own runtime API
// (ReviveApi) otherwise. On Nov 14, 2026 both gave the same numbers for the same block.
//
// Nothing here can sign or send.
import { Metadata, TypeRegistry } from '@polkadot/types';
import { u8aConcat } from '@polkadot/util';
import { resolveHolder } from './accounts.ts';
import { checksummed, parseAddress, toSs58, type ParsedAddress } from './address.ts';
import { ethQuantity, ethRpc, type Conn } from './chain.ts';
import { show, toPlain } from './codec.ts';
import { EthRpcError, ToolError } from './errors.ts';
import { clip, formatUnits, isHex, lines, parseUnits, toHex } from './format.ts';
import { fullName, normName, resolveRef, type ArgInfo, type ChainIndex, type ItemInfo } from './meta.ts';
import { NATIVE_DECIMALS, PALLETS_ADDRESS, type Network } from './networks.ts';
import { searchChain } from './search.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

export interface CallContext {
  conn: Conn;
  index: ChainIndex;
  network: Network;
}

export interface BuiltCall {
  item: ItemInfo;
  /** The call as @polkadot/api holds it (a GenericCall). */
  call: Loose;
  /** The SCALE-encoded call: [module index][call index][arguments]. */
  hex: string;
  /** What was given for each argument, in order, before encoding. */
  inputs: unknown[];
}

const MAX_DEPTH = 4;
const INT_TYPE = /^(Compact<)?[ui](8|16|32|64|128|256)>?$/;
const ACCOUNT_TYPE = /^(MultiAddress|AccountId32|AccountId)$/;
const ACCOUNT_LIST = /^Vec<(MultiAddress|AccountId32|AccountId)>$/;
const CALL_TYPE = /^(Box<)?Call>?$/;
/** How ItemInfo.args[i].meaning starts for an amount of the chain's own token. */
const NATIVE_MEANING = 'an amount in the smallest unit: 1 ';

export const isNativeAmount = (a: ArgInfo | undefined): boolean => Boolean(a && a.meaning.includes(NATIVE_MEANING));

const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/** The useful end of a @polkadot/api error: "createType(Lookup42):: Compact<u128>:: Invalid character" -> "Invalid character". */
export function apiReason(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  const parts = m.split('::').map((p) => p.trim()).filter(Boolean);
  return clip(parts[parts.length - 1] ?? m, 220);
}

function looksLikeSecretPhrase(s: string): boolean {
  const words = s.trim().split(/\s+/);
  return [12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w));
}

/**
 * Checks raw JSON input before anything else: numbers that are not exact whole numbers, and text
 * that looks like a secret recovery phrase.
 */
export function checkPlainInput(value: unknown, path: string, network: Network, depth = 0): void {
  if (depth > 16) throw new ToolError(`${path} is nested too deeply. Encode the inner call on its own first with encode_call and pass its bytes.`);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ToolError(`${path} is ${value}, which is not a number a call can carry.`);
    if (!Number.isInteger(value)) {
      throw new ToolError(
        `${path} is ${value}, a number with a decimal point. Call arguments are whole numbers: an amount is counted in the smallest unit (1 ${network.token} = 100000000000000 of it). ` +
          `convert_amount turns ${value} ${network.token} into that number; pass the result as a string.`,
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new ToolError(
        `${path} is ${value}, larger than 9007199254740991 (2^53 - 1). A JSON number that large has already lost precision before it reaches this tool, so it is refused. Pass it as a string of digits, for example "150000000000000000".`,
      );
    }
    return;
  }
  if (typeof value === 'string') {
    if (looksLikeSecretPhrase(value)) {
      throw new ToolError(`${path} looks like a secret recovery phrase. Never put a secret phrase or a private key into a call or a tool: a remark is public forever. If that phrase is real, treat the account as exposed and move its funds.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkPlainInput(v, `${path}[${i}]`, network, depth + 1));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) checkPlainInput(v, `${path}.${k}`, network, depth + 1);
  }
}

/** The arguments of a call, one per line: name, type and plain meaning. */
export function expectedArgs(item: ItemInfo): string[] {
  if (!item.args.length) return [`${fullName(item)} takes no arguments.`];
  return [
    `${fullName(item)} takes ${item.args.length} argument${item.args.length === 1 ? '' : 's'}, in this order:`,
    ...item.args.map((a, i) => `  ${i + 1}. ${a.name}: ${a.type}${a.typeName && a.typeName !== a.type ? ` (${a.typeName})` : ''}${a.meaning ? ` - ${a.meaning}` : ''}`),
  ];
}

function notFound(ctx: CallContext, ref: string, where: string): never {
  const near = searchChain(ctx.index, ref.slice(0, 300).replace(/::|[./]/g, ' '), ['call'], 6);
  const names = [...new Set([...near.jobs.map((j) => fullName(j.item)), ...near.hits.filter((h) => h.item).map((h) => fullName(h.item as ItemInfo))])].slice(0, 6);
  throw new ToolError(
    lines(
      `${where}The ${ctx.network.label} (runtime ${ctx.index.specVersion}) has no call named "${clip(ref, 100)}".`,
      names.length ? `Closest names: ${names.join(', ')}.` : null,
      'describe_item with a module name lists all of its calls; search_chain finds a call by what it does. Do not fall back on a name from another chain: if it is not listed, this chain does not have it.',
    ),
  );
}

function orderArgs(item: ItemInfo, args: unknown, where: string): unknown[] {
  const n = item.args.length;
  if (args === undefined || args === null) {
    if (n === 0) return [];
    throw new ToolError(lines(`${where}${fullName(item)} needs ${n} argument${n === 1 ? '' : 's'} and none were given.`, ...expectedArgs(item)));
  }
  if (Array.isArray(args)) {
    if (args.length !== n) {
      throw new ToolError(lines(`${where}${fullName(item)} takes ${n} argument${n === 1 ? '' : 's'}, but ${args.length} ${args.length === 1 ? 'was' : 'were'} given.`, ...expectedArgs(item), 'Give them as an array in this order, or as an object by name.'));
    }
    return args;
  }
  if (typeof args === 'object') {
    const byName = new Map(item.args.map((a, i) => [normName(a.name), i] as const));
    const out: unknown[] = new Array(n);
    const seen = new Set<number>();
    const unknown: string[] = [];
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      const i = byName.get(normName(k));
      if (i === undefined) unknown.push(k);
      else {
        out[i] = v;
        seen.add(i);
      }
    }
    const missing = item.args.filter((_, i) => !seen.has(i)).map((a) => a.name);
    if (unknown.length || missing.length) {
      throw new ToolError(
        lines(
          `${where}${[unknown.length && `${fullName(item)} has no argument named ${unknown.slice(0, 8).map((u) => `"${clip(u, 100)}"`).join(', ')}.`, missing.length && `Missing: ${missing.join(', ')}.`].filter(Boolean).join(' ')}`,
          ...expectedArgs(item),
        ),
      );
    }
    return out;
  }
  throw new ToolError(`${where}the arguments of ${fullName(item)} must be an array in order, or an object by argument name. Got ${typeof args}.`);
}

/** Most decimal digits, and most characters of a 0x number (0x and 64 hex digits), that a whole number of any type here can have. */
export const MAX_NUMBER_DIGITS = 80;
export const MAX_NUMBER_HEX = 66;

export function checkWhole(value: unknown, a: ArgInfo, label: string, network: Network): unknown {
  const amount = isNativeAmount(a);
  const unit = amount ? ` of the smallest unit (1 ${network.token} = 100000000000000 of it)` : '';
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    throw new ToolError(`${label} is empty. It must be a whole number${unit}. @polkadot/api would encode an empty value as 0 without a warning, so it is refused here.`);
  }
  if (typeof value === 'number') return value; // checkPlainInput has already refused fractions and unsafe numbers
  if (typeof value === 'string') {
    const s = value.trim();
    // @polkadot/api reads a long decimal number with a parser that slows down with the square of its
    // length, so a number longer than any of these types can hold is refused first.
    const tooLong = (): ToolError =>
      new ToolError(`${label} has ${s.length} characters, more than any whole number of ${a.type} can have (at most ${MAX_NUMBER_DIGITS} digits, or 0x and 64 hex digits). Nothing was encoded.`);
    if (/^\d+$/.test(s)) {
      if (s.length > MAX_NUMBER_DIGITS) throw tooLong();
      return s;
    }
    if (/^0x[0-9a-fA-F]+$/.test(s)) {
      if (s.length > MAX_NUMBER_HEX) throw tooLong();
      return BigInt(s);
    }
    const shown = clip(s, 100);
    if (/^\d*\.\d*$/.test(s) && /\d/.test(s)) {
      if (!amount) throw new ToolError(`${label} is "${shown}", which has a decimal point. It must be a whole number.`);
      let hint = '';
      try {
        if (s.length <= MAX_NUMBER_DIGITS) hint = ` If you mean ${s} ${network.token}, that is "${parseUnits(s, NATIVE_DECIMALS)}".`;
      } catch {
        /* more decimals than the token has: no hint */
      }
      throw new ToolError(
        `${label} is "${shown}", which has a decimal point. ${a.name} is an amount in the smallest unit, a whole number: 1 ${network.token} is 100000000000000 of it.${hint} ` +
          'convert_amount does this conversion and shows both sides (14 and 18 decimals); pass its result as a string.',
      );
    }
    throw new ToolError(`${label} is "${shown}", which is not a whole number. Write it with digits only, for example "1000000000000", or as 0x hex: no commas, underscores, signs, units or exponent.`);
  }
  throw new ToolError(`${label} must be a whole number: digits in a string, or a JSON number up to 9007199254740991. Got ${clip(safeJson(value), 80)}.`);
}

const ACCOUNT_FORMS: Record<string, 'Id' | 'Address32' | 'Address20'> = { id: 'Id', address32: 'Address32', address20: 'Address20' };

/**
 * An account written in an explicit form of MultiAddress: {"Id": ...}, {"Address32": ...} or
 * {"Address20": ...}. The string inside goes through parseAddress, which refuses junk and very long
 * text before the encoder's base58 parser (slow on long input) sees it. Returns the form to encode,
 * { h160 } for an Id that holds a 0x address (answered like a bare 0x address), or null when the
 * value is not one of these forms (it then goes to the encoder as it is).
 */
export function explicitAccount(value: unknown, label: string): { value: Record<string, string> } | { h160: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const form = keys.length === 1 ? ACCOUNT_FORMS[keys[0].toLowerCase()] : undefined;
  const inner = form ? (value as Record<string, unknown>)[keys[0]] : undefined;
  if (!form || typeof inner !== 'string') return null;
  let parsed: ParsedAddress;
  try {
    parsed = parseAddress(inner);
  } catch (err) {
    throw new ToolError(`${label} ({"${form}": ...}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (form === 'Address20') {
    if (parsed.kind !== 'h160') throw new ToolError(`${label}: {"Address20": ...} holds a 0x address of 40 hex characters, and this is a 32-byte account. A native account is written as a 5... address, or as {"Id": "5..."}.`);
    return { value: { [keys[0]]: parsed.h160 } };
  }
  if (parsed.kind === 'h160') {
    if (form === 'Id') return { h160: inner.trim() };
    throw new ToolError(`${label}: {"Address32": ...} holds 32 bytes (a 5... address or a 0x account id of 64 hex characters), and this is a 0x address of 20 bytes.`);
  }
  return { value: { [keys[0]]: form === 'Id' ? inner.trim() : toHex(parsed.accountId) } };
}

async function checkAccount(ctx: CallContext, value: unknown, label: string): Promise<unknown> {
  const form = explicitAccount(value, label);
  if (form && 'h160' in form) return checkAccount(ctx, form.h160, label);
  if (form) return form.value;
  if (typeof value !== 'string') return value; // another form, such as { "Index": 1 }, goes to the encoder as it is
  let parsed;
  try {
    parsed = parseAddress(value);
  } catch (err) {
    throw new ToolError(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.kind === 'h160') {
    const holder = await resolveHolder(ctx.conn, parsed);
    throw new ToolError(
      `${label} wants a native account (SS58, it starts with 5), but ${value.trim()} is a 0x address. @polkadot/api would encode it in the 20-byte Address20 form, which was not tested on this chain. ` +
        `The native account that holds that 0x address's balance is ${holder.holderSs58}${holder.linked ? ' (the native account it belongs to)' : ' (its fallback account: the 20 bytes followed by twelve 0xEE bytes)'}. ` +
        'Pass that if it is the account you mean; convert_address explains both forms.',
    );
  }
  return value.trim();
}

/** Struct arguments given as objects: every field must be named, because a field left out is encoded as 0. */
function checkStructFields(api: Loose, typeId: Loose, value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  let def: Loose;
  try {
    def = api.registry.lookup.getTypeDef(typeId);
  } catch {
    return;
  }
  if (!Array.isArray(def?.sub) || typeof def.type !== 'string' || !/^\{"(?!_enum|_set)/.test(def.type)) return;
  const names: string[] = def.sub.map((s: Loose) => String(s.name ?? '')).filter(Boolean);
  if (!names.length) return;
  const snake = (n: string): string => n.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const accepted = new Map<string, string>();
  for (const n of names) {
    accepted.set(n, n);
    accepted.set(snake(n), n);
  }
  const keys = Object.keys(value as Record<string, unknown>);
  const unknown = keys.filter((k) => !accepted.has(k));
  const given = new Set(keys.map((k) => accepted.get(k)).filter(Boolean));
  const missing = names.filter((n) => !given.has(n));
  if (unknown.length || missing.length) {
    throw new ToolError(
      `${label} is a structure with the fields ${names.join(', ')}. ${[unknown.length && `It has no field ${unknown.slice(0, 8).map((u) => `"${clip(u, 100)}"`).join(', ')}.`, missing.length && `Missing: ${missing.join(', ')}.`].filter(Boolean).join(' ')} ` +
        '@polkadot/api would encode a missing field as 0 without a warning, so give every field, and write 0 (or null for an optional field) where you mean it.',
    );
  }
}

/** Reads call bytes and checks that they are exactly one call of this chain. */
export function decodeCallBytes(ctx: CallContext, hex: string, label: string): Loose {
  const s = hex.trim();
  if (!isHex(s) || s.length < 6) {
    throw new ToolError(`${label}: "${clip(s, 60)}" is not call bytes. Call bytes are 0x and an even number of hex characters, starting with the module index and the call index (0x0603... for Balances.transferKeepAlive).`);
  }
  let call: Loose;
  try {
    call = (ctx.conn.api as Loose).createType('Call', s);
  } catch (err) {
    throw new ToolError(`${label}: the bytes ${clip(s, 40)} are not a call of the ${ctx.network.label}: ${apiReason(err)}. Call bytes start with the module index and the call index; describe_item shows both.`);
  }
  const back: string = call.toHex();
  if (back !== s.toLowerCase()) {
    throw new ToolError(
      `${label}: the bytes are not exactly one call. They start like ${callName(ctx.index, call)}, whose full encoding is ${(back.length - 2) / 2} bytes, but ${(s.length - 2) / 2} bytes were given. ` +
        '(@polkadot/api would drop extra bytes and pad missing ones with zeros without a warning.) Pass the bytes of one call exactly as encode_call printed them.',
    );
  }
  return call;
}

async function toInnerCall(ctx: CallContext, value: unknown, label: string, depth: number): Promise<Loose> {
  if (typeof value === 'string') return decodeCallBytes(ctx, value, label);
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Loose).call === 'string') {
    const extra = Object.keys(value).filter((k) => k !== 'call' && k !== 'args');
    if (extra.length) throw new ToolError(`${label}: an inner call is { "call": "Module.name", "args": [...] }; it has the unexpected field(s) ${extra.slice(0, 8).map((k) => clip(k, 100)).join(', ')}.`);
    return (await buildCall(ctx, (value as Loose).call, (value as Loose).args, `${label} > `, depth + 1)).call;
  }
  throw new ToolError(`${label} must be a call: its bytes as 0x hex (from an earlier encode_call), or { "call": "Module.name", "args": [...] }. Got ${clip(safeJson(value), 80)}.`);
}

/** "Balances.transferKeepAlive argument 2 (value)", with the outer calls in front for an inner call. */
const argLabel = (item: ItemInfo, i: number, where: string): string => `${where}${fullName(item)} argument ${i + 1} (${item.args[i].name})`;

async function prepareArg(ctx: CallContext, item: ItemInfo, i: number, value: unknown, where: string, depth: number): Promise<unknown> {
  const a = item.args[i];
  const label = argLabel(item, i, where);
  if (CALL_TYPE.test(a.type)) return toInnerCall(ctx, value, label, depth);
  if (a.type === 'Vec<Call>') {
    if (!Array.isArray(value)) throw new ToolError(`${label} is a list of calls: give an array whose entries are call bytes (0x...) or { "call": "Module.name", "args": [...] }.`);
    const out: Loose[] = [];
    for (let j = 0; j < value.length; j++) out.push(await toInnerCall(ctx, value[j], `${label}, entry ${j + 1}`, depth));
    return out;
  }
  if (INT_TYPE.test(a.type)) return checkWhole(value, a, label, ctx.network);
  if (ACCOUNT_TYPE.test(a.type)) return checkAccount(ctx, value, label);
  if (ACCOUNT_LIST.test(a.type) && Array.isArray(value)) {
    const out: unknown[] = [];
    for (let j = 0; j < value.length; j++) out.push(await checkAccount(ctx, value[j], `${label}, entry ${j + 1}`));
    return out;
  }
  if (/AccountId|MultiAddress/.test(a.type)) refuseLongAccountText(value, label);
  return value;
}

/**
 * An account inside another type (a tuple or a struct, such as Identity.setSubs) reaches the
 * encoder's base58 parser as it is, and that parser slows down with the square of the length:
 * 3.5 s for 19999 characters, measured on Nov 14, 2026. An address has at most 66 characters, so
 * inside such an argument a base58 string longer than 120 characters is refused.
 */
export function refuseLongAccountText(v: unknown, label: string, depth = 0): void {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.length > 120 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(t)) {
      throw new ToolError(`${label} holds a value of ${t.length} characters where an account can be, far too long for an address (a native address has about 48 characters). Nothing was encoded.`);
    }
    return;
  }
  if (depth > 16 || !v || typeof v !== 'object') return;
  for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) refuseLongAccountText(x, label, depth + 1);
}

/** Builds a call from its name and arguments (an array in order, or an object by name). Nested calls are built first. */
export async function buildCall(ctx: CallContext, ref: string, args: unknown, where = '', depth = 0): Promise<BuiltCall> {
  if (depth > MAX_DEPTH) throw new ToolError(`${where}calls are nested more than ${MAX_DEPTH} deep. Encode the inner call on its own first and pass its bytes.`);
  const { items } = resolveRef(ctx.index, ref, 'call');
  if (!items.length) notFound(ctx, ref, where);
  if (items.length > 1) {
    throw new ToolError(`${where}"${ref}" names ${items.length} calls on the ${ctx.network.label}: ${items.map(fullName).join(', ')}. Put the module in front, for example "${fullName(items[0])}".`);
  }
  const item = items[0];
  const inputs = orderArgs(item, args, where);
  const api = ctx.conn.api as Loose;
  const fn = api.tx[item.section]?.[item.name];
  if (!fn) throw new ToolError(`${where}${fullName(item)} is in the metadata but @polkadot/api offers no api.tx.${item.section}.${item.name}.`);
  const fields: Loose[] = fn.meta.fields;
  const codecs: Loose[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const a = item.args[i];
    const prepared = await prepareArg(ctx, item, i, inputs[i], where, depth);
    checkStructFields(api, fields[i].type, inputs[i], argLabel(item, i, where));
    try {
      codecs.push(api.registry.createType(api.registry.createLookupType(fields[i].type), prepared));
    } catch (err) {
      throw new ToolError(
        lines(
          `${argLabel(item, i, where)} cannot be encoded as ${a.type}: ${apiReason(err)}. Given: ${clip(safeJson(inputs[i]), 160)}.`,
          ...expectedArgs(item),
          'describe_item gives the full description of each argument.',
        ),
      );
    }
  }
  let tx: Loose;
  try {
    tx = fn(...codecs);
  } catch (err) {
    throw new ToolError(lines(`${where}${fullName(item)} could not be built: ${apiReason(err)}.`, ...expectedArgs(item)));
  }
  return { item, call: tx.method, hex: tx.method.toHex(), inputs };
}

/* ---------- reading a call back ---------- */

export function findCallItem(index: ChainIndex, call: Loose): ItemInfo | undefined {
  const section = String(call.section);
  const method = String(call.method);
  return index.items.find((it) => it.kind === 'call' && it.section === section && it.name === method);
}

export function callName(index: ChainIndex, call: Loose): string {
  const it = findCallItem(index, call);
  return it ? fullName(it) : `${call.section}.${call.method}`;
}

const byteLength = (hex: string): number => (hex.length - 2) / 2;

function bytesText(codec: Loose, input: unknown): string {
  const u8a: Uint8Array = codec.toU8a(true);
  const hex: string = codec.toHex();
  let text: string | null = null;
  if (u8a.length) {
    try {
      const t = new TextDecoder('utf-8', { fatal: true }).decode(u8a);
      // eslint-disable-next-line no-control-regex
      if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) text = t;
    } catch {
      /* not text */
    }
  }
  const given =
    typeof input === 'string' ? (/^0x([0-9a-fA-F]{2})*$/.test(input.trim()) ? ' (you gave 0x hex, so it was read as raw bytes)' : ' (you gave text, so it was read as UTF-8)') : '';
  return `${text !== null ? `"${clip(text, 160)}" = ` : ''}${clip(hex, 200)}, ${u8a.length} byte${u8a.length === 1 ? '' : 's'}${given}`;
}

function renderValue(codec: Loose, a: ArgInfo | undefined, type: string, input: unknown, network: Network): { text: string; native: bigint } {
  if (isNativeAmount(a)) {
    if (INT_TYPE.test(type)) {
      const v = BigInt(codec.toString());
      return { text: `${v} base units = ${formatNative(v, network)}`, native: v };
    }
    if (typeof codec.isNone === 'boolean') {
      if (codec.isNone) return { text: 'none', native: 0n };
      const inner = codec.unwrap();
      if (/^\d+$/.test(inner.toString())) {
        const v = BigInt(inner.toString());
        return { text: `${v} base units = ${formatNative(v, network)}`, native: v };
      }
    }
  }
  if (type === 'MultiAddress') return { text: multiAddressText(codec), native: 0n };
  if (type === 'AccountId32' || type === 'AccountId') return { text: toSs58(codec.toU8a()), native: 0n };
  if (ACCOUNT_LIST.test(type)) {
    const list: string[] = [...codec].map((c: Loose) => (typeof c.type === 'string' && 'inner' in c ? multiAddressText(c) : toSs58(c.toU8a())));
    return { text: `[${list.join(', ')}]`, native: 0n };
  }
  if (type === 'H160') return { text: `${checksummed(codec.toHex())} (a 0x address)`, native: 0n };
  if (type === 'Bytes' || type === 'Vec<u8>') return { text: bytesText(codec, input), native: 0n };
  if (INT_TYPE.test(type)) return { text: codec.toString(), native: 0n };
  return { text: clip(show(toPlain(codec), 400, 0), 400), native: 0n };
}

const formatNative = (v: bigint, network: Network): string => `${formatUnits(v, NATIVE_DECIMALS)} ${network.token}`;

/** A MultiAddress (an enum: Id, Index, Raw, Address32, Address20) as text. Its variant is in .type. */
function multiAddressText(codec: Loose): string {
  if (codec.type === 'Id') return `${toSs58(codec.inner.toU8a())} (a native account)`;
  return `${codec.type} ${codec.inner.toString()} (WARNING: not the Id form, which is how a native account is named)`;
}

export interface Echo {
  lines: string[];
  /** The sum of every native amount among the arguments, inner calls included. */
  nativeTotal: bigint;
  /** True when one of those amounts is a limit (a deposit limit, a maximum), which may not be spent in full. */
  hasLimit: boolean;
}

/** Every argument of a call as the chain decodes it, inner calls included. */
export function echoCall(ctx: CallContext, call: Loose, inputs: unknown[] | null, indent: string, depth = 0): Echo {
  const item = findCallItem(ctx.index, call);
  const out: string[] = [];
  let total = 0n;
  let hasLimit = false;
  const args: Loose[] = [...call.args];
  args.forEach((codec, i) => {
    const a = item?.args[i];
    const name = a?.name ?? `argument ${i + 1}`;
    const type = a?.type ?? String(codec.toRawType());
    if (CALL_TYPE.test(type) && depth < 6) {
      const hex: string = codec.toHex();
      out.push(`${indent}${name}: ${callName(ctx.index, codec)}, ${byteLength(hex)} bytes: ${clip(hex, 200)}`);
      const inner = echoCall(ctx, codec, null, `${indent}    `, depth + 1);
      out.push(...inner.lines);
      total += inner.nativeTotal;
      hasLimit ||= inner.hasLimit;
    } else if (type === 'Vec<Call>' && depth < 6) {
      const calls: Loose[] = [...codec];
      out.push(`${indent}${name}: ${calls.length} call${calls.length === 1 ? '' : 's'}`);
      calls.forEach((c, j) => {
        const hex: string = c.toHex();
        out.push(`${indent}  ${j + 1}. ${callName(ctx.index, c)}, ${byteLength(hex)} bytes: ${clip(hex, 200)}`);
        const inner = echoCall(ctx, c, null, `${indent}     `, depth + 1);
        out.push(...inner.lines);
        total += inner.nativeTotal;
        hasLimit ||= inner.hasLimit;
      });
    } else {
      const { text, native } = renderValue(codec, a, type, inputs?.[i], ctx.network);
      out.push(`${indent}${name}: ${text}`);
      total += native;
      if (native > 0n && /limit|max|deposit/i.test(name)) hasLimit = true;
    }
  });
  if (!args.length) out.push(`${indent}(no arguments)`);
  return { lines: out, nativeTotal: total, hasLimit };
}

/** A line of the chain's own notes that says the call needs a special origin, if there is one. */
export function specialOriginNote(item: ItemInfo): string | null {
  const text = item.docs.join(' ').replace(/\s+/g, ' ');
  const m = /[^.]*\b(origin must be `?root`?|must be (called by )?`?root`?|`?root`? origin|privileged function|ensure_root)[^.]*\./i.exec(text);
  return m ? clip(m[0].replace(/`/g, '').trim(), 200) : null;
}

/* ---------- the Ethereum side ---------- */

/** Why a native call sent from a 0x account to the pallets address is expected to work, and its limits. */
export const PALLETS_ROUTE_BASIS =
  'Proven on Nov 13, 2026 with System.remarkWithEvent and Balances.transferKeepAlive (testnet blocks 452626 and 452633). ' +
  'The receipt of such a transaction shows gasUsed 0 and no logs; its result is in the Substrate events of the same block. ' +
  'Other calls were not sent this way; on Nov 15, 2026, 143 dry runs of native calls across 18 modules ran each call as a native call and answered with its result (a gas figure, or "Failed to dispatch call:" and the call\'s own error). A call that needs a special origin (root) cannot work this way.';

/** What the runtime-API path rests on. */
export const RUNTIME_PATH_BASIS =
  "On Nov 14, 2026 the node's runtime API gave exactly the same estimate as eth_estimateGas on the testnet, at the same block, for 10 different transactions (native calls through the pallets address, value transfers, deployments and contract calls) and the same error for 3 failing ones, and the same balance, nonce and gas price.";

/** Our measured rules for storage deposits, to judge the size of an estimate. */
export const depositScale = (token: string): string =>
  `a new 32-byte contract storage slot holds 3.8415 ${token}; deploying code whose runtime part is L bytes holds 0.078 x L + 13.11 ${token} (measured Oct 19 and Nov 14, 2026; when the same code is already on the chain, a new contract with it holds 7.65 plus 30 percent of that code's deposit instead, measured Nov 14, 2026)`;

export interface EthQuery {
  /** A 0x address, lower case. */
  from: string;
  /** A 0x address, or undefined for a contract deployment. */
  to?: string;
  data?: string;
  /** In wei. */
  value: bigint;
}

export interface EthFailure {
  /** True when the call itself reverted. */
  revert: boolean;
  /** The JSON-RPC error code, when the answer came from the Ethereum RPC. */
  code: number | null;
  message: string;
  /** The revert data, when there is any. */
  data: string | null;
}

export interface EthReading {
  /** 'rpc': the Ethereum JSON-RPC; 'runtime': the node's runtime API (ReviveApi). */
  path: 'rpc' | 'runtime';
  estimate: bigint | null;
  failure: EthFailure | null;
  /** Wei per gas. */
  gasPrice: bigint;
  /** What eth_getBalance reports, in wei: free less the larger of the existential deposit and the frozen amount, plus the account's dust. */
  balance: bigint;
  nonceLatest: bigint;
  noncePending: bigint;
  /** Set when the network has an Ethereum RPC but it gave no usable answer, so the runtime API was asked instead. */
  fallbackReason?: string;
}

const failureOf = (e: EthRpcError): EthFailure => ({
  revert: e.code === 3 || /revert/i.test(e.message),
  code: e.code,
  message: e.message,
  data: typeof e.data === 'string' ? e.data : null,
});

async function readByRpc(network: Network, q: EthQuery): Promise<EthReading> {
  const tx: Record<string, string> = { from: q.from };
  if (q.to) tx.to = q.to;
  if (q.data && q.data !== '0x') tx.data = q.data;
  if (q.value > 0n) tx.value = `0x${q.value.toString(16)}`;
  const estimate = ethRpc<string>(network, 'eth_estimateGas', [tx]).then(
    (v) => ({ value: ethQuantity(v, 'eth_estimateGas'), failure: null as EthFailure | null }),
    (err: unknown) => {
      if (err instanceof EthRpcError) return { value: null as bigint | null, failure: failureOf(err) };
      throw err;
    },
  );
  const [est, gasPrice, balance, latest, pending] = await Promise.all([
    estimate,
    ethRpc<string>(network, 'eth_gasPrice'),
    ethRpc<string>(network, 'eth_getBalance', [q.from, 'latest']),
    ethRpc<string>(network, 'eth_getTransactionCount', [q.from, 'latest']),
    ethRpc<string>(network, 'eth_getTransactionCount', [q.from, 'pending']),
  ]);
  // A value that is not a 0x number is a ToolError, so readEthSide asks the node instead.
  return {
    path: 'rpc',
    estimate: est.value,
    failure: est.failure,
    gasPrice: ethQuantity(gasPrice, 'eth_gasPrice'),
    balance: ethQuantity(balance, 'eth_getBalance'),
    nonceLatest: ethQuantity(latest, 'eth_getTransactionCount'),
    noncePending: ethQuantity(pending, 'eth_getTransactionCount'),
  };
}

interface RuntimeFn {
  registry: TypeRegistry;
  inputs: string[];
  output: string;
}
const reviveFnCache = new WeakMap<object, { spec: string; fns: Promise<Map<string, RuntimeFn>> }>();

/** ReviveApi's methods by their metadata name (eth_estimate_gas), with their types, from the chain's metadata version 15. */
function reviveFns(conn: Conn): Promise<Map<string, RuntimeFn>> {
  const api = conn.api as Loose;
  const spec = String(api.runtimeVersion.specVersion);
  const cached = reviveFnCache.get(api);
  if (cached && cached.spec === spec) return cached.fns;
  const fns = (async () => {
    const opt = await api.call.metadata.metadataAtVersion(15);
    if (opt.isNone) throw new ToolError(`The ${conn.network.label} node offers no metadata version 15, so its ReviveApi types cannot be read.`);
    const registry = new TypeRegistry();
    const metadata = new Metadata(registry, opt.unwrap().toU8a(true));
    registry.setMetadata(metadata, undefined, { AuthorizeCall: { extrinsic: {}, payload: {} }, EthSetOrigin: { extrinsic: {}, payload: {} } }, true);
    const revive = (metadata.asLatest as Loose).apis.find((a: Loose) => a.name.toString() === 'ReviveApi');
    const map = new Map<string, RuntimeFn>();
    for (const m of revive?.methods ?? []) {
      map.set(m.name.toString(), { registry, inputs: m.inputs.map((i: Loose) => registry.createLookupType(i.type)), output: registry.createLookupType(m.output) });
    }
    return map;
  })();
  fns.catch(() => reviveFnCache.delete(api));
  reviveFnCache.set(api, { spec, fns });
  return fns;
}

/**
 * One ReviveApi runtime call (a read-only state_call), as JSON. The connection is made from the saved
 * metadata version 14, which lists no runtime APIs, so @polkadot/api offers no api.call.reviveApi on
 * it: the types are read from version 15 and the node is asked directly. Uses api.call.reviveApi when
 * it is there.
 */
export async function reviveCall(conn: Conn, name: string, args: unknown[]): Promise<Loose> {
  const api = conn.api as Loose;
  const decorated = api.call?.reviveApi?.[name.replace(/_([a-z])/g, (_m: string, c: string) => c.toUpperCase())];
  if (typeof decorated === 'function') return (await decorated(...args)).toJSON();
  const fn = (await reviveFns(conn)).get(name);
  if (!fn || fn.inputs.length !== args.length) {
    throw new ToolError(`The ${conn.network.label} runtime offers no ReviveApi.${name} with ${args.length} argument${args.length === 1 ? '' : 's'}, so the Ethereum side cannot be read through the node. The runtime may have been upgraded since Nov 14, 2026.`);
  }
  const input = u8aConcat(...fn.inputs.map((type, i) => fn.registry.createType(type, args[i]).toU8a()));
  const raw = await api.rpc.state.call(`ReviveApi_${name}`, `0x${Buffer.from(input).toString('hex')}`);
  return fn.registry.createType(fn.output, raw.toU8a(true)).toJSON();
}

async function readByRuntime(conn: Conn, q: EthQuery): Promise<EthReading> {
  const api = conn.api as Loose;
  const tx = {
    from: q.from,
    to: q.to ?? null,
    value: q.value > 0n ? `0x${q.value.toString(16)}` : null,
    input: { input: q.data && q.data !== '0x' ? q.data : '0x', data: null },
    accessList: null,
    authorizationList: [],
    blobVersionedHashes: [],
    blobs: [],
    chainId: null,
    gas: null,
    gasPrice: null,
    maxFeePerBlobGas: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    nonce: null,
    r_type: null,
  };
  const holder = await resolveHolder(conn, parseAddress(q.from));
  const [json, gasPrice, balance, latest, pending] = await Promise.all([
    reviveCall(conn, 'eth_estimate_gas', [tx, { timestampOverride: null, performBalanceChecks: null, stateOverrides: null }]),
    reviveCall(conn, 'gas_price', []),
    reviveCall(conn, 'balance', [q.from]),
    reviveCall(conn, 'nonce', [q.from]),
    api.rpc.system.accountNextIndex(holder.holderSs58),
  ]);
  let estimate: bigint | null = null;
  let failure: EthFailure | null = null;
  if (json && json.ok !== undefined && json.ok !== null) estimate = BigInt(json.ok);
  else if (json?.err?.data !== undefined) failure = { revert: true, code: null, message: 'execution reverted', data: String(json.err.data) };
  else failure = { revert: false, code: null, message: String(json?.err?.message ?? safeJson(json?.err ?? json)), data: null };
  return {
    path: 'runtime',
    estimate,
    failure,
    gasPrice: BigInt(gasPrice),
    balance: BigInt(balance),
    nonceLatest: BigInt(latest),
    noncePending: BigInt(pending.toString()),
  };
}

/**
 * The gas estimate, gas price, balance and nonce of an Ethereum transaction. Uses the Ethereum RPC
 * where the network has one, and the node's runtime API when it has none or gives no usable answer.
 */
export async function readEthSide(conn: Conn, q: EthQuery): Promise<EthReading> {
  if (conn.network.evm) {
    try {
      return await readByRpc(conn.network, q);
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      const reading = await readByRuntime(conn, q);
      reading.fallbackReason = err.message.split('. ')[0];
      return reading;
    }
  }
  return readByRuntime(conn, q);
}

/** Our gas rule: gas limit = estimate + 10 percent, max fee per gas = gas price + one eighth, priority fee 0. */
export function ethLimits(estimate: bigint, gasPrice: bigint, value: bigint): { gasLimit: bigint; maxFee: bigint; needed: bigint } {
  const gasLimit = estimate + estimate / 10n;
  const maxFee = gasPrice + gasPrice / 8n;
  return { gasLimit, maxFee, needed: value + gasLimit * maxFee };
}

export const isPalletsAddress = (h160: string): boolean => h160.toLowerCase() === PALLETS_ADDRESS;
