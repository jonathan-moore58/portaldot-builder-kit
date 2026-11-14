---
type: llm
weight: 3
---

PASS only if the answer says that nothing is lost: the Ethereum side (eth_getBalance, MetaMask) shows what can be spent, which leaves out the existential deposit of 0.1 tPOT that every account must keep.

FAIL if the answer blames a fee, a pending transaction, rounding or decimals, dust, or a sync problem.
