// The list of errors and traps (references/errors.md), the file generated from it, and the pure parts
// of explain_error. No network: every check here runs offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_ENTRIES, ERROR_INTRO } from '../../src/generated/errors.ts';
import { CUSTOM_BY_SELECTOR, ENTRY_PATTERNS, STANDARD, findModulePairs, findReverts, focusText, listNotes, matchEntries, readRevert, standardMatches } from '../../src/tools/explain_error.ts';

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
  ];
  for (const [text, id] of cases) assert.equal(matchEntries(focusText(text))[0]?.entry.id, id, text);
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
  // what we did not measure says so
  for (const s of STANDARD) assert.match(s.basis, /standard Substrate meaning, not measured by us on this chain|standard JSON-RPC 2\.0 meaning|measured on this chain on Nov 14, 2026/, s.label);
});

test('our list explains some module errors in brackets', () => {
  assert.equal(listNotes('Revive', 'TransferFailed').note, 'a value larger than the balance (E10)');
  assert.ok(listNotes('Revive', 'StorageDepositLimitExhausted').ids.includes('E7'));
  assert.deepEqual(listNotes('Contracts', 'OutOfGas').ids, [], 'the Contracts module is not the one E10 speaks of');
});
