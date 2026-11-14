// Everything the chain's own metadata says about its modules: calls, events, errors, constants and
// storage, with their exact names, arguments and text. Read once per network and runtime version.
import type { ApiPromise } from '@polkadot/api';
import { stringCamelCase } from '@polkadot/util';
import type { Conn } from './chain.ts';
import { formatUnits } from './format.ts';
import { GROUP_OF, MODULE_NOTES, type Group, type ItemKind, withToken } from './knowledge.ts';
import { NATIVE_DECIMALS } from './networks.ts';

export interface ArgInfo {
  name: string;
  /** The type as @polkadot/api names it, such as MultiAddress or Compact<u128>. */
  type: string;
  /** The name the runtime's own code uses for it, such as Balance. Often says more than the type. */
  typeName: string;
  /** What the type means, in a few plain words. Empty when there is nothing safe to say. */
  meaning: string;
  /** For a struct or an enum (also inside Option or Vec): its fields or variants, a few levels deep, one line each. */
  shape?: string[];
}

export interface ItemInfo {
  kind: ItemKind;
  /** The module's name as the chain writes it: Balances. */
  module: string;
  /** The same name the way @polkadot/api writes it: balances. */
  section: string;
  name: string;
  /** Position inside the module (call, event or error index). Null for constants and storage. */
  index: number | null;
  args: ArgInfo[];
  /** The chain's own text for the item, line by line, with names written the JavaScript way. */
  docs: string[];
  /** The first paragraph of that text, as one plain line. */
  summary: string;
  /** Constants: the value, as text. */
  value?: string;
  /** Constants and storage: the type of the value. */
  valueType?: string;
  /** Storage maps: the type of each key, in order. Empty for a plain value. */
  keyTypes?: string[];
  /** Storage: true when a missing entry reads as "none" rather than as a default value. */
  optional?: boolean;
  /** Constants and storage: the fields or variants of the value's type, when it is a struct or an enum. */
  valueShape?: string[];
}

export interface ModuleInfo {
  name: string;
  section: string;
  index: number;
  /** Our one line on what the module is for; empty for a module we have not described. */
  note: string;
  group: Group | null;
  calls: ItemInfo[];
  events: ItemInfo[];
  errors: ItemInfo[];
  constants: ItemInfo[];
  storage: ItemInfo[];
}

export interface ChainIndex {
  specVersion: number;
  token: string;
  modules: ModuleInfo[];
  items: ItemInfo[];
}

/* ---------- the chain's text, made readable ---------- */

// A line that only defines a doc link, such as "[`x`]: struct.Pallet.html#method.x", says nothing to a reader.
const isLinkDef = (line: string): boolean => /^\[[^\]]+\]:\s/.test(line.trim());

// The chain's text names things the Rust way (transfer_keep_alive, Pallet::create_pool). JavaScript
// libraries write the same names in camelCase, so the text is made to match.
function tidyCode(code: string): string {
  let c = code.trim().replace(/^(Pallet|Self|Call|Event|Error|Config)(<[^>]*>)?::/, '');
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(c)) c = stringCamelCase(c);
  return c;
}

const tidyLine = (line: string): string =>
  line
    .replace(/`([^`]+)`/g, (_m, code: string) => `\`${tidyCode(code)}\``)
    .replace(/\[(`[^`]*`)\](\([^)]*\))?/g, '$1')
    .replace(/\s+$/, '');

function tidyDocs(raw: string[]): string[] {
  const out = raw.filter((l) => !isLinkDef(l)).map((l) => tidyLine(l.replace(/^ /, '')));
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

function firstParagraph(docs: string[]): string {
  const first: string[] = [];
  for (const l of docs) {
    const t = l.trim();
    if (!t || /^#+\s/.test(t)) {
      if (first.length) break;
      continue;
    }
    first.push(t);
  }
  return first.join(' ').replace(/`/g, '').replace(/[*[\]]/g, '');
}

/* ---------- what a type means ---------- */

function explainOne(t: string, tn: string, moduleName: string, token: string): string {
  if (/Balance|Price$/.test(tn)) {
    // Modules whose amounts are in the chain's own token. A token module counts in that token's units.
    const groupId = GROUP_OF.get(moduleName)?.id ?? '';
    const native = ['money', 'staking', 'governance', 'contracts'].includes(groupId) && !/Asset/.test(tn) && moduleName !== 'MultiAssetBounties' && moduleName !== 'AssetConversionTxPayment';
    if (native) return `an amount in the smallest unit: 1 ${token} is 1 followed by ${NATIVE_DECIMALS} zeros (10n ** ${NATIVE_DECIMALS}n in code)`;
    return "an amount, counted in the token's smallest unit";
  }
  if (/AccountIdLookup|LookupSource|^AccountId/.test(tn) || t === 'MultiAddress' || t === 'AccountId32') return 'an account address in SS58 form (it starts with 5), not a 0x address';
  if (t === 'H160') return 'an Ethereum-style address: 0x and 40 hex characters';
  if (t === 'H256') return 'a 32-byte hash: 0x and 64 hex characters';
  if (t === 'U256') return 'a 256-bit number';
  if (t === 'bool') return 'true or false';
  if (t === 'Bytes' || t === 'Vec<u8>') return 'raw bytes, written as 0x and hex characters';
  if (/^AssetId/.test(tn)) return 'the id number of a token';
  if (tn === 'AssetKind') return "which token: the chain's own, or another one by its id number";
  if (tn === 'CollectionId') return 'the id number of an NFT collection';
  if (tn === 'ItemId') return 'the number of an NFT inside its collection';
  const whole = /^(Compact<)?u(8|16|32|64|128)>?$/.test(t);
  if (tn === 'PoolId' && whole) return 'the id number of a pool';
  if (/BlockNumber/.test(tn) && whole) return 'a block number, or a count of blocks';
  if (t === 'SpWeightsWeightV2Weight' || tn === 'Weight') return 'a limit on computing work, like a gas limit: { refTime, proofSize }';
  if (t === 'Call') return 'another call, wrapped inside this one';
  if (tn.startsWith('RuntimeCallNameOf')) return "two pieces of text, as bytes: the module's name and the call's name";
  if (tn === 'FixedU128') return 'a number with 18 decimal places: 1 is 1 followed by 18 zeros';
  if (whole) return 'a whole number';
  if (/^(Perbill|Permill|Percent|Perquintill)$/.test(t)) return 'a fraction';
  return '';
}

/** What a type means, in a few plain words. Empty when there is nothing safe to say. */
export function explainType(type: string, typeName: string, moduleName: string, token: string): string {
  const unwrap = (s: string, word: string): string => new RegExp(`^${word}<(.+)>$`).exec(s)?.[1] ?? '';
  const each = unwrap(type, 'Vec');
  if (each && each !== 'u8') {
    const e = explainOne(each, unwrap(typeName, 'Vec'), moduleName, token);
    return e ? `a list. Each entry: ${e}` : 'a list';
  }
  const maybe = unwrap(type, 'Option');
  if (maybe) {
    const e = explainOne(maybe, unwrap(typeName, 'Option'), moduleName, token);
    return e ? `optional. When given: ${e}` : 'optional';
  }
  return explainOne(type, typeName, moduleName, token);
}

/* ---------- reading the metadata ---------- */

// The decorated API is typed for known chains; here every module of this chain is read by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const text = (v: Loose): string => (v === undefined || v === null ? '' : v.toString());
const optionText = (o: Loose): string => (o && o.isSome ? o.unwrap().toString() : '');
const docsOf = (meta: Loose): string[] => tidyDocs(((meta?.docs ?? []) as Loose[]).map((d) => d.toString()));

function typeLabel(api: ApiPromise, typeId: Loose): string {
  try {
    const def = api.registry.lookup.getTypeDef(typeId) as Loose;
    return String(def.lookupName || def.type);
  } catch {
    return '';
  }
}

const MAX_SHAPE_LINES = 12;
const MAX_SHAPE_DEPTH = 3;

/**
 * The fields of a struct or the variants of an enum, as lines such as
 *   PalletNftsCollectionConfig: { settings: u64, maxSupply: Option<u32>, mintSettings: PalletNftsMintSettings }
 *   PalletStakingRewardDestination: one of Staked | Stash | Controller | Account(AccountId32) | None
 * Types named inside are expanded too, a few levels deep. Empty for plain types.
 */
function typeShape(api: ApiPromise, typeId: Loose): string[] {
  const lookup = api.registry.lookup as Loose;
  const out: string[] = [];
  const seen = new Set<string>();
  const nameOf = (d: Loose): string => String(d.lookupName || d.type);
  const resolve = (d: Loose): Loose => (/^Lookup\d+$/.test(String(d.type)) ? lookup.getTypeDef(String(d.type)) : d);

  const walk = (raw: Loose, depth: number): void => {
    if (out.length >= MAX_SHAPE_LINES || depth > MAX_SHAPE_DEPTH) return;
    const def = resolve(raw);
    const text = String(def.type);
    const label = String(def.lookupName || raw.lookupName || '');
    const subs: Loose[] = Array.isArray(def.sub) ? def.sub : def.sub ? [def.sub] : [];
    if (Array.isArray(def.sub) && text.startsWith('{') && label) {
      if (seen.has(label)) return;
      seen.add(label);
      const isEnum = text.startsWith('{"_enum"');
      const parts = def.sub.map((s: Loose) => (isEnum ? (String(s.type) === 'Null' ? String(s.name) : `${s.name}(${nameOf(s)})`) : `${s.name}: ${nameOf(s)}`));
      const line = isEnum ? `${label}: one of ${parts.join(' | ')}` : `${label}: { ${parts.join(', ')} }`;
      out.push(line.length > 420 ? `${line.slice(0, 417)}...` : line);
    }
    for (const s of subs) walk(s, depth + 1);
  };

  try {
    walk(lookup.getTypeDef(typeId), 0);
  } catch {
    /* a type the library cannot describe: show nothing rather than something wrong */
  }
  return out;
}

// A constant that is an amount of the chain's own token: its name says so and it is a u128.
const AMOUNT_NAME = /deposit|fee|bond|balance|amount|price|tip|reward|payout|minimum|cost|stake/i;

function readModule(api: ApiPromise, pallet: Loose, token: string): ModuleInfo {
  const name: string = pallet.name.toString();
  const section = stringCamelCase(name);
  const a = api as Loose;
  const base = { module: name, section };
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  const calls: ItemInfo[] = Object.keys(a.tx[section] ?? {}).map((method) =>
    safe<ItemInfo>(() => {
      const meta = a.tx[section][method].meta;
      const docs = docsOf(meta);
      const args: ArgInfo[] = meta.args.map((arg: Loose, i: number) => {
        const type = safe(() => text(arg.type), '');
        const typeName = safe(() => optionText(arg.typeName), '');
        const shape = safe(() => typeShape(api, meta.fields[i].type), [] as string[]);
        return { name: stringCamelCase(text(arg.name)), type, typeName, meaning: explainType(type, typeName, name, token), shape };
      });
      return { ...base, kind: 'call', name: method, index: meta.index.toNumber(), args, docs, summary: firstParagraph(docs) };
    }, { ...base, kind: 'call', name: method, index: null, args: [], docs: [], summary: '' }),
  );

  const events: ItemInfo[] = Object.keys(a.events[section] ?? {}).map((method) =>
    safe<ItemInfo>(() => {
      const meta = a.events[section][method].meta;
      const docs = docsOf(meta);
      const types: string[] = meta.args.map((t: Loose) => text(t));
      const args: ArgInfo[] = meta.fields.map((f: Loose, i: number) => {
        const typeName = safe(() => optionText(f.typeName), '').replace(/^T::/, '');
        const type = types[i] ?? '';
        const shape = safe(() => typeShape(api, f.type), [] as string[]);
        return { name: f.name.isSome ? stringCamelCase(f.name.unwrap().toString()) : `value${i + 1}`, type, typeName, meaning: explainType(type, typeName, name, token), shape };
      });
      return { ...base, kind: 'event', name: method, index: meta.index.toNumber(), args, docs, summary: firstParagraph(docs) };
    }, { ...base, kind: 'event', name: method, index: null, args: [], docs: [], summary: '' }),
  );

  const errors: ItemInfo[] = Object.keys(a.errors[section] ?? {}).map((method) =>
    safe<ItemInfo>(() => {
      const meta = a.errors[section][method].meta;
      const docs = docsOf(meta);
      return { ...base, kind: 'error', name: method, index: meta.index.toNumber(), args: [], docs, summary: firstParagraph(docs) };
    }, { ...base, kind: 'error', name: method, index: null, args: [], docs: [], summary: '' }),
  );

  const constants: ItemInfo[] = Object.keys(a.consts[section] ?? {}).map((key) =>
    safe<ItemInfo>(() => {
      const c = a.consts[section][key];
      const docs = docsOf(c.meta);
      const valueType = typeLabel(api, c.meta.type);
      const human = c.toHuman();
      let value = typeof human === 'object' && human !== null ? JSON.stringify(human) : text(c);
      try {
        if (valueType === 'u128' && AMOUNT_NAME.test(key)) value = `${text(c)} (${formatUnits(BigInt(text(c)), NATIVE_DECIMALS)} ${token})`;
        // fractions are stored as parts per billion, per million or per hundred
        else if (valueType === 'Perbill') value = `${text(c)} (${Number(text(c)) / 1e7}%)`;
        else if (valueType === 'Permill') value = `${text(c)} (${Number(text(c)) / 1e4}%)`;
        else if (valueType === 'Percent') value = `${text(c)}%`;
      } catch {
        /* keep the plain value */
      }
      return { ...base, kind: 'constant', name: key, index: null, args: [], docs, summary: firstParagraph(docs), value, valueType, valueShape: typeShape(api, c.meta.type) };
    }, { ...base, kind: 'constant', name: key, index: null, args: [], docs: [], summary: '' }),
  );

  const storage: ItemInfo[] = Object.keys(a.query[section] ?? {})
    .filter((key) => key !== 'palletVersion') // added by the library, not part of the chain's metadata
    .map((key) =>
      safe<ItemInfo>(() => {
        const meta = a.query[section][key].creator.meta;
        const docs = docsOf(meta);
        let keyTypes: string[] = [];
        let valueType = '';
        let valueShape: string[] = [];
        if (meta.type.isMap) {
          const map = meta.type.asMap;
          const def = api.registry.lookup.getTypeDef(map.key) as Loose;
          keyTypes = map.hashers.length > 1 && Array.isArray(def.sub) ? def.sub.map((s: Loose) => String(s.lookupName || s.type)) : [String(def.lookupName || def.type)];
          valueType = typeLabel(api, map.value);
          valueShape = typeShape(api, map.value);
        } else {
          valueType = typeLabel(api, meta.type.asPlain);
          valueShape = typeShape(api, meta.type.asPlain);
        }
        return { ...base, kind: 'storage', name: key, index: null, args: [], docs, summary: firstParagraph(docs), keyTypes, valueType, valueShape, optional: text(meta.modifier) === 'Optional' };
      }, { ...base, kind: 'storage', name: key, index: null, args: [], docs: [], summary: '', keyTypes: [] }),
    );

  return {
    name,
    section,
    index: pallet.index.toNumber(),
    note: withToken(MODULE_NOTES[name] ?? '', token),
    group: GROUP_OF.get(name) ?? null,
    calls,
    events,
    errors,
    constants,
    storage,
  };
}

export function buildIndex(api: ApiPromise, token: string): ChainIndex {
  const pallets = api.runtimeMetadata.asLatest.pallets as Loose[];
  const modules = pallets.map((p) => readModule(api, p, token)).sort((x, y) => x.index - y.index);
  const items = modules.flatMap((m) => [...m.calls, ...m.events, ...m.errors, ...m.constants, ...m.storage]);
  return { specVersion: api.runtimeVersion.specVersion.toNumber(), token, modules, items };
}

const cache = new Map<string, ChainIndex>();

/** The index of a network's current runtime. Rebuilt when the chain upgrades. */
export function getIndex(conn: Conn): ChainIndex {
  const spec = conn.api.runtimeVersion.specVersion.toNumber();
  const key = `${conn.network.key}:${spec}`;
  let index = cache.get(key);
  if (!index) {
    index = buildIndex(conn.api, conn.network.token);
    for (const k of cache.keys()) if (k.startsWith(`${conn.network.key}:`)) cache.delete(k);
    cache.set(key, index);
  }
  return index;
}

/* ---------- finding things by name ---------- */

/** Names compare without case and without underscores, so transfer_keep_alive finds transferKeepAlive. */
export const normName = (s: string): string => s.replace(/[_\s]/g, '').toLowerCase();

export function findModule(index: ChainIndex, name: string): ModuleInfo | undefined {
  const n = normName(name);
  return index.modules.find((m) => normName(m.name) === n);
}

export interface Resolved {
  module?: ModuleInfo;
  items: ItemInfo[];
}

/**
 * Finds what a reference names: "Balances" (a module), "Balances.transferKeepAlive",
 * "balances::transfer_keep_alive", or a bare item name such as "transferKeepAlive".
 */
export function resolveRef(index: ChainIndex, ref: string, wantedKind?: ItemKind): Resolved {
  // "api.errors.assets.Frozen" says which kind is meant, so the prefix is used, not just dropped.
  const prefix = /^api\.(tx|query|consts|events|errors)\./.exec(ref.trim());
  const fromPrefix = prefix ? ({ tx: 'call', query: 'storage', consts: 'constant', events: 'event', errors: 'error' } as const)[prefix[1] as 'tx' | 'query' | 'consts' | 'events' | 'errors'] : undefined;
  const cleaned = ref.trim().replace(/^api\.(tx|query|consts|events|errors)\./, '').replace(/\(.*$/, '');
  // A Rust path such as pallet_balances::Call::transfer_keep_alive names the same thing, and its
  // middle part says the kind too.
  const rawParts = cleaned.split(/::|[./\s]+/).filter(Boolean);
  const segment = rawParts.length > 2 ? rawParts.find((p) => /^(Call|Event|Error|Storage)$/.test(p)) : undefined;
  const fromPath = segment ? ({ Call: 'call', Event: 'event', Error: 'error', Storage: 'storage' } as const)[segment as 'Call' | 'Event' | 'Error' | 'Storage'] : undefined;
  const kind = wantedKind ?? fromPrefix ?? fromPath;
  const parts = rawParts.filter((p) => !(rawParts.length > 2 && /^(Call|Event|Error|Storage|Pallet|Config)$/.test(p))).map((p, i) => (i === 0 ? p.replace(/^pallet_/, '') : p));
  const byKind = (list: ItemInfo[]): ItemInfo[] => (kind ? list.filter((it) => it.kind === kind) : list);
  // Names compare without case, so "existentialDeposit" finds both the constant of that name and the
  // error ExistentialDeposit. When exactly one of them is written the way the caller wrote it, that
  // is the one they mean.
  const preferExact = (list: ItemInfo[], written: string): ItemInfo[] => {
    if (list.length < 2) return list;
    const exact = list.filter((it) => it.name === written);
    if (exact.length === 1) return exact;
    const camel = list.filter((it) => it.name === stringCamelCase(written)); // transfer_keep_alive
    return exact.length === 0 && camel.length === 1 ? camel : list;
  };
  if (parts.length >= 2) {
    const module = findModule(index, parts[0]);
    const written = parts.slice(1).join('');
    const n = normName(written);
    if (module) return { module, items: preferExact(byKind(index.items.filter((it) => it.module === module.name && normName(it.name) === n)), written) };
    return { items: [] };
  }
  if (parts.length === 1) {
    const module = findModule(index, parts[0]);
    if (module && !kind) return { module, items: [] };
    const n = normName(parts[0]);
    const items = preferExact(byKind(index.items.filter((it) => normName(it.name) === n)), parts[0]);
    return module ? { module, items } : { items };
  }
  return { items: [] };
}

/** "Balances.transferKeepAlive". */
export const fullName = (it: ItemInfo): string => `${it.module}.${it.name}`;

/** How an item is written: transferKeepAlive(dest, value), Transfer { from, to, amount }, account(key). */
export function signature(it: ItemInfo): string {
  if (it.kind === 'call') return `${it.name}(${it.args.map((a) => a.name).join(', ')})`;
  if (it.kind === 'event') return it.args.length ? `${it.name} { ${it.args.map((a) => a.name).join(', ')} }` : it.name;
  if (it.kind === 'storage') return it.keyTypes && it.keyTypes.length ? `${it.name}(${it.keyTypes.join(', ')})` : it.name;
  return it.name;
}

/** One line of JavaScript, for @polkadot/api, that uses the item. */
export function codeSample(it: ItemInfo): string {
  const names = it.args.map((a) => a.name).join(', ');
  switch (it.kind) {
    case 'call':
      return `await api.tx.${it.section}.${it.name}(${names}).signAndSend(account);`;
    case 'event':
      return names ? `if (api.events.${it.section}.${it.name}.is(event)) {\n  const [${names}] = event.data;\n}` : `if (api.events.${it.section}.${it.name}.is(event)) { /* it happened */ }`;
    case 'error':
      return `if (api.errors.${it.section}.${it.name}.is(dispatchError.asModule)) { /* the call failed for this reason */ }`;
    case 'constant':
      return `api.consts.${it.section}.${it.name}`;
    case 'storage': {
      const n = it.keyTypes?.length ?? 0;
      const keys = Array.from({ length: n }, (_, i) => (n === 1 ? 'key' : `key${i + 1}`)).join(', ');
      return `await api.query.${it.section}.${it.name}(${keys});`;
    }
  }
}
