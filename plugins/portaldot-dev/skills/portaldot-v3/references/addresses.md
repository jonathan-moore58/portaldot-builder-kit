# Addresses: the native form and the 0x form

How one account can appear as a `5...` address and as a `0x` address, how to convert between them (and which common helpers convert wrongly), which one to use, and which `0x` addresses are not accounts at all. Read it before you send funds between a native wallet and an Ethereum wallet, or when an address "has no balance".

Basis words: Checked (measured on the chain by the Bridge Zero team, on the date given), Experience (learned while building and running our own tools on this chain), Guide (the chain team's testnet guide), Reported (said by other builders, not checked by us).

## The two forms

- Native form: a 32-byte account id, written as an SS58 address with prefix 42, so it starts with `5` (Checked Nov 14, 2026: `system_properties` gives `ss58Format` 42). Wallets create sr25519 keys by default (Experience).
- Ethereum form: a 20-byte `0x` address (H160). Only the Revive module and the Ethereum RPC work with it (Experience).
- Native modules take the native form: `AccountId` and `MultiAddress` arguments are `5...` addresses. Revive calls take the `0x` form: `revive.call`'s `dest` is an `H160` (Checked Nov 14, 2026, from the call definitions).
- `convert_address` gives both forms of any address, whether they are linked, and which one to use. It also says when a `0x` address is not an account (see "Addresses that are not accounts" below).

## From native to 0x

- Rule: the `0x` form is the last 20 bytes of keccak-256 of the 32-byte account id (Checked Nov 14, 2026: the offline rule and `api.call.reviveApi.address` agreed on 15 real accounts and 9 made-up ids, on both networks).
- Exception: an account id whose last 12 bytes are all `0xEE` stands for a `0x` address, and its `0x` form is its first 20 bytes. An id that ends in only eleven `0xEE` bytes is hashed like any other (Checked Nov 14, 2026 on both networks).
- This `0x` form is what `msg.sender` is inside a contract when that native account calls it (Experience: proven by a native-path contract call on Oct 27, 2026).

Worked example, the Treasury (Checked Nov 14, 2026):

- Native: `5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z`.
- Account id: `0x6d6f646c70792f74727372790000000000000000000000000000000000000000`, the text `modlpy/trsry` padded with zeros.
- keccak-256 of those 32 bytes, last 20 bytes: `0x8ddee436166f311ddeed36d714b08f512670d16e` (checksummed `0x8DDEe436166f311ddeED36d714B08F512670d16e`).
- `reviveApi.address` returns the same value, and `revive.originalAccount(0x8dde...)` returns the Treasury: the two forms are linked.

## From 0x to native

- If `revive.originalAccount(0x...)` names a native account, that account holds the balance and signs for the address. `reviveApi.accountId(0x...)` then returns that native account.
- If it names none (any address from an Ethereum key, such as MetaMask's), the balance sits on the address's fallback account: the 20 bytes followed by twelve `0xEE` bytes (Checked Nov 14, 2026: `reviveApi.accountId` returns exactly that).
- A fallback account is an ordinary native account: it can hold reserved funds and stake like any other. On Nov 14, 2026, 340 of the 630 fallback accounts on the testnet held reserved funds, 2 were bonded staking stashes and 6 were nomination-pool members (Checked).

Worked example with an Ethereum-style address (Checked Nov 14, 2026 on both networks). The address was made for this page from a hash, so nobody holds its key: never send funds to it.

- `0x` form: `0x30FCb8D9F49fF9d61d3e1c1C4AB20c70fAA6A273`.
- Fallback account id: `0x30fcb8d9f49ff9d61d3e1c1c4ab20c70faa6a273eeeeeeeeeeeeeeeeeeeeeeee`.
- Fallback `5...` form: `5DAwEHBNaDY7hRrFFCECLDqsnD8b79mb4FdYikURumQ3GUEc`.
- `reviveApi.accountId(0x30FC...)` returns the same `5DAwEH...` account, `revive.originalAccount(0x30FC...)` is empty, and `reviveApi.address` of the fallback account gives back `0x30FC...A273` (the exception above).
- The testnet guide's own example follows the same rule: its `0x` address maps to that address plus twelve `0xEE` bytes (Checked Nov 14, 2026, offline).

## The rule in code

Offline, with @polkadot/util-crypto (the same logic checked the examples above on Nov 14, 2026; recipe 6 in `recipes.md` has the full version):

```js
import { decodeAddress, encodeAddress, keccakAsU8a } from '@polkadot/util-crypto';
const hex = (u8) => '0x' + Buffer.from(u8).toString('hex');
export function nativeToH160(ss58) {
  const id = decodeAddress(ss58);
  if (id.subarray(20).every((b) => b === 0xee)) return hex(id.subarray(0, 20));
  return hex(keccakAsU8a(id, 256).subarray(12));
}
export function h160ToFallback(h160) {
  const bytes = Buffer.from(h160.slice(2), 'hex');
  return encodeAddress(new Uint8Array([...bytes, ...new Uint8Array(12).fill(0xee)]), 42);
}
```

On the chain, read-only (with `ApiPromise.create` as in recipe 0, `api.call.reviveApi` is present; Checked Nov 14, 2026):

```js
(await api.call.reviveApi.address(decodeAddress(ss58))).toHex();   // native -> 0x
(await api.call.reviveApi.accountId(h160)).toHex();                // 0x -> the account that holds its balance
(await api.query.revive.originalAccount(h160)).toHuman();          // the linked native account, or null
```

## Wrong conversion rules

Common helpers convert by rules that are not this chain's, and none of them raises an error (Checked Nov 15, 2026: offline, and against `reviveApi.address` and `reviveApi.accountId` on the testnet).

| Helper | What it computes | What you get here |
|---|---|---|
| @polkadot/util-crypto `addressToEvm(native)` | the first 20 bytes of the account id | a wrong `0x` form, except for a fallback account. The Treasury gives its text `modlpy/trsry` (`0x6d6f646c70792f7472737279`) followed by 8 zero bytes |
| `new Keyring({ type: 'ethereum' }).encodeAddress(id)`, util-crypto `ethereumEncode` | the last 20 bytes, unhashed | a wrong `0x` form; every module account gives the zero address |
| @polkadot/util-crypto `evmToAddress(h160)` | blake2-256 of `"evm:"` + the 20 bytes (the rule of Frontier chains) | an unrelated `5...` account |
| The 20 bytes padded with 12 zero bytes | | an unrelated `5...` account; the fallback pads with twelve `0xEE` bytes |

- Check every conversion against the chain (`reviveApi.address`, `reviveApi.accountId`, or `convert_address`). A `0x` address that spells `modl` and ends in zero bytes is a module account converted by the first-20-bytes rule.
- The chain does not stop a payment to a wrong result: a native transfer to an `evmToAddress` account and an Ethereum transfer to the Treasury's first-20-bytes form both passed their dry runs. No key controls those accounts (our reading).
- Found on the testnet on Nov 15, 2026 (a read of every account, done twice, blocks 477893 and 478090): 8 accounts at the fallback form of the first 20 bytes of a native account id held 8630.3 tPOT in all, the largest 7000.1 tPOT. None of them has ever sent a transaction. Their 8 source ids look like ordinary native accounts (6 of them have sent transactions), so payments to a wrongly converted address are the likely cause; the chain cannot prove it.

What libraries do with the wrong kind of address (Checked Nov 15, 2026, offline; the chain's reply by dry run):

| Call | Given | Result |
|---|---|---|
| @polkadot/api `api.tx.balances.transferKeepAlive(dest, amount)` | a `0x` address as `dest` | encoded silently as `MultiAddress::Address20`; the chain answers `Failed to dispatch call: CannotLookup` (so does `Address32`; E50). Pass `{ Id: <32-byte account id> }`, for a MetaMask user its fallback id. A 32-byte hex string is encoded as `Id` and works |
| @polkadot/util-crypto `decodeAddress` | a `0x` address | the 20 bytes, with no error |
| @polkadot/util-crypto `encodeAddress`; sr25519 `Keyring.encodeAddress` | 20 bytes | `Expected a valid key to convert, with length 1, 2, 4, 8, 32, 33` |
| @polkadot/util-crypto `checkAddress(address, 42)` | a `0x` address | `[false,"Invalid base58 character \"0\" (0x30) at index 0"]` |
| @polkadot/util-crypto `evmToAddress` | a 32-byte id | `Converting 0x...: Invalid evm address length` |
| @polkadot/types `createType('AccountId32', ...)` | 20 bytes | `createType(AccountId32):: Invalid AccountId provided, expected 32 bytes, found 20` |
| @polkadot/types `createType('H160', ...)`, for example `revive.call`'s `dest` | a 32-byte id, or a `5...` address | `createType(H160):: Expected input with 20 bytes (160 bits), found 32 bytes` (`found 48 bytes` for a `5...` address) |
| ethers 6.15 `getAddress`, `Transaction.from({ to })`, `AbiCoder.encode(['address'], ...)` | a 32-byte id, or a `5...` address | `TypeError: invalid address (argument="address", value="...", code=INVALID_ARGUMENT, version=6.15.0)`; wrong capital letters give `bad address checksum` |
| viem 2.21 `getAddress`, `encodeAbiParameters` | the same | `InvalidAddressError: Address "..." is invalid.`, then `- Address must be a hex value of 20 bytes (40 hex characters).` and `- Address must match its checksum counterpart.`; `isAddress` returns `false` |

## Which form to use

| You want to | Use |
|---|---|
| Pay a MetaMask user from a native wallet | the fallback `5...` form of their `0x` address (Guide; Checked Nov 14, 2026); in @polkadot/api as `{ Id: <fallback account id> }`, never the bare `0x` string |
| Pay a native account from MetaMask or another Ethereum tool | its `0x` form, but only after `revive.originalAccount(0x...)` names that account |
| Pay the owner of a linked `0x` address from a native wallet | the linked native account, never the fallback `5...` form of that `0x` address |
| Call a contract from a native account | `revive.call` with the contract's `0x` address; the contract sees your `0x` form as `msg.sender` |
| Give an address to another EVM chain or a bridge | an address from an Ethereum key, never a native account's `0x` form |
| Use a faucet that pays `5...` addresses only | the fallback `5...` form of your `0x` address |

## autoMap: every native account is linked

- `revive.autoMap` is true on both networks (Checked Nov 14, 2026, the constant). Every native account is linked to its `0x` form when it is created.
- On Nov 14, 2026 the testnet had 1305 native accounts and 1305 `revive.originalAccount` entries; the mainnet had 1227 and 1227 (Checked).
- So do not call `revive.mapAccount`. Its own documentation says "Noop when `Config::AutoMap` is enabled", and `unmapAccount` is "Disabled when `Config::AutoMap` is enabled" (Checked Nov 14, 2026, from the metadata). An error `AutoMappingEnabled` ("Manual mapping is disabled when auto-mapping is enabled") also exists.
- Other Revive chains may have autoMap off; this chain has had it on whenever we measured, since Oct 19, 2026.

## Funds sent to the wrong form

- A native account that does not exist yet (never funded) has no link. tPOT sent from the Ethereum side to its `0x` form lands on the fallback account of that `0x` address, which no Ethereum key controls (Experience).
  - Avoid it: check `revive.originalAccount(0x...)` first, or fund the native account natively first.
- The fallback `5...` form of a linked `0x` address is a separate account that is not used while the link exists. tPOT sent to it natively stays there: the `0x` address does not see it, and only the linked native account could move it (Checked Nov 14, 2026 for the accounts; the recovery is untested).
  - Example: the Treasury's `0x` form plus twelve `0xEE` bytes is `5FGipbm9kpThCKSRuVamVt8y67H7MVqYob1gJYYqcyceoyPM`. On Nov 14, 2026 it held nothing, and `reviveApi.accountId(0x8dde...)` named the Treasury, not it. `convert_address` on such an address says so and names the account to pay.
  - On Nov 15, 2026 one testnet account of this kind held 1.1 tPOT and had never sent (Checked). How it got there is not known; a payment from the Ethereum side before the native account existed (the case above) is the simplest explanation.
- Recovery: `revive.dispatchAsFallbackAccount(call)` (call index `0x5009`). The chain documents it as: "Every `AccountId32` can control its corresponding fallback account. The fallback account is the `AccountId20` with the last 12 bytes set to `0xEE`. This is essentially a recovery function in case an `AccountId20` was used without creating a mapping first." (Checked Nov 14, 2026 that the call and its text exist.)
  - Our reading: the native owner, once its account exists and can pay a fee, signs `revive.dispatchAsFallbackAccount(balances.transferKeepAlive(<its own 5... address>, amount))`. Nobody we know of has tried it on V3: dry-run before relying on it.
- tPOT sent with a plain `balances` transfer to a contract's account id, instead of through the contract's functions, is not seen by the contract's own bookkeeping (Experience).

## A native account's 0x form has no private key

- The `0x` form of a native account is a hash of its account id. No Ethereum private key stands behind it (Experience).
- No other EVM chain can see a transaction from it, and tokens sent to it on another EVM chain cannot be moved. Give other chains an address from an Ethereum key.
- The guide warns: "The H160 derived from the same private key/mnemonic is NOT the same as the address generated on Ethereum/BSC" (Guide). That holds for sr25519 accounts. A MetaMask key's `0x` address is its normal Ethereum address, the same on every EVM chain (Experience: our Ethereum keys sent transactions on this chain and on other EVM testnets).

## An Ethereum key signing native transactions

- The native signature type has an Ethereum variant, `MultiSignature::Eth` (index 3, 65 bytes). It signs for one account only: keccak-256 of the key's 33-byte compressed public key, last 20 bytes, followed by twelve `0xEE` bytes. Its `0x` form is those 20 bytes.
- That is not the fallback account of the key's usual `0x` address (keccak-256 of the 64-byte public key), where MetaMask's balance sits. So a MetaMask key cannot move that balance with a native transaction; send native calls from it through the pallets address (recipe 4 in `recipes-contracts.md`).
- What the node's own check (`TaggedTransactionQueue_validate_transaction`) accepted: the signing payload hashed with keccak-256 (its blake2-256 hashed with keccak-256 when the payload is longer than 256 bytes), signed raw, with v 0/1 or 27/28. An EIP-191 `personal_sign`, or the usual address's fallback account as the signer, got `BadProof`.
- @polkadot/types 17 adds such a signature only after `registry.register({ ExtrinsicSignature: { _enum: { Ed25519: '[u8;64]', Sr25519: '[u8;64]', Ecdsa: '[u8;65]', Eth: '[u8;65]' } } })`. A `Keyring({ type: 'ethereum' })` pair cannot sign here: `signAsync` throws `createType(Vec<StorageKey>):: createType(Lookup1):: Invalid AccountId provided, expected 32 bytes, found 20`.
- Basis: Checked on Nov 15, 2026 with new keys held only in memory; the check answered `Payment` (signature accepted, account empty). Nothing was sent, so that such a transaction is included is not measured.

## Module accounts

- Treasury: `5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z`, `0x8ddee436166f311ddeed36d714b08f512670d16e`. Transaction fees are paid into it (Checked Nov 13, 2026). It held over 150000 tPOT on Nov 14, 2026, which makes it a good "from" for dry runs and estimates.
- Revive: `5EYCAe5ijiYfhaAUBd6H9WGRTsvwFFc7GnhQkiHvBYxdvpbV`, the text `modlpy/reviv` padded with zeros. It holds every code deposit, as `CodeUploadDepositReserve`: 58651.44 tPOT on the testnet on Nov 14, 2026, exactly the sum of the deposits of the 279 entries in `revive.codeInfoOf` (Checked). Each entry still names the uploader as `owner`.
- Multisig: the account id is `blake2_256("modlpy/utilisuba" ++ SCALE(sorted member account ids) ++ u16 little-endian threshold)`, and it gets a `0x` form like any native account (Experience: proven with a 2-of-3 account on Oct 20, 2026).

## Addresses that are not accounts

These `0x` addresses answer calls but belong to the runtime. Do not send tPOT to them in either form: no key controls their fallback accounts. Checked Nov 14, 2026 unless marked; `evm-checks.md` sections 2 and 3 have the measurements.

- Pallets address: `0x6d6f646c70792f70616464720000000000000000`, the text `modlpy/paddr` padded with zeros; `reviveApi.runtimePalletsAddress` returns it on both networks.
  - An Ethereum transaction sent to it with a SCALE-encoded native call as `data` and value 0 runs that call as the sender (`native-modules.md`; recipe 4 in `recipes-contracts.md`). With a value above 0, `eth_estimateGas` answers `Invalid call: Call`.
  - It is not derived by the rule: the module account `modlpy/paddr` (`5EYCAe5ijiYfRmcZ49QUZ8dWLt4eYQ6WfHhR9eyyw4pHHfqY`) has the different `0x` form `0x6c0314017761e1367178001be94c2f710eb43325`.
- Precompiles, all at addresses whose first 18 bytes are zero:
  - `0x0000000000000000000000000000000000000001` to `...0009` (ecrecover, sha256, ripemd160, identity, modexp, bn256 add, mul and pairing, blake2f) and `...0100` (P256VERIFY) gave the correct answers for test vectors computed with independent libraries.
  - `...0900` is the chain's own System precompile (`minimumBalance()`, `hashBlake256(bytes)`, `toAccountId(address)`), and `...0901` exists too.
  - `...000a` (KZG) fails when called, and `...000b` to `...0011` (BLS12-381) are absent: a call there returns no data and no error.
  - Funds can still reach them: `...0001` has a Revive account record, and its fallback account held 0.101 tPOT on Nov 14, 2026.
- Token addresses: an asset of the Assets module answers ERC-20 calls (`name`, `symbol`, `decimals`, `totalSupply`, `balanceOf`) at its id as 4 big-endian bytes, then 12 zero bytes, then `0001`, then `0000`. Asset 2 is `0x0000000200000000000000000000000000010000`. The PoolAssets module (the liquidity tokens of AssetConversion) uses `0002` in place of `0001`.
  - An id with no asset still answers `totalSupply()`, `balanceOf()` and `allowance()` with 0, so check that the asset exists (`read_storage` of `Assets.asset`).
  - `transfer`, `approve`, `transferFrom` and `permit` work through these addresses, with differences from Ethereum (Checked Nov 15, 2026, sent; E40 to E44). Asset 7777 (pUSD, 6 decimals) is `0x00001e6100000000000000000000000000010000`: 7777 is `0x00001e61`.
- `eth_getCode` at `...0900`, `...0901` and the token addresses returns `0x60006000fd`, not `0x`, while `revive.accountInfoOf` holds no contract record for them. Do not use "has code" to tell a contract from a precompile here.
- `convert_address` recognises the pallets address, the precompiles and the token addresses, and says what each is.

## Contract addresses

- A contract created by a native account without a salt gets the CREATE address of the deployer's `0x` form and its account nonce (Checked Nov 14, 2026: a deploy dry run from the Treasury, nonce 0, reported `0x30ca0ab4156e37027841a1504e78aae6116468db`, which is keccak-256 of the RLP of the Treasury's `0x` form and nonce 0, last 20 bytes).
- A contract created by an Ethereum transaction gets the CREATE address of the sender and the transaction's nonce. Seen on the chain in other builders' transactions, not sent by us: testnet blocks 354887 (nonce 0) and 346634 (nonce 3), legacy (type 0) creation transactions with receipt status 1, whose receipts name exactly that address (Checked Nov 14, 2026).
  - A reverted creation still has a `contractAddress` on its receipt, although no contract exists there (testnet blocks 343008 to 343010, Checked Nov 14, 2026). Check the receipt's `status` before you use that address.
- With a salt, the address is the CREATE2 address of the deployer's `0x` form, the salt and keccak-256 of the init code with its constructor arguments, and it does not depend on the nonce (Checked Nov 14, 2026, by dry run only).
- Without a salt the address depends on the nonce, so any transaction the deployer sends first moves it. `simulate_contract_deploy` gives the address for the current nonce, or for a salt.

## One nonce for both sides

- An account has one nonce for the native and the Ethereum side: `eth_getTransactionCount(0x...)` equals `System.Account.nonce` of the linked or fallback account (Checked Nov 14, 2026 on three accounts).
- An Ethereum transaction waiting for its block counts on the native side: `system_accountNextIndex` of the sender's fallback account was its nonce + 1, while `eth_getTransactionCount(..., "pending")` still equalled `"latest"` (Checked Nov 15, 2026, a sent transaction, block 477944). So the two sides draw from one sequence. Send one at a time, only when no earlier transaction is pending, and ask the node, not the Ethereum RPC, whether one is (E12, recipe 9 in `recipes.md`).

## Account counts

- Testnet, Nov 14, 2026: 1935 accounts, of which 1305 are native and 630 are fallback accounts of `0x` addresses (Checked). Nov 15, 2026, block 478090: 1940 accounts, 1307 native and 633 fallback (Checked).
- Mainnet, Nov 14, 2026: 1227 accounts, all native (Checked). It had 1215 on Nov 13, 2026.

## Keys

- Never put a real private key or recovery phrase in code. Use a fresh test key that holds testnet tPOT only.
- Well-known test accounts such as `//Alice` or `//Ferdie`, and any mnemonic printed in a sample, are public: anyone can spend from them. Sample code that uses such accounts, or prints keys, is for local experiments only; do not copy those lines into real code.
- An account id is public, but a 64-hex `0x` value can also be an Ethereum private key. Never paste a private key into a tool or a chat; if one was pasted, treat it as exposed and move its funds.
