---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

In my dApp on the Portaldot V3 testnet, users approve my contract to spend pUSD (asset 7777) through the token's ERC-20 address. Two problems: a user who holds pUSD but no tPOT cannot approve at all, and users who do have tPOT see about 0.1 tPOT disappear after approve(). Is that a bug, and do they get it back?
