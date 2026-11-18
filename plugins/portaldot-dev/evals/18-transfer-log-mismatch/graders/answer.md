---
type: llm
weight: 3
---

PASS only if both of these hold:
1. It explains that a transfer which would leave the sender less than the token's minimum balance (10000 units for pUSD) moves the sender's whole balance, while the ERC-20 Transfer log shows only the amount that was asked for.
2. It names a source that is right: balanceOf, or the chain's own Assets.Transferred event.

FAIL if it blames missing logs, decimals, a reorganisation or the indexer's arithmetic.
