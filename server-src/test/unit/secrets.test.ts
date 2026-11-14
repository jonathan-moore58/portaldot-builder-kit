// The one check for secret recovery phrases in any argument. No network. The phrases are the public
// BIP-39 test vectors and phrases generated on the spot: none belongs to anyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicGenerate } from '@polkadot/util-crypto';
import { ToolError } from '../../src/lib/errors.ts';
import { holdsRecoveryPhrase, isRecoveryPhrase, phraseWords, refuseSecretsIn } from '../../src/lib/secrets.ts';

const P12 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const P24 = `${'abandon '.repeat(23)}art`;
const refused = (v: unknown): boolean => {
  try {
    refuseSecretsIn(v);
    return false;
  } catch (e) {
    assert.ok(e instanceof ToolError);
    return true;
  }
};

const VARIANTS: Record<string, (p: string) => string> = {
  'as is': (p) => p,
  'upper case': (p) => p.toUpperCase(),
  'title case': (p) => p.replace(/\b[a-z]/g, (c) => c.toUpperCase()),
  'first word capitalised, full stop': (p) => `${p[0].toUpperCase()}${p.slice(1)}.`,
  'commas': (p) => p.split(' ').join(', '),
  'commas, no space': (p) => p.split(' ').join(','),
  'semicolons': (p) => p.split(' ').join(';'),
  'colons': (p) => p.split(' ').join(':'),
  'pipes': (p) => p.split(' ').join(' | '),
  'slashes': (p) => p.split(' ').join('/'),
  'one word per line': (p) => p.split(' ').join('\n'),
  'numbered "1. word", one per line': (p) => p.split(' ').map((w, i) => `${i + 1}. ${w}`).join('\n'),
  'numbered "1.word" inline': (p) => p.split(' ').map((w, i) => `${i + 1}.${w}`).join(' '),
  'numbered "1) word"': (p) => p.split(' ').map((w, i) => `${i + 1}) ${w}`).join(' '),
  'quoted in a sentence, in capitals': (p) => `my phrase is "${p.toUpperCase()}", is it right?`,
};

test('a phrase is refused in capitals, with punctuation between the words, and as a numbered list', () => {
  const phrases = [P12, P24, mnemonicGenerate(12), mnemonicGenerate(15), mnemonicGenerate(18), mnemonicGenerate(21), mnemonicGenerate(24)];
  for (const [name, f] of Object.entries(VARIANTS)) {
    for (const p of phrases) assert.equal(refused({ remark: f(p) }), true, `${name}: ${f(p).slice(0, 60)}`);
  }
  // nested inside the arguments too
  assert.equal(refused({ args: [{ inner: [P12.toUpperCase()] }] }), true);
});

test('phraseWords: lower case, list numbers and a full stop dropped, split on spaces and , ; : | /', () => {
  assert.deepEqual(phraseWords('1. Legal\n2) WINNER, thank;year:wave|sausage/worth useful.'), ['legal', 'winner', 'thank', 'year', 'wave', 'sausage', 'worth', 'useful']);
  assert.deepEqual(phraseWords('  '), []);
});

test('what is not a phrase is not refused: a wrong checksum, the wrong count, a word off the list, or list words inside a longer sentence', () => {
  assert.equal(isRecoveryPhrase(P12.replace(/yellow$/, 'winner')), false, 'checksum');
  assert.equal(isRecoveryPhrase(P12.split(' ').slice(0, 11).join(' ')), false, 'eleven words');
  assert.equal(isRecoveryPhrase(`${P12} extra`), false, 'thirteen words');
  assert.equal(isRecoveryPhrase(P12.replace('legal', 'legally')), false, 'not a list word');
  assert.equal(holdsRecoveryPhrase(`please check this: ${P12} and tell me`), false, 'inside a longer sentence');
  assert.equal(refused({ remark: 'native call from a 0x account, test 1' }), false);
});

// Ordinary sentences of 12 to 24 words, from common English words of which more than half are on
// the BIP-39 list, with capitals, commas and a full stop. A fixed seed keeps the run the same.
const COMMON = (
  'the of and to a in is it you that he was for on are with as his they be at one have this from or had by word but what some we can out ' +
  'other were all there when up use your how said an each she which do their time if will way about many then them write would like so these ' +
  'her long make thing see him two has look more day could go come did number sound no most people my over know water than call first who may ' +
  'down side been now find any new work part take get place made live where after back little only round man year came show every good me give ' +
  'our under name very through just form sentence great think say help low line differ turn cause much mean before move right boy old too same ' +
  'tell does set three want air well also play small end put home read hand port large spell add even land here must big high such follow act ' +
  'why ask men change went light kind off need house picture try us again animal point mother world near build self earth father head stand own ' +
  'page should country found answer school grow study still learn plant cover food sun four between state keep eye never last let thought city'
).split(' ');

function sentences(count: number, seed: number): string[] {
  let s = seed;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => {
    const n = 12 + Math.floor(rand() * 13);
    const words = Array.from({ length: n }, (_, i) => `${COMMON[Math.floor(rand() * COMMON.length)]}${i < n - 1 && rand() < 0.15 ? ',' : ''}`);
    words[0] = `${words[0][0].toUpperCase()}${words[0].slice(1)}`;
    return `${words.join(' ')}.`;
  });
}

test('2000 ordinary English sentences of 12 to 24 words are not refused', () => {
  const list = sentences(2000, 20261114);
  const wrongly = list.filter((s) => refused({ remark: s }));
  assert.equal(wrongly.length, 0, wrongly.slice(0, 3).join(' | '));
});

test('a phrase is refused however deep it sits, as a value or as a key, and with one word per line', () => {
  const nest = (depth: number, leaf: unknown): unknown => {
    let v = leaf;
    for (let i = 0; i < depth; i++) v = { k: v };
    return v;
  };
  const perLine = P12.split(' ').join('\n');
  const deep: unknown[] = [nest(12, P12), nest(9, perLine), nest(9, [[[P12]]]), nest(8, { [P12]: 1 }), { error: nest(7, `my words are:\n${P12}\nthanks`) }];
  for (const args of deep) assert.ok(refused(args), JSON.stringify(args).slice(0, 90));
  assert.equal(refused(nest(40, 'an ordinary error text, long enough to be looked at, with no phrase in it')), false);
});

test('a phrase written one word per line is refused among other lines, and a list of ordinary words is not', () => {
  const perLine = P12.split(' ').join('\n');
  const numbered = P12.split(' ').map((w, i) => `${i + 1}. ${w}`).join('\n');
  const texts = [`My recovery phrase:\n${perLine}\nThanks`, `seed\n${perLine}`, `Backup (do not share):\n\n${numbered}\n\nstored on paper`, `${perLine.replace(/\n/g, '\n\n')}\nend of list`];
  for (const text of texts) {
    assert.ok(holdsRecoveryPhrase(text), text.slice(0, 30));
    assert.ok(refused({ remark: text }), text.slice(0, 30));
  }
  // lines of one word each that are not a phrase: words off the list, and list words with a wrong checksum
  assert.equal(holdsRecoveryPhrase('Shopping:\napples\nbread\nbutter\ncheese\ncoffee\neggs\nflour\nhoney\nlemons\nmilk\nonions\npasta\nrice\nthanks'), false);
  const wrong = P12.replace(/yellow$/, 'winner').split(' ').join('\n');
  assert.equal(holdsRecoveryPhrase(`My words:\n${wrong}\nThanks`), false);
  // a very long list costs a bounded number of checks
  const started = Date.now();
  assert.equal(holdsRecoveryPhrase(Array.from({ length: 2800 }, () => 'winner').join('\n')), false);
  assert.ok(Date.now() - started < 5000);
});
