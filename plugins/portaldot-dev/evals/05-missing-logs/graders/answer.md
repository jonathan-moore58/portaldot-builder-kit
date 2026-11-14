---
type: llm
weight: 3
---

PASS only if the answer says the event is not lost and gives this explanation and method: the Ethereum RPC serves, through eth_getLogs, only the logs of Ethereum transactions; an event emitted during a native (Substrate) call is in the block's System events as revive.ContractEmitted, with the fields contract, data and topics; read the events of that block (for example with api.at(blockHash) and query.system.events()) and decode data and topics with the ABI.

FAIL if the answer blames an indexing delay, a wrong filter, the block range or the RPC being down, or tells the user to wait or retry, without naming the ContractEmitted event in the Substrate events.
