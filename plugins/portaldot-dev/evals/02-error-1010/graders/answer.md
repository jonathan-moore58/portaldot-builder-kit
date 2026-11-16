---
type: llm
weight: 3
---

PASS only if both of these hold:
1. The cause is given as the balance rule of this chain: the node refuses the transaction because gas limit multiplied by the fee per gas (the base fee) is more than the sender can spend, and gas numbers are this large because gas on this chain includes the storage deposit.
2. A concrete fix follows from it: keep the gas limit close to the estimate (for example the estimate plus about 10 percent), and/or hold enough balance to cover gas limit x base fee (an answer that asks for gas limit x max fee, or adds the value, is stricter than the node and also passes).

FAIL if the main diagnosis is the nonce, the signature, the chain id or the RPC, or if the advice is only "raise the gas limit" or "try again".
