# Native calls: what they answer to common mistakes

What the native modules answered to common mistakes on the testnet, in dry runs and, for the rows that name a block, in transactions we sent: the call, the mistake, the chain's reply and what to do. Read it when a native call, or `eth_estimateGas` through the pallets address, fails with an error you do not understand, or before you build a call that moves tPOT, tokens or NFTs.

Basis words: Checked (measured on the chain by the Bridge Zero team, on the date given), Experience (learned while building and running our own tools on this chain), Guide (the chain team's testnet guide), Reported (said by other builders, not checked by us).

Every reply in this file is Checked on Nov 15, 2026, by a dry run on the testnet (runtime spec 3002, blocks 474727 to 476042, and blocks 477797 to 478178 for the rows on locked, held and reserved tPOT, on address kinds and on TransactionStorage, and for the two `Proxy.proxy` cases that were also sent, in blocks 477948 and 477950). A row that names a block was also sent from our own test accounts on that day, and the row says what the block recorded: a transfer above the balance (blocks 477796 and 477826), two calls through a proxy (blocks 477948 and 477950), and `TransactionStorage.store` and `renew` (blocks 478138, 478139 and 478141). Every other row rests on dry runs alone: no sent transaction confirms it. The "What to do" column follows from the measured reply and from the chain's own text for that error.

## How this was measured

- We called `eth_estimateGas` on the pallets address `0x6d6f646c70792f70616464720000000000000000` with the bytes of a native call as `data` and a value of 0 (recipe 4 in `recipes-contracts.md`, E29 in `errors.md`). The node runs the native call as the sender and reports its result. `eth_call` answers alike.
- From the `0x` form of a native account that exists, and so is linked to it (`revive.originalAccount`, E8), the call runs as that native account itself; for a native account that does not exist yet, it runs as the `0x` form's fallback account (E4). From the Treasury's `0x` form `0x8ddee436166f311ddeed36d714b08f512670d16e`, the calls ran on the Treasury's own balance: a transfer of all but 0.05 tPOT of it answered `Token(NotExpendable)`. From a validator's `0x` form, `Staking.bond` answered `Staking.AlreadyBonded`.
- From the address of an Ethereum key, the call runs as that key's fallback account (E4). A 1 tPOT `Balances.transferKeepAlive` from the `0x` address of a fallback account that held 5.7 tPOT was accepted.
- A dry run may name any account as `from`, the sudo key included. No key is needed.
- The rows on locked, held and reserved tPOT come from seven accounts that existed on the testnet: one with a 10 tPOT vesting lock, a nomination pool's reward account with a 0.1 tPOT freeze, a staking stash, a pool member, an account with a contract code deposit hold, and two with reserves (one of them an asset owner). Each was dry-run at its exact limit, which was accepted, and at one base unit more, with its balance read at the same block. A second vesting account was dry-run on a later block.
- The sent rows used test accounts we funded for this, signed with @polkadot/api 17 (block 477826: an Ethereum transaction signed with ethers 6). A sent call that fails when it runs is still included and pays its fee (blocks 477796, 477826, 477950 and 478141); in block 477796 it also used its nonce.
- A refused call answers code -32000 with the message `Failed to dispatch call: <the error>` and no `data` field. For example, `Nfts.mint` into a collection that does not exist: `{"code":-32000,"message":"Failed to dispatch call: Module(ModuleError { index: 47, error: [32, 0, 0, 0], message: Some(\"NoConfig\") })"}`. Module 47 is Nfts, and error 32 of that module is `NoConfig`. The tables write it as `Nfts.NoConfig (47/32)`. Other refusals name a kind of dispatch error, such as `Failed to dispatch call: Token(BelowMinimum)` or `Failed to dispatch call: BadOrigin`.
- A call that is not refused answers a gas estimate, for example `0xcb0da02522` for `System.remarkWithEvent`. The tables write "accepted".
- Most cases were dry-run twice, some minutes apart, and gave the same reply both times. Some were dry-run once only.

The limits of a dry run:

- A dry run is not a sent transaction. A sent transaction may still fail where a dry run passed, for example on the fee: a dry run does not check that the sender can pay the fee (E29). `TransactionStorage.store` and `renew` go the other way: every dry run of a valid call answered `TransactionStorage.BadContext`, and the same calls sent succeeded (E53).
- `Utility.batch`, `Utility.forceBatch`, `Proxy.proxy`, `Sudo.sudo` and `Sudo.sudoAs` report success when the call inside them fails. The same is expected, but not measured, for `Proxy.proxyAnnounced`, `Utility.dispatchAs`, `Sudo.sudoUncheckedWeight` and the approval of `Multisig.asMulti` that executes the call (E9). A dry run shows no events, so the inner result cannot be seen. Sent, such a call succeeds too: through a proxy whose type did not cover the call, the transaction succeeded and only its `Proxy.ProxyExecuted` event held the error (block 477948, E38). `Utility.batchAll` shows the inner error: with a root-only call inside, it answered `BadOrigin`.
- A new multisig operation gets the timepoint `{ height: the best block, index: 0 }` in a dry run. An approval built with that timepoint answered `Multisig.AlreadyApproved` at one block and `Multisig.WrongTimepoint` at a later block.
- State moves between blocks. A `Balances.transferKeepAlive` that would have left the Treasury below the existential deposit answered `Token(NotExpendable)`, and the same bytes were accepted 64 blocks later, after the Treasury's balance had risen. Dry-run again just before you send.

## Balances

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Balances.transferKeepAlive` | More than the sender holds: 10,000,000 tPOT from the Treasury, or 1 tPOT from a new, empty account (sent: twice the free balance failed in block 477796, and 10,000 tPOT through the pallets address was mined with status 0 in block 477826; both paid their fee) | Token(FundsUnavailable) | Send no more than the free balance, less the fee and the 0.1 tPOT existential deposit. |
| `Balances.transferKeepAlive` | An amount that would leave the sender 0.05 tPOT, below the 0.1 tPOT existential deposit | Token(NotExpendable) | Leave at least 0.1 tPOT on the sender. |
| `Balances.transferKeepAlive` | More than free - max(frozen - reserved, 0.1 tPOT) from an account with a vesting lock, a freeze, a hold (staking, contract code deposit), a reserve or an asset, even with nothing frozen: one base unit more on six such accounts, or the whole free balance (0.1 tPOT) of an account that held an asset | Token(Frozen) | Send at most free - max(frozen - reserved, 0.1 tPOT), and keep the fee on top, since a dry run does not charge it. |
| `Balances.transferKeepAlive` | The free balance less 0.1 tPOT, from an account whose vesting schedule has ended while its vesting lock (10 tPOT, and 9.7 tPOT on a second account) is still in `balances.locks` | Token(Frozen) | Send `Vesting.vest` first, or a `Utility.batchAll` of `Vesting.vest` and the transfer, because the lock stays until vest is called. |
| `Balances.transferKeepAlive` | One base unit above the free balance less 0.1 tPOT, from a nomination pool member (its stake held by DelegatedStaking, `providers` 2) | Token(NotExpendable) | Leave 0.1 tPOT on the sender. |
| `Balances.transferKeepAlive` | A `dest` of the MultiAddress kind `Address20` (what @polkadot/api makes of a 20-byte `0x` string) or `Address32` | CannotLookup | Pass the native account as `{ Id: ... }` or as its SS58 string, for a `0x` address the account that `convert_address` names (E4). |
| `Balances.transferKeepAlive` | 1 tPOT to the account id that @polkadot/util-crypto `evmToAddress` makes of a `0x` address (another chain's rule) | accepted | Convert with `convert_address` or `reviveApi.accountId(0x...)`, because the chain accepts a payment to any 32-byte account id. |
| `Balances.transferKeepAlive` | 0.01 tPOT to an account that does not exist yet | Token(BelowMinimum) | Send at least 0.1 tPOT, the existential deposit, to a new account. |
| `Balances.transferAllowDeath` | 0.01 tPOT to an account that does not exist yet | Token(BelowMinimum) | Send at least 0.1 tPOT, the existential deposit, to a new account. |
| `Balances.transferAllowDeath` | An amount that leaves the sender 0.05 tPOT, below the existential deposit, from the Treasury | accepted | Use `Balances.transferKeepAlive`, which refuses this, because an account below 0.1 tPOT is removed and the rest is lost (E17). |
| `Balances.transferAllowDeath` | One base unit above free - max(frozen - reserved, 0.1 tPOT), or the whole free balance, from an account with a lock, freeze, hold or reserve and `providers` 1 | Token(Frozen) | Expect the same limit as for `Balances.transferKeepAlive`, because on such an account this call does not take the sender below 0.1 tPOT either. |
| `Balances.transferAllowDeath` | The whole free balance of a nomination pool member (`providers` 2) | accepted | Keep tPOT for later fees yourself, because the call leaves the member no free tPOT. |
| `Balances.transferKeepAlive` | A payment of 0 to an account that does not exist yet, or from one (dry run only: sent from an empty account, it fails on the fee) | accepted | Refuse an amount of 0 in your own code: the call itself does not refuse it. |
| `Balances.transferKeepAlive` | 1 tPOT to the sender itself | accepted | Check the recipient in your own code, because the chain does not refuse a payment to oneself. |
| `Balances.transferAll` | From an empty account (dry run only: sent, it fails on the fee) | accepted | Read the balance first: the call itself does not refuse a transfer of an empty balance. |
| `Balances.burn` | More than the balance | Token(FundsUnavailable) | Burn no more than the free balance less 0.1 tPOT when `keepAlive` is true. |
| `Balances.forceTransfer` | From a signed account | BadOrigin | Do not call it from an account: it needs the root origin. |
| `Balances.forceSetBalance` | From a signed account | BadOrigin | Do not call it from an account: it needs the root origin. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form, from the address of a new, empty key, and from the `0x` forms of the seven accounts with locked, frozen, held or reserved tPOT. The rows that name a block were sent from our own test accounts.

## Assets

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Assets.transfer` | An asset id that does not exist | Assets.Unknown (39/3) | Check the id with `assets.asset(id)` first. |
| `Assets.transfer` | From an account that never held the asset | Assets.NoAccount (39/1) | Check `assets.account(id, sender)` before you send. |
| `Assets.transfer` | More units than the sender holds | Assets.BalanceLow (39/0) | Send no more than the balance in `assets.account(id, sender)`. |
| `Assets.transfer` | Less than the asset's minimum balance to an account that holds none of it: 1 unit of asset 7777, whose minimum was 10000 | Token(BelowMinimum) | Send a new holder at least the `minBalance` shown in `assets.asset(id)`. |
| `Assets.transfer` | Units of an asset that is not sufficient (asset 7777) to an account with no tPOT | Token(CannotCreate) | Send the recipient at least 0.1 tPOT first (a `Utility.batchAll` of that payment and then the same transfer was accepted in a dry run), and 0.1 tPOT more, plus the fee when it sends the approval itself, if it will approve the token at its ERC-20 address (E41). |
| `Assets.transfer` | An asset whose status is `Frozen` (asset 4503 on Nov 15, 2026) | Assets.AssetNotLive (39/16) | Check that `assets.asset(id).status` is `Live` before you send. |
| `Assets.mint` | Without the issuer role, an amount at the asset's minimum | Assets.NoPermission (39/2) | Mint from the issuer named in `assets.asset(id)`. |
| `Assets.mint` | Without the issuer role, an amount below the asset's minimum, to an account that holds none | Token(BelowMinimum) | Mint at least `minBalance`, from the issuer: the minimum is checked before the role. |
| `Assets.burn` | Without the admin role | Assets.NoPermission (39/2) | Burn from the admin named in `assets.asset(id)`. |
| `Assets.freeze` | Without the freezer role | Assets.NoPermission (39/2) | Freeze from the freezer named in `assets.asset(id)`. |
| `Assets.setMetadata` | By an account that does not own the asset | Assets.NoPermission (39/2) | Set the metadata from the asset's owner. |
| `Assets.create` | An asset id that is taken (7777) | Assets.InUse (39/5) | Choose an id for which `assets.asset(id)` is empty. |
| `Assets.create` | A minimum balance of 0 | Assets.MinBalanceZero (39/7) | Give a `minBalance` of at least 1. |
| `Assets.create` | From an empty account, which cannot pay the asset deposit | Balances.InsufficientBalance (6/2) | Fund the sender with the deposit (`assets.assetDeposit`, 1 tPOT) plus the fee. |
| `Assets.touch` | From an empty account, which cannot pay the deposit | Balances.InsufficientBalance (6/2) | Fund the sender with the deposit (`assets.assetAccountDeposit`, 1 tPOT) plus the fee. |
| `Assets.transferApproved` | No approval from the owner | Assets.Unapproved (39/10) | The owner calls `Assets.approveTransfer` first. |
| `Assets.cancelApproval` | An approval that does not exist, of an asset that does (asset 7777) | Assets.Unknown (39/3) | Check `assets.approvals(id, owner, delegate)` first: here Unknown means that there is no such approval. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form, from the `0x` form of a holder of asset 7777, from the `0x` form of the owner of asset 4503 and from the address of a new, empty key. The deposits, the status of asset 4503 and the missing approval were read from the chain on the same day.

## Nfts

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Nfts.mint` | Into a collection that does not exist | Nfts.NoConfig (47/32) | Check `nfts.collection(id)` first: from `Nfts.mint`, NoConfig means that the collection is not there. |
| `Nfts.mint` | Into a collection whose mint type is Issuer (collection 25), by an account that is not its issuer | Nfts.NoPermission (47/0) | Mint from the collection's issuer, as `nfts.collectionRoleOf` lists it. |
| `Nfts.mint` | An item id that is already used, by the issuer | Nfts.AlreadyExists (47/2) | Pick an item id for which `nfts.item(collection, item)` is empty. |
| `Nfts.transfer` | In a collection that does not exist | Nfts.UnknownCollection (47/1) | Check the collection id with `nfts.collection(id)` first. |
| `Nfts.transfer` | An item that does not exist, in a collection that does | Nfts.UnknownItem (47/20) | Check `nfts.item(collection, item)` first. |
| `Nfts.transfer` | An item the sender does not own | Nfts.NoPermission (47/0) | Send it from the item's owner, as `nfts.item(collection, item)` shows. |
| `Nfts.burn` | An item the sender does not own | Nfts.NoPermission (47/0) | Burn it from the item's owner, as `nfts.item(collection, item)` shows. |
| `Nfts.create` | From an empty account, which cannot pay the collection deposit | Balances.InsufficientBalance (6/2) | Fund the sender with the deposit (`nfts.collectionDeposit`) plus the fee. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form, from the `0x` form of the owner of collection 25 and from the address of a new, empty key.

## Uniques

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Uniques.mint` | Into a class that does not exist (the testnet had no Uniques classes on Nov 15, 2026) | Uniques.UnknownCollection (46/1) | Create the class first, or use Nfts, which holds the testnet's collections. |
| `Uniques.transfer` | An item of a class that does not exist | Uniques.UnknownCollection (46/1) | Check the class with `uniques.class(id)` first. |
| `Uniques.mint` | By the class's creator, when `Uniques.create` named another account as admin | Uniques.NoPermission (46/0) | Mint from the account named as admin in `Uniques.create`. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form. The last row created the class and minted in one `Utility.batchAll`.

## AssetConversion

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `AssetConversion.swapExactTokensForTokens` | A pair that has no pool (tPOT and asset 2 on Nov 15, 2026) | AssetConversion.PoolEmpty (65/23) | Check `assetConversion.pools([asset1, asset2])` first: PoolEmpty also comes when there is no pool at all. |
| `AssetConversion.swapExactTokensForTokens` | An amount of 0 | AssetConversion.ZeroAmount (65/16) | Swap an amount above 0. |
| `AssetConversion.swapExactTokensForTokens` | A minimum out that the pool cannot pay | AssetConversion.ProvidedMinimumNotSufficientForSwap (65/17) | Quote first with `assetConversionApi.quotePriceExactTokensForTokens`, and set the minimum a little below the quote. |
| `AssetConversion.swapExactTokensForTokens` | A path of one asset | AssetConversion.InvalidPath (65/19) | Give a path of at least two assets. |
| `AssetConversion.swapExactTokensForTokens` | From an empty account, with `keepAlive` true | Token(NotExpendable) | Fund the sender first. |
| `AssetConversion.swapExactTokensForTokens` | From an empty account, with `keepAlive` false | Token(FundsUnavailable) | Fund the sender first. |
| `AssetConversion.createPool` | The same asset twice (tPOT and tPOT) | AssetConversion.InvalidAssetPair (65/0) | Give two different assets. |
| `AssetConversion.createPool` | A pair that already has a pool (tPOT and asset 7777) | AssetConversion.PoolExists (65/1) | Add to the existing pool with `AssetConversion.addLiquidity`. |
| `AssetConversion.createPool` | An asset that does not exist | Assets.Unknown (39/3) | Check both assets with `assets.asset(id)` first: this reply comes from the Assets module. |
| `AssetConversion.addLiquidity` | Desired amounts of 0 | AssetConversion.WrongDesiredAmount (65/2) | Give desired amounts above 0 for both assets. |
| `AssetConversion.removeLiquidity` | LP tokens the sender does not hold: 100000 or 10000000 units of LP token 1, from an account with none | Token(FundsUnavailable) | Read your LP balance in `poolAssets.account(lpToken, account)` and burn no more than it. |
| `AssetConversion.removeLiquidity` | More LP units than the whole supply: 10^14 units of LP token 1, whose supply was 1.5 x 10^12 | AssetConversion.ReserveLeftLessThanMinimal (65/5) | Burn fewer LP units: each reserve left in the pool must stay at or above its minimum (0.1 tPOT for tPOT, `minBalance` in `assets.asset(id)` for an asset), so a burn above the LP supply always fails and a burn of nearly all of it can fail too. |
| `AssetConversion.removeLiquidity` | Too few LP units: 1000 units of LP token 1, worth less than 1 unit of asset 7777, with minimums of 0 | AssetConversion.AssetTwoWithdrawalDidNotMeetMinimum (65/12) | Burn enough LP units that each asset's share (units x reserve / LP supply) is at least 1. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form, from the `0x` forms of the pool's own account and of a liquidity provider of the tPOT and asset 7777 pool, and from the addresses of new, empty keys. LP token 1 belongs to that pool. The pools, the LP holdings, the LP supply and the reserves (177.5 tPOT and 126,827,790 units of asset 7777) were read from the chain on the same day. A swap we sent later that day, with a minimum out of 90 percent of the quote, received exactly what `quotePriceExactTokensForTokens` had quoted: 708367 units of asset 7777 for 1 tPOT (block 478194).

## Multisig

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Multisig.asMulti` | A threshold of 1 | Multisig.MinimumThreshold (36/0) | Use a threshold of 2 or more, or `Multisig.asMultiThreshold1` for a threshold of 1. |
| `Multisig.asMulti` | Other signatories not sorted by account id | Multisig.SignatoriesOutOfOrder (36/5) | Sort the other signatories by their 32-byte account id. |
| `Multisig.asMulti` | The sender among the other signatories | Multisig.SenderInSignatories (36/6) | Leave the sender out of the other signatories. |
| `Multisig.asMultiThreshold1` | The sender among the other signatories | Multisig.SenderInSignatories (36/6) | Leave the sender out of the other signatories. |
| `Multisig.asMulti` | 101 signatories in all (the sender and 100 others), above the maximum of 100 | Multisig.TooManySignatories (36/4) | Keep the sender and the other signatories at 100 or fewer (`multisig.maxSignatories`). |
| `Multisig.asMulti` | A timepoint given when opening a new operation | Multisig.UnexpectedTimepoint (36/11) | Pass `null` as `maybeTimepoint` for the first approval. |
| `Multisig.asMulti` | Approving an open operation without its timepoint | Multisig.NoTimepoint (36/9) | Pass the timepoint of the opening, from `multisig.multisigs(account, callHash).when`. |
| `Multisig.asMulti` | Approving with a timepoint that is not the opening one: height 1, the next block, or the height of an older dry run | Multisig.WrongTimepoint (36/10) | Read the timepoint from `multisig.multisigs(account, callHash).when` just before you approve. |
| `Multisig.asMulti` | The same signatory approving twice, with the right timepoint | Multisig.AlreadyApproved (36/1) | Another signatory must give the next approval. |
| `Multisig.cancelAsMulti` | An operation that does not exist | Multisig.NotFound (36/7) | Check `multisig.multisigs(account, callHash)` first. |
| `Multisig.asMulti` | From an empty account, which cannot reserve the deposit | Balances.InsufficientBalance (6/2) | Fund the opener with the deposit, 5.43 + 1.92 x threshold tPOT (9.27 tPOT for a threshold of 2), plus the fee. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form and from the address of a new, empty key. The approvals were dry-run in one `Utility.batchAll` with the opening. The deposit constants and the maximum of 100 were read from the chain on the same day.

## Proxy

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Proxy.proxy` | For an account that has no proxy relation with the sender | Proxy.NotProxy (35/2) | Check that `proxy.proxies(real)` lists the sender first. |
| `Proxy.proxy` | A `forceProxyType` that the relation does not have: Staking where it is Any, or Any where it is NonTransfer (sent: failed in block 477950 and paid its fee) | Proxy.NotProxy (35/2) | Pass `null` as `forceProxyType`, or the relation's exact type. |
| `Proxy.proxy` | By a delegate whose relation has a delay of 10 blocks, without an announcement | Proxy.Unannounced (35/6) | Call `Proxy.announce`, wait for the delay, then call `Proxy.proxyAnnounced`. |
| `Proxy.proxy` | A call inside that fails (a root-only call) | accepted | Dry-run the inner call from the `0x` form of the real account, because a dry run of `Proxy.proxy` does not show the inner result. |
| `Proxy.proxy` | A call that the proxy's type does not cover: `Balances.transferKeepAlive` of 0.01 tPOT through a NonTransfer proxy (sent: succeeded in block 477948, and the 0.01 tPOT did not move) | accepted | Read the result in `Proxy.ProxyExecuted` after you send, because it holds `System.CallFiltered` while the transaction itself succeeds (E38). |
| `Proxy.addProxy` | A delegate that is already a proxy, with the same type and delay | Proxy.Duplicate (35/4) | Read `proxy.proxies(account)` before you add one. |
| `Proxy.addProxy` | The sender as its own delegate | Proxy.NoSelfProxy (35/7) | Name another account as the delegate. |
| `Proxy.removeProxy` | A relation that does not exist | Proxy.NotFound (35/1) | Give the exact delegate, type and delay that `proxy.proxies(account)` lists. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form and from the `0x` forms of an account with proxies and of two of its delegates. The rows that name a block were sent from our own test accounts: a NonTransfer proxy added in block 477947 (2.61 tPOT reserved as its deposit), used in blocks 477948 and 477950, and removed in block 477951 (the deposit returned).

## Utility

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Utility.batch` | A call inside that fails (a root-only call after a remark) | accepted | Use `Utility.batchAll`, which shows the inner error, or dry-run each call on its own. |
| `Utility.forceBatch` | A call inside that fails (a root-only call after a remark) | accepted | Use `Utility.batchAll`, which shows the inner error, or dry-run each call on its own. |
| `Utility.batchAll` | A call inside that fails (a root-only call after a remark) | BadOrigin | Fix the inner call: the reply is that call's own error. |
| `Utility.batch` | 10923 calls, one above `utility.batchedCallsLimit` (10922) | Utility.TooManyCalls (1/0) | Split the work into batches of at most 10922 calls. |
| `Utility.dispatchAs` | The Root origin, from a signed account | BadOrigin | Do not call it from an account: it needs the root origin. |
| `Utility.withWeight` | From a signed account | BadOrigin | Do not call it from an account: it needs the root origin. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form.

## Staking

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Staking.bond` | More than the free balance: 1,000,000 tPOT from an account with about 156,432 tPOT free | accepted | Bond only what you mean to lock, because the bond takes the whole free balance. |
| `Staking.bond` | 1 tPOT from an empty account | accepted | Check the free balance before you bond: the call itself does not refuse a bond above it (sent from an empty account, it fails on the fee). |
| `Staking.bond` | tPOT that is under a vesting lock: 25 tPOT from an account with 25.61 tPOT free, 10 of it locked by vesting | accepted | Expect the bond to overlap the vesting lock, so that the free balance less the bond and 0.1 tPOT stays spendable. |
| `Staking.bond` | A value of 0 | Staking.InsufficientBond (11/7) | Bond at least 0.1 tPOT, the existential deposit, because the chain refuses a smaller bond with this error. |
| `Staking.bond` | From a stash that is already bonded (a validator's) | Staking.AlreadyBonded (11/2) | Add to an existing bond with `Staking.bondExtra`. |
| `Staking.bondExtra` | More than the free balance: the free balance + 1 tPOT, from a stash | accepted | Pass the exact amount to add, because the call does not refuse a larger one and bonds nearly the whole free balance. |
| `Staking.bondExtra` | From an account that has no staking bond: one with only a vesting lock, or a nomination pool member | Staking.NotStash (11/1) | Call `Staking.bond` first, or `NominationPools.bondExtra` as a pool member. |
| `Staking.nominate` | Without a bond | Staking.NotController (11/0) | Call `Staking.bond` first. |
| `Staking.nominate` | A target that is not a validator, after a bond in the same `Utility.batchAll` | accepted | Check that each target is in `staking.validators`, because the chain does not refuse other accounts. |
| `Staking.unbond` | Without a bond | Staking.NotController (11/0) | Call `Staking.bond` first: without a bond there is nothing to unbond. |
| `Staking.payoutStakers` | Era 0, older than the 84 eras kept (the current era was 133 on Nov 15, 2026) | Staking.InvalidEraToReward (11/11) | Claim only eras within `staking.historyDepth` (84) of the current era. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form, from a validator's `0x` form, from the address of a new, empty key, and from the `0x` forms of a stash, a pool member and two accounts with a vesting lock. The current era and `staking.historyDepth` were read from the chain on the same day.

## NominationPools

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `NominationPools.join` | A pool that does not exist (999; only pool 1 existed on Nov 15, 2026) | NominationPools.PoolNotFound (62/0) | Read `nominationPools.bondedPools` for the pool ids. |
| `NominationPools.join` | 1 base unit, below `nominationPools.minJoinBond` (1 tPOT) | NominationPools.MinimumBondNotMet (62/8) | Join with at least `nominationPools.minJoinBond`. |
| `NominationPools.join` | 1 tPOT from an empty account | Token(FundsUnavailable) | Fund the sender with the amount plus the fee first. |
| `NominationPools.join` | By an account that is already a member | NominationPools.AccountBelongsToOtherPool (62/4) | Add to an existing membership with `NominationPools.bondExtra`. |
| `NominationPools.bondExtra` | `FreeBalance` of more than the free balance (the free balance + 1 tPOT), by a member | Token(FundsUnavailable) | Give at most the free balance, because unlike `Staking.bondExtra` this call refuses a larger amount. |
| `NominationPools.create` | 1 tPOT, below `nominationPools.minCreateBond` (10 tPOT) | NominationPools.MinimumBondNotMet (62/8) | Create with at least `nominationPools.minCreateBond`. |
| `NominationPools.claimPayout` | By an account that is not a member | NominationPools.PoolMemberNotFound (62/1) | Check `nominationPools.poolMembers(account)` first. |
| `NominationPools.claimPayout` | Nothing to claim, by a member | accepted | Read `nominationPoolsApi.pendingRewards(account)` first, because the chain does not refuse an empty claim. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form, from the `0x` addresses of two pool members and from the address of a new, empty key. The pool ids and the two minimums were read from the chain on the same day.

## Identity

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Identity.clearIdentity` | No identity set | Identity.NoIdentity (28/5) | Check `identity.identityOf(account)` first. |
| `Identity.setSubs` | No identity set | Identity.NotFound (28/1) | Call `Identity.setIdentity` first. |
| `Identity.requestJudgement` | A chain with no registrars (`identity.registrars` was empty on Nov 15, 2026) | Identity.EmptyIndex (28/3) | Read `identity.registrars` first: with none, no judgement can be requested. |
| `Identity.setIdentity` | From an empty account, which cannot pay the deposit | Balances.InsufficientBalance (6/2) | Fund the sender with the identity deposit plus the fee. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form, from the `0x` form of an account with an identity and from the address of a new, empty key.

## Vesting

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Vesting.vest` | No vesting schedule | Vesting.NotVesting (31/0) | Check `vesting.vesting(account)` first. |
| `Vesting.vestedTransfer` | A locked amount of 1 base unit | Vesting.AmountLow (31/2) | Lock at least `vesting.minVestedTransfer`. |
| `Vesting.vestedTransfer` | A `perBlock` of 0 | Vesting.InvalidScheduleParams (31/4) | Give a `perBlock` above 0. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form. What `Vesting.vest` releases is in the Balances rows above.

## Preimage

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Preimage.unnotePreimage` | A hash that was never noted | Preimage.NotNoted (34/3) | Check `preimage.requestStatusFor(hash)` first. |
| `Preimage.notePreimage` | From an empty account | Token(FundsUnavailable) | Fund the sender with the deposit plus the fee first. |
| `Preimage.requestPreimage` | From a signed account | BadOrigin | Do not call it from an account: a signed account is refused. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form and from the address of a new, empty key.

## Scheduler

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Scheduler.scheduleAfter` | From a signed account | BadOrigin | Do not plan on the Scheduler: it refuses a signed account. |
| `Scheduler.cancel` | From a signed account | BadOrigin | Do not plan on the Scheduler: it refuses a signed account. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form.

## Sudo

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Sudo.sudo` | From an account that is not the sudo key | Sudo.RequireSudo (22/0) | Only the account in `sudo.key` can call it. |
| `Sudo.setKey` | From an account that is not the sudo key | Sudo.RequireSudo (22/0) | Only the account in `sudo.key` can call it. |
| `Sudo.sudo` | A call inside that needs a signed origin (`Balances.transferKeepAlive`), dry-run as the sudo key | accepted | Do not read a dry run of `Sudo.sudo` as a check of the inner call. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form and from the sudo key's `0x` form.

## Treasury

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Treasury.payout` | A spend index that does not exist | Treasury.InvalidIndex (19/0) | Read `treasury.spends` for the valid indices. |
| `Treasury.spendLocal` | From a signed account | BadOrigin | Do not call it from an account: a signed account is refused. |
| `Treasury.removeApproval` | From a signed account | BadOrigin | Do not call it from an account: a signed account is refused. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form.

## TransactionStorage

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `TransactionStorage.store` | A valid store of 1 or 4096 bytes, dry-run (sent: a store of 16 bytes succeeded in block 478138) | TransactionStorage.BadContext (51/0) | Do not read this as a fault of the call, because store runs only inside a block: check the size yourself and take the fee from `TransactionPaymentCallApi_query_call_info` (E53). |
| `TransactionStorage.store` | 0 bytes | TransactionStorage.BadDataSize (51/1) | Store at least 1 byte and at most `transactionStorage.maxTransactionSize` (8388608 bytes). |
| `TransactionStorage.renew` | A valid renew of an entry that exists (block 468666, index 0), dry-run (sent: a renew succeeded in block 478139) | TransactionStorage.BadContext (51/0) | Do not read this as a fault of the call, because renew runs only inside a block: check the entry in `transactionStorage.transactions(block)` yourself (E53). |
| `TransactionStorage.renew` | A block and index that hold nothing (sent: failed in block 478141 and paid its fee), block 1, or an entry past the retention period of 100800 blocks (block 279419) | TransactionStorage.RenewedNotFound (51/4) | Renew with the block and index of the data's latest `Stored` or `Renewed` event, before its retention period ends. |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form, at blocks 477907 to 478178. The rows that name a block were sent from our own test account. The entries and the retention period were read from the chain on the same day.

## System

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `System.setCode` | From a signed account | BadOrigin | Do not call it from an account: it needs the root origin. |
| `System.remarkWithEvent` | From an empty account | accepted | Check that the sender can pay the fee, because a dry run does not (E29). |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form and from the address of a new, empty key.

## Revive

| Call | Mistake | Reply | What to do |
|---|---|---|---|
| `Revive.call` | A storage deposit limit of 0 for `approve()`, which writes a new storage slot | Revive.StorageDepositLimitExhausted (80/24) | Set the limit to the dry run's `maxStorageDeposit` plus 2% (E7). |
| `Revive.call` | A value above the balance, from a funded account (1,000,000 tPOT from the Treasury) | Revive.TransferFailed (80/4) | Keep the value, the deposit, the fee and 0.1 tPOT within the free balance. |
| `Revive.call` | A value one base unit above free - max(frozen - reserved, 0.1 tPOT), from an account with a lock, freeze, hold or reserve whose balance covers the value | Revive.TransferFailed (80/4) | Keep the value within free - max(frozen - reserved, 0.1 tPOT), because this reply comes for locked or held tPOT as well as for a lack of funds. |
| `Revive.call` | A value of 1 tPOT from an empty account | Revive.StorageDepositNotEnoughFunds (80/23) | Fund the sender first: from an empty account this error does not point to the value, because a deployment with a value of 0 gave it too. |
| `Revive.call` | A weight limit of `{ refTime: 1, proofSize: 1 }` | Revive.OutOfGas (80/3) | Take the weight limit from a dry run (`simulate_contract_call`). |
| `Revive.call` | To an address with no code, with a value of 0 | accepted | Check with `eth_getCode` that code is there before you call it. |
| `Revive.instantiateWithCode` | A storage deposit limit of 0 | Revive.StorageDepositLimitExhausted (80/24) | Set the limit to the dry run's `maxStorageDeposit` plus 2% (E7). |
| `Revive.instantiateWithCode` | From an empty account | Revive.StorageDepositNotEnoughFunds (80/23) | Fund the sender with the deposit first, which `simulate_contract_deploy` shows. |
| `Revive.instantiateWithCode` | Bytes that start with the PolkaVM mark `PVM\0` and then garbage | Revive.CodeRejected (80/27) | Pass the compiler's output exactly. |
| `Revive.instantiateWithCode` | Init code with a byte that is no opcode (`0xdeadbeef`), or the INVALID opcode `0xfe` | Revive.InvalidInstruction (80/31) | Pass the compiler's bytecode exactly, built for cancun without blob opcodes (E31). |
| `Revive.uploadCode` | Bytes that start with the PolkaVM mark `PVM\0` and then garbage | Revive.CodeRejected (80/27) | Pass the compiler's output exactly. |
| `Revive.uploadCode` | EVM bytes that fail when they run (`0xfe`, the INVALID opcode) | accepted | Check EVM code with a dry run of the deployment (`simulate_contract_deploy`), because the upload accepted code that fails when it runs. |
| `Revive.removeCode` | A code hash that does not exist | Revive.CodeNotFound (80/7) | Check the hash with `revive.codeInfoOf(hash)` first. |
| `Revive.mapAccount` | From an account that is mapped already, or from a `0x` account with no native account | accepted | Leave it out: the chain's text calls it a no-op while auto-mapping is on (E8). |
| `Revive.unmapAccount` | By an account that is mapped (the Treasury) | Revive.AutoMappingEnabled (80/66) | Do not call it: mapping is automatic on V3 (E8). |

Checked on Nov 15, 2026: dry runs through the pallets address from the Treasury's `0x` form, from the addresses of new, empty keys and from the `0x` forms of the seven accounts of the Balances rows.

## Replies whose name misleads

- `Nfts.NoConfig (47/32)`, "Config for a collection or an item can't be found", came from `Nfts.mint` into a collection that does not exist (`nfts.collection(999999)` read as empty). In the same case `Nfts.transfer` answers `Nfts.UnknownCollection (47/1)`.
- `AssetConversion.PoolEmpty (65/23)`, "The pool exists but has no liquidity (at least one of the reserves is zero)", came from a swap on a pair that has no pool at all: `assetConversion.pools([Native, WithId(2)])` read as empty. No swap of ours got `AssetConversion.PoolNotFound`.
- `Assets.Unknown (39/3)`, "The given asset ID is unknown", came in two more cases:
  - from `Assets.cancelApproval` of an approval that does not exist, for asset 7777, which exists (`assets.approvals` read as empty for that owner and delegate);
  - from `AssetConversion.createPool` with an asset that does not exist. The error belongs to the Assets module (39), not to AssetConversion (65).
- `AssetConversion.removeLiquidity` answered two errors that say nothing about the sender's LP holding. In both, the amount was the cause:
  - `AssetConversion.ReserveLeftLessThanMinimal (65/5)` came for 10^14 LP units, more than the whole supply of 1.5 x 10^12. It came from an account with no LP tokens and from the pool's own account, which held 1,000,000 units.
  - `AssetConversion.AssetTwoWithdrawalDidNotMeetMinimum (65/12)` came for 1000 LP units with minimums of 0, from an account with no LP tokens and from two accounts that held LP tokens. With reserves of 126,827,790 units of asset 7777 against an LP supply of 1.5 x 10^12, 1000 LP units are worth about 0.08 units of asset 7777. A burn of 100000 units by the pool's account and one of 10000000 units by the liquidity provider were accepted.
  - An account with no LP tokens that burns an amount of that size gets `Token(FundsUnavailable)` instead.
- `Token(NotExpendable)` came from a swap with `keepAlive` true from an empty account, which has nothing to keep. With `keepAlive` false the same swap answered `Token(FundsUnavailable)`. Both mean: fund the sender.
- `Token(Frozen)` comes with nothing frozen. It answered every transfer of one base unit more than free - max(frozen - reserved, 0.1 tPOT) from accounts with a staking hold, a contract code deposit hold or a reserve, as from those with a vesting lock or a freeze, through `transferKeepAlive` and `transferAllowDeath` alike (a nomination pool member, with `providers` 2, got `Token(NotExpendable)` instead); and a `transferKeepAlive` of the whole free balance (0.1 tPOT, nothing frozen) of an account that held an asset. Read it as "this would spend tPOT that is locked, held or reserved, or the last 0.1 tPOT" (E47). On these seven accounts `eth_getBalance` / 10^4, dust left out, equalled that limit.
- `Revive.TransferFailed (80/4)`, "Performing the requested transfer failed. Probably because there isn't enough free balance in the sender's account", came for a value one base unit above that same limit, from accounts whose balance covered the value. It also comes for a value above the whole balance, so it does not tell a lock from a lack of funds.
- `TransactionStorage.BadContext (51/0)`, "Attempted to call `store`/`renew` outside of block execution", answered every dry run of a valid `store` or `renew`. Sent, the same calls succeeded (blocks 478138 and 478139). It does not mean that the call is wrong (E53).
- `Token(BelowMinimum)` came from `Assets.mint` by an account without the issuer role, when the amount was below the asset's minimum: the minimum is checked first, so the missing role does not show. At the minimum, the same call answered `Assets.NoPermission (39/2)`.
- `Balances.InsufficientBalance (6/2)`, "Balance too low to send value", came from calls that send nothing: `Assets.create`, `Assets.touch`, `Nfts.create`, `Multisig.asMulti` and `Identity.setIdentity` from an empty account. The deposit is what cannot be paid. `Preimage.notePreimage`, which also takes a deposit, answered `Token(FundsUnavailable)` instead, as transfers do.
- The name is right but the text is not: `Nfts.UnknownCollection (47/1)` and `Uniques.UnknownCollection (46/1)` both say "The given item ID is unknown". It was the collection that did not exist.

Checked on Nov 15, 2026: the dry runs of the tables above and of the `Token(Frozen)` case, the sent transactions of blocks 478138 and 478139, and reads of `nfts.collection`, `assetConversion.pools`, `assets.approvals`, `poolAssets.account`, the pool's reserves, `system.account` of the senders and `eth_getBalance` of the seven accounts on the same day.

## Accepted, although it looks like a mistake

- A bond above the balance. `Staking.bond` of 1,000,000 tPOT from the Treasury, which had about 156,432 tPOT free, was accepted. The bond takes what is free: a `Utility.batchAll` of that bond and a 1 tPOT `Balances.transferKeepAlive` was refused with `Token(FundsUnavailable)`, and the same batch with a bond of 10 tPOT was accepted. So an oversized bond holds the whole free balance, and a payment after it is refused. Unbonding takes 672 eras, about 168 days (`native-modules.md`). Bond only what you mean to stake. A bond of 1 tPOT from an empty account was accepted too.
- An extra bond above the balance. `Staking.bondExtra` of the free balance + 1 tPOT from a stash was accepted; after it, in the same `Utility.batchAll`, a 1 tPOT `Balances.transferKeepAlive` answered `Token(FundsUnavailable)` and a 1 base unit `Balances.transferAllowDeath` answered `Token(Frozen)`, so at most 0.1 tPOT stayed free. `NominationPools.bondExtra` refuses such an amount instead.
- A bond of tPOT under a vesting lock. From an account with 25.61 tPOT free, 10 of it locked by vesting, a `Utility.batchAll` of `Staking.bond` of 25 tPOT and a transfer of the free balance less 25.1 tPOT was accepted, and one base unit more answered `Token(Frozen)`: the bond used the locked tPOT. A second vesting account gave the same with a bond of 30 tPOT.
- A transfer that leaves less than the existential deposit. `Balances.transferAllowDeath` that left the Treasury 0.05 tPOT was accepted, while `Balances.transferKeepAlive` of the same amount answered `Token(NotExpendable)`. By the chain's own text for the two calls, the account would be removed and the rest lost (E17). Use `transferKeepAlive`. From an account with a lock, freeze, hold or reserve and `providers` 1, `transferAllowDeath` stopped at the same limit as `transferKeepAlive`, with `Token(Frozen)`; a pool member, with `providers` 2, could send its whole free balance with it.
- Payments of 0. `Balances.transferKeepAlive` of 0 was accepted from an account that does not exist (in a dry run: sent from an account that does not exist, it fails on the fee, E29), and to one that does not exist, while 0.01 tPOT to that same new account answered `Token(BelowMinimum)`. `Balances.transferAll` from an empty account was accepted too. Check the amount in your own code.
- A payment to an id made by a wrong conversion rule. `Balances.transferKeepAlive` of 1 tPOT to the id that @polkadot/util-crypto `evmToAddress` makes of a `0x` address was accepted: the chain cannot know that nobody holds that account's key. Convert with `convert_address` (E4).
- `Revive.call` with a value of 0 to an address with no code was accepted. A direct `eth_call` to such an address does not fail either: it returns `0x` (E26). Check with `eth_getCode` first.
- `Revive.mapAccount` was accepted from the Treasury, which is mapped already, and from the address of a new key with no native account. The chain's text calls it a no-op while auto-mapping is on (E8), and `Revive.unmapAccount` is refused with `Revive.AutoMappingEnabled (80/66)`. Leave the step out.
- `Revive.uploadCode` accepted the single EVM byte `0xfe`, which `Revive.instantiateWithCode` refuses with `Revive.InvalidInstruction (80/31)`.
- `Utility.batch`, `Utility.forceBatch`, `Proxy.proxy`, `Sudo.sudo` and `Sudo.sudoAs` were accepted with a failing call inside (see the limits above). A `Proxy.proxy` whose call the proxy's type does not cover was accepted too, and sent it succeeded with `System.CallFiltered` in its `Proxy.ProxyExecuted` event (block 477948, E38).
- `Staking.nominate` of an account that is not a validator, `NominationPools.claimPayout` with nothing to claim and `System.remarkWithEvent` from an empty account were accepted.

Checked on Nov 15, 2026: the dry runs of the tables above, the sent transaction of block 477948, and a read of the Treasury's free balance on the same day.

## Not measured

- What a sent transaction answers for the mistakes of the rows that name no block.
- The inner result of `Utility.batch`, `Utility.forceBatch`, `Proxy.proxy`, `Sudo.sudo` and `Sudo.sudoAs` in a dry run. A dry run through the pallets address shows no events, and the runtime has no `DryRunApi` (E51 gives the texts you get and what works instead). `system_dryRun` of a signed `Utility.batch` with a failing call inside, from a funded key, answered Ok as well (`0x0000`). (`Revive.dispatchAsFallbackAccount` is not among them: with `Balances.forceSetBalance` inside, its dry run answered `BadOrigin`.)
- `Multisig.MaxWeightTooLow`. It needs a second signatory's approval at the threshold, which a dry run as one account cannot give, and a `Proxy.proxy` around it hides the inner error.
- What a bond from an empty account bonds, and exactly how much an oversized `Staking.bondExtra` leaves free.
- An account with both frozen and reserved tPOT outside a batch: none existed on Nov 15, 2026. Inside one `Utility.batchAll`, a bond under a vesting lock kept the limit free - max(frozen - reserved, 0.1 tPOT). Also accounts with unbonding staking chunks.
- Nfts mint types Public and HolderOf, item attributes (E25), and Uniques roles on a class that another account owns.
- `NominationPools.claimPayout` with pending rewards, `NominationPools.unbond` and `NominationPools.withdrawUnbonded`; `Staking.chill`; `Treasury.spend` with an asset kind; the Scheduler with the root origin.
- `Revive.AccountUnmapped` and `Revive.instantiate` from uploaded code.
- The mainnet: these dry runs used the testnet's Ethereum RPC, and the mainnet has none.
