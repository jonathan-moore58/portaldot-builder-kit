---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

Write a small Node.js script (ESM) that sends 10 tPOT on the Portaldot V3 testnet from a test account (read its secret phrase from an environment variable) to 5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z, and only reports success once it is safe to treat the transfer as done.
