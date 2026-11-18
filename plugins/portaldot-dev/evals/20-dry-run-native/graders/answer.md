---
type: llm
weight: 3
---

PASS only if both of these hold:
1. It says that this runtime has no DryRunApi.
2. It gives the dry run that works for any sender here, described correctly: an Ethereum-style dry run (eth_estimateGas, or the kit's encode_call with a sender) from the sender's 0x form to the pallets address with the call's bytes as data, which needs no signature (`system_dryRun` of a signed transaction from a key that can pay may come in addition).

FAIL if the only thing it offers as a dry run is a fee estimate (paymentInfo), or if it invents a DryRunApi call.
