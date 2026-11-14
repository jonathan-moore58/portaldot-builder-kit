// Finding items by name (resolveRef), what types mean (explainType), and how items are written
// (signature, codeSample). No network: the index is built by hand below, with names, indices and
// argument lists copied from the testnet runtime (spec 3002) on Nov 14, 2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_OF, MODULE_NOTES, withToken, type ItemKind } from '../../src/lib/knowledge.ts';
import { codeSample, explainType, findModule, fullName, normName, resolveRef, signature, type ArgInfo, type ChainIndex, type ItemInfo, type ModuleInfo } from '../../src/lib/meta.ts';

type Entry = [name: string, args?: string[], summary?: string];
interface Spec { name: string; index: number; call?: Entry[]; event?: Entry[]; error?: Entry[]; constant?: Entry[]; storage?: Entry[] }

/** A ChainIndex from a few modules, shaped the way buildIndex shapes the live one. */
function buildFixture(specs: Spec[], token = 'tPOT'): ChainIndex {
  const modules: ModuleInfo[] = specs.map((s) => {
    const section = s.name[0].toLowerCase() + s.name.slice(1);
    const make = (kind: ItemKind, list: Entry[] = []): ItemInfo[] =>
      list.map(([name, args = [], summary = ''], i) => ({
        kind, module: s.name, section, name, index: kind === 'constant' || kind === 'storage' ? null : i,
        args: kind === 'storage' ? [] : args.map((a): ArgInfo => ({ name: a, type: '', typeName: '', meaning: '' })),
        docs: summary ? [summary] : [], summary,
        ...(kind === 'storage' ? { keyTypes: args, valueType: 'X', optional: false } : {}),
        ...(kind === 'constant' ? { value: '1', valueType: 'u128' } : {}),
      }));
    return { name: s.name, section, index: s.index, note: withToken(MODULE_NOTES[s.name] ?? '', token), group: GROUP_OF.get(s.name) ?? null,
      calls: make('call', s.call), events: make('event', s.event), errors: make('error', s.error), constants: make('constant', s.constant), storage: make('storage', s.storage) };
  });
  return { specVersion: 3002, token, modules, items: modules.flatMap((m) => [...m.calls, ...m.events, ...m.errors, ...m.constants, ...m.storage]) };
}

const INDEX = buildFixture([
  { name: 'System', index: 0, call: [['remark', ['remark']], ['remarkWithEvent', ['remark']]], event: [['Remarked', ['sender', 'hash']]], storage: [['account', ['AccountId32']], ['number']] },
  { name: 'Balances', index: 6, call: [['transferAllowDeath', ['dest', 'value']], ['transferKeepAlive', ['dest', 'value']]],
    event: [['Transfer', ['from', 'to', 'amount']]], error: [['InsufficientBalance'], ['ExistentialDeposit']], constant: [['existentialDeposit']], storage: [['totalIssuance']] },
  { name: 'Staking', index: 11, call: [['bond', ['value', 'payee']]], event: [['Bonded', ['stash', 'amount']]], storage: [['bonded', ['AccountId32']], ['ledger', ['AccountId32']]] },
  { name: 'Sudo', index: 22, call: [['sudo', ['call']]], storage: [['key']] },
  { name: 'Assets', index: 39, call: [['create', ['id', 'admin', 'minBalance']]], event: [['Frozen', ['assetId', 'who']]], error: [['Frozen']], storage: [['account', ['u32', 'AccountId32']]] },
  { name: 'Revive', index: 80, call: [['call', ['dest', 'value', 'weightLimit', 'storageDepositLimit', 'data']]], event: [['ContractEmitted', ['contract', 'data', 'topics']]] },
]);

const one = (ref: string, kind?: ItemKind): ItemInfo => {
  const r = resolveRef(INDEX, ref, kind);
  assert.equal(r.items.length, 1, `${ref}: ${r.items.map(fullName).join(', ')}`);
  return r.items[0];
};

test('normName and findModule ignore case, underscores and spaces', () => {
  assert.equal(normName('transfer_keep_alive'), 'transferkeepalive');
  assert.equal(normName('Transfer Keep Alive'), 'transferkeepalive');
  assert.equal(findModule(INDEX, 'balances')?.name, 'Balances');
  assert.equal(findModule(INDEX, 'BALANCES')?.name, 'Balances');
  assert.equal(findModule(INDEX, 'pallet_balances'), undefined);
});

test('resolveRef: every spelling of Balances.transferKeepAlive', () => {
  for (const ref of ['Balances.transferKeepAlive', 'balances::transfer_keep_alive', 'api.tx.balances.transferKeepAlive(dest, value)', 'Balances/transferKeepAlive', 'balances.TRANSFERKEEPALIVE', '  Balances.transferKeepAlive  ', 'Balances transfer keep alive']) {
    const it = one(ref);
    assert.equal(fullName(it), 'Balances.transferKeepAlive', ref);
    assert.equal(it.kind, 'call');
    assert.equal(resolveRef(INDEX, ref).module?.name, 'Balances', ref);
  }
  const bare = resolveRef(INDEX, 'transferKeepAlive');
  assert.equal(bare.module, undefined);
  assert.deepEqual(bare.items.map(fullName), ['Balances.transferKeepAlive']);
});

test('resolveRef: the api prefixes of @polkadot/api', () => {
  assert.equal(fullName(one('api.query.system.account')), 'System.account');
  assert.equal(fullName(one('api.consts.balances.existentialDeposit')), 'Balances.existentialDeposit');
  assert.equal(one('api.consts.balances.existentialDeposit').kind, 'constant');
  assert.equal(one('api.errors.balances.ExistentialDeposit').kind, 'error');
  assert.equal(one('api.events.balances.Transfer').kind, 'event');
});

test('resolveRef: a module name alone', () => {
  const r = resolveRef(INDEX, 'Balances');
  assert.equal(r.module?.name, 'Balances');
  assert.deepEqual(r.items, []);
  assert.equal(resolveRef(INDEX, 'balances').module?.name, 'Balances');
  // with a kind, a module name is looked up as an item, and the module is still given
  const k = resolveRef(INDEX, 'Balances', 'call');
  assert.equal(k.module?.name, 'Balances');
  assert.deepEqual(k.items, []);
  // a module that also has an item of its own name: the module wins without a kind, the item with one
  assert.deepEqual(resolveRef(INDEX, 'sudo').items, []);
  assert.equal(resolveRef(INDEX, 'sudo').module?.name, 'Sudo');
  assert.equal(fullName(one('sudo', 'call')), 'Sudo.sudo');
});

test('resolveRef: names that differ only by case pick the one written exactly so', () => {
  assert.equal(one('Balances.existentialDeposit').kind, 'constant');
  assert.equal(one('Balances.ExistentialDeposit').kind, 'error');
  assert.equal(one('balances::existential_deposit').kind, 'constant', 'snake_case becomes the camelCase name');
  assert.equal(one('Staking.bonded').kind, 'storage');
  assert.equal(one('Staking.Bonded').kind, 'event');
  // written neither way: both are offered, so the caller can choose
  assert.deepEqual(resolveRef(INDEX, 'Balances.EXISTENTIALDEPOSIT').items.map((i) => i.kind).sort(), ['constant', 'error']);
  // a kind settles it whatever the case
  assert.equal(one('Balances.EXISTENTIALDEPOSIT', 'constant').kind, 'constant');
  assert.equal(one('Balances.existentialdeposit', 'error').kind, 'error');
});

test('resolveRef: two items with exactly the same name are both returned, and a kind settles it', () => {
  assert.deepEqual(resolveRef(INDEX, 'Assets.Frozen').items.map((i) => i.kind).sort(), ['error', 'event']);
  assert.equal(one('Assets.Frozen', 'error').kind, 'error');
});

test('resolveRef: the api.errors. or api.events. prefix says which kind is meant', () => {
  assert.equal(one('api.errors.assets.Frozen').kind, 'error');
  assert.equal(one('api.events.assets.Frozen').kind, 'event');
});

test('resolveRef: a bare name written exactly like one of two items picks that item', () => {
  assert.equal(one('existentialDeposit').kind, 'constant');
  assert.equal(one('ExistentialDeposit').kind, 'error');
});

test('resolveRef: names that do not exist', () => {
  assert.deepEqual(resolveRef(INDEX, 'Balances.transfer').items.map(fullName), ['Balances.Transfer'], 'only the event: this runtime has no call named transfer');
  const r = resolveRef(INDEX, 'Balances.nothing');
  assert.equal(r.module?.name, 'Balances');
  assert.deepEqual(r.items, []);
  assert.deepEqual(resolveRef(INDEX, 'Nope.transfer'), { items: [] });
  assert.deepEqual(resolveRef(INDEX, ''), { items: [] });
  assert.deepEqual(resolveRef(INDEX, '::'), { items: [] });
  // a Rust path names the same call: the pallet_ prefix and the Call segment are understood
  assert.deepEqual(resolveRef(INDEX, 'pallet_balances::Call::transfer_keep_alive').items.map(fullName), ['Balances.transferKeepAlive']);
});

test('explainType: amounts', () => {
  const native = 'an amount in the smallest unit: 1 tPOT is 1 followed by 14 zeros (10n ** 14n in code)';
  assert.equal(explainType('Compact<u128>', 'Balance', 'Balances', 'tPOT'), native);
  assert.equal(explainType('Compact<u128>', 'BalanceOf', 'Revive', 'tPOT'), native);
  assert.equal(explainType('Compact<u128>', 'BalanceOf', 'Staking', 'POT'), native.replace('tPOT', 'POT'));
  assert.equal(explainType('u128', 'Balance', 'Assets', 'tPOT'), "an amount, counted in the token's smallest unit");
  assert.equal(explainType('u128', 'AssetBalanceOf', 'Revive', 'tPOT'), "an amount, counted in the token's smallest unit");
  assert.equal(explainType('u128', 'BalanceOf', 'MultiAssetBounties', 'tPOT'), "an amount, counted in the token's smallest unit");
  assert.equal(explainType('Option<u128>', 'Option<BalanceOf>', 'Balances', 'tPOT'), `optional. When given: ${native}`);
});

test('explainType: addresses, hashes and plain values', () => {
  const ss58 = 'an account address in SS58 form (it starts with 5), not a 0x address';
  assert.equal(explainType('MultiAddress', 'AccountIdLookupOf', 'Balances', 'tPOT'), ss58);
  assert.equal(explainType('AccountId32', 'AccountId', 'System', 'tPOT'), ss58);
  assert.equal(explainType('AccountId32', '', 'System', 'tPOT'), ss58);
  assert.equal(explainType('H160', 'H160', 'Revive', 'tPOT'), 'an Ethereum-style address: 0x and 40 hex characters');
  assert.equal(explainType('H256', '', 'System', 'tPOT'), 'a 32-byte hash: 0x and 64 hex characters');
  assert.equal(explainType('U256', '', 'Revive', 'tPOT'), 'a 256-bit number');
  assert.equal(explainType('bool', 'bool', 'Balances', 'tPOT'), 'true or false');
  assert.equal(explainType('Bytes', 'Bytes', 'Revive', 'tPOT'), 'raw bytes, written as 0x and hex characters');
  assert.equal(explainType('Vec<u8>', 'Vec<u8>', 'System', 'tPOT'), 'raw bytes, written as 0x and hex characters');
  assert.equal(explainType('Compact<u32>', 'AssetIdParameter', 'Assets', 'tPOT'), 'the id number of a token');
  assert.equal(explainType('u32', 'CollectionId', 'Nfts', 'tPOT'), 'the id number of an NFT collection');
  assert.equal(explainType('u32', 'ItemId', 'Nfts', 'tPOT'), 'the number of an NFT inside its collection');
  assert.equal(explainType('u32', 'PoolId', 'NominationPools', 'tPOT'), 'the id number of a pool');
  assert.equal(explainType('u32', 'BlockNumberFor', 'Scheduler', 'tPOT'), 'a block number, or a count of blocks');
  assert.equal(explainType('SpWeightsWeightV2Weight', 'Weight', 'Revive', 'tPOT'), 'a limit on computing work, like a gas limit: { refTime, proofSize }');
  assert.equal(explainType('Call', 'RuntimeCall', 'Sudo', 'tPOT'), 'another call, wrapped inside this one');
  assert.equal(explainType('(Bytes,Bytes)', 'RuntimeCallNameOf', 'TxPause', 'tPOT'), "two pieces of text, as bytes: the module's name and the call's name");
  assert.equal(explainType('u128', 'FixedU128', 'AssetRate', 'tPOT'), 'a number with 18 decimal places: 1 is 1 followed by 18 zeros');
  assert.equal(explainType('u64', 'u64', 'System', 'tPOT'), 'a whole number');
  assert.equal(explainType('Compact<u16>', '', 'System', 'tPOT'), 'a whole number');
  assert.equal(explainType('Perbill', 'Perbill', 'Staking', 'tPOT'), 'a fraction');
  assert.equal(explainType('Text', '', 'System', 'tPOT'), '');
});

test('explainType: lists and options', () => {
  assert.equal(explainType('Vec<AccountId32>', 'Vec<AccountId>', 'Multisig', 'tPOT'), 'a list. Each entry: an account address in SS58 form (it starts with 5), not a 0x address');
  assert.equal(explainType('Vec<Call>', 'Vec<RuntimeCall>', 'Utility', 'tPOT'), 'a list. Each entry: another call, wrapped inside this one');
  assert.equal(explainType('Vec<PalletFoo>', '', 'System', 'tPOT'), 'a list');
  assert.equal(explainType('Option<u32>', 'Option<BlockNumberFor>', 'Scheduler', 'tPOT'), 'optional. When given: a block number, or a count of blocks');
  assert.equal(explainType('Option<PalletMultisigTimepoint>', 'Option<Timepoint>', 'Multisig', 'tPOT'), 'optional');
});

test('explainType: an NFT price is an amount, not just a whole number', () => {
  assert.match(explainType('u128', 'ItemPrice', 'Nfts', 'tPOT'), /amount/);
});

test('signature for every kind', () => {
  assert.equal(signature(one('Balances.transferKeepAlive')), 'transferKeepAlive(dest, value)');
  assert.equal(signature(one('Balances.Transfer')), 'Transfer { from, to, amount }');
  assert.equal(signature(one('Balances.InsufficientBalance')), 'InsufficientBalance');
  assert.equal(signature(one('Balances.existentialDeposit')), 'existentialDeposit');
  assert.equal(signature(one('System.account')), 'account(AccountId32)');
  assert.equal(signature(one('Assets.account', 'storage')), 'account(u32, AccountId32)');
  assert.equal(signature(one('System.number')), 'number');
  const noArgs = { ...one('Balances.Transfer'), args: [] };
  assert.equal(signature(noArgs), 'Transfer');
});

test('codeSample for every kind', () => {
  assert.equal(codeSample(one('Balances.transferKeepAlive')), 'await api.tx.balances.transferKeepAlive(dest, value).signAndSend(account);');
  assert.equal(codeSample(one('Balances.Transfer')), 'if (api.events.balances.Transfer.is(event)) {\n  const [from, to, amount] = event.data;\n}');
  assert.equal(codeSample({ ...one('Balances.Transfer'), args: [] }), 'if (api.events.balances.Transfer.is(event)) { /* it happened */ }');
  assert.equal(codeSample(one('Balances.InsufficientBalance')), 'if (api.errors.balances.InsufficientBalance.is(dispatchError.asModule)) { /* the call failed for this reason */ }');
  assert.equal(codeSample(one('Balances.existentialDeposit')), 'api.consts.balances.existentialDeposit');
  assert.equal(codeSample(one('System.account')), 'await api.query.system.account(key);');
  assert.equal(codeSample(one('Assets.account', 'storage')), 'await api.query.assets.account(key1, key2);');
  assert.equal(codeSample(one('System.number')), 'await api.query.system.number();');
});
