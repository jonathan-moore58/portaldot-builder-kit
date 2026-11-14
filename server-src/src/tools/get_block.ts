import * as z from 'zod';
import {
  callName,
  depositHeld,
  ethBlockHash,
  ethHashOf,
  ethSenderOf,
  eventName,
  eventsOf,
  explorerExtrinsicUrl,
  feeOf,
  finalityOf,
  isEthTransact,
  isInherent,
  loadBlock,
  nodeConsoleBlockUrl,
  outcomeOf,
  resolveBlock,
  shortEvent,
  type LoadedBlock,
} from '../lib/blocks.ts';
import { getConn } from '../lib/chain.ts';
import { lines, nativeAmount, utc } from '../lib/format.ts';
import { pickNetwork, type Network } from '../lib/networks.ts';
import { defineTool, networkField } from '../lib/tool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** Extrinsics shown in full; the rest are counted. */
const MAX_LISTED = 30;
/** Events shown per extrinsic. */
const MAX_EVENTS_EACH = 6;
/** Rough size at which the list of extrinsics stops, so a large block stays readable. */
const TEXT_BUDGET = 9_000;

// Shown in each extrinsic's own lines (result, fee), so they are left out of its event list.
const SUMMED_UP = new Set(['System.ExtrinsicSuccess', 'System.ExtrinsicFailed', 'TransactionPayment.TransactionFeePaid']);

function extrinsicLines(block: LoadedBlock, i: number, network: Network): string[] {
  const x = block.extrinsics[i];
  const records = eventsOf(block, i);
  const name = callName(block.registry, x.method);
  if (isInherent(x, records)) return [`  #${i} ${name} (inherent: added by the block author)`];

  const outcome = outcomeOf(block.registry, records);
  const fee = feeOf(records);
  const out: string[] = [];
  if (isEthTransact(x)) {
    const sender = ethSenderOf(fee);
    out.push(`  #${i} ${name}: an Ethereum transaction, hash ${ethHashOf(x) ?? '(could not be computed)'}`);
    if (sender && fee) out.push(`      from ${sender} (its native account ${fee.whoText} paid the fee)`);
  } else {
    out.push(`  #${i} ${name}${x.isSigned ? `, signed by ${x.signer.toString()}` : ' (unsigned)'}`);
  }
  let result = outcome.text;
  if (outcome.ethRevert) result = `the Ethereum transaction REVERTED (Revive.EthExtrinsicRevert: ${outcome.ethRevert}). The extrinsic itself shows System.ExtrinsicSuccess and the fee was paid; that is how this chain records a revert`;
  out.push(`      result: ${result}`);
  for (const f of outcome.inner) out.push(`      inner call failed: ${f}`);
  if (fee) out.push(`      fee paid: ${fee.assetId ? `${fee.fee} units of asset ${fee.assetId}` : nativeAmount(fee.fee, network)}${fee.tip > 0n ? `, tip included ${fee.tip}` : ''}`);
  const { held, code } = depositHeld(records);
  if (held > 0n) out.push(`      storage deposit held: ${nativeAmount(held, network)}`);
  if (code > 0n) out.push(`      code deposit held: ${nativeAmount(code, network)}`);
  const shown = records.filter((r: Loose) => !SUMMED_UP.has(eventName(block.registry, r)));
  if (shown.length) {
    out.push(`      events (${shown.length}${shown.length > MAX_EVENTS_EACH ? `, the first ${MAX_EVENTS_EACH} shown` : ''}):`);
    for (const r of shown.slice(0, MAX_EVENTS_EACH)) out.push(`        ${shortEvent(block.registry, r, network, 200)}`);
  }
  return out;
}

export default defineTool({
  name: 'get_block',
  title: 'Portaldot V3: one block, its extrinsics and events',
  description:
    'Reads one Portaldot V3 block from the live node: number, Substrate hash, parent hash, time (UTC), whether it is finalized, and its Ethereum-side block hash (both sides share block numbers, not hashes). ' +
    'Then every extrinsic: index, Module.call, signer, result (a failure with its named error), fee paid and its events; an Ethereum transaction shows as Revive.ethTransact with its 0x transaction hash, and a reverted one is flagged even though the node marks it successful. ' +
    'Ends with event counts per Module.Event and explorer links. Use it to see what happened in a block, to find an extrinsic\'s index for get_transaction, or to turn an Ethereum-side block hash into the block. ' +
    'Takes a number, a 0x hash from either side, "latest" or "finalized". Example: {"block": 452626}.',
  input: {
    block: z
      .union([z.number().int().min(0), z.string().min(1)])
      .optional()
      .describe('Which block: a number (452626), a 0x block hash (0x and 64 hex characters; the Substrate hash or the Ethereum-side one), "latest" or "finalized". Default "latest".'),
    network: networkField,
  },
  readsChain: true,
  handler: async ({ block: ref, network: key }) => {
    const network = pickNetwork(key);
    const conn = await getConn(network.key);
    const found = await resolveBlock(conn, ref);
    const block = await loadBlock(conn, found);
    const [finality, ethHash] = await Promise.all([finalityOf(conn, found), ethBlockHash(block)]);

    const xs = block.extrinsics;
    const kinds = xs.map((x: Loose, i: number) => (isEthTransact(x) ? 'eth' : x.isSigned ? 'signed' : isInherent(x, eventsOf(block, i)) ? 'inherent' : 'unsigned'));
    const count = (k: string): number => kinds.filter((v: string) => v === k).length;

    // Inherents are one short line each; the others are listed in full until the size budget is used.
    const listed: string[] = [];
    const left: number[] = [];
    let used = 0;
    let full = 0;
    for (let i = 0; i < xs.length; i++) {
      if (kinds[i] !== 'inherent' && (full >= MAX_LISTED || used > TEXT_BUDGET)) {
        left.push(i);
        continue;
      }
      const part = extrinsicLines(block, i, network);
      if (kinds[i] !== 'inherent') full++;
      used += part.join('\n').length;
      listed.push(...part);
    }

    const counts = new Map<string, number>();
    for (const r of block.events) {
      const n = eventName(block.registry, r);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    const countText = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([n, c]) => `${n} ${c}`);
    const outside = block.events.filter((r: Loose) => !r.phase.isApplyExtrinsic).length;
    const firstReal = kinds.findIndex((k: string) => k !== 'inherent');
    const link = firstReal >= 0 ? explorerExtrinsicUrl(network, block.number, firstReal) : null;

    return lines(
      found.note && `Note: ${found.note}\n`,
      `Block ${block.number} on the ${network.label} (runtime ${block.specVersion}), read from the node just now.`,
      `hash:                ${block.hash}`,
      `parent hash:         ${block.parentHash}`,
      `time:                ${block.timeMs === null ? 'could not be read' : block.timeMs === 0 ? 'none: timestamp.now reads 0 at this block (the genesis block has no time)' : `${utc(block.timeMs)} (timestamp.now at this block)`}`,
      `finalized:           ${finality.text}`,
      ethHash
        ? `Ethereum block hash: ${ethHash} (revive.blockHash read at this block). ${network.evm ? 'The Ethereum RPC and receipts name the block by this hash' : 'Ethereum tools would name the block by this hash (this network has no public Ethereum RPC)'}, the node and the explorer by the one above; both use the same number.`
        : 'Ethereum block hash: not found (revive.blockHash is empty at this block).',
      `extrinsics:          ${xs.length}: ${count('inherent')} inherent, ${count('signed')} signed, ${count('eth')} Ethereum transaction(s)${count('unsigned') ? `, ${count('unsigned')} other unsigned` : ''}`,
      '',
      'Extrinsics',
      xs.length ? listed : '  none',
      left.length > 0 && `  ... ${left.length} more extrinsic(s) not shown, to keep this readable: index ${left[0]} to ${left[left.length - 1]}. get_transaction with "block" and "index" shows any one of them.`,
      '',
      `Events: ${block.events.length} in all${outside ? `, ${outside} of them outside any extrinsic (block initialization or finalization)` : ''}. By Module.Event:`,
      `  ${countText.join(', ') || 'none'}`,
      '  (System.ExtrinsicSuccess, System.ExtrinsicFailed and TransactionPayment.TransactionFeePaid appear above as each extrinsic\'s result and fee.)',
      '',
      'Links (Substrate side only; neither looks up a 0x transaction hash)',
      `  Node Console, this block: ${nodeConsoleBlockUrl(network, block.number)}`,
      link && `  explorer, one extrinsic: ${link} (the number after the dash is the extrinsic index)`,
      '',
      firstReal >= 0
        ? `Next: get_transaction {"block": ${block.number}, "index": ${firstReal}${network.key === 'mainnet' ? ', "network": "mainnet"' : ''}} shows one extrinsic in full: its arguments, every event, and for an Ethereum transaction the receipt.`
        : xs.length
          ? 'This block holds only inherents: no transaction was included.'
          : 'This block holds no extrinsics at all.',
    );
  },
});
