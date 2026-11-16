---
type: llm
weight: 3
---

PASS only if both of these hold:
1. It says that a proxy of type NonTransfer does not cover a transfer, so the call inside is not run: the transaction itself succeeds, and the `Proxy.ProxyExecuted` event carries the error (`System.CallFiltered`).
2. It says what to do: read the result in that event, and use a proxy whose type covers the call (such as Any) or send the transfer from the account itself.

FAIL if it blames the fee, the nonce, the address or the amount, or says the proxy is not registered.
