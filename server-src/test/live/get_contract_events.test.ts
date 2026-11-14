// get_contract_events against the live chains. The node side is checked against Revive.ContractEmitted
// events decoded here, and the "served by eth_getLogs" column against a raw eth_getLogs request for the
// same blocks. The fixtures are fixed history, public data of two contracts of other builders on the
// testnet: in block 463584 one emitted two events through a native Revive.call, and in block 389240
// another emitted one through an Ethereum transaction.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import tool from '../../src/tools/get_contract_events.ts';
import { runTool } from '../../src/lib/tool.ts';
import { closeAll, getConn } from '../../src/lib/chain.ts';
import { NETWORKS } from '../../src/lib/networks.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const NATIVE_CONTRACT = '0x072a1022f537a0da496801239725539101a41bb2';
const NATIVE_BLOCK = 463584;
const ETH_CONTRACT = '0xc05a1f041a42ffa96fc24a3aebc576b1157aa7f6';
const ETH_BLOCK = 389240;

const run = (args: unknown) => runTool(tool, args);

interface Log { blockNumber: string; transactionHash: string; topics: string[]; data: string }
async function getLogs(address: string, from: number, to: number, topic?: string): Promise<Log[]> {
  const res = await fetch(NETWORKS.testnet.evm!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address, ...(topic ? { topics: [topic] } : {}) }] }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { result: Log[]; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

/** One contract's Revive.ContractEmitted events in one block, decoded here. */
async function nodeEvents(address: string, block: number): Promise<Array<{ topics: string[]; data: string; index: number }>> {
  const api = (await getConn('testnet')).api as Loose;
  const at = await api.at(await api.rpc.chain.getBlockHash(block));
  const out = [];
  for (const r of await at.query.system.events()) {
    if (r.event.section !== 'revive' || r.event.method !== 'ContractEmitted') continue;
    const [contract, data, topics] = r.event.data;
    if (contract.toHex() !== address.toLowerCase()) continue;
    out.push({ topics: [...topics].map((t: Loose) => t.toHex()), data: data.toHex(), index: r.phase.asApplyExtrinsic.toNumber() });
  }
  return out;
}

const count = (text: string): number => Number(/^(\d+) events? \(Revive\.ContractEmitted from this contract\) on the node/m.exec(text)?.[1] ?? NaN);

test('an event from a native Revive.call: found on the node, not served by eth_getLogs', async () => {
  const { text, isError } = await run({ address: NATIVE_CONTRACT, from_block: NATIVE_BLOCK });
  assert.equal(isError, false, text);
  const mine = await nodeEvents(NATIVE_CONTRACT, NATIVE_BLOCK);
  assert.ok(mine.length >= 1);
  assert.equal(count(text), mine.length);
  assert.deepEqual(await getLogs(NATIVE_CONTRACT, NATIVE_BLOCK, NATIVE_BLOCK), []);
  assert.match(text, new RegExp(`1\\. block ${NATIVE_BLOCK}, extrinsic ${mine[0].index}: Revive\\.call, signed by 5\\w+ \\(a native call\\)`));
  assert.match(text, new RegExp(`topics: ${mine[0].topics.join(', ')}`));
  assert.match(text, new RegExp(`data: ${mine[0].data} \\(\\d+ bytes\\)`));
  assert.match(text, /served by eth_getLogs: NO/);
  assert.match(text, /eth_getLogs serves 0 of them; \d+ (is|are) missing from eth_getLogs/);
  assert.match(text, /Why some are missing: eth_getLogs serves only the logs of Ethereum transactions/);
});

test('an event from an Ethereum transaction: served by eth_getLogs, with the same transaction, topics and data', async () => {
  const { text, isError } = await run({ address: ETH_CONTRACT, from_block: ETH_BLOCK });
  assert.equal(isError, false, text);
  const logs = await getLogs(ETH_CONTRACT, ETH_BLOCK, ETH_BLOCK);
  assert.ok(logs.length >= 1);
  assert.equal(count(text), logs.length);
  assert.match(text, new RegExp(`Revive\\.ethTransact: Ethereum transaction ${logs[0].transactionHash}`));
  assert.match(text, new RegExp(`topics: ${logs[0].topics.join(', ')}`));
  assert.match(text, new RegExp(`served by eth_getLogs: yes \\(transaction ${logs[0].transactionHash}, log index \\d+\\)`));
  assert.doesNotMatch(text, /Why some are missing/);
});

test('a 50-block range: the served count equals what eth_getLogs returns for the same blocks', async () => {
  const from = NATIVE_BLOCK - 24;
  const to = from + 49;
  const { text, isError } = await run({ address: NATIVE_CONTRACT, from_block: from, to_block: to });
  assert.equal(isError, false, text);
  assert.match(text, new RegExp(`blocks ${from} to ${to} \\(50 blocks\\)`));
  const logs = await getLogs(NATIVE_CONTRACT, from, to);
  const served = Number(/eth_getLogs serves (\d+) of them/.exec(text)?.[1]);
  assert.equal(served, logs.length);
  assert.ok(count(text) > served, 'the native-path events of block 463584 are in this range');
  assert.doesNotMatch(text, /UNEXPECTED/);
});

test('topic0 keeps only the events whose first topic matches', async () => {
  const [first] = await nodeEvents(ETH_CONTRACT, ETH_BLOCK);
  const hit = await run({ address: ETH_CONTRACT, from_block: ETH_BLOCK, topic0: first.topics[0] });
  assert.equal(count(hit.text), 1);
  assert.match(hit.text, new RegExp(`first topic ${first.topics[0]}`));
  const miss = await run({ address: ETH_CONTRACT, from_block: ETH_BLOCK, topic0: `0x${'00'.repeat(31)}01` });
  assert.equal(count(miss.text), 0);
  assert.match(miss.text, /eth_getLogs returned 0 log\(s\) for this range too/);
});

test('an address with no contract gets a clear answer', async () => {
  const { text, isError } = await run({ address: '0x1111111111111111111111111111111111111111', from_block: ETH_BLOCK });
  assert.equal(isError, false, text);
  assert.equal(count(text), 0);
  assert.match(text, /There is no contract at 0x1111111111111111111111111111111111111111 on the Portaldot V3 testnet now/);
});

test('refusals: more than 50 blocks, a reversed or future range, a bad topic, a native address', async () => {
  const api = (await getConn('testnet')).api as Loose;
  const head = (await api.rpc.chain.getHeader()).number.toNumber();
  const cases: Array<[unknown, RegExp]> = [
    [{ address: ETH_CONTRACT, from_block: 1000, to_block: 1050 }, /At most 50 blocks per call: blocks 1000 to 1050 are 51 blocks\. Split the range, for example 1000 to 1049 first/],
    [{ address: ETH_CONTRACT, from_block: 1010, to_block: 1000 }, /to_block \(1000\) is before from_block \(1010\)/],
    [{ address: ETH_CONTRACT, from_block: head + 100_000 }, /does not exist yet: the newest block on the Portaldot V3 testnet is \d+/],
    [{ address: ETH_CONTRACT, from_block: 1000, topic0: '0x1234' }, /topic0 must be 0x and 64 hex characters/],
    [{ address: '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z', from_block: 1000 }, /is a native account, not a contract/],
    [{ address: '0x1234', from_block: 1000 }, /neither a 0x address/],
  ];
  for (const [args, re] of cases) {
    const { text, isError } = await run(args);
    assert.equal(isError, true, `${JSON.stringify(args)} was not refused:\n${text}`);
    assert.match(text, re);
  }
});

test('the mainnet: zero events, read from the node only', async () => {
  const { text, isError } = await run({ address: ETH_CONTRACT, from_block: 1000, to_block: 1009, network: 'mainnet' });
  assert.equal(isError, false, text);
  assert.equal(count(text), 0);
  assert.match(text, /on the Portaldot V3 mainnet, blocks 1000 to 1009 \(10 blocks\)/);
  assert.match(text, /eth_getLogs: not asked\. The Portaldot V3 mainnet has no public Ethereum RPC/);
  assert.doesNotMatch(text, /eth_getLogs can search far wider ranges/);
});

after(async () => {
  await closeAll();
});
