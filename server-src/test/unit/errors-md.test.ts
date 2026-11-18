// The list of errors and traps (references/errors.md), the file generated from it, and the pure parts
// of explain_error. No network: every check here runs offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_ENTRIES, ERROR_INTRO } from '../../src/generated/errors.ts';
import { CUSTOM_BY_SELECTOR, ENTRY_PATTERNS, STANDARD, findModulePairs, findReverts, focusText, listNotes, matchEntries, readFunds, readRevert, standardMatches } from '../../src/tools/explain_error.ts';
import { pickNetwork } from '../../src/lib/networks.ts';

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ERRORS_MD = resolve(SERVER_SRC, '..', 'plugins/portaldot-dev/skills/portaldot-v3/references/errors.md');

/** Runs the generator with errors.md text on stdin, and returns its exit code and messages. */
function genWith(markdown: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ['scripts/gen-knowledge.mjs', '--stdin'], { cwd: SERVER_SRC, input: markdown, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const ENTRY = (id: string, body: string): string => `### ${id}. A title\n\n${body}\n`;

test('the generated file is up to date with errors.md', () => {
  const r = spawnSync(process.execPath, ['scripts/gen-knowledge.mjs', '--check'], { cwd: SERVER_SRC, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /is up to date/);
  // a second way: the first line of the file and the number of headings in errors.md
  const md = readFileSync(ERRORS_MD, 'utf8');
  const headings = md.match(/^### E\d+\. /gm) ?? [];
  assert.equal(ERROR_ENTRIES.length, headings.length);
  assert.ok(ERROR_INTRO.startsWith('# Portaldot V3: errors and traps'));
});

test('the generator fails loudly on a broken errors.md', () => {
  const none = genWith('# Errors\n\nNothing here yet.\n');
  assert.equal(none.status, 1);
  assert.match(none.out, /no entries/);

  const dup = genWith(ENTRY('E1', '- **Fix:** a.\n- **Basis:** Checked.') + ENTRY('E1', '- **Fix:** b.\n- **Basis:** Checked.'));
  assert.equal(dup.status, 1);
  assert.match(dup.out, /duplicate id E1/);

  const neither = genWith(ENTRY('E1', '- **You see:** something.\n- **Basis:** Checked.'));
  assert.equal(neither.status, 1);
  assert.match(neither.out, /neither a "- \*\*Cause:\*\*" nor a "- \*\*Fix:\*\*"/);

  const good = genWith(ENTRY('E1', '- **Cause:** a.\n- **Fix:** b.\n- **Basis:** Checked.'));
  assert.equal(good.status, 0, good.out);
});

test('the entries are numbered E1, E2, ... in order, and each says how we know', () => {
  ERROR_ENTRIES.forEach((e, i) => {
    assert.equal(e.id, `E${i + 1}`);
    assert.ok(e.title.length > 5, e.id);
    assert.match(e.body, /^- \*\*Basis:\*\* (?:Checked|Experience|Guide|Reported)/m, `${e.id} has no Basis line that starts with a basis word`);
  });
});

test('every entry has patterns, and no pattern points to a missing entry', () => {
  assert.deepEqual(Object.keys(ENTRY_PATTERNS).sort(), ERROR_ENTRIES.map((e) => e.id).sort());
  for (const [id, pats] of Object.entries(ENTRY_PATTERNS)) {
    assert.ok(pats.length >= 2, `${id} has fewer than two patterns`);
    for (const [re, w] of pats) {
      assert.ok(!re.global && !re.sticky, `${id}: ${re} must not keep state between calls`);
      assert.ok(w >= 1 && w <= 10, `${id}: weight ${w}`);
    }
  }
});

test('the symptom an entry describes finds that entry', () => {
  const part = (body: string, label: string): string | undefined => new RegExp(`^- \\*\\*${label}:\\*\\*([\\s\\S]*?)(?=^- \\*\\*|$(?![\\s\\S]))`, 'm').exec(body)?.[1];
  for (const e of ERROR_ENTRIES) {
    // an entry without a "You see" part (E24) describes its symptoms under "Others report"
    const seen = part(e.body, 'You see') ?? part(e.body, 'Others report') ?? '';
    const ids = matchEntries(`${e.title}\n${seen}`).map((m) => m.entry.id);
    assert.ok(ids.includes(e.id), `${e.id} is not found from its own title and "You see" text; found ${ids.join(', ') || 'nothing'}`);
  }
});

test('real error texts find the right entry first', () => {
  const cases: Array<[string, string]> = [
    ['1010: Invalid Transaction: Inability to pay some fees (e.g. account balance too low)', 'E1'],
    ['{"jsonrpc":"2.0","id":1,"error":{"code":1010,"message":"Invalid Transaction"}}', 'E1'],
    ['MetaMask shows a review alert: gas limit 7158578160885', 'E2'],
    ['Error: State already discarded for 0x7c05b2dc7486f81a693d676553fa13f380b5be16da7c739b182931cd6cf07001', 'E5'],
    ['eth_getLogs returned [] although the contract emitted the event', 'E6'],
    ['1014: Priority is too low: (2 vs 2)', 'E12'],
    ['getaddrinfo ENOTFOUND testnetv3-node.feso-apps.xyz', 'E13'],
    ['API-WS: disconnected from wss://test-node-v3.portaldot.dev: 1006:: Abnormal Closure', 'E14'],
    ['eth_getTransactionReceipt returned null', 'E15'],
    ['{"code":3,"message":"execution reverted: ","data":"0x"}', 'E26'],
    ['{"code":-32000,"message":"Invalid call: Payment"}', 'E27'],
    ['{"code":-32601,"message":"Method not found"}', 'E28'],
    ['{"code":-32000,"message":"Failed to dispatch call: BadOrigin"}', 'E29'],
    // the texts of E26 and E30 to E33, as the testnet's Ethereum RPC returned them on Nov 14, 2026
    ['{"code":3,"message":"execution reverted: revert: Metadata not found","data":"0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000124d65746164617461206e6f7420666f756e640000000000000000000000000000"}', 'E26'],
    ['{"code":-32602,"message":"Invalid params","data":"unknown variant `newHeads`, expected `newBlockHeaders` or `logs` at line 1 column 10"}', 'E30'],
    ['{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 80, error: [31, 0, 0, 0], message: Some(\\"InvalidInstruction\\") })"}', 'E31'],
    ['{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 80, error: [47, 0, 0, 0], message: Some(\\"UnsupportedPrecompileAddress\\") })"}', 'E31'],
    ['{"code":-32000,"message":"The transaction consumes more than the allowed weight. needed=Weight(ref_time: 1531321961872, proof_size: 23813914) allowed=Weight(ref_time: 1529902658700, proof_size: 14111759216387806985) overweight_by=Weight(ref_time: 1419303172, proof_size: 0)"}', 'E32'],
    ['{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 80, error: [3, 0, 0, 0], message: Some(\\"OutOfGas\\") })"}', 'E32'],
    ['eth_getLogs: {"code":-32000,"message":"Failed to filter logs"}', 'E33'],
    // texts measured on Nov 15, 2026: refusals before a transaction runs, and wrong parameters
    ['1010: Invalid Transaction: Inability to pay some fees , e.g. account balance too low', 'E1'],
    ['1010: Invalid Transaction: Transaction has an ancient birth block', 'E1'],
    ['1010: Invalid Transaction: Transaction call is not expected', 'E1'],
    ['1040: Client error: Could not decode `OpaqueExtrinsic.0`:\n\tNot enough data to decode vector\n', 'E34'],
    ['1001: Extrinsic has invalid format: Could not decode `OpaqueExtrinsic.0`:\n\tNot enough data to decode vector\n', 'E34'],
    ['1002: Verification Error: Runtime error: Execution failed: Execution aborted due to trap: wasm trap: wasm `unreachable` instruction executed', 'E34'],
    ['4003: Client error: Execution failed: Execution aborted due to trap: wasm trap: wasm `unreachable` instruction executed', 'E34'],
    ['{"code":-32000,"message":"Invalid transaction"}', 'E35'],
    ['{"code":1013,"message":"Transaction Already Imported"}', 'E12'],
    ['1013: Transaction Already Imported: Any { .. }', 'E12'],
    ['1011: Unknown Transaction Validity: NoUnsignedValidator', 'E12'],
    ['{"code":-32602,"message":"Invalid params","data":"No more params"}', 'E36'],
    ['-32602: Invalid params: No more params', 'E36'],
    ['{"code":-32602,"message":"Invalid params","data":"OddLength"}', 'E36'],
    ['{"code":-32602,"message":"Invalid params","data":"InvalidHexCharacter { c: \'z\', index: 0 }"}', 'E36'],
    ['-32602: Invalid params: invalid hex character: h, at 0 at line 1 column 7', 'E36'],
    ['{"code":-32602,"message":"Invalid params","data":"hex string without 0x prefix at line 1 column 8"}', 'E36'],
    ['{"code":-32602,"message":"Invalid params","data":"invalid type: integer `4`, expected a (both 0x-prefixed or not) hex string or byte array containing between (0; 32] bytes at line 1 column 1"}', 'E36'],
    ['{"code":-32000,"message":"Ethereum block not found"}', 'E37'],
    ['{"code":-32000,"message":"Account not found for address 0x1111111111111111111111111111111111111111"}', 'E37'],
  ];
  for (const [text, id] of cases) assert.equal(matchEntries(focusText(text))[0]?.entry.id, id, text);
});

test('texts recorded on Nov 15, 2026 by sent transactions and dry runs find the right entry first', () => {
  // copied from the measurement records; an account address in them is replaced by the Treasury's 0x form
  const cases: Array<[string, string]> = [
    // nonces, by sent transactions on both RPCs (E12)
    ['{"code":1010,"message":"Invalid Transaction","data":"Transaction is outdated"}', 'E12'],
    ['1010: Invalid Transaction: Transaction is outdated', 'E12'],
    ['{"code":1013,"message":"Transaction Already Imported","data":"Any { .. }"}', 'E12'],
    ['{"code":1012,"message":"Transaction is temporarily banned"}', 'E12'],
    ['1012: Transaction is temporarily banned', 'E12'],
    ['{"code":1014,"message":"Priority is too low: (4048 vs 4048)","data":"The transaction has too low priority to replace another transaction already in the pool."}', 'E12'],
    ['{"code":1014,"message":"Priority is too low: (14 vs 10)"}', 'E12'],
    // the balance rule and the fee fields (E1), and too small a gas field (E27)
    ['{"code":1010,"message":"Invalid Transaction","data":"Inability to pay some fees (e.g. account balance too low)"}', 'E1'],
    ['{"code":-32000,"message":"Effective gas price 1 lower than base fee 15140"}', 'E1'],
    ['{"code":-32000,"message":"insufficient funds for gas * price + value (2208055164315450): address 0x8ddee436166f311ddeed36d714b08f512670d16e have 14720367762103006325 (supplied gas Some(1458424811304789))"}', 'E1'],
    ['{"code":-32000,"message":"Not enough gas supplied: Off by: 26784185435"}', 'E27'],
    ['{"code":-32000,"message":"Not enough gas supplied: Module(ModuleError { index: 80, error: [23, 0, 0, 0], message: Some(\\"StorageDepositNotEnoughFunds\\") })"}', 'E27'],
    ['{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 80, error: [11, 0, 0, 0], message: Some(\\"ContractTrapped\\") })"}', 'E27'],
    // forge script's own limits (E39)
    ['Estimated total gas used for script: 329147', 'E39'],
    ['Error: Failed to send transaction after 4 attempts', 'E39'],
    // an Assets token at its ERC-20 address (E40, E41, E3)
    ['{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 39, error: [0, 0, 0, 0], message: Some(\\"BalanceLow\\") })"}', 'E40'],
    ['{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 39, error: [1, 0, 0, 0], message: Some(\\"NoAccount\\") })"}', 'E40'],
    ['{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 39, error: [3, 0, 0, 0], message: Some(\\"Unknown\\") })"}', 'E40'],
    ['{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 39, error: [10, 0, 0, 0], message: Some(\\"Unapproved\\") })"}', 'E40'],
    ['{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 39, error: [16, 0, 0, 0], message: Some(\\"AssetNotLive\\") })"}', 'E40'],
    ['{"code":-32000,"message":"failed to run contract: Token(BelowMinimum)"}', 'E40'],
    ['{"code":-32000,"message":"failed to run contract: Token(CannotCreate)"}', 'E40'],
    ['{"code":-32000,"message":"failed to run contract: ConsumerRemaining"}', 'E41'],
    ['{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 6, error: [2, 0, 0, 0], message: Some(\\"InsufficientBalance\\") })"}', 'E41'],
    ['{"code":3,"message":"execution reverted: revert: Permit expired","data":"0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000e5065726d69742065787069726564000000000000000000000000000000000000"}', 'E41'],
    ['{"code":3,"message":"execution reverted: revert: Signer does not match owner","data":"0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001b5369676e657220646f6573206e6f74206d61746368206f776e65720000000000"}', 'E41'],
    ['{"code":3,"message":"execution reverted: revert: Invalid signature v value","data":"0x08c379a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000019496e76616c6964207369676e617475726520762076616c756500000000000000"}', 'E41'],
    ['{"code":3,"message":"execution reverted: revert: Balance conversion failed","data":"0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001942616c616e636520636f6e76657273696f6e206661696c656400000000000000"}', 'E3'],
    // a panic 0x41 is first a Solidity panic (E26); the token address is a related cause (E40)
    ['{"code":3,"message":"execution reverted: panic: memory allocation error (0x41)","data":"0x4e487b710000000000000000000000000000000000000000000000000000000000000041"}', 'E26'],
    // native calls: a lock, a 0x destination, TransactionStorage (E47, E50, E53 before E29, the route they came by)
    ['{"code":-32000,"message":"Failed to dispatch call: Token(Frozen)"}', 'E47'],
    ['{"code":-32000,"message":"Failed to dispatch call: CannotLookup"}', 'E50'],
    ['{"code":-32000,"message":"Failed to dispatch call: Module(ModuleError { index: 51, error: [0, 0, 0, 0], message: Some(\\"BadContext\\") })"}', 'E53'],
    ['{"code":-32000,"message":"Failed to dispatch call: Module(ModuleError { index: 51, error: [1, 0, 0, 0], message: Some(\\"BadDataSize\\") })"}', 'E53'],
    ['{"code":-32000,"message":"Failed to dispatch call: Module(ModuleError { index: 51, error: [4, 0, 0, 0], message: Some(\\"RenewedNotFound\\") })"}', 'E53'],
    ['{"code":-32602,"message":"Invalid CID: Failed to parse multihash","data":{"variant":"InvalidCid"}}', 'E53'],
    // signing (E50, E55) and dry runs (E51)
    ['{"Err":{"Unknown":"CannotLookup"}}', 'E50'],
    ['{"Err":{"Invalid":"UnknownOrigin"}}', 'E50'],
    ['createType(Result<ValidTransaction, TransactionValidityError>):: Unable to create Enum via index 12, in Call, Payment, Future, Stale, BadProof, AncientBirthBlock, ExhaustsResources, Custom, BadMandatory, MandatoryDispatch, BadSigner', 'E50'],
    ["Provided signed extensions doesn't match any VerifyMultiSignature pipeline", 'E50'],
    ['{"code":4003,"message":"Client error: Execution failed: Other: Exported method DryRunApi_dry_run_call is not found"}', 'E51'],
    ["Cannot read properties of undefined (reading 'dryRunCall')", 'E51'],
    ['Runtime entry RuntimeCall(DryRunApi_dry_run_call) not found', 'E51'],
    ['Runtime api spec not found for DryRunApi_dry_run_call', 'E51'],
    ['validateTransaction threw: 4003: Client error: Execution failed: Execution aborted due to trap: wasm trap: wasm `unreachable` instruction executed\nWASM backtrace:\nerror while executing at wasm backtrace:\n    0: 0xb05592 - portaldot_v3_runtime.wasm!__rustc[4b1ee1ef74718a7b]::rust_begin_unwind\n    1:  0x1f5f9 - portaldot_v3_runtime.wasm!core[973facb28fb2967]::panicking::panic_fmt\n    2: 0x9465bd - portaldot_v3_runtime.wasm!TaggedTransactionQueue_validate_transaction', 'E55'],
    ['validate_transaction threw: Incompatible runtime entry RuntimeCall(TaggedTransactionQueue_validate_transaction)', 'E55'],
    // the public endpoints (E52)
    ['HTTP 413; <html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n', 'E52'],
    ['{"code":-32800,"message":"Maximum number of chainHead_follow has been reached"}', 'E52'],
    ['{"code":-32802,"message":"The `chainHead_follow` subscription was started with `withRuntime` set to `false`"}', 'E52'],
    ['{"code":-32801,"message":"Invalid block hash"}', 'E52'],
    ['{"code":8011,"message":"Leaf was not found","data":"LeafNotFound"}', 'E52'],
    ['{"code":4003,"message":"Client error: Execution failed: Execution aborted due to trap: host code panicked while being called by the runtime: local_storage_get can be called only in the offchain call context with\\n\\t\\t\\t\\tOffchainDb extension"}', 'E52'],
    // printed by @polkadot/api on every connect (E11)
    ['API/INIT: RPC methods not decorated: archive_v1_body, ..., transaction_v1_stop (31 methods)', 'E11'],
  ];
  for (const [text, id] of cases) assert.equal(matchEntries(focusText(text))[0]?.entry.id, id, text);
  // not recorded, but how a developer would report what these entries describe
  const told: Array<[string, string]> = [
    ['forge script --broadcast: server returned an error response: error code 1010: Invalid Transaction', 'E39'],
    ['1011: Unknown Transaction Validity: CannotLookup', 'E50'],
    ['allowance() returns 340282366920938463463374607431768211455 after approve(spender, type(uint256).max)', 'E43'],
    ['the Transfer log says 683367 but Assets.Transferred says 688367', 'E42'],
    ['the token address keeps the tPOT I sent with transfer()', 'E44'],
    ['I set value = eth_getBalance to send everything and the receipt has status 0x0', 'E45'],
    ['the receipt shows gasUsed 0 and effectiveGasPrice 0 for my call through the pallets address, yet my balance dropped', 'E46'],
    ['payable(payee).transfer(1) reverts, but the payee only writes one storage slot', 'E48'],
    ['Revive.MaxCallDepthReached', 'E49'],
    ['my airdrop contract pays 1 wei to 1000 new addresses and costs 100 tPOT more', 'E54'],
  ];
  for (const [text, id] of told) assert.equal(matchEntries(focusText(text))[0]?.entry.id, id, text);
});

test('the new patterns leave ordinary texts and other entries\' texts alone', () => {
  const first = (t: string): string | undefined => matchEntries(focusText(t))[0]?.entry.id;
  const full = (t: string): string | undefined => { const m = matchEntries(focusText(t))[0]; return m && m.score >= 6 ? m.entry.id : undefined; };
  // the same words or codes in texts that belong to another entry
  for (const [text, id] of [
    ['{"code":-32000,"message":"Failed to dispatch call: Token(FundsUnavailable)"}', 'E29'],
    ['{"code":-32000,"message":"Failed to dispatch call: Token(BelowMinimum)"}', 'E29'],
    ['{"code":-32000,"message":"Failed to dispatch call: Module(ModuleError { index: 39, error: [0, 0, 0, 0], message: Some(\\"BalanceLow\\") })"}', 'E29'],
    ['{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 80, error: [31, 0, 0, 0], message: Some(\\"InvalidInstruction\\") })"}', 'E31'],
    ['{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 80, error: [3, 0, 0, 0], message: Some(\\"OutOfGas\\") })"}', 'E32'],
    ['{"code":3,"message":"execution reverted: revert: Invalid signature","data":"0x08c379a0"}', 'E26'],
    ['{"code":3,"message":"execution reverted: revert: ERC20: transfer amount exceeds balance","data":"0x08c379a0"}', 'E26'],
    ['4003: Client error: Execution failed: Execution aborted due to trap: wasm trap: wasm `unreachable` instruction executed', 'E34'],
    ['1002: Verification Error: Runtime error: Execution failed: Execution aborted due to trap: wasm trap: wasm `unreachable` instruction executed\nWASM backtrace:\n    2: 0x9465bd - portaldot_v3_runtime.wasm!TaggedTransactionQueue_validate_transaction', 'E34'],
    ['Error: HTTP 502 Bad Gateway <center>nginx</center>', 'E14'],
    ['{"code":1010,"message":"Invalid Transaction"}', 'E1'],
    ['Permit2 is not deployed on this chain', 'E19'],
    ['approveAsMulti stored only the call hash', 'E16'],
  ] as const) assert.equal(first(text), id, text);
  // ordinary texts get no new entry in full
  for (const text of [
    'the token is frozen by its issuer',
    'forge build failed: compiler error',
    'the game runs at 26 frames per second',
    'see frame 27 of the film',
    'send all my tokens to the exchange',
    'the payout was delayed',
    'TypeError: x is undefined at validateTransaction (wallet.js:10)',
    'Unable to create Enum via index 3, in Ok, Err',
    'bad context',
    'Invalid block hash',
  ]) assert.equal(full(text), undefined, text);
  // a meta transaction's own errors are not a refused transaction's reasons, though they share the names
  for (const text of ['MetaTx.BadProof', 'MetaTx.AncientBirthBlock']) {
    assert.ok(!matchEntries(text).some((m) => m.entry.id === 'E1'), text);
    assert.ok(!standardMatches(text).some((s) => s.label.startsWith('InvalidTransaction')), text);
  }
  assert.equal(first('{"Err":{"Invalid":"BadProof"}}'), 'E1');
  // a token address alone is an address first: its entry is only related
  assert.ok((matchEntries('0x00001e6100000000000000000000000000010000')[0]?.score ?? 0) < 6);
  // the variant list of @polkadot/types is not read as the error, but the enum stays recognisable
  const listed = focusText('Unable to create Enum via index 12, in Call, Payment, Future, Stale, BadProof, AncientBirthBlock');
  assert.equal(listed, 'Unable to create Enum via index 12, in Call, Payment');
  assert.ok(!standardMatches(listed).some((s) => /BadProof|AncientBirthBlock/.test(s.label)));
});

test('standard codes give the texts measured on Nov 15, 2026', () => {
  const labels = (t: string): string[] => standardMatches(focusText(t)).map((s) => s.label);
  const basis = (label: string): string => STANDARD.find((s) => s.label === label)?.basis ?? '';
  for (const [text, label] of [
    ['{"code":1014,"message":"Priority is too low: (14 vs 10)"}', '1014 Priority is too low'],
    ['1010: Invalid Transaction: Transaction is outdated', 'InvalidTransaction Stale'],
    ['{"code":-32800,"message":"Maximum number of chainHead_follow has been reached"}', '-32800 Maximum number of chainHead_follow has been reached'],
    ['{"code":-32802,"message":"The `chainHead_follow` subscription was started with `withRuntime` set to `false`"}', '-32802 chainHead_follow started with withRuntime false'],
    ['{"code":-32801,"message":"Invalid block hash"}', '-32801 Invalid block hash'],
    ['<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n</html>', 'HTTP 413 Request Entity Too Large'],
    ['{"code":8011,"message":"Leaf was not found","data":"LeafNotFound"}', '8011 Leaf was not found'],
    ['{"code":4003,"message":"Client error: Execution failed: Other: Exported method DryRunApi_dry_run_call is not found"}', '4003 Client error: Execution failed'],
    ['{"Err":{"Invalid":"UnknownOrigin"}}', 'InvalidTransaction UnknownOrigin'],
    ['{"Err":{"Unknown":"CannotLookup"}}', 'UnknownTransaction'],
    ['{"code":-32000,"message":"Failed to dispatch call: CannotLookup"}', 'DispatchError CannotLookup'],
    ['{"code":-32000,"message":"failed to run contract: ConsumerRemaining"}', 'DispatchError ConsumerRemaining'],
    ['{"code":-32000,"message":"Failed to dispatch call: Token(Frozen)"}', 'Token(Frozen)'],
    ['{"code":-32000,"message":"Not enough gas supplied: Off by: 26784185435"}', '-32000 Not enough gas supplied'],
    ['{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 39, error: [0, 0, 0, 0], message: Some(\\"BalanceLow\\") })"}', '-32000 failed to run contract, at the ERC-20 address of an Assets token'],
    ['{"code":-32000,"message":"failed to run contract: Token(CannotCreate)"}', '-32000 failed to run contract, at the ERC-20 address of an Assets token'],
  ] as const) {
    assert.ok(labels(text).includes(label), `${text}: ${labels(text).join(', ')}`);
    assert.match(basis(label), /measured on this chain on Nov 15, 2026/, label);
  }
  // the meanings name what was measured, not the textbook case only
  assert.match(STANDARD.find((s) => s.label === '1014 Priority is too low')?.meaning ?? '', /waiting transaction and of the new one/);
  assert.match(STANDARD.find((s) => s.label === 'Token(Frozen)')?.meaning ?? '', /free - max\(frozen - reserved, 0\.1 tPOT\)/);
  assert.match(STANDARD.find((s) => s.label === 'Token(CannotCreate)')?.meaning ?? '', /ERC-20 address/);
  assert.doesNotMatch(STANDARD.find((s) => s.label === '1013 Transaction Already Imported')?.meaning ?? '', /"pending" nonce/);
  // a 413 is not read into ordinary numbers, and Revive's own "failed to run contract" is not a token's
  assert.deepEqual(labels('the bus came 413 seconds late'), []);
  assert.ok(!labels('{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 80, error: [31, 0, 0, 0], message: Some(\\"InvalidInstruction\\") })"}').some((l) => l.includes('ERC-20')));
  // only the leads are shown before the named module errors
  assert.deepEqual(STANDARD.filter((s) => s.lead).map((s) => s.label).sort(), ['-32000 Not enough gas supplied', '-32000 failed to run contract, at the ERC-20 address of an Assets token']);
});

test('after a used nonce, the advice is to look up the earlier send, never to sign at once with the next nonce', () => {
  // a retry of a send that went through gets "Transaction is outdated": signing with the next nonce would pay twice
  const stale = STANDARD.find((s) => s.label === 'InvalidTransaction Stale')?.meaning ?? '';
  assert.doesNotMatch(stale, /sign with the next one/);
  assert.match(stale, /It may be your own earlier send, and this a retry of it, so do not sign again with a new nonce yet/);
  assert.match(stale, /Settle every earlier send of this payment by the nonce it was signed with \(and by the hash you wrote down before sending it, not by the hash of this refused one\)/);
  assert.match(stale, /While the account is not past that nonce \(get_account shows its nonce\), the send can still be included/);
  assert.match(stale, /find the block where that nonce was used \(recipe 9 step 3\): the transaction with that nonce there is either this payment \(read its result, and the result of a call inside it\) or another transaction/);
  assert.match(stale, /Sign again only what is settled as not done: a send that failed or whose call inside failed, after fixing the cause \(of a batch that stopped part way, only the calls that did not run\), or one that lost its nonce to another transaction, with the nonce from system_accountNextIndex/);
  assert.match(stale, /Keep at most one send of the payment able to run: if another one succeeded, also with a call inside it that failed, replace this one with a harmless transaction of its nonce and a higher tip or fees; if several still wait, keep the one with the lowest nonce and replace the others at once \(recipe 9\)/);
  assert.match(stale, /Behind a nonce gap it runs only once the missing nonces are used: after replacing any other send, send a harmless transaction with each missing nonce, not the payment \(recipe 9, A nonce gap\)/);
  assert.match(stale, /It is this payment when its hash is one you wrote down for it, and the other payment when you wrote its hash down for that one; with a hash you never wrote down \(a wallet speed-up has another hash\), it is this payment when its call, recipient and amount are the same/);
  assert.match(stale, /At the account's next nonce while get_account shows that nothing waits, it was refused or dropped: if no other send of this payment succeeded or still waits, sign it again with that same nonce/);
  assert.match(stale, /Otherwise wait for it or replace it with the same nonce \(recipe 9\); do not sign the payment with another nonce/);
  assert.doesNotMatch(stale, /in neither place/, 'a failed earlier send is in a block and must be sent again once fixed');
  const e12 = ERROR_ENTRIES.find((e) => e.id === 'E12')?.body ?? '';
  assert.match(e12, /^ {2}- After `Transaction is outdated`, or a bare 1010 from the Ethereum RPC for a nonce already used, do not sign again at once/m);
  assert.match(e12, /not by the refused one's hash: signed again, a transaction can have other bytes and another hash/);
  assert.match(e12, /Settle every earlier send of this payment by the nonce it was signed with, not by the refused one's hash/);
  assert.match(e12, /While the account's nonce in blocks \(`System\.Account\.nonce`\) is not past that nonce, the send can still be included: it waits in the pool \(recipe 9 step 1b, or get_transaction\), or behind a nonce gap, where nothing lists it/);
  assert.match(e12, /Once the account is past that nonce, recipe 9 step 3 finds the block where it was used \(it finds none until that block is finalized: ask again a few seconds later\)\. The account's transaction with that nonce in that block is either this payment or another transaction; if it is another, that send can never be included/);
  assert.match(e12, /^ {2}- If the transaction with that nonce is this payment, read its result\. If it succeeded, do not send it again\. If the transaction itself failed, it paid its fee and moved nothing\./m);
  assert.match(e12, /Sign again only what is settled as not done: a send that failed or whose call inside failed \(after fixing the cause; of a batch that stopped part way, only the calls that did not run\), or one that lost its nonce to another transaction, with the nonce from `system_accountNextIndex`/);
  assert.match(e12, /Keep at most one send of the payment able to run: if another one succeeded, also with a call inside it that failed, replace this one with a harmless transaction of its nonce and a higher tip or higher fees; if several still wait, keep the one with the lowest nonce and replace the others at once the same way/);
  assert.match(e12, /Behind a nonce gap it runs only once the missing nonces are used: after replacing any other send as below, send a harmless transaction with each missing nonce, not the payment \(Fix bullet 4\)/);
  assert.match(e12, /Recognise the payment by a hash you wrote down for one of its sends \(recipe 5a, or 5b for a native extrinsic\); a transaction whose hash you wrote down for another payment is that payment\. Only when its hash is none you wrote down/);
  assert.match(e12, /if anyone else sends from the account, ask them first, since an equal payment of theirs looks the same/);
  assert.match(e12, /At the account's next nonce while nothing waits \(`system_accountNextIndex` equals `System\.Account\.nonce`\), it is not waiting: it was refused or dropped/);
  assert.match(e12, /Otherwise wait for it, or replace it with a transaction of the same nonce \(recipe 9\), and do not sign the payment with another nonce/);
  assert.match(e12, /With no record of a send's nonce, settle every nonce the account used since the first send in the same way/);
  assert.doesNotMatch(e12, /sign with the next one/);
  assert.doesNotMatch(e12, /in neither place/);
  // a used nonce seen in a 1012 does not tell whose transaction was included
  assert.match(STANDARD.find((s) => s.label === '1012 Transaction is temporarily banned')?.meaning ?? '', /this transaction or another with that nonce was included; do not send it again before you know which/);
  // the recorded replies get this line and E12 first
  for (const text of ['1010: Invalid Transaction: Transaction is outdated', '{"code":1010,"message":"Invalid Transaction","data":"Transaction is outdated"}']) {
    assert.ok(standardMatches(focusText(text)).some((s) => s.label === 'InvalidTransaction Stale'), text);
    assert.equal(matchEntries(focusText(text))[0]?.entry.id, 'E12', text);
  }
});

test('the error @polkadot/api throws from validateTransaction lists E55, although it names only the runtime', () => {
  // as the library throws it: no camel-case validateTransaction, only the runtime's name in the backtrace
  const thrown = '4003: Client error: Execution failed: Execution aborted due to trap: wasm trap: wasm `unreachable` instruction executed\nWASM backtrace:\nerror while executing at wasm backtrace:\n    0: 0xb05592 - portaldot_v3_runtime.wasm!__rustc[4b1ee1ef74718a7b]::rust_begin_unwind\n    1:  0x1f5f9 - portaldot_v3_runtime.wasm!core[973facb28fb2967]::panicking::panic_fmt\n    2: 0x9465bd - portaldot_v3_runtime.wasm!TaggedTransactionQueue_validate_transaction';
  // the same in a log of more than 6 lines, where only the lines that look like an error are kept
  const logged = `${thrown}\n    at async main (file:///C:/work/check.mjs:12:3)`;
  for (const text of [thrown, logged]) {
    const found = matchEntries(focusText(text));
    assert.equal(found[0]?.entry.id, 'E34', text);
    const e55 = found.find((m) => m.entry.id === 'E55');
    assert.ok(e55, `E55 is not listed for ${text}`);
    assert.ok(e55.score < 6, 'E55 is related, not the best match');
  }
  // a 1002 comes from submitting the bytes, not from this call
  const submitted = '1002: Verification Error: Runtime error: Execution failed: Execution aborted due to trap: wasm trap: wasm `unreachable` instruction executed\nWASM backtrace:\n    2: 0x9465bd - portaldot_v3_runtime.wasm!TaggedTransactionQueue_validate_transaction';
  assert.ok(!matchEntries(focusText(submitted)).some((m) => m.entry.id === 'E55'));
});

test('the numbers of "insufficient funds" are read in tPOT', () => {
  const testnet = pickNetwork('testnet');
  const withGas = readFunds('{"code":-32000,"message":"insufficient funds for gas * price + value (2208055164315450): address 0x8ddee436166f311ddeed36d714b08f512670d16e have 14720367762103006325 (supplied gas Some(1458424811304789))"}', testnet).join('\n');
  assert.match(withGas, /can spend 14\.720367762103006325 tPOT \(14720367762103006325 wei\), its eth_getBalance/);
  assert.match(withGas, /the gas field, 1458424811304789 gas, x the base fee \(about 15140 wei per gas\), in native units: 22\.0805516431545 tPOT/);
  assert.match(withGas, /The value is not in that number/);
  const noGas = readFunds('{"code":-32000,"message":"insufficient funds for gas * price + value (0): address 0x8ddee436166f311ddeed36d714b08f512670d16e have 0 (supplied gas None)"}', testnet).join('\n');
  assert.match(noGas, /no gas field, so the number in brackets is 0 and no fee was counted/);
  const estimate = readFunds('insufficient funds for gas * price + value (0): address 0x8ddee436166f311ddeed36d714b08f512670d16e have 5 (supplied gas Some(18446744073709551615))', testnet).join('\n');
  assert.match(estimate, /no gas field/);
  assert.deepEqual(readFunds('insufficient funds for gas', testnet), []);
});

test('the Ethereum RPC\'s own "Invalid transaction" (-32000) is not the pool\'s "Invalid Transaction" (1010)', () => {
  const own = '{"code":-32000,"message":"Invalid transaction"}';
  const pool = '{"code":1010,"message":"Invalid Transaction"}';
  assert.ok(!matchEntries(own).some((m) => m.entry.id === 'E1'), 'the RPC\'s own refusal must not point to E1');
  assert.ok(!matchEntries(pool).some((m) => m.entry.id === 'E35'), 'the pool\'s refusal must not point to E35');
  const labels = (t: string): string[] => standardMatches(t).map((s) => s.label);
  assert.ok(labels(own).some((l) => l.startsWith('-32000 Invalid transaction')));
  assert.ok(!labels(own).includes('1010 Invalid Transaction'));
  assert.ok(labels(pool).includes('1010 Invalid Transaction'));
  assert.ok(!labels(pool).some((l) => l.startsWith('-32000 Invalid transaction')));
  // a text with no code at all is read as the pool's
  assert.equal(matchEntries('Invalid Transaction')[0]?.entry.id, 'E1');
});

test('texts that only mention a code or a method of the new entries do not get them in full', () => {
  const full = (t: string): string | undefined => { const m = matchEntries(focusText(t))[0]; return m && m.score >= 6 ? m.entry.id : undefined; };
  for (const [text, not] of [
    ['error 1001 while reading the receipt', 'E34'],
    ['signature verification error', 'E34'],
    ['1011: Unknown Transaction Validity: CannotLookup', 'E12'],
    ['eth_sendRawTransaction: {"code":-32000,"message":"transaction underpriced"}', 'E35'],
    ['{"code":4001,"message":"User rejected the request.","data":{"method":"eth_sendTransaction"}}', 'E37'],
    ['the node was started with --rpc-methods unsafe mode', 'E38'],
    ['the keeper paused caller 0x12 until the next round', 'E38'],
  ] as const) assert.notEqual(full(text), not, text);
});

test('a filtered call finds E38 first, also in the form the pallets address gives a module error (E29)', () => {
  for (const text of [
    'System.CallFiltered',
    'proxy.ProxyExecuted: Err(system.CallFiltered)',
    // E29's form for a module error, with this error's numbers: E38 comes before E29, the route it came by
    '{"code":-32000,"message":"Failed to dispatch call: Module(ModuleError { index: 0, error: [5, 0, 0, 0], message: Some(\\"CallFiltered\\") })"}',
    'Is the chain in safe mode?',
    'TxPause.pausedCalls',
    'pallet_tx_pause',
    'pallet_safe_mode',
  ]) assert.equal(matchEntries(focusText(text))[0]?.entry.id, 'E38', text);
});

test('a long answer is matched on its error lines only', () => {
  const answer = ['Dry run of a contract call, made by the node just now.', 'Result: the transaction reverts.', 'Good to know', '- Events a contract emits are only Revive.ContractEmitted events in the block.', '- A storage deposit is held, not spent.', 'more', 'and more'].join('\n');
  assert.ok(!focusText(answer).includes('ContractEmitted'));
  assert.ok(focusText(answer).includes('reverts'));
});

test('module errors given as numbers are read in every common form', () => {
  const forms: Array<[string, { module: number; error: number }]> = [
    ['{ "index": 6, "error": "0x02000000" }', { module: 6, error: 2 }],
    ['{"module":{"index":80,"error":"0x18000000"}}', { module: 80, error: 24 }],
    ["{ Module: { index: '6', error: '0x02000000' } }", { module: 6, error: 2 }],
    ['{"Module":{"index":"6","error":"0x02000000"}}', { module: 6, error: 2 }],
    ['Module { index: 80, error: [12, 0, 0, 0] }', { module: 80, error: 12 }],
    ['Failed to dispatch call: Module(ModuleError { index: 39, error: [3, 0, 0, 0], message: Some(\\"Unknown\\") })', { module: 39, error: 3 }],
    ['{"index":6,"error":2}', { module: 6, error: 2 }],
    ['module 6 error 2', { module: 6, error: 2 }],
    ['Revive.TransferFailed (module 80, error 4)', { module: 80, error: 4 }],
    ['6.2', { module: 6, error: 2 }],
  ];
  for (const [text, want] of forms) assert.deepEqual(findModulePairs(text), [want], text);
  assert.deepEqual(findModulePairs('block 6.2 seconds'), []);
  assert.deepEqual(findModulePairs('the fee was 0.0123 tPOT'), []);
});

test('revert data: Error(string), Panic(uint256) and known custom errors', () => {
  const msg = '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000c74657374206d6573736167650000000000000000000000000000000000000000';
  assert.match(readRevert(msg), /the message "test message"/);
  assert.match(readRevert('0x4e487b710000000000000000000000000000000000000000000000000000000000000011'), /Panic\(0x11\)/);
  assert.deepEqual(findReverts(`{"code":3,"message":"execution reverted: revert: test message","data":"${msg}"}`), [msg]);
  assert.deepEqual(findReverts('{"code":3,"message":"execution reverted: ","data":"0x"}'), ['0x']);
  assert.deepEqual(findReverts('{"code":-32000,"message":"hash not found","data":"0x1234"}'), [], 'data outside a revert is not revert data');
  // ERC20InsufficientBalance(sender, balance 5, needed 100)
  const custom = '0xe450d38c0000000000000000000000008ddee436166f311ddeed36d714b08f512670d16e00000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000064';
  assert.match(readRevert(custom), /ERC20InsufficientBalance\(address,uint256,uint256\).*balance = 5, needed = 100/);
});

test('custom error selectors are the published ones', () => {
  // Selectors of OpenZeppelin Contracts 5 errors as the library and block explorers list them.
  const known: Record<string, string> = {
    '0xe450d38c': 'ERC20InsufficientBalance(address,uint256,uint256)',
    '0xfb8f41b2': 'ERC20InsufficientAllowance(address,uint256,uint256)',
    '0x118cdaa7': 'OwnableUnauthorizedAccount(address)',
    '0x7e273289': 'ERC721NonexistentToken(uint256)',
    '0x3ee5aeb5': 'ReentrancyGuardReentrantCall()',
    '0xd93c0665': 'EnforcedPause()',
    '0xe2517d3f': 'AccessControlUnauthorizedAccount(address,bytes32)',
    '0x5274afe7': 'SafeERC20FailedOperation(address)',
    '0x9996b315': 'AddressEmptyCode(address)',
  };
  for (const [selector, signature] of Object.entries(known)) assert.equal(CUSTOM_BY_SELECTOR.get(selector)?.signature, signature, selector);
});

test('standard codes: pool codes, InvalidTransaction reasons, DispatchError kinds, JSON-RPC codes', () => {
  const labels = (t: string): string[] => standardMatches(t).map((s) => s.label);
  assert.ok(labels('1014: Priority is too low: (2 vs 2)').includes('1014 Priority is too low'));
  assert.ok(labels('{"code":1012,"message":"Transaction is temporarily banned"}').includes('1012 Transaction is temporarily banned'));
  assert.ok(labels('1010: Invalid Transaction: Transaction has a bad signature').includes('InvalidTransaction BadProof'));
  assert.ok(labels('Failed to dispatch call: Token(FundsUnavailable)').includes('Token(FundsUnavailable)'));
  assert.ok(labels('{"arithmetic":"Underflow"}').includes('Arithmetic(Underflow)'));
  assert.ok(labels('{"code":-32602,"message":"Invalid params"}').includes('JSON-RPC -32602 Invalid params'));
  // a Solidity panic is not a Substrate arithmetic error, and a block number is not a pool code
  assert.ok(!labels('execution reverted: panic: arithmetic underflow or overflow (0x11)').some((l) => l.startsWith('Arithmetic')));
  assert.deepEqual(labels('the transfer was in block 1014 of the chain'), []);
  // codes and texts measured on Nov 15, 2026
  assert.ok(labels('1040: Client error: Could not decode `OpaqueExtrinsic.0`: Not enough data to decode vector').includes('1040 Client error'));
  assert.ok(labels('1011: Unknown Transaction Validity: NoUnsignedValidator').includes('1011 Unknown Transaction Validity'));
  assert.ok(labels('{"code":-32602,"message":"Invalid params","data":"No more params"}').includes('Invalid params: No more params'));
  assert.ok(labels('{"code":-32000,"message":"Ethereum block not found"}').includes('-32000 Ethereum block not found'));
  for (const label of ['1001 Extrinsic has invalid format', '1002 Verification Error', '1011 Unknown Transaction Validity', '1012 Transaction is temporarily banned', '1013 Transaction Already Imported', '1040 Client error', 'Token(BelowMinimum)', 'Token(NotExpendable)', 'Token(CannotCreate)']) {
    assert.match(STANDARD.find((s) => s.label === label)?.basis ?? '', /measured on this chain on Nov 1[45], 2026/, label);
  }
  // what we did not measure says so
  for (const s of STANDARD) assert.match(s.basis, /standard Substrate meaning, not measured by us on this chain|standard JSON-RPC 2\.0 meaning|measured on this chain on Nov 1[45], 2026/, s.label);
});

test('our list explains some module errors in brackets', () => {
  assert.equal(listNotes('Revive', 'TransferFailed').note, 'a value larger than what the account can spend, E47 (E10)');
  // a lock gives the same reply, so the entry on locked tPOT is listed with it
  assert.ok(listNotes('Revive', 'TransferFailed').ids.includes('E47'));
  assert.ok(listNotes('Revive', 'StorageDepositLimitExhausted').ids.includes('E7'));
  assert.deepEqual(listNotes('Contracts', 'OutOfGas').ids, [], 'the Contracts module is not the one E10 speaks of');
  // a bracket in a Basis or Not known part is a block number or a doubt, not a cause
  assert.ok(listNotes('Proxy', 'NotProxy').ids.includes('E29'));
  assert.equal(listNotes('Proxy', 'NotProxy').note, null);
  assert.equal(listNotes('Revive', 'CallDataTooLarge').note, null);
  assert.ok(listNotes('Revive', 'MaxCallDepthReached').ids.includes('E49'));
});
