import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PromptLibraryEntry, PromptLibraryResponse } from "@loomic/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromptLibraryDialog } from "../src/components/prompt-library/prompt-library-dialog";
import { fetchPromptLibrary } from "../src/lib/prompt-library-api";

vi.mock("../src/lib/prompt-library-api", () => ({
  fetchPromptLibrary: vi.fn(),
}));

const entry: PromptLibraryEntry = {
  id: "logo-1",
  title: "简洁品牌标志",
  prompt:
    "Create a precise minimal logo.\nKeep the original Chinese lettering.",
  category: "品牌设计",
  tags: ["logo"],
  sourceId: "licensed-source",
  sourceUrl: "https://example.com/prompt/1",
  author: "Designer",
  modelHints: ["GPT Image"],
  requiresReference: false,
};
const response: PromptLibraryResponse = {
  version: "test",
  items: [entry],
  total: 1,
  nextOffset: null,
  sources: [
    {
      id: "licensed-source",
      name: "Licensed collection",
      url: "https://example.com",
      license: "MIT",
      licenseUrl: "https://example.com/license",
      attribution: "Original authors",
      status: "available",
      note: "文本授权已核查；图片授权独立。",
      entryCount: 1,
    },
    {
      id: "external-source",
      name: "External collection",
      url: "https://example.net",
      license: "待确认",
      attribution: "External authors",
      status: "link_only",
      note: "未导入文本或图片。",
      entryCount: 0,
    },
  ],
  categories: ["品牌设计", "宣传图"],
};

beforeEach(() =>
  vi.mocked(fetchPromptLibrary).mockReset().mockResolvedValue(response),
);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(props: Partial<Parameters<typeof PromptLibraryDialog>[0]> = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(
    <PromptLibraryDialog
      accessToken="token"
      currentPrompt=""
      onApply={onApply}
      onClose={onClose}
      {...props}
    />,
  );
  return { onApply, onClose };
}

describe("prompt library dialog", () => {
  it("does not request explicitly labeled previews until confirmation and remembers only that entry in this session", async () => {
    const first = {
      ...entry,
      title: "Editorial (NSFW)",
      imageUrl: "https://example.com/marked-one.png",
      previewImageUrls: [
        "https://example.com/marked-one.png",
        "https://example.com/marked-two.png",
      ],
    };
    const second = {
      ...entry,
      id: "marked-2",
      title: "成人内容 · 第二个案例",
      imageUrl: "https://example.com/other.png",
    };
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = observe;
        disconnect() {}
      },
    );
    vi.mocked(fetchPromptLibrary).mockResolvedValue({
      ...response,
      items: [first, second],
      total: 2,
    });
    const { onApply, onClose } = setup();
    await screen.findByRole("button", { name: `查看提示词：${first.title}` });
    expect(screen.queryByRole("img")).toBeNull();
    expect(observe).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: `查看提示词：${first.title}` }),
    );
    let details = within(
      screen.getByRole("complementary", { name: "提示词详情" }),
    );
    expect(
      details.getByText(first.prompt, { normalizer: (value) => value }),
    ).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(observe).not.toHaveBeenCalled();
    await userEvent.click(
      details.getByRole("button", { name: "显示此案例图片" }),
    );
    expect(details.getByRole("img").getAttribute("src")).toBe(first.imageUrl);
    expect(observe).toHaveBeenCalledOnce();
    expect(
      screen.getAllByRole("button", { name: "显示此案例图片" }),
    ).toHaveLength(1);
    await userEvent.click(
      details.getByRole("button", { name: "查看示例图 2" }),
    );
    fireEvent.load(details.getByRole("img"));
    await userEvent.click(
      details.getByRole("button", { name: "放大查看示例图" }),
    );
    expect(
      screen
        .getByRole("img", { name: `${first.title} · 放大示例 2` })
        .getAttribute("src"),
    ).toBe("https://example.com/marked-two.png");
    await userEvent.click(screen.getByRole("button", { name: "关闭放大图片" }));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: `查看提示词：${second.title}` }),
    );
    details = within(screen.getByRole("complementary", { name: "提示词详情" }));
    expect(details.queryByRole("img")).toBeNull();
    expect(
      details.getByRole("button", { name: "显示此案例图片" }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: `查看提示词：${first.title}` }),
    );
    details = within(screen.getByRole("complementary", { name: "提示词详情" }));
    expect(
      details.queryByRole("button", { name: "显示此案例图片" }),
    ).toBeNull();
    expect(details.getByRole("img").getAttribute("src")).toBe(first.imageUrl);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索提示词" }), {
      target: { value: "Editorial" },
    });
    await userEvent.click(
      await screen.findByRole("button", { name: `查看提示词：${first.title}` }),
    );
    details = within(screen.getByRole("complementary", { name: "提示词详情" }));
    expect(
      details.queryByRole("button", { name: "显示此案例图片" }),
    ).toBeNull();
    await userEvent.click(
      details.getByRole("button", { name: "使用此提示词" }),
    );
    expect(onApply).toHaveBeenCalledExactlyOnceWith(first, "replace");
  });

  it("allows explicit card reveal without selecting, remains lazy and resets after closing the library", async () => {
    const marked = {
      ...entry,
      tags: ["NSFW"],
      imageUrl: "https://example.com/marked.png",
    };
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = observe;
        disconnect() {}
      },
    );
    vi.mocked(fetchPromptLibrary).mockResolvedValue({
      ...response,
      items: [marked],
    });
    setup();
    await userEvent.click(
      await screen.findByRole("button", { name: "显示此案例图片" }),
    );
    expect(observe).toHaveBeenCalledOnce();
    expect(screen.queryByRole("img")).toBeNull();
    expect(
      screen.queryByRole("complementary", { name: "提示词详情" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "显示此案例图片" })).toBeNull();
    cleanup();
    observe.mockClear();
    setup();
    await screen.findByRole("button", { name: "显示此案例图片" });
    expect(observe).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("does not block normal examples because of unmarked prompt text or broaden link-only permissions", async () => {
    const normal = {
      ...entry,
      prompt: "NSFW marker occurs only inside quoted prompt content",
      imageUrl: "https://example.com/normal.png",
    };
    const linkOnly = {
      ...entry,
      id: "blocked-source",
      title: "NSFW source example",
      sourceId: "external-source",
      imageUrl: "https://example.net/image.png",
    };
    vi.mocked(fetchPromptLibrary).mockResolvedValue({
      ...response,
      items: [normal, linkOnly],
    });
    setup();
    await userEvent.click(
      await screen.findByRole("button", {
        name: `查看提示词：${normal.title}`,
      }),
    );
    expect(
      within(screen.getByRole("complementary", { name: "提示词详情" }))
        .getByRole("img")
        .getAttribute("src"),
    ).toBe(normal.imageUrl);
    expect(screen.queryByRole("button", { name: "显示此案例图片" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: `查看提示词：${linkOnly.title}` }),
    );
    expect(
      within(
        screen.getByRole("complementary", { name: "提示词详情" }),
      ).queryByRole("img"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "显示此案例图片" })).toBeNull();
  });

  it("shows original prompt, model caveat and verified source before explicit application", async () => {
    const { onApply } = setup();
    await userEvent.click(
      await screen.findByRole("button", { name: `查看提示词：${entry.title}` }),
    );
    expect(
      within(
        screen.getByRole("complementary", { name: "提示词详情" }),
      ).getByText(entry.prompt, { normalizer: (value) => value }).textContent,
    ).toBe(entry.prompt);
    expect(screen.getByText("GPT Image")).toBeTruthy();
    expect(screen.getByText(/不保证在所有模型上得到相同效果/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "MIT" }).getAttribute("href")).toBe(
      "https://example.com/license",
    );
    expect(onApply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "使用此提示词" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith(entry, "replace");
  });

  it.each(["替换当前提示词", "追加到末尾"])(
    "requires an explicit choice for existing text: %s",
    async (label) => {
      const { onApply } = setup({ currentPrompt: "Keep my draft" });
      await userEvent.click(
        await screen.findByRole("button", {
          name: `查看提示词：${entry.title}`,
        }),
      );
      expect(screen.queryByRole("button", { name: "使用此提示词" })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: label }));
      expect(onApply).toHaveBeenCalledExactlyOnceWith(
        entry,
        label === "追加到末尾" ? "append" : "replace",
      );
    },
  );

  it("informs reference-image requirements without silently adding a reference", async () => {
    vi.mocked(fetchPromptLibrary).mockResolvedValue({
      ...response,
      items: [{ ...entry, requiresReference: true }],
    });
    setup();
    await userEvent.click(
      await screen.findByRole("button", { name: `查看提示词：${entry.title}` }),
    );
    expect(
      screen.getByText(/需参考图，请在支持参考图的改图入口使用/),
    ).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("cannot apply while the node is generating", async () => {
    const { onApply } = setup({ disabled: true });
    await userEvent.click(
      await screen.findByRole("button", { name: `查看提示词：${entry.title}` }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "使用此提示词",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "使用此提示词" }));
    expect(onApply).not.toHaveBeenCalled();
  });

  it("treats link-only sources as links, including a malformed item in such a source", async () => {
    vi.mocked(fetchPromptLibrary).mockResolvedValue({
      ...response,
      items: [
        {
          ...entry,
          sourceId: "external-source",
          imageUrl: "https://example.net/private.png",
        },
      ],
    });
    const { onApply } = setup();
    await userEvent.click(
      await screen.findByRole("button", { name: `查看提示词：${entry.title}` }),
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "使用此提示词",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByRole("link", { name: "External collection" }),
    ).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("shows all sources and explains link-only filtering", async () => {
    setup();
    await screen.findByRole("button", { name: `查看提示词：${entry.title}` });
    await userEvent.click(screen.getByRole("button", { name: "来源与授权" }));
    expect(screen.getByText("仅提供来源链接，未导入内容")).toBeTruthy();
    vi.mocked(fetchPromptLibrary).mockResolvedValue({
      ...response,
      items: [],
      total: 0,
    });
    fireEvent.change(screen.getByRole("combobox", { name: "提示词来源" }), {
      target: { value: "external-source" },
    });
    await screen.findByText("此来源仅提供外部链接");
    expect(fetchPromptLibrary).toHaveBeenLastCalledWith(
      "token",
      { q: "", source: "external-source", category: "" },
      expect.any(AbortSignal),
    );
  });

  it("cancels earlier searches and ignores stale responses", async () => {
    const resolvers: Array<(value: PromptLibraryResponse) => void> = [];
    vi.mocked(fetchPromptLibrary).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    setup();
    await waitFor(() => expect(resolvers.length).toBe(1));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索提示词" }), {
      target: { value: "poster" },
    });
    await waitFor(() => expect(resolvers.length).toBe(2));
    expect(vi.mocked(fetchPromptLibrary).mock.calls[0]?.[2]?.aborted).toBe(
      true,
    );
    resolvers[1]!({
      ...response,
      items: [{ ...entry, id: "poster-2", title: "最新海报" }],
    });
    await screen.findByRole("button", { name: "查看提示词：最新海报" });
    resolvers[0]!(response);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: `查看提示词：${entry.title}` }),
      ).toBeNull(),
    );
  });

  it("retries errors, shows empty state and supports clearing filters", async () => {
    vi.mocked(fetchPromptLibrary).mockRejectedValueOnce(
      new Error("网络暂不可用"),
    );
    setup();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "网络暂不可用",
    );
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("button", { name: `查看提示词：${entry.title}` });
    vi.mocked(fetchPromptLibrary).mockResolvedValue({
      ...response,
      items: [],
      total: 0,
    });
    fireEvent.change(screen.getByRole("textbox", { name: "搜索提示词" }), {
      target: { value: "not found" },
    });
    await screen.findByText("没有找到匹配的提示词");
    vi.mocked(fetchPromptLibrary).mockResolvedValue(response);
    await userEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    await screen.findByRole("button", { name: `查看提示词：${entry.title}` });
  });

  it("paginates without duplicate cards and keeps the selected detail", async () => {
    vi.mocked(fetchPromptLibrary)
      .mockResolvedValueOnce({ ...response, total: 3, nextOffset: 24 })
      .mockResolvedValue({
        ...response,
        total: 3,
        items: [entry, { ...entry, id: "second", title: "另一种设计" }],
      });
    setup();
    await userEvent.click(
      await screen.findByRole("button", { name: `查看提示词：${entry.title}` }),
    );
    await userEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await screen.findByRole("button", { name: "查看提示词：另一种设计" });
    expect(
      screen.getAllByRole("button", { name: `查看提示词：${entry.title}` }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("complementary", { name: "提示词详情" }),
    ).toBeTruthy();
    expect(fetchPromptLibrary).toHaveBeenLastCalledWith(
      "token",
      { q: "", source: "", category: "", offset: 24 },
      expect.any(AbortSignal),
    );
  });

  it("contains keyboard and pointer interactions, closes explicitly and does not apply", async () => {
    const parentKey = vi.fn();
    const parentPointer = vi.fn();
    const onClose = vi.fn();
    const onApply = vi.fn();
    render(
      <div onKeyDown={parentKey} onPointerDown={parentPointer}>
        <PromptLibraryDialog
          accessToken="token"
          currentPrompt=""
          onClose={onClose}
          onApply={onApply}
        />
      </div>,
    );
    const search = screen.getByRole("textbox", { name: "搜索提示词" });
    expect(search.getAttribute("maxlength")).toBe("160");
    fireEvent.keyDown(search, { key: "Delete" });
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.pointerDown(search);
    expect(parentKey).not.toHaveBeenCalled();
    expect(parentPointer).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "关闭提示词库" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("closes the library with Escape without applying a prompt", async () => {
    const { onClose, onApply } = setup();
    await screen.findByRole("button", { name: `查看提示词：${entry.title}` });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "搜索提示词" }), {
      key: "Escape",
      code: "Escape",
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("loads source images only inside the list viewport and offers real retry without losing apply", async () => {
    let notify: IntersectionObserverCallback | undefined;
    let target: Element | undefined;
    let options: IntersectionObserverInit | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          callback: IntersectionObserverCallback,
          init: IntersectionObserverInit,
        ) {
          notify = callback;
          options = init;
        }
        observe(element: Element) {
          target = element;
        }
        disconnect() {}
      },
    );
    vi.mocked(fetchPromptLibrary).mockResolvedValue({
      ...response,
      items: [{ ...entry, imageUrl: "https://example.com/preview.png" }],
    });
    const { onApply } = setup({ accessToken: "private-session-token" });
    await screen.findByRole("button", { name: `查看提示词：${entry.title}` });
    expect(screen.queryByRole("img")).toBeNull();
    expect(options?.root).toBe(
      screen.getByRole("region", { name: "提示词列表" }),
    );
    expect(options?.rootMargin).toBe("0px");
    act(() =>
      notify!(
        [
          {
            target,
            isIntersecting: true,
            intersectionRatio: 1,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      ),
    );
    const img = screen.getByRole("img", { name: entry.title });
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("class")).toContain("object-contain");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img.getAttribute("src")).toBe("https://example.com/preview.png");
    expect(img.outerHTML).not.toContain("private-session-token");
    fireEvent.error(img);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("原站图片暂时无法加载")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "重试图片" }));
    expect(
      screen.queryByRole("complementary", { name: "提示词详情" }),
    ).toBeNull();
    expect(screen.getByRole("img").getAttribute("src")).toBe(
      "https://example.com/preview.png",
    );
    await userEvent.click(
      screen.getByRole("button", { name: `查看提示词：${entry.title}` }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "使用此提示词",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "使用此提示词" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith(
      { ...entry, imageUrl: "https://example.com/preview.png" },
      "replace",
    );
  });

  it("shows a selected gallery image, switches without prefetching and isolates zoom Escape", async () => {
    const illustrated = {
      ...entry,
      imageUrl: "https://example.com/one.png",
      previewImageUrls: [
        "https://example.com/one.png",
        "https://example.com/two.png",
      ],
    };
    vi.mocked(fetchPromptLibrary).mockResolvedValue({
      ...response,
      items: [
        illustrated,
        {
          ...entry,
          id: "second",
          title: "另一张海报",
          imageUrl: "https://example.com/next.png",
        },
      ],
    });
    const { onApply, onClose } = setup();
    await userEvent.click(
      await screen.findByRole("button", { name: `查看提示词：${entry.title}` }),
    );
    const details = within(
      screen.getByRole("complementary", { name: "提示词详情" }),
    );
    expect(details.getByRole("img").getAttribute("src")).toBe(
      illustrated.imageUrl,
    );
    expect(
      document.querySelector('img[src="https://example.com/two.png"]'),
    ).toBeNull();
    await userEvent.click(
      details.getByRole("button", { name: "查看示例图 2" }),
    );
    expect(details.getByRole("img").getAttribute("src")).toBe(
      "https://example.com/two.png",
    );
    fireEvent.load(details.getByRole("img"));
    await userEvent.click(
      details.getByRole("button", { name: "放大查看示例图" }),
    );
    const closeZoom = screen.getByRole("button", { name: "关闭放大图片" });
    expect(
      screen
        .getByRole("img", { name: `${entry.title} · 放大示例 2` })
        .getAttribute("src"),
    ).toBe("https://example.com/two.png");
    fireEvent.keyDown(closeZoom, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "关闭放大图片" })).toBeNull(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "查看提示词：另一张海报" }),
    );
    expect(
      within(screen.getByRole("complementary", { name: "提示词详情" }))
        .getByRole("img")
        .getAttribute("src"),
    ).toBe("https://example.com/next.png");
    expect(screen.queryByRole("button", { name: "查看示例图 2" })).toBeNull();
  });
});
