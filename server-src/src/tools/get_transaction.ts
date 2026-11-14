import * as z from 'zod';
import { readReviveAccount } from '../lib/accounts.ts';
import { h160OfAccountId } from '../lib/address.ts';
import {
  argText,
  callName,
  cut,
  depositHeld,
  ethBlockHash,
  ethHashOf,
  ethSenderOf,
  eventName,
  eventsOf,
  explorerExtrinsicUrl,
  feeOf,
  finalityOf,
  findInBlock,
  isEthTransact,
  isHash32,
  isInherent,
  loadBlock,
  outcomeOf,
  refuseSecret,
  resolveBlock,
  scanForHash,
  shortEvent,
  type BlockRef,
  type LoadedBlock,
} from '../lib/blocks.ts';
import { ethRpc, getConn, hasEvmRpc, isEthHex, type Conn } from '../lib/chain.ts';
import { EthRpcError, ToolError } from '../lib/errors.ts';
import { formatUnits, lines, nativeAmount, utc, weiAmount } from '../lib/format.ts';
import { NATIVE_DECIMALS, NATIVE_TO_WEI, PALLETS_ADDRESS, pickNetwork, type Network } from '../lib/networks.ts';
import { messageText, redact, untrusted } from '../lib/text.ts';
import { defineTool, networkField } from '../lib/tool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** Events listed for one transaction. */
const MAX_EVENTS = 40;
const DEFAULT_SEARCH = 100;

interface EthTx {
  hash: string;
  blockNumber: string | null;
  blockHash: string | null;
  from: string;
  to: string | null;
  value: string;
  nonce: string;
  input: string;
  type?: string;
  gas: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

interface EthReceipt {
  status: string;
  blockNumber: string;
  blockHash: string;
  gasUsed: string;
  effectiveGasPrice: string;
  contractAddress: string | null;
  logs: unknown[];
}

interface EthSide {
  tx: EthTx | null;
  receipt: EthReceipt | null;
  /** Why the Ethereum side is missing or incomplete, when it is. */
  note: string | null;
}

// The Ethereum RPC is another server: its fields are printed only when they are 0x hex, as they
// should be. Anything else is shown as one quoted string, so it cannot pass for a line of this tool.

/** A quantity of the Ethereum RPC's answer, or null when it is not a 0x number. */
const qty = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null);
const big = (v: unknown): bigint => qty(v) ?? 0n;
const NOT_HEX = '(not 0x hex, as the Ethereum RPC should write it)';
/** A hex field as it is, or quoted with a note when it is not hex. */
const hexText = (v: unknown, none: string): string => (isEthHex(v) ? v : v === null || v === undefined ? none : `${untrusted(v, 80)} ${NOT_HEX}`);
/** A quantity written by fmt, or quoted with a note when it is not a 0x number. */
const qtyText = (v: unknown, fmt: (b: bigint) => string): string => {
  const q = qty(v);
  return q !== null ? fmt(q) : v === null || v === undefined ? 'none' : `${untrusted(v, 80)} ${NOT_HEX}`;
};
const asObject = <T>(v: unknown): T | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : null);

/** Both Ethereum lookups of one hash. A failing RPC is reported in the note, not thrown. */
async function askEth(network: Network, hash: string): Promise<EthSide> {
  if (!hasEvmRpc(network)) return { tx: null, receipt: null, note: `the ${network.label} has no public Ethereum RPC (checked Nov 13, 2026), so the transaction and its receipt cannot be read on that side.` };
  try {
    const [tx, receipt] = await Promise.all([ethRpc<unknown>(network, 'eth_getTransactionByHash', [hash]), ethRpc<unknown>(network, 'eth_getTransactionReceipt', [hash])]);
    return { tx: asObject<EthTx>(tx), receipt: asObject<EthReceipt>(receipt), note: null };
  } catch (err) {
    const why = err instanceof EthRpcError ? `it refused the request with code ${err.code}: ${untrusted(redact(err.message), 200)}` : messageText(err instanceof Error ? err.message.split('. ')[0] : String(err), 300);
    return { tx: null, receipt: null, note: `the Ethereum RPC did not answer (${why}).` };
  }
}

const TYPE_NAME: Record<string, string> = { '0x0': 'legacy', '0x1': 'EIP-2930', '0x2': 'EIP-1559' };

function ethTxLines(tx: EthTx, network: Network): string[] {
  const type = tx.type ?? '0x0';
  const wei = (b: bigint): string => `${b} wei`;
  const fees = type === '0x2' ? `max fee per gas ${qtyText(tx.maxFeePerGas, wei)}, max priority fee ${qtyText(tx.maxPriorityFeePerGas, wei)}` : `gas price ${qtyText(tx.gasPrice, wei)}`;
  return [
    `  from:                ${hexText(tx.from, 'unknown')}`,
    `  to:                  ${hexText(tx.to, 'none: a contract creation')}${isEthHex(tx.to) && tx.to.toLowerCase() === PALLETS_ADDRESS ? ' (the pallets address: the data is a native call, decoded below)' : ''}`,
    `  value:               ${qtyText(tx.value, (b) => weiAmount(b, network))}`,
    `  nonce:               ${qtyText(tx.nonce, String)}`,
    `  type:                ${qtyText(type, (b) => String(Number(b)))} (${typeof type === 'string' && Object.hasOwn(TYPE_NAME, type) ? TYPE_NAME[type] : 'unknown'}); gas limit ${qtyText(tx.gas, String)}; ${fees}`,
    `  data:                ${isEthHex(tx.input) ? (tx.input !== '0x' ? `${(tx.input.length - 2) / 2} bytes, ${cut(tx.input, 200)}` : 'none (0x)') : hexText(tx.input, 'none (0x)')}`,
  ];
}

/** One argument of a call as "name: value", with amounts of Balances and Revive calls also in tokens. */
function argLine(call: Loose, i: number, network: Network): string {
  const meta = call.meta.args[i];
  const name = meta?.name?.toString() ?? `arg${i + 1}`;
  const typeName = meta?.typeName?.isSome ? meta.typeName.unwrap().toString() : '';
  let text = argText(call.args[i]);
  if (/Balance/.test(typeName) && (call.section === 'balances' || call.section === 'revive') && /^\d+$/.test(text)) text = `${text} (${formatUnits(BigInt(text), NATIVE_DECIMALS)} ${network.token})`;
  return `${name}: ${text}`;
}

/** The native call a 0x account sent to the pallets address, decoded with the block's own runtime. */
function palletsCallLines(block: LoadedBlock, input: string, network: Network): string[] {
  try {
    const call = block.registry.createType('Call', input);
    return [
      '',
      `Native call in the data (the pallets address ${PALLETS_ADDRESS} runs the SCALE-encoded call it is sent):`,
      `  ${callName(block.registry, call)}`,
      ...call.args.map((_a: Loose, i: number) => `    ${argLine(call, i, network)}`),
      '  Such a receipt shows gasUsed 0 and no logs by design: the call is not EVM code, so its fee and its effects show only in the node\'s events below.',
      `  (Its fee is paid in ${network.token} on the node, not through gas.)`,
    ];
  } catch (err) {
    return ['', `The data sent to the pallets address could not be decoded as a native call of runtime ${block.specVersion} (${err instanceof Error ? err.message.split(':: ').pop() : String(err)}).`];
  }
}

function argLines(x: Loose, network: Network): string[] {
  if (!x.method.args.length) return ['arguments:      none'];
  return ['arguments:', ...x.method.args.map((_a: Loose, i: number) => `  ${argLine(x.method, i, network)}`)];
}

/** "In short" lines: what a reader looks for first among the events. */
function highlights(block: LoadedBlock, records: Loose[]): string[] {
  const named = records.map((r: Loose) => ({ r, n: eventName(block.registry, r) }));
  const emitted = named.filter((e) => e.n === 'Revive.ContractEmitted');
  const contracts = [...new Set(emitted.map((e) => e.r.event.data[0].toHex()))];
  const created = named.filter((e) => e.n === 'Revive.Instantiated').map((e) => e.r.event.data[1]?.toHex?.() ?? String(e.r.event.data[1]));
  const transfers = named.filter((e) => e.n === 'Balances.Transfer').length;
  return [
    emitted.length ? `  contract events: ${emitted.length} (Revive.ContractEmitted) from ${contracts.join(', ')}` : '',
    created.length ? `  contract created: ${created.join(', ')} (Revive.Instantiated)` : '',
    transfers ? `  transfers: ${transfers} (Balances.Transfer)` : '',
  ].filter(Boolean);
}

interface RenderOpts {
  eth: EthSide | null;
  /** How the transaction was found, when that is worth saying. */
  how: string | null;
}

async function render(conn: Conn, block: LoadedBlock, index: number, opts: RenderOpts): Promise<string> {
  const network = conn.network;
  const x = block.extrinsics[index];
  const records = eventsOf(block, index);
  const outcome = outcomeOf(block.registry, records);
  const fee = feeOf(records);
  const { held, code, released } = depositHeld(records);
  const ref: BlockRef = { number: block.number, hash: block.hash };
  const [finality, ethHash] = await Promise.all([finalityOf(conn, ref), isEthTransact(x) ? ethBlockHash(block) : Promise.resolve(null)]);
  const id = `${block.number}-${index}`;
  const link = explorerExtrinsicUrl(network, block.number, index);
  const emitted = records.find((r: Loose) => eventName(block.registry, r) === 'Revive.ContractEmitted');
  const next = emitted
    ? `Next: get_contract_events {"address": "${emitted.event.data[0].toHex()}", "from_block": ${block.number}${network.key === 'mainnet' ? ', "network": "mainnet"' : ''}} lists this contract's events from both sides.`
    : `Next: get_block {"block": ${block.number}${network.key === 'mainnet' ? ', "network": "mainnet"' : ''}} shows everything else in this block.`;
  const failNext = !outcome.ok || outcome.ethRevert || outcome.inner.length ? 'explain_error takes the error name above and gives the likely cause and fix.' : null;
  const finalNote = finality.finalized ? null : 'Treat this transaction as settled only once its block is finalized: ask again in a few seconds.';
  const eventList = [
    `Events, in order (${records.length}${records.length > MAX_EVENTS ? `, the first ${MAX_EVENTS} shown` : ''}):`,
    ...records.slice(0, MAX_EVENTS).map((r: Loose, k: number) => `  ${k + 1}. ${shortEvent(block.registry, r, network, 200)}`),
  ];
  const short = highlights(block, records);

  if (isEthTransact(x)) {
    const hash = ethHashOf(x) ?? '(could not be computed)';
    const eth = opts.eth ?? (await askEth(network, hash));
    const tx = eth.tx;
    const receipt = eth.receipt;
    const sender = ethSenderOf(fee);
    let status: string;
    if (receipt) status = receipt.status === '0x1' ? 'success' : 'REVERTED';
    else status = outcome.ethRevert ? 'REVERTED (read from the node; no receipt)' : outcome.ok ? 'success (read from the node; no receipt)' : outcome.text;

    const gasUsed = big(receipt?.gasUsed);
    const price = big(receipt?.effectiveGasPrice);
    const costWei = gasUsed * price;
    let check: string | null = null;
    if (receipt && fee && !fee.assetId && qty(receipt.gasUsed) !== null && qty(receipt.effectiveGasPrice) !== null) {
      if (gasUsed === 0n) check = `  check:               the receipt shows gas used 0, so its cost is 0; the fee above was paid on the node instead.`;
      else if (released === 0n) {
        const rest = costWei - (fee.fee + held + code) * NATIVE_TO_WEI;
        const parts = `fee${held > 0n ? ' + storage deposit' : ''}${code > 0n ? ' + code deposit' : ''}`;
        check =
          rest >= 0n && (rest < price || rest === 0n)
            ? `  check:               cost on the receipt = ${parts}${held + code === 0n ? ' (no deposit was held)' : ''}${rest ? ` + ${rest} wei, less than the price of one unit of gas` : ''}.`
            : `  check:               the cost on the receipt differs from ${parts} by ${rest} wei.`;
      }
    }
    let creation: string | null = null;
    if (receipt?.contractAddress) {
      creation = `  contract address:    ${hexText(receipt.contractAddress, 'none')} (on the receipt)`;
      if (receipt.status !== '0x1' && isEthHex(receipt.contractAddress) && receipt.contractAddress.length === 42) {
        const acct = await readReviveAccount(conn, receipt.contractAddress.toLowerCase()).catch(() => undefined);
        if (acct !== undefined) creation += acct?.contract ? '. A contract exists there now.' : '. The deploy reverted, and no contract exists at that address now (revive.accountInfoOf has no contract).';
      }
    }

    return lines(
      `Ethereum transaction ${hash} on the ${network.label}: ${status}.`,
      `Read just now from the node${tx || receipt ? ' and from the Ethereum RPC' : ''}.${opts.how ? ` ${opts.how}` : ''}`,
      '',
      `block:               ${block.number}, extrinsic index ${index} (Revive.ethTransact)`,
      `block hash:          ${block.hash} (Substrate side)`,
      ethHash && `Ethereum block hash: ${ethHash} (the same block on the Ethereum side)`,
      `time:                ${block.timeMs === null ? 'could not be read' : utc(block.timeMs)}`,
      `finalized:           ${finality.text}`,
      '',
      'Ethereum side (eth_getTransactionByHash, eth_getTransactionReceipt)',
      tx ? ethTxLines(tx, network) : sender ? `  from:                ${sender} (from the native account that paid the fee)` : null,
      !tx && `  transaction:         not returned${eth.note ? `: ${eth.note}` : ' by the Ethereum RPC.'}`,
      receipt
        ? [
            `  status:              ${receipt.status === '0x1' ? 'success' : 'reverted'} (receipt status ${hexText(receipt.status, 'none')})`,
            creation,
            `  gas used:            ${qtyText(receipt.gasUsed, String)}`,
            `  effective gas price: ${qtyText(receipt.effectiveGasPrice, (b) => `${b} wei per gas`)}`,
            qty(receipt.gasUsed) === null || qty(receipt.effectiveGasPrice) === null
              ? '  cost:                unknown: the receipt does not give gas used and price as 0x numbers'
              : gasUsed === 0n
                ? `  cost:                ${weiAmount(0n, network)} on the receipt, because gas used is 0`
                : `  cost:                gas used x price = ${weiAmount(costWei, network)}: the fee and any deposit (storage, and code for a deployment) together`,
            `  logs on the receipt: ${Array.isArray(receipt.logs) ? receipt.logs.length : 'unknown'}`,
          ]
        : tx
          ? '  receipt:             NOT returned, although the transaction is in a block. That has happened on this chain before (for some days in October 2026). The result below is read from the node instead.'
          : null,
      isEthHex(tx?.to) && tx.to.toLowerCase() === PALLETS_ADDRESS && isEthHex(tx.input) && tx.input.length > 2 ? palletsCallLines(block, tx.input, network) : null,
      '',
      `Node side (extrinsic ${id}, unsigned: the signed Ethereum transaction is its payload)`,
      `  result:              ${outcome.ethRevert ? `Revive.EthExtrinsicRevert: ${outcome.ethRevert}. The extrinsic itself still shows System.ExtrinsicSuccess and the fee was paid; on this chain that is how a reverted Ethereum transaction looks on the node` : outcome.ok ? 'success (System.ExtrinsicSuccess)' : outcome.text}`,
      outcome.inner.map((f) => `  inner call failed:   ${f} (the transaction succeeded, but this inner call did not)`),
      fee && `  fee paid:            ${nativeAmount(fee.fee, network)} (TransactionPayment.TransactionFeePaid), by ${fee.whoText}`,
      held > 0n && `  storage deposit held: ${nativeAmount(held, network)} (Balances.Held, reason StorageDepositReserve)`,
      code > 0n && `  code deposit held:   ${nativeAmount(code, network)} (Balances.Held, reason CodeUploadDepositReserve)`,
      released > 0n && `  deposit released:    ${nativeAmount(released, network)}`,
      check,
      short.length ? ['In short:', ...short] : null,
      '',
      eventList,
      '',
      finalNote,
      link && `Explorer (node side): ${link}. The explorer cannot look up the 0x hash itself.`,
      failNext,
      next,
    );
  }

  const name = callName(block.registry, x.method);
  const inherent = isInherent(x, records);
  const signer = x.isSigned ? x.signer.toString() : null;
  let signerHex: string | null = null;
  try {
    // The signer is a MultiAddress; its Id variant holds the 32-byte account id.
    signerHex = x.isSigned && x.signer.type === 'Id' ? h160OfAccountId(x.signer.value.toU8a()) : null;
  } catch {
    signerHex = null;
  }
  return lines(
    `Extrinsic ${id} on the ${network.label}: ${name}, ${outcome.ok ? 'success' : outcome.text}${inherent ? ' (an inherent, added by the block author)' : ''}.`,
    `Read just now from the node.${opts.how ? ` ${opts.how}` : ''}`,
    '',
    `block:          ${block.number}, extrinsic index ${index}`,
    `block hash:     ${block.hash}`,
    `time:           ${block.timeMs === null ? 'could not be read' : utc(block.timeMs)}`,
    `finalized:      ${finality.text}`,
    `extrinsic hash: ${x.hash.toHex()}`,
    `call:           ${name}`,
    signer ? `signer:         ${signer}${signerHex ? ` (its 0x form, which contracts see as msg.sender: ${signerHex})` : ''}` : `signer:         none (unsigned)`,
    x.isSigned && `nonce:          ${x.nonce.toNumber()}`,
    x.isSigned && `tip:            ${nativeAmount(BigInt(x.tip.toString()), network)}`,
    `result:         ${outcome.ok ? 'success (System.ExtrinsicSuccess)' : outcome.text}`,
    outcome.inner.map((f) => `inner call failed: ${f} (the extrinsic succeeded, but this inner call did not)`),
    fee && `fee paid:       ${fee.assetId ? `${fee.fee} units of asset ${fee.assetId}` : nativeAmount(fee.fee, network)} (${fee.assetId ? 'AssetTxFeePaid' : 'TransactionPayment.TransactionFeePaid'}, it includes the tip)${outcome.ok ? '' : '. The fee is charged even though the call failed.'}`,
    !fee && !inherent && 'fee paid:       no fee event (this call pays no fee)',
    held > 0n && `storage deposit held: ${nativeAmount(held, network)} (Balances.Held, reason StorageDepositReserve)`,
    code > 0n && `code deposit held: ${nativeAmount(code, network)} (Balances.Held, reason CodeUploadDepositReserve)`,
    argLines(x, network),
    short.length ? ['In short:', ...short] : null,
    '',
    eventList,
    '',
    finalNote,
    link && `Explorer: ${link}`,
    failNext,
    next,
  );
}

/** A hash that is not a transaction may be a block hash: say so instead of "not found". */
async function blockHint(conn: Conn, hash: string): Promise<string | null> {
  const header = (await conn.provider.send('chain_getHeader', [hash]).catch(() => null)) as { number: string } | null;
  if (header) return `That is the hash of block ${Number(BigInt(header.number))}, not of a transaction: get_block shows that block.`;
  if (hasEvmRpc(conn.network)) {
    const eth = await ethRpc<{ number?: unknown } | null>(conn.network, 'eth_getBlockByHash', [hash, false], { tries: 1 }).catch(() => null);
    const n = qty(eth?.number);
    if (n !== null) return `That is the Ethereum-side hash of block ${n}, not of a transaction: get_block shows that block.`;
  }
  return null;
}

export default defineTool({
  name: 'get_transaction',
  title: 'Portaldot V3: one transaction, seen from both sides',
  description:
    'Shows the full result of one Portaldot V3 transaction from both sides, read live: for an Ethereum 0x transaction hash (which the official explorer cannot look up) the receipt (status, from, to, value, nonce, gas used, price, cost) and the matching Revive.ethTransact extrinsic on the node with its fee, revert, contract events and transfers; ' +
    'for a native extrinsic its call, signer, nonce, arguments, success or named error, fee and every event. Data sent to the pallets address is decoded as the native call it carries. ' +
    'Also says whether the block is finalized. Give a hash, or a block with an index or hash. A native extrinsic hash cannot be looked up by any node, so the newest blocks are scanned for it. ' +
    'Example: {"hash": "0xd56478b42c6be657c123c44f2bebecf0eaae3c7e689c69b17deb2cfdee0cf1ac"}.',
  input: {
    hash: z.string().min(1).optional().describe('The transaction hash: 0x and 64 hex characters. Either an Ethereum transaction hash (what MetaMask, cast and receipts show) or the hash of a native extrinsic.'),
    block: z
      .union([z.number().int().min(0), z.string().min(1)])
      .optional()
      .describe('The block the transaction is in: a number (452626) or a 0x block hash from either side. With it, give "index" or "hash".'),
    index: z.number().int().min(0).optional().describe('The extrinsic\'s position in the block, from 0 (0 is usually timestamp.set). The explorer writes block 452626 index 1 as 452626-1.'),
    search_blocks: z.number().int().min(1).max(300).optional().describe(`For a hash without a block: how many of the newest blocks to scan when it is not an Ethereum transaction. Default ${DEFAULT_SEARCH}, at most 300.`),
    network: networkField,
  },
  readsChain: true,
  handler: async ({ hash: rawHash, block: blockRef, index, search_blocks, network: key }) => {
    const network = pickNetwork(key);
    if (rawHash === undefined && blockRef === undefined) throw new ToolError('Give "hash" (a 0x transaction hash), or "block" with "index" (its position in the block) or with "hash". get_block lists the extrinsics of a block with their indexes.');
    if (index !== undefined && blockRef === undefined) throw new ToolError('"index" is a position inside a block, so it needs "block" too, for example {"block": 452626, "index": 1}.');
    let hash: string | undefined;
    if (rawHash !== undefined) {
      refuseSecret(rawHash);
      if (!isHash32(rawHash)) throw new ToolError(`"${cut(rawHash.trim(), 80)}" is not a transaction hash: that is 0x and 64 hex characters (32 bytes). A 0x address (40 hex characters) is not a transaction; get_account reads an address.`);
      hash = rawHash.trim().toLowerCase();
    }
    const conn = await getConn(network.key);

    // A block given: go straight there.
    if (blockRef !== undefined) {
      const found = await resolveBlock(conn, blockRef);
      const block = await loadBlock(conn, found);
      const count = block.extrinsics.length;
      let i = index;
      if (i !== undefined && i >= count) throw new ToolError(`Block ${block.number} has ${count} extrinsic(s), at index 0 to ${count - 1}; there is no index ${i}. get_block {"block": ${block.number}} lists them.`);
      if (hash) {
        const match = findInBlock(block, hash);
        if (!match || (i !== undefined && match.index !== i)) {
          const have = block.extrinsics.map((x: Loose, k: number) => `${k}: ${callName(block.registry, x.method)} ${x.hash.toHex()}${ethHashOf(x) ? ` (Ethereum hash ${ethHashOf(x)})` : ''}`);
          throw new ToolError(
            lines(
              `No extrinsic${i !== undefined ? ` at index ${i}` : ''} of block ${block.number} on the ${network.label} has the hash ${hash}. Its extrinsics are:`,
              have.slice(0, 20).map((h: string) => `  ${h}`),
              have.length > 20 && `  ... and ${have.length - 20} more`,
              'Leave out "block" to look the hash up on its own.',
            ),
          );
        }
        i = match.index;
      }
      if (i === undefined) throw new ToolError(`Give "index" (0 to ${count - 1}) or "hash" with "block". get_block {"block": ${block.number}} lists the extrinsics of block ${block.number} with their indexes.`);
      const out = await render(conn, block, i, { eth: null, how: null });
      return found.note ? `Note: ${found.note}\n\n${out}` : out;
    }

    const h = hash as string;
    // A hash alone: first as an Ethereum transaction, where the network has an Ethereum RPC.
    let ethNote: string | null = null;
    if (hasEvmRpc(network)) {
      const eth = await askEth(network, h);
      ethNote = eth.note;
      const tx = eth.tx;
      if (tx && (tx.blockNumber === null || tx.blockNumber === undefined) && !eth.receipt) {
        return lines(
          `Ethereum transaction ${h} on the ${network.label} is PENDING: the Ethereum RPC knows it, but it is not in a block yet (read just now).`,
          '',
          ethTxLines(tx, network),
          '',
          'Ask again in a few seconds: a block comes every 6 s. It has happened only once it is in a block, and it is settled only once that block is finalized.',
        );
      }
      const numberHex = eth.receipt?.blockNumber ?? tx?.blockNumber ?? null;
      if (numberHex) {
        const q = qty(numberHex);
        if (q === null || q > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new ToolError(`The Ethereum RPC places transaction ${h} in a block whose number is not a 0x number (${untrusted(numberHex, 80)}), so its answer cannot be used. Give the block with "block" and "index" instead; get_block lists a block's extrinsics.`);
        }
        const n = Number(q);
        const block = await loadBlock(conn, await resolveBlock(conn, n));
        const match = findInBlock(block, h);
        if (match) return render(conn, block, match.index, { eth, how: null });
        return lines(
          `Ethereum transaction ${h} on the ${network.label}: the Ethereum RPC places it in block ${n}, but that block on the node holds no Revive.ethTransact whose payload hashes to it. This is unexpected; the node's view is the one that counts.`,
          '',
          tx ? ethTxLines(tx, network) : null,
          eth.receipt && `  receipt status ${hexText(eth.receipt.status, 'none')}, gas used ${qtyText(eth.receipt.gasUsed, String)}, block hash ${hexText(eth.receipt.blockHash, 'none')}`,
          '',
          `Next: get_block {"block": ${n}} shows what the node has in that block.`,
        );
      }
    }

    // Not an Ethereum transaction the RPC knows: it may be a native extrinsic, which only reading blocks can find.
    const count = search_blocks ?? DEFAULT_SEARCH;
    const scan = await scanForHash(conn, h, count);
    if (scan.found) {
      const block = await loadBlock(conn, { number: scan.found.number, hash: scan.found.hash });
      const how =
        scan.found.kind === 'ethereum'
          ? `Found by reading the newest ${count} blocks: it is the Ethereum transaction of a Revive.ethTransact extrinsic${hasEvmRpc(network) ? `, although the Ethereum RPC did not return it${ethNote ? ` (${ethNote})` : ''}` : ''}.`
          : `Found by reading the newest ${count} blocks (no node can look up an extrinsic by its hash).`;
      return render(conn, block, scan.found.index, { eth: hasEvmRpc(network) ? null : { tx: null, receipt: null, note: `the ${network.label} has no public Ethereum RPC (checked Nov 13, 2026).` }, how });
    }

    const hint = await blockHint(conn, h);
    if (hint) throw new ToolError(hint);
    throw new ToolError(
      lines(
        hasEvmRpc(network)
          ? `No transaction with the hash ${h} was found on the ${network.label}. The Ethereum RPC does not know it${ethNote ? ` (${ethNote})` : ' (eth_getTransactionByHash returned nothing)'}, so it is not an Ethereum transaction there, and it is not the hash of an extrinsic in the newest ${count} blocks (${scan.from} to ${scan.to}).`
          : `No extrinsic with the hash ${h} is in the newest ${count} blocks of the ${network.label} (${scan.from} to ${scan.to}). The ${network.label} has no public Ethereum RPC (checked Nov 13, 2026), so an Ethereum 0x transaction hash cannot be looked up there.`,
        'No node can look up a native extrinsic by its hash: it can only be found by reading blocks. Pass the block it is in ("block" with "hash" or "index"; block and index work on both networks), or raise search_blocks (at most 300).',
        network.key === 'testnet' ? 'If it was sent to the mainnet, add "network": "mainnet".' : 'If it was sent to the testnet, leave out "network".',
      ),
    );
  },
});
