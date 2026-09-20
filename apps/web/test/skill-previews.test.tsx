// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SkillDetail, SkillListItem } from "@loomic/shared";

import { SkillCard } from "../src/components/skills/skill-card";
import { SkillDetailDialog } from "../src/components/skills/skill-detail-dialog";

const api = vi.hoisted(() => ({
  fetchSkills: vi.fn(), fetchWorkspaceSkills: vi.fn(), fetchSkillDetail: vi.fn(),
  fetchPublishedSkillPreviewGroups: vi.fn(),
  installSkill: vi.fn(), uninstallSkill: vi.fn(), deleteSkill: vi.fn(), updateSkill: vi.fn(), toggleSkill: vi.fn(),
  createSkill: vi.fn(),
}));
vi.mock("../src/lib/server-api", () => ({ ...api, ApiAuthError: class extends Error {} }));
vi.mock("../src/lib/auth-context", () => ({
  useAuth: () => ({ session: { access_token: "qa-token" }, user: { id: "qa-owner" }, loading: false }),
}));
vi.mock("../src/components/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const skill: SkillListItem = {
  id: "87e79614-8f4b-4530-8003-6e4bab97c993",
  slug: "logo-design",
  name: "Logo 与品牌标识",
  description: "为新 Logo 与图形标识规划或生成位图概念。",
  category: "design",
  source: "system",
  version: "2.2.0",
  installed: true,
  enabled: true,
} as SkillListItem;

const detail = { ...skill, author: "loomic", license: null, files: [], skillContent: "# Logo\n正文", sourceUrl: null } as unknown as SkillDetail;

const cover = { id: "cover-1", role: "cover" as const, caption: "1:1 主视觉", imageUrl: "https://signed.test/cover.png" };
const examples = [
  { id: "ex-1", role: "example" as const, caption: "竖版海报", imageUrl: "https://signed.test/ex1.png" },
  { id: "ex-2", role: "example" as const, caption: null, imageUrl: "https://signed.test/ex2.png" },
];

describe("skill card images", () => {
  afterEach(() => cleanup());

  it("shows the published cover and the example count when the platform provides them", () => {
    render(<SkillCard skill={skill} onToggle={vi.fn()} onClick={vi.fn()} coverUrl={cover.imageUrl} exampleCount={2} />);
    const image = screen.getByAltText("Logo 与品牌标识 效果图");
    expect(image).toHaveAttribute("src", cover.imageUrl);
    expect(image).toHaveAttribute("loading", "lazy");
    expect(screen.getByText(/已安装 · v2.2.0 · 2 张示例/)).toBeInTheDocument();
  });

  it("keeps the plain card when the skill has no image", () => {
    render(<SkillCard skill={skill} onToggle={vi.fn()} onClick={vi.fn()} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/已安装 · v2.2.0$/)).toBeInTheDocument();
    // The rest of the card is unchanged and still reachable.
    expect(screen.getByRole("switch", { name: "启用 Logo 与品牌标识" })).toBeInTheDocument();
    expect(screen.getByText("查看详情")).toBeInTheDocument();
  });
});

describe("skill detail gallery", () => {
  afterEach(() => cleanup());

  const baseProps = {
    skill: detail, open: true, onOpenChange: vi.fn(),
    onInstall: vi.fn(async () => {}), onUninstall: vi.fn(async () => {}),
  };

  it("renders the cover and every example with its caption", () => {
    render(<SkillDetailDialog {...baseProps} cover={cover} examples={examples} />);
    const gallery = screen.getByTestId("skill-detail-gallery");
    expect(gallery).toBeInTheDocument();
    expect(screen.getByAltText("Logo 与品牌标识：1:1 主视觉")).toHaveAttribute("src", cover.imageUrl);
    expect(screen.getByAltText("Logo 与品牌标识 示例：竖版海报")).toHaveAttribute("src", "https://signed.test/ex1.png");
    expect(screen.getByAltText("Logo 与品牌标识 示例")).toHaveAttribute("src", "https://signed.test/ex2.png");
    expect(screen.getByText("竖版海报")).toBeInTheDocument();
    // The disclaimer keeps the images from reading as a promise about the result.
    expect(screen.getByText(/不代表你的实际生成结果/)).toBeInTheDocument();
  });

  it("omits the gallery entirely when there is no published image", () => {
    render(<SkillDetailDialog {...baseProps} />);
    expect(screen.queryByTestId("skill-detail-gallery")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    // The rest of the dialog is unaffected.
    expect(screen.getByText("技能文件")).toBeInTheDocument();
  });
});

describe("skills page wiring", () => {
  beforeEach(() => {
    api.fetchSkills.mockReset().mockResolvedValue({ skills: [skill] });
    api.fetchWorkspaceSkills.mockReset().mockResolvedValue({ skills: [{ id: skill.id, enabled: true }] });
    api.fetchSkillDetail.mockReset().mockResolvedValue({ skill: detail });
    api.fetchPublishedSkillPreviewGroups.mockReset().mockResolvedValue({
      groups: [{ slug: "logo-design", cover, examples }],
    });
  });
  afterEach(() => cleanup());

  it("loads published images in one batch for the visible skills", async () => {
    const { default: SkillsPage } = await import("../src/app/(workspace)/skills/page");
    render(<SkillsPage />);
    await waitFor(() => expect(api.fetchPublishedSkillPreviewGroups).toHaveBeenCalledWith("qa-token", ["logo-design"]));
    expect(await screen.findByAltText("Logo 与品牌标识 效果图")).toBeInTheDocument();
  });

  it("keeps the list working when the image read fails", async () => {
    api.fetchPublishedSkillPreviewGroups.mockRejectedValue(new Error("图片接口不可用"));
    const { default: SkillsPage } = await import("../src/app/(workspace)/skills/page");
    render(<SkillsPage />);
    // The card is still there, just without an image.
    expect(await screen.findByText("Logo 与品牌标识")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByAltText("Logo 与品牌标识 效果图")).not.toBeInTheDocument());
  });
});
