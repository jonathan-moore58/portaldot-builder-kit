---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

A tutorial for pallet-revive says a Substrate account must call `revive.mapAccount()` once before it can interact with contracts. On the Portaldot V3 testnet, do I need to do that for the account 5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z? And what address will a contract see as msg.sender when this account calls it?
