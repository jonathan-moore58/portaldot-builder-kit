// simulate_contract_deploy against the live chains. Init code is written by hand here, so the runtime
// size is known exactly; random runtime bytes make sure the code is never already on the chain. Each
// address is checked against CREATE or CREATE2 computed in this file (its own RLP and keccak-256), with
// the nonce read from the raw System.Account bytes, and each deposit against the rule
// 0.06 x (L + 70) x 1.3 + 7.65 tokens (+ 3.8415 per new storage slot). No assertion depends on a balance.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blake2AsU8a, decodeAddress, encodeAddress, keccakAsHex, keccakAsU8a, randomAsU8a, xxhashAsU8a } from '@polkadot/util-crypto';
import tool from '../../src/tools/simulate_contract_deploy.ts';
import { runTool } from '../../src/lib/tool.ts';
import { closeAll } from '../../src/lib/chain.ts';
import { NETWORKS, type NetworkKey } from '../../src/lib/networks.ts';

const TREASURY = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const VECTOR = '0x600160005360016000f3'; // returns the one-byte runtime 0x01
const T = 100_000_000_000_000n; // one token in base units
const RULE = (L: bigint): bigint => (6n * T * (L + 70n) * 13n) / 1000n + 765n * T / 100n; // 0.06 x (L+70) x 1.3 + 7.65
const SLOT = 384_150_000_000_000n;

const run = (args: unknown) => runTool(tool, args);
const hex = (u: Uint8Array): string => `0x${Buffer.from(u).toString('hex')}`;
const h160Of = (ss58: string): string => hex(keccakAsU8a(decodeAddress(ss58), 256).subarray(12));

function get(text: string, re: RegExp): string {
  const m = re.exec(text);
  assert.ok(m, `missing ${re} in:\n${text}`);
  return m[1];
}

async function rpc(key: NetworkKey, method: string, params: unknown[]): Promise<string | null> {
  const url = NETWORKS[key].ws.replace(/^wss:/, 'https:');
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  const body = (await res.json()) as { result?: string | null };
  return body.result ?? null;
}

/** The account nonce from the raw System.Account bytes: twox128("System") ++ twox128("Account") ++ blake2_128(id) ++ id. */
async function nonceOf(key: NetworkKey, ss58: string): Promise<bigint> {
  const id = decodeAddress(ss58);
  const storageKey = hex(new Uint8Array([...xxhashAsU8a('System', 128), ...xxhashAsU8a('Account', 128), ...blake2AsU8a(id, 128), ...id]));
  const raw = await rpc(key, 'state_getStorage', [storageKey]);
  if (!raw) return 0n;
  const b = Buffer.from(raw.slice(2), 'hex');
  return BigInt(b.readUInt32LE(0));
}

function rlpCreate(deployer: string, nonce: bigint): string {
  let n: number[];
  if (nonce === 0n) n = [0x80];
  else if (nonce < 0x80n) n = [Number(nonce)];
  else {
    const h = nonce.toString(16);
    const bytes = [...Buffer.from(h.length % 2 ? `0${h}` : h, 'hex')];
    n = [0x80 + bytes.length, ...bytes];
  }
  const body = [0x94, ...Buffer.from(deployer.slice(2), 'hex'), ...n];
  return hex(keccakAsU8a(Uint8Array.from([0xc0 + body.length, ...body]), 256).subarray(12));
}
const create2 = (deployer: string, salt: string, init: string): string =>
  hex(keccakAsU8a(Buffer.concat([Buffer.from([0xff]), Buffer.from(deployer.slice(2), 'hex'), Buffer.from(salt.slice(2), 'hex'), Buffer.from(keccakAsU8a(Buffer.from(init.slice(2), 'hex'), 256))]), 256).subarray(12));

/** Init code that returns `payload` as the runtime code, optionally after writing storage slot 0 (SSTORE). */
function initReturning(payload: string, sstore = false): string {
  const n = (payload.length - 2) / 2;
  const pre = sstore ? '6001600055' : '';
  const offset = 14 + pre.length / 2;
  const n2 = n.toString(16).padStart(4, '0');
  return `0x${pre}61${n2}60${offset.toString(16).padStart(2, '0')}60003961${n2}6000f3${payload.slice(2)}`;
}
/** Runtime bytes that are new to the chain: 0x00 (STOP) and then random bytes. */
const freshRuntime = (n: number): string => `0x00${Buffer.from(randomAsU8a(n - 1)).toString('hex')}`;

const deposit = (text: string): bigint => BigInt(get(text, /storage deposit: \S+ \S+ \((\d+) base units\), from the dry run/));

test('the one-byte vector: 13.188 tPOT, explained part by part, at the CREATE address of the Treasury and its nonce', async () => {
  const nonce = await nonceOf('testnet', TREASURY);
  const { text, isError } = await run({ from: TREASURY, code: VECTOR });
  assert.equal(isError, false, text);
  assert.match(text, /Result: it would deploy\. The constructor runs and returns 1 byte of runtime code\./);
  assert.match(text, /- runtime code: 1 byte, code hash 0x5fe7f977e71dba2ea1a68e21057beebb9be2ac30c6410aa38d4f3fbe41dcffd2 \(keccak-256\)/);
  assert.equal(keccakAsHex('0x01', 256), '0x5fe7f977e71dba2ea1a68e21057beebb9be2ac30c6410aa38d4f3fbe41dcffd2');
  assert.equal(deposit(text), 1_318_800_000_000_000n);
  assert.equal(deposit(text), RULE(1n));
  assert.match(text, /sum: 13\.188 tPOT, the same as the chain's figure\. In short: 0\.078 tPOT x L \+ 13\.11 tPOT for new code/);
  assert.equal(get(text, /address it would get: (0x[0-9a-fA-F]{40})/).toLowerCase(), rlpCreate(h160Of(TREASURY), nonce));
  assert.match(text, /the same as the chain's answer/);
  assert.match(text, /It changes when the nonce does/);
  const limit = BigInt(get(text, /storageDepositLimit to pass \(\+2%\): \S+ \S+ \((\d+) base units\)/));
  assert.equal(limit, 1_318_800_000_000_000n + 1_318_800_000_000_000n / 50n);
  const fee = BigInt(get(text, /fee \(paymentInfo, with these limits\): \S+ \S+ \((\d+) base units\)/));
  assert.equal(BigInt(get(text, /total needed: [^=]+= \S+ \S+ \((\d+) base units\)/)), limit + fee + 10_000_000_000_000n);
  assert.match(text, /api\.tx\.revive\.instantiateWithCode\(0n, \{ refTime: \d+n, proofSize: \d+n \}, 1345176000000000n, '0x600160005360016000f3', '0x', null\)/);
  assert.match(text, /creation transaction, with no "to"/);
});

test('the deposit rule holds for fresh runtime code of 300 and 2000 bytes, and one storage slot adds 3.8415', async () => {
  for (const L of [300, 2000]) {
    const { text, isError } = await run({ from: TREASURY, code: initReturning(freshRuntime(L)) });
    assert.equal(isError, false, text);
    assert.match(text, new RegExp(`returns ${L} bytes of runtime code`));
    assert.equal(deposit(text), RULE(BigInt(L)), `L = ${L}`);
    assert.match(text, /the same as the chain's figure/);
  }
  const { text } = await run({ from: TREASURY, code: initReturning(freshRuntime(100), true) });
  assert.equal(deposit(text), RULE(100n) + SLOT);
  assert.match(text, /storage the constructor writes: 1 new 32-byte slot x 3\.8415 tPOT = 3\.8415 tPOT/);
});

test('runtime code that is already on the chain is not charged again (checked at run time)', async () => {
  // init code returning the one-byte runtime 0x00
  const { text, isError } = await run({ from: TREASURY, code: '0x600060005360016000f3' });
  assert.equal(isError, false, text);
  if (/already stored on this chain/.test(text)) {
    assert.equal(deposit(text), RULE(1n) - 6n * T * 71n / 100n); // the code deposit 0.06 x 71 is left out
    assert.match(text, /is already stored on the Portaldot V3 testnet, so its code deposit is not charged again/);
  } else {
    assert.equal(deposit(text), RULE(1n));
  }
});

test('a salt gives the CREATE2 address of the deployer, the salt and the init code with its arguments', async () => {
  const salt = `0x${'11'.repeat(32)}`;
  const args = `0x${'00'.repeat(31)}05`;
  const { text, isError } = await run({ from: TREASURY, code: VECTOR, salt, constructor_args: args });
  assert.equal(isError, false, text);
  assert.match(text, /init code: 42 bytes \(10 of bytecode \+ 32 of constructor arguments\)/);
  assert.equal(get(text, /address it would get: (0x[0-9a-fA-F]{40})/).toLowerCase(), create2(h160Of(TREASURY), salt, VECTOR + args.slice(2)));
  assert.match(text, /It does not depend on the nonce/);
});

test('reverting constructors: no reason, Error(string) and a custom error', async () => {
  const plain = await run({ from: TREASURY, code: '0x60006000fd' });
  assert.match(plain.text, /Result: the constructor reverts, so nothing would be deployed\. It reverted without a reason/);
  assert.match(plain.text, /no cost is shown/);
  // copies Error("no") (100 bytes) into memory and reverts with it
  const errorNo = '08c379a0' + '20'.padStart(64, '0') + '02'.padStart(64, '0') + '6e6f'.padEnd(64, '0');
  const message = await run({ from: TREASURY, code: `0x6064600c60003960646000fd${errorNo}` });
  assert.match(message.text, /It reverted with the message "no"\./);
  const custom = await run({ from: TREASURY, code: '0x63deadbeef60e01b60005260046000fd' });
  assert.match(custom.text, /a custom error whose selector is 0xdeadbeef/);
  assert.match(custom.text, /- revert data \(4 bytes\): 0xdeadbeef/);
});

test('an account with no balance: the chain answers StorageDepositNotEnoughFunds, and the cost is read from a funded account', async () => {
  const empty = encodeAddress(randomAsU8a(32), 42);
  const { text, isError } = await run({ from: empty, code: VECTOR });
  assert.equal(isError, false, text);
  assert.match(text, new RegExp(`the chain refuses it from ${empty}: Revive\\.StorageDepositNotEnoughFunds \\(module 80, error \\d+\\)`));
  assert.match(text, /has 0 tPOT free \(the account does not exist yet\)/);
  assert.match(text, /The same dry run from a funded account \(the Treasury/);
  assert.equal(deposit(text), RULE(1n));
  assert.equal(get(text, /address it would get from \S+: (0x[0-9a-fA-F]{40})/).toLowerCase(), rlpCreate(h160Of(empty), 0n));
  assert.match(text, /verdict: NOT enough/);
});

test('a value larger than the balance is refused by the chain (Revive.TransferFailed)', async () => {
  const { text } = await run({ from: TREASURY, code: VECTOR, value: '1000000000000000000000000000000' });
  assert.match(text, /the chain refuses this deployment: Revive\.TransferFailed/);
});

test('a Foundry artifact is read from disk: only that file, and only inside the project folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-deploy-'));
  const project = join(dir, 'project');
  const before = process.env.CLAUDE_PROJECT_DIR;
  try {
    mkdirSync(join(project, 'out'), { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = project;
    const file = join(project, 'out', 'Counter.json');
    writeFileSync(file, JSON.stringify({ abi: [], bytecode: { object: VECTOR, linkReferences: {} }, deployedBytecode: { object: '0x01' } }));
    for (const path of [file, 'out/Counter.json']) {
      const { text, isError } = await run({ from: TREASURY, artifact_path: path });
      assert.equal(isError, false, text);
      assert.match(text, /init code: 10 bytes, read from .*Counter\.json, Foundry \(bytecode\.object\)/);
      assert.equal(deposit(text), RULE(1n));
      // bytecode that came from a file is never printed back
      assert.ok(!text.includes(VECTOR), 'the init code of a file was printed');
    }
    writeFileSync(join(project, 'out', 'Iface.json'), JSON.stringify({ abi: [], bytecode: { object: '0x' } }));
    const iface = await run({ from: TREASURY, artifact_path: join(project, 'out', 'Iface.json') });
    assert.equal(iface.isError, true);
    assert.match(iface.text, /interface or an abstract contract/);

    // a file outside the project folder is refused, by an absolute path and by a relative one
    const outside = join(dir, 'outside.json');
    writeFileSync(outside, JSON.stringify({ bytecode: { object: VECTOR } }));
    for (const path of [outside, '../outside.json']) {
      const refused = await run({ from: TREASURY, artifact_path: path });
      assert.equal(refused.isError, true, refused.text);
      assert.match(refused.text, /must be a file inside the project folder/);
    }
    // a network path is refused before anything is read
    for (const path of ['\\\\some-host\\share\\out\\A.json', '//some-host/share/out/A.json']) {
      const refused = await run({ from: TREASURY, artifact_path: path });
      assert.equal(refused.isError, true, refused.text);
      assert.match(refused.text, /network or device path/);
    }
    // a file that looks like a list of private keys is refused, and its content is not printed
    const keys = join(project, 'keys.txt');
    const fake = 'ab'.repeat(32);
    writeFileSync(keys, `00${'cd'.repeat(31)}\n${fake}\n`);
    const refusedKeys = await run({ from: TREASURY, artifact_path: keys });
    assert.equal(refusedKeys.isError, true, refusedKeys.text);
    assert.match(refusedKeys.text, /what private keys look like/);
    assert.ok(!refusedKeys.text.includes(fake));
  } finally {
    if (before === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refusals: one of code and artifact_path, unlinked libraries, empty, non-hex, too large, wrong files, bad salt, secrets', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ from: TREASURY }, /exactly one of code .* and artifact_path/],
    [{ from: TREASURY, code: VECTOR, artifact_path: 'x.json' }, /exactly one of code/],
    [{ from: TREASURY, code: '0x6080__$1234567890123456789012345678901234$__00' }, /unlinked library placeholder/],
    [{ from: TREASURY, code: '0x' }, /holds no bytecode/],
    [{ from: TREASURY, code: 'hello' }, /not hex bytecode/],
    [{ from: TREASURY, code: `0x${'00'.repeat(250_001)}` }, /250001 bytes of bytecode; this tool takes at most 250000/],
    [{ from: TREASURY, artifact_path: 'contracts/Counter.sol' }, /must name a \.json, \.bin, \.hex or \.txt file/],
    [{ from: TREASURY, artifact_path: 'pd-no-such-dir/Missing.json' }, /There is no file at/],
    // outside the project the answer is the same whether the file exists or not
    [{ from: TREASURY, artifact_path: join(tmpdir(), 'pd-no-such-dir', 'Missing.json') }, /must be a file inside the project folder/],
    [{ from: TREASURY, code: VECTOR, salt: '0x12' }, /salt must be exactly 32 bytes/],
    [{ from: TREASURY, code: VECTOR, value: '1.5' }, /convert_amount/],
    [{ from: TREASURY, code: `0x${'ab'.repeat(32)}` }, /size of a private key/],
    [{ from: TREASURY, code: `0x${'ab'.repeat(64)}` }, /size of a private key or a seed/],
    [{ from: TREASURY, code: 'legal winner thank year wave sausage worth useful legal winner thank yellow' }, /secret recovery phrase/],
  ];
  for (const [args, re] of cases) {
    const { text, isError } = await run(args);
    assert.equal(isError, true, `${JSON.stringify(args).slice(0, 120)} was not refused:\n${text}`);
    assert.match(text, re);
  }
});

test('the mainnet: the same dry run in POT, and the native call is the only way to deploy there', async () => {
  const nonce = await nonceOf('mainnet', TREASURY);
  const { text, isError } = await run({ from: TREASURY, code: VECTOR, network: 'mainnet' });
  assert.equal(isError, false, text);
  assert.match(text, /on the Portaldot V3 mainnet/);
  assert.match(text, /storage deposit: 13\.188 POT \(1318800000000000 base units\)/);
  assert.equal(get(text, /address it would get: (0x[0-9a-fA-F]{40})/).toLowerCase(), rlpCreate(h160Of(TREASURY), nonce));
  assert.match(text, /has no public Ethereum RPC .* use the native call/);
  assert.doesNotMatch(text, /tPOT/);
});

after(async () => {
  await closeAll();
});
