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

/**
 * The browser's canvas session keeps writing the canvas while a confirmation card is
 * pending: it re-serializes the elements it merges. Measured on a real click
 * (artifacts/delete-confirmation-browser probes), that write moved `version` 1 -> 2, gave
 * `versionNonce` a new value, refreshed `updated`, added `index` and normalized
 * `boundElements` from `null` to `[]` — with the object's content byte-identical. These
 * tests replay that exact sequence through the real propose -> execute -> CAS path: the
 * one a browser produces, not a hand-built guard call.
 */
describe("confirmed deletion against a re-serialized canvas", () => {
  const VICTIM = {
    id: "victim-image",
    type: "image",
    fileId: "file-1",
    x: 0,
    y: 0,
    width: 900,
    height: 1200,
    angle: 0,
    scale: [1, 1],
    crop: null,
    isDeleted: false,
    locked: false,
    opacity: 100,
    groupIds: [],
    boundElements: null,
    frameId: null,
    customData: { title: "确认删除执行图" },
    text: null,
    containerId: null,
    link: null,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    roundness: null,
    seed: 1,
    status: "saved",
    version: 1,
    versionNonce: 1,
    updated: 1,
  };
  const BYSTANDER = {
    id: "bystander-image",
    type: "image",
    x: 10,
    y: 10,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
  };

  /** A canvas row plus the browser's own re-serialization of one element. */
  function canvasHarness() {
    let row = {
      content: {
        elements: [structuredClone(VICTIM), structuredClone(BYSTANDER)],
        appState: {},
        files: {},
      },
      updated_at: "v1",
    };
    let writes = 0;
    const client = {
      from: () => ({
        select: () => ({
          eq() { return this; },
          single: async () => ({ data: structuredClone(row), error: null }),
        }),
        update: (payload: { content: typeof row.content }) => ({
          eq() { return this; },
          select() { return this; },
          async maybeSingle() {
            writes += 1;
            row = {
              content: structuredClone(payload.content),
              updated_at: `v${writes + 1}`,
            };
            return { data: { id: "canvas-1" }, error: null };
          },
        }),
      }),
    };
    return {
      client,
      writes: () => writes,
      liveElements: () =>
        (row.content.elements as Array<Record<string, unknown>>).filter(
          (element) => !element.isDeleted,
        ),
      element: (id: string) =>
        (row.content.elements as Array<Record<string, unknown>>).find(
          (element) => element.id === id,
        ),
      /** Exactly what the pending card's canvas write does to the target. */
      reSerializeVictim() {
        const victim = (row.content.elements as Array<Record<string, unknown>>)[0]!;
        victim.version = 2;
        victim.versionNonce = 2106926071;
        victim.updated = 2;
        victim.index = "a0";
        victim.boundElements = [];
      },
      /** A genuine edit to the same object: it moved and was resized. */
      moveAndResizeVictim() {
        const victim = (row.content.elements as Array<Record<string, unknown>>)[0]!;
        victim.version = 2;
        victim.versionNonce = 2106926071;
        victim.x = 120;
        victim.width = 640;
      },
    };
  }

  async function proposeDelete(client: unknown) {
    const service = createDestructiveConfirmationService();
    const proposal = await manipulateCanvasWithCas(
      client as never,
      "canvas-1",
      [{ action: "delete", element_id: "victim-image" }],
      "删除这张图片",
      { confirmationService: service, userId: "user-1" },
    );
    expect(proposal.error).toBe("confirmation_required");
    return { service, confirmationId: proposal.confirmation!.confirmationId };
  }

  it("applies a click whose target was only re-serialized by the browser", async () => {
    const harness = canvasHarness();
    const { service, confirmationId } = await proposeDelete(harness.client);
    harness.reSerializeVictim();

    const result = await service.confirm({
      confirmationId,
      userId: "user-1",
      canvasId: "canvas-1",
    });

    expect(result).toMatchObject({ success: true });
    expect(harness.writes()).toBe(1);
    expect(harness.element("victim-image")?.isDeleted).toBe(true);
    // The delete removes the named element and nothing else.
    expect(harness.liveElements().map((element) => element.id)).toEqual([
      "bystander-image",
    ]);
  });

  it("refuses a click whose target was moved and resized while the card was pending", async () => {
    const harness = canvasHarness();
    const { service, confirmationId } = await proposeDelete(harness.client);
    harness.moveAndResizeVictim();

    await expect(
      service.confirm({
        confirmationId,
        userId: "user-1",
        canvasId: "canvas-1",
      }),
    ).rejects.toMatchObject({ code: "confirmation_stale" });

    expect(harness.writes()).toBe(0);
    expect(harness.element("victim-image")?.isDeleted).toBe(false);
    expect(harness.liveElements()).toHaveLength(2);
  });
});
