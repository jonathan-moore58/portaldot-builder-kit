---
type: llm
weight: 3
---

PASS only if both of these hold:
1. The answer says that calling mapAccount is not needed on Portaldot V3, because accounts are mapped automatically there (autoMap is on; the call does nothing).
2. It gives msg.sender as exactly 0x8ddee436166f311ddeed36d714b08f512670d16e (any letter case).

FAIL if the answer says to call mapAccount first, gives another address, or cannot give the address.
