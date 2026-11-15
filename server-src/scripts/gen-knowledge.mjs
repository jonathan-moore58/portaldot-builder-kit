// Builds two files of src/generated from the knowledge pack, so the tools return the reference text exactly
// as it stands there. Plain Node, no dependencies.
//   - src/generated/errors.ts from references/errors.md (explain_error's list of errors and traps);
//   - src/generated/mistakes.ts from references/native-call-errors.md (one item per table row of its
//     module sections: what a native call answered to a mistake when we dry-ran it).
//
// Usage, from server-src:
//   node scripts/gen-knowledge.mjs                   write both files
//   node scripts/gen-knowledge.mjs --check           write nothing; fail when either file is not up to date
//   node scripts/gen-knowledge.mjs --stdin           read an errors.md from stdin, check it, write nothing
//   node scripts/gen-knowledge.mjs --stdin-mistakes  read a native-call-errors.md from stdin, check it, write nothing
//
// It fails loudly (exit code 1) when errors.md has no entries, has two entries with the same id,
// or has an entry with neither a "Cause" nor a "Fix" bullet. It also refuses a heading that is not
// of the form "### E7. Short title", a bullet label other than the six below, labels out of order,
// and an entry without a "Basis" bullet.
//
// In native-call-errors.md, a module section is a heading of one word ("## Balances"). Each holds one
// table with exactly the columns | Call | Mistake | Reply | What to do |. The generator refuses, naming
// the line: a table outside a module section, another header, a row without four cells, a Call that is
// not `Module.call` of the section's module, a Reply in another form than "Assets.NoAccount (39/1)",
// "Token(BelowMinimum)", "BadOrigin" or "accepted", a "What to do" that is not one sentence, a module
// section without a table, and the same call and mistake twice. Each file is checked on its own, so a
// fault in one does not stop the other from being written.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCES_REL = 'plugins/portaldot-dev/skills/portaldot-v3/references';

/* ---------- errors.md -> src/generated/errors.ts ---------- */

/** The bullet labels an entry may use, in the order they must appear. */
const LABELS = ['You see', 'Cause', 'Fix', 'Not known', 'Others report', 'Basis'];

const HEADING = /^### (E\d+)\. (\S.*)$/;

/** Splits errors.md into its introduction and its entries. Returns the problems it found. */
function parseErrors(markdown) {
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

  const result = { intro: trimBlock(introLines), entries: entries.map(({ id, title, body }) => ({ id, title, body })) };
  const summary = entries.length ? `${entries.length} entries, ${entries[0].id} to ${entries[entries.length - 1].id}` : 'no entries';
  return { result, summary, problems };
}

function renderErrors({ intro, entries }, sourceRel) {
  const str = (s) => JSON.stringify(s);
  return [
    `// GENERATED FILE: do not edit it by hand.`,
    `// Made by scripts/gen-knowledge.mjs from ${sourceRel}.`,
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

/* ---------- native-call-errors.md -> src/generated/mistakes.ts ---------- */

/** A module section: a level-2 heading of one word, the module's name. */
const MODULE_SECTION = /^## ([A-Z][A-Za-z0-9]*)\s*$/;
const COLUMNS = ['Call', 'Mistake', 'Reply', 'What to do'];
const SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|){4}\s*$/;
const CALL_CELL = /^`([A-Z][A-Za-z0-9]*)\.([a-z][A-Za-z0-9]*)`$/;
/** The forms a Reply cell may take, as the chain names the reply. */
const REPLY_FORMS = [
  [/^accepted$/, '"accepted"'],
  [/^[A-Z][A-Za-z0-9]*\.[A-Z][A-Za-z0-9]* \(\d+\/\d+\)$/, 'a module error such as "Assets.NoAccount (39/1)"'],
  [/^[A-Z][A-Za-z0-9]*\([A-Z][A-Za-z0-9]*\)$/, 'a dispatch error with its kind such as "Token(BelowMinimum)"'],
  [/^[A-Z][A-Za-z0-9]*$/, 'a dispatch error of one word such as "BadOrigin"'],
];

/** The cells of a table line, or null when it does not start and end with "|". A "\|" inside a cell is a literal "|". */
function cells(line) {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|') || t.endsWith('\\|')) return null;
  return t
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** Reads the module tables of native-call-errors.md. Returns the rows and the problems it found, each naming its line. */
function parseMistakes(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const problems = [];
  const rows = [];
  const sections = [];
  let section = null; // { name, line, module: boolean, tables: number }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = `line ${i + 1}`;
    if (/^#{1,2} /.test(line)) {
      const m = MODULE_SECTION.exec(line);
      section = { name: m ? m[1] : line.replace(/^#+ /, '').trim(), line: i + 1, module: Boolean(m), tables: 0 };
      sections.push(section);
      continue;
    }
    if (/^#{3,} /.test(line) && section?.module) {
      problems.push(`${at}: a module section holds only its table and a basis line, not a subheading: ${JSON.stringify(line)}`);
      continue;
    }
    if (!line.trimStart().startsWith('|')) continue;

    // a table: this line and the ones after it that start with "|"
    const start = i;
    while (i + 1 < lines.length && lines[i + 1].trimStart().startsWith('|')) i++;
    const block = lines.slice(start, i + 1);
    const where = `line ${start + 1}`;
    if (!section?.module) {
      problems.push(`${where}: a table outside a module section; tables belong under a heading of one word that names the module, such as "## Balances"`);
      continue;
    }
    section.tables++;
    if (section.tables > 1) problems.push(`${where}: a second table in "## ${section.name}"; a module section has one table`);
    const header = cells(block[0]);
    if (!header || header.length !== COLUMNS.length || header.some((c, k) => c !== COLUMNS[k])) {
      problems.push(`${where}: the table header must be exactly "| ${COLUMNS.join(' | ')} |", found ${JSON.stringify(block[0].trim())}`);
      continue;
    }
    if (block.length < 2 || !SEPARATOR.test(block[1].trim())) {
      problems.push(`line ${start + 2}: the line after the table header must be "|---|---|---|---|", found ${JSON.stringify((block[1] ?? '').trim())}`);
      continue;
    }
    if (block.length < 3) problems.push(`${where}: the table in "## ${section.name}" has no rows`);

    for (let k = 2; k < block.length; k++) {
      const n = start + k + 1;
      const rowAt = `line ${n}`;
      const c = cells(block[k]);
      if (!c) {
        problems.push(`${rowAt}: a table row must start and end with "|": ${JSON.stringify(block[k].trim())}`);
        continue;
      }
      if (c.length !== COLUMNS.length) {
        problems.push(`${rowAt}: a table row must have ${COLUMNS.length} cells (${COLUMNS.join(', ')}), found ${c.length}; write a "|" inside a cell as "\\|"`);
        continue;
      }
      const [callCell, mistake, reply, fix] = c;
      const empty = COLUMNS.filter((_, j) => !c[j]);
      if (empty.length) {
        problems.push(`${rowAt}: empty cell${empty.length > 1 ? 's' : ''}: ${empty.join(', ')}`);
        continue;
      }
      const call = CALL_CELL.exec(callCell);
      if (!call) problems.push(`${rowAt}: the Call cell must be one call in backticks, such as \`Balances.transferKeepAlive\`, found ${JSON.stringify(callCell)}`);
      else if (call[1] !== section.name) problems.push(`${rowAt}: the call ${call[1]}.${call[2]} is not of the module "${section.name}" whose section it is in`);
      if (!REPLY_FORMS.some(([re]) => re.test(reply))) problems.push(`${rowAt}: the Reply cell must be ${REPLY_FORMS.map(([, d]) => d).join(', or ')}, with nothing else; found ${JSON.stringify(reply)}`);
      if (!fix.endsWith('.')) problems.push(`${rowAt}: the "What to do" cell must be one sentence that ends with a full stop: ${JSON.stringify(fix)}`);
      else if (/[.!?]\s+[A-Z]/.test(fix.slice(0, -1))) problems.push(`${rowAt}: the "What to do" cell must be one sentence, found more: ${JSON.stringify(fix)}`);
      const row = { call: call ? `${call[1]}.${call[2]}` : callCell, mistake, reply, fix, line: n };
      const twin = rows.find((r) => r.call === row.call && r.mistake === row.mistake);
      if (twin) problems.push(`${rowAt}: the same call and mistake as on line ${twin.line}; merge the two rows`);
      rows.push(row);
    }
  }

  const modules = sections.filter((s) => s.module);
  for (const s of modules) if (!s.tables) problems.push(`line ${s.line}: the module section "## ${s.name}" has no table`);
  if (!modules.length) problems.push('no module sections: no heading of one word, such as "## Balances", with a table under it');

  const result = rows.map(({ call, mistake, reply, fix }) => ({ call, mistake, reply, fix }));
  return { result, summary: `${rows.length} rows in ${modules.length} module sections`, problems };
}

function renderMistakes(rows, sourceRel) {
  const str = (s) => JSON.stringify(s);
  return [
    `// GENERATED FILE: do not edit it by hand.`,
    `// Made by scripts/gen-knowledge.mjs from ${sourceRel}.`,
    `// To change it, edit native-call-errors.md and run, from server-src: node scripts/gen-knowledge.mjs`,
    '',
    '/** One item per table row of the module sections of native-call-errors.md, in the order of the file. */',
    'export const MEASURED_MISTAKES: Array<{ call: string; mistake: string; reply: string; fix: string }> = [',
    ...rows.map((r) => `  { call: ${str(r.call)}, mistake: ${str(r.mistake)}, reply: ${str(r.reply)}, fix: ${str(r.fix)} },`),
    '];',
    '',
  ].join('\n');
}

/* ---------- the command ---------- */

const TARGETS = [
  { key: 'errors', sourceRel: `${REFERENCES_REL}/errors.md`, targetRel: 'src/generated/errors.ts', parse: parseErrors, render: renderErrors },
  { key: 'mistakes', sourceRel: `${REFERENCES_REL}/native-call-errors.md`, targetRel: 'src/generated/mistakes.ts', parse: parseMistakes, render: renderMistakes },
];

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

/** Checks one source and writes its file, or (with check) compares it with the file. */
function run(t, check) {
  const source = resolve(SERVER_SRC, '..', t.sourceRel);
  const target = resolve(SERVER_SRC, t.targetRel);
  if (!existsSync(source)) return fail(t.sourceRel, [`the file does not exist (looked for it at ${t.sourceRel}, next to server-src)`]);
  const parsed = t.parse(readFileSync(source, 'utf8'));
  if (parsed.problems.length) return fail(t.sourceRel, parsed.problems);
  const output = t.render(parsed.result, t.sourceRel);
  if (check) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current === output) console.log(`gen-knowledge: ${t.targetRel} is up to date (${parsed.summary}).`);
    else fail(t.targetRel, [current === null ? 'the file does not exist; run: node scripts/gen-knowledge.mjs' : `it is out of date with ${t.sourceRel}; run: node scripts/gen-knowledge.mjs`]);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output);
    console.log(`gen-knowledge: wrote ${t.targetRel}: ${parsed.summary}, from ${t.sourceRel}.`);
  }
}

const args = process.argv.slice(2);
const stdinKey = args.includes('--stdin-mistakes') ? 'mistakes' : args.includes('--stdin') ? 'errors' : null;
if (stdinKey) {
  const t = TARGETS.find((x) => x.key === stdinKey);
  const name = t.sourceRel.split('/').pop();
  const parsed = t.parse(await readStdin());
  if (parsed.problems.length) fail(`the ${name} on stdin`, parsed.problems);
  else console.log(`gen-knowledge: the ${name} on stdin is valid: ${parsed.summary}.`);
} else {
  for (const t of TARGETS) run(t, args.includes('--check'));
}
