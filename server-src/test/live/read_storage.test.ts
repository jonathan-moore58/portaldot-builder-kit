// read_storage against the live chains. Values are checked a second way: the raw bytes under the
// storage key the tool prints, read with state_getStorage at the block the tool names, and decoded by
// hand; listings are checked against state_getKeysPaged. Nothing depends on a balance or a block number.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAddress } from '@polkadot/util-crypto';
import tool from '../../src/tools/read_storage.ts';
import { runTool } from '../../src/lib/tool.ts';
import { closeAll } from '../../src/lib/chain.ts';
import { NETWORKS, type NetworkKey } from '../../src/lib/networks.ts';

const TREASURY = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const TREASURY_H160 = '0x8ddee436166f311ddeed36d714b08f512670d16e';

const run = (args: unknown) => runTool(tool, args);
const httpOf = (key: NetworkKey): string => NETWORKS[key].ws.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
async function rpc<T = string | null>(key: NetworkKey, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(httpOf(key), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}
const bytes = (h: string): Uint8Array => new Uint8Array(Buffer.from(h.slice(2), 'hex'));
const le = (u: Uint8Array, from: number, to: number): bigint => {
  let v = 0n;
  for (let i = to - 1; i >= from; i--) v = (v << 8n) | BigInt(u[i]);
  return v;
};
function blockOf(text: string): { number: number; hash: string } {
  const m = /Read at block (\d+) \((0x[0-9a-f]{64})\)/.exec(text);
  assert.ok(m, `no block in:\n${text}`);
  return { number: Number(m[1]), hash: m[2] };
}
const storageKey = (text: string): string => {
  const m = /Storage key: (0x[0-9a-f]+)/.exec(text);
  assert.ok(m, `no storage key in:\n${text}`);
  return m[1];
};
/** The raw bytes under the key the tool printed, at the block it named. */
async function rawOf(key: NetworkKey, text: string): Promise<Uint8Array | null> {
  const raw = await rpc(key, 'state_getStorage', [storageKey(text), blockOf(text).hash]);
  return raw ? bytes(raw) : null;
}
const nextKey = (text: string): string | undefined => /"start_key": "(0x[0-9a-f]+)"/.exec(text)?.[1];
const listedKeys = (text: string): unknown[][] => [...text.matchAll(/^\d+\. keys (\[.*?\]) -> /gm)].map((m) => JSON.parse(m[1]));

test('System.account of the Treasury on both networks: free and nonce match the raw bytes', async () => {
  for (const network of ['testnet', 'mainnet'] as const) {
    const r = await run({ item: 'System.account', keys: [TREASURY], network });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, new RegExp(`Portaldot V3 ${network}`));
    assert.match(r.text, /the newest block when asked/);
    assert.match(r.text, /Amounts are whole numbers in the smallest unit/);
    const raw = await rawOf(network, r.text);
    assert.ok(raw);
    assert.match(r.text, new RegExp(`"free": "?${le(raw, 16, 32)}"?`));
    assert.match(r.text, new RegExp(`"nonce": ${le(raw, 0, 4)}`));
  }
});

test('a plain value: Balances.totalIssuance', async () => {
  const r = await run({ item: 'Balances.totalIssuance' });
  assert.equal(r.isError, false, r.text);
  const raw = await rawOf('testnet', r.text);
  assert.ok(raw);
  assert.match(r.text, new RegExp(`"${le(raw, 0, 16)}"`));
  const k = await run({ item: 'Balances.totalIssuance', keys: [1] });
  assert.equal(k.isError, true);
  assert.match(k.text, /single value, so it takes no keys/);
});

test('Assets.asset listing, its second page, and one entry read by the key the listing gave', async () => {
  const p1 = await run({ item: 'Assets.asset', limit: 3 });
  assert.equal(p1.isError, false, p1.text);
  assert.match(p1.text, /A listing of the map's entries: 1 key in all \(u32\)/);
  const keys1 = listedKeys(p1.text);
  assert.equal(keys1.length, 3);
  const start = nextKey(p1.text);
  assert.ok(start, 'a start_key for the next page');
  const { number, hash } = blockOf(p1.text);
  const prefix = start.slice(0, 66);
  const rawKeys = await rpc<string[]>('testnet', 'state_getKeysPaged', [prefix, 3, prefix, hash]);
  assert.equal(rawKeys[2], start, 'the last key is the third raw key');
  // the decoded keys are the u32 at the end of each raw key
  keys1.forEach((k, i) => assert.ok(rawKeys[i].endsWith(Buffer.from(new Uint32Array([k[0] as number]).buffer).toString('hex'))));

  const p2 = await run({ item: 'Assets.asset', limit: 3, start_key: start, at_block: number });
  assert.equal(p2.isError, false, p2.text);
  assert.match(p2.text, /This page starts after/);
  const rawKeys2 = await rpc<string[]>('testnet', 'state_getKeysPaged', [prefix, 3, start, hash]);
  assert.equal(nextKey(p2.text) ?? rawKeys2[rawKeys2.length - 1], rawKeys2[rawKeys2.length - 1]);
  assert.notDeepEqual(listedKeys(p2.text)[0], keys1[0]);

  const one = await run({ item: 'Assets.asset', keys: [keys1[0][0]] });
  assert.equal(one.isError, false, one.text);
  const raw = await rawOf('testnet', one.text);
  assert.ok(raw);
  assert.match(one.text, new RegExp(`"owner": "${encodeAddress(raw.subarray(0, 32), 42)}"`));
  assert.equal(storageKey(one.text), rawKeys[0]);
});

test('Assets.account with one key lists the holders of that asset', async () => {
  const list = await run({ item: 'Assets.asset', limit: 20 });
  const m = /keys \[(\d+)\] -> \{[^\n]*"accounts":([1-9]\d*)/.exec(list.text);
  if (!m) return; // no asset with holders on the first page: nothing to check
  const r = await run({ item: 'Assets.account', keys: [Number(m[1])], limit: 2 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /under the first 1 key: 2 keys in all \(u32, AccountId32\)/);
  const keys = listedKeys(r.text);
  assert.ok(keys.length >= 1);
  for (const k of keys) {
    assert.equal(k[0], Number(m[1]));
    assert.match(String(k[1]), /^5/);
  }
});

test('Revive.originalAccount of the Treasury 0x form names the Treasury; a 5... key is refused with its 0x form', async () => {
  const r = await run({ item: 'Revive.originalAccount', keys: [TREASURY_H160] });
  assert.equal(r.isError, false, r.text);
  const raw = await rawOf('testnet', r.text);
  assert.ok(raw);
  assert.equal(encodeAddress(raw, 42), TREASURY);
  assert.match(r.text, new RegExp(`"${TREASURY}"`));
  const bad = await run({ item: 'Revive.originalAccount', keys: [TREASURY] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /The 0x form of 5EYC\S+ is 0x8DDEe436166f311ddeED36d714B08F512670d16e/);
});

test('Timestamp.now at block 1000 and at the newest block', async () => {
  const old = await run({ item: 'Timestamp.now', at_block: 1000 });
  assert.equal(old.isError, false, old.text);
  const b = blockOf(old.text);
  assert.equal(b.number, 1000);
  assert.equal(b.hash, await rpc('testnet', 'chain_getBlockHash', [1000]));
  const raw = await rawOf('testnet', old.text);
  assert.ok(raw);
  assert.match(old.text, new RegExp(`\\n${le(raw, 0, 8)}\\n`));
  const spec = (await rpc<{ specVersion: number }>('testnet', 'state_getRuntimeVersion', [b.hash])).specVersion;
  const now = (await rpc<{ specVersion: number }>('testnet', 'state_getRuntimeVersion', [])).specVersion;
  if (spec !== now) assert.match(old.text, new RegExp(`which ran runtime ${spec}`));
  const byHash = await run({ item: 'Timestamp.now', at_block: b.hash });
  assert.equal(byHash.isError, false, byHash.text);
  assert.equal(blockOf(byHash.text).number, 1000);

  const latest = await run({ item: 'Timestamp.now' });
  assert.equal(latest.isError, false, latest.text);
  assert.ok(blockOf(latest.text).number > 1000);
  assert.match(latest.text, /the newest block when asked/);
});

test('a constant: Balances.existentialDeposit, 0.1 tPOT', async () => {
  const r = await run({ item: 'Balances.existentialDeposit' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /is a constant of the Balances module/);
  assert.match(r.text, /10000000000000/);
  assert.match(r.text, /api\.consts\.balances\.existentialDeposit/);
  const k = await run({ item: 'Balances.existentialDeposit', keys: [1] });
  assert.equal(k.isError, true);
  assert.match(k.text, /is a constant, so it takes no keys/);
});

test('System.events names each event', async () => {
  const r = await run({ item: 'System.events' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /"event": "[A-Z]\w*\.[A-Z]\w*"/);
  assert.ok(r.text.length < 24_000);
});

test('wrong names, wrong keys and too many keys are refused with what to do', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ item: 'Balances.acount' }, /Stored values of Balances: .*account/],
    [{ item: 'Balances.transferKeepAlive' }, /is a call .* not a stored value/],
    [{ item: 'account' }, /names 6 stored values/],
    [{ item: 'System.account', keys: [12345] }, /do not fit System\.account, whose key types are, in order: AccountId32/],
    [{ item: 'System.account', keys: [TREASURY_H160] }, /is a 0x address/],
    [{ item: 'System.account', keys: [TREASURY, 1] }, /takes 1 key \(AccountId32\), but 2 were given/],
    [{ item: 'System.account', keys: [''] }, /is empty/],
    [{ item: 'Assets.asset', keys: [''] }, /is empty/],
    [{ item: 'Assets.asset', keys: [{ a: 1 }] }, /is a whole number/],
    [{ item: 'Assets.asset', keys: [[1]] }, /is a whole number/],
    [{ item: 'Assets.asset', keys: [1.5] }, /not a whole number/],
    [{ item: 'Assets.asset', keys: [9007199254740993] }, /2\^53 - 1/],
    [{ item: 'Assets.asset', start_key: '0x1234' }, /start_key must be the storage key/],
    [{ item: 'Timestamp.now', at_block: 999999999 }, /does not exist yet/],
    [{ item: 'Timestamp.now', at_block: '0x1234' }, /at_block must be a block number/],
    [{ item: 'System.account', keys: ['legal winner thank year wave sausage worth useful legal winner thank yellow'] }, /secret recovery phrase/],
  ];
  for (const [args, re] of cases) {
    const r = await run(args);
    assert.equal(r.isError, true, `expected an error for ${JSON.stringify(args)}: ${r.text}`);
    assert.match(r.text, re, `message for ${JSON.stringify(args)}: ${r.text}`);
    assert.doesNotMatch(r.text, /\n\s+at /);
  }
});

test('the mainnet: Revive.chainId and an empty Assets listing read cleanly', async () => {
  const c = await run({ item: 'Revive.chainId', network: 'mainnet' });
  assert.equal(c.isError, false, c.text);
  assert.match(c.text, /780780777/);
  const a = await run({ item: 'Assets.asset', network: 'mainnet', limit: 2 });
  assert.equal(a.isError, false, a.text);
  assert.match(a.text, /Portaldot V3 mainnet/);
  assert.match(a.text, / POT has 14 decimals/);
});

after(async () => {
  await closeAll();
});
