// Search over the chain's modules, calls, events, errors, constants and storage, by everyday words
// or by name. Everyday jobs ("send", "mint an nft") come first, because the word a person uses is
// often in no call's name.
import { JOBS, SYNONYMS, withToken, type ItemKind, type Job } from './knowledge.ts';
import { normName, type ChainIndex, type ItemInfo, type ModuleInfo } from './meta.ts';

export type HitKind = ItemKind | 'module';

export interface Hit {
  kind: HitKind;
  module: ModuleInfo;
  item?: ItemInfo;
  score: number;
}

export interface JobHit {
  job: Job;
  text: string;
  item: ItemInfo;
}

export interface SearchResult {
  jobs: JobHit[];
  hits: Hit[];
  /** How many matches there were before the list was cut to the limit. */
  total: number;
  /** True when nothing matched every word of the query, so these results match most of its words. */
  loose: boolean;
}

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'how', 'do', 'does', 'i', 'on', 'in', 'for', 'with', 'my', 'is', 'are', 'what', 'which', 'and', 'or', 'can', 'it', 'me', 'from', 'by', 'at', 'this', 'that', 'portaldot', 'v3', 'chain', 'pallet', 'module', 'extrinsic', 'call', 'function', 'method', 'using', 'use', 'get', 'make']);

// transferKeepAlive -> ["transfer", "keep", "alive"]
const splitName = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);

// "minting" and "mints" should find "mint"; "tokens" should find "token"; "nfts" should find "nft".
function stem(w: string): string {
  if (w.length > 5) return w.replace(/(ing|ed|es|s)$/, '');
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

const KIND_BONUS: Record<HitKind, number> = { call: 6, module: 4, storage: 2, event: 1, constant: 0, error: 0 };
const KIND_ORDER: Record<HitKind, number> = { module: 0, call: 1, storage: 2, event: 3, constant: 4, error: 5 };

/** How well one query word fits an item, and whether it was found in the item's own name. */
function wordScore(word: string, nameWords: string[], nameNorm: string, moduleNorm: string, doc: string): { score: number; inName: boolean } {
  const s = stem(word);
  if (nameWords.some((n) => n === word || stem(n) === s)) return { score: 30, inName: true };
  if (moduleNorm === word || stem(moduleNorm) === s) return { score: 26, inName: false };
  if (nameNorm.includes(word) || nameWords.some((n) => n.startsWith(s))) return { score: 22, inName: true };
  if (moduleNorm.includes(s)) return { score: 14, inName: false };
  const clean = s.replace(/[^a-z0-9]/g, '');
  if (clean.length > 2 && new RegExp(`\\b${clean}`, 'i').test(doc)) return { score: 6, inName: false };
  return { score: 0, inName: false };
}

/** The words of a query that carry meaning: lower case, no punctuation, no filler words. */
export function queryWords(query: string): string[] {
  const raw = query.trim().toLowerCase();
  const hasLetter = (w: string): boolean => /[a-z0-9]/.test(w);
  const tokens = raw.split(/[^a-z0-9_]+/).filter((w) => hasLetter(w) && !STOP.has(w));
  return tokens.length ? tokens : raw.split(/[^a-z0-9_]+/).filter(hasLetter);
}

export function searchChain(index: ChainIndex, query: string, kinds: HitKind[] | undefined, limit: number): SearchResult {
  const raw = query.trim().toLowerCase();
  const words = queryWords(query);
  if (!words.length) return { jobs: [], hits: [], total: 0, loose: false };
  const wants = (k: HitKind): boolean => !kinds || kinds.length === 0 || kinds.includes(k);
  const exact = normName(raw.replace(/::/g, '.').split('.').pop() ?? raw);
  const exactModule = raw.includes('.') || raw.includes('::') ? normName(raw.replace(/::/g, '.').split('.')[0]) : '';

  // One pass over everything. "needed" is how many of the query's words must be found.
  const run = (needed: number): { jobs: JobHit[]; hits: Hit[] } => {
    const jobs: JobHit[] = [];
    for (const job of JOBS) {
      const jobWords = job.words.split(' ');
      const found = words.filter((w) => jobWords.some((x) => x.startsWith(stem(w)) || stem(x) === stem(w))).length;
      if (found < needed || !wants(job.kind)) continue;
      const item = index.items.find((it) => it.module === job.module && it.kind === job.kind && it.name === job.item);
      if (item) jobs.push({ job, text: withToken(job.text, index.token), item }); // offered only when the chain really has it
    }
    const top = jobs.slice(0, 3);
    const jobRank = new Map(top.map((j, i) => [j.item, i]));
    const hits: Hit[] = [];

    const consider = (kind: HitKind, module: ModuleInfo, item: ItemInfo | undefined): void => {
      if (!wants(kind)) return;
      const name = item ? item.name : module.name;
      const nameNorm = normName(name);
      const moduleNorm = normName(module.name);
      const doc = item ? item.summary : `${module.note} ${module.group?.name ?? ''}`;
      let score = 0;
      if (nameNorm === exact && (!exactModule || exactModule === moduleNorm)) score = 100;
      else if (item && `${moduleNorm}${nameNorm}` === normName(raw)) score = 100;
      else {
        const nameWords = splitName(name);
        let sum = 0;
        let inName = 0;
        let found = 0;
        for (const w of words) {
          let best = wordScore(w, nameWords, nameNorm, moduleNorm, doc);
          for (const alt of SYNONYMS[w] ?? []) {
            const viaAlt = wordScore(alt, nameWords, nameNorm, moduleNorm, doc);
            if (viaAlt.score - 4 > best.score) best = { score: viaAlt.score - 4, inName: viaAlt.inName };
          }
          if (best.score <= 0) continue;
          found++;
          sum += best.score;
          if (best.inName) inName++;
        }
        if (found < needed) return;
        // A short name that the query covers well beats a long name that merely contains a word.
        score = sum / words.length + (10 * Math.min(inName, nameWords.length)) / nameWords.length;
      }
      score += KIND_BONUS[kind];
      const rank = item ? jobRank.get(item) : undefined;
      if (rank !== undefined) score += 23 - rank; // the items that answer a job come first, in the jobs' order
      hits.push({ kind, module, item, score });
    };

    for (const module of index.modules) {
      consider('module', module, undefined);
      for (const it of [...module.calls, ...module.events, ...module.errors, ...module.constants, ...module.storage]) consider(it.kind, module, it);
    }
    hits.sort((a, b) => b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.item?.name.length ?? 0) - (b.item?.name.length ?? 0));
    return { jobs: top, hits };
  };

  // Every word has to be found. Only when that finds nothing at all, and the query is a sentence,
  // are results accepted that match most of its words.
  let found = run(words.length);
  let loose = false;
  if (!found.jobs.length && !found.hits.length && words.length >= 3) {
    found = run(Math.ceil((words.length * 2) / 3));
    loose = found.jobs.length > 0 || found.hits.length > 0;
  }
  return { jobs: found.jobs, hits: found.hits.slice(0, limit), total: found.hits.length, loose };
}
