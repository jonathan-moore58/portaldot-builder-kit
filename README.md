# Portaldot Builder Kit

by the Bridge Zero team

Checked facts and read-only chain tools for building on Portaldot V3, packaged as a plugin for Claude Code.

This is an independent project. The Portaldot team did not make it and does not endorse it.

## Why it exists

Portaldot V3 looks like Polkadot on one side and like Ethereum on the other. In a few places it behaves like neither, and those places cost money:

- **Two address forms.** A native account has an address that starts with `5`. Contracts and MetaMask use `0x` addresses. The two are linked by a rule, not by a shared key, and funds sent to the wrong form can be stuck.
- **Two scales.** Native amounts have 14 decimals. The Ethereum side shows the same token with 18. A value copied from one side to the other is wrong by a factor of 10,000.
- **Gas includes a storage deposit.** Estimates look enormous, and the node refuses a transaction (error 1010) when the gas limit asks for more than the sender's balance.
- **Events can hide.** `eth_getLogs` does not return the events a contract emits when it is called from the native side.

An assistant that answers from Polkadot or Ethereum habits gets these wrong. This plugin gives it measured facts and the tools to check the live chain instead.

## What is inside

**Chain tools.** An MCP server named `chain` with fifteen read-only tools:

| Tool | What it answers |
| --- | --- |
| `get_chain_facts` | Endpoints, chain ids, decimals, the gas price and constants read live, whether the chain is producing blocks, and whether safe mode is on or a call is paused |
| `search_chain` | Which module, call, event, error, constant or stored value does a job, by everyday words or by name |
| `describe_item` | A call's exact arguments and what each means, its indices, sample code; or a whole module |
| `convert_address` | Both forms of an address, whether they are linked on the chain, and which form to use where |
| `get_account` | Balances in both forms, the nonce, and contract details |
| `convert_amount` | Tokens, native base units and wei, converted exactly |
| `read_storage` | Any stored value or constant, or a page of a map |
| `encode_call` | The exact bytes of a call, a fee estimate, the chain's own answer to it by dry run when you name a sender, and how a `0x` account can send a native call |
| `estimate_eth_transaction` | Gas, the real cost in tokens, and whether the node would refuse the transaction |
| `simulate_contract_call` | A dry run of a contract call: return value, revert reason, limits to pass |
| `simulate_contract_deploy` | A dry run of a deployment: the address, the deposit, the limits |
| `get_transaction` | One transaction seen from both sides. It accepts an Ethereum `0x` hash |
| `get_block` | A block's extrinsics and events |
| `get_contract_events` | A contract's events from both sides, including the ones `eth_getLogs` does not serve (at most 50 blocks per call) |
| `explain_error` | What an error text or code means on this chain, and what to do |

**A knowledge pack.** The skill `portaldot-v3`: the rules that prevent the costly mistakes, proven recipes, a list of errors and traps, a table of what native calls answer to common mistakes, and measurements of what the EVM and the Ethereum RPC really do on this chain.

**Every fact says how it is known.** *Checked* means we measured it on the chain, with the date. *Experience* means we learned it while building and running our own tools there. *Guide* means it comes from the chain team's testnet guide. *Reported* means other builders said it and we did not check it.

## Install

You need Claude Code, Node.js 20 or newer on your PATH (we ran it only on Node.js 24), and git.

```
claude plugin marketplace add jonathan-moore58/portaldot-builder-kit
claude plugin install portaldot-dev@bridge-zero
```

In a session, `/mcp` then lists `plugin:portaldot-dev:chain`.

To try it without installing, clone this repository and start Claude Code with the plugin folder:

```
claude --plugin-dir ./plugins/portaldot-dev
```

## Things to ask

- "Send 2.5 tPOT from my Substrate account to this MetaMask address. Which address and which amount do I pass?"
- "My MetaMask transaction fails with error 1010. Why?"
- "Which call mints an NFT here, and what are its arguments?"
- "What will it cost to deploy this contract? Dry-run it."
- "What happened in transaction 0x...?"
- "eth_getLogs returns nothing for my event. Where is it?"

## What it never does

- No tool asks for a private key or a secret phrase, and none signs or sends a transaction. The most a tool returns is unsigned call data for you to sign in your own wallet or script.
- A secret phrase in any argument is refused before anything is sent. A private key cannot be told apart from an account id (both are 0x and 64 hex characters), so never paste one: it would go to the node as a lookup.
- It connects only to the public Portaldot endpoints, or to the ones you set under Settings, and only when a tool is used; when `HTTPS_PROXY` or `HTTP_PROXY` is set, it reaches them through that proxy (see Cloud sessions and proxies). A connection that is idle for five minutes is closed.
- The addresses, call data and bytecode you ask about are sent to those public nodes. Nothing is sent to us. There is no telemetry.
- It writes no files. One tool, `simulate_contract_deploy`, can read a build artifact that you name.

## Settings

The server works without any. These environment variables change its endpoints:

| Variable | Meaning |
| --- | --- |
| `PORTALDOT_DEFAULT_NETWORK` | `testnet` (the default) or `mainnet` |
| `PORTALDOT_TESTNET_WS`, `PORTALDOT_MAINNET_WS` | Another Substrate WebSocket endpoint |
| `PORTALDOT_TESTNET_EVM`, `PORTALDOT_MAINNET_EVM` | Another Ethereum JSON-RPC endpoint |

The server compares the genesis hash of the node it reaches with the recorded one, and warns when they differ.

### Cloud sessions and proxies

A cloud session (Claude Code on the web) reaches only the hosts its environment's network settings allow. Unless the environment allows every host, add these three to its allowed hosts; otherwise the chain tools cannot connect (we have not yet run the plugin inside a cloud session):

- `test-node-v3.portaldot.dev`
- `test-evm-rpc-v3.portaldot.dev`
- `live-v3-node.portaldot.dev`

Behind a proxy the server follows `HTTPS_PROXY` and `HTTP_PROXY`, and by Node.js's rules `NO_PROXY`, through the proxy support built into Node.js (the plugin sets `NODE_USE_ENV_PROXY=1` for its server). We checked `HTTPS_PROXY` with a local proxy on Node.js 24.12 on Nov 15, 2026: with the setting, the node and the Ethereum RPC were reached through the proxy, and without it they were not. `NO_PROXY` and a cloud session itself were not tested. A Node.js version without that support ignores the setting. With `NODE_OPTIONS=--no-experimental-websocket` the WebSocket to the node does not use the proxy.

## Develop

```
cd server-src
npm ci
npm run typecheck
npm run test:unit      # no network
npm run test:live      # reads the live chains
npm run build          # writes plugins/portaldot-dev/server/index.mjs and its third-party notices
npm run test:server    # the built server, over stdio
```

- `node scripts/gen-knowledge.mjs` rebuilds the error list and the table of native-call replies inside the server from `references/errors.md` and `references/native-call-errors.md` (in `plugins/portaldot-dev/skills/portaldot-v3/`).
- `node scripts/gen-metadata.mjs` saves the chains' runtime metadata into the source, so a session does not download it. It needs both networks to be reachable and stamps the day it ran. Run it after a runtime upgrade. Until then the server downloads the new metadata by itself: it is slower to start, and it still reads the new runtime.
- `node scripts/call.ts <tool> '<json>'` runs one tool from source.
- `third-party-licences/` holds the licence texts that cannot be read from `node_modules`: packages that arrive inside another package's build files, and one that ships no licence file. The build stops when a text is missing.

The built server is one file with no dependencies to install. Node.js 24 runs the TypeScript source directly; the tests need it. Node.js 24 is also the only version the server was run on.

## How it was checked

Numbers from November 15, 2026, on Node.js 24 and Windows:

- 192 unit tests, with no network.
- 126 live tests, which read the testnet and the mainnet.
- 150 checks of the built server over stdio, in both protocol modes of the MCP client.
- A copy without `node_modules` builds to the same file, byte for byte.
- 12 developer questions, each asked twice with the plugin and twice without it (Claude Opus; the run without the plugin could search the web). With the plugin 24 of 24 answers were right; without it 16 of 24. The questions and their graders are in `plugins/portaldot-dev/evals/`. This repeats the run: `claude plugin eval plugins/portaldot-dev --runs 2 --allow-real-servers --allow-tools "mcp__plugin_portaldot-dev_chain__*" WebSearch WebFetch --model opus --judge-model opus`. It starts the real chain server, which reads the public testnet, and it uses your own Claude account.

What was not checked: other Node.js versions, Linux and macOS, and deploying by Ethereum transaction, with Hardhat, `forge create` or anything else (our deployments used native calls; our own Ethereum transactions were contract calls sent with `cast` and native calls through the pallets address).

Two limits to know:

- `simulate_contract_deploy` reads a build artifact only from inside the project folder.
- A user name and password in a WebSocket endpoint are not sent by the WebSocket built into Node.js 22 and later; the error message says what to set.

## Status

Version 0.2.1, November 2026. It supports Claude Code, checked on version 2.1.325; much older versions reject the plugin's manifest. Other assistants may follow.

The chain changes, so every fact carries its date. If you find something that is wrong or out of date, please open an issue at https://github.com/jonathan-moore58/portaldot-builder-kit/issues.

## Licence

Apache-2.0. See [LICENSE](LICENSE). The bundled server contains third-party packages, whose notices are in [plugins/portaldot-dev/server/THIRD-PARTY-NOTICES.txt](plugins/portaldot-dev/server/THIRD-PARTY-NOTICES.txt).
