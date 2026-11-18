# Recipes: connect, send, read results, addresses, balances, fees, nonces, stored data

Runnable recipes for Portaldot V3, numbered 0 to 10. This file holds recipes 0, 1 and 5 to 10. Recipes 2 (Solidity with Foundry and cast, and Assets tokens through their ERC-20 address), 3 (call a contract from a native account) and 4 (a native call from a `0x` account) are in `recipes-contracts.md`. Read this file when you write code that connects to the chain, signs or dry-runs a native transaction, sends tPOT, reads a result or an event, converts an address, plans fees and nonces, replaces a waiting transaction, or stores data.

By the Bridge Zero team, an independent project and not an official Portaldot one. Each snippet's basis line says what ran, when and against what. Most ran read-only against the V3 testnet on Nov 14, 2026; the parts that sign and send are labelled "Assembled" unless the basis line names the block of a transaction we sent.

## Before you start

- Node 20 or newer (the scripts use `fetch` and top-level `await`; save them as `.mjs`). `npm install @polkadot/api@17 @polkadot/util-crypto@14`. The snippets ran with @polkadot/api 17.0.2 and @polkadot/util-crypto 14.0.3 on Node 24.
- Foundry (`cast`, `forge`) for the shell parts of recipe 2 (`recipes-contracts.md`). They ran with Foundry 1.8.5.
- Save recipe 0 as `v3.mjs`, recipe 6's first snippet as `addresses.mjs` and recipe 9 as `nonce-check.mjs`: the other scripts use them.
- Safety: use test accounts only. Never put a real secret phrase or private key into code, a config file, a log or a chat. The scripts that sign read a testnet-only phrase from the environment variable `V3_TEST_PHRASE`; in a browser, a wallet signs instead. Run every send on the testnet first.

Basis words: **Proven**: it ran against the testnet and the result was recorded (dates and evidence given; "a sent transaction, block N" when we sent one). **Assembled**: the lines come from code that ran (the basis line says which, how far, and whether this exact script passed only `node --check`), but this exact script was not run to send. **Not proven**: nobody we know of has done it on V3. Facts quoted with a recipe use the words of the other reference files: Checked, Experience, Guide, Reported.

Error numbers (E1, E2 and so on) refer to `errors.md`. Each recipe names the chain tool of this plugin that does the same step; the tools never sign or send.

## Contents

- 0. Connect, and check that you are on the right chain
- 1. Send the native token (tPOT) with @polkadot/api; 1b dry-run the signed bytes before sending them (`system_dryRun`, and the node's validity check); 1c sign with polkadot-api or dedot
- 2. Solidity with Foundry and cast (`recipes-contracts.md`): 2a build, 2b read, 2c call by Ethereum transaction (and send a whole balance), 2d deploy by Ethereum transaction (seen on the chain, not sent by us), 2e deploy on the native path, 2f read why the node refuses an Ethereum transaction without sending it, 2g an Assets token through its ERC-20 address (buy it in the swap pool, approve, transferFrom, permit)
- 3. Call a contract from a native account, `revive.call` (`recipes-contracts.md`)
- 4. Call a native module from a `0x` account (`recipes-contracts.md`)
- 5. Read a transaction's result and events on both sides: 5a an Ethereum transaction, 5b a native extrinsic (and the call inside `Proxy.proxy`), 5c contract events, 5d in a browser
- 6. Convert between the two address forms
- 7. An account's balance in both forms, what it can send, and a vesting lock to release
- 8. Estimate a fee
- 9. Nonces, finality and sending safely: what waits in the pool, replacing or cancelling a waiting transaction, a nonce gap
- 10. Store data on the chain with TransactionStorage, renew it, read it back

---

## 0. Connect, and check that you are on the right chain

What it does: opens @polkadot/api on a V3 node, declares the two transaction extensions @polkadot/api does not know, refuses a wrong genesis hash or chain id, and gives a small JSON-RPC client for the Ethereum RPC (testnet only: the mainnet has none). The same client works for the node's own HTTPS endpoint (`net.node` with `https://` in place of `wss://`).

```js
// v3.mjs: connect to Portaldot V3 and check that it is the chain you expect.
import { ApiPromise, WsProvider } from '@polkadot/api';

export const NETWORKS = {
  testnet: {
    node: 'wss://test-node-v3.portaldot.dev',
    evm: 'https://test-evm-rpc-v3.portaldot.dev',
    genesis: '0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd',
    chainId: 420420777n, // 0x190f1ca9
  },
  mainnet: {
    node: 'wss://live-v3-node.portaldot.dev',
    evm: null, // the mainnet has no public Ethereum JSON-RPC
    genesis: '0x6e7f1f24628d2fa3a1ac81a8b45157c63b1037fee4123a7664aae2c55cdbbc36',
    chainId: 780780777n,
  },
};

// The Ethereum side: plain JSON-RPC over HTTPS.
export function ethRpc(url) {
  return async function eth(method, params = []) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await r.json();
    if (body.error) {
      const e = new Error(`${method}: ${body.error.message}`);
      Object.assign(e, { code: body.error.code, data: body.error.data });
      throw e;
    }
    return body.result;
  };
}

export async function connect(name = 'testnet') {
  const net = NETWORKS[name];
  const provider = new WsProvider(net.node, 2_500, {}, 60_000); // reconnect after 2.5 s, 60 s per request
  const api = new ApiPromise({
    provider,
    noInitWarn: true,
    // two transaction extensions that @polkadot/api does not know; on V3 both carry no data.
    // Optional: without them @polkadot/api prints a REGISTRY warning and signs the same bytes.
    signedExtensions: { AuthorizeCall: { extrinsic: {}, payload: {} }, EthSetOrigin: { extrinsic: {}, payload: {} } },
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from ${net.node} within 30 s`)), 30_000);
  });
  try {
    await Promise.race([api.isReadyOrError, timeout]);
  } catch (e) {
    await api.disconnect();
    throw new Error(`cannot connect to ${net.node}: ${e?.message || 'connection refused or host not found'}`);
  } finally {
    clearTimeout(timer);
  }
  const fail = async (msg) => { await api.disconnect(); throw new Error(msg); };
  if (api.genesisHash.toHex() !== net.genesis) await fail(`genesis ${api.genesisHash.toHex()}: not the V3 ${name}, or it was reset`);
  if (api.consts.revive.chainId.toBigInt() !== net.chainId) await fail('wrong revive.chainId');
  const eth = net.evm ? ethRpc(net.evm) : null;
  if (eth && BigInt(await eth('eth_chainId')) !== net.chainId) await fail('the Ethereum RPC serves another chain');
  return { api, eth, net };
}

// Is the chain producing blocks? (the testnet stopped twice in Oct 2026)
export async function chainStatus(api) {
  const best = await api.rpc.chain.getHeader();
  const finalized = await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead());
  const now = (await api.query.timestamp.now()).toNumber(); // ms, the time of the best block
  return {
    best: best.number.toNumber(),
    finalized: finalized.number.toNumber(),
    secondsSinceLastBlock: Math.max(0, Math.round((Date.now() - now) / 1000)), // above 60: blocks are not coming
  };
}
```

Use it:

```js
// check-chain.mjs: recipe 0 in use
import { connect, chainStatus } from './v3.mjs';

for (const name of ['testnet', 'mainnet']) {
  const { api, eth } = await connect(name);
  const s = await chainStatus(api);
  console.log(`${name}: ${await api.rpc.system.chain()}, spec ${api.runtimeVersion.specVersion}`);
  console.log(`  best ${s.best}, finalized ${s.finalized}, last block ${s.secondsSinceLastBlock} s ago`);
  console.log(`  existential deposit ${api.consts.balances.existentialDeposit} base units`);
  if (eth) console.log(`  eth_blockNumber ${BigInt(await eth('eth_blockNumber'))}, eth_gasPrice ${BigInt(await eth('eth_gasPrice'))} wei`);
  await api.disconnect();
}
```

What you should see (Nov 14, 2026; the numbers move):

```
testnet: PortaldotV3 Test, spec 3002
  best 463430, finalized 463428, last block 0 s ago
  existential deposit 10000000000000 base units
  eth_blockNumber 463431, eth_gasPrice 15700 wei
mainnet: PortaldotV3 Live, spec 3001
  best 1076546, finalized 1076544, last block 0 s ago
  existential deposit 10000000000000 base units
```

- Connecting downloads the runtime metadata, so the first connection takes a few seconds (about 10 s for both networks on Nov 14, 2026).
- After `disconnect()`, @polkadot/api may print `disconnected from wss://...: 1000:: Normal Closure`. That is harmless.

What can go wrong:

- `cannot connect to ...`: a wrong or old endpoint (the guide's `feso-apps.xyz` hosts no longer resolve, E13), or the node is down (E14). The 30 s timeout stops the script instead of letting it wait forever.
- `genesis 0x...: not the V3 testnet, or it was reset`: refuse to send (E13).
- `REGISTRY: Unknown signed extensions AuthorizeCall, EthSetOrigin found, treating them as no-effect`: the `signedExtensions` option is missing. Only a warning: signing works anyway (E11).
- `Method not found` for an `eth_` method: it went to the Substrate node, not to the Ethereum RPC (E28).
- `secondsSinceLastBlock` above about 60: the chain is not producing blocks; do not send (E14).
- Do not call `process.exit()` while @polkadot/api is still starting: on Windows it can abort the process. Disconnect and let the script end (E22).

Basis: **Proven**. Both scripts ran on Nov 14, 2026 against both networks, and against an unreachable host and a wrong genesis hash (both refused, the first at once, the second after about 5 s). Our own tools have connected this way, with the same two extensions, for every send since Oct 19, 2026. Checked on Nov 15, 2026: without the two `signedExtensions`, @polkadot/api 17 printed the warning above and signed byte for byte the same transaction as with them, and the node's validity check accepted its encoding and signature (`Invalid(Payment)` for new, empty keys; nothing was sent). Our tools keep passing them.

Tool: `get_chain_facts` reads the same values live and says whether blocks are coming.

---

## 1. Send the native token (tPOT) with @polkadot/api

What it does: sends 1 tPOT with `balances.transferKeepAlive` from a native (sr25519) test account: it estimates the fee, checks the balance and that nothing is pending, signs with an explicit nonce, prints the hash before submitting, and waits for finality.

You need: recipe 0 as `v3.mjs`; a testnet-only account with tPOT; its secret phrase in `V3_TEST_PHRASE`.

```js
// send-tpot.mjs: send tPOT on the V3 testnet from a native (sr25519) test account.
import { Keyring } from '@polkadot/api';
import { cryptoWaitReady, decodeAddress } from '@polkadot/util-crypto';
import { connect } from './v3.mjs';

const { api } = await connect('testnet');
await cryptoWaitReady();

// A TEST account only. Set V3_TEST_PHRASE in your shell; never write it into a file of the project, never print it.
const phrase = process.env.V3_TEST_PHRASE;
if (!phrase) throw new Error('set V3_TEST_PHRASE to the secret phrase of a testnet-only account');
const pair = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromMnemonic(phrase);

const dest = process.argv[2]; // a 5... address. To pay a MetaMask user, use the fallback 5... form of their 0x address (recipe 6)
// A 0x address here would become MultiAddress::Address20, which the chain refuses with CannotLookup (E50).
if (decodeAddress(dest).length !== 32) throw new Error('give a native 5... address (32 bytes), not a 0x address');
const amount = 1n * 10n ** 14n; // 1 tPOT: native amounts have 14 decimals
const tx = api.tx.balances.transferKeepAlive(dest, amount); // refuses to take the sender below 0.1 tPOT

const fee = (await tx.paymentInfo(pair.address)).partialFee.toBigInt();
const ed = api.consts.balances.existentialDeposit.toBigInt(); // 0.1 tPOT
const { nonce, data } = await api.query.system.account(pair.address);
const [free, frozen, reserved] = [data.free.toBigInt(), data.frozen.toBigInt(), data.reserved.toBigInt()];
const keep = frozen - reserved > ed ? frozen - reserved : ed; // what a lock or the 0.1 tPOT keeps of free (E47)
if (free < amount + fee + keep) throw new Error(`free ${free} base units < amount + fee + ${keep} that must stay`);

const next = (await api.rpc.system.accountNextIndex(pair.address)).toNumber();
if (next !== nonce.toNumber()) throw new Error('an earlier transaction from this account is still pending (recipe 9)');
console.log(`fee estimate ${fee} base units, nonce ${next}`);

const signed = await tx.signAsync(pair, { nonce: next });
console.log('extrinsic hash', signed.hash.toHex()); // write it down BEFORE submitting

const done = await new Promise((resolve, reject) => {
  let unsub = () => {};
  const timer = setTimeout(() => { unsub(); reject(new Error('not final after 10 minutes: treat it as pending (recipe 9)')); }, 600_000);
  const stop = (fn, value) => { clearTimeout(timer); unsub(); fn(value); };
  signed.send(({ status, dispatchError, events }) => {
    if (status.isInBlock) console.log('in block', status.asInBlock.toHex());
    if (status.isFinalized) {
      if (!dispatchError) return stop(resolve, { blockHash: status.asFinalized.toHex(), events });
      const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
      stop(reject, new Error(m ? `${m.section}.${m.name}: ${m.docs.join(' ')}` : dispatchError.toString()));
    } else if (status.isInvalid || status.isDropped || status.isUsurped || status.isFinalityTimeout) {
      stop(reject, new Error(`the node reports the extrinsic as ${status.type}: check the nonce before sending again (recipe 9)`));
    }
  }).then((u) => { unsub = u; }, (e) => stop(reject, e)); // a refusal at submission ("1010: Invalid Transaction: ...") lands here
});
const paid = done.events.find(({ event }) => event.section === 'transactionPayment' && event.method === 'TransactionFeePaid');
console.log(`final in block ${done.blockHash}, fee paid ${paid?.event.data[1]} base units`);
await api.disconnect();
```

Run: `node send-tpot.mjs <5... address>`.

What you should see: `fee estimate 1490314274929 base units, nonce ...` (about 0.0149 tPOT on Nov 14, 2026), the extrinsic hash, `in block 0x...`, then about 12 s later `final in block 0x..., fee paid ... base units`.

- The fee is about 0.015 tPOT: four transfers paid 0.0149 to 0.0150 tPOT between Oct 20 and Nov 1, 2026 (Checked).
- The most a native account can send is free - max(frozen - reserved, 0.1 tPOT), less the fee. One base unit more got `Token(Frozen)` in dry runs on Nov 15, 2026, also from accounts with nothing frozen that have a hold or a reserve (E47). Staked tPOT is a hold: it is in `reserved`, not in `frozen`. Recipe 7 prints the figure and finds a vesting lock that `Vesting.vest` would release.
- In a browser, a wallet extension signs instead of a key in code: pass its signer, `tx.signAndSend(address, { signer })`. Not proven by us on V3.

What can go wrong:

- `1010: Invalid Transaction: Inability to pay some fees (e.g. account balance too low)`: the account cannot pay the fee, or does not exist yet (E1).
- `Balances.InsufficientBalance` (module 6, error 2), or a refused transfer near the minimum: the transfer would take the sender below 0.1 tPOT, or a new account would receive less than 0.1 tPOT (E17, E10).
- `1012: Transaction is temporarily banned`: the same bytes were sent again soon after a refusal, or after they were included (two blocks later, block 477849). Before you sign again, check that the account's nonce has not passed the transaction's: if it has, the transaction was included, so do not send it again (E12). Otherwise fix the cause, then sign again (E1).
- `Priority is too low` (1014): another transaction with this nonce waits in the pool; to replace it, see recipe 9. `1010: Invalid Transaction: Transaction is outdated`: the nonce was already used (E12). `Transaction Already Imported` (1013): these bytes were sent before; refused bytes sent again get it too, so check that the transaction waits before you wait for it (E12, recipe 9).
- `Token(Frozen)` from the transfer: more than the account can send (above, E47). `CannotLookup`: the destination was a 0x address (E50).
- A transaction that fails when it runs is still included: it uses its nonce and pays its fee (a transfer of twice the balance, block 477796, fee 0.0150 tPOT, `Token(FundsUnavailable)`). Recipe 1b shows such a failure before you send.
- Not final after 10 minutes: the chain may have stopped (E14). Treat the send as pending, not failed, and settle it with recipe 9 before you send again.

Basis: **Assembled**. On Nov 14, 2026 the script ran up to the signing step, with the Treasury `5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z` as the sender for the read-only parts, and `node --check` passed. The address guard and the `keep` check were added after the measurements of Nov 15, 2026 and passed `node --check` only. The sending lines (`transferKeepAlive`, `signAsync` with an explicit nonce, the status callback and the finality wait) are those of our own tools, which sent four transfers this way between Oct 20 and Nov 1, 2026; each was included 4 blocks after the finalized head at signing. Not proven: `transferAllowDeath`, `transferAll`, and signing through a browser extension.

Tool: `encode_call` with a `sender` gives the call bytes, the fee and the balance check for any native call.

### 1b. Dry-run the signed bytes before sending them

What it does: signs as recipe 1 does, asks the node's validity check about those exact bytes, then runs them with `system_dryRun`, which also gives the result of the call itself, and decodes it with the chain's own types. Nothing is sent, and the nonce and balance do not change. Send the same `signed` afterwards (`signed.send(...)` as in recipe 1).

```js
// dry-run-native.mjs: check and dry-run a signed native transaction without sending it.
// Usage: node dry-run-native.mjs <5... address>   (1 tPOT, as in recipe 1)
import { Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { connect, ethRpc } from './v3.mjs';

const { api, net } = await connect('testnet');
await cryptoWaitReady();
const phrase = process.env.V3_TEST_PHRASE; // a testnet-only account; never print it
if (!phrase) throw new Error('set V3_TEST_PHRASE to the secret phrase of a testnet-only account');
const pair = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromMnemonic(phrase);
const tx = api.tx.balances.transferKeepAlive(process.argv[2], 10n ** 14n);
const signed = await tx.signAsync(pair, { nonce: (await api.rpc.system.accountNextIndex(pair.address)).toNumber() });

// 1. The node's checks (signature, nonce, fee), as at submission. Read the block hash AFTER signing:
//    an older block makes a mortal transaction look invalid (AncientBirthBlock or BadProof).
const at = (await api.rpc.chain.getBlockHash()).toHex();
const valid = await api.call.taggedTransactionQueue.validateTransaction('External', signed.toU8a(), at); // bytes: hex traps (E55)
if (valid.isErr) throw new Error(`the node would refuse it: ${JSON.stringify(valid.asErr.toHuman())}`);

// 2. The call itself. Many public nodes do not serve system_dryRun: the public testnet node does today and may stop (E51).
let raw = null;
try { raw = await ethRpc(net.node.replace('wss://', 'https://'))('system_dryRun', [signed.toHex()]); }
catch (e) { console.log(`no dry run of the call (${e.message}); only the checks above passed`); }
if (raw) {
  // The chain's own types: @polkadot/api's built-in ApplyExtrinsicResult prints old names ("NoFunds" for FundsUnavailable).
  const r = api.createType('Result<Result<Null, SpRuntimeDispatchError>, SpRuntimeTransactionValidityTransactionValidityError>', raw);
  if (r.isErr) throw new Error(`the node would refuse it: ${JSON.stringify(r.asErr.toHuman())}`);
  if (r.asOk.isErr) {
    const e = r.asOk.asErr;
    const m = e.isModule ? api.registry.findMetaError(e.asModule) : null;
    throw new Error(`the call would fail: ${m ? `${m.section}.${m.name}` : JSON.stringify(e.toHuman())}`);
  }
  console.log('dry run: Ok');
}
console.log('extrinsic hash', signed.hash.toHex()); // send these same bytes now, as in recipe 1
await api.disconnect();
```

What the node answered on Nov 15, 2026, for transactions signed by a funded test account of ours (the last row: a new, empty key), through `system_dryRun` over HTTPS:

| Signed call | Reply | Decoded with the chain's types |
|---|---|---|
| `System.remark` | `0x0000` | Ok(Ok) |
| `Balances.transferKeepAlive` of twice the free balance | `0x00010700` | Ok(Err(Token(FundsUnavailable))); the built-in type prints `{"Token":"NoFunds"}` |
| `Assets.transfer` of asset 7777, never held | `0x0001032701000000` | Ok(Err(Module 39, error 1)): `assets.NoAccount` |
| `Utility.batch` [remark, the transfer above] | `0x0000` | Ok(Ok): the batch succeeds; the failure inside shows only in events, which a dry run does not return |
| a remark signed by a new, empty key | `0x010001` | Err(Invalid(Payment)) |

- An empty or random key gets `Payment` (or `BadProof` for a wrong signature) before the call runs, so `system_dryRun` shows the call's result only for a key you hold that can pay. For any account, `eth_estimateGas` from its `0x` form to the pallets address answers with the call's dispatch error (recipe 4, E29).
- The runtime has no `DryRunApi` (E51).

Basis: the table is **Proven** by dry runs of Nov 15, 2026 (nonce and balance unchanged afterwards); the decoding column was checked offline against the chain's metadata of spec 3002. The validity check with `signed.toU8a()` and a block hash read after signing, and `system_dryRun` through @polkadot/api, answered `Payment` for new keys on Nov 15, 2026. This exact script is **Assembled** and passed `node --check` only.

Tool: `encode_call` with a `sender` gives the dispatch result through the pallets address.

### 1c. Sign with polkadot-api or dedot

Neither library needs to be told about `AuthorizeCall` and `EthSetOrigin`. Do not turn on a metadata hash (PAPI's `withMetadataHash`, dedot's `metadataHash` option): the runtime has none, and every such transaction is refused with `Unknown(CannotLookup)` (E50).

```js
// papi-sign.mjs: polkadot-api 3.3.0. First: npm install polkadot-api@3.3.0 @polkadot/api@17
// and npx papi add v3 -w wss://test-node-v3.portaldot.dev (it writes the descriptors).
import { createClient, Binary } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import { getTxCreator } from 'polkadot-api/tx-creator';
import { v3 } from '@polkadot-api/descriptors';
import { Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { hexToU8a, u8aConcat, u8aToHex } from '@polkadot/util';

await cryptoWaitReady();
const pair = new Keyring({ type: 'sr25519' }).addFromMnemonic(process.env.V3_TEST_PHRASE); // a TEST account
const client = createClient(getWsProvider('wss://test-node-v3.portaldot.dev'));
const api = client.getTypedApi(v3);
const tx = await api.tx.System.remark({ remark: Binary.fromText('hi') })
  .create(getTxCreator(pair.publicKey, 'Sr25519', (m) => pair.sign(m))); // the signed bytes; nonce and era from the node
// The node's validity check, at a best block read AFTER create (_request is internal to PAPI).
const best = await client._request('chain_getBlockHash', []);
console.log(await client._request('state_call', ['TaggedTransactionQueue_validate_transaction', u8aToHex(u8aConcat([2], tx, hexToU8a(best))), best]));
client.destroy(); // to send instead: client.submit(tx) (not run by us)
```

```js
// dedot-sign.mjs: dedot 1.4.0. First: npm install dedot@1.4.0 @polkadot/api@17
import { LegacyClient, WsProvider } from 'dedot';
import { Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

await cryptoWaitReady();
const pair = new Keyring({ type: 'sr25519' }).addFromMnemonic(process.env.V3_TEST_PHRASE); // a TEST account
const client = await LegacyClient.new({ provider: new WsProvider('wss://test-node-v3.portaldot.dev') });
const tx = await client.tx.system.remark('0x1234').sign(pair); // nonce and era from the node
const head = await client.rpc.chain_getHeader();
const at = await client.rpc.chain_getBlockHash(head.number); // the header has no hash field: head.hash is undefined
console.log(await client.call.taggedTransactionQueue.validateTransaction('External', tx.toHex(), at));
await client.disconnect(); // to send instead: tx.send() (not run by us)
```

What you should see from a new, empty key: PAPI `0x010001`, dedot `{ isOk: false, isErr: true, err: { type: 'Invalid', value: { type: 'Payment' } } }`. Both mean that the encoding and the signature were accepted and only the fee cannot be paid.

- PAPI's typed `api.apis.TaggedTransactionQueue.validate_transaction` did not work: with the bytes as hex it threw `Incompatible runtime entry RuntimeCall(TaggedTransactionQueue_validate_transaction)` before sending anything, and with the bytes it trapped in the runtime. The raw `state_call` above works.
- PAPI's `getTxCreator` takes `'Sr25519'`, `'Ed25519'` or `'Ecdsa'`. `'Eth'` is accepted without an error but writes the type byte of Ed25519, and the node answers `BadProof`.
- With dedot, `validateTransaction(..., head.hash)` throws `API Compatibility Error: taggedTransactionQueue.validateTransaction` and marks `block_hash` as an invalid input with the value `undefined`: read the hash with `chain_getBlockHash` as above.

Basis: **Proven** up to the node's validity check: on Nov 15, 2026 both snippets ran against the testnet in this form, with new, empty sr25519 keys made in memory in place of the phrase; ecdsa keys also got `Payment` with both libraries; judged at an older block, PAPI's bytes got `BadProof`. Our dedot runs passed the chain's metadata to `LegacyClient.new` to skip a 640 kB download; the snippet leaves that option out. Nothing was sent: submitting with either library is not proven by us. The measured versions were polkadot-api 3.3.0 and dedot 1.4.0.

---

## 5. Read a transaction's result and events on both sides

Block numbers are the same on the Ethereum side and on the node; block hashes are not. The Ethereum hash of block n is `revive.blockHash(n)` read at block n; read at the head, that map keeps only the newest 256 blocks (Checked Nov 14, 2026). Link the two sides by number.

### 5a. An Ethereum transaction

What it does: reads the receipt from the Ethereum RPC, then finds the same transaction on the node, an unsigned `revive.ethTransact` extrinsic whose payload is the raw signed transaction, and lists its events.

```js
// eth-tx-both-sides.mjs: an Ethereum transaction seen from the Ethereum RPC and from the node.
// Usage: node eth-tx-both-sides.mjs <0x transaction hash>
import { keccakAsHex } from '@polkadot/util-crypto';
import { connect } from './v3.mjs';

const { api, eth } = await connect('testnet');
const hash = process.argv[2];

// Ethereum side
const r = await eth('eth_getTransactionReceipt', [hash]); // null: not in a block yet, unknown, or not served (E15)
if (!r) throw new Error('no receipt: pending, unknown to this RPC, or not served; look on the node (below) by block number');
const cost = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice); // wei: the fee plus any storage deposit
console.log(`status ${r.status} block ${BigInt(r.blockNumber)} gasUsed ${BigInt(r.gasUsed)} cost ${cost} wei, ${r.logs.length} logs`);

// Node side: the same block NUMBER (the hashes differ), an unsigned revive.ethTransact whose payload hashes to the tx hash
const blockHash = await api.rpc.chain.getBlockHash(BigInt(r.blockNumber));
const { block } = await api.rpc.chain.getBlock(blockHash);
const index = block.extrinsics.findIndex((x) =>
  x.method.section === 'revive' && x.method.method === 'ethTransact' && keccakAsHex(x.method.args[0].toU8a(true)) === hash);
const events = (await (await api.at(blockHash)).query.system.events())
  .filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.toNumber() === index);
console.log(`node: block ${blockHash.toHex()}, extrinsic ${index}`);
for (const { event } of events) console.log(`  ${event.section}.${event.method} ${JSON.stringify(event.data.toHuman())}`);
await api.disconnect();
```

What you should see, for a contract call that wrote one new storage slot (a third party's transaction in testnet block 389240, read on Nov 14, 2026):

```
status 0x1 block 389240 gasUsed 204128708753593 cost 3857011951899139735 wei, 2 logs
node: block 0xc000d43df32d28cf6534ec4b43b5cbddabb2ed153d64fe90fd7ab5b5058d1aa3, extrinsic 1
  balances.Withdraw {...}
  revive.ContractEmitted {"contract":"0x...","data":"0x...","topics":["0x...", ...]}
  revive.ContractEmitted {...}
  balances.Held {"reason":{"Revive":"StorageDepositReserve"},"who":"5...","amount":"384,150,000,000,000"}
  ...
  transactionPayment.TransactionFeePaid {"who":"5...","actualFee":"1,551,195,189,913","tip":"0"}
  system.ExtrinsicSuccess {...}
```

- `gasUsed x effectiveGasPrice` is the fee plus the storage deposit: 3.857 tPOT here, of which 3.8415 is the deposit for one new slot, held as `StorageDepositReserve`. More precisely, it is (`actualFee` + the `balances.Held` amounts) x 10^4 wei, plus less than one gas price (9735 wei here; 5570 to 14860 wei on 8 transactions) (Checked Nov 14, 2026).
- keccak-256 of the `ethTransact` payload is the Ethereum transaction hash: checked on Nov 14, 2026 for 10 transactions in 10 blocks, and for one of them `cast keccak <raw transaction>` and `cast decode-transaction` gave the same hash.
- A native call sent from a `0x` account to the pallets address (recipe 4) shows `gasUsed 0`, cost 0 and no logs in its receipt. Its fee and effects are only in the node's events: for the two transactions of Nov 13, 2026 in testnet blocks 452626 and 452633, `balances.Withdraw`, then `system.Remarked` or `balances.Transfer`, then `transactionPayment.TransactionFeePaid` (0.0158 and 0.0159 tPOT) and `system.ExtrinsicSuccess` (Checked Nov 14, 2026).
- A reverted Ethereum transaction still shows `system.ExtrinsicSuccess` on the node; read the receipt's `status`, or look for `revive.EthExtrinsicRevert` among the events (E9).

What can go wrong: a `null` receipt does not tell "pending", "never sent" and "not served" apart; one receipt was missing for some days in October 2026 (E15). Then look on the node: the block with the same number. Without a block number, scan recent blocks for the `ethTransact` whose payload hashes to your hash. Before its block, a transaction the node has taken is invisible on the Ethereum RPC: `eth_getTransactionByHash` answers `null` too, and the "pending" count does not include it. Only the node's pool shows it (recipe 9).

Basis: **Proven**: ran on Nov 14, 2026 on three Ethereum transactions (the two of Nov 13, 2026 and the one above); for each, the node's extrinsic was found by the payload hash. Our tools read receipts this way for six contract calls between Oct 19 and Nov 1, 2026.

Tool: `get_transaction` takes a `0x` hash and shows both sides.

### 5b. A native extrinsic

What it does: given the block and the extrinsic hash (from `signed.hash` before sending), tells success or failure with the named error, the fee paid, and the events.

```js
// extrinsic-result.mjs: the result, fee and events of a native extrinsic, read later from its block.
// Usage: node extrinsic-result.mjs <block number or 0x block hash> <0x extrinsic hash>
import { connect } from './v3.mjs';

const { api } = await connect('testnet');
const [blockArg, extrinsicHash] = process.argv.slice(2);
const blockHash = blockArg.startsWith('0x') ? blockArg : (await api.rpc.chain.getBlockHash(Number(blockArg))).toHex();

const { block } = await api.rpc.chain.getBlock(blockHash);
const index = block.extrinsics.findIndex((x) => x.hash.toHex() === extrinsicHash);
if (index < 0) throw new Error('that extrinsic is not in this block');
const apiAt = await api.at(blockHash); // decodes with the runtime of that block
const records = (await apiAt.query.system.events())
  .filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.toNumber() === index);

const failed = records.find(({ event }) => apiAt.events.system.ExtrinsicFailed.is(event));
const ok = records.some(({ event }) => apiAt.events.system.ExtrinsicSuccess.is(event));
const paid = records.find(({ event }) => apiAt.events.transactionPayment.TransactionFeePaid.is(event));
console.log(`extrinsic ${blockArg}-${index}: ${block.extrinsics[index].method.section}.${block.extrinsics[index].method.method}`);
if (failed) {
  const err = failed.event.data[0]; // DispatchError
  const m = err.isModule ? apiAt.registry.findMetaError(err.asModule) : null;
  console.log('FAILED:', m ? `${m.section}.${m.name}: ${m.docs.join(' ')}` : err.toString());
} else console.log(ok ? 'success' : 'no result event (an inherent?)');
// Proxy.proxy succeeds even when the call inside fails: its result is in Proxy.ProxyExecuted (E38).
const proxied = records.find(({ event }) => apiAt.events.proxy.ProxyExecuted.is(event));
if (proxied?.event.data[0].isErr) {
  const e = proxied.event.data[0].asErr;
  const pm = e.isModule ? apiAt.registry.findMetaError(e.asModule) : null;
  console.log('the call inside Proxy.proxy FAILED:', pm ? `${pm.section}.${pm.name}` : e.toString());
}
if (paid) console.log(`fee paid ${paid.event.data[1]} base units (actualFee, tip included)`);
for (const { event } of records) console.log(`  ${event.section}.${event.method} ${JSON.stringify(event.data.toHuman())}`);
await api.disconnect();
```

What you should see (a third party's `staking.payoutStakersByPage` in testnet block 463569, read on Nov 14, 2026):

```
extrinsic 463569-1: staking.payoutStakersByPage
success
fee paid 1500881157231 base units (actualFee, tip included)
  balances.Withdraw {...}
  staking.PayoutStarted {...}
  ...
```

- The fee actually paid is `actualFee` of `transactionPayment.TransactionFeePaid { who, actualFee, tip }`; it includes the tip (Checked Nov 13, 2026).
- A multisig, batch or proxy extrinsic can succeed while its inner call fails: read `multisig.MultisigExecuted { ..., result }`, the batch's own events, or `proxy.ProxyExecuted { result }` (E9, E16, E38). Our `Proxy.proxy` of a transfer through a NonTransfer proxy succeeded and paid its fee, and `ProxyExecuted` carried `Err(System.CallFiltered)`: no tPOT moved (a sent transaction, block 477948).
- `api.at(blockHash)` decodes the block with its own runtime, which matters across a runtime upgrade (E11).

Basis: **Proven**: ran on Nov 14, 2026 on the extrinsic above; `get_transaction` reported the same fee. The failure branch did not run (no failed extrinsic was found in the 600 blocks scanned); its lines are those our tools use for every send since Oct 19, 2026. The `ProxyExecuted` lines were added after Nov 15, 2026 and passed `node --check` only; the same reading in our measurement script reported `Err(system.CallFiltered)` for block 477948 and `Ok` for block 477949.

Tool: `get_transaction` with `{ "block": 463569, "index": 1 }`, or `get_block` for a whole block.

### 5c. A contract's events, including those eth_getLogs does not serve

What it does: reads every `revive.ContractEmitted { contract, data, topics }` of a block from the node and turns each into an Ethereum-style log. It finds the events of Ethereum transactions and of native-path calls (`revive.call`, a multisig, a batch); `eth_getLogs` serves only the first kind (E6).

```js
// contract-events.mjs: every contract event of one block, from the node, as Ethereum-style logs.
// It also finds the events of native-path calls, which eth_getLogs does not serve.
// Usage: node contract-events.mjs <block number>
import { connect } from './v3.mjs';

const { api } = await connect('testnet');
const number = Number(process.argv[2]);
const blockHash = await api.rpc.chain.getBlockHash(number);
const apiAt = await api.at(blockHash); // the runtime of that block decodes its events
const logs = [];
for (const { event, phase } of await apiAt.query.system.events()) {
  if (!apiAt.events.revive.ContractEmitted.is(event)) continue;
  const [contract, data, topics] = event.data;
  logs.push({
    address: contract.toHex(),
    topics: topics.map((t) => t.toHex()),
    data: data.toHex(),
    extrinsicIndex: phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : null,
  });
}
console.log(JSON.stringify(logs, null, 1)); // decode each with the contract's ABI (viem decodeEventLog, ethers Interface.parseLog)
await api.disconnect();
```

What you should see, checked on Nov 14, 2026:

- Block 389240 (an Ethereum transaction): 2 logs from the node, and `eth_getLogs` for that block returns the same 2 (same addresses, topics and data; the order may differ).
- Block 463584 (a third party's native `revive.call`): logs from the node, and `eth_getLogs` for that block returns `[]`.

- To find the block of a past event without an index, binary-search old state, for example for the first block where a counter in the contract's storage passed a value (as recipe 9 does for a nonce). The V3 nodes serve old state (Checked Nov 14, 2026).
- An event's topics and data are the same bytes as in an Ethereum log, so viem's `decodeEventLog({ abi, topics, data })` decodes them.

Basis: **Proven**: ran on Nov 14, 2026 on the two blocks above and on a native-path contract call made on Oct 27, 2026 (one event from the node, none from `eth_getLogs`). Our tools have read native-path events this way since Oct 27, 2026.

Tool: `get_contract_events` reads a contract's events from both sides.

### 5d. In a browser

- The testnet explorer opens an extrinsic or its events by block and index: `https://scanner-testnet-v3.portaldot.dev/#/extrinsics/<block>-<index>` and `https://scanner-testnet-v3.portaldot.dev/#/events/<block>-<index>`. Its API filters by name, 10 items a page: `https://scanner-testnet-v3-api.portaldot.dev/extrinsics?method=<call>&page=1` (for example `transferKeepAlive` or `call`) and `/events?method=<event>&page=1` (for example `Instantiated`, `ContractEmitted` or `EthExtrinsicRevert`). Treat the lists as incomplete: on Nov 14, 2026 `ethTransact` gave none, and the newest `Instantiated` and `EthExtrinsicRevert` they gave were in blocks 340057 and 342940, although later ones exist (blocks 354887 and 343008) (Checked).
- The Node Console opens a block: `https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/<block>`.
- Neither looks up an Ethereum `0x` transaction hash. Get the block number from the receipt (recipe 5a), then open the block.
- Basis: the link formats are Experience; the three sites answered HTTP 200 on Nov 14, 2026 (Checked).

---

## 6. Convert between the two address forms

What it does: the rule in both directions, offline; then the same answers from the chain, and whether a `0x` address is linked to a native account.

```js
// addresses.mjs: the two address forms of Portaldot V3, offline.
import { decodeAddress, encodeAddress, keccakAsU8a } from '@polkadot/util-crypto';

const hex = (u8) => '0x' + Buffer.from(u8).toString('hex');

// native 5... -> its 0x form (what msg.sender is when that account calls a contract)
export function nativeToH160(ss58) {
  const id = decodeAddress(ss58);
  if (id.subarray(20).every((b) => b === 0xee)) return hex(id.subarray(0, 20)); // a fallback account: it stands for a 0x address
  return hex(keccakAsU8a(id, 256).subarray(12)); // last 20 bytes of keccak-256 of the 32-byte account id
}

// 0x -> the fallback 5... account that holds its balance when no native account is linked to it (an Ethereum key)
export function h160ToFallback(h160) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(h160)) throw new Error(`not a 0x address of 20 bytes: ${h160}`);
  const bytes = Buffer.from(h160.slice(2), 'hex');
  return encodeAddress(new Uint8Array([...bytes, ...new Uint8Array(12).fill(0xee)]), 42);
}
```

Check against the chain, read-only:

```js
// check-address.mjs: recipe 6, offline rule against the chain
import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';
import { connect } from './v3.mjs';
import { nativeToH160, h160ToFallback } from './addresses.mjs';

const { api } = await connect('testnet');

// which native account holds the balance of a 0x address, and is it linked?
async function holderOf(h160) {
  const linked = (await api.query.revive.originalAccount(h160)).toJSON(); // the linked native account, or null
  return linked ? { holder: encodeAddress(linked, 42), linked: true } : { holder: h160ToFallback(h160), linked: false };
}

const treasury = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const h160 = nativeToH160(treasury);
console.log('Treasury 0x form, offline :', h160);
console.log('Treasury 0x form, on chain:', (await api.call.reviveApi.address(decodeAddress(treasury))).toHex());
console.log('holder of', h160, await holderOf(h160));

const metamask = '0x30FCb8D9F49fF9d61d3e1c1C4AB20c70fAA6A273'; // made from a hash for this example: nobody holds its key
console.log('fallback, offline :', h160ToFallback(metamask));
console.log('fallback, on chain:', encodeAddress((await api.call.reviveApi.accountId(metamask)).toU8a(), 42));
console.log('holder of', metamask, await holderOf(metamask));
console.log('back to 0x:', nativeToH160(h160ToFallback(metamask)));
await api.disconnect();
```

What you should see (Nov 14, 2026):

```
Treasury 0x form, offline : 0x8ddee436166f311ddeed36d714b08f512670d16e
Treasury 0x form, on chain: 0x8ddee436166f311ddeed36d714b08f512670d16e
holder of 0x8ddee436166f311ddeed36d714b08f512670d16e { holder: '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z', linked: true }
fallback, offline : 5DAwEHBNaDY7hRrFFCECLDqsnD8b79mb4FdYikURumQ3GUEc
fallback, on chain: 5DAwEHBNaDY7hRrFFCECLDqsnD8b79mb4FdYikURumQ3GUEc
holder of 0x30FCb8D9F49fF9d61d3e1c1C4AB20c70fAA6A273 { holder: '5DAwEHBNaDY7hRrFFCECLDqsnD8b79mb4FdYikURumQ3GUEc', linked: false }
back to 0x: 0x30fcb8d9f49ff9d61d3e1c1c4ab20c70faa6a273
```

Which form to use:

- Pay a MetaMask user from a native wallet: send to `h160ToFallback(their 0x address)`. The guide does the same with Developer, Runtime calls, `reviveApi`, `accountId` (Guide).
- Pay a native account from the Ethereum side: send to `nativeToH160(its 5... address)`, but only when `holderOf` says `linked: true`. A native account that does not exist yet has no link, and the tPOT lands on a fallback account that no key controls (E4).
- A contract called by a native account sees `msg.sender = nativeToH160(that account)`.
- Never give a native account's `0x` form to another EVM chain: no private key exists for it (E4).
- Do not convert with @polkadot/util-crypto's `addressToEvm` or `evmToAddress`, or with a Keyring of type `ethereum`: they give the first 20 bytes, blake2 of `'evm:'` + the 20 bytes, and the last 20 bytes, all without an error and none of them the chain's form (Checked Nov 15, 2026 against `reviveApi.address` and `reviveApi.accountId`; `addresses.md`).
- `revive.mapAccount` is not needed: `autoMap` is on and every native account is linked when it is created (E8).

Basis: **Proven**: both scripts ran on Nov 14, 2026; the offline rule and `reviveApi.address`, `reviveApi.accountId` and `revive.originalAccount` agreed on both examples. Not proven: the recovery call `revive.dispatchAsFallbackAccount`, `revive.mapAccount` and `revive.unmapAccount`.

Tool: `convert_address` gives both forms, checks the link on the chain, and says which form to use.

---

## 7. An account's balance in both forms, what it can send, and a vesting lock to release

What it does: reads the native balance (14 decimals), what the Ethereum side shows (18 decimals) through the Ethereum RPC and through the node's runtime API (which works on the mainnet too), the dust, and checks the rule that links them. Then it prints what a native transfer can move, and any vesting schedule that has ended but still locks tPOT.

```js
// balance.mjs: one account's balance on both sides. Usage: node balance.mjs <5... or 0x...>
import { encodeAddress } from '@polkadot/util-crypto';
import { connect } from './v3.mjs';
import { nativeToH160, h160ToFallback } from './addresses.mjs';

const { api, eth } = await connect('testnet');
const input = process.argv[2];
const h160 = input.startsWith('0x') ? input.toLowerCase() : nativeToH160(input);
const linked = (await api.query.revive.originalAccount(h160)).toJSON();
const holder = input.startsWith('0x') ? (linked ? encodeAddress(linked, 42) : h160ToFallback(h160)) : input;

// native side: 14 decimals
const { nonce, data } = await api.query.system.account(holder);
const ed = api.consts.balances.existentialDeposit.toBigInt();
const ratio = api.consts.revive.nativeToEthRatio.toBigInt(); // 10000
// Ethereum side: 18 decimals; the node's own figure works on the mainnet too
const viaNode = (await api.call.reviveApi.balance(h160)).toBigInt();
const viaRpc = eth ? BigInt(await eth('eth_getBalance', [h160, 'latest'])) : null;
const dust = BigInt((await api.query.revive.accountInfoOf(h160)).toJSON()?.dust ?? 0); // wei below one base unit

const free = data.free.toBigInt();
const frozen = data.frozen.toBigInt();
const kept = frozen > ed ? frozen : ed; // what the Ethereum side leaves out: the frozen amount or 0.1 tPOT, whichever is larger
const expected = (free > kept ? (free - kept) * ratio : 0n) + dust;
console.log(`holder ${holder}, 0x form ${h160}, linked ${Boolean(linked)}`);
console.log(`free ${free}, reserved ${data.reserved}, frozen ${frozen} (base units), nonce ${nonce}`);
console.log(`reviveApi.balance ${viaNode} wei, eth_getBalance ${viaRpc} wei, (free - max(frozen, 0.1 tPOT)) x ${ratio} + dust = ${expected} wei`);

// Native side: the most a transfer can move, before its fee (E47).
const reserved = data.reserved.toBigInt();
const keep = frozen - reserved > ed ? frozen - reserved : ed;
console.log(`a native transfer can move at most ${free > keep ? free - keep : 0n} base units, less its fee`);
// A vesting lock stays until Vesting.vest is called, even after its schedule has ended.
const head = (await api.rpc.chain.getHeader()).number.toBigInt();
for (const v of (await api.query.vesting.vesting(holder)).unwrapOr([])) {
  const ended = (head - v.startingBlock.toBigInt()) * v.perBlock.toBigInt() >= v.locked.toBigInt();
  console.log(`vesting of ${v.locked} base units from block ${v.startingBlock}: ${ended ? 'ended; send Vesting.vest() to release it' : 'still running'}`);
}
await api.disconnect();
```

What you should see for the Treasury (Nov 14, 2026; the balance moves):

```
holder 5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z, 0x form 0x8ddee436166f311ddeed36d714b08f512670d16e, linked true
free 15486476300000575558, reserved 0, frozen 0 (base units), nonce 0
reviveApi.balance 154864663000005755580000 wei, eth_getBalance 154864663000005755580000 wei, (free - max(frozen, 0.1 tPOT)) x 10000 + dust = 154864663000005755580000 wei
```

- The Ethereum side shows (free - max(frozen, existential deposit)) x 10000 wei + the account's dust (Checked Nov 14, 2026 on 19 accounts of both networks). For an account with nothing frozen that is (free - 0.1 tPOT) x 10^4 + dust, so a wallet's "max" on the Ethereum side keeps the 0.1; a transaction must also leave gas limit x base fee, and recipe 2c leaves gas limit x max fee, for room.
- For a MetaMask address with no tPOT yet, every figure is 0, and the fallback account does not exist until it is funded.
- Use BigInt for every amount: 154864 tPOT is far above what a JS `Number` holds exactly (E3).
- Reserved tPOT (held for staking, which is a hold here and not a lock, or as a deposit) does not lower what the Ethereum side shows; frozen tPOT (for example under a vesting lock) does. Dust is added even when nothing can be spent.
- The native limit is free - max(frozen - reserved, 0.1 tPOT): on Nov 15, 2026 exactly that amount passed a dry run of `transferKeepAlive` on 7 kinds of account (vesting lock, freeze, staking and pool holds, proxy and asset reserves, code deposit), and one base unit more did not (E47). The frozen-and-reserved case was measured inside a batch (bond 5 tPOT under a 10 tPOT vesting lock, then transfer). What `eth_getBalance` shows in that state is not measured.
- Both vesting schedules on the testnet had ended long before Nov 15, 2026, yet 10 and 9.7 tPOT stayed locked. `utility.batchAll([vesting.vest(), balances.transferKeepAlive(dest, free - 0.1 tPOT)])` passed a dry run, and the transfer alone got `Token(Frozen)`. Leave the fee out of the amount you send.
- An account id that ends in twelve `0xEE` bytes is the fallback account of an Ethereum key: the script then prints `linked false` for a `5...` input, which is right (recipe 6).

Basis: **Proven**: ran on Nov 14, 2026 for the Treasury, for an unused `0x` address, for two staking accounts and for two accounts under a vesting lock (frozen 10 and 9.7 tPOT); the three figures agreed exactly each time, and `get_account` gave the same figures. The native limit and the vesting lines were added after the dry runs of Nov 15, 2026 (nothing sent) and passed `node --check` only; the decoding of a vesting schedule was also checked offline against the chain's metadata.

Tool: `get_account` shows both forms, the balances, the nonce, what holds reserved or frozen funds, and contract details. `convert_amount` converts between tokens, base units and wei.

---

## 8. Estimate a fee

What it does: estimates, without signing, the fee of a native extrinsic, the weight of a call on its own (for `multisig.asMulti`), and the cost of an Ethereum transaction with the balance the node checks before it takes the transaction.

```js
// fees.mjs: estimate fees before sending, on both sides. Nothing is signed.
import { connect } from './v3.mjs';

const { api, eth } = await connect('testnet');
const sender = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';    // any address works for an estimate
const senderH160 = '0x8ddee436166f311ddeed36d714b08f512670d16e';     // its 0x form
const tokens = (units, decimals) => `${units / 10n ** BigInt(decimals)}.${(units % 10n ** BigInt(decimals)).toString().padStart(decimals, '0')}`;

// 1. A native extrinsic: the fee only (payment_queryInfo)
const tx = api.tx.balances.transferKeepAlive('5DAwEHBNaDY7hRrFFCECLDqsnD8b79mb4FdYikURumQ3GUEc', 10n ** 14n);
const info = await tx.paymentInfo(sender);
console.log(`transferKeepAlive fee ${tokens(info.partialFee.toBigInt(), 14)} tPOT, weight ${info.weight.refTime} / ${info.weight.proofSize}`);

// 2. The weight of a call on its own, for multisig.asMulti's maxWeight
const call = tx.method;
const callInfo = (await api.call.transactionPaymentCallApi.queryCallInfo(call, call.encodedLength)).toJSON();
console.log(`queryCallInfo weight ${JSON.stringify(callInfo.weight)}, fee ${tokens(BigInt(callInfo.partialFee), 14)} tPOT`);

// 3. An Ethereum transaction: gas x gas price is the fee AND the storage deposit (18 decimals)
const est = BigInt(await eth('eth_estimateGas', [{ from: senderH160, to: '0x6d6f646c70792f70616464720000000000000000', data: call.toHex() }]));
const gasPrice = BigInt(await eth('eth_gasPrice'));
const gasLimit = est + est / 10n, maxFee = gasPrice + gasPrice / 8n; // the 10 percent is headroom: unused gas is not charged
// The node takes the transaction when the sender can spend gas limit x base fee; the value must fit on top, or it fails in the block (E45).
// The check below uses the max fee, which leaves room for the base fee to rise.
console.log(`eth_estimateGas ${est} x ${gasPrice} wei = ${tokens(est * gasPrice, 18)} tPOT; balance needed ${tokens(gasLimit * maxFee, 18)} tPOT plus the value`);
await api.disconnect();
```

What you should see (Nov 14, 2026; the last figure is worked out from the same estimate and gas price, with the balance line above):

```
transferKeepAlive fee 0.01490314187428 tPOT, weight 656445000 / 15777
queryCallInfo weight {"refTime":164051000,"proofSize":3593}, fee 0.00420159645697 tPOT
eth_estimateGas 1068327538268 x 15690 wei = 0.016762059075424920 tPOT; balance needed 0.020742754315751194 tPOT plus the value
```

Which estimate for which job:

| Job | How | Seen |
|---|---|---|
| A native extrinsic | `(await tx.paymentInfo(sender)).partialFee` | `transferKeepAlive` about 0.0149 tPOT (Checked Nov 14, 2026) |
| A contract call or deployment on the native path | the dry run (`reviveApi.call`, `reviveApi.instantiate`) for the weight and the deposit, plus `paymentInfo` for the fee; total = value + deposit limit + fee + 0.1 tPOT | recipes 2e and 3 (`recipes-contracts.md`) |
| `multisig.asMulti`'s `maxWeight` | `transactionPaymentCallApi.queryCallInfo(call, length)`, read with `.toJSON().weight` | Experience, Oct 2026 |
| An Ethereum transaction | `eth_estimateGas x eth_gasPrice` = fee + deposit; the balance must cover value + gas limit x max fee (the node itself needs gas limit x base fee) | recipes 2c and 4 (`recipes-contracts.md`) |

- The Ethereum rule, by transactions we sent on Nov 15, 2026: the node takes a transaction when gas limit x base fee is at most what the sender can spend (`eth_getBalance`), and refuses it with a bare 1010 otherwise (taken at 2 percent below that line, refused at 5 percent above it; blocks 478128 to 478132). The max fee, a legacy gas price, the priority fee and the value are not counted. It then charges gasUsed x base fee, plus the value: a transfer's balance fell by exactly that (block 477814). The value is checked only in the block (E45).
- Deposits are part of the cost: a new 32-byte contract storage slot holds 3.8415 tPOT; deploying new code of L bytes holds 0.078 x L + 13.11 tPOT before the constructor's storage (Checked Nov 14, 2026; `amounts-and-fees.md`).
- A native payment that creates an account must be at least 0.1 tPOT (E17). Contract code may pay a new address less; the transaction's sender then pays 0.1 tPOT more for each new account, and a deposit limit must cover it (dry runs, Nov 15, 2026; E54).
- The gas price moves: on the testnet it was 38840 wei on Oct 19, 2026 and about 15700 wei on Nov 14, 2026 (it fell from 15825 to 15575 during that day). Read it each time. On the mainnet it was 5000 wei, read through the node on Nov 14, 2026 (`reviveApi.gasPrice`), so the same fee in tokens is about 3 times as much gas there.
- `eth_estimateGas` ignores a state override; for a "what if" estimate use the runtime call `reviveApi.ethTransactWithConfig` (E21).

What can go wrong: `insufficient funds for gas * price + value` from `eth_estimateGas` when the sender cannot pay the value (E1); `Invalid call: Payment` when you pass a small `gas` field (leave it out, E27); `Effective gas price ... lower than base fee ...` for a max fee below the base fee (E1); `execution reverted` when the call reverts (E26).

Basis: **Proven**: ran on Nov 14, 2026. The fee of the transfer matches the four transfers our tools sent between Oct 20 and Nov 1, 2026 (0.0149 to 0.0150 tPOT). The balance line of the script was changed after the sent transactions of Nov 15, 2026 and passed `node --check` only.

Tools: `encode_call` with a `sender` (native fee), `simulate_contract_call` and `simulate_contract_deploy` (native path), `estimate_eth_transaction` (Ethereum transactions and the 1010 check).

---

## 9. Nonces, finality and sending safely

What it does: before a send, checks whether a transaction of the account waits for its block (for a native or a `0x` account); looks a written-down hash up in the node's pool; reads the finalized head; and, after a crash or an unknown outcome, finds the block in which a given nonce was used.

On V3, `eth_getTransactionCount(from, "pending")` always equals `"latest"`: while one of our transactions waited for its block, both counts were the same, and `eth_getTransactionByHash` answered `null` (blocks 477889 and 477944). The node shows it: `system_accountNextIndex` of the account that holds the funds was the account's nonce + 1, and `author_pendingExtrinsics` held the transaction. A native transaction waiting for its block showed the same way (block 477853).

```js
// nonce-check.mjs: does a transaction of this account wait for its block, and where did its nonce pass a value?
// Usage: node nonce-check.mjs <5... or 0x address> [nonce to look for] [0x hash to look for in the pool]
// Exit code 2: a transaction of this account waits for its block.
import { encodeAddress, keccakAsHex } from '@polkadot/util-crypto';
import { connect } from './v3.mjs';
import { h160ToFallback } from './addresses.mjs';

const { api, eth } = await connect('testnet');
const input = process.argv[2];
const extra = process.argv.slice(3);
// The account that holds the funds and the nonce: for a 0x address, the linked native account, or else its fallback (recipe 6).
const linked = input.startsWith('0x') ? (await api.query.revive.originalAccount(input)).toJSON() : null;
const who = input.startsWith('0x') ? (linked ? encodeAddress(linked, 42) : h160ToFallback(input)) : input;

// 1. Waiting? Both sides share one nonce per account. (The Ethereum "pending" count does not show it on V3.)
const stateNonce = (await api.query.system.account(who)).nonce.toNumber(); // transactions in blocks
const poolNonce = (await api.rpc.system.accountNextIndex(who)).toNumber();  // also counts the node's pool
console.log(`${who}: nonce ${stateNonce} in blocks, ${poolNonce} with the pool`);
if (poolNonce !== stateNonce) { console.log('a transaction of this account waits for its block: do not send yet'); process.exitCode = 2; }

// 1b. Is the transaction with this hash in the pool? A native extrinsic by its hash; an Ethereum one as the
//     revive.ethTransact whose payload hashes to it (as in recipe 5a). A transaction behind a nonce gap is not listed.
const hash = extra.find((a) => /^0x[0-9a-fA-F]{64}$/.test(a));
if (hash) {
  const inPool = (await api.rpc.author.pendingExtrinsics()).some((x) => x.hash.toHex() === hash
    || (x.method.section === 'revive' && x.method.method === 'ethTransact' && keccakAsHex(x.method.args[0].toU8a(true)) === hash));
  console.log(inPool ? `${hash} waits in the pool` : `${hash} is not in the pool: in a block, refused, dropped, or behind a nonce gap`);
}

// 2. Finality: the node's finalized head, and the Ethereum RPC's "finalized" tag
const fin = (await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())).number.toNumber();
const best = (await api.rpc.chain.getHeader()).number.toNumber();
const ethFin = Number((await eth('eth_getBlockByNumber', ['finalized', false])).number);
console.log(`best ${best}, finalized ${fin}, Ethereum "finalized" ${ethFin}`);

// 3. Settle an unknown send: the first finalized block where the account's nonce is above n
//    (the transaction signed with nonce n is in that block). Needs old state: the V3 nodes serve it.
async function blockWhereNonceExceeds(n) {
  const nonceAt = async (b) => (await (await api.at(await api.rpc.chain.getBlockHash(b))).query.system.account(who)).nonce.toNumber();
  if ((await nonceAt(fin)) <= n) return null; // not included (yet): pending or dropped
  let lo = 0, hi = fin; // nonceAt(lo) <= n < nonceAt(hi)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await nonceAt(mid)) > n) hi = mid; else lo = mid;
  }
  return hi;
}
const nonceArg = extra.find((a) => /^\d+$/.test(a));
if (nonceArg !== undefined) {
  const n = Number(nonceArg);
  const b = await blockWhereNonceExceeds(n);
  console.log(b === null ? `nonce ${n} not used in a finalized block` : `nonce ${n} was used in block ${b}`);
}
await api.disconnect();
```

What you should see, for an active third-party account on Nov 14, 2026 (that run's first line also gave the Ethereum counts; this version leaves them out):

```
5...: nonce 338 in blocks, 338 with the pool
best 463632, finalized 463630, Ethereum "finalized" 463630
nonce 337 was used in block 463584
```

The search takes about 20 lookups (about 30 s). Block 463584 holds that account's signed extrinsic, and nonce 336 led to block 463577, its previous one. Recipes 2c and 2d run this script before they sign and stop on a non-zero exit code.

The rules our tools follow (Experience, from every send since Oct 19, 2026, corrected by the measurements of Nov 15, 2026):

- Send only when nothing waits: `system_accountNextIndex` equals `System.Account.nonce` of the account that holds the funds. The native and the Ethereum side share one nonce per account (Checked Nov 14, 2026), so an Ethereum transaction and a native extrinsic from one account draw from the same sequence. Send one at a time.
- Sign with the nonce from `system_accountNextIndex`, never from a counter of your own, and write the hash down before submitting: for a native extrinsic `signed.hash`; for an Ethereum transaction keccak-256 of the raw signed transaction (`cast keccak <raw>`). After a crash, the hash and the nonce let the next run settle the send instead of sending twice.
- Treat a send as done only when its block is finalized. GRANDPA finalizes about 2 blocks (12 s) behind the best block, with 2 validators. On Nov 14, 2026 `eth_getBlockByNumber("finalized")` matched the node's finalized head (Checked).
- If a send is not final after 10 minutes, treat it as pending, not failed: the chain may have stopped (E14). Then use step 3: if the nonce was used in a finalized block, look in that block for your hash (recipe 5b); if another extrinsic used the nonce, yours can never be included, but a copy of your payment with a hash you did not write down (a wallet's speed-up: the same call, recipient and amount) counts as yours (E12); if the nonce is still free, your transaction may still be in the pool (step 1b), or may have been dropped.
- Check the genesis hash and the chain id before every send (recipe 0).

### Replace or cancel a transaction that waits for its block

Sign a new transaction with the same nonce and a higher priority, while the first still waits. To cancel, make the new one harmless.

- Native: the same nonce and a higher tip. A second transaction with the same nonce and no tip was refused: `{"code":1014,"message":"Priority is too low: (4048 vs 4048)","data":"The transaction has too low priority to replace another transaction already in the pool."}`. A second one with a tip of 0.001 tPOT replaced the first: only it was in `author_pendingExtrinsics`, it was included (block 477860), and the first never was. The tip is paid on top of the fee.

  ```js
  // With api, pair and the send of recipe 1. waiting = the nonce of the transaction to replace (step 1: the nonce in blocks).
  const cancel = await api.tx.system.remark('cancel').signAsync(pair, { nonce: waiting, tip: 10n ** 11n }); // 0.001 tPOT
  ```

- Ethereum: the same nonce with a higher max fee and a higher priority fee. We sent one with 3 x base fee and half the base fee after one with 2 x base fee and 0: the second was taken and mined (block 477889), the first never was, and a third with the first one's fees got `{"code":1014,"message":"Priority is too low: (14 vs 10)"}`. The priority fee was not charged: the receipt showed `effectiveGasPrice` = the base fee. Run the `cast mktx` and `cast publish` lines of recipe 2c by hand (its script stops while a transaction waits) with `--nonce` of the waiting transaction and `--gas-price $((GP * 3)) --priority-gas-price $((GP / 2))`; to cancel, send 0 tPOT to your own address (we replaced with another transfer, not with that).

### A nonce gap

A transaction signed with a nonce above the next one is taken (a hash comes back) and then waits where nothing shows it: a native one was neither in `author_pendingExtrinsics` nor counted by `system_accountNextIndex`; for an Ethereum one, `eth_getTransactionByHash` answered `null` and "pending" equalled "latest". Further transactions with that same nonce are taken too, with no 1014. When the missing nonce is sent, one of them runs in the same block: the one with the higher tip (native, block 477798) or the higher fees (Ethereum, block 477816), or, with equal tips, the one sent first (block 477866). The others never ran.

- To let the waiting transaction run: send the missing nonce.
- To stop it: first send a harmless transaction with that same future nonce and a higher tip (native) or higher fees (Ethereum), then send the missing nonce. Only the harmless one then runs.
- Not measured: whether a waiting transaction leaves the pool by itself, for example when its era ends.

What can go wrong: `1010: Invalid Transaction: Transaction is outdated` (native) or a bare `{"code":1010,"message":"Invalid Transaction"}` (Ethereum) for a nonce already used; `Transaction Already Imported` (1013) for the bytes of a transaction already in a block, and also for refused bytes sent again, so check that the transaction waits before you wait for it (E12). A reorganisation can make a settled transfer look failed; wait for finality before you decide (E12).

Basis: **Proven** for the script's reads: it ran on Nov 14, 2026, and the blocks it found hold that account's extrinsics; the version above (a `0x` input, step 1b, the exit code, no Ethereum counts) passed `node --check` only. The pool, replacement and gap behaviour is **Checked** on Nov 15, 2026 by transactions we sent from our own test accounts (native: @polkadot/api 17, remarks; Ethereum: ethers 6, transfers of type 2), blocks 477796 to 477944. The cancel snippet is **Assembled** from those lines. The other rules are Experience.

Tools: `get_account` shows the nonce and whether a transaction of the account waits for its block (from `system_accountNextIndex`); `get_transaction` also looks in the node's pool; `get_chain_facts` shows the best and finalized heads.

---

## 10. Store data on the chain with TransactionStorage, renew it, read it back

What it does: `transactionStorage.store(data)` puts 1 byte up to 8388608 bytes (the runtime's limit) on the chain, kept for 100800 blocks (about a week) unless renewed; `renew(block, index)` keeps them longer; the node then gives them to anyone by their CID. Never store anything private.

Store, then renew (with `api`, `pair` and the send of recipe 1):

```js
const data = '0x' + Buffer.from('builder kit test', 'utf8').toString('hex');
const store = api.tx.transactionStorage.store(data); // its fee: (await store.paymentInfo(pair.address)).partialFee
// After its block: transactionStorage.Stored { index, contentHash }, where contentHash = blake2AsHex(data).
// Within 100800 blocks, renew it by that block number and index; a later renew names the block of the last renew
// and the index from its Renewed event.
const renew = api.tx.transactionStorage.renew(storedBlock, storedIndex);
```

Read it back (no key needed):

```js
// read-stored.mjs: read bytes stored with TransactionStorage. Usage: node read-stored.mjs <block> <index>
import { base32Encode, blake2AsHex } from '@polkadot/util-crypto';
import { hexToU8a, u8aConcat } from '@polkadot/util';
import { connect, ethRpc } from './v3.mjs';

const { api, net } = await connect('testnet');
const [block, index] = process.argv.slice(2).map(Number);
const entries = await api.query.transactionStorage.transactions(block); // [{ chunkRoot, contentHash, size_, blockChunks }]
if (entries.isNone || !entries.unwrap()[index]) throw new Error('no such entry: check the block and index, and the retention period');
const contentHash = entries.unwrap()[index].contentHash.toHex();
// CIDv1: version 1, codec raw (0x55), multihash blake2b-256 (0xa0 0xe4 0x02, 32 bytes), base32 with the prefix "b"
const cid = base32Encode(u8aConcat([0x01, 0x55, 0xa0, 0xe4, 0x02, 0x20], hexToU8a(contentHash)), true);
const bytes = await ethRpc(net.node.replace('wss://', 'https://'))('bitswap_v1_get', [cid]);
if (blake2AsHex(bytes) !== contentHash) throw new Error('the bytes do not match the content hash');
console.log(cid, Buffer.from(hexToU8a(bytes)).toString('utf8'));
await api.disconnect();
```

What we saw on Nov 15, 2026:

- `store` of 16 bytes (block 478138): events `balances.Held`, `balances.BurnedDebt`, `transactionStorage.Stored { index: 0, contentHash: 0x9bce1cd6...5d52c1 }`; a fee of 0.0126 tPOT, plus 1160 base units burned (10 per byte and 1000 per entry, about 10^-11 tPOT). `transactionStorage.transactions(478138)` then held one entry of size 16.
- `renew(478138, 0)` one block later (block 478139): `transactionStorage.Renewed` with the same content hash; a fee of 0.0117 tPOT plus 1160 base units.
- `renew` of a block and index that hold nothing was included and failed with `TransactionStorage.RenewedNotFound`, and its fee was paid (block 478141).
- The fee grows with the size: about 0.0001 tPOT per byte (0.1138 tPOT for 1024 bytes, by `transactionPaymentCallApi.queryCallInfo`). Estimate it with `paymentInfo`: a dry run of a valid `store` or `renew` always answers `BadContext` (E53); `store` of 0 bytes answers `BadDataSize`.
- `bitswap_v1_get` with these 16 bytes' CID, `bafk2bzacecn44hgwwwxcflocxj5obmcmb4sbphsxsmtpoacxlq2jh2x3lvjmc`, returned them. Given the 0x content hash instead of a CID, it answers `{"code":-32602,"message":"Invalid CID: Failed to parse multihash","data":{"variant":"InvalidCid"}}`.

Basis: store and renew are **Proven** by transactions we sent (blocks 478138, 478139 and 478141, @polkadot/api 17). The read-back is **Checked**: on Nov 15, 2026 the CID built this way returned the 16 bytes above, whose blake2-256 equals their content hash, and the same construction reproduced the CIDs of two older entries offline. Both snippets passed `node --check` only; the decoding of the storage entry was also checked offline against the chain's metadata. Not proven: `check_proof`, and what the node serves after the retention period.

Tools: `read_storage` reads `transactionStorage.transactions(block)`; `encode_call` gives the bytes and the fee of `store`.
