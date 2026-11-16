// The runtime-upgrade warning of a connection, from the saved metadata's spec version. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specWarning } from '../../src/lib/chain.ts';
import { SAVED_METADATA } from '../../src/generated/metadata.ts';
import { NETWORKS } from '../../src/lib/networks.ts';

const testnet = NETWORKS.testnet;
const mainnet = NETWORKS.mainnet;
const savedT = SAVED_METADATA.testnet.specVersion;
const savedM = SAVED_METADATA.mainnet.specVersion;

// When this fails, the metadata was saved again from a newer runtime: measure the dated facts again
// on it before the release, then change these two numbers.
test('the saved metadata is the runtime the facts were measured on: testnet spec 3002, mainnet spec 3001', () => {
  assert.equal(savedT, 3002);
  assert.equal(savedM, 3001);
});

test('no warning while the chain runs the saved spec', () => {
  assert.equal(specWarning(testnet, { genesis: testnet.genesis, specVersion: savedT }), null);
  assert.equal(specWarning(mainnet, { genesis: mainnet.genesis, specVersion: savedM }), null);
});

test('another spec: one warning that names both specs, says live reads are still right, and says to update the plugin', () => {
  const w = specWarning(testnet, { genesis: testnet.genesis, specVersion: savedT + 1 });
  assert.equal(
    w,
    `WARNING: the Portaldot V3 testnet now runs runtime spec ${savedT + 1}, and the facts in these tools that carry a date were measured on spec ${savedT}: after this runtime upgrade they may no longer hold. ` +
      'What the tools read live is still right. Update the plugin: a newer version may have the facts checked on the new runtime.',
  );
  assert.match(specWarning(mainnet, { genesis: mainnet.genesis, specVersion: savedM - 1 }) ?? '', new RegExp(`^WARNING: the Portaldot V3 mainnet now runs runtime spec ${savedM - 1}, .* measured on spec ${savedM}:`));
  assert.match(w ?? '', /^[\x20-\x7e]+$/, 'ASCII only, one line');
});

test('a node of another chain gets no spec warning: the genesis warning covers it', () => {
  assert.equal(specWarning(testnet, { genesis: mainnet.genesis, specVersion: 9999 }), null);
  assert.equal(specWarning(testnet, { genesis: `0x${'00'.repeat(32)}`, specVersion: 3003 }), null);
});

test('a spec version that is not a whole number is ignored', () => {
  assert.equal(specWarning(testnet, { genesis: testnet.genesis, specVersion: Number.NaN }), null);
  assert.equal(specWarning(testnet, { genesis: testnet.genesis, specVersion: 3002.5 }), null);
});
