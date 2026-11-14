import * as z from 'zod';
import { getConn } from '../lib/chain.ts';
import { ToolError } from '../lib/errors.ts';
import { clip, lines } from '../lib/format.ts';
import { GLOSSARY, PLAIN_NOTES, withToken } from '../lib/knowledge.ts';
import { codeSample, fullName, getIndex, normName, resolveRef, signature, type ChainIndex, type ItemInfo, type ModuleInfo } from '../lib/meta.ts';
import { pickNetwork, type Network } from '../lib/networks.ts';
import { searchChain } from '../lib/search.ts';
import { defineTool, networkField } from '../lib/tool.ts';

const KINDS = ['call', 'event', 'error', 'constant', 'storage'] as const;

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

const KIND_WORD: Record<ItemInfo['kind'], string> = { call: 'call', event: 'event', error: 'error', constant: 'constant', storage: 'stored value' };

const USE_LABEL: Record<ItemInfo['kind'], string> = {
  call: 'Send it, with @polkadot/api',
  event: "Recognise it among a block's events",
  error: 'Recognise it when a call fails',
  constant: 'Read it, with @polkadot/api',
  storage: 'Read it, with @polkadot/api',
};

/**
 * What the chain's own text says beyond its first paragraph (which is already shown as the summary),
 * kept to a readable size. Words from the glossary are explained once below it.
 */
function chainNotes(it: ItemInfo): string[] {
  if (!it.docs.length) return ['', "The chain's metadata has no text for it."];
  let i = 0;
  while (i < it.docs.length && !it.docs[i].trim()) i++;
  while (i < it.docs.length && it.docs[i].trim() && !/^#+\s/.test(it.docs[i].trim())) i++;
  const rest = it.docs.slice(i);
  while (rest.length && !rest[0].trim()) rest.shift();
  const all = it.docs.join('\n');
  const used = GLOSSARY.filter((g) => g.term.split(', ').some((t) => new RegExp(`\\b${t}s?\\b`, 'i').test(all)));
  const words = used.length ? ['', "Words the chain's text uses:", ...used.map((g) => `  ${g.term}: ${g.meaning}`)] : [];
  if (!rest.length) return words;
  const body = rest.join('\n');
  const cut = body.length > 2200 ? `${body.slice(0, 2200)}\n... (cut)` : body;
  return ['', "More from the chain's own notes (names written the JavaScript way; Rust and raw metadata use snake_case):", ...cut.split('\n').map((l) => `  ${l}`), ...words];
}

const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a');

/** How many single-character edits turn one short name into another (stops counting above 3). */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 4;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

function describeItem(it: ItemInfo, module: ModuleInfo, network: Network, index: ChainIndex): string {
  const key = fullName(it);
  const where = it.index === null ? '' : it.kind === 'call' ? `: module ${module.index}, call ${it.index}, so its encoded bytes start 0x${hex2(module.index)}${hex2(it.index)}` : `: module ${module.index}, ${it.kind} ${it.index}`;
  const plainNote = PLAIN_NOTES[key];
  const argLines = it.args.flatMap((a) => [
    `  ${a.name}: ${a.type}${a.typeName && a.typeName !== a.type ? ` (${a.typeName})` : ''}${a.meaning ? ` - ${a.meaning}` : ''}`,
    ...(a.shape ?? []).map((s) => `      ${s}`),
  ]);
  const hasShapes = it.args.some((a) => a.shape?.length);
  const extra: string[] = [];
  if (hasShapes && it.kind === 'call') {
    extra.push('In @polkadot/api, pass a struct as an object with those keys, an enum as the name of a variant ("Staked") or as { Variant: value } when it carries a value, and an Option as the value or null.');
  }
  if (it.kind === 'call') {
    extra.push(
      'Next: encode_call builds the exact bytes for given arguments and estimates the fee. Whoever signs must be a test account in code or a wallet in a browser; these tools never sign.',
      module.errors.length ? `Errors this module can return: ${module.errors.map((e) => e.name).join(', ')}.` : '',
    );
    if (it.args.some((a) => /Balance/.test(a.typeName))) extra.push('Amounts are whole numbers of the smallest unit. Pass them as BigInt or strings, never as floating point; convert_amount does the conversion.');
  }
  if (it.kind === 'storage') {
    extra.push(`Next: read_storage reads it from the chain now, for example {"item": "${key}"${it.keyTypes?.length ? ', "keys": [...]' : ''}}.`);
  }
  if (it.kind === 'error') {
    extra.push(
      `A failed call reports it as a module error with index ${module.index} (the module) and error ${it.index}. @polkadot/api prints that as {"module":{"index":${module.index},"error":"0x${hex2(it.index ?? 0)}000000"}}: the error index is the first of the four bytes. explain_error turns such a pair, or an error text, into its meaning.`,
    );
  }
  return lines(
    `${module.name}.${signature(it)} - ${article(KIND_WORD[it.kind])} ${KIND_WORD[it.kind]} of the ${module.name} module on the ${network.label} (runtime ${index.specVersion})${where}.`,
    it.summary && `\n${it.summary}`,
    plainNote && `\nIn plain words: ${withToken(plainNote, network.token)}`,
    it.kind === 'constant' && `\nValue: ${it.value === undefined ? '(could not be read)' : it.value.length > 1500 ? `${it.value.slice(0, 1500)}... (cut: ${it.value.length} characters in all; read_storage shows more of it)` : it.value}${it.valueType ? `   type ${clip(it.valueType, 80)}` : ''}`,
    it.kind === 'storage' && `\nKeys: ${it.keyTypes?.length ? it.keyTypes.join(', ') : 'none (a single value)'}\nValue type: ${clip(it.valueType ?? '', 300)}${it.optional ? '   (reads as none when there is no entry)' : ''}`,
    (it.kind === 'storage' || it.kind === 'constant') && it.valueShape?.length ? it.valueShape.map((s) => `    ${s}`) : null,
    argLines.length ? ['', it.kind === 'call' ? 'Arguments, in order:' : 'Fields, in order:', ...argLines] : it.kind === 'call' ? '\nIt takes no arguments.' : null,
    '',
    `${USE_LABEL[it.kind]}:`,
    ...codeSample(it).split('\n').map((l) => `  ${l}`),
    ...chainNotes(it),
    extra.filter(Boolean).length ? ['', ...extra.filter(Boolean)] : null,
  );
}

/**
 * "Balances.transfer" finds the event Balances.Transfer, because names compare without case. Someone
 * who writes a lower-case name usually wants a call, so the calls with a similar name are offered too.
 */
function callHint(ref: string, it: ItemInfo, module: ModuleInfo): string | null {
  const last = ref.trim().split(/::|[./\s]+/).filter(Boolean).pop() ?? '';
  if (!/^[a-z]/.test(last) || (it.kind !== 'event' && it.kind !== 'error')) return null;
  const n = normName(last);
  const calls = module.calls.filter((c) => normName(c.name).includes(n));
  return calls.length
    ? `Note: ${module.name} has no call named "${last}". If you want a call, the ones with a similar name are: ${calls.map((c) => c.name).join(', ')}. What follows is the ${it.kind} ${module.name}.${it.name}.\n`
    : `Note: ${module.name} has no call named "${last}". What follows is the ${it.kind} ${module.name}.${it.name}.\n`;
}

function listOf(title: string, items: ItemInfo[], render: (it: ItemInfo) => string): string[] {
  if (!items.length) return [];
  return ['', `${title} (${items.length})`, ...items.map((it) => `  ${render(it)}`)];
}

function describeModule(m: ModuleInfo, network: Network, index: ChainIndex): string {
  const withDoc = (it: ItemInfo): string => `${signature(it)}${it.summary ? ` - ${clip(it.summary, 110)}` : ''}`;
  const empty = !m.calls.length && !m.events.length && !m.errors.length && !m.constants.length && !m.storage.length;
  return lines(
    `${m.name} - module ${m.index} of the ${network.label} (runtime ${index.specVersion})${m.group ? `. Group: ${m.group.name}.` : '.'}`,
    m.note || 'We have not written a description for this module yet; the lists below come straight from the chain.',
    !empty &&
      `In @polkadot/api it is "${m.section}": ${[m.calls.length && `api.tx.${m.section}`, m.storage.length && `api.query.${m.section}`, m.constants.length && `api.consts.${m.section}`, m.events.length && `api.events.${m.section}`, m.errors.length && `api.errors.${m.section}`].filter(Boolean).join(', ')}.`,
    empty && '\nThis module has no calls, events, errors, constants or storage of its own. It works behind the scenes.',
    ...listOf('Calls', m.calls, withDoc),
    ...listOf('Events', m.events, withDoc),
    m.errors.length ? ['', `Errors (${m.errors.length})`, `  ${m.errors.map((e) => e.name).join(', ')}`] : null,
    ...listOf('Constants', m.constants, (it) => `${it.name} = ${clip(it.value ?? '', 90)}`),
    ...listOf('Storage', m.storage, withDoc),
    '',
    `Next: describe_item "${m.name}.<name>" for one item's exact arguments, meaning and sample code.`,
  );
}

export default defineTool({
  name: 'describe_item',
  title: 'Portaldot V3: one module or one of its items, in full',
  description:
    'Describes one module (pallet) of Portaldot V3, or one call (extrinsic), event, error, constant or stored value in it, straight from the live chain\'s metadata. ' +
    'For a call: the exact argument names, order and types, what each argument means in plain words (which arguments are amounts in the smallest unit, which want a 5... address and which a 0x one), ' +
    'its module and call index, a line of @polkadot/api code, the chain\'s own notes, and a plain-words note for common calls. For a module: every call, event, error, constant and stored value it has. ' +
    'Use it before writing or reviewing any code that makes a call, reads storage or matches an event or error, so nothing is guessed. ' +
    'Names may be written any way: "Balances.transferKeepAlive", "balances::transfer_keep_alive", "Nfts", "Assets.Created". Example: {"name": "Balances.transferKeepAlive"}.',
  input: {
    name: z.string().trim().min(2).max(300).describe('A module name ("Balances"), or Module.item ("Balances.transferKeepAlive", "System.account", "Revive.ContractEmitted"). Case and snake_case do not matter.'),
    kind: z.enum(KINDS).optional().describe('Only needed when a module has two items with the same name, for example a call and a stored value.'),
    network: networkField,
  },
  readsChain: true,
  handler: async ({ name, kind, network: key }) => {
    const network = pickNetwork(key);
    const conn = await getConn(network.key);
    const index = getIndex(conn);
    const { module, items } = resolveRef(index, name, kind);

    if (items.length === 1) {
      const owner = index.modules.find((m) => m.name === items[0].module)!;
      return lines(callHint(name, items[0], owner), describeItem(items[0], owner, network, index));
    }
    if (items.length > 1) {
      const sameModule = items.every((it) => it.module === items[0].module);
      return lines(
        `"${name}" names ${items.length} things on the ${network.label}:`,
        ...items.map((it) => `  ${it.kind.padEnd(9)} ${it.module}.${signature(it)}${it.summary ? ` - ${clip(it.summary, 100)}` : ''}`),
        '',
        sameModule ? 'Call describe_item again with "kind" set to the one you mean.' : 'Call describe_item again with the module in front, for example "' + fullName(items[0]) + '".',
      );
    }
    if (module && !name.replace(/::/g, '.').includes('.')) return describeModule(module, network, index);

    // The name exists, but not as the kind that was asked for: say which kinds it does exist as.
    if (kind) {
      const other = resolveRef(index, name).items;
      if (other.length) {
        throw new ToolError(
          `${other[0].module} has no ${KIND_WORD[kind]} named "${other[0].name}". It has ${other.map((it) => `${article(KIND_WORD[it.kind])} ${KIND_WORD[it.kind]} ${fullName(it)}`).join(' and ')}: call describe_item again without "kind", or with "kind" set to "${other[0].kind}".`,
        );
      }
    }

    // Nothing by that exact name: offer the nearest names instead of leaving the model to guess.
    const shown = clip(name, 80);
    const wanted = normName(name.split(/::|[./\s]+/).filter(Boolean).pop() ?? '');
    const pool = module ? [...module.calls, ...module.events, ...module.errors, ...module.constants, ...module.storage] : [];
    const nearInModule = wanted.length >= 3 ? pool.filter((it) => editDistance(normName(it.name), wanted) <= 2 || normName(it.name).startsWith(wanted) || wanted.startsWith(normName(it.name))).map(fullName) : [];
    const near = searchChain(index, name.replace(/::|[./]/g, ' '), undefined, 6);
    const suggestions = [...new Set([...nearInModule, ...near.jobs.map((j) => fullName(j.item)), ...near.hits.map((h) => (h.item ? fullName(h.item) : h.module.name))])].slice(0, 6);
    throw new ToolError(
      lines(
        module
          ? `The ${module.name} module on the ${network.label} (runtime ${index.specVersion}) has nothing named "${clip(name.split(/::|[./]/).slice(1).join('.'), 80)}".`
          : `Nothing on the ${network.label} (runtime ${index.specVersion}) is named "${shown}".`,
        suggestions.length ? `Closest names: ${suggestions.join(', ')}.` : null,
        module ? `Call describe_item with "${module.name}" alone to list everything that module has.` : 'Use search_chain to look for it by what it does.',
        'Do not fall back on a name from Polkadot or Ethereum habits: if it is not in this list, this chain does not have it.',
      ),
    );
  },
});
