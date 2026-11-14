---
type: llm
weight: 3
---

PASS only if both of these hold:
1. The cause is given as the balance rule of this chain: the node refuses the transaction because gas limit multiplied by the fee per gas is more than the sender's balance, and gas numbers are this large because gas on this chain includes the storage deposit.
2. A concrete fix follows from it: keep the gas limit close to the estimate (for example the estimate plus about 10 percent) and the max fee close to the current gas price, and/or hold enough balance to cover value + gas limit x max fee.

FAIL if the main diagnosis is the nonce, the signature, the chain id or the RPC, or if the advice is only "raise the gas limit" or "try again".
