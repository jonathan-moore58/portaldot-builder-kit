import * as z from 'zod';
import { getConn } from '../lib/chain.ts';
import { clip, lines } from '../lib/format.ts';
import { fullName, getIndex, signature } from '../lib/meta.ts';
import { pickNetwork } from '../lib/networks.ts';
import { queryWords, searchChain, type Hit, type HitKind } from '../lib/search.ts';
import { defineTool, networkField } from '../lib/tool.ts';

const KINDS = ['module', 'call', 'event', 'error', 'constant', 'storage'] as const;

function row(hit: Hit): string {
  if (!hit.item) return `module    ${hit.module.name} - ${hit.module.note || 'No description.'}${hit.module.group ? ` (${hit.module.group.name})` : ''}`;
  const it = hit.item;
  const what = it.kind === 'constant' && it.value ? `${fullName(it)} = ${clip(it.value, 60)}` : `${it.module}.${signature(it)}`;
  return `${it.kind.padEnd(9)} ${what}${it.summary ? ` - ${clip(it.summary, 140)}` : ''}`;
}

// Things people search for that are facts about the chain, not items of its runtime.
const FACT_WORDS = /^(gas|gasprice|fee|fees|price|endpoint|endpoints|rpc|url|chainid|decimals|decimal|faucet|explorer|metamask|genesis|finality|blocktime|symbol)$/;

export default defineTool({
  name: 'search_chain',
  title: 'Portaldot V3: find a module, call, event, error, constant or stored value',
  description:
    'Searches everything the Portaldot V3 runtime offers, read from the live chain: all its modules (pallets) and their calls (extrinsics), events, errors, constants and storage. ' +
    'Search by what you want to do in everyday words ("send", "mint nft", "swap", "deploy contract", "stake") or by a name or part of one ("transferKeepAlive", "existential", "Revive"). ' +
    'Everyday jobs are answered first with the exact call that does them. Use it before writing any call, so the name, module and argument list are the chain\'s own and not a guess from Polkadot or Ethereum habits. ' +
    'Follow up with describe_item for exact arguments and sample code. Example: {"query": "create token"}.',
  input: {
    query: z.string().trim().min(2).max(300).describe('What to look for: everyday words ("send tokens", "nft") or a name or part of one ("batchAll", "Assets.mint"). At least 2 characters.'),
    kinds: z.array(z.enum(KINDS)).optional().describe('Only these kinds of result, for example ["call"] or ["error", "event"]. Leave out for all kinds.'),
    limit: z.number().int().min(1).max(40).optional().describe('Most results to return. Default 12, at most 40.'),
    network: networkField,
  },
  readsChain: true,
  handler: async ({ query, kinds, limit, network: key }) => {
    const network = pickNetwork(key);
    const conn = await getConn(network.key);
    const index = getIndex(conn);
    const max = limit ?? 12;
    const shown = clip(query, 120);
    const { jobs, hits, total, loose } = searchChain(index, query, kinds as HitKind[] | undefined, max);
    const factHint = queryWords(query).some((w) => FACT_WORDS.test(w))
      ? 'For the gas price now, fees, endpoints, chain ids, decimals, the explorer and MetaMask settings, call get_chain_facts: those are facts about the chain, not items of its runtime.'
      : null;

    if (!jobs.length && !hits.length) {
      return lines(
        `No module, call, event, error, constant or stored value on the ${network.label} (runtime ${index.specVersion}) matches "${shown}".`,
        factHint,
        'Try one plain word for the action or the thing (send, token, nft, contract, stake, vote, fee), or part of a name.',
        'This runtime has no Referenda or ConvictionVoting module, no paras or parachain-system module, no XCM module and no bridge module (checked Nov 13, 2026), so searches for those find nothing.',
      );
    }
    const example = jobs[0] ? fullName(jobs[0].item) : hits[0].item ? fullName(hits[0].item) : hits[0].module.name;
    return lines(
      `Search "${shown}" on the ${network.label} (runtime ${index.specVersion}): ${total} ${total === 1 ? 'match' : 'matches'}${total > hits.length ? `, the best ${hits.length} shown` : ''}.`,
      loose && 'Nothing matches every word of the query, so these match most of its words. Check that each is what you meant.',
      factHint,
      jobs.length ? ['', 'How to', ...jobs.map((j) => `  ${j.text} -> ${j.job.module}.${signature(j.item)}  (${j.job.kind})`)] : null,
      hits.length ? ['', 'Matches, best first', ...hits.map((h) => `  ${row(h)}`)] : null,
      '',
      `Next: describe_item with a name from this list (for example "${example}") gives the exact arguments, what each means, and sample code.`,
    );
  },
});
