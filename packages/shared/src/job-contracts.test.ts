import { describe, expect, it } from "vitest";

import {
  backgroundJobSchema,
  backgroundJobWorkerSchema,
  createImageJobRequestSchema,
  createVideoJobRequestSchema,
  normalizeImageGenerationPayload,
  normalizeVideoGenerationPayload,
  normalizedImageGenerationPayloadSchema,
} from "./job-contracts.js";

const ids = {
  canvas: "3417e887-ddf1-4e77-957d-2d951986a3ee",
  design: "74066fc9-7141-475c-b911-886f6262fe00",
  request: "a202227f-e4e5-4b90-a55c-e8d507e719a4",
  workspace: "816c03dc-d355-4466-8922-c8929fc00809",
  project: "87d29501-c414-4616-a147-50deaa19de0a",
  user: "c135316a-d3fa-49ba-872a-49ae9f43d6b6",
} as const;

describe("image processing job contracts", () => {
  it("requires bounded named semantic layers and an explicit repaired background", () => {
    const valid = { prompt: "Split the image", operation: "split_layers",
      layer_backend: "semantic", layer_names: ["subject", "text"],
      repair_background: true, input_images: ["https://example.test/source.png"] };
    expect(normalizeImageGenerationPayload(valid)).toMatchObject(valid);
    expect(createImageJobRequestSchema.safeParse({ ...valid, layer_names: ["subject"] }).success).toBe(false);
    expect(createImageJobRequestSchema.safeParse({ ...valid, layer_names: ["subject", "SUBJECT"] }).success).toBe(false);
    expect(createImageJobRequestSchema.safeParse({ ...valid, repair_background: false }).success).toBe(false);
    expect(createImageJobRequestSchema.safeParse({ ...valid, layer_backend: undefined }).success).toBe(false);
  });
  it("requires a complete authoritative design source binding", () => {
    const target = {
      kind: "design",
      design_id: ids.design,
      expected_revision: 1,
      idempotency_key: ids.request,
      source_object_id: ids.canvas,
    };
    expect(
      createImageJobRequestSchema.safeParse({ prompt: "erase", target })
        .success,
    ).toBe(false);
    expect(
      createImageJobRequestSchema.safeParse({
        prompt: "erase",
        target: {
          ...target,
          expected_object_version: 2,
          source_asset_object_id: ids.workspace,
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    "remove_background",
    "region_matting",
    "split_layers",
    "erase_transparent",
    "smart_erase",
  ] as const)("accepts the %s local operation", (operation) => {
    const parsed = createImageJobRequestSchema.parse({
      prompt: "process image",
      operation,
      model: "local:feynobg",
      input_images: ["data:image/png;base64,AA=="],
    });
    expect(parsed.operation).toBe(operation);
  });

  it("accepts an erase mask data URL", () => {
    const result = createImageJobRequestSchema.parse({
      prompt: "erase",
      operation: "smart_erase",
      input_images: ["data:image/png;base64,aW1hZ2U="],
      mask_image: "data:image/png;base64,bWFzaw==",
    });
    expect(result.mask_image).toContain("data:image/png");
  });

  it("requires one source, a mask, and a meaningful prompt for local repaint", () => {
    const valid = {
      prompt: "Replace the flower with a red rose",
      operation: "local_repaint" as const,
      input_images: ["data:image/png;base64,aW1hZ2U="],
      mask_image: "data:image/png;base64,bWFzaw==",
    };
    expect(createImageJobRequestSchema.parse(valid).operation).toBe(
      "local_repaint",
    );
    expect(
      createImageJobRequestSchema.safeParse({ ...valid, prompt: "   " }).success,
    ).toBe(false);
    expect(
      createImageJobRequestSchema.safeParse({ ...valid, mask_image: undefined })
        .success,
    ).toBe(false);
    expect(
      createImageJobRequestSchema.safeParse({ ...valid, input_images: [] })
        .success,
    ).toBe(false);
  });

  it("accepts canvas outpaint margins and preserves them in the Worker payload", () => {
    const valid = {
      prompt: "Continue the beach beyond the original frame",
      operation: "outpaint" as const,
      input_images: ["data:image/png;base64,aW1hZ2U="],
      outpaint_margins: { top: 12, right: 48, bottom: 0, left: 24 },
      canvas_id: "00000000-0000-4000-8000-000000000001",
      placeholder_element_id: "outpaint-placeholder-1",
    };

    expect(createImageJobRequestSchema.parse(valid).operation).toBe("outpaint");
    expect(normalizeImageGenerationPayload(valid)).toMatchObject({
      operation: "outpaint",
      input_images: valid.input_images,
      outpaint_margins: valid.outpaint_margins,
      target: {
        kind: "canvas",
        element_id: "outpaint-placeholder-1",
      },
    });
  });

  it("rejects invalid outpaint sources, masks, margins, and design targets", () => {
    const valid = {
      prompt: "Extend the scenery",
      operation: "outpaint" as const,
      input_images: ["data:image/png;base64,aW1hZ2U="],
      outpaint_margins: { top: 1, right: 0, bottom: 0, left: 0 },
    };
    const designTarget = {
      kind: "design" as const,
      design_id: "00000000-0000-4000-8000-000000000002",
      expected_revision: 1,
      idempotency_key: "00000000-0000-4000-8000-000000000003",
    };

    for (const candidate of [
      { ...valid, prompt: "   " },
      { ...valid, input_images: [] },
      { ...valid, input_images: [...valid.input_images, "second"] },
      { ...valid, mask_image: "data:image/png;base64,bWFzaw==" },
      { ...valid, outpaint_margins: undefined },
      { ...valid, outpaint_margins: { top: 0, right: 0, bottom: 0, left: 0 } },
      { ...valid, outpaint_margins: { top: 4097, right: 0, bottom: 0, left: 0 } },
      { ...valid, outpaint_margins: { top: 0.5, right: 0, bottom: 0, left: 0 } },
      valid,
      { ...valid, target: designTarget },
    ]) {
      expect(createImageJobRequestSchema.safeParse(candidate).success).toBe(false);
    }
    expect(
      createImageJobRequestSchema.safeParse({
        prompt: "ordinary generation",
        outpaint_margins: valid.outpaint_margins,
      }).success,
    ).toBe(false);
  });

  it("accepts a normalized region for guided matting", () => {
    const parsed = createImageJobRequestSchema.parse({
      prompt: "extract selected subject",
      operation: "region_matting",
      input_images: ["data:image/png;base64,AA=="],
      selection_region: { x: 0.2, y: 0.1, width: 0.5, height: 0.7 },
    });
    expect(parsed.selection_region).toEqual({
      x: 0.2,
      y: 0.1,
      width: 0.5,
      height: 0.7,
    });
  });

  it("rejects normalized regions that overflow the image", () => {
    expect(() =>
      createImageJobRequestSchema.parse({
        prompt: "extract selected subject",
        selection_region: { x: 0.7, y: 0.1, width: 0.5, height: 0.7 },
      }),
    ).toThrow();
  });

  it("rejects unknown image operations", () => {
    expect(() =>
      createImageJobRequestSchema.parse({
        prompt: "x",
        operation: "erase_everything",
      }),
    ).toThrow();
  });
});

describe("job routing normalization", () => {
  it("rejects modern target mixed with legacy routing", () => {
    expect(() =>
      createImageJobRequestSchema.parse({
        prompt: "generate",
        canvas_id: ids.canvas,
        target: null,
      }),
    ).toThrow();
    expect(() =>
      createVideoJobRequestSchema.parse({
        prompt: "generate",
        canvas_id: ids.canvas,
        target: { kind: "canvas", canvas_id: ids.canvas },
      }),
    ).toThrow();
  });

  it("normalizes chat-only jobs to an explicit null target", () => {
    expect(
      normalizeImageGenerationPayload({ prompt: "chat image" }).target,
    ).toBeNull();
    expect(
      normalizeVideoGenerationPayload({ prompt: "chat video" }).target,
    ).toBeNull();
  });

  it("preserves the optional native image resolution and rejects unknown tiers", () => {
    expect(normalizeImageGenerationPayload({ prompt: "native", resolution: "4k" }).resolution).toBe("4k");
    expect(createImageJobRequestSchema.safeParse({ prompt: "native", resolution: "8k" }).success).toBe(false);
  });

  it("normalizes legacy placeholder routing to an opaque canvas element id", () => {
    const payload = normalizeImageGenerationPayload({
      prompt: "legacy canvas image",
      canvas_id: ids.canvas,
      placement_x: 10,
      placement_y: 20,
      placement_width: 300,
      placement_height: 200,
      placeholder_element_id: "placeholder:image/123",
    });
    expect(payload.target).toEqual({
      kind: "canvas",
      canvas_id: ids.canvas,
      element_id: "placeholder:image/123",
      placement: { x: 10, y: 20, width: 300, height: 200 },
    });
    expect("placement_x" in payload).toBe(false);
  });

  it("preserves a modern design target without canvas aliases", () => {
    const target = {
      kind: "design" as const,
      design_id: ids.design,
      expected_revision: 2,
      idempotency_key: ids.request,
      placement: { x: 1, y: 2, role: "product" as const },
    };
    expect(
      normalizeImageGenerationPayload({ prompt: "design", target }).target,
    ).toEqual(target);
    expect(() =>
      normalizedImageGenerationPayloadSchema.parse({
        prompt: "ambiguous worker payload",
        target,
        canvas_id: ids.canvas,
      }),
    ).toThrow();
  });

  it("rejects incomplete legacy placement and duplicate image inputs", () => {
    expect(() =>
      createImageJobRequestSchema.parse({
        prompt: "bad placement",
        canvas_id: ids.canvas,
        placement_x: 1,
      }),
    ).toThrow();
    expect(() =>
      createImageJobRequestSchema.parse({
        prompt: "duplicate inputs",
        input_images: [
          "data:image/png;base64,AA==",
          "data:image/png;base64,AA==",
        ],
      }),
    ).toThrow();
  });
});

describe("background job target columns", () => {
  const job = {
    id: ids.request,
    workspace_id: ids.workspace,
    project_id: ids.project,
    canvas_id: null,
    target_kind: null,
    design_id: null,
    session_id: null,
    thread_id: null,
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    status: "queued",
    payload: {},
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: ids.user,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  } as const;

  it("accepts chat, canvas, design, and legacy canvas combinations", () => {
    expect(backgroundJobSchema.parse(job).target_kind).toBeNull();
    expect(
      backgroundJobSchema.parse({
        ...job,
        target_kind: "canvas",
        canvas_id: ids.canvas,
      }).target_kind,
    ).toBe("canvas");
    expect(
      backgroundJobSchema.parse({
        ...job,
        target_kind: "design",
        design_id: ids.design,
      }).target_kind,
    ).toBe("design");
    const { target_kind: _targetKind, ...legacyJob } = job;
    expect(
      backgroundJobSchema.parse({ ...legacyJob, canvas_id: ids.canvas })
        .canvas_id,
    ).toBe(ids.canvas);
  });

  it("rejects mixed target columns", () => {
    expect(() =>
      backgroundJobSchema.parse({
        ...job,
        target_kind: "design",
        canvas_id: ids.canvas,
        design_id: ids.design,
      }),
    ).toThrow();
    expect(() =>
      backgroundJobSchema.parse({
        ...job,
        target_kind: null,
        design_id: ids.design,
      }),
    ).toThrow();
  });

  it("parses a specialized design export Worker job", () => {
    const exportJob = {
      ...job,
      target_kind: "design" as const,
      design_id: ids.design,
      job_type: "design_export" as const,
      queue_name: "design_export_jobs",
      payload: {
        design_id: ids.design,
        revision: 3,
        idempotency_key: ids.request,
        requested_by: ids.user,
        format: "png" as const,
        multiplier: 2 as const,
        transparent: true,
      },
    };
    expect(backgroundJobWorkerSchema.parse(exportJob).job_type).toBe(
      "design_export",
    );
    expect(() =>
      backgroundJobWorkerSchema.parse({
        ...exportJob,
        payload: { ...exportJob.payload, design_id: ids.canvas },
      }),
    ).toThrow();
    expect(() =>
      backgroundJobWorkerSchema.parse({
        ...exportJob,
        payload: { prompt: "not an export payload", target: null },
      }),
    ).toThrow();
  });

  it("requires normalized generation payload routing to match the job row", () => {
    const workerJob = {
      ...job,
      target_kind: "canvas" as const,
      canvas_id: ids.canvas,
      payload: {
        prompt: "render",
        target: { kind: "canvas" as const, canvas_id: ids.canvas },
      },
    };
    expect(backgroundJobWorkerSchema.parse(workerJob).job_type).toBe(
      "image_generation",
    );
    expect(() =>
      backgroundJobWorkerSchema.parse({
        ...workerJob,
        payload: {
          ...workerJob.payload,
          target: { kind: "canvas", canvas_id: ids.design },
        },
      }),
    ).toThrow();
  });
});
