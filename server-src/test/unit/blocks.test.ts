// The pure helpers behind get_block, get_transaction and get_contract_events, on hand-built records
// shaped like the ones @polkadot/api decodes from the V3 testnet. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  argText,
  callName,
  cut,
  depositHeld,
  describeDispatchError,
  ethHashOf,
  eventName,
  eventsOf,
  explorerExtrinsicUrl,
  feeOf,
  isEthTransact,
  isHash32,
  isInherent,
  matchEvents,
  moduleName,
  nodeConsoleBlockUrl,
  outcomeOf,
  refuseSecret,
  shortEvent,
  type EthLog,
  type NodeEvent,
} from '../../src/lib/blocks.ts';
import { ToolError } from '../../src/lib/errors.ts';
import { NETWORKS } from '../../src/lib/networks.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const testnet = NETWORKS.testnet;
const some = (v: string) => ({ isSome: true, unwrap: () => ({ toString: () => v }) });
const none = { isSome: false };

/** A registry that knows a few modules by their chain names and two errors. */
const registry: Loose = {
  metadata: { pallets: ['System', 'Balances', 'TransactionPayment', 'Revive', 'Utility', 'Sudo'].map((n) => ({ name: { toString: () => n } })) },
  findMetaError: (m: Loose) => {
    if (m.index === 6 && m.error === 2) return { section: 'balances', name: 'InsufficientBalance', docs: ['Balance too low to send value.'] };
    if (m.index === 80 && m.error === 11) return { section: 'revive', name: 'ContractTrapped', docs: ['Contract trapped during execution.'] };
    throw new Error('unknown');
  },
};

/** A value with the methods the helpers use. */
const val = (plain: unknown, raw = ''): Loose => ({ toPrimitive: () => plain, toString: () => String(plain), toRawType: () => raw, toHex: () => String(plain), toU8a: () => new Uint8Array(32) });
const moduleErr = (index: number, error: number): Loose => ({ isModule: true, asModule: { index, error }, type: 'Module' });
const ok: Loose = { isErr: false };
const errOf = (e: Loose): Loose => ({ isErr: true, asErr: e });

/** An event record: section, method, its field names and type names, values, and the extrinsic it belongs to. */
function rec(section: string, method: string, fields: Array<[string, string, Loose]>, index: number | null = 1): Loose {
  return {
    phase: index === null ? { isApplyExtrinsic: false, type: 'Finalization' } : { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: () => index }, type: 'ApplyExtrinsic' },
    event: {
      section,
      method,
      meta: { fields: fields.map(([name, typeName]) => ({ name: some(name), typeName: typeName ? some(typeName) : none })) },
      data: fields.map(([, , v]) => v),
    },
  };
}
const success = (cls = 'Normal') => rec('system', 'ExtrinsicSuccess', [['dispatch_info', 'DispatchEventInfo', { class: { toString: () => cls } }]]);
const feePaid = (fee: bigint, tip = 0n) => rec('transactionPayment', 'TransactionFeePaid', [['who', 'T::AccountId', val('5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z')], ['actual_fee', 'BalanceOf<T>', val(fee)], ['tip', 'BalanceOf<T>', val(tip)]]);

test('cut, isHash32 and refuseSecret', () => {
  assert.equal(cut('abcdef', 10), 'abcdef');
  assert.equal(cut('abcdefghijkl', 10), 'abcdefg...');
  assert.equal(cut('x'.repeat(300)).length, 200);
  assert.equal(isHash32(`0x${'ab'.repeat(32)}`), true);
  assert.equal(isHash32(` 0x${'AB'.repeat(32)} `), true);
  assert.equal(isHash32(`0x${'ab'.repeat(20)}`), false);
  assert.throws(() => refuseSecret('legal winner thank year wave sausage worth useful legal winner thank yellow'), (e: unknown) => e instanceof ToolError && /secret recovery phrase/.test(e.message));
  assert.doesNotThrow(() => refuseSecret('452626'));
});

test('module, call and event names use the chain\'s own module names', () => {
  assert.equal(moduleName(registry, 'transactionPayment'), 'TransactionPayment');
  assert.equal(moduleName(registry, 'revive'), 'Revive');
  assert.equal(moduleName(registry, 'unknownThing'), 'UnknownThing');
  assert.equal(callName(registry, { section: 'balances', method: 'transferKeepAlive' }), 'Balances.transferKeepAlive');
  assert.equal(eventName(registry, rec('revive', 'ContractEmitted', [])), 'Revive.ContractEmitted');
});

test('ethHashOf: keccak-256 of the bare payload bytes of Revive.ethTransact only', () => {
  const bare = new Uint8Array(0);
  const prefixed = Uint8Array.of(0);
  // toU8a(true) is the bare payload; toU8a() would add the SCALE length prefix
  const payload = { toU8a: (isBare?: boolean) => (isBare ? bare : prefixed) };
  const x = { method: { section: 'revive', method: 'ethTransact', args: [payload] } };
  assert.equal(isEthTransact(x), true);
  assert.equal(ethHashOf(x), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(ethHashOf({ method: { section: 'revive', method: 'call', args: [payload] } }), null);
});

test('eventsOf and isInherent', () => {
  const block: Loose = { events: [success('Mandatory'), rec('system', 'ExtrinsicSuccess', [['dispatch_info', 'DispatchEventInfo', { class: { toString: () => 'Mandatory' } }]], 0), rec('treasury', 'UpdatedInactive', [], null)] };
  assert.equal(eventsOf(block, 1).length, 1);
  assert.equal(eventsOf(block, 0).length, 1);
  const unsigned = { isSigned: false, method: { section: 'timestamp', method: 'set' } };
  assert.equal(isInherent(unsigned, eventsOf(block, 0)), true);
  assert.equal(isInherent({ ...unsigned, isSigned: true }, eventsOf(block, 0)), false);
  assert.equal(isInherent({ isSigned: false, method: { section: 'revive', method: 'ethTransact' } }, eventsOf(block, 0)), false);
  assert.equal(isInherent(unsigned, [success('Normal')]), false);
});

test('describeDispatchError: a module error by name and text, and the other kinds by type', () => {
  assert.equal(describeDispatchError(registry, moduleErr(6, 2)), 'Balances.InsufficientBalance: Balance too low to send value');
  assert.equal(describeDispatchError(registry, { isModule: false, type: 'Token', value: { type: 'FundsUnavailable' } }), 'Token.FundsUnavailable');
  assert.equal(describeDispatchError(registry, { isModule: false, type: 'BadOrigin', value: null }), 'BadOrigin');
  assert.equal(describeDispatchError(registry, moduleErr(99, 1)), "a module error (module 99, error 1) that this block's metadata does not name");
});

test('outcomeOf: success, a failure, a reverted Ethereum transaction, and inner calls that failed', () => {
  assert.deepEqual(outcomeOf(registry, [feePaid(1n), success()]), { ok: true, text: 'success', ethRevert: null, inner: [] });
  const failed = outcomeOf(registry, [feePaid(1n), rec('system', 'ExtrinsicFailed', [['dispatch_error', 'DispatchError', moduleErr(6, 2)], ['dispatch_info', 'DispatchEventInfo', {}]])]);
  assert.equal(failed.ok, false);
  assert.equal(failed.text, 'FAILED: Balances.InsufficientBalance: Balance too low to send value');
  assert.deepEqual(failed.inner, []);
  // an Ethereum transaction that reverted: the extrinsic itself succeeds
  const reverted = outcomeOf(registry, [rec('revive', 'EthExtrinsicRevert', [['dispatch_error', 'DispatchError', moduleErr(80, 11)]]), feePaid(1n), success()]);
  assert.equal(reverted.ok, true);
  assert.equal(reverted.ethRevert, 'Revive.ContractTrapped: Contract trapped during execution');
  assert.deepEqual(reverted.inner, []);
  // Sudo.Sudid { sudo_result: DispatchResult } and Utility.ItemFailed { error: DispatchError }
  const inner = outcomeOf(registry, [rec('sudo', 'Sudid', [['sudo_result', 'DispatchResult', errOf(moduleErr(6, 2))]]), rec('utility', 'ItemFailed', [['error', 'DispatchError', { isModule: false, type: 'Token', value: { type: 'FundsUnavailable' } }]]), rec('sudo', 'Sudid', [['sudo_result', 'DispatchResult', ok]]), success()]);
  assert.equal(inner.ok, true);
  assert.deepEqual(inner.inner, ['Sudo.Sudid: Balances.InsufficientBalance: Balance too low to send value', 'Utility.ItemFailed: Token.FundsUnavailable']);
  assert.match(outcomeOf(registry, []).text, /no result event/);
});

test('feeOf: TransactionFeePaid (the actual fee includes the tip), an asset fee, or none', () => {
  const f = feeOf([feePaid(1580375464789n, 5n)]);
  assert.equal(f?.fee, 1580375464789n);
  assert.equal(f?.tip, 5n);
  assert.equal(f?.assetId, null);
  const asset = feeOf([rec('assetTxPayment', 'AssetTxFeePaid', [['who', '', val('5x')], ['actual_fee', '', val(7n)], ['tip', '', val(0n)], ['asset_id', '', val(1984)]])]);
  assert.equal(asset?.fee, 7n);
  assert.equal(asset?.assetId, '1984');
  assert.equal(feeOf([success()]), null);
});

test('depositHeld: storage and code deposits apart, and releases', () => {
  const held = (reason: string, amount: bigint, method = 'Held') => rec('balances', method, [['reason', '', { revive: reason }], ['who', '', val('5x')], ['amount', '', val(amount)]]);
  // the deposits of an Ethereum deployment on the testnet (block 354887, Nov 6, 2026)
  const deploy = [held('CodeUploadDepositReserve', 38436000000000000n), held('StorageDepositReserve', 12679950000000000n)];
  assert.deepEqual(depositHeld(deploy), { held: 12679950000000000n, code: 38436000000000000n, released: 0n });
  assert.deepEqual(depositHeld([held('StorageDepositReserve', 384150000000000n, 'Released')]), { held: 0n, code: 0n, released: 384150000000000n });
  // holds for other reasons are not deposits of a contract
  assert.deepEqual(depositHeld([rec('balances', 'Held', [['reason', '', { preimage: 'Preimage' }], ['who', '', val('5x')], ['amount', '', val(5n)]])]), { held: 0n, code: 0n, released: 0n });
});

test('shortEvent and argText: native amounts in tokens, bytes as hex, long values cut', () => {
  const transfer = rec('balances', 'Transfer', [['from', 'T::AccountId', val('5A')], ['to', 'T::AccountId', val('5B')], ['amount', 'T::Balance', val('1000000000000')]]);
  assert.equal(shortEvent(registry, transfer, testnet), 'Balances.Transfer { from: 5A, to: 5B, amount: 1000000000000 (0.01 tPOT) }');
  // amounts of other modules are not assumed to be tPOT
  const assets = rec('assets', 'Transferred', [['asset_id', 'T::AssetId', val(7)], ['amount', 'T::Balance', val('1000000000000')]]);
  assert.equal(shortEvent(registry, assets, testnet), 'Assets.Transferred { assetId: 7, amount: 1000000000000 }');
  const emitted = rec('revive', 'ContractEmitted', [['contract', 'H160', val('0xab')], ['data', 'Vec<u8>', val(`0x${'00'.repeat(200)}`, 'Bytes')]]);
  const s = shortEvent(registry, emitted, testnet);
  assert.equal(s.length, 200);
  assert.ok(s.startsWith('Revive.ContractEmitted { contract: 0xab, data: 0x0000'));
  assert.ok(s.endsWith('...'));
  assert.equal(argText(val('', 'Bytes')), '0x (empty)');
  // text that someone put on the chain is shown as one quoted string, so it cannot pass for a line of the tool
  assert.equal(argText(val('native call from a 0x account, test 1', 'Bytes')), '"native call from a 0x account, test 1"');
  assert.equal(argText(val('hello\nNext: do something', 'Bytes')), '"hello\\nNext: do something"');
  assert.equal(argText(val({ id: '5A' })), '{"id":"5A"}');
});

test('matchEvents: same block, topics and data, in order; logs the node lacks are reported', () => {
  const t0 = `0x${'11'.repeat(32)}`;
  const ev = (block: number, data: string): NodeEvent => ({ block, extrinsic: 1, phase: 'ApplyExtrinsic', topics: [t0], data });
  const log = (block: number, data: string): EthLog => ({ blockNumber: `0x${block.toString(16)}`, topics: [t0.toUpperCase().replace('0X', '0x')], data });
  const nodeEvents = [ev(10, '0x01'), ev(10, '0x01'), ev(11, '0x02'), ev(12, '0x03')];
  const logs = [log(10, '0x01'), log(11, '0x02'), log(13, '0x04')];
  const { logOf, unmatched } = matchEvents(nodeEvents, logs);
  assert.deepEqual(logOf, [0, -1, 1, -1]);
  assert.deepEqual(unmatched, [2]);
  // a different number of topics does not match
  assert.deepEqual(matchEvents([{ ...ev(10, '0x01'), topics: [t0, t0] }], [log(10, '0x01')]).logOf, [-1]);
});

test('links: the explorer page of an extrinsic and the Node Console page of a block', () => {
  assert.equal(explorerExtrinsicUrl(testnet, 452626, 1), 'https://scanner-testnet-v3.portaldot.dev/#/extrinsics/452626-1');
  assert.equal(explorerExtrinsicUrl(NETWORKS.mainnet, 1000, 0), 'https://scanner-live-v3.portaldot.dev/#/extrinsics/1000-0');
  assert.equal(explorerExtrinsicUrl({ ...testnet, overridden: true }, 1, 1), null);
  assert.equal(nodeConsoleBlockUrl(testnet, 452626), 'https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/452626');
});
