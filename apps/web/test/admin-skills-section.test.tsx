// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AdminSkillsSection,
  previewRoleLabel,
  previewStatusLabel,
  skillCategoryLabel,
  validatePreviewFile,
} from "../src/components/admin/admin-skills-section";

const { fetchCatalogMock, fetchPreviewsMock, uploadMock, publishMock, deleteMock, reorderMock } = vi.hoisted(() => ({
  fetchCatalogMock: vi.fn(),
  fetchPreviewsMock: vi.fn(),
  uploadMock: vi.fn(),
  publishMock: vi.fn(),
  deleteMock: vi.fn(),
  reorderMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchAdminSkillCatalog: fetchCatalogMock,
  fetchAdminSkillPreviews: fetchPreviewsMock,
  uploadAdminSkillPreview: uploadMock,
  publishAdminSkillPreview: publishMock,
  deleteAdminSkillPreview: deleteMock,
  reorderAdminSkillPreviews: reorderMock,
}));

const SKILL = "87e79614-8f4b-4530-8003-6e4bab97c993";
const OTHER_SKILL = "372f4760-ffe1-4f09-8211-cf0c5dbc0606";
const COVER = "11111111-1111-4111-8111-111111111111";
const EXAMPLE_1 = "22222222-2222-4222-8222-222222222222";
const EXAMPLE_2 = "33333333-3333-4333-8333-333333333333";

const skillEntry = {
  id: SKILL, slug: "logo-design", name: "Logo 与品牌标识", displayName: "Logo 与品牌标识",
  category: "design", source: "system", version: "2.2.0", iconName: "shapes",
  outputKinds: ["raster-image", "image-prompt"], enabledWorkspaces: 32, installCount: 32,
  previewCount: 3, publishedPreviewCount: 1, hasPublishedCover: true,
};

const otherSkill = { ...skillEntry, id: OTHER_SKILL, slug: "json-image-prompt", name: "图像需求结构化",
  displayName: null, category: "custom", version: "2.2.0", previewCount: 0, publishedPreviewCount: 0,
  hasPublishedCover: false, enabledWorkspaces: 5, installCount: 5 };

function preview(overrides: Record<string, unknown> = {}) {
  return {
    id: COVER, skillId: SKILL, role: "cover" as const, caption: "1:1 主视觉", sortOrder: 0,
    status: "published" as const, assetObjectId: "asset-1", mimeType: "image/png", byteSize: 1024,
    createdBy: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z", imageUrl: "https://signed.test/cover.png",
    ...overrides,
  };
}

const examples = [
  preview({ id: EXAMPLE_1, role: "example", caption: "示例 A", status: "published", imageUrl: "https://signed.test/a.png" }),
  preview({ id: EXAMPLE_2, role: "example", caption: "示例 B", status: "draft", imageUrl: "https://signed.test/b.png" }),
];

describe("admin skills section", () => {
  /** The group shells render before the fetch resolves, so wait for real content. */
  async function renderReady() {
    render(<AdminSkillsSection accessToken="token" />);
    await screen.findByAltText("1:1 主视觉");
  }

  beforeEach(() => {
    fetchCatalogMock.mockReset().mockResolvedValue({ skills: [skillEntry, otherSkill] });
    fetchPreviewsMock.mockReset().mockResolvedValue({ previews: [preview(), ...examples] });
    uploadMock.mockReset();
    publishMock.mockReset();
    deleteMock.mockReset();
    reorderMock.mockReset();
  });
  afterEach(() => cleanup());

  it("lists skills and loads the selected skill's images", async () => {
    render(<AdminSkillsSection accessToken="token" />);
    const list = await screen.findByTestId("admin-skill-list");
    expect(within(list).getByText("logo-design · v2.2.0 · 设计")).toBeInTheDocument();
    expect(within(list).getByText(/32 个工作区启用 · 图片 3 · 已有封面/)).toBeInTheDocument();
    await waitFor(() => expect(fetchPreviewsMock).toHaveBeenCalledWith("token", SKILL));
    const covers = await screen.findByTestId("admin-skill-previews-cover");
    expect(within(covers).getByAltText("1:1 主视觉")).toBeInTheDocument();
    expect(within(covers).getByText(/已发布 · 1:1 主视觉/)).toBeInTheDocument();
    const exampleGroup = screen.getByTestId("admin-skill-previews-example");
    expect(within(exampleGroup).getByText(/草稿 · 示例 B/)).toBeInTheDocument();
  });

  it("searches on submit and switches the loaded skill", async () => {
    render(<AdminSkillsSection accessToken="token" />);
    await screen.findByTestId("admin-skill-list");
    await userEvent.type(screen.getByLabelText("搜索技能"), "json");
    expect(fetchCatalogMock).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "查询" }));
    await waitFor(() => expect(fetchCatalogMock).toHaveBeenLastCalledWith("token", { query: "json", limit: 200 }));

    await userEvent.click(screen.getByRole("button", { name: /json-image-prompt/ }));
    await waitFor(() => expect(fetchPreviewsMock).toHaveBeenLastCalledWith("token", OTHER_SKILL));
  });

  it("validates the file size before uploading", async () => {
    render(<AdminSkillsSection accessToken="token" />);
    await screen.findByTestId("admin-skill-detail");
    const input = screen.getByLabelText("选择技能图片");
    // The input's accept filter already blocks a wrong type in a real file dialog;
    // validatePreviewFile covers that case directly (see the label test below).
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    await userEvent.upload(input, big);
    expect(screen.getByText(/1 字节到 5MB/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传为草稿" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("上传原因"), "上传原因");
    expect(screen.getByRole("button", { name: "上传为草稿" })).toBeDisabled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("uploads as a draft with the role, caption and reason", async () => {
    uploadMock.mockResolvedValue(undefined);
    render(<AdminSkillsSection accessToken="token" />);
    await screen.findByTestId("admin-skill-detail");
    const file = new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("选择技能图片"), file);
    await userEvent.selectOptions(screen.getByLabelText("图片用途"), "example");
    await userEvent.type(screen.getByLabelText("图片说明"), "竖版示例");
    await userEvent.type(screen.getByLabelText("上传原因"), "补充示例图");
    await userEvent.click(screen.getByRole("button", { name: "上传为草稿" }));

    expect(uploadMock).toHaveBeenCalledWith("token", SKILL, {
      file, role: "example", caption: "竖版示例", reason: "补充示例图",
    });
    expect(await screen.findByTestId("admin-skills-feedback")).toHaveTextContent("已上传示例（草稿状态");
    await waitFor(() => expect(fetchPreviewsMock).toHaveBeenCalledTimes(2));
  });

  it("requires a reason and confirmation before publishing, and reports the result", async () => {
    publishMock.mockResolvedValue(undefined);
    render(<AdminSkillsSection accessToken="token" />);
    const exampleGroup = await screen.findByTestId("admin-skill-previews-example");
    const row = within(exampleGroup).getByText(/草稿 · 示例 B/).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "发布" }));
    expect(publishMock).not.toHaveBeenCalled();

    const confirm = within(row).getByRole("button", { name: "确认草稿" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(row).getByLabelText("草稿操作原因"), "确认可用");
    await userEvent.click(confirm);
    expect(publishMock).toHaveBeenCalledWith("token", SKILL, EXAMPLE_2, "确认可用", "publish");
    expect(await screen.findByTestId("admin-skills-feedback")).toHaveTextContent("已发布");
  });

  it("unpublishes a published image and requires a reason", async () => {
    publishMock.mockResolvedValue(undefined);
    await renderReady();
    const covers = screen.getByTestId("admin-skill-previews-cover");
    const row = within(covers).getByText(/已发布 · 1:1 主视觉/).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "下架" }));
    await userEvent.type(within(row).getByLabelText("已发布操作原因"), "换封面");
    await userEvent.click(within(row).getByRole("button", { name: "确认已发布" }));
    expect(publishMock).toHaveBeenCalledWith("token", SKILL, COVER, "换封面", "unpublish");
  });

  it("reorders within a role group with a reason", async () => {
    reorderMock.mockResolvedValue(undefined);
    await renderReady();
    const exampleGroup = screen.getByTestId("admin-skill-previews-example");
    const secondRow = within(exampleGroup).getByText(/草稿 · 示例 B/).closest("li")!;
    await userEvent.click(within(secondRow).getByRole("button", { name: "上移" }));
    await userEvent.type(within(secondRow).getByLabelText(/操作原因/), "示例顺序");
    await userEvent.click(within(secondRow).getByRole("button", { name: /^确认/ }));
    await waitFor(() => expect(reorderMock).toHaveBeenCalled());
    const [, skillId, ordered, reason] = reorderMock.mock.calls[0]!;
    expect(skillId).toBe(SKILL);
    expect(reason).toBe("示例顺序");
    expect(ordered.slice(0, 2)).toEqual([EXAMPLE_2, EXAMPLE_1]);
  });

  it("deletes an image record with a reason and keeps the row when the server refuses", async () => {
    deleteMock.mockRejectedValueOnce(new Error("该技能图片不存在。"));
    await renderReady();
    const covers = screen.getByTestId("admin-skill-previews-cover");
    const row = within(covers).getByText(/已发布 · 1:1 主视觉/).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "删除" }));
    await userEvent.type(within(row).getByLabelText("已发布操作原因"), "换图");
    await userEvent.click(within(row).getByRole("button", { name: "确认已发布" }));
    expect(deleteMock).toHaveBeenCalledWith("token", SKILL, COVER, "换图");
    expect(await screen.findByTestId("admin-skills-feedback")).toHaveTextContent("该技能图片不存在。");
    expect(screen.getByTestId("admin-skill-previews-cover")).toBeInTheDocument();
  });

  it("can cancel a pending action without calling the server", async () => {
    await renderReady();
    const covers = screen.getByTestId("admin-skill-previews-cover");
    const row = within(covers).getByText(/已发布 · 1:1 主视觉/).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "删除" }));
    await userEvent.click(within(row).getByRole("button", { name: "取消" }));
    expect(within(row).getByRole("button", { name: "删除" })).toBeInTheDocument();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("states empty groups and a failed image link explicitly", async () => {
    fetchPreviewsMock.mockResolvedValue({ previews: [preview({ imageUrl: null })] });
    render(<AdminSkillsSection accessToken="token" />);
    expect(await screen.findByText("图片链接过期，刷新后重试")).toBeInTheDocument();
    expect(screen.getByText("还没有示例图。")).toBeInTheDocument();
  });

  it("reports a catalog load failure and retries", async () => {
    fetchCatalogMock.mockRejectedValueOnce(new Error("技能目录加载失败，请稍后重试。"))
      .mockResolvedValueOnce({ skills: [skillEntry] });
    render(<AdminSkillsSection accessToken="token" />);
    expect(await screen.findByText("技能目录加载失败，请稍后重试。")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByTestId("admin-skill-list")).toBeInTheDocument();
  });

  it("labels roles, statuses and categories, and validates files locally", () => {
    expect(previewRoleLabel("cover")).toBe("封面");
    expect(previewRoleLabel("example")).toBe("示例");
    expect(previewRoleLabel("other")).toBe("other");
    expect(previewStatusLabel("draft")).toBe("草稿");
    expect(previewStatusLabel("published")).toBe("已发布");
    expect(skillCategoryLabel("design")).toBe("设计");
    expect(skillCategoryLabel("custom")).toBe("自定义");
    expect(skillCategoryLabel("future")).toBe("future");
    expect(validatePreviewFile(new File([new Uint8Array([1])], "a.png", { type: "image/png" }))).toBeNull();
    expect(validatePreviewFile(new File([], "a.png", { type: "image/png" }))).toContain("1 字节");
  });
});
