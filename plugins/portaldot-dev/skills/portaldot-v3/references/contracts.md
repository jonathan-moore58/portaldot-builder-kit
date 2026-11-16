# Smart contracts: Solidity on Revive, and ink!

How contracts run on Portaldot V3, what has been proven to work, the Revive module's calls, events, runtime API and errors, the ERC-20 addresses of native assets, and the state of ink!. Read it before you build, deploy, call or index a contract.

Basis words: Checked (measured on the chain by the Bridge Zero team, on the date given), Experience (learned while building and running our own tools on this chain), Guide (the chain team's testnet guide), Reported (said by other builders, not checked by us).

## What runs contracts

- Solidity contracts run in the Revive module (pallet-revive, module index 80) with `0x` addresses (Checked Nov 14, 2026).
- `revive.allowEVMBytecode` is true on both networks, so standard EVM bytecode from solc runs as it is: no resolc and no PolkaVM build is needed (Checked Nov 14, 2026).
- PolkaVM code is accepted too. On Nov 14, 2026 the testnet held 279 Revive code entries, 273 of them EVM code and 6 PolkaVM code, and 528 Revive account entries: the same counts as on Nov 13, 2026 (Checked). The mainnet holds none (Checked Nov 14, 2026).
- ink! contracts run in a separate module, Contracts (index 21); see the ink! section below.

## What the EVM does here

Measured on Nov 14, 2026 with deployless `eth_call`s on the testnet and the node's own dry run on both networks (Checked). `evm-checks.md` has every value and how it was measured.

- Code built for `cancun` runs: `PUSH0`, `MCOPY`, `TSTORE` and `TLOAD` work. The exception is the blob opcodes: `BLOBHASH` and `BLOBBASEFEE` fail the whole call with `Revive.InvalidInstruction` (module 80, error 31) when they are executed, as do `INVALID` and unassigned opcodes. A contract built with solc 0.8.27 for `cancun` was deployed and runs (Experience, Oct 19, 2026).
- `block.prevrandao` is the constant 2500000000000000 on every block. Never use it as randomness.
- `block.timestamp` (seconds), `block.number`, `block.chainid`, `block.basefee`, `msg.sender`, `tx.origin` and `address(this)` behave as on Ethereum. `blockhash(n)` gives the Ethereum block hash, not the Substrate one.
- `block.gaslimit` is 2^64 - 1 and does not bound a call in practice. The weight of one extrinsic does: a deployless `eth_call` with 4096 `STATICCALL`s passed, and one with 5120 failed with "The transaction consumes more than the allowed weight" (E32 in `errors.md`).
- Precompiles (`evm-checks.md` section 2):
  - `0x01` to `0x09` (ecrecover, sha256, ripemd160, identity, modexp, bn256 add, mul and pairing, blake2f) and P256VERIFY at `0x100` work as on Ethereum.
  - KZG point evaluation (`0x0a`) is absent: a call to it fails with `Revive.UnsupportedPrecompileAddress` (module 80, error 47).
  - BLS12-381 (`0x0b` to `0x11`) is absent: a call there succeeds with no data, so check the length of returned data.
  - A System precompile at `0x0000000000000000000000000000000000000900` answers `minimumBalance()`, `hashBlake256(bytes)` and `toAccountId(address)`.
  - Reported, not measured: there is no ed25519 and no staking precompile.
- An `eth_call` with creation code and no `to` (a "deployless" call) works; it is the way to batch reads without Multicall3 (`evm-checks.md` section 10).
- Payments and calls between contracts (Checked Nov 15, 2026, dry runs; `evm-checks.md` section 11 has the numbers):
  - `transfer()` and `send()` give the payee 7,461,079 gas, not 2300, and a call that sends value with a gas cap gives it the cap + 7,461,079. 7,461,079 gas is enough to emit an event or to overwrite a slot that already exists, but not to write a new slot (that needs gas worth about 3.84 tPOT, the slot deposit) or to make any external call (about 7.7 x 10^7 gas), so re-entry through `transfer()` and `send()` fails; with a cap of 10^12 it succeeded. A failing `transfer()` reverts with empty data; `send()` and a capped call return false (E48).
  - Contract code can pay any amount, even 1 wei, to an address that has no account. The transaction's sender pays 0.1 tPOT for each account created this way: in gas on the Ethereum side, and in the storage deposit on the native path, where a `storageDepositLimit` without it fails the whole call with `Revive.StorageDepositLimitExhausted` (module 80, error 24; E54).
  - Calls nest at most 26 frames deep, the top call included, for `CALL`, `DELEGATECALL`, `STATICCALL` and chains of `CREATE`. The call one level deeper fails silently, with empty data (E49).
  - `selfdestruct` in a constructor is accepted, and the node's dry run holds the same 13.11 tPOT deposit as for a constructor that returns empty code. Not known: what a sent one removes or refunds, and what `selfdestruct` does to a contract deployed earlier.

## Build settings

Every byte of new runtime code holds about 0.078 tokens of deposit (`amounts-and-fees.md`), so build small. A Foundry profile with the settings we build with (Experience; we applied `via_ir` to the contract sources only):

```toml
[profile.v3]
evm_version = "cancun"
cbor_metadata = false     # no V3 explorer reads it, and every byte costs a deposit
bytecode_hash = "none"
via_ir = true             # the IR pipeline usually gives smaller code
```

- In our experience these settings and fewer public getters cut one contract from 1842 to 899 bytes of runtime code, which saved about 74 tPOT of deposit.
- Immutables cost no storage slot: they sit in the deployed code (Experience).

## Tools

- The testnet guide documents MetaMask, Remix and Hardhat for deploying and calling (Guide).
- Our own deployments used native calls only (recipe 2e); we have not deployed by Ethereum transaction, and have not run `forge create` against V3. Our own Ethereum transactions were contract calls sent with `cast` (recipe 2c), native calls through the pallets address (recipe 4), and, on Nov 15, 2026, transfers, a contract call and ERC-20 calls signed with ethers 6.
- Connection entries (Checked Nov 14, 2026: the URL and chain id are the ones `get_chain_facts` reads live):
  - Hardhat 3: `networks: { portaldotTestnet: { type: "http", url: "https://test-evm-rpc-v3.portaldot.dev", chainId: 420420777, accounts: [configVariable("PRIVATE_KEY")] } }`. Hardhat 2 takes the same entry without `type`, with `accounts: [process.env.PRIVATE_KEY]`; Hardhat 2 was not run.
  - Foundry: in `foundry.toml`, `[rpc_endpoints]` with `portaldot_testnet = "https://test-evm-rpc-v3.portaldot.dev"`, then `--rpc-url portaldot_testnet`.
- What each tool puts into a transaction on V3 when you set nothing yourself (Checked Nov 15, 2026: each tool built transactions against the testnet through a local proxy that passed on only reads, and nothing it built was sent; the base fee was 15140 to 15145 wei):

| Tool | Gas limit | Max fee | Priority fee |
|---|---|---|---|
| ethers 6.17 | `eth_estimateGas`, unchanged | 2 x base fee | 0 |
| viem 2.57 | `eth_estimateGas`, unchanged | 1.2 x base fee | 0 |
| Hardhat 3.22 with hardhat-ethers 4.2.2 (the entry above) | `eth_estimateGas`, unchanged | floor(base fee x 81/64), about 1.27 x | 1 wei |
| `cast mktx` 1.8.5 | `eth_estimateGas`, unchanged | 2 x base fee + 1 wei | 1 wei |
| `forge script` 1.8.5 | its own EVM's gas x 1.3, never asked of the node: 29005 for a transfer, 67501 for an `approve`, 329147 for a 1000-byte deployment | 2 x base fee + 1 wei | 1 wei |

- What that means here: the node takes an Ethereum transaction when its gas limit x base fee fits the sender's `eth_getBalance`. The max fee, a legacy gas price, the priority fee and the value are not part of that check, and only gas used x base fee is charged (Checked Nov 15, 2026 by transactions sent from our own test accounts, blocks 477814 to 478132; `amounts-and-fees.md`). So ethers, viem, Hardhat 3 and `cast` can keep their own fields: their larger max fees and the 1 wei priority fee cost nothing. A larger gas limit raises only what the sender must hold.
- `forge script` limits are 10^8 to 10^10 times too small. A dry run of them answers `{"code":-32000,"message":"Invalid call: Payment"}`, and a transaction sent with its gas limit of 67501 got the bare `{"code":1010,"message":"Invalid Transaction"}` (E39). Build the transaction with `cast estimate` and `cast mktx --gas-limit` (recipe 2c) instead. Whether `forge script --gas-limit` or `--skip-simulation` avoids this was not measured.
- A gas limit below what the transaction uses is refused with the same bare 1010 before the block, not mined as failed: half the estimate, and 1 percent below the gas used, were refused; 0.5 percent above the gas used was mined. `eth_estimateGas` was 4.8 percent above the gas a transfer used (block 477814), so the estimate alone was enough for it (Checked Nov 15, 2026, sent transactions).
- Foundry is not in the guide. In our experience `forge build`, `cast call`, `cast code`, `cast logs`, `cast receipt`, `cast mktx` and `cast publish` all work against `https://test-evm-rpc-v3.portaldot.dev` with `--chain 420420777`.
- Foundry reads the `.env` of the folder it runs in; run `cast` in a folder without one when you do not want its values (Experience).
- Recipe 2 in `recipes-contracts.md` has the exact commands: 2a build, 2b read, 2c call by Ethereum transaction, 2d deploy by Ethereum transaction, 2e deploy on the native path.

## What is proven and what is not

| Task | Status |
|---|---|
| Build for V3 with Foundry, solc 0.8.27, `cancun` | proven (Experience) |
| Read: `eth_call`, `eth_getCode`, `eth_getStorageAt`, `eth_getLogs`, receipts | proven (Experience; Checked Nov 14, 2026) |
| Call a contract with value by Ethereum transaction (`cast mktx`, then `cast publish`) | proven by six contract calls sent as Ethereum transactions between Oct 19 and Nov 1, 2026 |
| Send Ethereum transactions signed with ethers 6, type 2 and legacy | proven on Nov 15, 2026: transfers and a contract call, blocks 477814 to 478132 |
| `approve`, `transferFrom`, `permit` and `transfer` on the ERC-20 address of an Assets token | proven on Nov 15, 2026 on pUSD, blocks 478195 to 478206 (section "Tokens of the Assets module" below) |
| Deploy on the native path, `revive.instantiateWithCode` from an sr25519 account | proven on Oct 19, 2026: 899 bytes, deposit 83.232 tPOT, fee 0.1285 tPOT |
| Call a contract from a native account, `revive.call` | proven on Oct 27, 2026: fee 0.0253 tPOT, deposit 3.8415 tPOT |
| Run a contract call inside `multisig.asMulti` | proven in Oct 2026 |
| Deploy by Ethereum transaction (a creation transaction with no `to`: Remix, MetaMask, `cast mktx --create`, `forge create`) | seen on the chain in other builders' transactions; not sent by us. Blocks 354887 and 346634 hold legacy (type 0) creation transactions with receipt status 1; each contract is at CREATE(from, transaction nonce), and the deposits follow the rule in `amounts-and-fees.md` (Checked Nov 14, 2026). The guide shows Remix and MetaMask deploying (Guide) |
| Deploy with a salt, `uploadCode` then `instantiate`, PolkaVM code | not proven by us |

- After a creation transaction, check the receipt's `status` and `eth_getCode` at the new address. Three reverted creation transactions (blocks 343008 to 343010) carry a `contractAddress` on their receipts, but no code is there, and the node shows `Revive.EthExtrinsicRevert` with `Revive.ContractTrapped` (module 80, error 11) (Checked Nov 14, 2026).
- A deployment's fee grows with the size of its init code and is about the same on either path: the creation transaction in block 354887 (6368 bytes of init code) paid 0.6466 tPOT, and `paymentInfo` of a native `instantiateWithCode` with 6348 bytes gave 0.6475 (Checked Nov 14, 2026); the native deployment of Oct 19, 2026 (899 bytes of runtime code) paid 0.1285.

## The native path

Call shapes (Checked Nov 14, 2026, from the metadata):

- `revive.call(dest: H160, value: Compact<u128>, weightLimit: Weight, storageDepositLimit: Compact<u128>, data: Bytes)`, call index `0x5001`.
- `revive.instantiateWithCode(value: Compact<u128>, weightLimit: Weight, storageDepositLimit: Compact<u128>, code: Bytes, data: Bytes, salt: Option<[u8;32]>)`, call index `0x5003`.
- `value` is in native base units (14 decimals); the contract sees `msg.value = value x 10^4` (Experience, proven Oct 27, 2026).
- `data` of `revive.call` is the same ABI calldata an Ethereum transaction would carry.
- For EVM code, append the ABI-encoded constructor arguments to the init code and pass `data` as `0x`. The chain says so in its error `EvmConstructorNonEmptyData`: "When calling an EVM constructor `data` has to be empty. EVM constructors do not accept data. Their input data is part of the code blob itself." (Checked Nov 14, 2026.)
- Without a salt, the new contract's address is the CREATE address of the deployer's `0x` form and its account nonce; with a salt, the CREATE2 address over keccak-256 of the init code with its constructor arguments (Checked Nov 14, 2026 with dry runs; `addresses.md`).
- Inside the contract, `msg.sender` is the caller's `0x` form (Experience).

## The 14 Revive calls

Checked Nov 14, 2026 (names, indices and the chain's own descriptions):

| Index | Call | What it does |
|---|---|---|
| `0x5000` | `ethTransact(payload)` | the wrapper an Ethereum JSON-RPC server uses for a raw Ethereum transaction; it cannot be dispatched directly |
| `0x5001` | `call` | calls a contract, optionally sending value |
| `0x5002` | `instantiate` | creates a contract from code already uploaded (by code hash) |
| `0x5003` | `instantiateWithCode` | uploads code and creates the contract in one step |
| `0x5004` | `uploadCode(code, storageDepositLimit)` | uploads code only; reserves the code deposit from the caller |
| `0x5005` | `removeCode(codeHash)` | removes code no contract uses and refunds its deposit to the uploader |
| `0x5006` | `setCode(dest, codeHash)` | privileged: changes the code of an existing contract |
| `0x5007` | `mapAccount` | links a native account to its `0x` form; a no-op while autoMap is on |
| `0x5008` | `unmapAccount` | disabled while autoMap is on |
| `0x5009` | `dispatchAsFallbackAccount(call)` | runs a call as the caller's fallback account, for recovery (`addresses.md`) |
| `0x500a` | `ethInstantiateWithCode` | the deployment form used only by Ethereum transactions |
| `0x500b` | `ethCall` | the call form used only by Ethereum transactions |
| `0x500c` | `ethSubstrateCall(call, transactionEncoded)` | runs a native call from an Ethereum transaction (the pallets-address route) |
| `0x500d` | `batchMapAccounts(accounts)` | maps many accounts; free if at least 90 percent were unmapped or held deposits |

## The 3 Revive events

Checked Nov 14, 2026:

- `ContractEmitted { contract: H160, data: Vec<u8>, topics: Vec<H256> }`: a log. Treat it as address = contract, plus topics and data, and decode it with the ABI.
- `Instantiated { deployer: H160, contract: H160 }`.
- `EthExtrinsicRevert { dispatch_error }`. The chain documents it as: "Ethereum transactions always complete successfully at the extrinsic level, as even reverted calls must store their `ReceiptInfo`. To distinguish reverted calls from successful ones, this event is emitted for failed Ethereum transactions." Block 343010 shows it: a reverted Ethereum transaction with `ExtrinsicSuccess` on the Substrate side. Read the receipt's `status`, or look for this event.

Events and `eth_getLogs` (Checked Nov 14, 2026):

- The contract events of an Ethereum transaction are in both places: `eth_getLogs` and `revive.ContractEmitted` in `System.Events` (block 389240, for example; the order of the logs can differ).
- The events of a native-path call (`revive.call`, a multisig, a batch) exist only as `revive.ContractEmitted`; `eth_getLogs` returns `[]` for them (block 463584, and a native-path call from Oct 27, 2026).
- `eth_getLogs` has no block-range limit: block 0 to `latest` answered. A `fromBlock` after the `toBlock`, or a `toBlock` beyond the head, answers `{"code":-32000,"message":"Failed to filter logs"}` (E33).
- `get_contract_events` reads both sides; recipe 5c in `recipes.md` shows the code.

## The runtime API (ReviveApi)

- Methods (Checked Nov 14, 2026, 52 with the `_versioned` forms, the same on both networks): `call`, `instantiate`, `upload_code`, `eth_transact`, `eth_transact_with_config`, `eth_estimate_gas`, `eth_pre_dispatch_weight`, `gas_price`, `balance`, `nonce`, `address`, `account_id`, `runtime_pallets_address`, `code`, `get_storage`, `get_storage_var_key`, `new_balance_with_dust`, `eth_block`, `eth_block_hash`, `eth_receipt_data`, `block_gas_limit`, `max_extrinsic_weight_in_gas`, `block_author`, `trace_block`, `trace_tx`, `trace_call`, `trace_call_with_config`, `version_declarations`, and a `_versioned` form of most of them.
- In @polkadot/api they are `api.call.reviveApi.<camelCase name>`. They exist when @polkadot/api loads metadata version 15 or newer, which it does by default; a connection built from saved version 14 metadata has no `api.call.reviveApi` (Checked Nov 14, 2026).
- The runtime API answers on the mainnet too, which has no Ethereum RPC: `gasPrice` (5000 wei), `balance`, `nonce`, `ethEstimateGas` and the dry runs (Checked Nov 14, 2026). `ethEstimateGas(tx, config)` takes two arguments and gave exactly the `eth_estimateGas` answer at the same block (`evm-checks.md` section 9).
- Read results with `.toJSON()`: they are newer than @polkadot/api's static types (Experience).
- The fields of a dry run (Checked Nov 14, 2026 for `instantiate`): `weightConsumed`, `weightRequired { refTime, proofSize }`, `storageDeposit { charge | refund }`, `maxStorageDeposit`, `gasConsumed`, and `result`.
  - `call`: `result.ok { flags: { bits }, data }` or `result.err`.
  - `instantiate`: `result.ok { result: { flags, data }, addr }` or `result.err`.
  - Flags bit 1 set means the contract reverted; `data` then holds the revert data (Checked Nov 14, 2026; `errors.md` E9).
- The chain documents `ContractReverted` as "only returned from extrinsics. When called directly or via RPC an `Ok` will be returned. In this case the caller needs to inspect the flags" (Checked Nov 14, 2026).
- A module error in a dry run comes as `{ module: { index, error } }`, where `error` is 4 bytes such as `"0x18000000"` and its first byte is the error's index. Name it with `api.registry.findMetaError(Uint8Array.of(index, errorBytes[0]))`; `explain_error` does this (Checked Nov 14, 2026; `errors.md` E10).
- `reviveApi.balance(0x...)` returns the same number as `eth_getBalance` (Checked Nov 14, 2026).

## Errors you may meet

Names, indices (module 80) and texts from the metadata, Checked Nov 14, 2026. "Seen" means a dry run or a transaction on the chain returned it. `errors.md` has the traps, by entry number.

- `OutOfGas` (3): "The executed contract exhausted its gas limit." Seen with a weight limit below the dry run's, in a deployless `eth_call` too heavy for one extrinsic (E10, E32), and in `eth_call`s whose gas field was 50 or 97 percent of the estimate (Nov 15, 2026).
- `TransferFailed` (4): "Performing the requested transfer failed. Probably because there isn't enough free balance in the sender's account." Seen with a value larger than the balance (E10).
- `MaxCallDepthReached` (5): never seen by name. A call 26 frames deep that calls once more gets a failed call with empty data instead (E49).
- `StorageDepositNotEnoughFunds` (23): "Origin doesn't have enough balance to pay the required storage deposits." Seen in dry runs from an account with no balance (E7, E18). On Nov 15, 2026, `eth_call`s of one deployment with gas fields far too small (10^13 and 10^15) answered `{"code":-32000,"message":"Not enough gas supplied: Module(ModuleError { index: 80, error: [23, 0, 0, 0], message: Some(\"StorageDepositNotEnoughFunds\") })"}` from a sender that held 156,000 tPOT: there the cause is the gas field, not the balance. Which text a gas field that is too small gets depends on the contract (`OutOfGas` above, `ContractTrapped` below).
- `StorageDepositLimitExhausted` (24): "More storage was created than allowed by the storage deposit limit." Seen with a limit below the deposit, also when the limit leaves out the 0.1 tPOT of each account that the contract's code creates by paying it; set the limit from `maxStorageDeposit` (E7).
- `ContractReverted` (26): returned only from extrinsics; dry runs and the Ethereum RPC report a revert through the flags or `execution reverted` (E9, E26).
- `ContractTrapped` (11): "Contract trapped during execution." Seen in the reverted creation transactions of blocks 343008 to 343010, and in an `eth_call` with a gas field of 10^13 for a constructor that writes one slot (Nov 15, 2026).
- `InvalidInstruction` (31): "The program contains an invalid instruction." Seen for the blob opcodes, `INVALID` and unassigned opcodes (E31; `evm-checks.md` section 1).
- `UnsupportedPrecompileAddress` (47): "Unsupported precompile address." Seen for a call to `0x0a` (E31; `evm-checks.md` section 2).
- `TxFeeOverdraw` (53): the gas limit of an Ethereum transaction was too low for the deposit it needed (the chain's text is in `amounts-and-fees.md`). Not seen.
- `CodeRejected` (27), `BlobTooLarge` (28), `CallDataTooLarge` (48), `DuplicateContract` (18), `EvmConstructorNonEmptyData` (54): not seen.
- `AccountUnmapped` (43), `AutoMappingEnabled` (66): about account links. With autoMap on, whether `AccountUnmapped` can still fire is not known (E8).
- `BalanceConversionFailed` (40, "Failed to convert a U256 to a Balance", E3), `StorageRefundNotEnoughFunds` (56), `StorageRefundLocked` (57), `PendingDepositCleanup` (67): not seen.
- From the Ethereum RPC: `execution reverted` with code 3 (E26); `Invalid call: Payment` for a small `gas` field (E27); `Failed to dispatch call: ...` for a native call through the pallets address (E29); `The transaction consumes more than the allowed weight` for a call too heavy for one extrinsic (E32); `Failed to filter logs` (E33); `unknown variant newHeads` from `eth_subscribe` (E30); `insufficient funds for gas * price + value`, and error 1010 when sending (E1); `Effective gas price 1 lower than base fee 15140` for a max fee or legacy gas price of 1 wei, below the base fee, and `Not enough gas supplied: Off by: 212144843580` for a gas field a little below the need (Nov 15, 2026). The ERC-20 address of an asset with no metadata reverts `name()` with `execution reverted: revert: Metadata not found`, and a failed write there answers `failed to run contract:` with an Assets (39) or Balances (6) module error or a `Token(...)` text (`evm-checks.md` section 3, E40).

## Limits of eth_call and estimates

- `eth_call` takes a state override as its third parameter (`code`, `balance` and `stateDiff` were applied); `eth_estimateGas` ignores one; `eth_simulateV1` answers "Method not found" (Checked Nov 14, 2026; E21). Two limits of overrides (Checked Nov 15, 2026):
  - An address given only `code` has no account. The first payment to it costs 0.1 tPOT, as for a new account, and fails under any gas cap; later payments behave as for a deployed contract. Create test contracts inside a deployless call (`new C()`) instead.
  - A `balance` override creates the account, even with a balance of 0, so an override cannot show how much tPOT a new account needs.
- For a "what if" estimate against state you supply, our tools used the runtime call `reviveApi.ethTransactWithConfig` with a state override (Experience).
- An estimate does not check that the sender can pay the fee (`amounts-and-fees.md`). An `eth_call` without a gas field does not check that the sender can pay a storage deposit either: a deployment holding 112.95 tPOT of deposit ran from an origin holding 5.2 tPOT (Checked Nov 15, 2026).
- Gas readings differ between the two kinds of dry run: `gasleft()` falls during an `eth_call`, but reads 2^64 - 1 throughout the node's dry run without a gas limit (`evm-checks.md` section 11). Measure gas-dependent code with `eth_call`.
- `eth_call` and `eth_getBalance` answered at block 1 on Nov 14, 2026; in October 2026 the RPC refused state older than about 256 blocks (`open-questions.md` item 1). Test the depth at run time before you depend on it.

## Contract storage

- A contract's storage is a child trie named by its trie id. A 32-byte slot `K` is stored there under `blake2_256(K)`. This matters for storage proofs (Experience).
- `eth_getStorageAt` reads any slot, including values without a getter (Experience). `reviveApi.getStorage` exists too (Checked Nov 14, 2026).
- Contract records (`revive.accountInfoOf`) hold the code hash, the trie id, `storageBytes`, `storageItems` and the deposits: `storageBaseDeposit`, `storageByteDeposit`, `storageItemDeposit` (Checked Nov 14, 2026). Code records (`revive.codeInfoOf`) hold `owner`, `deposit`, `refcount`, `codeLen`, `codeType` and `behaviourVersion`.
- The root origin can replace any contract's code with `revive.setCode`, and both networks have a Sudo key (Checked Nov 14, 2026).

## ink!

- The Contracts module (index 21) runs ink! contracts. The testnet held 14 ink! contracts and 11 code blobs on Nov 14, 2026, as on Nov 13, 2026 (Checked).
- Calls between ink! and Solidity contracts are "awaiting confirmation" (Guide).
- The ink! language was discontinued upstream on Jan 27, 2026 (Experience, from the upstream announcement). For new work, prefer Solidity on Revive.

## Tokens of the Assets module seen from Solidity

- Every asset of the Assets module has an ERC-20 address: the asset id as 4 big-endian bytes, then 12 zero bytes, then `0x0001`, then `0x0000`. Asset 2 is `0x0000000200000000000000000000000000010000` (Checked Nov 14, 2026: `totalSupply()` there returned 15000000000000000000, the module's `assets.asset(2).supply`).
- The PoolAssets module (the liquidity tokens of AssetConversion) uses the same layout with `0x0002`: pool asset 0 is `0x0000000000000000000000000000000000020000` (Checked Nov 14, 2026).
- `name()`, `symbol()`, `decimals()`, `totalSupply()`, `balanceOf(holder)` and `allowance()` matched the module's storage (Checked Nov 14, 2026; `allowance()` on Nov 15, 2026). `decimals()` is the asset's own: 6 for pUSD (asset 7777), so never assume 18. An id with no asset still answers `totalSupply()`, `balanceOf()` and `allowance()` with 0 and no error, and a transfer there fails with `Assets.Unknown`, so check that the asset exists before you trust a zero. `convert_address` recognises these addresses.
- Writes work: we sent `approve`, `transferFrom`, `permit` and `transfer` on pUSD on Nov 15, 2026 (blocks 478195 to 478206). What differs from an OpenZeppelin token (`evm-checks.md` section 3 has the texts and numbers):
  - A failure is not revert data. Tools get code -32000 with a module error, and a calling contract gets a failed call with empty data, so `SafeERC20` reverts with no reason (E40).
  - Every approval, and a permit, holds 0.1 tPOT from the owner while it exists, outside gas (E41).
  - An approval of 2^128 or more, `type(uint256).max` included, is stored as 2^128 - 1 and goes down with each `transferFrom` (E43).
  - A transfer that would leave the sender below the asset's minimum balance moves the whole balance, while the `Transfer` log shows the amount asked (E42).
  - tPOT sent along with a token call stays on the token address (E44).
  - The EIP-712 domain of `permit` is the asset's metadata name, version "1", chain id 420420777 and the token address; `eip712Domain()` is not served.
- The modules `AssetsPrecompiles` (index 91) and `AssetsPrecompilesPermit` (index 92) exist. `AssetsPrecompiles` maps 52 asset indexes (`nextAssetIndex` is 52) to the 52 asset ids of the testnet, but no address found uses those indexes; what reads them is not known (Checked Nov 14, 2026).
- Upstream polkadot-sdk has no ERC-721 precompile for the Nfts or Uniques modules (Experience, from the upstream source on Oct 15, 2026).

## Separate token worlds

- A token made as a Solidity contract in Revive, an asset in the Assets module and an NFT in the Nfts module are separate objects (Guide). The one link between them: an Assets-module asset can be used from Solidity at its ERC-20 address (above). A Solidity token does not appear in the Assets module, and no ERC-721 address for Nfts is known.
- Pick one per token, and say which one in your code and docs.
