# EVM checks: what the EVM and the Ethereum RPC really do

Measurements on the Portaldot V3 testnet (Ethereum RPC `https://test-evm-rpc-v3.portaldot.dev`, chain id 420420777, client `eth-rpc/main-fddd431`; Substrate node `wss://test-node-v3.portaldot.dev`), made by the Bridge Zero team on Nov 14, 2026 and, where a line says so, on Nov 15, 2026 (runtime spec 3002). The checks that need only the node were repeated on the mainnet (`wss://live-v3-node.portaldot.dev`, which has no Ethereum RPC). Most answers come from `eth_call`, `eth_estimateGas`, `debug_traceCall`, block and state reads, or the node's runtime API, and nothing was sent for them. The exceptions say so: section 5 has rows with sends that could not be accepted, and lines marked "sent" rest on transactions that we sent from our own test accounts on Nov 15, 2026, in the blocks they name.

The main findings:

- Code built for `cancun` runs, except the blob opcodes `BLOBHASH` and `BLOBBASEFEE`, which fail the call (section 1).
- `block.prevrandao` is the constant 2500000000000000 at every block measured, from block 1 to the head (section 1).
- Precompiles `0x01` to `0x09` and P256VERIFY (`0x100`) work; KZG (`0x0a`) and BLS12-381 (`0x0b` to `0x11`) are absent (section 2).
- Every Assets-module token has an ERC-20 address: the asset id as 4 big-endian bytes, then 12 zero bytes, then `0001`, then `0000`; PoolAssets use `0002`. Reads and writes work there, with differences from OpenZeppelin tokens (section 3).
- `latest` and `pending` are the best block, `safe` and `finalized` the finalized head; `pending` does not count transactions that wait in the pool (section 4).
- Receipts have `cumulativeGasUsed` 0, type-2 transaction objects have `gasPrice` 0, `transactionIndex` counts the timestamp inherent, and `stateRoot` is not a state root (section 5).
- No filters, no `eth_getProof`, no `eth_createAccessList`, no `eth_simulateV1`. The RPC host also answers on `wss://`, where `eth_subscribe` takes `newBlockHeaders` and `logs`, not `newHeads` (section 5).
- `eth_getLogs` has no block-range limit. A call is bounded by the weight of one extrinsic, not by the block gas limit (section 6).
- No helper contracts at their usual addresses on either network; a deployless `eth_call` batches reads instead (section 10).
- In `eth_call` a payee paid by `transfer()` or `send()` gets 7,461,079 gas, not 2300; calls nest at most 26 frames; a payment from contract code that creates an account costs the transaction's sender 0.1 tPOT (section 11).

Each line below gives what was asked, what the chain answered, and what it means for your code. Entry numbers (E1 and so on) refer to `errors.md`. Basis: **Checked** (measured on Nov 14, 2026, unless another date is given) or **Reported** (said by others, not checked). Anything not measured says so.

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
- `gasleft()` at entry (`0x5a`): 18446743359831245280 (`0xffffff59c98981e0`), close to 2^64 - 1, for an `eth_call` without a `gas` field. In the node's own dry run (`reviveApi.instantiate`) without a gas limit it reads 18446744073709551615 at every point and never falls (Nov 15, 2026; section 11). Gas numbers on this chain include the storage deposit (see `amounts-and-fees.md`); do not compare `gasleft()` with Ethereum figures.
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
- A second precompile at `0x0000000000000000000000000000000000000901` exists (it reverts on an unknown selector, like `0x...0900` and the token addresses of section 3, with `panic: memory allocation error (0x41)`). Its functions were not measured.
- `eth_getCode` at a precompile of the chain (`0x...0900`, `0x...0901`, the token addresses of section 3) returns `0x60006000fd` (revert if run as code), not `0x`.
- A scan of every address whose last two bytes are 1 to 65535 (one `STATICCALL` of `totalSupply()` each, in deployless `eth_call`s of 4096 calls) found answers only at `0x02` to `0x0a`, `0x0900` and `0x0901`. Precompiles that answer a 4-byte input with "success, no data" stay invisible to such a scan (`0x01` and `0x100` do), so this is a lower bound.
- The node's own dry run (`reviveApi.call`) agreed on both networks for `0x02` (sha256 of "abc"), `0x08` (empty pairing is 1), `0x0a` (fails with Revive error 47, `UnsupportedPrecompileAddress`), `0x0b` (no data) and `minimumBalance()` at `0x...0900` (10^17 wei).
- Others report that Revive has no ed25519 and no staking precompile (Reported). Not measured.

## 3. Tokens of the Assets module seen from Solidity

Every asset of the Assets module has an ERC-20 interface at a fixed address. Reads were checked against the Assets module's storage at the same block (463542) for assets 2, 4242 and 7777, and for pool assets at block 463587. Writes were checked on Nov 15, 2026 on pUSD (asset 7777): by dry runs (`eth_call`, `eth_estimateGas` and `debug_traceCall`, blocks 477746 to 478127) and by transactions sent from our own test accounts, signed with ethers 6, at a base fee of 15130 wei (blocks 478195 to 478206; the pUSD they moved came from a native swap in block 478194).

- The rule: the asset id as a 4-byte big-endian number, then 12 zero bytes, then `0001`, then `0000`. Asset 2 is `0x0000000200000000000000000000000000010000`; asset 7777 (`0x1e61`) is `0x00001e6100000000000000000000000000010000`.
- What answered there: `name()`, `symbol()`, `decimals()`, `totalSupply()` and `balanceOf(holder)` returned exactly the module's `assets.metadata` and `assets.asset(id).supply`, and `assets.account(id, holder).balance` for the largest holder (given as its `0x` form). Asset 2: "test asset", "TEST", 18, 15000000000000000000. The other two matched the same way, and so did `allowance(owner, spender)` with `assets.approvals` (Nov 15, 2026).
- pUSD: "Portaldot USD (test)", "pUSD", `decimals()` 6, as in `assets.metadata(7777)`; minimum balance 10000 units (0.01 pUSD); not a sufficient asset. Read `decimals()` for each token; assets 2, 4242 and 1 have 18.
- The first 4 bytes are the asset id itself, not an index: at `0x0000000100000000000000000000000000010000` the chain answered with asset 1's metadata.
- An id with no asset still answers `totalSupply()`, `balanceOf()` and `allowance()` with 0 and no error; `name()`, `symbol()` and `decimals()` revert with `execution reverted: revert: Metadata not found` (code 3), and `transfer` fails with `Assets.Unknown` (table below). Check that an asset exists (or has metadata) before you trust a zero.
- The same layout with `0002` is the PoolAssets module (the liquidity tokens of AssetConversion): `totalSupply()` at `0x0000000000000000000000000000000000020000` matched `poolAssets.asset(0).supply` (316227766016837933), and pool assets 1, 3 and 6 matched too. Pool tokens have no metadata, so `name()` reverts with "Metadata not found".
- A scan of all 65535 values of bytes 16 and 17 (first 4 bytes = 3) found these two prefixes only, `0001` and `0002`. The upstream polkadot-sdk prefixes `0120`, `0220` and `0320` are empty here.
- `eth_getCode` answers `0x60006000fd` (section 2) and `EXTCODESIZE` is 5, so Solidity's code check before a call and OpenZeppelin's `SafeERC20` accept these addresses.
- Functions that answered: `name`, `symbol`, `decimals`, `totalSupply`, `balanceOf`, `allowance`, `transfer`, `approve`, `transferFrom`, `permit`, `nonces` and `DOMAIN_SEPARATOR`. An unknown selector, `eip712Domain()` and a payment with no data answer `{"code":3,"message":"execution reverted: panic: memory allocation error (0x41)","data":"0x4e487b710000000000000000000000000000000000000000000000000000000000000041"}`.
- The module `AssetsPrecompiles` maps 52 asset indexes to the 52 asset ids (`assetIndexToForeignAssetId`), but no address found here uses those indexes. Not known what reads them.

What the writes do (sent, unless a line says dry run):

- `approve(spender, amount)` sets the allowance (1000, then 500, leaves 500; dry run) and holds 0.1 tPOT from the owner while the approval exists, outside gas. The owner's `eth_getBalance` fell by 0.1187 tPOT: 0.1 held (`Balances.Reserved`, `Assets.ApprovedTransfer`) and a fee of 0.0187 (block 478195). `approve(spender, 0)` removed the approval and gave the 0.1 tPOT back (`Balances.Unreserved`, `Assets.ApprovalCancelled`; block 478197). The owner needs an `eth_getBalance` of at least 0.1 tPOT, that is 0.2 tPOT free on the native side, plus the fee when it sends the approval itself (dry runs; replies in the table; E41).
- `approve(spender, 2^256 - 1)`: the `Approval` log shows 2^256 - 1, but the chain stores 2^128 - 1 (340282366920938463463374607431768211455), and `allowance()` returns that (block 478199). A `transferFrom` of 10000 lowered it by 10000 (block 478201): it is not unlimited, so a test for `allowance == type(uint256).max` never matches; test `>= 2^128 - 1`. Any amount of 2^128 or more is stored the same way (dry runs; E43).
- `transferFrom(owner, to, amount)`, sent by the spender: fee 0.0219 tPOT, paid by the spender (block 478201). An owner that calls it on its own tokens needs an approval for itself too, and it emits only `Transfer`, with no `Approval` for the lower allowance (dry runs).
- `permit(owner, spender, value, deadline, v, r, s)`, signed by the owner and sent by the spender (block 478203). EIP-712 domain: `{name: <the asset's metadata name, "Portaldot USD (test)" here>, version: "1", chainId: 420420777, verifyingContract: <the token address>}`, with the standard EIP-2612 `Permit` type; it hashes to `DOMAIN_SEPARATOR()`, `0x928145d95a467f5fbf399d0709fdd7febfd025c59d0147eaa529893c11750bff` for pUSD. `nonces(owner)` went from 0 to 1, the permit replaced the existing approval, and the 0.1 tPOT deposit was held from the owner, not the sender; the sender paid a fee of 0.0348 tPOT. `permit` returns no data, and `eip712Domain()` is not served.
- `transfer(to, amount)`: fee 0.0187 tPOT (block 478206). A new holder of an asset that is not sufficient must already have a native account (hold tPOT), or the transfer fails with `Token(CannotCreate)`; a transfer of 10000 units to the Treasury, which holds tPOT and no pUSD, returned true (dry runs). A holder whose only tPOT is the 0.1 existential deposit can receive the token but cannot approve it.
- A transfer that would leave the sender below the minimum balance moves the whole balance. A `transfer` of the balance minus 5000 units emitted `Transfer(..., 683367)`, the amount asked, while the chain's `Assets.Transferred` moved 688367, the whole balance, and the sender held 0 afterwards (block 478206). A sum of `Transfer` logs then falls short; read `balanceOf` (E42). The native `Assets.transferKeepAlive` refuses the same transfer with `Assets.BalanceLow` (dry run).
- `transfer` with 10000 wei of value attached (block 478205): the token moved, and the value stayed on the token address (`eth_getBalance` 0, then 10000 wei). That address had no account, so one was created with 0.1 tPOT from the sender (`System.NewAccount`, `Balances.Endowed`); the sender lost about 0.119 tPOT in all. We know of no way to move that value again (E44).
- `transfer(address(0), amount)` returned true (dry run): the zero address is an ordinary account here (its `eth_getBalance` was 2.9 tPOT on Nov 15, 2026) and is not refused, unlike in OpenZeppelin tokens.
- Cost: `approve` and `transfer` 0.0187 tPOT, `transferFrom` 0.0219, `permit` 0.0348 (gas used 1.236 x 10^12, 1.448 x 10^12 and 2.30 x 10^12), and `approve` and `permit` hold 0.1 tPOT on top. A native `Assets.transfer` costs 0.0146 tPOT (fee query, Nov 15, 2026).
- Events: the receipts carry standard ERC-20 `Transfer` and `Approval` logs emitted at the token address. In a dry run, `debug_traceCall` with `{"tracer":"callTracer","tracerConfig":{"withLog":true}}` shows them; `eth_call` returns only the result. Not measured: whether `eth_getLogs` serves the logs of token addresses.
- Test tokens: a native `AssetConversion.swapExactTokensForTokens` of 1 tPOT for pUSD paid 708367 units (0.708 pUSD) straight to the account of an Ethereum key, as `AssetConversionApi.quotePriceExactTokensForTokens` had quoted (block 478194).

How a failure looks (dry runs, Nov 15, 2026; E40):

- `eth_call` and `eth_estimateGas`, and so wallets and tools, get no revert data but code -32000, as in the table. Only the token address's own checks (the amount, the permit, the metadata, an unknown function) give a revert string with code 3.
- Inside a contract, BalanceLow, NoAccount, Unknown, Unapproved, `Token(CannotCreate)` and `Token(BelowMinimum)` each arrived as a failed call with empty data: a low-level call returns false and `0x`, `try` lands in `catch` with empty bytes, and an uncaught `IERC20.transfer` or OpenZeppelin 5.1 `SafeERC20.safeTransfer` makes the whole call answer `{"code":3,"message":"execution reverted: ","data":"0x"}`. The contract cannot tell the causes apart. To learn the cause, dry-run the token call itself, or run `debug_traceCall` with `callTracer`: the token's frame carries the name, for example `"error":"BalanceLow"`.

| Mistake | Reply of `eth_call` and `eth_estimateGas` |
|---|---|
| amount above the balance; `transferFrom` within the allowance but above the owner's balance | `{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 39, error: [0, 0, 0, 0], message: Some(\"BalanceLow\") })"}` |
| sender holds none of the asset | `{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 39, error: [1, 0, 0, 0], message: Some(\"NoAccount\") })"}` |
| the asset id does not exist | `{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 39, error: [3, 0, 0, 0], message: Some(\"Unknown\") })"}` |
| `transferFrom` with no allowance or above it | `{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 39, error: [10, 0, 0, 0], message: Some(\"Unapproved\") })"}` |
| the asset is frozen (asset 4503); reads still answer | `{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 39, error: [16, 0, 0, 0], message: Some(\"AssetNotLive\") })"}`; the chain's text "The asset is not live, and likely being destroyed" misleads |
| at least the minimum balance to an address with no account (asset not sufficient) | `{"code":-32000,"message":"failed to run contract: Token(CannotCreate)"}` |
| less than the minimum balance to an address that holds none of the asset | `{"code":-32000,"message":"failed to run contract: Token(BelowMinimum)"}` |
| `approve` or `permit` by an owner that has no account | `{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 6, error: [2, 0, 0, 0], message: Some(\"InsufficientBalance\") })"}` |
| `approve` or `permit` by an owner whose `eth_getBalance` is below 0.1 tPOT | `{"code":-32000,"message":"failed to run contract: ConsumerRemaining"}` |
| `transfer` of an amount that does not fit 128 bits (2^128 measured) | `{"code":3,"message":"execution reverted: revert: Balance conversion failed","data":"0x08c379a0..."}` |
| `permit`: `r` and `s` that are no signature; a past deadline; `v` 0 with `r` and `s` 0; a valid signature over another nonce | `execution reverted: revert: Invalid signature`, `... revert: Permit expired`, `... revert: Invalid signature v value`, `... revert: Signer does not match owner` (code 3) |

Not measured: writes through PoolAssets addresses, a sufficient asset, a frozen account (only a frozen asset), a `permit` on an asset with no metadata, and a failing token call sent as a transaction.

## 4. Block tags

`eth_getBlockByNumber(<tag>, false)` against the node's `chain_getHeader` (best) and `chain_getFinalizedHead`, three rounds 7 s apart (blocks 463634 to 463641). All Checked.

- `latest` and `pending`: the node's best block, the same number and hash in every round (once one block newer, because a block arrived between the two requests). There is no separate pending block.
- `finalized` and `safe`: the node's finalized head, normally 2 blocks behind the best block. `safe` gave the same block as `finalized` (in one round one block later, as the finalized head moved between the requests). The hash equals `revive.blockHash(number)` in the node's storage.
- `earliest` and `0x0`: block 0 with hash `0x7c05b2dc7486f81a693d676553fa13f380b5be16da7c739b182931cd6cf07001` and timestamp `0x0`. That is not the Substrate genesis hash (`0xd4f9acbc...283bd`): never compare the two.
- `eth_blockNumber` equals the node's best block.
- `pending` does not see the pool either. While a sent transaction waited for its block, `eth_getTransactionCount` gave the same count for `pending` as for `latest`, and `eth_getTransactionByHash` and `eth_getTransactionReceipt` answered `null`; the node held it in `author_pendingExtrinsics`, and `system_accountNextIndex` of the sender was the account nonce + 1 (sent, Nov 15, 2026, block 477944). A transaction sent with a nonce gap is taken and waits, and `system_accountNextIndex` does not count it (measured for a native extrinsic).
- What it means: wait for `finalized` (or `safe`) before you treat a result as settled. `latest` can still change. To learn whether an account has a transaction waiting, compare `system_accountNextIndex` with the account's nonce (`get_account` shows both), and look a hash up with `get_transaction`, which also searches the node's pool.

## 5. The JSON-RPC surface

Each method once with harmless parameters, on Nov 14, 2026. Nothing that sends or signs was called. Checked. On Nov 15, 2026 we asked the methods again and added those that send or sign, with requests that could not be accepted: transactions signed by new, empty accounts with random keys held only in memory. All were refused. Checked; those rows say Nov 15, 2026.

| Method | Answer |
|---|---|
| `eth_chainId`, `net_version` | `0x190f1ca9`, `"420420777"` |
| `web3_clientVersion` | `eth-rpc/main-fddd431/x86_64-unknown-linux-gnu/rustc1.98.0` |
| `eth_syncing`, `eth_accounts`, `net_listening`, `net_peerCount` | `false`, `[]`, `true`, `0x1` |
| `eth_blockNumber`, `eth_gasPrice`, `eth_maxPriorityFeePerGas` | answers; the gas price was 15690 to 15695 wei; the priority fee `0x0` |
| `eth_feeHistory("0x4", "latest", [25, 75])` | answers: `baseFeePerGas` the same in every block, every `reward` `0x0`, and `gasUsedRatio` = the block's gas used / (2^64 - 1): 0 for a block without Ethereum transactions, and 4.37 x 10^-8 and 4.44 x 10^-8 for blocks 477827 and 477828, which held one transaction each (`eth_feeHistory("0xa", "latest", [20])`, Nov 15, 2026). The block count must be hex: the JSON number `4` answers ``{"code":-32602,"message":"Invalid params","data":"invalid type: integer `4`, expected a (both 0x-prefixed or not) hex string or byte array containing between (0; 32] bytes at line 1 column 1"}`` (Nov 15, 2026, measured twice; `errors.md` E36) |
| `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount` (`latest` and `pending`) | answer |
| `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getBlockTransactionCountByNumber`, `eth_getBlockTransactionCountByHash` | answer |
| `eth_getTransactionByHash`, `eth_getTransactionByBlockNumberAndIndex`, `eth_getTransactionByBlockHashAndIndex`, `eth_getTransactionReceipt`, `eth_getBlockReceipts` | answer; an unknown hash gives `null`, with no error |
| `eth_getLogs` | answers (limits in section 6) |
| `eth_call` | answers, and takes a state override as the third parameter: `code`, `balance` and `stateDiff` were all applied |
| `eth_estimateGas` | answers, but ignores a state override: with an override that put reverting code at the target it returned the same estimate as without |
| `debug_traceTransaction(hash, {"tracer":"callTracer"})`, `debug_traceBlockByNumber`, `debug_traceCall` (`callTracer`, `prestateTracer`) | answer. `debug_traceTransaction` without a tracer object answered `{"code":-32000,"message":"No Ethereum extrinsic found"}` for the same, existing transaction |
| `eth_subscribe` over HTTP | `{"code":-32603,"message":"Internal error"}` |
| `eth_subscribe` over WebSocket, `wss://test-evm-rpc-v3.portaldot.dev` | the same host answers on `wss://` (`eth_chainId` gave `0x190f1ca9`). `["newBlockHeaders"]` sent one notification per block (two blocks in a row, then `eth_unsubscribe` returned `true`), and `["logs", {}]` gave a subscription id. `["newHeads"]` answered ``{"code":-32602,"message":"Invalid params","data":"unknown variant `newHeads`, expected `newBlockHeaders` or `logs` at line 1 column 10"}``, and `["newPendingTransactions"]` the same with its own name. A subscription id is a text of 16 letters and digits (for example `LWtrF54TSceGp2Bb`), not `0x` hex, and `eth_unsubscribe` of an id that does not exist answers `false`, not an error (Nov 15, 2026; the id form seen twice). Subscriptions per connection and connections per client: `networks.md` |
| `eth_sendRawTransaction` | text that is not hex of whole bytes answers `-32602` `Invalid params` (`OddLength`, `InvalidHexCharacter`; `errors.md` E36). Bytes it cannot decode as an Ethereum transaction (nonsense, cut off, a Substrate extrinsic, a legacy transaction without a chain id) answer `{"code":-32000,"message":"Invalid transaction"}` (E35). The rest it passes on to the node, even a transaction signed for chain id 1, a blob (type 3) or a set-code (type 4) transaction; each one we sent came back the first time as `{"code":1010,"message":"Invalid Transaction"}`, with no reason (E1). A raw transaction without `0x` was passed on too (Nov 15, 2026) |
| `eth_sendTransaction` | `{"code":-32000,"message":"Account not found for address 0x..."}`: the RPC holds no keys (`errors.md` E37) (Nov 15, 2026, measured twice) |
| `eth_sign`, `eth_signTypedData_v4` | `{"code":-32601,"message":"Method not found"}` (Nov 15, 2026) |
| `eth_createAccessList`, `eth_getProof`, `eth_simulateV1`, `eth_blobBaseFee`, `eth_newFilter`, `eth_newBlockFilter`, `eth_newPendingTransactionFilter`, `eth_getFilterChanges`, `eth_getFilterLogs`, `eth_uninstallFilter`, `txpool_content`, `txpool_status`, `rpc_modules`, `debug_traceBlockByHash`, `eth_getUncleCountByBlockNumber`, `eth_protocolVersion`, `eth_coinbase`, `eth_mining`, `eth_hashrate`, `web3_sha3`, `eth_getHeaderByNumber` | `{"code":-32601,"message":"Method not found"}` |
| `eth_fillTransaction`, `eth_getAccountInfo`, `anvil_nodeInfo` | `{"code":-32601,"message":"Method not found"}` (Nov 15, 2026). viem 2.57 asks for the first and forge 1.8.5 for the other two; both carry on without them |

Field quirks, seen in the blocks and receipts of three blocks that hold Ethereum transactions (450413, 463467, 463615):

- `transactionIndex` is the extrinsic's position in the Substrate block. Extrinsic 0 is always the `timestamp.set` inherent, so the first Ethereum transaction has index `0x1`, and `eth_getTransactionByBlockNumberAndIndex(block, "0x0")` returns `null`.
- `cumulativeGasUsed` is `0x0` in every receipt, while `gasUsed` is filled in. The block's `gasUsed` is the sum of its receipts' `gasUsed`. Do not read gas from `cumulativeGasUsed`.
- In a mined type-2 (EIP-1559) transaction object, `gasPrice` is `0x0`. The price paid is the receipt's `effectiveGasPrice`. In a legacy (type 0) one, `gasPrice` is filled in: all 26 legacy creation transactions read had one, and in blocks 354887 and 346634 it equalled the receipt's `effectiveGasPrice`.
- `effectiveGasPrice` is the base fee whatever the sender offered: type 2 transactions with a priority fee of half and of twice the base fee, and legacy ones with a gas price of 2 and 4 x the base fee, all showed it (sent, Nov 15, 2026, blocks 477816 to 478130; `amounts-and-fees.md` has what is charged).
- A transaction to the pallets address (a native call from a `0x` account) has a receipt with `gasUsed` 0 and `effectiveGasPrice` 0; its fee is only in the node's events. That holds when the call fails too: status `0x0`, and the sender paid 0.0162 tPOT (sent, Nov 15, 2026, block 477826; E46).
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
- Request size: the limits of the public endpoints (an HTTP 413 page above about 1 MB of body, batches, connections, subscriptions) are in `networks.md` (E52). An `eth_call` with 500,000 bytes of calldata, to an address without code, answered `"0x"`: no calldata limit fired there (Nov 15, 2026). `Revive.CallDataTooLarge` (module 80, error 48) exists; large calldata to a contract was not tried.

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
- A sent transfer of 0.001 tPOT + 1 wei was mined (block 477828). The sender paid the exact wei; the receiver's native balance rose by exactly 0.001 tPOT, and its `eth_getBalance` now ends in `...0001`: the single wei is kept as dust and shows on the Ethereum side only (sent, Nov 15, 2026). In dry runs, contracts read such values exactly (`msg.value` 10001, 12345 and 1 wei) and passed them on exactly.
- A payment to an address with no account costs 0.1 tPOT more, whatever the value, even 1 wei: the payer funds the new account's existential deposit. Check that the payee exists, or budget the 0.1 tPOT. A payment from contract code works the same way (section 11).
- Not measured: when `Revive.BalanceConversionFailed` fires.

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
- A failure that is not a revert (an invalid opcode, out of gas, an unsupported precompile) has a different shape: code -32000 and `failed to run contract: Module(ModuleError { index: 80, ... })` with the Revive error's name (sections 1, 2 and 6). A token address of section 3 fails in the same shape, with Assets (39) and Balances (6) errors, or with `Token(...)` and `ConsumerRemaining` texts that have no `Module` wrapper; inside a calling contract such a failure arrives with empty data (section 3).
- The empty revert (`"execution reverted: "`, data `0x`) also comes from a `transfer()` whose payee needs a new slot or calls out, and from a call nested deeper than 26 frames whose failure is passed up to the top (section 11; E26).

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

## 11. Calls between contracts and payments

Deployless `eth_call`s from the Treasury's `0x` form and the node's own dry run (`reviveApi.instantiate`), testnet blocks 477807 to 478187, on Nov 15, 2026; nothing was sent. The probes were built with solc 0.8.27 for `cancun` with the IR pipeline, and their payees were created inside the same call (see the last item). All Checked.

- Gas a payee receives, in `eth_call`: with value, the cap + 7,461,079. `send()`, `transfer()` and `call{value: v, gas: 0}` gave 7,461,079; caps of 2300, 50000, 10^9 and 10^12 gave the cap + 7,461,079; `try I(x).f{value: v, gas: N}()` gave N + 7,396,013. Without value, a cap of 2300 gave 2300 + 7,461,079, but a cap of 0 failed.
- That is enough for a payment to an existing account or to a new address, an empty `receive()`, an event, or overwriting a slot that already exists. It is not enough to write a new slot, which needs a cap worth about 3.84 tPOT of gas (the slot deposit, so the number of gas moves with the gas price: 253,659,525,697,540 at 15140 wei per gas), or to make any external call, which needs about 7.7 x 10^7 gas (77,158,784 and 77,152,587 for two different contracts). Caps of 2300 and 50000 are no better than 0 for either, and caps up to 10^12 are no better than 0 for a new slot.
- How it fails: `transfer()` reverts with empty data, so the reply is `{"code":3,"message":"execution reverted: ","data":"0x"}` if nothing catches it; `send()` and a capped call return false; `try` lands in `catch` with empty bytes. No `OutOfGas` text appears (E48).
- Re-entry: under `transfer()`, `send()` and `call{value, gas: 2300}`, a payee that called the paying contract back failed, and nothing changed; with a cap of 10^12 or with all gas, the same re-entry succeeded.
- Payments to new addresses: contract code paid 1 wei, 0.05 tPOT and 0.1 tPOT to one and to ten addresses that had no account by `call`, and 1 wei to one by `send` and by `transfer`; every payment succeeded. The paying contract lost only the amounts, and each payee's balance (`BALANCE`) read exactly its amount. The transaction's origin paid 0.1 tPOT per new account: in the node's dry run its balance fell by 0.1 tPOT per new payee, and `storageDeposit.charge` rose from 112.95 to 113.05 tPOT for one and to 113.95 for ten; `eth_estimateGas` rose by about 0.1 tPOT of gas per new payee. A gas cap does not bound that 0.1 tPOT. Not measured: the payee's native balance (it probably holds the 0.1 as its existential deposit). E54 has the fix.
- On the native path the same 0.1 tPOT per new account is part of the storage deposit: with a `storageDepositLimit` equal to the deposit without payees, the whole instantiation failed with `Revive.StorageDepositLimitExhausted` (module 80, error 24), even for one payment of 1 wei.
- Call depth: 26 frames in all, the top call and 25 nested ones, for `CALL`, `DELEGATECALL`, `STATICCALL`, `try`/`catch` and a chain of `CREATE`s (a deployless constructor counts as frame 1). The call from frame 26 is refused with success 0 and empty return data while plenty of gas is left; a `CREATE` there returns address 0. The node's dry run agreed. If each frame passes the failure up, the reply is `{"code":3,"message":"execution reverted: ","data":"0x"}`, the same as an empty revert. The name `Revive.MaxCallDepthReached` (module 80, error 5) never appeared (E49).
- `gasleft()` in the node's dry run without a gas limit reads 18446744073709551615 at every point. There a payee got 3,730,540 gas for `send()`, `transfer()` and `call{value: v, gas: 0}`, 3,698,007 for `try I(x).f{value: v, gas: 0}()`, and 2^64 - 1 for every cap of 2300 or more. Gas-dependent code behaves differently in the two kinds of dry run; measure gas with `eth_call`.
- `selfdestruct(beneficiary)` in a constructor: `eth_call` answered `0x` with no error, and the node's dry run answered success with a storage deposit of 13.11 tPOT, the same as for a constructor that returns empty runtime code; no `Revive.TerminatedInConstructor`. Not known: what a sent one removes or refunds, and what `selfdestruct` does to a contract deployed in an earlier transaction.
- Payees placed by a state override: an address given only `code` has no account, so the first payment to it costs 0.1 tPOT and fails under any gas cap; after one payment with all gas, capped payments to it worked. Create payees inside the deployless call (`new C()`) to test them as deployed contracts.
