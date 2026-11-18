---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

On the Portaldot V3 testnet my MetaMask transaction to my own contract is rejected immediately with "RPC Error: 1010: Invalid Transaction". Nothing gets mined. My account has about 5 tPOT, the function just stores one number, and to be safe I set the gas limit in MetaMask to 600,000,000,000,000. Other chains never did this to me. What is going on, and what exactly should I change?
