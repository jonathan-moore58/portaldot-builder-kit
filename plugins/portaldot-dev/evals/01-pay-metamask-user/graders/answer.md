---
type: llm
weight: 3
---

PASS only if all of these hold:
1. The destination passed to the transfer is exactly the SS58 address 5DwTvdqfoYzcnHDMc5iuxfHxxP3CHwH9X813W3wksnwdt8Yb (or the same account written as the 32-byte id 0x52f2d9e3b1bb0d8cf1f4f0bc7b3a4d1b0e7c9a11eeeeeeeeeeeeeeeeeeeeeeee).
2. The amount is 250000000000000 base units, that is 2.5 x 10^14 (an equivalent BigInt expression is fine).
3. The call is balances.transferKeepAlive or balances.transferAllowDeath.

FAIL if the 0x address itself is passed as the destination, if another 5... address is given, if the amount uses 18, 12 or 10 decimals, or if the answer says it cannot be done or cannot work out the address.
