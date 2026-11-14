// estimate_eth_transaction against the live chains, with no account of ours: the Treasury's 0x form as
// "from" (an estimate needs no signature), an address with no balance, and a contract found on the chain
// at run time. The estimate is checked a second way with a raw eth_estimateGas request, and the limits
// are recomputed from the printed numbers. Nothing depends on a balance or a block number.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import tool from '../../src/tools/estimate_eth_transaction.ts';
import { runTool } from '../../src/lib/tool.ts';
import { closeAll, getConn } from '../../src/lib/chain.ts';
import { NETWORKS } from '../../src/lib/networks.ts';

const TREASURY_H160 = '0x8ddee436166f311ddeed36d714b08f512670d16e';
const UNUSED = '0x1111111111111111111111111111111111111111';
const PALLETS = '0x6d6f646c70792f70616464720000000000000000';
const REMARK = '0x0007946e61746976652063616c6c2066726f6d2061203078206163636f756e742c20746573742031';
// init code: mstore(0, Error selector); mstore(4, 0x20); mstore(0x24, 2); mstore(0x44, "no"); revert(0, 0x64)
const REVERT_NO = `0x7f${'08c379a0'.padEnd(64, '0')}600052602060045260026024527f${'6e6f'.padEnd(64, '0')}60445260646000fd`;
const DEPLOY_42 = '0x600a600c600039600a6000f3602a60005260206000f3';

const run = (args: unknown) => runTool(tool, args);
async function eth(method: string, params: unknown[]): Promise<{ result?: string; error?: { code: number; message: string; data?: string } }> {
  const res = await fetch(NETWORKS.testnet.evm as string, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  return (await res.json()) as { result?: string; error?: { code: number; message: string; data?: string } };
}
function numbers(text: string) {
  const get = (re: RegExp): bigint => {
    const m = re.exec(text);
    assert.ok(m, `missing ${re} in:\n${text}`);
    return BigInt(m[1]);
  };
  return {
    estimate: get(/gas estimate: +(\d+) gas/),
    price: get(/gas price now: (\d+) wei per gas/),
    cost: get(/expected cost: estimate x gas price = \S+ \S+ \((\d+) wei\)/),
    limit: get(/gas limit: +(\d+) \(estimate \+ 10 percent\)/),
    maxFee: get(/max fee per gas: (\d+) wei/),
    needed: get(/balance needed to be accepted: value \+ gas limit x max fee = \S+ \S+ \((\d+) wei\)/),
    balance: get(/balance now: +\S+ \S+ \((\d+) wei\)/),
  };
}
/** The limits recomputed from the printed estimate and price, and the verdict from the printed balance. */
function checkArithmetic(text: string, value: bigint): ReturnType<typeof numbers> {
  const n = numbers(text);
  assert.equal(n.cost, n.estimate * n.price, 'cost = estimate x gas price');
  assert.equal(n.limit, n.estimate + n.estimate / 10n, 'gas limit = estimate + 10 percent');
  assert.equal(n.maxFee, n.price + n.price / 8n, 'max fee = gas price + one eighth');
  assert.equal(n.needed, value + n.limit * n.maxFee, 'needed = value + limit x max fee');
  assert.match(text, n.balance >= n.needed ? /verdict: +ACCEPTED/ : /verdict: +REFUSED: expect the node to refuse this transaction with error 1010/);
  assert.match(text, /max priority fee per gas: 0/);
  return n;
}
const close = (a: bigint, b: bigint): boolean => (a > b ? a - b : b - a) * 1000n <= b; // within 0.1 percent

test('the Treasury 0x form through the pallets address: a native call, the estimate, and no key to sign', async () => {
  const r = await run({ from: TREASURY_H160, to: PALLETS, data: REMARK });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Read just now through the Ethereum RPC/);
  assert.match(r.text, /the pallets address: this runs a native call, System\.remarkWithEvent/);
  assert.match(r.text, /Its receipt will show gasUsed 0 and no logs/);
  assert.match(r.text, /is the 0x form of the native account 5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z/);
  assert.match(r.text, /No fields to copy: no key can sign for this sender/);
  assert.match(r.text, /gas includes the storage deposit/);
  const n = checkArithmetic(r.text, 0n);
  const raw = await eth('eth_estimateGas', [{ from: TREASURY_H160, to: PALLETS, data: REMARK }]);
  assert.ok(raw.result, JSON.stringify(raw));
  assert.ok(close(n.estimate, BigInt(raw.result)), `tool ${n.estimate}, eth_estimateGas ${BigInt(raw.result)}`);
});

test('an address with no balance: the verdict follows the balance, and the fields to copy are complete', async () => {
  const r = await run({ from: UNUSED, to: PALLETS, data: REMARK });
  assert.equal(r.isError, false, r.text);
  const n = checkArithmetic(r.text, 0n);
  const nonce = /nonce to use: +(\d+)/.exec(r.text)?.[1];
  assert.ok(nonce !== undefined);
  assert.match(r.text, new RegExp(`viem: +\\{ to: '0x6D6f646c70792F70616464720000000000000000', data: '${REMARK}', value: 0n, nonce: ${nonce}, gas: ${n.limit}n, maxFeePerGas: ${n.maxFee}n, maxPriorityFeePerGas: 0n, chainId: 420420777, type: 'eip1559' \\}`));
  assert.match(r.text, new RegExp(`gasLimit: ${n.limit}n, .*type: 2 \\}`));
  assert.match(r.text, new RegExp(`cast mktx 0x6D6f646c70792F70616464720000000000000000 ${REMARK} --rpc-url https://test-evm-rpc-v3\\.portaldot\\.dev --chain 420420777 --nonce ${nonce} --gas-limit ${n.limit} --gas-price ${n.maxFee} --priority-gas-price 0 --value 0 --account <keystore name>`));
  assert.match(r.text, /cast publish <the raw transaction that mktx printed>/);
  assert.doesNotMatch(r.text, /private key/i);
});

test('a value the sender cannot cover: the node message, code -32000', async () => {
  const r = await run({ from: UNUSED, to: TREASURY_H160, value: '1000000000000000000' });
  assert.equal(r.isError, false, r.text);
  const raw = await eth('eth_estimateGas', [{ from: UNUSED, to: TREASURY_H160, value: '0xde0b6b3a7640000' }]);
  if (raw.error) {
    assert.match(r.text, /The estimate failed: the balance does not cover the value/);
    assert.match(r.text, /insufficient funds for gas \* price \+ value/);
    assert.match(r.text, /\(code -32000\)/);
    assert.match(r.text, /verdict: +REFUSED/);
  } else {
    checkArithmetic(r.text, 10n ** 18n); // someone funded the address: the normal answer
  }
});

test('a contract found on the chain now: its code is named and the call is estimated or its revert explained', async () => {
  const conn = await getConn('testnet');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = conn.api as any;
  const page = await api.query.revive.accountInfoOf.entriesPaged({ args: [], pageSize: 40 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found = page.find(([, v]: [any, any]) => v.isSome && v.unwrap().accountType.isContract);
  assert.ok(found, 'a contract on the first page of revive.accountInfoOf');
  const address: string = found[0].args[0].toHex();
  const r = await run({ from: TREASURY_H160, to: address, data: '0x06fdde03' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /a contract: \d+ bytes of (EVM|PolkaVM) code/);
  assert.match(r.text, /function selector 0x06fdde03/);
  if (/The estimate failed: the transaction reverts/.test(r.text)) {
    assert.match(r.text, /simulate_contract_call/);
  } else {
    const n = checkArithmetic(r.text, 0n);
    const raw = await eth('eth_estimateGas', [{ from: TREASURY_H160, to: address, data: '0x06fdde03' }]);
    assert.ok(raw.result && close(n.estimate, BigInt(raw.result)), `tool ${n.estimate}, eth_estimateGas ${JSON.stringify(raw)}`);
  }
});

test('a deployment that reverts with a message: code 3, the data, and the decoded reason', async () => {
  const r = await run({ from: TREASURY_H160, data: REVERT_NO });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /none: this is a contract deployment/);
  assert.match(r.text, /The estimate failed: the transaction reverts/);
  assert.match(r.text, /\(code 3\)/);
  assert.match(r.text, /revert data: 0x08c379a0/);
  assert.match(r.text, /It reverted with the message "no"\./);
  assert.match(r.text, /simulate_contract_deploy/);
  const ok = await run({ from: UNUSED, data: DEPLOY_42 });
  assert.equal(ok.isError, false, ok.text);
  checkArithmetic(ok.text, 0n);
  assert.match(ok.text, /deployments by Ethereum transaction succeed on the testnet in other builders' transactions/);
  assert.match(ok.text, new RegExp(`cast mktx --rpc-url \\S+ --chain 420420777 .* --create ${DEPLOY_42}`));
  assert.doesNotMatch(ok.text, /viem: +\{ to:/, 'a deployment has no "to"');
});

test('warnings: a value that is not whole native units, and value sent to the pallets address', async () => {
  const dust = await run({ from: UNUSED, to: '0x2222222222222222222222222222222222222222', value: '12345' });
  assert.equal(dust.isError, false, dust.text);
  assert.match(dust.text, /12345 wei, is not a whole number of native units \(1 unit = 10000 wei\): it is 1 units and 2345 wei more/);
  const pv = await run({ from: UNUSED, to: PALLETS, data: REMARK, value: '10000' });
  assert.equal(pv.isError, false, pv.text);
  assert.match(pv.text, /a value sent together with a native call is refused/);
  assert.match(pv.text, /Invalid call: Call/);
});

test('the mainnet: read through the node\'s runtime API, in POT, with nowhere to send', async () => {
  const r = await run({ from: UNUSED, to: PALLETS, data: REMARK, network: 'mainnet' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Read just now through the node's runtime API \(ReviveApi/);
  assert.match(r.text, /no public Ethereum RPC/);
  assert.match(r.text, /There is nowhere to send this transaction on the Portaldot V3 mainnet today/);
  assert.match(r.text, /chainId: 780780777/);
  assert.doesNotMatch(r.text, /tPOT/);
  checkArithmetic(r.text, 0n);
  const revert = await run({ from: TREASURY_H160, data: REVERT_NO, network: 'mainnet' });
  assert.equal(revert.isError, false, revert.text);
  assert.match(revert.text, /It reverted with the message "no"\./);
});

test('bad input is refused with what to do', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ from: TREASURY_H160, to: '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z' }, /"to" must be a 0x address.*0x8DDEe436166f311ddeED36d714B08F512670d16e/],
    [{ from: TREASURY_H160, to: UNUSED, value: '1.5' }, /decimal point.*"1500000000000000000" wei.*convert_amount/],
    [{ from: TREASURY_H160, to: UNUSED, value: 1.5 }, /decimal point/],
    [{ from: TREASURY_H160, to: UNUSED, value: '1e18' }, /not a whole number of wei/],
    [{ from: TREASURY_H160, to: UNUSED, value: 9007199254740993 }, /2\^53 - 1/],
    [{ from: TREASURY_H160, to: UNUSED, value: '' }, /"value" is empty/],
    [{ from: TREASURY_H160, to: UNUSED, data: '0x123' }, /even number of hex characters/],
    [{ from: TREASURY_H160 }, /a deployment needs its init code in "data"/],
    [{ from: 'legal winner thank year wave sausage worth useful legal winner thank yellow', to: UNUSED }, /secret recovery phrase/],
    [{ from: '0x1234', to: UNUSED }, /neither a 0x address/],
  ];
  for (const [args, re] of cases) {
    const r = await run(args);
    assert.equal(r.isError, true, `expected an error for ${JSON.stringify(args)}: ${r.text}`);
    assert.match(r.text, re, `message for ${JSON.stringify(args)}: ${r.text}`);
    assert.doesNotMatch(r.text, /\n\s+at /);
  }
});

after(async () => {
  await closeAll();
});
