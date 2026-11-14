// One check, for every tool, that an argument is not a secret recovery phrase. The tools are
// read-only and never need a key, so a phrase in an argument is always a mistake, and the sooner it
// is refused the less of it travels: it is refused here, before a tool runs or anything is sent.
import { mnemonicValidate } from '@polkadot/util-crypto';
import { ToolError } from './errors.ts';

const PHRASE_LENGTHS = new Set([12, 15, 18, 21, 24]);
/** Longest text that is searched; a phrase further in is not looked for. */
const MAX_SCAN = 20_000;

/**
 * The words of a text, the way a phrase may be written down: in any case, with list numbers such as
 * "1." or "1)" in front of the words, a full stop at the end, and spaces or the punctuation , ; : | /
 * between them.
 */
export function phraseWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,;:|/]+/)
    .map((w) => w.replace(/^\d{1,2}[.)]/, '').replace(/[.!?]+$/, ''))
    .filter(Boolean);
}

/** True when the text is exactly one valid BIP-39 recovery phrase (English words, checksum included). */
export function isRecoveryPhrase(text: string): boolean {
  const words = phraseWords(text);
  if (!PHRASE_LENGTHS.has(words.length)) return false;
  if (!words.every((w) => /^[a-z]{3,8}$/.test(w))) return false;
  try {
    return mnemonicValidate(words.join(' '), undefined, true);
  } catch {
    return false;
  }
}

/** Most checksum tests one text may cost in the search for a phrase written one word per line. */
const MAX_WINDOWS = 2_000;

/**
 * True when the text holds a phrase written one word per line (list numbers allowed) with other
 * lines before or after it, the way a phrase is copied from a note that has a heading. Twelve or
 * more lines of one word each are not ordinary prose, so every window of such a run is tested.
 */
function phraseInWordLines(text: string): boolean {
  let budget = MAX_WINDOWS;
  const holds = (run: string[]): boolean => {
    for (const n of PHRASE_LENGTHS) {
      for (let i = 0; i + n <= run.length; i++) {
        if (budget-- <= 0) return false;
        if (isRecoveryPhrase(run.slice(i, i + n).join(' '))) return true;
      }
    }
    return false;
  };
  let run: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const words = phraseWords(line);
    if (words.length === 0) continue; // an empty line does not end the list
    if (words.length === 1 && /^[a-z]{3,8}$/.test(words[0])) {
      run.push(words[0]);
      continue;
    }
    if (run.length >= 12 && holds(run)) return true;
    run = [];
  }
  return run.length >= 12 && holds(run);
}

/**
 * True when a string holds a recovery phrase as its whole content, as one of its lines, inside
 * quotes, or one word per line among other lines. Twelve list words that merely follow one another
 * inside a longer sentence are not taken for a phrase: with a checksum of four bits, one in sixteen
 * such runs would pass by chance.
 */
export function holdsRecoveryPhrase(text: string): boolean {
  const t = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  if (isRecoveryPhrase(t)) return true;
  for (const line of t.split(/\r?\n/)) if (line.length >= 35 && isRecoveryPhrase(line)) return true;
  for (const m of t.matchAll(/["'`]([^"'`]{35,500})["'`]/g)) if (isRecoveryPhrase(m[1])) return true;
  return phraseInWordLines(t);
}

export const SECRET_REFUSAL =
  'One of the arguments is a secret recovery phrase. Never give a secret phrase or a private key to a tool: these tools are read-only and need only public values. ' +
  'Nothing was sent anywhere. If that phrase is real, treat the account as exposed and move its funds to a new one.';

/**
 * Throws when any string inside the arguments of a tool call holds a recovery phrase: every value and
 * every key, however deep. The walk uses a list, not recursion, so depth costs nothing.
 */
export function refuseSecretsIn(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (v.length >= 35 && holdsRecoveryPhrase(v)) throw new ToolError(SECRET_REFUSAL);
      continue;
    }
    if (v === null || typeof v !== 'object') continue;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!Array.isArray(v)) stack.push(k);
      stack.push(x);
    }
  }
}
