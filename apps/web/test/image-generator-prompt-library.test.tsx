import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImageGeneratorPanel } from "../src/components/canvas/image-generator-panel";
import {
  updateImageGeneratorElement,
  type ImageGeneratorData,
} from "../src/lib/canvas-image-generator";
import { ApiApplicationError, fetchImageModels, submitNodeImageGeneration } from "../src/lib/server-api";
import { fetchPromptLibrary } from "../src/lib/prompt-library-api";

vi.mock("../src/hooks/use-generation-error-handler", () => ({
  useGenerationErrorHandler: () => ({ handleGenerationError: () => false }),
}));
vi.mock("../src/lib/server-api", async () => ({
  ...(await vi.importActual("../src/lib/server-api")),
  fetchImageModels: vi.fn(),
  submitNodeImageGeneration: vi.fn(),
}));
vi.mock("../src/lib/canvas-elements", () => ({
  getViewportCenter: () => ({ x: 0, y: 0 }),
  createExcalidrawImageElement: vi.fn(),
  fetchAsDataURL: vi.fn(),
}));
vi.mock("../src/lib/prompt-library-api", async () => ({
  ...(await vi.importActual("../src/lib/prompt-library-api")),
  fetchPromptLibrary: vi.fn(),
}));

const data: ImageGeneratorData = {
  type: "image-generator",
  prompt: "My original logo",
  model: "gpt-image-2",
  quality: "hd",
  aspectRatio: "1:1",
  status: "idle",
  inputImages: ["existing-reference-id"],
};
const libraryEntry = {
  id: "prompt-1",
  title: "蓝色品牌标志",
  prompt: "Make a blue logo, keep the exact typography.",
  category: "品牌设计",
  tags: ["logo"],
  sourceId: "open-source",
  sourceUrl: "https://example.com/1",
  modelHints: ["GPT Image"],
  requiresReference: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(submitNodeImageGeneration).mockReset();
  vi.mocked(submitNodeImageGeneration).mockResolvedValue({
    job: { id: "job-default", status: "queued", payload: { node_submission_revision: 5 } } as never,
    replayed: false,
  });
  vi.mocked(fetchImageModels).mockResolvedValue({
    models: [{ id: "gpt-image-2", displayName: "GPT Image 2" } as never],
  });
  vi.mocked(fetchPromptLibrary).mockResolvedValue({
    version: "test",
    items: [libraryEntry],
    total: 1,
    nextOffset: null,
    categories: ["品牌设计"],
    sources: [
      {
        id: "open-source",
        name: "Open prompts",
        url: "https://example.com",
        license: "MIT",
        attribution: "Authors",
        status: "available",
        note: "Text only",
        entryCount: 1,
      },
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(initial: Partial<ImageGeneratorData> = {}, strictMode = false) {
  let elements: any[] = [
    {
      id: "a",
      x: 10,
      y: 10,
      width: 200,
      height: 200,
      version: 1,
      customData: { ...data, ...initial },
    },
    {
      id: "b",
      x: 300,
      y: 10,
      width: 200,
      height: 200,
      version: 1,
      customData: { ...data, prompt: "Other node draft" },
    },
  ];
  let notify = () => {};
  const api = {
    getSceneElements: () => elements,
    updateScene: vi.fn((value: { elements: any[] }) => {
      elements = value.elements;
      notify();
    }),
  };
  const persistCanvas = vi.fn().mockResolvedValue(undefined);
  function Harness({ activeId }: { activeId: string }) {
    const [, rerender] = useState(0);
    notify = () => rerender((value) => value + 1);
    const element = elements.find((item) => item.id === activeId);
    return (
      <ImageGeneratorPanel
        key={activeId}
        elementId={activeId}
        canvasId="canvas"
        elementBounds={element}
        data={element.customData}
        excalidrawApi={api}
        accessToken="test-token"
        canvasScrollZoom={{ scrollX: 0, scrollY: 0, zoom: 1 }}
        onPersistCanvas={persistCanvas}
        onClose={vi.fn()}
      />
    );
  }
  const renderHarness = (activeId: string) =>
    strictMode ? (
      <StrictMode>
        <Harness activeId={activeId} />
      </StrictMode>
    ) : (
      <Harness activeId={activeId} />
    );
  const view = render(renderHarness("a"));
  return {
    api,
    persistCanvas,
    elements: () => elements,
    view,
    switchNode: (activeId: string) => view.rerender(renderHarness(activeId)),
    externalModel: (model: string) =>
      act(() => {
        elements = elements.map((element) =>
          element.id === "a"
            ? { ...element, customData: { ...element.customData, model } }
            : element,
        );
        notify();
      }),
    externalPrompt: (prompt: string) =>
      act(() => {
        elements = elements.map((element) =>
          element.id === "a"
            ? { ...element, customData: { ...element.customData, prompt } }
            : element,
        );
        notify();
      }),
    moveNode: (x: number, y: number) =>
      act(() => {
        elements = elements.map((element) =>
          element.id === "a" ? { ...element, x, y, version: element.version + 1 } : element,
        );
        notify();
      }),
  };
}

describe("image generator prompt library", () => {
  it("clears the previous terminal job binding before a new attempt, allowing lost-response recovery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(submitNodeImageGeneration).mockRejectedValue(new Error("network lost"));
    const state = setup({ inputImages: [], status: "error", jobId: "old-terminal-job",
      nodeImageRequest: { requestId: "old-request", state: "accepted", submissionRevision: 3,
        prompt: data.prompt, model: data.model, aspectRatio: "1:1", quality: "hd" } });
    await userEvent.click(screen.getByRole("button", { name: "生成图片" }));
    await waitFor(() => expect(state.elements()[0].customData.nodeImageRequest.state).toBe("unknown"));
    expect(state.elements()[0].customData.jobId).toBeUndefined();
    expect(state.elements()[0].customData.nodeImageRequest.requestId).not.toBe("old-request");
    expect(submitNodeImageGeneration).toHaveBeenCalledTimes(1);
  });

  it("unlocks edits after a confirmed model rejection and submits a new request identity", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(submitNodeImageGeneration).mockRejectedValueOnce(new ApiApplicationError("node_model_unavailable", "模型不可用"));
    const state = setup({ inputImages: [] });
    await userEvent.click(screen.getByRole("button", { name: "生成图片" }));
    await waitFor(() => expect(state.elements()[0].customData.nodeImageRequest.state).toBe("rejected"));
    const first = state.elements()[0].customData.nodeImageRequest.requestId;
    const field = screen.getByRole("textbox", { name: "图片生成提示词" }) as HTMLTextAreaElement;
    expect(field.disabled).toBe(false);
    fireEvent.change(field, { target: { value: "new draft" } });
    await userEvent.click(screen.getByRole("button", { name: "生成图片" }));
    await waitFor(() => expect(state.elements()[0].customData.nodeImageRequest.state).toBe("accepted"));
    expect(state.elements()[0].customData.nodeImageRequest.requestId).not.toBe(first);
    expect(vi.mocked(submitNodeImageGeneration).mock.calls[1]?.[1].prompt).toBe("new draft");
  });
  it("persists manual drafts immediately without generating or changing other node fields", async () => {
    const state = setup();
    const before = structuredClone(state.elements());
    fireEvent.change(screen.getByRole("textbox", { name: "图片生成提示词" }), {
      target: { value: "New unsent draft" },
    });
    expect(state.elements()[0].customData).toEqual({
      ...before[0].customData,
      prompt: "New unsent draft",
    });
    expect(state.elements()[1]).toEqual(before[1]);
    expect(state.api.updateScene).toHaveBeenLastCalledWith(
      expect.objectContaining({ captureUpdate: "IMMEDIATELY" }),
    );
    expect(submitNodeImageGeneration).not.toHaveBeenCalled();
  });

  it("keeps unresolved workspace model IDs compact while metadata is loading", () => {
    vi.mocked(fetchImageModels).mockReturnValue(new Promise(() => {}));
    const model = "workspace:29a0cb35-0794-4239-9a95-948c8cf93705";
    setup({ model });
    const modelButton = screen.getByRole("button", { name: "选择生图模型" });
    expect(modelButton.textContent).toBe("当前模型");
    expect(modelButton.title).toBe(model);
    expect(
      screen.getByRole("button", { name: "打开提示词库" }).className,
    ).toContain("whitespace-nowrap");
    expect(
      screen.getByRole("button", { name: "打开提示词库" }).className,
    ).toContain("shrink-0");
    expect(modelButton.className).toContain("min-w-0");
  });

  it("resolves a missing model once outside render even when StrictMode replays state updates", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = setup({ model: "retired-model" }, true);
    // updateScene updates the live parent Harness, mirroring Excalidraw's
    // onChange -> CanvasToolMenu state update. A setModel updater side effect
    // is replayed during child render and emits the real cross-render warning.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "选择生图模型" }).textContent,
      ).toBe("GPT Image 2"),
    );
    expect(fetchImageModels).toHaveBeenCalledTimes(2);
    expect(state.elements()[0].customData.model).toBe("gpt-image-2");
    expect(state.api.updateScene).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("uses the live node model when a delayed catalog response arrives, preserving a valid later choice", async () => {
    let resolveModels!: (
      value: Awaited<ReturnType<typeof fetchImageModels>>,
    ) => void;
    vi.mocked(fetchImageModels).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveModels = resolve;
        }),
    );
    const state = setup({ model: "retired-model" });
    state.externalModel("workspace:chosen");
    await act(async () => {
      resolveModels({
        models: [
          { id: "workspace:first", displayName: "First model" } as never,
          { id: "workspace:chosen", displayName: "My chosen model" } as never,
        ],
      });
    });
    expect(state.elements()[0].customData.model).toBe("workspace:chosen");
    expect(
      screen.getByRole("button", { name: "选择生图模型" }).textContent,
    ).toBe("My chosen model");
    expect(state.api.updateScene).not.toHaveBeenCalled();
  });

  it.each(["替换当前提示词", "追加到末尾"])(
    "applies %s only to the targeted node and keeps its model, ratio, quality and references",
    async (label) => {
      const state = setup();
      const before = structuredClone(state.elements());
      await userEvent.click(
        screen.getByRole("button", { name: "打开提示词库" }),
      );
      await userEvent.click(
        await screen.findByRole("button", {
          name: `查看提示词：${libraryEntry.title}`,
        }),
      );
      await userEvent.click(screen.getByRole("button", { name: label }));
      const expected =
        label === "追加到末尾"
          ? `${data.prompt}\n\n${libraryEntry.prompt}`
          : libraryEntry.prompt;
      await waitFor(() =>
        expect(
          (
            screen.getByRole("textbox", {
              name: "图片生成提示词",
            }) as HTMLTextAreaElement
          ).value,
        ).toBe(expected),
      );
      expect(state.elements()[0].customData).toEqual({
        ...before[0].customData,
        prompt: expected,
      });
      expect(state.elements()[1]).toEqual(before[1]);
      expect(submitNodeImageGeneration).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it("restores each node's own draft after changing selection, not the previous React state", () => {
    const state = setup();
    fireEvent.change(screen.getByRole("textbox", { name: "图片生成提示词" }), {
      target: { value: "Saved A draft" },
    });
    state.switchNode("b");
    expect(
      (
        screen.getByRole("textbox", {
          name: "图片生成提示词",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Other node draft");
    fireEvent.change(screen.getByRole("textbox", { name: "图片生成提示词" }), {
      target: { value: "Saved B draft" },
    });
    state.switchNode("a");
    expect(
      (
        screen.getByRole("textbox", {
          name: "图片生成提示词",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Saved A draft");
    expect(state.elements()[1].customData.prompt).toBe("Saved B draft");
  });

  it("reflects canvas undo without writing the old draft back", () => {
    const state = setup();
    fireEvent.change(screen.getByRole("textbox", { name: "图片生成提示词" }), {
      target: { value: "Typed content" },
    });
    const calls = state.api.updateScene.mock.calls.length;
    state.externalPrompt("Restored by undo");
    expect(
      (
        screen.getByRole("textbox", {
          name: "图片生成提示词",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Restored by undo");
    expect(state.api.updateScene).toHaveBeenCalledTimes(calls);
    expect(state.elements()[0].customData.prompt).toBe("Restored by undo");
  });

  it("appends against the latest scene when undo changed the prompt with the library open", async () => {
    const state = setup();
    await userEvent.click(screen.getByRole("button", { name: "打开提示词库" }));
    await userEvent.click(
      await screen.findByRole("button", {
        name: `查看提示词：${libraryEntry.title}`,
      }),
    );
    state.externalPrompt("Latest undo result");
    await userEvent.click(screen.getByRole("button", { name: "追加到末尾" }));
    expect(state.elements()[0].customData.prompt).toBe(
      `Latest undo result\n\n${libraryEntry.prompt}`,
    );
  });

  it("does not write a canceled or deleted generator node", () => {
    const deleted = {
      id: "deleted",
      isDeleted: true,
      version: 1,
      customData: { ...data },
    };
    const api = { getSceneElements: () => [deleted], updateScene: vi.fn() };
    updateImageGeneratorElement(api, "deleted", { prompt: "should not apply" });
    updateImageGeneratorElement(api, "missing", { prompt: "should not apply" });
    expect(api.updateScene).not.toHaveBeenCalled();
  });

  it("does not add undo history for an unchanged prompt", () => {
    const api = {
      getSceneElements: () => [{ id: "a", customData: { ...data } }],
      updateScene: vi.fn(),
    };
    updateImageGeneratorElement(api, "a", { prompt: data.prompt });
    expect(api.updateScene).not.toHaveBeenCalled();
  });

  it("disables applying library text during generation", () => {
    setup({ status: "generating", jobId: "job" });
    expect(
      (
        screen.getByRole("button", {
          name: "打开提示词库",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("textbox", {
          name: "图片生成提示词",
        }) as HTMLTextAreaElement
      ).disabled,
    ).toBe(true);
  });

  it("never treats an IME confirmation Enter as a paid generation request", () => {
    setup();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "图片生成提示词" }), {
      key: "Enter",
      isComposing: true,
    });
    expect(submitNodeImageGeneration).not.toHaveBeenCalled();
  });

  it("submits the exact typed prompt and chosen parameters without an implicit Skill or library rewrite", async () => {
    const raw = '  原文：夏日上新！\n保留“Logo”、字体与标点。\n  ';
    // Leave the no-network request pending; this test checks the submitted input.
    vi.mocked(submitNodeImageGeneration).mockReturnValue(new Promise(() => {}));
    const state = setup({ prompt: raw, inputImages: [], aspectRatio: "3:4", quality: "ultra" });
    await userEvent.click(screen.getByRole("button", { name: "生成图片" }));
    expect(state.persistCanvas).toHaveBeenCalledTimes(1);
    expect(submitNodeImageGeneration).toHaveBeenCalledExactlyOnceWith(
      "test-token",
      expect.objectContaining({
        request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        canvas_id: "canvas",
        element_id: "a",
        prompt: raw,
        model: "gpt-image-2",
        aspect_ratio: "3:4",
        quality: "standard",
        resolution: "4k",
      }),
    );
    expect(state.elements()[0].customData.prompt).toBe(raw);
    expect(state.elements()[0].customData.status).toBe("generating");
    expect(fetchPromptLibrary).not.toHaveBeenCalled();
    expect(state.elements()[1].customData.prompt).toBe("Other node draft");
  });

  it("keeps a delayed durable submission alive after switching nodes and preserves a moved placeholder", async () => {
    let resolveSubmission!: (
      value: Awaited<ReturnType<typeof submitNodeImageGeneration>>,
    ) => void;
    vi.mocked(submitNodeImageGeneration).mockImplementation(
      () => new Promise((resolve) => { resolveSubmission = resolve; }),
    );
    const state = setup({ inputImages: [] });
    await userEvent.click(screen.getByRole("button", { name: "生成图片" }));
    await waitFor(() => expect(submitNodeImageGeneration).toHaveBeenCalledTimes(1));

    state.moveNode(444, -120);
    state.switchNode("b");
    await act(async () => {
      resolveSubmission({
        job: { id: "job-delayed", status: "queued", payload: { node_submission_revision: 5 } } as never,
        replayed: false,
      });
    });

    await waitFor(() =>
      expect(state.elements()[0]).toMatchObject({
        x: 444,
        y: -120,
        customData: {
          status: "generating",
          jobId: "job-delayed",
          nodeImageRequest: { state: "accepted" },
        },
      }),
    );
    expect(state.persistCanvas).toHaveBeenCalledTimes(2);
    expect(
      (screen.getByRole("textbox", { name: "图片生成提示词" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Other node draft");
  });

  it("retries an unknown response with the same request id and frozen input", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(submitNodeImageGeneration)
      .mockRejectedValueOnce(new TypeError("network disconnected"))
      .mockResolvedValueOnce({
        job: { id: "job-recovered", status: "queued", payload: { node_submission_revision: 5 } } as never,
        replayed: true,
      });
    const raw = "  保留这段原始提示词  ";
    const state = setup({ prompt: raw, inputImages: [] });

    await userEvent.click(screen.getByRole("button", { name: "生成图片" }));
    await screen.findByText(/不会自动重新扣费/);
    const firstPayload = vi.mocked(submitNodeImageGeneration).mock.calls[0]?.[1];
    expect(state.elements()[0].customData).toMatchObject({
      status: "error",
      nodeImageRequest: { state: "unknown", prompt: raw },
    });
    expect(
      (screen.getByRole("textbox", { name: "图片生成提示词" }) as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "生成图片" }));
    await waitFor(() => expect(submitNodeImageGeneration).toHaveBeenCalledTimes(2));
    expect(vi.mocked(submitNodeImageGeneration).mock.calls[1]?.[1]).toEqual(
      firstPayload,
    );
    await waitFor(() =>
      expect(state.elements()[0].customData).toMatchObject({
        status: "generating",
        jobId: "job-recovered",
        nodeImageRequest: { state: "accepted", prompt: raw },
      }),
    );
  });

  it("never calls the paid submission endpoint when the placeholder save fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = setup({ inputImages: [] });
    state.persistCanvas.mockRejectedValueOnce(new Error("save failed"));
    await userEvent.click(screen.getByRole("button", { name: "生成图片" }));
    await screen.findByText(/任务尚未提交/);
    expect(submitNodeImageGeneration).not.toHaveBeenCalled();
    expect(state.elements()[0].customData.nodeImageRequest).toMatchObject({
      state: "rejected",
    });
  });

  it("does not silently drop persisted references and charge for a text-only result after reload", async () => {
    const state = setup();
    await userEvent.click(screen.getByRole("button", { name: "生成图片" }));
    expect(submitNodeImageGeneration).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("当前节点暂不支持参考图生成");
    expect(state.elements()[0].customData.status).toBe("idle");
    expect(state.elements()[0].customData.inputImages).toEqual(["existing-reference-id"]);
    await userEvent.click(screen.getByRole("button", { name: "移除已保存参考图" }));
    expect(state.elements()[0].customData.inputImages).toEqual([]);
    expect(state.elements()[1].customData.inputImages).toEqual(["existing-reference-id"]);
    expect(submitNodeImageGeneration).not.toHaveBeenCalled();
  });

  it("explicitly blocks unsupported reference-image generation before any API or generating status", async () => {
    const state = setup();
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File(["fake-png"], "reference.png", { type: "image/png" })],
      },
    });
    await screen.findByRole("button", { name: "移除参考图" });
    await userEvent.click(screen.getByRole("button", { name: "生成图片" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "当前节点暂不支持参考图生成",
    );
    expect(submitNodeImageGeneration).not.toHaveBeenCalled();
    expect(state.elements()[0].customData.status).toBe("idle");
  });
});
