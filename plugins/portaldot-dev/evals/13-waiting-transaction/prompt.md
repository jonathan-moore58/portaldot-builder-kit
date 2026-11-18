---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

On the Portaldot V3 testnet I send transfers with ethers. Right after sending, `provider.getTransaction(hash)` returns null, and `provider.getTransactionCount(address, "pending")` is the same as with "latest". My script takes that to mean the transaction was dropped and sends it again, and sometimes the payment goes out twice. Is the RPC broken? How do I check properly whether a transaction of mine is still waiting?
