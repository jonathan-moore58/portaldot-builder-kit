---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

I want to move the whole balance of a MetaMask-style account on the Portaldot V3 testnet to another address with ethers. When I set `value` to the full `getBalance()`, the transaction was mined but failed, and I still paid a fee. What is the largest value I can send, exactly?
