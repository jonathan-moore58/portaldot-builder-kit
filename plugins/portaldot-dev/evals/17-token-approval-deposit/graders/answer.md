---
type: llm
weight: 3
---

PASS only if both of these hold:
1. It says that each approval of a token of the Assets module holds (reserves) a deposit of 0.1 tPOT from the owner, apart from the gas, so an owner without tPOT cannot approve.
2. It says the deposit comes back when the approval is cleared, for example with approve(spender, 0).

FAIL if it says the 0.1 tPOT is only a gas fee, or that it is lost for good.
