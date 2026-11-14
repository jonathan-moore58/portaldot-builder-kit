---
type: llm
weight: 3
---

The measured rule on this chain gives a deposit of about 348 tPOT (0.078 x 4200 + 13.11 = 340.71 for the code and the contract record, plus 2 x 3.8415 = 7.68 for the two slots), plus a small fee and some headroom.

PASS only if the answer states a total between 330 and 450 tPOT and explains it mainly by storage and code deposits, with arithmetic per byte of code.

FAIL if the stated need is below 100 tPOT or above 600 tPOT, if the cost is described as negligible or as a normal gas fee, or if no number is given.
