---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

With Foundry on the Portaldot V3 testnet, `forge script ... --broadcast` fails on every transaction with error 1010 (Invalid Transaction), but `cast send` works for the same calls from the same account. Why, and how should I deploy and call instead?
