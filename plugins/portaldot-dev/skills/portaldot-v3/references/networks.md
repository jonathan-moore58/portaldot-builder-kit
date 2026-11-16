# Networks, endpoints and the state of the chain

What the two Portaldot V3 networks are, how to reach them and how they behave. Read it when you write connection code or wallet settings, or when requests fail.

Basis words: Checked (measured on the chain by the Bridge Zero team, on the date given), Experience (learned while building and running our own tools on this chain), Guide (the chain team's testnet guide), Reported (said by other builders, not checked by us).

## The two networks

Checked Nov 14, 2026 on both networks with @polkadot/api and the Ethereum JSON-RPC.

| | Testnet | Mainnet |
|---|---|---|
| Substrate RPC | `wss://test-node-v3.portaldot.dev` (also `https://`) | `wss://live-v3-node.portaldot.dev` (also `https://`) |
| Ethereum JSON-RPC | `https://test-evm-rpc-v3.portaldot.dev` (also `wss://`) | none public |
| Ethereum chain id | 420420777 (`0x190f1ca9`) | 780780777 (`0x2e89c4e9`), from `revive.chainId` |
| Token | tPOT, 14 decimals | POT, 14 decimals |
| `system_chain` | `PortaldotV3 Test` | `PortaldotV3 Live` |
| Runtime | `portaldot-v3` spec 3002, transactionVersion 2 | `portaldot-v3` spec 3001, transactionVersion 2 |
| Genesis hash | `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd` | `0x6e7f1f24628d2fa3a1ac81a8b45157c63b1037fee4123a7664aae2c55cdbbc36` |
| Explorer | `https://scanner-testnet-v3.portaldot.dev` | `https://scanner-live-v3.portaldot.dev` |
| Explorer API | `https://scanner-testnet-v3-api.portaldot.dev` | `https://scanner-live-v3-api.portaldot.dev` |

- Both runtimes use state version 1 and SS58 prefix 42. `system_properties` reports `tokenDecimals` 14 and `tokenSymbol` `tPOT` or `POT`.
- The chain id appears twice on the testnet: `api.consts.revive.chainId` and `eth_chainId` both give 420420777.

## The Ethereum RPC over WebSocket

Checked Nov 14, 2026 with a WebSocket client.

- `wss://test-evm-rpc-v3.portaldot.dev`, the same host as the HTTPS endpoint, answers JSON-RPC: `eth_chainId` gave `0x190f1ca9`.
- `eth_subscribe` takes `newBlockHeaders` and `logs` only. `["newBlockHeaders"]` sent one notification per block, and `eth_unsubscribe` returned `true`. `["logs", {}]` returned a subscription id; whether it delivers logs was not seen (no log was emitted while it was open).
- The standard name `newHeads` is refused: ``{"code":-32602,"message":"Invalid params","data":"unknown variant `newHeads`, expected `newBlockHeaders` or `logs` at line 1 column 10"}``. Libraries that watch blocks with `newHeads` over a WebSocket fail with this answer; give them the HTTPS endpoint and let them poll.
- Over HTTPS, `eth_subscribe` answers `{"code":-32603,"message":"Internal error"}`, and there are no filters (`eth_newFilter` is "Method not found"). `evm-checks.md` section 5 has the details.

## Check that you are on the right chain

Before any send, compare three values and refuse on a mismatch (Experience: our tools did this before every send).

- `api.genesisHash.toHex()` against the genesis hash above. A different value means a wrong endpoint or a reset testnet.
- `api.consts.revive.chainId` against 420420777 (testnet) or 780780777 (mainnet).
- `eth_chainId` from the Ethereum RPC against `0x190f1ca9`.
- Recipe 0 in `recipes.md` has the code; `get_chain_facts` does the same checks live.

## Blocks and finality

Checked Nov 14, 2026 unless marked.

- Block time: 6 seconds (`babe.expectedBlockTime` 6000 ms on both networks). The last 1000 blocks averaged 6.05 s on the testnet and 6.00 s on the mainnet.
- Finality: GRANDPA finalizes blocks about 2 blocks behind the best block (samples: testnet best 464131, finalized 464128; mainnet best 1077262, finalized 1077260). Wait for the finalized head, not the best block.
- GRANDPA authorities: 2 on each network, each with weight 1, so both must vote for a block to become final. `session.validators` and `staking.validators` hold 2 entries on each network.
- Sessions last 600 blocks (1 hour) and an era is 6 sessions (6 hours). On the testnet, era 130 was active 798.0 hours after block 1, about 6.1 hours per era; on the mainnet, era 300 after 1797.9 hours, about 6.0. The validator set can change at each era.
- On the Ethereum RPC, `eth_getBlockByNumber("finalized")` returned the node's finalized head in every sample, and `safe` returns the same block (`evm-checks.md` section 4).
- Testnet block 1 is dated Oct 12, 2026, 7:54 AM UTC; mainnet block 1 Aug 31, 2026, 4:00 PM UTC.

## The testnet halts

Checked Nov 14, 2026 from block timestamps; the same times were noted in October while running our tools (Experience).

- First halt: block 232115 at Oct 28, 2026, 12:45 PM UTC, then block 232116 at Oct 29, 2026, 2:09 AM UTC (13 hours 24 minutes without blocks).
- Second halt: block 265321 at Oct 31, 2026, 10:58 AM UTC, then block 265322 at 4:14 PM UTC (5 hours 16 minutes).
- What to do: before you blame your code, check that the head is moving (`get_chain_facts` compares the latest block's timestamp with the clock). Use timeouts and retries, and treat a send as pending until its block is finalized.
- Experience: our tools reconnect after 2.5 s, time a request out after 60 s, retry an HTTP request 3 times 2 s apart, and wait up to 10 minutes for finality before reporting a send as pending.
- We know of no status page or announcement channel for halts.

## The gas price on each network

- Testnet: `eth_gasPrice` was 38840 wei per gas on Oct 19, 2026, about 15700 wei on Nov 14, 2026 (it fell from 15825 to 15575 during that day) and 15130 to 15145 wei on Nov 15, 2026. Checked on each date; `amounts-and-fees.md` has the history.
- Mainnet: 5000 wei per gas on Nov 14, 2026, read through the node: `api.call.reviveApi.gasPrice()`, or the RPC `state_call` with `ReviveApi_gas_price` and `0x` (Checked). There is no `eth_gasPrice` to ask on the mainnet.
- The fee in tokens is about the same on both networks, so the gas numbers differ: an empty call from the Treasury's `0x` form to itself costs about 0.0123 tokens on both, estimated at 2460498146384 gas on the mainnet and 784539579017 on the testnet (Checked Nov 14, 2026; `evm-checks.md` section 9). Gas figures do not carry over between the networks.

## Admin key

- Both networks have a Sudo key set (Checked Nov 14, 2026, `api.query.sudo.key()`).
- The root origin can call privileged functions such as `revive.setCode`, which the chain documents as "Privileged function that changes the code of an existing contract" (Checked Nov 14, 2026, from the metadata). Keep this in mind when you judge what a contract on this chain can guarantee.

## Node and RPC surface

- Node: `PortaldotV3 Node` version `3.0.0-dev-fddd43141f2` on both networks (Checked Nov 14, 2026).
- The node lists 135 RPC methods on both networks (Checked Nov 14, 2026); "The 135 methods" below groups them. It answers no `eth_*` method, and `rpc_modules` is not supported.
  - Older counts: 125 methods on Oct 16, 2026; two surveys on Nov 13, 2026 counted 135 and 140.
- Archive state: both nodes served state at block 1 on Nov 13 and Nov 14, 2026, and the testnet node again on Nov 15, 2026 (read proofs and `archive_v1_*` calls at block 1) (Checked). Use `api.at(blockHash)` for old state.
- Ethereum RPC client: `eth-rpc/main-fddd431` (Checked Nov 14, 2026). On Nov 14, 2026 it served `eth_getBalance` and `eth_call` at blocks from 1 to the head, and block 1 itself. In October 2026 it refused state older than about 256 blocks; see `open-questions.md` item 1. `evm-checks.md` lists the methods it answers.
- `eth_getLogs` has no block-range limit: block 0 to the latest answered, in under a second with an address filter. A `fromBlock` after the `toBlock` answers `{"code":-32000,"message":"Failed to filter logs"}` (Checked Nov 14, 2026; `evm-checks.md` section 6).
- Request speed (Experience): one request at a time over the WebSocket gives about 19 answers a second; HTTP batches of 50 requests read 300 blocks in about 3 seconds. Keep load modest: these are shared public nodes.
- All public RPC endpoints are on `*.portaldot.dev` and run by the chain team (Checked Nov 13, 2026). A third-party gateway seen on Nov 13, 2026 forwards to these same hosts. Both testnet endpoints answer through Cloudflare, and the Ethereum RPC has nginx 1.24.0 behind it (Checked Nov 15, 2026, from the response headers and an error page).

### Limits of the public endpoints

Checked Nov 15, 2026 on the testnet. CORS, the batch of 101, the follow limit and the idle socket were measured twice; the rest once.

| | Ethereum RPC | Substrate node |
|---|---|---|
| CORS | `access-control-allow-origin: *` on preflight and on POST, with `allow-headers` and `allow-methods` `*` on preflight; the WebSocket upgrade with another site's `Origin` was accepted | the same |
| JSON-RPC batch | 101 calls answered whole (the largest tried) | the same |
| Request body | 1,000,128 bytes passed; 2,000,128 bytes got HTTP 413 as an nginx HTML page (`<title>413 Request Entity Too Large</title>`, `nginx/1.24.0 (Ubuntu)`), not JSON-RPC (E52) | not measured |
| WebSocket connections | 10 held open together by one client; more not tried | the same |
| Subscriptions on one connection | 20 `eth_subscribe` `["newBlockHeaders"]` | 20 tried, all accepted except a 5th `chainHead_v1_follow`: `{"code":-32800,"message":"Maximum number of chainHead_follow has been reached"}` (E52) |
| Idle WebSocket | the server pings every 30 s; a socket idle for 125 s stayed open | the same |
| Rate limits | no 429, 503 or rate-limit header in 264 requests; none provoked | the same |

- A page on any origin can call either endpoint directly. Keep each HTTP request under 1 MB.
- The largest answers met arrived whole: `state_getMetadata` (1,123,870 bytes over HTTP, and in one WebSocket message) and `grandpa_proveFinality` of block 1 (about 1.8 MB of JSON). Set long timeouts and large frame limits.

### Proofs and finality data

Checked Nov 15, 2026 on the testnet node.

| Method | What it gave |
|---|---|
| `state_getReadProof` | proofs at the finalized block, 300 and 3000 blocks back, and at block 1. The nodes hash to the Substrate header's `stateRoot`; the Ethereum block's `stateRoot` is not a state root (`evm-checks.md` section 5) |
| `state_getChildReadProof` | contract storage proofs at the finalized block and 3000 back. The child key is `:child_storage:default:` + the `trieId` from `revive.accountInfoOf`; `childstate_getKeysPaged` lists the keys |
| `grandpa_proveFinality` | proofs at every depth tried: 2.5 to 2.7 kB 5 blocks back, 752,767 bytes 3000 back, 908,075 bytes for block 1 |
| `grandpa_roundState`, `grandpa_subscribeJustifications` | answer: set id 134, threshold weight 2 of 2; 7 or 8 justifications in 30 to 40 s |
| `beefy_getFinalizedHead`, `beefy_subscribeJustifications` | answer: the BEEFY head was 3 and 5 blocks behind GRANDPA in two samples; BEEFY began at block 1 (`BeefyApi_beefy_genesis`) |
| `mmr_root` | answers |
| `mmr_generateProof` | `{"code":8011,"message":"Leaf was not found","data":"LeafNotFound"}` for every block tried, recent and old; `MmrApi_generate_proof` through `state_call` fails with a trap ("local_storage_get can be called only in the offchain call context"). The node probably runs without offchain indexing (our reading): no MMR proofs from it (E52) |
| `chain_getBlock` justifications | `null` in recent blocks; blocks 477696 and 477184 held a GRANDPA justification (the first also a BEEFY one), as JSON arrays of byte values, not hex. Subscribe instead of reading blocks |

### archive_v1 and chainHead_v1

Checked Nov 15, 2026 on the testnet node.

- `archive_v1_finalizedHeight` answers, and `archive_v1_hashByHeight`, `archive_v1_header` and `archive_v1_call` answered at block 1. `archive_v1_storage` is a subscription: over WebSocket it returns an id, then `storage` and `storageDone` events.
- `chainHead_v1_call` needs a follow opened with `[true]`; with `[false]` it answers ``{"code":-32802,"message":"The `chainHead_follow` subscription was started with `withRuntime` set to `false`"}``. `chainHead_v1_header` and `chainHead_v1_storage` work only for blocks the follow has pinned (recent ones); a block 3000 back answered `{"code":-32801,"message":"Invalid block hash"}`, so use `archive_v1_*` or `state_*` with a block hash for older blocks. At most 4 follows per connection (above).

### Dry runs on the node

- `system_dryRun` and `system_dryRunAt` answer on the public testnet node today (Checked Nov 15, 2026). Many public nodes do not serve these two methods, so do not depend on them: this node may stop serving them.
- `system_dryRun` of signed bytes runs the whole transaction, the call included, and changes nothing (nonce and balance were the same afterwards). For a funded key it answered `0x0000` (Ok) for a remark, `0x00010700` for a transfer above the balance (`Token(FundsUnavailable)`), and `0x0001032701000000` for an `Assets.transfer` of an asset the account never held (`Assets.NoAccount`, module 39 error 1). A `utility.batch` with a failing call inside answered `0x0000`: an inner failure shows only in events, which a dry run does not return (Checked Nov 15, 2026, nothing sent).
  - It checks the signature and the fee first: an empty account gets `0x010001` (`Invalid(Payment)`) and a broken signature `0x010004` (`Invalid(BadProof)`), so it helps only with a key you hold that can pay.
  - Decode with the chain's own error types: @polkadot/api's built-in `ApplyExtrinsicResult` prints `0x00010700` with the old name `NoFunds`.
- The runtime has no `DryRunApi`: `{"code":4003,"message":"Client error: Execution failed: Other: Exported method DryRunApi_dry_run_call is not found"}` (E51). For an account you cannot sign for, dry-run the call with `eth_estimateGas` from its `0x` form to the pallets address (E29).

### Data stored with TransactionStorage

Checked Nov 15, 2026 on the testnet node.

- `bitswap_v1_get` with a CIDv1 returns the stored bytes as `0x` hex, over plain JSON-RPC. The CID is `b` + base32 (lower case, no padding) of `0x01 0x55 0xa0 0xe4 0x02 0x20` + the entry's `contentHash`; check that blake2-256 of the bytes equals `contentHash`. Passing the `contentHash` itself answers `{"code":-32602,"message":"Invalid CID: Failed to parse multihash","data":{"variant":"InvalidCid"}}`.
- To find entries, read `TransactionStorage.Transactions(block)`, or call `TransactionStorageApi_indexed_transactions` through `state_call` with the block number as a little-endian u32. Big-endian bytes, which @polkadot/types `createType('u32', n).toHex()` gives, ask for another block and answer `0x00`.
- `RetentionPeriod` is 100800 blocks, about 7 days; `renew` keeps an entry. Data stored at block 279419 and renewed since was still served about 198,500 blocks later. Whether data past its retention is served is not known, and the archive node keeps the block bodies that carry it: treat stored data as public and permanent.
- Fees: `amounts-and-fees.md` (Native fees). A dry run of a valid `store` or `renew` answers `BadContext` (E53).

### The 135 methods

Testnet node, `rpc_methods`, Checked Nov 15, 2026 (block 477764).

| Group | Methods |
|---|---|
| `chain_*` (19) | blocks, headers, hashes, the finalized head (both spellings, `Finalised` and `Finalized`), and subscriptions to new and finalized heads and to the runtime version |
| `state_*` (25) | storage, keys, pairs, metadata, the runtime version, `state_call`, `state_getReadProof`, `state_getChildReadProof`, `state_queryStorage`, `state_traceBlock`, storage subscriptions |
| `childstate_*` (7) | child-trie keys, values, hashes and sizes (contract storage) |
| `system_*` (20) | chain name, properties, health, version, `system_accountNextIndex`, `system_dryRun`, `system_dryRunAt`, and others |
| `author_*` (10) | submit and watch transactions, `author_pendingExtrinsics`, and others |
| `archive_v1_*` (10), `chainHead_v1_*` (9), `chainSpec_v1_*` (3), `transaction_v1_*` (2), `transactionWatch_v1_*` (2) | the newer JSON-RPC interface |
| `grandpa_*` (4), `beefy_*` (3), `mmr_*` (5), `babe_epochAuthorship` | finality and consensus |
| `payment_queryInfo`, `payment_queryFeeDetails` | fees |
| `bitswap_v1_get` | TransactionStorage data |
| `statement_*` (3), `sync_state_genSyncSpec`, `account_nextIndex`, `subscribe_newHead`, `unsubscribe_newHead`, `rpc_methods`, and four more | others |

## Explorers and consoles

- The official explorers (table above) show the Substrate side: blocks, extrinsics, events, accounts. They have no Ethereum transaction view, no contract pages and no source verification (Checked Nov 13, 2026). Both answered HTTP 200 on Nov 14, 2026.
- Explorer APIs (table above): the paths `/blocks`, `/extrinsics`, `/events`, `/overview`, `/status` and `/runtimes` work; `/graphql`, `/contracts` and `/assets` answer 404 (Checked Nov 14, 2026).
- The API filters by method name: `/extrinsics?method=<call>&page=<n>` (for example `transferKeepAlive`) and `/events?method=<Event>&page=<n>` (for example `Instantiated`, `EthExtrinsicRevert`, `ContractEmitted`). It returns 10 items a page, each with its block and index; extrinsics carry `isSuccess` (Checked Nov 14, 2026).
  - The method filter returned incomplete lists on Nov 14, 2026 (Checked; recipe 5d in `recipes.md` gives the cases): `/extrinsics?method=ethTransact` returned an empty list, the extrinsic list held signed extrinsics only, and the newest `Instantiated` and `EthExtrinsicRevert` events listed were older than ones on the chain. `/events?method=ExtrinsicFailed` returned an empty list too. Do not take an empty or short answer as proof that nothing happened; read the block on the node by its number (`get_block`).
- Link formats (Experience): `https://scanner-testnet-v3.portaldot.dev/#/extrinsics/<block>-<index>` and `/#/events/<block>-<index>`.
- The Node Console, a polkadot.js Apps build, opens a testnet block at `https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/<block>` (Experience; the site answered HTTP 200 on Nov 14, 2026). Its Developer menu has storage queries and runtime calls.
- None of these looks up an Ethereum `0x` transaction hash (Checked Nov 13, 2026). Use `eth_getTransactionReceipt`, then open the block by number, or call `get_transaction`.

## MetaMask and other Ethereum wallets

- Settings (Experience): network name of your choice, RPC `https://test-evm-rpc-v3.portaldot.dev`, chain id 420420777, currency symbol tPOT, block explorer left empty. The wallet shows 18 decimals.
- The testnet guide gives an older RPC address and the symbol `tPOTv3`; the chain's own symbol is `tPOT` (Guide, compared with the chain on Nov 14, 2026).
- No public chain list (chainid.network, ethereum-lists, chainlist.org) has an entry for 420420777, so wallets offer no one-click "add network": type the settings by hand (Checked Nov 13, 2026).
- The mainnet has no public Ethereum RPC, so a wallet cannot use the mainnet's Ethereum side (Checked Nov 13, 2026: the node answers no `eth_` method and the official wallet list gives the mainnet no EVM settings; on Nov 14, 2026 the node still answered no `eth_` method).

## Test tokens

- There is no self-serve official faucet (Checked Nov 13, 2026). Builders report getting tPOT through a ticket on the chain team's Discord (Reported).
- If a faucet pays only `5...` addresses and your wallet shows `0x`, convert the `0x` address to its fallback `5...` form first (`convert_address`, or `addresses.md`).
- To fund a MetaMask address from a native wallet, send tPOT to its fallback `5...` form. The guide finds that address in the Node Console under Developer, Runtime calls, `reviveApi`, `accountId` (Guide).
- Deployments need tens to hundreds of tPOT of storage deposit (`amounts-and-fees.md`). Dry-run first so you know what to ask for.

## Documentation

- For V3, use the chain team's testnet guide together with what the chain itself reports (metadata, constants, the tools of this plugin).
- The documentation site `portaldot-dev.readthedocs.io` describes the chain before V3 (endpoint `wss://mainnet.portaldot.io`, spec 1002, the Contracts module 3.0.0); it does not cover Revive, the Ethereum RPC or the chain ids (Checked Nov 13, 2026).
- The testnet guide lists endpoints on `feso-apps.xyz` (`wss://testnetv3-node.feso-apps.xyz`, `https://testnetv3-eth-rpc.feso-apps.xyz`, and `node-console.feso-apps.xyz`). They answered HTTP 502 on Oct 10, 2026, and none of the three host names resolved on Nov 14, 2026 (`ENOTFOUND`; Checked). Use the `portaldot.dev` endpoints.
- The guide's V3.0 feature list names modules the runtime does not have (`native-modules.md`).

## Runtime history

Checked Nov 14, 2026 with `state_getRuntimeVersion` at the boundary blocks and the explorer API's `/runtimes`.

- Testnet: spec 3000 from block 1, 3001 from block 50000, 3002 from block 57052.
- Mainnet: spec 3000 from block 1, 3001 from block 660453.
- Module counts from `/runtimes`: testnet 3002 and mainnet 3001 both have 69 modules, 480 calls, 494 events, 352 storage items and 228 constants. Testnet 3000, testnet 3001 and mainnet 3000 have 70 modules, 486 calls, 498 events, 355 storage items and 229 constants.
- So the number 3001 probably names a different runtime on each network (our reading of the counts). On Nov 13, 2026 the module lists of testnet 3002 and mainnet 3001 were identical, and on Nov 14, 2026 so were their Revive calls, errors, constants (apart from the chain id) and transaction extensions.
- Besides `system.version`, 13 runtime constants differ between the two networks, among them the chain ids, some deposits of Assets, PoolAssets, Uniques and Nfts, and `treasury.spendPeriod` (Checked Nov 14, 2026); `native-modules.md` lists them.
- After a runtime upgrade, decode a block's events with the metadata of its parent block; `api.at(hash)` does this (Experience).

## What is on the mainnet

- Checked Nov 14, 2026: 1227 accounts, all native and all linked to their `0x` form; no contract code (`revive.codeInfoOf` and `revive.accountInfoOf` empty), no assets, no NFT collections, no AssetConversion pools and no identities.
- Ethereum-side work (MetaMask, Foundry, Hardhat) therefore happens on the testnet. The node's runtime API still answers the Ethereum-side questions (balances, gas price, estimates, dry runs) on the mainnet, and the chain tools use it there.
