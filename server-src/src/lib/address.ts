// The two address forms of Portaldot V3 and the rule that links them. Everything here is offline.
//
// A native account is 32 bytes (an "account id"), written as an SS58 address that starts with 5.
// pallet-revive (Solidity contracts, MetaMask) works with 20-byte 0x addresses. The rule, checked
// against the chain's own reviveApi.address and reviveApi.accountId on Nov 14, 2026:
//   native -> 0x : the last 20 bytes of keccak-256 of the account id,
//                  except for an account id that ends in twelve 0xEE bytes: its first 20 bytes.
//   0x -> native : the native account linked to it (revive.originalAccount), or, when none is
//                  linked, its "fallback" account id: the 20 bytes followed by twelve 0xEE bytes.
import { base58Decode, decodeAddress, encodeAddress, ethereumEncode, isEthereumChecksum, keccakAsU8a } from '@polkadot/util-crypto';
import { ToolError } from './errors.ts';
import { hexToBytes, toHex } from './format.ts';

export const SS58_PREFIX = 42;

export type AddressKind = 'ss58' | 'accountId' | 'h160';

export interface ParsedAddress {
  input: string;
  kind: AddressKind;
  /** The 32-byte account id for a native input; for a 0x input, its fallback account id. */
  accountId: Uint8Array;
  /** The 0x form: given, or derived by the rule above. Lower case. */
  h160: string;
  /** True when the account id ends in twelve 0xEE bytes, so it stands for a 0x address. */
  isFallbackForm: boolean;
  /** The SS58 prefix the input was written with (only for an SS58 input). */
  ss58Prefix?: number;
  /** Set when a mixed-case 0x input fails its EIP-55 checksum: a sign of a typing mistake. */
  checksumWarning?: string;
}

const EE = 0xee;

export const isFallbackId = (id: Uint8Array): boolean => id.length === 32 && id.subarray(20).every((b) => b === EE);

/** The 0x address pallet-revive gives a native account. */
export function h160OfAccountId(id: Uint8Array): string {
  if (id.length !== 32) throw new ToolError(`An account id is 32 bytes; got ${id.length}.`);
  return toHex(isFallbackId(id) ? id.subarray(0, 20) : keccakAsU8a(id, 256).subarray(12));
}

/** The account id that holds a 0x address's balance when no native account is linked to it. */
export function fallbackIdOfH160(h160: string): Uint8Array {
  const bytes = hexToBytes(h160);
  if (bytes.length !== 20) throw new ToolError(`A 0x address is 20 bytes (0x and 40 hex characters); got ${bytes.length} bytes.`);
  const id = new Uint8Array(32).fill(EE);
  id.set(bytes, 0);
  return id;
}

export const toSs58 = (id: Uint8Array, prefix = SS58_PREFIX): string => encodeAddress(id, prefix);

/** A 0x address with its EIP-55 capital letters, the way wallets show it. */
export const checksummed = (h160: string): string => ethereumEncode(h160);

function ss58PrefixOf(address: string): number {
  const raw = base58Decode(address);
  // one-byte prefixes are below 64; two-byte prefixes pack 14 bits across the first two bytes
  return raw[0] < 64 ? raw[0] : ((raw[0] & 0x3f) << 2) | (raw[1] >> 6) | ((raw[1] & 0x3f) << 8);
}

/** Reads an address in any of its forms. Throws a ToolError that says what was wrong with it. */
export function parseAddress(input: string): ParsedAddress {
  const trimmed = input.trim();
  if (trimmed.split(/\s+/).length >= 12) {
    throw new ToolError('That looks like a secret recovery phrase, not an address. Never paste a secret phrase or a private key into a tool: these tools are read-only and need only public addresses. If that phrase is real, treat the account as exposed and move its funds.');
  }
  // The longest address form is an account id of 66 characters. The base58 decoder slows down with
  // the square of the length, so long input is refused before it gets there.
  if (trimmed.length > 120) {
    throw new ToolError(`That is ${trimmed.length} characters long, which is far too long for an address. A native address has about 48 characters, a 0x address 42 and an account id 66.`);
  }
  // "0X..." is the same thing as "0x...".
  const text = /^0X/.test(trimmed) ? `0x${trimmed.slice(2)}` : trimmed;
  // An error message quotes the input, so a very long input is cut there.
  const shown = text.length > 100 ? `${text.slice(0, 100)}... (${text.length} characters)` : text;
  if (/^0x[0-9a-fA-F]{40}$/.test(text)) {
    const mixed = /[a-f]/.test(text.slice(2)) && /[A-F]/.test(text.slice(2));
    const parsed: ParsedAddress = { input: text, kind: 'h160', accountId: fallbackIdOfH160(text), h160: text.toLowerCase(), isFallbackForm: true };
    if (mixed && !isEthereumChecksum(text)) parsed.checksumWarning = 'The capital letters of this 0x address do not match its checksum, so one of its characters may be mistyped. Compare it with the source before using it.';
    return parsed;
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(text)) {
    const id = hexToBytes(text);
    return { input: text, kind: 'accountId', accountId: id, h160: h160OfAccountId(id), isFallbackForm: isFallbackId(id) };
  }
  if (/^0x/.test(text)) {
    const body = text.slice(2);
    const bad = /[^0-9a-fA-F]/.exec(body);
    if (bad) {
      throw new ToolError(`"${shown}" is not hex: the character "${bad[0]}" at position ${bad.index + 1} after 0x is not one of 0-9 or a-f. A 0x address is 0x and 40 hex characters; an account id is 0x and 64.`);
    }
    throw new ToolError(`"${shown}" is neither a 0x address (0x and 40 hex characters) nor an account id (0x and 64 hex characters): it has ${body.length} characters after 0x.`);
  }
  let id: Uint8Array;
  try {
    id = decodeAddress(text);
  } catch (e) {
    // The library's message repeats the whole input; only its reason is kept.
    const reason = (e as Error).message.replace(/^Decoding [\s\S]*?: (?=Invalid|Decoded|Expected)/, '').slice(0, 160);
    throw new ToolError(`"${shown}" is not a valid address (${reason}). A native Portaldot address is SS58 and starts with 5; an Ethereum-style one is 0x and 40 hex characters.`);
  }
  if (id.length !== 32) throw new ToolError(`"${shown}" decodes to ${id.length} bytes, but a Portaldot account id is 32 bytes.`);
  return { input: text, kind: 'ss58', accountId: id, h160: h160OfAccountId(id), isFallbackForm: isFallbackId(id), ss58Prefix: ss58PrefixOf(text) };
}

export interface SpecialAddress {
  kind: 'pallets' | 'precompile' | 'asset' | 'poolAsset' | 'zero';
  /** What the address is, in one or two sentences. */
  text: string;
}

const STANDARD_PRECOMPILES: Record<number, string> = {
  1: 'ecrecover',
  2: 'sha256',
  3: 'ripemd160',
  4: 'identity',
  5: 'modexp',
  6: 'bn256 add',
  7: 'bn256 scalar multiplication',
  8: 'bn256 pairing',
  9: 'blake2f',
};

/**
 * 0x addresses that are not accounts: the pallets address, precompiles, and the ERC-20 faces of
 * tokens of the Assets module. What is said here was measured on the testnet on Nov 14, 2026.
 */
export function specialAddress(h160: string): SpecialAddress | null {
  const hex = h160.toLowerCase().replace(/^0x/, '');
  if (hex.length !== 40) return null;
  if (hex === '6d6f646c70792f70616464720000000000000000') {
    return {
      kind: 'pallets',
      text: 'This is the runtime\'s pallets address (the text "modlpy/paddr" padded with zeros), not an account to pay. An Ethereum transaction sent to it with a SCALE-encoded call as its data runs that native call as the sender; encode_call builds the data.',
    };
  }
  if (/^0{40}$/.test(hex)) return { kind: 'zero', text: 'This is the zero address. Nobody holds a key for it, so anything sent to it cannot be moved again.' };
  if (/^0{36}/.test(hex)) {
    const n = Number.parseInt(hex.slice(36), 16);
    const name = STANDARD_PRECOMPILES[n];
    const what = name
      ? `the ${name} precompile, which answered correctly on Nov 14, 2026`
      : n === 0x0a
        ? 'where Ethereum has its KZG point-evaluation precompile, which this chain does not support (a call fails with Revive.UnsupportedPrecompileAddress; checked Nov 14, 2026)'
        : n === 0x100
          ? 'the P256VERIFY precompile (secp256r1 signature check), which answered correctly on Nov 14, 2026'
          : n === 0x900 || n === 0x901
            ? 'a system precompile of this chain (something answered there on Nov 14, 2026)'
            : n >= 0x0b && n <= 0x11
              ? 'where Ethereum has a BLS12-381 precompile, which this chain does not have (checked Nov 14, 2026)'
              : n === 0xdead
                ? 'the common burn address: nobody is known to hold a key for it, so anything sent to it cannot be moved again'
                : 'a low address, in the range where Ethereum puts its precompiles; we have not seen anything answer at this one';
    return { kind: 'precompile', text: `This address is ${what}. It is not an account to pay.` };
  }
  const token = /^([0-9a-f]{8})0{24}(0001|0002)0000$/.exec(hex);
  if (token) {
    const id = Number.parseInt(token[1], 16);
    const pool = token[2] === '0002';
    return {
      kind: pool ? 'poolAsset' : 'asset',
      text: `This is the ERC-20 address of ${pool ? 'pool asset' : 'asset'} ${id} of the ${pool ? 'PoolAssets' : 'Assets'} module (the id in the first 4 bytes, then 12 zero bytes, then ${pool ? '0x0002' : '0x0001'} and 0x0000). Contracts and Ethereum tools reach that token there with the usual ERC-20 calls: name, symbol, decimals, totalSupply and balanceOf matched the module's storage on Nov 14, 2026. Whether asset ${id} exists is a separate question: read_storage {"item": "${pool ? 'PoolAssets' : 'Assets'}.asset", "keys": [${id}]}. It is not an account to pay.`,
    };
  }
  return null;
}
