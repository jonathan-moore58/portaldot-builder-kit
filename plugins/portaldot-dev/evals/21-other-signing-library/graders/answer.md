---
type: llm
weight: 3
---

PASS only if both of these hold:
1. It says PAPI needs no extra configuration for the two extensions: it handles them by itself.
2. It says that signing with the metadata hash check switched on (CheckMetadataHash mode 1, what a Ledger sends) does not work on this chain today: the runtime answers Unknown(CannotLookup).

FAIL if it says custom signed-extension code must be written for PAPI, or that Ledger signing works.
