import { afterEach, describe, expect, it, vi } from "vitest";

import {
  composeLibraryPrompt,
  fetchPromptLibrary,
} from "../src/lib/prompt-library-api";

afterEach(() => vi.unstubAllGlobals());

const result = {
  version: "test",
  items: [],
  sources: [],
  categories: [],
  total: 0,
  nextOffset: null,
};

describe("prompt library API", () => {
  it("authenticates, encodes filters, paginates and forwards cancellation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    expect(
      await fetchPromptLibrary(
        "test-token",
        {
          q: " 红色&海报 ",
          category: "品牌设计",
          source: "test-source",
          offset: 24,
          limit: 24,
        },
        controller.signal,
      ),
    ).toEqual(result);
    const [address, options] = fetchMock.mock.calls[0]!;
    const url = new URL(address);
    expect(url.pathname).toBe("/api/prompt-library");
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      q: "红色&海报",
      category: "品牌设计",
      source: "test-source",
      offset: "24",
      limit: "24",
    });
    expect(options.headers).toEqual({ Authorization: "Bearer test-token" });
    expect(options.signal).toBe(controller.signal);
    expect(options.method).toBeUndefined();
  });

  it("does not expose server internals and explains expired sessions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("secret", { status: 401 })),
    );
    await expect(fetchPromptLibrary("token")).rejects.toThrow("登录已过期");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("private-stack", { status: 500 })),
    );
    await expect(fetchPromptLibrary("token")).rejects.toThrow(
      "提示词库暂时无法加载",
    );
  });

  it("rejects invalid catalog payloads before rendering", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ ...result, items: [{ title: "missing fields" }] }),
          ),
        ),
    );
    await expect(fetchPromptLibrary("token")).rejects.toThrow("数据格式异常");
  });

  it("replaces exactly, appends with a paragraph break and preserves meaningful whitespace", () => {
    expect(composeLibraryPrompt("draft", "  original text\n", "replace")).toBe(
      "  original text\n",
    );
    expect(
      composeLibraryPrompt("  Keep my logo. \n", " Render blue.\n", "append"),
    ).toBe("  Keep my logo.\n\nRender blue.\n");
    expect(composeLibraryPrompt("  ", "original", "append")).toBe("original");
  });
});
