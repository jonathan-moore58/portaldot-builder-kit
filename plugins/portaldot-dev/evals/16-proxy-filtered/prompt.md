---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

My bot has a NonTransfer proxy for my main account on Portaldot V3. It sends `Proxy.proxy(main, null, Balances.transferKeepAlive(dest, amount))`. The transaction shows ExtrinsicSuccess, and a dry run before it was fine, but no tPOT moves. What is happening?
