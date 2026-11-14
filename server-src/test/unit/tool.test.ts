// runTool: every way a handler can fail becomes text the model can act on, long output is cut,
// and connection warnings are put in front. No network: the tools here are made up for the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { callContext } from '../../src/lib/chain.ts';
import { EthRpcError, failureText, ToolError } from '../../src/lib/errors.ts';
import { defineTool, MAX_DIGITS, MAX_HEX, MAX_TEXT, networkField, runTool } from '../../src/lib/tool.ts';

const make = (handler: (args: { text?: string; n?: number }) => Promise<string>) =>
  defineTool({
    name: 'test_tool',
    title: 'test',
    description: 'test',
    input: { text: z.string().min(2).optional().describe('text'), n: z.number().int().min(1).max(5).optional().describe('n'), network: networkField },
    readsChain: false,
    handler,
  });

test('a normal answer comes back as it is', async () => {
  const r = await runTool(make(async () => 'hello'), {});
  assert.deepEqual(r, { text: 'hello', isError: false });
});

test('a ToolError becomes isError text with its message only', async () => {
  const r = await runTool(make(async () => { throw new ToolError('Say what to do next.'); }), {});
  assert.deepEqual(r, { text: 'Say what to do next.', isError: true });
});

test('a zod error names each field and what was wrong with it', async () => {
  const tool = make(async () => 'not reached');
  const r1 = await runTool(tool, { text: 'x', n: 9 });
  assert.equal(r1.isError, true);
  assert.match(r1.text, /^Invalid input for test_tool: /);
  assert.match(r1.text, /text: /);
  assert.match(r1.text, /n: /);
  const r2 = await runTool(tool, { network: 'devnet' });
  assert.match(r2.text, /network: /);
  const r3 = await runTool(tool, null);
  assert.equal(r3.isError, false, 'no arguments at all is the same as {}');
});

test('an unknown exception becomes "<tool> failed: <message>", without a stack trace', async () => {
  const r = await runTool(make(async () => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); }), {});
  assert.equal(r.isError, true);
  assert.equal(r.text, "test_tool failed: Cannot read properties of undefined (reading 'x')");
  assert.doesNotMatch(r.text, /\n\s+at /);
  const r2 = await runTool(make(async () => { throw 'a plain string'; }), {});
  assert.equal(r2.text, 'test_tool failed: a plain string');
});

test('a lost connection is explained as the node not answering', async () => {
  for (const msg of ['No response received from RPC endpoint in 30s', 'WebSocket is not connected', 'disconnected from wss://x: 1006:: Abnormal Closure']) {
    const r = await runTool(make(async () => { throw new Error(msg); }), {});
    assert.match(r.text, /^The node did not answer/, msg);
    assert.match(r.text, /get_chain_facts/);
  }
});

test('an Ethereum RPC error answer keeps its method, code, message and data', () => {
  const t = failureText('x', new EthRpcError('eth_call', 3, 'execution reverted', '0x08c379a0'));
  // the node's message and data are shown as quoted strings: they may carry text from a contract
  assert.equal(t, 'The Ethereum RPC refused eth_call with code 3: "execution reverted". Data: "0x08c379a0". Paste this text into explain_error for the likely cause.');
  const t2 = failureText('x', new EthRpcError('eth_estimateGas', -32000, 'insufficient funds', { a: 1 }));
  assert.match(t2, /Data: \{"a":1\}\./);
  const t3 = failureText('x', new EthRpcError('eth_chainId', -32601, 'Method not found'));
  assert.doesNotMatch(t3, /Data:/);
});

test('very long output is cut, with a note that says how long it was', async () => {
  const r = await runTool(make(async () => 'x'.repeat(50_000)), {});
  assert.equal(r.isError, false);
  assert.match(r.text, /\(cut: the answer was 50000 characters long\. Ask for less at once\.\)$/);
  assert.ok(r.text.length < 50_000);
  const ok = await runTool(make(async () => 'y'.repeat(10_000)), {});
  assert.equal(ok.text.length, 10_000, 'an answer of normal length is not touched');
});

test('no answer is longer than 20000 characters', async () => {
  const r = await runTool(make(async () => 'x'.repeat(50_000)), {});
  assert.ok(r.text.length <= 20_000, `got ${r.text.length}`);
});

test('connection warnings are put in front of the answer, once each', async () => {
  const tool = make(async () => {
    const store = callContext.getStore();
    assert.ok(store, 'runTool gives the handler a call context');
    store.warnings.add('WARNING: one');
    store.warnings.add('WARNING: two');
    store.warnings.add('WARNING: one');
    return 'body';
  });
  const r = await runTool(tool, {});
  assert.equal(r.text, 'WARNING: one\nWARNING: two\n\nbody');
  // the context belongs to one call only
  const r2 = await runTool(make(async () => 'clean'), {});
  assert.equal(r2.text, 'clean');
});

test('connection warnings are kept when the tool then fails', async () => {
  const r = await runTool(make(async () => {
    callContext.getStore()!.warnings.add('WARNING: genesis differs');
    throw new ToolError('failed');
  }), {});
  assert.match(r.text, /WARNING: genesis differs/);
});

test('a value far longer than any real one is refused before the handler runs, in a few milliseconds, anywhere in the arguments', async () => {
  let ran = 0;
  const tool = defineTool({
    name: 'size_tool',
    title: 'test',
    description: 'test',
    input: { args: z.array(z.unknown()).optional().describe('args'), text: z.string().optional().describe('text') },
    readsChain: false,
    handler: async () => {
      ran++;
      return 'ran';
    },
  });
  const refused: Array<[unknown, RegExp]> = [
    [{ args: ['1'.repeat(1_000_000)] }, /^Invalid input for size_tool: args\.0 is a number of 1000000 characters\. No amount, id or block number has more than 80 digits/],
    [{ args: [`-${'9'.repeat(81)}`] }, /args\.0 is a number of 82 characters/],
    [{ args: [{ Id: { deep: ['1'.repeat(81)] } }] }, /args\.0\.Id\.deep\.0 is a number of 81 characters/],
    [{ args: [`0x${'f'.repeat(MAX_HEX)}`] }, /args\.0 is 600002 characters of 0x hex, more than the 600000/],
    [{ text: 'a'.repeat(MAX_TEXT + 1) }, /text is 20001 characters long\. A value of these tools has at most 20000 characters/],
    [{ args: [{ ['k'.repeat(MAX_TEXT + 1)]: 1 }] }, /a field name in args\.0 is 20001 characters long/],
  ];
  for (const [args, re] of refused) {
    const t = performance.now();
    const r = await runTool(tool, args);
    const ms = performance.now() - t;
    assert.equal(r.isError, true, JSON.stringify(args).slice(0, 80));
    assert.match(r.text, re);
    assert.ok(r.text.length < 400, 'the value is not repeated back');
    assert.ok(ms < 500, `refused in ${ms.toFixed(0)} ms`);
  }
  assert.equal(ran, 0, 'the handler never ran');
  // the longest values that are allowed still reach the handler
  for (const args of [{ args: ['1'.repeat(MAX_DIGITS)] }, { args: [`0x${'f'.repeat(MAX_HEX - 2)}`] }, { text: 'a'.repeat(MAX_TEXT) }, { args: [' 12 ', 'text', 5, null, { a: [true] }] }]) {
    const r = await runTool(tool, args);
    assert.equal(r.text, 'ran', JSON.stringify(args).slice(0, 80));
  }
});
