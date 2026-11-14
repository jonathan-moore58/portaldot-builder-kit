# Recipes: connect, send, read results, addresses, balances, fees, nonces

Runnable recipes for Portaldot V3, numbered 0 to 9. This file holds recipes 0, 1 and 5 to 9. Recipes 2 (Solidity with Foundry and cast), 3 (call a contract from a native account) and 4 (a native call from a `0x` account) are in `recipes-contracts.md`. Read this file when you write code that connects to the chain, sends tPOT, reads a result or an event, converts an address, or plans fees and nonces.

By the Bridge Zero team, an independent project and not an official Portaldot one. Every snippet below was run against the V3 testnet on Nov 14, 2026, read-only; the parts that sign and send were checked up to the signing step and are labelled "Assembled".

## Before you start

- Node 20 or newer (the scripts use `fetch` and top-level `await`; save them as `.mjs`). `npm install @polkadot/api@17 @polkadot/util-crypto@14`. The snippets ran with @polkadot/api 17.0.2 and @polkadot/util-crypto 14.0.3 on Node 24.
- Foundry (`cast`, `forge`) for the shell parts of recipe 2 (`recipes-contracts.md`). They ran with Foundry 1.8.5.
- Save recipe 0 as `v3.mjs` and recipe 6's first snippet as `addresses.mjs`: the other scripts import them.
- Safety: use test accounts only. Never put a real secret phrase or private key into code, a config file, a log or a chat. The scripts that sign read a testnet-only phrase from the environment variable `V3_TEST_PHRASE`; in a browser, a wallet signs instead. Run every send on the testnet first.

Basis words: **Proven**: it ran against the testnet and the result was recorded (dates and evidence given). **Assembled**: the lines come from proven code and everything up to the signing step ran on Nov 14, 2026, but this exact script was not run to send. **Not proven**: nobody we know of has done it on V3. Facts quoted with a recipe use the words of the other reference files: Checked, Experience, Guide, Reported.

Error numbers (E1, E2 and so on) refer to `errors.md`. Each recipe names the chain tool of this plugin that does the same step; the tools never sign or send.

## Contents

- 0. Connect, and check that you are on the right chain
- 1. Send the native token (tPOT) with @polkadot/api
- 2. Solidity with Foundry and cast (`recipes-contracts.md`): 2a build, 2b read, 2c call by Ethereum transaction, 2d deploy by Ethereum transaction (seen on the chain, not sent by us), 2e deploy on the native path
- 3. Call a contract from a native account, `revive.call` (`recipes-contracts.md`)
- 4. Call a native module from a `0x` account (`recipes-contracts.md`)
- 5. Read a transaction's result and events on both sides: 5a an Ethereum transaction, 5b a native extrinsic, 5c contract events, 5d in a browser
- 6. Convert between the two address forms
- 7. An account's balance in both forms
- 8. Estimate a fee
- 9. Nonces, finality and sending safely

---

## 0. Connect, and check that you are on the right chain

What it does: opens @polkadot/api on a V3 node, declares the two transaction extensions @polkadot/api does not know, refuses a wrong genesis hash or chain id, and gives a small client for the Ethereum JSON-RPC (testnet only: the mainnet has none).

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
    // two transaction extensions that @polkadot/api does not know; on V3 both carry no data
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
- `REGISTRY: Unknown signed extensions AuthorizeCall, EthSetOrigin`: the `signedExtensions` option is missing (E11).
- `Method not found` for an `eth_` method: it went to the Substrate node, not to the Ethereum RPC (E28).
- `secondsSinceLastBlock` above about 60: the chain is not producing blocks; do not send (E14).
- Do not call `process.exit()` while @polkadot/api is still starting: on Windows it can abort the process. Disconnect and let the script end (E22).

Basis: **Proven**. Both scripts ran on Nov 14, 2026 against both networks, and against an unreachable host and a wrong genesis hash (both refused, the first at once, the second after about 5 s). Our own tools have connected this way, with the same two extensions, for every send since Oct 19, 2026. Not proven: signing without the two `signedExtensions` (reading works without them; keep them).

Tool: `get_chain_facts` reads the same values live and says whether blocks are coming.

---

## 1. Send the native token (tPOT) with @polkadot/api

What it does: sends 1 tPOT with `balances.transferKeepAlive` from a native (sr25519) test account: it estimates the fee, checks the balance and that nothing is pending, signs with an explicit nonce, prints the hash before submitting, and waits for finality.

You need: recipe 0 as `v3.mjs`; a testnet-only account with tPOT; its secret phrase in `V3_TEST_PHRASE`.

```js
// send-tpot.mjs: send tPOT on the V3 testnet from a native (sr25519) test account.
import { Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { connect } from './v3.mjs';

const { api } = await connect('testnet');
await cryptoWaitReady();

// A TEST account only. Set V3_TEST_PHRASE in your shell; never write it into a file of the project, never print it.
const phrase = process.env.V3_TEST_PHRASE;
if (!phrase) throw new Error('set V3_TEST_PHRASE to the secret phrase of a testnet-only account');
const pair = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromMnemonic(phrase);

const dest = process.argv[2]; // a 5... address. To pay a MetaMask user, use the fallback 5... form of their 0x address (recipe 6)
const amount = 1n * 10n ** 14n; // 1 tPOT: native amounts have 14 decimals
const tx = api.tx.balances.transferKeepAlive(dest, amount); // refuses to take the sender below 0.1 tPOT

const fee = (await tx.paymentInfo(pair.address)).partialFee.toBigInt();
const ed = api.consts.balances.existentialDeposit.toBigInt(); // 0.1 tPOT
const { nonce, data } = await api.query.system.account(pair.address);
if (data.free.toBigInt() < amount + fee + ed) throw new Error(`free ${data.free} base units < amount + fee + 0.1 tPOT`);

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
- `data.frozen` (for example staked tPOT) cannot be sent. If it is not 0, leave it out of what you plan to send.
- In a browser, a wallet extension signs instead of a key in code: pass its signer, `tx.signAndSend(address, { signer })`. Not proven by us on V3.

What can go wrong:

- `1010: Invalid Transaction: Inability to pay some fees (e.g. account balance too low)`: the account cannot pay the fee, or does not exist yet (E1).
- `Balances.InsufficientBalance` (module 6, error 2), or a refused transfer near the minimum: the transfer would take the sender below 0.1 tPOT, or a new account would receive less than 0.1 tPOT (E17, E10).
- `1012: Transaction is temporarily banned`: the same bytes were sent again soon after a refusal. Fix the cause, then sign again (E1).
- `Priority is too low` (1014), `Transaction Already Imported` (1013) or `Transaction is outdated` (1010): nonce trouble (E12, recipe 9).
- Not final after 10 minutes: the chain may have stopped (E14). Treat the send as pending, not failed, and settle it with recipe 9 before you send again.

Basis: **Assembled**. On Nov 14, 2026 the script ran up to the signing step, with the Treasury `5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z` as the sender for the read-only parts, and `node --check` passed. The sending lines (`transferKeepAlive`, `signAsync` with an explicit nonce, the status callback and the finality wait) are those of our own tools, which sent four transfers this way between Oct 20 and Nov 1, 2026; each was included 4 blocks after the finalized head at signing. Not proven: `transferAllowDeath`, `transferAll`, and signing through a browser extension.

Tool: `encode_call` with a `sender` gives the call bytes, the fee and the balance check for any native call.

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

What can go wrong: a `null` receipt does not tell "pending", "never sent" and "not served" apart; one receipt was missing for some days in October 2026 (E15). Then look on the node: the block with the same number. Without a block number, scan recent blocks for the `ethTransact` whose payload hashes to your hash.

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
- A multisig or batch extrinsic can succeed while its inner call fails: read `multisig.MultisigExecuted { ..., result }` or the batch's own events (E9, E16).
- `api.at(blockHash)` decodes the block with its own runtime, which matters across a runtime upgrade (E11).

Basis: **Proven**: ran on Nov 14, 2026 on the extrinsic above; `get_transaction` reported the same fee. The failure branch did not run (no failed extrinsic was found in the 600 blocks scanned); its lines are those our tools use for every send since Oct 19, 2026.

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
- `revive.mapAccount` is not needed: `autoMap` is on and every native account is linked when it is created (E8).

Basis: **Proven**: both scripts ran on Nov 14, 2026; the offline rule and `reviveApi.address`, `reviveApi.accountId` and `revive.originalAccount` agreed on both examples. Not proven: the recovery call `revive.dispatchAsFallbackAccount`, `revive.mapAccount` and `revive.unmapAccount`.

Tool: `convert_address` gives both forms, checks the link on the chain, and says which form to use.

---

## 7. An account's balance in both forms

What it does: reads the native balance (14 decimals), what the Ethereum side shows (18 decimals) through the Ethereum RPC and through the node's runtime API (which works on the mainnet too), the dust, and checks the rule that links them.

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
await api.disconnect();
```

What you should see for the Treasury (Nov 14, 2026; the balance moves):

```
holder 5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z, 0x form 0x8ddee436166f311ddeed36d714b08f512670d16e, linked true
free 15486476300000575558, reserved 0, frozen 0 (base units), nonce 0
reviveApi.balance 154864663000005755580000 wei, eth_getBalance 154864663000005755580000 wei, (free - max(frozen, 0.1 tPOT)) x 10000 + dust = 154864663000005755580000 wei
```

- The Ethereum side shows (free - max(frozen, existential deposit)) x 10000 wei + the account's dust (Checked Nov 14, 2026 on 19 accounts of both networks). For an account with nothing frozen that is (free - 0.1 tPOT) x 10^4 + dust, so a wallet's "max" on the Ethereum side keeps the 0.1.
- For a MetaMask address with no tPOT yet, every figure is 0, and the fallback account does not exist until it is funded.
- Use BigInt for every amount: 154864 tPOT is far above what a JS `Number` holds exactly (E3).
- Reserved tPOT (for example held for staking or as a storage deposit) does not lower what the Ethereum side shows; frozen tPOT (for example under a vesting lock) does. Dust is added even when nothing can be spent. No account on either network had both a frozen and a reserved amount on Nov 14, 2026, so that case is not measured: compare the figures yourself, and `get_account` lists what holds the funds.
- An account id that ends in twelve `0xEE` bytes is the fallback account of an Ethereum key: the script then prints `linked false` for a `5...` input, which is right (recipe 6).

Basis: **Proven**: ran on Nov 14, 2026 for the Treasury, for an unused `0x` address, for two staking accounts and for two accounts under a vesting lock (frozen 10 and 9.7 tPOT); the three figures agreed exactly each time, and `get_account` gave the same figures.

Tool: `get_account` shows both forms, the balances, the nonce, what holds reserved or frozen funds, and contract details. `convert_amount` converts between tokens, base units and wei.

---

## 8. Estimate a fee

What it does: estimates, without signing, the fee of a native extrinsic, the weight of a call on its own (for `multisig.asMulti`), and the cost of an Ethereum transaction with the balance the node will ask for.

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
const gasLimit = est + est / 10n, maxFee = gasPrice + gasPrice / 8n;
console.log(`eth_estimateGas ${est} x ${gasPrice} wei = ${tokens(est * gasPrice, 18)} tPOT; balance needed ${tokens(gasLimit * maxFee, 18)} tPOT plus the value`);
await api.disconnect();
```

What you should see (Nov 14, 2026):

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
| An Ethereum transaction | `eth_estimateGas x eth_gasPrice` = fee + deposit; the balance must cover value + (estimate + 10 percent) x (gas price + one eighth) | recipes 2c and 4 (`recipes-contracts.md`) |

- Deposits are part of the cost: a new 32-byte contract storage slot holds 3.8415 tPOT; deploying new code of L bytes holds 0.078 x L + 13.11 tPOT before the constructor's storage (Checked Nov 14, 2026; `amounts-and-fees.md`).
- A payment that creates an account needs at least 0.1 tPOT for it.
- The gas price moves: on the testnet it was 38840 wei on Oct 19, 2026 and about 15700 wei on Nov 14, 2026 (it fell from 15825 to 15575 during that day). Read it each time. On the mainnet it was 5000 wei, read through the node on Nov 14, 2026 (`reviveApi.gasPrice`), so the same fee in tokens is about 3 times as much gas there.
- `eth_estimateGas` ignores a state override; for a "what if" estimate use the runtime call `reviveApi.ethTransactWithConfig` (E21).

What can go wrong: `insufficient funds for gas * price + value` from `eth_estimateGas` when the sender cannot pay the value (E1); `Invalid call: Payment` when you pass a small `gas` field (leave it out, E27); `execution reverted` when the call reverts (E26).

Basis: **Proven**: ran on Nov 14, 2026. The fee of the transfer matches the four transfers our tools sent between Oct 20 and Nov 1, 2026 (0.0149 to 0.0150 tPOT).

Tools: `encode_call` with a `sender` (native fee), `simulate_contract_call` and `simulate_contract_deploy` (native path), `estimate_eth_transaction` (Ethereum transactions and the 1010 check).

---

## 9. Nonces, finality and sending safely

What it does: before a send, checks that nothing is pending on either side; reads the finalized head; and, after a crash or an unknown outcome, finds the block in which a given nonce was used.

```js
// nonce-check.mjs: is anything pending for this account, and where did its nonce pass a value?
// Usage: node nonce-check.mjs <5... address> [nonce to look for]
import { connect } from './v3.mjs';
import { nativeToH160 } from './addresses.mjs';

const { api, eth } = await connect('testnet');
const who = process.argv[2];

// 1. Pending? Both sides share one nonce per account.
const stateNonce = (await api.query.system.account(who)).nonce.toNumber(); // transactions in blocks
const poolNonce = (await api.rpc.system.accountNextIndex(who)).toNumber();  // also counts the node's pool
const h160 = nativeToH160(who); // for a MetaMask account, start from its 0x address and its fallback 5... (recipe 6)
const latest = Number(await eth('eth_getTransactionCount', [h160, 'latest']));
const pending = Number(await eth('eth_getTransactionCount', [h160, 'pending']));
console.log(`nonce: state ${stateNonce}, with pool ${poolNonce}; Ethereum side latest ${latest}, pending ${pending}`);
if (poolNonce !== stateNonce || pending !== latest) console.log('something is pending: do not send yet');

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
if (process.argv[3] !== undefined) {
  const n = Number(process.argv[3]);
  const b = await blockWhereNonceExceeds(n);
  console.log(b === null ? `nonce ${n} not used in a finalized block` : `nonce ${n} was used in block ${b}`);
}
await api.disconnect();
```

What you should see, for an active third-party account on Nov 14, 2026:

```
nonce: state 338, with pool 338; Ethereum side latest 338, pending 338
best 463632, finalized 463630, Ethereum "finalized" 463630
nonce 337 was used in block 463584
```

The search takes about 20 lookups (about 30 s). Block 463584 holds that account's signed extrinsic, and nonce 336 led to block 463577, its previous one.

The rules our tools follow (Experience, from every send since Oct 19, 2026):

- Send only when nothing is pending: `accountNextIndex` equals `System.Account.nonce`, and `eth_getTransactionCount` "pending" equals "latest". The native and the Ethereum side share one nonce per account (Checked Nov 14, 2026: equal counts on both sides), so an Ethereum transaction and a native extrinsic from one account draw from the same sequence. Send one at a time.
- Sign with an explicit nonce, and write the hash down before submitting: for a native extrinsic `signed.hash`; for an Ethereum transaction keccak-256 of the raw signed transaction (`cast keccak <raw>`). After a crash, the hash and the nonce let the next run settle the send instead of sending twice.
- Treat a send as done only when its block is finalized. GRANDPA finalizes about 2 blocks (12 s) behind the best block, with 2 validators. On Nov 14, 2026 `eth_getBlockByNumber("finalized")` matched the node's finalized head (Checked).
- If a send is not final after 10 minutes, treat it as pending, not failed: the chain may have stopped (E14). Then use step 3: if the nonce was used in a finalized block, look in that block for your hash (recipe 5b); if another extrinsic used the nonce, yours was dropped; if the nonce is still free, your transaction may still be in the pool, or may have been dropped.
- Check the genesis hash and the chain id before every send (recipe 0).

What can go wrong: `Priority is too low` (1014), `Transaction Already Imported` (1013), `Transaction is outdated` (1010) are the standard Substrate answers for nonce trouble (E12). A reorganisation can make a settled transfer look failed; wait for finality before you decide (E12).

Basis: **Proven** for the script: it ran on Nov 14, 2026, and the blocks it found hold that account's extrinsics. The rules are Experience. Whether a real send of ours ever needed step 3 is not recorded.

Tools: `get_account` shows the nonce and whether a transaction is pending; `get_chain_facts` shows the best and finalized heads.
