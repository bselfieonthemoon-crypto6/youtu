// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DefaultModelSection } from "../src/components/admin/default-model-section";

const { settingsMock, modelsMock, updateMock } = vi.hoisted(() => ({
  settingsMock: vi.fn(),
  modelsMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", () => ({
  fetchWorkspaceSettings: settingsMock,
  fetchModels: modelsMock,
  updateWorkspaceSettings: updateMock,
}));

const catalogue = [
  { id: "model-1", name: "Main 1", provider: "BASE" },
  { id: "model-2", name: "Main 2", provider: "BASE" },
];

describe("admin default model section", () => {
  beforeEach(() => {
    settingsMock.mockReset().mockResolvedValue({ settings: { defaultModel: "model-1" } });
    modelsMock.mockReset().mockResolvedValue({ models: catalogue });
    updateMock.mockReset().mockResolvedValue({ settings: { defaultModel: "model-2" } });
  });
  afterEach(() => cleanup());

  it("shows the saved default model against the discovered catalogue", async () => {
    render(<DefaultModelSection accessToken="token" />);
    const select = await screen.findByLabelText("默认模型");
    expect(select).toHaveValue("model-1");
    expect(screen.getByRole("option", { name: "Main 2（BASE）" })).toBeInTheDocument();
    expect(settingsMock).toHaveBeenCalledWith("token");
    expect(modelsMock).toHaveBeenCalledWith("token");
  });

  it("saves only after a change and reports the new value", async () => {
    render(<DefaultModelSection accessToken="token" />);
    const save = await screen.findByRole("button", { name: "保存" });
    expect(save).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText("默认模型"), "model-2");
    expect(save).toBeEnabled();
    await userEvent.click(save);

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith("token", { defaultModel: "model-2" }));
    expect(await screen.findByTestId("admin-default-model-feedback")).toHaveTextContent("默认模型已更新");
    // The saved value is now the baseline, so Save goes back to disabled.
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("keeps an out-of-catalogue model instead of silently replacing it", async () => {
    // A model missing from the catalogue is not proof that it stopped working.
    settingsMock.mockResolvedValue({ settings: { defaultModel: "legacy-model" } });
    render(<DefaultModelSection accessToken="token" />);
    const select = await screen.findByLabelText("默认模型");
    expect(select).toHaveValue("legacy-model");
    expect(await screen.findByTestId("admin-default-model-unavailable")).toHaveTextContent("未列入可选目录");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("blocks saving when the catalogue cannot be read", async () => {
    modelsMock.mockRejectedValue(new Error("模型目录读取失败"));
    render(<DefaultModelSection accessToken="token" />);
    expect(await screen.findByTestId("admin-default-model-error")).toHaveTextContent("模型目录读取失败");
    expect(screen.queryByLabelText("默认模型")).not.toBeInTheDocument();

    modelsMock.mockResolvedValue({ models: catalogue });
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByLabelText("默认模型")).toHaveValue("model-1");
  });

  it("surfaces a save failure and keeps the choice", async () => {
    updateMock.mockRejectedValue(new Error("仅工作区所有者和管理员可以修改默认模型。"));
    render(<DefaultModelSection accessToken="token" />);
    await userEvent.selectOptions(await screen.findByLabelText("默认模型"), "model-2");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByTestId("admin-default-model-feedback")).toHaveTextContent("仅工作区所有者和管理员");
    expect(screen.getByLabelText("默认模型")).toHaveValue("model-2");
  });
});
