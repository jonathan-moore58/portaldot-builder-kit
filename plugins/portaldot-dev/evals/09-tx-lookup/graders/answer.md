---
type: llm
weight: 3
---

PASS only if the answer states all of these: the transaction is in block 452626; it succeeded; and it carried a native System remark call (system.remarkWithEvent, seen as a Remarked event) sent as an Ethereum transaction to the runtime's pallets address.

FAIL if the answer cannot find the transaction, or gives another block or another action.
