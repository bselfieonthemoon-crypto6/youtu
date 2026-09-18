import { describe, expect, it, vi } from "vitest";
import { createPromptLibraryService, type PromptLibraryAgentQuery } from "./prompt-library-service.js";

const query: PromptLibraryAgentQuery = { queries: [], sources: [], categories: [], offset: 0, limit: 6 };
const source = (id: string, entryCount: number, status: "available" | "link_only" = "available") => ({
  id, name: id, entryCount, status, url: `https://example.org/${id}`, license: "MIT",
  attribution: `Attribution: ${id}`, note: status === "available" ? "Reviewed public reference" : "Third-party rights not cleared",
});
const entry = (id: string, sourceId: string, title: string, prompt: string) => ({
  id, sourceId, title, prompt, category: "海报", tags: ["设计"], sourceUrl: `https://example.org/${sourceId}/${id}`,
  modelHints: ["gpt-image-2"], requiresReference: false,
  imageUrl: `https://images.example.org/${id}.png`, previewImageUrls: [`https://images.example.org/${id}.png`],
});
function fixture() {
  return {
    version: "test-agent-1",
    sources: [source("source-a", 2), source("source-b", 2), source("link-only", 0, "link_only")],
    items: [
      entry("summer-cn", "source-a", "夏日饮品海报", "使用蓝色背景，夏日宣传饮品品牌。"),
      entry("other", "source-a", "纪念照片", "自然光下的合影。"),
      entry("summer-en", "source-b", "Summer drink poster", "Editorial typography with a refreshing drink in bright summer light."),
      entry("long", "source-b", "Package label", `Preserve exact wording. ${"Complete source text. ".repeat(100)}`),
    ],
  };
}
const service = () => createPromptLibraryService({ readCatalog: async () => JSON.stringify(fixture()) });

describe("Agent prompt library progressive search", () => {
  it("combines Chinese/English query variants across all permitted sources with source attribution and previews", async () => {
    const result = await service().searchForAgent({ ...query, queries: ["夏日 饮品 海报", "summer drink poster"] });
    expect(new Set(result.items.map(item => item.id))).toEqual(new Set(["summer-cn", "summer-en"]));
    expect(new Set(result.items.map(item => item.sourceId))).toEqual(new Set(["source-a", "source-b"]));
    for (const item of result.items) {
      expect(item.source.attribution).toContain(item.sourceId);
      expect(item.sourceUrl).toContain(item.id);
      expect(item.imageUrl).toContain(item.id);
      expect(item.previewImageUrls).toEqual([item.imageUrl]);
      expect(item.matchedTerms.length).toBeGreaterThan(0);
      expect(item).not.toHaveProperty("prompt");
    }
    expect(result.searchMode).toBe("lexical_terms_and_query_variants");
  });

  it("segments an unspaced Chinese brief and ranks useful multi-term results without a model call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
    try {
      const result = await service().searchForAgent({ ...query, queries: ["夏日饮品宣传海报"] });
      expect(result.items[0]?.id).toBe("summer-cn");
      expect(result.items[0]?.matchedTerms).toEqual(expect.arrayContaining(["夏日", "宣传", "海报"]));
      // ICU dictionaries can segment 饮品 as one word or two; both must retain
      // its constituent information instead of requiring spaces in the brief.
      expect(result.items[0]?.matchedTerms.join("")).toContain("饮品");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it("does not treat patterns as executable regular expressions", async () => {
    expect((await service().searchForAgent({ ...query, queries: [".*", "(a+)+$"] })).items).toEqual([]);
  });

  it("bounds summaries but retrieves the complete exact selected prompt, version and source", async () => {
    const catalog = service();
    const result = await catalog.searchForAgent({ ...query, queries: ["package label"] });
    const summary = result.items[0]!;
    expect(summary.promptExcerpt.length).toBeLessThanOrEqual(360);
    expect(summary.promptLength).toBeGreaterThan(summary.promptExcerpt.length);
    const detail = await catalog.getById(summary.id);
    expect(detail?.item.prompt).toBe(fixture().items.find(item => item.id === summary.id)?.prompt);
    expect(detail?.version).toBe(result.version);
    expect(detail?.source.status).toBe("available");
  });

  it("keeps stable pagination and deduplicates overlapping query variants", async () => {
    const catalog = service();
    const first = await catalog.searchForAgent({ ...query, queries: ["summer drink", "SUMMER drink", "drink"], limit: 1 });
    expect(first.total).toBe(1);
    expect(first.items[0]?.matchedQueries).toHaveLength(2);
    expect(first.nextOffset).toBeNull();
    const browse = await catalog.searchForAgent({ ...query, limit: 2 });
    const next = await catalog.searchForAgent({ ...query, offset: browse.nextOffset!, limit: 2 });
    expect(browse.nextOffset).toBe(2);
    expect(next.nextOffset).toBeNull();
    expect(new Set([...browse.items, ...next.items].map(item => item.id)).size).toBe(4);
    expect((await catalog.searchForAgent({ ...query, offset: 999 })).items).toEqual([]);
  });

  it("supports multiple exact source/category filters and never returns restricted contents", async () => {
    const catalog = service();
    expect((await catalog.searchForAgent({ ...query, sources: ["source-b"], categories: ["海报"] })).items.map(item => item.id)).toEqual(["summer-en", "long"]);
    const restricted = await catalog.searchForAgent({ ...query, sources: ["link-only"] });
    expect(restricted.items).toEqual([]);
    expect(restricted.sources.find(source => source.id === "link-only")).toMatchObject({ status: "link_only", entryCount: 0 });
    expect((await catalog.searchForAgent({ ...query, sources: ["missing"] })).items).toEqual([]);
    expect((await catalog.searchForAgent({ ...query, categories: ["missing"] })).items).toEqual([]);
  });

  it.each(["missing", "../catalog.json", "https://private.invalid/x", "", "x".repeat(161)])("rejects unavailable/non-ID detail key %s", async id => {
    expect(await service().getById(id)).toBeNull();
  });

  it.each([
    { limit: 13 }, { limit: 0 }, { offset: -1 }, { offset: 10001 }, { queries: Array(5).fill("logo") },
    { queries: ["x".repeat(161)] }, { queries: [" "] }, { sources: Array(9).fill("source-a") },
    { categories: Array(9).fill("海报") }, { fetchUrl: "https://example.org" },
  ])("validates service bounds, not just the tool schema: %j", async override => {
    await expect(service().searchForAgent({ ...query, ...override } as PromptLibraryAgentQuery)).rejects.toThrow();
  });

  it("clones search/detail data so one run cannot mutate references seen by another", async () => {
    const catalog = service();
    const first = await catalog.searchForAgent(query);
    first.items[0]!.source.attribution = "injected";
    first.items[0]!.previewImageUrls!.push("https://images.example.org/injected.png");
    const detail = await catalog.getById("summer-cn");
    detail!.item.prompt = "injected";
    detail!.source.status = "link_only";
    const restored = await catalog.getById("summer-cn");
    expect(restored?.item.prompt).toBe(fixture().items[0]!.prompt);
    expect(restored?.source.attribution).toBe("Attribution: source-a");
    expect(restored?.item.previewImageUrls).toHaveLength(1);
  });

  it("fails closed if restricted source entries are smuggled into the catalog", async () => {
    const data = fixture();
    data.items[0]!.sourceId = "link-only";
    const catalog = createPromptLibraryService({ readCatalog: async () => JSON.stringify(data) });
    await expect(catalog.searchForAgent(query)).rejects.toThrow("提示词库暂时不可用");
    await expect(catalog.getById("summer-cn")).rejects.toThrow("提示词库暂时不可用");
  });

  it("searches the actual deployed multi-source corpus and retrieves actual original case text", async () => {
    const catalog = createPromptLibraryService();
    const result = await catalog.searchForAgent({ ...query, queries: ["logo", "海报"], limit: 12 });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThanOrEqual(12);
    expect(result.sources.filter(source => source.status === "available").length).toBeGreaterThan(1);
    expect(result.items.some(item => item.imageUrl)).toBe(true);
    for (const source of result.sources) {
      const page = await catalog.searchForAgent({ ...query, sources: [source.id] });
      expect(page.total).toBe(source.entryCount);
      for (const item of page.items) {
        const detail = await catalog.getById(item.id);
        expect(detail?.item.prompt.length).toBe(item.promptLength);
        expect(detail?.source.id).toBe(source.id);
      }
    }
  });
});
