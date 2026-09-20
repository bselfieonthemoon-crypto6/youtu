import { randomUUID } from "node:crypto";

import type { DesignExportResult, LoomicSceneV1 } from "@loomic/shared";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import {
  type DesignPreviewRenderError,
  createSupabaseDesignExportRenderer,
  createSupabaseDesignPreviewRenderer,
  loadDesignSceneAtRevision,
  renderDesignExportBuffer,
  renderDesignPreviewBuffer,
  renderDesignPreviewSvg,
} from "./design-preview-renderer.js";
import { parseExportDimensionReceipt } from "../../agent/nonstandard-export-deliverable.js";

describe("design preview renderer", () => {
  it("reconstructs a frozen revision from its nearest snapshot and command chain", async () => {
    const designId = randomUUID();
    const objectId = randomUUID();
    const initial = baseScene(100, 100);
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      lte: vi.fn(() => query),
      order: vi.fn(() => query),
      range: vi.fn(async () => ({
        data: [
          {
            revision: 0,
            parent_revision: null,
            command_batch: [],
            snapshot: initial,
          },
          {
            revision: 1,
            parent_revision: 0,
            snapshot: null,
            command_batch: [
              {
                action: "object.add",
                object: {
                  objectId,
                  objectVersion: 1,
                  type: "rect",
                  x: 10,
                  y: 10,
                  width: 20,
                  height: 20,
                  rotation: 0,
                  opacity: 1,
                  zIndex: 0,
                  locked: false,
                  visible: true,
                  fill: { kind: "solid", color: "#ff0000" },
                  stroke: null,
                  strokeWidth: 0,
                },
              },
            ],
          },
        ],
        error: null,
      })),
    };
    const scene = await loadDesignSceneAtRevision(
      { from: vi.fn(() => query) } as never,
      designId,
      1,
    );
    expect(scene.objects.map((object) => object.objectId)).toEqual([objectId]);
  });

  it("reconstructs frozen revisions beyond the PostgREST default row limit", async () => {
    const designId = randomUUID();
    const initial = baseScene(100, 100);
    const rows = Array.from({ length: 1_002 }, (_, revision) => ({
      revision,
      parent_revision: revision === 0 ? null : revision - 1,
      command_batch: [],
      snapshot: revision === 0 ? initial : null,
    }));
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      lte: vi.fn(() => query),
      order: vi.fn(() => query),
      range: vi.fn(async (from: number, to: number) => ({
        data: rows.slice(from, to + 1),
        error: null,
      })),
    };

    const scene = await loadDesignSceneAtRevision(
      { from: vi.fn(() => query) } as never,
      designId,
      1_001,
    );

    expect(scene).toEqual(initial);
    expect(query.range).toHaveBeenCalledTimes(3);
    expect(query.range).toHaveBeenLastCalledWith(1_000, 1_499);
  });

  it("renders a transparent scene at no more than 512 pixels on its largest edge", async () => {
    const scene = baseScene(1600, 900);
    scene.objects.push({
      objectId: randomUUID(),
      objectVersion: 1,
      type: "rect",
      name: "Card",
      x: 100,
      y: 100,
      width: 800,
      height: 400,
      rotation: 0,
      opacity: 1,
      zIndex: 0,
      locked: false,
      visible: true,
      fill: { kind: "solid", color: "#ff3366" },
      stroke: null,
      strokeWidth: 0,
      radiusX: 30,
      radiusY: 30,
    });

    const output = await renderDesignPreviewBuffer(scene);
    const metadata = await sharp(output).metadata();

    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(288);
    expect(metadata.hasAlpha).toBe(true);
  });

  it("fails a background export after its hard render deadline", async () => {
    await expect(
      renderDesignExportBuffer(baseScene(100, 100), new Map(), {
        format: "png",
        multiplier: 1,
        transparent: true,
        deadlineAt: Date.now() - 1,
      }),
    ).rejects.toMatchObject({ code: "design_export_timeout" });
  });

  it("renders exact PNG and JPEG export dimensions with explicit alpha behavior", async () => {
    const scene = baseScene(320, 180);
    const transparentPng = await renderDesignExportBuffer(scene, new Map(), {
      format: "png",
      multiplier: 2,
      transparent: true,
    });
    const jpeg = await renderDesignExportBuffer(scene, new Map(), {
      format: "jpeg",
      multiplier: 1,
      transparent: false,
    });

    await expect(sharp(transparentPng).metadata()).resolves.toMatchObject({
      format: "png",
      width: 640,
      height: 360,
      hasAlpha: true,
    });
    await expect(sharp(jpeg).metadata()).resolves.toMatchObject({
      format: "jpeg",
      width: 320,
      height: 180,
      hasAlpha: false,
    });
  });

  it("reuses the job-derived export asset after a post-upload crash", async () => {
    const jobId = randomUUID();
    const designId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const requestedBy = randomUUID();
    const scene = baseScene(64, 32);
    const objectPath = `${workspaceId}/design-exports/${designId}/2-${jobId}.png`;
    let assetRow: Record<string, unknown> | null = null;
    let storedBytes: Buffer | null = null;
    const designQuery = {
      select: vi.fn(() => designQuery),
      eq: vi.fn(() => designQuery),
      is: vi.fn(() => designQuery),
      maybeSingle: vi.fn(async () => ({
        data: {
          id: designId,
          workspace_id: workspaceId,
          project_id: projectId,
          revision: 2,
          scene,
          deleted_at: null,
        },
        error: null,
      })),
    };
    const versionQuery = {
      select: vi.fn(() => versionQuery),
      eq: vi.fn(() => versionQuery),
      lte: vi.fn(() => versionQuery),
      order: vi.fn(() => versionQuery),
      range: vi.fn(async () => ({
        data: [
          {
            revision: 2,
            parent_revision: 1,
            command_batch: [],
            snapshot: scene,
          },
        ],
        error: null,
      })),
    };
    const assetQuery = {
      select: vi.fn(() => assetQuery),
      eq: vi.fn(() => assetQuery),
      maybeSingle: vi.fn(async () => ({ data: assetRow, error: null })),
      update: vi.fn(() => ({
        eq: vi.fn(async () => ({ data: null, error: null })),
      })),
      upsert: vi.fn(async (row: Record<string, unknown>) => {
        assetRow = row;
        return { error: null };
      }),
    };
    const memberQuery = {
      select: vi.fn(() => memberQuery),
      eq: vi.fn(() => memberQuery),
      maybeSingle: vi.fn(async () => ({
        data: { workspace_id: workspaceId, user_id: requestedBy },
        error: null,
      })),
    };
    const jobQuery = {
      select: vi.fn(() => jobQuery),
      eq: vi.fn(() => jobQuery),
      maybeSingle: vi.fn(async () => ({
        data: { id: jobId, status: "running" },
        error: null,
      })),
    };
    const upload = vi.fn(async (_path: string, body: Buffer) => {
      storedBytes = body;
      return { data: { path: objectPath }, error: null };
    });
    // The replay path re-reads the stored artifact instead of trusting the
    // persisted byte_size, so a replayed export is verified from the same bytes.
    const download = vi.fn(async () => ({
      data: storedBytes ? new Blob([new Uint8Array(storedBytes)]) : null,
      error: null,
    }));
    const admin = {
      from: vi.fn((table: string) =>
        table === "design_documents"
          ? designQuery
          : table === "design_document_versions"
            ? versionQuery
            : table === "workspace_members"
              ? memberQuery
              : table === "background_jobs"
                ? jobQuery
                : assetQuery,
      ),
      storage: { from: vi.fn(() => ({ upload, download })) },
    };
    const renderer = createSupabaseDesignExportRenderer();
    const input = {
      job: {
        id: jobId,
        workspace_id: workspaceId,
        project_id: projectId,
        created_at: "2026-09-04T00:00:00.000Z",
      },
      payload: {
        design_id: designId,
        revision: 2,
        idempotency_key: randomUUID(),
        format: "png",
        multiplier: 1,
        transparent: true,
        requested_by: requestedBy,
      },
    };
    const context = {
      getAdminClient: () => admin,
      renewVt: vi.fn(async () => undefined),
    };

    const first = await renderer.render(input as never, context as never);
    // Simulate the worker dying here, before JobService.markSucceeded.
    const replay = await renderer.render(input as never, context as never);

    expect(replay).toEqual(first);
    expect(first.asset_object_id).toBe(jobId);
    expect(first.expires_at).toBe("2026-09-11T00:00:00.000Z");
    // The replayed result is verified from the stored bytes: its receipt and its
    // width/height are byte-derived on both passes, not only on the first.
    expect(download).toHaveBeenCalledWith(objectPath);
    expect(first).toMatchObject({
      width: 64,
      height: 32,
      dimension_receipt: {
        actualExportSize: { width: 64, height: 32 },
        pixelVerification: { source: "encoded_bytes", format: "png" },
        matches: true,
        mismatches: [],
      },
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(assetQuery.upsert).toHaveBeenCalledTimes(1);
    expect(assetQuery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ gc_eligible_at: "2026-09-11T00:00:00.000Z" }),
      expect.anything(),
    );
  });

  it("rejects export output when membership is revoked during rendering", async () => {
    const jobId = randomUUID();
    const designId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const requestedBy = randomUUID();
    const scene = baseScene(32, 32);
    const designQuery = {
      select: vi.fn(() => designQuery),
      eq: vi.fn(() => designQuery),
      maybeSingle: vi.fn(async () => ({
        data: {
          id: designId,
          workspace_id: workspaceId,
          project_id: projectId,
          deleted_at: null,
        },
        error: null,
      })),
    };
    const versionQuery = {
      select: vi.fn(() => versionQuery),
      eq: vi.fn(() => versionQuery),
      lte: vi.fn(() => versionQuery),
      order: vi.fn(() => versionQuery),
      range: vi.fn(async () => ({
        data: [
          {
            revision: 0,
            parent_revision: null,
            command_batch: [],
            snapshot: scene,
          },
        ],
        error: null,
      })),
    };
    const memberQuery = {
      select: vi.fn(() => memberQuery),
      eq: vi.fn(() => memberQuery),
      maybeSingle: vi
        .fn()
        .mockResolvedValueOnce({
          data: { workspace_id: workspaceId, user_id: requestedBy },
          error: null,
        })
        .mockResolvedValueOnce({ data: null, error: null }),
    };
    const jobQuery = {
      select: vi.fn(() => jobQuery),
      eq: vi.fn(() => jobQuery),
      maybeSingle: vi.fn(async () => ({
        data: { id: jobId, status: "running" },
        error: null,
      })),
    };
    const assetQuery = {
      select: vi.fn(() => assetQuery),
      eq: vi.fn(() => assetQuery),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    const upload = vi.fn();
    const admin = {
      from: vi.fn((table: string) =>
        table === "design_documents"
          ? designQuery
          : table === "design_document_versions"
            ? versionQuery
            : table === "workspace_members"
              ? memberQuery
              : table === "background_jobs"
                ? jobQuery
                : assetQuery,
      ),
      storage: { from: vi.fn(() => ({ upload })) },
    };
    const renderer = createSupabaseDesignExportRenderer();
    await expect(
      renderer.render(
        {
          job: {
            id: jobId,
            workspace_id: workspaceId,
            project_id: projectId,
            created_at: "2026-09-04T00:00:00.000Z",
          },
          payload: {
            design_id: designId,
            revision: 0,
            idempotency_key: randomUUID(),
            requested_by: requestedBy,
            format: "png",
            multiplier: 1,
            transparent: true,
          },
        } as never,
        { getAdminClient: () => admin, renewVt: vi.fn() } as never,
      ),
    ).rejects.toMatchObject({ code: "design_export_forbidden" });
    expect(upload).not.toHaveBeenCalled();
  });

  it("reuses the job-derived preview asset after a post-upload crash", async () => {
    const jobId = randomUUID();
    const designId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const requestedBy = randomUUID();
    const scene = baseScene(64, 32);
    const objectPath = `${workspaceId}/design-previews/${designId}/2-${jobId}.webp`;
    let assetRow: Record<string, unknown> | null = null;
    const designQuery = {
      select: vi.fn(() => designQuery),
      eq: vi.fn(() => designQuery),
      is: vi.fn(() => designQuery),
      maybeSingle: vi.fn(async () => ({
        data: {
          id: designId,
          workspace_id: workspaceId,
          project_id: projectId,
          revision: 2,
          scene,
          deleted_at: null,
        },
        error: null,
      })),
    };
    const assetQuery = {
      select: vi.fn(() => assetQuery),
      eq: vi.fn(() => assetQuery),
      maybeSingle: vi.fn(async () => ({ data: assetRow, error: null })),
      upsert: vi.fn(async (row: Record<string, unknown>) => {
        assetRow = row;
        return { error: null };
      }),
    };
    const upload = vi.fn(async () => ({
      data: { path: objectPath },
      error: null,
    }));
    const admin = {
      from: vi.fn((table: string) =>
        table === "design_documents" ? designQuery : assetQuery,
      ),
      storage: { from: vi.fn(() => ({ upload })) },
    };
    const renderer = createSupabaseDesignPreviewRenderer();
    const input = {
      job: { id: jobId },
      designId,
      revision: 2,
      requestedBy,
    };
    const context = {
      getAdminClient: () => admin,
      renewVt: vi.fn(async () => undefined),
    };

    const first = await renderer.render(input as never, context as never);
    const replay = await renderer.render(input as never, context as never);

    expect(replay).toEqual(first);
    expect(first.preview_asset_object_id).toBe(jobId);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(assetQuery.upsert).toHaveBeenCalledTimes(1);
  });

  it("renders normalized private image assets without retaining source markup", async () => {
    const assetObjectId = randomUUID();
    const scene = baseScene(256, 256);
    scene.objects.push({
      objectId: randomUUID(),
      objectVersion: 1,
      type: "image",
      assetObjectId,
      fit: "cover",
      x: 32,
      y: 32,
      width: 192,
      height: 192,
      rotation: 0,
      opacity: 1,
      zIndex: 0,
      locked: false,
      visible: true,
    });
    const source = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: "#0066ff",
      },
    })
      .png()
      .toBuffer();

    const output = await renderDesignPreviewBuffer(
      scene,
      new Map([[assetObjectId, { buffer: source, mimeType: "image/png" }]]),
    );
    const metadata = await sharp(output).metadata();

    expect(metadata.width).toBe(256);
    expect(metadata.height).toBe(256);
  });

  it("renders image crop, mask, filters, stroke and shadow in server output", async () => {
    const assetObjectId = randomUUID();
    const scene = baseScene(200, 100);
    scene.objects.push({
      objectId: randomUUID(),
      objectVersion: 1,
      type: "image",
      assetObjectId,
      fit: "cover",
      x: 10,
      y: 10,
      width: 160,
      height: 80,
      rotation: 0,
      opacity: 1,
      zIndex: 0,
      locked: false,
      visible: true,
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      mask: { shape: "ellipse", x: 0, y: 0, width: 1, height: 1 },
      filters: { brightness: 0.2, contrast: -0.1, sepia: true },
      stroke: { kind: "solid", color: "#ffffff" },
      strokeWidth: 3,
      shadow: {
        color: "#000000",
        blur: 8,
        offsetX: 2,
        offsetY: 4,
        opacity: 0.3,
      },
    });
    const source = await sharp({
      create: {
        width: 16,
        height: 8,
        channels: 4,
        background: "#0066ff",
      },
    })
      .png()
      .toBuffer();

    const svg = await renderDesignPreviewSvg(
      scene,
      new Map([[assetObjectId, { buffer: source, mimeType: "image/png" }]]),
    );

    expect(svg).toContain('id="image-clip-0"');
    expect(svg).toContain("<ellipse");
    expect(svg).toContain('filter="url(#image-filter-0)"');
    expect(svg).toContain("feComponentTransfer");
    expect(svg).toContain("feColorMatrix");
    expect(svg).toContain("feDropShadow");
    expect(svg).toContain('stroke="#ffffff"');
    expect(svg).toContain('stroke-width="3"');
  });

  it("fails explicitly when a referenced asset is unavailable", async () => {
    const assetObjectId = randomUUID();
    const scene = baseScene(100, 100);
    scene.objects.push({
      objectId: randomUUID(),
      objectVersion: 1,
      type: "svg",
      assetObjectId,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      opacity: 1,
      zIndex: 0,
      locked: false,
      visible: true,
    });

    await expect(renderDesignPreviewBuffer(scene)).rejects.toMatchObject({
      code: "design_preview_asset_missing",
    } satisfies Partial<DesignPreviewRenderError>);
  });

  it("renders transformed groups, exact arrow ends, shadows and textbox wrapping", async () => {
    const groupId = randomUUID();
    const rectId = randomUUID();
    const textId = randomUUID();
    const arrowId = randomUUID();
    const noArrowId = randomUUID();
    const scene = baseScene(800, 600);
    scene.objects.push(
      {
        objectId: groupId,
        objectVersion: 2,
        type: "group",
        x: 200,
        y: 100,
        width: 400,
        height: 240,
        rotation: 30,
        opacity: 0.8,
        zIndex: 0,
        locked: false,
        visible: true,
        childObjectIds: [rectId, textId],
      },
      {
        objectId: rectId,
        objectVersion: 1,
        type: "rect",
        x: 100,
        y: 100,
        width: 200,
        height: 80,
        rotation: 10,
        opacity: 1,
        zIndex: 1,
        locked: false,
        visible: true,
        fill: { kind: "solid", color: "#ff0000" },
        stroke: null,
        strokeWidth: 0,
        shadow: {
          color: "#000000",
          blur: 12,
          offsetX: 4,
          offsetY: 6,
          opacity: 0.5,
        },
      },
      {
        objectId: textId,
        objectVersion: 1,
        type: "textbox",
        x: 100,
        y: 200,
        width: 200,
        height: 40,
        rotation: 0,
        opacity: 1,
        zIndex: 2,
        locked: false,
        visible: true,
        text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
        fontFamily: "Arial",
        fontSize: 20,
        fontWeight: 400,
        fontStyle: "normal",
        textAlign: "left",
        lineHeight: 1.2,
        charSpacing: 0,
        fill: { kind: "solid", color: "#ffffff" },
        shadow: {
          color: "#112233",
          blur: 8,
          offsetX: 2,
          offsetY: 3,
          opacity: 0.7,
        },
      },
      {
        objectId: arrowId,
        objectVersion: 1,
        type: "arrow",
        x: 50,
        y: 400,
        width: 200,
        height: 1,
        rotation: 0,
        opacity: 1,
        zIndex: 3,
        locked: false,
        visible: true,
        stroke: { kind: "solid", color: "#00ff00" },
        strokeWidth: 4,
        x1: 50,
        y1: 400,
        x2: 250,
        y2: 400,
        arrowStart: "arrow",
        arrowEnd: "none",
      },
      {
        objectId: noArrowId,
        objectVersion: 1,
        type: "arrow",
        x: 300,
        y: 400,
        width: 200,
        height: 1,
        rotation: 0,
        opacity: 1,
        zIndex: 4,
        locked: false,
        visible: true,
        stroke: { kind: "solid", color: "#0000ff" },
        strokeWidth: 4,
        x1: 300,
        y1: 400,
        x2: 500,
        y2: 400,
        arrowStart: "none",
        arrowEnd: "none",
      },
    );

    const svg = await renderDesignPreviewSvg(scene);

    expect(svg).toContain(
      '<g opacity="0.8" transform="translate(400 220) rotate(30) scale(2 1.7142857142857142) translate(-200 -170)">',
    );
    expect(svg).toContain(
      '<feDropShadow dx="4" dy="6" stdDeviation="6" flood-color="#000000" flood-opacity="0.5"/>',
    );
    expect(svg).toContain('filter="url(#shadow-2)"');
    expect(svg).toContain('marker-start="url(#arrow-3)"');
    expect(svg).not.toContain('marker-end="url(#arrow-3)"');
    expect(svg).not.toContain('id="arrow-4"');
    expect(svg.match(/<tspan /g)?.length).toBeGreaterThan(1);

    const output = await renderDesignPreviewBuffer(scene);
    await expect(sharp(output).metadata()).resolves.toMatchObject({
      format: "webp",
      width: 512,
      height: 384,
    });
  });

  it("delivers an exact target frame and reports the size read back from the uploaded bytes", async () => {
    const jobId = randomUUID();
    const designId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const requestedBy = randomUUID();
    // A 1280x416 (3:1) board asked for as a 320x70 (4.571:1) delivery: the frame
    // the export must deliver is NOT canvas × multiplier, so the old path could
    // only ever have reported the wrong one.
    const scene = baseScene(1280, 416);
    scene.objects.push({
      objectId: randomUUID(),
      objectVersion: 1,
      type: "rect",
      name: "Band",
      x: 0,
      y: 0,
      width: 1280,
      height: 416,
      rotation: 0,
      opacity: 1,
      zIndex: 0,
      locked: false,
      visible: true,
      fill: { kind: "solid", color: "#ff3366" },
      stroke: null,
      strokeWidth: 0,
    });
    const objectPath = `${workspaceId}/design-exports/${designId}/2-${jobId}.png`;
    let uploaded: Buffer | null = null;
    const designQuery = {
      select: vi.fn(() => designQuery),
      eq: vi.fn(() => designQuery),
      is: vi.fn(() => designQuery),
      maybeSingle: vi.fn(async () => ({
        data: {
          id: designId,
          workspace_id: workspaceId,
          project_id: projectId,
          revision: 2,
          scene,
          deleted_at: null,
        },
        error: null,
      })),
    };
    const versionQuery = {
      select: vi.fn(() => versionQuery),
      eq: vi.fn(() => versionQuery),
      lte: vi.fn(() => versionQuery),
      order: vi.fn(() => versionQuery),
      range: vi.fn(async () => ({
        data: [
          {
            revision: 2,
            parent_revision: 1,
            command_batch: [],
            snapshot: scene,
          },
        ],
        error: null,
      })),
    };
    const assetQuery = {
      select: vi.fn(() => assetQuery),
      eq: vi.fn(() => assetQuery),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      upsert: vi.fn(async () => ({ error: null })),
    };
    const memberQuery = {
      select: vi.fn(() => memberQuery),
      eq: vi.fn(() => memberQuery),
      maybeSingle: vi.fn(async () => ({
        data: { workspace_id: workspaceId, user_id: requestedBy },
        error: null,
      })),
    };
    const jobQuery = {
      select: vi.fn(() => jobQuery),
      eq: vi.fn(() => jobQuery),
      maybeSingle: vi.fn(async () => ({
        data: { id: jobId, status: "running" },
        error: null,
      })),
    };
    const upload = vi.fn(async (_path: string, body: Buffer) => {
      uploaded = body;
      return { data: { path: objectPath }, error: null };
    });
    const admin = {
      from: vi.fn((table: string) =>
        table === "design_documents"
          ? designQuery
          : table === "design_document_versions"
            ? versionQuery
            : table === "workspace_members"
              ? memberQuery
              : table === "background_jobs"
                ? jobQuery
                : assetQuery,
      ),
      storage: { from: vi.fn(() => ({ upload })) },
    };
    const renderer = createSupabaseDesignExportRenderer();

    const result: DesignExportResult = await renderer.render(
      {
        job: {
          id: jobId,
          workspace_id: workspaceId,
          project_id: projectId,
          created_at: "2026-09-04T00:00:00.000Z",
        },
        payload: {
          design_id: designId,
          revision: 2,
          idempotency_key: randomUUID(),
          requested_by: requestedBy,
          format: "png",
          multiplier: 1,
          transparent: true,
          target_size: { width: 320, height: 70 },
        },
      } as never,
      { getAdminClient: () => admin, renewVt: vi.fn(async () => undefined) } as never,
    );

    // ① the requested frame, ④ read out of the uploaded artifact's own header.
    expect(result).toMatchObject({
      width: 320,
      height: 70,
      format: "png",
      dimension_receipt: {
        targetSize: { width: 320, height: 70 },
        actualExportSize: { width: 320, height: 70 },
        format: "png",
        matches: true,
        mismatches: [],
        pixelVerification: {
          source: "encoded_bytes",
          actualSize: { width: 320, height: 70 },
          headerSize: { width: 320, height: 70 },
          decodedSize: { width: 320, height: 70 },
        },
      },
    });
    // The receipt's size and the number in the job result agree with the bytes
    // that were actually stored, and the stored artifact really is 320x70.
    const receipt = parseExportDimensionReceipt(result.dimension_receipt);
    expect(receipt).not.toBeNull();
    expect(receipt?.actualExportSize).toEqual({ width: 320, height: 70 });
    expect(result.width).toBe(receipt?.actualExportSize?.width);
    expect(uploaded).not.toBeNull();
    await expect(sharp(uploaded as unknown as Buffer).metadata()).resolves.toMatchObject({
      format: "png",
      width: 320,
      height: 70,
    });
    expect(result.byte_size).toBe((uploaded as unknown as Buffer).byteLength);
    // The receipt followed the artifact, not the budget: canvas × multiplier
    // (1280x416) is nowhere in the reported delivery.
    expect(result.width).not.toBe(scene.canvas.width);
  });

  it("keeps the delivered frame unchanged when the request names no target size", async () => {
    const jobId = randomUUID();
    const designId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const requestedBy = randomUUID();
    const scene = baseScene(320, 180);
    const objectPath = `${workspaceId}/design-exports/${designId}/0-${jobId}.png`;
    let uploaded: Buffer | null = null;
    const designQuery = {
      select: vi.fn(() => designQuery),
      eq: vi.fn(() => designQuery),
      is: vi.fn(() => designQuery),
      maybeSingle: vi.fn(async () => ({
        data: {
          id: designId,
          workspace_id: workspaceId,
          project_id: projectId,
          revision: 0,
          scene,
          deleted_at: null,
        },
        error: null,
      })),
    };
    const versionQuery = {
      select: vi.fn(() => versionQuery),
      eq: vi.fn(() => versionQuery),
      lte: vi.fn(() => versionQuery),
      order: vi.fn(() => versionQuery),
      range: vi.fn(async () => ({
        data: [{ revision: 0, parent_revision: null, command_batch: [], snapshot: scene }],
        error: null,
      })),
    };
    const assetQuery = {
      select: vi.fn(() => assetQuery),
      eq: vi.fn(() => assetQuery),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      upsert: vi.fn(async () => ({ error: null })),
    };
    const memberQuery = {
      select: vi.fn(() => memberQuery),
      eq: vi.fn(() => memberQuery),
      maybeSingle: vi.fn(async () => ({
        data: { workspace_id: workspaceId, user_id: requestedBy },
        error: null,
      })),
    };
    const jobQuery = {
      select: vi.fn(() => jobQuery),
      eq: vi.fn(() => jobQuery),
      maybeSingle: vi.fn(async () => ({
        data: { id: jobId, status: "running" },
        error: null,
      })),
    };
    const upload = vi.fn(async (_path: string, body: Buffer) => {
      uploaded = body;
      return { data: { path: objectPath }, error: null };
    });
    const admin = {
      from: vi.fn((table: string) =>
        table === "design_documents"
          ? designQuery
          : table === "design_document_versions"
            ? versionQuery
            : table === "workspace_members"
              ? memberQuery
              : table === "background_jobs"
                ? jobQuery
                : assetQuery,
      ),
      storage: { from: vi.fn(() => ({ upload })) },
    };
    const renderer = createSupabaseDesignExportRenderer();

    const result = await renderer.render(
      {
        job: {
          id: jobId,
          workspace_id: workspaceId,
          project_id: projectId,
          created_at: "2026-09-04T00:00:00.000Z",
        },
        payload: {
          design_id: designId,
          revision: 0,
          idempotency_key: randomUUID(),
          requested_by: requestedBy,
          format: "png",
          multiplier: 2,
          transparent: false,
        },
      } as never,
      { getAdminClient: () => admin, renewVt: vi.fn(async () => undefined) } as never,
    );

    // No request size: canvas × multiplier, as before — and now confirmed by the
    // bytes rather than asserted by the budget.
    expect(result).toMatchObject({
      width: 640,
      height: 360,
      dimension_receipt: {
        targetSize: { width: 640, height: 360 },
        actualExportSize: { width: 640, height: 360 },
        matches: true,
        mismatches: [],
      },
    });
    await expect(sharp(uploaded as unknown as Buffer).metadata()).resolves.toMatchObject({
      width: 640,
      height: 360,
    });
    // A same-ratio frame must be a real 2x render, not a 320x180 raster padded or
    // stretched into 640x360: the delivered pixels are the scene rasterized at the
    // delivered frame, so they are identical to a direct 640x360 render. (The two
    // files differ in container detail — the composition re-encodes with explicit
    // compression settings — so the PIXELS are what is compared.)
    const renderedAtTarget = await renderDesignExportBuffer(scene, new Map(), {
      format: "png",
      multiplier: 1,
      transparent: false,
      outputSize: { width: 640, height: 360 },
    });
    const rgb = (buffer: Buffer) =>
      sharp(buffer).removeAlpha().raw().toBuffer();
    expect((await rgb(uploaded as unknown as Buffer)).equals(await rgb(renderedAtTarget))).toBe(true);
  });
});

function baseScene(width: number, height: number): LoomicSceneV1 {
  return {
    schemaVersion: 1,
    engine: "fabric",
    canvas: { width, height, background: null },
    objects: [],
  };
}
