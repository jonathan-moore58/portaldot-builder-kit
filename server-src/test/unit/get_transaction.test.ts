// get_transaction's lookup in the node's pool (author_pendingExtrinsics), offline: extrinsics are
// built here with the saved testnet metadata, the way the node lists them, and searched by their own
// hash and by the Ethereum hash of the transaction they carry. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { blake2AsHex, keccakAsHex } from '@polkadot/util-crypto';
import { SAVED_METADATA } from '../../src/generated/metadata.ts';
import { NETWORKS } from '../../src/lib/networks.ts';
import { findInPool, MAX_POOL, notFoundLines, renderPool } from '../../src/tools/get_transaction.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const saved = SAVED_METADATA.testnet;
const registry = new TypeRegistry();
const metadata = new Metadata(registry, `0x${gunzipSync(Buffer.from(saved.gzipBase64, 'base64')).toString('hex')}` as `0x${string}`);
registry.setMetadata(metadata, undefined, { AuthorizeCall: { extrinsic: {}, payload: {} }, EthSetOrigin: { extrinsic: {}, payload: {} } }, true);

/** An unsigned extrinsic of Module.call with these arguments, as hex with its length prefix. */
function extrinsic(section: string, method: string, args: unknown[]): string {
  const pallet = (metadata.asLatest.pallets as Loose[]).find((p) => p.name.toString().toLowerCase() === section.toLowerCase());
  const variants = (registry.lookup.getSiType(pallet.calls.unwrap().type) as Loose).def.asVariant.variants as Loose[];
  const v = variants.find((x) => x.name.toString().replace(/_/g, '').toLowerCase() === method.toLowerCase());
  const call = registry.createType('Call', { callIndex: [pallet.index.toNumber(), v.index.toNumber()], args });
  return registry.createType('Extrinsic', { method: call }).toHex();
}

// The EIP-155 example transaction (legacy, chain id 1), carried the way the node carries one.
const RAW = '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83';
const ETH_X = extrinsic('Revive', 'ethTransact', [RAW]);
const REMARK_X = extrinsic('System', 'remark', ['0x68656c6c6f']);
const POOL = [REMARK_X, ETH_X];

test('the extrinsics built here are what the node would list', () => {
  const x = registry.createType('Extrinsic', ETH_X) as Loose;
  assert.equal(`${x.method.section}.${x.method.method}`, 'revive.ethTransact');
  assert.equal(x.method.args[0].toHex(), RAW);
  assert.ok(ETH_X.length > 200);
});

test('an Ethereum hash is found by keccak-256 of the payload, and a native one by blake2-256 of the extrinsic', () => {
  const eth = findInPool(registry, POOL, keccakAsHex(RAW, 256));
  assert.equal(eth?.kind, 'ethereum');
  assert.equal(eth?.position, 1);
  assert.equal(eth?.extrinsicHash, blake2AsHex(ETH_X, 256));
  const own = findInPool(registry, POOL, blake2AsHex(REMARK_X, 256).toUpperCase().replace('0X', '0x'));
  assert.equal(own?.kind, 'extrinsic', 'upper-case hex is found too');
  assert.equal(own?.position, 0);
  const ethOwn = findInPool(registry, POOL, blake2AsHex(ETH_X, 256));
  assert.equal(ethOwn?.kind, 'extrinsic', 'the node-side hash of an Ethereum transaction is found as an extrinsic');
  assert.equal(findInPool(registry, POOL, `0x${'11'.repeat(32)}`), null);
  assert.equal(findInPool(registry, [], keccakAsHex(RAW, 256)), null);
});

test('entries the runtime cannot decode are skipped, not thrown', () => {
  const junk = ['0x00', `0x${'ff'.repeat(150)}`, '0x1234'];
  assert.doesNotThrow(() => findInPool(registry, [...junk, ETH_X], keccakAsHex(RAW, 256)));
  assert.equal(findInPool(registry, [...junk, ETH_X], keccakAsHex(RAW, 256))?.position, 3);
  const own = findInPool(registry, junk, blake2AsHex('0x1234', 256));
  assert.equal(own?.kind, 'extrinsic');
  assert.equal(own?.x, null, 'found by its hash, though it cannot be decoded');
});

test('renderPool: an Ethereum transaction that waits shows the fields of its signed bytes and what waiting means', () => {
  const m = findInPool(registry, POOL, keccakAsHex(RAW, 256));
  assert.ok(m);
  const text = renderPool(m, keccakAsHex(RAW, 256), NETWORKS.testnet, 2);
  assert.match(text, /^Ethereum transaction 0x[0-9a-f]{64} on the Portaldot V3 testnet: WAITING\. The node has taken it, and it is not in a block yet\.$/m);
  assert.match(text, /Found just now in the node's pool \(author_pendingExtrinsics, entry 2 of 2\)\./);
  assert.match(text, /type: +0 \(legacy\); chain id 1, NOT the Portaldot V3 testnet's 420420777/);
  assert.match(text, /to: +0x3535353535353535353535353535353535353535/);
  assert.match(text, /value: +1 tPOT \(1000000000000000000 wei\)/);
  assert.match(text, /nonce: +9/);
  assert.match(text, /gas limit: +21000; gas price 20000000000 wei/);
  assert.match(text, /eth_getTransactionByHash and eth_getTransactionReceipt answer null until its block \(measured on Nov 15, 2026\)/);
  assert.match(text, /No fee is charged yet\./);
  assert.match(text, /with the same fees one is refused with 1014/);
  assert.match(text, /^[\x0a\x20-\x7e]+$/, 'ASCII only');
});

test('renderPool: a native extrinsic that waits shows its call and arguments', () => {
  const m = findInPool(registry, POOL, blake2AsHex(REMARK_X, 256));
  assert.ok(m);
  const text = renderPool(m, blake2AsHex(REMARK_X, 256), NETWORKS.testnet, 2);
  assert.match(text, /^Extrinsic 0x[0-9a-f]{64} on the Portaldot V3 testnet: WAITING\./);
  assert.match(text, /^call: +System\.remark$/m);
  assert.match(text, /^signer: +none \(unsigned\)$/m);
  assert.match(text, /remark: /);
  const undecoded = renderPool({ kind: 'extrinsic', position: 0, x: null, extrinsicHash: '0x' }, '0x', NETWORKS.testnet, 1);
  assert.match(undecoded, /could not be decoded with the node's current runtime/);
});

test('notFoundLines: what "in no block and not waiting" can mean, without guessing which', () => {
  const t = notFoundLines(NETWORKS.testnet, { size: 3, why: null }).join('\n');
  assert.match(t, /not in the node's pool of transactions waiting for a block \(author_pendingExtrinsics, read just now, held 3\)/);
  for (const re of [/never sent to this node/, /refused when it was sent.*1010, 1012, 1013 or 1014/, /replaced by another transaction with the same nonce/, /waits behind a nonce gap.*does not list it until the missing nonce is sent \(measured on Nov 15, 2026\)/, /raise search_blocks/]) assert.match(t, re);
  assert.match(t, /If it was sent to the mainnet, add "network": "mainnet"\./);
  assert.match(notFoundLines(NETWORKS.mainnet, { size: null, why: 'no answer' }).join('\n'), /the node's pool could not be read \(no answer\), so whether the transaction waits there is not known/);
  assert.match(notFoundLines(NETWORKS.testnet, { size: MAX_POOL + 1, why: null }).join('\n'), new RegExp(`the first ${MAX_POOL} were searched`));
});
