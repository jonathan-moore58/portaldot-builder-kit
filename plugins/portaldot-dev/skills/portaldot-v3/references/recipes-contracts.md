# Recipes for contracts: Foundry and cast, native contract calls, native calls from a 0x account

Recipes 2, 3 and 4 of the Portaldot V3 recipes. Recipes 0, 1 and 5 to 9 (connect, send tPOT, read results and events, addresses, balances, fees, nonces) are in `recipes.md`, with the prerequisites, the safety rule and the basis words. Read this file when you build, deploy or call a Solidity contract, or send a native call from an Ethereum key.

By the Bridge Zero team, an independent project and not an official Portaldot one. The read-only parts below ran against the V3 testnet on Nov 14, 2026; the parts that sign and send ran up to the signing step and are labelled "Assembled" unless a recipe says "Proven".

You need: Node 20 or newer with @polkadot/api 17 (`recipes.md`), recipe 0 saved as `v3.mjs`, and Foundry for the shell parts (they ran with Foundry 1.8.5 in Git Bash on Windows; any bash works). Error numbers (E1, E2 and so on) refer to `errors.md`.

- 2. Solidity on the testnet with Foundry and cast: 2a build, 2b read, 2c call by Ethereum transaction, 2d deploy by Ethereum transaction (seen on the chain, not sent by us), 2e deploy on the native path, 2f read why the node refuses an Ethereum transaction, without sending it
- 3. Call a contract from a native account (`revive.call`)
- 4. Call a native module from a `0x` account

Two things to know first:

- Gas on the Ethereum side includes the storage deposit, so estimates of 10^12 to 10^16 gas are normal. A new 32-byte storage slot holds 3.8415 tPOT; deploying new code whose runtime part is L bytes holds 0.078 x L + 13.11 tPOT before the constructor's storage (Checked Nov 14, 2026; `amounts-and-fees.md`).
- The gas rule for every Ethereum transaction: gas limit = `eth_estimateGas` + 10 percent; max fee = `eth_gasPrice` + one eighth; priority fee 0; and the balance must cover value + gas limit x max fee, or the node refuses the transaction with error 1010 (E1). Experience, proven by six contract calls sent as Ethereum transactions between Oct 19 and Nov 1, 2026, and by the two transactions of recipe 4.

---

## 2. Solidity on the testnet with Foundry and cast

### 2a. Build for V3

```toml
# foundry.toml
[profile.v3]
out = "out-v3"
solc_version = "0.8.27"
evm_version = "cancun"    # PUSH0 and the other cancun opcodes run on V3
cbor_metadata = false     # every byte of runtime code holds about 0.078 tPOT of deposit, and no V3 explorer reads it
bytecode_hash = "none"
via_ir = true             # the IR pipeline usually gives smaller code
```

```sh
FOUNDRY_PROFILE=v3 forge build --sizes      # PowerShell: $env:FOUNDRY_PROFILE = "v3"; forge build --sizes
node -p "(require('./out-v3/MyToken.sol/MyToken.json').deployedBytecode.object.length - 2) / 2"   # runtime bytes L
```

- The deposit for deploying it is about 0.078 x L + 13.11 tPOT, plus 3.8415 for each storage slot the constructor writes. `simulate_contract_deploy` gives the exact figure.
- Foundry 1.8.5 leaves the optimizer off unless the profile says `optimizer = true` (Checked with `forge config`, Nov 14, 2026). Try it and compare the runtime size.
- In our experience these settings and fewer public getters cut one contract from 1842 to 899 bytes of runtime code, about 74 tPOT less deposit.

Basis: **Proven** for the settings: a contract built this way with solc 0.8.27 and Foundry 1.8.5 was deployed on Oct 19, 2026 and runs on V3. On Nov 14, 2026 `forge config` read this exact profile (out, solc, evm_version, cbor_metadata, bytecode_hash, via_ir); the build itself was not run again. Not proven: other solc versions, and `evm_version` later than `cancun`.

### 2b. Read a contract (no key)

Run cast in a folder that has no `.env` file: Foundry loads the `.env` of the folder it runs in (E22).

```sh
RPC=https://test-evm-rpc-v3.portaldot.dev
cast chain-id --rpc-url $RPC                                          # 420420777
cast gas-price --rpc-url $RPC                                         # wei per gas, for example 15695
cast codesize $CONTRACT --rpc-url $RPC                                # runtime bytes
cast code $CONTRACT --rpc-url $RPC | cast keccak                      # the code hash
cast call $CONTRACT "totalSupply()(uint256)" --rpc-url $RPC
cast call $CONTRACT "balanceOf(address)(uint256)" 0x8ddee436166f311ddeed36d714b08f512670d16e --rpc-url $RPC
cast storage $CONTRACT 0 --rpc-url $RPC                               # any slot, also values without a getter
cast logs --from-block $BLOCK --to-block $BLOCK --address $CONTRACT --rpc-url $RPC
cast receipt $TX_HASH --rpc-url $RPC
cast balance 0x8ddee436166f311ddeed36d714b08f512670d16e --ether --rpc-url $RPC   # 18 decimals, without the 0.1 tPOT the account keeps
```

What you should see (Nov 14, 2026, an ERC-20 found on the testnet): `cast codesize` 1863; `cast code | cast keccak` gave the same hash as the contract's `codeHash` in `revive.accountInfoOf`; `totalSupply()(uint256)` printed `1000000000000000000000000 [1e24]`; `cast receipt` of a contract call showed `status 1 (success)`, `type 2`, `gasUsed 204128708753593` and `effectiveGasPrice 18895`.

- `gasUsed x effectiveGasPrice` in a receipt is the fee plus the storage deposit (3.857 tPOT in that receipt; 3.8415 of it the deposit for one new slot).
- `cast logs` returns only the logs of Ethereum transactions. Events from native-path calls are only on the node (recipe 5c in `recipes.md`, E6). There is no block-range limit: from block 0 to the head, one contract's 9 logs came back in about 0.5 s on Nov 14, 2026. A `--to-block` beyond the head gives `Failed to filter logs` (E33).
- An asset of the Assets module answers ERC-20 calls at the address made of its asset id as 4 big-endian bytes, then 12 zero bytes, then `0x0001`, then `0x0000`. Asset 7777 is at `0x00001e6100000000000000000000000000010000`: `cast call <that address> "totalSupply()(uint256)"` returned the asset's `supply` from `assets.asset(7777)`, and `decimals()` and `symbol()` its metadata (Checked Nov 14, 2026 on 7 assets; transfers through it were not tried). `evm-checks.md` section 3 has the details, including the PoolAssets layout.

Basis: **Proven**: every command ran on Nov 14, 2026 against the testnet. Tool: `get_account` for a contract's code, size, hash and deposits; `simulate_contract_call` for any view.

### 2c. Call a contract with an Ethereum transaction

What it does: estimates, applies the gas rule, refuses when the node would answer 1010, signs with a Foundry keystore, prints the hash, publishes, and waits for the receipt. Recipe 4 uses the same script.

You need: a Foundry keystore with a TEST key that holds tPOT. `cast wallet import v3test --interactive` asks for the key and a password and stores the key encrypted; never paste a key into a chat or a file. Fund its address from a native wallet by sending tPOT to its fallback `5...` form (recipe 6 in `recipes.md`).

```sh
#!/usr/bin/env bash
# send-eth.sh: send an Ethereum transaction on the V3 testnet with the gas rule and the 1010 check.
# Usage: TO=0x... DATA=0x... [VALUE=<wei>] [ACCOUNT=<keystore name>] bash send-eth.sh
set -euo pipefail
: "${TO:?set TO to the 0x address to call}" "${DATA:?set DATA to the 0x calldata}"
VALUE=${VALUE:-0}                   # wei (18 decimals): 1 tPOT = 10^18 wei; keep it a multiple of 10000
ACCOUNT=${ACCOUNT:-v3test}          # a Foundry keystore that holds a TEST key
RPC=https://test-evm-rpc-v3.portaldot.dev
FROM=$(cast wallet address --account "$ACCOUNT")

[ "$(cast chain-id --rpc-url "$RPC")" = 420420777 ] || { echo "not the V3 testnet"; exit 1; }
NONCE=$(cast nonce "$FROM" --rpc-url "$RPC")
[ "$NONCE" = "$(cast nonce "$FROM" --block pending --rpc-url "$RPC")" ] || { echo "a transaction is pending"; exit 1; }
EST=$(cast estimate --from "$FROM" "$TO" "$DATA" --value "$VALUE" --rpc-url "$RPC")   # includes the storage deposit
GP=$(cast gas-price --rpc-url "$RPC")
# BigInt arithmetic: these products overflow the shell's 64-bit integers
read -r GAS MAXFEE NEED <<< "$(node -p "const e=${EST}n, g=${GP}n, gas=e+e/10n, fee=g+g/8n; [gas, fee, ${VALUE}n+gas*fee].join(' ')")"
BAL=$(cast balance "$FROM" --rpc-url "$RPC")
echo "estimate $EST gas, gas price $GP wei; gas limit $GAS, max fee $MAXFEE; need $NEED wei, have $BAL wei"
node -e "process.exit(${BAL}n >= ${NEED}n ? 0 : 1)" || { echo "balance too low: the node would refuse it with error 1010"; exit 1; }

cd "$(mktemp -d)"                   # Foundry reads the .env of the folder it runs in: sign in an empty one
RAW=$(cast mktx "$TO" "$DATA" --rpc-url "$RPC" --chain 420420777 --account "$ACCOUNT" \
  --nonce "$NONCE" --gas-limit "$GAS" --gas-price "$MAXFEE" --priority-gas-price 0 --value "$VALUE")
HASH=$(cast keccak "$RAW")
echo "transaction hash $HASH"       # write it down BEFORE publishing
cast publish "$RAW" --rpc-url "$RPC" --async
cast receipt "$HASH" --rpc-url "$RPC"   # waits for the receipt; if none comes, read the node's side (recipe 5a)
```

Use it for a contract call:

```sh
TO=$CONTRACT DATA=$(cast calldata "approve(address,uint256)" $SPENDER 1000000000000000000) bash send-eth.sh
```

What you should see before signing (Nov 14, 2026, an ERC-20 `approve` that writes one new slot):

```
estimate 249985957328367 gas, gas price 15685 wei; gas limit 274984553061203, max fee 17645; need 4852102438764926935 wei, have ... wei
```

That is about 3.92 tPOT of cost (3.8415 of deposit and the fee), while the balance check asks for about 4.85 tPOT. From an address with no tPOT the script stops with `balance too low: the node would refuse it with error 1010`. After publishing, the receipt shows `status 1 (success)`; `gasUsed x effectiveGasPrice` is the fee plus the deposit.

- `--gas-price` of `cast mktx` is the max fee of an EIP-1559 (type 2) transaction; `--priority-gas-price 0` is accepted (`eth_maxPriorityFeePerGas` returns 0).
- For unattended use, `--password-file <file>` after `--account` gives the keystore password; keep that file outside the project.
- A `value` that is not a multiple of 10000 wei is not a whole native unit; what the chain does with the remainder was not tested (E3).
- Windows: run the script in Git Bash or WSL. A command line longer than about 30000 characters is refused (E22).

What can go wrong: `{"code":1010,"message":"Invalid Transaction"}` from `cast publish` (balance below gas limit x max fee plus value, E1); `execution reverted` from `cast estimate` (the call reverts: decode it, E26); `Invalid call: Payment` if you add a small `--gas-limit` to `cast estimate` or `cast call` (E27); a receipt that does not come (E15).

Basis: **Assembled**. On Nov 14, 2026 the script ran up to the signing step, with the Treasury's `0x` form as `FROM` (an estimate needs no signature) and with an empty address (refused by the balance check), and `bash -n` passed. The signing lines (`cast mktx` with these flags, `cast keccak`, `cast publish --async`, then the receipt) are those that sent six contract calls with value as Ethereum transactions between Oct 19 and Nov 1, 2026, all with status 1. Those calls built their calldata in code and asked for the estimate with `eth_estimateGas` directly; on Nov 14, 2026 `cast calldata` and `cast estimate` gave the same calldata and estimate (within the few hundred gas the estimate drifts between calls).

Tool: `estimate_eth_transaction` gives the estimate, the limits, the 1010 verdict and the fields to copy for viem, ethers and cast.

### 2d. Deploy a contract with an Ethereum transaction: seen on the chain, not sent by us

Other builders deploy this way on the testnet: on Nov 14, 2026 we read 68 creation transactions that the explorer API lists with a `revive.Instantiated` event (testnet blocks 295289 to 340057), all with receipt status 1, of which 26 legacy (type 0) and 42 EIP-1559 (type 2), 23 of these with a priority fee of 0 as below (Checked). We have not sent one ourselves, so try a small contract first; the native path (2e) is the one we proved. The guide shows a deployment with Remix and MetaMask (Guide). The script follows the same rules as 2c:

```sh
#!/usr/bin/env bash
# deploy-eth.sh: deploy by Ethereum transaction on the V3 testnet. Not yet sent by us: try a small contract first.
# Usage: ARTIFACT=out-v3/MyToken.sol/MyToken.json [ARGS=<abi-encoded constructor arguments>] [ACCOUNT=<keystore name>] bash deploy-eth.sh
set -euo pipefail
: "${ARTIFACT:?set ARTIFACT to the Foundry artifact (JSON)}"
ARGS=${ARGS:-0x}                    # for example: ARGS=$(cast abi-encode "constructor(uint256)" 42)
ACCOUNT=${ACCOUNT:-v3test}
RPC=https://test-evm-rpc-v3.portaldot.dev
FROM=$(cast wallet address --account "$ACCOUNT")
INITCODE=$(node -p "require('./$ARTIFACT').bytecode.object + '${ARGS#0x}'")

[ "$(cast chain-id --rpc-url "$RPC")" = 420420777 ] || { echo "not the V3 testnet"; exit 1; }
NONCE=$(cast nonce "$FROM" --rpc-url "$RPC")
[ "$NONCE" = "$(cast nonce "$FROM" --block pending --rpc-url "$RPC")" ] || { echo "a transaction is pending"; exit 1; }
EST=$(cast estimate --from "$FROM" --rpc-url "$RPC" --create "$INITCODE")   # includes the code deposit
GP=$(cast gas-price --rpc-url "$RPC")
read -r GAS MAXFEE NEED <<< "$(node -p "const e=${EST}n, g=${GP}n, gas=e+e/10n, fee=g+g/8n; [gas, fee, gas*fee].join(' ')")"
BAL=$(cast balance "$FROM" --rpc-url "$RPC")
echo "init code $(( (${#INITCODE} - 2) / 2 )) bytes; estimate $EST gas at $GP wei; need $NEED wei, have $BAL wei"
echo "expected address $(cast compute-address "$FROM" --nonce "$NONCE")"
node -e "process.exit(${BAL}n >= ${NEED}n ? 0 : 1)" || { echo "balance too low: the node would refuse it with error 1010"; exit 1; }

cd "$(mktemp -d)"                   # an empty folder: no .env
# the options come before --create, which is a subcommand
RAW=$(cast mktx --rpc-url "$RPC" --chain 420420777 --account "$ACCOUNT" \
  --nonce "$NONCE" --gas-limit "$GAS" --gas-price "$MAXFEE" --priority-gas-price 0 --create "$INITCODE")
HASH=$(cast keccak "$RAW")
echo "transaction hash $HASH"       # write it down BEFORE publishing
cast publish "$RAW" --rpc-url "$RPC" --async
cast receipt "$HASH" --rpc-url "$RPC"   # contractAddress, status, gasUsed x effectiveGasPrice = fee + deposit
```

The deposit, worked out:

- Rule: 0.078 x L + 13.11 tPOT for new runtime code of L bytes, made of a code deposit of (L + 70) x 0.06, held on the Revive module's own account (`modlpy/reviv`), and a storage base deposit of 7.65 + 30 percent of the code deposit for the contract; plus 3.8415 per storage slot the constructor writes (Checked Nov 14, 2026 by dry runs for 1 to 24576 bytes on both networks and on the records of more than 20 deployed contracts).
- Example: an ERC-20 of 1863 bytes on the testnet. Its records hold a code deposit of 115.98 tPOT ((1863 + 70) x 0.06) and a contract deposit of 42.444 tPOT (30 percent of 115.98, plus 7.65): 158.424 tPOT = 0.078 x 1863 + 13.11. Its 6 storage slots hold 23.049 tPOT more (6 x 3.8415). Checked Nov 14, 2026 from `revive.codeInfoOf` and `revive.accountInfoOf`.
- Seen on the chain: the creation transaction in testnet block 354887 (legacy, nonce 0, 6336 bytes of runtime code) held 384.36 tPOT of code deposit ((6336 + 70) x 0.06) on `modlpy/reviv` and 126.7995 tPOT for the contract (30 percent of 384.36, plus 7.65, plus one slot), and paid a fee of 0.6466 tPOT. Its receipt's `gasUsed x effectiveGasPrice` was 511.806 tPOT, the sum of the three, and the contract is at the CREATE address of its sender and nonce. Block 346634 (nonce 3, 6376 bytes) matched the same way (Checked Nov 14, 2026 from the receipts and the node's events).
- In gas: the deposit divided by the gas price. At 15695 wei per gas, 158.424 tPOT alone is about 1.01 x 10^16 gas.
- The balance check asks for about 1.1 x 1.125 = 1.2375 times the estimated cost: about 196 tPOT for that ERC-20 before its storage. Measured on Nov 14, 2026 for init code that returns 1000 bytes of runtime code: estimate 5900202211390958 gas at 15685 wei, about 92.5 tPOT (91.11 of it deposit), and the check asked for 114.52 tPOT.
- When the exact same runtime code is already stored on the chain, its code part, (L + 70) x 0.06, is not charged again; the lockup and the record are (Checked Nov 14, 2026: one byte of code that is already stored cost 8.928 tPOT instead of 13.188).

- Windows: init code longer than about 15000 bytes makes a `cast` command line longer than about 30000 characters, which Windows refuses (E22). Sign such a transaction in a script (viem, ethers) instead.
- A reverted creation still gets a `contractAddress` in its receipt, with no code there: check `status` (E9).

What can go wrong: `execution reverted` from `cast estimate --create` (the constructor reverts: decode it, E26); `failed to run contract: ... InvalidInstruction` (a blob opcode, E31); `{"code":1010,"message":"Invalid Transaction"}` from `cast publish` (balance below gas limit x max fee, E1); a receipt that does not come (E15).

Basis: the route is **Checked** on the chain (Nov 14, 2026), from other builders' transactions. This script is **Assembled** from 2c, with `--create`: on Nov 14, 2026 it ran up to the signing step (from the Treasury's `0x` form, with and without constructor arguments), `cast estimate --create` answered, `cast compute-address` gave the same address as the native dry run for the same account and nonce, and `bash -n` passed. We have not sent it: not proven are its acceptance as written and the final cost of one of our own deployments.

Tool: `simulate_contract_deploy` (address, deposit, limits for the native path) and `estimate_eth_transaction` with no `to` (the creation transaction's gas and the 1010 check).

### 2e. Deploy a contract on the native path (proven)

What it does: dry-runs `revive.instantiateWithCode` for the address, the deposit and the weight, then builds the real call with the limits our tools use (weight + 10 percent, deposit + 2 percent), checks the balance, and signs.

```js
// deploy-native.mjs: deploy a Solidity contract on the native path (revive.instantiateWithCode).
import { readFileSync } from 'node:fs';
import { Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { connect } from './v3.mjs';

const { api } = await connect('testnet');
await cryptoWaitReady();
const phrase = process.env.V3_TEST_PHRASE; // a testnet-only account; never print it
if (!phrase) throw new Error('set V3_TEST_PHRASE to the secret phrase of a testnet-only account');
const pair = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromMnemonic(phrase);
const from = pair.address;

// The creation code from Foundry's artifact, with the ABI-encoded constructor arguments appended
// (for example the output of: cast abi-encode "constructor(uint256)" 42, without its 0x).
const artifact = JSON.parse(readFileSync('out-v3/MyToken.sol/MyToken.json', 'utf8'));
const constructorArgs = '';
const initcode = artifact.bytecode.object + constructorArgs;

// 1. Dry run: nothing is sent. value 0, no weight limit, no deposit limit, data '0x', no salt.
const dry = (await api.call.reviveApi.instantiate(from, 0, null, null, { Upload: initcode }, '0x', null)).toJSON();
if (dry.result.err) {
  const m = dry.result.err.module;
  const name = m ? api.registry.findMetaError(Uint8Array.of(m.index, Number.parseInt(m.error.slice(2, 4), 16))) : null;
  throw new Error(name ? `${name.section}.${name.name}: ${name.docs.join(' ')}` : JSON.stringify(dry.result.err));
}
if ((dry.result.ok.result.flags.bits & 1) === 1) throw new Error(`the constructor reverted: ${dry.result.ok.result.data}`);
const address = dry.result.ok.addr; // CREATE(the deployer's 0x form, its nonce): it changes when the nonce does
const deposit = BigInt(dry.storageDeposit.charge ?? 0); // base units (14 decimals)
const maxDeposit = BigInt(dry.maxStorageDeposit?.charge ?? 0);
const rt = BigInt(dry.weightRequired.refTime), ps = BigInt(dry.weightRequired.proofSize);

// 2. The real call, with the limits: weight + 10 percent, deposit + 2 percent.
const held = deposit > maxDeposit ? deposit : maxDeposit;
const depositLimit = held + held / 50n;
const tx = api.tx.revive.instantiateWithCode(0, { refTime: rt + rt / 10n, proofSize: ps + ps / 10n }, depositLimit, initcode, '0x', null);
const fee = (await tx.paymentInfo(from)).partialFee.toBigInt();
const free = (await api.query.system.account(from)).data.free.toBigInt();
const need = depositLimit + fee + api.consts.balances.existentialDeposit.toBigInt();
console.log(`address ${address}, deposit ${deposit}, deposit limit ${depositLimit}, fee ${fee}, need ${need}, free ${free} (base units)`);
if (free < need) throw new Error('not enough tPOT for the deposit, the fee and the 0.1 tPOT that must stay');

// 3. Sign and send, then wait for finality exactly as in recipe 1 (the Promise around signed.send).
const signed = await tx.signAsync(pair, { nonce: (await api.rpc.system.accountNextIndex(from)).toNumber() });
console.log('extrinsic hash', signed.hash.toHex()); // write it down before submitting
// ... signed.send(...) as in recipe 1; then look for revive.Instantiated { deployer, contract } among the events,
// and check the code: eth_getCode(address) on the testnet, or api.query.revive.accountInfoOf(address).
await api.disconnect();
```

What you should see before signing (Nov 14, 2026, from the Treasury as `from`; init code `0x60646000f3` returns 100 bytes of runtime code):

```
address 0x30ca0ab4156e37027841a1504e78aae6116468db, deposit 2091000000000000, deposit limit 2132820000000000, fee 1310552428440, need 2144130552428440, free ... (base units)
```

- The deposit is 20.91 tPOT = 0.078 x 100 + 13.11; 1 byte gave 13.188 and 1000 bytes 91.11. A constructor that writes one and two new slots added 3.8415 and 7.683.
- The fee is small (0.0131 tPOT here; 0.1285 tPOT for 899 bytes on Oct 19, 2026). On the native path the deposit and the fee are separate.
- The address is the CREATE address of the deployer's `0x` form and its account nonce: `cast compute-address 0x8ddee436166f311ddeed36d714b08f512670d16e --nonce 0` gives the same `0x30Ca...68dB`. It changes when the nonce does.
- `weightRequired.proofSize` can be 0 for code that touches no storage; the +10 percent limit then stays 0, and a second dry run with these exact limits succeeded.
- For EVM code, `data` must be `0x`: the constructor arguments go at the end of the init code (the chain refuses data with `EvmConstructorNonEmptyData`).

What can go wrong (each seen in a dry run on Nov 14, 2026):

- `the constructor reverted: 0x...`: decode the revert data (E26); init code `0x60006000fd` gives this.
- `Revive.StorageDepositLimitExhausted` (module 80, error 24): the deposit limit is below the peak deposit; a limit 1 base unit too low gave it (E7).
- `Revive.OutOfGas` (module 80, error 3): the weight limit is too low; half the weight gave it (E10).
- `Revive.StorageDepositNotEnoughFunds` (module 80, error 23): the account cannot pay the deposit (E7, E18).
- An `artifact.bytecode.object` that is empty (`0x`) is an interface or an abstract contract; one with `__$...$__` placeholders needs its libraries linked first.

Basis: **Proven**: a contract was deployed this way on Oct 19, 2026 (899 bytes, deposit 83.232 tPOT, fee 0.1285 tPOT). This exact script is **Assembled**: on Nov 14, 2026 it ran up to the signing step for init code of 1, 100 and 1000 bytes of runtime code and for a reverting constructor, and the limits passed a second dry run made with them. Not proven: a deployment with a salt, `uploadCode` followed by `instantiate`, and PolkaVM code.

Tool: `simulate_contract_deploy` does steps 1 and 2, and reads the artifact from a file inside the project folder (`artifact_path`; a network path is refused).

### 2f. Read why the node refuses an Ethereum transaction, without sending it

What it does: `eth_sendRawTransaction` answers every transaction the node refuses with the same bare `{"code":1010,"message":"Invalid Transaction"}` (E1). This script puts the signed transaction into the call `revive.ethTransact`, the way the Ethereum RPC hands it to the node, and asks the node's own pool check about that unsigned extrinsic. Nothing is sent. Use it on the `RAW` of recipe 2c, in place of `cast publish`.

```js
// why-refused.mjs: ask the node why it would refuse a signed Ethereum transaction, without sending it.
// Usage: node why-refused.mjs <the raw signed transaction, 0x...>
import { connect } from './v3.mjs';

const raw = process.argv[2]; // for example RAW from recipe 2c (cast mktx), before cast publish
if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(raw ?? '')) throw new Error('give the raw signed transaction as 0x hex');
const { api } = await connect('testnet');

// The Ethereum RPC hands a transaction to the node as an unsigned revive.ethTransact extrinsic (recipe 4, step 3).
const xt = api.tx.revive.ethTransact(raw); // not signed: length prefix, version byte 0x04, then the call
const at = (await api.rpc.chain.getFinalizedHead()).toHex();
// The pool's own check: source 0x02 (External, as for a sent transaction), the extrinsic, a block hash.
const arg = `0x02${xt.toHex().slice(2)}${at.slice(2)}`;
const out = await api.rpc.state.call('TaggedTransactionQueue_validate_transaction', arg, at);
const v = api.createType('Result<ValidTransaction, TransactionValidityError>', out);
if (v.isOk) console.log('valid: the node would take it into its pool');
else {
  const e = v.asErr;
  const reason = e.isInvalid ? `Invalid ${e.asInvalid.type}` : `Unknown ${e.asUnknown.type}`;
  console.log(`refused: ${reason} (${JSON.stringify(e.toHuman())})`);
}
await api.disconnect();
```

Run: `node why-refused.mjs "$RAW"`, with `RAW` from `cast mktx` (recipe 2c) or from `signTransaction` in viem or ethers.

What you should see (Nov 15, 2026, a 1 tPOT transfer of type 2 for chain id 420420777, gas limit = estimate + 10 percent, max fee = gas price + one eighth, signed by a new random key whose account was empty):

```
refused: Invalid Payment ({"Invalid":"Payment"})
```

- `Payment` is the balance check of E1: the account cannot pay value + gas limit x base fee (`eth_gasPrice`), or does not exist yet. Fund it with at least value + gas limit x max fee (the safer rule of E1's fix), or lower a padded gas limit to the estimate + 10 percent (E1).
- The same transfer signed for chain id 1 printed `refused: Invalid Call ({"Invalid":"Call"})`. In our measurements of Nov 15, 2026 the same check said `Call` for a blob (type 3) and a set-code (type 4) transaction too (E1).
- Bytes that are no Ethereum transaction at all (`0xdeadbeef`) also printed `Invalid Call`. `eth_sendRawTransaction` refuses such bytes itself, with `-32000` `Invalid transaction` (E35), so they never reach this check.
- The check is the node's, not the Ethereum RPC's. A legacy transaction without a chain id got `Payment` from it, although the RPC refuses that transaction before the node sees it (E35).
- An empty account fails the balance check first. A gas limit of 21000, a max fee of half the gas price and a nonce of 5, each signed by an empty account, all got `Payment`: from an empty account, the check does not show those mistakes.
- `api.tx.revive.ethTransact(raw)` without signing gives the unsigned extrinsic; its hex starts with the length prefix, then `04`. The argument of `TaggedTransactionQueue_validate_transaction` is put together by hand: the source byte, the extrinsic with its length prefix, the block hash.

Basis: **Proven**: on Nov 15, 2026 this exact script (with recipe 0 as `v3.mjs`) ran against the testnet, near block 475250, for three inputs: the type-2 transfer above (`Invalid Payment`), the same signed for chain id 1 (`Invalid Call`) and `0xdeadbeef` (`Invalid Call`). Each transaction came from a new random key held only in memory, whose account we checked was empty (balance 0, pending nonce 0) just before; nothing was sent. The other reasons above come from the same check, made the same way, during our measurements of Nov 15, 2026 (E1, E35). Not proven: the `valid` line (it needs an account that can pay), and what the check says for a funded account's other mistakes.

Tool: none of the chain tools makes this check yet; `estimate_eth_transaction` checks the balance rule before you sign.

---

## 3. Call a contract from a native account (revive.call)

What it does: calls a Solidity contract from a native (sr25519) account. The dry run alone answers a view call; for a state change it gives the weight and the deposit, and the script builds `revive.call` with the limits, checks the balance and signs.

```js
// call-native.mjs: call a Solidity contract from a native account (revive.call).
import { Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { connect } from './v3.mjs';

const { api } = await connect('testnet');
await cryptoWaitReady();
const phrase = process.env.V3_TEST_PHRASE; // a testnet-only account; never print it
if (!phrase) throw new Error('set V3_TEST_PHRASE to the secret phrase of a testnet-only account');
const pair = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromMnemonic(phrase);
const from = pair.address;

const contract = process.argv[2]; // the contract's 0x address
const data = process.argv[3];     // ABI calldata, for example from: cast calldata "approve(address,uint256)" <spender> <amount>
const value = 0n;                 // NATIVE base units (14 decimals); the contract sees msg.value = value x 10^4 wei

// 1. Dry run (this alone answers a view call). value, no weight limit, no deposit limit, calldata.
const dry = (await api.call.reviveApi.call(from, contract, value, null, null, data)).toJSON();
if (dry.result.err) {
  const m = dry.result.err.module;
  const name = m ? api.registry.findMetaError(Uint8Array.of(m.index, Number.parseInt(m.error.slice(2, 4), 16))) : null;
  throw new Error(name ? `${name.section}.${name.name}: ${name.docs.join(' ')}` : JSON.stringify(dry.result.err));
}
if ((dry.result.ok.flags.bits & 1) === 1) throw new Error(`the call reverts, revert data ${dry.result.ok.data}`);
console.log('returns', dry.result.ok.data); // decode with the function's ABI (cast abi-decode, viem decodeFunctionResult)

// 2. The limits: weight + 10 percent; deposit limit = the larger of the net and the peak deposit, + 2 percent.
const amount = (d) => (d?.charge !== undefined ? BigInt(d.charge) : -BigInt(d?.refund ?? 0)); // a refund counts as negative
const net = amount(dry.storageDeposit), peak = amount(dry.maxStorageDeposit ?? dry.storageDeposit);
const held = [net, peak, 0n].reduce((a, b) => (a > b ? a : b));
const depositLimit = held + held / 50n;
const rt = BigInt(dry.weightRequired.refTime), ps = BigInt(dry.weightRequired.proofSize);
const tx = api.tx.revive.call(contract, value, { refTime: rt + rt / 10n, proofSize: ps + ps / 10n }, depositLimit, data);
const fee = (await tx.paymentInfo(from)).partialFee.toBigInt();
const free = (await api.query.system.account(from)).data.free.toBigInt();
const need = value + depositLimit + fee + api.consts.balances.existentialDeposit.toBigInt();
console.log(`deposit ${net}, peak ${peak}, deposit limit ${depositLimit}, fee ${fee}, need ${need}, free ${free} (base units)`);
if (free < need) throw new Error('not enough tPOT for value + deposit limit + fee + 0.1 tPOT');

// 3. Sign and send, then wait for finality exactly as in recipe 1 (the Promise around signed.send).
const signed = await tx.signAsync(pair, { nonce: (await api.rpc.system.accountNextIndex(from)).toNumber() });
console.log('extrinsic hash', signed.hash.toHex()); // write it down before submitting
// ... signed.send(...) as in recipe 1. The contract's events are revive.ContractEmitted in System.Events (recipe 5c),
// not in eth_getLogs.
await api.disconnect();
```

Run: `node call-native.mjs <contract 0x address> <calldata>`.

What you should see before signing (Nov 14, 2026, the Treasury as `from`, an ERC-20 on the testnet):

- `decimals()` (`0x313ce567`): `returns 0x...0012` (18), deposit 0, fee about 0.0142 tPOT.
- `approve(spender, 10^18)`, which writes one new slot: `returns 0x...01`, then `deposit 384150000000000, peak 384150000000000, deposit limit 391833000000000, fee 2140498893864, need 403973498893864`: 3.8415 tPOT of deposit, a limit of 3.91833, a fee of 0.0214.
- An unknown selector (`0xdeadbeef`): `the call reverts, revert data 0x`.

- `value` is in native base units, not wei: 1 tPOT is `10n ** 14n` here, and the contract sees `msg.value` = 10^18 wei (E3). `msg.sender` is the caller's `0x` form (recipe 6).
- A view call needs no key: run step 1 with any address as `from` (as `simulate_contract_call` does). The guide makes the same dry run in the Node Console under Developer, Runtime calls, `reviveApi`, `call` (Guide).
- The deposit limit must cover the peak (`maxStorageDeposit`) even when the net charge is 0 (E7). A call that only frees storage shows a refund, and the script then passes the peak, which may be 0. A limit of 0 passed a dry run of a call that stores nothing, and gave `StorageDepositLimitExhausted` for `approve` (Checked Nov 14, 2026). Freeing storage was proven only through a call whose deposit netted 0 (Oct 20, 2026).
- Events from this call are not in `eth_getLogs`; read them from the node (recipe 5c, E6).
- Dry-run again right before sending: limits read earlier can change with the contract's state.

What can go wrong: a module error such as `Revive.StorageDepositLimitExhausted`, `Revive.OutOfGas` or `Revive.TransferFailed` (a value larger than the balance) (E7, E10); `Balances.InsufficientBalance`; a revert (decode the data, E26); `1010: Invalid Transaction: Inability to pay some fees` at submission (E1).

Basis: **Proven**: a contract call was sent this way from a native account on Oct 27, 2026 (weight 556697281 ref time and 32118 proof size, deposit 3.8415 tPOT, fee 0.0253 tPOT), and the same call has run inside `multisig.asMulti` (Oct 2026). This exact script is **Assembled**: on Nov 14, 2026 it ran up to the signing step for the three calls above, and `simulate_contract_call` gave the same limits and fee for `approve`. Not proven: a `result.err` that is not a module error.

Tool: `simulate_contract_call` runs step 1 and 2 and explains the result.

---

## 4. Call a native module from a 0x account (an Ethereum key)

What it does: lets an Ethereum key (MetaMask, a Foundry keystore) run any native call, for example `balances.transferKeepAlive` or `system.remarkWithEvent`. Send an Ethereum transaction to the runtime's pallets address `0x6d6f646c70792f70616464720000000000000000` (the text `modlpy/paddr`), with the SCALE-encoded call as `data` and no value.

Step 1, encode the call (read-only, no key):

```js
// encode-call.mjs: the SCALE bytes of a native call, for a 0x account to send to the pallets address. No key needed.
import { connect } from './v3.mjs';

const { api } = await connect('testnet');
const remark = api.tx.system.remarkWithEvent('native call from a 0x account, test 1').method.toHex();
const transfer = api.tx.balances.transferKeepAlive('5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z', 10n ** 12n).method.toHex(); // 0.01 tPOT
console.log(remark);
console.log(transfer);
// check what the bytes say before anyone signs them
console.log(JSON.stringify(api.createType('Call', transfer).toHuman()));
console.log(`pallets address ${(await api.call.reviveApi.runtimePalletsAddress()).toHex()}`);
await api.disconnect();
```

What you should see (Nov 14, 2026):

```
0x0007946e61746976652063616c6c2066726f6d2061203078206163636f756e742c20746573742031
0x0603006d6f646c70792f74727372790000000000000000000000000000000000000000070010a5d4e8
{"args":{"dest":{"Id":"5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z"},"value":"1,000,000,000,000"},"method":"transferKeepAlive","section":"balances"}
pallets address 0x6d6f646c70792f70616464720000000000000000
```

- The bytes are `[module index][call index][SCALE arguments]`: `00 07` is System's `remarkWithEvent` (call 0 is `remark`), `06 03` is Balances' `transferKeepAlive`, then `00` (the address kind `Id`), the 32-byte account id and the compact amount `070010a5d4e8` (10^12 base units = 0.01 tPOT).
- The same bytes are what a native account would sign: `api.tx(api.createType('Call', bytes))` rebuilds the transaction from them.

Step 2, send it with `send-eth.sh` from recipe 2c (the gas rule and the 1010 check, value 0):

```sh
TO=0x6d6f646c70792f70616464720000000000000000 \
DATA=0x0007946e61746976652063616c6c2066726f6d2061203078206163636f756e742c20746573742031 \
bash send-eth.sh
```

What you should see before signing (Nov 14, 2026): `estimate 1055685474923 gas, gas price 15685 wei; gas limit 1161254022415, max fee 17645; need 20490327225512675 wei, ...`: a cost of about 0.0166 tPOT, and the check asks for about 0.0205 tPOT.

Step 3, check both sides with recipe 5a (`eth-tx-both-sides.mjs` in `recipes.md`):

- The receipt shows `status 0x1`, `gasUsed 0`, `effectiveGasPrice 0` and no logs.
- On the node, the block with the same number holds an unsigned `revive.ethTransact` extrinsic carrying the raw transaction. Its events show the call ran as the account that holds the `0x` address's balance (for an Ethereum key, its fallback `5...` account, recipe 6): `balances.Withdraw`, then `system.Remarked { sender }` or `balances.Transfer { from, to, amount }`, then `transactionPayment.TransactionFeePaid` and `system.ExtrinsicSuccess`.

What can go wrong: the estimate answers `Failed to dispatch call: ...` when the native call itself would fail, for example `Token(FundsUnavailable)` when the account cannot pay an amount the call moves, or `BadOrigin` for a call that needs root (E29). It answers `Invalid call: Call` when the transaction carries a value, or when `data` is missing or not a call (E29). Error 1010 when the balance is below gas limit x max fee (E1). The fee is paid by the account that holds the `0x` address's balance, so fund that account (its fallback `5...` form for an Ethereum key). A call that fails shows its error in the node's events, not in the receipt; read them (recipe 5b, E10).

Basis: **Proven** for the route: two transactions from an Ethereum key on Nov 13, 2026, testnet blocks 452626 (`system.remarkWithEvent`, the first bytes above) and 452633 (`balances.transferKeepAlive` of 0.01 tPOT). Both were type 2 transactions with a priority fee of 0 and a max fee of 18140 wei (the gas price plus one eighth); gas limits of 1129572168498 and 1136535970904; fees of 0.0158 and 0.0159 tPOT; receipts with `gasUsed 0`; the effects in the node's events. Read again on Nov 14, 2026: the remark transaction's `data` is exactly the first bytes above, and keccak-256 of its raw transaction is its hash. The scripts are **Assembled**: on Nov 14, 2026 they ran up to the signing step (from the Treasury's `0x` form, and from an empty address, which the balance check refused). Not proven: sending a value with such a call (its estimate is refused, E29), sending `utility.batchAll` this way, and calls that need another origin, such as root. `eth_estimateGas` for `utility.batchAll` through the pallets address answered an estimate (Checked Nov 14, 2026: from the Treasury's `0x` form, data `0x01020400071468656c6c6f`, a batch of one `system.remarkWithEvent("hello")`, about 0.0136 tPOT); nothing was sent. That a sent batch works is Reported, not checked.

Tool: `encode_call` gives the bytes, echoes every argument as the chain reads it, and with a `0x` sender estimates this route; `estimate_eth_transaction` with this `to` and `data` gives the fields to copy.
