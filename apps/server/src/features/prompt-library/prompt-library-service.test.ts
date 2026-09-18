import { describe, expect, it, vi } from "vitest";
import {
  createPromptLibraryService,
  PromptLibraryUnavailableError,
  promptLibraryCatalogUrl,
  type PromptLibraryQuery,
} from "./prompt-library-service.js";

const query: PromptLibraryQuery = { q: "", source: "", category: "", offset: 0, limit: 24 };
const source = {
  id: "open-prompts", name: "Open prompts", url: "https://example.org/prompts", license: "MIT",
  attribution: "Original authors", status: "available", note: "Imported with attribution", entryCount: 2,
};
const baseEntry = {
  id: "first", title: "品牌 Logo", prompt: "Create a botanical LOGO; preserve [A-Z].",
  category: "Logo", tags: ["植物", "标志"], sourceId: source.id, sourceUrl: source.url,
  modelHints: ["gpt-image-2"], requiresReference: false,
};
const exampleImages = {
  imageUrl: "https://images.example.org/logo-cover.webp",
  previewImageUrls: ["https://images.example.org/logo-cover.webp", "https://images.example.org/logo-detail.png"],
};
function fixture() {
  return {
    version: "test-1",
    sources: [source, { ...source, id: "reference-links", name: "Link only", status: "link_only", entryCount: 0 }],
    items: [baseEntry, { ...baseEntry, id: "second", title: "夏日海报", category: "海报", prompt: "海报带有果汁。", tags: ["促销"], modelHints: ["Model B"] }],
  };
}

describe("prompt library local snapshot", () => {
  it("keeps full prompts, attribution and globally available categories in stable catalog order", async () => {
    const service = createPromptLibraryService({ readCatalog: async () => JSON.stringify(fixture()) });
    const result = await service.search(query);
    expect(result.items.map(item => item.id)).toEqual(["first", "second"]);
    expect(result.items[0]?.prompt).toBe(baseEntry.prompt);
    expect(result.sources[1]).toMatchObject({ status: "link_only", entryCount: 0, note: "Imported with attribution" });
    expect(result.categories).toEqual(["Logo", "海报"]);
    expect(result).toMatchObject({ total: 2, version: "test-1", nextOffset: null });
  });

  it("returns remote example image metadata unchanged without downloading or resolving the images", async () => {
    const data = fixture();
    Object.assign(data.items[0]!, exampleImages);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Prompt catalog reads must not download example images");
    });
    try {
      const service = createPromptLibraryService({ readCatalog: async () => JSON.stringify(data) });
      const result = await service.search(query);
      expect(result.items[0]).toEqual({ ...baseEntry, ...exampleImages });
      expect(result.items[1]?.imageUrl).toBeUndefined();
      expect(result.items[1]?.previewImageUrls).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("clones preview URL arrays so one response cannot change another user's catalog metadata", async () => {
    const data = fixture();
    Object.assign(data.items[0]!, exampleImages);
    const service = createPromptLibraryService({ readCatalog: async () => JSON.stringify(data) });
    const first = await service.search(query);
    first.items[0]!.previewImageUrls!.push("https://images.example.org/unreviewed.png");
    first.items[0]!.imageUrl = "https://images.example.org/unreviewed.png";
    expect((await service.search(query)).items[0]).toEqual({ ...baseEntry, ...exampleImages });
  });

  it.each([
    ["logo", "first"], ["果汁", "second"], ["植物", "first"], ["GPT-IMAGE-2", "first"], ["model b", "second"],
    ["[A-Z]", "first"],
  ])("searches title, full body, tags and model hints with literal case-insensitive query %s", async (q, id) => {
    const service = createPromptLibraryService({ readCatalog: async () => JSON.stringify(fixture()) });
    expect((await service.search({ ...query, q })).items.map(item => item.id)).toEqual([id]);
  });

  it("does not interpret patterns as regular expressions", async () => {
    const service = createPromptLibraryService({ readCatalog: async () => JSON.stringify(fixture()) });
    expect((await service.search({ ...query, q: ".*" })).total).toBe(0);
    expect((await service.search({ ...query, q: "(a+)+$" })).total).toBe(0);
  });

  it("combines category/source/search filters without narrowing global metadata", async () => {
    const service = createPromptLibraryService({ readCatalog: async () => JSON.stringify(fixture()) });
    const result = await service.search({ ...query, source: source.id, category: "海报", q: "果汁" });
    expect(result.items.map(item => item.id)).toEqual(["second"]);
    expect(result.categories).toEqual(["Logo", "海报"]);
    expect(result.sources).toHaveLength(2);
  });

  it.each([{ source: "unknown" }, { source: "reference-links" }, { category: "不存在" }])("returns an empty list for unavailable filters %s", async (filters) => {
    const service = createPromptLibraryService({ readCatalog: async () => JSON.stringify(fixture()) });
    expect(await service.search({ ...query, ...filters })).toMatchObject({ items: [], total: 0, nextOffset: null });
  });

  it("paginates stable ordering and terminates out-of-range offsets", async () => {
    const service = createPromptLibraryService({ readCatalog: async () => JSON.stringify(fixture()) });
    const page1 = await service.search({ ...query, limit: 1 });
    expect(page1).toMatchObject({ total: 2, nextOffset: 1 });
    expect(page1.items[0]?.id).toBe("first");
    const page2 = await service.search({ ...query, offset: 1, limit: 1 });
    expect(page2).toMatchObject({ total: 2, nextOffset: null });
    expect(page2.items[0]?.id).toBe("second");
    expect(await service.search({ ...query, offset: 1000 })).toMatchObject({ total: 2, items: [], nextOffset: null });
  });

  it("coalesces simultaneous first reads and caches the parsed snapshot", async () => {
    const readCatalog = vi.fn(async () => JSON.stringify(fixture()));
    const service = createPromptLibraryService({ readCatalog });
    await Promise.all([service.search(query), service.search({ ...query, q: "logo" })]);
    await service.search(query);
    expect(readCatalog).toHaveBeenCalledTimes(1);
  });

  it("does not let a caller mutate the cached catalog", async () => {
    const service = createPromptLibraryService({ readCatalog: async () => JSON.stringify(fixture()) });
    const first = await service.search(query);
    first.items[0]!.tags.push("changed");
    first.items[0]!.prompt = "changed";
    first.sources[0]!.name = "changed";
    expect((await service.search(query)).items[0]).toEqual(baseEntry);
    expect((await service.search(query)).sources[0]?.name).toBe(source.name);
  });

  it("drops unexpected entry/source fields and preserves source text solely as data", async () => {
    const data = fixture();
    Object.assign(data.items[0]!, { privateKey: "not-public", prompt: "<script>doNotExecute()</script>" });
    Object.assign(data.sources[0]!, { accessToken: "not-public" });
    const service = createPromptLibraryService({ readCatalog: async () => JSON.stringify(data) });
    const result = await service.search(query);
    expect(result.items[0]?.prompt).toBe("<script>doNotExecute()</script>");
    expect(JSON.stringify(result)).not.toContain("not-public");
  });

  it.each([
    { name: "invalid JSON", raw: "not json" },
    { name: "wrong container", raw: JSON.stringify({ data: [] }) },
    { name: "missing sources", raw: JSON.stringify({ ...fixture(), sources: [] }) },
    { name: "source count mismatch", raw: JSON.stringify({ ...fixture(), items: [] }) },
    { name: "duplicate source", raw: JSON.stringify({ ...fixture(), sources: [source, source] }) },
    { name: "duplicate entry", raw: JSON.stringify({ ...fixture(), items: [baseEntry, baseEntry] }) },
    { name: "link-only contents", raw: JSON.stringify({ ...fixture(), sources: [{ ...source, status: "link_only" }] }) },
    { name: "oversized prompt", raw: JSON.stringify({ ...fixture(), items: [{ ...baseEntry, prompt: "x".repeat(24001) }] }) },
    { name: "unsafe URL", raw: JSON.stringify({ ...fixture(), sources: [{ ...source, url: "javascript:alert(1)" }] }) },
    { name: "embedded credentials", raw: JSON.stringify({ ...fixture(), sources: [{ ...source, url: "https://secret@example.org/" }] }) },
    ...["http://images.example.org/preview.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "https://private:secret@images.example.org/preview.png", "https://127.0.0.1/private.png", "https://0x7f.0.0.1/private.png", "https://files.internal/private.png"].map(imageUrl => ({
      name: `unsafe example image ${imageUrl.split(":")[0]}`,
      raw: JSON.stringify({ ...fixture(), items: [{ ...baseEntry, imageUrl }, { ...baseEntry, id: "second" }] }),
    })),
    { name: "unsafe preview image", raw: JSON.stringify({ ...fixture(), items: [{ ...baseEntry, previewImageUrls: ["file:///private.png"] }, { ...baseEntry, id: "second" }] }) },
    { name: "oversized preview gallery", raw: JSON.stringify({ ...fixture(), items: [{ ...baseEntry, previewImageUrls: Array(9).fill(exampleImages.imageUrl) }, { ...baseEntry, id: "second" }] }) },
  ])("fails closed on $name without leaking source paths/data", async ({ raw }) => {
    const readCatalog = vi.fn(async () => raw);
    const service = createPromptLibraryService({ readCatalog });
    await expect(service.search(query)).rejects.toThrow(PromptLibraryUnavailableError);
    await expect(service.search(query)).rejects.toThrow("提示词库暂时不可用，请稍后重试。");
    expect(readCatalog).toHaveBeenCalledTimes(1);
  });

  it("hides filesystem errors", async () => {
    const service = createPromptLibraryService({ readCatalog: async () => { throw new Error("EACCES E:/private/provider-key"); } });
    await expect(service.search(query)).rejects.toThrow("提示词库暂时不可用，请稍后重试。");
  });

  it("locates data outside src/dist, independent of the process working directory", () => {
    expect(promptLibraryCatalogUrl.pathname.replaceAll("\\", "/")).toMatch(/\/apps\/server\/data\/prompt-library\/catalog\.json$/);
    const compiled = new URL("../../../data/prompt-library/catalog.json", "file:///app/apps/server/dist/features/prompt-library/prompt-library-service.js");
    expect(compiled.pathname).toBe("/app/apps/server/data/prompt-library/catalog.json");
  });
});
