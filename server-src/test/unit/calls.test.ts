// The pure helpers of src/lib/calls.ts. No network: if one of them opened a connection, the run would not end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiReason, checkPlainInput, checkWhole, depositScale, ethLimits, expectedArgs, explicitAccount, isNativeAmount, isPalletsAddress, PALLETS_ROUTE_BASIS, refuseLongAccountText, RUNTIME_PATH_BASIS, specialOriginNote } from '../../src/lib/calls.ts';
import { ToolError } from '../../src/lib/errors.ts';
import type { ArgInfo, ItemInfo } from '../../src/lib/meta.ts';
import { NETWORKS } from '../../src/lib/networks.ts';

const testnet = NETWORKS.testnet;

function item(name: string, args: ArgInfo[], docs: string[] = []): ItemInfo {
  return { kind: 'call', module: 'Balances', section: 'balances', name, index: 3, args, docs, summary: docs[0] ?? '' };
}
const amountArg: ArgInfo = { name: 'value', type: 'Compact<u128>', typeName: 'Balance', meaning: 'an amount in the smallest unit: 1 tPOT is 1 followed by 14 zeros (10n ** 14n in code)' };
const destArg: ArgInfo = { name: 'dest', type: 'MultiAddress', typeName: 'AccountIdLookupOf', meaning: 'an account address in SS58 form (it starts with 5), not a 0x address' };

test('ethLimits: gas limit + 10 percent, max fee + one eighth, needed = value + limit x max fee', () => {
  // the numbers of a real estimate on Nov 14, 2026, worked out by hand
  const r = ethLimits(828791356110n, 15690n, 0n);
  assert.equal(r.gasLimit, 911670491721n);
  assert.equal(r.maxFee, 17651n);
  assert.equal(r.needed, 16091895849367371n);
  const withValue = ethLimits(1000n, 8n, 5n);
  assert.deepEqual(withValue, { gasLimit: 1100n, maxFee: 9n, needed: 5n + 1100n * 9n });
  // integer division rounds down, the way the rule is applied
  assert.deepEqual(ethLimits(9n, 7n, 0n), { gasLimit: 9n, maxFee: 7n, needed: 63n });
});

test('the pallets address is recognised in any case', () => {
  assert.equal(isPalletsAddress('0x6d6f646c70792f70616464720000000000000000'), true);
  assert.equal(isPalletsAddress('0x6D6F646C70792F70616464720000000000000000'), true);
  assert.equal(isPalletsAddress('0x8ddee436166f311ddeed36d714b08f512670d16e'), false);
});

test('isNativeAmount reads the meaning of an argument', () => {
  assert.equal(isNativeAmount(amountArg), true);
  assert.equal(isNativeAmount(destArg), false);
  assert.equal(isNativeAmount(undefined), false);
});

test('checkPlainInput refuses fractions, unsafe integers and secret phrases anywhere, and accepts the rest', () => {
  const refuse = (v: unknown, re: RegExp): void => {
    assert.throws(() => checkPlainInput(v, 'args', testnet), (e: unknown) => e instanceof ToolError && re.test(e.message), `for ${JSON.stringify(v)}`);
  };
  refuse([1.5], /args\[0\] is 1\.5, a number with a decimal point.*convert_amount/);
  refuse([{ x: [9007199254740993] }], /args\[0\]\.x\[0\] is 9007199254740992, larger than 9007199254740991/);
  refuse(['legal winner thank year wave sausage worth useful legal winner thank yellow'], /secret recovery phrase/);
  refuse([Infinity], /not a number a call can carry/);
  let deep: unknown = 1;
  for (let i = 0; i < 20; i++) deep = [deep];
  refuse(deep, /nested too deeply.*encode_call/);
  assert.doesNotThrow(() => checkPlainInput(['5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z', '150000000000000000', 9007199254740991, { refTime: 1, proofSize: 2 }, null, true], 'args', testnet));
  // eleven words are not a secret phrase; a normal sentence is not one either
  assert.doesNotThrow(() => checkPlainInput(['native call from a 0x account, test 1'], 'args', testnet));
});

test('expectedArgs lists name, type and meaning in order', () => {
  const lines = expectedArgs(item('transferKeepAlive', [destArg, amountArg]));
  assert.equal(lines[0], 'Balances.transferKeepAlive takes 2 arguments, in this order:');
  assert.match(lines[1], /^ {2}1\. dest: MultiAddress \(AccountIdLookupOf\) - an account address in SS58 form/);
  assert.match(lines[2], /^ {2}2\. value: Compact<u128> \(Balance\) - an amount in the smallest unit/);
  assert.deepEqual(expectedArgs(item('chill', [])), ['Balances.chill takes no arguments.']);
});

test('specialOriginNote finds the sentence that asks for root, and nothing in ordinary docs', () => {
  assert.match(specialOriginNote(item('forceTransfer', [], ['Exactly as `transfer_allow_death`, except the origin must be root and the source account may be specified.'])) ?? '', /origin must be root/);
  assert.match(specialOriginNote(item('sudo', [], ['Authenticates the sudo key and dispatches a function call with `Root` origin.'])) ?? '', /Root origin/);
  assert.equal(specialOriginNote(item('transferKeepAlive', [], ['Same as the `transfer_allow_death` call, but with a check that the transfer will not kill the origin account.'])), null);
});

test('apiReason keeps the useful end of a @polkadot/api message', () => {
  assert.equal(apiReason(new Error('createType(Lookup42):: Compact<u128>:: Invalid character')), 'Invalid character');
  assert.equal(apiReason('plain text'), 'plain text');
  assert.ok(apiReason(new Error(`a:: ${'x'.repeat(500)}`)).length <= 220);
});

test('the stated bases are dated and say what was not tested', () => {
  assert.match(PALLETS_ROUTE_BASIS, /Nov 13, 2026/);
  assert.match(PALLETS_ROUTE_BASIS, /were not tested/);
  assert.match(PALLETS_ROUTE_BASIS, /452626 and 452633/);
  assert.match(RUNTIME_PATH_BASIS, /Nov 14, 2026/);
  assert.match(depositScale('tPOT'), /3\.8415 tPOT/);
  assert.match(depositScale('tPOT'), /0\.078 x L \+ 13\.11 tPOT/);
  for (const text of [PALLETS_ROUTE_BASIS, RUNTIME_PATH_BASIS, depositScale('POT')]) assert.doesNotMatch(text, /[\u2018\u2019\u201c\u201d\u2013\u2014\u2026]/, 'plain ASCII punctuation');
});

test('checkWhole refuses a number longer than any whole number can be, fast, without repeating it', () => {
  const tooLong = (v: string, re: RegExp): void => {
    const t = performance.now();
    assert.throws(() => checkWhole(v, amountArg, 'value', testnet), (e: unknown) => e instanceof ToolError && re.test(e.message) && e.message.length < 400, v.slice(0, 20));
    assert.ok(performance.now() - t < 200);
  };
  tooLong('1'.repeat(81), /value has 81 characters, more than any whole number of Compact<u128> can have/);
  tooLong(`0x${'f'.repeat(65)}`, /value has 67 characters/);
  tooLong(`0x${'f'.repeat(1_000_000)}`, /value has 1000002 characters/);
  assert.equal(checkWhole('1'.repeat(80), amountArg, 'value', testnet), '1'.repeat(80));
  assert.equal(checkWhole(`0x${'f'.repeat(64)}`, amountArg, 'value', testnet), 2n ** 256n - 1n);
  // other wrong values are quoted cut to about 100 characters
  assert.throws(() => checkWhole(`${'1'.repeat(500)}.5`, amountArg, 'value', testnet), (e: unknown) => e instanceof ToolError && e.message.length < 600 && /which has a decimal point/.test(e.message));
  assert.throws(() => checkWhole('x'.repeat(5000), amountArg, 'value', testnet), (e: unknown) => e instanceof ToolError && e.message.length < 400 && /not a whole number/.test(e.message));
});

test('explicitAccount: the string inside {"Id"}, {"Address32"} and {"Address20"} goes through parseAddress', () => {
  const T = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
  const T_ID = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000';
  const T_H160 = '0x8ddee436166f311ddeed36d714b08f512670d16e';
  assert.deepEqual(explicitAccount({ Id: ` ${T} ` }, 'dest'), { value: { Id: T } });
  assert.deepEqual(explicitAccount({ id: T }, 'dest'), { value: { id: T } });
  assert.deepEqual(explicitAccount({ Address32: T }, 'dest'), { value: { Address32: T_ID } });
  assert.deepEqual(explicitAccount({ Address20: T_H160.toUpperCase().replace('0X', '0x') }, 'dest'), { value: { Address20: T_H160 } });
  assert.deepEqual(explicitAccount({ Id: T_H160 }, 'dest'), { h160: T_H160 }, 'answered like a bare 0x address');
  // not one of these forms: left to the encoder
  for (const v of [T, { Index: 1 }, { Raw: '0x00' }, { Id: [1, 2] }, { Id: T, extra: 1 }, null, [T]]) assert.equal(explicitAccount(v, 'dest'), null, JSON.stringify(v));
  // junk and very long text are refused at once
  for (const [v, re] of [
    [{ Id: '5'.repeat(30_000) }, /dest \(\{"Id": \.\.\.\}\): That is 30000 characters long/],
    [{ Address32: 'not an address' }, /dest \(\{"Address32": \.\.\.\}\): "not an address" is not a valid address/],
    [{ Address20: T }, /\{"Address20": \.\.\.\} holds a 0x address of 40 hex characters/],
    [{ Address32: T_H160 }, /\{"Address32": \.\.\.\} holds 32 bytes/],
  ] as Array<[unknown, RegExp]>) {
    const t = performance.now();
    assert.throws(() => explicitAccount(v, 'dest'), (e: unknown) => e instanceof ToolError && re.test(e.message), JSON.stringify(v).slice(0, 60));
    assert.ok(performance.now() - t < 200);
  }
});

test('refuseLongAccountText: a base58 string too long for an address, nested in an argument that holds accounts, is refused fast', () => {
  const b58 = 'aB3x'.repeat(5000);
  const t = performance.now();
  assert.throws(() => refuseLongAccountText([[b58, { Raw: '0x00' }]], 'subs'), (e: unknown) => e instanceof ToolError && /subs holds a value of 20000 characters where an account can be/.test(e.message) && e.message.length < 300);
  assert.ok(performance.now() - t < 100);
  // addresses, hex, ordinary text and short values pass
  assert.doesNotThrow(() => refuseLongAccountText([['5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z', { Raw: 'my name' }], `0x${'ab'.repeat(500)}`, 'a b '.repeat(100), 'x'.repeat(120)], 'subs'));
});
