// What native calls answered to common mistakes (references/native-call-errors.md), the file generated
// from it, and measuredFor. No network: the names are checked against the metadata saved with the tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { MEASURED_MISTAKES } from '../../src/generated/mistakes.ts';
import { SAVED_METADATA } from '../../src/generated/metadata.ts';
import { measuredFor, parseReply } from '../../src/lib/mistakes.ts';

type Loose = any;

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = resolve(SERVER_SRC, '..', 'plugins/portaldot-dev/skills/portaldot-v3/references/native-call-errors.md');

/** Runs the generator with a native-call-errors.md on stdin, and returns its exit code and messages. */
function genWith(markdown: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ['scripts/gen-knowledge.mjs', '--stdin-mistakes'], { cwd: SERVER_SRC, input: markdown, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const HEADER = '| Call | Mistake | Reply | What to do |\n|---|---|---|---|';
/** A small file: a title, then a module section whose table starts on line 5, so its first row is line 7. */
const FILE = (rows: string, heading = '## Balances'): string => `# Title\n\n${heading}\n\n${HEADER}\n${rows}\n`;
const ROW = '| `Balances.burn` | More than the balance | Token(FundsUnavailable) | Burn no more than the free balance. |';

test('the generated file is up to date with native-call-errors.md', () => {
  const r = spawnSync(process.execPath, ['scripts/gen-knowledge.mjs', '--check'], { cwd: SERVER_SRC, encoding: 'utf8' });
  // errors.ts is checked in the same run; this test looks at mistakes.ts only
  assert.match(r.stdout, /src\/generated\/mistakes\.ts is up to date/, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stderr, /mistakes\.ts|native-call-errors\.md/, r.stderr);
  // a second way: the table rows of the file against the items, in order
  const md = readFileSync(SOURCE, 'utf8');
  assert.ok(md.startsWith('# Native calls: what they answer to common mistakes'));
  const rows = md.split(/\r?\n/).filter((l) => /^\| `[A-Z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*` \|/.test(l));
  assert.equal(MEASURED_MISTAKES.length, rows.length);
  rows.forEach((l, i) => assert.ok(l.startsWith(`| \`${MEASURED_MISTAKES[i].call}\` | ${MEASURED_MISTAKES[i].mistake} | ${MEASURED_MISTAKES[i].reply} |`), `row ${i + 1}: ${l}`));
});

test('the generator refuses a malformed table and names the line', () => {
  const good = genWith(FILE(ROW));
  assert.equal(good.status, 0, good.out);
  assert.match(good.out, /valid: 1 rows in 1 module sections/);

  const cases: Array<[string, RegExp]> = [
    [FILE('| `Balances.burn` | More than the balance | Token(FundsUnavailable) |'), /line 7: a table row must have 4 cells/],
    [FILE(`${ROW}\n| \`Balances.burn\` | A | B | C. | D. |`), /line 8: a table row must have 4 cells/],
    [`# Title\n\n## Balances\n\n| Call | Mistake | Answer | What to do |\n|---|---|---|---|\n${ROW}\n`, /line 5: the table header must be exactly/],
    [`# Title\n\n## Balances\n\n| Call | Mistake | Reply | What to do |\n| a | b | c | d |\n${ROW}\n`, /line 6: the line after the table header/],
    [FILE('| `Balances.burn` | More than the balance | `Token(FundsUnavailable)` | Burn less. |'), /line 7: the Reply cell must be/],
    [FILE('| `Balances.burn` | More than the balance | Assets.NoAccount | Burn less. |'), /line 7: the Reply cell must be/],
    [FILE('| `Balances.burn` | More than the balance | Token(FundsUnavailable): the balance is low | Burn less. |'), /line 7: the Reply cell must be/],
    [FILE('| Balances.burn | More than the balance | Token(FundsUnavailable) | Burn less. |'), /line 7: the Call cell must be one call in backticks/],
    [FILE('| `Assets.transfer` | More than the balance | Assets.BalanceLow (39/0) | Send less. |'), /line 7: the call Assets\.transfer is not of the module "Balances"/],
    [FILE('| `Balances.burn` | More than the balance | Token(FundsUnavailable) | Burn less |'), /line 7: the "What to do" cell must be one sentence that ends with a full stop/],
    [FILE('| `Balances.burn` | More than the balance | Token(FundsUnavailable) | Burn less. Then wait. |'), /line 7: the "What to do" cell must be one sentence, found more/],
    [FILE('| `Balances.burn` |  | Token(FundsUnavailable) | Burn less. |'), /line 7: empty cell: Mistake/],
    [FILE(`${ROW}\n${ROW}`), /line 8: the same call and mistake as on line 7/],
    [FILE(ROW, '## How this was measured'), /line 5: a table outside a module section/],
    [`# Title\n\n## Balances\n\nNo table here.\n`, /line 3: the module section "## Balances" has no table/],
    ['# Title\n\nNothing here yet.\n', /no module sections/],
  ];
  for (const [markdown, want] of cases) {
    const r = genWith(markdown);
    assert.equal(r.status, 1, `${want}: ${r.out}`);
    assert.match(r.out, want);
  }
});

test('every Reply cell has one of the allowed forms', () => {
  const forms = [/^accepted$/, /^[A-Z][A-Za-z0-9]*\.[A-Z][A-Za-z0-9]* \(\d+\/\d+\)$/, /^[A-Z][A-Za-z0-9]*\([A-Z][A-Za-z0-9]*\)$/, /^[A-Z][A-Za-z0-9]*$/];
  for (const m of MEASURED_MISTAKES) {
    assert.ok(forms.some((re) => re.test(m.reply)), `${m.call}: ${JSON.stringify(m.reply)}`);
    assert.ok(parseReply(m.reply), `${m.call}: parseReply refuses ${JSON.stringify(m.reply)}`);
    assert.match(m.call, /^[A-Z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/);
    assert.ok(m.mistake.length > 3 && m.fix.endsWith('.'), m.call);
    assert.match(`${m.call} ${m.mistake} ${m.reply} ${m.fix}`, /^[\x20-\x7e]*$/, `${m.call}: ASCII only`);
  }
  assert.ok(MEASURED_MISTAKES.some((m) => m.reply === 'accepted'));
});

/** The saved testnet metadata: each module's index, calls and errors, and the dispatch error's kinds. */
function savedNames(): { modules: Map<string, { index: number; calls: Set<string>; errors: Map<string, number> }>; words: Set<string>; kinds: Map<string, Set<string>>; specVersion: number } {
  const saved = SAVED_METADATA.testnet;
  const registry = new TypeRegistry();
  const metadata = new Metadata(registry, `0x${gunzipSync(Buffer.from(saved.gzipBase64, 'base64')).toString('hex')}` as `0x${string}`);
  registry.setMetadata(metadata, undefined, { AuthorizeCall: { extrinsic: {}, payload: {} }, EthSetOrigin: { extrinsic: {}, payload: {} } }, true);
  const variants = (typeId: Loose): Loose[] => (registry.lookup.getSiType(typeId) as Loose).def.asVariant.variants as Loose[];
  const flat = (s: string): string => s.replace(/_/g, '').toLowerCase();
  const modules = new Map<string, { index: number; calls: Set<string>; errors: Map<string, number> }>();
  for (const p of metadata.asLatest.pallets as Loose[]) {
    modules.set(p.name.toString(), {
      index: p.index.toNumber(),
      calls: new Set(p.calls.isSome ? variants(p.calls.unwrap().type).map((v) => flat(v.name.toString())) : []),
      errors: new Map(p.errors.isSome ? variants(p.errors.unwrap().type).map((v) => [v.name.toString(), v.index.toNumber()] as [string, number]) : []),
    });
  }
  // sp_runtime::DispatchError: its variants of one word, and the kinds that carry a reason (Token, Arithmetic, ...)
  const words = new Set<string>();
  const kinds = new Map<string, Set<string>>();
  const dispatch = (metadata.asLatest.lookup.types as Loose[]).find((t) => t.type.path.map((x: Loose) => x.toString()).join('::') === 'sp_runtime::DispatchError');
  assert.ok(dispatch, 'the saved metadata has sp_runtime::DispatchError');
  for (const v of dispatch.type.def.asVariant.variants as Loose[]) {
    if (v.fields.length === 0) words.add(v.name.toString());
    else if (v.fields.length === 1) {
      const inner = registry.lookup.getSiType(v.fields[0].type) as Loose;
      if (inner.def.isVariant) kinds.set(v.name.toString(), new Set((inner.def.asVariant.variants as Loose[]).map((x) => x.name.toString())));
    }
  }
  return { modules, words, kinds, specVersion: saved.specVersion };
}

test('every error and call in the tables exists in the saved metadata, with exactly those indices', () => {
  const { modules, words, kinds, specVersion } = savedNames();
  assert.ok(kinds.get('Token')?.has('BelowMinimum') && words.has('BadOrigin'), 'the dispatch error was read');
  const flat = (s: string): string => s.replace(/_/g, '').toLowerCase();
  let moduleErrors = 0;
  for (const m of MEASURED_MISTAKES) {
    const [mod, call] = m.call.split('.');
    assert.ok(modules.get(mod)?.calls.has(flat(call)), `${m.call}: no such call in runtime ${specVersion}`);
    const r = parseReply(m.reply);
    assert.ok(r, m.reply);
    if (r.kind === 'module') {
      const info = modules.get(r.module);
      assert.ok(info, `${m.reply} (${m.call}): no module ${r.module} in runtime ${specVersion}`);
      assert.equal(info.index, r.moduleIndex, `${m.reply} (${m.call}): ${r.module} has index ${info.index}`);
      assert.ok(info.errors.has(r.name), `${m.reply} (${m.call}): ${r.module} has no error ${r.name}`);
      assert.equal(info.errors.get(r.name), r.errorIndex, `${m.reply} (${m.call}): ${r.module}.${r.name} is error ${info.errors.get(r.name)}`);
      moduleErrors++;
    } else if (r.kind === 'variant') {
      assert.ok(kinds.get(r.module)?.has(r.name), `${m.reply} (${m.call}): the dispatch error has no ${r.module}(${r.name})`);
    } else if (r.kind === 'word') {
      assert.ok(words.has(r.name), `${m.reply} (${m.call}): the dispatch error has no variant ${r.name}`);
    }
  }
  assert.ok(moduleErrors > 50, `only ${moduleErrors} module errors were checked`);
});

test('measuredFor finds the measured cases by the exact error, in any letter case', () => {
  const calls = (module: string, name: string): string[] => measuredFor(module, name).map((m) => m.call);

  const noAccount = measuredFor('Assets', 'NoAccount');
  assert.deepEqual(noAccount.map((m) => m.call), ['Assets.transfer']);
  assert.ok(noAccount.every((m) => m.reply === 'Assets.NoAccount (39/1)' && m.fix.length > 10));

  const below = measuredFor('token', 'belowminimum');
  assert.ok(below.length >= 3 && below.every((m) => m.reply === 'Token(BelowMinimum)'));
  assert.ok(below.some((m) => m.call === 'Assets.mint') && below.some((m) => m.call === 'Balances.transferKeepAlive'));

  assert.ok(calls('Nfts', 'NoConfig').includes('Nfts.mint'));
  assert.ok(calls('NFTS', 'noconfig').includes('Nfts.mint'));
  assert.ok(calls('AssetConversion', 'PoolEmpty').includes('AssetConversion.swapExactTokensForTokens'));

  // a dispatch error of one word, in the forms explain_error and others use
  const badOrigin = calls('DispatchError', 'BadOrigin');
  assert.ok(badOrigin.includes('Balances.forceTransfer') && badOrigin.includes('Utility.batchAll'));
  assert.deepEqual(calls('', 'badorigin'), badOrigin);
  assert.deepEqual(calls('BadOrigin', ''), badOrigin);

  // nothing for an error that is not measured, or not exactly this one
  assert.deepEqual(measuredFor('Assets', 'NoAccountX'), []);
  assert.deepEqual(measuredFor('Assets', 'NoAccoun'), []);
  assert.deepEqual(measuredFor('Nfts', 'Unknown'), [], 'Assets.Unknown is not an Nfts error');
  assert.deepEqual(measuredFor('AssetConversion', 'BelowMinimum'), [], 'an AssetConversion error of the same name as Token(BelowMinimum)');
  assert.deepEqual(measuredFor('Token', 'NoAccount'), []);
  assert.deepEqual(measuredFor('Assets', 'BadOrigin'), []);
  assert.deepEqual(measuredFor('', ''), []);

  // rows the chain accepted are never returned
  assert.deepEqual(measuredFor('accepted', ''), []);
  assert.deepEqual(measuredFor('', 'accepted'), []);
  for (const m of MEASURED_MISTAKES) {
    const r = parseReply(m.reply);
    if (!r || r.kind === 'accepted') continue;
    const found = r.kind === 'word' ? measuredFor('DispatchError', r.name) : measuredFor(r.module, r.name);
    assert.ok(found.length > 0 && found.every((f) => f.reply === m.reply), m.reply);
  }

  // the answer is a copy: changing it leaves the list as it was
  measuredFor('Assets', 'NoAccount')[0].fix = 'changed';
  assert.notEqual(measuredFor('Assets', 'NoAccount')[0].fix, 'changed');
});
