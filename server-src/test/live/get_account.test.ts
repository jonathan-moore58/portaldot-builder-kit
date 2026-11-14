// get_account against the live chains. Every number the tool prints is checked a second way: raw
// JSON-RPC requests (state_getStorage with a hand-built key, state_call ReviveApi_balance, eth_getBalance)
// at the block the tool names. No assertion depends on a balance or a block number staying the same.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { blake2AsU8a, xxhashAsU8a } from '@polkadot/util-crypto';
import tool from '../../src/tools/get_account.ts';
import { runTool } from '../../src/lib/tool.ts';
import { closeAll, getConn } from '../../src/lib/chain.ts';
import { parseAddress } from '../../src/lib/address.ts';
import { NETWORKS, type NetworkKey } from '../../src/lib/networks.ts';

const TREASURY = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const TREASURY_H160 = '0x8ddee436166f311ddeed36d714b08f512670d16e';
const PALLETS = '0x6d6f646c70792f70616464720000000000000000';
const UNUSED = '0x1111111111111111111111111111111111111111';

const run = (args: unknown) => runTool(tool, args);
const httpOf = (key: NetworkKey): string => NETWORKS[key].ws.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

async function rpc(url: string, method: string, params: unknown[]): Promise<string | null> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  const body = (await res.json()) as { result?: string | null; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result ?? null;
}
const hex = (u: Uint8Array): string => `0x${Buffer.from(u).toString('hex')}`;
const le = (u: Uint8Array, from: number, to: number): bigint => {
  let v = 0n;
  for (let i = to - 1; i >= from; i--) v = (v << 8n) | BigInt(u[i]);
  return v;
};

/** Reads the numbers back out of the answer. */
function numbers(text: string) {
  const get = (re: RegExp): string => {
    const m = re.exec(text);
    assert.ok(m, `missing ${re} in:\n${text}`);
    return m[1];
  };
  return {
    block: Number(get(/read live at block (\d+) \(/)),
    hash: get(/read live at block \d+ \((0x[0-9a-f]{64})\)/),
    holder: get(/System\.account of (\S+), 14 decimals/),
    h160: get(/- 0x form \(Solidity, MetaMask, Ethereum RPC\): +(0x[0-9a-fA-F]{40})/).toLowerCase(),
    nonce: Number(get(/- nonce: (\d+)\./)),
    free: BigInt(get(/- free: +\S+ \S+ \((\d+) base units\)/)),
    reserved: BigInt(get(/- reserved: +\S+ \S+ \((\d+) base units\)/)),
    frozen: BigInt(get(/- frozen: +\S+ \S+ \((\d+) base units\)/)),
    nodeWei: BigInt(get(/node's own figure: \S+ \S+ \((\d+) wei\)/)),
  };
}

/** The same numbers a second way: raw RPC at the block the tool named. */
async function checkAgainstRawRpc(key: NetworkKey, text: string): Promise<void> {
  const n = numbers(text);
  const url = httpOf(key);
  const id = parseAddress(n.holder).accountId;
  const storageKey = hex(new Uint8Array([...xxhashAsU8a('System', 128), ...xxhashAsU8a('Account', 128), ...blake2AsU8a(id, 128), ...id]));
  const raw = await rpc(url, 'state_getStorage', [storageKey, n.hash]);
  const u = raw ? new Uint8Array(Buffer.from(raw.slice(2), 'hex')) : new Uint8Array(80);
  assert.equal(Number(le(u, 0, 4)), n.nonce, 'nonce');
  assert.equal(le(u, 16, 32), n.free, 'free');
  assert.equal(le(u, 32, 48), n.reserved, 'reserved');
  assert.equal(le(u, 48, 64), n.frozen, 'frozen');
  const bal = await rpc(url, 'state_call', ['ReviveApi_balance', n.h160, n.hash]);
  assert.ok(bal);
  assert.equal(le(new Uint8Array(Buffer.from(bal.slice(2), 'hex')), 0, 32), n.nodeWei, 'reviveApi.balance');
  assert.doesNotMatch(text, /It differs from \(free/, 'the measured rule holds');
  if (key === 'testnet' && /eth_getBalance at block \d+: the same/.test(text)) {
    const eth = await rpc(NETWORKS.testnet.evm as string, 'eth_getBalance', [n.h160, `0x${n.block.toString(16)}`]);
    assert.equal(BigInt(eth as string), n.nodeWei, 'eth_getBalance at the same block');
  }
}

test('the Treasury on the testnet, as SS58: a module account, linked, numbers match raw RPC', async () => {
  const r = await run({ address: TREASURY });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /a native account of a runtime module: its account id is the text "modlpy\/trsry"/);
  assert.match(r.text, /0x8DDEe436166f311ddeED36d714B08F512670d16e/);
  assert.match(r.text, /- linked: revive\.originalAccount/);
  assert.match(r.text, /One nonce serves both sides/);
  assert.match(r.text, /\(free - the 0\.1 tPOT existential deposit\) x 10000 \+ dust/);
  assert.match(r.text, /eth_getBalance at block \d+: the same/);
  assert.match(r.text, /eth_getTransactionCount of 0x8DDEe436166f311ddeED36d714B08F512670d16e: latest \d+, pending \d+/);
  assert.doesNotMatch(r.text, /flags/);
  const n = numbers(r.text);
  assert.equal(n.holder, TREASURY);
  // the rule, checked on the tool's own numbers: (free - ED) x 10000 (the Treasury has no dust)
  assert.equal(n.nodeWei, (n.free - 10_000_000_000_000n) * 10_000n + BigInt(/dust: (\d+) wei/.exec(r.text)?.[1] ?? 0));
  await checkAgainstRawRpc('testnet', r.text);
});

test('the same account as 0x and as a 64-hex account id gives the same holder', async () => {
  const a = await run({ address: TREASURY_H160 });
  assert.equal(a.isError, false, a.text);
  assert.match(a.text, /the 0x form of the native account 5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z/);
  assert.match(a.text, /cannot sign Ethereum transactions/);
  assert.equal(numbers(a.text).holder, TREASURY);
  const b = await run({ address: '0x6d6f646c70792f74727372790000000000000000000000000000000000000000' });
  assert.equal(b.isError, false, b.text);
  assert.equal(numbers(b.text).holder, TREASURY);
  // a 0x value of 64 hex characters could be a private key pasted by mistake: the same caution as convert_address
  assert.match(b.text, /Note: a 0x value of 64 hex characters is read here as a public account id\. If what you pasted is a private key, treat it as exposed/);
  assert.doesNotMatch(a.text, /64 hex characters is read here/);
  await checkAgainstRawRpc('testnet', a.text);
});

test('a mistyped checksum and another SS58 prefix are named', async () => {
  const bad = await run({ address: '0x8dDEe436166f311ddeED36d714B08F512670d16e' });
  assert.equal(bad.isError, false);
  assert.match(bad.text, /WARNING: The capital letters of this 0x address do not match its checksum/);
  const other = await run({ address: '13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB' });
  assert.equal(other.isError, false);
  assert.match(other.text, /SS58 prefix 0, another network's format/);
  assert.equal(numbers(other.text).holder, TREASURY);
});

test('an unused 0x address is a clear answer, not an error', async () => {
  const r = await run({ address: UNUSED });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /the chain cannot tell these apart/);
  assert.match(r.text, /<- its fallback account/);
  assert.match(r.text, /- exists: no\./);
  assert.match(r.text, /Nothing can be spent from the Ethereum side/);
  await checkAgainstRawRpc('testnet', r.text);
});

test('the pallets address is named as such', async () => {
  const r = await run({ address: PALLETS });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /the pallets address, the text "modlpy\/paddr"/);
  assert.match(r.text, /encode_call/);
});

test('a contract found on the chain now: code, deposits and the storage hold', async () => {
  const conn = await getConn('testnet');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = conn.api as any;
  const page = await api.query.revive.accountInfoOf.entriesPaged({ args: [], pageSize: 40 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found = page.find(([, v]: [any, any]) => v.isSome && v.unwrap().accountType.isContract);
  assert.ok(found, 'a contract on the first page of revive.accountInfoOf');
  const address: string = found[0].args[0].toHex();
  const r = await run({ address });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Contract 0x/);
  assert.match(r.text, /What it is: a contract: (EVM|PolkaVM) code, \d+ bytes/);
  assert.match(r.text, /code hash 0x[0-9a-f]{64}/);
  assert.match(r.text, /contracts that use this code: \d+/);
  assert.match(r.text, /its Revive\.StorageDepositReserve hold is exactly this/);
  assert.match(r.text, /code deposit: \S+ tPOT \(\d+ base units\), paid by 5/);
  const codeHash = /code hash (0x[0-9a-f]{64})/.exec(r.text)?.[1];
  const info = (await api.query.revive.codeInfoOf(codeHash)).toJSON();
  assert.match(r.text, new RegExp(`code deposit: \\S+ tPOT \\(${BigInt(info.deposit)} base units\\)`));
  assert.match(r.text, new RegExp(`${info.codeLen} bytes, code hash`));
  await checkAgainstRawRpc('testnet', r.text);
});

test('an account with a lock or freeze found on the chain now: the reason is listed and the rule holds', async () => {
  const conn = await getConn('testnet');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = conn.api as any;
  const page = await api.query.balances.locks.entriesPaged({ args: [], pageSize: 20 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found = page.find(([, v]: [any, any]) => v.length > 0);
  if (!found) return; // no lock on the chain any more: nothing to check
  const r = await run({ address: found[0].args[0].toString() });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /What holds the reserved and frozen amounts/);
  assert.match(r.text, /- locked as /);
  await checkAgainstRawRpc('testnet', r.text);
});

test('the mainnet: POT, the node figure, and no Ethereum RPC', async () => {
  const r = await run({ address: TREASURY, network: 'mainnet' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Portaldot V3 mainnet/);
  assert.match(r.text, / POT \(\d+ base units\)/);
  assert.doesNotMatch(r.text, /tPOT/);
  assert.match(r.text, /has no public Ethereum RPC/);
  await checkAgainstRawRpc('mainnet', r.text);
  const u = await run({ address: UNUSED, network: 'mainnet' });
  assert.equal(u.isError, false, u.text);
  assert.match(u.text, /- exists: no\./);
});

test('bad input is refused with a clear message and no stack trace', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ address: '' }, /Invalid input/],
    [{ address: 'hello' }, /not a valid address/],
    [{ address: '0x8ddee436166f311ddeed36d714b08f512670d16' }, /39 characters after 0x/],
    [{ address: 'legal winner thank year wave sausage worth useful legal winner thank yellow' }, /secret recovery phrase/],
    [{ address: 12345 }, /Invalid input/],
    [{ address: TREASURY, network: 'devnet' }, /Invalid input/],
  ];
  for (const [args, re] of cases) {
    const r = await run(args);
    assert.equal(r.isError, true, `expected an error for ${JSON.stringify(args)}`);
    assert.match(r.text, re);
    assert.doesNotMatch(r.text, /\n\s+at /);
  }
});

after(async () => {
  await closeAll();
});
