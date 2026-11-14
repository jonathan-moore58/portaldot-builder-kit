---
tags: [core]
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, WebSearch, WebFetch, "mcp__plugin_portaldot-dev_chain__*"]
---

My Solidity contract on the Portaldot V3 testnet has `function join() external payable { require(msg.value == 1 ether, "need exactly 1"); }`. I call it from a Substrate account with @polkadot/api: `api.tx.revive.call(dest, value, weightLimit, storageDepositLimit, data)`. What number do I pass as `value` so that the require passes? Give the exact integer.
