import { describe, expect, it, vi } from "vitest";
import { createDestructiveConfirmationService } from "../../features/agent-actions/destructive-confirmation-service.js";
import {
  hasExplicitCanvasDeleteIntent,
  manipulateCanvasWithCas,
} from "./manipulate-canvas.js";

describe("hasExplicitCanvasDeleteIntent", () => {
  it.each([
    "删除旧的两张图片",
    "把选中的图删掉",
    "清空画布",
    "remove the previous image",
  ])("allows an explicit destructive instruction: %s", (prompt) => {
    expect(hasExplicitCanvasDeleteIntent(prompt)).toBe(true);
  });

  it.each([
    "重新生成一个简约版",
    "生成新的，但不要删除旧的",
    "生成了就保存好，保留所有图片",
    "don't remove the previous image",
    "keep all existing results",
    undefined,
  ])("blocks absent or negated deletion intent: %s", (prompt) => {
    expect(hasExplicitCanvasDeleteIntent(prompt)).toBe(false);
  });
});

describe("destructive canvas confirmation boundary", () => {
  it("freezes a mixed batch and performs zero writes before confirmation", async () => {
    const update = vi.fn(() => {
      throw new Error("must not write");
    });
    const row = {
      content: {
        elements: [
          {
            id: "old-image",
            type: "image",
            version: 4,
            versionNonce: 44,
            isDeleted: false,
            customData: { title: "Old logo" },
          },
        ],
        appState: {},
        files: {},
      },
      updated_at: "v1",
    };
    const client = {
      from: () => ({
        select: () => ({
          eq() { return this; },
          single: async () => ({ data: structuredClone(row), error: null }),
        }),
        update,
      }),
    };
    const service = createDestructiveConfirmationService();

    const result = await manipulateCanvasWithCas(
      client,
      "canvas-1",
      [
        { action: "add_text", text: "replacement", x: 10, y: 20 },
        { action: "delete", element_id: "old-image" },
      ],
      "删除旧图",
      { confirmationService: service, userId: "user-1" },
    );

    expect(result.error).toBe("confirmation_required");
    expect(result.confirmation?.targets).toEqual([
      expect.objectContaining({
        elementId: "old-image",
        label: "Old logo",
        version: 4,
      }),
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it("does not treat raw prompt wording as executable authorization", async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq() { return this; },
          single: async () => ({
            data: {
              content: {
                elements: [{ id: "image", type: "image", version: 1 }],
                appState: {},
                files: {},
              },
              updated_at: "v1",
            },
            error: null,
          }),
        }),
      }),
    };
    const result = await manipulateCanvasWithCas(
      client,
      "canvas-1",
      [{ action: "delete", element_id: "image" }],
      "删除这张图片",
    );
    expect(result.error).toBe("confirmation_unavailable");
  });
});
