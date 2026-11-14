// convert_amount is pure: these tests need no network. If the tool opened a connection,
// the process would not exit and the run would time out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tool from '../../src/tools/convert_amount.ts';
import { runTool } from '../../src/lib/tool.ts';

const run = (args: unknown) => runTool(tool, args);

/** Reads the three values back out of the answer. */
function parse(text: string): { tokens: string; base: string; wei: string; hex: string } {
  const get = (re: RegExp): string => {
    const m = re.exec(text);
    assert.ok(m, `missing ${re} in:\n${text}`);
    return m[1];
  };
  return {
    tokens: get(/what people read\):\s+(\S+)/),
    base: get(/14 decimals\):\s+(\d+)/),
    wei: get(/18 decimals\):\s+(\d+)/),
    hex: get(/"value" field\):\s+(0x[0-9a-f]+)/),
  };
}

/** A second way to the same numbers: pad the decimal string by hand, no BigInt arithmetic. */
function byHand(tokens: string): { base: string; wei: string } {
  const [whole, frac = ''] = tokens.split('.');
  const strip = (s: string): string => s.replace(/^0+(?=\d)/, '');
  return { base: strip(whole + frac.padEnd(18, '0').slice(0, 14)), wei: strip(whole + frac.padEnd(18, '0')) };
}

test('it does not read the chain', () => {
  assert.equal(tool.readsChain, false);
  assert.equal(tool.name, 'convert_amount');
  assert.ok(tool.description.length >= 400 && tool.description.length <= 1100, `description is ${tool.description.length} characters`);
});

test('1.5 tokens in all three units', async () => {
  const r = await run({ amount: '1.5', unit: 'token' });
  assert.equal(r.isError, false);
  const v = parse(r.text);
  assert.deepEqual(v, { tokens: '1.5', base: '150000000000000', wei: '1500000000000000000', hex: '0x14d1120d7b160000' });
  assert.match(r.text, /parseEther\("1"\) \(1000000000000000000n\) is right for an Ethereum transaction and 10000 times too much as a native value/);
  assert.match(r.text, /Balances\.transferKeepAlive/);
  assert.match(r.text, /eth_getBalance/);
  assert.match(r.text, /const wei = 1500000000000000000n;/);
  assert.match(r.text, /parseUnits\('1\.5', 14\)/);
  assert.match(r.text, /tPOT/);
  assert.match(r.text, /nothing was read from the chain/);
});

test('the three ways in agree with each other and with a second method', async () => {
  for (const tokens of ['0', '1', '0.1', '123.456', '0.00000000000001', '98765432109.87654321', '0.000000000000000001']) {
    const fromToken = parse((await run({ amount: tokens, unit: 'token' })).text);
    const hand = byHand(tokens);
    assert.equal(fromToken.wei, hand.wei, `wei of ${tokens}`);
    assert.equal(fromToken.base, hand.base, `base of ${tokens}`);
    assert.equal(BigInt(fromToken.hex), BigInt(fromToken.wei), `hex of ${tokens}`);
    const fromWei = parse((await run({ amount: fromToken.wei, unit: 'wei' })).text);
    assert.equal(fromWei.tokens, fromToken.tokens);
    assert.equal(fromWei.base, fromToken.base);
    if (BigInt(fromToken.wei) % 10000n === 0n) {
      const fromBase = parse((await run({ amount: fromToken.base, unit: 'base' })).text);
      assert.equal(fromBase.wei, fromToken.wei);
      assert.equal(fromBase.tokens, fromToken.tokens);
    }
  }
});

test('a wei amount that is not a multiple of 10000 gets the dust warning', async () => {
  const r = await run({ amount: '1234567', unit: 'wei' });
  assert.equal(r.isError, false);
  assert.match(r.text, /123 base units and 4567 wei left over/);
  assert.match(r.text, /called dust/);
  assert.match(r.text, /not known to us/);
  assert.match(r.text, /multiples of 10000 wei/);
});

test('a multiple of 10000 wei has no dust warning', async () => {
  const r = await run({ amount: '20000', unit: 'wei' });
  assert.equal(r.isError, false);
  assert.equal(parse(r.text).base, '2');
  assert.doesNotMatch(r.text, /dust/);
});

test('15 to 18 decimal places: allowed, with a warning; 19 refused', async () => {
  const ok = await run({ amount: '0.123456789012345678', unit: 'token' });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /more than 14 decimal places/);
  assert.match(ok.text, /12345678901234 base units and 5678 wei left over/);
  const no = await run({ amount: '1.0000000000000000001', unit: 'token' });
  assert.equal(no.isError, true);
  assert.match(no.text, /19 decimal places/);
  const zeros = await run({ amount: '1.00000000000000000000', unit: 'token' });
  assert.equal(zeros.isError, false, 'trailing zeros do not count as places');
});

test('the 2^53 warning appears only where it applies', async () => {
  const small = await run({ amount: '1', unit: 'base' });
  assert.doesNotMatch(small.text, /2\^53/);
  const wei = await run({ amount: '1', unit: 'token' });
  assert.match(wei.text, /2\^53 - 1 \(9007199254740991\), so not exact as a JavaScript Number: wei 1000000000000000000/);
  assert.doesNotMatch(wei.text, /base units 100000000000000 and/);
  const both = await run({ amount: '100', unit: 'token' });
  assert.match(both.text, /base units 10000000000000000 and wei 100000000000000000000/);
});

test('very large amounts stay exact', async () => {
  const r = await run({ amount: (2n ** 128n).toString(), unit: 'wei' });
  assert.equal(r.isError, false);
  const v = parse(r.text);
  assert.equal(v.wei, '340282366920938463463374607431768211456');
  assert.equal(v.hex, '0x100000000000000000000000000000000');
});

test('hex is accepted for base and wei, not for tokens', async () => {
  const r = await run({ amount: '0x14d1120d7b160000', unit: 'wei' });
  assert.equal(parse(r.text).tokens, '1.5');
  const b = await run({ amount: '0x2710', unit: 'base' });
  assert.equal(parse(b.text).base, '10000');
  const upper = await run({ amount: '0X1A', unit: 'wei' });
  assert.equal(upper.isError, false, upper.text);
  assert.equal(parse(upper.text).wei, '26');
  const empty = await run({ amount: '0x', unit: 'wei' });
  assert.equal(empty.isError, true);
  assert.match(empty.text, /not a hex number/);
  const t = await run({ amount: '0x10', unit: 'token' });
  assert.equal(t.isError, true);
  assert.match(t.text, /cannot be a token amount/);
});

test('a safe JSON integer is accepted', async () => {
  const r = await run({ amount: 1000, unit: 'base' });
  assert.equal(r.isError, false);
  assert.equal(parse(r.text).wei, '10000000');
});

test('the mainnet uses POT', async () => {
  const r = await run({ amount: '2', unit: 'token', network: 'mainnet' });
  assert.equal(r.isError, false);
  assert.match(r.text, /2 POT in all three units/);
  assert.doesNotMatch(r.text, /tPOT/);
});

test('bad input is refused with a message that says how to write it', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ amount: '-1', unit: 'token' }, /without the minus sign/],
    [{ amount: -5, unit: 'base' }, /cannot be negative/],
    [{ amount: '1e18', unit: 'wei' }, /without an exponent: "1e18" is "1000000000000000000"/],
    [{ amount: '2.5e-3', unit: 'token' }, /"0\.0025"/],
    [{ amount: '1,000', unit: 'token' }, /comma/],
    [{ amount: '1.5tPOT', unit: 'token' }, /put the unit in "unit"/],
    [{ amount: '5 gwei', unit: 'wei' }, /"5000000000", "unit": "wei"/],
    [{ amount: '1 000', unit: 'base' }, /space/],
    [{ amount: 1.5, unit: 'token' }, /as a string/],
    [{ amount: 9007199254740993, unit: 'wei' }, /2\^53 - 1/],
    [{ amount: '1.5', unit: 'base' }, /whole number/],
    [{ amount: '1.5', unit: 'wei' }, /whole number/],
    [{ amount: '', unit: 'wei' }, /empty/],
    [{ amount: 'abc', unit: 'base' }, /not a plain decimal number/],
    [{ amount: '1.2.3', unit: 'token' }, /not a plain decimal number/],
    [{ amount: '0xZZ', unit: 'wei' }, /not a hex number/],
    [{ amount: `0x${'ab'.repeat(32)}`, unit: 'wei' }, /private key/],
    [{ amount: 'legal winner thank year wave sausage worth useful legal winner thank yellow', unit: 'token' }, /secret recovery phrase/],
    [{ amount: '1', unit: 'ether' }, /Invalid input/],
  ];
  for (const [args, re] of cases) {
    const r = await run(args);
    assert.equal(r.isError, true, `expected an error for ${JSON.stringify(args)}`);
    assert.match(r.text, re, `message for ${JSON.stringify(args)}: ${r.text}`);
    assert.doesNotMatch(r.text, /\n\s+at /, 'no stack trace');
  }
});
