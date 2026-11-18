// The kit's knowledge pack by section, for read_guide: a table of contents, one section in full (in
// numbered parts when it is long), and a search. No network: the text is in src/generated/guide.ts,
// made from the skill's SKILL.md and references/*.md by scripts/gen-knowledge.mjs.
import { GUIDE_FILES, GUIDE_SECTIONS, type GuideFile, type GuideSection } from '../generated/guide.ts';
import { ToolError } from './errors.ts';
import { clip, lines } from './format.ts';
import { untrusted } from './text.ts';

/** Longest answer: below the 19,000 characters any tool may return, with room for a warning line in front. */
export const ANSWER_LIMIT = 18_000;
/** Most text of the knowledge pack in one part of a long topic; the header and the footer come on top. */
export const PART_CHARS = 15_000;
/** Most sections a search lists. */
export const MAX_HITS = 8;

export interface Guide {
  files: GuideFile[];
  sections: GuideSection[];
}

/** The knowledge pack the server carries. */
export const GUIDE: Guide = { files: GUIDE_FILES, sections: GUIDE_SECTIONS };

/* ---------- tokens and words ---------- */

/**
 * Words left out of a section token. scripts/gen-knowledge.mjs makes the tokens with the same list,
 * so a topic written as words ("the two forms") finds the token "two-forms".
 */
const STOP_WORDS = new Set(
  'a an the of and or to in on for with by is are was were be been has have had it its that this these those what which who how do does did from as at into than then you your we our they their there here can may might will would should must also only just'.split(' '),
);
const MAX_TOKEN_WORDS = 4;

/** Up to four plain words, in lower case, joined by "-": the token of a heading without a number. */
export function slugToken(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/'/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w));
  return words.slice(0, MAX_TOKEN_WORDS).join('-') || 'section';
}

/** Words a search ignores besides the stop words: they say that something is asked, not what. */
const QUERY_NOISE = new Set(['i', 'me', 'my', 'not', 'no', 'why', 'when', 'where', 'get', 'use', 'using', 'about', 'please', 'want', 'need', 'some', 'any', 'way']);

/** A light stem, so that "deposits" finds "deposit" and "addresses" finds "address". */
export function stem(word: string): string {
  if (word.length <= 3 || /^\d/.test(word)) return word;
  if (/(?:sses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/.test(word)) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** The words of a text in lower case: letters, digits and "_" (so eth_getLogs stays one word). */
const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);

/** A text in lower case with every run of other characters as one space, for phrase matching. */
const flat = (text: string): string => ` ${text.toLowerCase().replace(/[^a-z0-9_]+/g, ' ').trim()} `;

/** The words of a query worth searching for, stemmed, each once. */
export function queryStems(query: string): string[] {
  const out: string[] = [];
  for (const w of wordsOf(query)) {
    if (STOP_WORDS.has(w) || QUERY_NOISE.has(w) || (w.length < 2 && !/^\d$/.test(w))) continue;
    const s = stem(w);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** True when a word of the text matches a query word: the same stem, or a longer word that starts with it. */
const matchesStem = (textStem: string, queryStem: string): boolean => textStem === queryStem || (queryStem.length >= 4 && textStem.startsWith(queryStem));

/* ---------- the index ---------- */

interface Doc {
  section: GuideSection;
  order: number;
  titleStems: string[];
  /** Each stem of the section's own text below its heading, with how often it occurs. */
  bodyStems: Map<string, number>;
  flatTitle: string;
  flatBody: string;
}

interface Index {
  files: Map<string, GuideFile>;
  /** By id in lower case. */
  sections: Map<string, GuideSection>;
  children: Map<string, GuideSection[]>;
  top: Map<string, GuideSection[]>;
  order: Map<GuideSection, number>;
  docs: Doc[] | null;
}

const indexes = new WeakMap<Guide, Index>();

function indexOf(g: Guide): Index {
  let ix = indexes.get(g);
  if (ix) return ix;
  ix = { files: new Map(g.files.map((f) => [f.id, f])), sections: new Map(), children: new Map(), top: new Map(), order: new Map(), docs: null };
  for (const [i, s] of g.sections.entries()) {
    ix.sections.set(s.id.toLowerCase(), s);
    ix.order.set(s, i);
    const list = s.parent ? ix.children : ix.top;
    const key = s.parent ?? s.file;
    list.set(key, [...(list.get(key) ?? []), s]);
  }
  indexes.set(g, ix);
  return ix;
}

/** The search data, built at the first search (a few milliseconds) and kept. */
function docsOf(g: Guide): Doc[] {
  const ix = indexOf(g);
  if (ix.docs) return ix.docs;
  ix.docs = g.sections.map((section, order) => {
    const own = ownText(g, section);
    const body = own.slice(own.indexOf('\n') + 1 || own.length);
    const bodyStems = new Map<string, number>();
    for (const w of wordsOf(body)) {
      const s = stem(w);
      bodyStems.set(s, (bodyStems.get(s) ?? 0) + 1);
    }
    const titleText = `${section.title} ${section.token.replace(/-/g, ' ')}`;
    return { section, order, titleStems: [...new Set(wordsOf(titleText).map(stem))], bodyStems, flatTitle: flat(section.title), flatBody: flat(body) };
  });
  return ix.docs;
}

const fileOf = (g: Guide, s: GuideSection): GuideFile => {
  const f = indexOf(g).files.get(s.file);
  if (!f) throw new Error(`the guide has no file ${s.file}`);
  return f;
};

/** A section's own text: its heading and what follows, up to the next heading. */
export const ownText = (g: Guide, s: GuideSection): string => fileOf(g, s).text.slice(s.start, s.end);
/** A section with the sections under it. */
export const fullText = (g: Guide, s: GuideSection): string => fileOf(g, s).text.slice(s.start, s.fullEnd);

const childrenOf = (g: Guide, s: GuideSection): GuideSection[] => indexOf(g).children.get(s.id) ?? [];
const descendants = (g: Guide, s: GuideSection): GuideSection[] => childrenOf(g, s).flatMap((c) => [c, ...descendants(g, c)]);
const topOf = (g: Guide, f: GuideFile): GuideSection[] => indexOf(g).top.get(f.id) ?? [];
const sectionsOfFile = (g: Guide, f: GuideFile): GuideSection[] => g.sections.filter((s) => s.file === f.id);

/** "E12 Nonce trouble" for a numbered section, the title alone for the others. */
const titleOf = (s: GuideSection): string => (s.token === 'intro' ? `${s.title} (the text before the first heading)` : /^(?:E\d+|\d+[a-z]?)$/.test(s.token) ? `${s.token}. ${s.title}` : s.title);

/** A call of read_guide, written the way the model passes it. */
export const call = (args: Record<string, string | number>): string => `read_guide ${JSON.stringify(args)}`;

/* ---------- the table of contents ---------- */

/** The table of contents: per file, what it holds and its sections with their ids. */
export function contents(g: Guide = GUIDE): string {
  const out: string[] = [
    `The Bridge Zero team's knowledge pack for Portaldot V3: ${g.files.length} files, ${g.sections.length} sections. Every fact in it says how it is known (Checked, Experience, Guide or Reported) and when.`,
    `A section's id is its file and its token: ${call({ topic: 'errors/E12' })} returns that section in full. Short forms work too ("E12", "recipe 4", "2f"), and a file name returns the whole file in parts.`,
    `${call({ query: 'storage deposit deploy' })} searches every section and shows the best one in full. Each file's text before its first heading is <file>/intro.`,
  ];
  const depth = (s: GuideSection): number => {
    let d = 0;
    for (let p = s.parent; p; p = indexOf(g).sections.get(p.toLowerCase())?.parent ?? null) d++;
    return d;
  };
  for (const f of g.files) {
    out.push('', `${f.id}: ${f.summary}`);
    // the title too: a token alone ("evm", "proven-not") does not always say enough
    out.push(...sectionsOfFile(g, f).filter((s) => s.token !== 'intro').map((s) => `${'  '.repeat(1 + depth(s))}${s.token}  ${clip(s.title, 80)}`));
  }
  out.push('', `Next: ${call({ topic: '<file>/<token>' })} for one section; ${call({ query: '<words>' })} to search.`);
  return lines(out);
}

/* ---------- finding a topic ---------- */

export type Found =
  | { kind: 'file'; file: GuideFile }
  | { kind: 'section'; section: GuideSection }
  | { kind: 'many'; sections: GuideSection[] }
  | { kind: 'none'; near: GuideSection[] };

/** "E012", "e 12" and "E12" are the same token; other tokens are compared in lower case. */
const canon = (token: string): string => token.toLowerCase().replace(/\s+/g, '').replace(/^e0+(?=\d)/, 'e');

/** Words that name the kind of thing asked for, not which one: "section 3", "item 4", "the entry E12". */
const FILLER = new Set(['section', 'sections', 'entry', 'entries', 'item', 'items', 'part', 'number', 'no', 'nr', 'of', 'in', 'the', 'from', 'file', 'chapter', 'see', 'read']);

/**
 * The files a word points to: the file of that name, or (wide, or when there is none) every file whose
 * name starts with it or holds it as a part ("recipe" gives recipes and recipes-contracts).
 */
function filesFor(g: Guide, word: string, wide = false): GuideFile[] {
  const w = word.toLowerCase();
  const exact = g.files.filter((f) => f.id === w);
  if (exact.length && !wide) return exact;
  const root = stem(w);
  return g.files.filter((f) => f.id.startsWith(w) || f.id.split('-').some((part) => stem(part) === root));
}

function unique(list: GuideSection[]): Found | null {
  const set = [...new Set(list)];
  if (set.length === 1) return { kind: 'section', section: set[0] };
  if (set.length > 1) return { kind: 'many', sections: set };
  return null;
}

/** How many single-character edits turn a into b; counting stops above 3. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 4;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** The sections nearest to a topic that names none: by its words, then by spelling. */
function nearest(g: Guide, topic: string): GuideSection[] {
  const byWords = rank(g, topic, g.sections).slice(0, 5).map((h) => h.section);
  if (byWords.length >= 3) return byWords;
  const t = canon(topic.replace(/^.*\//, ''));
  const bySpelling = g.sections
    .map((s) => ({ s, d: Math.min(editDistance(t, canon(s.token)), editDistance(canon(topic), s.id.toLowerCase())) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d || indexOf(g).order.get(a.s)! - indexOf(g).order.get(b.s)!)
    .map((x) => x.s);
  return [...new Set([...byWords, ...bySpelling])].slice(0, 5);
}

/** Turns a topic (an id, a file, a path, a short form or a title) into what it names. */
export function findTopic(g: Guide, topic: string): Found {
  const ix = indexOf(g);
  // Trailing punctuation or a trailing slash, as a topic written from prose may have ("E12.", "errors/"), is dropped.
  let t = topic.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim().replace(/\\/g, '/').replace(/#/g, '/').replace(/[\s/.:;,]+$/, '');
  // a path to a knowledge file: .../portaldot-v3/SKILL.md, plugins/.../references/errors.md, references/errors.md, errors.md
  const skillPath = /^(?:.*\/)?([a-z0-9-]+)\/skill\.md(\/.*)?$/i.exec(t);
  if (skillPath) t = `${skillPath[1]}${skillPath[2] ?? ''}`;
  else if (/^skill\.md(?:\/|$)/i.test(t)) t = t.replace(/^skill\.md/i, g.files.find((f) => /\/SKILL\.md$/.test(f.path))?.id ?? 'skill');
  t = t.replace(/^(?:\.\/)?(?:.*\/)?references\//i, '').replace(/\.md(?=\/|$)/i, '');
  const low = t.toLowerCase();
  if (!low) return { kind: 'none', near: [] };

  // 1. an id or a file
  const byId = ix.sections.get(low);
  if (byId) return { kind: 'section', section: byId };
  const file = ix.files.get(low);
  if (file) return { kind: 'file', file };

  // 2. "<file>/<token>", also with a file name that is only the start of one ("recipes/4" is in recipes-contracts)
  const slash = low.indexOf('/');
  if (slash > 0) {
    const filePart = low.slice(0, slash);
    const rest = low.slice(slash + 1).trim();
    const inFiles = (files: GuideFile[]): GuideSection[] => {
      const ids = new Set(files.map((f) => f.id));
      const pool = g.sections.filter((s) => ids.has(s.file));
      const exact = pool.filter((s) => canon(s.token) === canon(rest) || s.token === slugToken(rest));
      if (exact.length) return exact;
      return pool.filter((s) => slugToken(rest) !== 'section' && s.token.startsWith(slugToken(rest)));
    };
    const exactFile = g.files.filter((f) => f.id === filePart);
    const found = unique(inFiles(exactFile)) ?? unique(inFiles(filesFor(g, filePart, true)));
    if (found) return found;
  }

  // 3. a short form with a number: "E12", "recipe 4", "2f", "evm-checks section 3", "open question 4"
  const words = low.replace(/\//g, ' ').split(/\s+/).filter(Boolean);
  const joined = words.join(' ').replace(/\be (\d+)\b/, 'e$1');
  const numbers = joined.split(' ').filter((w) => /^(?:e\d+|\d+[a-z]?)$/.test(w));
  if (numbers.length === 1) {
    const hints = joined.split(' ').filter((w) => w !== numbers[0] && !FILLER.has(w) && w.length >= 3);
    const hinted = hints.flatMap((w) => filesFor(g, w));
    // words that name no file ("rule 3") make this some other kind of topic
    if (!hints.length || hinted.length) {
      const files = hinted.length ? new Set(hinted.map((f) => f.id)) : null;
      const found = unique(g.sections.filter((s) => (!files || files.has(s.file)) && canon(s.token) === canon(numbers[0])));
      if (found) return found;
    }
  }

  // 4. a title, or the words of a token
  const ft = flat(t);
  const byTitle = unique(g.sections.filter((s) => flat(s.title) === ft || flat(titleOf(s)) === ft));
  if (byTitle) return byTitle;
  const token = slugToken(t);
  if (token !== 'section') {
    const byToken = unique(g.sections.filter((s) => s.token === token));
    if (byToken) return byToken;
    const starts = g.sections.filter((s) => s.token.startsWith(token));
    if (starts.length >= 1 && starts.length <= 6) return unique(starts) as Found;
  }
  return { kind: 'none', near: nearest(g, t) };
}

/* ---------- parts of a long text ---------- */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

interface Block {
  text: string;
  /** The opening line, when the block is a code block. */
  fence: string | null;
}

/** Paragraphs and code blocks: the pieces a part may be cut between. A code block stays one piece. */
function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let cur: string[] = [];
  let fence: { marker: string; line: string } | null = null;
  const end = (f: string | null = null): void => {
    if (cur.length) blocks.push({ text: cur.join('\n'), fence: f });
    cur = [];
  };
  for (const line of text.split('\n')) {
    const f = FENCE.exec(line);
    if (fence) {
      cur.push(line);
      if (f && f[1][0] === fence.marker[0] && f[1].length >= fence.marker.length && line.trim() === f[1]) {
        end(fence.line);
        fence = null;
      }
      continue;
    }
    if (f) {
      end();
      fence = { marker: f[1], line };
      cur.push(line);
      continue;
    }
    if (!line.trim()) end();
    else cur.push(line);
  }
  end(fence ? fence.line : null);
  return blocks;
}

/** A block longer than a part, cut at line ends. A code block is closed at each cut and opened again after it. */
function cutBlock(b: Block, max: number): string[] {
  const close = b.fence ? (FENCE.exec(b.fence)?.[1] ?? '```') : '';
  const room = Math.max(200, max - (b.fence ? b.fence.length + close.length + 2 : 0));
  const chunks: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (let line of b.text.split('\n')) {
    while (line.length > room) {
      if (cur.length) chunks.push(cur.join('\n'));
      cur = [];
      len = 0;
      chunks.push(line.slice(0, room));
      line = line.slice(room);
    }
    if (cur.length && len + line.length + 1 > room) {
      chunks.push(cur.join('\n'));
      cur = [];
      len = 0;
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  if (!b.fence) return chunks;
  return chunks.map((c, i) => `${i > 0 ? `${b.fence}\n` : ''}${c}${i < chunks.length - 1 ? `\n${close}` : ''}`);
}

/**
 * A text cut into pieces of at most max characters (the first at most first), between paragraphs and
 * code blocks where it can. The first piece is empty when not even the first paragraph fits in first.
 */
export function splitText(text: string, max: number, first = max): string[] {
  if (text.length <= first) return [text];
  const out: string[] = [];
  let cur = '';
  let limit = first;
  const push = (): void => {
    out.push(cur);
    cur = '';
    limit = max;
  };
  for (const b of blocksOf(text)) {
    const room = limit - (cur ? cur.length + 2 : 0);
    if (b.text.length <= room) {
      cur = cur ? `${cur}\n\n${b.text}` : b.text;
      continue;
    }
    if (cur || limit < max) push();
    if (b.text.length <= max) {
      cur = b.text;
      continue;
    }
    const chunks = cutBlock(b, max);
    for (const c of chunks.slice(0, -1)) {
      cur = c;
      push();
    }
    cur = chunks[chunks.length - 1];
  }
  if (cur) out.push(cur);
  return out;
}

export interface Part {
  text: string;
  /** The sections that start in this part. */
  starts: string[];
  /** The section this part begins in the middle of, if it does. */
  inside: string | null;
}

interface Unit {
  text: string;
  starts: string[];
}

/** A section as units: whole when it fits in a part, else its own text and then each section under it. */
function unitsOf(g: Guide, s: GuideSection, max: number): Unit[] {
  const full = fullText(g, s);
  if (full.length <= max) return [{ text: full, starts: [s.id, ...descendants(g, s).map((d) => d.id)] }];
  const kids = childrenOf(g, s);
  if (!kids.length) return [{ text: full, starts: [s.id] }];
  return [{ text: ownText(g, s), starts: [s.id] }, ...kids.flatMap((k) => unitsOf(g, k, max))];
}

/** A file or a section in parts of at most max characters, cut between sections where it can. */
export function partsOf(g: Guide, target: GuideFile | GuideSection, max = PART_CHARS): Part[] {
  let units: Unit[];
  if ('summary' in target) {
    const top = topOf(g, target);
    const all = sectionsOfFile(g, target).map((s) => s.id);
    if (target.text.length <= max || !top.length) units = [{ text: target.text.trim(), starts: all }];
    else {
      const before = target.text.slice(0, top[0].start).trim();
      units = [...(before ? [{ text: before, starts: [] }] : []), ...top.flatMap((s) => unitsOf(g, s, max))];
    }
  } else units = unitsOf(g, target, max);

  const parts: Part[] = [];
  let cur: Part = { text: '', starts: [], inside: null };
  const flush = (): void => {
    if (cur.text) parts.push(cur);
    cur = { text: '', starts: [], inside: null };
  };
  const add = (text: string, starts: string[]): void => {
    cur.text = cur.text ? `${cur.text}\n\n${text}` : text;
    cur.starts.push(...starts);
  };
  for (const u of units) {
    if (u.text.length <= max) {
      if (cur.text && cur.text.length + 2 + u.text.length > max) flush();
      add(u.text, u.starts);
      continue;
    }
    // a section longer than a part: it fills the current part when that is less than half full
    if (cur.text.length > max / 2) flush();
    let pieces = splitText(u.text, max, cur.text ? max - cur.text.length - 2 : max);
    if (!pieces[0]) {
      // not even its first paragraph fits in what is left: it starts the next part
      flush();
      pieces = pieces.slice(1);
    }
    const owner = u.starts[0] ?? null;
    pieces.forEach((piece, i) => {
      if (i > 0) {
        flush();
        cur.inside = owner;
      }
      add(piece, i === 0 ? u.starts : []);
    });
  }
  flush();
  return parts.length ? parts : [{ text: '', starts: [], inside: null }];
}

/* ---------- answers ---------- */

const tokenOf = (id: string): string => id.slice(id.indexOf('/') + 1);

/** "E1 to E6", "the rest of 2e, then 2f": what a part holds, in few words. */
function holds(p: Part): string {
  const ids = p.starts.filter((id) => !id.endsWith('/intro') || p.starts.length === 1);
  const from = ids.length ? (ids.length === 1 ? tokenOf(ids[0]) : `${tokenOf(ids[0])} to ${tokenOf(ids[ids.length - 1])}`) : '';
  const intro = p.starts.some((id) => id.endsWith('/intro')) && ids.length !== p.starts.length ? 'intro' : '';
  const rest = p.inside ? `the rest of ${tokenOf(p.inside)}` : '';
  return [rest, intro, from].filter(Boolean).join(', ') || 'text';
}

/** The section after this one in its file, for reading on. */
function nextSection(g: Guide, s: GuideSection): GuideSection | undefined {
  return g.sections.find((x) => x.file === s.file && x.start >= s.fullEnd && indexOf(g).order.get(x)! > indexOf(g).order.get(s)!);
}

const REFERS = /\bE\d{1,3}\b|\brecipes? \d+[a-z]?\b|`?[a-z-]+\.md`?/;

/** One section or one file in full, or the part asked for. */
function show(g: Guide, target: GuideFile | GuideSection, topicShown: string, part: number | undefined): string {
  const isFile = 'summary' in target;
  const id = target.id;
  const file = isFile ? target : fileOf(g, target);
  const parts = partsOf(g, target);
  const n = parts.length;
  const k = part ?? 1;
  if (k > n) {
    throw new ToolError(
      `${id} has ${n === 1 ? 'only one part, so leave "part" out' : `${n} parts, so "part" goes from 1 to ${n}`}. ${call({ topic: id, ...(n > 1 ? { part: 1 } : {}) })} reads it from the start.`,
    );
  }
  const p = parts[k - 1];
  const parent = !isFile && target.parent ? indexOf(g).sections.get(target.parent.toLowerCase()) : undefined;
  const what = isFile
    ? `${id}: the whole file ${file.path} ("${file.title}")`
    : `${id}: ${titleOf(target)}${parent ? ` (part of ${parent.id}: ${titleOf(parent)})` : ''}`;
  const head = [
    n > 1 ? `${what}. Part ${k} of ${n}: ${holds(p)}.` : `${what}.`,
    isFile ? `From the Bridge Zero team's knowledge pack for Portaldot V3.` : `From ${file.path} ("${file.title}") in the Bridge Zero team's knowledge pack for Portaldot V3.`,
    topicShown.toLowerCase() !== id.toLowerCase() ? `(The topic ${untrusted(topicShown, 100)} was read as ${id}.)` : null,
    n > 1 ? `All parts: ${parts.map((x, i) => `${i + 1}: ${holds(x)}`).join('; ')}.` : null,
  ];
  const next: string[] = [];
  if (k < n) next.push(`Next part: ${call({ topic: id, part: k + 1 })}`);
  else if (n > 1) next.push('This was the last part.');
  if (isFile && k === 1) next.push(`To read one section only: ${call({ topic: sectionsOfFile(g, target).find((s) => s.token !== 'intro')?.id ?? `${id}/intro` })} or another id of this file.`);
  if (!isFile && k === n) {
    const after = nextSection(g, target);
    if (after) next.push(`${call({ topic: after.id })} reads the next section, ${titleOf(after)}.`);
  }
  if (REFERS.test(p.text)) next.push('References in the text (E12, recipe 2f, errors.md) work as a topic too.');
  return lines(head, '', p.text, '', next.length ? next : null);
}

function many(g: Guide, topicShown: string, list: GuideSection[]): string {
  return lines(
    `The topic ${untrusted(topicShown, 100)} names ${list.length} sections of the knowledge pack:`,
    ...list.slice(0, 12).map((s) => `- ${s.id}: ${titleOf(s)} (${fileOf(g, s).title})`),
    list.length > 12 ? `- and ${list.length - 12} more` : null,
    '',
    `Next: ${call({ topic: list[0].id })} reads the first; pass the full id of the one you mean.`,
  );
}

function notFound(g: Guide, topicShown: string, near: GuideSection[]): never {
  // an entry number past the end ("E99"): say which numbers exist
  const entries = g.sections.filter((s) => /^E\d+$/.test(s.token));
  const range = /^\s*e\s*\d+\s*$/i.test(topicShown) && entries.length ? `The list of errors and traps runs from ${entries[0].id} to ${entries[entries.length - 1].id}.` : null;
  throw new ToolError(
    lines(
      `No section of the knowledge pack is called ${untrusted(topicShown, 100)}.`,
      range,
      near.length ? ['The nearest ids:', ...near.map((s) => `- ${s.id}: ${titleOf(s)}`)] : null,
      `Next: ${near.length ? `${call({ topic: near[0].id })} reads the first of these; ` : ''}${call({ query: clip(topicShown.replace(/[/#]/g, ' '), 80) })} searches the text of every section; read_guide with no arguments lists every id.`,
    ),
  );
}

/** read_guide with a topic: that section or file in full, or the part asked for. */
export function readTopic(topic: string, part?: number, g: Guide = GUIDE): string {
  const found = findTopic(g, topic);
  if (found.kind === 'none') return notFound(g, topic, found.near);
  if (found.kind === 'many') {
    if (part) throw new ToolError(`The topic ${untrusted(topic, 100)} names ${found.sections.length} sections (${found.sections.map((s) => s.id).join(', ')}); give the full id with "part".`);
    return many(g, topic, found.sections);
  }
  return show(g, found.kind === 'file' ? found.file : found.section, topic, part);
}

/* ---------- search ---------- */

export interface Hit {
  section: GuideSection;
  score: number;
  /** True when every word of the query is in the section. */
  all: boolean;
}

/**
 * The sections that match a query, best first. Simple and repeatable: a query word in the title or the
 * token counts 3 (a bare number 1), in the text 1 (a little more when it comes often), every word found
 * adds 2, and the exact phrase adds 6 in the title or 4 in the text. Ties keep the order of the files.
 */
export function rank(g: Guide, query: string, within: GuideSection[] = g.sections): Hit[] {
  const stems = queryStems(query);
  if (!stems.length) return [];
  const phrase = flat(query);
  const phraseWords = phrase.trim().split(' ').length;
  const allowed = new Set(within);
  const hits: Hit[] = [];
  for (const d of docsOf(g)) {
    if (!allowed.has(d.section)) continue;
    let score = 0;
    let found = 0;
    for (const q of stems) {
      const inTitle = d.titleStems.some((t) => matchesStem(t, q));
      let count = 0;
      for (const [t, c] of d.bodyStems) if (matchesStem(t, q)) count += c;
      // a bare number in a title is mostly a section number ("3. Tokens ..."), weak evidence in a search
      if (inTitle) score += /^\d+$/.test(q) ? 1 : 3;
      if (count) score += 1 + (count >= 3 ? 0.5 : 0) + (count >= 8 ? 0.5 : 0);
      if (inTitle || count) found++;
    }
    if (!found) continue;
    const all = found === stems.length;
    if (all && stems.length > 1) score += 2;
    if (phraseWords > 1) {
      if (d.flatTitle.includes(phrase)) score += 6;
      else if (d.flatBody.includes(phrase)) score += 4;
    }
    hits.push({ section: d.section, score, all });
  }
  return hits.sort((a, b) => b.score - a.score || indexOf(g).order.get(a.section)! - indexOf(g).order.get(b.section)!);
}

/** Two lines of a section's text: the first that holds a word of the query, and the one after it. */
export function excerpt(g: Guide, s: GuideSection, query: string): string[] {
  const stems = queryStems(query);
  const phrase = flat(query);
  const plain = (l: string): string => l.replace(/\*\*/g, '').replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim();
  // prose only: no code, no headings, no table rules, and no bare labels such as "Cause:"
  const content: string[] = [];
  let inCode = false;
  for (const l of ownText(g, s).split('\n')) {
    if (FENCE.test(l)) inCode = !inCode;
    else if (!inCode && l.trim() && !/^#{1,6}\s/.test(l) && !/^\s*\|?\s*:?-{3,}/.test(l) && !/^[^\s]{0,20}:?$/.test(plain(l))) content.push(l);
  }
  const hasWord = (l: string): boolean => flat(l).includes(phrase) || wordsOf(l).some((w) => stems.some((q) => matchesStem(stem(w), q)));
  const at = Math.max(0, content.findIndex(hasWord));
  return content.slice(at, at + 2).map((l) => clip(plain(l), 160));
}

/** read_guide with a query: the best sections, each with two lines of its text, and the best one in full when it fits. */
export function searchGuide(query: string, topic?: string, g: Guide = GUIDE): string {
  if (!queryStems(query).length) {
    throw new ToolError(`The query ${untrusted(query, 100)} has no word to search for: only common words such as "the" or "how". Name the thing, for example ${call({ query: 'storage deposit' })} or ${call({ query: 'eth_getLogs events' })}.`);
  }
  let within = g.sections;
  let scope = '';
  if (topic) {
    const found = findTopic(g, topic);
    if (found.kind === 'none') return notFound(g, topic, found.near);
    if (found.kind === 'many') return many(g, topic, found.sections);
    if (found.kind === 'file') {
      within = sectionsOfFile(g, found.file);
      scope = ` in ${found.file.id}`;
    } else {
      within = [found.section, ...descendants(g, found.section)];
      scope = ` in ${found.section.id}`;
    }
  }
  const hits = rank(g, query, within);
  const shown = untrusted(query, 120);
  if (!hits.length) {
    return lines(
      `No section of the knowledge pack${scope} has any word of the query ${shown}.`,
      'Try other words: the name of a call or an error, a token (tPOT), or a plain word such as "deposit", "nonce", "address" or "gas".',
      `Other sources: explain_error for an error text; search_chain and describe_item for the chain's own modules, calls, events and errors.${scope ? ` ${call({ query })} searches the whole pack.` : ''}`,
    );
  }
  const top = hits.slice(0, MAX_HITS);
  const list = top.flatMap((h, i) => {
    const parent = h.section.parent ? ` (part of ${h.section.parent})` : '';
    return [`${i + 1}. ${h.section.id}: ${titleOf(h.section)}${parent}`, ...excerpt(g, h.section, query).map((l) => `   ${l}`)];
  });
  const head = [
    `Search ${shown} in the Bridge Zero team's knowledge pack for Portaldot V3${scope}: ${hits.length} ${hits.length === 1 ? 'section matches' : 'sections match'}${hits.length > top.length ? `; the best ${top.length}` : ''}, best first.`,
    top[0].all ? null : 'No section holds every word of the query, so these hold some of them.',
  ];
  const best = top[0].section;
  const nextLine = top.length > 1 ? `Next: ${call({ topic: top[1].section.id })} reads another of these in full; any id above works.` : `Next: ${call({ topic: best.id })} reads it again; read_guide with no arguments lists every section.`;
  const used = lines(head, '', list, '', '', nextLine).length + 400;
  const room = ANSWER_LIMIT - used;
  const full = fullText(g, best);
  const own = ownText(g, best);
  let bestPart: string[];
  if (full.length <= room) bestPart = [`The best match in full, ${best.id} (from ${fileOf(g, best).path}):`, '', full];
  else if (own.length <= room && own.length > 200) {
    const kids = childrenOf(g, best).map((c) => c.id);
    bestPart = [`The best match, ${best.id} (from ${fileOf(g, best).path}), without the ${kids.length} sections under it (${kids.map(tokenOf).join(', ')}):`, '', own];
  } else {
    const n = partsOf(g, best).length;
    bestPart = [`The best match, ${best.id}, is too long to show here: ${call({ topic: best.id })} gives it${n > 1 ? ` in ${n} parts` : ''}.`];
  }
  return lines(head, '', list, '', bestPart, '', nextLine);
}
