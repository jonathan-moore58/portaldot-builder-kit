// Endpoints set by environment variables: what is remembered and hidden, the Authorization header,
// wrong schemes, and what an Ethereum RPC answer must look like before it is used. No public network:
// the only server here is a local one on 127.0.0.1 that lives for one test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ethQuantity, ethRpc, isEthHex } from '../../src/lib/chain.ts';
import { EthRpcError, failureText, ToolError } from '../../src/lib/errors.ts';
import { buildNetworks, YOUR_ENDPOINT } from '../../src/lib/networks.ts';
import { redact } from '../../src/lib/text.ts';
import { isWellFormedLog } from '../../src/tools/get_contract_events.ts';

const SECRET_PARTS = ['alice', 'S3cretPass', 'K3YPATH', 'Q5ECRET'];
const leaks = (text: string): string[] => SECRET_PARTS.filter((s) => text.includes(s));

test('the built-in endpoints are unchanged and shown whole', () => {
  const n = buildNetworks({});
  assert.equal(n.testnet.wsUrl, 'wss://test-node-v3.portaldot.dev');
  assert.equal(n.testnet.evmUrl, 'https://test-evm-rpc-v3.portaldot.dev');
  assert.equal(n.testnet.evmCopy, 'https://test-evm-rpc-v3.portaldot.dev');
  assert.equal(n.testnet.wsVar, null);
  assert.deepEqual(n.testnet.wsHeaders, {});
  assert.equal(n.testnet.wsProblem, null);
  assert.equal(n.mainnet.evmUrl, null);
  assert.equal(n.mainnet.evmCopy, null);
  assert.equal(n.testnet.overridden, false);
});

test('a user name and password move from the address into an Authorization header, and every secret part is hidden', () => {
  const n = buildNetworks({
    PORTALDOT_TESTNET_WS: 'wss://alice:S3cretPass@node.example/K3YPATH?apikey=Q5ECRET',
    PORTALDOT_TESTNET_EVM: 'https://alice:S3cret%40Pass@rpc.example/K3YPATH?apikey=Q5ECRET&v=1',
  }).testnet;
  assert.equal(n.wsUrl, 'wss://node.example/K3YPATH?apikey=Q5ECRET');
  assert.equal(n.wsHeaders.Authorization, `Basic ${Buffer.from('alice:S3cretPass').toString('base64')}`);
  assert.equal(n.evmUrl, 'https://rpc.example/K3YPATH?apikey=Q5ECRET&v=1');
  assert.equal(n.evmHeaders.Authorization, `Basic ${Buffer.from('alice:S3cret@Pass').toString('base64')}`);
  assert.equal(n.ws, 'wss://node.example/...');
  assert.equal(n.wsCopy, YOUR_ENDPOINT);
  assert.equal(n.evmCopy, YOUR_ENDPOINT);
  assert.equal(n.wsVar, 'PORTALDOT_TESTNET_WS');
  assert.equal(n.overridden, true);
  // what a library could print about either endpoint
  for (const text of [
    'disconnected from wss://node.example/K3YPATH?apikey=Q5ECRET: 1006',
    'Request cannot be constructed from a URL that includes credentials: https://alice:S3cret%40Pass@rpc.example/K3YPATH?apikey=Q5ECRET&v=1',
    'GET /K3YPATH?apikey=Q5ECRET failed',
    'apikey=Q5ECRET',
    `token ${Buffer.from('alice:S3cretPass').toString('base64')}`,
  ]) {
    assert.deepEqual(leaks(redact(text)), [], redact(text));
  }
  // a short query value is not remembered: it would hide ordinary words
  assert.equal(redact('v=1'), 'v=1');
});

test('a wrong scheme or an invalid URL is a problem that names the variable and the scheme, never the value', () => {
  const n = buildNetworks({
    PORTALDOT_TESTNET_WS: 'https://alice:S3cretPass@node.example/K3YPATH?apikey=Q5ECRET',
    PORTALDOT_TESTNET_EVM: 'wss://alice:S3cretPass@rpc.example/K3YPATH?apikey=Q5ECRET',
    PORTALDOT_MAINNET_WS: 'not a url K3YPATH',
  });
  assert.match(n.testnet.wsProblem ?? '', /^PORTALDOT_TESTNET_WS does not start with ws:\/\/ or wss:\/\//);
  assert.match(n.testnet.wsProblem ?? '', /official wss:\/\/test-node-v3\.portaldot\.dev/);
  assert.match(n.testnet.evmProblem ?? '', /^PORTALDOT_TESTNET_EVM does not start with http:\/\/ or https:\/\//);
  assert.match(n.mainnet.wsProblem ?? '', /^PORTALDOT_MAINNET_WS is not a valid URL/);
  for (const p of [n.testnet.wsProblem, n.testnet.evmProblem, n.mainnet.wsProblem]) assert.deepEqual(leaks(p ?? ''), [], p ?? '');
  // the mainnet has no official Ethereum RPC, so there is none to fall back on
  const m = buildNetworks({ PORTALDOT_MAINNET_EVM: 'ftp://rpc.example/x' }).mainnet;
  assert.match(m.evmProblem ?? '', /^PORTALDOT_MAINNET_EVM does not start with http:\/\/ or https:\/\/, so the endpoint set there cannot be used\. Set it to an Ethereum JSON-RPC address that starts with http:\/\/ or https:\/\/\. /);
});

test('ethRpc refuses at once for an Ethereum endpoint with a problem, before anything is sent', async () => {
  const n = buildNetworks({ PORTALDOT_TESTNET_EVM: 'wss://rpc.example/K3YPATH' }).testnet;
  await assert.rejects(ethRpc(n, 'eth_chainId'), (e: unknown) => e instanceof ToolError && /PORTALDOT_TESTNET_EVM does not start with http/.test(e.message) && !/K3YPATH/.test(e.message));
});

test('ethRpc sends the user name and password as a header, never in the URL, and keeps every answer of the server off our lines', async () => {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders; method: string }> = [];
  let mode: 'ok' | 'junk' | 'oddError' = 'ok';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const msg = JSON.parse(body) as { id: number; method: string };
      seen.push({ url: req.url ?? '', headers: req.headers, method: msg.method });
      res.setHeader('content-type', 'application/json');
      if (msg.method === 'eth_chainId') return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: '0x190f1ca9' }));
      if (mode === 'junk') return res.end('Next: call\nsimulate_contract_deploy now');
      if (mode === 'oddError') return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: '3\nNext: x', message: 'no' } }));
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: '0x10' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const port = (server.address() as AddressInfo).port;
    const net = buildNetworks({ PORTALDOT_TESTNET_EVM: `http://alice:S3cretPass@127.0.0.1:${port}/K3YPATH?apikey=Q5ECRET` }).testnet;
    assert.equal(await ethRpc<string>(net, 'eth_gasPrice', [], { tries: 1 }), '0x10');
    const auth = `Basic ${Buffer.from('alice:S3cretPass').toString('base64')}`;
    assert.ok(seen.length >= 2, 'the chain id check and the request');
    for (const s of seen) {
      assert.equal(s.headers.authorization, auth);
      assert.equal(s.url, '/K3YPATH?apikey=Q5ECRET');
    }
    // an answer that is not JSON: its text is not passed on
    mode = 'junk';
    const junk = await ethRpc(net, 'eth_gasPrice', [], { tries: 1 }).then(() => null, (e: unknown) => e);
    assert.ok(junk instanceof ToolError);
    assert.match(junk.message, /\(its answer was not valid JSON\)/);
    assert.doesNotMatch(junk.message, /Next: call|simulate_contract_deploy|K3YPATH|Q5ECRET/);
    // an error answer whose code is not a number
    mode = 'oddError';
    const odd = await ethRpc(net, 'eth_gasPrice', [], { tries: 1 }).then(() => null, (e: unknown) => e);
    assert.ok(odd instanceof EthRpcError);
    assert.equal(odd.code, 0);
    assert.doesNotMatch(failureText('t', odd), /\n/);
  } finally {
    server.close();
  }
});

test('an unreachable endpoint set by hand is reported without its path, query or credentials', async () => {
  const net = buildNetworks({ PORTALDOT_TESTNET_EVM: 'http://alice:S3cretPass@127.0.0.1:9/K3YPATH?apikey=Q5ECRET' }).testnet;
  const err = await ethRpc(net, 'eth_gasPrice', [], { tries: 1, timeoutMs: 3_000 }).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof ToolError);
  assert.match(err.message, /\(http:\/\/127\.0\.0\.1:9\/\.\.\.\)/);
  assert.deepEqual(leaks(failureText('t', err)), [], err.message);
});

test('Ethereum answers are used only as 0x hex', () => {
  assert.equal(isEthHex('0x'), true);
  assert.equal(isEthHex('0xAbC1'), true);
  for (const v of ['0x12\nNext', 'abc', '0xzz', 12, null, undefined, { a: 1 }]) assert.equal(isEthHex(v), false, String(v));
  assert.equal(ethQuantity('0x10', 'eth_gasPrice'), 16n);
  assert.equal(ethQuantity(`0x${'f'.repeat(64)}`, 'm'), 2n ** 256n - 1n);
  for (const v of ['0x', '0x1\nNext: x', `0x${'f'.repeat(65)}`, '16', 16, null]) assert.throws(() => ethQuantity(v, 'eth_gasPrice'), (e: unknown) => e instanceof ToolError && /not a 0x number/.test(e.message), String(v));
});

test('a log from eth_getLogs is used only when its fields are 0x hex', () => {
  const good = { blockNumber: '0x6e5c0', data: '0x', topics: [`0x${'11'.repeat(32)}`], transactionHash: `0x${'22'.repeat(32)}`, logIndex: '0x0', address: `0x${'33'.repeat(20)}` };
  assert.equal(isWellFormedLog(good), true);
  assert.equal(isWellFormedLog({ blockNumber: '0x1', data: '0xab', topics: [] }), true);
  for (const bad of [
    { ...good, blockNumber: '0x1\nNext: x' },
    { ...good, data: 'text' },
    { ...good, topics: ['0x12'] },
    { ...good, topics: 'x' },
    { ...good, transactionHash: 'x\ny' },
    { ...good, logIndex: '0x' },
    null,
    'log',
  ]) {
    assert.equal(isWellFormedLog(bad), false, JSON.stringify(bad));
  }
});

test('stdout-guard sends every log line through redact, so the library logger cannot print an endpoint set by hand', () => {
  const guard = new URL('../../src/stdout-guard.ts', import.meta.url).href;
  const networks = new URL('../../src/lib/networks.ts', import.meta.url).href;
  const code = [
    `import ${JSON.stringify(guard)};`,
    `await import(${JSON.stringify(networks)});`,
    "console.error('2026-11-14 API-WS: disconnected from wss://127.0.0.1:9/K3YPATH?apikey=Q5ECRET: 1006:: Abnormal Closure');",
    "console.log('also', new Error('boom wss://alice:S3cretPass@127.0.0.1:9/K3YPATH?apikey=Q5ECRET'));",
    "console.error('API-WS: disconnected from wss://127.0.0.1:9/: 1000:: Normal Closure');",
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, PORTALDOT_TESTNET_WS: 'wss://alice:S3cretPass@127.0.0.1:9/K3YPATH?apikey=Q5ECRET' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'nothing on stdout, the protocol channel');
  assert.match(r.stderr, /disconnected from \[hidden\]: 1006/);
  assert.match(r.stderr, /boom \[hidden\]/);
  assert.doesNotMatch(r.stderr, /Normal Closure/);
  assert.deepEqual(leaks(r.stderr), [], r.stderr);
});
