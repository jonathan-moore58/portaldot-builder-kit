---
type: llm
weight: 3
---

PASS only if both of these hold:
1. It explains why the transaction was mined and failed: before the block the node checks only that gas limit x base fee fits the balance, the value is checked when the transaction runs, and a transaction that fails in its block still pays its fee.
2. It gives a rule that works: the value is at most the balance (`eth_getBalance`) minus gas limit x max fee (gas limit x base fee with a margin also passes).

FAIL if it says the node refuses such a transaction before the block, or if its only arithmetic is Ethereum's 21000 gas for a transfer.
