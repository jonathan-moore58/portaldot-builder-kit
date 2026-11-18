---
type: llm
weight: 3
---

PASS only if both of these hold:
1. It says that on this chain the Ethereum RPC does not show a transaction that waits for its block: `eth_getTransactionByHash` (ethers `getTransaction`) is null until the block, and the "pending" transaction count equals "latest", so neither one shows that the transaction was dropped.
2. It gives a check on the Substrate side that works here: the account's next index on the Substrate node (`system_accountNextIndex`) against its nonce, or `author_pendingExtrinsics`, or the kit's get_account or get_transaction tools (advice to wait for the receipt or for the nonce to move in a block, and to resend only with the same nonce, may come in addition).

FAIL if it tells the developer to rely on the "pending" count or on `eth_getTransactionByHash`, or says the transaction was dropped.
