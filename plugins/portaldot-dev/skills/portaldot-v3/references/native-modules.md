# Native modules: what the runtime offers and how to call it

The 69 runtime modules, their indices, how a call is encoded, the call for each everyday job, the transaction extensions, and the rules of multisig, proxies, staking, vesting and TransactionStorage. Read it before you build, encode or decode a native call, or when you look for "how do I do X natively".

Basis words: Checked (measured on the chain by the Bridge Zero team, on the date given), Experience (learned while building and running our own tools on this chain), Guide (the chain team's testnet guide), Reported (said by other builders, not checked by us).

## Explore with the tools

- `search_chain` finds modules, calls, events, errors, constants and storage by everyday words ("send tokens", "create an NFT") or by name.
- `describe_item` gives a call's exact arguments in plain words, its indices and sample code, or a whole module.
- `encode_call` gives the exact call bytes and, with a `sender`, a fee estimate; `read_storage` reads stored values.
- The values below were read on Nov 14 and 15, 2026, as each line says. The tools read the chain as it is now.

## The 69 modules

The testnet (spec 3002) and the mainnet (spec 3001) have the same 69 modules at the same indices (Checked Nov 14, 2026). Index in brackets:

- Money and accounts: Balances (6), TransactionPayment (7), AssetConversionTxPayment (9), Indices (5), Identity (28), Recovery (30), Vesting (31), Proxy (35), Multisig (36), SkipFeelessPayment (77), VerifySignature (81), MetaTx (89).
- Tokens, NFTs and swaps: AssetRate (20), Assets (39), PoolAssets (40), Lottery (44), Uniques (46), Nfts (47), NftFractionalization (48), AssetConversion (65), AssetConversionMigration (79), AssetsFreezer (84), Oracle (85).
- Smart contracts: Contracts (21, ink!), Revive (80, Solidity), AssetsPrecompiles (91), AssetsPrecompilesPermit (92), VestingPrecompiles (93).
- Staking: ElectionProviderMultiPhase (10), Staking (11), VoterList (52), NominationPools (62), FastUnstake (66), DelegatedStaking (82).
- Blocks and finality: Babe (2), Authorship (4), Session (12), Grandpa (18), ImOnline (23), AuthorityDiscovery (24), Offences (25), Historical (26), Beefy (41), Mmr (42), MmrLeaf (43).
- Basics: System (0), Utility (1), Timestamp (3), Scheduler (32), TransactionStorage (51), Remark (56), TxPause (69), SafeMode (70), Statement (71), MultiBlockMigrations (72), Mixnet (75), Parameters (76).
- Governance and treasury: TechnicalCommittee (15), TechnicalMembership (17), Treasury (19), Sudo (22), Preimage (34), Bounties (37), ChildBounties (54), MultiAssetBounties (90).
- Other chains: MessageQueue (67), Broker (73), RegistrarPara (95), RegistrarRelay (96).

The runtime has 480 calls, 494 events, 352 storage items, 228 constants and 678 errors in all, the same counts on both networks (Checked Nov 14, 2026, from the metadata).

The 13 constants that differ between the networks, besides `system.version`, which holds each runtime's version (Checked Nov 14, 2026; the other 214 are the same):

- The chain ids: `revive.chainId` and `assetsPrecompilesPermit.chainId`, 420420777 on the testnet and 780780777 on the mainnet.
- Deposits for NFTs and asset metadata: `metadataDepositBase` of Assets, PoolAssets, Uniques and Nfts, and `attributeDepositBase` of Uniques and Nfts, are 0.1 tPOT on the testnet and 0.5 POT on the mainnet; `itemDeposit` of Uniques and Nfts is 0.1 tPOT on the testnet and 0.05 POT on the mainnet.
- `treasury.spendPeriod` (3600 blocks on the testnet, 432000 on the mainnet) and the `bountyValueMinimum` of Bounties and MultiAssetBounties (5 tPOT, 1 POT).

## Call encoding

- A call's bytes are `[module index][call index][SCALE-encoded arguments]` (Checked Nov 14, 2026).
- In @polkadot/api, `api.tx.<module>.<call>(...).method.toHex()` gives exactly these bytes, without a key (Checked Nov 14, 2026; the same bytes were sent and accepted on Nov 13, 2026).

Two examples (Checked Nov 14, 2026, with `encode_call`):

- `system.remarkWithEvent("hello")` = `0x00071468656c6c6f`
  - `00` System, `07` remarkWithEvent, `14` the compact length 5, then the bytes of `hello`.
  - System call 0 is `remark`; call 7 is `remarkWithEvent`, whose `system.Remarked { sender, hash }` event names the sender and the hash of the text.
- `balances.transferKeepAlive(Treasury, 0.01 tPOT)` = `0x0603006d6f646c70792f74727372790000000000000000000000000000000000000000070010a5d4e8`
  - `06` Balances, `03` transferKeepAlive, `00` the MultiAddress kind `Id`, then the 32-byte account id of `5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z`.
  - `070010a5d4e8` is the compact encoding of 10^12 base units (0.01 tPOT).

## A native call from a 0x account

- A `0x` account (MetaMask, a Foundry keystore) can run a native call: send an Ethereum transaction to the pallets address `0x6d6f646c70792f70616464720000000000000000` with the call bytes as `data` and a value of 0. The runtime describes this route in `revive.ethSubstrateCall`: "Executes a Substrate runtime call from an Ethereum transaction" (Checked Nov 14, 2026).
- Proven by two such transactions on Nov 13, 2026 (`system.remarkWithEvent` and `balances.transferKeepAlive`), with fees of 0.0158 and 0.0159 tPOT (Checked). We also sent one that fails, a `balances.transferKeepAlive` of more than the account held (block 477826). On Nov 15, 2026, 143 dry runs of native calls across 18 modules went through this route: 31 answered with a gas estimate and 112 with `Failed to dispatch call:` and the call's own error (Checked by dry run, not sent; `native-call-errors.md`).
- The receipt shows status 1, `gasUsed` 0, `effectiveGasPrice` 0 and no logs. On the Substrate side the block holds an unsigned `revive.ethTransact` extrinsic carrying the raw transaction, and its events (`balances.Withdraw`, `system.Remarked`, `transactionPayment.TransactionFeePaid`, `system.ExtrinsicSuccess`) show the call ran as the account that holds the `0x` address's balance (Checked Nov 13, 2026, and again on Nov 14, 2026 for the first one). A call that fails when it runs is mined with status 0, still with `gasUsed` 0 and `effectiveGasPrice` 0, and the fee is paid: 0.0162 tPOT in block 477826 (Checked Nov 15, 2026; E46).
- Use the Ethereum gas rule of `amounts-and-fees.md`. Recipe 4 in `recipes-contracts.md` has the steps; `encode_call` builds the bytes, and `estimate_eth_transaction` the gas.
- When the native call would fail, `eth_estimateGas` says why: `Failed to dispatch call: ...`, for example `BadOrigin` for a call that needs root (E29 in `errors.md`).
- A value above 0 is refused: `eth_estimateGas` to the pallets address with a value of 10000 wei answered `Invalid call: Call` (Checked Nov 14, 2026).
- `eth_estimateGas` for `utility.batchAll` through the pallets address answered an estimate (Checked Nov 14, 2026: from the Treasury's `0x` form, data `0x01020400071468656c6c6f`, a batch of one `system.remarkWithEvent("hello")`, about 0.0136 tPOT); nothing was sent. That a sent batch works is Reported, not checked.

## Everyday jobs and their calls

Call indices Checked Nov 14, 2026 with `describe_item`; each job is what `search_chain` names for those everyday words (Checked Nov 14, 2026).

| Job | Call or storage | Index |
|---|---|---|
| Send tPOT | `balances.transferKeepAlive(dest, value)` | `0x0603` |
| Read a balance | storage `system.account(address)`, field `data.free` | |
| Deploy a Solidity contract | `revive.instantiateWithCode` | `0x5003` |
| Call a Solidity contract | `revive.call` | `0x5001` |
| Deploy an ink! contract | `contracts.instantiateWithCode` | `0x1507` |
| Create a token | `assets.create(id, admin, minBalance)` | `0x2700` |
| Mint units of it | `assets.mint(id, beneficiary, amount)` | `0x2706` |
| Send a token other than tPOT | `assets.transfer(id, target, amount)` | `0x2708` |
| Swap tokens | `assetConversion.swapExactTokensForTokens(path, amountIn, amountOutMin, sendTo, keepAlive)` | `0x4103` |
| Create an NFT collection | `nfts.create(admin, config)` | `0x2f00` |
| Mint an NFT | `nfts.mint(collection, item, mintTo, witnessData)` | `0x2f03` |
| Stake | `staking.bond(value, payee)`, then `staking.nominate(targets)` | `0x0b00`, `0x0b05` |
| Stake through a pool | `nominationPools.join(amount, poolId)` | `0x3e00` |
| Several calls in one transaction | `utility.batchAll(calls)` | `0x0102` |
| Approve or run a multisig call | `multisig.asMulti` | `0x2401` |
| Write a note into a block | `system.remarkWithEvent(remark)` | `0x0007` |

Plain notes (Experience, from the chain's own call documentation, unless marked):

- `transferKeepAlive` refuses to take the sender below the existential deposit (0.1 tPOT). `transferAllowDeath` (`0x0600`) does not, and may remove the account; but from an account with a lock, freeze, hold or reserve and `providers` 1 (in `system.account`), it stopped at the same limit as `transferKeepAlive`, with `Token(Frozen)` (Checked Nov 15, 2026 by dry run; `native-call-errors.md`). `transferAll(dest, keepAlive)` (`0x0604`) sends everything spendable.
- `batchAll` is all or nothing. `batch` (`0x0100`) stops at the first failure but keeps the calls before it. `forceBatch` (`0x0104`) "allows errors and won't interrupt" (the chain's text, Checked Nov 14, 2026). At most 10922 calls fit in one batch (`utility.batchedCallsLimit`, Checked Nov 14, 2026).
- `assets.create` starts the token with no supply; `assets.mint` adds it. Creating an asset reserves `assets.assetDeposit` (1 tPOT), an approval `assets.approvalDeposit` (0.1), and metadata `assets.metadataDepositBase` (0.1 tPOT on the testnet, 0.5 POT on the mainnet) plus 0.06 per byte (`assets.metadataDepositPerByte`) (Checked Nov 14, 2026).
- `nfts.mint` needs the collection first. A collection reserves `nfts.collectionDeposit` (1 tPOT) and an item `nfts.itemDeposit` (0.1 tPOT on the testnet, 0.05 POT on the mainnet) (Checked Nov 14, 2026).
- In Nfts, the "Account" attribute namespace needs the item's owner to call `nfts.approveItemAttributes` (`0x2f16`) first, or the call fails with `NoPermission` (Experience, from the upstream code; not tested on V3).

## Argument types in plain words

- `Balance`, `u128`, `Compact<u128>`: an amount in the smallest unit (14 decimals for tPOT).
- `MultiAddress` and `AccountId32`: a `5...` address, not a `0x` one. @polkadot/api accepts the SS58 string, and makes it, or a 32-byte hex string, the kind `Id`. A 20-byte `0x` string becomes the kind `Address20` without a warning, and the chain answers `CannotLookup` when the call runs; `Address32` gets the same (Checked Nov 15, 2026 by dry run). For a `0x` address, pass the native account that `convert_address` names (E4). As a transaction's signer, `Address20` is refused with `Unknown(CannotLookup)` (Checked Nov 15, 2026).
- `H160`: a `0x` address, 40 hex characters.
- `Weight`: a limit on computing work with two parts, `refTime` and `proofSize`; it plays the part of a gas limit.
- `Call`: another call, built with `api.tx...` and passed as is.
- `FixedU128`: a number with 18 decimal places.
- `Option<...>`: pass `null` for none.

## What the testnet holds

- Nov 14, 2026 (Checked), the same counts as on Nov 13, 2026: 52 assets, 21 AssetConversion pools, 28 NFT collections, 14 ink! contracts with 11 code blobs, 279 Revive code entries, 528 Revive account entries, 9 identities and 1 nomination pool.
- The mainnet held none of these on Nov 13, 2026, and still no Revive code or accounts, assets, NFT collections or pools on Nov 14, 2026 (Checked).

## Transaction extensions

- V3 extrinsics carry 12 transaction extensions, the same on both networks (Checked Nov 14, 2026): `AuthorizeCall`, `CheckNonZeroSender`, `CheckSpecVersion`, `CheckTxVersion`, `CheckGenesis`, `CheckMortality`, `CheckNonce`, `CheckWeight`, `ChargeAssetTxPayment`, `CheckMetadataHash`, `EthSetOrigin`, `WeightReclaim`.
- @polkadot/api 17 does not know `AuthorizeCall` and `EthSetOrigin`, and prints `REGISTRY: Unknown signed extensions AuthorizeCall, EthSetOrigin found, treating them as no-effect` when it connects. Neither adds a byte: a transaction signed without declaring them was byte for byte the one signed with the declaration, and the node's `TaggedTransactionQueue_validate_transaction` refused both, from fresh empty keys, only for the fee (`Payment`), so their encoding and signature were accepted (Checked Nov 15, 2026). The declaration is optional: it removes the warning, and every native send we made used it:

```js
const api = await ApiPromise.create({
  provider: new WsProvider('wss://test-node-v3.portaldot.dev'),
  signedExtensions: {
    AuthorizeCall: { extrinsic: {}, payload: {} },
    EthSetOrigin: { extrinsic: {}, payload: {} },
  },
});
```

- polkadot-api 3.3.0 and dedot 1.4.0 need no configuration for the two (Checked Nov 15, 2026 the same way: `Payment` for sr25519 and ecdsa keys).
- Sign with `CheckMetadataHash` mode 0. On spec 3002 every transaction with mode 1 was refused with `Unknown(CannotLookup)`, whatever hash it carried (Checked Nov 15, 2026; E50).
- Fees are charged through `ChargeAssetTxPayment`, so a fee could in principle be paid in another asset; not tried by us.

## Multisig rules

Experience, proven with a 2-of-3 account on Oct 20, 2026, unless marked.

- Shape (Checked Nov 14, 2026): `multisig.asMulti(threshold: u16, otherSignatories: Vec<AccountId32>, maybeTimepoint: Option<Timepoint>, call: Call, maxWeight: Weight)`, index `0x2401`.
- `otherSignatories` must be sorted by account id.
- Open with `asMulti` and the full call. `approveAsMulti` (`0x2402`) only registers an approval by hash; the chain's text says it "will NEVER execute the call, even if the approval threshold is reached", and that `as_multi` with the full call data must run it (Checked Nov 14, 2026).
- `maxWeight` must cover the inner call, or the approval fails with `MaxWeightTooLow`. Take the weight from `transactionPaymentCallApi.queryCallInfo(call, length)`.
- The extrinsic succeeds even when the inner call fails. Read the result in `multisig.MultisigExecuted { approving, timepoint, multisig, call_hash, result }`.
- The opener reserves `depositBase` 5.43 + `depositFactor` 1.92 x threshold (9.27 tPOT for a threshold of 2) until the call runs or is cancelled (constants Checked Nov 14, 2026, the same on both networks; at most 100 signatories).
- Approvers who dry-run at different times get different limits, and so a different call and call hash. Round the limits so that every approver builds the same call.

## Proxy rules

Checked Nov 15, 2026 on the testnet, unless marked.

- Types: Any, NonTransfer, Governance and Staking (the runtime metadata). A call that the proxy's type does not cover is not run, yet the transaction succeeds: read the result in `Proxy.ProxyExecuted` (E38).
- `Proxy.addProxy` reserves `proxy.proxyDepositBase` (0.63 tPOT) plus `proxy.proxyDepositFactor` (1.98 tPOT) for each proxy: 2.61 tPOT for one, reserved in block 477947 and returned by `Proxy.removeProxy` in block 477951 (sent transactions).
- `Proxy.proxy` with a `forceProxyType` that the relation does not have answers `Proxy.NotProxy`; sent, it was included, failed and paid its fee (block 477950). Pass `null` unless you need one type.

## Staking numbers

Checked Nov 14, 2026, the same on both networks:

- A session is 600 blocks (1 hour) and an era is 6 sessions (6 hours).
- `staking.bondingDuration` is 672 eras: at 6 hours per era, unbonded tPOT stays unavailable for about 168 days.
- `staking.historyDepth` is 84 eras (about 21 days). Reported: rewards nobody claims within 84 eras are lost; that matches the upstream meaning of this constant (our reading).
- Both networks have 2 validators (`session.validators`).

Checked Nov 15, 2026 on the testnet:

- A bond is a hold, not a lock. The 8 accounts with a staking ledger and the 6 nomination pool members all had `frozen` 0 (block 477769). A stash's bond sits in `balances.holds` as `staking.Staking`, a pool member's stake as `delegatedStaking.StakingDelegation`, and both count in `reserved`.
- `Staking.bond` can bond tPOT that a vesting lock holds: from an account with 25.61 tPOT free, 10 of it locked, a bond of 25 tPOT left exactly the free balance less 25.1 tPOT spendable (dry runs on two accounts). What stays spendable beside a lock, hold or reserve, and the errors past it: Balances in `native-call-errors.md`, and E47.

## Vesting

- A vesting lock stays after its schedule has ended, until `Vesting.vest` is sent. On Nov 15, 2026 both vesting schedules on the testnet had ended long before, yet `balances.locks` still held 10 and 9.7 tPOT; a transfer of the free balance less 0.1 tPOT answered `Token(Frozen)`, and the same transfer after `Vesting.vest`, in one `Utility.batchAll`, was accepted (Checked by dry run on both accounts).
- A schedule in `vesting.vesting(account)` has ended when (current block - `startingBlock`) x `perBlock` >= `locked` (Checked Nov 15, 2026 by dry run on one account).

## TransactionStorage

Checked Nov 15, 2026 on the testnet.

- `transactionStorage.store(data)` (`0x3300`) takes 1 to 8388608 bytes (`transactionStorage.maxTransactionSize`). The chain's text: "Data will be removed after `RetentionPeriod` blocks, unless `renew` is called". `RetentionPeriod` is 100800 blocks, about 7 days. `renew(block, index)` (`0x3301`) takes the block and index from the data's last `Stored` or `Renewed` event. The runtime has no authorize calls.
- Cost, from sent transactions: a store of 16 bytes paid a fee of 0.0126 tPOT and 1160 base units more, held and then burned (`Balances.Held`, `Balances.BurnedDebt`): `ByteFee` 10 base units x 16 + `EntryFee` 1000 (block 478138). Its renew paid 0.0117 tPOT and the same 1160 units (block 478139). The fee grows by about 0.0001 tPOT per byte: `TransactionPaymentCallApi_query_call_info` gave 0.1138 tPOT for 1024 bytes and 0.4210 tPOT for 4096 bytes.
- A dry run of a valid `store` or `renew` answers `TransactionStorage.BadContext`, and sent they succeed (E53). A renew of a block and index that hold nothing was included, failed with `RenewedNotFound` and paid its fee (block 478141).
- Reading data back over JSON-RPC: `state_call` of `TransactionStorageApi_indexed_transactions` with the block number as 4 little-endian bytes lists each entry's `contentHash`, `size` and `cidCodec` (85); @polkadot/api's `createType('u32', n).toHex()` is big-endian, names another block and gets an empty list (`0x00`). `bitswap_v1_get` takes the CIDv1 `"b"` + lower-case base32, without padding, of `0x01 0x55 0xa0 0xe4 0x02 0x20` + `contentHash`, and returns the bytes as hex; check that their blake2-256 is `contentHash`. Given the `0x` hash itself, it answers -32602 "Invalid CID: Failed to parse multihash".
- Treat stored data as public: anyone can fetch it this way, and the block that stored it keeps the bytes in its body (block 279419 still held them 198,759 blocks later). Whether the node stops serving data whose retention has ended is not known: the oldest data we fetched by bitswap had been renewed.

## Modules named in the feature list that the runtime does not have

- The V3.0 feature list and launch post name Referenda, ConvictionVoting, `paras`, `cumulus_parachain_system` and iBridge (Guide).
- None of them is in the runtime of either network (Checked Nov 14, 2026). RegistrarPara (95) and RegistrarRelay (96) are there instead.
- Build only on modules the metadata lists; `search_chain` shows what exists.

## Other notes

- The native Scheduler refuses a signed account with `BadOrigin` (Checked Nov 15, 2026 by dry run; `native-call-errors.md`).
- Reported: some extrinsics that carry an asset-fee `assetId` cannot be decoded by polkadot.js; this probably relates to `ChargeAssetTxPayment` (our guess).
- Both networks have a Sudo key (Checked Nov 14, 2026).
