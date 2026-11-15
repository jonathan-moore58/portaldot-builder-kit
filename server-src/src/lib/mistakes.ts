// What native calls answered to common mistakes when we dry-ran them (references/native-call-errors.md).
import { MEASURED_MISTAKES } from '../generated/mistakes.ts';

export interface MeasuredMistake {
  /** The call, as Module.call, for example "Nfts.mint". */
  call: string;
  /** The mistake in plain words. */
  mistake: string;
  /** The reply as the chain names it: "Nfts.NoConfig (47/32)", "Token(BelowMinimum)", "BadOrigin" or "accepted". */
  reply: string;
  /** What to do, in one line. */
  fix: string;
}

/** A reply cell read back into its parts. */
export type Reply =
  | { kind: 'accepted' }
  /** A module error, for example "Assets.NoAccount (39/1)": module 39, error 1. */
  | { kind: 'module'; module: string; name: string; moduleIndex: number; errorIndex: number }
  /** A dispatch error with its kind, for example "Token(BelowMinimum)". */
  | { kind: 'variant'; module: string; name: string }
  /** A dispatch error of one word, for example "BadOrigin". */
  | { kind: 'word'; name: string };

const MODULE_ERROR = /^([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*) \((\d+)\/(\d+)\)$/;
const VARIANT = /^([A-Za-z][A-Za-z0-9]*)\(([A-Za-z][A-Za-z0-9]*)\)$/;
const WORD = /^[A-Za-z][A-Za-z0-9]*$/;

/** Reads a reply cell. Returns null for a text in none of the four forms. */
export function parseReply(reply: string): Reply | null {
  const r = reply.trim();
  if (r === 'accepted') return { kind: 'accepted' };
  let m = MODULE_ERROR.exec(r);
  if (m) return { kind: 'module', module: m[1], name: m[2], moduleIndex: Number(m[3]), errorIndex: Number(m[4]) };
  m = VARIANT.exec(r);
  if (m) return { kind: 'variant', module: m[1], name: m[2] };
  if (WORD.test(r)) return { kind: 'word', name: r };
  return null;
}

/**
 * The measured cases whose reply is exactly this error, in any letter case: ("Nfts", "NoConfig") for
 * "Nfts.NoConfig (47/32)", ("Token", "BelowMinimum") for "Token(BelowMinimum)". A one-word dispatch error
 * such as "BadOrigin" is found as ("DispatchError", "BadOrigin"), ("", "BadOrigin") or ("BadOrigin", "").
 * Rows the chain accepted are never returned.
 */
export function measuredFor(module: string, name: string): MeasuredMistake[] {
  const mod = module.trim().toLowerCase();
  const err = name.trim().toLowerCase();
  if (!mod && !err) return [];
  return MEASURED_MISTAKES.filter((row) => {
    const r = parseReply(row.reply);
    if (!r || r.kind === 'accepted') return false;
    if (r.kind === 'word') {
      const word = r.name.toLowerCase();
      return (err === word && (mod === '' || mod === 'dispatcherror')) || (mod === word && err === '');
    }
    return r.module.toLowerCase() === mod && r.name.toLowerCase() === err;
  }).map((row) => ({ ...row }));
}
