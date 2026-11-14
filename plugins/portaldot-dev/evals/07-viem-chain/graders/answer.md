---
type: llm
weight: 3
---

PASS only if all of these hold:
1. Testnet: id 420420777, the RPC URL https://test-evm-rpc-v3.portaldot.dev, nativeCurrency with symbol tPOT and decimals 18.
2. Mainnet: id 780780777, symbol POT, decimals 18.
3. The answer says that the mainnet has no public Ethereum JSON-RPC endpoint today, so no working rpcUrls can be given for it, and it does not present an invented mainnet URL as real.

FAIL if an id is wrong, if nativeCurrency decimals are 14, 12 or 10, if the testnet RPC URL is different, or if a mainnet Ethereum RPC URL is given as working.
