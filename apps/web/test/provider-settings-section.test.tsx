// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderSettingsSection } from "../src/components/settings/provider-settings-section";

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
  discoverProviderModels: discoverMock,
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
    await userEvent.click(screen.getByRole("button", { name: "保存并获取模型" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTPS");
    expect(createMock).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText("Base URL"));
    await userEvent.type(screen.getByLabelText("Base URL"), "https://safe.example/v1/");
    await userEvent.click(screen.getByRole("button", { name: "保存并获取模型" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        baseUrl: "https://safe.example/v1",
        apiKey: "sk-secret-value",
        models: [expect.objectContaining({ upstreamModelId: "model-one", capabilities: ["text"] })],
      }),
    ));
    await waitFor(() => expect(testMock).toHaveBeenCalledWith("token", config.id));
    expect(discoverMock).toHaveBeenCalledWith("token", config.id);
  }, 10_000);

  it("reports connection-test success and failure in Chinese", async () => {
    render(<ProviderSettingsSection accessToken="token" />);
    await screen.findByText("API 易");
    await userEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接成功")).toBeInTheDocument();

    testMock.mockRejectedValueOnce(Object.assign(new Error(), { code: "provider_auth_failed" }));
    await userEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText(/API Key 无效/)).toBeInTheDocument();
  });

  it("loads the model catalog from the persisted supplier", async () => {
    render(<ProviderSettingsSection accessToken="token" />);
    await screen.findByText("API 易");
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.click(screen.getByRole("button", { name: "重新获取" }));
    expect(await screen.findByLabelText("模型 1 ID")).toHaveValue("gpt-image-2-all");
    expect(testMock).toHaveBeenCalledWith("token", config.id);
    expect(discoverMock).toHaveBeenCalledWith("token", config.id);
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
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("token", config.id));
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
});
