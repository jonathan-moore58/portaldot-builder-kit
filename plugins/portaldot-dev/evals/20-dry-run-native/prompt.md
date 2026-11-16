---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

Before sending a native call on Portaldot V3 I want to dry-run it. polkadot.js Apps cannot do it, and in my script `api.call.dryRunApi` is undefined. How can I find out, without sending, whether my `Assets.transfer` call will succeed?
