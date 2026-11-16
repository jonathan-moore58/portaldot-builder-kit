---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

My Solidity contract on the Portaldot V3 testnet pays winners with `payable(winner).transfer(amount)`. It works for ordinary accounts, but when the winner is a contract whose receive() records the payment in a new storage slot, the payout reverts with an empty reason. What is different on this chain, and what should I change?
