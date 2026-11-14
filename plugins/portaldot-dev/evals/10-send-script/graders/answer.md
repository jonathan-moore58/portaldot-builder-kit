---
type: llm
weight: 3
---

PASS only if all of these hold:
1. It connects to wss://test-node-v3.portaldot.dev.
2. The amount is 10 x 10^14 = 1000000000000000 base units (an equivalent BigInt expression such as 10n * 10n ** 14n is fine).
3. It uses balances.transferKeepAlive or balances.transferAllowDeath.
4. It reports success only after the block is finalized (status.isFinalized or an equivalent wait for the finalized head), and it checks for a failed dispatch.

FAIL if the endpoint is another one or invented, if the amount uses decimals other than 14, or if success is reported when the transaction is merely broadcast or in a block.
