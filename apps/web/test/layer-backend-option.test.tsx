import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayerBackendOption } from "../src/components/canvas/layer-backend-option";
import { fetchLayerBackend, fetchSemanticLayerQuote, imageToolOperationModel } from "../src/lib/layer-backend";
import { DesignImageTools } from "../src/components/design/design-image-tools";
import type { DesignObject } from "@loomic/shared";

vi.mock("../src/lib/env", () => ({ getServerBaseUrl: () => "http://localhost:3002" }));
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const status = (available = false) => ({ configured: available, available, model: "qwen-image-layered", reason: available ? "专用分层服务就绪" : "尚未配置 Qwen 专用分层服务", remote: true });

describe("Dedicated layer backend entry", () => {
  it("checks status without uploading image pixels and disables an unconfigured service", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => status() }); const run = vi.fn();
    render(<LayerBackendOption accessToken="qa-token" onRun={run} />);
    expect(await screen.findByText("尚未配置 Qwen 专用分层服务")).toBeVisible();
    expect(screen.getByRole("button", { name: "Qwen 专用分层" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3002/api/images/layer-backend", { headers: { Authorization: "Bearer qa-token" } });
    expect(run).not.toHaveBeenCalled();
  });
  it("shows data-transfer disclosure and runs only after explicit dedicated selection", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => status(true) }); const run = vi.fn();
    render(<LayerBackendOption accessToken="qa-token" onRun={run} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Qwen 专用分层" })).toBeEnabled());
    expect(run).not.toHaveBeenCalled(); expect(screen.getByText(/点击后将原图发送到已配置的远程专用服务/)).toBeVisible();
    expect(screen.getByText(/外部服务或算力可能产生费用，不代表免费/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Qwen 专用分层" })); expect(run).toHaveBeenCalledOnce();
  });
  it("keeps the dedicated action unavailable on a failed health request without falling back", async () => {
    fetchMock.mockRejectedValue(new Error("offline")); const run = vi.fn();
    render(<LayerBackendOption accessToken="qa-token" onRun={run} />);
    expect(await screen.findByText("无法检查专用分层服务，请重试。")).toBeVisible(); expect(screen.getByRole("button", { name: "Qwen 专用分层" })).toBeDisabled();
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects a mismatched health model identifier", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...status(true), model: "gpt-image-2-all" }) });
    await expect(fetchLayerBackend("qa")).rejects.toThrow("无效的配置状态");
  });
  it("uses the server quote for the selected semantic layer count", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ available: true, model: "workspace:flare", displayName: "Flare 图像", calls: 4, credits: 32, quality: "standard", resolution: "1k", layerCount: 3 }) });
    await expect(fetchSemanticLayerQuote("qa-token", 3)).resolves.toMatchObject({ displayName: "Flare 图像", calls: 4, credits: 32, resolution: "1k" });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3002/api/images/semantic-layer-backend?layer_count=3", { headers: { Authorization: "Bearer qa-token" } });
  });
  it("preserves local default and never overrides background-removal's exact model", () => {
    expect(imageToolOperationModel("split_layers")).toBe("local:feynobg");
    expect(imageToolOperationModel("split-layers")).toBe("local:feynobg");
    expect(imageToolOperationModel("split_layers", "qwen-image-layered")).toBe("qwen-image-layered");
    expect(imageToolOperationModel("split-layers", "qwen-image-layered")).toBe("qwen-image-layered");
    expect(imageToolOperationModel("remove_background", "qwen-image-layered")).toBe("gpt-image-2");
    expect(imageToolOperationModel("remove-background")).toBe("gpt-image-2");
  });
  it("exposes independent local and dedicated actions on a selected artboard image", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => status(true) });
    const local = vi.fn(); const dedicated = vi.fn();
    render(<DesignImageTools selectedImage={{ objectId: "qa", type: "image" } as Extract<DesignObject, { type: "image" }>} jobs={[]} accessToken="qa" onRun={local} onRunDedicatedLayers={dedicated} onStartErase={vi.fn()} onStartRegion={vi.fn()} onRefresh={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "本地拆分" }));
    expect(local).toHaveBeenCalledWith("split_layers"); expect(dedicated).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Qwen 专用分层" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Qwen 专用分层" })); expect(dedicated).toHaveBeenCalledOnce(); expect(local).toHaveBeenCalledOnce();
  });
});
