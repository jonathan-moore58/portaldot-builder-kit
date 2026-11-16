# Changelog

What changed in each version of the Portaldot Builder Kit, newest first. The plugin, the server and both package.json files carry the same version.

## 0.3.0 (Nov 16, 2026)

- For any MCP client: a sixteenth tool, `read_guide`, gives the knowledge pack by section or by search; each knowledge file is a resource at `portaldot://guide/<name>`; the server starts with `npx -y github:jonathan-moore58/portaldot-builder-kit`; and `docs/other-assistants.md` has the settings for 15 assistants, taken from their own documentation.
- A start guide: the skill `portaldot-start`, also served as the prompt `start_project`. It takes a developer from an idea to a first working result on the testnet, with blueprints for eleven kinds of project.
- New measurements of Nov 15, 2026: 65 transactions of our own on the testnet, and 524 dry runs and reads in six groups. From them: 17 new entries in `errors.md` (E39 to E55), 16 new rows in `native-call-errors.md` (142 in all), new recipes (dry-run signed bytes, sign with polkadot-api or dedot, replace or cancel a waiting transaction, a nonce gap, store data with TransactionStorage, an Assets token through its ERC-20 address), and corrections in every reference file.
- Corrected: the rule behind error 1010 is gas limit x base fee against what the sender can spend. The max fee, the priority fee and the value are not counted, and a transaction whose value cannot be paid is included, fails and still costs its fee. `estimate_eth_transaction` and `encode_call` now give that verdict.
- Corrected: on this chain `eth_getTransactionCount` with "pending" always equals "latest", so it cannot show a waiting transaction. `get_account` now reads `system_accountNextIndex`, and `get_transaction` looks for a hash in the node's pool. Versions 0.1.0 to 0.2.1 could say that nothing was pending while a transaction waited.
- Every answer starts with a warning when the chain runs another runtime version than the one our dated facts were measured on.
- An offline smoke test, a check that the committed server is what the source builds, and CI on Linux, macOS and Windows with Node.js 22 and 24 (the smoke test also on Node.js 20).
- Checked with 239 unit tests, 132 live tests, 199 checks of the built server and 13 smoke checks, on Node.js 24 and Windows.

## 0.2.1 (Nov 15, 2026)

- A call refused with `System.CallFiltered` is now explained: entry E38 in `errors.md` gives its three causes (safe mode, a paused call, a call that the type of a proxy does not allow), what to check and what to do. We measured the proxy case with our own testnet transactions (blocks 477947 to 477951).
- `get_chain_facts` says in one line whether safe mode is on, and names the calls that are paused.
- `explain_error` recognises E38 and gives the next step. `encode_call` adds a note for calls sent through a proxy.
- Checked with 192 unit tests, 126 live tests and 150 checks of the built server, on Node.js 24 and Windows.

## 0.2.0 (Nov 15, 2026)

- `errors.md`: four new entries (E34 to E37), and measured additions to nine others.
- A new reference, `native-call-errors.md`: what native calls answer to common mistakes. 126 rows, each from a dry run on the testnet.
- `encode_call` dry-runs the call from a sender you name, and names the chain's refusal.
- `explain_error` shows the measured cases of an error, and knows what the node answers to bytes it cannot read.
- A recipe for reading why the node refuses an Ethereum transaction, without sending it.
- The server follows `HTTPS_PROXY` and `HTTP_PROXY`. Notes for cloud sessions.
- Checked with 184 unit tests, 126 live tests and 147 checks of the built server, on Node.js 24 and Windows.

## 0.1.0 (Nov 15, 2026)

- Initial release, under the name Portaldot V3 Dev Kit. It was renamed Portaldot Builder Kit on the same day, before 0.2.0.
- The plugin has two parts. An MCP server with fifteen read-only tools: `get_chain_facts`, `search_chain`, `describe_item`, `convert_address`, `get_account`, `convert_amount`, `read_storage`, `encode_call`, `estimate_eth_transaction`, `simulate_contract_call`, `simulate_contract_deploy`, `get_transaction`, `get_block`, `get_contract_events` and `explain_error`. And the skill `portaldot-v3`: rules, recipes, errors and measurements, each fact with how it is known and when.
- No tool asks for a key, signs or sends; a secret recovery phrase in any argument is refused.
- Checked with 170 unit tests, 117 live tests and 136 checks of the built server, on Node.js 24 and Windows.
