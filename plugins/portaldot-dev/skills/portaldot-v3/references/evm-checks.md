# EVM checks: what the EVM and the Ethereum RPC really do

Read-only measurements on the Portaldot V3 testnet (Ethereum RPC `https://test-evm-rpc-v3.portaldot.dev`, chain id 420420777, client `eth-rpc/main-fddd431`; Substrate node `wss://test-node-v3.portaldot.dev`), made by the Bridge Zero team on Nov 14, 2026. The checks that need only the node were repeated on the mainnet (`wss://live-v3-node.portaldot.dev`, which has no Ethereum RPC). Nothing was sent: every answer comes from `eth_call`, `eth_estimateGas`, block and state reads, or the node's runtime API. The exception is section 5, whose rows marked Nov 15, 2026 include sends that could not be accepted.

The main findings:

- Code built for `cancun` runs, except the blob opcodes `BLOBHASH` and `BLOBBASEFEE`, which fail the call (section 1).
- `block.prevrandao` is the constant 2500000000000000 at every block measured, from block 1 to the head (section 1).
- Precompiles `0x01` to `0x09` and P256VERIFY (`0x100`) work; KZG (`0x0a`) and BLS12-381 (`0x0b` to `0x11`) are absent (section 2).
- Every Assets-module token has an ERC-20 address: the asset id as 4 big-endian bytes, then 12 zero bytes, then `0001`, then `0000`; PoolAssets use `0002` (section 3).
- `latest` and `pending` are the best block, `safe` and `finalized` the finalized head (section 4).
- Receipts have `cumulativeGasUsed` 0, type-2 transaction objects have `gasPrice` 0, `transactionIndex` counts the timestamp inherent, and `stateRoot` is not a state root (section 5).
- No filters, no `eth_getProof`, no `eth_createAccessList`, no `eth_simulateV1`. The RPC host also answers on `wss://`, where `eth_subscribe` takes `newBlockHeaders` and `logs`, not `newHeads` (section 5).
- `eth_getLogs` has no block-range limit. A call is bounded by the weight of one extrinsic, not by the block gas limit (section 6).
- No helper contracts at their usual addresses on either network; a deployless `eth_call` batches reads instead (section 10).

Each line below gives what was asked, what the chain answered, and what it means for your code. Basis: **Checked** (measured on Nov 14, 2026, unless another date is given) or **Reported** (said by others, not checked). Anything not measured says so.

How the opcode checks were run: a "deployless" `eth_call` with no `to`, from the Treasury's `0x` form, with tiny creation code as `data`. The chain runs the code as a constructor and returns what it returns:

```json
{"method":"eth_call","params":[{"from":"0x8ddee436166f311ddeed36d714b08f512670d16e","data":"0x4260015260216000f3"},"0x71258"]}
```

`42` is the opcode under test (here `TIMESTAMP`); `60015260216000f3` stores the top of the stack at memory offset 1 and returns 33 bytes, so the answer is `0x00` followed by one 32-byte word. Each bytecode was checked by hand against a disassembly, and each value against a second source (the node's storage, the block header, or an independent library).

## 1. Environment opcodes

Pinned to block 463448 (`0x71258`) unless noted. All Checked.

- `block.timestamp` (`0x42`): `0x6af857c6` = 1794660294. The node's `Timestamp.Now` at that block was 1794660294001 ms, and the block's `timestamp` field is the same `0x6af857c6`. Seconds, as on Ethereum: the node's milliseconds divided by 1000, rounded down. The same held at 11 blocks from block 1 to the head.
- `block.number` (`0x43`): 463448, the block named in the `eth_call`. An `eth_call` at block N runs with `block.number` = N, not N + 1.
- `block.chainid` (`0x46`): 420420777 (`0x190f1ca9`), the same as `eth_chainId`.
- `block.basefee` (`0x48`): 15695 wei, equal to that block's `baseFeePerGas` and to `eth_gasPrice` at the time.
- `block.gaslimit` (`0x45`): 18446744073709551615 (`0xffffffffffffffff`, 2^64 - 1), equal to the block's `gasLimit`. It is not a real limit; do not size work by it.
- `block.coinbase` (`0x41`): the `0x` form of the block's author. At 11 blocks (1 to the head) it equalled the block's `miner` field and the keccak-256 `0x` form of the author that the node's BABE digest names. It alternated between the `0x` forms of the two validators on Nov 14, 2026.
- `block.prevrandao` (`0x44`): 2500000000000000 (`0x8e1bc9bf04000`) at blocks 1, 1000, 100000, 300000, 363459, 462459, 463449 and 463456 to 463459. The block's `mixHash` holds the same value and `difficulty` is `0x0`. It is a constant: never use it as randomness. This confirms what others reported.
- `tx.gasprice` (`0x3a`): 15695 wei with no `gasPrice` in the call (the base fee), and the same when `gasPrice` was set to `eth_gasPrice`.
- `gasleft()` at entry (`0x5a`): 18446743359831245280 (`0xffffff59c98981e0`), close to 2^64 - 1, for a call without a `gas` field. Gas numbers on this chain include the storage deposit (see `amounts-and-fees.md`); do not compare `gasleft()` with Ethereum figures.
- `address(this)` in a constructor (`0x30`): `0x30ca0ab4156e37027841a1504e78aae6116468db`, which is keccak-256(rlp([from, nonce]))[12:] for the Treasury's `0x` form and its nonce 0. The usual CREATE rule.
- Code size in a constructor: `CODESIZE` (`0x38`) gave 9, the length of the creation code; `EXTCODESIZE(address(this))` (`0x30 0x3b`) gave 0. As on Ethereum, so the "is a contract" test by code size fails during construction here too.
- `selfbalance()` (`0x47`) and `msg.value` (`0x34`): 0 without a value; 10000 each with `"value":"0x2710"` (10000 wei, one native base unit). The constructor holds the value it was sent.
- `msg.sender` (`0x33`) and `tx.origin` (`0x32`): both `0x8ddee436166f311ddeed36d714b08f512670d16e`, the `from` of the call.
- `blockhash(block.number - 1)` (`0x40`): `0xeebdc427...57cf61`, the Ethereum block hash of block 463447 as `eth_getBlockByNumber` shows it (not the Substrate block hash). `blockhash(block.number)` gave 0, as on Ethereum.
- `PUSH0` (`0x5f`), `TSTORE`/`TLOAD` (`0x5d`/`0x5c`) and `MCOPY` (`0x5e`) run: `60075f5260205ff3` returned 7; a `TSTORE` of 42 then a `TLOAD` returned 42; an `MCOPY` of 33 bytes returned the copied word. Code built for `cancun` runs, apart from the two blob opcodes below.
- `blobhash(0)` (`0x49`) and `block.blobbasefee` (`0x4a`): refused when executed. The whole call fails with `{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 80, error: [31, 0, 0, 0], message: Some(\"InvalidInstruction\") })"}`. Code that merely contains `0x49` where it is never reached ran normally (`60075f5260205ff349` returned 7). So only the path that executes a blob opcode fails.
- An unassigned opcode (`0x0c`) and `INVALID` (`0xfe`): the same `InvalidInstruction` answer, code -32000. On Ethereum `INVALID` is an exceptional halt; here the dry run reports a module error instead of "execution reverted".
- A second path, the node's own dry run (`reviveApi.instantiate` with the same creation code), gave the same answers on the testnet for `TIMESTAMP`, `NUMBER`, `CHAINID`, `PREVRANDAO`, `BASEFEE`, `PUSH0`, `TSTORE`/`TLOAD` and the two blob opcodes (`Revive.InvalidInstruction`). On the mainnet (block 1076881) the same codes gave the same results, with `CHAINID` 780780777, `BASEFEE` 5000 wei and the same `PREVRANDAO` constant.
- Not measured: whether a real deployment refuses runtime code that starts with `0xEF` (EIP-3541). A deployless `eth_call` that returned the single byte `0xef` as code answered `"0xef"` with no error, but that is a dry run, not a deployment.

## 2. Precompiles

Called with `eth_call` `{"from":"0x8dde...d16e","to":"<address>","data":"<input>"}` at `latest`. The expected answers were computed independently with the @noble libraries and Node's crypto. An address with no code (`0x...00ab`, a control) answers `0x` with no error. All Checked.

| Address | Precompile | Input | Answer | Verdict |
|---|---|---|---|---|
| `0x01` | ecrecover | own vector (keccak-256 of "hello", signed with a public throwaway key) and the go-ethereum vector | the signer, `0x...ceaccac640adf55b2028469bd36ba501f28b699d` for the go-ethereum vector; `0x` for `v` = 29 | present, correct |
| `0x02` | sha256 | "abc" | `0xba7816bf...f20015ad` | present, correct |
| `0x03` | ripemd160 | "abc" | `0x000...008eb208f7e05d987a9b044a8e98c6b087f15a0bfc` | present, correct |
| `0x04` | identity | `0x0102030405` | `0x0102030405` | present, correct |
| `0x05` | modexp | 3^(p-2) mod p (secp256k1 field prime); 2^10 mod 1000 | the inverse of 3; `0x0018` | present, correct |
| `0x06` | bn256 add | G + G | 2G (`0x030644e7...`) | present, correct |
| `0x07` | bn256 mul | 3 x G | 3G | present, correct |
| `0x08` | bn256 pairing | empty; e(G,H) e(-G,H); e(G,H) | 1; 1; 0 | present, correct |
| `0x09` | blake2f | EIP-152 vector 5 (12 rounds, "abc", 213 bytes) | blake2b-512("abc"), `0xba80a53f...d4009923` | present, correct |
| `0x0a` | KZG point evaluation | any input | the call fails: `Module(ModuleError { index: 80, error: [47, 0, 0, 0], message: Some("UnsupportedPrecompileAddress") })` | absent, and calling it fails |
| `0x0b` to `0x11` | BLS12-381 (EIP-2537) | valid inputs made of points at infinity | `0x`, no error | absent (no code) |
| `0x100` | P256VERIFY (secp256r1) | a valid signature; the same with one bit of the hash changed | 1; `0x` | present, correct |
| `0x...0900` | pallet-revive System | `minimumBalance()`; `hashBlake256("abc")`; `toAccountId(address)` | 10^17 (0.1 tPOT in wei); blake2b-256("abc"); the 32-byte account id | present |

What it means:
- Solidity's `ecrecover`, `sha256`, `ripemd160`, modexp, the alt_bn128 curve (Groth16 and other zk verifiers) and blake2f work as on Ethereum.
- Malformed input fails the whole call, as on Ethereum. The texts are the RPC's own: an off-curve point to `0x06` gave `failed to run contract: Other("Invalid curve point")`, a 210-byte input to `0x09` gave `Other("invalid input length")`, and a final flag of 2 gave `Other("invalid final flag")`, each with code -32000.
- There is no KZG point evaluation (`0x0a`) and there are no BLS12-381 precompiles. An `eth_call` straight to `0x0a` fails as shown; a `STATICCALL` to it from contract code returns failure (success 0, no data). A call to `0x0b` to `0x11` silently succeeds with no data, so check the length of the returned data before you trust it.
- P256 (passkey, WebAuthn) signatures can be checked on chain with the precompile at `0x0000000000000000000000000000000000000100`: 1 for a valid signature, empty output otherwise.
- The System precompile at `0x0000000000000000000000000000000000000900` answers `minimumBalance()` in wei (100000000000000000 = 0.1 tPOT, the existential deposit), `hashBlake256(bytes)` and `toAccountId(address)`: for the Treasury's `0x` form it returned the Treasury's account id (`modlpy/trsry` padded with zeros); for an address with no linked account, the address followed by twelve `0xEE` bytes. Its other functions were not measured.
- A second precompile at `0x0000000000000000000000000000000000000901` exists (it reverts on an unknown selector, like `0x...0900`, with `panic: memory allocation error (0x41)`). Its functions were not measured.
- `eth_getCode` at a precompile of the chain (`0x...0900`, `0x...0901`, the token addresses of section 3) returns `0x60006000fd` (revert if run as code), not `0x`.
- A scan of every address whose last two bytes are 1 to 65535 (one `STATICCALL` of `totalSupply()` each, in deployless `eth_call`s of 4096 calls) found answers only at `0x02` to `0x0a`, `0x0900` and `0x0901`. Precompiles that answer a 4-byte input with "success, no data" stay invisible to such a scan (`0x01` and `0x100` do), so this is a lower bound.
- The node's own dry run (`reviveApi.call`) agreed on both networks for `0x02` (sha256 of "abc"), `0x08` (empty pairing is 1), `0x0a` (fails with Revive error 47, `UnsupportedPrecompileAddress`), `0x0b` (no data) and `minimumBalance()` at `0x...0900` (10^17 wei).
- Others report that Revive has no ed25519 and no staking precompile (Reported). Not measured.

## 3. Tokens of the Assets module seen from Solidity

Every asset of the Assets module has an ERC-20 interface at a fixed address. Checked against the Assets module's storage at the same block (463542) for assets 2, 4242 and 7777, and for pool assets at block 463587.

- The rule: the asset id as a 4-byte big-endian number, then 12 zero bytes, then `0001`, then `0000`. Asset 2 is `0x0000000200000000000000000000000000010000`; asset 7777 (`0x1e61`) is `0x00001e6100000000000000000000000000010000`.
- What answered there: `name()`, `symbol()`, `decimals()`, `totalSupply()` and `balanceOf(holder)` returned exactly the module's `assets.metadata` and `assets.asset(id).supply`, and `assets.account(id, holder).balance` for the largest holder (given as its `0x` form). Asset 2: "test asset", "TEST", 18, 15000000000000000000. The other two matched the same way.
- The first 4 bytes are the asset id itself, not an index: at `0x0000000100000000000000000000000000010000` the chain answered with asset 1's metadata.
- An id with no asset still answers `totalSupply()` and `balanceOf()` with 0 and no error; `name()`, `symbol()` and `decimals()` revert with `execution reverted: revert: Metadata not found` (code 3). Check that an asset exists (or has metadata) before you trust a zero.
- The same layout with `0002` is the PoolAssets module (the liquidity tokens of AssetConversion): `totalSupply()` at `0x0000000000000000000000000000000000020000` matched `poolAssets.asset(0).supply` (316227766016837933), and pool assets 1, 3 and 6 matched too. Pool tokens have no metadata, so `name()` reverts with "Metadata not found".
- A scan of all 65535 values of bytes 16 and 17 (first 4 bytes = 3) found these two prefixes only, `0001` and `0002`. The upstream polkadot-sdk prefixes `0120`, `0220` and `0320` are empty here.
- EIP-2612 support: the module `AssetsPrecompilesPermit` keeps permit nonces per (token address, owner), and its `chainId` constant is 420420777. `nonces(owner)` at a token address returned the same value as that storage, and `DOMAIN_SEPARATOR()` answered. A permit itself was not measured.
- The module `AssetsPrecompiles` maps 52 asset indexes to the 52 asset ids (`assetIndexToForeignAssetId`), but no address found here uses those indexes. Not known what reads them.
- Not measured: `transfer`, `approve`, `transferFrom` and `allowance` (a transfer would change state), and what a token address does with a `msg.value`.

## 4. Block tags

`eth_getBlockByNumber(<tag>, false)` against the node's `chain_getHeader` (best) and `chain_getFinalizedHead`, three rounds 7 s apart (blocks 463634 to 463641). All Checked.

- `latest` and `pending`: the node's best block, the same number and hash in every round (once one block newer, because a block arrived between the two requests). There is no separate pending block.
- `finalized` and `safe`: the node's finalized head, normally 2 blocks behind the best block. `safe` gave the same block as `finalized` (in one round one block later, as the finalized head moved between the requests). The hash equals `revive.blockHash(number)` in the node's storage.
- `earliest` and `0x0`: block 0 with hash `0x7c05b2dc7486f81a693d676553fa13f380b5be16da7c739b182931cd6cf07001` and timestamp `0x0`. That is not the Substrate genesis hash (`0xd4f9acbc...283bd`): never compare the two.
- `eth_blockNumber` equals the node's best block.
- What it means: wait for `finalized` (or `safe`) before you treat a result as settled. `latest` can still change.

## 5. The JSON-RPC surface

Each method once with harmless parameters, on Nov 14, 2026. Nothing that sends or signs was called. Checked. On Nov 15, 2026 we asked the methods again and added those that send or sign, with requests that could not be accepted: transactions signed by new, empty accounts with random keys held only in memory. All were refused. Checked; those rows say Nov 15, 2026.

| Method | Answer |
|---|---|
| `eth_chainId`, `net_version` | `0x190f1ca9`, `"420420777"` |
| `web3_clientVersion` | `eth-rpc/main-fddd431/x86_64-unknown-linux-gnu/rustc1.98.0` |
| `eth_syncing`, `eth_accounts`, `net_listening`, `net_peerCount` | `false`, `[]`, `true`, `0x1` |
| `eth_blockNumber`, `eth_gasPrice`, `eth_maxPriorityFeePerGas` | answers; the gas price was 15690 to 15695 wei; the priority fee `0x0` |
| `eth_feeHistory("0x4", "latest", [25, 75])` | answers: `baseFeePerGas` the same in every block, `gasUsedRatio` 0, every `reward` `0x0`. The block count must be hex: the JSON number `4` answers ``{"code":-32602,"message":"Invalid params","data":"invalid type: integer `4`, expected a (both 0x-prefixed or not) hex string or byte array containing between (0; 32] bytes at line 1 column 1"}`` (Nov 15, 2026, measured twice; `errors.md` E36) |
| `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount` (`latest` and `pending`) | answer |
| `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getBlockTransactionCountByNumber`, `eth_getBlockTransactionCountByHash` | answer |
| `eth_getTransactionByHash`, `eth_getTransactionByBlockNumberAndIndex`, `eth_getTransactionByBlockHashAndIndex`, `eth_getTransactionReceipt`, `eth_getBlockReceipts` | answer; an unknown hash gives `null`, with no error |
| `eth_getLogs` | answers (limits in section 6) |
| `eth_call` | answers, and takes a state override as the third parameter: `code`, `balance` and `stateDiff` were all applied |
| `eth_estimateGas` | answers, but ignores a state override: with an override that put reverting code at the target it returned the same estimate as without |
| `debug_traceTransaction(hash, {"tracer":"callTracer"})`, `debug_traceBlockByNumber`, `debug_traceCall` (`callTracer`, `prestateTracer`) | answer. `debug_traceTransaction` without a tracer object answered `{"code":-32000,"message":"No Ethereum extrinsic found"}` for the same, existing transaction |
| `eth_subscribe` over HTTP | `{"code":-32603,"message":"Internal error"}` |
| `eth_subscribe` over WebSocket, `wss://test-evm-rpc-v3.portaldot.dev` | the same host answers on `wss://` (`eth_chainId` gave `0x190f1ca9`). `["newBlockHeaders"]` sent one notification per block (two blocks in a row, then `eth_unsubscribe` returned `true`), and `["logs", {}]` gave a subscription id. `["newHeads"]` answered ``{"code":-32602,"message":"Invalid params","data":"unknown variant `newHeads`, expected `newBlockHeaders` or `logs` at line 1 column 10"}``, and `["newPendingTransactions"]` the same with its own name. A subscription id is a text of 16 letters and digits (for example `LWtrF54TSceGp2Bb`), not `0x` hex, and `eth_unsubscribe` of an id that does not exist answers `false`, not an error (Nov 15, 2026; the id form seen twice) |
| `eth_sendRawTransaction` | text that is not hex of whole bytes answers `-32602` `Invalid params` (`OddLength`, `InvalidHexCharacter`; `errors.md` E36). Bytes it cannot decode as an Ethereum transaction (nonsense, cut off, a Substrate extrinsic, a legacy transaction without a chain id) answer `{"code":-32000,"message":"Invalid transaction"}` (E35). The rest it passes on to the node, even a transaction signed for chain id 1, a blob (type 3) or a set-code (type 4) transaction; each one we sent came back the first time as `{"code":1010,"message":"Invalid Transaction"}`, with no reason (E1). A raw transaction without `0x` was passed on too (Nov 15, 2026) |
| `eth_sendTransaction` | `{"code":-32000,"message":"Account not found for address 0x..."}`: the RPC holds no keys (`errors.md` E37) (Nov 15, 2026, measured twice) |
| `eth_sign`, `eth_signTypedData_v4` | `{"code":-32601,"message":"Method not found"}` (Nov 15, 2026) |
| `eth_createAccessList`, `eth_getProof`, `eth_simulateV1`, `eth_blobBaseFee`, `eth_newFilter`, `eth_newBlockFilter`, `eth_newPendingTransactionFilter`, `eth_getFilterChanges`, `eth_getFilterLogs`, `eth_uninstallFilter`, `txpool_content`, `txpool_status`, `rpc_modules`, `debug_traceBlockByHash`, `eth_getUncleCountByBlockNumber`, `eth_protocolVersion`, `eth_coinbase`, `eth_mining`, `eth_hashrate`, `web3_sha3`, `eth_getHeaderByNumber` | `{"code":-32601,"message":"Method not found"}` |

Field quirks, seen in the blocks and receipts of three blocks that hold Ethereum transactions (450413, 463467, 463615):

- `transactionIndex` is the extrinsic's position in the Substrate block. Extrinsic 0 is always the `timestamp.set` inherent, so the first Ethereum transaction has index `0x1`, and `eth_getTransactionByBlockNumberAndIndex(block, "0x0")` returns `null`.
- `cumulativeGasUsed` is `0x0` in every receipt, while `gasUsed` is filled in. The block's `gasUsed` is the sum of its receipts' `gasUsed`. Do not read gas from `cumulativeGasUsed`.
- In a mined type-2 (EIP-1559) transaction object, `gasPrice` is `0x0`. The price paid is the receipt's `effectiveGasPrice` (the base fee, since the priority fee is 0). In a legacy (type 0) one, `gasPrice` is filled in: all 26 legacy creation transactions read had one, and in blocks 354887 and 346634 it equalled the receipt's `effectiveGasPrice`.
- A transaction to the pallets address (a native call from a `0x` account) has a receipt with `gasUsed` 0 and `effectiveGasPrice` 0; its fee is only in the node's events.
- The block's `stateRoot` equals its `transactionsRoot`: the empty-trie root `0x56e81f17...b421` when the block has no Ethereum transaction, and the transactions root otherwise. It never equalled the Substrate state root. It is not a state root: do not verify proofs against it.
- `miner` is the block author's `0x` form, `mixHash` is the constant `prevrandao` (section 1), `difficulty` is `0x0`, and `gasLimit` is `0xffffffffffffffff`. Blocks also carry `blobGasUsed`, `excessBlobGas` (`0x0`), `withdrawals` and `withdrawalsRoot`.
- There are no filters. To follow new blocks, subscribe over `wss://` with `newBlockHeaders` (not the standard name `newHeads`), or poll `eth_blockNumber` and `eth_getLogs` with explicit block ranges over HTTPS. Libraries that subscribe with `newHeads` over a WebSocket (for example a block watcher on a WebSocket transport) get the "Invalid params" answer above; give them the HTTPS endpoint and let them poll. Whether a `logs` subscription delivers logs was not measured (no log was emitted while it was open).
- The Substrate node (`https://test-node-v3.portaldot.dev`) listed 135 methods in `rpc_methods`, none of them `eth_`.

## 6. Limits

All Checked.

- `eth_getLogs` range: no range limit was found, in two independent sets of measurements. From block 0 to `latest` (about 463600 blocks) it answered in about 0.26 s with a topic filter that matches nothing, and in 0.3 to 0.5 s with an address filter. With no filter at all, the last 20000 blocks returned 717 logs in 4.3 s and the last 100000 blocks 4135 logs in 35 s; in the second set the whole chain returned 8004 logs in 24 s, and spans of 100 to 50000 blocks all answered. Large answers take tens of seconds, so page by block range in your indexer and set a long client timeout.
- `eth_getLogs` with `fromBlock` after `toBlock`, or with a `toBlock` beyond the head: `{"code":-32000,"message":"Failed to filter logs"}` (`errors.md` E33). `{"blockHash": ...}` filters work.
- How far back state reads work: `eth_getBalance` and `eth_call` answered at blocks 1, 1000, 100000, 300000, 363641, 462641 and 463631. At each of those blocks `eth_getBalance` of the Treasury's `0x` form equalled (free balance - 0.1 tPOT) x 10^4 from the node's `System.Account` at the same block, and a deployless `NUMBER` returned that block's number. A block after the head answers `{"code":-32000,"message":"hash not found"}`. In October 2026 the same RPC refused state older than about 256 blocks (Checked then, see `errors.md` E5), so test the depth at run time before you depend on it.
- Block gas limit: `0xffffffffffffffff` in every block header and from `GASLIMIT`. It does not bound a call in practice; the weight of the call does. A deployless `eth_call` that made 4096 `STATICCALL`s to empty addresses succeeded in about 0.7 s. With 5120 it failed with `{"code":-32000,"message":"The transaction consumes more than the allowed weight. needed=Weight(ref_time: 1531321961872, proof_size: 23813914) allowed=Weight(ref_time: 1529902658700, proof_size: 14111759216387806985) overweight_by=Weight(ref_time: 1419303172, proof_size: 0)"}`, and with 6144, 8192 and 12288 with `{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 80, error: [3, 0, 0, 0], message: Some(\"OutOfGas\") })"}`. The bound is the weight of one extrinsic (about 1.53 x 10^12 ref_time), not the block gas limit.

## 7. Values that are not whole native units

`eth_call` and `eth_estimateGas` of a plain transfer (`{"from":"0x8dde...d16e","to":<payee>,"value":<v>}`, no data) at a gas price of 15690 wei. Gas x gas price is shown in tPOT. All Checked.

| Value | Payee: an address with no account (`0x...00ab`) | Payee: an existing native account's `0x` form |
|---|---|---|
| 0 | `0x`; 784289590351 gas = 0.0123055 tPOT | `0x`; 784289590351 gas = 0.0123055 tPOT |
| 1 wei | `0x`; 7157776895399 gas = 0.1123055 tPOT | `0x`; 784290597688 gas = 0.0123055 tPOT |
| 10000 wei (1 base unit) | `0x`; 7170522864524 gas = 0.1125055 tPOT | `0x`; 797036566816 gas = 0.0125055 tPOT |
| 10001 wei | `0x`; 7170523872568 gas = 0.1125055 tPOT | `0x`; 797037574856 gas = 0.0125055 tPOT |
| 0.1 tPOT (10^17 wei) | `0x`; 7208763796031 gas = 0.1131055 tPOT | `0x`; 835277498322 gas = 0.0131055 tPOT |

- Neither method refuses a value that is not a multiple of 10^4 wei. The chain keeps the part below 10^4 wei as "dust" on the account (see `amounts-and-fees.md`).
- A payment to an address with no account costs 0.1 tPOT more, whatever the value, even 1 wei: the payer funds the new account's existential deposit. Check that the payee exists, or budget the 0.1 tPOT.
- Not measured: what a sent transaction with such a value does on chain (nothing was sent), and when `Revive.BalanceConversionFailed` fires.

## 8. Reverts

Deployless creation code that copies the revert data from its own tail and reverts with it (`60<len>600c60003960<len>6000fd<data>`). `eth_call` and `eth_estimateGas` gave the same error object in every case. Checked; the first, fourth and fifth agree with `errors.md` E26.

| Revert data | Error object |
|---|---|
| `Error("nope")` (`0x08c379a0...`) | `{"code":3,"message":"execution reverted: revert: nope","data":"0x08c379a0...6e6f7065..."}` |
| custom error `0xdeadbeef` with one `uint256` 42 | `{"code":3,"message":"execution reverted","data":"0xdeadbeef000...002a"}` |
| custom error `0xdeadbeef` with no arguments | `{"code":3,"message":"execution reverted","data":"0xdeadbeef"}` |
| `Panic(0x11)` | `{"code":3,"message":"execution reverted: panic: arithmetic underflow or overflow (0x11)","data":"0x4e487b71...0011"}` |
| empty | `{"code":3,"message":"execution reverted: ","data":"0x"}` |

- The revert data always comes back whole in `data`, so viem, ethers and `cast` can decode custom errors with the contract's ABI.
- The message names the reason only for `Error(string)` and `Panic(uint256)`. A custom error gives "execution reverted" with no colon; an empty revert gives "execution reverted: " with a colon and a space. Match on `data`, not on the message.
- A failure that is not a revert (an invalid opcode, out of gas, an unsupported precompile) has a different shape: code -32000 and `failed to run contract: Module(ModuleError { index: 80, ... })` with the Revive error's name (sections 1, 2 and 6).

## 9. The same reads through the Substrate node

The node's runtime API `ReviveApi` (52 calls on both networks, with `@polkadot/api`: `api.call.reviveApi.<name>(...)`). It is the only way to read the Ethereum side of the mainnet, which has no Ethereum RPC. Testnet at block 463710, mainnet (spec 3001) at block 1076834. All Checked.

| Call | Testnet, against the Ethereum RPC at the same block | Mainnet |
|---|---|---|
| `balance(0x8dde...d16e)` | 154862784797616281560000 wei, equal to `eth_getBalance` and to (free - 0.1) x 10^4 from `System.Account` | 11568169917328014554920000 wei, equal to (free - 0.1) x 10^4 |
| `nonce(0x8dde...d16e)` | 0, equal to `eth_getTransactionCount` | 0 |
| `gasPrice()` | 15685 wei, equal to `eth_gasPrice` | 5000 wei |
| `blockGasLimit()` | 2^64 - 1, equal to the block's `gasLimit` | 2^64 - 1 |
| `code(address)` | a contract's code, equal to `eth_getCode` once the leading SCALE length (`0x991f` for 2022 bytes) is removed | `0x00` (no code: the length 0 alone) |
| `getStorage(address, slot)` | `{"ok":null}` for an unset slot (`eth_getStorageAt` gives 32 zero bytes) | `{"err":{"doesntExist":null}}` for an address with no contract |
| `ethEstimateGas(tx, config)` | 784539579017 gas for an empty call to self, and 7160058598135 for 1 wei to a new address: both equal to `eth_estimateGas` | 2460498146384 gas (0.0123 POT at 5000 wei) and 22460499154394 gas (0.1123 POT) |
| `blockAuthor()` | equal to the block's `miner` | answers |
| `newBalanceWithDust(10001 wei)` | `{"ok":[10000000000001,1]}`: 1 base unit plus the 0.1 existential deposit, and 1 wei of dust | the same |

- `ethEstimateGas` takes two arguments. With only the transaction, `@polkadot/api` throws `ReviveApi_eth_estimate_gas:: Expected 2 arguments, found 1`; pass `{ timestampOverride: null, performBalanceChecks: null, stateOverrides: null }` as the second. Its `stateOverrides` field is the way to estimate "what if" on this chain (`eth_estimateGas` ignores overrides, section 5).
- With `@polkadot/api` 17.0.2, `.toJSON()` of `code()` kept the SCALE length prefix. Strip it, or read code with `eth_getCode` on the testnet.
- The fee in tokens is the same on both networks (about 0.0123 for an empty call), while the gas number differs with the gas price. Gas numbers do not carry over between the two networks.
- `reviveApi.address(5EYCAe5i...5e6Z)` gave `0x8ddee436166f311ddeed36d714b08f512670d16e` and `runtimePalletsAddress()` gave `0x6d6f646c70792f70616464720000000000000000` on both networks.

## 10. Helper contracts and batched reads

`eth_getCode(<address>, "latest")` on the testnet, and `reviveApi.code(<address>)` on both networks. Checked.

| Helper | Address | Testnet | Mainnet |
|---|---|---|---|
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | absent | absent |
| Multicall2 | `0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696` | absent | absent |
| CREATE2 deployer (deterministic deployment proxy) | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | absent | absent |
| CreateX | `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` | absent | absent |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | absent | absent |
| Safe singleton factory | `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7` | absent | absent |
| Safe proxy factory 1.3.0 and 1.4.1 | `0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2`, `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | absent | absent |
| EntryPoint 0.6 and 0.7 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`, `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | absent | absent |
| ERC-1820 registry | `0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24` | absent | absent |

"Absent" means `eth_getCode` returned `0x` and `reviveApi.code` returned `0x00`, on Nov 14, 2026. A call to any of them returns `0x` with no error, which libraries report as "returned no data".

A batch of reads without Multicall3: one deployless `eth_call` whose creation code does the reads and returns the results. This 128-byte code, run at block 463729, returned five words in one request:

```
0x6318160ddd60e01b610200526020600060046102007300000002000000000000000000000000000100005afa5063313ce56760e01b610200526020602060046102007300000002000000000000000000000000000100005afa50738ddee436166f311ddeed36d714b08f512670d16e31604052436060524260805260a06000f3
```

Read by read: `totalSupply()` and `decimals()` of asset 2's token address (each a `STATICCALL` with the selector at memory 0x200 and the answer written to the next word), then `BALANCE` of the Treasury's `0x` form, `NUMBER` and `TIMESTAMP`, then `RETURN(0, 0xa0)`. The answer was 15000000000000000000, 18, 154862803704999342820000, 463729 and 1794661992. The same five values, read one by one at the same block (`eth_call` twice, `eth_getBalance`, `eth_getBlockByNumber`), were identical. Checked.

- `BALANCE` of the Treasury's `0x` form gave the same number as `eth_getBalance`: for an account with nothing frozen, the free balance minus the 0.1 tPOT existential deposit, in wei, plus dust (the general rule is in `amounts-and-fees.md`).
- In Solidity the same pattern is a contract whose constructor makes the calls and ends with `assembly { return(add(out, 32), mload(out)) }`; send its creation code with arguments as `data` and no `to`. Not measured as Solidity: only the hand-written code above was run. viem's `deployless` multicall was not tested.
- Size the batch: 4096 trivial `STATICCALL`s fit in one call and 5120 did not (section 6). Real reads cost more weight each, so keep batches far smaller and split them when the call answers with "consumes more than the allowed weight" or `OutOfGas`.
- For batched writes, `utility.batchAll` is the native way (see `native-modules.md`). `eth_estimateGas` for `utility.batchAll` through the pallets address answered an estimate (Checked Nov 14, 2026: from the Treasury's `0x` form, data `0x01020400071468656c6c6f`, a batch of one `system.remarkWithEvent("hello")`, about 0.0136 tPOT); nothing was sent. That a sent batch works is Reported, not checked.
