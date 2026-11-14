// Chain values as plain text a reader can use. Large numbers stay exact: they are written out in
// full as decimal digits, never as floating point and never with thousands separators.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** A decoded chain value as plain JavaScript: numbers that fit stay numbers, larger ones become decimal strings. */
export function toPlain(codec: Loose): unknown {
  if (codec === null || codec === undefined) return null;
  if (typeof codec.toPrimitive === 'function') {
    try {
      return codec.toPrimitive();
    } catch {
      /* fall through */
    }
  }
  if (typeof codec.toJSON === 'function') return codec.toJSON();
  return codec;
}

/** JSON text of a plain value. BigInt becomes a decimal string; long output is cut with a note. */
export function show(value: unknown, maxChars = 6000, indent = 2): string {
  const json = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), indent) ?? 'null';
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars)}\n... (cut: ${json.length - maxChars} more characters. Ask for a narrower value.)`;
}
