// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { modelLimitError, ProviderSettingsSection } from "../src/components/settings/provider-settings-section";

const { fetchMock, createMock, updateMock, deleteMock, testMock, discoverMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn(),
  testMock: vi.fn(),
  discoverMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchProviderConfigs: fetchMock,
  createProviderConfig: createMock,
  updateProviderConfig: updateMock,
  deleteProviderConfig: deleteMock,
  testProviderConnection: testMock,
  discoverDraftProviderModels: discoverMock,
}));

const config = {
  id: "10000000-0000-4000-8000-000000000001",
  adapter: "openai_compatible" as const,
  displayName: "API 易",
  baseUrl: "https://api.apiyi.com/v1",
  enabled: true,
  hasApiKey: true,
  lastFour: "6d97",
  models: [{
    id: "20000000-0000-4000-8000-000000000001",
    upstreamModelId: "gemini-flash",
    displayName: "Gemini Flash",
    modality: "text" as const,
    enabled: true,
    capabilities: ["text" as const],
  }],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  lastTestedAt: null,
  lastTestStatus: "never" as const,
};

describe("ProviderSettingsSection", () => {
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({ configs: [config] });
    createMock.mockReset();
    updateMock.mockReset().mockResolvedValue({ config });
    deleteMock.mockReset().mockResolvedValue(undefined);
    testMock.mockReset().mockResolvedValue({ ok: true, testedAt: "2026-09-01T01:00:00.000Z" });
    discoverMock.mockReset().mockResolvedValue({ models: [{ upstreamModelId: "gpt-image-2-all", displayName: "gpt-image-2-all", modality: "image", enabled: false, capabilities: ["image_generation"] }] });
  });

  afterEach(() => cleanup());

  it("shows only the masked key hint and never prefills the secret", async () => {
    render(<ProviderSettingsSection accessToken="token" />);
    expect(await screen.findByText(/已配置 ••••6d97/)).toBeInTheDocument();
    // Omitting the scope keeps the optional per-workspace override.
    expect(screen.getByTestId("provider-settings-workspace")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    const keyInput = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(keyInput.value).toBe("");
    expect(keyInput.placeholder).toContain("••••6d97");
    expect(document.body.textContent).not.toContain("sk-secret-value");
  });

  it("keeps the existing key when an edit is saved with an empty key", async () => {
    render(<ProviderSettingsSection accessToken="token" />);
    await screen.findByText("API 易");
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.click(screen.getByRole("button", { name: "保存模型" }));

    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const payload = updateMock.mock.calls[0]?.[2];
    expect(payload).not.toHaveProperty("apiKey");
    expect(payload.models[0]).not.toHaveProperty("id");
  });

  it("requires HTTPS and creates an OpenAI-compatible provider with models", async () => {
    createMock.mockResolvedValue({ config: { ...config, displayName: "新网关" } });
    render(<ProviderSettingsSection accessToken="token" />);
    await screen.findByText("API 易");
    await userEvent.click(screen.getByRole("button", { name: "新增供应商" }));
    await userEvent.type(screen.getByLabelText("供应商名称"), "新网关");
    await userEvent.clear(screen.getByLabelText("Base URL"));
    await userEvent.type(screen.getByLabelText("Base URL"), "http://unsafe.example/v1");
    await userEvent.type(screen.getByLabelText("API Key"), "sk-secret-value");
    await userEvent.click(screen.getByRole("button", { name: "手动添加" }));
    await userEvent.type(screen.getByLabelText("模型 1 ID"), "model-one");
    await userEvent.type(screen.getByLabelText("模型 1 显示名称"), "Model One");
    await userEvent.click(screen.getByRole("button", { name: "保存供应商与模型" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTPS");
    expect(createMock).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText("Base URL"));
    await userEvent.type(screen.getByLabelText("Base URL"), "https://safe.example/v1/");
    await userEvent.click(screen.getByRole("button", { name: "保存供应商与模型" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        baseUrl: "https://safe.example/v1",
        apiKey: "sk-secret-value",
        models: [expect.objectContaining({ upstreamModelId: "model-one" })],
      }),
      "workspace",
    ));
    expect(discoverMock).not.toHaveBeenCalled();
  }, 10_000);

  it("reports connection-test success and failure in Chinese", async () => {
    render(<ProviderSettingsSection accessToken="token" />);
    await screen.findByText("API 易");
    await userEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接成功")).toBeInTheDocument();

    testMock.mockRejectedValueOnce(Object.assign(new Error(), { code: "provider_auth_failed" }));
    await userEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText(/API Key 无效/)).toBeInTheDocument();

    testMock.mockRejectedValueOnce(Object.assign(new Error(), { code: "provider_response_too_large" }));
    await userEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText(/超过系统安全上限/)).toBeInTheDocument();
  });

  it("opens a picker without changing the draft until confirmation", async () => {
    render(<ProviderSettingsSection accessToken="token" />);
    await screen.findByText("API 易");
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("选择 gpt-image-2-all")).not.toBeChecked();
    expect(updateMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("gpt-image-2-all")).not.toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    await userEvent.click(screen.getByLabelText("选择 gpt-image-2-all"));
    await userEvent.selectOptions(screen.getByLabelText("gpt-image-2-all 类型"), "video");
    await userEvent.click(screen.getByRole("button", { name: "确认添加" }));
    expect(screen.getByLabelText("模型 2 ID")).toHaveValue("gpt-image-2-all");
    expect(screen.getByLabelText("模型 2 类型")).toHaveValue("video");
    expect(screen.getByLabelText("模型 2 ID")).toBeEnabled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(testMock).not.toHaveBeenCalled();
    expect(discoverMock).toHaveBeenCalledWith("token", { configId: config.id, baseUrl: config.baseUrl }, "workspace");
  });

  it("discovers with unsaved connection credentials without persisting them", async () => {
    render(<ProviderSettingsSection accessToken="token" />);
    await screen.findByText("API 易");
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.type(screen.getByLabelText("API Key"), "new-secret-value");
    await userEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(testMock).not.toHaveBeenCalled();
    expect(discoverMock).toHaveBeenCalledWith("token", { configId: config.id, baseUrl: config.baseUrl, apiKey: "new-secret-value" }, "workspace");
    expect(updateMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("offers draft discovery before the first save and cancel creates nothing", async () => {
    render(<ProviderSettingsSection accessToken="token" />);
    await screen.findByText("API 易");
    await userEvent.click(screen.getByRole("button", { name: "新增供应商" }));
    await userEvent.clear(screen.getByLabelText("Base URL"));
    await userEvent.type(screen.getByLabelText("Base URL"), "https://toapis.cn/v1");
    await userEvent.type(screen.getByLabelText("API Key"), "unsaved-test-key");
    await userEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(discoverMock).toHaveBeenCalledWith("token", { baseUrl: "https://toapis.cn/v1", apiKey: "unsaved-test-key" }, "workspace");
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("pages a large catalog and keeps selections when searching", async () => {
    discoverMock.mockResolvedValueOnce({ models: Array.from({ length: 101 }, (_, index) => ({
      upstreamModelId: `catalog-${index}`,
      displayName: `Catalog ${index}`,
      modality: "text" as const,
      enabled: false,
      capabilities: ["text" as const],
    })) });
    render(<ProviderSettingsSection accessToken="token" />);
    await screen.findByText("API 易");
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    expect(await screen.findByText("第 1/2 页。", { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "下一页模型" }));
    await userEvent.click(screen.getByLabelText("选择 catalog-100"));
    await userEvent.type(screen.getByLabelText("搜索获取到的模型"), "catalog-0");
    expect(screen.getByText("第 1/1 页。", { exact: false })).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("搜索获取到的模型"));
    await userEvent.click(screen.getByRole("button", { name: "下一页模型" }));
    expect(screen.getByLabelText("选择 catalog-100")).toBeChecked();
  });

  it("preserves existing models rather than adding discovered duplicates", async () => {
    discoverMock.mockResolvedValueOnce({ models: [{ ...config.models[0], enabled: false }] });
    render(<ProviderSettingsSection accessToken="token" />);
    await screen.findByText("API 易");
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.click(screen.getByRole("button", { name: "拉取模型" }));
    await userEvent.click(await screen.findByLabelText("选择 gemini-flash"));
    await userEvent.click(screen.getByRole("button", { name: "确认添加" }));
    expect(screen.getByLabelText("模型 1 ID")).toHaveValue("gemini-flash");
    expect(screen.queryByLabelText("模型 2 ID")).not.toBeInTheDocument();
  });

  it("reports the cap message used by the picker before persistence", () => {
    expect(modelLimitError(500, 1)).toContain("最多只能保存 500 个模型");
    expect(modelLimitError(499, 1)).toBeNull();
  });

  it("requires inline confirmation before deleting and removes the card", async () => {
    render(<ProviderSettingsSection accessToken="token" />);
    await screen.findByText("API 易");
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(deleteMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "确认删除 API 易" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("token", config.id, "workspace"));
    expect(screen.queryByText("API 易")).not.toBeInTheDocument();
  });

  it("keeps the provider and shows Chinese feedback when deletion fails", async () => {
    deleteMock.mockRejectedValueOnce(Object.assign(new Error(), { code: "provider_persistence_failed" }));
    render(<ProviderSettingsSection accessToken="token" />);
    await screen.findByText("API 易");
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("删除失败");
    expect(screen.getByText("API 易")).toBeInTheDocument();
  });

  it("configures the platform default, and says so, when the scope is platform", async () => {
    render(<ProviderSettingsSection accessToken="token" scope="platform" />);

    expect(await screen.findByText(/包括之后新建的账号/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "平台模型与渠道" })).toBeInTheDocument();
    expect(screen.getByTestId("provider-settings-platform")).toBeInTheDocument();
    // Every call carries the scope, because that is what selects the platform routes.
    expect(fetchMock).toHaveBeenCalledWith("token", "platform");

    await userEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(testMock).toHaveBeenCalledWith("token", config.id, "platform"));

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.click(screen.getByRole("button", { name: "保存模型" }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith("token", config.id, expect.anything(), "platform"));

    // Saving lands back on the platform list, where deletion is scoped the same way
    // and the confirmation says it affects every workspace.
    await userEvent.click(await screen.findByRole("button", { name: "删除" }));
    expect(screen.getByRole("alertdialog", { name: "确认删除 API 易" })).toHaveTextContent("所有工作区");
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("token", config.id, "platform"));
  });
});
