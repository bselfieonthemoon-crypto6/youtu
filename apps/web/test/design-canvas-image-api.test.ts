import { describe, expect, it, vi } from "vitest";

import {
  importCanvasImageToDesign,
  undoCanvasImageImport,
} from "../src/lib/design-canvas-image-api";

const designId = "10000000-0000-4000-8000-000000000001";
const canvasId = "20000000-0000-4000-8000-000000000002";
const requestId = "30000000-0000-4000-8000-000000000003";
const undoId = "40000000-0000-4000-8000-000000000004";

describe("design canvas image API", () => {
  it("posts a strict import and returns the replay receipt", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        operation_id: requestId,
        design_id: designId,
        design_revision: 4,
        object_id: requestId,
        object_version: 1,
        source_canvas_id: canvasId,
        source_canvas_revision: 8,
        source_element_id: "source",
        source_element_version: 3,
        mode: "copy",
        replayed: true,
      }),
    );
    const response = await importCanvasImageToDesign(
      "token",
      importRequest(),
      { baseUrl: "https://server.test/", fetch: fetch as typeof globalThis.fetch },
    );

    expect(response.replayed).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      `https://server.test/api/designs/${designId}/canvas-image-imports`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("posts version-guarded undo to the import operation", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        operation_id: requestId,
        design_id: designId,
        design_revision: 5,
        object_id: requestId,
        removed: true,
        replayed: false,
      }),
    );
    const response = await undoCanvasImageImport(
      "token",
      designId,
      requestId,
      {
        idempotency_key: undoId,
        expected_design_revision: 4,
        expected_object_version: 1,
      },
      { baseUrl: "https://server.test", fetch: fetch as typeof globalThis.fetch },
    );

    expect(response.removed).toBe(true);
    expect(fetch.mock.calls[0]?.[0]).toContain(`/${requestId}/undo`);
  });

  it("surfaces a structured source CAS conflict", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(
        {
          error: {
            code: "CANVAS_REVISION_CONFLICT",
            message: "The canvas image changed.",
            canvas_id: canvasId,
            latest_revision: 9,
            retryable: false,
          },
        },
        { status: 409 },
      ),
    );

    await expect(
      importCanvasImageToDesign("token", importRequest(), {
        baseUrl: "https://server.test",
        fetch: fetch as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({
      code: "CANVAS_REVISION_CONFLICT",
      conflict: { canvasId, latestRevision: 9 },
    });
  });
});

function importRequest() {
  return {
    request_id: requestId,
    design_id: designId,
    expected_design_revision: 3,
    canvas_id: canvasId,
    source_element_id: "source",
    expected_source_element_version: 3,
    board_element_id: "board",
    expected_board_element_version: 2,
    mode: "copy" as const,
    placement: { kind: "fit" as const },
  };
}
