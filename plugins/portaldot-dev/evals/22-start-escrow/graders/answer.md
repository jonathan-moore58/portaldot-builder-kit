---
type: llm
weight: 3
---

PASS only if all of these hold:
1. It starts from facts of this chain, not from generic Ethereum advice: pUSD is used through its ERC-20 address or through the Assets module.
2. It gives costs for this chain before any code, set against the 30 tPOT: for the multisig escrow (the default), the opener's reserve of about 9.27 tPOT for 2 of 3; or, for a contract, what its deployment holds in deposits (a figure in tPOT, or about 0.078 tPOT for each byte of code plus about 13 tPOT).
3. It lays out a short numbered plan in which each send is dry-run first.
4. It names at least one trap of this chain that fits an escrow: the 0.1 tPOT held for each token approval, a token transfer that moves a whole balance when less than the minimum would be left, a failed token call that reaches a contract with no reason, pUSD that cannot reach an account holding no tPOT, an `asMulti` that succeeds although the call inside failed (read `MultisigExecuted`), one multisig account for each set of members and threshold, or a failed transaction that still pays its fee.

FAIL if it is a generic tutorial with no figures or facts of this chain, or if it asks more than three questions and gives nothing else.
