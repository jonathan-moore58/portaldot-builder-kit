// Live tests of the four core tools (get_chain_facts, search_chain, describe_item, convert_address),
// of the shared account helpers (src/lib/accounts.ts), of the saved metadata, and of our own words
// about the chain (src/lib/knowledge.ts) against both live networks.
//
// Every fact a tool states is compared with a second way of getting it: the API's own constants,
// or a plain HTTP JSON-RPC request to the node that does not go through src/lib/chain.ts.
// Nothing here depends on a balance or a block number. Only the neutral accounts are used (the
// Treasury and the pallets address); contracts are found on the chain at run time.
//
// Run: node --test test/live/core-tools.test.ts
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { checkAddress, encodeAddress } from '@polkadot/util-crypto';
import { SAVED_METADATA } from '../../src/generated/metadata.ts';
import { codeKind, readReviveAccount, resolveHolder } from '../../src/lib/accounts.ts';
import { checksummed, parseAddress, toSs58 } from '../../src/lib/address.ts';
import { closeAll, ethRpc, getConn } from '../../src/lib/chain.ts';
import { formatUnits, toHex } from '../../src/lib/format.ts';
import { GROUP_OF, JOBS, MODULE_NOTES, PLAIN_NOTES } from '../../src/lib/knowledge.ts';
import { fullName, getIndex, resolveRef } from '../../src/lib/meta.ts';
import { NETWORKS, PALLETS_ADDRESS, type NetworkKey } from '../../src/lib/networks.ts';
import { runTool } from '../../src/lib/tool.ts';
import convertAddress from '../../src/tools/convert_address.ts';
import describeItem from '../../src/tools/describe_item.ts';
import getChainFacts from '../../src/tools/get_chain_facts.ts';
import searchChain from '../../src/tools/search_chain.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const NETS: NetworkKey[] = ['testnet', 'mainnet'];
const TREASURY = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const TREASURY_ID = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000';
const TREASURY_H160 = '0x8ddee436166f311ddeed36d714b08f512670d16e';
const PALLETS_FALLBACK = '5EYCAe5ijiYfRmcZ49QUZ8dWLt4eZuwEUWscww7vuDtroCLa';
const EXPECTED_MODULES = 69;

after(async () => {
  await closeAll();
});

/** The second way: a plain JSON-RPC request over HTTP to the same node, outside src/lib/chain.ts. */
async function nodeHttp<T = Loose>(key: NetworkKey, method: string, params: unknown[] = []): Promise<T> {
  const url = NETWORKS[key].ws.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

const run = async (tool: Parameters<typeof runTool>[0], args: unknown): Promise<string> => {
  const r = await runTool(tool, args);
  assert.equal(r.isError, false, `unexpected error for ${JSON.stringify(args)}:\n${r.text}`);
  return r.text;
};
const runError = async (tool: Parameters<typeof runTool>[0], args: unknown): Promise<string> => {
  const r = await runTool(tool, args);
  assert.equal(r.isError, true, `expected an error for ${JSON.stringify(args)}, got:\n${r.text}`);
  return r.text;
};

/** A contract on the testnet, found at run time. */
async function findContract(): Promise<{ h160: string; codeHash: string }> {
  const conn = await getConn('testnet');
  const page = await (conn.api as Loose).query.revive.accountInfoOf.entriesPaged({ args: [], pageSize: 60 });
  for (const [k, v] of page) {
    const c = v.toJSON()?.accountType?.contract;
    if (c?.codeHash) return { h160: k.args[0].toHex(), codeHash: String(c.codeHash) };
  }
  throw new Error('no contract in the first 60 Revive accounts of the testnet');
}

/* ---------------- the saved metadata ---------------- */

for (const key of NETS) {
  test(`${key}: the saved metadata is for the runtime the chain runs now`, async () => {
    const saved = SAVED_METADATA[key];
    assert.ok(saved, `src/generated/metadata.ts has no copy for the ${key}: run node scripts/gen-metadata.mjs`);
    // the second way: ask the node over HTTP, as scripts/gen-metadata.mjs does
    const [genesis, version] = await Promise.all([nodeHttp<string>(key, 'chain_getBlockHash', [0]), nodeHttp<{ specVersion: number }>(key, 'state_getRuntimeVersion')]);
    assert.equal(saved.genesis, genesis, `the ${key} genesis is now ${genesis}, but the saved metadata is for ${saved.genesis}: the network was reset. Check, then run node scripts/gen-metadata.mjs`);
    assert.equal(saved.specVersion, version.specVersion, `the ${key} now runs spec ${version.specVersion}, but the saved metadata is for spec ${saved.specVersion}: run node scripts/gen-metadata.mjs`);
    const conn = await getConn(key);
    assert.equal(conn.api.genesisHash.toHex(), genesis);
    assert.equal(conn.api.runtimeVersion.specVersion.toNumber(), version.specVersion);
  });
}

test('the saved metadata carries the runtime APIs, so api.call.reviveApi exists', async () => {
  for (const key of NETS) {
    const raw = gunzipSync(Buffer.from(SAVED_METADATA[key].gzipBase64, 'base64'));
    assert.ok(raw[4] >= 15, `${key}: saved metadata is V${raw[4]}`);
    const conn = await getConn(key);
    assert.equal(typeof (conn.api as Loose).call.reviveApi?.gasPrice, 'function', key);
  }
});

/* ---------------- get_chain_facts ---------------- */

for (const key of NETS) {
  test(`get_chain_facts on the ${key}: the facts match the chain`, async () => {
    const net = NETWORKS[key];
    const text = await run(getChainFacts, { network: key });
    const conn = await getConn(key);
    const api = conn.api as Loose;
    const props = await nodeHttp<{ tokenSymbol: string; tokenDecimals: number; ss58Format: number }>(key, 'system_properties');
    const genesis = await nodeHttp<string>(key, 'chain_getBlockHash', [0]);
    const chainId = Number(api.consts.revive.chainId.toString());
    const ed = BigInt(api.consts.balances.existentialDeposit.toString());

    assert.equal(chainId, net.evmChainId);
    assert.ok(text.includes(`- chain id ${chainId} (0x${chainId.toString(16)})`), 'chain id line');
    assert.ok(text.includes(`- genesis ${genesis}\n`), 'genesis line, without a NOT');
    assert.equal(genesis, net.genesis);
    assert.equal(props.tokenSymbol, net.token);
    assert.equal(props.tokenDecimals, 14);
    assert.ok(text.includes(`- native token ${props.tokenSymbol} with ${props.tokenDecimals} decimals: 1 ${net.token} = 100000000000000 base units`));
    assert.ok(text.includes(`existential deposit, the smallest balance an account may hold: ${formatUnits(ed, 14)} ${net.token} (${ed} base units)`));
    assert.equal(ed, 10000000000000n);
    assert.equal(props.ss58Format, 42);
    assert.ok(text.includes('SS58 with prefix 42'));
    assert.ok(text.includes(`- Substrate RPC: ${net.ws}`));
    assert.ok(text.includes(`spec ${api.runtimeVersion.specVersion.toNumber()}`));
    assert.ok(text.includes(`- ${EXPECTED_MODULES} modules.`));
    assert.equal(BigInt(api.consts.revive.nativeToEthRatio.toString()), 10000n);
    assert.ok(text.includes('1 native base unit = 10000 wei'));
    // the deposit prices, from the constants
    const perByte = BigInt(api.consts.revive.depositPerByte.toString());
    const perItem = BigInt(api.consts.revive.depositPerItem.toString());
    const perChild = BigInt(api.consts.revive.depositPerChildTrieItem.toString());
    assert.ok(text.includes(`storage deposits: ${formatUnits(perByte, 14)} ${net.token} per byte, ${formatUnits(perItem, 14)} per item, ${formatUnits(perChild, 14)} per contract storage entry`));
    assert.ok(text.includes(`one new 32-byte contract storage slot holds ${formatUnits(perByte * 64n + perChild, 14)} ${net.token}`));
    assert.equal(api.consts.revive.autoMap.toString(), 'true');
    assert.ok(text.includes('autoMap is on'));
    assert.match(text, /head: block \d+, finalized \d+; the newest block is \d+ s old/, 'the chain is producing blocks');
    assert.ok(!/feso-apps|tPOTv3/.test(text) || key === 'testnet');
    if (key === 'testnet') {
      const id = Number(BigInt(await ethRpc<string>(net, 'eth_chainId')));
      assert.equal(id, 420420777);
      assert.ok(text.includes(`- JSON-RPC ${net.evm}: answering, at block`));
      assert.ok(text.includes(`chain id ${id}\n`), 'the RPC chain id, with no NOT');
      assert.ok(text.includes(`- Ethereum RPC: ${net.evm}`));
      assert.match(text, /gas price now: \d+ wei per gas/);
    } else {
      assert.ok(text.includes('- Ethereum RPC: none public'));
      assert.ok(text.includes('No public Ethereum JSON-RPC exists for this network'));
      assert.ok(!text.includes('MetaMask: add the network by hand'));
    }
    assert.ok(text.length < 6000, `${text.length} characters`);
  });
}

test('get_chain_facts on the mainnet gives the gas price read through the node', async () => {
  const text = await run(getChainFacts, { network: 'mainnet' });
  assert.match(text, /gas price now, read through the node: \d+ wei per gas/);
});

/* ---------------- search_chain ---------------- */

/** The names a search answer gives, in order: jobs first, then matches. */
function firstNames(text: string, n = 3): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const job = /->\s+([A-Z]\w*)\.(\w+)/.exec(line);
    const hit = /^\s{2}(?:call|storage|event|error|constant)\s+([A-Z]\w*)\.(\w+)/.exec(line);
    const mod = /^\s{2}module\s+(\w+)/.exec(line);
    const name = job ? `${job[1]}.${job[2]}` : hit ? `${hit[1]}.${hit[2]}` : mod ? mod[1] : null;
    if (name && !out.includes(name)) out.push(name);
  }
  return out.slice(0, n);
}

const EVERYDAY: Array<[string, string]> = [
  ['send', 'Balances.transferKeepAlive'],
  ['transfer tpot', 'Balances.transferKeepAlive'],
  ['check balance', 'System.account'],
  ['deploy contract', 'Revive.instantiateWithCode'],
  ['call contract', 'Revive.call'],
  ['create token', 'Assets.create'],
  ['mint nft', 'Nfts.mint'],
  ['swap tokens', 'AssetConversion.swapExactTokensForTokens'],
  ['stake', 'Staking.bond'],
  ['batch', 'Utility.batchAll'],
  ['multisig', 'Multisig.asMulti'],
  ['nft collection', 'Nfts.create'],
  ['existential deposit', 'Balances.existentialDeposit'],
  ['note', 'System.remarkWithEvent'],
];

test('search_chain: the expected call is among the first three results for everyday queries (testnet)', async () => {
  const failures: string[] = [];
  for (const [query, expected] of EVERYDAY) {
    const text = await run(searchChain, { query });
    const names = firstNames(text);
    if (!names.includes(expected)) failures.push(`"${query}": expected ${expected}, got ${names.join(', ')}`);
  }
  assert.deepEqual(failures, []);
});

test('search_chain on the mainnet: the same everyday answers, with POT', async () => {
  for (const [query, expected] of EVERYDAY.slice(0, 4)) {
    const text = await run(searchChain, { query, network: 'mainnet' });
    assert.ok(firstNames(text).includes(expected), `${query}: ${firstNames(text).join(', ')}`);
  }
  const send = await run(searchChain, { query: 'send', network: 'mainnet' });
  assert.ok(send.includes('Send POT to another account'));
  assert.ok(send.includes('Portaldot V3 mainnet'));
});

test('search_chain: an exact name, the kinds filter, the limit and a query that finds nothing', async () => {
  assert.deepEqual(firstNames(await run(searchChain, { query: 'Balances.transferKeepAlive' }), 1), ['Balances.transferKeepAlive']);
  const ev = await run(searchChain, { query: 'transfer', kinds: ['event'], limit: 5 });
  assert.ok(ev.split('\n').filter((l) => /^\s{2}\w/.test(l)).every((l) => /^\s{2}event\s/.test(l)), ev);
  assert.match(await run(searchChain, { query: 'send', limit: 2 }), /the best 2 shown/);
  assert.match(await run(searchChain, { query: 'qwertyuiop' }), /^No module, call, event, error, constant or stored value/);
  assert.match(await runError(searchChain, { query: 'a' }), /query/);
});

test('search_chain: "deploy ink!" finds Contracts.instantiateWithCode', async () => {
  assert.ok(firstNames(await run(searchChain, { query: 'deploy ink!' })).includes('Contracts.instantiateWithCode'));
});

test('search_chain: a query of blanks is refused or finds nothing', async () => {
  const r = await runTool(searchChain, { query: '  ' });
  assert.ok(r.isError || /^No module/.test(r.text), r.text.slice(0, 200));
});

/* ---------------- describe_item ---------------- */

test('describe_item: one item of each kind, checked against the API', async () => {
  const conn = await getConn('testnet');
  const api = conn.api as Loose;
  const spec = api.runtimeVersion.specVersion.toNumber();

  const call = await run(describeItem, { name: 'Balances.transferKeepAlive' });
  const [m, c] = Array.from(api.tx.balances.transferKeepAlive.callIndex as Uint8Array);
  assert.ok(call.includes(`(runtime ${spec}): module ${m}, call ${c}, so its encoded bytes start 0x${m.toString(16).padStart(2, '0')}${c.toString(16).padStart(2, '0')}.`), call);
  assert.equal(`${m},${c}`, '6,3');
  assert.match(call, /dest: MultiAddress \(AccountIdLookupOf\) - an account address in SS58 form/);
  assert.match(call, /value: Compact<u128> \(Balance\) - an amount in the smallest unit: 1 tPOT is 1 followed by 14 zeros/);
  assert.match(call, /In plain words: Sends tPOT with a safety check/);
  assert.ok(call.includes('await api.tx.balances.transferKeepAlive(dest, value).signAndSend(account);'));

  const event = await run(describeItem, { name: 'Balances.Transfer' });
  assert.ok(event.includes(`module 6, event ${api.events.balances.Transfer.meta.index.toNumber()}.`));
  assert.match(event, /Fields, in order:\n {2}from: AccountId32[^\n]*\n {2}to: AccountId32[^\n]*\n {2}amount: u128/);

  const error = await run(describeItem, { name: 'Balances.InsufficientBalance' });
  assert.ok(error.includes(`module 6, error ${api.errors.balances.InsufficientBalance.meta.index.toNumber()}.`));

  const constant = await run(describeItem, { name: 'Balances.existentialDeposit' });
  assert.ok(constant.includes(`a constant of the Balances module`));
  assert.ok(constant.includes(`Value: ${api.consts.balances.existentialDeposit.toString()} (0.1 tPOT)   type u128`));

  const storage = await run(describeItem, { name: 'System.account' });
  assert.ok(storage.includes('Keys: AccountId32'));
  // valueShape: the fields of the stored struct, compared with a real value read from the chain
  const value = (await api.query.system.account(TREASURY)).toJSON();
  const fields = Object.keys(value).join(', ');
  const dataFields = Object.keys(value.data).join(', ');
  assert.equal(fields, 'nonce, consumers, providers, sufficients, data');
  assert.ok(storage.includes(`FrameSystemAccountInfo: { ${Object.keys(value).map((k) => `${k}: ${k === 'data' ? 'PalletBalancesAccountData' : 'u32'}`).join(', ')} }`), storage);
  assert.ok(storage.includes(`PalletBalancesAccountData: { ${Object.keys(value.data).map((k) => `${k}: u128`).join(', ')} }`), `${dataFields}\n${storage}`);
  assert.ok(storage.includes('Next: read_storage reads it from the chain now'));

  const module = await run(describeItem, { name: 'Revive' });
  assert.ok(module.includes(`Calls (${Object.keys(api.tx.revive).length})`));
  assert.ok(module.includes(`Events (${Object.keys(api.events.revive).length})`));
  assert.equal(Object.keys(api.tx.revive).length, 14);
  assert.equal(Object.keys(api.events.revive).length, 3);
  assert.match(module, /^Revive - module 80 of the Portaldot V3 testnet/);
});

test('describe_item: struct and enum arguments show their fields (ArgInfo.shape)', async () => {
  const conn = await getConn('testnet');
  const api = conn.api as Loose;
  const nfts = await run(describeItem, { name: 'Nfts.create' });
  const config = Object.keys(api.createType('PalletNftsCollectionConfig').toJSON());
  assert.deepEqual(config, ['settings', 'maxSupply', 'mintSettings']);
  assert.ok(nfts.includes('PalletNftsCollectionConfig: { settings: u64, maxSupply: Option<u32>, mintSettings: PalletNftsMintSettings }'), nfts);
  assert.ok(nfts.includes('PalletNftsMintType: one of Issuer | Public | HolderOf(u32)'));
  assert.ok(nfts.includes('In @polkadot/api, pass a struct as an object with those keys'));
  const bond = await run(describeItem, { name: 'Staking.bond' });
  const variants = api.createType('PalletStakingRewardDestination').defKeys as string[];
  assert.deepEqual(variants, ['Staked', 'Stash', 'Controller', 'Account', 'None']);
  assert.ok(bond.includes('PalletStakingRewardDestination: one of Staked | Stash | Controller | Account(AccountId32) | None'), bond);
  // the value of a storage map (ItemInfo.valueShape), and an enum inside a struct
  const info = await run(describeItem, { name: 'Revive.accountInfoOf' });
  assert.ok(info.includes('PalletReviveStorageAccountType: one of Contract(PalletReviveStorageContractInfo) | EOA'), info);
});

test('describe_item: names that differ only by case, and the error paths', async () => {
  assert.match(await run(describeItem, { name: 'Balances.existentialDeposit' }), /^Balances\.existentialDeposit - a constant/);
  assert.match(await run(describeItem, { name: 'Balances.ExistentialDeposit' }), /^Balances\.ExistentialDeposit - an error/);
  assert.match(await run(describeItem, { name: 'balances::existential_deposit' }), /- a constant/);
  assert.match(await run(describeItem, { name: 'Balances.EXISTENTIALDEPOSIT' }), /names 2 things[\s\S]*"kind"/);
  assert.match(await run(describeItem, { name: 'Balances.ExistentialDeposit', kind: 'constant' }), /- a constant/);
  const transfer = await run(describeItem, { name: 'Balances.transfer' });
  assert.match(transfer, /^Note: Balances has no call named "transfer"\. If you want a call, the ones with a similar name are: [^\n]*transferKeepAlive/);
  assert.match(await runError(describeItem, { name: 'Balances.nothing' }), /The Balances module on the Portaldot V3 testnet \(runtime \d+\) has nothing named "nothing"/);
  assert.match(await runError(describeItem, { name: 'Nope' }), /Nothing on the Portaldot V3 testnet \(runtime \d+\) is named "Nope"/);
  assert.match(await runError(describeItem, { name: 'Balances.transferKeepAliv' }), /Closest names: [^\n]*Balances\.transferKeepAlive/, 'a name cut short');
  assert.match(await runError(describeItem, { name: 'x' }), /name/);
  const mainnet = await run(describeItem, { name: 'Balances.transferKeepAlive', network: 'mainnet' });
  assert.match(mainnet, /Portaldot V3 mainnet \(runtime \d+\): module 6, call 3, so its encoded bytes start 0x0603/);
  assert.ok(mainnet.includes('Sends POT with a safety check'));
});

test('describe_item: a one-letter typo still gets the closest name', async () => {
  assert.match(await runError(describeItem, { name: 'Balances.transferKeepAlivee' }), /Closest names: [^\n]*Balances\.transferKeepAlive/);
});

test('describe_item: a kind that does not fit says what the name is instead', async () => {
  const text = await runError(describeItem, { name: 'Balances.transferKeepAlive', kind: 'event' });
  assert.doesNotMatch(text, /has nothing named "transferKeepAlive"/);
});

test('describe_item: an error is shown the way @polkadot/api prints it', async () => {
  const conn = await getConn('testnet');
  const printed = JSON.stringify((conn.api as Loose).registry.createType('DispatchError', { Module: { index: 6, error: '0x02000000' } }).toJSON());
  assert.equal(printed, '{"module":{"index":6,"error":"0x02000000"}}');
  assert.ok((await run(describeItem, { name: 'Balances.InsufficientBalance' })).includes('"error":"0x02000000"'));
});

/* ---------------- convert_address ---------------- */

/** ReviveApi_address and ReviveApi_account_id over HTTP: the chain's own rule, not ours. */
const chainH160 = async (key: NetworkKey, accountIdHex: string): Promise<string> => nodeHttp<string>(key, 'state_call', ['ReviveApi_address', accountIdHex]);
const chainAccountId = async (key: NetworkKey, h160: string): Promise<string> => nodeHttp<string>(key, 'state_call', ['ReviveApi_account_id', h160]);

for (const key of NETS) {
  test(`convert_address on the ${key}: every kind of input, against the chain's own rule`, async () => {
    const net = NETWORKS[key];
    assert.equal(await chainH160(key, TREASURY_ID), TREASURY_H160);
    assert.equal(await chainAccountId(key, TREASURY_H160), TREASURY_ID, 'the Treasury is linked to its 0x form');
    assert.equal(await chainAccountId(key, PALLETS_ADDRESS), `${PALLETS_ADDRESS}${'ee'.repeat(12)}`, 'the pallets address is not linked');
    const conn = await getConn(key);
    const original = await (conn.api as Loose).query.revive.originalAccount(TREASURY_H160);
    assert.equal(original.unwrap().toHex(), TREASURY_ID);

    const ss58 = await run(convertAddress, { address: TREASURY, network: key });
    assert.match(ss58, new RegExp(`^A native account\\. Network: ${net.label}\\.`));
    assert.ok(ss58.includes(`account id:                                            ${TREASURY_ID}`));
    assert.ok(ss58.includes(`0x form (what contracts see as msg.sender):            ${checksummed(TREASURY_H160)}  <- the last 20 bytes of keccak-256`));
    assert.ok(ss58.includes(`it is linked to its 0x address: revive.originalAccount(${checksummed(TREASURY_H160)}) names it.`));
    assert.match(ss58, /the account exists: free balance [\d.]+ t?POT, nonce \d+/);

    const h160 = await run(convertAddress, { address: TREASURY_H160, network: key });
    assert.match(h160, /^An Ethereum-style \(0x\) address\./);
    assert.ok(h160.includes(`${TREASURY}  <- the native account this 0x address belongs to`));
    assert.ok(h160.includes(`the native account ${TREASURY} is linked to this 0x address`));
    assert.ok(h160.includes('No private key exists for this 0x address'));

    const id = await run(convertAddress, { address: TREASURY_ID, network: key });
    assert.match(id, /^A native account\./);
    assert.ok(id.includes(checksummed(TREASURY_H160)));

    const pallets = await run(convertAddress, { address: PALLETS_ADDRESS, network: key });
    // the pallets address is not an account: the tool says what it is and does not offer it as an address to pay
    assert.ok(pallets.includes("the runtime's pallets address"));
    assert.ok(pallets.includes('not an account to pay'));
    assert.ok(pallets.includes(PALLETS_FALLBACK));
    assert.doesNotMatch(pallets, /To pay it from a native wallet/);
    const fallbackForm = await run(convertAddress, { address: PALLETS_FALLBACK, network: key });
    assert.match(fallbackForm, /^This 5\.\.\. address stands for the Ethereum-style address/);
    assert.ok(fallbackForm.includes(checksummed(PALLETS_ADDRESS)));

    const polkadotForm = encodeAddress(TREASURY_ID, 0);
    assert.ok(checkAddress(polkadotForm, 0)[0]);
    const other = await run(convertAddress, { address: polkadotForm, network: key });
    assert.ok(other.includes('you wrote it with SS58 prefix 0; Portaldot uses prefix 42'));
    assert.ok(other.includes(TREASURY));

    const mixed = `${checksummed(TREASURY_H160).slice(0, -1)}E`;
    assert.ok((await run(convertAddress, { address: mixed, network: key })).includes('WARNING: The capital letters of this 0x address do not match its checksum'));

    const unused = toSs58(randomBytes(32));
    const fresh = await run(convertAddress, { address: unused, network: key });
    assert.ok(fresh.includes('the account does not exist yet'));
    assert.ok(fresh.includes('Do NOT pay'));

    assert.match(await runError(convertAddress, { address: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', network: key }), /secret recovery phrase/);
    assert.match(await runError(convertAddress, { address: '0x1234', network: key }), /4 characters after 0x/);
    assert.match(await runError(convertAddress, { address: 'not an address', network: key }), /not a valid address/);
  });
}

test('convert_address: a contract found on the testnet, with its code size checked two more ways', async () => {
  const { h160, codeHash } = await findContract();
  const conn = await getConn('testnet');
  const code = await (conn.api as Loose).query.revive.codeInfoOf(codeHash);
  const codeLen = Number(code.toJSON().codeLen);
  const codeType = String(code.toJSON().codeType);
  const rpcCode = await ethRpc<string>(NETWORKS.testnet, 'eth_getCode', [h160, 'latest']);
  assert.equal((rpcCode.length - 2) / 2, codeLen, 'eth_getCode and codeInfoOf agree');
  const text = await run(convertAddress, { address: h160 });
  assert.ok(text.includes(`- it is a contract: ${codeLen} bytes of ${codeKind(codeType)} code.`), text);
  assert.ok(text.includes('It is a contract, so pay it through its own functions.'));
});

test("convert_address: the fallback form of a linked 0x address says where that address's balance is", async () => {
  const fallback = toSs58(parseAddress(TREASURY_H160).accountId);
  assert.equal(fallback, '5FGipbm9kpThCKSRuVamVt8y67H7MVqYob1gJYYqcyceoyPM');
  const text = await run(convertAddress, { address: fallback });
  assert.doesNotMatch(text, /It is where that 0x address keeps its/);
});

test('convert_address: the pallets address is named as such, not offered as an address to pay', async () => {
  const text = await run(convertAddress, { address: PALLETS_ADDRESS });
  assert.match(text, /pallets address/i);
  assert.doesNotMatch(text, /To pay it from a native wallet/);
});

/* ---------------- accounts.ts ---------------- */

for (const key of NETS) {
  test(`resolveHolder and readReviveAccount on the ${key}`, async () => {
    const conn = await getConn(key);
    const linked = await resolveHolder(conn, parseAddress(TREASURY_H160));
    assert.equal(linked.linked, TREASURY);
    assert.equal(linked.holderSs58, TREASURY);
    assert.equal(toHex(linked.holderId), await chainAccountId(key, TREASURY_H160));

    const unlinked = await resolveHolder(conn, parseAddress(PALLETS_ADDRESS));
    assert.equal(unlinked.linked, null);
    assert.equal(unlinked.holderSs58, PALLETS_FALLBACK);
    assert.equal(toHex(unlinked.holderId), await chainAccountId(key, PALLETS_ADDRESS));

    const native = await resolveHolder(conn, parseAddress(TREASURY));
    assert.equal(native.holderSs58, TREASURY);
    assert.equal(native.linked, TREASURY);

    // a 0x address nobody has used: no record
    assert.equal(await readReviveAccount(conn, toHex(randomBytes(20))), null);
    // the Treasury has no Revive record, or one without a contract
    const t = await readReviveAccount(conn, TREASURY_H160);
    assert.ok(t === null || t.contract === null);
  });
}

test('readReviveAccount on testnet contracts and an EOA record, against the raw storage and eth_getCode', async () => {
  const conn = await getConn('testnet');
  const api = conn.api as Loose;
  const page = await api.query.revive.accountInfoOf.entriesPaged({ args: [], pageSize: 20 });
  let contracts = 0;
  let eoas = 0;
  for (const [k, v] of page) {
    const h160 = k.args[0].toHex();
    const json = v.toJSON();
    const r = await readReviveAccount(conn, h160);
    assert.ok(r, h160);
    assert.equal(r.dust, Number(json.dust ?? 0), `${h160} dust`);
    assert.ok(r.dust >= 0 && r.dust < 10000, `${h160} dust ${r.dust} is below one native unit`);
    if (json.accountType?.contract && contracts < 3) {
      contracts++;
      const c = r.contract!;
      assert.equal(c.codeHash, json.accountType.contract.codeHash);
      assert.ok(c.codeType === 'Evm' || c.codeType === 'Pvm', c.codeType);
      const rpcCode = await ethRpc<string>(NETWORKS.testnet, 'eth_getCode', [h160, 'latest']);
      assert.equal(c.codeLen, (rpcCode.length - 2) / 2, `${h160} code length`);
      assert.ok(c.codeRefcount >= 1);
      assert.equal(c.storageBaseDeposit, BigInt(json.accountType.contract.storageBaseDeposit));
      assert.equal(typeof c.codeDeposit, 'bigint');
      assert.equal(c.codeDeposit, BigInt((await api.query.revive.codeInfoOf(c.codeHash)).toJSON().deposit));
      assert.equal(codeKind(c.codeType), c.codeType === 'Evm' ? 'EVM' : 'PolkaVM');
    } else if (!json.accountType?.contract && eoas < 3) {
      eoas++;
      assert.equal(r.contract, null);
    }
  }
  assert.ok(contracts > 0, 'found no contract to check');
});

/* ---------------- the module count, and knowledge.ts against the live chain ---------------- */

for (const key of NETS) {
  test(`${key}: ${EXPECTED_MODULES} modules, and every name in knowledge.ts exists on the chain`, async () => {
    const conn = await getConn(key);
    const index = getIndex(conn);
    const pallets = (conn.api.runtimeMetadata.asLatest.pallets as Loose[]).map((p) => p.name.toString());
    assert.equal(index.modules.length, EXPECTED_MODULES);
    assert.equal(pallets.length, EXPECTED_MODULES);
    assert.deepEqual([...pallets].sort(), index.modules.map((m) => m.name).sort());

    const missing: string[] = [];
    for (const j of JOBS) {
      if (!index.items.some((it) => it.module === j.module && it.kind === j.kind && it.name === j.item)) missing.push(`job ${j.id}: ${j.module}.${j.item} (${j.kind})`);
    }
    for (const k of Object.keys(PLAIN_NOTES)) {
      const [m, item] = k.split('.');
      if (!index.items.some((it) => it.module === m && it.name === item)) missing.push(`PLAIN_NOTES ${k}`);
    }
    for (const m of Object.keys(MODULE_NOTES)) if (!pallets.includes(m)) missing.push(`MODULE_NOTES ${m}`);
    for (const m of [...GROUP_OF.keys()]) if (!pallets.includes(m)) missing.push(`group member ${m}`);
    assert.deepEqual(missing, [], `names in knowledge.ts that the ${key} does not have`);

    const undescribed = pallets.filter((m) => !MODULE_NOTES[m]).map((m) => `no MODULE_NOTES line: ${m}`);
    const ungrouped = pallets.filter((m) => !GROUP_OF.has(m)).map((m) => `no group: ${m}`);
    assert.deepEqual([...undescribed, ...ungrouped], [], `modules of the ${key} that knowledge.ts does not cover`);

    // the jobs resolve the way describe_item will look them up
    for (const j of JOBS) assert.equal(resolveRef(index, `${j.module}.${j.item}`, j.kind).items.map(fullName)[0], `${j.module}.${j.item}`);
  });
}
