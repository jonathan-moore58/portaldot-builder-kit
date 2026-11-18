---
type: llm
weight: 3
---

PASS only if all of these hold:
1. It explains 1014: a transaction from the same account with the same nonce already waits in the pool, and the new one does not have a higher priority (the two numbers are the two priorities).
2. It says how to replace the waiting transaction: send the same nonce again with higher fees (a higher priority fee and max fee on the Ethereum side, or a higher tip on the native side).
3. It says how to see on this chain that the stuck transaction still waits, since the Ethereum RPC answers null for a waiting transaction: `system_accountNextIndex` above the account's nonce, `author_pendingExtrinsics`, or the kit's get_account or get_transaction tools.

FAIL if the fix it gives is to use a new, higher nonce, or if it says a waiting transaction cannot be replaced.
