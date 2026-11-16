---
type: llm
weight: 3
---

PASS only if both of these hold:
1. The cause: forge script does not take its gas limit from the node. It uses the gas of its own local run, which is tiny, while gas on this chain includes the storage deposit and is many orders of magnitude larger; the node refuses a gas limit that is too low with 1010.
2. The fix: take the gas limit from the node (cast estimate or eth_estimateGas) and send with cast send or cast mktx with that limit, or with another tool that uses the node's estimate.

FAIL if the main diagnosis is the balance, the nonce, the chain id or the RPC.
