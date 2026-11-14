import * as z from 'zod';
import { readReviveAccount } from '../lib/accounts.ts';
import { checksummed, parseAddress } from '../lib/address.ts';
import {
  blockHashes,
  callName,
  CHUNK,
  cut,
  ethHashOf,
  isEthTransact,
  isHash32,
  matchEvents,
  type EthLog,
  type NodeEvent,
} from '../lib/blocks.ts';
import { ethRpc, getConn, hasEvmRpc, isEthHex } from '../lib/chain.ts';
import { EthRpcError, ToolError } from '../lib/errors.ts';
import { lines } from '../lib/format.ts';
import { pickNetwork } from '../lib/networks.ts';
import { messageText, redact, untrusted } from '../lib/text.ts';
import { defineTool, networkField } from '../lib/tool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** Most blocks read in one call: each block is read on its own, so this keeps a call quick and polite. */
const MAX_BLOCKS = 50;
/** Events shown in full; the counts cover all of them. */
const MAX_SHOWN = 30;
/** Data longer than this many hex characters is cut. */
const MAX_DATA_HEX = 512;

interface Found extends NodeEvent {
  /** "Revive.call, signed by 5..." or "Revive.ethTransact, Ethereum transaction 0x...". */
  source: string;
}

const hex = (n: number): string => `0x${n.toString(16)}`;

/** A log as an Ethereum RPC should write it: block number, topics and data as 0x hex, and the optional fields too. */
export function isWellFormedLog(l: unknown): l is EthLog {
  if (!l || typeof l !== 'object') return false;
  const x = l as Record<string, unknown>;
  const optional = (v: unknown, re: RegExp): boolean => v === undefined || v === null || (typeof v === 'string' && re.test(v));
  return (
    typeof x.blockNumber === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(x.blockNumber) &&
    isEthHex(x.data) &&
    Array.isArray(x.topics) && x.topics.length <= 4 && x.topics.every((t) => typeof t === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t)) &&
    optional(x.transactionHash, /^0x[0-9a-fA-F]{64}$/) && optional(x.logIndex, /^0x[0-9a-fA-F]{1,16}$/) && optional(x.address, /^0x[0-9a-fA-F]{40}$/)
  );
}

function dataText(data: string): string {
  const body = data.slice(2);
  if (body.length <= MAX_DATA_HEX) return `${data} (${body.length / 2} bytes)`;
  return `0x${body.slice(0, MAX_DATA_HEX)}... (cut: ${body.length / 2} bytes in all)`;
}

export default defineTool({
  name: 'get_contract_events',
  title: 'Portaldot V3: a contract\'s events from both sides',
  description:
    'Lists the events (logs) a Solidity contract emitted on Portaldot V3 in a range of at most 50 blocks, from both sides, read live: the node\'s Revive.ContractEmitted events in System.Events, and eth_getLogs. ' +
    'eth_getLogs serves only events of Ethereum transactions; events from a contract called by a native extrinsic (Revive.call, or a call inside a multisig) are missing there, and this tool finds them. ' +
    'For each event: block, extrinsic index and its Module.call, topics, data, and whether eth_getLogs serves it. Use it when logs seem missing, or to read events of native-path calls. ' +
    'The node keeps no index by contract, so give the block range to read (get_transaction gives the block of a transaction). ' +
    'Example: {"address": "<0x contract address>", "from_block": 452600, "to_block": 452649, "topic0": "<optional 0x event signature hash>"}.',
  input: {
    address: z.string().min(1).describe('The contract\'s 0x address: 0x and 40 hex characters, as a deploy receipt (contractAddress) or the Revive.Instantiated event gives it, for example "0x" followed by 40 hex digits. Not a 5... address.'),
    from_block: z.number().int().min(0).describe('First block to read, a block number such as 452600.'),
    to_block: z.number().int().min(0).optional().describe(`Last block to read (included). Default: from_block. At most ${MAX_BLOCKS} blocks per call.`),
    topic0: z.string().optional().describe('Only events whose first topic is this: 0x and 64 hex characters, the keccak-256 of the event signature, for example the hash of "Transfer(address,address,uint256)".'),
    network: networkField,
  },
  readsChain: true,
  handler: async ({ address, from_block, to_block, topic0, network: key }) => {
    const network = pickNetwork(key);
    const parsed = parseAddress(address);
    if (parsed.kind !== 'h160' && !parsed.isFallbackForm) {
      throw new ToolError(`"${address.trim()}" is a native account, not a contract. A contract is named by its 0x address (0x and 40 hex characters); convert_address shows both forms of an address.`);
    }
    const contract = parsed.h160;
    let topic: string | null = null;
    if (topic0 !== undefined && topic0.trim() !== '') {
      if (!isHash32(topic0)) throw new ToolError(`topic0 must be 0x and 64 hex characters (a 32-byte topic, such as the keccak-256 of an event signature); got "${cut(topic0.trim(), 80)}".`);
      topic = topic0.trim().toLowerCase();
    }
    const to = to_block ?? from_block;
    if (to < from_block) throw new ToolError(`to_block (${to}) is before from_block (${from_block}). Give from_block as the lower number.`);
    const span = to - from_block + 1;
    if (span > MAX_BLOCKS) {
      throw new ToolError(`At most ${MAX_BLOCKS} blocks per call: blocks ${from_block} to ${to} are ${span} blocks. Split the range, for example ${from_block} to ${from_block + MAX_BLOCKS - 1} first. The node keeps no index of events by contract, so each block is read on its own.`);
    }

    const conn = await getConn(network.key);
    const api = conn.api as Loose;
    const head = (await api.rpc.chain.getHeader()).number.toNumber();
    if (from_block > head) throw new ToolError(`Block ${from_block} does not exist yet: the newest block on the ${network.label} is ${head}.`);
    const last = Math.min(to, head);
    const numbers: number[] = [];
    for (let n = from_block; n <= last; n++) numbers.push(n);
    const hashes = await blockHashes(conn, numbers);

    // The Ethereum side, asked once for the whole range while the node is read.
    const ethAsked = hasEvmRpc(network)
      ? ethRpc<unknown>(network, 'eth_getLogs', [{ fromBlock: hex(from_block), toBlock: hex(last), address: contract, ...(topic ? { topics: [topic] } : {}) }]).then(
          (answer) => {
            // Logs from another server: only well-formed ones are used, so their fields can be printed as they are.
            const list = Array.isArray(answer) ? answer : [];
            const logs = list.filter(isWellFormedLog);
            return { logs, error: Array.isArray(answer) ? null : 'its answer was not a list of logs', dropped: list.length - logs.length };
          },
          (err: unknown) => ({
            logs: null as EthLog[] | null,
            error: err instanceof EthRpcError ? `it refused the request with code ${err.code}: ${untrusted(redact(err.message), 200)}` : messageText(err instanceof Error ? err.message.split('. ')[0] : String(err), 300),
            dropped: 0,
          }),
        )
      : Promise.resolve({ logs: null as EthLog[] | null, error: null as string | null, dropped: 0 });

    // The node side: System.Events of each block, decoded with that block's own runtime.
    const found: Found[] = [];
    for (let i = 0; i < numbers.length; i += CHUNK) {
      const part = numbers.slice(i, i + CHUNK);
      const perBlock = await Promise.all(
        part.map(async (n, j) => {
          const bh = hashes[i + j];
          if (!bh) return [] as Found[];
          const at = await api.at(bh);
          const records = await at.query.system.events();
          const mine: Array<{ rec: Loose; topics: string[]; data: string }> = [];
          for (const rec of records) {
            if (rec.event.section !== 'revive' || rec.event.method !== 'ContractEmitted') continue;
            const names: string[] = (rec.event.meta?.fields ?? []).map((f: Loose) => (f.name?.isSome ? f.name.unwrap().toString() : ''));
            const pick = (name: string, fallback: number): Loose => rec.event.data[names.indexOf(name) >= 0 ? names.indexOf(name) : fallback];
            if (pick('contract', 0).toHex().toLowerCase() !== contract) continue;
            const topics: string[] = [...pick('topics', 2)].map((t: Loose) => t.toHex());
            if (topic && topics[0]?.toLowerCase() !== topic) continue;
            mine.push({ rec, topics, data: pick('data', 1).toHex() });
          }
          if (!mine.length) return [] as Found[];
          // Only blocks with a match are read in full, to name the extrinsic behind each event.
          const block = await api.rpc.chain.getBlock(bh);
          return mine.map(({ rec, topics, data }) => {
            const idx = rec.phase.isApplyExtrinsic ? rec.phase.asApplyExtrinsic.toNumber() : null;
            const x = idx === null ? null : block.block.extrinsics[idx];
            let source = idx === null ? `raised outside any extrinsic (${rec.phase.type})` : 'extrinsic not found';
            if (x) {
              const name = callName(at.registry, x.method);
              source = isEthTransact(x) ? `${name}: Ethereum transaction ${ethHashOf(x)}` : x.isSigned ? `${name}, signed by ${x.signer.toString()} (a native call)` : `${name} (unsigned)`;
            }
            return { block: n, extrinsic: idx, phase: rec.phase.type, topics, data, source };
          });
        }),
      );
      for (const list of perBlock) found.push(...list);
    }

    const eth = await ethAsked;
    // With nothing found, say whether there is a contract at all: a wrong address or network is the usual cause.
    const noContract = found.length === 0 && !(await readReviveAccount(conn, contract).catch(() => undefined))?.contract;
    const logs = eth.logs ?? [];
    const { logOf, unmatched } = eth.logs ? matchEvents(found, logs) : { logOf: found.map(() => -1), unmatched: [] as number[] };
    const served = logOf.filter((i) => i >= 0).length;
    const missing = found.length - served;
    const range = `blocks ${from_block} to ${last} (${numbers.length} block${numbers.length === 1 ? '' : 's'})`;

    const ethLine = !hasEvmRpc(network)
      ? `eth_getLogs: not asked. The ${network.label} has no public Ethereum RPC (checked Nov 13, 2026), so the node's System.Events are the only source there.`
      : eth.error
        ? `eth_getLogs: did not answer (${eth.error}), so whether these events are served there is unknown. Try again in a moment.`
        : found.length
          ? `eth_getLogs serves ${served} of them; ${missing} ${missing === 1 ? 'is' : 'are'} missing from eth_getLogs.`
          : `eth_getLogs returned ${logs.length} log(s) for this range too.`;

    const shown = found.slice(0, MAX_SHOWN).map((ev, k) => {
      const li = logOf[k];
      const servedText = !hasEvmRpc(network) ? 'not applicable (no Ethereum RPC)' : eth.error ? 'unknown (eth_getLogs did not answer)' : li >= 0 ? `yes (transaction ${logs[li].transactionHash ?? 'unknown'}, log index ${logs[li].logIndex ? Number(BigInt(logs[li].logIndex as string)) : 'unknown'})` : 'NO';
      return [
        `${k + 1}. block ${ev.block}, ${ev.extrinsic === null ? ev.source : `extrinsic ${ev.extrinsic}: ${ev.source}`}`,
        `   topics: ${ev.topics.length ? ev.topics.join(', ') : 'none'}`,
        `   data: ${dataText(ev.data)}`,
        `   served by eth_getLogs: ${servedText}`,
      ];
    });

    const strays = unmatched.map((j) => logs[j]);
    const firstWithIndex = found.find((ev) => ev.extrinsic !== null);
    return lines(
      `Events of the contract ${checksummed(contract)} on the ${network.label}, ${range}${topic ? `, first topic ${topic}` : ''}.`,
      `Read just now: System.Events of each block from the node${hasEvmRpc(network) ? ', and eth_getLogs from the Ethereum RPC' : ''}.`,
      parsed.checksumWarning && `WARNING: ${parsed.checksumWarning}`,
      to > head && `Note: to_block ${to} is beyond the newest block (${head}), so the range stops at ${head}.`,
      '',
      `${found.length} event${found.length === 1 ? '' : 's'} (Revive.ContractEmitted from this contract) on the node. ${ethLine}`,
      eth.dropped > 0 && `eth_getLogs also returned ${eth.dropped} entr${eth.dropped === 1 ? 'y' : 'ies'} whose fields were not 0x hex as they should be; ${eth.dropped === 1 ? 'it was' : 'they were'} left out.`,
      hasEvmRpc(network) && !eth.error && missing > 0 &&
        'Why some are missing: eth_getLogs serves only the logs of Ethereum transactions (Revive.ethTransact). A contract called by a native extrinsic (Revive.call, or a call inside a multisig) emits events that exist only in System.Events.',
      noContract && `There is no contract at ${checksummed(contract)} on the ${network.label} now (revive.accountInfoOf has no contract there), so check the address and the network.`,
      strays.length > 0 && [
        '',
        `UNEXPECTED: eth_getLogs returned ${strays.length} log(s) of this contract that the node's events for these blocks do not contain:`,
        ...strays.slice(0, 10).map((l) => `  block ${Number(BigInt(l.blockNumber))}, transaction ${l.transactionHash ?? 'unknown'}, topics ${l.topics.join(', ')}`),
        '  The node is the chain itself, so its events are the ones that count. Read the block with get_block to compare.',
      ],
      shown.length ? ['', ...shown.flat()] : null,
      found.length > MAX_SHOWN && `... ${found.length - MAX_SHOWN} more event(s) not shown. Ask for a smaller range to see them.`,
      '',
      'The node keeps no index of events by contract, so this tool reads block by block, at most 50 blocks per call: you need to know roughly where to look. get_transaction gives the block of a transaction.',
      hasEvmRpc(network) &&
        'eth_getLogs can search far wider ranges by address (on Nov 14, 2026 it answered for block 0 to the latest with no range limit), but it only sees events of Ethereum transactions.',
      firstWithIndex
        ? `Next: get_transaction {"block": ${firstWithIndex.block}, "index": ${firstWithIndex.extrinsic}${network.key === 'mainnet' ? ', "network": "mainnet"' : ''}} shows the full result of the extrinsic behind the first event.`
        : null,
    );
  },
});
