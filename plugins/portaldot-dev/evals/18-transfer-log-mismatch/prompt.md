---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

My indexer adds up the ERC-20 Transfer logs of pUSD on the Portaldot V3 testnet (token address 0x00001e6100000000000000000000000000010000). For one sender my sums say 5000 units are left, but balanceOf says 0. The logs I have are complete. What explains the difference?
