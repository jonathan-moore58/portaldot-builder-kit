---
type: llm
weight: 3
---

PASS only if both of these hold:
1. The call is assetConversion.swapExactTokensForTokens with the arguments, in this order: path, amountIn, amountOutMin, sendTo, keepAlive.
2. The path is a list of two entries of an enum with the variants Native and WithId: the native token written as Native (for example 'Native' or { Native: null }) and the asset as { WithId: 7780 }.

FAIL if another module or call name is used, if the arguments are missing or out of order, or if the assets are written as XCM locations (MultiLocation, parents, interior) or as plain numbers.
