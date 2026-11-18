---
type: llm
weight: 3
---

PASS only if all of these hold:
1. It says that a proxy of type NonTransfer does not cover a transfer, so the call inside is not run: the transaction itself succeeds, and the `Proxy.ProxyExecuted` event carries the error (`System.CallFiltered`).
2. It says what to do: read the result in that event, and use a proxy whose type covers the call (such as Any) or send the transfer from the account itself.
3. It says why the dry run passed: a dry run of `Proxy.proxy` reports success when the call inside is filtered, so check the proxy's type in `proxy.proxies` before sending.

FAIL if it blames the fee, the nonce, the address or the amount, or says the proxy is not registered.
