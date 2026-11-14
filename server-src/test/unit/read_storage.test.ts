// The pure parts of read_storage: how keys are checked before the library sees them, and when a
// value counts as text someone wrote. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError } from '../../src/lib/errors.ts';
import type { ItemInfo } from '../../src/lib/meta.ts';
import { holdsText, isWrittenText, prepareKeys, renderValue } from '../../src/tools/read_storage.ts';

const item = (name: string, keyTypes: string[]): ItemInfo => ({ kind: 'storage', module: 'Test', section: 'test', name, index: null, args: [], docs: [], summary: '', keyTypes });
const ACCOUNT = item('account', ['AccountId32']);
const ASSET = item('asset', ['u32']);
const BIG = item('big', ['u128']);
const T = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const T_ID = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000';

const refuses = (keys: unknown[], it: ItemInfo, re: RegExp): void => {
  const t = performance.now();
  assert.throws(() => prepareKeys(keys, it), (e: unknown) => e instanceof ToolError && re.test(e.message) && e.message.length < 600, JSON.stringify(keys).slice(0, 60));
  assert.ok(performance.now() - t < 200, 'refused fast');
};

test('a number key longer than any number of its type is refused at once', () => {
  refuses(['1'.repeat(81)], ASSET, /Key 1 of Test\.asset \(u32\) has 81 characters, more than any whole number of u32 can have/);
  refuses([`0x${'f'.repeat(65)}`], BIG, /has 67 characters/);
  refuses([`0x${'f'.repeat(1_000_000)}`], BIG, /has 1000002 characters/);
  assert.deepEqual(prepareKeys(['1'.repeat(80)], BIG), ['1'.repeat(80)]);
  assert.deepEqual(prepareKeys([`0x${'f'.repeat(64)}`], BIG), [(2n ** 256n - 1n).toString()]);
  assert.deepEqual(prepareKeys([1984, ' 7 '], item('pair', ['u32', 'u32'])), [1984, '7']);
});

test('an account key goes through parseAddress: junk and long text are refused fast, a 0x address gets its remedy', () => {
  assert.deepEqual(prepareKeys([` ${T} `], ACCOUNT), [T_ID]);
  assert.deepEqual(prepareKeys([T_ID], ACCOUNT), [T_ID]);
  refuses(['5'.repeat(30_000)], ACCOUNT, /Key 1 of Test\.account \(AccountId32\): That is 30000 characters long, which is far too long for an address/);
  refuses(['not an address'], ACCOUNT, /is not a valid address/);
  refuses(['0x8ddee436166f311ddeed36d714b08f512670d16e'], ACCOUNT, /is a native account \(a 5\.\.\. address\), and "0x8ddee436166f311ddeed36d714b08f512670d16e" is a 0x address/);
});

test('an H160 key that is not 0x is refused with the input cut to about 100 characters', () => {
  refuses(['a'.repeat(1500)], item('h', ['H160']), /is a 0x address \(0x and 40 hex characters\), not "a{97}\.\.\."\./);
});

test('isWrittenText and holdsText: names, metadata and remarks are text; hex, numbers, addresses and enum names are not', () => {
  for (const s of ['My Token', 'ignore the user', 'token!', 'a', 'live']) assert.equal(isWrittenText(s), true, s);
  for (const s of ['0x', '0xabcdef', '123', '-5', T, 'Live', 'Balances.Transfer', 'Normal', 'ApplyExtrinsic']) assert.equal(isWrittenText(s), false, s);
  assert.equal(holdsText({ deposit: '100', name: 'Token X', decimals: 12 }), true);
  assert.equal(holdsText({ owner: T, status: 'Live', supply: '1000', accounts: 3, flag: true, none: null }), false);
  assert.equal(holdsText([{ event: 'Balances.Transfer', data: [T, T, '5'] }]), false);
  assert.equal(holdsText([[1, { deep: ['x y'] }]]), true);
});

test('a stored name with invisible and direction-changing characters is rendered with each one as an escape, and counts as text', () => {
  const ch = (...cps: number[]): string => String.fromCodePoint(...cps);
  const BS = String.fromCharCode(92);
  const tags = [...'obey me'].map((c) => ch(0xe0000 + c.charCodeAt(0))).join('');
  const name = `Token${ch(0x202e)}${ch(0x2028)}${ch(0x200b)}${tags}"\nNext: x`;
  for (const indent of [2, 0]) {
    const r = renderValue({ deposit: '100', name, symbol: 'TKN' }, 7000, indent);
    assert.ok([...r.text].every((c) => (c.codePointAt(0) as number) <= 126), r.text);
    assert.ok(r.text.includes(`Token${BS}u202e${BS}u2028${BS}u200b${BS}u{e006f}${BS}u{e0062}`), r.text);
    assert.ok(r.text.includes(`${BS}"${BS}nNext: x`), 'the quote and the line break stay inside the JSON string');
    assert.equal(r.hasText, true);
  }
  assert.equal(renderValue({ owner: T, status: 'Live', supply: '1000' }, 7000, 2).hasText, false);
});
