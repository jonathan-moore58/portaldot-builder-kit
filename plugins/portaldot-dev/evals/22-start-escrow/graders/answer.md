---
type: llm
weight: 3
---

PASS only if all of these hold:
1. It starts from facts of this chain, not from generic Ethereum advice: pUSD is used through its ERC-20 address or through the Assets module.
2. It gives costs for this chain before any code: at least what a contract deployment holds in deposits (a figure in tPOT, or the rule of about 0.078 tPOT for each byte of code plus about 13 tPOT), set against the 30 tPOT.
3. It lays out a short numbered plan in which each send is dry-run first.
4. It names at least one trap of this chain that fits an escrow: the 0.1 tPOT held for each token approval, a token transfer that moves a whole balance when less than the minimum would be left, a failed token call that reaches a contract with no reason, or a failed transaction that still pays its fee.

FAIL if it is a generic tutorial with no figures or facts of this chain, or if it asks more than three questions and gives nothing else.
