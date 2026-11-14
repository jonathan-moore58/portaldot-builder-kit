// Amounts and small text helpers. No network. Expected values are written out as digit strings by
// hand (or built by padding strings, never by the BigInt arithmetic under test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolError } from '../../src/lib/errors.ts';
import { clip, duration, formatUnits, hexToBytes, isHex, lines, nativeAmount, nativeToWei, parseInteger, parseUnits, toHex, utc, weiAmount, weiToNative } from '../../src/lib/format.ts';
import { NETWORKS } from '../../src/lib/networks.ts';

const zeros = (n: number): string => '0'.repeat(n);

test('formatUnits at 14 and 18 decimals', () => {
  assert.equal(formatUnits(0n, 14), '0');
  assert.equal(formatUnits(1n, 14), `0.${zeros(13)}1`);
  assert.equal(formatUnits(1n, 18), `0.${zeros(17)}1`);
  assert.equal(formatUnits(BigInt(`1${zeros(14)}`), 14), '1');
  assert.equal(formatUnits(BigInt(`15${zeros(13)}`), 14), '1.5');
  assert.equal(formatUnits(BigInt(`1${zeros(13)}`), 14), '0.1');
  assert.equal(formatUnits(BigInt(`1${zeros(18)}`), 18), '1');
  assert.equal(formatUnits(-BigInt(`15${zeros(13)}`), 14), '-1.5');
  assert.equal(formatUnits(12345n, 0), '12345');
});

test('formatUnits and parseUnits round trips, including values above 2^64 and 2^128', () => {
  const cases = [
    '0', '1', '0.1', '0.00000000000001', '1.5', '90.07199254740993', '123456789.12345678901234',
    '18446744073709551616', // 2^64
    '340282366920938463463374607431768211456', // 2^128
    '340282366920938463463374607431768211455.99999999999999', // 2^128 - 10^-14
  ];
  for (const text of cases) {
    const base = parseUnits(text, 14);
    assert.equal(formatUnits(base, 14), text, `14 decimals: ${text}`);
    const wei = parseUnits(text, 18);
    assert.equal(formatUnits(wei, 18), text, `18 decimals: ${text}`);
    assert.equal(wei, base * 10000n, `18 decimals is 10000 times 14 decimals: ${text}`);
  }
  // compare with digits padded by hand
  assert.equal(parseUnits('1.5', 14).toString(), `15${zeros(13)}`);
  assert.equal(parseUnits('18446744073709551616', 18).toString(), `18446744073709551616${zeros(18)}`);
  assert.equal(parseUnits('.5', 14).toString(), `5${zeros(13)}`);
  assert.equal(parseUnits('1.', 14).toString(), `1${zeros(14)}`);
  assert.equal(parseUnits(' 2 ', 14).toString(), `2${zeros(14)}`);
  assert.equal(parseUnits('1_000', 14).toString(), `1000${zeros(14)}`);
  // trailing zeros beyond the decimals are harmless
  assert.equal(parseUnits(`1.${zeros(20)}`, 14).toString(), `1${zeros(14)}`);
});

test('parseUnits refuses too many decimals and anything that is not a plain number', () => {
  const refuses = (text: string, re: RegExp, decimals = 14): void => {
    assert.throws(() => parseUnits(text, decimals), (e: unknown) => e instanceof ToolError && re.test((e as Error).message), text);
  };
  refuses(`0.${zeros(14)}1`, /more than 14 decimal places/);
  refuses(`0.${zeros(18)}1`, /more than 18 decimal places/, 18);
  refuses('1.5', /more than 0 decimal places/, 0);
  for (const junk of ['', ' ', '.', '-1', '+1', '1e18', '1,000', '1.000,5', '1.5 tPOT', '0x10', 'abc', '1..2', 'NaN', 'Infinity', '١']) {
    refuses(junk, /not a plain decimal number/);
  }
});

test('parseInteger takes decimal strings, 0x strings, safe numbers and bigints', () => {
  assert.equal(parseInteger('10000000000000', 'x'), 10000000000000n);
  assert.equal(parseInteger(' 42 ', 'x'), 42n);
  assert.equal(parseInteger('1_000', 'x'), 1000n);
  assert.equal(parseInteger('0xff', 'x'), 255n);
  assert.equal(parseInteger('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 'x'), 340282366920938463463374607431768211455n);
  assert.equal(parseInteger(9007199254740991, 'x'), 9007199254740991n);
  assert.equal(parseInteger(0, 'x'), 0n);
  assert.equal(parseInteger(5n, 'x'), 5n);
  const refuses = (v: string | number, re: RegExp): void => {
    assert.throws(() => parseInteger(v, 'value'), (e: unknown) => e instanceof ToolError && /value must be a whole number/.test((e as Error).message) && re.test((e as Error).message), String(v));
  };
  refuses(9007199254740992, /too large for a JSON number/);
  refuses(1e21, /too large for a JSON number/);
  refuses(1.5, /not whole/);
  refuses(Number.NaN, /not whole/);
  refuses(Number.POSITIVE_INFINITY, /not whole/);
  for (const s of ['', '1.5', '-5', '1e3', '0x', '0xzz', '0X10', '12 34', 'ten']) refuses(s, /not a whole number/);
});

test('parseInteger refuses a negative JSON number as it refuses "-5"', () => {
  assert.throws(() => parseInteger(-5, 'value'), ToolError);
});

test('nativeToWei and weiToNative: 1 base unit is 10000 wei, and the rest is dust', () => {
  assert.equal(nativeToWei(1n), 10000n);
  assert.equal(nativeToWei(BigInt(`1${zeros(14)}`)).toString(), `1${zeros(18)}`);
  assert.deepEqual(weiToNative(10000n), { native: 1n, dust: 0n });
  assert.deepEqual(weiToNative(19999n), { native: 1n, dust: 9999n });
  assert.deepEqual(weiToNative(1n), { native: 0n, dust: 1n });
  assert.deepEqual(weiToNative(0n), { native: 0n, dust: 0n });
  const big = BigInt(`123456789${zeros(18)}`) + 1234n;
  assert.deepEqual(weiToNative(big), { native: BigInt(`123456789${zeros(14)}`), dust: 1234n });
});

test('nativeAmount and weiAmount show tokens and raw units with the network symbol', () => {
  assert.equal(nativeAmount(10000000000000n, NETWORKS.testnet), '0.1 tPOT (10000000000000 base units)');
  assert.equal(nativeAmount(10000000000000n, NETWORKS.mainnet, false), '0.1 POT');
  assert.equal(weiAmount(100000000000000000n, NETWORKS.testnet), '0.1 tPOT (100000000000000000 wei)');
  assert.equal(weiAmount(1n, NETWORKS.mainnet, false), `0.${zeros(17)}1 POT`);
});

test('duration', () => {
  assert.equal(duration(0), '0 s');
  assert.equal(duration(6), '6 s');
  assert.equal(duration(89.4), '89 s');
  assert.equal(duration(90), '2 min');
  assert.equal(duration(240), '4 min');
  assert.equal(duration(89 * 60), '89 min');
  assert.equal(duration(90 * 60), '1 h 30 min');
  assert.equal(duration(2 * 3600 + 5 * 60), '2 h 5 min');
  assert.equal(duration(13 * 3600 + 24 * 60), '13 h 24 min');
  assert.equal(duration(-5), '0 s');
});

test('utc', () => {
  assert.equal(utc(0), '1970-01-01 00:00:00 UTC');
  assert.equal(utc(Date.UTC(2026, 10, 14, 7, 50, 42, 999)), '2026-11-14 07:50:42 UTC');
});

test('lines drops false, null and undefined, flattens one level and keeps empty strings', () => {
  assert.equal(lines('a', false, null, undefined, '', ['b', false, 'c'], 'd'), 'a\n\nb\nc\nd');
  assert.equal(lines(), '');
});

test('clip', () => {
  assert.equal(clip('short'), 'short');
  assert.equal(clip('x'.repeat(120)), 'x'.repeat(120));
  const cut = clip('x'.repeat(121));
  assert.equal(cut.length, 120);
  assert.ok(cut.startsWith('x'.repeat(117)));
  assert.ok(cut.endsWith('...'));
  assert.equal(clip('abcdef', 4).length, 4);
});

test('clip marks a cut with plain ASCII', () => {
  assert.match(clip('x'.repeat(200), 50), /\.\.\.$/);
});

test('isHex, toHex and hexToBytes', () => {
  assert.equal(isHex('0x'), true);
  assert.equal(isHex('0x00ff'), true);
  assert.equal(isHex('0xABcd'), true);
  assert.equal(isHex('0xabc'), false, 'odd length');
  assert.equal(isHex('abcd'), false, 'no 0x');
  assert.equal(isHex('0xzz'), false);
  assert.equal(isHex('0x00ff', 2), true);
  assert.equal(isHex('0x00ff', 3), false);
  assert.equal(isHex(`0x${'ab'.repeat(20)}`, 20), true);
  assert.equal(toHex(Uint8Array.of(0, 1, 254, 255)), '0x0001feff');
  assert.equal(toHex(new Uint8Array()), '0x');
  assert.deepEqual([...hexToBytes('0x0001feff')], [0, 1, 254, 255]);
  assert.deepEqual([...hexToBytes('0001feff')], [0, 1, 254, 255]);
});
