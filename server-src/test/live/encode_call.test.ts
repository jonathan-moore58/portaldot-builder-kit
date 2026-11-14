// encode_call against the live chains. The call bytes are checked against vectors proven on the
// testnet and against encodings worked out by hand (SCALE: module index, call index, arguments).
// The fee is checked a second way with the runtime API TransactionPaymentCallApi_query_call_info.
// Nothing depends on a balance or a block number staying the same.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import tool from '../../src/tools/encode_call.ts';
import { runTool } from '../../src/lib/tool.ts';
import { closeAll } from '../../src/lib/chain.ts';
import { NETWORKS } from '../../src/lib/networks.ts';

const TREASURY = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const TREASURY_H160 = '0x8ddee436166f311ddeed36d714b08f512670d16e';
const UNUSED_H160 = '0x1111111111111111111111111111111111111111';
const REMARK_TEXT = 'native call from a 0x account, test 1';
const REMARK = '0x0007946e61746976652063616c6c2066726f6d2061203078206163636f756e742c20746573742031';
const TRANSFER = '0x0603006d6f646c70792f74727372790000000000000000000000000000000000000000070010a5d4e8';

const run = (args: unknown) => runTool(tool, args);
function bytesOf(text: string): string {
  const m = /Call bytes \((\d+) bytes\):\n(0x[0-9a-f]*)/.exec(text);
  assert.ok(m, `no call bytes in:\n${text}`);
  assert.equal(Number(m[1]), (m[2].length - 2) / 2, 'the stated length');
  return m[2];
}

test('the two proven vectors, on both networks', async () => {
  for (const network of ['testnet', 'mainnet'] as const) {
    const r = await run({ call: 'System.remarkWithEvent', args: [REMARK_TEXT], network });
    assert.equal(r.isError, false, r.text);
    assert.equal(bytesOf(r.text), REMARK);
    assert.match(r.text, /module 0, call 7, so the bytes start 0x0007/);
    assert.match(r.text, new RegExp(`remark: "${REMARK_TEXT}"`));
    const t = await run({ call: 'Balances.transferKeepAlive', args: [TREASURY, '1000000000000'], network });
    assert.equal(t.isError, false, t.text);
    assert.equal(bytesOf(t.text), TRANSFER);
    assert.match(t.text, /dest: 5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z \(a native account\)/);
    assert.match(t.text, new RegExp(`value: 1000000000000 base units = 0\\.01 ${NETWORKS[network].token}\\b`));
    assert.match(t.text, /Checked just now: tx\.method\.toHex\(\) gives back exactly these bytes/);
    assert.match(t.text, /0x6d6f646c70792f70616464720000000000000000/);
    if (network === 'mainnet') assert.match(t.text, /no public Ethereum RPC/);
  }
});

test('arguments by name, in any spelling of the call', async () => {
  const r = await run({ call: 'balances::transfer_keep_alive', args: { dest: TREASURY, value: '1000000000000' } });
  assert.equal(r.isError, false, r.text);
  assert.equal(bytesOf(r.text), TRANSFER);
});

test('a batchAll of two inner calls: as objects and as bytes give the same bytes, worked out by hand', async () => {
  const objects = await run({ call: 'Utility.batchAll', args: [[{ call: 'System.remarkWithEvent', args: ['a'] }, { call: 'Balances.transferKeepAlive', args: [TREASURY, '1000000000000'] }]] });
  assert.equal(objects.isError, false, objects.text);
  const asBytes = await run({ call: 'Utility.batchAll', args: [['0x00070461', TRANSFER]] });
  assert.equal(asBytes.isError, false, asBytes.text);
  // Utility is module 1, batchAll call 2; compact(2) = 0x08; remarkWithEvent("a") = 0x0007 04 61
  const byHand = `0x010208${'00070461'}${TRANSFER.slice(2)}`;
  assert.equal(bytesOf(objects.text), byHand);
  assert.equal(bytesOf(asBytes.text), byHand);
  assert.match(objects.text, /calls: 2 calls/);
  assert.match(objects.text, /1\. System\.remarkWithEvent, 4 bytes: 0x00070461/);
  assert.match(objects.text, /2\. Balances\.transferKeepAlive, 41 bytes/);
});

test('Revive.call with a weight structure, worked out by hand', async () => {
  const r = await run({ call: 'Revive.call', args: ['0x019030bff84bbf433c0668196acd288cd763e4a2', '0', { refTime: '1000000000', proofSize: '100000' }, '1000000000000000', '0x06fdde03'] });
  assert.equal(r.isError, false, r.text);
  // 0x5001, dest (20 bytes), compact(0) 00, compact(1e9) 02286bee, compact(100000) 821a0600, compact(1e15) 0f0080c6a47e8d03, bytes(4) 10 06fdde03
  assert.equal(bytesOf(r.text), '0x5001019030bff84bbf433c0668196acd288cd763e4a20002286bee821a06000f0080c6a47e8d031006fdde03');
  assert.match(r.text, /storageDepositLimit: 1000000000000000 base units = 10 tPOT/);
  const missing = await run({ call: 'Revive.call', args: ['0x019030bff84bbf433c0668196acd288cd763e4a2', '0', { refTime: '1000000000' }, '1000000000000000', '0x06fdde03'] });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /Missing: proofSize/);
});

test('a call that needs root carries the chain\'s own note', async () => {
  const r = await run({ call: 'Sudo.sudo', args: [{ call: 'System.remarkWithEvent', args: ['x'] }] });
  assert.equal(r.isError, false, r.text);
  assert.equal(bytesOf(r.text), '0x160000070478');
  assert.match(r.text, /Root origin/);
});

test('mistakes are refused with the expected arguments', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ call: 'Balances.transferKeepAlive', args: [TREASURY] }, /takes 2 arguments, but 1 was given[\s\S]*1\. dest: MultiAddress[\s\S]*2\. value: Compact<u128>/],
    [{ call: 'Balances.transferKeepAlive', args: [TREASURY, 150000000000000000] }, /larger than 9007199254740991.*as a string of digits/],
    [{ call: 'Balances.transferKeepAlive', args: [TREASURY, '1.5'] }, /has a decimal point.*If you mean 1\.5 tPOT, that is "150000000000000".*convert_amount/],
    [{ call: 'Balances.transferKeepAlive', args: [TREASURY, 1.5] }, /decimal point.*convert_amount/],
    [{ call: 'Balances.transferKeepAlive', args: [TREASURY, ''] }, /is empty/],
    [{ call: 'Balances.transferKeepAlive', args: [TREASURY, '1e18'] }, /not a whole number/],
    [{ call: 'Balances.transferKeepAlive', args: [TREASURY_H160, '1'] }, /is a 0x address.*5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z/],
    [{ call: 'Balances.transferKeepAlive', args: { dest: TREASURY, amount: '1' } }, /no argument named "amount"\. Missing: value/],
    [{ call: 'Balances.transfer', args: [] }, /has no call named "Balances\.transfer"[\s\S]*Closest names: .*Balances\.transferKeepAlive/],
    [{ call: 'Utility.batchAll', args: [['0x0007046100']] }, /not exactly one call/],
    [{ call: 'Utility.batchAll', args: [['0xff00']] }, /are not a call of the Portaldot V3 testnet/],
    [{ call: 'Staking.chill', args: ['x'] }, /takes 0 arguments, but 1 was given/],
    [{ call: 'System.remarkWithEvent', args: ['legal winner thank year wave sausage worth useful legal winner thank yellow'] }, /secret recovery phrase/],
    [{ call: 'System.remarkWithEvent', args: ['hi'], sender: '0xZZ' }, /is not hex: the character "Z"/],
  ];
  for (const [args, re] of cases) {
    const r = await run(args);
    assert.equal(r.isError, true, `expected an error for ${JSON.stringify(args)}: ${r.text}`);
    assert.match(r.text, re, `message for ${JSON.stringify(args)}: ${r.text}`);
    assert.doesNotMatch(r.text, /\n\s+at /);
  }
});

test('with a native sender: the fee, checked against query_call_info, and the balance check', async () => {
  const r = await run({ call: 'Balances.transferKeepAlive', args: [TREASURY, '1000000000000'], sender: TREASURY });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Sender: 5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z, a native account/);
  const fee = BigInt(/fee estimate: \S+ tPOT \((\d+) base units\)/.exec(r.text)?.[1] ?? '0');
  const free = BigInt(/free balance: \S+ tPOT \((\d+) base units\)/.exec(r.text)?.[1] ?? '0');
  const needed = BigInt(/existential deposit = \S+ tPOT \((\d+) base units\)/.exec(r.text)?.[1] ?? '0');
  assert.equal(needed, fee + 1000000000000n + 10000000000000n, 'needed = fee + amount + existential deposit');
  assert.match(r.text, free >= needed ? /covers it: yes/ : /covers it: NO/);
  // second way: the runtime's own fee for the call alone, at a signed length of 147 or 148 bytes; it leaves out
  // the small weight of the transaction extensions, so the two agree to a fraction of a percent
  const res = await fetch(NETWORKS.testnet.ws.replace('wss:', 'https:'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'state_call', params: ['TransactionPaymentCallApi_query_call_info', `${TRANSFER}${Buffer.from(new Uint32Array([148]).buffer).toString('hex')}`] }),
  });
  const raw = Buffer.from(((await res.json()) as { result: string }).result.slice(2), 'hex');
  let callFee = 0n;
  for (let i = raw.length - 1; i >= raw.length - 16; i--) callFee = (callFee << 8n) | BigInt(raw[i]);
  const diff = fee > callFee ? fee - callFee : callFee - fee;
  assert.ok(diff * 1000n < fee, `paymentInfo ${fee} and query_call_info ${callFee} agree within 0.1 percent`);
});

test('with a 0x sender on the testnet: route b with the gas rule; a native account\'s 0x form cannot use it', async () => {
  const r = await run({ call: 'System.remarkWithEvent', args: ['hi'], sender: UNUSED_H160 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /a 0x account\. Its balance is held by its fallback account 5/);
  assert.match(r.text, /Route b for this 0x account/);
  const m = /gas estimate: (\d+); gas price: (\d+) wei per gas\n\s+gas limit (\d+) \(estimate \+ 10 percent\), max fee per gas (\d+) wei/.exec(r.text);
  assert.ok(m, r.text);
  const [est, price, limit, maxFee] = m.slice(1).map(BigInt);
  assert.equal(limit, est + est / 10n);
  assert.equal(maxFee, price + price / 8n);
  assert.match(r.text, new RegExp(`gas limit x max fee = \\S+ tPOT \\(${limit * maxFee} wei\\)`));
  const balance = BigInt(/balance now \(eth_getBalance[^)]*\): \S+ tPOT \((\d+) wei\)/.exec(r.text)?.[1] ?? '-1');
  assert.ok(balance >= 0n, r.text);
  assert.match(r.text, balance >= limit * maxFee ? /enough to be accepted: yes/ : /enough to be accepted: NO, short by \S+ tPOT \(\d+ wei\)/);
  assert.match(r.text, /Next: estimate_eth_transaction/);

  const own = await run({ call: 'System.remarkWithEvent', args: ['hi'], sender: TREASURY_H160 });
  assert.equal(own.isError, false, own.text);
  assert.match(own.text, /the 0x form of the native account 5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z/);
  assert.match(own.text, /cannot use route b/);
  assert.doesNotMatch(own.text, /Route b for this 0x account/);
});

test('with a 0x sender on the mainnet: the fee, and no Ethereum route', async () => {
  const r = await run({ call: 'System.remarkWithEvent', args: ['hi'], sender: UNUSED_H160, network: 'mainnet' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /fee estimate: \S+ POT/);
  assert.match(r.text, /no public Ethereum RPC/);
  assert.doesNotMatch(r.text, /tPOT/);
});

after(async () => {
  await closeAll();
});
