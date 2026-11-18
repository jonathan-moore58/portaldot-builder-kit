---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

A transfer I sent on the Portaldot V3 testnet seems stuck: `eth_getTransactionByHash` still returns null for it. I tried to resend it with the same nonce from a script and got `1014: Priority is too low: (10 vs 10)`. What does that mean, how can I see whether the stuck one is still waiting, and how do I replace the waiting transaction?
