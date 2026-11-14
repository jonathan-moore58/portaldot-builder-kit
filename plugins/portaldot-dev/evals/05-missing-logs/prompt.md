---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

My contract on the Portaldot V3 testnet emits `Deposited(address,uint256)`. When a user calls it from MetaMask I can find the event with eth_getLogs. But when my backend calls the same function from a Substrate account with `api.tx.revive.call`, the transaction succeeds and yet eth_getLogs returns an empty array for that block. Is the event lost? How do I read it?
