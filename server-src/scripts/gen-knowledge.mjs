// Builds four files of src/generated from the knowledge pack, so the server returns the reference text
// exactly as it stands there. Plain Node, no dependencies.
//   - src/generated/errors.ts from references/errors.md (explain_error's list of errors and traps);
//   - src/generated/mistakes.ts from references/native-call-errors.md (one item per table row of its
//     module sections: what a native call answered to a mistake when we dry-ran it);
//   - src/generated/guide.ts from every skill folder under plugins/portaldot-dev/skills/ that has a
//     references folder: the body of its SKILL.md and each references/*.md, split into sections by their
//     headings (read_guide, and the resources portaldot://guide/<name>);
//   - src/generated/prompts.ts from every plugins/portaldot-dev/skills/*/SKILL.md whose front matter has
//     a line "mcp-prompt: <name>": the body of that file becomes the MCP prompt of that name.
//
// Usage, from server-src:
//   node scripts/gen-knowledge.mjs                   write the four files
//   node scripts/gen-knowledge.mjs --check           write nothing; fail when a file is not up to date
//   node scripts/gen-knowledge.mjs --stdin           read an errors.md from stdin, check it, write nothing
//   node scripts/gen-knowledge.mjs --stdin-mistakes  read a native-call-errors.md from stdin, check it, write nothing
//   node scripts/gen-knowledge.mjs --skills <folder> --json
//                                                    read the guide and the prompts from another skills
//                                                    folder, print what was read as JSON, write nothing
//
// Section ids are "<file>/<token>". The file is the name of a references file without ".md", or the
// skill's folder name for its SKILL.md. The token is the number of a numbered heading ("### E12. ..." gives
// "errors/E12", "## 4. ..." gives "recipes-contracts/4", "### 2f. ..." gives "recipes-contracts/2f"), or else
// up to four plain words of the heading ("## Tools" gives "contracts/tools"). The text before a file's first
// section is "<file>/intro". Headings inside code blocks are not headings. Two files with the same name in
// different skills, a code block that is never closed, a prompt name that is not snake_case and two
// prompts with the same name are refused.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_REL = 'plugins/portaldot-dev/skills';
const REFERENCES_REL = `${SKILLS_REL}/portaldot-v3/references`;

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

/* ---------- the knowledge pack -> src/generated/guide.ts ---------- */

/** The opening line of a code block: three or more backticks or tildes. Headings inside a block are code. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_LINE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
/** "E12. Title", "4. Title", "2f. Title": the number is the section's token. */
const NUMBERED = /^(E\d+|\d+[a-z]?)\.\s+(\S.*)$/;
/**
 * Words left out of a token: they make it longer without telling sections apart. src/lib/guide.ts
 * turns a topic into a token with the same list, so the two must stay the same.
 */
const STOP_WORDS = new Set(
  'a an the of and or to in on for with by is are was were be been has have had it its that this these those what which who how do does did from as at into than then you your we our they their there here can may might will would should must also only just'.split(' '),
);
const MAX_TOKEN_WORDS = 4;
/** A file's name becomes part of every section id and of a resource address, so it is kept plain. */
const FILE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Up to four plain words of a heading, in lower case, joined by "-": "The two forms" gives "two-forms". */
function slug(title) {
  const words = title
    .toLowerCase()
    .replace(/'/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w));
  return words.slice(0, MAX_TOKEN_WORDS).join('-') || 'section';
}

/** A string as JSON in plain ASCII: every character above "~" is written as an escape. */
function asciiJson(s) {
  const backslash = String.fromCharCode(92);
  return [...JSON.stringify(s)]
    .map((c) => {
      const code = c.codePointAt(0);
      if (code <= 126) return c;
      // a character above U+FFFF is written as its two UTF-16 halves, as JSON allows
      return [...Array.from({ length: c.length }, (_, k) => c.charCodeAt(k))].map((u) => `${backslash}u${u.toString(16).padStart(4, '0')}`).join('');
    })
    .join('');
}

/** The fields of a SKILL.md's front matter (plain "key: value" lines) and the text after it. */
function frontMatter(markdown) {
  const text = markdown.replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { fields: {}, body: text, lineOffset: 0 };
  const fields = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    // a folded (>) or literal (|) block: the indented lines that follow
    if (/^[>|][+-]?$/.test(value)) {
      const more = [];
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
      value = more.join(value.startsWith('>') ? ' ' : '\n');
    }
    fields[kv[1]] = value.replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  const rest = text.slice(m[0].length);
  const lead = /^\n*/.exec(rest)[0].length;
  return { fields, body: rest.slice(lead), lineOffset: (m[0].match(/\n/g) ?? []).length + lead };
}

/** The end of a piece of text without its trailing blank lines and its closing rule ("---"). */
function cleanEnd(text, start, end) {
  let e = end;
  for (;;) {
    while (e > start && /\s/.test(text[e - 1])) e--;
    const lineStart = text.lastIndexOf('\n', e - 1) + 1;
    if (lineStart > start && /^ {0,3}-{3,}[ \t]*$/.test(text.slice(lineStart, e))) e = lineStart;
    else return e;
  }
}

/**
 * The title and the sections of one knowledge file. Each section has its own text (from its heading to
 * the next heading, start to end) and its whole text (with the sections under it, start to fullEnd).
 */
function parseFile(text, where, lineOffset, problems) {
  const lines = text.split('\n');
  const heads = [];
  let title = null;
  let fence = null;
  let offset = 0;
  lines.forEach((line, i) => {
    const at = offset;
    offset += line.length + 1;
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.marker[0] && f[1].length >= fence.marker.length && line.trim() === f[1]) fence = null;
      return;
    }
    if (f) {
      fence = { marker: f[1], line: i };
      return;
    }
    const h = HEADING_LINE.exec(line);
    if (!h) return;
    const level = h[1].length;
    if (level === 1 && title === null && !heads.length) title = { text: h[2], end: Math.min(offset, text.length) };
    // a later level-1 heading counts as level 2; levels 4 to 6 stay inside their section
    else if (level <= 3) heads.push({ level: Math.max(2, level), heading: h[2], at });
  });
  if (fence) problems.push(`${where}, line ${fence.line + 1 + lineOffset}: a code block starts here and is never closed, so no heading after it can be found`);

  const sections = [];
  const tokens = new Set();
  const firstAt = heads.length ? heads[0].at : text.length;
  if (text.slice(title ? title.end : 0, firstAt).trim()) {
    tokens.add('intro');
    const end = cleanEnd(text, 0, firstAt);
    sections.push({ token: 'intro', level: 1, title: title?.text ?? null, start: 0, end, fullEnd: end, parentIndex: -1 });
  }
  const byHead = [];
  heads.forEach((h, k) => {
    const n = NUMBERED.exec(h.heading);
    const base = n ? n[1] : slug(h.heading);
    let token = base;
    for (let c = 2; tokens.has(token); c++) token = `${base}-${c}`;
    tokens.add(token);
    const next = heads[k + 1];
    const after = heads.slice(k + 1).find((x) => x.level <= h.level);
    let parentIndex = -1;
    for (let j = k - 1; j >= 0; j--) {
      if (heads[j].level < h.level) {
        parentIndex = byHead[j];
        break;
      }
    }
    byHead.push(sections.length);
    sections.push({
      token,
      level: h.level,
      title: n ? n[2] : h.heading,
      start: h.at,
      end: cleanEnd(text, h.at, next ? next.at : text.length),
      fullEnd: cleanEnd(text, h.at, after ? after.at : text.length),
      parentIndex,
    });
  });
  return { title: title?.text ?? null, sections };
}

/**
 * Reads every skill folder with a references folder: the body of its SKILL.md first, then each
 * references/*.md in the order the SKILL.md first names them (the others after, by name).
 */
function parseGuide(skillsDir, skillsRel) {
  const problems = [];
  const files = [];
  const sections = [];
  if (!existsSync(skillsDir)) return { result: null, summary: '', problems: [`the folder ${skillsRel} does not exist`] };
  // The skill with the most knowledge files comes first: it is the main pack, and a bare "SKILL.md" means its text.
  const refCount = (d) => {
    const r = join(skillsDir, d, 'references');
    return existsSync(r) ? readdirSync(r).filter((n) => n.endsWith('.md')).length : 0;
  };
  const skills = readdirSync(skillsDir)
    .filter((d) => statSync(join(skillsDir, d)).isDirectory())
    .sort((a, b) => refCount(b) - refCount(a) || (a < b ? -1 : a > b ? 1 : 0));
  const from = new Map(); // file id -> the file it was made from
  let used = 0;
  for (const skill of skills) {
    const refDir = join(skillsDir, skill, 'references');
    if (!existsSync(refDir) || !statSync(refDir).isDirectory()) continue;
    used++;
    const parts = [];
    const summaries = new Map();
    const named = [];
    const skillFile = join(skillsDir, skill, 'SKILL.md');
    if (existsSync(skillFile)) {
      const fm = frontMatter(readFileSync(skillFile, 'utf8'));
      parts.push({ id: skill, rel: `${skill}/SKILL.md`, text: fm.body, lineOffset: fm.lineOffset, isSkill: true });
      for (const m of fm.body.matchAll(/`references\/([A-Za-z0-9._-]+?)\.md`/g)) if (!named.includes(m[1])) named.push(m[1]);
      for (const m of fm.body.matchAll(/^- `references\/([A-Za-z0-9._-]+?)\.md`:?[ \t]*(\S.*)$/gm)) if (!summaries.has(m[1])) summaries.set(m[1], m[2].trim());
    }
    const rank = (name) => (named.includes(name) ? named.indexOf(name) : named.length);
    const names = readdirSync(refDir)
      .filter((f) => /\.md$/i.test(f) && statSync(join(refDir, f)).isFile())
      .map((f) => f.slice(0, -3))
      .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      parts.push({ id: name, rel: `${skill}/references/${name}.md`, text: readFileSync(join(refDir, `${name}.md`), 'utf8').replace(/\r\n?/g, '\n'), lineOffset: 0, isSkill: false });
    }
    for (const p of parts) {
      const where = `${skillsRel}/${p.rel}`;
      if (!FILE_ID.test(p.id)) {
        problems.push(`${where}: the name "${p.id}" may hold only lower-case letters, digits and "-", because it becomes part of every section id and of the address portaldot://guide/${p.id}`);
        continue;
      }
      if (from.has(p.id)) {
        problems.push(`${where}: another knowledge file has the name "${p.id}" (${from.get(p.id)}); section ids are made from file names, so rename one of the two`);
        continue;
      }
      from.set(p.id, where);
      if (!p.text.trim()) {
        problems.push(`${where}: the file is empty`);
        continue;
      }
      const parsed = parseFile(p.text, where, p.lineOffset, problems);
      const title = parsed.title ?? p.id;
      const topTitles = parsed.sections.filter((s) => s.level === 2).map((s) => s.title.replace(/[.:]$/, ''));
      const summary = p.isSkill
        ? `The main notes of the ${skill} skill${topTitles.length ? `: ${topTitles.join('; ')}` : ''}.`
        : (summaries.get(p.id) ?? title);
      files.push({ id: p.id, skill, path: p.rel, title, summary, text: p.text });
      const ids = parsed.sections.map((s) => `${p.id}/${s.token}`);
      parsed.sections.forEach((s, k) => {
        sections.push({ id: ids[k], file: p.id, token: s.token, level: s.level, title: s.title ?? title, start: s.start, end: s.end, fullEnd: s.fullEnd, parent: s.parentIndex >= 0 ? ids[s.parentIndex] : null });
      });
    }
  }
  if (!used) problems.push(`no skill folder in ${skillsRel} has a references folder, so the guide would be empty`);
  return { result: { files, sections }, summary: `${files.length} files, ${sections.length} sections, from ${used} skill${used === 1 ? '' : 's'}`, problems };
}

function renderGuide({ files, sections }, sourceRel) {
  const s = asciiJson;
  return [
    '// GENERATED FILE: do not edit it by hand.',
    `// Made by scripts/gen-knowledge.mjs from the SKILL.md and references/*.md of every skill folder under ${sourceRel}/ that has a references folder.`,
    '// To change it, edit those files and run, from server-src: node scripts/gen-knowledge.mjs',
    '',
    'export interface GuideFile {',
    '  /** The name used in section ids and in portaldot://guide/<id>: the references file without ".md", or the skill folder for its SKILL.md. */',
    '  id: string;',
    '  /** The skill folder the file belongs to. */',
    '  skill: string;',
    '  /** The file, from the skills folder: "portaldot-v3/references/errors.md". */',
    '  path: string;',
    '  /** The first level-1 heading, or the id when there is none. */',
    '  title: string;',
    '  /** One line on what the file holds: its line in the SKILL.md list of references, or the titles of its parts. */',
    '  summary: string;',
    '  /** The whole Markdown (for a SKILL.md, the text after its front matter). Sections are pieces of it. */',
    '  text: string;',
    '}',
    '',
    'export interface GuideSection {',
    '  /** "<file id>/<token>", for example "errors/E12". */',
    '  id: string;',
    '  file: string;',
    '  /** The number of a numbered heading ("E12", "4", "2f"), up to four words of the heading ("two-forms"), or "intro". */',
    '  token: string;',
    '  /** 1 for the text before the first heading of level 2 or 3; else the level of the heading. */',
    '  level: 1 | 2 | 3;',
    '  /** The heading without its number. */',
    '  title: string;',
    '  /** Its own text is file.text.slice(start, end); with the sections under it, file.text.slice(start, fullEnd). */',
    '  start: number;',
    '  end: number;',
    '  fullEnd: number;',
    '  /** The section this one is under, or null when it is directly under the file. */',
    '  parent: string | null;',
    '}',
    '',
    'export const GUIDE_FILES: GuideFile[] = [',
    ...files.map((f) => `  { id: ${s(f.id)}, skill: ${s(f.skill)}, path: ${s(f.path)}, title: ${s(f.title)}, summary: ${s(f.summary)}, text: ${s(f.text)} },`),
    '];',
    '',
    'export const GUIDE_SECTIONS: GuideSection[] = [',
    ...sections.map(
      (x) => `  { id: ${s(x.id)}, file: ${s(x.file)}, token: ${s(x.token)}, level: ${x.level}, title: ${s(x.title)}, start: ${x.start}, end: ${x.end}, fullEnd: ${x.fullEnd}, parent: ${x.parent === null ? 'null' : s(x.parent)} },`,
    ),
    '];',
    '',
  ].join('\n');
}

/* ---------- SKILL.md files with "mcp-prompt: <name>" -> src/generated/prompts.ts ---------- */

/** A prompt name: snake_case, as MCP clients show it to people. */
const PROMPT_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function parsePrompts(skillsDir, skillsRel) {
  const problems = [];
  const prompts = [];
  if (!existsSync(skillsDir)) return { result: null, summary: '', problems: [`the folder ${skillsRel} does not exist`] };
  const skills = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory()).sort();
  for (const skill of skills) {
    const file = join(skillsDir, skill, 'SKILL.md');
    if (!existsSync(file)) continue;
    const where = `${skillsRel}/${skill}/SKILL.md`;
    const fm = frontMatter(readFileSync(file, 'utf8'));
    const name = fm.fields['mcp-prompt'];
    if (name === undefined) continue;
    if (!PROMPT_NAME.test(name)) {
      problems.push(`${where}: the prompt name ${JSON.stringify(name)} must be snake_case: lower-case letters, digits and "_", starting with a letter, at most 64 characters`);
      continue;
    }
    const twin = prompts.find((p) => p.name === name);
    if (twin) {
      problems.push(`${where}: the prompt name "${name}" is also used by ${skillsRel}/${twin.skill}/SKILL.md; give each prompt its own name`);
      continue;
    }
    const body = fm.body.trim();
    if (!body) {
      problems.push(`${where}: there is no text after the front matter, so the prompt "${name}" would be empty`);
      continue;
    }
    const h1 = /^# +(\S.*?)\s*$/m.exec(body);
    prompts.push({ name, skill, title: fm.fields['mcp-prompt-title'] || h1?.[1] || skill, description: fm.fields.description ?? '', body });
  }
  return {
    result: prompts,
    summary: prompts.length ? `${prompts.length} prompt${prompts.length === 1 ? '' : 's'}: ${prompts.map((p) => p.name).join(', ')}` : 'no prompts, because no SKILL.md has a line "mcp-prompt: <name>"',
    problems,
  };
}

function renderPrompts(prompts, sourceRel) {
  const s = asciiJson;
  return [
    '// GENERATED FILE: do not edit it by hand.',
    `// Made by scripts/gen-knowledge.mjs from every ${sourceRel}/*/SKILL.md whose front matter has a line "mcp-prompt: <name>".`,
    '// To change it, edit that SKILL.md and run, from server-src: node scripts/gen-knowledge.mjs',
    '',
    'export interface PromptEntry {',
    '  /** From the line "mcp-prompt: <name>" of the front matter. */',
    '  name: string;',
    '  /** The skill folder it comes from. */',
    '  skill: string;',
    '  /** "mcp-prompt-title" of the front matter, else the first level-1 heading, else the folder name. */',
    '  title: string;',
    '  /** "description" of the front matter, or "". */',
    '  description: string;',
    '  /** The Markdown after the front matter. */',
    '  body: string;',
    '}',
    '',
    ...(prompts.length
      ? ['export const PROMPT_ENTRIES: PromptEntry[] = [', ...prompts.map((p) => `  { name: ${s(p.name)}, skill: ${s(p.skill)}, title: ${s(p.title)}, description: ${s(p.description)}, body: ${s(p.body)} },`), '];']
      : ['export const PROMPT_ENTRIES: PromptEntry[] = [];']),
    '',
  ].join('\n');
}

/* ---------- the command ---------- */

const ROOT = resolve(SERVER_SRC, '..');

/** Reads one knowledge file and parses it. */
function loadFile(sourceRel, parse) {
  const source = resolve(ROOT, sourceRel);
  if (!existsSync(source)) return { result: null, summary: '', problems: [`the file does not exist (looked for it at ${sourceRel}, next to server-src)`] };
  return parse(readFileSync(source, 'utf8'));
}

const TARGETS = [
  { key: 'errors', sourceRel: `${REFERENCES_REL}/errors.md`, targetRel: 'src/generated/errors.ts', parse: parseErrors, load: () => loadFile(`${REFERENCES_REL}/errors.md`, parseErrors), render: renderErrors },
  { key: 'mistakes', sourceRel: `${REFERENCES_REL}/native-call-errors.md`, targetRel: 'src/generated/mistakes.ts', parse: parseMistakes, load: () => loadFile(`${REFERENCES_REL}/native-call-errors.md`, parseMistakes), render: renderMistakes },
  { key: 'guide', sourceRel: SKILLS_REL, targetRel: 'src/generated/guide.ts', load: () => parseGuide(resolve(ROOT, SKILLS_REL), SKILLS_REL), render: renderGuide },
  { key: 'prompts', sourceRel: SKILLS_REL, targetRel: 'src/generated/prompts.ts', load: () => parsePrompts(resolve(ROOT, SKILLS_REL), SKILLS_REL), render: renderPrompts },
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
  const target = resolve(SERVER_SRC, t.targetRel);
  const parsed = t.load();
  if (parsed.problems.length) return fail(t.sourceRel, parsed.problems);
  const output = t.render(parsed.result, t.sourceRel);
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (check) {
    if (current === output) console.log(`gen-knowledge: ${t.targetRel} is up to date (${parsed.summary}).`);
    else fail(t.targetRel, [current === null ? 'the file does not exist; run: node scripts/gen-knowledge.mjs' : `it is out of date with ${t.sourceRel}; run: node scripts/gen-knowledge.mjs`]);
  } else if (current === output) {
    // an unchanged file is not written again, so its date stays and no build sees a change
    console.log(`gen-knowledge: ${t.targetRel} is up to date (${parsed.summary}); not written.`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output);
    console.log(`gen-knowledge: wrote ${t.targetRel}: ${parsed.summary}, from ${t.sourceRel}.`);
  }
}

const args = process.argv.slice(2);
const stdinKey = args.includes('--stdin-mistakes') ? 'mistakes' : args.includes('--stdin') ? 'errors' : null;
const skillsAt = args.indexOf('--skills');
if (skillsAt >= 0) {
  // Another skills folder, for tests: everything is read and checked, and nothing is written.
  const dir = args[skillsAt + 1];
  if (!dir || dir.startsWith('--')) {
    fail('--skills', ['name the folder after --skills, for example: --skills test/unit/fixtures/skills-good']);
  } else {
    const folder = resolve(process.cwd(), dir);
    const guide = parseGuide(folder, dir);
    const prompts = parsePrompts(folder, dir);
    const problems = [...guide.problems, ...prompts.problems];
    if (problems.length) fail(`the skills folder ${dir}`, problems);
    else if (args.includes('--json')) console.log(JSON.stringify({ guide: guide.result, prompts: prompts.result }));
    else console.log(`gen-knowledge: the skills folder ${dir} is valid: ${guide.summary}; ${prompts.summary}.`);
  }
} else if (stdinKey) {
  const t = TARGETS.find((x) => x.key === stdinKey);
  const name = t.sourceRel.split('/').pop();
  const parsed = t.parse(await readStdin());
  if (parsed.problems.length) fail(`the ${name} on stdin`, parsed.problems);
  else console.log(`gen-knowledge: the ${name} on stdin is valid: ${parsed.summary}.`);
} else {
  for (const t of TARGETS) run(t, args.includes('--check'));
}
