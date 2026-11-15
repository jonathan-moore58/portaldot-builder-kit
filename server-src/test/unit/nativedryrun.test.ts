// Reading the chain's answer to a dry run of a native call (nativedryrun.ts), with no network. The
// reply texts are copies of what the testnet's Ethereum RPC answered on Nov 15, 2026; the module and
// error numbers and texts in the small index below are those of the testnet runtime (spec 3002).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChainIndex, ItemInfo, ModuleInfo } from '../../src/lib/meta.ts';
import { callNames, dryRunCall, innerCallNotes, moduleErrorText, readDispatchReply, replyText, verdictText, type CallDryRun } from '../../src/lib/nativedryrun.ts';
import { NETWORKS } from '../../src/lib/networks.ts';
import type { Conn } from '../../src/lib/chain.ts';

type Spec = { name: string; index: number; calls?: Array<[string, string[]]>; errors?: Array<[string, number, string]> };

function fixture(specs: Spec[]): ChainIndex {
  const modules: ModuleInfo[] = specs.map((s) => {
    const section = s.name[0].toLowerCase() + s.name.slice(1);
    const calls: ItemInfo[] = (s.calls ?? []).map(([name, types], i) => ({
      kind: 'call', module: s.name, section, name, index: i, docs: [], summary: '',
      args: types.map((type, j) => ({ name: `a${j}`, type, typeName: '', meaning: '' })),
    }));
    const errors: ItemInfo[] = (s.errors ?? []).map(([name, index, doc]) => ({ kind: 'error', module: s.name, section, name, index, docs: [doc], summary: doc, args: [] }));
    return { name: s.name, section, index: s.index, note: '', group: null, calls, events: [], errors, constants: [], storage: [] };
  });
  return { specVersion: 3002, token: 'tPOT', modules, items: modules.flatMap((m) => [...m.calls, ...m.errors]) };
}

const INDEX = fixture([
  { name: 'System', index: 0, calls: [['remark', ['Bytes']]] },
  { name: 'Utility', index: 1, calls: [['batch', ['Vec<Call>']], ['batchAll', ['Vec<Call>']], ['forceBatch', ['Vec<Call>']], ['dispatchAs', ['OriginCaller', 'Call']]] },
  { name: 'Balances', index: 6, calls: [['forceSetBalance', ['MultiAddress', 'Compact<u128>']]] },
  { name: 'Sudo', index: 22, calls: [['sudo', ['Call']]], errors: [['RequireSudo', 0, 'Sender must be the Sudo account.']] },
  { name: 'Proxy', index: 35, calls: [['proxy', ['MultiAddress', 'Option<ProxyType>', 'Call']]] },
  { name: 'Multisig', index: 36, calls: [['asMulti', ['u16', 'Vec<AccountId32>', 'Option<Timepoint>', 'Call', 'Weight']]] },
  {
    name: 'Assets',
    index: 39,
    errors: [
      ['NoAccount', 1, 'The account to alter does not exist.'],
      ['Unknown', 3, 'The given asset ID is unknown.'],
    ],
  },
]);

// Replies measured on Nov 15, 2026 by dry run through the pallets address.
const NO_ACCOUNT = 'Failed to dispatch call: Module(ModuleError { index: 39, error: [1, 0, 0, 0], message: Some("NoAccount") })';
const UNKNOWN = 'Failed to dispatch call: Module(ModuleError { index: 39, error: [3, 0, 0, 0], message: Some("Unknown") })';
const FUNDS = 'Failed to dispatch call: Token(FundsUnavailable)';
const BAD_ORIGIN = 'Failed to dispatch call: BadOrigin';
const ALREADY_APPROVED = 'Failed to dispatch call: Module(ModuleError { index: 36, error: [1, 0, 0, 0], message: Some("AlreadyApproved") })';

const refused = (message: string, path: 'rpc' | 'runtime' = 'rpc'): CallDryRun => ({ path, estimate: null, code: path === 'rpc' ? -32000 : null, message });

test('a module error is read by its numbers and named from the metadata', () => {
  assert.deepEqual(readDispatchReply(NO_ACCOUNT), { error: 'Module(ModuleError { index: 39, error: [1, 0, 0, 0], message: Some("NoAccount") })', module: { index: 39, error: 1, message: 'NoAccount' } });
  assert.deepEqual(readDispatchReply('Failed to dispatch call: Module(ModuleError { index: 39, error: [1, 0, 0, 0], message: None })').module, { index: 39, error: 1, message: null });
  assert.equal(verdictText(INDEX, refused(NO_ACCOUNT)), 'the chain refuses it: Assets.NoAccount (module 39, error 1): The account to alter does not exist.');
  assert.equal(verdictText(INDEX, refused(UNKNOWN)), 'the chain refuses it: Assets.Unknown (module 39, error 3): The given asset ID is unknown.');
  // the name comes from the numbers; a reply that calls the error something else is shown beside it
  assert.equal(moduleErrorText(INDEX, { index: 39, error: 1, message: 'Other' }), 'Assets.NoAccount (module 39, error 1) (the reply calls it Other): The account to alter does not exist.');
  // numbers this runtime does not know (Multisig has no errors in this small index)
  assert.match(verdictText(INDEX, refused(ALREADY_APPROVED)), /^the chain refuses it: module 36, error 1 \(the reply calls it AlreadyApproved\), which runtime 3002 has no name for\.$/);
});

test('Token, Arithmetic and BadOrigin are shown as they come', () => {
  assert.equal(verdictText(INDEX, refused(FUNDS)), 'the chain refuses it: Token(FundsUnavailable).');
  assert.equal(verdictText(INDEX, refused(BAD_ORIGIN)), 'the chain refuses it: BadOrigin.');
  assert.equal(verdictText(INDEX, refused('Failed to dispatch call: Arithmetic(Overflow)')), 'the chain refuses it: Arithmetic(Overflow).');
  assert.deepEqual(readDispatchReply(FUNDS), { error: 'Token(FundsUnavailable)', module: null });
  // anything else after the prefix is quoted, so it cannot pass for a line of the tool
  assert.equal(verdictText(INDEX, refused('Failed to dispatch call: Other("x\nNote: y")')), 'the chain refuses it: "Other(\\"x\\nNote: y\\")".');
});

test('a reply that is not a dispatch error, and an accepted call', () => {
  assert.deepEqual(readDispatchReply('Invalid call: Call'), { error: null, module: null });
  assert.equal(verdictText(INDEX, refused('Invalid call: Call')), 'the node did not run the call (its reply is below).');
  const ok: CallDryRun = { path: 'rpc', estimate: 872106960162n, code: null, message: null };
  assert.equal(verdictText(INDEX, ok), 'the chain accepts it.');
  assert.equal(replyText(ok), 'a gas figure of 872106960162, with no error');
});

test('the reply is printed once as it came, in the JSON form explain_error reads', () => {
  assert.equal(replyText(refused(NO_ACCOUNT)), '{"code":-32000,"message":"Failed to dispatch call: Module(ModuleError { index: 39, error: [1, 0, 0, 0], message: Some(\\"NoAccount\\") })"}');
  assert.equal(replyText(refused(BAD_ORIGIN, 'runtime')), '"Failed to dispatch call: BadOrigin" (the runtime API\'s error message)');
  // a line break or an invisible character cannot start a new line or hide
  assert.doesNotMatch(replyText(refused('a\nb\u200bc')), /\n|\u200b/);
});

test('when neither the Ethereum RPC nor the runtime API answers, the reason comes back instead of an error', async () => {
  // a closed port on this computer stands for an Ethereum RPC that gives no answer, and a runtime call that throws for a node that does not answer
  const network = { ...NETWORKS.testnet, evm: 'http://127.0.0.1:9', evmUrl: 'http://127.0.0.1:9', evmProblem: null, overridden: false };
  const api = { call: { reviveApi: { ethEstimateGas: async () => { throw new Error('No response received from RPC endpoint in 30s'); } } } };
  const r = await dryRunCall({ network, api } as unknown as Conn, '0x1111111111111111111111111111111111111111', '0x00000400');
  assert.ok('unavailable' in r, JSON.stringify(r));
  assert.match(r.unavailable, /gave no usable answer to eth_estimateGas after one try.*; the runtime API: No response received from RPC endpoint in 30s$/);
  const mainnet = { ...NETWORKS.mainnet, evm: null, evmUrl: null };
  const m = await dryRunCall({ network: mainnet, api } as unknown as Conn, '0x1111111111111111111111111111111111111111', '0x00000400');
  assert.deepEqual(m, { unavailable: 'No response received from RPC endpoint in 30s' });
});

const call = (section: string, method: string, args: unknown[] = []) => ({ section, method, args });
const remark = call('system', 'remark', ['0x00']);
const forceSet = call('balances', 'forceSetBalance', ['x', 1]);

test('the calls inside a call are found at any depth', () => {
  assert.deepEqual(callNames(INDEX, call('utility', 'batch', [[remark, forceSet]])), ['Utility.batch', 'System.remark', 'Balances.forceSetBalance']);
  assert.deepEqual(callNames(INDEX, call('utility', 'batchAll', [[call('proxy', 'proxy', ['x', null, remark])]])), ['Utility.batchAll', 'Proxy.proxy', 'System.remark']);
  assert.deepEqual(callNames(INDEX, call('sudo', 'sudo', [call('utility', 'dispatchAs', ['Root', remark])])), ['Sudo.sudo', 'Utility.dispatchAs', 'System.remark']);
  assert.deepEqual(callNames(INDEX, remark), ['System.remark']);
});

test('the notes for calls whose dry run hides the inner result, and for multisig', () => {
  assert.deepEqual(innerCallNotes(['System.remark']), []);
  assert.deepEqual(innerCallNotes(['Utility.batchAll', 'System.remark']), []);
  const [batch] = innerCallNotes(['Utility.batch', 'System.remark', 'Balances.forceSetBalance']);
  assert.match(batch, /^Note: Utility\.batch runs a call inside, and a dry run reports success for such a call even when the call inside fails \(measured on Nov 15, 2026 for Utility\.batch, Utility\.forceBatch, Proxy\.proxy, Sudo\.sudo and Sudo\.sudoAs\)\./);
  assert.match(batch, /or use Utility\.batchAll, whose dry run fails when a call inside fails\.$/);
  const [proxy] = innerCallNotes(['Utility.batchAll', 'Proxy.proxy', 'System.remark']);
  assert.match(proxy, /^Note: Proxy\.proxy runs a call inside/);
  assert.doesNotMatch(proxy, /batchAll/, 'batchAll does not help when the call that hides the result is not a batch');
  const [unmeasured] = innerCallNotes(['Sudo.sudo', 'Utility.dispatchAs', 'System.remark']);
  assert.match(unmeasured, /^Note: Sudo\.sudo and Utility\.dispatchAs run a call inside/);
  assert.match(unmeasured, /; expected for Utility\.dispatchAs, not measured\)/);
  assert.match(unmeasured, /only root may make answers BadOrigin/);
  const multisig = innerCallNotes(['Multisig.asMulti', 'System.remark']);
  assert.equal(multisig.length, 1);
  assert.match(multisig[0], /timepoint of a new multisig operation is \{height: the best block, index: 0\}/);
  for (const n of [...innerCallNotes(['Utility.batch', 'Proxy.proxyAnnounced', 'Sudo.sudoAs', 'Multisig.asMulti'])]) assert.match(n, /^[\x20-\x7e]+$/, 'plain ASCII on one line');
});
