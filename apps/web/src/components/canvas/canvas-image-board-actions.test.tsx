// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDesign: vi.fn(),
  createDesign: vi.fn(),
  fetchCanvas: vi.fn(),
  uploadFile: vi.fn(),
  resolveCanvasImageSource: vi.fn(),
  importImage: vi.fn(),
  undoImport: vi.fn(),
}));

vi.mock("../../lib/design-api", () => ({
  createDesignApiClient: () => ({ getDesign: mocks.getDesign, createDesign: mocks.createDesign }),
}));
vi.mock("../../lib/server-api", () => ({ fetchCanvas: mocks.fetchCanvas, uploadFile: mocks.uploadFile }));
vi.mock("../../lib/canvas-image-source", () => ({ resolveCanvasImageSource: mocks.resolveCanvasImageSource }));
vi.mock("../../lib/design-canvas-image-api", () => ({
  importCanvasImageToDesign: mocks.importImage,
  undoCanvasImageImport: mocks.undoImport,
}));

import { CanvasImageBoardActions } from "./canvas-image-board-actions";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const designId = "24fb3221-cb46-4878-b729-cd3299e1f18e";
const operationId = "4a4e0c9e-65bd-4b43-8c78-abc6e9ebff11";
const objectId = "2a125e52-21b4-4f1d-b9ad-69d468eceb9c";

function sceneFixture({ inside = false, assetBacked = true }: { inside?: boolean; assetBacked?: boolean } = {}) {
  const source = {
    id: "image-1", fileId: "file-1", type: "image", x: inside ? 130 : 10, y: 130,
    width: 40, height: 30, angle: 0, version: 7, versionNonce: 1, isDeleted: false,
    ...(assetBacked ? { customData: { assetId: "50000000-0000-4000-8000-000000000005" } } : {}),
  };
  const board = {
    id: "board-1", type: "rectangle", x: 100, y: 100, width: 200, height: 150, angle: 0,
    version: 3, versionNonce: 2, isDeleted: false,
    customData: { kind: "loomic-design", schemaVersion: 1, designId, revision: 0, previewAssetObjectId: null, previewRevision: 0 },
  };
  let elements = [source, board];
  const updateScene = vi.fn((next: { elements?: any[] }) => { if (next.elements) elements = next.elements; });
  const api = {
    getSceneElements: () => elements.filter(element => !element.isDeleted),
    getSceneElementsIncludingDeleted: () => elements,
    getFiles: () => ({ "file-1": { id: "file-1", dataURL: "data:image/png;base64,iVBORw0KGgo=" } }),
    getAppState: () => ({ zoom: { value: 1 }, scrollX: 0, scrollY: 0 }),
    updateScene,
  };
  return { source, board, api, updateScene, liveSource: () => elements.find(element => element.id === source.id)! };
}

function renderActions(fixture: ReturnType<typeof sceneFixture>) {
  const onPersistCanvas = vi.fn().mockResolvedValue(undefined);
  function Harness() {
    const [open, setOpen] = useState(true);
    return <CanvasImageBoardActions
      accessToken="token"
      canvasId="canvas-1"
      api={fixture.api}
      image={{ id: fixture.source.id, fileId: fixture.source.fileId, x: fixture.source.x, y: fixture.source.y, width: fixture.source.width, height: fixture.source.height, angle: 0, mimeType: "image/png" }}
      open={open}
      onClose={() => setOpen(false)}
      onPersistCanvas={onPersistCanvas}
      onCanvasRevisionChange={vi.fn()}
    />;
  }
  render(
    <Harness />,
  );
  return { onPersistCanvas };
}

function arrangeBackend(fixture: ReturnType<typeof sceneFixture>, sceneObjects: any[] = [{ objectId, objectVersion: 1 }]) {
  mocks.fetchCanvas.mockImplementation(async () => ({ canvas: { projectId: "70000000-0000-4000-8000-000000000007", revision: 9, content: { elements: fixture.api.getSceneElementsIncludingDeleted() } } }));
  mocks.getDesign.mockResolvedValue({ revision: 12, scene: { objects: sceneObjects } });
  mocks.importImage.mockResolvedValue({ operation_id: operationId, object_id: objectId });
  mocks.undoImport.mockResolvedValue({ revision: 13 });
  mocks.resolveCanvasImageSource.mockResolvedValue("data:image/png;base64,iVBORw0KGgo=");
  mocks.uploadFile.mockResolvedValue({ asset: { id: "60000000-0000-4000-8000-000000000006" }, url: "https://assets.test/local.png" });
}

describe("CanvasImageBoardActions", () => {
  it("copies an outside image and retains the exact source version on the canvas", async () => {
    const fixture = sceneFixture(); arrangeBackend(fixture); renderActions(fixture);
    await userEvent.click(await screen.findByRole("button", { name: "添加到画板" }));
    await waitFor(() => expect(mocks.importImage).toHaveBeenCalledOnce());

    expect(mocks.importImage.mock.calls[0]![1]).toMatchObject({
      mode: "copy", expected_source_element_version: 7, expected_board_element_version: 3,
      placement: { kind: "fit" },
    });
    expect(fixture.liveSource()).toMatchObject({ isDeleted: false, version: 7 });
  });

  it("does not tombstone an inside image until its adopt import has succeeded", async () => {
    const fixture = sceneFixture({ inside: true }); arrangeBackend(fixture);
    let resolveImport!: (value: any) => void;
    mocks.importImage.mockImplementationOnce(() => new Promise(resolve => { resolveImport = resolve; }));
    const { onPersistCanvas } = renderActions(fixture);
    await userEvent.click(await screen.findByRole("button", { name: "加入此画板" }));
    await waitFor(() => expect(mocks.importImage).toHaveBeenCalledOnce());
    expect(fixture.liveSource()).toMatchObject({ isDeleted: false, version: 7 });

    resolveImport({ operation_id: operationId, object_id: objectId });
    await waitFor(() => expect(fixture.liveSource().isDeleted).toBe(true));
    expect(onPersistCanvas).toHaveBeenCalledTimes(2);
  });

  it("keeps the source when the import request fails", async () => {
    const fixture = sceneFixture({ inside: true }); arrangeBackend(fixture);
    mocks.importImage.mockRejectedValueOnce(new Error("network uncertain"));
    renderActions(fixture);
    await userEvent.click(await screen.findByRole("button", { name: "加入此画板" }));
    await screen.findByRole("alert");

    expect(fixture.liveSource()).toMatchObject({ isDeleted: false, version: 7 });
    expect(screen.getByRole("alert").textContent).toContain("原图保留");
  });

  it("reuses the request id when an outcome is unknown and the user retries", async () => {
    const fixture = sceneFixture(); arrangeBackend(fixture);
    mocks.importImage.mockRejectedValueOnce(new Error("network uncertain"));
    renderActions(fixture);
    const choose = await screen.findByRole("button", { name: "添加到画板" });
    await userEvent.click(choose);
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "添加到画板" }));
    await waitFor(() => expect(mocks.importImage).toHaveBeenCalledTimes(2));

    expect(mocks.importImage.mock.calls[1]![1].request_id).toBe(mocks.importImage.mock.calls[0]![1].request_id);
  });

  it("undo restores an adopted source before removing the imported layer exactly once", async () => {
    const fixture = sceneFixture({ inside: true }); arrangeBackend(fixture);
    const { onPersistCanvas } = renderActions(fixture);
    await userEvent.click(await screen.findByRole("button", { name: "加入此画板" }));
    await screen.findByRole("button", { name: "撤销加入" });
    expect(fixture.liveSource().isDeleted).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "撤销加入" }));
    await waitFor(() => expect(mocks.undoImport).toHaveBeenCalledOnce());
    expect(fixture.liveSource()).toMatchObject({ isDeleted: false });
    expect(onPersistCanvas).toHaveBeenCalledTimes(3);
    expect(mocks.undoImport).toHaveBeenCalledWith("token", designId, operationId, expect.objectContaining({ expected_object_version: 1 }));
  });
  it("refreshes the frozen attempt after an explicit revision rejection", async () => {
    const fixture = sceneFixture(); arrangeBackend(fixture);
    mocks.importImage.mockRejectedValueOnce(Object.assign(new Error("revision conflict"), { status: 409, code: "DESIGN_CONFLICT" }));
    renderActions(fixture);
    await userEvent.click(await screen.findByRole("button", { name: "添加到画板" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "添加到画板" }));
    await waitFor(() => expect(mocks.importImage).toHaveBeenCalledTimes(2));
    expect(mocks.importImage.mock.calls[1]![1].request_id).not.toBe(mocks.importImage.mock.calls[0]![1].request_id);
  });

  it("uploads and binds a local canvas image before importing it", async () => {
    const fixture = sceneFixture({ assetBacked: false }); arrangeBackend(fixture);
    const { onPersistCanvas } = renderActions(fixture);

    await userEvent.click(await screen.findByRole("button", { name: "添加到画板" }));
    await waitFor(() => expect(mocks.importImage).toHaveBeenCalledOnce());

    expect(mocks.resolveCanvasImageSource).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({ id: "image-1", version: 7 }),
      expect.any(Object),
    );
    expect(mocks.uploadFile).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({ type: "image/png" }),
      "70000000-0000-4000-8000-000000000007",
    );
    expect(fixture.liveSource()).toMatchObject({
      version: 8,
      customData: { assetId: "60000000-0000-4000-8000-000000000006" },
    });
    expect(mocks.importImage.mock.calls[0]![1]).toMatchObject({
      expected_source_element_version: 8,
    });
    expect(onPersistCanvas).toHaveBeenCalledTimes(2);
  });

  it("keeps a created asset binding locally when its canvas save is uncertain", async () => {
    const fixture = sceneFixture({ assetBacked: false }); arrangeBackend(fixture);
    const { onPersistCanvas } = renderActions(fixture);
    onPersistCanvas.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("network uncertain"));

    await userEvent.click(await screen.findByRole("button", { name: "添加到画板" }));
    await screen.findByRole("alert");

    expect(mocks.importImage).not.toHaveBeenCalled();
    expect(fixture.liveSource()).toMatchObject({
      customData: { assetId: "60000000-0000-4000-8000-000000000006" },
    });
    expect(screen.getByRole("alert").textContent).toContain("画布绑定尚未确认保存");
  });
});
