import { describe, expect, it } from "vitest";

import type { BackgroundJob } from "@loomic/shared";

import { normalizePersistedGenerationJob } from "./design-target-normalizer.js";

const baseJob: BackgroundJob = {
  id: "10000000-0000-4000-8000-000000000001",
  workspace_id: "20000000-0000-4000-8000-000000000001",
  project_id: "30000000-0000-4000-8000-000000000001",
  canvas_id: "40000000-0000-4000-8000-000000000001",
  session_id: null,
  thread_id: null,
  queue_name: "image_generation_jobs",
  job_type: "image_generation",
  status: "succeeded",
  payload: {
    prompt: "legacy logo",
    auto_finalize_canvas: true,
    placement_x: 10,
    placement_y: 20,
    placement_width: 300,
    placement_height: 200,
    placeholder_element_id: "placeholder-1",
  },
  result: null,
  error_code: null,
  error_message: null,
  attempt_count: 1,
  max_attempts: 3,
  created_by: "50000000-0000-4000-8000-000000000001",
  created_at: "2026-09-04T00:00:00.000Z",
  updated_at: "2026-09-04T00:00:00.000Z",
  started_at: "2026-09-04T00:00:00.000Z",
  completed_at: "2026-09-04T00:00:01.000Z",
  failed_at: null,
  canceled_at: null,
};

describe("design target normalization", () => {
  it("normalizes a legacy flat Canvas job before Worker parsing", () => {
    const normalized = normalizePersistedGenerationJob(baseJob);

    expect(normalized.job_type).toBe("image_generation");
    if (normalized.job_type !== "image_generation")
      throw new Error("wrong type");
    expect(normalized.target_kind).toBe("canvas");
    expect(normalized.payload.target).toEqual({
      kind: "canvas",
      canvas_id: baseJob.canvas_id,
      element_id: "placeholder-1",
      placement: { x: 10, y: 20, width: 300, height: 200 },
    });
    expect(normalized.payload).not.toHaveProperty("auto_finalize_canvas");
    expect(normalized.payload).not.toHaveProperty("placement_x");
  });

  it("keeps and validates a frozen modern design target", () => {
    const designId = "60000000-0000-4000-8000-000000000001";
    const normalized = normalizePersistedGenerationJob({
      ...baseJob,
      canvas_id: null,
      design_id: designId,
      target_kind: "design",
      payload: {
        prompt: "hero image",
        target: {
          kind: "design",
          design_id: designId,
          expected_revision: 7,
          idempotency_key: "70000000-0000-4000-8000-000000000001",
          placement: { x: 40, y: 50, role: "product" },
        },
      },
    });

    expect(normalized.job_type).toBe("image_generation");
    if (normalized.job_type !== "image_generation")
      throw new Error("wrong type");
    expect(normalized.payload.target).toMatchObject({
      kind: "design",
      design_id: designId,
      expected_revision: 7,
    });
  });

  it("refuses to invent missing design concurrency metadata", () => {
    expect(() =>
      normalizePersistedGenerationJob({
        ...baseJob,
        canvas_id: null,
        design_id: "60000000-0000-4000-8000-000000000001",
        target_kind: "design",
      }),
    ).toThrow("design_target_payload_missing");
  });
});
