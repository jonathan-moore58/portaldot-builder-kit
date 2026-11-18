# Amounts, fees, gas and deposits

Decimals, the existential deposit, what `eth_getBalance` shows, what an account can really send, the gas price, how gas and deposits combine, and what transactions really cost. Read it before you write any amount, fee, gas limit or deposit limit into code, or when an estimate looks wrong.

Basis words: Checked (measured on the chain by the Bridge Zero team, on the date given), Experience (learned while building and running our own tools on this chain), Guide (the chain team's testnet guide), Reported (said by other builders, not checked by us).

## Decimals and units

Checked Nov 14, 2026 on both networks.

- The native token is tPOT on the testnet and POT on the mainnet, with 14 decimals: 1 tPOT = 10^14 base units.
- The Ethereum side shows the same token with 18 decimals. `revive.nativeToEthRatio` is 10000: 1 native base unit = 10^4 wei, and 1 tPOT = 10^18 wei.
- The guide calls the token `tPOTv3` (Guide); the chain's own symbol is `tPOT`.
- `convert_amount` converts exactly between tokens, base units and wei, and says which unit each place takes.

Which unit each place uses:

| Place | Unit |
|---|---|
| `System.Account.data.free`, `balances.transferKeepAlive` amount, fees, `storageDepositLimit` | native base units (14 decimals) |
| `value` of `revive.call` and `revive.instantiateWithCode` (Experience) | native base units; the contract sees `msg.value = value x 10^4` |
| `value` of an Ethereum transaction, `msg.value`, `eth_getBalance` (Experience) | wei (18 decimals) |
| `eth_gasPrice`, `effectiveGasPrice` | wei per gas |
| `gasUsed x effectiveGasPrice` of a receipt | wei: the fee plus every deposit the transaction held |
| Revive dry-run `storageDeposit` and `maxStorageDeposit` | native base units |

- Use BigInt. A JS `Number` is exact only up to 2^53, which is about 90 tPOT in base units and about 0.009 tPOT in wei.
- A value that is not a whole multiple of 10^4 wei is accepted and kept to the wei (see Dust below). Prefer whole multiples anyway: native tools do not show the part below 10^4 wei.

## The existential deposit

- 0.1 tPOT (10^13 base units) on the testnet and 0.1 POT on the mainnet (Checked Nov 14, 2026, `balances.existentialDeposit`).
- It is the smallest balance an account may hold. Below it the account is removed, and what was left is lost. `balances.transferKeepAlive` refuses a transfer that would take the sender below it.
  - `transferAllowDeath` took an account below it only where the account had no consumers (the Treasury) or two providers (a nomination-pool member). From 6 accounts with one provider and a lock, freeze, hold or reserve, it refused one base unit more than `transferKeepAlive` allows, and the whole free balance, with `Failed to dispatch call: Token(Frozen)` (Checked Nov 15, 2026 by dry run; E47).
- A payment that creates a new account also funds its 0.1. On Nov 14, 2026, `eth_estimateGas` of a 1 wei payment came to 0.1123 tPOT for an address with no account and 0.0123 tPOT for an existing account (Checked; `evm-checks.md` section 7).
  - When contract code pays a new address, any amount works: 1 wei and 0.05 tPOT to new addresses succeeded, and the transaction's origin paid 0.1 tPOT per new account (Checked Nov 15, 2026 by dry run; E54).
  - Sent on Nov 15, 2026: tPOT attached to a call to a token address created an account there, with 0.1 tPOT taken from the sender (block 478205, `System.NewAccount`, `Balances.Endowed` 0.1 tPOT; E44).

## What eth_getBalance shows

- `eth_getBalance` = (free - max(frozen, existential deposit)) x 10000 wei + the account's dust (Checked Nov 14, 2026 on 19 accounts on both networks, and again on 8 testnet accounts at block 464152; Checked Nov 15, 2026 on 8 testnet accounts with a lock, freeze, hold or reserve). `reviveApi.balance` returns the same number.
  - For an account with nothing frozen this is (free - 0.1 tPOT) x 10000 + dust.
  - A frozen amount larger than 0.1 tPOT (a vesting lock) is left out instead of the 0.1: an account with 25.6126 tPOT free and a 10 tPOT vesting lock showed 15.6126 tPOT plus its dust.
  - Reserved and held amounts (staking, contract deposits, proxy and asset deposits) are not part of `free` and do not lower the figure. Staking here is a hold, not a lock: all 8 staking ledgers on the testnet had nothing frozen, and a pool member's stake is a hold too. The only freeze on the testnet was 0.1 tPOT on a nomination pool's own reward account (Checked Nov 15, 2026).
  - Not measured: an account with both a frozen and a reserved amount. None existed on either network on Nov 14, 2026, nor on the testnet on Nov 15, 2026.
- Example, the Treasury at testnet block 464152: free 15486398055870704255 base units (about 154863.98 tPOT), nothing frozen, no dust; `eth_getBalance` of `0x8ddee436166f311ddeed36d714b08f512670d16e` at that block = 154863880558707042550000 wei, exactly (free - 0.1 tPOT) x 10000.
- Dust: Revive keeps a per-account amount below 10^4 wei (`AccountInfo.dust`, a u32) for values that do not fit whole native units. One account showed 9271 wei of dust on Nov 14, 2026. The dust is added even when nothing can be spent: an account holding exactly 0.1 tPOT with 3 wei of dust showed 3 wei (Checked Nov 14, 2026).
  - Sent on Nov 15, 2026 (block 477828): a transfer of 0.001 tPOT + 1 wei. The sender's `eth_getBalance` fell by exactly that value plus the fee, the receiver's native balance rose by exactly 0.001 tPOT, and its `eth_getBalance` then ended in `...0001`: the 1 wei is dust that only the Ethereum side shows. Contracts read such a `msg.value` exactly and pass it on exactly (Checked Nov 15, 2026 by dry run).
- So a wallet's "max" on the Ethereum side never includes the 0.1 tPOT the account must keep, nor a frozen amount. `get_account` shows what is free, reserved and frozen.

## What an account can really send

Checked Nov 15, 2026 by dry run, to the base unit, on 8 testnet accounts: two under a vesting lock, a pool's reward account (a 0.1 tPOT freeze), a staking stash, a nomination-pool member and an account with a `contracts` code-upload deposit (holds), and an asset owner and an account with proxies (plain reserves).

- Native: the largest transfer is **free - max(frozen - reserved, 0.1 tPOT)**, less the fee (a dry run charges none).
  - One base unit more answers `Failed to dispatch call: Token(Frozen)`, also when nothing is frozen and also from `transferAllowDeath`. The pool member, which has two providers, got `Token(NotExpendable)` instead (E47).
  - `revive.call` with a value one base unit above it answers `Failed to dispatch call: Module(ModuleError { index: 80, error: [4, 0, 0, 0], message: Some("TransferFailed") })`, the same text as for a value above the whole balance.
  - A hold can sit under a lock: after `Staking.bond` of 5 tPOT under a 10 tPOT vesting lock (inside one `utility.batchAll`), the limit was still free - (frozen - reserved).

| What keeps the tPOT | Where it shows | What it takes from the limit |
|---|---|---|
| A vesting lock (`balances.locks`) | `frozen` | the lock less what is reserved; the 0.1 tPOT sits inside it |
| A freeze (`balances.freezes`; on the testnet only a pool's reward account) | `frozen` | the same as a lock |
| A hold (`balances.holds`: staking, a pool member's stake, a code-upload deposit) | `reserved`, outside `free` | nothing beyond the 0.1 tPOT |
| A plain reserve (for example asset or proxy deposits) | `reserved`, outside `free` | nothing beyond the 0.1 tPOT |

- Ethereum side: when nothing is both frozen and reserved, `eth_getBalance` is that same limit, plus the dust. `eth_estimateGas` accepted a value of exactly `eth_getBalance` and refused 1 wei more with `insufficient funds for gas * price + value (0): address 0x... have <eth_getBalance> (supplied gas Some(18446744073709551615))`. It does not add the fee: leave room for it (The rule for an Ethereum transaction, below).
- A vesting lock stays after its schedule has ended: both vesting schedules on the testnet had ended long before, yet still locked 10 and 9.7 tPOT. `Vesting.vest` releases it: `utility.batchAll [Vesting.vest(), transfer]` passed where the transfer alone got `Token(Frozen)` (E47).
- A signed native call that fails when it runs is still included, uses its nonce and pays its fee: a `transferKeepAlive` of twice the free balance failed with `Token(FundsUnavailable)` and paid 0.0150 tPOT (sent, Nov 15, 2026, block 477796). What a sent transfer above the limit of a locked account does was not measured.

## The gas price

- `eth_gasPrice` returns the base fee, and a priority fee of 0 is accepted: `eth_maxPriorityFeePerGas` returns `0x0` (Checked Nov 14, 2026), and every Ethereum transaction we sent before Nov 15, 2026 used 0 (Experience). A priority fee is not charged (The rule for an Ethereum transaction, below).
- `eth_gasPrice` and the node's `reviveApi.gasPrice` gave the same value when read together on Nov 14, 2026 (15670 wei).
- Mainnet: 5000 wei per gas, read through the node with `reviveApi.gasPrice`, since the mainnet has no Ethereum RPC (Checked Nov 14, 2026). A call costs about the same in tokens on both networks, so its gas number is about 3 times larger on the mainnet: `system.remarkWithEvent("hello")` through the pallets address was estimated at 2661325327334 gas at 5000 wei (0.0133 POT) on the mainnet and 849564017363 gas at 15665 wei (0.0133 tPOT) on the testnet (Checked Nov 14, 2026). Gas numbers do not carry over between the networks.
- The testnet price moves and has fallen over time (Checked on each date):

| Date | Gas price (wei per gas) |
|---|---|
| Oct 19, 2026 | 38840 |
| Oct 20, 2026 | 37165 |
| Oct 27, 2026 | 28875 |
| Nov 1, 2026 | 25105 |
| Nov 13, 2026 | about 16125 |
| Nov 14, 2026 | about 15700 (it fell from 15825 to 15575 during that day) |
| Nov 15, 2026 | 15130 to 15145 |

- In mid October 2026 it was about 39600. Read it each time and never hard-code it.

## Gas includes the deposits

- On the Ethereum side, gas covers the fee and every deposit the transaction holds. A receipt's `gasUsed x effectiveGasPrice` = the fee plus all deposits held: checked on 8 Ethereum transactions against the node's events, it equalled (`TransactionFeePaid.actualFee` + every `Balances.Held` amount) x 10000, plus 5570 to 14860 wei, always less than one gas price (Checked Nov 14, 2026). For a deployment the held amounts include the code deposit.
  - Example, the creation transaction in block 354887: 511.806 tPOT on the receipt = a fee of 0.6466 + a code deposit of 384.36 + a storage deposit of 126.7995, plus 14300 wei (Checked Nov 14, 2026).
  - A reserve made by a native module that the transaction calls is not in gas: an ERC-20 `approve` on an Assets token reserved 0.1 tPOT from the owner while its receipt showed 0.0187 tPOT (sent, Nov 15, 2026, block 478195; Token approval deposits, below).
- A native call sent from a `0x` account to the pallets address shows `gasUsed` 0 and `effectiveGasPrice` 0 on its receipt; its fee is only in the node's `TransactionFeePaid` event (Checked Nov 13 and Nov 14, 2026). The same when the call fails: a transfer through the pallets address that failed (status `0x0`, block 477826) still cost the sender 0.0162 tPOT (sent, Nov 15, 2026; E46).
- So the gas used by the same call changes with the gas price. Two identical contract calls used 103.97 x 10^12 gas at 37165 wei and 153.92 x 10^12 gas at 25105 wei; each cost 3.864 tPOT, of which 3.8415 was the deposit for one new storage slot (Checked Oct 20 and Nov 1, 2026: the receipts; reading it this way is ours).
- `eth_estimateGas` includes the deposits too. Examples on Nov 14, 2026 at 15665 wei per gas (Checked):
  - deploying 100 bytes of runtime code (init code `0x60646000f3`): 1356380154168200 gas, about 21.25 tPOT (20.91 of deposit, the rest fee);
  - a native `system.remarkWithEvent("hello")` sent from a `0x` account through the pallets address: 849564017363 gas, about 0.0133 tPOT.
- The estimate is above what is used: a plain transfer's estimate was 4.8 percent above the gas it used (sent, Nov 15, 2026, block 477814), and the smallest gas limit that ran a deployment was about 1.5 percent below its estimate (Checked Nov 15, 2026 by dry run).
- An estimate does not check that the sender can pay the fee. With a value of 0, `eth_estimateGas` answers for an address with no balance (Checked Nov 14, 2026: a remark through the pallets address). Only a value the sender cannot cover fails at that stage, with `insufficient funds for gas * price + value` (E1 in `errors.md`). Even with `gasPrice` given, it accepted a value equal to the whole `eth_getBalance` (Checked Nov 15, 2026), so a "max" built on the estimate leaves nothing for the fee.
- Judge an estimate in tokens: `gas x gasPrice / 10^18`. Then compare it with the deposit you expect (new slots x 3.8415, plus code, plus 0.1 for a new account).

## The rule for an Ethereum transaction

- Gas limit = `eth_estimateGas` + 10 percent. Max fee = `eth_gasPrice` + one eighth. Priority fee 0.
- Before signing, check balance >= value + gas limit x max fee. That covers both checks below, with room for the base fee to rise up to the max fee (our reading of the sends below).
- Basis: Experience, proven by six contract calls sent as Ethereum transactions between Oct 19 and Nov 1, 2026, and two native calls sent from a `0x` account on Nov 13, 2026. All were EIP-1559 (type 2) transactions.

What the node checks and what it charges (Checked Nov 15, 2026 by sent transactions from Ethereum keys, type 2 and legacy, signed with ethers 6; testnet blocks 477814 to 478132, base fee 15130 to 15145 wei):

- Before the block, the node takes a transaction when **gas limit x base fee <= what the sender can spend** (`eth_getBalance`). With gas limit x base fee 5 percent above that it answered a bare `{"code":1010,"message":"Invalid Transaction"}`, and 2 percent below it the transaction was mined (block 478132). A refused transaction is not mined and costs nothing; the node's own check (recipe 2f in `recipes-contracts.md`) calls it `Payment`.
- The max fee, a legacy gas price, the priority fee and the value are not part of that check. Mined: gas limit x max fee at twice the balance (type 2, block 478128; legacy, block 478129), gas limit x (base fee + priority fee) at 1.2 times the balance (block 478130), and a balance between gas limit x base fee + value and gas limit x max fee + value (block 477914).
- The value is checked in the block. A sender that covered gas limit x base fee but not the value on top, and one that sent its whole `eth_getBalance` as the value, were mined as failed (status `0x0`, blocks 477940 and 477900) and paid the fee (E45).
- Also refused with the same bare 1010: a gas limit below the gas the transaction uses (1 percent below, half the estimate, or 67501 as forge script sends: E39), and a max fee below the base fee (1 wei below, or half of it).
- Charged: gas used x base fee. The receipt's `effectiveGasPrice` was the base fee for a type 2 transaction with a priority fee of half the base fee and for a legacy gas price of twice the base fee, and the balance fell by exactly the value + gas used x base fee. Unused gas, the room up to the max fee and the priority fee are not charged (blocks 477814, 477816, 477889, 477898). A priority fee still ranks transactions with the same nonce in the pool (E12).
- So a gas limit above the estimate raises what the sender must hold, not what it pays. With a balance close to the cost, a large pad alone gives a bare 1010. ethers 6.17, viem 2.57, Hardhat 3.22 and cast 1.8.5 take `eth_estimateGas` unchanged as the limit (Checked Nov 15, 2026, through a local proxy that sent nothing); forge script does not ask the node and sends limits far too low here (E39).
- To send everything from an Ethereum key: value = `eth_getBalance` - gas limit x max fee (our reading of the sends above). The node charges only gas used x base fee, so a little stays; the existential deposit is already left out of `eth_getBalance`.
- The same transfer used more gas as its signed bytes grew: 793.0 x 10^9 as a legacy transaction, 819.1 x 10^9 as type 2, 832.3 x 10^9 to 832.6 x 10^9 as type 2 with a priority fee and a higher max fee (Checked Nov 15, 2026, sent).
- Worked example, the remark above: estimate 849564017363; limit 934520419099; max fee 15665 + 1958 = 17623 wei. The node needs 934520419099 x 15665 wei = about 0.0146 tPOT; the check before signing, with the max fee, asks for 934520419099 x 17623 wei = about 0.0165 tPOT; the transaction costs about 0.0133.
- A limit below what the deposit needs can fail with `TxFeeOverdraw`, which the chain documents as "Too much deposit was drawn from the shared txfee and deposit credit. This happens if the passed `gas` inside the ethereum transaction is too low." (Checked Nov 14, 2026 that the error and its text exist.)
- `estimate_eth_transaction` applies this rule, and its verdict follows the measured check (gas limit x base fee). It works on the mainnet too, through the node's runtime API.

## Native fees

- The native path charges the fee and the deposit separately. Estimate the fee with `(await tx.paymentInfo(sender)).partialFee` (the RPC `payment_queryInfo`) (Experience).
- The fee actually paid is in the extrinsic's `transactionPayment.TransactionFeePaid { who, actualFee, tip }` event; `actualFee` includes the tip (Checked Nov 13, 2026).
- Fees go to the Treasury (Checked Nov 13 and Nov 14, 2026).

Fees seen (Checked on the dates given; on Nov 15, 2026 sent unless marked):

| Extrinsic | Fee in tPOT |
|---|---|
| `balances.transferKeepAlive` | 0.0149 to 0.0150 (four transfers, Oct 20 to Nov 1, 2026); `paymentInfo` 0.0148 and 0.0149 on Nov 14, 2026; 0.0150 for one that failed in the block (Nov 15, 2026) |
| `system.remark` of a few bytes | 0.0114 to 0.0126 (five, Nov 15, 2026) |
| `utility.batchAll` of two transfers | 0.0194 and 0.0196 (Nov 15, 2026) |
| `proxy.proxy` with a call inside | 0.0161 to 0.0184 (Nov 15, 2026); `proxy.removeProxy` 0.0147 |
| `assets.transfer` | `paymentInfo` 0.0146 (Nov 15, 2026) |
| `assetConversion.swapExactTokensForTokens` and a transfer in one `utility.batchAll` | 0.0226 (Nov 15, 2026) |
| `transactionStorage.store` of 16 bytes | 0.0126, plus 1160 base units burned (16 bytes x `ByteFee` 10 + `EntryFee` 1000); `renew` 0.0117 plus the same (Nov 15, 2026) |
| `transactionStorage.store`, larger data | about 0.0001 per byte: `queryCallInfo` 0.1138 for 1024 bytes and 6.5652 for 65536 bytes (Nov 15, 2026, not sent) |
| `system.remarkWithEvent` from a `0x` account through the pallets address | 0.0158 (Nov 13, 2026) |
| `balances.transferKeepAlive` from a `0x` account through the pallets address | 0.0159 (Nov 13, 2026); 0.0162 for one that failed (Nov 15, 2026) |
| `revive.call` that wrote one new slot | 0.0253, plus 3.8415 of deposit (Oct 27, 2026) |
| `revive.instantiateWithCode`, 899 bytes of runtime code | 0.1285, plus 83.232 of deposit (Oct 19, 2026) |
| `multisig.asMulti` opening a 2-of-3 call | 0.0328 (Oct 2026) |
| `multisig.asMulti` running it | 0.0336 (Oct 2026) |

Ethereum transactions seen (Checked Nov 15, 2026, sent; gas used x base fee at 15130 to 15145 wei):

| Transaction | Gas used | tPOT |
|---|---|---|
| A transfer to an existing account, type 2 | 819.1 x 10^9 | 0.0124 |
| The same, legacy | 793.0 x 10^9 | 0.0120 |
| A contract call that reverted | 805.9 x 10^9 | 0.0122 |
| ERC-20 `transfer` or `approve` on an Assets token | 1.236 x 10^12 | 0.0187; `approve` also reserves 0.1 from the owner |
| ERC-20 `transferFrom` | 1.448 x 10^12 | 0.0219 |
| ERC-20 `permit`, sent by the spender | 2.30 x 10^12 | 0.0348; the 0.1 is reserved from the owner |

## Revive deposit constants

The same on both networks (Checked Nov 14, 2026, `api.consts.revive`):

| Constant | Value | Raw |
|---|---|---|
| `depositPerByte` | 0.06 tPOT | 6000000000000 |
| `depositPerItem` | 0.15 tPOT | 15000000000000 |
| `depositPerChildTrieItem` | 0.0015 tPOT | 150000000000 |
| `codeHashLockupDepositPercent` | 30 percent | 300000000 (Perbill) |
| `gasScale` | 5 | |
| `allowEVMBytecode` | true | |
| `debugEnabled` | false | |
| `autoMap` | true | |
| `nativeToEthRatio` | 10000 | |

## A contract storage slot

- A new 32-byte storage slot costs 64 bytes x 0.06 + one child-trie item x 0.0015 = 3.8415 tPOT (Checked Nov 14, 2026: deploy dry runs whose constructor wrote one and two new slots cost exactly 3.8415 and 7.683 more than the same code without them).
- Contract records on the testnet show the same prices: `storageByteDeposit` is 0.06 per stored byte and `storageItemDeposit` 0.0015 per item, at 64 bytes per slot (Checked Nov 14, 2026 on 10 contracts).
- The guide's own dry-run screenshot shows the same 384150000000000 base units (Guide).
- The sender pays it, and gets it back when the slot is cleared: a contract call that cleared a slot netted 0 on Oct 20, 2026 (Experience). See `open-questions.md` item 5 for reports that differ.

## Deploying a contract

The deposit for deploying a contract whose new runtime code is L bytes is **0.078 x L + 13.11 tokens**, before any storage its constructor writes.

- It is made of three parts:
  - a code deposit of (L + 70) x 0.06, held on the Revive module's own account `modlpy/reviv` (`5EYCAe5ijiYfhaAUBd6H9WGRTsvwFFc7GnhQkiHvBYxdvpbV`, hold reason `CodeUploadDepositReserve`) and recorded in `revive.codeInfoOf` as `deposit`, with the uploader as `owner`;
  - a storage base deposit of 7.65 + 30 percent of the code deposit (`codeHashLockupDepositPercent`), held on the new contract's own account (hold reason `StorageDepositReserve`, recorded as `storageBaseDeposit`);
  - 3.8415 per new 32-byte storage slot the constructor writes, held on the contract's account too.
- Together, before storage: (L + 70) x 0.06 x 1.3 + 7.65 = 0.078 x L + 13.11.
- For code that is already stored on the chain, the code deposit is not charged again; the base deposit is. That is 0.018 x L + 8.91 before storage: one byte of stored code cost 8.928 tPOT instead of 13.188, and 6336 bytes of stored code 122.958 instead of 507.318 (Checked Nov 14, 2026, dry runs). `simulate_contract_deploy` says whether your code is already stored.
- Checked Nov 14, 2026:
  - dry runs of `reviveApi.instantiate` for 1 to 24576 bytes of runtime code, the same on both networks: for example 1 byte 13.188, 100 bytes 20.91, 777 bytes 73.716, 1000 bytes 91.11, 5000 bytes 403.11;
  - the on-chain records of more than 20 contracts: `deposit` = (codeLen + 70) x 0.06, and `storageBaseDeposit` = 7.65 + 30 percent of it;
  - the Revive module account held 58651.44 tPOT under `CodeUploadDepositReserve`, exactly the sum of the 279 code deposits in `revive.codeInfoOf`;
  - two dry runs on Oct 19, 2026 match too: 899 bytes gave 83.232 and 1100 bytes gave 98.91.
- Deployments by Ethereum transaction hold the same deposits: seen on the chain in other builders' transactions; not sent by us. The creation transaction in block 354887 (6336 bytes of runtime code) held a code deposit of 384.36 = (6336 + 70) x 0.06 on `modlpy/reviv` and a storage deposit of 126.7995 = 7.65 + 0.3 x 384.36 + one slot of 3.8415 (Checked Nov 14, 2026).
- Our reading, from one contract's numbers (a code deposit of 58.14 for 899 bytes and a base deposit of 25.092): the 70 is bytes of bookkeeping stored with the code, and 7.65 is 125 bytes x 0.06 plus one item x 0.15. That places `depositPerItem` (0.15) in the contract's record. The chain stores only the totals, so the split is ours; the totals are checked.
- Examples for new code: 1000 bytes 91.11 tPOT, 2000 bytes 169.11, 5000 bytes 403.11, 10000 bytes 793.11.
- A constructor that runs `selfdestruct` holds the same 13.11 tPOT as one that returns empty runtime code (Checked Nov 15, 2026 by dry run); whether a sent one gets it back is not known.
- Smaller code costs less. Build settings that shrink code are in `contracts.md`. `simulate_contract_deploy` reports the exact deposit for your code.

## Dry runs and limits

- A Revive dry run (`reviveApi.call`, `reviveApi.instantiate`) reports `storageDeposit` (the net charge or refund) and `maxStorageDeposit` (the most held at any point). The limit you pass must cover the maximum, even when the net is 0 (Experience).
- The limits our tools used on the native path (Experience, proven on every native-path contract call and deployment we sent):
  - weight limit: the dry run's `weightRequired` + 10 percent;
  - storage deposit limit: the larger of `storageDeposit` and `maxStorageDeposit`, + 2 percent;
  - balance check: free >= value + deposit limit + fee + 0.1 tPOT. For an account with a lock or a freeze, check against free - max(frozen - reserved, 0.1 tPOT) instead (Checked Nov 15, 2026; What an account can really send, above).
- In dry runs on Nov 14, 2026 (Checked): half the required `refTime` gave `Revive.OutOfGas`; a deposit limit 1 base unit below the deposit gave `Revive.StorageDepositLimitExhausted`; a limit of 0 passed for a call that stores nothing and failed for one that writes a slot.
- Each new account that the contract code pays adds 0.1 tPOT to `storageDeposit`, and a limit without it failed the whole instantiate with `Revive.StorageDepositLimitExhausted`, not only the payment (Checked Nov 15, 2026 by dry run, twice; E54).
- For a call inside a multisig, take the weight from the runtime call `transactionPaymentCallApi.queryCallInfo(call, length)` (Experience).

## Multisig deposits

- `multisig.depositBase` 5.43 tPOT and `multisig.depositFactor` 1.92 tPOT, at most 100 signatories (Checked Nov 14, 2026, the same on both networks).
- The account that opens a multisig call reserves depositBase + depositFactor x threshold until the call runs: 9.27 tPOT for a threshold of 2 (Experience, Oct 20, 2026).

## Proxy deposits

- `proxy.proxyDepositBase` 0.63 tPOT and `proxy.proxyDepositFactor` 1.98 tPOT per proxy (Checked Nov 15, 2026, the constants). Adding one proxy reserved 2.61 tPOT, and `proxy.removeProxy` returned it (sent, Nov 15, 2026, blocks 477947 and 477951).

## Token approval deposits

- An ERC-20 `approve` or `permit` on an Assets token reserves `assets.approvalDeposit`, 0.1 tPOT, from the owner, outside gas. It stays reserved while the approval exists, and `approve(spender, 0)` returned it. A `permit` sent by the spender took it from the owner, not from the sender (sent, Nov 15, 2026, blocks 478195, 478197 and 478203).
- So the owner needs 0.1 tPOT above the existential deposit: an `eth_getBalance` of at least 0.1 tPOT. With less, `approve` and `permit` fail (Checked Nov 15, 2026 by dry run; E41 has the replies). Fee estimates do not include it.

## Paying fees in another asset

- The transaction extension `ChargeAssetTxPayment` and the module `AssetConversionTxPayment` (index 9) exist (Checked Nov 14, 2026), so fees can in principle be paid in another asset. We have not tried it.

## What other builders report

- Reported: storage deposits that did not come back, one of them 7.53 tPOT. We saw a refund when a slot was cleared (`open-questions.md` item 5).
- Reported: deployments of several contracts costing 400 to 1386 tPOT. That fits the formula above for large code: one 5000-byte contract alone holds 403.11 tPOT, and the creation transactions in blocks 354887 and 346634 show about 512 and 515 tPOT on their receipts (Checked Nov 14, 2026).
- Reported: one deployment through MetaMask cost 289 tPOT against 0.36 tPOT on the native path. A receipt's cost includes the deposits, while a native fee does not: of the 511.806 tPOT on the receipt in block 354887, the fee was 0.6466 (Checked Nov 14, 2026). Two such figures differ this much when one includes the deposits and the other does not (our reading).
