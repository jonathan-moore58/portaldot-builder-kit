# Amounts, fees, gas and deposits

Decimals, the existential deposit, what `eth_getBalance` shows, the gas price, how gas and deposits combine, and what transactions really cost. Read it before you write any amount, fee, gas limit or deposit limit into code, or when an estimate looks wrong.

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
- Keep Ethereum-side values whole multiples of 10^4 wei, so they map to whole native units. `eth_call` and `eth_estimateGas` accept other values (Checked Nov 14, 2026); what a sent transaction does with the remainder is not known (`open-questions.md`).

## The existential deposit

- 0.1 tPOT (10^13 base units) on the testnet and 0.1 POT on the mainnet (Checked Nov 14, 2026, `balances.existentialDeposit`).
- It is the smallest balance an account may hold. Below it the account is removed, and what was left is lost. `balances.transferKeepAlive` refuses a transfer that would take the sender below it; `transferAllowDeath` does not (Experience, from the chain's call documentation).
- A payment that creates a new account also funds its 0.1. On Nov 14, 2026, `eth_estimateGas` of a 1 wei payment came to 0.1123 tPOT for an address with no account and 0.0123 tPOT for an existing account (Checked; `evm-checks.md` section 7).

## What eth_getBalance shows

- `eth_getBalance` = (free - max(frozen, existential deposit)) x 10000 wei + the account's dust (Checked Nov 14, 2026 on 19 accounts on both networks, and again on 8 testnet accounts at block 464152). `reviveApi.balance` returns the same number.
  - For an account with nothing frozen this is (free - 0.1 tPOT) x 10000 + dust.
  - A frozen amount larger than 0.1 tPOT (a vesting lock, a nomination-pool freeze) is left out instead of the 0.1: an account with 25.6126 tPOT free and a 10 tPOT vesting lock showed 15.6126 tPOT plus its dust.
  - Reserved and held amounts (staking, contract deposits) are not part of `free` and do not lower the figure.
  - Not measured: an account with both a frozen and a reserved amount. No such account existed on either network on Nov 14, 2026.
- Example, the Treasury at testnet block 464152: free 15486398055870704255 base units (about 154863.98 tPOT), nothing frozen, no dust; `eth_getBalance` of `0x8ddee436166f311ddeed36d714b08f512670d16e` at that block = 154863880558707042550000 wei, exactly (free - 0.1 tPOT) x 10000.
- Dust: Revive keeps a per-account amount below 10^4 wei (`AccountInfo.dust`, a u32) for values that do not fit whole native units. One account showed 9271 wei of dust on Nov 14, 2026. The dust is added even when nothing can be spent: an account holding exactly 0.1 tPOT with 3 wei of dust showed 3 wei (Checked Nov 14, 2026).
- So a wallet's "max" on the Ethereum side never includes the 0.1 tPOT the account must keep, nor a frozen amount. `get_account` shows what is free, reserved and frozen.

## The gas price

- `eth_gasPrice` returns the base fee, and a priority fee of 0 is accepted: `eth_maxPriorityFeePerGas` returns `0x0` (Checked Nov 14, 2026), and every Ethereum transaction we sent used 0 (Experience).
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

- In mid October 2026 it was about 39600. Read it each time and never hard-code it.

## Gas includes the deposits

- On the Ethereum side, gas covers the fee and every deposit the transaction holds. A receipt's `gasUsed x effectiveGasPrice` = the fee plus all deposits held: checked on 8 Ethereum transactions against the node's events, it equalled (`TransactionFeePaid.actualFee` + every `Balances.Held` amount) x 10000, plus 5570 to 14860 wei, always less than one gas price (Checked Nov 14, 2026). For a deployment the held amounts include the code deposit.
  - Example, the creation transaction in block 354887: 511.806 tPOT on the receipt = a fee of 0.6466 + a code deposit of 384.36 + a storage deposit of 126.7995, plus 14300 wei (Checked Nov 14, 2026).
- A native call sent from a `0x` account to the pallets address shows `gasUsed` 0 and `effectiveGasPrice` 0 on its receipt; its fee is only in the node's `TransactionFeePaid` event (Checked Nov 13 and Nov 14, 2026).
- So the gas used by the same call changes with the gas price. Two identical contract calls used 103.97 x 10^12 gas at 37165 wei and 153.92 x 10^12 gas at 25105 wei; each cost 3.864 tPOT, of which 3.8415 was the deposit for one new storage slot (Checked Oct 20 and Nov 1, 2026: the receipts; reading it this way is ours).
- `eth_estimateGas` includes the deposits too. Examples on Nov 14, 2026 at 15665 wei per gas (Checked):
  - deploying 100 bytes of runtime code (init code `0x60646000f3`): 1356380154168200 gas, about 21.25 tPOT (20.91 of deposit, the rest fee);
  - a native `system.remarkWithEvent("hello")` sent from a `0x` account through the pallets address: 849564017363 gas, about 0.0133 tPOT.
- An estimate does not check that the sender can pay the fee. With a value of 0, `eth_estimateGas` answers for an address with no balance (Checked Nov 14, 2026: a remark through the pallets address). Only a value the sender cannot cover fails at that stage, with `insufficient funds for gas * price + value` (E1 in `errors.md`). The node checks the fee when the transaction is sent, and refuses it with error 1010.
- Judge an estimate in tokens: `gas x gasPrice / 10^18`. Then compare it with the deposit you expect (new slots x 3.8415, plus code, plus 0.1 for a new account).

## The rule for an Ethereum transaction

- Gas limit = `eth_estimateGas` + 10 percent. Max fee = `eth_gasPrice` + one eighth. Priority fee 0.
- Before signing, check balance >= value + gas limit x max fee. The node refuses a transaction whose gas limit x base fee, plus its value, is more than the sender's balance, with error 1010, and nothing is mined (Checked Nov 13, 2026; E1 in `errors.md`).
- Basis: Experience, proven by six contract calls sent as Ethereum transactions between Oct 19 and Nov 1, 2026, and two native calls sent from a `0x` account on Nov 13, 2026. All were EIP-1559 (type 2) transactions.
- Worked example, the remark above: estimate 849564017363; limit 934520419099; max fee 15665 + 1958 = 17623 wei; the balance must cover 934520419099 x 17623 wei = about 0.0165 tPOT, while the transaction costs about 0.0133.
- A limit far above the estimate can ask for more than the account holds; that is the usual cause of 1010 here. A limit below what the deposit needs can fail with `TxFeeOverdraw`, which the chain documents as "Too much deposit was drawn from the shared txfee and deposit credit. This happens if the passed `gas` inside the ethereum transaction is too low." (Checked Nov 14, 2026 that the error and its text exist.)
- `estimate_eth_transaction` applies this rule and makes the 1010 check. It works on the mainnet too, through the node's runtime API.

## Native fees

- The native path charges the fee and the deposit separately. Estimate the fee with `(await tx.paymentInfo(sender)).partialFee` (the RPC `payment_queryInfo`) (Experience).
- The fee actually paid is in the extrinsic's `transactionPayment.TransactionFeePaid { who, actualFee, tip }` event; `actualFee` includes the tip (Checked Nov 13, 2026).
- Fees go to the Treasury (Checked Nov 13 and Nov 14, 2026).

Fees seen (Checked on the dates given):

| Extrinsic | Fee in tPOT |
|---|---|
| `balances.transferKeepAlive` | 0.0149 to 0.0150 (four transfers, Oct 20 to Nov 1, 2026); `paymentInfo` 0.0148 and 0.0149 on Nov 14, 2026 |
| `system.remarkWithEvent` from a `0x` account through the pallets address | 0.0158 (Nov 13, 2026) |
| `balances.transferKeepAlive` from a `0x` account through the pallets address | 0.0159 (Nov 13, 2026) |
| `revive.call` that wrote one new slot | 0.0253, plus 3.8415 of deposit (Oct 27, 2026) |
| `revive.instantiateWithCode`, 899 bytes of runtime code | 0.1285, plus 83.232 of deposit (Oct 19, 2026) |
| `multisig.asMulti` opening a 2-of-3 call | 0.0328 (Oct 2026) |
| `multisig.asMulti` running it | 0.0336 (Oct 2026) |

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
- Smaller code costs less. Build settings that shrink code are in `contracts.md`. `simulate_contract_deploy` reports the exact deposit for your code.

## Dry runs and limits

- A Revive dry run (`reviveApi.call`, `reviveApi.instantiate`) reports `storageDeposit` (the net charge or refund) and `maxStorageDeposit` (the most held at any point). The limit you pass must cover the maximum, even when the net is 0 (Experience).
- The limits our tools used on the native path (Experience, proven on every native-path contract call and deployment we sent):
  - weight limit: the dry run's `weightRequired` + 10 percent;
  - storage deposit limit: the larger of `storageDeposit` and `maxStorageDeposit`, + 2 percent;
  - balance check: free >= value + deposit limit + fee + 0.1 tPOT.
- In dry runs on Nov 14, 2026 (Checked): half the required `refTime` gave `Revive.OutOfGas`; a deposit limit 1 base unit below the deposit gave `Revive.StorageDepositLimitExhausted`; a limit of 0 passed for a call that stores nothing and failed for one that writes a slot.
- For a call inside a multisig, take the weight from the runtime call `transactionPaymentCallApi.queryCallInfo(call, length)` (Experience).

## Multisig deposits

- `multisig.depositBase` 5.43 tPOT and `multisig.depositFactor` 1.92 tPOT, at most 100 signatories (Checked Nov 14, 2026, the same on both networks).
- The account that opens a multisig call reserves depositBase + depositFactor x threshold until the call runs: 9.27 tPOT for a threshold of 2 (Experience, Oct 20, 2026).

## Paying fees in another asset

- The transaction extension `ChargeAssetTxPayment` and the module `AssetConversionTxPayment` (index 9) exist (Checked Nov 14, 2026), so fees can in principle be paid in another asset. We have not tried it.

## What other builders report

- Reported: storage deposits that did not come back, one of them 7.53 tPOT. We saw a refund when a slot was cleared (`open-questions.md` item 5).
- Reported: deployments of several contracts costing 400 to 1386 tPOT. That fits the formula above for large code: one 5000-byte contract alone holds 403.11 tPOT, and the creation transactions in blocks 354887 and 346634 show about 512 and 515 tPOT on their receipts (Checked Nov 14, 2026).
- Reported: one deployment through MetaMask cost 289 tPOT against 0.36 tPOT on the native path. A receipt's cost includes the deposits, while a native fee does not: of the 511.806 tPOT on the receipt in block 354887, the fee was 0.6466 (Checked Nov 14, 2026). Two such figures differ this much when one includes the deposits and the other does not (our reading).
