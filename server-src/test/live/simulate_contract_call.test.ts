// simulate_contract_call against the live chains. The contract is found at run time (revive.accountInfoOf),
// and what the tool prints is checked a second way: the return data against eth_call on the Ethereum RPC,
// msg.sender against keccak-256 of the account id computed here, and the limits and the total against
// the rules applied to the tool's own numbers. No assertion depends on a balance or a block number.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAddress, keccakAsU8a } from '@polkadot/util-crypto';
import tool from '../../src/tools/simulate_contract_call.ts';
import { runTool } from '../../src/lib/tool.ts';
import { closeAll, getConn } from '../../src/lib/chain.ts';
import { readDryRun, reviveDryRun } from '../../src/lib/dryrun.ts';
import { NETWORKS } from '../../src/lib/networks.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const TREASURY = '5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z';
const TREASURY_H160 = '0x8ddee436166f311ddeed36d714b08f512670d16e';
const UNUSED = '0x1111111111111111111111111111111111111111';
const DECIMALS = '0x313ce567';
const ED = 10_000_000_000_000n;

const run = (args: unknown) => runTool(tool, args);
const hex = (u: Uint8Array): string => `0x${Buffer.from(u).toString('hex')}`;

async function eth(method: string, params: unknown[]): Promise<{ result?: string; error?: { code: number; message: string } }> {
  const res = await fetch(NETWORKS.testnet.evm!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
  return (await res.json()) as { result?: string; error?: { code: number; message: string } };
}

function get(text: string, re: RegExp): string {
  const m = re.exec(text);
  assert.ok(m, `missing ${re} in:\n${text}`);
  return m[1];
}

/** The money lines of an answer, as numbers. */
function money(text: string) {
  return {
    refTime: BigInt(get(text, /weight required: refTime (\d+)/)),
    proofSize: BigInt(get(text, /weight required: refTime \d+, proofSize (\d+)/)),
    limitRefTime: BigInt(get(text, /\(\+10%\): refTime (\d+)/)),
    limitProofSize: BigInt(get(text, /\(\+10%\): refTime \d+, proofSize (\d+)/)),
    net: /storage deposit: net 0 /.test(text) ? 0n : BigInt(get(text, /storage deposit: net a (?:charge|refund) of \S+ \S+ \((\d+) base units\)/)),
    depositLimit: BigInt(get(text, /storageDepositLimit to pass[^:]*: \S+ \S+ \((\d+) base units\)/)),
    fee: BigInt(get(text, /fee \(paymentInfo, with these limits\): \S+ \S+ \((\d+) base units\)/)),
    total: BigInt(get(text, /total needed: [^=]+= \S+ \S+ \((\d+) base units\)/)),
    free: BigInt(get(text, /free balance of \S+: \S+ \S+ \((\d+) base units\)/)),
  };
}

let ERC20 = '';

before(async () => {
  // A contract that answers decimals() with one word and reverts on an unknown selector, found at run time.
  const conn = await getConn('testnet');
  const api = conn.api as Loose;
  const page = await api.query.revive.accountInfoOf.entriesPaged({ args: [], pageSize: 100 });
  const contracts = page.filter(([, v]: Loose) => v.toJSON()?.accountType?.contract).map(([k]: Loose) => k.args[0].toHex() as string);
  const from = decodeAddress(TREASURY);
  for (const c of contracts) {
    const d = readDryRun(await reviveDryRun(conn, 'call', [from, c, 0n, null, null, DECIMALS]), 'call');
    if (!d.ok || d.ok.reverted || d.ok.data.length !== 66) continue;
    const bad = readDryRun(await reviveDryRun(conn, 'call', [from, c, 0n, null, null, '0xdeadbeef']), 'call');
    if (bad.ok?.reverted) {
      ERC20 = c;
      break;
    }
  }
  assert.ok(ERC20, `no contract among ${contracts.length} answers decimals() with one word`);
});

test('a view returns a value: decimals() matches eth_call, msg.sender is the 0x form, limits follow the rules', async () => {
  const { text, isError } = await run({ from: TREASURY, to: ERC20, data: DECIMALS });
  assert.equal(isError, false, text);
  assert.match(text, /Result: it succeeds and returns one 32-byte word\. As a number: \d+/);
  assert.match(text, /is a contract: \d+ bytes of EVM code \(code hash 0x[0-9a-f]{64}\)/);
  const data = get(text, /- return data: (0x[0-9a-f]{64})\n/);
  const viaEth = await eth('eth_call', [{ from: TREASURY_H160, to: ERC20, data: DECIMALS }, 'latest']);
  assert.equal(viaEth.result, data);
  assert.equal(get(text, /msg\.sender = (0x[0-9a-fA-F]{40})/).toLowerCase(), hex(keccakAsU8a(decodeAddress(TREASURY), 256).subarray(12)));
  assert.match(text, /msg\.value = 0 tPOT \(0 wei\)/);
  const m = money(text);
  assert.equal(m.limitRefTime, m.refTime + m.refTime / 10n);
  assert.equal(m.limitProofSize, m.proofSize + m.proofSize / 10n);
  assert.ok(m.fee > 0n);
  assert.equal(m.total, m.depositLimit + m.fee + ED);
  assert.match(text, new RegExp(`api\\.tx\\.revive\\.call\\('${ERC20}', 0n, \\{ refTime: ${m.limitRefTime}n, proofSize: ${m.limitProofSize}n \\}, ${m.depositLimit}n, '${DECIMALS}'\\)`));
  assert.match(text, /not served by eth_getLogs/);
});

test('the same view from the Treasury\'s 0x form runs as the Treasury', async () => {
  const { text, isError } = await run({ from: TREASURY_H160, to: ERC20, data: DECIMALS });
  assert.equal(isError, false, text);
  assert.match(text, new RegExp(`Its tPOT sits on ${TREASURY} \\(the native account linked to it\\)`));
});

test('an unknown selector reverts, as eth_call says too', async () => {
  const { text, isError } = await run({ from: TREASURY, to: ERC20, data: '0xdeadbeef' });
  assert.equal(isError, false, text);
  assert.match(text, /Result: it reverts\./);
  assert.match(text, /Sending it as it is would fail/);
  assert.doesNotMatch(text, /To send it as the native call/);
  const viaEth = await eth('eth_call', [{ from: TREASURY_H160, to: ERC20, data: '0xdeadbeef' }, 'latest']);
  assert.ok(viaEth.error, `eth_call did not revert: ${JSON.stringify(viaEth)}`);
});

test('a value to a non-payable view reverts, and the advice names the value', async () => {
  const { text } = await run({ from: TREASURY, to: ERC20, data: DECIMALS, value: '100000000000000' });
  assert.match(text, /Result: it reverts\./);
  assert.match(text, /Check the value too: a Solidity function that is not payable reverts/);
  assert.match(text, /msg\.value = 1 tPOT \(1000000000000000000 wei\)/);
});

test('a non-contract address: a plain transfer, and a new account costs its 0.1 existential deposit', async () => {
  const { text, isError } = await run({ from: TREASURY, to: UNUSED, value: '100000000000000' });
  assert.equal(isError, false, text);
  assert.match(text, /there is no contract at 0x1111111111111111111111111111111111111111 on the Portaldot V3 testnet/);
  assert.match(text, /plain transfer of 1 tPOT/);
  const m = money(text);
  assert.equal(m.net, ED);
  assert.equal(m.depositLimit, ED + ED / 50n);
  assert.equal(m.total, 100_000_000_000_000n + m.depositLimit + m.fee + ED);
});

test('a value larger than the balance: the chain refuses it with Revive.TransferFailed', async () => {
  const { text, isError } = await run({ from: TREASURY, to: UNUSED, value: '1000000000000000000000000000000' });
  assert.equal(isError, false, text);
  assert.match(text, /the chain refuses this call: Revive\.TransferFailed \(module 80, error \d+\)/);
  assert.match(text, /If this number is in wei/);
});

test('a built-in precompile: identity (0x...04) returns its input', async () => {
  const { text } = await run({ from: TREASURY, to: '0x0000000000000000000000000000000000000004', data: '0x1234' });
  assert.match(text, /built-in precompile/);
  assert.match(text, /- return data: 0x1234\n/);
});

test('bad input is refused with what to do', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ from: TREASURY, to: '0x1234' }, /0x and 40 hex characters/],
    [{ from: TREASURY, to: TREASURY }, /native 5\.\.\. address.*convert_address/],
    [{ from: TREASURY, to: ERC20, data: '0x313' }, /odd number of hex digits/],
    [{ from: TREASURY, to: ERC20, data: 'decimals()' }, /must be hex/],
    [{ from: TREASURY, to: ERC20, value: '1.5' }, /convert_amount/],
    [{ from: 'legal winner thank year wave sausage worth useful legal winner thank yellow', to: ERC20 }, /secret phrase|recovery phrase/],
  ];
  for (const [args, re] of cases) {
    const { text, isError } = await run(args);
    assert.equal(isError, true, `${JSON.stringify(args)} was not refused:\n${text}`);
    assert.match(text, re);
  }
});

test('the mainnet: no contract at that address is the normal answer there', async () => {
  const { text, isError } = await run({ from: TREASURY, to: ERC20, data: DECIMALS, network: 'mainnet' });
  assert.equal(isError, false, text);
  assert.match(text, /on the Portaldot V3 mainnet/);
  assert.match(text, /there is no contract at 0x[0-9a-fA-F]{40} on the Portaldot V3 mainnet/);
  assert.match(text, /0 POT/);
  assert.match(text, /no public Ethereum RPC/);
  assert.doesNotMatch(text, /tPOT/);
});

after(async () => {
  await closeAll();
});
