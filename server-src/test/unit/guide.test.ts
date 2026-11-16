// read_guide and its knowledge pack: the generator (with fixture folders given by argument), finding a
// topic in every common form, long texts in parts, the search, and the answer limit. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDE_FILES, GUIDE_SECTIONS, type GuideFile, type GuideSection } from '../../src/generated/guide.ts';
import { ToolError } from '../../src/lib/errors.ts';
import { ANSWER_LIMIT, GUIDE, PART_CHARS, contents, findTopic, fullText, ownText, partsOf, rank, readTopic, searchGuide, slugToken, splitText, stem, type Guide } from '../../src/lib/guide.ts';
import { runTool } from '../../src/lib/tool.ts';
import readGuide from '../../src/tools/read_guide.ts';

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS = resolve(SERVER_SRC, '..', 'plugins/portaldot-dev/skills');

function gen(...args: string[]): { status: number | null; out: string; stdout: string } {
  const r = spawnSync(process.execPath, ['scripts/gen-knowledge.mjs', ...args], { cwd: SERVER_SRC, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const fences = (text: string): number => text.split('\n').filter((l) => FENCE.test(l)).length;

/** True when every line of the original that holds text comes, in order, in the parts. Closing rules ("---") may go. */
function holdsInOrder(original: string, parts: string[]): boolean {
  const got = parts.join('\n').split('\n');
  let at = 0;
  for (const line of original.split('\n')) {
    if (!line.trim() || /^ {0,3}-{3,}\s*$/.test(line)) continue;
    while (at < got.length && got[at] !== line) at++;
    if (at === got.length) return false;
    at++;
  }
  return true;
}

/** A small knowledge pack made by hand: one section per "## " heading. */
function tiny(files: Record<string, string>): Guide {
  const gf: GuideFile[] = [];
  const gs: GuideSection[] = [];
  for (const [id, text] of Object.entries(files)) {
    gf.push({ id, skill: 'test', path: `test/references/${id}.md`, title: id, summary: `the ${id} file`, text });
    const heads = [...text.matchAll(/^## (.+)$/gm)];
    heads.forEach((m, i) => {
      const start = m.index ?? 0;
      const end = i + 1 < heads.length ? (heads[i + 1].index ?? 0) - 1 : text.length;
      gs.push({ id: `${id}/${slugToken(m[1])}`, file: id, token: slugToken(m[1]), level: 2, title: m[1], start, end, fullEnd: end, parent: null });
    });
  }
  return { files: gf, sections: gs };
}

const thrown = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ToolError, `a ToolError, not ${String(e)}`);
    return e.message;
  }
  assert.fail('no error was thrown');
};

/* ---------- the generator ---------- */

test('the generated guide and prompts are up to date with the knowledge files', () => {
  const r = gen('--check');
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /src\/generated\/guide\.ts is up to date/);
  assert.match(r.stdout, /src\/generated\/prompts\.ts is up to date/);
});

test('the generator reads a skills folder given by argument: files, order, sections and prompts', () => {
  const r = gen('--skills', 'test/unit/fixtures/skills-good', '--json');
  assert.equal(r.status, 0, r.out);
  const { guide, prompts } = JSON.parse(r.stdout) as { guide: { files: GuideFile[]; sections: GuideSection[] }; prompts: Array<{ name: string; skill: string; title: string; description: string; body: string }> };
  // the SKILL.md first, then the files in the order the SKILL.md names them, then the others by name
  assert.deepEqual(guide.files.map((f) => f.id), ['alpha', 'two', 'one', 'three']);
  assert.equal(guide.files.find((f) => f.id === 'two')?.summary, 'what the second file holds.');
  assert.equal(guide.files[0].summary, 'The main notes of the alpha skill: Rules; Where to read more.');
  assert.ok(!guide.files[0].text.startsWith('---'), 'the front matter is not part of the text');
  assert.equal(guide.files.find((f) => f.id === 'three')?.title, 'three', 'a file without a title is named by its file');
  assert.ok(!guide.files.some((f) => f.skill === 'beta'), 'a skill without a references folder is not in the guide');
  assert.deepEqual(guide.sections.map((s) => s.id), [
    'alpha/intro', 'alpha/rules', 'alpha/where-read-more',
    'two/rule-ethereum-transaction',
    'one/intro', 'one/1', 'one/1a', 'one/notes', 'one/notes-2', 'one/E5',
    'three/file-without-title',
  ]);
  const one = guide.files.find((f) => f.id === 'one')?.text ?? '';
  const sec = (id: string): GuideSection => guide.sections.find((s) => s.id === id) as GuideSection;
  assert.equal(sec('one/1a').parent, 'one/1');
  assert.equal(sec('one/E5').parent, 'one/notes-2');
  assert.equal(sec('one/1').title, 'First step', 'the number is the token, not part of the title');
  assert.match(one.slice(sec('one/1').start, sec('one/1').fullEnd), /# a comment in a code block, not a heading[\s\S]*Text of step 1a\.$/);
  assert.match(one.slice(sec('one/1').start, sec('one/1').end), /echo one\n```$/, 'its own text stops before the section under it');
  assert.equal(one.slice(sec('one/notes-2').start, sec('one/notes-2').end), '## Notes\n\nThe second notes.', 'the closing rule and blank lines are not part of a section');

  assert.deepEqual(prompts, [
    { name: 'start_test', skill: 'beta', title: 'Start a test', description: 'A made-up prompt for the tests.', body: '# Begin here\n\nDo this first.' },
    { name: 'second_one', skill: 'gamma', title: 'Second prompt', description: '', body: '# Second prompt\n\nIts text.' },
  ]);
});

test('the generator refuses a broken skills folder and names each fault', () => {
  const r = gen('--skills', 'test/unit/fixtures/skills-bad', '--json');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '', 'nothing is printed as a result');
  assert.match(r.out, /one\/references\/notes\.md, line 5: a code block starts here and is never closed/);
  assert.match(r.out, /two\/references\/notes\.md: another knowledge file has the name "notes"/);
  assert.match(r.out, /one\/SKILL\.md: the prompt name "Start-Project" must be snake_case/);
  assert.match(r.out, /two\/SKILL\.md: the prompt name "same_name" is also used by .*three\/SKILL\.md/);
  const none = gen('--skills');
  assert.equal(none.status, 1);
  assert.match(none.out, /name the folder after --skills/);
});

/* ---------- the generated pack ---------- */

test('every knowledge file is in the guide, and every section is well formed', () => {
  for (const skill of readdirSync(SKILLS)) {
    const refs = join(SKILLS, skill, 'references');
    if (!existsSync(refs) || !statSync(refs).isDirectory()) continue;
    assert.ok(GUIDE_FILES.some((f) => f.id === skill && !f.text.startsWith('---')), `${skill}/SKILL.md, without its front matter`);
    for (const name of readdirSync(refs).filter((n) => n.endsWith('.md'))) assert.ok(GUIDE_FILES.some((f) => f.id === name.slice(0, -3)), name);
  }
  assert.equal(new Set(GUIDE_SECTIONS.map((s) => s.id)).size, GUIDE_SECTIONS.length, 'section ids are unique');
  for (const s of GUIDE_SECTIONS) {
    const f = GUIDE_FILES.find((x) => x.id === s.file);
    assert.ok(f, s.id);
    assert.equal(s.id, `${s.file}/${s.token}`);
    assert.ok(s.start >= 0 && s.start < s.end && s.end <= s.fullEnd && s.fullEnd <= f.text.length, `${s.id}: offsets`);
    if (s.token !== 'intro') assert.match(ownText(GUIDE, s), /^#{1,3} \S/, `${s.id} starts with its heading`);
    // the tokens the generator made are the ones guide.ts makes from a title, so a topic in words finds them
    if (!/^(?:E\d+|\d+[a-z]?|intro)$/.test(s.token)) assert.match(s.token, new RegExp(`^${slugToken(s.title)}(?:-\\d+)?$`), s.id);
    if (s.parent) {
      const p = GUIDE_SECTIONS.find((x) => x.id === s.parent);
      assert.ok(p && p.file === s.file && p.start < s.start && s.fullEnd <= p.fullEnd, `${s.id} lies inside ${s.parent}`);
    }
  }
});

test('tokens and stems', () => {
  assert.equal(slugToken('The two forms'), 'two-forms');
  assert.equal(slugToken("A native account's 0x form has no private key"), 'native-accounts-0x-form');
  assert.equal(slugToken('Tools'), 'tools');
  assert.equal(slugToken('!!!'), 'section');
  assert.deepEqual(['deposits', 'addresses', 'fees', 'queries', 'status', 'gas', 'eth_getlogs', '1010'].map(stem), ['deposit', 'address', 'fee', 'query', 'status', 'gas', 'eth_getlog', '1010']);
});

/* ---------- finding a topic ---------- */

test('a topic in every common form finds its section or file', () => {
  const sections: Array<[string, string]> = [
    ['errors/E12', 'errors/E12'],
    ['E12', 'errors/E12'],
    ['e12', 'errors/E12'],
    ['E 12', 'errors/E12'],
    ['E012', 'errors/E12'],
    ['errors.md#E12', 'errors/E12'],
    ['references/errors.md/E12', 'errors/E12'],
    ['recipe 4', 'recipes-contracts/4'],
    ['recipes/4', 'recipes-contracts/4'],
    ['Recipe 2f', 'recipes-contracts/2f'],
    ['2f', 'recipes-contracts/2f'],
    ['recipes/5a', 'recipes/5a'],
    ['contracts/tools', 'contracts/tools'],
    ['the two forms', 'addresses/two-forms'],
    ['The rule for an Ethereum transaction', 'amounts-and-fees/rule-ethereum-transaction'],
    ['evm-checks section 3', 'evm-checks/3'],
    ['open question 4', 'open-questions/4'],
    ['rules', 'portaldot-v3/rules-prevent-costly-mistakes'],
    ['`errors/E1`', 'errors/E1'],
  ];
  for (const [topic, id] of sections) {
    const f = findTopic(GUIDE, topic);
    assert.equal(f.kind === 'section' ? f.section.id : f.kind, id, topic);
  }
  const files: Array<[string, string]> = [
    ['errors', 'errors'],
    ['references/networks.md', 'networks'],
    ['plugins/portaldot-dev/skills/portaldot-v3/references/networks.md', 'networks'],
    ['SKILL.md', 'portaldot-v3'],
    ['portaldot-v3/SKILL.md', 'portaldot-v3'],
  ];
  for (const [topic, id] of files) {
    const f = findTopic(GUIDE, topic);
    assert.equal(f.kind === 'file' ? f.file.id : f.kind, id, topic);
  }
  const many = findTopic(GUIDE, '4');
  assert.equal(many.kind, 'many');
  if (many.kind === 'many') for (const id of ['recipes-contracts/4', 'evm-checks/4', 'open-questions/4']) assert.ok(many.sections.some((s) => s.id === id), id);
  assert.match(readTopic('4'), /names \d+ sections[\s\S]*- recipes-contracts\/4: [\s\S]*Next: read_guide \{"topic":"/);
});

test('an unknown topic is answered with the nearest ids and the exact next calls', () => {
  const m = thrown(() => readTopic('gas rul'));
  assert.match(m, /^No section of the knowledge pack is called "gas rul"\./);
  assert.match(m, /The nearest ids:\n- [a-z0-9-]+\/\S+: /);
  assert.match(m, /read_guide \{"topic":"[^"]+"\} reads the first of these; read_guide \{"query":"gas rul"\} searches/);
  // a misspelt file still finds the section
  assert.match(thrown(() => readTopic('erors/E12')), /- errors\/E12: /);
  // an entry past the end says where the list ends
  assert.match(thrown(() => readTopic('E999')), /runs from errors\/E1 to errors\/E\d+\./);
  // words that name no file are not taken for a file ("rule 3" is no section)
  assert.match(thrown(() => readTopic('rule 3')), /- portaldot-v3\/rules-prevent-costly-mistakes: /);
});

/* ---------- parts of long texts ---------- */

test('a long text is cut between paragraphs and code blocks, and a long code block is closed and opened again', () => {
  const para = (i: number): string => `Paragraph ${i}. ${'word '.repeat(190).trim()}`;
  const text = Array.from({ length: 10 }, (_, i) => para(i)).join('\n\n');
  const pieces = splitText(text, 3500);
  assert.ok(pieces.length > 1);
  for (const p of pieces) {
    assert.ok(p.length <= 3500, `${p.length}`);
    assert.match(p, /^Paragraph \d+\./, 'a piece starts with a whole paragraph');
  }
  assert.ok(holdsInOrder(text, pieces));

  const code = ['Before the code.', '', '```js', ...Array.from({ length: 800 }, (_, i) => `const line${i} = ${i}; // some code`), '```', '', 'After the code.'].join('\n');
  const cut = splitText(code, 5000);
  assert.ok(cut.length >= 6);
  for (const [i, p] of cut.entries()) {
    assert.ok(p.length <= 5000, `piece ${i}: ${p.length}`);
    assert.equal(fences(p) % 2, 0, `piece ${i} opens and closes its code block`);
  }
  assert.ok(cut.slice(1, -1).every((p) => p.startsWith('```js\n')), 'each later piece opens the code block again');
  assert.ok(holdsInOrder(code, cut));

  const long = `${'x'.repeat(12_000)}`;
  assert.deepEqual(splitText(long, 5000).map((p) => p.length), [5000, 5000, 2000]);
  // nothing fits in a small first piece: it comes back empty, and the text starts in the next
  assert.equal(splitText(text, 3500, 100)[0], '');
});

test('every file and every long section comes in parts within the limit, which together hold the whole text', () => {
  const targets: Array<GuideFile | GuideSection> = [...GUIDE_FILES, ...GUIDE_SECTIONS.filter((s) => fullText(GUIDE, s).length > PART_CHARS)];
  assert.ok(targets.length > GUIDE_FILES.length, 'some sections are longer than a part');
  for (const t of targets) {
    const parts = partsOf(GUIDE, t);
    const whole = 'summary' in t ? t.text : fullText(GUIDE, t);
    for (const [i, p] of parts.entries()) {
      assert.ok(p.text.length <= PART_CHARS, `${t.id} part ${i + 1}: ${p.text.length}`);
      assert.equal(fences(p.text) % 2, 0, `${t.id} part ${i + 1} closes every code block it opens`);
    }
    assert.ok(holdsInOrder(whole, parts.map((p) => p.text)), `${t.id}: the parts hold the whole text in order`);
    const n = parts.length;
    for (let k = 1; k <= n; k++) {
      const answer = readTopic(t.id, k);
      assert.ok(answer.length <= ANSWER_LIMIT, `${t.id} part ${k}: ${answer.length}`);
      if (k < n) assert.ok(answer.includes(`Next part: read_guide {"topic":"${t.id}","part":${k + 1}}`), `${t.id} part ${k} gives the next call`);
      if (n > 1) assert.match(answer, new RegExp(`Part ${k} of ${n}: `));
    }
    if (n > 1) assert.match(readTopic(t.id, n), /This was the last part\./);
    assert.match(thrown(() => readTopic(t.id, n + 1)), n === 1 ? /has only one part, so leave "part" out/ : new RegExp(`has ${n} parts, so "part" goes from 1 to ${n}`));
  }
});

test('a short section comes whole, with where it is from and the next section', () => {
  const a = readTopic('E12');
  assert.match(a, /^errors\/E12: E12\. .+\.\nFrom portaldot-v3\/references\/errors\.md \("/);
  assert.match(a, /\(The topic "E12" was read as errors\/E12\.\)/);
  assert.ok(a.includes(ownText(GUIDE, GUIDE_SECTIONS.find((s) => s.id === 'errors/E12') as GuideSection)));
  assert.match(a, /read_guide \{"topic":"errors\/E13"\} reads the next section/);
  assert.doesNotMatch(a, /Part \d+ of/);
});

/* ---------- the contents and the search ---------- */

test('the table of contents fits the answer limit and names every file and section', () => {
  const c = contents();
  assert.ok(c.length <= ANSWER_LIMIT, `${c.length}`);
  for (const f of GUIDE_FILES) assert.ok(c.includes(`\n${f.id}: `), f.id);
  for (const s of GUIDE_SECTIONS.filter((x) => x.token !== 'intro')) assert.ok(c.includes(`  ${s.token}  `), s.id);
  assert.match(c, /read_guide \{"topic":"errors\/E12"\}/);
});

test('search: the title weighs more than the text, an exact phrase more than the same words apart, and ties keep file order', () => {
  const g = tiny({
    a: ['## Other notes', 'deposit deposit deposit', '## Deposit rules', 'nothing else', '## Words apart', 'limit of storage and a deposit', '## Phrase', 'the storage deposit limit'].join('\n'),
    b: ['## Same text', 'a nonce', '## Same text again', 'a nonce'].join('\n'),
  });
  assert.equal(rank(g, 'deposit')[0].section.id, 'a/deposit-rules');
  const two = rank(g, 'storage deposit').map((h) => h.section.id);
  assert.ok(two.indexOf('a/phrase') < two.indexOf('a/words-apart'), two.join(', '));
  assert.deepEqual(rank(g, 'nonce').map((h) => h.section.id), ['b/same-text', 'b/same-text-again']);
  assert.deepEqual(rank(g, 'deposit'), rank(g, 'deposit'), 'the same query gives the same answer');
  assert.deepEqual(rank(g, 'the how'), [], 'common words alone match nothing');
});

test('search finds the right section of the real pack first', () => {
  const first = (q: string): string => rank(GUIDE, q)[0]?.section.id ?? '';
  assert.equal(first('eth_getLogs missing events'), 'errors/E6');
  assert.equal(first('State already discarded'), 'errors/E5');
  assert.equal(first('faucet test tokens'), 'networks/test-tokens');
  assert.ok(rank(GUIDE, 'nonce').length > 3);
});

test('a search answer lists at most 8 sections with two lines each, shows the best in full when it fits, and stays within the limit', () => {
  for (const q of ['storage deposit deploy', 'eth_getLogs missing events', 'nonce', 'Solidity on the testnet with Foundry and cast', 'address', 'gas']) {
    const a = searchGuide(q);
    assert.ok(a.length <= ANSWER_LIMIT, `${q}: ${a.length}`);
    const listed = a.match(/^\d+\. [a-z0-9-]+\/\S+: /gm) ?? [];
    assert.ok(listed.length >= 1 && listed.length <= 8, `${q}: ${listed.length}`);
    assert.match(a, /\nNext: read_guide \{"topic":"/);
  }
  assert.match(searchGuide('faucet test tokens'), /The best match in full, networks\/test-tokens \(from [^)]+\):\n\n## Test tokens\n/);
  // a best match longer than the room left is shown without the sections under it, or named with the call that reads it
  assert.match(searchGuide('Solidity on the testnet with Foundry and cast'), /without the \d+ sections under it|is too long to show here: read_guide \{"topic":"/);
  // a search inside one file
  const scoped = searchGuide('nonce', 'errors');
  assert.ok((scoped.match(/^\d+\. (\S+): /gm) ?? []).every((l) => l.includes(' errors/')), scoped.slice(0, 400));
  assert.match(scoped, /in errors: /);
  assert.match(thrown(() => searchGuide('the how')), /has no word to search for/);
  assert.match(searchGuide('zzqqxx'), /No section of the knowledge pack has any word of the query "zzqqxx"/);
});

/* ---------- the tool ---------- */

test('read_guide: no arguments, a topic, a query, and the mistakes in between', async () => {
  const toc = await runTool(readGuide, {});
  assert.equal(toc.isError, false);
  assert.match(toc.text, /^The Bridge Zero team's knowledge pack for Portaldot V3: \d+ files, \d+ sections\./);
  const topic = await runTool(readGuide, { topic: 'recipe 4' });
  assert.equal(topic.isError, false);
  assert.match(topic.text, /^recipes-contracts\/4: /);
  const both = await runTool(readGuide, { topic: 'errors', query: 'nonce' });
  assert.match(both.text, /in errors: /);
  const partAlone = await runTool(readGuide, { part: 2 });
  assert.equal(partAlone.isError, true);
  assert.match(partAlone.text, /"part" needs a "topic"/);
  const partSearch = await runTool(readGuide, { query: 'nonce', part: 2 });
  assert.equal(partSearch.isError, true);
  const unknown = await runTool(readGuide, { topic: 'no such thing at all' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /No section of the knowledge pack is called/);
  const empty = await runTool(readGuide, { topic: '   ' });
  assert.equal(empty.isError, true);
  assert.match(empty.text, /^Invalid input for read_guide: topic/);
});

test("read_guide's description says what it returns, when to use it instead of the other tools, and gives an example", () => {
  const d = readGuide.description;
  assert.ok(d.length >= 120 && d.length <= 2000, `${d.length}`);
  for (const word of ['explain_error', 'describe_item', 'search_chain', '"query"', '"topic"', 'Example: {"query": ']) assert.ok(d.includes(word), word);
  assert.match(d, /^[\x20-\x7e]+$/, 'plain ASCII');
  assert.equal(readGuide.readsChain, false);
  for (const [k, v] of Object.entries(readGuide.input)) assert.ok((v as { description?: string }).description, k);
});
