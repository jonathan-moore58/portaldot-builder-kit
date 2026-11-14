// Our own words about the chain, checked for consistency. No network. test/live/core-tools.test.ts
// checks the same names against the live chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLOSSARY, GROUP_OF, GROUPS, JOBS, MODULE_NOTES, PLAIN_NOTES, SYNONYMS, withToken } from '../../src/lib/knowledge.ts';

test("every job's module is a member of a group", () => {
  const missing = JOBS.filter((j) => !GROUP_OF.has(j.module)).map((j) => `${j.id}: ${j.module}`);
  assert.deepEqual(missing, []);
});

test('GROUPS has no duplicate members and no duplicate ids', () => {
  const seen = new Map<string, string>();
  const dups: string[] = [];
  for (const g of GROUPS) {
    for (const m of g.members) {
      if (seen.has(m)) dups.push(`${m} in ${seen.get(m)} and ${g.id}`);
      seen.set(m, g.id);
    }
  }
  assert.deepEqual(dups, []);
  assert.equal(new Set(GROUPS.map((g) => g.id)).size, GROUPS.length);
  assert.equal(GROUP_OF.size, seen.size);
});

test('every PLAIN_NOTES key is "Module.item"', () => {
  const bad = Object.keys(PLAIN_NOTES).filter((k) => !/^[A-Z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(k));
  assert.deepEqual(bad, []);
  const noGroup = Object.keys(PLAIN_NOTES).filter((k) => !GROUP_OF.has(k.split('.')[0]));
  assert.deepEqual(noGroup, []);
});

test('every module with a note is in a group, and every group member has a note', () => {
  assert.deepEqual(Object.keys(MODULE_NOTES).filter((m) => !GROUP_OF.has(m)), []);
  assert.deepEqual([...GROUP_OF.keys()].filter((m) => !(m in MODULE_NOTES)), []);
});

test('jobs are well formed', () => {
  assert.equal(new Set(JOBS.map((j) => j.id)).size, JOBS.length, 'job ids are unique');
  for (const j of JOBS) {
    assert.match(j.words, /^[a-z0-9]+( [a-z0-9]+)*$/, `${j.id}: words are lower-case, single spaces`);
    assert.ok(['call', 'storage', 'event', 'error', 'constant'].includes(j.kind), j.id);
    assert.ok(j.text.length > 0 && !j.text.endsWith('.'), j.id);
  }
  // each job that is a call has a plain note, so describe_item can explain it
  const unexplained = JOBS.filter((j) => j.kind === 'call' && !PLAIN_NOTES[`${j.module}.${j.item}`]).map((j) => `${j.module}.${j.item}`);
  assert.deepEqual(unexplained, []);
});

test('synonyms are lower case words, so they can match the lower-cased query', () => {
  for (const [w, alts] of Object.entries(SYNONYMS)) {
    assert.match(w, /^[a-z0-9]+$/, w);
    assert.ok(alts.length > 0, w);
    for (const a of alts) assert.match(a, /^[a-z0-9]+$/, `${w} -> ${a}`);
  }
});

test('the texts are plain ASCII, and POT is swapped for the network symbol', () => {
  const all = [...Object.values(MODULE_NOTES), ...Object.values(PLAIN_NOTES), ...JOBS.map((j) => j.text), ...GLOSSARY.flatMap((g) => [g.term, g.meaning]), ...GROUPS.flatMap((g) => [g.name, g.sub])];
  const nonAscii = all.filter((t) => /[^\x20-\x7e]/.test(t));
  assert.deepEqual(nonAscii, []);
  assert.equal(withToken('Send POT, not POTS or SPOT.', 'tPOT'), 'Send tPOT, not POTS or SPOT.');
  assert.equal(withToken(MODULE_NOTES.Balances, 'tPOT'), "The chain's own token, tPOT: every balance, and the calls that send it.");
});

