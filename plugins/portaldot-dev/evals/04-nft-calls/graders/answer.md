---
type: llm
weight: 3
---

PASS only if all of these hold:
1. The collection is created with api.tx.nfts.create(admin, config): exactly two arguments, the admin address first.
2. The config object has the keys settings, maxSupply and mintSettings, and mintSettings has mintType, price, startBlock, endBlock and defaultItemSettings.
3. The item is minted with api.tx.nfts.mint(collection, item, mintTo, witnessData): four arguments in this order (witnessData may be null or undefined).

FAIL if the uniques module is the main answer, if an argument is missing, added or out of order, or if the config has invented keys.
