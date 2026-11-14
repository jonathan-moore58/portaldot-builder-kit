// get_block against the live chains. What the tool prints is checked a second way: block and parent
// hashes against raw chain_getBlockHash / chain_getHeader, the Ethereum-side hash and the time against
// eth_getBlockByNumber, and the Ethereum transaction hash against that block's own transaction list.
// Old blocks used as fixtures are fixed history; nothing depends on the newest block number.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import tool from '../../src/tools/get_block.ts';
import { runTool } from '../../src/lib/tool.ts';
import { closeAll } from '../../src/lib/chain.ts';
import { NETWORKS, type NetworkKey } from '../../src/lib/networks.ts';

// Two public test transactions of Nov 13, 2026 (Ethereum transactions sent to the pallets address).
const FIXTURE_BLOCK = 452626;
const FIXTURE_ETH_HASH = '0xd56478b42c6be657c123c44f2bebecf0eaae3c7e689c69b17deb2cfdee0cf1ac';

const run = (args: unknown) => runTool(tool, args);

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  const body = (await res.json()) as { result: T; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
const node = <T>(key: NetworkKey, method: string, params: unknown[]) => rpc<T>(NETWORKS[key].ws.replace(/^wss:/, 'https:'), method, params);
const eth = <T>(method: string, params: unknown[]) => rpc<T>(NETWORKS.testnet.evm!, method, params);

function get(text: string, re: RegExp): string {
  const m = re.exec(text);
  assert.ok(m, `missing ${re} in:\n${text}`);
  return m[1];
}
const utcOf = (seconds: string): string => `${new Date(Number(BigInt(seconds)) * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

test('a block with an Ethereum transaction: both hashes, the time and the transaction hash match a second source', async () => {
  const { text, isError } = await run({ block: FIXTURE_BLOCK });
  assert.equal(isError, false, text);
  const hash = get(text, /^hash: +(0x[0-9a-f]{64})$/m);
  assert.equal(hash, await node<string>('testnet', 'chain_getBlockHash', [FIXTURE_BLOCK]));
  const header = await node<{ parentHash: string }>('testnet', 'chain_getHeader', [hash]);
  assert.equal(get(text, /^parent hash: +(0x[0-9a-f]{64})$/m), header.parentHash);
  const ethBlock = await eth<{ hash: string; timestamp: string; transactions: string[] }>('eth_getBlockByNumber', [`0x${FIXTURE_BLOCK.toString(16)}`, false]);
  assert.equal(get(text, /^Ethereum block hash: (0x[0-9a-f]{64}) \(revive\.blockHash read at this block\)/m), ethBlock.hash);
  assert.notEqual(ethBlock.hash, hash);
  assert.match(text, new RegExp(`time: +${utcOf(ethBlock.timestamp)} \\(timestamp\\.now at this block\\)`));
  assert.match(text, /^finalized: +yes/m);
  assert.match(text, /extrinsics: +2: 1 inherent, 0 signed, 1 Ethereum transaction\(s\)/);
  assert.match(text, /#0 Timestamp\.set \(inherent: added by the block author\)/);
  assert.match(text, new RegExp(`#1 Revive\\.ethTransact: an Ethereum transaction, hash ${FIXTURE_ETH_HASH}`));
  assert.ok(ethBlock.transactions.includes(FIXTURE_ETH_HASH));
  assert.match(text, /fee paid: \S+ tPOT \(\d+ base units\)/);
  assert.match(text, /System\.Remarked \{ sender: 5\w+/);
  assert.match(text, /https:\/\/scanner-testnet-v3\.portaldot\.dev\/#\/extrinsics\/452626-1/);
  assert.match(text, /get_transaction \{"block": 452626, "index": 1\}/);
});

test('the Ethereum-side hash of a block finds the same block, with a note', async () => {
  const ethBlock = await eth<{ hash: string }>('eth_getBlockByNumber', [`0x${FIXTURE_BLOCK.toString(16)}`, false]);
  const { text, isError } = await run({ block: ethBlock.hash });
  assert.equal(isError, false, text);
  assert.match(text, new RegExp(`Note: ${ethBlock.hash} is the Ethereum-side hash of block ${FIXTURE_BLOCK}`));
  assert.match(text, new RegExp(`^Block ${FIXTURE_BLOCK} on the Portaldot V3 testnet`, 'm'));
  const bySubstrateHash = await run({ block: await node<string>('testnet', 'chain_getBlockHash', [FIXTURE_BLOCK]) });
  assert.match(bySubstrateHash.text, new RegExp(`^Block ${FIXTURE_BLOCK} on`, 'm'));
  assert.doesNotMatch(bySubstrateHash.text, /^Note:/m);
});

test('"latest" and "finalized" are at least as new as the heads read just before', async () => {
  const head = Number(BigInt((await node<{ number: string }>('testnet', 'chain_getHeader', [])).number));
  const latest = await run({});
  assert.ok(Number(get(latest.text, /^Block (\d+) on the Portaldot V3 testnet/m)) >= head);
  const finHash = await node<string>('testnet', 'chain_getFinalizedHead', []);
  const fin = Number(BigInt((await node<{ number: string }>('testnet', 'chain_getHeader', [finHash])).number));
  const finalized = await run({ block: 'finalized' });
  assert.ok(Number(get(finalized.text, /^Block (\d+) on/m)) >= fin);
  assert.match(finalized.text, /^finalized: +yes/m);
});

test('the genesis block: the recorded genesis hash, no time and no extrinsics', async () => {
  const { text, isError } = await run({ block: 0 });
  assert.equal(isError, false, text);
  assert.equal(get(text, /^hash: +(0x[0-9a-f]{64})$/m), NETWORKS.testnet.genesis);
  assert.match(text, /the genesis block has no time/);
  assert.match(text, /This block holds no extrinsics at all\./);
});

test('a reverted Ethereum transaction is flagged although the node marks the extrinsic successful', async () => {
  // testnet block 343010 holds an Ethereum contract creation whose constructor failed (Nov 6, 2026)
  const { text, isError } = await run({ block: 343010 });
  assert.equal(isError, false, text);
  assert.match(text, /the Ethereum transaction REVERTED \(Revive\.EthExtrinsicRevert: Revive\.\w+/);
  assert.match(text, /The extrinsic itself shows System\.ExtrinsicSuccess and the fee was paid/);
});

test('a failed native extrinsic shows its named error and the fee it paid', async () => {
  // testnet block 334731: a Balances.transferAllowDeath of more than the sender had (Nov 5, 2026)
  const { text, isError } = await run({ block: 334731 });
  assert.equal(isError, false, text);
  assert.match(text, /#1 Balances\.transferAllowDeath, signed by 5\w+\n +result: FAILED: Token\.FundsUnavailable\n +fee paid: \S+ tPOT/);
});

test('refusals: an unknown hash, a future block, text that is no block, a secret phrase', async () => {
  const head = Number(BigInt((await node<{ number: string }>('testnet', 'chain_getHeader', [])).number));
  const cases: Array<[unknown, RegExp]> = [
    [{ block: `0x${'11'.repeat(32)}` }, /No block with the hash 0x1{64} is known to the node of the Portaldot V3 testnet or to its Ethereum RPC/],
    [{ block: head + 100_000 }, /does not exist yet: the newest block on the Portaldot V3 testnet is \d+/],
    [{ block: 'abc' }, /is not a block\. Give a block number/],
    [{ block: -1 }, /Invalid input/],
    [{ block: 'legal winner thank year wave sausage worth useful legal winner thank yellow' }, /secret recovery phrase/],
  ];
  for (const [args, re] of cases) {
    const { text, isError } = await run(args);
    assert.equal(isError, true, `${JSON.stringify(args)} was not refused:\n${text}`);
    assert.match(text, re);
  }
});

test('the mainnet: the newest block and block 1000, with the mainnet genesis behind them', async () => {
  const latest = await run({ network: 'mainnet' });
  assert.equal(latest.isError, false, latest.text);
  assert.match(latest.text, /on the Portaldot V3 mainnet \(runtime \d+\)/);
  assert.match(latest.text, /this network has no public Ethereum RPC/);
  const old = await run({ block: 1000, network: 'mainnet' });
  assert.equal(get(old.text, /^hash: +(0x[0-9a-f]{64})$/m), await node<string>('mainnet', 'chain_getBlockHash', [1000]));
  assert.match(old.text, /#0 Timestamp\.set \(inherent/);
  const genesis = await run({ block: 0, network: 'mainnet' });
  assert.equal(get(genesis.text, /^hash: +(0x[0-9a-f]{64})$/m), NETWORKS.mainnet.genesis);
  const ethHash = await run({ block: `0x${'11'.repeat(32)}`, network: 'mainnet' });
  assert.equal(ethHash.isError, true);
  assert.match(ethHash.text, /is known to the node of the Portaldot V3 mainnet\. Check the network/);
});

after(async () => {
  await closeAll();
});
