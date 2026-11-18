# Differences from Ethereum

What a developer used to Ethereum expects, what Portaldot V3 does instead, and what to do about it. Read it when you port Ethereum code, tools or habits to this chain.

Each item gives what you would expect on Ethereum, what this chain does (with its basis), and what to do. Basis words: Checked (measured on the chain by the Bridge Zero team, on the date given), Experience (learned while building and running our own tools on this chain), Guide (the chain team's testnet guide), Reported (said by other builders, not checked by us). `evm-checks.md` has the measured opcode, precompile and RPC details; error numbers refer to `errors.md`.

## Accounts and amounts

1. **One address per key.**
   - Ethereum: a key has one address, and that address is the account.
   - Here: every account has a native `5...` form (32 bytes) and a `0x` form (20 bytes). A native account's `0x` form is a hash of its account id; a MetaMask key's balance sits on a fallback `5...` account, the 20 bytes followed by twelve `0xEE` bytes (Checked Nov 14, 2026).
   - Do: convert with `convert_address` or the rule in `addresses.md`, and check `revive.originalAccount` before paying a `0x` address from the Ethereum side.
2. **18 decimals everywhere.**
   - Ethereum: 1 ETH = 10^18 wei in every tool.
   - Here: 14 decimals natively, 18 on the Ethereum side; 1 native base unit = 10^4 wei (Checked Nov 14, 2026).
   - Do: convert at the boundary (`convert_amount`), use BigInt, and keep Ethereum values whole multiples of 10^4 wei.
3. **The balance is all yours to spend.**
   - Ethereum: `eth_getBalance` is the whole balance, and an account can be emptied to 0.
   - Here: an account must keep 0.1 tPOT (the existential deposit), and `eth_getBalance` = (free - max(frozen, existential deposit)) x 10000 wei + the account's dust: it leaves out the 0.1, or a larger frozen amount such as a vesting lock (Checked Nov 14, 2026 on 19 accounts on both networks).
   - Do: keep 0.1 tPOT on every account, add 0.1 when a payment creates a new account, also when contract code makes the payment (E54), and read reserved and frozen amounts on the native side (`get_account`).
4. **A nonce per address, and a pool the RPC can see.**
   - Ethereum: each address has its own nonce, and the RPC shows a transaction that waits in the pool: `eth_getTransactionByHash` finds it and the `pending` count includes it.
   - Here: one nonce per account is shared by the native and the Ethereum side (Checked Nov 14, 2026). The Ethereum RPC does not see the pool: while a sent transaction waited for its block, `eth_getTransactionByHash` and `eth_getTransactionReceipt` answered `null` and the `pending` count equalled the `latest` count, while the node's `system_accountNextIndex` was the account nonce + 1 (Checked Nov 15, 2026, a sent transaction, block 477944; `evm-checks.md` section 4).
   - Do: send one transaction at a time per account, and only when `system_accountNextIndex` equals the account's nonce (`get_account` shows it); look a waiting transaction up with `get_transaction`, which also searches the node's pool.
5. **The same key works on every EVM chain.**
   - Ethereum: an address from a key is valid on every EVM chain.
   - Here: true for a MetaMask key; false for a native account's `0x` form, which has no private key (Experience).
   - Do: never give a native account's `0x` form to another EVM chain or a bridge.

## Gas and fees

6. **Gas measures computation.**
   - Ethereum: gas is work done; a plain transfer is 21000 gas.
   - Here: gas also pays the storage deposits, so a receipt's `gasUsed x effectiveGasPrice` = the fee plus all deposits held (Checked Nov 14, 2026 on 8 receipts against the node's events). Estimates are about 10^12 gas for a plain transfer, about 10^14 for a call that writes a new storage slot and 10^15 to 10^16 for a deployment (Checked Oct 19 to Nov 14, 2026). A `gas` field of 21000 answers `Invalid call: Payment` (E27).
   - Do: judge costs in tokens (gas x gas price / 10^18), dry-run to see the deposit (`amounts-and-fees.md`), and leave `gas` out of `eth_call` and `eth_estimateGas`.
7. **A generous gas limit is harmless, and a transaction the sender cannot pay is refused.**
   - Ethereum: unused gas is refunded, so a high limit costs nothing; the pool refuses a transaction whose value + gas limit x gas price is more than the balance.
   - Here: unused gas is not charged either, but the node refuses with a bare error 1010 a transaction whose gas limit x base fee is more than the sender's `eth_getBalance`. The max fee, a legacy gas price, the priority fee and the value are not part of that check. So a transaction whose value the sender cannot pay on top of the fee is taken, mined as failed, and charged its fee (Checked Nov 15, 2026 by sent transactions: taken with gas limit x max fee at twice the balance, block 478128; refused at gas limit x base fee 5 percent above the balance; mined as failed for the whole balance as value, block 477900; E1, E45). `eth_estimateGas` without a gas field does not check that the sender can pay the fee: it answers for an address with no balance (Checked Nov 14, 2026).
   - Do: gas limit = the estimate (+ up to 10 percent), max fee = `eth_gasPrice` + one eighth, priority fee 0, and before signing check balance >= value + gas limit x max fee: that covers the node's check, with room for the base fee to rise. To send everything, value = balance - gas limit x max fee (`amounts-and-fees.md`). `estimate_eth_transaction` checks the balance; the tools' own fields are in `contracts.md`, section Tools.
8. **The gas price is a fee market.**
   - Ethereum: the base fee moves with demand, and a priority fee buys inclusion.
   - Here: `eth_gasPrice` is the base fee and a priority fee of 0 is accepted; `eth_maxPriorityFeePerGas` returns 0, and `eth_feeHistory` shows the same base fee in every block, every reward 0, and a `gasUsedRatio` of the block's gas used / (2^64 - 1): 0, or about 4.4 x 10^-8 for a block with one transfer (Checked Nov 14 and 15, 2026). The fee is gas used x base fee whatever was offered: a priority fee of half and of twice the base fee, and legacy gas prices of 2 and 4 x the base fee, were not charged (Checked Nov 15, 2026, sent transactions, blocks 477816 to 478130). A higher fee still won between two transactions with the same nonce: it replaced the other, and a third transaction with the replaced one's lower fees got `{"code":1014,"message":"Priority is too low: (14 vs 10)"}` (block 477889). On the testnet the price was 38840 wei on Oct 19, 2026 and about 15700 wei on Nov 14, 2026 (it fell from 15825 to 15575 during that day); on the mainnet it was 5000 wei, read through the node on Nov 14, 2026 (Checked on each date).
   - Do: set the priority fee to 0 and read the gas price each time. Gas numbers do not carry over between the two networks.
9. **Deploying costs gas and nothing else.**
   - Ethereum: a deployment pays gas once, 200 gas per byte of code.
   - Here: a deployment holds a deposit of 0.078 x L + 13.11 tPOT for new runtime code of L bytes, plus 3.8415 tPOT per new storage slot. For code already stored on the chain the code deposit is not charged again: 0.018 x L + 8.91 (Checked Nov 14, 2026, dry runs and the records of more than 20 contracts).
   - Do: build small (no CBOR metadata, the IR pipeline) and dry-run the deployment with `simulate_contract_deploy` before asking for test tokens.
10. **Gas used is a fixed property of the call.**
    - Ethereum: the same call uses the same gas whatever the gas price.
    - Here: the deposit part is fixed in tokens, so the same call uses more gas when the gas price is lower (Checked from receipts, Oct 20 and Nov 1, 2026).
    - Do: never hard-code gas numbers from an earlier run.

## Transactions, blocks and logs

11. **Every transaction is an Ethereum transaction.**
    - Ethereum: every transaction has a hash that an explorer finds.
    - Here: most activity is native extrinsics. An Ethereum transaction appears on the node as an unsigned `revive.ethTransact` extrinsic holding the raw signed transaction, with events such as `transactionPayment.TransactionFeePaid` and `system.ExtrinsicSuccess`. keccak-256 of that payload is the Ethereum transaction hash (Checked Nov 14, 2026 on 10 transactions).
    - Do: use `get_transaction` to see both sides of one transaction.
12. **`eth_getLogs` sees every contract event.**
    - Ethereum: every event is a log, and `eth_getLogs` finds it.
    - Here: `eth_getLogs` serves only the logs of Ethereum transactions; those also appear on the node as `revive.ContractEmitted`. Events from native-path calls (`revive.call`, multisig, batches) are only `revive.ContractEmitted` in `System.Events` (Checked Nov 14, 2026 on block 463584 and a native-path call from Oct 27, 2026).
    - Do: index both, or use `get_contract_events` (recipe 5c in `recipes.md`).
13. **`eth_getLogs` limits the block range.**
    - Ethereum: public RPCs refuse a large block range.
    - Here: there is no range limit: block 0 to `latest` answered. With no filter, a large answer takes tens of seconds: in two sets of measurements, the last 100000 blocks returned 4135 logs in 35 s, and the whole chain returned 8004 logs in 24 s. A `fromBlock` after the `toBlock`, or a `toBlock` beyond the head, answers `{"code":-32000,"message":"Failed to filter logs"}` (Checked Nov 14, 2026; E33).
    - Do: page by block range anyway in an indexer, set a long client timeout, and keep `fromBlock` <= `toBlock` <= the head.
14. **A reverted transaction shows as failed everywhere.**
    - Ethereum: a revert gives receipt status 0, and that is all.
    - Here: a reverted Ethereum transaction still completes at the extrinsic level: the node shows `ExtrinsicSuccess` plus a `revive.EthExtrinsicRevert` event. A reverted creation transaction still carries a `contractAddress` on its receipt, with no code there (Checked Nov 14, 2026: the chain's own description of that event, and blocks 343008 to 343010). Besides reverts, a transaction is also mined with status 0, and pays its fee, when its value is more than the balance left after the fee (item 7), and when a native call sent through the pallets address fails (Checked Nov 15, 2026, blocks 477900 and 477826).
    - Do: read the receipt's `status`, or look for `EthExtrinsicRevert` among the extrinsic's events; after a deployment, check `eth_getCode` at the new address.
15. **The receipt and transaction fields mean what they mean on Ethereum.**
    - Ethereum: `cumulativeGasUsed` adds up the block, `gasPrice` is filled in, and `transactionIndex` 0 is the first transaction.
    - Here: `cumulativeGasUsed` is `0x0` in every receipt; a mined type 2 transaction shows `gasPrice` `0x0` (the price paid is the receipt's `effectiveGasPrice`); `transactionIndex` is the extrinsic's position in the Substrate block, where extrinsic 0 is the `timestamp.set` inherent, so it is never 0. A native call sent from a `0x` account to the pallets address has a receipt with `gasUsed` 0, `effectiveGasPrice` 0 and no logs (Checked Nov 13 and Nov 14, 2026; `evm-checks.md` section 5), even when it failed and the sender paid 0.0162 tPOT (Checked Nov 15, 2026, block 477826; E46).
    - Do: read gas from `gasUsed`, the price from `effectiveGasPrice`, and the node's events for calls through the pallets address.
16. **A block has one hash and a state root.**
    - Ethereum: one block hash, and a `stateRoot` to check state proofs against.
    - Here: block numbers match on both sides, but the hashes differ. The Ethereum block hash is `revive.blockHash(number)`: read at block n it gives that block's hash, while read at the head it keeps only the newest 256 blocks. Ethereum block 0 (`0x7c05b2dc7486f81a693d676553fa13f380b5be16da7c739b182931cd6cf07001`) is not the Substrate genesis. The Ethereum block's `stateRoot` equals its `transactionsRoot` (the empty-trie root `0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421` when the block has no Ethereum transaction) and is never a state root (Checked Nov 14, 2026).
    - Do: link the two sides by block number, never by hash; check the chain with `eth_chainId`, not block 0; do not verify state proofs against that `stateRoot`.
17. **Finality takes many confirmations.**
    - Ethereum: wait many blocks, or for the `finalized` tag, several minutes behind the head.
    - Here: GRANDPA finalizes blocks about 2 blocks (12 s) behind the best block, with 2 validators. `finalized` and `safe` give the node's finalized head, and `latest` and `pending` its best block (Checked Nov 14, 2026, in three rounds). The testnet stopped twice in Oct 2026 (`networks.md`).
    - Do: wait for `finalized`, and treat a send as pending, not failed, while the chain is stopped.
18. **Receipts are always served.**
    - Ethereum: a mined transaction always has a receipt.
    - Here: for some days in October 2026 the Ethereum RPC did not serve one transaction's receipt; it served it again on Oct 23, 2026 (Checked then).
    - Do: fall back to the node: the `revive.ethTransact` extrinsic in the same block number and its events.
19. **The Ethereum RPC serves old state.**
    - Ethereum: an archive RPC answers at any block.
    - Here: in October 2026 it refused state older than about 256 blocks; on Nov 14, 2026 `eth_getBalance` and `eth_call` answered at block 1 (Checked on both dates).
    - Do: test the depth at run time, or read old state from the Substrate node, which acts as an archive node (`api.at(blockHash)`).

## Tooling

20. **Multicall3, the CREATE2 deployer, Safe, Permit2, EntryPoint and ERC-1820 are at their usual addresses.**
    - Ethereum: these helpers sit at the same addresses on most EVM chains.
    - Here: none is deployed on either network (Checked Nov 14, 2026: `eth_getCode` on the testnet and `reviveApi.code` on both networks).
    - Do: for batched reads use a deployless `eth_call` (`evm-checks.md` section 10); for batched native calls use `utility.batchAll`; deploy your own helpers if you need them.
21. **Wallets know the chain.**
    - Ethereum: a wallet adds a known network in one click.
    - Here: no public chain list has 420420777 (Checked Nov 13, 2026).
    - Do: add the network by hand (`networks.md`).
22. **An EVM explorer with source verification.**
    - Ethereum: an explorer finds a `0x` hash and verifies source code.
    - Here: the official explorers show the Substrate side only, and no verification service lists 420420777 (Checked Nov 13, 2026).
    - Do: read receipts through the RPC, open the block by number in the explorer, and publish your code hash (`cast code <address> | cast keccak`).
23. **`eth_estimateGas` takes a state override, and `eth_simulateV1` exists.**
    - Ethereum: common clients accept state overrides in both calls, and many offer `eth_simulateV1`, `eth_getProof` and `eth_createAccessList`.
    - Here: `eth_call` takes an override (`code`, `balance` and `stateDiff` were applied), `eth_estimateGas` ignores one, and `eth_simulateV1`, `eth_getProof` and `eth_createAccessList` answer "Method not found" (Checked Nov 14, 2026; E21).
    - Do: for a "what if" estimate, use the runtime call `reviveApi.ethTransactWithConfig` (Experience, Oct 19, 2026).
24. **Subscriptions with `newHeads`, and filters.**
    - Ethereum: `eth_subscribe("newHeads")` over a WebSocket, and `eth_newFilter` over HTTP.
    - Here: the Ethereum RPC host also answers on `wss://test-evm-rpc-v3.portaldot.dev`, but `eth_subscribe` takes `newBlockHeaders` and `logs` only: `newHeads` answers -32602 "unknown variant `newHeads`, expected `newBlockHeaders` or `logs`". There are no filters: `eth_newFilter` and the other filter methods answer "Method not found" (Checked Nov 14, 2026; E30). Whether a `logs` subscription delivers logs was not measured.
    - Do: subscribe with `newBlockHeaders`, or give a library that subscribes with `newHeads` the HTTPS endpoint and let it poll `eth_blockNumber` and `eth_getLogs`.
25. **One wallet signs everything.**
    - Ethereum: one wallet signs every transaction.
    - Here: native wallets sign native extrinsics; Ethereum transactions need an Ethereum wallet. An Ethereum key can sign a native extrinsic (signature type `Eth`, index 3, over keccak-256 of the payload, or of its blake2-256 hash when the payload is longer than 256 bytes), but only for the account keccak-256(the 33-byte compressed public key)[12..] followed by twelve `0xEE` bytes, which is not the account of the key's usual `0x` address. Signed for that usual address's account, or with EIP-191 `personal_sign`, the node's check answered `BadProof` (Checked Nov 15, 2026: the node's validity check of extrinsics signed by random keys; nothing was sent). Reported: the Portaldot wallet cannot sign Ethereum transactions.
    - Do: plan for two wallets, or send native calls from a `0x` account through the pallets address (`native-modules.md`).
26. **The mainnet has an Ethereum RPC.**
    - Ethereum: every network has a public JSON-RPC.
    - Here: the mainnet has none, and no contracts or tokens yet (Checked Nov 13 and Nov 14, 2026). Its node's runtime API answers the Ethereum view: `reviveApi.gasPrice` (5000 wei), `balance`, `nonce`, `ethEstimateGas` and dry runs (Checked Nov 14, 2026).
    - Do: do Ethereum-side work on the testnet; on the mainnet read through the node (`estimate_eth_transaction` does).

## The EVM itself

27. **`block.prevrandao` gives randomness.**
    - Ethereum: `prevrandao` is the beacon chain's randomness, new in every block.
    - Here: it is the constant 2500000000000000 on every block; the block's `mixHash` holds the same value and `difficulty` is 0 (Checked Nov 14, 2026 at 11 blocks).
    - Do: never use it as randomness.
28. **The usual precompiles, and the newer ones.**
    - Ethereum: precompiles `0x01` to `0x0a`, and on newer forks BLS12-381 at `0x0b` to `0x11`.
    - Here: `0x01` to `0x09` and P256VERIFY at `0x100` work; KZG (`0x0a`) is absent and a call to it fails with `Revive.UnsupportedPrecompileAddress`; BLS12-381 (`0x0b` to `0x11`) is absent, and a call there succeeds with no data (Checked Nov 14, 2026). Reported, not measured: no ed25519 or staking precompile.
    - Do: check the length of returned data, and see `evm-checks.md` section 2.
29. **Every `cancun` opcode runs.**
    - Ethereum: code built for `cancun` may use `BLOBHASH` and `BLOBBASEFEE`.
    - Here: `PUSH0`, `MCOPY`, `TSTORE` and `TLOAD` work; `BLOBHASH`, `BLOBBASEFEE`, `INVALID` and unassigned opcodes fail the whole call with `Revive.InvalidInstruction` (module 80, error 31): code -32000 and a module error, not "execution reverted" (Checked Nov 14, 2026; E31).
    - Do: build for `cancun`, and keep blob opcodes off every path that runs.
30. **The block gas limit bounds a call.**
    - Ethereum: a call can use up to the block gas limit.
    - Here: `block.gaslimit` and the block's `gasLimit` are 2^64 - 1. A call is bounded by the weight of one extrinsic: a deployless `eth_call` with 4096 `STATICCALL`s passed and one with 5120 failed with "The transaction consumes more than the allowed weight" (Checked Nov 14, 2026; E32).
    - Do: do not size work by the gas limit; split a batch when it fails with that text or `OutOfGas`.
31. **A token on the Ethereum side is a contract.**
    - Ethereum: an ERC-20 token is a deployed contract.
    - Here: every asset of the Assets module has an ERC-20 address that the runtime serves, with no deployed contract: the asset id as 4 big-endian bytes, 12 zero bytes, `0x0001`, `0x0000` (asset 2 is `0x0000000200000000000000000000000000010000`); PoolAssets the same with `0x0002`. `name`, `symbol`, `decimals`, `totalSupply` and `balanceOf` matched the module's storage (Checked Nov 14, 2026). Writes work too, with differences: `decimals` is the asset's own (6 for pUSD), a failure reaches a calling contract with no reason, every approval holds 0.1 tPOT from the owner, and an unlimited approval is stored as 2^128 - 1 and goes down with use (Checked Nov 15, 2026, dry runs and sent transactions; `evm-checks.md` section 3, E40 to E44).
    - Do: compute the address from the asset id (`convert_address` names it), and check that the asset exists: an unknown id answers `totalSupply()` with 0. Read `decimals()`, and keep 0.1 tPOT above the existential deposit on any account that approves.
32. **No admin can change a deployed contract.**
    - Ethereum: code without an upgrade path cannot change.
    - Here: both networks have a Sudo key, and the root origin can replace a contract's code with `revive.setCode` (Checked Nov 14, 2026).
    - Do: state this in any security claim about a contract on this chain.
33. **Contracts are EVM-only.**
    - Ethereum: contracts are EVM bytecode, and tokens are contracts.
    - Here: Revive runs EVM bytecode and PolkaVM code, and the separate Contracts module runs ink! (Checked Nov 14, 2026). A Revive token, an Assets asset and an Nfts NFT are separate objects (Guide); only Assets tokens are also reachable from Solidity, at their ERC-20 addresses (item 31).
    - Do: pick one token world per token.
34. **`transfer()` and `send()` give the payee 2300 gas.**
    - Ethereum: the payee gets a 2300-gas stipend: enough to log an event, not to write storage or call out, which is what stops re-entry.
    - Here: in `eth_call` the payee gets 7,461,079 gas, and a call that sends value with a gas cap gives the cap + 7,461,079. A payee can then emit events and overwrite a slot that already exists, but cannot write a new slot (about 3.84 tPOT of deposit) or make any external call (about 7.7 x 10^7 gas), so re-entry through `transfer()` and `send()` still fails; a cap of 10^12 allowed it (Checked Nov 15, 2026, dry runs; E48).
    - Do: check the flag of `send()` and of every call; size a gas cap from a dry run on this chain, never from Ethereum numbers; prefer pull payments.
35. **Calls can nest 1024 deep.**
    - Ethereum: the call depth limit is 1024.
    - Here: 26 frames in all, the top call included, for `CALL`, `DELEGATECALL`, `STATICCALL` and chains of `CREATE`. The next call fails silently with empty data, and passed up it reads as `execution reverted: ` with data `0x`, like an empty revert (Checked Nov 15, 2026, dry runs; E49).
    - Do: keep routers, proxies and factories shallow, turn recursion into loops, and handle a failed call at every level.
