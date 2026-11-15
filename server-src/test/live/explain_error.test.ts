// explain_error against the live chain. The first tests prove that a text without a module error is
// answered without any connection; the later ones check module errors against the chain's own
// registry (a second way to the same name), and feed the error texts that other tools print.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WsProvider } from '@polkadot/api';
import { closeAll, getConn } from '../../src/lib/chain.ts';
import { measuredFor } from '../../src/lib/mistakes.ts';
import { runTool } from '../../src/lib/tool.ts';
import tool from '../../src/tools/explain_error.ts';
import encodeCall from '../../src/tools/encode_call.ts';
import estimateEth from '../../src/tools/estimate_eth_transaction.ts';
import simulateDeploy from '../../src/tools/simulate_contract_deploy.ts';

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TREASURY_SS58 = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const TREASURY_H160 = '0x8ddee436166f311ddeed36d714b08f512670d16e';
// init code whose constructor reverts with Error("test message"), and one that reverts with Panic(0x11)
const REVERT_MESSAGE_INIT = '0x6064600c60003960646000fd08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000c74657374206d6573736167650000000000000000000000000000000000000000';
const MESSAGE_DATA = REVERT_MESSAGE_INIT.slice(0, 2) + REVERT_MESSAGE_INIT.slice(26);
const PANIC_DATA = '0x4e487b710000000000000000000000000000000000000000000000000000000000000011';
/** An address nobody holds a key for, new on every run, so it has no balance. */
const freshH160 = (): string => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString('hex')}`;

// Count the WebSocket connections that are opened, to prove that a pure pattern match opens none.
let connects = 0;
const proto = WsProvider.prototype as unknown as { connect: (...a: unknown[]) => Promise<void> };
const realConnect = proto.connect;
proto.connect = function (this: unknown, ...a: unknown[]) {
  connects++;
  return realConnect.apply(this, a);
};

const explain = (error: string, network?: 'testnet' | 'mainnet') => runTool(tool, network ? { error, network } : { error });
const bestOf = (text: string): string | undefined => /Best match in our list: (E\d+)/.exec(text)?.[1];
/** "Revive.TransferFailed", as findMetaError names it: the section written the way the chain writes the module. */
const chainName = (api: any, module: number, error: number): string => {
  const m = api.registry.findMetaError(Uint8Array.of(module, error));
  const section = String(m.section);
  return `${section.charAt(0).toUpperCase()}${section.slice(1)}.${m.name}`;
};

after(async () => {
  await closeAll();
});

test('error texts of our list find the right entry, and need no connection', async () => {
  const cases: Array<[string, string]> = [
    ['1010: Invalid Transaction: Inability to pay some fees (e.g. account balance too low)', 'E1'],
    ['{"jsonrpc":"2.0","id":1,"error":{"code":1010,"message":"Invalid Transaction"}}', 'E1'],
    ['{"code":-32000,"message":"insufficient funds for gas * price + value (0): address 0x1111111111111111111111111111111111111111 have 0 (supplied gas Some(18446744073709551615))"}', 'E1'],
    ['MetaMask: Review alert. Network fee 7158578160885 gas', 'E2'],
    ['Error: State already discarded for 0x7c05b2dc7486f81a693d676553fa13f380b5be16da7c739b182931cd6cf07001', 'E5'],
    ['eth_getLogs returned [] although the contract emitted the event', 'E6'],
    ['the guide says to call mapAccount first', 'E8'],
    ['REGISTRY: Unknown signed extensions AuthorizeCall, EthSetOrigin found, treating them as no-effect', 'E11'],
    ['1014: Priority is too low: (2 vs 2)', 'E12'],
    ['FetchError: request to https://testnetv3-eth-rpc.feso-apps.xyz/ failed, reason: getaddrinfo ENOTFOUND testnetv3-eth-rpc.feso-apps.xyz', 'E13'],
    ['API-WS: disconnected from wss://test-node-v3.portaldot.dev: 1006:: Abnormal Closure', 'E14'],
    ['Error: HTTP 503 Service Unavailable', 'E14'],
    ['429 Too Many Requests', 'E14'],
    ['eth_getTransactionReceipt returned null for a transaction that is in a block', 'E15'],
    ['approveAsMulti stored only the call hash', 'E16'],
    ['The contract function "aggregate3" returned no data ("0x"). address: 0xcA11bde05977b3631167028862bE2a173976CA11', 'E19'],
    ['eth_simulateV1: {"code":-32601,"message":"Method not found"}', 'E21'],
    ["Error: EPERM: operation not permitted, rename 'state.json.tmp' -> 'state.json'", 'E22'],
    ['{"code":3,"message":"execution reverted: ","data":"0x"}', 'E26'],
    ['{"code":-32000,"message":"Invalid call: Payment"}', 'E27'],
    ['{"code":-32601,"message":"Method not found"}', 'E28'],
    ['{"code":-32000,"message":"Failed to dispatch call: Token(FundsUnavailable)"}', 'E29'],
    ['{"code":3,"message":"execution reverted: revert: Metadata not found","data":"0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000124d65746164617461206e6f7420666f756e640000000000000000000000000000"}', 'E26'],
    ['{"code":-32602,"message":"Invalid params","data":"unknown variant `newHeads`, expected `newBlockHeaders` or `logs` at line 1 column 10"}', 'E30'],
    ['{"code":-32000,"message":"The transaction consumes more than the allowed weight. needed=Weight(ref_time: 1531321961872, proof_size: 23813914) allowed=Weight(ref_time: 1529902658700, proof_size: 14111759216387806985) overweight_by=Weight(ref_time: 1419303172, proof_size: 0)"}', 'E32'],
    ['{"code":-32000,"message":"Failed to filter logs"}', 'E33'],
  ];
  for (const [text, id] of cases) {
    const r = await explain(text);
    assert.equal(r.isError, false, text);
    assert.equal(bestOf(r.text), id, `${text}\n---\n${r.text.slice(0, 600)}`);
  }
  assert.equal(connects, 0, 'a pure pattern match opened a connection');
});

test('both kinds of revert data are decoded, without a connection', async () => {
  const message = await explain(`{"code":3,"message":"execution reverted: revert: test message","data":"${MESSAGE_DATA}"}`);
  assert.match(message.text, /It reverted with the message "test message"/);
  assert.equal(bestOf(message.text), 'E26');
  const panic = await explain(PANIC_DATA);
  assert.match(panic.text, /Panic\(0x11\): arithmetic overflow or underflow/);
  assert.doesNotMatch(panic.text, /Arithmetic\(Underflow\)/, 'a Solidity panic is not a Substrate arithmetic error');
  assert.equal(connects, 0);
});

test('a 1014 text gives the standard meaning, marked as not measured, and E12', async () => {
  const r = await explain('1014: Priority is too low: (2 vs 2)');
  assert.match(r.text, /1014 Priority is too low: .*standard Substrate meaning, not measured by us on this chain/);
  assert.equal(bestOf(r.text), 'E12');
  assert.match(r.text, /Next: get_account/);
  assert.equal(connects, 0);
});

test('an unknown text says so and guesses nothing', async () => {
  const r = await explain('the frobnicator is out of sprockets');
  assert.equal(r.isError, false);
  assert.match(r.text, /^Nothing in this text matches/m);
  assert.match(r.text, /search_chain with kinds \["error"\]/);
  assert.doesNotMatch(r.text, /Best match/);
  assert.equal(connects, 0);
});

test('an entry by its id, the list, and refusals', async () => {
  const e7 = await explain('E7');
  assert.match(e7.text, /E7\. The storage deposit limit is too low/);
  assert.match((await explain('list')).text, /E1\. Error 1010/);
  const missing = await explain('E999');
  assert.equal(missing.isError, true);
  const phrase = await explain('legal winner thank year wave sausage worth useful legal winner thank yellow');
  assert.equal(phrase.isError, true);
  assert.match(phrase.text, /secret recovery phrase/);
  const key = await explain('my private key 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318 fails');
  assert.equal(key.isError, true);
  assert.match(key.text, /private key/);
  assert.equal(connects, 0);
});

test('module errors in every form, named as the chain names them', { timeout: 120_000 }, async () => {
  const { api } = await getConn('testnet');
  const forms: Array<[string, number, number]> = [
    ['{ "index": 6, "error": "0x02000000" }', 6, 2],
    ['Module { index: 80, error: [12, 0, 0, 0] }', 80, 12],
    ['module 6 error 2', 6, 2],
    ['6.2', 6, 2],
    ['dispatchError: {"module":{"index":80,"error":"0x18000000"}}', 80, 24],
    ['{"Module":{"index":"6","error":"0x02000000"}}', 6, 2],
    ['Result: the chain refuses this call: Revive.TransferFailed (module 80, error 4).', 80, 4],
  ];
  for (const [text, module, error] of forms) {
    const r = await explain(text);
    const name = chainName(api, module, error);
    assert.ok(r.text.includes(`- ${name} (module ${module}, error ${error})`), `${text}: expected ${name}\n---\n${r.text.slice(0, 600)}`);
    assert.match(r.text, /testnet's live metadata \(runtime \d+\)/);
  }
  // 80.24 is StorageDepositLimitExhausted today; whatever its name, E7 must follow when it is
  const r24 = await explain('{"module":{"index":80,"error":"0x18000000"}}');
  if (chainName(api, 80, 24) === 'Revive.StorageDepositLimitExhausted') assert.equal(bestOf(r24.text), 'E7');

  // names, with and without the module
  const errors = api.errors as any;
  for (const [text, module, name] of [['balances.InsufficientBalance', 'balances', 'InsufficientBalance'], ['Revive.OutOfGas', 'revive', 'OutOfGas']] as const) {
    const meta = errors[module][name].meta;
    const r = await explain(text);
    const pallet = (api.runtimeMetadata.asLatest.pallets as any[]).find((p) => p.name.toString().toLowerCase() === module);
    assert.ok(r.text.includes(`(module ${pallet.index.toNumber()}, error ${meta.index.toNumber()})`), r.text.slice(0, 600));
  }
  const bare = await explain('NoPermission');
  const holders = Object.keys(errors).filter((section) => errors[section].NoPermission);
  assert.equal((bare.text.match(/^- [A-Za-z]+\.NoPermission \(module/gm) ?? []).length, holders.length, 'every module that has NoPermission is listed');
  assert.ok(holders.length >= 2);

  // the eth-rpc's own text for a module error names it once, by its numbers
  const dispatch = await explain('{"code":-32000,"message":"Failed to dispatch call: Module(ModuleError { index: 39, error: [3, 0, 0, 0], message: Some(\\"Unknown\\") })"}');
  assert.ok(dispatch.text.includes(`- ${chainName(api, 39, 3)} (module 39, error 3)`));
  assert.equal((dispatch.text.match(/^- [A-Za-z]+\.Unknown \(module/gm) ?? []).length, 1);
  assert.equal(bestOf(dispatch.text), 'E29');

  // what the eth-rpc says for an opcode or a precompile the chain does not have (E31)
  for (const [error, name] of [[31, 'InvalidInstruction'], [47, 'UnsupportedPrecompileAddress']] as const) {
    const r = await explain(`{"code":-32000,"message":"failed to run contract: Module(ModuleError { index: 80, error: [${error}, 0, 0, 0], message: Some(\\"${name}\\") })"}`);
    assert.ok(r.text.includes(`- ${chainName(api, 80, error)} (module 80, error ${error})`), r.text.slice(0, 600));
    if (chainName(api, 80, error) === `Revive.${name}`) assert.equal(bestOf(r.text), 'E31');
  }

  // a name the chain does not have
  const none = await explain('Balances.NoSuchError');
  assert.match(none.text, /No module error is named "Balances.NoSuchError"/);
});

test('a variant of the dispatch error is not taken for a module error of the same name', { timeout: 120_000 }, async () => {
  const forms = [
    'Token(BelowMinimum)',
    'Token::BelowMinimum',
    'Token.BelowMinimum',
    'TokenError::BelowMinimum',
    'DispatchError::Token(TokenError::BelowMinimum)',
    '{"token":"BelowMinimum"}',
    'dispatchError: {"token":"BelowMinimum"}',
    "{ token: 'BelowMinimum' }",
    'Token: BelowMinimum',
  ];
  for (const text of forms) {
    const r = await explain(text);
    assert.match(r.text, /Token\(BelowMinimum\): the account would hold less than the minimum/, text);
    assert.doesNotMatch(r.text, /AssetConversion\.BelowMinimum/, text);
  }
  // named with its module, it is still the module's error
  const named = await explain('AssetConversion.BelowMinimum');
  assert.match(named.text, /AssetConversion\.BelowMinimum \(module \d+, error \d+\)/);
  // and a module error written after "Token(" is still named: only the variant names are set aside
  const perm = await explain('Failed to mint Token(NoPermission)');
  assert.match(perm.text, /Assets\.NoPermission/);
});

test('the mainnet names module errors from its own metadata', { timeout: 120_000 }, async () => {
  const { api } = await getConn('mainnet');
  const r = await explain('{"module":{"index":80,"error":"0x18000000"}}', 'mainnet');
  assert.match(r.text, /mainnet's live metadata \(runtime \d+\)/);
  assert.ok(r.text.includes(`- ${chainName(api, 80, 24)} (module 80, error 24)`));
});

test('error texts that other tools print are understood', { timeout: 180_000 }, async () => {
  const fresh = freshH160();

  // estimate_eth_transaction: a constructor that reverts with a message, and a sender with no balance
  const reverted = await runTool(estimateEth, { from: TREASURY_H160, data: REVERT_MESSAGE_INIT });
  assert.match(reverted.text, /execution reverted/);
  const r1 = await explain(reverted.text);
  assert.equal(bestOf(r1.text), 'E26');
  assert.match(r1.text, /the message "test message"/);
  const poor = await runTool(estimateEth, { from: fresh, to: TREASURY_H160, value: '1000000000000000000' });
  const poorLine = /node message: .*$/m.exec(poor.text)?.[0];
  assert.ok(poorLine, poor.text);
  assert.equal(bestOf((await explain(poorLine)).text), 'E1');

  // simulate_contract_deploy from an account with no balance
  const deploy = await runTool(simulateDeploy, { from: fresh, code: '0x600160005360016000f3' });
  const result = /^Result: .*$/m.exec(deploy.text)?.[0];
  assert.ok(result && /module 80, error \d+/.test(result), deploy.text.slice(0, 600));
  for (const input of [result, deploy.text]) {
    const r = await explain(input);
    assert.match(r.text, /Revive\.StorageDepositNotEnoughFunds \(module 80, error \d+\)/);
    assert.equal(bestOf(r.text), 'E7');
  }

  // encode_call with a 0x sender that holds nothing: the Ethereum route's estimate fails
  const encoded = await runTool(encodeCall, { call: 'Balances.transferKeepAlive', args: [TREASURY_SS58, '1000000000000'], sender: fresh });
  // older versions print "eth_estimateGas failed: ...", newer ones the dry run's "reply: {...}"
  const failed = /(?:eth_estimateGas failed: |reply: ).*Failed to dispatch call.*$/m.exec(encoded.text)?.[0];
  assert.ok(failed, encoded.text.slice(0, 800));
  const r3 = await explain(failed);
  assert.equal(bestOf(r3.text), 'E29');
  assert.match(r3.text, /Token\(FundsUnavailable\)/);
});

test('texts measured on Nov 15, 2026: bytes the node cannot read, the two "Invalid transaction", a dispatch error with its cases', { timeout: 120_000 }, async () => {
  // the replies of author_submitExtrinsic (1040), author_submitAndWatchExtrinsic (1001) and both (1002), as @polkadot/api printed them
  const unreadable = [
    '1040: Client error: Could not decode `OpaqueExtrinsic.0`:\n\tNot enough data to decode vector\n',
    '1001: Extrinsic has invalid format: Could not decode `OpaqueExtrinsic.0`:\n\tNot enough data to decode vector\n',
    '1002: Verification Error: Runtime error: Execution failed: Execution aborted due to trap: wasm trap: wasm `unreachable` instruction executed\nWASM backtrace:\nerror while executing at wasm backtrace:\n    0: 0xb05592 - portaldot_v3_runtime.wasm!__rustc[4b1ee1ef74718a7b]::rust_begin_unwind\n    1:  0x1f5f9 - portaldot_v3_runtime.wasm!core[973facb28fb2967]::panicking::panic_fmt\n    2: 0x9465bd - portaldot_v3_runtime.wasm!TaggedTransactionQueue_validate_transaction',
  ];
  for (const text of unreadable) {
    const r = await explain(text);
    assert.equal(bestOf(r.text), 'E34', `${text}\n---\n${r.text.slice(0, 600)}`);
  }
  assert.match((await explain(unreadable[0])).text, /1040 Client error: .*measured on this chain on Nov 15, 2026/);

  // the Ethereum RPC's own refusal against the pool's: the same words, told apart by the code
  const own = await explain('{"code":-32000,"message":"Invalid transaction"}');
  assert.equal(bestOf(own.text), 'E35', own.text.slice(0, 600));
  assert.doesNotMatch(own.text, /^- E1\. /m);
  assert.doesNotMatch(own.text, /- 1010 Invalid Transaction:/);
  const pool = await explain('{"code":1010,"message":"Invalid Transaction"}');
  assert.equal(bestOf(pool.text), 'E1', pool.text.slice(0, 600));
  assert.doesNotMatch(pool.text, /E35\./);

  // a module error inside "Failed to dispatch call": the error and its measured cases first, then E29 short
  const { api } = await getConn('testnet');
  const name = chainName(api, 47, 32);
  const r = await explain('{"code":-32000,"message":"Failed to dispatch call: Module(ModuleError { index: 47, error: [32, 0, 0, 0], message: Some(\\"NoConfig\\") })"}');
  const at = r.text.indexOf(`- ${name} (module 47, error 32)`);
  assert.ok(at >= 0, r.text.slice(0, 800));
  assert.ok(at < r.text.indexOf('Best match in our list: E29'), 'the named error comes before E29');
  assert.match(r.text, /^E29\. "Failed to dispatch call" when a 0x account estimates a native call$/m);
  assert.match(r.text, /Ask explain_error for "E29"/);
  assert.doesNotMatch(r.text, /\*\*Cause:\*\*/, 'E29 is shown with its title and one line only');
  if (name === 'Nfts.NoConfig' && measuredFor('Nfts', 'NoConfig').length) {
    assert.match(r.text, /^ {2}Seen in our testnet dry runs of Nov 15, 2026: Nfts\.mint, /m);
    assert.equal((r.text.match(/references\/native-call-errors\.md/g) ?? []).length, 1, 'the file is named once');
  }
  // a Token variant inside the same form gets its measured cases too
  const below = await explain('{"code":-32000,"message":"Failed to dispatch call: Token(BelowMinimum)"}');
  assert.equal(bestOf(below.text), 'E29');
  assert.ok(below.text.indexOf('Token(BelowMinimum): the account would hold less') < below.text.indexOf('Best match in our list: E29'));
  if (measuredFor('Token', 'BelowMinimum').length) assert.match(below.text, /^ {2}Seen in our testnet dry runs of Nov 15, 2026: /m);
});

test('when the node cannot be reached: pure matches still answer, module errors use the saved metadata', { timeout: 120_000 }, () => {
  const run = (args: unknown) =>
    spawnSync(process.execPath, ['scripts/call.ts', '--file', 'src/tools/explain_error.ts', JSON.stringify(args)], {
      cwd: SERVER_SRC,
      encoding: 'utf8',
      // a local port where nothing listens, so every connection attempt fails at once
      env: { ...process.env, PORTALDOT_TESTNET_WS: 'ws://localhost:9' },
      timeout: 90_000,
    });
  const pure = run({ error: '1014: Priority is too low' });
  assert.equal(pure.status, 0, pure.stderr);
  assert.match(pure.stdout, /Best match in our list: E12/);
  assert.doesNotMatch(pure.stderr, /API-WS|localhost:9/, 'a pure match tried to connect');
  const offline = run({ error: '6.2' });
  assert.match(offline.stdout, /could not be reached/);
  assert.match(offline.stdout, /metadata saved with this tool \(runtime \d+\)/);
  assert.match(offline.stdout, /- Balances\.InsufficientBalance \(module 6, error 2\)/);
});
