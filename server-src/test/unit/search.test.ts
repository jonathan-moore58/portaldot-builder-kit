// The ranking rules of searchChain, on a small index built by hand (names, argument lists and the
// chain's own first lines copied from the testnet runtime, spec 3002, on Nov 14, 2026). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_OF, JOBS, MODULE_NOTES, withToken, type ItemKind } from '../../src/lib/knowledge.ts';
import { fullName, type ArgInfo, type ChainIndex, type ItemInfo, type ModuleInfo } from '../../src/lib/meta.ts';
import { searchChain, type Hit } from '../../src/lib/search.ts';

type Entry = [name: string, args?: string[], summary?: string];
interface Spec { name: string; index: number; call?: Entry[]; event?: Entry[]; error?: Entry[]; constant?: Entry[]; storage?: Entry[] }

function buildFixture(specs: Spec[], token = 'tPOT'): ChainIndex {
  const modules: ModuleInfo[] = specs.map((s) => {
    const section = s.name[0].toLowerCase() + s.name.slice(1);
    const make = (kind: ItemKind, list: Entry[] = []): ItemInfo[] =>
      list.map(([name, args = [], summary = ''], i) => ({
        kind, module: s.name, section, name, index: kind === 'constant' || kind === 'storage' ? null : i,
        args: kind === 'storage' ? [] : args.map((a): ArgInfo => ({ name: a, type: '', typeName: '', meaning: '' })),
        docs: summary ? [summary] : [], summary,
        ...(kind === 'storage' ? { keyTypes: args, valueType: 'X', optional: false } : {}),
      }));
    return { name: s.name, section, index: s.index, note: withToken(MODULE_NOTES[s.name] ?? '', token), group: GROUP_OF.get(s.name) ?? null,
      calls: make('call', s.call), events: make('event', s.event), errors: make('error', s.error), constants: make('constant', s.constant), storage: make('storage', s.storage) };
  });
  return { specVersion: 3002, token, modules, items: modules.flatMap((m) => [...m.calls, ...m.events, ...m.errors, ...m.constants, ...m.storage]) };
}

const INDEX = buildFixture([
  { name: 'System', index: 0, call: [['remark', ['remark'], 'Make some on-chain remark.'], ['remarkWithEvent', ['remark'], 'Make some on-chain remark and emit event.']],
    event: [['Remarked', ['sender', 'hash'], 'On on-chain remark happened.']], storage: [['account', ['AccountId32'], 'The full account information for a particular account ID.']] },
  { name: 'Utility', index: 1, call: [['batch', ['calls'], 'Send a batch of dispatch calls.'], ['batchAll', ['calls'], 'Send a batch of dispatch calls and atomically execute them.']] },
  { name: 'Balances', index: 6,
    call: [['transferAllowDeath', ['dest', 'value'], 'Transfer some liquid free balance to another account.'], ['transferKeepAlive', ['dest', 'value'], 'Same as the transferAllowDeath call, but with a check that the transfer will not kill the origin account.'], ['transferAll', ['dest', 'keepAlive'], 'Transfer the entire transferable balance from the caller account.']],
    event: [['Transfer', ['from', 'to', 'amount'], 'Transfer succeeded.']], error: [['InsufficientBalance', [], 'Balance too low to send value.'], ['ExistentialDeposit', [], 'Value too low to create account due to existential deposit.']],
    constant: [['existentialDeposit', [], 'The minimum amount required to keep an account open.']], storage: [['totalIssuance', [], 'The total units issued in the system.']] },
  { name: 'Contracts', index: 21, call: [['instantiateWithCode', ['value', 'gasLimit', 'storageDepositLimit', 'code', 'data', 'salt'], 'Instantiates a new contract from the supplied code optionally transferring some balance.']] },
  { name: 'Assets', index: 39, call: [['create', ['id', 'admin', 'minBalance'], 'Issue a new class of fungible assets from a public origin.'], ['mint', ['id', 'beneficiary', 'amount'], 'Mint assets of a particular class.'], ['transfer', ['id', 'target', 'amount'], 'Move some assets from the sender account to another.']],
    event: [['Created', ['assetId', 'creator', 'owner'], 'Some asset class was created.']], storage: [['asset', ['u32'], 'Details of an asset.']] },
  { name: 'Uniques', index: 46, call: [['mint', ['collection', 'item', 'owner'], 'Mint an item of a particular collection.']] },
  { name: 'Nfts', index: 47, call: [['create', ['admin', 'config'], 'Issue a new collection of non-fungible items from a public origin.'], ['mint', ['collection', 'item', 'mintTo', 'witnessData'], 'Mint an item of a particular collection.']],
    event: [['Issued', ['collection', 'item', 'owner'], 'An item was issued.']], storage: [['collection', ['u32'], 'Details of a collection.']] },
  { name: 'Revive', index: 80, call: [['call', ['dest', 'value', 'weightLimit', 'storageDepositLimit', 'data'], 'Makes a call to an account, optionally transferring some balance.'], ['instantiateWithCode', ['value', 'weightLimit', 'storageDepositLimit', 'code', 'data', 'salt'], 'Instantiate a new contract from the supplied code.']],
    event: [['ContractEmitted', ['contract', 'data', 'topics'], 'A custom event emitted by the contract.']] },
]);

const name = (h: Hit): string => (h.item ? fullName(h.item) : `module ${h.module.name}`);
const top = (q: string, n = 3, kinds?: Parameters<typeof searchChain>[2]): string[] => searchChain(INDEX, q, kinds, 40).hits.slice(0, n).map(name);

test('an exact name wins', () => {
  assert.equal(top('transferKeepAlive', 1)[0], 'Balances.transferKeepAlive');
  assert.equal(top('Balances.transferKeepAlive', 1)[0], 'Balances.transferKeepAlive');
  assert.equal(top('balances::transfer_keep_alive', 1)[0], 'Balances.transferKeepAlive');
  assert.equal(top('Assets.mint', 1)[0], 'Assets.mint', 'the module in front picks among same-named calls');
  assert.equal(top('Nfts.mint', 1)[0], 'Nfts.mint');
  // the job "Write a note into a block" adds 20 to remarkWithEvent, and the exact name still wins
  assert.equal(top('remark', 1)[0], 'System.remark');
  assert.equal(top('Nfts', 1)[0], 'module Nfts', 'a module name finds the module first');
});

test('"mint nft" puts Nfts.mint first, and the job names it', () => {
  const r = searchChain(INDEX, 'mint nft', undefined, 12);
  assert.equal(r.jobs[0]?.job.id, 'nft');
  assert.equal(fullName(r.jobs[0].item), 'Nfts.mint');
  assert.equal(name(r.hits[0]), 'Nfts.mint');
  assert.ok(r.hits.findIndex((h) => name(h) === 'Uniques.mint') > 0, 'Uniques.mint is found too, through the nft synonym, below Nfts.mint');
  assert.ok(!r.hits.some((h) => name(h) === 'Assets.mint'), 'Assets.mint has nothing to do with nft');
});

test('jobs come first, and only when the index has the job\'s item', () => {
  const send = searchChain(INDEX, 'send', undefined, 12);
  assert.deepEqual(send.jobs.map((j) => j.job.id), ['send', 'sendtoken']);
  assert.equal(send.jobs[0].text, 'Send tPOT to another account', 'POT becomes the network symbol');
  assert.ok(top('send').includes('Balances.transferKeepAlive'), `top 3 for send: ${top('send').join(', ')}`);
  // the swap job names AssetConversion.swapExactTokensForTokens, which this index does not have
  assert.ok(JOBS.some((j) => j.id === 'swap'));
  assert.deepEqual(searchChain(INDEX, 'swap', undefined, 12).jobs, []);
  // jobs are at most three
  assert.ok(searchChain(INDEX, 'create', undefined, 12).jobs.length <= 3);
});

test('every query word must match somewhere', () => {
  assert.equal(searchChain(INDEX, 'transfer zebra', undefined, 12).total, 0);
  // a sentence of three or more words that matches nothing in full falls back to most of its words, and says so
  const sentence = searchChain(INDEX, 'transfer keep zebra', undefined, 12);
  assert.equal(sentence.loose, true);
  assert.ok(sentence.total > 0);
  assert.equal(searchChain(INDEX, 'transfer keep', undefined, 12).loose, false);
  assert.ok(searchChain(INDEX, 'transfer keep', undefined, 12).total > 0);
  assert.equal(top('transfer keep', 1)[0], 'Balances.transferKeepAlive');
});

test('stop words are ignored', () => {
  assert.equal(top('how do I transfer keep alive on portaldot', 1)[0], 'Balances.transferKeepAlive');
});

test('the kinds filter applies to hits and to jobs', () => {
  const ev = searchChain(INDEX, 'transfer', ['event'], 12);
  assert.ok(ev.hits.length > 0);
  assert.ok(ev.hits.every((h) => h.kind === 'event'), ev.hits.map(name).join(', '));
  assert.equal(name(ev.hits[0]), 'Balances.Transfer');
  assert.deepEqual(searchChain(INDEX, 'send', ['event'], 12).jobs, [], 'the send job is a call');
  const st = searchChain(INDEX, 'balance check', ['storage'], 12);
  assert.ok(st.hits.every((h) => h.kind === 'storage'));
  assert.equal(searchChain(INDEX, 'Nfts', ['module'], 12).hits.every((h) => h.kind === 'module'), true);
  assert.deepEqual(searchChain(INDEX, 'transfer', [], 12).hits.length, searchChain(INDEX, 'transfer', undefined, 12).hits.length, 'an empty list means all kinds');
});

test('the limit cuts the hits, and total counts them all', () => {
  const r = searchChain(INDEX, 'transfer', undefined, 2);
  assert.equal(r.hits.length, 2);
  assert.ok(r.total > 2, `total ${r.total}`);
});

test('synonyms find the chain\'s word for an everyday word', () => {
  // "memo" is in no name and no text here; SYNONYMS maps it to remark
  assert.ok(searchChain(INDEX, 'memo', ['call'], 12).hits.some((h) => name(h) === 'System.remark'));
  // "pay" maps to transfer
  const pay = top('pay', 3);
  assert.ok(pay.includes('Balances.transferKeepAlive') && pay.includes('Assets.transfer'), pay.join(', '));
  // "solidity" maps to revive
  assert.ok(searchChain(INDEX, 'solidity', undefined, 12).hits.some((h) => h.module.name === 'Revive'));
});

test('plural and -ing forms find the stem', () => {
  assert.ok(top('minting', 5).includes('Nfts.mint'));
  assert.ok(top('transfers', 5).includes('Balances.Transfer'));
});

test('a query with no match gives no jobs and no hits', () => {
  const r = searchChain(INDEX, 'qwertyuiop', undefined, 12);
  assert.deepEqual([r.jobs.length, r.hits.length, r.total], [0, 0, 0]);
  const bangs = searchChain(INDEX, '!!', undefined, 12);
  assert.deepEqual([bangs.jobs.length, bangs.total], [0, 0]);
});

test('"deploy ink!" finds the ink! deploy job', () => {
  const r = searchChain(INDEX, 'deploy ink!', undefined, 12);
  assert.equal(r.jobs[0]?.job.id, 'ink');
  assert.equal(fullName(r.jobs[0].item), 'Contracts.instantiateWithCode');
});

test('a query of only spaces finds nothing', () => {
  const r = searchChain(INDEX, '  ', undefined, 12);
  assert.deepEqual([r.jobs.length, r.total], [0, 0]);
});

test('a query of only underscores finds nothing', () => {
  assert.equal(searchChain(INDEX, '___', undefined, 12).total, 0);
});
