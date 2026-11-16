// What any MCP client sees besides the tools: the knowledge files as resources, the prompts made from
// the skills, the capabilities and the instructions. Client and server talk in memory. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { GUIDE_FILES } from '../../src/generated/guide.ts';
import type { PromptEntry } from '../../src/generated/prompts.ts';
import { MAX_ARGUMENT, promptText, registerPrompts, servedPrompts } from '../../src/lib/prompts.ts';
import { GUIDE_URI, guideResources, registerGuideResources } from '../../src/lib/resources.ts';
import { buildServer, instructionsFor, INSTRUCTIONS, SERVER_INFO } from '../../src/server.ts';
import { TOOLS } from '../../src/tools/index.ts';

const START: PromptEntry = { name: 'start_project', skill: 'portaldot-start', title: 'Start here', description: 'A long description for a skill.', body: '# Start\n\nFirst, check the chain.' };
const OTHER: PromptEntry = { name: 'other_prompt', skill: 'other', title: 'Another prompt', description: 'x'.repeat(400), body: '# Other\n\nIts text.' };

/** A client connected in memory to a server. */
async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'surface-test', version: '0.0.1' });
  await client.connect(clientSide);
  return client;
}

test('one resource per knowledge file: address, title, one line on what it holds, Markdown, size', () => {
  const list = guideResources();
  assert.equal(list.length, GUIDE_FILES.length);
  assert.equal(new Set(list.map((r) => r.uri)).size, list.length, 'addresses are unique');
  for (const [i, r] of list.entries()) {
    const f = GUIDE_FILES[i];
    assert.equal(r.uri, `${GUIDE_URI}${f.id}`);
    assert.equal(r.uri, new URL(r.uri).href, 'the address stays the same when a client parses it');
    assert.equal(r.name, f.id);
    assert.equal(r.title, f.title);
    assert.equal(r.mimeType, 'text/markdown');
    assert.equal(r.text, f.text);
    assert.equal(r.size, Buffer.byteLength(f.text, 'utf8'));
    assert.match(r.description, /^[A-Z`].*[.!?]$/, `${r.uri}: a sentence`);
    assert.doesNotMatch(r.description, /\n/, `${r.uri}: one line`);
  }
  assert.ok(list.some((r) => r.uri === 'portaldot://guide/errors'));
  assert.ok(!list.some((r) => r.text.startsWith('---')), 'no front matter');
});

test('prompts: the known settings of start_project, and a prompt the code does not know', () => {
  const [start, other] = servedPrompts([START, OTHER]);
  assert.equal(start.title, 'Start a Portaldot V3 project');
  assert.equal(start.argument?.name, 'idea');
  assert.match(start.description, /Portaldot V3 project/);
  assert.equal(other.title, 'Another prompt');
  assert.equal(other.argument, undefined);
  assert.equal(other.description.length, 300, 'a long description is cut');
  assert.equal(promptText(start), START.body);
  assert.equal(promptText(start, '   '), START.body, 'an empty idea adds nothing');
  assert.equal(promptText(start, ' a ticket shop '), `${START.body}\n\n---\n\nWhat I want to build: a ticket shop`);
  assert.equal(promptText(other, 'ignored'), OTHER.body, 'a prompt without an argument ignores one');
  assert.deepEqual(servedPrompts([]), []);
});

test('resources and prompts over MCP: list, read, get, and the refusals', async () => {
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { resources: { listChanged: false }, prompts: { listChanged: false } } });
  assert.equal(registerGuideResources(server), GUIDE_FILES.length);
  assert.equal(registerPrompts(server, [START, OTHER]), 2);
  const client = await connect(server);
  try {
    const { resources } = await client.listResources();
    assert.equal(resources.length, GUIDE_FILES.length);
    const errors = resources.find((r) => r.uri === 'portaldot://guide/errors');
    assert.ok(errors?.title && errors.description && errors.mimeType === 'text/markdown' && typeof errors.size === 'number');
    const read = await client.readResource({ uri: 'portaldot://guide/errors' });
    assert.equal(read.contents.length, 1);
    const c = read.contents[0] as { uri: string; mimeType?: string; text?: string };
    assert.equal(c.uri, 'portaldot://guide/errors');
    assert.equal(c.mimeType, 'text/markdown');
    assert.match(c.text ?? '', /^### E1\. /m);
    await assert.rejects(client.readResource({ uri: 'portaldot://guide/no-such-file' }));

    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name), ['start_project', 'other_prompt']);
    const start = prompts[0];
    assert.equal(start.title, 'Start a Portaldot V3 project');
    assert.deepEqual(start.arguments?.map((a) => ({ name: a.name, required: a.required })), [{ name: 'idea', required: false }]);
    assert.ok(start.arguments?.[0].description);
    const got = await client.getPrompt({ name: 'start_project', arguments: { idea: 'a ticket shop' } });
    assert.equal(got.messages.length, 1);
    assert.equal(got.messages[0].role, 'user');
    assert.equal((got.messages[0].content as { text: string }).text, `${START.body}\n\n---\n\nWhat I want to build: a ticket shop`);
    const plain = await client.getPrompt({ name: 'start_project' });
    assert.equal((plain.messages[0].content as { text: string }).text, START.body);
    await assert.rejects(client.getPrompt({ name: 'start_project', arguments: { idea: 'legal winner thank year wave sausage worth useful legal winner thank yellow' } }), /secret recovery phrase/);
    await assert.rejects(client.getPrompt({ name: 'start_project', arguments: { idea: 'x'.repeat(MAX_ARGUMENT + 1) } }));
    await assert.rejects(client.getPrompt({ name: 'no_such_prompt' }));
  } finally {
    await client.close();
  }
});

test('with the start prompt, the instructions name it and still fit in 4,096 characters', () => {
  const text = instructionsFor(servedPrompts([START]));
  assert.ok(text.length < 4096, `${text.length}`);
  assert.match(text, /Prompts a person can pick in the client: start_project \("Start a Portaldot V3 project"\)\. Suggest start_project to someone who begins a new project on this chain\./);
  const tools = new Set([...TOOLS.map((t) => t.name), 'start_project']);
  for (const word of text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) assert.ok(tools.has(word), word);
  assert.doesNotMatch(instructionsFor([]), /Prompts a person can pick/, 'no prompt line without prompts');
});

test('the server: capabilities, the tools with read_guide, the resources, and instructions under 4,096 characters', async () => {
  assert.equal(SERVER_INFO.name, 'portaldot-dev');
  const client = await connect(buildServer());
  try {
    const caps = client.getServerCapabilities();
    assert.ok(caps?.tools, 'tools');
    assert.equal(caps?.resources?.listChanged, false, 'the resource list never changes');
    assert.ok(!caps?.resources?.subscribe, 'no subscriptions');
    const served = servedPrompts();
    if (served.length) assert.equal(caps?.prompts?.listChanged, false);
    else assert.equal(caps?.prompts, undefined, 'no prompts capability without a prompt');

    const { tools } = await client.listTools();
    assert.equal(tools.length, TOOLS.length);
    assert.ok(tools.some((t) => t.name === 'read_guide' && t.annotations?.readOnlyHint === true && t.annotations?.openWorldHint === false));
    const { resources } = await client.listResources();
    assert.equal(resources.length, GUIDE_FILES.length);
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name), served.map((p) => p.name));

    const instructions = client.getInstructions() ?? '';
    assert.equal(instructions, INSTRUCTIONS);
    assert.ok(instructions.length < 4096, `${instructions.length}`);
    assert.match(instructions, /read_guide: the kit's knowledge by section: recipes, addresses, amounts and fees, contracts, native modules, open questions/);
    // the corrected rule 3: the value and the max fee are not part of the 1010 check
    assert.match(instructions, /gas limit x base fee is more than the sender can spend; the max fee and the value are not part of that check/);
    assert.doesNotMatch(instructions, /plus the value/);
    // every snake_case word names a tool or a prompt
    const names = new Set([...tools.map((t) => t.name), ...prompts.map((p) => p.name)]);
    for (const word of instructions.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) assert.ok(names.has(word), word);
    assert.match(instructions, /^[\x20-\x7e\n]+$/, 'plain ASCII');
  } finally {
    await client.close();
  }
});
