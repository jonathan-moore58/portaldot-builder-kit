// One shape for every tool: a name, a description written for the model, a zod input schema and a
// handler that returns text. The wrapper turns thrown errors into tool errors the model can act on.
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { callContext } from './chain.ts';
import { failureText, ToolError } from './errors.ts';
import type { NetworkKey } from './networks.ts';
import { refuseSecretsIn } from './secrets.ts';

/** Longest text a tool returns. Claude Code warns above about 10,000 tokens of tool output. */
const MAX_OUTPUT_CHARS = 19_000;

/** Most digits a number may have: no amount, id or block number comes near it. */
export const MAX_DIGITS = 80;
/** Longest 0x hex a value may be: init code (at most 250000 bytes) with room for its constructor arguments. */
export const MAX_HEX = 600_000;
/** Longest text a value may be. explain_error reads at most this much of an error text. */
export const MAX_TEXT = 20_000;

function checkLength(s: string, where: string, toolName: string): void {
  const t = s.trim();
  if (/^-?\d+$/.test(t)) {
    if (t.length > MAX_DIGITS) {
      throw new ToolError(
        `Invalid input for ${toolName}: ${where} is a number of ${t.length} characters. No amount, id or block number has more than ${MAX_DIGITS} digits, so it was refused before anything was read or sent. ` +
          'Digits meant as text or bytes go in as 0x hex.',
      );
    }
    return;
  }
  if (/^0[xX][0-9a-fA-F]*$/.test(t)) {
    if (t.length > MAX_HEX) throw new ToolError(`Invalid input for ${toolName}: ${where} is ${t.length} characters of 0x hex, more than the ${MAX_HEX} any value of these tools may have (the largest is init code of 250000 bytes), so it was refused before anything was read or sent.`);
    return;
  }
  if (s.length > MAX_TEXT) {
    throw new ToolError(
      `Invalid input for ${toolName}: ${where} is ${s.length} characters long. A value of these tools has at most ${MAX_TEXT} characters (bytes written as 0x hex may be longer), so it was refused before anything was read or sent. Pass only the part that matters.`,
    );
  }
}

/**
 * Refuses a string anywhere in the arguments that is longer than any real value, before anything
 * parses it. Some parsers inside @polkadot slow down with the square of the length: one number of a
 * million digits held the whole server for minutes. Field names are checked too.
 */
export function refuseOversized(value: unknown, toolName: string): void {
  const stack: Array<[unknown, string]> = [[value, '']];
  while (stack.length) {
    const [v, path] = stack.pop() as [unknown, string];
    if (typeof v === 'string') {
      checkLength(v, path || 'input', toolName);
      continue;
    }
    if (v === null || typeof v !== 'object') continue;
    const isList = Array.isArray(v);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (!isList) checkLength(k, `a field name in ${path || 'input'}`, toolName);
      stack.push([x, p]);
    }
  }
}

export interface ToolDef<Shape extends z.ZodRawShape> {
  /** snake_case, verb first. Shown to the model as mcp__plugin_portaldot-dev_chain__<name>. */
  name: string;
  /** A short human title. */
  title: string;
  /** What it returns, when to use it, an example. The model chooses tools by this text. */
  description: string;
  /** The input fields. Give every field a .describe() with its format and an example. */
  input: Shape;
  /** True when the tool reads the live chain, false when it only computes. */
  readsChain: boolean;
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<string>;
}

// A tool list holds tools with different input shapes, so the shape is erased here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDef<any>;

export function defineTool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape> {
  return def;
}

/** The network field every chain-reading tool takes. */
export const networkField = z
  .enum(['testnet', 'mainnet'])
  .optional()
  .describe('Default "testnet" (token tPOT), where contracts and tokens live today. "mainnet" (token POT) has no public Ethereum RPC.');

export type NetworkArg = NetworkKey | undefined;

/** Runs a tool the way the server does, and returns what the model would read. Used by tests too. */
export async function runTool(tool: AnyTool, args: unknown): Promise<{ text: string; isError: boolean }> {
  const store = { warnings: new Set<string>() };
  // What a connection had to say (for example a genesis hash that is not the recorded one) goes in
  // front of the answer, also when the answer is an error.
  const withWarnings = (text: string): string => (store.warnings.size ? `${[...store.warnings].join('\n')}\n\n${text}` : text);
  try {
    const parsed = z.object(tool.input).parse(args ?? {});
    refuseOversized(parsed, tool.name); // a value far longer than any real one is refused before a parser sees it
    refuseSecretsIn(parsed); // a secret phrase in any argument is refused before anything runs or is sent
    let text = withWarnings(await callContext.run(store, () => tool.handler(parsed)));
    if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n... (cut: the answer was ${text.length} characters long. Ask for less at once.)`;
    return { text, isError: false };
  } catch (err) {
    if (err instanceof z.ZodError) return { text: `Invalid input for ${tool.name}: ${err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`, isError: true };
    return { text: withWarnings(failureText(tool.name, err)).slice(0, MAX_OUTPUT_CHARS), isError: true };
  }
}

export function registerTools(server: McpServer, tools: AnyTool[]): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: z.object(tool.input),
        annotations: { title: tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: tool.readsChain },
      },
      async (args: unknown) => {
        const { text, isError } = await runTool(tool, args);
        return isError ? { isError: true, content: [{ type: 'text' as const, text }] } : { content: [{ type: 'text' as const, text }] };
      },
    );
  }
}
