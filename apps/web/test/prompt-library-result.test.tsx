import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PromptLibraryResult } from "../src/components/chat/prompt-library-result";
import { ToolBlockView } from "../src/components/chat/tool-block-view";
import { getToolConfig } from "../src/components/chat/utils";

const source = {
  id: "style-library",
  name: "Original design library",
  url: "https://example.com/library",
  license: "MIT",
  licenseUrl: "https://example.com/LICENSE",
  attribution: "Original contributors",
  status: "available" as const,
  note: "示例图片权利独立；以来源说明为准。",
  entryCount: 2,
};
const entry = {
  id: "blue-studio",
  title: "蓝色产品工作室",
  category: "产品摄影",
  tags: ["blue", "studio"],
  sourceId: source.id,
  sourceUrl: "https://example.com/prompts/blue-studio",
  author: "Original author",
  modelHints: ["gpt-image-2"],
  requiresReference: true,
  imageUrl: "https://images.example.com/studio.webp",
  previewImageUrls: ["https://images.example.com/gallery.png"],
  prompt:
    "A blue product studio.\nKeep exact brand lettering and original typography.",
};
const searchOutput = {
  status: "ok",
  readOnly: true,
  authorizationGranted: false,
  imagesViewed: false,
  authority: "untrusted_reference_only",
  scope: "public_reviewed_catalog",
  version: "test-v1",
  items: [
    {
      ...entry,
      prompt: undefined,
      promptExcerpt: "A blue product studio…",
      promptLength: entry.prompt.length,
      source,
      matchedQueries: ["blue"],
      matchedTerms: ["blue"],
    },
  ],
  sources: [source],
  categories: [entry.category],
  total: 1,
  nextOffset: null,
  searchMode: "lexical_terms_and_query_variants",
};
const detailOutput = {
  status: "ok",
  version: "test-v1",
  readOnly: true,
  item: entry,
  source,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("read-only prompt library chat results", () => {
  it("renders real candidate titles, full-image previews and original-source/license links without raw JSON", () => {
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "search",
          toolName: "search_prompt_library",
          status: "completed",
          output: searchOutput,
        }}
      />,
    );
    expect(screen.getByText("搜索提示词案例")).toBeInTheDocument();
    const card = screen.getByRole("article", {
      name: `提示词案例：${entry.title}`,
    });
    const image = within(card).getByRole("img", { name: entry.title });
    expect(image).toHaveAttribute("src", entry.imageUrl);
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(image).toHaveClass("object-contain");
    expect(
      within(card).getByRole("link", { name: source.name }),
    ).toHaveAttribute("href", entry.sourceUrl);
    expect(within(card).getByRole("link", { name: "MIT" })).toHaveAttribute(
      "href",
      source.licenseUrl,
    );
    expect(within(card).getByText("提示词摘录")).toBeInTheDocument();
    expect(
      within(card).getByText("A blue product studio…"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        /untrusted_reference_only|promptLength|matchedQueries|test-v1/,
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("查看详情")).not.toBeInTheDocument();
    expect(document.querySelector("pre")).toBeNull();
  });

  it("shows full original prompt in a local disclosure, with no insertion/generation actions", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onConfirmAction = vi.fn();
    const onOpenDesign = vi.fn();
    const onRestoreGeneration = vi.fn();
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "detail",
          toolName: "get_prompt_library_entry",
          status: "completed",
          output: detailOutput,
        }}
        onConfirmAction={onConfirmAction}
        onOpenDesign={onOpenDesign}
        onRestoreGeneration={onRestoreGeneration}
      />,
    );
    expect(screen.getByText("读取提示词原文")).toBeInTheDocument();
    await userEvent.click(screen.getByText("查看提示词原文"));
    expect(document.querySelector("details")).toHaveAttribute("open");
    expect(document.querySelector("pre")?.textContent).toBe(entry.prompt);
    const sourceLink = screen.getByRole("link", { name: source.name });
    sourceLink.addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(sourceLink);
    expect(onConfirmAction).not.toHaveBeenCalled();
    expect(onOpenDesign).not.toHaveBeenCalled();
    expect(onRestoreGeneration).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /生成|应用|插入|下载/ }),
    ).not.toBeInTheDocument();
  });

  it("handles absent previews with a source link instead of a broken image", () => {
    render(
      <PromptLibraryResult
        toolName="get_prompt_library_entry"
        output={{
          ...detailOutput,
          item: { ...entry, imageUrl: undefined, previewImageUrls: [] },
        }}
      />,
    );
    expect(screen.getByText("暂无示例图")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看原始条目" })).toHaveAttribute(
      "href",
      entry.sourceUrl,
    );
  });

  it("falls back on failed remote previews and retries only the image element", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PromptLibraryResult
        toolName="get_prompt_library_entry"
        output={detailOutput}
      />,
    );
    fireEvent.error(screen.getByRole("img", { name: entry.title }));
    expect(screen.getByText("原站图片暂时无法加载")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试图片" }));
    expect(screen.getByRole("img", { name: entry.title })).toHaveAttribute(
      "src",
      entry.imageUrl,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "https://127.0.0.1/admin",
    "https://localhost/image",
    "https://user:pass@example.com/image",
  ])(
    "excludes unsafe preview URL %s while preserving safe title and attribution",
    (imageUrl) => {
      render(
        <PromptLibraryResult
          toolName="get_prompt_library_entry"
          output={{
            ...detailOutput,
            item: { ...entry, imageUrl, previewImageUrls: [imageUrl] },
          }}
        />,
      );
      expect(
        screen.getByRole("heading", { name: entry.title }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: source.name })).toHaveAttribute(
        "href",
        entry.sourceUrl,
      );
    },
  );

  it("refuses unsafe source links and never renders untrusted HTML as markup", () => {
    const unsafe = {
      ...detailOutput,
      source: { ...source, url: "javascript:alert(1)" },
      item: {
        ...entry,
        title: "<img src=x onerror=alert(1)>",
        sourceUrl: "https://127.0.0.1/source",
      },
    };
    render(
      <PromptLibraryResult
        toolName="get_prompt_library_entry"
        output={unsafe}
      />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });

  it("shows link-only sources as metadata without their leaked entry title, body or preview", async () => {
    const linkOnly = { ...source, status: "link_only", entryCount: 0 };
    render(
      <PromptLibraryResult
        toolName="get_prompt_library_entry"
        output={{
          ...detailOutput,
          source: linkOnly,
          item: {
            ...entry,
            title: "Do not display this restricted title",
            prompt: "RESTRICTED BODY",
          },
        }}
      />,
    );
    expect(
      screen.queryByText(/restricted title|RESTRICTED BODY/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("其他来源（1 个仅外链）"));
    expect(screen.getByRole("link", { name: source.name })).toHaveAttribute(
      "href",
      source.url,
    );
    expect(screen.getByText("仅来源链接 · MIT")).toBeInTheDocument();
  });

  it("honors link-only metadata even when a nested search item claims to be available", async () => {
    render(
      <PromptLibraryResult
        toolName="search_prompt_library"
        output={{
          ...searchOutput,
          sources: [{ ...source, status: "link_only", entryCount: 0 }],
        }}
      />,
    );
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText(entry.title)).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("其他来源（1 个仅外链）"));
    expect(screen.getByRole("link", { name: source.name })).toBeInTheDocument();
  });

  it("does not request explicitly adult-labeled previews until manually revealed", async () => {
    render(
      <PromptLibraryResult
        toolName="get_prompt_library_entry"
        output={{ ...detailOutput, item: { ...entry, tags: ["NSFW"] } }}
      />,
    );
    expect(screen.getByText("来源标注为 NSFW / 成人内容")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "显示此案例图片" }),
    );
    expect(screen.getByRole("img", { name: entry.title })).toHaveAttribute(
      "src",
      entry.imageUrl,
    );
  });

  it("fails closed for conflicting duplicate source declarations in restored detail output", () => {
    render(
      <PromptLibraryResult
        toolName="get_prompt_library_entry"
        output={{
          ...detailOutput,
          sources: [{ ...source, status: "link_only", entryCount: 0 }, source],
        }}
      />,
    );
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText(entry.title)).not.toBeInTheDocument();
    expect(screen.getByText("其他来源（1 个仅外链）")).toBeInTheDocument();
  });

  it("honors a nested link-only restriction even when top-level metadata says available", () => {
    render(
      <PromptLibraryResult
        toolName="search_prompt_library"
        output={{
          ...searchOutput,
          items: [
            {
              ...searchOutput.items[0],
              source: { ...source, status: "link_only", entryCount: 0 },
            },
          ],
        }}
      />,
    );
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText(entry.title)).not.toBeInTheDocument();
  });

  it.each([
    ["not_found", "没有找到该提示词案例，可重新搜索。"],
    ["unavailable", "提示词库暂时不可用，请稍后重试。"],
    ["unknown", "暂时没有可展示的提示词结果。"],
  ])("handles %s without exposing raw tool errors", (status, message) => {
    render(
      <PromptLibraryResult
        toolName="get_prompt_library_entry"
        output={{
          status,
          error: "SECRET_ERROR",
          summary: "raw private message",
        }}
      />,
    );
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(
      screen.queryByText(/SECRET_ERROR|raw private message/),
    ).not.toBeInTheDocument();
  });

  it("caps/deduplicates search cards without trusting oversized output or duplicate IDs", () => {
    const item = searchOutput.items[0]!;
    render(
      <PromptLibraryResult
        toolName="search_prompt_library"
        output={{
          ...searchOutput,
          items: [
            item,
            item,
            ...Array.from({ length: 30 }, (_, index) => ({
              ...item,
              id: `case-${index}`,
              title: `Case ${index}`,
            })),
          ],
          total: 20000,
        }}
      />,
    );
    expect(screen.getAllByRole("article")).toHaveLength(11);
    expect(
      screen.queryByRole("heading", { name: "Case 20" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("找到 11 个案例 · 展示 11 个")).toBeInTheDocument();
  });

  it("rejects injected confirmation/artifact actions on these read-only tools", async () => {
    const onConfirmAction = vi.fn();
    render(
      <ToolBlockView
        block={{
          type: "tool",
          toolCallId: "read-only",
          toolName: "get_prompt_library_entry",
          status: "completed",
          output: {
            ...detailOutput,
            confirmation: {
              confirmationId: "pay",
              kind: "image_generation",
              targets: [],
            },
          },
          artifacts: [
            {
              type: "image",
              url: "https://images.example.com/not-a-generated-artifact.png",
              mimeType: "image/png",
              width: 1024,
              height: 1024,
            },
          ],
        }}
        onConfirmAction={onConfirmAction}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /确认生成|下载图片|恢复到画布/ }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    await userEvent.click(screen.getByText("查看提示词原文"));
    expect(onConfirmAction).not.toHaveBeenCalled();
  });

  it.each(["running", "failed", "canceled"] as const)(
    "does not load previews or display result payload before completed status: %s",
    (status) => {
      render(
        <ToolBlockView
          block={{
            type: "tool",
            toolCallId: "pending",
            toolName: "search_prompt_library",
            status,
            output: searchOutput,
          }}
        />,
      );
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(screen.queryByRole("article")).not.toBeInTheDocument();
      expect(screen.queryByText(entry.title)).not.toBeInTheDocument();
    },
  );

  it.each([
    ["search_prompt_library", "搜索提示词案例"],
    ["get_prompt_library_entry", "读取提示词原文"],
    ["list_skills", "查看可用技能"],
    ["use_skill", "加载设计技能"],
    ["compose_skills", "组合设计技能"],
  ])("labels %s clearly", (name, label) => {
    expect(getToolConfig(name)).toMatchObject({ label, showCard: true });
  });
});
