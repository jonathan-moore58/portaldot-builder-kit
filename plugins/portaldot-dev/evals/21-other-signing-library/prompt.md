---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

I prefer polkadot-api (PAPI) to @polkadot/api. Portaldot V3 has two extra transaction extensions, AuthorizeCall and EthSetOrigin. Do I have to write custom extension code to sign a transaction with PAPI? And will signing with a Ledger (the metadata hash check) work?
