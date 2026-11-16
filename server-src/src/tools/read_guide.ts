// read_guide: the kit's knowledge pack by section, for any MCP client. Without it, a client that loads
// only this server gets the tools but not the recipes, rules and measurements the skill carries.
import * as z from 'zod';
import { ToolError } from '../lib/errors.ts';
import { contents, GUIDE, readTopic, searchGuide } from '../lib/guide.ts';
import { defineTool } from '../lib/tool.ts';

export default defineTool({
  name: 'read_guide',
  title: 'Portaldot V3: read the knowledge pack by section',
  description:
    `Reads the Bridge Zero team's knowledge pack for Portaldot V3 (${GUIDE.files.length} files, ${GUIDE.sections.length} sections): the rules that prevent costly mistakes, runnable recipes, addresses, amounts and fees, contracts, native modules, Ethereum differences, measured EVM and RPC behaviour, errors and traps, and open questions. ` +
    'Every fact says how and when it was checked. It reads no chain and needs no network. ' +
    'No arguments: the table of contents with every section id. "query": the 8 best sections for your words, each with two lines of its text, and the best one in full. ' +
    '"topic": one section in full, by its id ("errors/E12", "recipes/5a"), a file name ("networks") or a short form ("E12", "recipe 4", "2f"); a long one comes in numbered parts, and the answer gives the call for the next part. ' +
    'Use it to learn how to do something on this chain, or why it behaves as it does, before you write code. ' +
    'Use explain_error instead for an error text, describe_item for the chain\'s own metadata of one call, event or error, and search_chain to find which call does a job. ' +
    'Example: {"query": "storage deposit deploy"}.',
  input: {
    topic: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('One section to read in full: an id from the contents such as "errors/E12", "recipes/5a" or "contracts/tools", a file name such as "networks", or a short form such as "E12", "recipe 4" or "2f". With "query" too, the search looks only inside this file or section.'),
    query: z
      .string()
      .trim()
      .min(2)
      .max(300)
      .optional()
      .describe('Words to search for, for example "storage deposit deploy" or "eth_getLogs missing events". Returns the 8 best sections, best first, and the best one in full when it fits.'),
    part: z.number().int().min(1).max(50).optional().describe('Which part of a long topic to read, from 1. The answer to a long topic says how many parts it has and gives the call for the next one.'),
  },
  readsChain: false,
  handler: async ({ topic, query, part }) => {
    if (query) {
      if (part) throw new ToolError('"part" goes with "topic" alone: a search answer is never cut into parts. Leave "part" out, or read one of the sections it lists with {"topic": "<id>", "part": 2}.');
      return searchGuide(query, topic);
    }
    if (topic) return readTopic(topic, part);
    if (part) throw new ToolError('"part" needs a "topic": for example {"topic": "recipes-contracts/2", "part": 2}. With no arguments, read_guide lists every section.');
    return contents();
  },
});
