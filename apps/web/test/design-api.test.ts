import type { BackgroundJob } from "@loomic/shared";
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type DesignApiError,
  createDesignApiClient,
  createDesignRequestForCanvas,
} from "../src/lib/design-api";
import { fetchCanvas, saveCanvas } from "../src/lib/server-api";

const ids = {
  design: "10000000-0000-4000-8000-000000000001",
  object: "10000000-0000-4000-8000-000000000002",
  request: "20000000-0000-4000-8000-000000000001",
  canvas: "30000000-0000-4000-8000-000000000001",
  workspace: "40000000-0000-4000-8000-000000000001",
  project: "50000000-0000-4000-8000-000000000001",
} as const;

const fetchMock = vi.fn();

describe("typed design API client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv("NEXT_PUBLIC_SERVER_BASE_URL", "http://localhost:3001");
  });

  it("uses the authoritative Canvas revision when building create input", () => {
    expect(
      createDesignRequestForCanvas(
        { id: ids.canvas, revision: 12 },
        {
          request_id: ids.request,
          canvas_element_id: "design-node-1",
          width: 1080,
          height: 1080,
          background: "#ffffff",
          node: { x: 1, y: 2, width: 320, height: 320 },
        },
      ),
    ).toMatchObject({
      canvas_id: ids.canvas,
      expected_canvas_revision: 12,
    });
  });

  it("sends a strict CAS mutation and parses its response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        design_id: ids.design,
        revision: 5,
        changed_object_ids: [ids.object],
        replayed: false,
      }),
    );
    const client = createDesignApiClient({
      baseUrl: "http://localhost:3001/",
      fetch: fetchMock,
    });

    await expect(
      client.mutateDesign("token", {
        design_id: ids.design,
        expected_revision: 4,
        idempotency_key: ids.request,
        commands: [{ action: "scene.replace", scene: scene() }],
      }),
    ).resolves.toMatchObject({ revision: 5 });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3001/api/designs/${ids.design}/mutations`,
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer token",
          "content-type": "application/json",
        },
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toMatchObject({
      expected_revision: 4,
      idempotency_key: ids.request,
    });
  });

  it("preserves strict Canvas conflict metadata", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "CANVAS_REVISION_CONFLICT",
            message: "Canvas changed.",
            canvas_id: ids.canvas,
            latest_revision: 9,
            retryable: false,
          },
        },
        409,
      ),
    );
    const client = createDesignApiClient({ fetch: fetchMock });

    await expect(
      client.createDesign("token", {
        request_id: ids.request,
        canvas_id: ids.canvas,
        expected_canvas_revision: 8,
        canvas_element_id: "node-1",
        width: 100,
        height: 100,
        background: null,
        node: { x: 0, y: 0, width: 100, height: 100 },
      }),
    ).rejects.toMatchObject({
      code: "CANVAS_REVISION_CONFLICT",
      status: 409,
      conflict: { canvasId: ids.canvas, latestRevision: 9 },
    });
  });

  it("copies through the dedicated endpoint with Canvas CAS and stable ids", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        design_id: "60000000-0000-4000-8000-000000000001",
        canvas_element_id: "copied-node",
        design_revision: 0,
        canvas_revision: 10,
        replayed: false,
      }),
    );
    const client = createDesignApiClient({
      baseUrl: "http://localhost:3001",
      fetch: fetchMock,
    });

    await expect(
      client.copyDesign("token", {
        request_id: ids.request,
        source_design_id: ids.design,
        canvas_id: ids.canvas,
        expected_canvas_revision: 9,
        canvas_element_id: "copied-node",
        node: { x: 400, y: 20, width: 320, height: 180 },
      }),
    ).resolves.toMatchObject({ canvas_revision: 10 });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3001/api/designs/${ids.design}/copy`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toMatchObject({
      request_id: ids.request,
      expected_canvas_revision: 9,
      canvas_element_id: "copied-node",
    });
  });

  it("rejects malformed success payloads instead of trusting casts", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ design: { id: ids.design } }));
    const client = createDesignApiClient({ fetch: fetchMock });

    await expect(client.getDesign("token", ids.design)).rejects.toMatchObject({
      code: "response_invalid",
    });
  });

  it("restores only export jobs for the requested design", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jobs: [
          exportJob({ id: ids.request, design_id: ids.design }),
          exportJob({
            id: "20000000-0000-4000-8000-000000000002",
            design_id: "10000000-0000-4000-8000-000000000099",
          }),
        ],
      }),
    );
    const client = createDesignApiClient({
      baseUrl: "http://localhost:3001",
      fetch: fetchMock,
    });

    await expect(
      client.listDesignExportJobs("token", ids.design),
    ).resolves.toMatchObject([{ id: ids.request, design_id: ids.design }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/api/jobs?job_type=design_export",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("cancels an export through the authoritative jobs endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ job: exportJob({ status: "canceled" }) }),
    );
    const client = createDesignApiClient({
      baseUrl: "http://localhost:3001",
      fetch: fetchMock,
    });

    await expect(
      client.cancelDesignExportJob("token", ids.request),
    ).resolves.toMatchObject({ status: "canceled" });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3001/api/jobs/${ids.request}/cancel`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("submits a bound design image operation without serializing the source image", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        job: imageJob({ id: ids.request, design_id: ids.design }),
      }),
    );
    const client = createDesignApiClient({
      baseUrl: "http://localhost:3001",
      fetch: fetchMock,
    });

    await expect(
      client.createDesignImageJob("token", {
        project_id: ids.project,
        prompt: "Remove the background.",
        model: "local:feynobg",
        operation: "remove_background",
        target: {
          kind: "design",
          design_id: ids.design,
          expected_revision: 4,
          idempotency_key: ids.request,
          source_object_id: ids.object,
          expected_object_version: 3,
          source_asset_object_id: ids.canvas,
          placement: {
            x: 10,
            y: 20,
            width: 300,
            height: 200,
            fit: "cover",
            replace_object_id: ids.object,
          },
        },
      }),
    ).resolves.toMatchObject({ job_type: "image_generation" });
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toMatchObject({
      operation: "remove_background",
      target: {
        design_id: ids.design,
        source_object_id: ids.object,
        expected_object_version: 3,
        source_asset_object_id: ids.canvas,
        placement: { replace_object_id: ids.object },
      },
    });
    expect(body).not.toHaveProperty("input_images");
  });

  it("restores only image jobs bound to the requested design", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jobs: [
          imageJob({ id: ids.request, design_id: ids.design }),
          imageJob({
            id: "20000000-0000-4000-8000-000000000003",
            design_id: "10000000-0000-4000-8000-000000000099",
          }),
          exportJob({
            id: "20000000-0000-4000-8000-000000000004",
            design_id: ids.design,
          }),
        ],
      }),
    );
    const client = createDesignApiClient({ fetch: fetchMock });

    await expect(
      client.listDesignImageJobs("token", ids.design),
    ).resolves.toEqual([
      expect.objectContaining({
        id: ids.request,
        job_type: "image_generation",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/api/jobs?job_type=image_generation",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fetchCanvas exposes and validates the revision consumed by create", async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(
      jsonResponse({
        canvas: {
          id: ids.canvas,
          name: "Main Canvas",
          projectId: ids.project,
          revision: 14,
          content: { elements: [], appState: {}, files: {} },
        },
      }),
    );

    await expect(fetchCanvas("token", ids.canvas)).resolves.toMatchObject({
      canvas: { revision: 14 },
    });
  });

  it("saveCanvas returns the next authoritative revision", async () => {
    globalThis.fetch = fetchMock;
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, revision: 15 }));

    await expect(
      saveCanvas("token", ids.canvas, {
        elements: [],
        appState: {},
        files: {},
      }),
    ).resolves.toBe(15);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function scene() {
  return {
    schemaVersion: 1 as const,
    engine: "fabric" as const,
    canvas: { width: 1080, height: 1080, background: "#ffffff" },
    objects: [],
  };
}

function exportJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return { ...exportJobBase(), ...overrides };
}

function exportJobBase() {
  return {
    id: ids.request,
    workspace_id: ids.workspace,
    project_id: ids.project,
    canvas_id: null,
    target_kind: "design" as const,
    design_id: ids.design,
    session_id: null,
    thread_id: null,
    queue_name: "design_export_jobs",
    job_type: "design_export" as const,
    status: "queued" as const,
    payload: {
      design_id: ids.design,
      revision: 4,
      idempotency_key: ids.request,
      requested_by: ids.workspace,
      format: "png",
      multiplier: 2,
      transparent: false,
    },
    result: null,
    error_code: null,
    error_message: null,
    attempt_count: 0,
    max_attempts: 3,
    created_by: ids.workspace,
    created_at: "2026-09-04T00:00:00.000Z",
    updated_at: "2026-09-04T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    failed_at: null,
    canceled_at: null,
  };
}

function imageJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    ...exportJobBase(),
    queue_name: "image_generation_jobs",
    job_type: "image_generation",
    payload: {
      prompt: "Remove the background.",
      model: "local:feynobg",
      operation: "remove_background",
      target: {
        kind: "design",
        design_id: ids.design,
        expected_revision: 4,
        idempotency_key: ids.request,
        source_object_id: ids.object,
        expected_object_version: 3,
        source_asset_object_id: ids.canvas,
        placement: {
          x: 10,
          y: 20,
          width: 300,
          height: 200,
          fit: "cover",
          replace_object_id: ids.object,
        },
      },
    },
    ...overrides,
  };
}
