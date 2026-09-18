import { readFile } from "node:fs/promises";
import {
  promptLibraryEntrySchema,
  promptLibraryResponseSchema,
  promptLibrarySourceSchema,
  type PromptLibraryEntry,
  type PromptLibraryResponse,
  type PromptLibrarySource,
} from "@loomic/shared";
import { z } from "zod";

const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const snapshotEnvelopeSchema = z.object({
  version: z.string().min(1).max(100),
  sources: z.array(z.unknown()).max(30),
  items: z.array(z.unknown()).max(10000),
}).strict();

// This relative path is identical from src/features/... and dist/features/....
// Deployments must include apps/server/data with the application package.
export const promptLibraryCatalogUrl = new URL("../../../data/prompt-library/catalog.json", import.meta.url);

export type PromptLibraryQuery = {
  q: string;
  source: string;
  category: string;
  offset: number;
  limit: number;
};

export type PromptLibraryService = {
  search(query: PromptLibraryQuery): Promise<PromptLibraryResponse>;
  searchForAgent(query: PromptLibraryAgentQuery): Promise<PromptLibraryAgentResponse>;
  getById(id: string): Promise<PromptLibraryDetail | null>;
};

export const promptLibraryAgentQuerySchema = z.object({
  queries: z.array(z.string().trim().min(1).max(160)).max(4).default([]),
  sources: z.array(z.string().regex(/^[a-z0-9-]{1,80}$/)).max(8).default([]),
  categories: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
  offset: z.number().int().min(0).max(10000).default(0),
  limit: z.number().int().min(1).max(12).default(6),
}).strict();
export type PromptLibraryAgentQuery = z.infer<typeof promptLibraryAgentQuerySchema>;
export type PromptLibrarySummary = Omit<PromptLibraryEntry, "prompt"> & {
  promptExcerpt: string;
  promptLength: number;
  source: PromptLibrarySource;
  matchedQueries: string[];
  matchedTerms: string[];
};
export type PromptLibraryAgentResponse = {
  version: string;
  items: PromptLibrarySummary[];
  total: number;
  nextOffset: number | null;
  sources: PromptLibrarySource[];
  categories: string[];
  searchMode: "lexical_terms_and_query_variants";
};
export type PromptLibraryDetail = {
  version: string;
  item: PromptLibraryEntry;
  source: PromptLibrarySource;
};

export class PromptLibraryUnavailableError extends Error {
  constructor() {
    super("提示词库暂时不可用，请稍后重试。");
    this.name = "PromptLibraryUnavailableError";
  }
}

type Snapshot = {
  version: string;
  sources: PromptLibrarySource[];
  categories: string[];
  entries: Array<{ item: PromptLibraryEntry; searchText: string; labelText: string }>;
};

function normalizeSearch(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

// Word segmentation handles Chinese briefs without requiring spaces; English
// variants are supplied by the planner, not invented by a hidden model call.
// This remains lexical matching: no embeddings, semantic or visual inspection.
const wordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
const englishStopWords = new Set(["the", "a", "an", "of", "for", "with", "and", "to", "in", "on", "is", "are"]);
function termsForQuery(query: string): string[] {
  const tokens = [...wordSegmenter.segment(normalizeSearch(query))]
    .filter(segment => segment.isWordLike)
    .map(segment => segment.segment)
    .filter(term => !englishStopWords.has(term) && !/^[a-z]$/.test(term));
  return [...new Set(tokens)].slice(0, 16);
}

function rankEntry(
  entry: Snapshot["entries"][number],
  variants: Array<{ query: string; needle: string; terms: string[] }>,
) {
  if (!variants.length) return { score: 0, matchedQueries: [], matchedTerms: [] };
  let score = 0;
  const matchedQueries: string[] = [];
  const matchedTerms = new Set<string>();
  for (const variant of variants) {
    const phraseMatch = entry.searchText.includes(variant.needle);
    const terms = variant.terms.filter(term => entry.searchText.includes(term));
    const coverage = variant.terms.length ? terms.length / variant.terms.length : 0;
    // Partial keyword matches are useful for long briefs, but a lone generic
    // word from a long brief must not flood the results. Expose matched terms
    // so the caller can distinguish examples from exact intent matches.
    if (!phraseMatch && coverage < 0.5) continue;
    matchedQueries.push(variant.query);
    terms.forEach(term => matchedTerms.add(term));
    const labelMatches = terms.filter(term => entry.labelText.includes(term)).length;
    score = Math.max(score, (phraseMatch ? 20 : 0) + coverage * 10 + labelMatches / Math.max(1, variant.terms.length) * 3);
  }
  return matchedQueries.length ? { score, matchedQueries, matchedTerms: [...matchedTerms] } : null;
}

function parseSnapshot(serialized: string): Snapshot {
  if (Buffer.byteLength(serialized, "utf8") > MAX_CATALOG_BYTES) throw new PromptLibraryUnavailableError();
  const parsed = snapshotEnvelopeSchema.parse(JSON.parse(serialized));
  // Shared contracts use their own Zod version. Parse at the boundary rather
  // than combining schema instances from different Zod major versions.
  const sources = parsed.sources.map(source => promptLibrarySourceSchema.parse(source));
  const items = parsed.items.map(item => promptLibraryEntrySchema.parse(item));
  const sourceById = new Map(sources.map(source => [source.id, source]));
  if (sourceById.size !== sources.length) throw new PromptLibraryUnavailableError();
  const itemIds = new Set<string>();
  const sourceCounts = new Map<string, number>();
  for (const item of items) {
    if (itemIds.has(item.id) || sourceById.get(item.sourceId)?.status !== "available") {
      throw new PromptLibraryUnavailableError();
    }
    itemIds.add(item.id);
    sourceCounts.set(item.sourceId, (sourceCounts.get(item.sourceId) ?? 0) + 1);
  }
  for (const source of sources) {
    if (source.entryCount !== (sourceCounts.get(source.id) ?? 0)) throw new PromptLibraryUnavailableError();
  }
  const categories = [...new Set(items.map(item => item.category))].sort();
  if (categories.length > 40) throw new PromptLibraryUnavailableError();
  return {
    version: parsed.version,
    sources,
    categories,
    entries: items.map(item => ({
      item,
      searchText: normalizeSearch([item.title, item.prompt, ...item.tags, ...item.modelHints].join("\n")),
      labelText: normalizeSearch([item.title, item.category, ...item.tags].join("\n")),
    })),
  };
}

export function createPromptLibraryService(options: {
  /** Test seam only; never set from an HTTP request or a user-supplied URL. */
  readCatalog?: () => Promise<string>;
} = {}): PromptLibraryService {
  let cachedSnapshot: Promise<Snapshot> | undefined;
  const readCatalog = options.readCatalog ?? (() => readFile(promptLibraryCatalogUrl, "utf8"));
  function load(): Promise<Snapshot> {
    // Cache both success and failure for this process. Concurrent first reads
    // share one parse; invalid deployments cannot repeatedly consume CPU/I/O.
    cachedSnapshot ??= Promise.resolve().then(readCatalog).then(parseSnapshot).catch(() => {
      throw new PromptLibraryUnavailableError();
    });
    return cachedSnapshot;
  }
  return {
    async search(query) {
      const snapshot = await load();
      const needle = normalizeSearch(query.q.trim());
      const matched = snapshot.entries.filter(({ item, searchText }) => (
        (!query.source || item.sourceId === query.source)
        && (!query.category || item.category === query.category)
        && (!needle || searchText.includes(needle))
      ));
      const items = matched.slice(query.offset, query.offset + query.limit).map(entry => entry.item);
      // Parsing also clones the public result, so consumers cannot mutate the
      // process-wide snapshot or accidentally expose unrecognized JSON fields.
      return promptLibraryResponseSchema.parse({
        version: snapshot.version,
        items,
        total: matched.length,
        nextOffset: query.offset + items.length < matched.length ? query.offset + items.length : null,
        sources: snapshot.sources,
        categories: snapshot.categories,
      });
    },
    async searchForAgent(input) {
      // Validate here as well as at the tool boundary; internal callers must
      // not bypass the result/context limits with an oversized query.
      const query = promptLibraryAgentQuerySchema.parse(input);
      const snapshot = await load();
      const variants = [...new Set(query.queries.map(normalizeSearch))].map(needle => ({
        query: query.queries.find(value => normalizeSearch(value) === needle)!,
        needle,
        terms: termsForQuery(needle),
      }));
      const ranked = snapshot.entries.flatMap((entry, index) => {
        if (query.sources.length && !query.sources.includes(entry.item.sourceId)) return [];
        if (query.categories.length && !query.categories.includes(entry.item.category)) return [];
        const rank = rankEntry(entry, variants);
        return rank ? [{ entry, index, ...rank }] : [];
      }).sort((a, b) => b.score - a.score || b.matchedQueries.length - a.matchedQueries.length || a.index - b.index);
      const items = ranked.slice(query.offset, query.offset + query.limit).map(({ entry, matchedQueries, matchedTerms }) => {
        const { prompt, ...item } = entry.item;
        return {
          ...item,
          promptExcerpt: prompt.length > 360 ? `${prompt.slice(0, 359)}…` : prompt,
          promptLength: prompt.length,
          source: snapshot.sources.find(source => source.id === item.sourceId)!,
          matchedQueries,
          matchedTerms,
        };
      });
      return structuredClone({
        version: snapshot.version,
        items,
        total: ranked.length,
        nextOffset: query.offset + items.length < ranked.length ? query.offset + items.length : null,
        sources: snapshot.sources,
        categories: snapshot.categories,
        searchMode: "lexical_terms_and_query_variants" as const,
      });
    },
    async getById(id) {
      // IDs are opaque catalog keys, never paths or external URLs.
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return null;
      const snapshot = await load();
      const item = snapshot.entries.find(entry => entry.item.id === id)?.item;
      if (!item) return null;
      const source = snapshot.sources.find(source => source.id === item.sourceId);
      if (source?.status !== "available") return null;
      return structuredClone({ version: snapshot.version, item, source });
    },
  };
}
