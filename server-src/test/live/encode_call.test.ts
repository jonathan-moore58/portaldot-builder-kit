// encode_call against the live chains. The call bytes are checked against vectors proven on the
// testnet and against encodings worked out by hand (SCALE: module index, call index, arguments).
// The fee is checked a second way with the runtime API TransactionPaymentCallApi_query_call_info.
// The dry runs from a sender repeat cases measured on Nov 15, 2026, with the Treasury as the sender
// that holds tPOT and a new random address as an empty one; a refusal is checked a second way with a
// raw eth_estimateGas. Nothing depends on a balance or a block number staying the same.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import tool from '../../src/tools/encode_call.ts';
import { runTool } from '../../src/lib/tool.ts';
import { closeAll, getConn } from '../../src/lib/chain.ts';
import { toSs58 } from '../../src/lib/address.ts';
import { NETWORKS, PALLETS_ADDRESS } from '../../src/lib/networks.ts';

const TREASURY = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const TREASURY_H160 = '0x8ddee436166f311ddeed36d714b08f512670d16e';
const UNUSED_H160 = '0x1111111111111111111111111111111111111111';
const REMARK_TEXT = 'native call from a 0x account, test 1';
const REMARK = '0x0007946e61746976652063616c6c2066726f6d2061203078206163636f756e742c20746573742031';
const TRANSFER = '0x0603006d6f646c70792f74727372790000000000000000000000000000000000000000070010a5d4e8';
const ONE = '100000000000000';
/** A new account nobody has used: no balance, no link to its 0x form. */
const fresh = (): string => toSs58(randomBytes(32));
const DRY_RUN = 'Dry run from this sender (the node ran the call just now; nothing was sent): ';
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const run = (args: unknown) => runTool(tool, args);
function bytesOf(text: string): string {
  const m = /Call bytes \((\d+) bytes\):\n(0x[0-9a-f]*)/.exec(text);
  assert.ok(m, `no call bytes in:\n${text}`);
  assert.equal(Number(m[1]), (m[2].length - 2) / 2, 'the stated length');
  return m[2];
}
async function eth(method: string, params: unknown[]): Promise<{ result?: string; error?: { code: number; message: string } }> {
  const res = await fetch(NETWORKS.testnet.evm as string, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  return (await res.json()) as { result?: string; error?: { code: number; message: string } };
}
/** The printed reply against a raw eth_estimateGas of the same bytes from the same 0x address. */
async function sameRefusal(text: string, fromH160: string): Promise<void> {
  const raw = await eth('eth_estimateGas', [{ from: fromH160, to: PALLETS_ADDRESS, data: bytesOf(text) }]);
  assert.ok(raw.error, `eth_estimateGas accepted it: ${JSON.stringify(raw)}`);
  assert.ok(text.includes(`  reply: ${JSON.stringify({ code: raw.error.code, message: raw.error.message })}. explain_error reads it.`), `the reply as it came, ${JSON.stringify(raw.error)}, in:\n${text}`);
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

test('dry run from a native sender: the chain accepts System.remark from the Treasury, run as the Treasury itself', async () => {
  const r = await run({ call: 'System.remark', args: ['0x00'], sender: TREASURY });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes(`${DRY_RUN}the chain accepts it.`), r.text);
  assert.match(r.text, /  reply: a gas figure of \d+, with no error\n/);
  assert.match(r.text, /  how: from 0x8DDEe436166f311ddeED36d714B08F512670d16e \(this account's 0x form\) to the pallets address, .* through (?:eth_estimateGas on the Ethereum RPC https:\/\/test-evm-rpc-v3\.portaldot\.dev|the node's runtime API \(ReviveApi eth_estimate_gas\), because the Ethereum RPC gave no usable answer .*?)\. The chain links that 0x form to this account, so the call ran as this account itself\./);
  assert.match(r.text, /Checked on Nov 15, 2026 with 143 such dry runs in 18 modules on the testnet/);
  assert.match(r.text, /no sent transaction has confirmed these answers/);
  if (/covers it: yes/.test(r.text)) assert.match(r.text, /\(This counts tPOT only\. Whether the sender holds the rest the call needs, such as another token or an NFT, is the dry run's answer below\.\)/);
  assert.doesNotMatch(r.text, /Note: .* runs a call inside/);
  const raw = await eth('eth_estimateGas', [{ from: TREASURY_H160, to: PALLETS_ADDRESS, data: '0x00000400' }]);
  assert.ok(raw.result, `a raw eth_estimateGas accepts it too: ${JSON.stringify(raw)}`);
});

test('dry run: more than the balance, from an empty native account, answers Token(FundsUnavailable)', async () => {
  const empty = fresh();
  const r = await run({ call: 'Balances.transferKeepAlive', args: [TREASURY, ONE], sender: empty });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /covers it: NO, short by/);
  assert.ok(r.text.includes(`${DRY_RUN}the chain refuses it: Token(FundsUnavailable).`), r.text);
  // a new account is not linked to its 0x form yet, so the dry run says whom it ran as
  assert.match(r.text, /No account is linked to that 0x form yet \(a native account is linked when it is created\), so the call ran as the 0x form's fallback account 5\w+, not as this account\. Ask again once this account exists\./);
  const h160 = /how: from (0x[0-9a-fA-F]{40}) \(this account's 0x form\)/.exec(r.text)?.[1];
  assert.ok(h160, r.text);
  await sameRefusal(r.text, h160.toLowerCase());
});

test('dry run: Assets.transfer of an asset the sender never held answers Assets.NoAccount, named from the metadata', async () => {
  // The measured case: asset 7777, of which the Treasury held none, 10000 units (its minimum balance). Another live asset the Treasury does not hold if that has changed.
  const api = (await getConn('testnet')).api as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const usable = async (id: string): Promise<string | null> => {
    const [asset, held] = await Promise.all([api.query.assets.asset(id), api.query.assets.account(id, TREASURY)]);
    return asset.isSome && asset.unwrap().status.isLive && held.isNone ? asset.unwrap().minBalance.toString() : null;
  };
  let id = '7777';
  let amount = await usable(id);
  if (amount === null) {
    const page = await api.query.assets.asset.entriesPaged({ args: [], pageSize: 20 });
    for (const [key] of page) {
      id = key.args[0].toString();
      if ((amount = await usable(id)) !== null) break;
    }
  }
  assert.ok(amount !== null, 'a live asset the Treasury does not hold');
  const r = await run({ call: 'Assets.transfer', args: [id, fresh(), amount === '0' ? '1' : amount], sender: TREASURY });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes(`${DRY_RUN}the chain refuses it: Assets.NoAccount (module 39, error 1): The account to alter does not exist.`), r.text);
  await sameRefusal(r.text, TREASURY_H160);
});

test('dry run: a call that only root may make answers BadOrigin', async () => {
  const r = await run({ call: 'Balances.forceSetBalance', args: [fresh(), ONE], sender: TREASURY });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes(`${DRY_RUN}the chain refuses it: BadOrigin.`), r.text);
  assert.ok(r.text.includes('  reply: {"code":-32000,"message":"Failed to dispatch call: BadOrigin"}. explain_error reads it.'), r.text);
});

test('dry run: Utility.batch with a failing call inside is accepted, with the note; batchAll of the same calls is refused', async () => {
  const calls = [{ call: 'System.remark', args: ['0x00'] }, { call: 'Balances.forceSetBalance', args: [fresh(), ONE] }];
  const r = await run({ call: 'Utility.batch', args: [calls], sender: TREASURY });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes(`${DRY_RUN}the chain accepts it.`), r.text);
  assert.ok(
    r.text.includes(
      '  Note: Utility.batch runs a call inside, and a dry run reports success for such a call even when the call inside fails (measured on Nov 15, 2026 for Utility.batch, Utility.forceBatch, Proxy.proxy, Sudo.sudo and Sudo.sudoAs). ' +
        'So dry-run the inner call by itself, from the account it runs as, or use Utility.batchAll, whose dry run fails when a call inside fails.',
    ),
    r.text,
  );
  const all = await run({ call: 'Utility.batchAll', args: [calls], sender: TREASURY });
  assert.equal(all.isError, false, all.text);
  assert.ok(all.text.includes(`${DRY_RUN}the chain refuses it: BadOrigin.`), all.text);
  assert.doesNotMatch(all.text, /runs a call inside/);
});

test('with a 0x sender on the testnet: route b with the gas rule; a native account\'s 0x form cannot use it', async () => {
  const r = await run({ call: 'System.remarkWithEvent', args: ['hi'], sender: UNUSED_H160 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /a 0x account\. Its balance is held by its fallback account 5/);
  assert.ok(r.text.includes(`${DRY_RUN}the chain accepts it.`), r.text);
  assert.match(r.text, new RegExp(`how: from ${esc('0x1111111111111111111111111111111111111111')} to the pallets address, .* No native account is linked to that address, so the call ran as its fallback account 5\\w+\\.`));
  assert.match(r.text, /Route b for this 0x account/);
  const m = /gas estimate: (\d+); gas price: (\d+) wei per gas\n\s+gas limit (\d+) \(estimate \+ 10 percent\), max fee per gas (\d+) wei/.exec(r.text);
  assert.ok(m, r.text);
  const [est, price, limit, maxFee] = m.slice(1).map(BigInt);
  assert.equal(limit, est + est / 10n);
  assert.equal(maxFee, price + price / 8n);
  assert.match(r.text, new RegExp(`to be taken by the node: gas limit x base fee = \\S+ tPOT \\(${limit * price} wei\\)`));
  const balance = BigInt(/balance now \(eth_getBalance[^)]*\): \S+ tPOT \((\d+) wei\)/.exec(r.text)?.[1] ?? '-1');
  assert.ok(balance >= 0n, r.text);
  assert.match(r.text, balance >= limit * price ? /verdict: TAKEN, and it should succeed/ : /verdict: REFUSED with error 1010/);
  assert.match(r.text, /Next: estimate_eth_transaction/);

  const own = await run({ call: 'System.remarkWithEvent', args: ['hi'], sender: TREASURY_H160 });
  assert.equal(own.isError, false, own.text);
  assert.match(own.text, /the 0x form of the native account 5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z/);
  assert.match(own.text, /cannot use route b/);
  assert.doesNotMatch(own.text, /Route b for this 0x account/);
  // its dry run runs as the native account, not as a fallback account
  assert.ok(own.text.includes(`${DRY_RUN}the chain accepts it.`), own.text);
  assert.match(own.text, /The chain links it to 5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z, so the call ran as that native account\./);
  // the ways to send say which address runs as what
  assert.match(own.text, /The call then runs as the key's fallback account \(the 20 bytes followed by twelve 0xEE bytes\), which pays the fee\. The 0x form of a native account has no key, so it cannot send this way; a dry run from it runs the call as that native account itself, once the account is linked to it/);
  assert.doesNotMatch(own.text, /runs as that account's fallback account/);
});

test('with a 0x sender on the mainnet: the fee, no Ethereum route, and a dry run through the node', async () => {
  const r = await run({ call: 'System.remarkWithEvent', args: ['hi'], sender: UNUSED_H160, network: 'mainnet' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /fee estimate: \S+ POT/);
  assert.match(r.text, /no public Ethereum RPC/);
  assert.ok(r.text.includes(`${DRY_RUN}the chain accepts it.`), r.text);
  assert.doesNotMatch(r.text, /tPOT/);
});

test('dry run on the mainnet from a native sender: through the node\'s runtime API, a root-only call answers BadOrigin', async () => {
  const r = await run({ call: 'Balances.forceSetBalance', args: [fresh(), ONE], sender: TREASURY, network: 'mainnet' });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes(`${DRY_RUN}the chain refuses it: BadOrigin.`), r.text);
  assert.ok(r.text.includes('  reply: "Failed to dispatch call: BadOrigin" (the runtime API\'s error message). explain_error reads it.'), r.text);
  assert.match(r.text, /through the node's runtime API \(ReviveApi eth_estimate_gas\), because the Portaldot V3 mainnet has no public Ethereum RPC\. The chain links that 0x form to this account, so the call ran as this account itself\./);
  assert.doesNotMatch(r.text, /tPOT/);
});

test('a batch too long to show in full says what the answer leaves out', { timeout: 180_000 }, async () => {
  const remarks = await run({ call: 'Utility.batchAll', args: [Array.from({ length: 600 }, () => ({ call: 'System.remark', args: ['x'] }))] });
  assert.equal(remarks.isError, false, remarks.text);
  assert.match(remarks.text, / \.\.\. \d+ more lines not shown, to keep this answer within its length limit \(the call bytes above hold them all\)\. To check every value, encode the batch in smaller parts\./);
  const transfers = await run({ call: 'Utility.batchAll', args: [Array.from({ length: 200 }, () => ({ call: 'Balances.transferKeepAlive', args: [TREASURY, ONE] }))] });
  assert.equal(transfers.isError, false, transfers.text);
  assert.match(transfers.text, /\(cut: \d+ bytes in all\./);
  assert.match(transfers.text, / \.\.\. \d+ more lines not shown, to keep this answer within its length limit\. To check every value, encode the batch in smaller parts\./);
});

after(async () => {
  await closeAll();
});
