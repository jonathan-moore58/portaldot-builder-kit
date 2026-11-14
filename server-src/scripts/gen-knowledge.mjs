// Builds src/generated/errors.ts from the knowledge pack's references/errors.md, so the
// explain_error tool returns each entry exactly as it stands there. Plain Node, no dependencies.
//
// Usage, from server-src:
//   node scripts/gen-knowledge.mjs           write src/generated/errors.ts
//   node scripts/gen-knowledge.mjs --check   write nothing; fail when src/generated/errors.ts is not up to date
//   node scripts/gen-knowledge.mjs --stdin   read an errors.md from stdin, check it, write nothing
//
// It fails loudly (exit code 1) when errors.md has no entries, has two entries with the same id,
// or has an entry with neither a "Cause" nor a "Fix" bullet. It also refuses a heading that is not
// of the form "### E7. Short title", a bullet label other than the six below, labels out of order,
// and an entry without a "Basis" bullet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_REL = 'plugins/portaldot-dev/skills/portaldot-v3/references/errors.md';
const SOURCE = resolve(SERVER_SRC, '..', SOURCE_REL);
const TARGET_REL = 'src/generated/errors.ts';
const TARGET = resolve(SERVER_SRC, TARGET_REL);

/** The bullet labels an entry may use, in the order they must appear. */
const LABELS = ['You see', 'Cause', 'Fix', 'Not known', 'Others report', 'Basis'];

const HEADING = /^### (E\d+)\. (\S.*)$/;

/** Splits errors.md into its introduction and its entries. Returns the problems it found. */
function parse(markdown) {
  const text = markdown.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const problems = [];
  const entries = [];
  const introLines = [];
  let current = null;

  lines.forEach((line, i) => {
    const m = HEADING.exec(line);
    if (m) {
      current = { id: m[1], title: m[2].trim(), line: i + 1, bodyLines: [] };
      entries.push(current);
      return;
    }
    if (/^#{1,3} /.test(line) && current) problems.push(`line ${i + 1}: a heading inside the entries must have the form "### E7. Short title": ${JSON.stringify(line)}`);
    else if (/^###\s*E/i.test(line)) problems.push(`line ${i + 1}: a heading that looks like an entry but is not of the form "### E7. Short title": ${JSON.stringify(line)}`);
    (current ? current.bodyLines : introLines).push(line);
  });

  // Horizontal rules and blank lines at the edges separate entries; they are not part of an entry.
  const trimBlock = (block) => {
    const out = [...block];
    const edge = (l) => l.trim() === '' || /^-{3,}\s*$/.test(l);
    while (out.length && edge(out[0])) out.shift();
    while (out.length && edge(out[out.length - 1])) out.pop();
    return out.join('\n');
  };

  if (!entries.length) problems.push('no entries: no heading of the form "### E7. Short title" was found');

  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.id)) problems.push(`duplicate id ${e.id}: on line ${seen.get(e.id)} and on line ${e.line}`);
    else seen.set(e.id, e.line);
    e.body = trimBlock(e.bodyLines);
    const labels = [...e.body.matchAll(/^- \*\*([^*]+?):\*\*/gm)].map((m) => m[1]);
    for (const l of labels) if (!LABELS.includes(l)) problems.push(`${e.id}: unknown bullet label "${l}" (allowed, in this order: ${LABELS.join(', ')})`);
    const order = labels.filter((l) => LABELS.includes(l)).map((l) => LABELS.indexOf(l));
    if (order.some((v, i) => i > 0 && v <= order[i - 1])) problems.push(`${e.id}: bullet labels out of order or repeated (${labels.join(', ')}); the order is ${LABELS.join(', ')}`);
    if (!labels.includes('Cause') && !labels.includes('Fix')) problems.push(`${e.id}: has neither a "- **Cause:**" nor a "- **Fix:**" bullet`);
    if (!labels.includes('Basis')) problems.push(`${e.id}: has no "- **Basis:**" bullet`);
    if (!e.body) problems.push(`${e.id}: the entry is empty`);
  }

  return { intro: trimBlock(introLines), entries: entries.map(({ id, title, body }) => ({ id, title, body })), problems };
}

function render({ intro, entries }) {
  const str = (s) => JSON.stringify(s);
  return [
    `// GENERATED FILE: do not edit it by hand.`,
    `// Made by scripts/gen-knowledge.mjs from ${SOURCE_REL}.`,
    `// To change it, edit errors.md and run, from server-src: node scripts/gen-knowledge.mjs`,
    '',
    'export interface ErrorEntry {',
    '  /** The entry\'s number, for example "E7". */',
    '  id: string;',
    '  /** The heading after the number. */',
    '  title: string;',
    '  /** The Markdown under the heading, as it stands in errors.md. */',
    '  body: string;',
    '}',
    '',
    '/** The text of errors.md before its first entry. */',
    `export const ERROR_INTRO: string = ${str(intro)};`,
    '',
    'export const ERROR_ENTRIES: ErrorEntry[] = [',
    ...entries.map((e) => `  { id: ${str(e.id)}, title: ${str(e.title)}, body: ${str(e.body)} },`),
    '];',
    '',
  ].join('\n');
}

function fail(source, problems) {
  console.error(`gen-knowledge: ${source} cannot be used:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exitCode = 1;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const args = process.argv.slice(2);
if (args.includes('--stdin')) {
  const parsed = parse(await readStdin());
  if (parsed.problems.length) fail('the errors.md on stdin', parsed.problems);
  else console.log(`gen-knowledge: the errors.md on stdin is valid: ${parsed.entries.length} entries.`);
} else if (!existsSync(SOURCE)) {
  fail(SOURCE_REL, [`the file does not exist (looked for it at ${SOURCE_REL}, next to server-src)`]);
} else {
  const parsed = parse(readFileSync(SOURCE, 'utf8'));
  if (parsed.problems.length) {
    fail(SOURCE_REL, parsed.problems);
  } else {
    const output = render(parsed);
    const ids = `${parsed.entries[0].id} to ${parsed.entries[parsed.entries.length - 1].id}`;
    if (args.includes('--check')) {
      const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null;
      if (current === output) console.log(`gen-knowledge: ${TARGET_REL} is up to date (${parsed.entries.length} entries, ${ids}).`);
      else fail(TARGET_REL, [current === null ? 'the file does not exist; run: node scripts/gen-knowledge.mjs' : `it is out of date with ${SOURCE_REL}; run: node scripts/gen-knowledge.mjs`]);
    } else {
      mkdirSync(dirname(TARGET), { recursive: true });
      writeFileSync(TARGET, output);
      console.log(`gen-knowledge: wrote ${TARGET_REL}: ${parsed.entries.length} entries (${ids}) from ${SOURCE_REL}.`);
    }
  }
}
