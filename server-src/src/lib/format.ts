// Amounts, numbers and small text helpers. Amounts are always BigInt: a JavaScript Number is exact
// only up to 2^53, which is about 90 tPOT in native base units.
import { EVM_DECIMALS, NATIVE_DECIMALS, NATIVE_TO_WEI, type Network } from './networks.ts';
import { ToolError } from './errors.ts';

/** 1500000 with 6 decimals becomes "1.5". Trailing zeros are dropped. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** "1.5" with 6 decimals becomes 1500000n. Refuses anything that is not a plain decimal number. */
export function parseUnits(text: string, decimals: number): bigint {
  const t = text.trim().replace(/_/g, '');
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) throw new ToolError(`"${clip(text, 100)}" is not a plain decimal number. Write it with digits and at most one dot, for example 1.5, with no commas, units or exponent.`);
  const fraction = m[2] ?? '';
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) {
    throw new ToolError(`"${clip(text, 100)}" has more than ${decimals} decimal places, so it cannot be written as a whole number of the smallest unit.`);
  }
  return BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt(fraction.slice(0, decimals).padEnd(decimals, '0') || '0');
}

/** A whole number from a decimal string, a 0x string, a number or a bigint. */
export function parseInteger(value: string | number | bigint, what: string): bigint {
  try {
    if (typeof value === 'bigint') {
      if (value < 0n) throw new Error('negative');
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) throw new Error('not whole');
      if (!Number.isSafeInteger(value)) throw new Error('too large for a JSON number; pass it as a string');
      if (value < 0) throw new Error('negative');
      return BigInt(value);
    }
    const t = value.trim().replace(/_/g, '');
    if (/^0x[0-9a-fA-F]+$/.test(t) || /^\d+$/.test(t)) return BigInt(t);
    throw new Error('not a whole number');
  } catch (e) {
    throw new ToolError(`${what} must be a whole number, as a decimal string such as "10000000000000" or a 0x string (${(e as Error).message}). Got: ${clip(typeof value === 'bigint' ? String(value) : (JSON.stringify(value) ?? String(value)), 100)}.`);
  }
}

/** A native amount (14 decimals) with the token's symbol and the raw number: "0.1 tPOT (10000000000000 base units)". */
export function nativeAmount(value: bigint, network: Network, withRaw = true): string {
  const text = `${formatUnits(value, NATIVE_DECIMALS)} ${network.token}`;
  return withRaw ? `${text} (${value} base units)` : text;
}

/** An Ethereum-side amount (18 decimals): "0.1 tPOT (100000000000000000 wei)". */
export function weiAmount(value: bigint, network: Network, withRaw = true): string {
  const text = `${formatUnits(value, EVM_DECIMALS)} ${network.token}`;
  return withRaw ? `${text} (${value} wei)` : text;
}

export const nativeToWei = (native: bigint): bigint => native * NATIVE_TO_WEI;
/** Wei as whole native units, plus what is left over (the "dust", below one native unit). */
export const weiToNative = (wei: bigint): { native: bigint; dust: bigint } => ({ native: wei / NATIVE_TO_WEI, dust: wei % NATIVE_TO_WEI });

export const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, Math.max(0, n - 3))}...` : s);

export const toHex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;
export const isHex = (s: string, bytes?: number): boolean => /^0x([0-9a-fA-F]{2})*$/.test(s) && (bytes === undefined || s.length === 2 + bytes * 2);
export const hexToBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s.replace(/^0x/, ''), 'hex'));

/** "3 s", "4 min", "2 h 5 min". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A UTC time that is easy to read and cannot be mistaken for local time: "2026-11-14 07:50:42 UTC". */
export const utc = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

/** Lines joined into the text a tool returns; empty entries are dropped, so callers can write `cond && line`. */
export function lines(...parts: Array<string | false | null | undefined | Array<string | false | null | undefined>>): string {
  return parts.flat().filter((p): p is string => typeof p === 'string').join('\n');
}

// Helpers for text that comes from the chain live in text.ts; they are offered here too.
export { FROM_CHAIN, hideInvisible, untrusted } from './text.ts';
