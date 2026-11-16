// MCP prompts made from the skills: every SKILL.md whose front matter has a line "mcp-prompt: <name>"
// (src/generated/prompts.ts). A client shows them to people as ready-made starts of a conversation.
// With no such file the server offers no prompt, and starts as usual.
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { PROMPT_ENTRIES, type PromptEntry } from '../generated/prompts.ts';
import { holdsRecoveryPhrase } from './secrets.ts';

/** Longest text a prompt argument may have: a few paragraphs about an idea. */
export const MAX_ARGUMENT = 4_000;

interface Argument {
  name: string;
  description: string;
  /** The words in front of the person's text, where it is added to the prompt. */
  label: string;
}

/** What the server knows about a prompt beyond its file: a title for people, and its argument. */
interface Settings {
  title: string;
  description: string;
  argument?: Argument;
}

const SETTINGS: Record<string, Settings> = {
  start_project: {
    title: 'Start a Portaldot V3 project',
    description: "Begins a new Portaldot V3 project with the Bridge Zero team's start-up steps: what to check, which tools to use and how to write the first code. Optionally say what you want to build.",
    argument: {
      name: 'idea',
      description: 'What you want to build, in a sentence or a few, for example "a shop that sells NFT tickets for tPOT". Optional.',
      label: 'What I want to build',
    },
  },
};

export interface ServedPrompt {
  name: string;
  title: string;
  description: string;
  argument?: Argument;
  body: string;
}

/** The prompts to register: the generated entries, with the settings known for their names. */
export function servedPrompts(entries: PromptEntry[] = PROMPT_ENTRIES): ServedPrompt[] {
  return entries.map((e) => {
    const s = SETTINGS[e.name];
    const description = s?.description ?? (e.description.length > 300 ? `${e.description.slice(0, 297)}...` : e.description);
    return { name: e.name, title: s?.title ?? e.title, description: description || e.title, argument: s?.argument, body: e.body };
  });
}

/** The prompt's text: the body of its SKILL.md, then the person's own words when they gave some. */
export function promptText(p: ServedPrompt, value?: string): string {
  const v = value?.trim();
  if (!v || !p.argument) return p.body;
  return `${p.body}\n\n---\n\n${p.argument.label}: ${v}`;
}

/** Refuses an argument that holds a secret phrase: it would go to the model with the prompt. */
function refuseSecret(p: ServedPrompt, value: string | undefined): void {
  if (value && value.length >= 35 && holdsRecoveryPhrase(value)) {
    throw new Error(`The ${p.argument?.name ?? 'argument'} of the prompt ${p.name} holds what looks like a secret recovery phrase. Never share one: remove it and try again. If it is real, treat the account as exposed and move its funds.`);
  }
}

/** Registers one MCP prompt per entry. Returns how many. */
export function registerPrompts(server: McpServer, entries: PromptEntry[] = PROMPT_ENTRIES): number {
  const list = servedPrompts(entries);
  for (const p of list) {
    const message = (text: string) => ({ description: p.description, messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });
    const arg = p.argument;
    if (arg) {
      const argsSchema = z.object({ [arg.name]: z.string().max(MAX_ARGUMENT).optional().describe(arg.description) });
      server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema }, (args) => {
        const value = args[arg.name];
        refuseSecret(p, value);
        return message(promptText(p, value));
      });
    } else {
      server.registerPrompt(p.name, { title: p.title, description: p.description }, () => message(p.body));
    }
  }
  return list.length;
}
