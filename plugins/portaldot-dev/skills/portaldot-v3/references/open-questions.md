# Open questions: what is still not known or disputed

What nobody we know of has checked on Portaldot V3, and where measurements and other builders still disagree, each with what to do meanwhile. Questions answered on Nov 14, 2026 are listed at the end, with the file that now holds the answer. Read it before you rely on one of these behaviours, or when the chain does something these notes do not explain.

Basis words: Checked (measured on the chain by the Bridge Zero team, on the date given), Experience (learned while building and running our own tools on this chain), Guide (the chain team's testnet guide), Reported (said by other builders, not checked by us). Each item gives the current measured fact first.

## Where sources still disagree

The items keep their numbers, because other files cite them by number.

### 1. How far back state and history are served

- Now: on Nov 14, 2026 the Ethereum RPC answered `eth_getBalance` and `eth_call` at blocks from 1 to the head, and `eth_getBlockByNumber` returned block 1; both Substrate nodes served state at block 1 (Checked).
- Earlier: from Oct 17 to Oct 20, 2026 the Ethereum RPC answered "State already discarded" past about 256 blocks and served only recent blocks (Checked then). The behaviour changed, and it may change again.
- Reported: one team could not recover an event once its history became unavailable.
- Meanwhile: test the depth at run time before you depend on it, handle a `null` block, read old state from the Substrate node (`api.at(blockHash)`), and store the events you need as their blocks become final.

### 4. What `depositPerItem` (0.15) is charged for

- Now: the totals are checked. A new contract storage slot costs 3.8415 tPOT, which uses the child-trie item price 0.0015. New code of L bytes holds (L + 70) x 0.06, recorded in `revive.codeInfoOf`, and each contract holds 7.65 plus 30 percent of its code's deposit, recorded in `revive.accountInfoOf` (Checked Nov 14, 2026 by dry runs for 1 to 24576 bytes and on the records of more than 20 contracts).
- Not known: what the 70 bytes and the 7.65 stand for. Our reading: 70 bytes of bookkeeping stored with the code, and 7.65 = 125 bytes x 0.06 + one item x 0.15, which would place `depositPerItem` in the contract's record.
- Meanwhile: use 0.078 x L + 13.11 for new code, plus 3.8415 per new slot (`amounts-and-fees.md`), and dry-run for the exact number.

### 5. Whether deposits come back

- Now: a contract call that cleared a storage slot netted a deposit of 0 on Oct 20, 2026 (Experience). The chain documents that `revive.removeCode` refunds the code deposit to its owner once no contract uses the code (Checked Nov 14, 2026, from the metadata).
- Reported: storage deposits that did not come back, one of them 7.53 tPOT.
- Not known: whether a deposit paid through an Ethereum transaction comes back as tPOT when the storage is cleared, and what happens to the contract's own deposit and the 30 percent lockup when a contract ends.
- Meanwhile: dry-run the clearing call and look at `storageDeposit.refund`.

## Not known

Nobody we know of has checked these on V3. Each line says what to do meanwhile.

- **An Ethereum RPC for the mainnet.** No public one exists (Checked Nov 13 and Nov 14, 2026); whether a private one does is not known. Meanwhile: read the mainnet's Ethereum side through the node's runtime API (`api.call.reviveApi`, which the chain tools use), and use native tools for everything else.
- **Creation transactions that reverted.** Three type 2 creation transactions in testnet blocks 343008 to 343010 were included and reverted with `Revive.ContractTrapped`. Their gas limit x max fee came to about 8 to 9 tPOT, below the deposit any new contract holds (at least 13.11 tPOT for new code); that this was the cause is our guess (Checked Nov 14, 2026: the receipts and events). Meanwhile: take the gas limit from `eth_estimateGas` + 10 percent, never from habit, and try a small contract first.
- **Values that are not multiples of 10^4 wei.** `eth_call` and `eth_estimateGas` accept them, and Revive keeps the part below 10^4 wei as per-account dust (Checked Nov 14, 2026). What a sent transaction does with such a value, and when `Revive.BalanceConversionFailed` fires, is not known. Meanwhile: keep values whole multiples of 10^4 wei.
- **A value sent to the pallets address.** `eth_estimateGas` answers `Invalid call: Call` for a native call with a value above 0 (Checked Nov 14, 2026); what a sent transaction does is not known. Meanwhile: send value 0 there, and move tPOT with a `balances` call inside the data.
- **`eth_getBalance` for an account with both a frozen and a reserved amount.** No such account existed on either network on Nov 14, 2026, so the rule (free - max(frozen, existential deposit)) x 10000 wei + the account's dust is measured only for accounts with one of the two. Meanwhile: read `reviveApi.balance` (or `get_account`) instead of computing it.
- **A `logs` subscription over WebSocket.** `eth_subscribe` with `logs` returns a subscription id, but no log arrived while it was open (Nov 14, 2026). Meanwhile: poll `eth_getLogs` by block range, or check the subscription against it.
- **Writes through the ERC-20 addresses of Assets tokens.** Reads match the Assets module (Checked Nov 14, 2026); `transfer`, `approve`, `transferFrom` and permits were not tried. Meanwhile: test with small amounts on the testnet, or use the Assets module's own calls.
- **The precompile at `0x0000000000000000000000000000000000000901`, and where the VestingPrecompiles module answers.** Both exist; their functions are not known. Meanwhile: do not depend on them.
- **Runtime code that starts with `0xEF`.** A deployless `eth_call` returned such code without an error; whether a real deployment refuses it (EIP-3541) is not known. Meanwhile: do not deploy such code.
- **Signing with @polkadot/api without declaring `AuthorizeCall` and `EthSetOrigin`.** Reading works without them. Meanwhile: declare both as empty (`native-modules.md`).
- **Whether `AccountUnmapped` can still fire with autoMap on.** A dry run of a contract call from an account that does not exist yet did not return it (Checked Nov 14, 2026). Meanwhile: dry-run first; no `mapAccount` step is needed.
- **The recovery call `revive.dispatchAsFallbackAccount`.** It exists and the chain documents it as a recovery function; nobody we know of has used it on V3. Meanwhile: avoid the mistake (check `revive.originalAccount` first, `addresses.md`), and dry-run before relying on it.
- **Sending `utility.batchAll` from a `0x` account.** `eth_estimateGas` for `utility.batchAll` through the pallets address answered an estimate (Checked Nov 14, 2026: from the Treasury's `0x` form, data `0x01020400071468656c6c6f`, a batch of one `system.remarkWithEvent("hello")`, about 0.0136 tPOT); nothing was sent. That a sent batch works is Reported, not checked. Meanwhile: test on the testnet with small amounts.
- **How long the testnet keeps its state.** No reset has been seen: the genesis hash has been the same whenever we checked, from October to Nov 14, 2026. Meanwhile: check the genesis hash before every send.
- **Why the testnet stopped twice in Oct 2026, and where halts are announced.** We know of no status page. Meanwhile: watch the head's timestamp (`get_chain_facts`).
- **The mainnet validator set beyond its 2 validators, and what the Oracle module's single key holds.** Meanwhile: read `session.validators` and the Oracle module's storage yourself before you rely on either.
- **Fees paid in another asset** through `ChargeAssetTxPayment`. Not tried. Meanwhile: pay fees in tPOT.
- **Reported, not checked:** Revive has no ed25519 or staking precompile; the Portaldot wallet cannot sign Ethereum transactions. Meanwhile: test each before you design around it. (That the native Scheduler refuses a signed account with `BadOrigin` was Checked by dry run on Nov 15, 2026: `errors.md` E24.)
- **Nfts attribute namespaces.** Upstream code requires `approve_item_attributes` for the "Account" namespace; not tested on V3. Meanwhile: follow the upstream order (`errors.md` E25).

## Answered on Nov 14, 2026

All Checked on Nov 14, 2026.

- **The ERC-20 address of an Assets token:** its id as 4 big-endian bytes, 12 zero bytes, then `0001` and `0000` (asset 2 is `0x0000000200000000000000000000000000010000`); PoolAssets use `0002`. `evm-checks.md` section 3, `addresses.md`.
- **A WebSocket for the Ethereum RPC:** `wss://test-evm-rpc-v3.portaldot.dev`, where `eth_subscribe` takes `newBlockHeaders` and `logs`, not `newHeads`. `networks.md`.
- **`block.prevrandao`:** the constant 2500000000000000 on every block. `evm-checks.md` section 1.
- **Precompiles and opcodes:** `0x01` to `0x09` and P256VERIFY at `0x100` work; KZG (`0x0a`) and BLS12-381 (`0x0b` to `0x11`) are absent; `BLOBHASH` and `BLOBBASEFEE` fail the call, while `PUSH0`, `MCOPY`, `TSTORE` and `TLOAD` work. `evm-checks.md` sections 1 and 2.
- **Deploying by Ethereum transaction:** seen on the chain in other builders' transactions; not sent by us. Testnet blocks 354887 and 346634 hold legacy (type 0) creations with status 1, the contract at CREATE(from, nonce) and the deposits by the rule of item 4. `addresses.md` (contract addresses); `get_transaction {"block": 354887, "index": 1}` shows one.
- **`eth_getBalance`:** (free - max(frozen, existential deposit)) x 10000 wei + the account's dust, equal to `reviveApi.balance`; reserved amounts do not lower it. Measured on 19 accounts, 3 of them with a frozen amount. `amounts-and-fees.md`.
- **`eth_getLogs` range:** no block-range limit; a `fromBlock` after the `toBlock` answers "Failed to filter logs". `evm-checks.md` section 6.
- **The text of error 1010 from the Ethereum RPC:** `{"code":1010,"message":"Invalid Transaction"}`, with no reason. `errors.md` E1.
- **Which storage-deposit error fires when:** a limit below the peak deposit gives `StorageDepositLimitExhausted`, an account that cannot pay gives `StorageDepositNotEnoughFunds` (dry runs). `errors.md` E7.
- **Error replies from the Ethereum RPC:** the revert data came back whole in `data` in every test of ours; replies that lose the data field, which others reported, did not occur. `evm-checks.md` section 8.
- **Ethereum transactions from external wallets:** they go through when they follow the gas rule. Our eight and other builders' transactions succeeded; the reported refusal has the text of the 1010 balance check. `errors.md` E1.
- **The gas price:** it moves. On the testnet it was 38840 wei on Oct 19, 2026 and about 15700 wei on Nov 14, 2026 (it fell from 15825 to 15575 during that day); on the mainnet it was 5000 wei, read through the node on Nov 14, 2026. Read it each time. `networks.md`.
- **Finality on the Ethereum RPC:** `finalized` and `safe` return the node's finalized head. `networks.md`, `evm-checks.md` section 4.
- **The era length and the two halts:** about 6 hours per era; halts of 13 hours 24 minutes from Oct 28, 2026 and 5 hours 16 minutes on Oct 31, 2026, from block timestamps. `networks.md`.

Settled earlier and checked again on Nov 14, 2026, where the guide or habits from other chains say otherwise:

- No `mapAccount` step: `autoMap` is on and every native account is linked (`addresses.md`).
- The block time is 6 seconds (`networks.md`).
- The endpoints are on `portaldot.dev` and the token is `tPOT`; the guide's `feso-apps.xyz` hosts no longer resolve and its symbol `tPOTv3` is out of date (`networks.md`).
- Referenda, ConvictionVoting, `paras`, `cumulus_parachain_system` and iBridge are in neither runtime, although the V3.0 feature list names them (`native-modules.md`).
- A reverted Ethereum transaction shows `ExtrinsicSuccess` on the Substrate side, with a `revive.EthExtrinsicRevert` event (`contracts.md`).
