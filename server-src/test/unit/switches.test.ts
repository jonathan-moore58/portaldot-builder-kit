// The line get_chain_facts prints about safe mode and paused calls (src/lib/switches.ts). No network:
// the values are built from the metadata saved with the kit, the way the library decodes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { Metadata, StorageKey, TypeRegistry, expandMetadata } from '@polkadot/types';
import { SAVED_METADATA } from '../../src/generated/metadata.ts';
import { PAUSED_SHOWN, pausedName, readSwitches, switchesLine } from '../../src/lib/switches.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const saved = SAVED_METADATA.testnet;
const registry = new TypeRegistry();
const metadata = new Metadata(registry, `0x${gunzipSync(Buffer.from(saved.gzipBase64, 'base64')).toString('hex')}` as `0x${string}`);
registry.setMetadata(metadata, undefined, { AuthorizeCall: { extrinsic: {}, payload: {} }, EthSetOrigin: { extrinsic: {}, payload: {} } }, true);
const pausedCalls = (expandMetadata(registry, metadata) as Loose).query.txPause.pausedCalls;

/** A key of TxPause.pausedCalls as a key listing returns it: encoded, then decoded again with its meta. */
const key = (module: unknown, call: unknown): Loose => {
  const raw = new StorageKey(registry, [pausedCalls, [[module, call]]] as Loose);
  return new StorageKey(registry, raw.toHex()).setMeta(pausedCalls.meta, 'txPause', 'pausedCalls');
};
const until = (block: number | null): Loose => registry.createType('Option<u32>', block);
const BEST = 477_361;
const line = (safeUntil: Loose, pausedKeys: Loose[] | null, modules: { hasSafeMode?: boolean; hasTxPause?: boolean } = {}): string | false =>
  switchesLine({ hasSafeMode: true, hasTxPause: true, safeUntil, pausedKeys, best: BEST, ...modules });
const TRANSFER = (): Loose => key('Balances', 'transfer_keep_alive');
const REFUSES = 'the chain refuses the calls that are not on its list of allowed calls, with System.CallFiltered; it is not a fault in your code (explain_error "E38")';

test('safe mode off and nothing paused is one plain line', () => {
  assert.equal(line(until(null), []), '- safe mode: off. No call is paused by name.');
});

test('a stored entry means safe mode is on, and the time left counts its last block', () => {
  assert.equal(
    line(until(BEST + 2400), []),
    '- WARNING: safe mode: ON through block 479761, its last block. It then ends by itself, so calls go through again from block 479762, about 4 h 0 min from now, ' +
      `unless safe mode is extended or ended before that. While it is on, ${REFUSES}. No call is paused by name.`,
  );
  assert.match(String(line(until(BEST), [])), /from block 477362, about 6 s from now/);
  // an entry whose block has passed is still an entry, and the entry is what the chain looks at
  assert.equal(line(until(BEST - 5), []), `- WARNING: safe mode: ON. Its last block 477356 has passed, but the entry is still stored, so ${REFUSES}. No call is paused by name.`);
});

test('only an empty entry reads as off', () => {
  // a value that is neither an empty nor a filled entry was not read as expected
  assert.equal(line(registry.createType('u32', 479_000), []), '- safe mode: could not be read just now. No call is paused by name.');
  assert.equal(line(undefined, []), '- safe mode: could not be read just now. No call is paused by name.');
  assert.equal(line(null, []), '- safe mode: could not be read just now. No call is paused by name.');
});

test('paused calls are named in quotes, and warned about even while safe mode is off', () => {
  assert.equal(
    line(until(null), [TRANSFER()]),
    '- WARNING: safe mode: off, but some calls are paused by name: "Balances.transfer_keep_alive". Expect the chain to refuse them for every account (explain_error "E38").',
  );
  const on = String(line(until(BEST + 10), [TRANSFER()]));
  assert.match(on, /^- WARNING: safe mode: ON through block /);
  assert.ok(on.endsWith(' Calls paused by name: "Balances.transfer_keep_alive".'), on);
});

test('a paused name cannot break the answer: odd bytes, line breaks, hidden characters, long names', () => {
  // the chain stores any bytes as a name; bytes that are not text are shown as hex, outside the quotes
  assert.equal(pausedName(key('0x42fffe', 'x')), 'bytes 0x42fffe.0x78 (not text)');
  // a name whose text happens to read like hex stays in quotes, so the two cannot be mixed up
  assert.equal(pausedName(key('0x3078343266666665', 'x')), '"0x42fffe.x"');
  const override = String.fromCharCode(0x202e);
  const hostile = String(line(until(null), [key('Bal\nances', `- WARNING: x${override}`)]));
  assert.equal(hostile.split('\n').length, 1, 'one line only');
  assert.ok(!hostile.includes(override), 'no hidden character');
  assert.ok(pausedName(key('A'.repeat(300), 'b'.repeat(300))).length < 140);
  // a key that did not decode, or no key at all
  assert.equal(pausedName({}), '"a key that could not be read"');
  assert.equal(pausedName(null), '"a key that could not be read"');
  assert.match(pausedName(new StorageKey(registry, key('Balances', 'x').toHex())), /^bytes [0-9a-f]{1,64} \(not text\)$/);
});

test('more paused calls than are shown, failed reads and missing modules', () => {
  const many = Array.from({ length: PAUSED_SHOWN + 1 }, (_, i) => key('Balances', `call_${i}`));
  assert.ok(String(line(until(null), many)).includes('"Balances.call_19" and more. Expect'), 'one more than shown');
  assert.ok(!String(line(until(null), many.slice(0, PAUSED_SHOWN))).includes('and more'), 'exactly as many as shown');
  assert.equal(line(until(null), null), '- safe mode: off. The paused calls could not be read just now.');
  assert.match(String(line(null, [TRANSFER()])), /^- WARNING: safe mode: could not be read just now, but some calls are paused by name: /);
  assert.match(String(line(until(BEST + 1), null)), /\(explain_error "E38"\)\. The paused calls could not be read just now\.$/);
  assert.equal(line(null, [], { hasSafeMode: false }), '- No call is paused by name.');
  assert.equal(line(null, [TRANSFER()], { hasSafeMode: false }), '- WARNING: some calls are paused by name: "Balances.transfer_keep_alive". Expect the chain to refuse them for every account (explain_error "E38").');
  assert.equal(line(until(null), null, { hasTxPause: false }), '- safe mode: off.');
  assert.equal(line(null, null, { hasSafeMode: false, hasTxPause: false }), false);
});

test('the reads: one more key than is shown, a failed read is null, a missing module is not asked', async () => {
  let asked: Loose;
  const api = {
    query: {
      safeMode: { enteredUntil: () => Promise.reject(new Error('x')) },
      txPause: { pausedCalls: { keysPaged: (options: Loose) => { asked = options; return Promise.resolve([]); } } },
    },
  };
  assert.deepEqual(await readSwitches(api), { hasSafeMode: true, hasTxPause: true, safeUntil: null, pausedKeys: [] });
  assert.equal(asked.pageSize, PAUSED_SHOWN + 1);
  // a read that throws at once, before it returns a promise, is a failed read too
  const throwing = { query: { safeMode: { enteredUntil: () => { throw new Error('x'); } }, txPause: { pausedCalls: { keysPaged: () => { throw new Error('x'); } } } } };
  assert.deepEqual(await readSwitches(throwing), { hasSafeMode: true, hasTxPause: true, safeUntil: null, pausedKeys: null });
  assert.deepEqual(await readSwitches({ query: {} }), { hasSafeMode: false, hasTxPause: false, safeUntil: null, pausedKeys: null });
  assert.deepEqual(await readSwitches({}), { hasSafeMode: false, hasTxPause: false, safeUntil: null, pausedKeys: null });
});
