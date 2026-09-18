import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPromptLibraryService, promptLibraryCatalogUrl, type PromptLibraryQuery } from "./prompt-library-service.js";

const query: PromptLibraryQuery = { q: "", source: "", category: "", offset: 0, limit: 48 };

describe("reviewed prompt library deployment snapshot", () => {
  it("loads the actual bundled catalog offline from its default path and paginates every entry exactly once", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("This catalog must never access the network");
    });
    try {
      const service = createPromptLibraryService();
      const firstPage = await service.search(query);
      expect(firstPage.total).toBe(654);
      expect(firstPage.sources.filter(source => source.status === "available")).toHaveLength(4);
      expect(firstPage.sources.filter(source => source.status === "link_only")).toHaveLength(3);
      const ids = new Set<string>();
      const counts = new Map<string, number>();
      let illustratedEntries = 0;
      let page = firstPage;
      for (;;) {
        expect(page.items.length).toBeLessThanOrEqual(48);
        expect(page.sources).toEqual(firstPage.sources);
        expect(page.categories).toEqual(firstPage.categories);
        for (const item of page.items) {
          expect(ids.has(item.id)).toBe(false);
          ids.add(item.id);
          counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1);
          expect(item.prompt.trim().length).toBeGreaterThan(0);
          expect(item.prompt.length).toBeLessThanOrEqual(24000);
          if (item.imageUrl) {
            illustratedEntries++;
            expect(new URL(item.imageUrl).protocol).toBe("https:");
          }
          expect(item.previewImageUrls?.length ?? 0).toBeLessThanOrEqual(8);
          for (const imageUrl of item.previewImageUrls ?? []) {
            const parsedUrl = new URL(imageUrl);
            expect(parsedUrl.protocol).toBe("https:");
            expect(parsedUrl.username).toBe("");
            expect(parsedUrl.password).toBe("");
          }
          expect(firstPage.categories).toContain(item.category);
        }
        if (page.nextOffset === null) break;
        expect(page.nextOffset).toBe(ids.size);
        page = await service.search({ ...query, offset: page.nextOffset });
      }
      expect(ids.size).toBe(firstPage.total);
      expect(illustratedEntries).toBeGreaterThan(0);
      for (const source of firstPage.sources) {
        expect(counts.get(source.id) ?? 0).toBe(source.entryCount);
        const filtered = await service.search({ ...query, source: source.id });
        expect(filtered.total).toBe(source.entryCount);
        expect(filtered.items.every(item => item.sourceId === source.id)).toBe(true);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("matches the reviewed import report and preserves each complete stored prompt", async () => {
    const rawCatalog = JSON.parse(await readFile(promptLibraryCatalogUrl, "utf8")) as { version: string; items: Array<{ id: string; prompt: string; imageUrl?: string; previewImageUrls?: string[] }> };
    const review = JSON.parse(await readFile(new URL("./import-report.json", promptLibraryCatalogUrl), "utf8")) as {
      registryRevision: string; catalogSha256: string; importedTotal: number;
    };
    expect(review.registryRevision).toBe("bc5dd581b2d910209b965b9e77f47ff48a9eddcc");
    expect(createHash("sha256").update(JSON.stringify(rawCatalog)).digest("hex")).toBe(review.catalogSha256);
    expect(rawCatalog.items).toHaveLength(review.importedTotal);
    const service = createPromptLibraryService();
    const first = await service.search({ ...query, limit: 1 });
    expect(first.version).toBe(rawCatalog.version);
    expect(first.items[0]?.prompt).toBe(rawCatalog.items[0]?.prompt);
    const longest = rawCatalog.items.reduce((a, b) => a.prompt.length >= b.prompt.length ? a : b);
    const index = rawCatalog.items.findIndex(item => item.id === longest.id);
    const page = await service.search({ ...query, offset: index, limit: 1 });
    expect(page.items[0]?.prompt).toBe(longest.prompt);
  });

  it("preserves every stored example image URL through the public response schema, without an image download route", async () => {
    const rawCatalog = JSON.parse(await readFile(promptLibraryCatalogUrl, "utf8")) as {
      items: Array<{ id: string; imageUrl?: string; previewImageUrls?: string[] }>;
    };
    const service = createPromptLibraryService();
    for (let offset = 0; offset < rawCatalog.items.length; offset += 48) {
      const page = await service.search({ ...query, offset });
      for (let index = 0; index < page.items.length; index++) {
        const raw = rawCatalog.items[offset + index]!;
        const item = page.items[index]!;
        expect(item.id).toBe(raw.id);
        expect(item.imageUrl).toEqual(raw.imageUrl);
        expect(item.previewImageUrls).toEqual(raw.previewImageUrls);
      }
    }
  });
});
