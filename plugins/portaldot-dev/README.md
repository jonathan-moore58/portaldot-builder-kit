# Portaldot V3 Dev Kit

by the Bridge Zero team

Checked facts and read-only chain tools for building on Portaldot V3, packaged as a plugin for Claude Code. It is an independent project. The Portaldot team did not make it and does not endorse it.

Portaldot V3 looks like Polkadot on one side and like Ethereum on the other, and it behaves like neither in a few places that cost money: every account has two address forms, amounts have 14 decimals on one side and 18 on the other, gas includes a storage deposit, and the node refuses a transaction when the gas limit asks for more than the balance. This plugin gives the assistant the measured facts and the tools to check the live chain, so it does not have to guess.

## What is inside

- **Chain tools** (an MCP server named `chain`): fifteen read-only tools. They look up the exact call for a job and its arguments, convert addresses and amounts, read balances and storage, dry-run contract calls and deployments, show a transaction from both sides, and explain errors.
- **A knowledge pack** (the skill `portaldot-v3`): rules that prevent the costly mistakes, proven recipes, and a list of errors and traps. Every fact says how it is known: checked on the chain, learned from experience, taken from the official guide, or only reported by others.

## What it never does

No tool asks for a private key or a secret phrase, and none signs or sends a transaction. The most a tool returns is unsigned call data for you to sign in your own wallet or script. A secret phrase in any argument is refused before anything is sent. A private key looks the same as an account id (0x and 64 hex characters), so never paste one.

When a tool is used, the server connects to the public Portaldot endpoints, or to the ones you set through its environment variables, and to nothing else. The addresses, call data and bytecode you ask about are sent to those nodes. No data is sent to us, and there is no telemetry.

## Install

You need Claude Code, Node.js 20 or newer on your PATH (we ran it only on Node.js 24), and git.

```
claude plugin marketplace add jonathan-moore58/portaldot-dev-kit
claude plugin install portaldot-dev@bridge-zero
```

Inside a session the same two steps are:

```
/plugin marketplace add jonathan-moore58/portaldot-dev-kit
/plugin install portaldot-dev@bridge-zero
```

## Licence

Apache-2.0. The bundled server contains third-party packages; their notices are in `server/THIRD-PARTY-NOTICES.txt`.
