import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { keccakAsHex } from '@polkadot/util-crypto';
import * as z from 'zod';
import { readReviveAccount } from '../lib/accounts.ts';
import { checksummed, parseAddress } from '../lib/address.ts';
import { getConn } from '../lib/chain.ts';
import {
  budgetLines,
  byteLen,
  create2Address,
  createAddress,
  depositLimitOf,
  explainDryRunError,
  feeOf,
  hexShown,
  parseHexInput,
  parseNativeValue,
  readBalance,
  readDryRun,
  resolveSender,
  reviveDryRun,
  senderLine,
  TREASURY_SS58,
  weightCode,
  weightLimitOf,
  weightText,
  type DryRun,
} from '../lib/dryrun.ts';
import { ToolError } from '../lib/errors.ts';
import { decodeRevert } from '../lib/evm.ts';
import { formatUnits, lines, nativeAmount } from '../lib/format.ts';
import { NATIVE_DECIMALS, pickNetwork, type Network } from '../lib/networks.ts';
import { defineTool, networkField } from '../lib/tool.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

export const ARTIFACT_EXTENSIONS = ['.json', '.bin', '.hex', '.txt'];
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const MAX_INITCODE_BYTES = 250_000;

/** The contract's own record, measured on Nov 14, 2026 (the same on both networks): 7.65 native tokens. */
const RECORD_DEPOSIT = 765_000_000_000_000n;
/** Bytes the code deposit counts on top of the runtime code, measured on Nov 14, 2026. */
const CODE_OVERHEAD_BYTES = 70n;

/* ---------- reading the init code ---------- */

const PLACEHOLDER = /__\$[0-9a-fA-F]{34}\$__/g;

function linkNames(refs: Loose): string[] {
  if (!refs || typeof refs !== 'object') return [];
  const out: string[] = [];
  for (const [file, libs] of Object.entries(refs)) if (libs && typeof libs === 'object') for (const name of Object.keys(libs)) out.push(`${file}:${name}`);
  return out;
}

/** Bytecode text as 0x hex, or a ToolError that says what is wrong with it. Never echoes the content. */
export function cleanBytecode(raw: string, where: string, links: string[] = []): string {
  const text = raw.trim();
  if (text.split(/\s+/).length >= 12) {
    throw new ToolError(`${where} looks like a secret recovery phrase, not bytecode. This tool does not read keys and has not sent it anywhere. If that phrase is real, treat the account as exposed.`);
  }
  const body = text.replace(/\s+/g, '').replace(/^0x/i, '');
  if (body.includes('__')) {
    const n = (body.match(PLACEHOLDER) ?? []).length;
    throw new ToolError(
      `${where} has ${n ? `${n} unlinked library placeholder${n === 1 ? '' : 's'} (__$...$__)` : 'unlinked library placeholders (__...__)'}${links.length ? ` for ${links.slice(0, 6).join(', ')}` : ''}. ` +
        'The bytecode is not complete until each library is deployed and its address written in. Deploy the library first, then link it ' +
        '(Foundry: forge build --libraries <path>:<Name>:<address>; Hardhat: the libraries option of getContractFactory), or make the library functions internal so they are compiled into the contract.',
    );
  }
  if (!body) {
    throw new ToolError(`${where} holds no bytecode (it is empty). That is what the compiler gives for an interface or an abstract contract, which cannot be deployed. Use the artifact of a concrete contract.`);
  }
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length % 2) {
    throw new ToolError(`${where} is not hex bytecode (${body.length % 2 && /^[0-9a-fA-F]*$/.test(body) ? 'an odd number of hex digits' : 'it has characters other than 0-9 and a-f'}). Give the creation bytecode: 0x followed by hex digits.`);
  }
  const bytes = body.length / 2;
  if (bytes === 32 || bytes === 64) {
    throw new ToolError(`${where} is exactly ${bytes} bytes, the size of a private key or a seed, and far too short for compiled contract bytecode. This tool has not sent it anywhere. Give the contract's creation bytecode instead.`);
  }
  if (bytes > MAX_INITCODE_BYTES) {
    throw new ToolError(`${where} is ${bytes} bytes of bytecode; this tool takes at most ${MAX_INITCODE_BYTES}. The chain itself refused init code above 49152 bytes on Nov 14, 2026, so the contract has to be smaller or split.`);
  }
  return `0x${body.toLowerCase()}`;
}

/** The creation bytecode inside a build artifact: Foundry, Hardhat, solc output or Remix. */
export function bytecodeFromJson(json: Loose, where: string): { hex: string; format: string } {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ToolError(`${where} is JSON but not an object, so it is not a build artifact.`);
  if (json.crypto || json.Crypto || (json.encoded && json.encoding)) {
    throw new ToolError(`${where} looks like an encrypted wallet keystore, not a build artifact. This tool never reads keys; nothing from it was used or sent. Point to the contract's artifact (for example out/<File>.sol/<Contract>.json from Foundry).`);
  }
  if (json.bytecode && typeof json.bytecode === 'object' && typeof json.bytecode.object === 'string') {
    return { hex: cleanBytecode(json.bytecode.object, `The bytecode.object field of ${where}`, linkNames(json.bytecode.linkReferences)), format: 'Foundry (bytecode.object)' };
  }
  if (typeof json.bytecode === 'string') {
    return { hex: cleanBytecode(json.bytecode, `The bytecode field of ${where}`, linkNames(json.linkReferences)), format: 'Hardhat (bytecode)' };
  }
  if (typeof json.evm?.bytecode?.object === 'string') {
    return { hex: cleanBytecode(json.evm.bytecode.object, `The evm.bytecode.object field of ${where}`, linkNames(json.evm.bytecode.linkReferences)), format: 'solc (evm.bytecode.object)' };
  }
  if (typeof json.data?.bytecode?.object === 'string') {
    return { hex: cleanBytecode(json.data.bytecode.object, `The data.bytecode.object field of ${where}`, linkNames(json.data.bytecode.linkReferences)), format: 'Remix (data.bytecode.object)' };
  }
  if (json.contracts && typeof json.contracts === 'object') {
    const found: Array<{ name: string; object: string; refs: Loose }> = [];
    for (const [file, byName] of Object.entries(json.contracts as Record<string, Loose>)) {
      for (const [name, c] of Object.entries((byName ?? {}) as Record<string, Loose>)) {
        const object = c?.evm?.bytecode?.object;
        if (typeof object === 'string' && object.replace(/^0x/, '')) found.push({ name: `${file}:${name}`, object, refs: c.evm.bytecode.linkReferences });
      }
    }
    if (found.length === 1) return { hex: cleanBytecode(found[0].object, `The bytecode of ${found[0].name} in ${where}`, linkNames(found[0].refs)), format: `solc standard JSON output (${found[0].name})` };
    if (found.length > 1) {
      throw new ToolError(`${where} is a full solc output with ${found.length} deployable contracts (${found.slice(0, 8).map((f) => f.name).join(', ')}${found.length > 8 ? ', ...' : ''}). Point to one contract's artifact, or pass its evm.bytecode.object as code.`);
    }
  }
  // Only field names that look like identifiers are named: a file of the wrong kind could use a key as a field name.
  const all = Object.keys(json);
  const named = all.filter((k) => /^[A-Za-z_][A-Za-z0-9_]{0,29}$/.test(k));
  const others = all.length - named.length;
  const fields = [named.slice(0, 10).join(', '), named.length > 10 && `${named.length - 10} more`, others > 0 && `${others} other field name${others === 1 ? '' : 's'} not shown`].filter(Boolean).join(', ');
  throw new ToolError(`No bytecode found in ${where}. Looked for bytecode.object (Foundry), bytecode (Hardhat), evm.bytecode.object (solc) and data.bytecode.object (Remix). Its top-level fields are: ${fields || 'none'}.`);
}

/** A path that would make the operating system contact another machine, or open a device: \\host\share, //host/share, \\?\..., \\.\... */
const isNetworkOrDevicePath = (p: string): boolean => /^[\\/]{2}/.test(p.trim());

/**
 * True when the file lies inside the folder. A name that only starts with two dots ("..dots.json")
 * is inside; ".." itself, or "..\" or "../" in front, is outside.
 */
export function isInside(folder: string, file: string): boolean {
  const rel = relative(folder, file);
  return rel !== '' && !/^\.\.([\\/]|$)/.test(rel) && !isAbsolute(rel);
}

/**
 * Reads the init code from a build artifact on disk. It reads that one file only, never writes,
 * and reads only inside the project folder: a path can come from text the model read somewhere,
 * so it must not be able to name any file on the disk, or a file on another machine.
 * The project folder is CLAUDE_PROJECT_DIR (or the working directory). Everything below it is
 * readable by design, so a project folder set to a drive root makes the whole drive readable.
 */
export async function readArtifact(path: string): Promise<{ hex: string; file: string; format: string }> {
  if (isNetworkOrDevicePath(path)) {
    throw new ToolError('artifact_path must be a file inside the project folder. A network or device path (one that starts with \\\\ or //) is refused, and nothing was read. Copy the artifact into the project, or pass the creation bytecode as code.');
  }
  const base = process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
  const file = isAbsolute(path) ? path : resolve(base, path);
  const ext = extname(file).toLowerCase();
  if (!ARTIFACT_EXTENSIONS.includes(ext)) {
    throw new ToolError(`artifact_path must name a .json, .bin, .hex or .txt file; ${file} ${ext ? `ends in ${ext}` : 'has no extension'}. Give the build artifact, for example out/<File>.sol/<Contract>.json from Foundry.`);
  }
  if (isNetworkOrDevicePath(file) || isNetworkOrDevicePath(base)) {
    throw new ToolError('artifact_path must be a file on this computer, inside the project folder. Nothing was read. Pass the creation bytecode as code instead.');
  }
  const outside = (): ToolError =>
    new ToolError(`artifact_path must be a file inside the project folder (${base}); ${file} is outside it, so nothing was read. Copy the artifact into the project, or pass the creation bytecode as code.`);
  // The path as written is checked before any file is touched, so the answer cannot tell whether a
  // file outside the project exists.
  if (!isInside(resolve(base), resolve(base, path))) throw outside();
  let real: string;
  let baseReal: string;
  try {
    [real, baseReal] = await Promise.all([realpath(file), realpath(base)]);
  } catch {
    throw new ToolError(`There is no file at ${file}${isAbsolute(path) ? '' : ` (the relative path was read against ${base})`}. Build the contract first (forge build, npx hardhat compile), or give its path inside the project.`);
  }
  // The real path is checked too, so a link inside the project cannot point the tool at a file outside it.
  if (isNetworkOrDevicePath(real) || !isInside(baseReal, real)) throw outside();
  const info = await stat(real);
  if (!info.isFile()) throw new ToolError(`${file} is not a file.`);
  if (info.size > MAX_ARTIFACT_BYTES) throw new ToolError(`${file} is ${info.size} bytes; this tool reads artifacts of at most ${MAX_ARTIFACT_BYTES} bytes (5 MB). Pass the creation bytecode as code instead.`);
  const text = await readFile(real, 'utf8');
  // A line of exactly 64 hex characters is what a private key looks like, not bytecode.
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const keyRows = rows.filter((l) => /^(0x)?[0-9a-fA-F]{64}$/.test(l)).length;
  if (keyRows) {
    throw new ToolError(`${file} holds ${keyRows === 1 ? 'a line' : `${keyRows} lines`} of exactly 32 bytes of hex, which is what private keys look like, not contract bytecode. Nothing from it was used or sent. Point to the contract's build artifact.`);
  }
  // A compiler writes bytecode as one line of hex. More lines are a list of something else, such as keys.
  if (ext !== '.json' && rows.length > 1) {
    throw new ToolError(`${file} holds ${rows.length} lines. A bytecode file (.bin, .hex, .txt) holds one line of hex, the way compilers write it, so this is not one. Nothing from it was used or sent. Point to the contract's build artifact, or pass the creation bytecode as code.`);
  }
  if (ext === '.json') {
    let json: Loose;
    try {
      json = JSON.parse(text);
    } catch {
      // The parser's message quotes the file's text, which could be anything, so it is not passed on.
      throw new ToolError(`${file} is not valid JSON, so it is not a build artifact. Point to the artifact the compiler wrote (for example out/<File>.sol/<Contract>.json from Foundry), or give a .bin or .hex file of the bytecode.`);
    }
    return { ...bytecodeFromJson(json, file), file };
  }
  return { hex: cleanBytecode(text, file), file, format: `plain hex (${ext})` };
}

/* ---------- the deposit, explained ---------- */

const tokens = (v: bigint, network: Network): string => `${formatUnits(v, NATIVE_DECIMALS)} ${network.token}`;

function depositLines(api: Loose, network: Network, deposit: bigint, runtimeLen: number, codeOnChain: boolean): string[] {
  const c = api.consts.revive;
  const perByte = BigInt(c.depositPerByte.toString());
  const perChild = BigInt(c.depositPerChildTrieItem.toString());
  const lockupPerbill = BigInt(c.codeHashLockupDepositPercent.toString());
  const lockupPct = Number(lockupPerbill) / 1e7;
  const slot = perByte * 64n + perChild;
  const L = BigInt(runtimeLen);
  const codeDeposit = perByte * (L + CODE_OVERHEAD_BYTES);
  const lockup = (codeDeposit * lockupPerbill) / 1_000_000_000n;
  const rule = (codeOnChain ? 0n : codeDeposit) + lockup + RECORD_DEPOSIT;
  const rest = deposit - rule;
  const slots = rest > 0n && rest % slot === 0n ? rest / slot : null;
  // the short form of the rule, from the live constants: a x L + b
  const a = codeOnChain ? (perByte * lockupPerbill) / 1_000_000_000n : perByte + (perByte * lockupPerbill) / 1_000_000_000n;
  const b = (codeOnChain ? 0n : perByte * CODE_OVERHEAD_BYTES) + (perByte * CODE_OVERHEAD_BYTES * lockupPerbill) / 1_000_000_000n + RECORD_DEPOSIT;
  const out = [
    'How it is made up (a rule measured on Nov 14, 2026: it matched dry runs for runtime code of 1 to 24576 bytes and the on-chain records of more than 20 deployed contracts):',
    codeOnChain
      ? `- code: this runtime code is already stored on the ${network.label}, so its code deposit is not charged again`
      : `- code: ${tokens(perByte, network)} per byte x (${runtimeLen} byte${runtimeLen === 1 ? '' : 's'} of runtime code + ${CODE_OVERHEAD_BYTES}) = ${tokens(codeDeposit, network)}, held as long as the code is stored`,
    `- code-hash lockup, ${lockupPct}% of ${codeOnChain ? `the code deposit (${tokens(codeDeposit, network)})` : 'that'}: ${tokens(lockup, network)}`,
    `- the contract's own record: ${tokens(RECORD_DEPOSIT, network)}`,
    rest === 0n
      ? `- storage the constructor writes: none (each new 32-byte slot would add ${tokens(slot, network)})`
      : slots !== null
        ? `- storage the constructor writes: ${slots} new 32-byte slot${slots === 1n ? '' : 's'} x ${tokens(slot, network)} = ${tokens(rest, network)}`
        : `- the rule leaves ${tokens(rest, network)} unexplained, so trust the chain's figure; the rule may be out of date`,
    rest === 0n || slots !== null
      ? `- sum: ${tokens(deposit, network)}, the same as the chain's figure. In short: ${tokens(a, network)} x L + ${tokens(b, network)} for ${codeOnChain ? 'code of L bytes that is already on the chain' : 'new code of L bytes'}, plus ${tokens(slot, network)} per storage slot.`
      : `- the chain's figure is ${tokens(deposit, network)}; the rule gives ${tokens(rule, network)} before storage.`,
  ];
  return out;
}

/* ---------- the tool ---------- */

const FUNDS_ERRORS = new Set(['Revive.StorageDepositNotEnoughFunds', 'Revive.TransferFailed']);

export default defineTool({
  name: 'simulate_contract_deploy',
  title: 'Portaldot V3: dry-run a contract deployment and price it',
  description:
    'Dry-runs deploying a Solidity contract on Portaldot V3 in the node itself (reviveApi.instantiate): nothing is sent and no key is needed. ' +
    'Returns whether the constructor runs (or why it reverts), the address the contract would get, the size of its code, and above all what it costs: ' +
    'the storage deposit (often tens to hundreds of tPOT, explained part by part), the weight and deposit limits to pass, the fee, and the total against the balance of "from". ' +
    'Also shows how to send it for real. Give the creation bytecode as code, or the path of a build artifact (Foundry, Hardhat, solc) so no bytecode has to be pasted. ' +
    'Use it before every deployment, and before asking for test tokens. For a deployment sent through MetaMask, Hardhat, Remix or cast, follow with estimate_eth_transaction (no "to", data = the init code with the constructor arguments at its end) for the gas limit. Works on the testnet and the mainnet. ' +
    'Example: {"from": "5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z", "artifact_path": "out/Counter.sol/Counter.json"}.',
  input: {
    from: z.string().min(1).describe('The deployer: a native 5... address or a 0x address (MetaMask). A 0x address runs as the native account that holds its balance. Public addresses only. Example: "5EYCAe5ijiYfyeZ2JJCGq56LmPyNRAKzpG4QkoQkkQNB5e6Z".'),
    code: z.string().max(600_000).optional().describe('The creation bytecode (init code), 0x hex, as the compiler gives it; not the deployed (runtime) bytecode. Give this or artifact_path, not both. Example: "0x600160005360016000f3".'),
    artifact_path: z.string().min(1).max(1000).optional().describe('Path of a build artifact: a .json from Foundry (out/<File>.sol/<Contract>.json), Hardhat (artifacts/...json) or solc, or a .bin, .hex or .txt file of hex. A relative path is read against the project folder. At most 5 MB. Only that file is read.'),
    constructor_args: z.string().max(200_000).optional().describe('ABI-encoded constructor arguments, 0x hex, appended to the init code (cast abi-encode "constructor(uint256)" 5, or viem encodeAbiParameters). Default none. Example: "0x0000000000000000000000000000000000000000000000000000000000000005".'),
    value: z.union([z.string().max(60), z.number()]).optional().describe('Native tokens to send to the constructor, in native base units (14 decimals), as a string of digits, not wei: "100000000000000" is 1 tPOT. Default "0". The constructor must be payable to accept value.'),
    salt: z.string().optional().describe('A 32-byte salt, 0x and 64 hex characters, for an address that does not depend on the nonce (CREATE2). Default none. Example: "0x0000000000000000000000000000000000000000000000000000000000000001".'),
    network: networkField,
  },
  readsChain: true,
  handler: async ({ from, code, artifact_path, constructor_args, value, salt, network: key }) => {
    const network = pickNetwork(key);
    if ((code === undefined) === (artifact_path === undefined)) {
      throw new ToolError('Give exactly one of code (the creation bytecode as 0x hex) and artifact_path (the path of a build artifact). The artifact path saves pasting a long bytecode.');
    }
    const loaded = code !== undefined ? { hex: cleanBytecode(code, 'code'), file: null as string | null, format: 'given as code' } : await readArtifact(artifact_path!);
    const args = parseHexInput(constructor_args ?? '0x', 'constructor_args', { maxBytes: 100_000 });
    const initcode = `${loaded.hex}${args.slice(2)}`;
    if (byteLen(initcode) > MAX_INITCODE_BYTES) throw new ToolError(`The init code with its constructor arguments is ${byteLen(initcode)} bytes; this tool takes at most ${MAX_INITCODE_BYTES}. The chain itself refused init code above 49152 bytes on Nov 14, 2026.`);
    const saltHex = salt === undefined ? null : parseHexInput(salt, 'salt', { exactBytes: 32 });
    const val = parseNativeValue(value ?? '0');

    const conn = await getConn(network.key);
    const api = conn.api as Loose;
    if (!api.tx.revive?.instantiateWithCode) throw new ToolError(`The ${network.label} runtime has no Revive module, so Solidity contracts cannot be deployed there.`);
    const sender = await resolveSender(conn, from);
    const senderH160 = sender.msgSender.toLowerCase();
    const dryArgs = (who: Uint8Array): unknown[] => [who, val, null, null, { Upload: initcode }, '0x', saltHex];
    const [json, bal] = await Promise.all([reviveDryRun(conn, 'instantiate', dryArgs(sender.holderId)), readBalance(conn, sender.holderId)]);
    const own = readDryRun(json, 'instantiate');
    const ed = BigInt(api.consts.balances.existentialDeposit.toString());

    // When "from" cannot pay, the same dry run from a funded account still shows what it would cost.
    let dry: DryRun = own;
    let borrowed = false;
    const ownErr = own.err ? explainDryRunError(api, own.err) : null;
    const treasury = parseAddress(TREASURY_SS58);
    if (ownErr?.name && FUNDS_ERRORS.has(ownErr.name) && sender.holderSs58 !== TREASURY_SS58) {
      const again = readDryRun(await reviveDryRun(conn, 'instantiate', dryArgs(treasury.accountId)), 'instantiate');
      if (again.ok) {
        dry = again;
        borrowed = true;
      }
    }

    const expected = saltHex ? create2Address(senderH160, saltHex, initcode) : createAddress(senderH160, bal.nonce);
    const ruleName = saltHex ? `the CREATE2 address of ${sender.msgSender}, the salt and keccak-256 of the init code` : `the CREATE address of the deployer's 0x form ${sender.msgSender} and its account nonce ${bal.nonce}`;

    const head = `Dry run of a contract deployment on the ${network.label}, made by the node just now (reviveApi.instantiate). Nothing was sent and no key was used.`;
    const sizeLine = `- init code: ${byteLen(initcode)} bytes${byteLen(args) ? ` (${byteLen(loaded.hex)} of bytecode + ${byteLen(args)} of constructor arguments)` : ''}, ${loaded.file ? `read from ${loaded.file}, ${loaded.format}` : 'given as code'}`;
    const facts = ['', 'The deployment', senderLine(sender, network), sizeLine, `- value: ${nativeAmount(val, network)}`, saltHex ? `- salt: ${saltHex}` : '- salt: none'];
    const tail = [
      '',
      'Good to know',
      '- A storage deposit is held, not spent: it stays locked while the code and the storage exist.',
      '- Dry-run values were read live just now. The rules quoted with a date were measured by the Bridge Zero team on that date.',
      '',
      'Next: simulate_contract_call checks a call to the new contract; get_transaction reads the result once it is sent; explain_error explains an error text.',
    ];

    /* ---- refused by the chain (and no cost figures from elsewhere) ---- */
    if (own.err && !borrowed) {
      const e = ownErr!;
      return lines(
        head,
        '',
        `Result: the chain refuses this deployment: ${e.title}.`,
        ...e.lines.map((l) => `  ${l}`),
        e.name && FUNDS_ERRORS.has(e.name) && `  ${sender.holderSs58} has ${nativeAmount(bal.free, network, false)} free${bal.exists ? '' : ' (the account does not exist yet)'}.`,
        ...facts,
        ...tail,
      );
    }

    /* ---- the constructor reverts ---- */
    if (dry.ok?.reverted) {
      const r = decodeRevert(dry.ok.data);
      return lines(
        head,
        '',
        `Result: the constructor reverts, so nothing would be deployed. ${r.text}`,
        byteLen(dry.ok.data) ? `- revert data (${byteLen(dry.ok.data)} bytes): ${hexShown(dry.ok.data)}` : '- revert data: none',
        `- check the constructor arguments (${byteLen(args)} bytes given)${val > 0n ? ' and the value: a constructor that is not payable reverts when it receives value' : ''}, and that this is the creation bytecode, not the deployed (runtime) bytecode.`,
        '- the chain reports no deposit for a reverted constructor, so no cost is shown.',
        ...facts,
        ...tail,
      );
    }

    const ok = dry.ok!;
    const runtime = ok.data;
    const runtimeLen = byteLen(runtime);
    const codeHash = keccakAsHex(runtime, 256);
    const [codeInfo, existing] = await Promise.all([api.query.revive.codeInfoOf(codeHash), readReviveAccount(conn, expected)]);
    const codeOnChain = Boolean(codeInfo?.isSome);
    const isPvm = initcode.startsWith('0x50564d00');

    /* ---- the address ---- */
    const addrLines: string[] = [];
    if (borrowed) {
      addrLines.push(`- address it would get from ${sender.holderSs58}: ${checksummed(expected)}, ${ruleName} (computed here; the chain could not confirm it, because the dry run from that account failed).`);
    } else if (ok.addr && ok.addr.toLowerCase() === expected) {
      addrLines.push(`- address it would get: ${checksummed(expected)}. This is ${ruleName}: computed here, and the same as the chain's answer.`);
    } else {
      addrLines.push(`- address it would get: ${ok.addr ? checksummed(ok.addr) : '(not reported)'}, from the chain. ${ruleName[0].toUpperCase()}${ruleName.slice(1)} would be ${checksummed(expected)}; they differ, so trust the chain's value.`);
    }
    addrLines.push(
      saltHex
        ? '  It does not depend on the nonce: the same deployer, salt and init code always give this address, so that combination can be deployed only once.'
        : `  It changes when the nonce does: any transaction ${sender.holderSs58} sends first moves it. Pass a salt to get an address that does not depend on the nonce.`,
    );
    if (existing?.contract) addrLines.push(`  WARNING: a contract already exists at ${checksummed(expected)}, so this deployment would collide with it.`);

    /* ---- the money side ---- */
    const wl = weightLimitOf(dry.weight);
    const dl = depositLimitOf(dry.net, dry.max);
    const tx = api.tx.revive.instantiateWithCode(val, { refTime: wl.refTime, proofSize: wl.proofSize }, dl, initcode, '0x', saltHex);
    const { fee, why } = await feeOf(tx, sender.holderSs58);
    const budget = budgetLines(network, { value: val, depositLimit: dl, fee, ed }, bal, sender.holderSs58);
    const deposit = dry.net;
    // Bytecode that was read from a file is never printed back: only short code the caller gave itself.
    const initArg = !loaded.file && initcode.length <= 202 ? `'${initcode}'` : 'initcode';
    const isTestnet = network.key === 'testnet';

    return lines(
      head,
      '',
      borrowed
        ? [
            `Result: the chain refuses it from ${sender.holderSs58}: ${ownErr!.title}.`,
            ...ownErr!.lines.map((l) => `  ${l}`),
            `  ${sender.holderSs58} has ${nativeAmount(bal.free, network, false)} free${bal.exists ? '' : ' (the account does not exist yet)'}.`,
            `The same dry run from a funded account (the Treasury, ${TREASURY_SS58}, used only to read the cost) deploys, so the figures below are what this deployment needs.`,
          ]
        : `Result: it would deploy. The constructor runs and returns ${runtimeLen} byte${runtimeLen === 1 ? '' : 's'} of runtime code.`,
      ...addrLines,
      `- runtime code: ${runtimeLen} byte${runtimeLen === 1 ? '' : 's'}, code hash ${codeHash} (keccak-256), ${codeOnChain ? 'already stored on this chain' : 'not yet on this chain'}.`,
      runtimeLen === 0 && '  The constructor returned no code, so the contract would have nothing to run.',
      ...facts,
      '',
      'Cost',
      `- storage deposit: ${nativeAmount(deposit, network)}, from the dry run. It is held, not spent.`,
      isPvm ? '  This is PolkaVM code; the rule below was measured for EVM code only, so the chain\'s figure is the one to use.' : depositLines(api, network, deposit, runtimeLen, codeOnChain).map((l) => `  ${l}`),
      `- weight required: ${weightText(dry.weight)}. weightLimit to pass (+10%): ${weightText(wl)}`,
      dry.weight.proofSize === 0n && '  The node reports a proofSize of 0, so that part of the limit is 0. We have not sent a deployment with a proofSize limit of 0 ourselves.',
      `- storageDepositLimit to pass (+2%): ${nativeAmount(dl, network)}`,
      fee === null ? `- fee: could not be estimated (${why}).` : `- fee (paymentInfo, with these limits): ${nativeAmount(fee, network)}`,
      ...budget.lines,
      !budget.enough && isTestnet && `  There is no self-serve official faucet (checked Nov 13, 2026). Builders report that tPOT is given through a ticket in the Portaldot Discord; ask for the total above plus a margin.`,
      '',
      'To deploy it for real',
      network.key === 'mainnet' && 'This is the mainnet: POT has real value, and the deposit above is held from it. Deploy the same contract on the testnet first.',
      '1. The native call Revive.instantiateWithCode (the Bridge Zero team deployed a contract this way on Oct 19, 2026):',
      `   api.tx.revive.instantiateWithCode(${val}n, ${weightCode(wl)}, ${dl}n, ${initArg}, '0x', ${saltHex ? `'${saltHex}'` : 'null'})`,
      `   ${initArg === 'initcode' ? 'initcode is the bytecode with the constructor arguments at its end. ' : ''}data stays '0x': for EVM code the arguments go at the end of the init code, and the chain refuses data here. Sign it with your own ${network.key === 'mainnet' ? 'key' : 'test key'} or wallet; these tools never sign. Once it is in a block, its Revive.Instantiated event names the deployer and the new contract.`,
      network.evm
        ? [
            '2. An Ethereum transaction (MetaMask, Remix, cast): a creation transaction, with no "to", whose data is this init code. estimate_eth_transaction gives its gas, which includes the deposit, and checks the balance rule behind error 1010.',
            '   We have not sent one ourselves, but the testnet holds successful ones (seen on Nov 14, 2026; get_transaction {"block": 354887, "index": 1} shows one): the contract got the CREATE address of the sender and its transaction nonce, and its deposits followed the rule above. The official guide shows a deployment done with Remix and MetaMask.',
          ]
        : `2. The ${network.label} has no public Ethereum RPC (checked Nov 13, 2026), so MetaMask and cast cannot deploy there: use the native call.`,
      '',
      'To cut the deposit',
      `- Each byte of runtime code holds ${tokens((BigInt(api.consts.revive.depositPerByte.toString()) * (1_000_000_000n + BigInt(api.consts.revive.codeHashLockupDepositPercent.toString()))) / 1_000_000_000n, network)}. Build without CBOR metadata (Foundry: cbor_metadata = false and bytecode_hash = "none") and try the IR pipeline (via_ir = true), then compare the runtime size.`,
      `- Each new 32-byte storage slot holds ${tokens(BigInt(api.consts.revive.depositPerByte.toString()) * 64n + BigInt(api.consts.revive.depositPerChildTrieItem.toString()), network)}, in the constructor and in every later call that writes a new slot. Fewer slots cost less.`,
      ...tail,
    );
  },
});
