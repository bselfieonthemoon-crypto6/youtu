import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillDetail, SkillListItem } from "@loomic/shared";
import { mergeSkillInstallation, notifySkillsChanged, readSkills, isSafeSkillFilePath } from "../src/lib/skills-client";
import { CreateSkillDialog } from "../src/components/skills/create-skill-dialog";
import { SkillDetailDialog } from "../src/components/skills/skill-detail-dialog";
import { SkillMetadata } from "../src/components/skills/skill-metadata";
import { ChatSkills } from "../src/components/chat-skills";
import { MarketplacePanel } from "../src/components/skills/marketplace-panel";
import { ImportPanel } from "../src/components/skills/import-panel";
import { useWorkspaceSkills } from "../src/hooks/use-workspace-skills";
import SkillsPage from "../src/app/(workspace)/skills/page";

const api = vi.hoisted(() => ({
  fetchSkills: vi.fn(), fetchWorkspaceSkills: vi.fn(), fetchSkillDetail: vi.fn(),
  createSkill: vi.fn(), updateSkill: vi.fn(), deleteSkill: vi.fn(), installSkill: vi.fn(),
  uninstallSkill: vi.fn(), toggleSkill: vi.fn(), searchMarketplace: vi.fn(),
  getMarketplaceDetail: vi.fn(), installMarketplaceSkill: vi.fn(), importSkillFromUrl: vi.fn(),
}));
vi.mock("../src/lib/server-api", () => ({ ...api, ApiAuthError: class extends Error {} }));
vi.mock("../src/lib/auth-context", () => ({ useAuth: () => ({ session: { access_token: "qa-token" }, user: { id: "qa-owner" }, loading: false }) }));
vi.mock("../src/components/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

function item(id: string, patch: Partial<SkillDetail> = {}): SkillDetail {
  return { id, slug: id, name: id, description: "QA skill description", author: "QA", version: "2.0.0", category: "design",
    source: "user", isFeatured: false, iconName: null, metadata: {}, createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
    installed: true, enabled: true, license: null, skillContent: "# QA instructions\nOnly change explicitly requested objects.", createdBy: "qa-owner", files: [], ...patch };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
afterEach(() => { cleanup(); notifySkillsChanged(); vi.useRealTimers(); });
beforeEach(() => { vi.clearAllMocks(); api.fetchSkills.mockResolvedValue({ skills: [] }); api.fetchWorkspaceSkills.mockResolvedValue({ skills: [] }); });

describe("Skills installation state and safe requests", () => {
  it("does not invent installations or default disabled skills to enabled", () => {
    const result = mergeSkillInstallation([item("catalog"), item("disabled")], [item("disabled", { enabled: false }), item("private")]);
    expect(result.map(({ id, installed, enabled }) => ({ id, installed, enabled }))).toEqual([
      { id: "catalog", installed: false, enabled: false }, { id: "disabled", installed: true, enabled: false },
      { id: "private", installed: true, enabled: true },
    ]);
  });
  it("shares only in-flight same-token requests and invalidates after mutations", async () => {
    const pending = deferred<{ skills: SkillListItem[] }>(); api.fetchWorkspaceSkills.mockReturnValueOnce(pending.promise);
    const one = readSkills("one", "workspace"); expect(readSkills("one", "workspace")).toBe(one);
    await readSkills("two", "workspace"); expect(api.fetchWorkspaceSkills).toHaveBeenCalledTimes(2);
    pending.resolve({ skills: [] }); await one; await readSkills("one", "workspace");
    expect(api.fetchWorkspaceSkills).toHaveBeenCalledTimes(3);
  });
  it.each(["references/../secret", "references/a%2fb", "references/NUL.txt", "scripts/a.js.", "references//a"])("rejects nonportable path %s", (path) => {
    expect(isSafeSkillFilePath(path)).toBe(false);
  });
  it("supports Chinese reference names using the shared canonical validator", () => expect(isSafeSkillFilePath("references/验收 标准.md")).toBe(true));
  it("ignores previous-account reads and refreshes real enabled state", async () => {
    const stale = deferred<{ skills: SkillListItem[] }>(); api.fetchWorkspaceSkills.mockReturnValueOnce(stale.promise).mockResolvedValue({ skills: [item("new")] });
    const hook = renderHook(({ token }) => useWorkspaceSkills(token), { initialProps: { token: "old" } });
    hook.rerender({ token: "new" }); await waitFor(() => expect(hook.result.current.skills[0]?.id).toBe("new"));
    await act(async () => { stale.resolve({ skills: [item("old")] }); await stale.promise; });
    expect(hook.result.current.skills[0]?.id).toBe("new");
    api.fetchWorkspaceSkills.mockResolvedValue({ skills: [item("new", { enabled: false })] });
    act(() => notifySkillsChanged()); await waitFor(() => expect(hook.result.current.skills[0]?.enabled).toBe(false));
  });
});

describe("Skills management UI", () => {
  it("shows only actual workspace installations on installed tab, and does not claim toggle success after an API failure", async () => {
    api.fetchSkills.mockResolvedValue({ skills: [item("installed"), item("catalog-only")] });
    api.fetchWorkspaceSkills.mockResolvedValue({ skills: [item("installed")] });
    api.toggleSkill.mockRejectedValue(new Error("QA network failure"));
    render(<SkillsPage />);
    expect(await screen.findByRole("article", { name: "installed" })).toBeVisible();
    expect(screen.queryByRole("article", { name: "catalog-only" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "启用 installed" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("切换失败");
    expect(screen.getByRole("switch", { name: "启用 installed" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("tab", { name: "技能目录" }));
    expect(screen.getByRole("article", { name: "catalog-only" })).toHaveTextContent("未安装");
  });
  it("keeps typed instructions and attachments in a failed create dialog", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("QA API error")); const close = vi.fn();
    render(<CreateSkillDialog open onOpenChange={close} onSubmit={submit} />);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "QA test" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "QA description" } });
    fireEvent.change(screen.getByLabelText("SKILL.md 内容"), { target: { value: "# QA body" } });
    await userEvent.click(screen.getByRole("button", { name: "添加文件" }));
    fireEvent.change(screen.getByLabelText("文件 1 路径"), { target: { value: "references/验收.md" } });
    fireEvent.change(screen.getByLabelText("文件 1 内容"), { target: { value: "QA reference" } });
    await userEvent.click(screen.getByRole("button", { name: "创建并安装" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("创建失败");
    expect(screen.getByLabelText("SKILL.md 内容")).toHaveValue("# QA body");
    expect(screen.getByLabelText("文件 1 内容")).toHaveValue("QA reference"); expect(close).not.toHaveBeenCalled();
    expect(submit.mock.calls[0]?.[0].files).toEqual([{ filePath: "references/验收.md", content: "QA reference" }]);
  });
  it("edits an existing skill and explicitly clears removed attachments", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const skill = item("editable", { files: [{ id: "ref", filePath: "references/a.md", content: "existing", mimeType: "text/plain", createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z" }] });
    render(<CreateSkillDialog open onOpenChange={vi.fn()} onSubmit={submit} skill={skill} />);
    expect(screen.getByLabelText("名称")).toHaveValue("editable");
    await userEvent.click(screen.getByRole("button", { name: "删除文件 1" }));
    await userEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ files: [], name: "editable" }));
  });
  it("shows failed detail as an error without fictional content or install action", () => {
    render(<SkillDetailDialog open skill={null} error="QA 详情加载失败" onOpenChange={vi.fn()} onInstall={vi.fn()} onUninstall={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("QA 详情加载失败");
    expect(screen.queryByRole("button", { name: "安装技能" })).not.toBeInTheDocument();
    expect(screen.queryByText("SKILL.md")).not.toBeInTheDocument();
  });
  it("renders actual model restrictions, provenance and unknown readiness honestly", () => {
    const skill = item("matting", { metadata: { loomic: { schemaVersion: 1, execution: "image", intents: ["remove background"], outputKinds: ["transparent_png"], requiredTools: ["generate_image"], optionalTools: [], models: [{ role: "image", required: true, preferredIds: ["gpt-image-2"], exactIds: ["gpt-image-2"] }], limitations: ["不保证像素完全相同"], examples: [], sources: [{ title: "Official docs", url: "https://example.com/docs", license: "未声明", relation: "inspired-by" }] } } });
    render(<SkillMetadata skill={skill} />);
    expect(screen.getByText(/尚未检测/)).toBeVisible(); expect(screen.getByText(/限定型号：gpt-image-2/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Official docs" })).toHaveAttribute("href", "https://example.com/docs");
    expect(screen.getByText(/方法参考（不是源码集成）/)).toBeVisible();
  });
  it("deduplicates general limitations but preserves actionable missing dependency reasons", () => {
    const skill = item("limited", { readiness: { status: "unavailable", models: [], reasons: ["一般能力边界", "缺少 gpt-image-2 模型"] },
      metadata: { loomic: { schemaVersion: 1, execution: "image", intents: [], outputKinds: ["transparent-png"], requiredTools: [], optionalTools: [], models: [], limitations: ["一般能力边界"], examples: [], sources: [] } } });
    const result = render(<SkillMetadata skill={skill} />);
    expect(screen.getAllByText("一般能力边界")).toHaveLength(1);
    expect(screen.getByText("缺少 gpt-image-2 模型")).toBeVisible();
    result.rerender(<SkillMetadata skill={skill} compact />);
    expect(screen.queryByText("一般能力边界")).not.toBeInTheDocument();
    expect(screen.getByText("缺少 gpt-image-2 模型")).toBeVisible();
  });
  it("chat uses real enabled skills only and selects an editable invitation without using examples", async () => {
    api.fetchWorkspaceSkills.mockResolvedValue({ skills: [
      item("off", { slug: "logo-design", enabled: false }),
      item("hidden", { slug: "reference-analysis", readiness: { status: "ready", reasons: [], models: [] } }),
      item("logo", { slug: "logo-design", name: "Logo 与品牌标识", readiness: { status: "ready", reasons: [], models: [] } }),
      item("campaign", { slug: "campaign-design", name: "活动海报与宣传图", readiness: { status: "ready", reasons: [], models: [] } }),
      item("product", { slug: "product-visual", name: "商品与产品视觉", readiness: { status: "ready", reasons: [], models: [] } }),
      item("creative", { slug: "creative-directions", name: "创意方向探索", readiness: { status: "ready", reasons: [], models: [] } }),
    ] });
    const select = vi.fn(); render(<ChatSkills onSelectSkill={select} accessToken="qa-token" />);
    const ready = await screen.findByRole("button", { name: "Logo 与品牌标识" });
    expect(screen.queryByRole("button", { name: /off/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /hidden/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(screen.queryByText("配置就绪")).not.toBeInTheDocument();
    expect(screen.queryByText("可用 · 指导类")).not.toBeInTheDocument();
    await userEvent.click(ready); expect(select).toHaveBeenCalledExactlyOnceWith("请使用「Logo 与品牌标识」技能协助我。");
  });
});

describe("Community lookup correctness", () => {
  it("does not submit duplicate imports while the first request is in flight", async () => {
    const pending = deferred<{ skill: SkillDetail }>(); api.importSkillFromUrl.mockReturnValue(pending.promise);
    const imported = vi.fn().mockResolvedValue(undefined);
    render(<ImportPanel accessToken={() => "qa"} onImported={imported} />);
    fireEvent.change(screen.getByLabelText("技能 URL"), { target: { value: "https://github.com/example/qa/tree/main/skill" } });
    const button = screen.getByRole("button", { name: "导入" });
    fireEvent.click(button); fireEvent.click(button);
    fireEvent.keyDown(screen.getByLabelText("技能 URL"), { key: "Enter" });
    expect(api.importSkillFromUrl).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve({ skill: item("imported") }); await pending.promise; });
    expect(imported).toHaveBeenCalledOnce(); await waitFor(() => expect(screen.getByText("已导入")).toBeVisible());
  });
  it("refuses non-HTTPS import before contacting the server", async () => {
    render(<ImportPanel accessToken={() => "qa"} onImported={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("技能 URL"), { target: { value: "file:///private/skill" } });
    await userEvent.click(screen.getByRole("button", { name: "导入" }));
    await waitFor(() => expect(screen.getByText("请输入有效的 HTTPS URL")).toBeVisible()); expect(api.importSkillFromUrl).not.toHaveBeenCalled();
  });
  it("does not resurrect cleared queries from stale search responses", async () => {
    const pending = deferred<{ skills: never[]; total: number }>(); api.searchMarketplace.mockReturnValue(pending.promise);
    render(<MarketplacePanel accessToken={() => "qa"} onInstalled={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("搜索市场技能"), { target: { value: "logo" } });
    await waitFor(() => expect(api.searchMarketplace).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("搜索市场技能"), { target: { value: "" } });
    await act(async () => { pending.resolve({ skills: [], total: 12 }); await pending.promise; });
    expect(screen.queryByText("未找到匹配的技能")).not.toBeInTheDocument(); expect(screen.getByText("输入关键词搜索社区技能。")).toBeVisible();
  });
  it("does not fabricate marketplace details after a fetch failure", async () => {
    api.searchMarketplace.mockResolvedValue({ skills: [{ packageName: "qa-package", name: "QA result", version: "1", description: "QA", author: "QA", downloads: 1 }], total: 1 });
    api.getMarketplaceDetail.mockRejectedValue(new Error("QA fetch failed"));
    render(<MarketplacePanel accessToken={() => "qa"} onInstalled={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("搜索市场技能"), { target: { value: "logo" } });
    await userEvent.click(await screen.findByRole("button", { name: /QA result/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("技能详情读取失败");
    expect(screen.queryByRole("button", { name: "安装技能" })).not.toBeInTheDocument();
  });
});
