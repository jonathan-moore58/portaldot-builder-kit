// The pure helpers behind simulate_contract_call and simulate_contract_deploy: input checks, reading
// the node's dry-run JSON, the limits to pass, CREATE and CREATE2, and reading build artifacts.
// No network. The address vectors come from two places that do not share code with the helpers:
// EIP-1014's own examples, and addresses the V3 chain itself computed (dry runs and receipts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  budgetLines,
  byteLen,
  create2Address,
  createAddress,
  depositLimitOf,
  depositText,
  depositValue,
  explainDryRunError,
  hexShown,
  parseContractAddress,
  parseHexInput,
  parseNativeValue,
  readDryRun,
  weightLimitOf,
} from '../../src/lib/dryrun.ts';
import { ToolError } from '../../src/lib/errors.ts';
import { NETWORKS } from '../../src/lib/networks.ts';
import { bytecodeFromJson, cleanBytecode, isInside, readArtifact } from '../../src/tools/simulate_contract_deploy.ts';

const testnet = NETWORKS.testnet;
const isToolError = (re: RegExp) => (e: unknown): boolean => e instanceof ToolError && re.test(e.message);
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

test('parseHexInput: lower case, whole bytes, exact and maximum sizes, no secret phrase', () => {
  assert.equal(parseHexInput('0xABcd', 'data'), '0xabcd');
  assert.equal(parseHexInput('abcd', 'data'), '0xabcd');
  assert.equal(parseHexInput('0x', 'data'), '0x');
  assert.throws(() => parseHexInput('0xabc', 'data'), isToolError(/odd number of hex digits/));
  assert.throws(() => parseHexInput('0xzz', 'data'), isToolError(/must be hex/));
  assert.throws(() => parseHexInput('0x12', 'salt', { exactBytes: 32 }), isToolError(/exactly 32 bytes .* got 1 bytes/));
  assert.equal(parseHexInput(`0x${'11'.repeat(32)}`, 'salt', { exactBytes: 32 }), `0x${'11'.repeat(32)}`);
  assert.throws(() => parseHexInput('0x112233', 'data', { maxBytes: 2 }), isToolError(/3 bytes; this tool takes at most 2/));
  assert.throws(() => parseHexInput(PHRASE, 'data'), isToolError(/secret recovery phrase/));
});

test('parseNativeValue: digits only, u128 at most, with advice for decimals', () => {
  assert.equal(parseNativeValue('0'), 0n);
  assert.equal(parseNativeValue(' 100000000000000 '), 100000000000000n);
  assert.equal(parseNativeValue('1_000'), 1000n);
  assert.equal(parseNativeValue(((1n << 128n) - 1n).toString()), (1n << 128n) - 1n);
  assert.throws(() => parseNativeValue((1n << 128n).toString()), isToolError(/larger than a u128/));
  assert.throws(() => parseNativeValue('1.5'), isToolError(/whole number of native base units.*convert_amount/));
  assert.throws(() => parseNativeValue('-1'), isToolError(/cannot be negative/));
  assert.throws(() => parseNativeValue(''), isToolError(/value is empty/));
  assert.equal(parseNativeValue(5), 5n);
  assert.throws(() => parseNativeValue(1.5), isToolError(/whole number of native base units, not 1\.5.*convert_amount/));
  assert.throws(() => parseNativeValue(2 ** 60), isToolError(/above 2\^53 - 1 as a JSON number/));
  assert.throws(() => parseNativeValue('1e18'), isToolError(/digits only/));
});

test('parseContractAddress: 0x and 40 hex characters; a 5... address is refused with its remedy', () => {
  assert.equal(parseContractAddress('0x019030Bff84bbf433C0668196aCd288cD763e4A2'), '0x019030bff84bbf433c0668196acd288cd763e4a2');
  assert.throws(() => parseContractAddress('5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z'), isToolError(/native 5\.\.\. address.*convert_address/));
  assert.throws(() => parseContractAddress('0x1234'), isToolError(/4 characters after 0x/));
});

test('depositValue: a charge is positive, a refund negative; numbers or hex strings', () => {
  assert.equal(depositValue({ charge: 384150000000000 }), 384150000000000n);
  assert.equal(depositValue({ charge: '0x000000000000000000205e67fe8c7000' }), 9111000000000000n);
  assert.equal(depositValue({ refund: 384150000000000 }), -384150000000000n);
  assert.equal(depositValue({ charge: 0 }), 0n);
  assert.equal(depositValue(undefined), null);
  assert.equal(depositValue({}), null);
});

// Shapes as the V3 testnet returned them on Nov 14, 2026.
const CALL_OK = { weightConsumed: { refTime: 5816016, proofSize: 2022 }, weightRequired: { refTime: 5816016, proofSize: 2022 }, storageDeposit: { charge: 0 }, maxStorageDeposit: { charge: 0 }, gasConsumed: 0, result: { ok: { flags: { bits: 0 }, data: '0x0000000000000000000000000000000000000000000000000000000000000012' } } };
const CALL_REVERT = { weightRequired: { refTime: 6272838, proofSize: 2022 }, storageDeposit: { charge: 0 }, maxStorageDeposit: { charge: 0 }, result: { ok: { flags: { bits: 1 }, data: '0x' } } };
const CALL_ERR = { weightRequired: { refTime: 0, proofSize: 0 }, storageDeposit: { charge: 0 }, maxStorageDeposit: { charge: 0 }, result: { err: { module: { index: 80, error: '0x04000000' } } } };
const DEPLOY_OK = { weightRequired: { refTime: 116190, proofSize: 0 }, storageDeposit: { charge: 1318800000000000 }, maxStorageDeposit: { charge: 1318800000000000 }, result: { ok: { result: { flags: { bits: 0 }, data: '0x01' }, addr: '0x30ca0ab4156e37027841a1504e78aae6116468db' } } };
const DEPLOY_HEX_WEIGHT = { weightRequired: { refTime: 2000000000000, proofSize: '0xffffffffffffffff' }, storageDeposit: { charge: 0 }, result: { err: { module: { index: 80, error: '0x1f000000' } } } };

test('readDryRun: call and instantiate shapes, reverts, errors and an unknown shape', () => {
  const ok = readDryRun(CALL_OK, 'call');
  assert.deepEqual(ok.weight, { refTime: 5816016n, proofSize: 2022n });
  assert.equal(ok.net, 0n);
  assert.equal(ok.max, 0n);
  assert.equal(ok.ok?.reverted, false);
  assert.equal(ok.ok?.data, CALL_OK.result.ok.data);
  assert.equal(ok.ok?.addr, null);
  assert.equal(readDryRun(CALL_REVERT, 'call').ok?.reverted, true);
  const err = readDryRun(CALL_ERR, 'call');
  assert.equal(err.ok, null);
  assert.deepEqual(err.err, { module: { index: 80, error: '0x04000000' } });
  const dep = readDryRun(DEPLOY_OK, 'instantiate');
  assert.equal(dep.net, 1318800000000000n);
  assert.equal(dep.ok?.data, '0x01');
  assert.equal(dep.ok?.addr, '0x30ca0ab4156e37027841a1504e78aae6116468db');
  assert.equal(readDryRun(DEPLOY_HEX_WEIGHT, 'instantiate').weight.proofSize, 0xffffffffffffffffn);
  assert.equal(readDryRun({ ...CALL_OK, maxStorageDeposit: undefined }, 'call').max, null);
  assert.throws(() => readDryRun({ gasRequired: 1 }, 'call'), isToolError(/shape these tools do not know.*gasRequired/));
});

test('the limits to pass: weight + 10%, deposit = the larger of net and maximum + 2%, never below 0', () => {
  assert.deepEqual(weightLimitOf({ refTime: 5816016n, proofSize: 2022n }), { refTime: 6397617n, proofSize: 2224n });
  assert.deepEqual(weightLimitOf({ refTime: 0n, proofSize: 0n }), { refTime: 0n, proofSize: 0n });
  assert.equal(depositLimitOf(384150000000000n, 384150000000000n), 391833000000000n);
  // a net of 0 that holds 3.8415 on the way: the limit must cover the maximum
  assert.equal(depositLimitOf(0n, 384150000000000n), 391833000000000n);
  assert.equal(depositLimitOf(-384150000000000n, 0n), 0n);
  assert.equal(depositLimitOf(1318800000000000n, null), 1345176000000000n);
  assert.equal(depositText(0n, testnet), '0 tPOT');
  assert.equal(depositText(384150000000000n, testnet), 'a charge of 3.8415 tPOT (384150000000000 base units)');
  assert.equal(depositText(-384150000000000n, testnet), 'a refund of 3.8415 tPOT (384150000000000 base units)');
});

test('CREATE: vectors computed by the V3 chain itself (two dry runs and three Ethereum deployments)', () => {
  // dry runs of Nov 14, 2026: the Treasury's 0x form at nonce 0, and an account at nonce 8151 (a two-byte RLP nonce)
  assert.equal(createAddress('0x8ddee436166f311ddeed36d714b08f512670d16e', 0n), '0x30ca0ab4156e37027841a1504e78aae6116468db');
  assert.equal(createAddress('0x3bf5c340884892c742b2964bd65bd85de3885bc8', 8151n), '0xab95fc48ff682fe6fcab49e742f9cf045c182b0a');
  // receipts of Ethereum creation transactions on the testnet (contractAddress), sender and transaction nonce
  assert.equal(createAddress('0xf3a73e7fa1b01f0f77970fa81e922bac589b64a4', 0n), '0x93ca24a53ec91488ff7841ac9a00cc0ce7ac82fa');
  assert.equal(createAddress('0x9fc79e370c3c37de07b42513e13e7f1d4db8d223', 3n), '0xd9f1fb1d6f634696763a345890f32c50603b653a');
  assert.equal(createAddress('0x421d297a9d9ba5112ede43e96f83a54c4e4aafdb', 16n), '0x5199051d8c1f390f32ec4be50cfb50ea6f8f59cb');
});

test('CREATE: one-byte and two-byte RLP nonces (127, 128, 255, 256, 8151) give distinct 20-byte addresses', () => {
  const seen = new Set<string>();
  for (const n of [0n, 1n, 127n, 128n, 255n, 256n, 8151n, 70000n]) {
    const a = createAddress('0x8ddee436166f311ddeed36d714b08f512670d16e', n);
    assert.match(a, /^0x[0-9a-f]{40}$/);
    seen.add(a);
  }
  assert.equal(seen.size, 8);
});

test('CREATE2: the examples of EIP-1014, and one the V3 chain computed with a salt and constructor arguments', () => {
  const z20 = `0x${'00'.repeat(20)}`;
  const z32 = `0x${'00'.repeat(32)}`;
  assert.equal(create2Address(z20, z32, '0x00'), '0x4d1a2e2bb4f88f0250f26ffff098b0b30b26bf38');
  assert.equal(create2Address('0xdeadbeef00000000000000000000000000000000', z32, '0x00'), '0xb928f69bb1d91cd65274e3c79d8986362984fda3');
  assert.equal(create2Address('0xdeadbeef00000000000000000000000000000000', '0x000000000000000000000000feed000000000000000000000000000000000000', '0x00'), '0xd04116cdd17bebe565eb2422f2497e06cc1c9833');
  assert.equal(create2Address(z20, z32, '0xdeadbeef'), '0x70f2b2914a2a4b783faefb75f459a580616fcb5e');
  assert.equal(create2Address('0x00000000000000000000000000000000deadbeef', '0x00000000000000000000000000000000000000000000000000000000cafebabe', '0xdeadbeef'), '0x60f3f640a8508fc6a86d45df051962668e1e8ac7');
  assert.equal(create2Address(z20, z32, '0x'), '0xe33c0c7f7df4809055c3eba6c09cfe4baf1bd9e0');
  // reviveApi.instantiate on Nov 14, 2026: the Treasury, salt 0x11 x 32, the one-byte vector followed by one uint256 argument (5)
  assert.equal(create2Address('0x8ddee436166f311ddeed36d714b08f512670d16e', `0x${'11'.repeat(32)}`, `0x600160005360016000f3${'00'.repeat(31)}05`), '0xaee53cd645a5fcb88f5ea137fa35c8929397dd86');
});

test('hexShown and byteLen', () => {
  assert.equal(byteLen('0x'), 0);
  assert.equal(byteLen('0x1234'), 2);
  assert.equal(hexShown('0x1234'), '0x1234');
  const long = `0x${'ab'.repeat(1500)}`;
  const shown = hexShown(long);
  assert.ok(shown.startsWith(`0x${'ab'.repeat(1000)}...`));
  assert.match(shown, /cut: 1500 bytes in all/);
});

test('budgetLines: the total, the verdict, and frozen funds above reserved ones', () => {
  const ed = 10_000_000_000_000n;
  const parts = { value: 0n, depositLimit: 391833000000000n, fee: 2140498665402n, ed };
  const rich = budgetLines(testnet, parts, { exists: true, free: 10n ** 20n, reserved: 0n, frozen: 0n, nonce: 0n }, 'X');
  assert.equal(rich.total, 391833000000000n + 2140498665402n + ed);
  assert.equal(rich.enough, true);
  assert.match(rich.lines.join('\n'), /verdict: enough/);
  const empty = budgetLines(testnet, parts, { exists: false, free: 0n, reserved: 0n, frozen: 0n, nonce: 0n }, 'X');
  assert.equal(empty.enough, false);
  assert.match(empty.lines.join('\n'), /does not exist yet[\s\S]*NOT enough\. X is short by 4\.03973498665402 tPOT/);
  // 5 tPOT free, 3 frozen, 1 reserved: 2 of the frozen part bind free funds, so 3 tPOT are usable
  const T = 100_000_000_000_000n;
  const locked = budgetLines(testnet, { value: 0n, depositLimit: 3n * T, fee: 0n, ed: 0n }, { exists: true, free: 5n * T, reserved: 1n * T, frozen: 3n * T, nonce: 0n }, 'X');
  assert.equal(locked.enough, true);
  assert.match(locked.lines.join('\n'), /2 tPOT of it is frozen.*counts 3 tPOT as usable/);
  const fee = budgetLines(testnet, { ...parts, fee: null }, { exists: true, free: 10n ** 20n, reserved: 0n, frozen: 0n, nonce: 0n }, 'X');
  assert.match(fee.lines[0], /without the fee, which could not be estimated/);
});

test('explainDryRunError: a module error by name with the chain text, an unknown index, another shape', () => {
  const api = {
    registry: {
      findMetaError: (u: Uint8Array) => {
        if (u[0] === 80 && u[1] === 4) return { section: 'revive', name: 'TransferFailed', docs: ['Performing the requested transfer failed.'] };
        throw new Error('not found');
      },
    },
  };
  const named = explainDryRunError(api, { module: { index: 80, error: '0x04000000' } });
  assert.equal(named.name, 'Revive.TransferFailed');
  assert.equal(named.title, 'Revive.TransferFailed (module 80, error 4)');
  assert.match(named.lines.join(' '), /The chain's text: "Performing the requested transfer failed\."/);
  assert.match(named.lines.join(' '), /value is more than "from" can pay/);
  const unknown = explainDryRunError(api, { module: { index: 99, error: '0x01000000' } });
  assert.equal(unknown.name, null);
  assert.match(unknown.lines[0], /no error with that index/);
  const other = explainDryRunError(api, { token: 'FundsUnavailable' });
  assert.equal(other.name, null);
  assert.match(other.lines[0], /"token":"FundsUnavailable"/);
});

test('cleanBytecode: whitespace is allowed; placeholders, empty, non-hex, 32 bytes, too large and phrases are refused', () => {
  assert.equal(cleanBytecode('  0x6001\n6000f3 ', 'code'), '0x60016000f3');
  assert.equal(cleanBytecode('600160005360016000f3', 'code'), '0x600160005360016000f3');
  assert.throws(() => cleanBytecode('0x6080__$1234567890123456789012345678901234$__00', 'code'), isToolError(/1 unlinked library placeholder/));
  assert.throws(() => cleanBytecode('0x', 'code'), isToolError(/holds no bytecode .*interface or an abstract contract/));
  assert.throws(() => cleanBytecode('hello', 'code'), isToolError(/not hex bytecode/));
  assert.throws(() => cleanBytecode('0x123', 'code'), isToolError(/odd number of hex digits/));
  assert.throws(() => cleanBytecode(`0x${'ab'.repeat(32)}`, 'code'), isToolError(/exactly 32 bytes, the size of a private key/));
  assert.throws(() => cleanBytecode(`0x${'00'.repeat(250_001)}`, 'code'), isToolError(/250001 bytes .* at most 250000/));
  assert.doesNotThrow(() => cleanBytecode(`0x${'00'.repeat(250_000)}`, 'code'));
  assert.throws(() => cleanBytecode(PHRASE, 'code'), isToolError(/secret recovery phrase/));
});

test('bytecodeFromJson: Foundry, Hardhat, solc, Remix and solc standard output; keystores and unknown files are refused', () => {
  const v = '0x600160005360016000f3';
  assert.deepEqual(bytecodeFromJson({ bytecode: { object: v, linkReferences: {} } }, 'f'), { hex: v, format: 'Foundry (bytecode.object)' });
  assert.deepEqual(bytecodeFromJson({ bytecode: v }, 'f'), { hex: v, format: 'Hardhat (bytecode)' });
  assert.deepEqual(bytecodeFromJson({ evm: { bytecode: { object: v.slice(2) } } }, 'f'), { hex: v, format: 'solc (evm.bytecode.object)' });
  assert.deepEqual(bytecodeFromJson({ data: { bytecode: { object: v.slice(2) } } }, 'f'), { hex: v, format: 'Remix (data.bytecode.object)' });
  assert.equal(bytecodeFromJson({ contracts: { 'a.sol': { I: { evm: { bytecode: { object: '' } } }, A: { evm: { bytecode: { object: v } } } } } }, 'f').hex, v);
  assert.throws(() => bytecodeFromJson({ contracts: { 'a.sol': { A: { evm: { bytecode: { object: '6001' } } }, B: { evm: { bytecode: { object: '6002' } } } } } }, 'f'), isToolError(/2 deployable contracts \(a\.sol:A, a\.sol:B\)/));
  assert.throws(() => bytecodeFromJson({ bytecode: { object: '0x6080__$1234567890123456789012345678901234$__00', linkReferences: { 'src/L.sol': { L: [] } } } }, 'f'), isToolError(/placeholder.*src\/L\.sol:L/));
  assert.throws(() => bytecodeFromJson({ version: 3, crypto: { cipher: 'aes-128-ctr' } }, 'f'), isToolError(/encrypted wallet keystore/));
  assert.throws(() => bytecodeFromJson({ abi: [] }, 'f'), isToolError(/No bytecode found in f.*top-level fields are: abi/));
  assert.throws(() => bytecodeFromJson([1, 2], 'f'), isToolError(/not an object/));
});

test('readArtifact: reads one file, resolves a relative path against CLAUDE_PROJECT_DIR, refuses the rest without echoing it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-artifact-'));
  const saved = process.env.CLAUDE_PROJECT_DIR;
  try {
    writeFileSync(join(dir, 'Counter.json'), JSON.stringify({ abi: [], bytecode: { object: '0x600160005360016000f3', linkReferences: {} } }));
    writeFileSync(join(dir, 'Counter.bin'), '600160005360016000f3\n');
    writeFileSync(join(dir, 'Bad.json'), 'SECRET-LOOKING TEXT {');
    writeFileSync(join(dir, 'Counter.sol'), 'contract C {}');
    // only files inside the project folder are read
    process.env.CLAUDE_PROJECT_DIR = join(dir, 'no-such-project');
    await assert.rejects(readArtifact(join(dir, 'Counter.json')), isToolError(/There is no file at|inside the project folder/));
    process.env.CLAUDE_PROJECT_DIR = dir;
    const abs = await readArtifact(join(dir, 'Counter.json'));
    assert.equal(abs.hex, '0x600160005360016000f3');
    assert.equal(abs.format, 'Foundry (bytecode.object)');
    await assert.rejects(readArtifact(join(dir, '..', 'elsewhere.json')), isToolError(/There is no file at|inside the project folder/));
    await assert.rejects(readArtifact('\\\\some-host\\share\\A.json'), isToolError(/network or device path/));
    await assert.rejects(readArtifact('//some-host/share/A.json'), isToolError(/network or device path/));
    assert.equal((await readArtifact('Counter.bin')).format, 'plain hex (.bin)');
    await assert.rejects(readArtifact('Counter.sol'), isToolError(/must name a \.json, \.bin, \.hex or \.txt file/));
    await assert.rejects(readArtifact('missing.json'), isToolError(/There is no file at .*the relative path was read against/));
    await assert.rejects(readArtifact('Bad.json'), (e: unknown) => e instanceof ToolError && /is not valid JSON/.test(e.message) && !/SECRET/.test(e.message));
    writeFileSync(join(dir, 'Big.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x30));
    await assert.rejects(readArtifact('Big.txt'), isToolError(/5242881 bytes; this tool reads artifacts of at most 5242880/));

    // A text artifact holds exactly one line; a line of 64 hex characters is refused whatever the count.
    const key = (i: number): string => (i.toString(16).padStart(2, '0')).repeat(32);
    writeFileSync(join(dir, 'keys5.txt'), Array.from({ length: 5 }, (_, i) => key(i + 1)).join('\n'));
    writeFileSync(join(dir, 'keys10.hex'), Array.from({ length: 10 }, (_, i) => `0x${key(i + 1)}`).join('\r\n'));
    writeFileSync(join(dir, 'keys4-and-short.bin'), `${[1, 2, 3, 4].map(key).join('\n')}\nab`);
    writeFileSync(join(dir, 'two-lines.txt'), '6001600053\n60016000f3\n');
    writeFileSync(join(dir, 'one-line.txt'), '\n  0x600160005360016000f3  \n\n');
    for (const f of ['keys5.txt', 'keys10.hex', 'keys4-and-short.bin']) {
      await assert.rejects(readArtifact(f), (e: unknown) => e instanceof ToolError && /of exactly 32 bytes of hex, which is what private keys look like/.test(e.message) && !e.message.includes(key(1)), f);
    }
    await assert.rejects(readArtifact('two-lines.txt'), isToolError(/holds 2 lines\. A bytecode file \(\.bin, \.hex, \.txt\) holds one line of hex/));
    assert.equal((await readArtifact('one-line.txt')).hex, '0x600160005360016000f3');

    // A path outside the project is refused before any file is touched: the same answer whether it exists or not.
    const outsideMsg = /must be a file inside the project folder .* is outside it, so nothing was read/;
    mkdirSync(join(dir, 'proj'));
    process.env.CLAUDE_PROJECT_DIR = join(dir, 'proj');
    await assert.rejects(readArtifact(join(dir, 'Counter.json')), isToolError(outsideMsg)); // exists
    await assert.rejects(readArtifact(join(dir, 'pd-no-such-file.json')), isToolError(outsideMsg)); // does not exist
    await assert.rejects(readArtifact('../Counter.json'), isToolError(outsideMsg));
    await assert.rejects(readArtifact('sub/../../pd-no-such-file.json'), isToolError(outsideMsg));
    process.env.CLAUDE_PROJECT_DIR = dir;
    // a file inside the project whose name starts with two dots is inside
    writeFileSync(join(dir, '..dots.json'), JSON.stringify({ bytecode: '0x600160005360016000f3' }));
    assert.equal((await readArtifact('..dots.json')).hex, '0x600160005360016000f3');
    assert.equal(isInside(dir, join(dir, '..dots.json')), true);
    assert.equal(isInside(dir, join(dir, '..', 'x.json')), false);
    assert.equal(isInside(dir, dir), false);

    // Only field names that look like identifiers are named when a JSON file has no bytecode.
    writeFileSync(join(dir, 'odd.json'), JSON.stringify({ abi: [], [`0x${key(9)}`]: 1, [key(7)]: 2, a_b9: 3, ['x'.repeat(31)]: 4 }));
    await assert.rejects(readArtifact('odd.json'), (e: unknown) => e instanceof ToolError && /top-level fields are: abi, a_b9, 3 other field names not shown\./.test(e.message) && !e.message.includes(key(9).slice(0, 10)) && !e.message.includes('xxxxxxxxxx'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
