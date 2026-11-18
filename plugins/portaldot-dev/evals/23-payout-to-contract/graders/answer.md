---
type: llm
weight: 3
---

PASS only if both of these hold:
1. The cause: transfer() and send() pass on a small fixed amount of gas, and on this chain writing a new storage slot needs gas worth the slot's storage deposit (about 3.84 tPOT), far more than the payee gets. (The payee can still emit an event or overwrite a slot that already holds a value.)
2. The fix: pay with call{value: ...}("") and all the gas, check the result and guard against re-entry; or let the winners withdraw.

FAIL if the fix it gives is to raise the gas limit of the outer transaction, or if it explains the failure only with Ethereum's 2300-gas stipend.
