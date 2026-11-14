---
type: llm
weight: 3
---

PASS only if the value given is exactly 100000000000000 (10^14; an equivalent expression such as 10n ** 14n is fine) and the answer explains that the contract then sees msg.value as 10^18 wei, because the native side has 14 decimals and the Ethereum side 18.

FAIL if the value given is 1000000000000000000 (10^18), 10^12, 10^10 or anything else, or if the answer gives several candidates without settling on 10^14.
