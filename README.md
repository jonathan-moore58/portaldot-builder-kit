# Portaldot Builder Kit

by the Bridge Zero team

[![CI](https://github.com/jonathan-moore58/portaldot-builder-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/jonathan-moore58/portaldot-builder-kit/actions/workflows/ci.yml)

Measured facts and read-only chain tools for building on Portaldot V3. It is a plugin for Claude Code, and an MCP server that other coding assistants can load.

This is an independent project. The Portaldot team did not make it and does not endorse it.

## Why it exists

Portaldot V3 looks like Polkadot on one side and like Ethereum on the other. In a few places it behaves like neither, and those places cost money:

- **Two address forms.** A native account has an address that starts with `5`. Contracts and MetaMask use `0x` addresses. The two are linked by a rule, not by a shared key, and funds sent to the wrong form can be stuck.
- **Two scales.** Native amounts have 14 decimals. The Ethereum side shows the same token with 18. A value copied from one side to the other is wrong by a factor of 10,000.
- **Gas includes a storage deposit.** Estimates look enormous, and the node refuses a transaction (error 1010) when gas limit x base fee is more than the sender can spend.
- **A failure costs money, and waiting is invisible.** A transaction that fails in its block still pays its fee. A transaction that waits for its block cannot be seen through the Ethereum RPC at all.
- **Events can hide.** `eth_getLogs` does not return the events a contract emits when it is called from the native side.

An assistant that answers from Polkadot or Ethereum habits gets these wrong. This kit gives it facts that were measured on the chain, and the tools to check the live chain instead of guessing.

## What is inside

**Chain tools.** An MCP server named `chain` with sixteen read-only tools:

| Tool | What it answers |
| --- | --- |
| `get_chain_facts` | Endpoints, chain ids, decimals, the gas price and constants read live, whether the chain is producing blocks, and whether safe mode is on or a call is paused |
| `search_chain` | Which module, call, event, error, constant or stored value does a job, by everyday words or by name |
| `describe_item` | A call's exact arguments and what each means, its indices, sample code; or a whole module |
| `convert_address` | Both forms of an address, whether they are linked on the chain, and which form to use where |
| `get_account` | Balances in both forms, the nonce, whether a transaction of the account waits for its block, and contract details |
| `convert_amount` | Tokens, native base units and wei, converted exactly |
| `read_storage` | Any stored value or constant, or a page of a map |
| `encode_call` | The exact bytes of a call, a fee estimate, the chain's own answer to it by dry run when you name a sender, and how a `0x` account can send a native call |
| `estimate_eth_transaction` | Gas, the real cost in tokens, and what the node will do with the transaction: take it, refuse it, or include it and let it fail |
| `simulate_contract_call` | A dry run of a contract call: return value, revert reason, limits to pass |
| `simulate_contract_deploy` | A dry run of a deployment: the address, the deposit, the limits |
| `get_transaction` | One transaction seen from both sides, by its Ethereum `0x` hash or its native hash. One that still waits is found in the node's pool |
| `get_block` | A block's extrinsics and events |
| `get_contract_events` | A contract's events from both sides, including the ones `eth_getLogs` does not serve (at most 50 blocks per call) |
| `explain_error` | What an error text or code means on this chain, and what to do |
| `read_guide` | The kit's knowledge by section: the contents, one section in full (an id, a file name, or "E12", "recipe 4", "2f"), or a search |

**A knowledge pack.** The skill `portaldot-v3`: the rules that prevent the costly mistakes, proven recipes, a list of 55 errors and traps, a table of what native calls answer to 142 common mistakes, and measurements of what the EVM, the Ethereum RPC and the public endpoints really do on this chain.

**A start guide.** The skill `portaldot-start` takes a developer from an idea to a first working result on the testnet: live checks first, at most three questions, the cost of every step before any code, then a short plan with a dry run before every send and a check after it. It has a blueprint for each of eleven kinds of project: a token, an NFT collection, a swap or DEX, payments and payouts, an escrow, a multisig or treasury, staking, a dApp front end, a bot or indexer, stored data, and a bridge or oracle.

**For any MCP client.** The server carries the knowledge pack by itself, for assistants that have no skills: the tool `read_guide`, each knowledge file as a resource at `portaldot://guide/<name>`, and the start guide as the prompt `start_project`.

**Every fact says how it is known.** *Checked* means we measured it on the chain, with the date. *Experience* means we learned it while building and running our own tools there. *Guide* means it comes from the chain team's testnet guide. *Reported* means other builders said it and we did not check it.

## Install

### Claude Code

You need Claude Code, Node.js 20 or newer on your PATH, and git.

```
claude plugin marketplace add jonathan-moore58/portaldot-builder-kit
claude plugin install portaldot-dev@bridge-zero
```

In a session, `/mcp` then lists `plugin:portaldot-dev:chain`. To start a project, say what you want to build, or run `/portaldot-dev:portaldot-start`.

To try it without installing, clone this repository and start Claude Code with the plugin folder:

```
claude --plugin-dir ./plugins/portaldot-dev
```

### Other assistants

The chain tools are an ordinary MCP server on stdio, so other coding assistants can load them too. You need Node.js 20 or newer, and git. There are two ways to start the server:

- **A local copy (recommended).** Clone this repository and point your assistant at `node /absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs`. It starts in about a second; `git pull` updates it.
- **npx, nothing to clone.** `npx -y github:jonathan-moore58/portaldot-builder-kit`. npm fetches the package at every start: in our tests on Windows, from a local git copy, that took 14 to 16 seconds, and 42 seconds the first time. Some assistants stop waiting sooner. Always write the `github:` form: we do not publish this package on the npm registry.

Many assistants take this shape (the page below has the exact one for each):

```json
{
  "mcpServers": {
    "portaldot": {
      "command": "node",
      "args": ["/absolute/path/to/portaldot-builder-kit/plugins/portaldot-dev/server/index.mjs"]
    }
  }
}
```

[docs/other-assistants.md](docs/other-assistants.md) gives the settings for VS Code with GitHub Copilot, Cursor, Codex, Claude Desktop, GitHub Copilot CLI, Gemini CLI, JetBrains AI Assistant and Junie, Devin Desktop, Cline, Zed, Kiro, opencode, Goose and Continue: where they go, Windows notes, start-up limits, what each assistant does with the server's instructions, prompt and resources, and a short text for your project's `AGENTS.md`. Those sections come from each assistant's own documentation; we have not run those assistants ourselves.

## Things to ask

- "I want to build an escrow that is paid in pUSD. Where do I start?"
- "Send 2.5 tPOT from my Substrate account to this MetaMask address. Which address and which amount do I pass?"
- "My MetaMask transaction fails with error 1010. Why?"
- "Is my transaction still waiting? `eth_getTransactionByHash` returns null."
- "Which call mints an NFT here, and what are its arguments?"
- "What will it cost to deploy this contract? Dry-run it."
- "What happened in transaction 0x...?"
- "My token's Transfer logs do not add up to the balances. Why?"
- "eth_getLogs returns nothing for my event. Where is it?"

## What it never does

- No tool asks for a private key or a secret phrase, and none signs or sends a transaction. The most a tool returns is unsigned call data for you to sign in your own wallet or script.
- A secret phrase in any argument is refused before anything is sent. A private key cannot be told apart from an account id (both are 0x and 64 hex characters), so never paste one: it would go to the node as a lookup.
- It connects only to the public Portaldot endpoints, or to the ones you set under Settings, and only when a tool is used; when `HTTPS_PROXY` or `HTTP_PROXY` is set, it reaches them through that proxy (see Cloud sessions and proxies). A connection that is idle for five minutes is closed.
- The addresses, call data and bytecode you ask about are sent to those public nodes. Nothing is sent to us. There is no telemetry.
- It writes no files. One tool, `simulate_contract_deploy`, can read a build artifact that you name.

[SECURITY.md](SECURITY.md) says the same in more detail, and how to report a security problem.

## Settings

The server works without any. These environment variables change its endpoints:

| Variable | Meaning |
| --- | --- |
| `PORTALDOT_DEFAULT_NETWORK` | `testnet` (the default) or `mainnet` |
| `PORTALDOT_TESTNET_WS`, `PORTALDOT_MAINNET_WS` | Another Substrate WebSocket endpoint |
| `PORTALDOT_TESTNET_EVM`, `PORTALDOT_MAINNET_EVM` | Another Ethereum JSON-RPC endpoint |

The server compares the genesis hash of the node it reaches with the recorded one, and warns when they differ. It also warns when the chain runs another runtime version than the one our dated facts were measured on.

### Cloud sessions and proxies

A cloud session (Claude Code on the web) reaches only the hosts its environment's network settings allow. Unless the environment allows every host, add these three to its allowed hosts; otherwise the chain tools cannot connect (we have not yet run the plugin inside a cloud session):

- `test-node-v3.portaldot.dev`
- `test-evm-rpc-v3.portaldot.dev`
- `live-v3-node.portaldot.dev`

Behind a proxy the server follows `HTTPS_PROXY` and `HTTP_PROXY`, and by Node.js's rules `NO_PROXY`, through the proxy support built into Node.js. The Claude Code plugin sets `NODE_USE_ENV_PROXY=1` for its server; in another assistant's settings, put `"NODE_USE_ENV_PROXY": "1"` into the server's environment yourself. We checked `HTTPS_PROXY` with a local proxy on Node.js 24.12 on Nov 15, 2026: with the setting, the node and the Ethereum RPC were reached through the proxy, and without it they were not. `NO_PROXY` and a cloud session itself were not tested. A Node.js version without that support ignores the setting. With `NODE_OPTIONS=--no-experimental-websocket` the WebSocket to the node does not use the proxy.

## Develop

```
cd server-src
npm ci                 # needs npm 11, which comes with Node.js 24; with Node.js 22: npx -y npm@11.6.2 ci
npm run typecheck
npm run test:unit      # no network
npm run test:smoke     # the built server over stdio, no network; runs on Node.js 20 too
npm run test:live      # reads the live chains
npm run build          # writes plugins/portaldot-dev/server/index.mjs and its third-party notices
npm run check:bundle   # fails when the committed bundle is not what the source builds
npm run test:server    # the built server, over stdio, against the live chains
```

- `node scripts/gen-knowledge.mjs` rebuilds what the server carries from the knowledge pack: the error list and the table of native-call replies (from `references/errors.md` and `references/native-call-errors.md`), the sections that `read_guide` and the resources serve (from each skill's `SKILL.md` and `references/*.md`), and the prompts (from each `SKILL.md` with a line `mcp-prompt: <name>`). `--check` writes nothing and fails when a file is out of date.
- `node scripts/gen-metadata.mjs` saves the chains' runtime metadata into the source, so a session does not download it. It needs both networks to be reachable and stamps the day it ran. Run it after a runtime upgrade. Until then the server downloads the new metadata by itself: it is slower to start, it still reads the new runtime, and every answer starts with a warning that the dated facts were measured on the older runtime.
- `node scripts/call.ts <tool> '<json>'` runs one tool from source.
- `node build.mjs --outdir=<folder>` builds into another folder and leaves the plugin alone.
- `node test/smoke.test.mjs --server=<path>` checks another build; `--npx=<spec>` checks the server the way npx starts it.
- `third-party-licences/` holds the licence texts that cannot be read from `node_modules`: packages that arrive inside another package's build files, and one that ships no licence file. The build stops when a text is missing.
- Every push and pull request to main runs `.github/workflows/ci.yml`: the type check, the unit tests, the check of the generated files, the bundle check and the smoke test on Linux, macOS and Windows with Node.js 22 and 24, and the smoke test on Node.js 20. The end-to-end test against the public nodes runs only when started by hand.

The built server is one file with no dependencies to install. Node.js 24 runs the TypeScript source directly; the unit tests need Node.js 22 or newer.

## How it was checked

Where the facts come from. On Nov 15, 2026 we sent 65 transactions of our own on the testnet, from fresh test accounts (the node took 50 and refused 15), and recorded 524 dry runs and reads in six groups: what Ethereum tools put into a transaction, a token's ERC-20 address, locked balances and address rules, calls between contracts, signing with other libraries, and the public endpoints. A sample of each group was then measured a second time, independently, and where the two differed the knowledge pack follows the second. Earlier measurements carry their own dates.

How the kit itself is tested. Numbers from November 16, 2026, on Node.js 24 and Windows:

- 239 unit tests, with no network.
- 132 live tests, which read the testnet and the mainnet.
- 199 checks of the built server over stdio, in both protocol modes of the MCP client.
- 13 smoke checks of the built server with no network, also run on Node.js 20.
- A copy without `node_modules` builds to the same file, byte for byte, and `npm run check:bundle` fails when the committed server is not what the source builds.
- The CI badge at the top shows the same checks on Linux, macOS and Windows.
- 12 developer questions, each asked twice with the plugin and twice without it (Claude Opus; the run without the plugin could search the web), on version 0.1.0. With the plugin 24 of 24 answers were right; without it 16 of 24. The questions and their graders are in `plugins/portaldot-dev/evals/`. This repeats the run: `claude plugin eval plugins/portaldot-dev --runs 2 --allow-real-servers --allow-tools "mcp__plugin_portaldot-dev_chain__*" WebSearch WebFetch --model opus --judge-model opus`. It starts the real chain server, which reads the public testnet, and it uses your own Claude account.

What was not checked: the other assistants themselves (their sections rest on their documentation), the start by `npx` from GitHub before this version was published (we ran it from a local git copy and from a packed copy), and deploying by Ethereum transaction, with Hardhat, `forge create` or anything else (our deployments used native calls; our own Ethereum transactions were transfers, token calls, contract calls sent with `cast`, and native calls through the pallets address).

Two limits to know:

- `simulate_contract_deploy` reads a build artifact only from inside the project folder.
- A user name and password in a WebSocket endpoint are not sent by the WebSocket built into Node.js 22 and later; the error message says what to set.

## Status

Version 0.3.0, November 2026. What changed in each version: [CHANGELOG.md](CHANGELOG.md).

The Claude Code plugin was checked on Claude Code 2.1.325; much older versions reject the plugin's manifest. For other assistants see [docs/other-assistants.md](docs/other-assistants.md).

The chain changes, so every fact carries its date. If you find something that is wrong or out of date, please open an issue at https://github.com/jonathan-moore58/portaldot-builder-kit/issues.

## Licence

Apache-2.0. See [LICENSE](LICENSE). The bundled server contains third-party packages, whose notices are in [plugins/portaldot-dev/server/THIRD-PARTY-NOTICES.txt](plugins/portaldot-dev/server/THIRD-PARTY-NOTICES.txt).
