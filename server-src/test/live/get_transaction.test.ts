// get_transaction against the live chains. Checked a second way: the Ethereum hash against keccak-256 of
// the Revive.ethTransact payload decoded here from the raw block, the receipt fields against raw
// eth_getTransactionReceipt, the fee against the block's TransactionFeePaid event, and a native
// extrinsic's hash against blake2-256 of its raw bytes. Old blocks are fixed history; one contract-call
// transaction is found at run time with eth_getLogs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { blake2AsHex, keccakAsHex } from '@polkadot/util-crypto';
import tool from '../../src/tools/get_transaction.ts';
import { runTool } from '../../src/lib/tool.ts';
import { closeAll, getConn } from '../../src/lib/chain.ts';
import { decodeEthRaw } from '../../src/lib/evm.ts';
import { NETWORKS, PALLETS_ADDRESS, type NetworkKey } from '../../src/lib/networks.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

// Two public test transactions of Nov 13, 2026: Ethereum transactions to the pallets address.
const REMARK = { hash: '0xd56478b42c6be657c123c44f2bebecf0eaae3c7e689c69b17deb2cfdee0cf1ac', block: 452626 };
const TRANSFER = { hash: '0xfc56147732c9eb9b9095658623c0da101caba98d29ebc1c805209dda0cac9c0c', block: 452633 };
// Three public test transactions of Nov 15, 2026 that were included and FAILED, each with its fee charged:
// a native transfer through the pallets address that the sender could not pay (its receipt shows gasUsed 0
// and effectiveGasPrice 0), a transfer whose value did not fit after gas limit x base fee, and a contract call
// with a selector the contract does not have.
const FAILED_PALLETS = { hash: '0x45cc8d26bda0c14d382ad1a8cbf5fcf851286e036d8172ad79dfcf67561db855', block: 477826 };
const FAILED_VALUE = { hash: '0x29aa26ad3e8fa2262237dbca62dced9d8165497b64c47d0a08f11152d8297479', block: 477940 };
const FAILED_CALL = { hash: '0xea726e2efcb3f4f98a43b943ab5c50b5aa52186ba7b20809e4c860d00f6235f2', block: 477827 };

const run = (args: unknown) => runTool(tool, args);

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
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

/** keccak-256 of the payload of the Revive.ethTransact at this index, decoded here from the raw block. */
async function payloadHash(block: number, index: number): Promise<string> {
  const conn = await getConn('testnet');
  const hash = await node<string>('testnet', 'chain_getBlockHash', [block]);
  const raw = await node<{ block: { extrinsics: string[] } }>('testnet', 'chain_getBlock', [hash]);
  const x = (conn.api as Loose).registry.createType('Extrinsic', raw.block.extrinsics[index]);
  assert.equal(`${x.method.section}.${x.method.method}`, 'revive.ethTransact');
  return keccakAsHex(x.method.args[0].toU8a(true), 256);
}

/** The actualFee of TransactionPayment.TransactionFeePaid for one extrinsic, read here. */
async function feePaid(key: NetworkKey, block: number, index: number): Promise<bigint> {
  const conn = await getConn(key);
  const at = await (conn.api as Loose).at(await node<string>(key, 'chain_getBlockHash', [block]));
  const rec = (await at.query.system.events()).find((r: Loose) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === index && r.event.method === 'TransactionFeePaid');
  return BigInt(rec.event.data[1].toString());
}

test('an Ethereum hash to the pallets address: System.remarkWithEvent decoded, both sides shown, and the hash is keccak-256 of the payload', async () => {
  const { text, isError } = await run({ hash: REMARK.hash });
  assert.equal(isError, false, text);
  assert.match(text, new RegExp(`^Ethereum transaction ${REMARK.hash} on the Portaldot V3 testnet: success\\.`, 'm'));
  assert.match(text, new RegExp(`block: +${REMARK.block}, extrinsic index 1 \\(Revive\\.ethTransact\\)`));
  assert.equal(await payloadHash(REMARK.block, 1), REMARK.hash);
  assert.match(text, /System\.remarkWithEvent\n +remark: "native call from a 0x account, test 1"/);
  assert.match(text, /receipt shows gasUsed 0 and no logs by design, and effectiveGasPrice 0, also when the call fails and a fee is paid/);
  assert.doesNotMatch(text, /what that means: +it FAILED/, 'a success is not called a failure');
  assert.match(text, /System\.Remarked \{ sender: 5\w+/);
  const receipt = await eth<{ gasUsed: string; status: string; logs: unknown[] }>('eth_getTransactionReceipt', [REMARK.hash]);
  assert.equal(receipt.status, '0x1');
  assert.equal(BigInt(get(text, /gas used: +(\d+)/)), BigInt(receipt.gasUsed));
  assert.equal(Number(get(text, /logs on the receipt: (\d+)/)), receipt.logs.length);
  assert.equal(BigInt(get(text, /fee paid: +\S+ tPOT \((\d+) base units\) \(TransactionPayment\.TransactionFeePaid\)/)), await feePaid('testnet', REMARK.block, 1));
  assert.match(text, /^finalized: +yes/m);
  assert.match(text, /The explorer cannot look up the 0x hash itself/);
});

test('an Ethereum hash of Balances.transferKeepAlive of 0.01 tPOT through the pallets address', async () => {
  const { text, isError } = await run({ hash: TRANSFER.hash });
  assert.equal(isError, false, text);
  assert.match(text, /Balances\.transferKeepAlive\n +dest: .*\n +value: 1000000000000 \(0\.01 tPOT\)/);
  assert.match(text, /Balances\.Transfer \{ from: 5\w+, to: 5\w+, amount: 1000000000000 \(0\.01 tPOT\) \}/);
  assert.equal(await payloadHash(TRANSFER.block, 1), TRANSFER.hash);
});

test('an ordinary contract call sent as an Ethereum transaction, found at run time: receipt fields and cost match', async () => {
  const head = Number(BigInt(await eth<string>('eth_blockNumber', [])));
  let logs: Array<{ transactionHash: string; blockNumber: string }> = [];
  for (const span of [5_000, 50_000]) {
    logs = await eth('eth_getLogs', [{ fromBlock: `0x${Math.max(0, head - span).toString(16)}`, toBlock: `0x${head.toString(16)}` }]);
    if (logs.length) break;
  }
  assert.ok(logs.length, 'no Ethereum-transaction log in the last 50000 blocks');
  const hash = logs[logs.length - 1].transactionHash;
  const tx = await eth<{ to: string | null }>('eth_getTransactionByHash', [hash]);
  const receipt = await eth<{ gasUsed: string; effectiveGasPrice: string; status: string; logs: unknown[] }>('eth_getTransactionReceipt', [hash]);
  const { text, isError } = await run({ hash });
  assert.equal(isError, false, text);
  assert.match(text, new RegExp(`^Ethereum transaction ${hash} on the Portaldot V3 testnet: ${receipt.status === '0x1' ? 'success' : 'REVERTED'}\\.`, 'm'));
  if (tx.to && tx.to.toLowerCase() !== PALLETS_ADDRESS) assert.match(text, new RegExp(`to: +${tx.to}`, 'i'));
  assert.equal(BigInt(get(text, /gas used: +(\d+)/)), BigInt(receipt.gasUsed));
  assert.equal(BigInt(get(text, /effective gas price: (\d+) wei per gas/)), BigInt(receipt.effectiveGasPrice));
  assert.equal(Number(get(text, /logs on the receipt: (\d+)/)), receipt.logs.length);
  assert.match(text, /check: +cost on the receipt = fee/);
  assert.match(text, /contract events: \d+ \(Revive\.ContractEmitted\)/);
  assert.match(text, /Next: get_contract_events \{"address": "0x[0-9a-f]{40}", "from_block": \d+\}/);
});

test('a reverted Ethereum deployment: REVERTED on the receipt, EthExtrinsicRevert on the node, and no contract left', async () => {
  // testnet block 343010 (Nov 6, 2026): a creation transaction whose constructor failed
  const hash = '0x89d02d3474fed5a0d6df5e4057d97e03fe3ae5724198beb7669faa4da7e13c1a';
  const { text, isError } = await run({ hash });
  assert.equal(isError, false, text);
  assert.match(text, /: REVERTED\./);
  assert.match(text, /to: +none: a contract creation/);
  assert.match(text, /status: +reverted \(receipt status 0x0\)/);
  const receipt = await eth<{ contractAddress: string }>('eth_getTransactionReceipt', [hash]);
  assert.match(text, new RegExp(`contract address: +${receipt.contractAddress} \\(on the receipt\\)\\. The deploy reverted, and no contract exists at that address now`));
  assert.equal(await eth<string>('eth_getCode', [receipt.contractAddress, 'latest']), '0x');
  assert.match(text, /result: +Revive\.EthExtrinsicRevert: Revive\.\w+/);
  assert.match(text, /explain_error takes the error name above/);
});

test('a successful Ethereum deployment: its cost is the fee plus the storage and the code deposit', async () => {
  // testnet block 354887 (Nov 6, 2026): a contract created by an Ethereum transaction
  const hash = '0x1cfaceae32ea201a0e64d741c86fdd5f20407daa4b83dc857d2124336ce9fe3d';
  const { text, isError } = await run({ hash });
  assert.equal(isError, false, text);
  const receipt = await eth<{ contractAddress: string; gasUsed: string; effectiveGasPrice: string }>('eth_getTransactionReceipt', [hash]);
  assert.match(text, new RegExp(`contract address: +${receipt.contractAddress} \\(on the receipt\\)`));
  assert.match(text, /contract created: 0x[0-9a-f]{40} \(Revive\.Instantiated\)/);
  const storage = BigInt(get(text, /storage deposit held: \S+ tPOT \((\d+) base units\)/));
  const code = BigInt(get(text, /code deposit held: +\S+ tPOT \((\d+) base units\)/));
  const fee = BigInt(get(text, /fee paid: +\S+ tPOT \((\d+) base units\)/));
  const cost = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  const rest = cost - (fee + storage + code) * 10_000n;
  assert.ok(rest >= 0n && rest < BigInt(receipt.effectiveGasPrice), `cost ${cost} against fee + deposits: rest ${rest}`);
  assert.match(text, /check: +cost on the receipt = fee \+ storage deposit \+ code deposit/);
});

test('a failed native extrinsic by block and index: the named error, the fee charged anyway', async () => {
  // testnet block 334731 (Nov 5, 2026): a Balances.transferAllowDeath of more than the sender had
  const { text, isError } = await run({ block: 334731, index: 1 });
  assert.equal(isError, false, text);
  assert.match(text, /^Extrinsic 334731-1 on the Portaldot V3 testnet: Balances\.transferAllowDeath, FAILED: Token\.FundsUnavailable\./m);
  assert.match(text, /^signer: +5\w+ \(its 0x form, which contracts see as msg\.sender: 0x[0-9a-f]{40}\)/m);
  assert.match(text, /^nonce: +\d+$/m);
  assert.match(text, /The fee is charged even though the call failed/);
  assert.equal(BigInt(get(text, /^fee paid: +\S+ tPOT \((\d+) base units\)/m)), await feePaid('testnet', 334731, 1));
  const raw = await node<{ block: { extrinsics: string[] } }>('testnet', 'chain_getBlock', [await node<string>('testnet', 'chain_getBlockHash', [334731])]);
  assert.equal(get(text, /^extrinsic hash: (0x[0-9a-f]{64})$/m), blake2AsHex(raw.block.extrinsics[1], 256));
});

test('a native extrinsic found by its hash alone, by reading the newest blocks', async () => {
  const head = await node<{ block: { extrinsics: string[]; header: { number: string } } }>('testnet', 'chain_getBlock', []);
  const hash = blake2AsHex(head.block.extrinsics[0], 256);
  const { text, isError } = await run({ hash, search_blocks: 20 });
  assert.equal(isError, false, text);
  assert.match(text, new RegExp(`^Extrinsic ${Number(BigInt(head.block.header.number))}-0 on the Portaldot V3 testnet: Timestamp\\.set, success \\(an inherent`, 'm'));
  assert.match(text, /Found by reading the newest 20 blocks \(no node can look up an extrinsic by its hash\)/);
});

test('hashes that are not transactions, and input that cannot work, are refused with what to do', async () => {
  const blockHash = await node<string>('testnet', 'chain_getBlockHash', [REMARK.block]);
  const ethBlock = await eth<{ hash: string }>('eth_getBlockByNumber', [`0x${REMARK.block.toString(16)}`, false]);
  const cases: Array<[unknown, RegExp]> = [
    [{ hash: blockHash, search_blocks: 3 }, new RegExp(`That is the hash of block ${REMARK.block}, not of a transaction`)],
    [{ hash: ethBlock.hash, search_blocks: 3 }, new RegExp(`That is the Ethereum-side hash of block ${REMARK.block}`)],
    [{ hash: `0x${'11'.repeat(32)}`, search_blocks: 3 }, /No transaction with the hash .* was found on the Portaldot V3 testnet\. Read just now:[\s\S]*newest 3 blocks[\s\S]*not in the node's pool[\s\S]*No node can look up a native extrinsic by its hash/],
    [{ hash: '0x8ddee436166f311ddeed36d714b08f512670d16e' }, /A 0x address \(40 hex characters\) is not a transaction; get_account/],
    [{ index: 1 }, /Give "hash"/],
    [{}, /Give "hash"/],
    [{ block: REMARK.block, index: 9 }, /has 2 extrinsic\(s\), at index 0 to 1; there is no index 9/],
    [{ block: REMARK.block }, /Give "index" \(0 to 1\) or "hash"/],
    [{ block: REMARK.block, hash: TRANSFER.hash }, /No extrinsic of block 452626 .* Its extrinsics are:[\s\S]*Ethereum hash 0xd564/],
    [{ hash: 'legal winner thank year wave sausage worth useful legal winner thank yellow' }, /secret recovery phrase/],
  ];
  for (const [args, re] of cases) {
    const { text, isError } = await run(args);
    assert.equal(isError, true, `${JSON.stringify(args)} was not refused:\n${text}`);
    assert.match(text, re);
  }
});

/** The receipt and the block's base fee, read here, for a failed transaction. */
async function failedReceipt(hash: string, block: number): Promise<{ status: string; gasUsed: bigint; price: bigint; baseFee: bigint }> {
  const r = await eth<{ status: string; gasUsed: string; effectiveGasPrice: string; blockNumber: string }>('eth_getTransactionReceipt', [hash]);
  assert.equal(Number(BigInt(r.blockNumber)), block);
  const b = await eth<{ baseFeePerGas: string }>('eth_getBlockByNumber', [`0x${block.toString(16)}`, false]);
  return { status: r.status, gasUsed: BigInt(r.gasUsed), price: BigInt(r.effectiveGasPrice), baseFee: BigInt(b.baseFeePerGas) };
}

test('a failed native call through the pallets address: FAILED, gasUsed 0 and effectiveGasPrice 0, and the fee paid all the same', async () => {
  const { text, isError } = await run({ hash: FAILED_PALLETS.hash });
  assert.equal(isError, false, text);
  const receipt = await failedReceipt(FAILED_PALLETS.hash, FAILED_PALLETS.block);
  assert.deepEqual([receipt.status, receipt.gasUsed, receipt.price], ['0x0', 0n, 0n]);
  assert.match(text, /: REVERTED\./);
  assert.match(text, /status: +reverted \(receipt status 0x0\)\n +what that means: +it FAILED in its block\. It is included and used its nonce, its effects were undone, and the fee was charged all the same/);
  assert.match(text, /^ +gas used: +0$/m);
  assert.match(text, /effective gas price: 0 wei per gas \(always 0 for a native call through the pallets address, also when a fee was paid/);
  assert.match(text, /That does not mean it was free: the fee was paid on the node/);
  assert.match(text, /Balances\.transferKeepAlive/);
  assert.match(text, /Revive\.EthExtrinsicRevert: Token\.FundsUnavailable/);
  const index = Number(get(text, /extrinsic index (\d+) \(Revive\.ethTransact\)/));
  const fee = BigInt(get(text, /fee paid: +\S+ tPOT \((\d+) base units\)/));
  assert.ok(fee > 0n);
  assert.equal(fee, await feePaid('testnet', FAILED_PALLETS.block, index));
});

test('a transfer whose value did not fit after gas limit x base fee: included, FAILED, charged gas used x base fee, and the cause named', async () => {
  const { text, isError } = await run({ hash: FAILED_VALUE.hash });
  assert.equal(isError, false, text);
  const receipt = await failedReceipt(FAILED_VALUE.hash, FAILED_VALUE.block);
  assert.equal(receipt.status, '0x0');
  assert.equal(receipt.price, receipt.baseFee, 'charged at the base fee');
  assert.match(text, /what that means: +it FAILED in its block\..* The charge is gas used x the base fee\./);
  assert.match(text, /Revive\.EthExtrinsicRevert: Revive\.TransferFailed/);
  assert.match(text, /likely cause: +the value could not be paid on top of the gas\. The node takes a transaction when gas limit x base fee is covered and does not count the value/);
  assert.equal(BigInt(get(text, /gas used: +(\d+)/)), receipt.gasUsed);
  assert.match(text, /check: +cost on the receipt = fee \(no deposit was held\)/);
});

test('a contract call that reverted: FAILED with its fee, and no value cause is guessed', async () => {
  const { text, isError } = await run({ hash: FAILED_CALL.hash });
  assert.equal(isError, false, text);
  const receipt = await failedReceipt(FAILED_CALL.hash, FAILED_CALL.block);
  assert.equal(receipt.status, '0x0');
  assert.equal(receipt.price, receipt.baseFee, 'charged at the base fee');
  assert.match(text, /what that means: +it FAILED in its block/);
  assert.match(text, /Revive\.EthExtrinsicRevert: Revive\.ContractReverted/);
  assert.doesNotMatch(text, /likely cause: /);
  assert.equal(BigInt(get(text, /effective gas price: (\d+) wei per gas/)), receipt.baseFee);
});

test('the signed bytes a waiting transaction carries are read right: the payload of a real one against eth_getTransactionByHash', async () => {
  const conn = await getConn('testnet');
  const hash = await node<string>('testnet', 'chain_getBlockHash', [FAILED_PALLETS.block]);
  const raw = await node<{ block: { extrinsics: string[] } }>('testnet', 'chain_getBlock', [hash]);
  const x = raw.block.extrinsics.map((e) => (conn.api as Loose).registry.createType('Extrinsic', e)).find((e: Loose) => keccakAsHex(e.method.args[0]?.toU8a?.(true) ?? new Uint8Array(0), 256) === FAILED_PALLETS.hash);
  assert.ok(x, 'the Revive.ethTransact of the transaction');
  const t = decodeEthRaw(x.method.args[0].toU8a(true));
  const tx = await eth<{ type: string; chainId: string; nonce: string; gas: string; to: string; value: string; input: string; maxFeePerGas: string; maxPriorityFeePerGas: string }>('eth_getTransactionByHash', [FAILED_PALLETS.hash]);
  assert.ok(t);
  assert.equal(t.type, Number(BigInt(tx.type)));
  assert.equal(t.chainId, BigInt(tx.chainId));
  assert.equal(t.nonce, BigInt(tx.nonce));
  assert.equal(t.gasLimit, BigInt(tx.gas));
  assert.equal(t.to, tx.to.toLowerCase());
  assert.equal(t.value, BigInt(tx.value));
  assert.equal(t.data, tx.input);
  assert.equal(t.maxFeePerGas, BigInt(tx.maxFeePerGas));
  assert.equal(t.maxPriorityFeePerGas, BigInt(tx.maxPriorityFeePerGas));
});

test('a hash in no block is looked up in the node\'s pool, and the answer says what "not found" can mean', async () => {
  const { text, isError } = await run({ hash: `0x${'22'.repeat(32)}`, search_blocks: 2 });
  assert.equal(isError, true);
  assert.match(text, /not in the node's pool of transactions waiting for a block \(author_pendingExtrinsics, read just now, held \d+/);
  assert.match(text, /it was refused when it was sent/);
  assert.match(text, /it was replaced by another transaction with the same nonce/);
  assert.match(text, /it waits behind a nonce gap/);
  assert.doesNotMatch(text, /\n\s+at /);
});

test('the block given as its Ethereum-side hash, with the transaction hash', async () => {
  const ethBlock = await eth<{ hash: string }>('eth_getBlockByNumber', [`0x${REMARK.block.toString(16)}`, false]);
  const { text, isError } = await run({ block: ethBlock.hash, hash: REMARK.hash });
  assert.equal(isError, false, text);
  assert.match(text, new RegExp(`^Note: ${ethBlock.hash} is the Ethereum-side hash of block ${REMARK.block}`));
  assert.match(text, new RegExp(`Ethereum transaction ${REMARK.hash} on the Portaldot V3 testnet: success`));
});

test('the mainnet: an Ethereum hash cannot be looked up there; block and index work', async () => {
  const lookup = await run({ hash: REMARK.hash, search_blocks: 3, network: 'mainnet' });
  assert.equal(lookup.isError, true);
  assert.match(lookup.text, /has no public Ethereum RPC .* so an Ethereum 0x transaction hash cannot be looked up there/);
  assert.match(lookup.text, /block and index work on both networks/);
  const { text, isError } = await run({ block: 1000, index: 0, network: 'mainnet' });
  assert.equal(isError, false, text);
  assert.match(text, /^Extrinsic 1000-0 on the Portaldot V3 mainnet: Timestamp\.set, success \(an inherent/m);
  assert.equal(get(text, /^block hash: +(0x[0-9a-f]{64})$/m), await node<string>('mainnet', 'chain_getBlockHash', [1000]));
  assert.match(text, /https:\/\/scanner-live-v3\.portaldot\.dev\/#\/extrinsics\/1000-0/);
});

after(async () => {
  await closeAll();
});
