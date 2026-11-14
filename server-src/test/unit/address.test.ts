// The address rule, offline. Every vector below was first checked against the chain's own runtime
// API on both networks (reviveApi.address(accountId) and reviveApi.accountId(h160)) on Nov 14, 2026,
// so these tests compare src/lib/address.ts with the chain, not with itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAddress, encodeAddress } from '@polkadot/util-crypto';
import { checksummed, fallbackIdOfH160, h160OfAccountId, isFallbackId, parseAddress, SS58_PREFIX, toSs58 } from '../../src/lib/address.ts';
import { ToolError } from '../../src/lib/errors.ts';
import { hexToBytes, toHex } from '../../src/lib/format.ts';

const TREASURY = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const TREASURY_ID = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000';
const TREASURY_H160 = '0x8ddee436166f311ddeed36d714b08f512670d16e';
const PALLETS = '0x6d6f646c70792f70616464720000000000000000';

/** Native account id -> 0x address, as reviveApi.address answered. */
const NATIVE: Array<{ label: string; id: string; ss58: string; h160: string }> = [
  { label: 'the Treasury (modlpy/trsry)', id: TREASURY_ID, ss58: TREASURY, h160: TREASURY_H160 },
  { label: 'the module account modlpy/paddr (32 bytes, not the pallets address)', id: '0x6d6f646c70792f70616464720000000000000000000000000000000000000000', ss58: '5EYCAe5ijiYfRmcZ49QUZ8dWLt4eYQ6WfHhR9eyyw4pHHfqY', h160: '0x6c0314017761e1367178001be94c2f710eb43325' },
  { label: 'all zero bytes', id: `0x${'00'.repeat(32)}`, ss58: '5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM', h160: '0x88386fc84ba6bc95484008f6362f93160ef3e563' },
  { label: 'all 0x01 bytes', id: `0x${'01'.repeat(32)}`, ss58: '5C62Ck4UrFPiBtoCmeSrgF7x9yv9mn38446dhCpsi2mLHiFT', h160: '0xb312bec018884c2d66667c67a90508214bd8bafc' },
  { label: 'all 0xff bytes', id: `0x${'ff'.repeat(32)}`, ss58: '5HrN7fHLXWcFiXPwwtq2EkSGns9eMt5P7SpeTPewumZy6ftb', h160: '0xab758a3376d22aedc6a55823d1b3ecbee81b8fb9' },
  { label: 'bytes 1 to 32', id: '0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20', ss58: '5C62W7ELLAAfjCQeBU3me9ykaYomD8XTg2B9Hk6ki6Cm3v58', h160: '0x3ef9427070bda64128fb5630b97b6ab17a8ff0a8' },
  { label: 'only eleven 0xEE bytes at the end (not a fallback id)', id: `0x${'11'.repeat(21)}${'ee'.repeat(11)}`, ss58: '5CT5jwBEAhveEjgiSCQbkaKcKcUyF3omxfXoSk2XjkuJNTbS', h160: '0x776953085b13792047841065d9b68e0a3153a6d2' },
];

/** Account ids that end in twelve 0xEE bytes: reviveApi.address gives back their first 20 bytes. */
const FALLBACK: Array<{ label: string; h160: string; id: string; ss58: string }> = [
  { label: 'the pallets address', h160: PALLETS, id: `${PALLETS}${'ee'.repeat(12)}`, ss58: '5EYCAe5ijiYfRmcZ49QUZ8dWLt4eZuwEUWscww7vuDtroCLa' },
  { label: '0x00..ff', h160: `0x${'00'.repeat(19)}ff`, id: `0x${'00'.repeat(19)}ff${'ee'.repeat(12)}`, ss58: '5C4hrfjw9DjXZTzV3MwzrrAr9P1UTzS88j9irHb2WyqDMYWK' },
  { label: 'an EIP-55 test address', h160: '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', id: `0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed${'ee'.repeat(12)}`, ss58: encodeAddress(hexToBytes(`0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed${'ee'.repeat(12)}`), 42) },
];

// The standard BIP-39 test phrases (all-zero entropy). Never a real phrase.
const PHRASE_12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PHRASE_24 = `${'abandon '.repeat(23)}art`;

const throwsTool = (fn: () => unknown, re: RegExp): void => {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof ToolError, `expected a ToolError, got ${String(e)}`);
    assert.match((e as Error).message, re);
    return true;
  });
};

test('native -> 0x: the last 20 bytes of keccak-256, as the chain computes it', () => {
  for (const v of NATIVE) {
    assert.equal(h160OfAccountId(hexToBytes(v.id)), v.h160, v.label);
    const p = parseAddress(v.ss58);
    assert.equal(p.kind, 'ss58', v.label);
    assert.equal(toHex(p.accountId), v.id, v.label);
    assert.equal(p.h160, v.h160, v.label);
    assert.equal(p.isFallbackForm, false, v.label);
    assert.equal(p.ss58Prefix, 42, v.label);
    assert.equal(toSs58(hexToBytes(v.id)), v.ss58, v.label);
  }
});

test('an account id ending in twelve 0xEE bytes stands for its first 20 bytes', () => {
  for (const v of FALLBACK) {
    const id = hexToBytes(v.id);
    assert.equal(isFallbackId(id), true, v.label);
    assert.equal(h160OfAccountId(id), v.h160, v.label);
    const p = parseAddress(v.ss58);
    assert.equal(p.isFallbackForm, true, v.label);
    assert.equal(p.h160, v.h160, v.label);
  }
  assert.equal(isFallbackId(hexToBytes(NATIVE[6].id)), false, 'eleven EE bytes are not enough');
  assert.equal(isFallbackId(new Uint8Array(20).fill(0xee)), false, 'a 20-byte value is not an account id');
});

test('0x -> native: the fallback account id is the 20 bytes and twelve 0xEE bytes (reviveApi.accountId of an unlinked address)', () => {
  for (const v of FALLBACK) {
    assert.equal(toHex(fallbackIdOfH160(v.h160)), v.id, v.label);
    const p = parseAddress(v.h160);
    assert.equal(p.kind, 'h160');
    assert.equal(toHex(p.accountId), v.id, v.label);
    assert.equal(toSs58(p.accountId), v.ss58, v.label);
    assert.equal(p.isFallbackForm, true);
  }
  // The Treasury's 0x form is linked, so the chain answers with the Treasury itself; offline, only the fallback is known.
  const t = parseAddress(TREASURY_H160);
  assert.equal(toHex(t.accountId), `${TREASURY_H160}${'ee'.repeat(12)}`);
});

test('the Treasury in all three written forms', () => {
  const a = parseAddress(TREASURY);
  const b = parseAddress(TREASURY_ID);
  assert.equal(a.h160, TREASURY_H160);
  assert.equal(b.kind, 'accountId');
  assert.equal(b.h160, TREASURY_H160);
  assert.equal(toHex(b.accountId), TREASURY_ID);
  assert.equal(b.isFallbackForm, false);
  assert.equal(checksummed(TREASURY_H160), '0x8DDEe436166f311ddeED36d714B08F512670d16e');
  const c = parseAddress(`${PALLETS}${'ee'.repeat(12)}`);
  assert.equal(c.kind, 'accountId');
  assert.equal(c.isFallbackForm, true);
  assert.equal(c.h160, PALLETS);
});

test('an SS58 address written with another prefix is the same account, and the prefix is reported', () => {
  for (const prefix of [0, 2, 5, 63]) {
    const text = encodeAddress(hexToBytes(TREASURY_ID), prefix);
    assert.ok(checkAddress(text, prefix)[0], `library self-check for prefix ${prefix}`);
    const p = parseAddress(text);
    assert.equal(p.ss58Prefix, prefix);
    assert.equal(toHex(p.accountId), TREASURY_ID);
    assert.equal(p.h160, TREASURY_H160);
  }
});

test('two-byte SS58 prefixes (64 to 16383) are decoded right', () => {
  for (const prefix of [64, 65, 127, 128, 255, 256, 1284, 2254, 4095, 16383]) {
    const text = encodeAddress(hexToBytes(TREASURY_ID), prefix);
    assert.ok(checkAddress(text, prefix)[0], `library self-check for prefix ${prefix}`);
    const p = parseAddress(text);
    assert.equal(p.ss58Prefix, prefix, `prefix ${prefix} (${text})`);
    assert.equal(toHex(p.accountId), TREASURY_ID);
  }
  assert.equal(SS58_PREFIX, 42);
});

test('EIP-55 checksum: valid mixed case, invalid mixed case, all lower, all upper', () => {
  // the test vectors of EIP-55 itself
  for (const good of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']) {
    const p = parseAddress(good);
    assert.equal(p.checksumWarning, undefined, good);
    assert.equal(p.h160, good.toLowerCase());
    assert.equal(checksummed(good.toLowerCase()), good);
  }
  const bad = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'; // last letter's case flipped
  assert.match(parseAddress(bad).checksumWarning ?? '', /checksum/);
  assert.equal(parseAddress(bad).h160, bad.toLowerCase(), 'still parsed, only warned');
  assert.equal(parseAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed').checksumWarning, undefined, 'all lower case carries no checksum');
  assert.equal(parseAddress('0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED').checksumWarning, undefined, 'all upper case carries no checksum');
  assert.equal(parseAddress('0x52908400098527886E0F7030069857D2E4169EE7').checksumWarning, undefined, 'EIP-55 all-caps vector');
});

test('a secret phrase of 12 or 24 words is refused, and not echoed back', () => {
  for (const phrase of [PHRASE_12, PHRASE_24, `  ${PHRASE_12}\n`, PHRASE_12.replace(/ /g, '\n')]) {
    assert.throws(
      () => parseAddress(phrase),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.match((e as Error).message, /secret recovery phrase/);
        assert.ok(!(e as Error).message.includes('abandon'), 'the phrase must not be repeated in the answer');
        return true;
      },
    );
  }
});

test('bad base58, a bad SS58 checksum and junk give a ToolError that says what an address looks like', () => {
  throwsTool(() => parseAddress('5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6O'), /not a valid address.*starts with 5/); // O is not base58
  throwsTool(() => parseAddress('5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Y'), /not a valid address/); // checksum
  throwsTool(() => parseAddress('hello'), /not a valid address/);
  throwsTool(() => parseAddress(''), /not a valid address/);
  throwsTool(() => parseAddress('   '), /not a valid address/);
});

test('wrong lengths are refused with the count', () => {
  throwsTool(() => parseAddress(`0x${'a'.repeat(39)}`), /39 characters after 0x/);
  throwsTool(() => parseAddress(`0x${'a'.repeat(41)}`), /41 characters after 0x/);
  throwsTool(() => parseAddress(`0x${'a'.repeat(63)}`), /63 characters after 0x/);
  throwsTool(() => parseAddress(`0x${'a'.repeat(66)}`), /66 characters after 0x/);
  throwsTool(() => parseAddress('0x'), /0 characters after 0x/);
  // an SS58 string that carries 33 bytes (an ECDSA public key)
  throwsTool(() => parseAddress(encodeAddress(new Uint8Array(33).fill(2), 42)), /decodes to 33 bytes/);
  throwsTool(() => h160OfAccountId(new Uint8Array(20)), /32 bytes; got 20/);
  throwsTool(() => fallbackIdOfH160('0x1234'), /20 bytes .* got 2 bytes/);
});

test('leading and trailing spaces are ignored', () => {
  assert.equal(parseAddress(`  ${TREASURY}  `).h160, TREASURY_H160);
  assert.equal(parseAddress(`\t${TREASURY_H160}\n`).h160, TREASURY_H160);
  assert.equal(parseAddress(` ${TREASURY_ID} `).kind, 'accountId');
  assert.equal(parseAddress(`  ${TREASURY}  `).input, TREASURY);
});

test('a 0x address written with a capital X is read, or refused with advice to write 0x', () => {
  const text = `0X${TREASURY_H160.slice(2)}`;
  let message = '';
  try {
    assert.equal(parseAddress(text).h160, TREASURY_H160);
    return;
  } catch (e) {
    message = (e as Error).message;
  }
  assert.match(message, /lower-case 0x|write it as 0x/i);
});

test('a non-hex character in a 0x address is named in the error', () => {
  throwsTool(() => parseAddress(`${TREASURY_H160.slice(0, -1)}g`), /not (a )?hex/i);
});
