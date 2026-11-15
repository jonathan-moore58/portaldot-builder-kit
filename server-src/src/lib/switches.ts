// The two switches of the runtime that stop calls for everyone (errors.md E38): safe mode and calls
// paused by name. This reads them and builds the line get_chain_facts prints about them.
import { duration } from './format.ts';
import { untrusted } from './text.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** At most this many paused calls are named; one more is read to know whether there are more. */
export const PAUSED_SHOWN = 20;

/**
 * A paused call's name as the chain stores it: two byte strings, the module's and the call's. The chain
 * stores any bytes there. Text is printed as one quoted string; bytes that are not UTF-8 are printed as
 * hex outside the quotes and marked, so they cannot pass for a name. Nothing here can throw.
 */
export const pausedName = (key: Loose): string => {
  try {
    const parts = (key.args?.[0] ?? []) as Loose[];
    if (parts.length && parts.every((part: Loose) => part.isUtf8)) return untrusted(parts.map((part: Loose) => part.toUtf8()).join('.'), 80);
    // hex holds only 0-9, a-f, x and dots, so it needs no quoting
    const hex = parts.length ? parts.map((part: Loose) => String(part.toHex()).slice(0, 42)).join('.') : String(key.toHex()).slice(66, 130);
    return `bytes ${hex} (not text)`;
  } catch {
    return '"a key that could not be read"';
  }
};

export interface SwitchesInput {
  /** Whether the runtime has the SafeMode module. */
  hasSafeMode: boolean;
  /** Whether the runtime has the TxPause module. */
  hasTxPause: boolean;
  /** SafeMode.enteredUntil as read (an Option of a block number), or null when the read failed. */
  safeUntil: Loose | null;
  /** The keys of TxPause.pausedCalls, at most PAUSED_SHOWN + 1 of them, or null when the read failed. */
  pausedKeys: Loose[] | null;
  /** The newest block's number. */
  best: number;
}

/** Reads the two switches where the modules exist. A failed read gives null and never an error. */
export async function readSwitches(api: Loose): Promise<Omit<SwitchesInput, 'best'>> {
  const hasSafeMode = typeof api.query?.safeMode?.enteredUntil === 'function';
  const hasTxPause = typeof api.query?.txPause?.pausedCalls?.keysPaged === 'function';
  const [safeUntil, pausedKeys] = await Promise.all([
    hasSafeMode ? Promise.resolve().then(() => api.query.safeMode.enteredUntil()).catch(() => null) : null,
    hasTxPause ? Promise.resolve().then(() => api.query.txPause.pausedCalls.keysPaged({ args: [], pageSize: PAUSED_SHOWN + 1 })).catch(() => null) : null,
  ]);
  return { hasSafeMode, hasTxPause, safeUntil, pausedKeys };
}

/** The line about the two switches, or false when the runtime has neither module. */
export function switchesLine({ hasSafeMode, hasTxPause, safeUntil, pausedKeys, best }: SwitchesInput): string | false {
  if (!hasSafeMode && !hasTxPause) return false;
  const keys: Loose[] = hasTxPause ? pausedKeys ?? [] : [];
  const names = keys.slice(0, PAUSED_SHOWN).map(pausedName);
  const list = `${names.join(', ')}${keys.length > PAUSED_SHOWN ? ' and more' : ''}`;
  const pausedText = !hasTxPause ? '' : pausedKeys === null ? ' The paused calls could not be read just now.' : names.length ? ` Calls paused by name: ${list}.` : ' No call is paused by name.';
  const filtered = 'the chain refuses the calls that are not on its list of allowed calls, with System.CallFiltered; it is not a fault in your code (explain_error "E38")';

  // SafeMode.enteredUntil holds the last block of safe mode while it is on and is empty while it is off
  // (the chain's own text for it), so any stored entry counts as on.
  if (hasSafeMode && safeUntil?.isSome === true) {
    const until: number = safeUntil.unwrap().toNumber();
    return until >= best
      ? `- WARNING: safe mode: ON through block ${until}, its last block. It then ends by itself, so calls go through again from block ${until + 1}, about ${duration((until + 1 - best) * 6)} from now, unless safe mode is extended or ended before that. While it is on, ${filtered}.${pausedText}`
      : `- WARNING: safe mode: ON. Its last block ${until} has passed, but the entry is still stored, so ${filtered}.${pausedText}`;
  }
  // Only an empty entry means off; anything else that is not a stored block was not read as expected.
  const safeText = !hasSafeMode ? '' : safeUntil?.isNone === true ? 'safe mode: off' : 'safe mode: could not be read just now';
  if (names.length) return `- WARNING: ${safeText ? `${safeText}, but some` : 'some'} calls are paused by name: ${list}. Expect the chain to refuse them for every account (explain_error "E38").`;
  return `- ${[safeText && `${safeText}.`, pausedText.trim()].filter(Boolean).join(' ')}`;
}
