// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AdminHomeContentListResponse,
  AdminHomeContentOverviewResponse,
  AdminHomeDiscoveryCase,
  AdminHomeExample,
} from "@loomic/shared";

import {
  AdminHomeContentSection,
  categoryAccent,
  categoryDataType,
  formatMentionLines,
  homeContentKindLabel,
  parseImageUrlLines,
  parseMentionLines,
} from "../src/components/admin/admin-home-content-section";

const { overviewMock, itemsMock, upsertCaseMock, upsertExampleMock, upsertCategoryMock,
  toggleMock, reorderMock, reorderCategoriesMock, deleteMock } = vi.hoisted(() => ({
  overviewMock: vi.fn(),
  itemsMock: vi.fn(),
  upsertCaseMock: vi.fn(),
  upsertExampleMock: vi.fn(),
  upsertCategoryMock: vi.fn(),
  toggleMock: vi.fn(),
  reorderMock: vi.fn(),
  reorderCategoriesMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchAdminHomeContentOverview: overviewMock,
  fetchAdminHomeContentItems: itemsMock,
  upsertAdminHomeDiscoveryCase: upsertCaseMock,
  upsertAdminHomeExample: upsertExampleMock,
  upsertAdminHomeCategory: upsertCategoryMock,
  setAdminHomeContentActive: toggleMock,
  reorderAdminHomeContent: reorderMock,
  reorderAdminHomeCategories: reorderCategoriesMock,
  deleteAdminHomeContent: deleteMock,
}));

const CASE_A = "case-a";
const CASE_B = "case-b";
const EXAMPLE_ID = "33333333-3333-4333-8333-333333333333";

const overview: AdminHomeContentOverviewResponse = {
  discovery: {
    categories: [
      { key: "branding-design", label: "品牌设计", sortOrder: 0, isActive: true,
        updatedAt: "2026-09-01T00:00:00.000Z", itemCount: 2, activeItemCount: 1 },
      { key: "illustration", label: "插画", sortOrder: 1, isActive: false,
        updatedAt: "2026-09-01T00:00:00.000Z", itemCount: 0, activeItemCount: 0 },
    ],
    itemCount: 2, activeItemCount: 1,
  },
  example: {
    categories: [
      { key: "branding", label: "Branding", dataType: "Branding", accent: "special", sortOrder: 0,
        isActive: true, updatedAt: "2026-09-01T00:00:00.000Z", itemCount: 1, activeItemCount: 1 },
    ],
    itemCount: 1, activeItemCount: 1,
  },
};

const caseA: AdminHomeDiscoveryCase = {
  id: CASE_A, categoryKey: "branding-design", title: "品牌案例 A", coverImageUrl: "https://example.com/a.png",
  authorName: "Studio", authorAvatarUrl: "", caseUrl: "", seedPrompt: "请参考 A", viewCount: 5, likeCount: 1,
  sortOrder: 0, isActive: true, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
  categoryIsActive: true,
};
const caseB: AdminHomeDiscoveryCase = {
  ...caseA, id: CASE_B, title: "品牌案例 B", sortOrder: 1, isActive: false, categoryIsActive: false,
};
const exampleRow: AdminHomeExample = {
  id: EXAMPLE_ID, categoryKey: "branding", title: "示例一", prompt: "提示词", imageUrls: ["https://example.com/p1.png"],
  inputMentions: [{ name: "Logo", type: "image", imgSrc: "https://example.com/l.png" }],
  sortOrder: 0, isActive: true, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
  categoryIsActive: true,
};

const caseList: AdminHomeContentListResponse = { kind: "discovery_case", total: 2, items: [caseA, caseB] };
const exampleList: AdminHomeContentListResponse = { kind: "example_example", total: 1, items: [exampleRow] };

async function renderReady() {
  render(<AdminHomeContentSection accessToken="token" />);
  await screen.findByTestId("admin-home-table");
}

describe("admin home content section", () => {
  beforeEach(() => {
    overviewMock.mockReset().mockResolvedValue(overview);
    itemsMock.mockReset().mockImplementation(async (_token: string, filters: { kind: string }) =>
      (filters.kind === "discovery_case" ? caseList : exampleList));
    upsertCaseMock.mockReset().mockResolvedValue({ id: CASE_A, created: false, sortOrder: 0 });
    upsertExampleMock.mockReset().mockResolvedValue({ id: EXAMPLE_ID, created: true, sortOrder: 1 });
    upsertCategoryMock.mockReset().mockResolvedValue({ key: "branding-design", kind: "discovery_category", created: false, sortOrder: 0 });
    toggleMock.mockReset().mockResolvedValue({ hiddenItems: 0, wasActive: true });
    reorderMock.mockReset().mockResolvedValue({ ordered: 2 });
    reorderCategoriesMock.mockReset().mockResolvedValue({ ordered: 2 });
    deleteMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  it("shows both libraries' categories with publish state and live counts", async () => {
    await renderReady();
    const panel = screen.getByTestId("admin-home-categories");
    expect(within(panel).getByText("品牌设计")).toBeInTheDocument();
    expect(within(panel).getByText("1/2 条已上架")).toBeInTheDocument();
    expect(within(panel).getByText("已下架（其下内容一并隐藏）")).toBeInTheDocument();
    // The list is scoped to the first category so reordering has an exact set.
    await waitFor(() => expect(itemsMock).toHaveBeenLastCalledWith("token",
      { kind: "discovery_case", categoryKey: "branding-design", limit: 200 }));
  });

  it("lists entries with publish state and flags one whose category is unpublished", async () => {
    await renderReady();
    const table = screen.getByTestId("admin-home-table");
    expect(within(table).getByText("品牌案例 A")).toBeInTheDocument();
    expect(within(table).getByText("已上架")).toBeInTheDocument();
    expect(within(table).getByText("已下架")).toBeInTheDocument();
    expect(within(table).getByTestId("admin-home-hidden")).toHaveTextContent("分类已下架");
    expect(screen.getByText(/共 2 条匹配，当前显示 2 条/)).toBeInTheDocument();
  });

  it("switches to the examples library and shows its images and mentions in the editor", async () => {
    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: "示例" }));
    const table = await screen.findByTestId("admin-home-table");
    await within(table).findByText("示例一");
    await waitFor(() => expect(itemsMock).toHaveBeenLastCalledWith("token",
      { kind: "example_example", categoryKey: "branding", limit: 200 }));

    await userEvent.click(within(table).getByRole("button", { name: "编辑" }));
    const form = screen.getByTestId("admin-home-form");
    expect(within(form).getByLabelText("表单预览图")).toHaveValue("https://example.com/p1.png");
    expect(within(form).getByLabelText("表单输入素材")).toHaveValue("Logo | image | https://example.com/l.png");
  });

  it("filters on submit and disables reordering while a filter hides entries", async () => {
    await renderReady();
    await userEvent.selectOptions(screen.getByLabelText("内容上架状态"), "true");
    await userEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => expect(itemsMock).toHaveBeenLastCalledWith("token",
      { kind: "discovery_case", categoryKey: "branding-design", active: true, limit: 200 }));

    const table = screen.getByTestId("admin-home-table");
    expect(within(table).getAllByRole("button", { name: "上移" })[0]).toBeDisabled();
    expect(screen.getByText(/排序需要看到该分类的全部条目/)).toBeInTheDocument();
  });

  it("unpublishes an entry only after an inline reason and confirmation", async () => {
    toggleMock.mockResolvedValue({ hiddenItems: 0, wasActive: true });
    await renderReady();
    const table = screen.getByTestId("admin-home-table");
    await userEvent.click(within(table).getAllByRole("button", { name: "下架" })[0]!);

    const confirm = screen.getByTestId("admin-home-confirm");
    expect(confirm).toHaveTextContent("下架");
    expect(confirm).toHaveTextContent("品牌案例 A");
    const button = within(confirm).getByRole("button", { name: "确认" });
    expect(button).toBeDisabled();
    await userEvent.type(within(confirm).getByLabelText("操作原因"), "封面图需要更换");
    await userEvent.click(button);

    expect(toggleMock).toHaveBeenCalledWith("token",
      { kind: "discovery_case", entityId: CASE_A, isActive: false, reason: "封面图需要更换" });
    expect(await screen.findByTestId("admin-home-feedback")).toHaveTextContent("已更新上架状态");
  });

  it("reports how many entries a category unpublish hides", async () => {
    toggleMock.mockResolvedValue({ hiddenItems: 2, wasActive: true });
    await renderReady();
    const panel = screen.getByTestId("admin-home-categories");
    await userEvent.click(within(panel).getAllByRole("button", { name: "下架" })[0]!);

    const confirm = screen.getByTestId("admin-home-confirm");
    expect(confirm).toHaveTextContent("下架分类会同时隐藏它下面的全部内容。");
    await userEvent.type(within(confirm).getByLabelText("操作原因"), "整组内容待重做");
    await userEvent.click(within(confirm).getByRole("button", { name: "确认" }));

    expect(toggleMock).toHaveBeenCalledWith("token",
      { kind: "discovery_category", entityId: "branding-design", isActive: false, reason: "整组内容待重做" });
    expect(await screen.findByTestId("admin-home-feedback")).toHaveTextContent("同时隐藏其下 2 条内容");
  });

  it("submits the whole category order when moving an entry", async () => {
    await renderReady();
    const table = screen.getByTestId("admin-home-table");
    await userEvent.click(within(table).getAllByRole("button", { name: "下移" })[0]!);

    const confirm = screen.getByTestId("admin-home-confirm");
    expect(confirm).toHaveTextContent("调整顺序");
    await userEvent.type(within(confirm).getByLabelText("操作原因"), "把新品排到前面");
    await userEvent.click(within(confirm).getByRole("button", { name: "确认" }));

    // The new order is the list the operator just rearranged, not a single position.
    expect(reorderMock).toHaveBeenCalledWith("token", {
      kind: "discovery_case", categoryKey: "branding-design", orderedIds: [CASE_B, CASE_A], reason: "把新品排到前面",
    });
    expect(await screen.findByTestId("admin-home-feedback")).toHaveTextContent("已保存顺序（2 条）");
  });

  it("saves an edited case with every field and a reason", async () => {
    await renderReady();
    const table = screen.getByTestId("admin-home-table");
    await userEvent.click(within(table).getAllByRole("button", { name: "编辑" })[0]!);

    const form = screen.getByTestId("admin-home-form");
    expect(within(form).getByLabelText("表单标题")).toHaveValue("品牌案例 A");
    await userEvent.clear(within(form).getByLabelText("表单标题"));
    await userEvent.type(within(form).getByLabelText("表单标题"), "品牌案例 A（改）");
    await userEvent.type(within(form).getByLabelText("表单原因"), "标题与实际不符");
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(upsertCaseMock).toHaveBeenCalledWith("token", {
      caseId: CASE_A, categoryKey: "branding-design", title: "品牌案例 A（改）",
      coverImageUrl: "https://example.com/a.png", authorName: "Studio", authorAvatarUrl: "",
      caseUrl: null, seedPrompt: "请参考 A", isActive: true, reason: "标题与实际不符",
    }));
    expect(await screen.findByTestId("admin-home-feedback")).toHaveTextContent("已保存案例");
  });

  it("blocks a bad image line before it reaches the server", async () => {
    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: "示例" }));
    const table = await screen.findByTestId("admin-home-table");
    await within(table).findByText("示例一");
    await userEvent.click(within(table).getAllByRole("button", { name: "编辑" })[0]!);

    const form = screen.getByTestId("admin-home-form");
    await userEvent.clear(within(form).getByLabelText("表单预览图"));
    await userEvent.type(within(form).getByLabelText("表单预览图"), "ftp://nope");
    await userEvent.type(within(form).getByLabelText("表单原因"), "换图");
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));

    expect(await screen.findByTestId("admin-home-error")).toHaveTextContent("必须是 http(s) 链接");
    expect(upsertExampleMock).not.toHaveBeenCalled();
  });

  it("creates a category and keeps the key read-only while editing", async () => {
    upsertCategoryMock.mockResolvedValue({ key: "illustration", kind: "discovery_category", created: true, sortOrder: 2 });
    await renderReady();
    const panel = screen.getByTestId("admin-home-categories");
    await userEvent.click(within(panel).getByRole("button", { name: "新增分类" }));
    await userEvent.type(screen.getByLabelText("分类 key"), "illustration");
    await userEvent.type(screen.getByLabelText("分类名称"), "插画");
    await userEvent.type(screen.getByLabelText("分类原因"), "补一个分类");
    await userEvent.click(screen.getByRole("button", { name: "保存分类" }));

    await waitFor(() => expect(upsertCategoryMock).toHaveBeenCalledWith("token", {
      kind: "discovery_category", key: "illustration", label: "插画", dataType: null, accent: null,
      isActive: true, reason: "补一个分类",
    }));
    expect(await screen.findByTestId("admin-home-feedback")).toHaveTextContent("已新增分类");

    await userEvent.click(within(panel).getAllByRole("button", { name: "编辑" })[0]!);
    expect(screen.getByLabelText("分类 key")).toBeDisabled();
  });

  it("deletes an entry only after an inline reason and confirmation", async () => {
    await renderReady();
    const table = screen.getByTestId("admin-home-table");
    await userEvent.click(within(table).getAllByRole("button", { name: "删除" })[1]!);

    const confirm = screen.getByTestId("admin-home-confirm");
    expect(confirm).toHaveTextContent("删除");
    expect(confirm).toHaveTextContent("品牌案例 B");
    expect(confirm).toHaveTextContent("删除后无法恢复");
    await userEvent.type(within(confirm).getByLabelText("操作原因"), "重复条目");
    await userEvent.click(within(confirm).getByRole("button", { name: "确认" }));

    expect(deleteMock).toHaveBeenCalledWith("token",
      { kind: "discovery_case", entityId: CASE_B, reason: "重复条目" });
    expect(await screen.findByTestId("admin-home-feedback")).toHaveTextContent("已删除");
  });

  it("reports a load failure and reloads after a retry", async () => {
    itemsMock.mockRejectedValueOnce(new Error("首页内容暂时不可用")).mockImplementation(
      async (_token: string, filters: { kind: string }) => (filters.kind === "discovery_case" ? caseList : exampleList));
    render(<AdminHomeContentSection accessToken="token" />);

    expect(await screen.findByTestId("admin-home-error")).toHaveTextContent("首页内容暂时不可用");
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(await screen.findByTestId("admin-home-table")).toBeInTheDocument();
  });

  it("parses and formats the compact image and mention editors", () => {
    expect(parseImageUrlLines("https://a.example/1.png\n\nhttps://a.example/2.png")).toEqual({
      urls: ["https://a.example/1.png", "https://a.example/2.png"], errors: [],
    });
    expect(parseImageUrlLines("nope").errors).toHaveLength(1);

    expect(parseMentionLines("Logo | image | https://a.example/l.png\nBoard | tool | https://a.example/t.svg")).toEqual({
      mentions: [
        { name: "Logo", type: "image", imgSrc: "https://a.example/l.png" },
        { name: "Board", type: "tool", imgSrc: "https://a.example/t.svg" },
      ],
      errors: [],
    });
    expect(parseMentionLines("Logo|wat|https://a.example/l.png").errors[0]).toContain("tool 或 image");
    expect(parseMentionLines("Logo | image").errors[0]).toContain("三段");

    expect(formatMentionLines([{ name: "Logo", type: "image", imgSrc: "https://a.example/l.png" }]))
      .toBe("Logo | image | https://a.example/l.png");
    expect(homeContentKindLabel("discovery_category")).toBe("发现分类");
    expect(homeContentKindLabel("unknown")).toBe("unknown");
    expect(categoryDataType({ dataType: "Branding" })).toBe("Branding");
    expect(categoryDataType({ key: "x" })).toBe("");
    expect(categoryAccent({ accent: "special" })).toBe("special");
    expect(categoryAccent(null)).toBe("");
  });
});
