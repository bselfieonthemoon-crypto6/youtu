import {
  type DesignObject,
  type DesignPaint,
  type DesignShadow,
  type LoomicSceneV1,
  designCommandSchema,
  loomicSceneV1Schema,
} from "@loomic/shared";
import sharp from "sharp";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  DesignExportRenderer,
  DesignPreviewRenderer,
} from "./design-async-worker.js";
import { applyDesignCommands } from "./design-command-applier.js";
import {
  DESIGN_EXPORT_MAX_ESTIMATED_BYTES,
  DESIGN_EXPORT_MAX_PIXELS,
  DESIGN_EXPORT_MAX_SIDE,
  assertDesignExportBudget,
} from "./design-export-service.js";

const PREVIEW_MAX_EDGE = 512;
const PREVIEW_BUCKET = "workspace-assets";
const EXPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const EXPORT_TIMEOUT_MS = 120_000;
const EXPORT_MAX_SOURCE_ASSETS = 128;
const EXPORT_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const EXPORT_MAX_DECODED_SOURCE_PIXELS = 32_000_000;
const EXPORT_MAX_SINGLE_SOURCE_PIXELS = 32_000_000;

type AssetBinary = { buffer: Buffer; mimeType: string };

export class DesignPreviewRenderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DesignPreviewRenderError";
    this.code = code;
  }
}

export function createSupabaseDesignPreviewRenderer(): DesignPreviewRenderer {
  return {
    async render(input, context) {
      const admin = context.getAdminClient();
      const documentResult = await admin
        .from("design_documents")
        .select("id, workspace_id, project_id, revision, scene, deleted_at")
        .eq("id", input.designId)
        .eq("revision", input.revision)
        .is("deleted_at", null)
        .maybeSingle();
      if (documentResult.error) {
        throw new DesignPreviewRenderError(
          "design_preview_read_failed",
          documentResult.error.message,
        );
      }
      const document = documentResult.data;
      if (!document) {
        throw new DesignPreviewRenderError(
          "design_preview_stale",
          "The requested design revision is no longer current.",
        );
      }

      const scene = loomicSceneV1Schema.parse(document.scene);
      const assetObjectId = input.job.id;
      const objectPath = `${document.workspace_id}/design-previews/${document.id}/${input.revision}-${input.job.id}.webp`;
      const existing = await loadExistingRenderAsset(
        admin,
        {
          assetObjectId,
          workspaceId: document.workspace_id,
          projectId: document.project_id,
          objectPath,
          mimeType: "image/webp",
        },
        "preview",
      );
      if (existing) return { preview_asset_object_id: assetObjectId };
      const assetIds = referencedAssetIds(scene);
      const assets = new Map<string, AssetBinary>();
      if (assetIds.length > 0) {
        const metadataResult = await admin
          .from("asset_objects")
          .select("id, bucket, object_path, mime_type")
          .in("id", assetIds);
        if (metadataResult.error) {
          throw new DesignPreviewRenderError(
            "design_preview_asset_read_failed",
            metadataResult.error.message,
          );
        }
        const metadata = new Map(
          (metadataResult.data ?? []).map((row) => [row.id, row]),
        );
        for (const assetId of assetIds) {
          const row = metadata.get(assetId);
          if (!row) {
            throw missingAsset(assetId);
          }
          const downloaded = await admin.storage
            .from(row.bucket)
            .download(row.object_path);
          if (downloaded.error || !downloaded.data) {
            throw new DesignPreviewRenderError(
              "design_preview_asset_missing",
              `Unable to load design asset ${assetId}.`,
            );
          }
          assets.set(assetId, {
            buffer: Buffer.from(await downloaded.data.arrayBuffer()),
            mimeType: row.mime_type ?? "application/octet-stream",
          });
        }
      }

      await context.renewVt(120);
      const preview = await renderDesignPreviewBuffer(scene, assets);
      const uploaded = await admin.storage
        .from(PREVIEW_BUCKET)
        .upload(objectPath, preview, {
          contentType: "image/webp",
          cacheControl: "31536000",
          upsert: true,
        });
      if (uploaded.error) {
        throw new DesignPreviewRenderError(
          "design_preview_upload_failed",
          uploaded.error.message,
        );
      }

      const inserted = await admin.from("asset_objects").upsert(
        {
          id: assetObjectId,
          scope: "workspace",
          workspace_id: document.workspace_id,
          project_id: document.project_id,
          bucket: PREVIEW_BUCKET,
          object_path: objectPath,
          mime_type: "image/webp",
          byte_size: preview.byteLength,
          created_by: input.requestedBy,
        },
        { onConflict: "id", ignoreDuplicates: true },
      );
      if (inserted.error) {
        throw new DesignPreviewRenderError(
          "design_preview_asset_write_failed",
          inserted.error.message,
        );
      }
      return { preview_asset_object_id: assetObjectId };
    },
  };
}

export function createSupabaseDesignExportRenderer(): DesignExportRenderer {
  return {
    async render(input, context) {
      const deadlineAt = Date.now() + EXPORT_TIMEOUT_MS;
      const admin = context.getAdminClient();
      const document = await assertExportAuthorized(admin, input);

      const scene = await loadDesignSceneAtRevision(
        admin,
        document.id,
        input.payload.revision,
      );
      let budget: ReturnType<typeof assertDesignExportBudget>;
      try {
        budget = assertDesignExportBudget({
          width: scene.canvas.width,
          height: scene.canvas.height,
          multiplier: input.payload.multiplier,
        });
      } catch {
        throw new DesignPreviewRenderError(
          "design_export_pixel_budget_exceeded",
          `Export exceeds side=${DESIGN_EXPORT_MAX_SIDE}, pixels=${DESIGN_EXPORT_MAX_PIXELS}, or estimatedBytes=${DESIGN_EXPORT_MAX_ESTIMATED_BYTES}.`,
        );
      }
      const { width, height } = budget;
      await assertSceneResourcesAuthorized(admin, scene, document.workspace_id);
      const assets = await loadReferencedAssets(
        admin,
        scene,
        "export",
        document.workspace_id,
        deadlineAt,
      );
      const assetObjectId = input.job.id;
      const extension = input.payload.format === "jpeg" ? "jpg" : "png";
      const mimeType =
        input.payload.format === "jpeg" ? "image/jpeg" : "image/png";
      const objectPath = `${document.workspace_id}/design-exports/${document.id}/${input.payload.revision}-${input.job.id}.${extension}`;
      const existing = await loadExistingRenderAsset(
        admin,
        {
          assetObjectId,
          workspaceId: document.workspace_id,
          projectId: document.project_id,
          objectPath,
          mimeType,
        },
        "export",
      );
      if (existing) {
        await assertExportAuthorized(admin, input);
        await assertSceneResourcesAuthorized(
          admin,
          scene,
          document.workspace_id,
        );
        const expiryUpdate = await admin
          .from("asset_objects")
          .update({ gc_eligible_at: exportExpiresAt(input) })
          .eq("id", assetObjectId);
        if (expiryUpdate.error) {
          throw new DesignPreviewRenderError(
            "design_export_asset_write_failed",
            expiryUpdate.error.message,
          );
        }
        return exportResult(
          input,
          document.id,
          width,
          height,
          existing.byteSize,
        );
      }
      await context.renewVt(300);
      const output = await renderDesignExportBuffer(scene, assets, {
        format: input.payload.format,
        multiplier: input.payload.multiplier,
        transparent: input.payload.transparent,
        deadlineAt,
      });
      await assertExportAuthorized(admin, input);
      await assertSceneResourcesAuthorized(admin, scene, document.workspace_id);
      const expiresAt = exportExpiresAt(input);
      const uploaded = await admin.storage
        .from(PREVIEW_BUCKET)
        .upload(objectPath, output, {
          contentType: mimeType,
          cacheControl: "31536000",
          upsert: true,
        });
      if (uploaded.error) {
        throw new DesignPreviewRenderError(
          "design_export_upload_failed",
          uploaded.error.message,
        );
      }
      const inserted = await admin.from("asset_objects").upsert(
        {
          id: assetObjectId,
          scope: "workspace",
          workspace_id: document.workspace_id,
          project_id: document.project_id,
          bucket: PREVIEW_BUCKET,
          object_path: objectPath,
          mime_type: mimeType,
          byte_size: output.byteLength,
          created_by: input.payload.requested_by,
          gc_eligible_at: expiresAt,
        },
        { onConflict: "id", ignoreDuplicates: true },
      );
      if (inserted.error) {
        throw new DesignPreviewRenderError(
          "design_export_asset_write_failed",
          inserted.error.message,
        );
      }
      return exportResult(input, document.id, width, height, output.byteLength);
    },
  };
}

async function assertExportAuthorized(
  admin: AdminSupabaseClient,
  input: Parameters<DesignExportRenderer["render"]>[0],
) {
  const [documentResult, memberResult, jobResult] = await Promise.all([
    admin
      .from("design_documents")
      .select("id, workspace_id, project_id, deleted_at")
      .eq("id", input.payload.design_id)
      .maybeSingle(),
    admin
      .from("workspace_members")
      .select("workspace_id, user_id")
      .eq("workspace_id", input.job.workspace_id)
      .eq("user_id", input.payload.requested_by)
      .maybeSingle(),
    admin
      .from("background_jobs")
      .select("id, status")
      .eq("id", input.job.id)
      .maybeSingle(),
  ]);
  const document = documentResult.data;
  if (
    documentResult.error ||
    memberResult.error ||
    jobResult.error ||
    !document ||
    !memberResult.data ||
    !jobResult.data ||
    jobResult.data.status !== "running" ||
    document.deleted_at !== null ||
    document.workspace_id !== input.job.workspace_id ||
    document.project_id !== input.job.project_id
  ) {
    throw new DesignPreviewRenderError(
      "design_export_forbidden",
      "The export requester or target is no longer authorized.",
    );
  }
  return document;
}

async function assertSceneResourcesAuthorized(
  admin: AdminSupabaseClient,
  scene: LoomicSceneV1,
  workspaceId: string,
) {
  const resourceIds = [
    ...new Set(
      scene.objects.flatMap((object) =>
        (object.type === "image" || object.type === "svg") && object.resourceId
          ? [object.resourceId]
          : [],
      ),
    ),
  ];
  if (resourceIds.length > 0) {
    const resources = await admin
      .from("design_resources")
      .select("id, scope, workspace_id, status, deleted_at")
      .in("id", resourceIds);
    const allowed = new Set(
      (resources.data ?? [])
        .filter(
          (resource) =>
            resource.deleted_at === null &&
            ((resource.scope === "platform" &&
              resource.status === "published") ||
              (resource.scope === "workspace" &&
                resource.workspace_id === workspaceId)),
        )
        .map((resource) => resource.id),
    );
    if (resources.error || resourceIds.some((id) => !allowed.has(id))) {
      throw new DesignPreviewRenderError(
        "design_export_resource_forbidden",
        "A referenced catalog resource is no longer authorized.",
      );
    }
  }
  const assetIds = referencedAssetIds(scene);
  if (assetIds.length > 0) {
    const assets = await admin
      .from("asset_objects")
      .select("id, scope, workspace_id, deletion_pending_at")
      .in("id", assetIds);
    const allowed = new Set(
      (assets.data ?? [])
        .filter(
          (asset) =>
            asset.deletion_pending_at === null &&
            (asset.scope === "platform" ||
              (asset.scope === "workspace" &&
                asset.workspace_id === workspaceId)),
        )
        .map((asset) => asset.id),
    );
    if (assets.error || assetIds.some((id) => !allowed.has(id))) {
      throw new DesignPreviewRenderError(
        "design_export_asset_forbidden",
        "A referenced export asset is no longer authorized.",
      );
    }
  }
  const fontIds = [
    ...new Set(
      scene.objects.flatMap((object) =>
        "fontFaceId" in object && object.fontFaceId ? [object.fontFaceId] : [],
      ),
    ),
  ];
  if (fontIds.length > 0) {
    const fonts = await admin
      .from("font_faces")
      .select("id, scope, workspace_id, status, deleted_at")
      .in("id", fontIds);
    const allowed = new Set(
      (fonts.data ?? [])
        .filter(
          (font) =>
            font.deleted_at === null &&
            ((font.scope === "platform" && font.status === "published") ||
              (font.scope === "workspace" &&
                font.workspace_id === workspaceId)),
        )
        .map((font) => font.id),
    );
    if (fonts.error || fontIds.some((id) => !allowed.has(id))) {
      throw new DesignPreviewRenderError(
        "design_export_font_forbidden",
        "A referenced export font is no longer authorized.",
      );
    }
  }
}

export async function loadDesignSceneAtRevision(
  admin: AdminSupabaseClient,
  designId: string,
  revision: number,
): Promise<LoomicSceneV1> {
  type RevisionRow = {
    revision: number;
    parent_revision: number | null;
    command_batch: unknown;
    snapshot: unknown;
  };
  const rows: RevisionRow[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const result = await admin
      .from("design_document_versions")
      .select("revision, parent_revision, command_batch, snapshot")
      .eq("design_id", designId)
      .lte("revision", revision)
      .order("revision", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (result.error) {
      throw new DesignPreviewRenderError(
        "design_export_revision_read_failed",
        result.error.message,
      );
    }
    const page = (result.data ?? []) as RevisionRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  const targetIndex = rows.findIndex((row) => row.revision === revision);
  if (targetIndex < 0) {
    throw new DesignPreviewRenderError(
      "design_export_revision_missing",
      "The requested frozen design revision is unavailable.",
    );
  }
  let snapshotIndex = targetIndex;
  while (snapshotIndex >= 0 && rows[snapshotIndex]?.snapshot == null) {
    snapshotIndex -= 1;
  }
  const snapshotRow = rows[snapshotIndex];
  if (!snapshotRow) {
    throw new DesignPreviewRenderError(
      "design_export_revision_missing",
      "No snapshot exists for the requested frozen revision.",
    );
  }
  let scene = loomicSceneV1Schema.parse(snapshotRow.snapshot);
  let previousRevision = snapshotRow.revision;
  for (let index = snapshotIndex + 1; index <= targetIndex; index += 1) {
    const row = rows[index];
    if (!row || row.parent_revision !== previousRevision) {
      throw new DesignPreviewRenderError(
        "design_export_revision_corrupt",
        "The frozen revision chain is incomplete.",
      );
    }
    scene = applyDesignCommands(
      scene,
      designCommandSchema.array().parse(row.command_batch),
    );
    previousRevision = row.revision;
  }
  return loomicSceneV1Schema.parse(scene);
}

async function loadExistingRenderAsset(
  admin: AdminSupabaseClient,
  expected: {
    assetObjectId: string;
    workspaceId: string;
    projectId: string;
    objectPath: string;
    mimeType: string;
  },
  kind: "preview" | "export",
) {
  const result = await admin
    .from("asset_objects")
    .select(
      "id, workspace_id, project_id, bucket, object_path, mime_type, byte_size",
    )
    .eq("id", expected.assetObjectId)
    .maybeSingle();
  if (result.error) {
    throw new DesignPreviewRenderError(
      `design_${kind}_asset_read_failed`,
      result.error.message,
    );
  }
  if (!result.data) return null;
  const asset = result.data;
  if (
    asset.workspace_id !== expected.workspaceId ||
    asset.project_id !== expected.projectId ||
    asset.bucket !== PREVIEW_BUCKET ||
    asset.object_path !== expected.objectPath ||
    asset.mime_type !== expected.mimeType ||
    typeof asset.byte_size !== "number"
  ) {
    throw new DesignPreviewRenderError(
      `design_${kind}_asset_conflict`,
      `The durable ${kind} asset does not match this job.`,
    );
  }
  return { byteSize: asset.byte_size };
}

function exportResult(
  input: Parameters<DesignExportRenderer["render"]>[0],
  designId: string,
  width: number,
  height: number,
  byteSize: number,
) {
  return {
    asset_object_id: input.job.id,
    design_id: designId,
    revision: input.payload.revision,
    format: input.payload.format,
    width,
    height,
    byte_size: byteSize,
    expires_at: exportExpiresAt(input),
  };
}

function exportExpiresAt(input: Parameters<DesignExportRenderer["render"]>[0]) {
  return new Date(
    Date.parse(input.job.created_at) + EXPORT_RETENTION_MS,
  ).toISOString();
}

export async function renderDesignPreviewBuffer(
  rawScene: LoomicSceneV1,
  assets: ReadonlyMap<string, AssetBinary> = new Map(),
): Promise<Buffer> {
  const svg = await renderDesignPreviewSvg(rawScene, assets);
  return sharp(Buffer.from(svg)).webp({ quality: 86 }).toBuffer();
}

export async function renderDesignPreviewSvg(
  rawScene: LoomicSceneV1,
  assets: ReadonlyMap<string, AssetBinary> = new Map(),
  options?: {
    outputWidth: number;
    outputHeight: number;
    backgroundMode: "scene" | "transparent" | "opaque";
    deadlineAt?: number;
  },
): Promise<string> {
  const scene = loomicSceneV1Schema.parse(rawScene);
  const scale = Math.min(
    1,
    PREVIEW_MAX_EDGE / Math.max(scene.canvas.width, scene.canvas.height),
  );
  const width =
    options?.outputWidth ?? Math.max(1, Math.round(scene.canvas.width * scale));
  const height =
    options?.outputHeight ??
    Math.max(1, Math.round(scene.canvas.height * scale));
  const imageData = new Map<string, string>();
  for (const object of scene.objects) {
    if (object.type !== "image" && object.type !== "svg") continue;
    if (imageData.has(object.assetObjectId)) continue;
    const source = assets.get(object.assetObjectId);
    if (!source) throw missingAsset(object.assetObjectId);
    try {
      assertRenderDeadline(options?.deadlineAt);
      const pipeline = sharp(source.buffer, {
        animated: false,
        limitInputPixels: EXPORT_MAX_SINGLE_SOURCE_PIXELS,
      });
      if (options?.deadlineAt) {
        pipeline.timeout({
          seconds: remainingRenderSeconds(options.deadlineAt),
        });
      }
      const normalized = await pipeline.png().toBuffer();
      imageData.set(
        object.assetObjectId,
        `data:image/png;base64,${normalized.toString("base64")}`,
      );
    } catch {
      throw new DesignPreviewRenderError(
        "design_preview_asset_invalid",
        `Design asset ${object.assetObjectId} is not a supported image.`,
      );
    }
  }

  const definitions: string[] = [];
  const renderedObjects: string[] = [];
  const byId = new Map(
    scene.objects.map((object) => [object.objectId, object]),
  );
  const childIds = new Set(
    scene.objects.flatMap((object) =>
      object.type === "group" ? object.childObjectIds : [],
    ),
  );
  const renderTree = (object: DesignObject, index: number): string => {
    if (!object.visible) return "";
    if (object.type !== "group")
      return renderObject(object, index, definitions, imageData);
    const children = object.childObjectIds.flatMap((id) => {
      const child = byId.get(id);
      return child ? [child] : [];
    });
    if (!children.length) return "";
    const bounds = objectBounds(children);
    const scaleX = object.width / Math.max(0.001, bounds.width);
    const scaleY = object.height / Math.max(0.001, bounds.height);
    const targetCenterX = object.x + object.width / 2;
    const targetCenterY = object.y + object.height / 2;
    const sourceCenterX = bounds.x + bounds.width / 2;
    const sourceCenterY = bounds.y + bounds.height / 2;
    const transform = `translate(${targetCenterX} ${targetCenterY}) rotate(${object.rotation}) scale(${scaleX} ${scaleY}) translate(${-sourceCenterX} ${-sourceCenterY})`;
    return `<g opacity="${object.opacity}" transform="${transform}">${children
      .map((child) => renderTree(child, scene.objects.indexOf(child)))
      .join("")}</g>`;
  };
  for (const [index, object] of scene.objects.entries()) {
    if (childIds.has(object.objectId)) continue;
    renderedObjects.push(renderTree(object, index));
  }
  const body = renderedObjects.join("");
  const background =
    options?.backgroundMode === "transparent"
      ? ""
      : scene.canvas.background
        ? `<rect width="100%" height="100%" fill="${escapeXml(scene.canvas.background)}"/>`
        : options?.backgroundMode === "opaque"
          ? '<rect width="100%" height="100%" fill="#ffffff"/>'
          : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${scene.canvas.width} ${scene.canvas.height}"><defs>${definitions.join("")}</defs>${background}${body}</svg>`;
}

export async function renderDesignExportBuffer(
  rawScene: LoomicSceneV1,
  assets: ReadonlyMap<string, AssetBinary>,
  options: {
    format: "png" | "jpeg";
    multiplier: 1 | 2;
    transparent: boolean;
    deadlineAt?: number;
  },
): Promise<Buffer> {
  const scene = loomicSceneV1Schema.parse(rawScene);
  const width = scene.canvas.width * options.multiplier;
  const height = scene.canvas.height * options.multiplier;
  if (width * height > DESIGN_EXPORT_MAX_PIXELS) {
    throw new DesignPreviewRenderError(
      "design_export_pixel_budget_exceeded",
      `The requested export exceeds ${DESIGN_EXPORT_MAX_PIXELS} pixels.`,
    );
  }
  const svg = await renderDesignPreviewSvg(scene, assets, {
    outputWidth: width,
    outputHeight: height,
    backgroundMode: options.transparent ? "transparent" : "opaque",
    ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
  });
  assertRenderDeadline(options.deadlineAt);
  const pipeline = sharp(Buffer.from(svg), {
    limitInputPixels: DESIGN_EXPORT_MAX_PIXELS,
  });
  if (options.deadlineAt) {
    pipeline.timeout({ seconds: remainingRenderSeconds(options.deadlineAt) });
  }
  return options.format === "jpeg"
    ? pipeline
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 92 })
        .toBuffer()
    : pipeline.png().toBuffer();
}

async function loadReferencedAssets(
  admin: AdminSupabaseClient,
  scene: LoomicSceneV1,
  kind: "preview" | "export",
  workspaceId: string,
  deadlineAt?: number,
): Promise<Map<string, AssetBinary>> {
  const assetIds = referencedAssetIds(scene);
  const assets = new Map<string, AssetBinary>();
  if (assetIds.length === 0) return assets;
  if (kind === "export" && assetIds.length > EXPORT_MAX_SOURCE_ASSETS) {
    throw new DesignPreviewRenderError(
      "design_export_source_budget_exceeded",
      `Export references more than ${EXPORT_MAX_SOURCE_ASSETS} source assets.`,
    );
  }
  const metadataResult = await admin
    .from("asset_objects")
    .select(
      "id, scope, workspace_id, bucket, object_path, mime_type, byte_size, deletion_pending_at",
    )
    .in("id", assetIds);
  if (metadataResult.error) {
    throw new DesignPreviewRenderError(
      `design_${kind}_asset_read_failed`,
      metadataResult.error.message,
    );
  }
  const metadata = new Map(
    (metadataResult.data ?? []).map((row) => [row.id, row]),
  );
  let totalBytes = 0;
  let totalDecodedPixels = 0;
  for (const assetId of assetIds) {
    assertRenderDeadline(deadlineAt);
    const row = metadata.get(assetId);
    if (
      !row ||
      row.deletion_pending_at !== null ||
      (row.scope !== "platform" &&
        !(row.scope === "workspace" && row.workspace_id === workspaceId))
    )
      throw missingAsset(assetId, kind);
    const downloaded = await admin.storage
      .from(row.bucket)
      .download(row.object_path);
    if (downloaded.error || !downloaded.data) throw missingAsset(assetId, kind);
    const buffer = Buffer.from(await downloaded.data.arrayBuffer());
    totalBytes += buffer.byteLength;
    if (kind === "export" && totalBytes > EXPORT_MAX_SOURCE_BYTES) {
      throw new DesignPreviewRenderError(
        "design_export_source_budget_exceeded",
        `Export source assets exceed ${EXPORT_MAX_SOURCE_BYTES} bytes.`,
      );
    }
    if (kind === "export") {
      try {
        const probe = sharp(buffer, {
          animated: false,
          limitInputPixels: EXPORT_MAX_SINGLE_SOURCE_PIXELS,
        });
        if (deadlineAt) {
          probe.timeout({ seconds: remainingRenderSeconds(deadlineAt) });
        }
        const metadata = await probe.metadata();
        const decodedPixels = (metadata.width ?? 0) * (metadata.height ?? 0);
        if (decodedPixels <= 0) throw new Error("missing image dimensions");
        totalDecodedPixels += decodedPixels;
        if (totalDecodedPixels > EXPORT_MAX_DECODED_SOURCE_PIXELS) {
          throw new DesignPreviewRenderError(
            "design_export_source_budget_exceeded",
            `Export decoded source assets exceed ${EXPORT_MAX_DECODED_SOURCE_PIXELS} pixels.`,
          );
        }
      } catch (error) {
        if (error instanceof DesignPreviewRenderError) throw error;
        throw new DesignPreviewRenderError(
          "design_export_asset_invalid",
          `Design asset ${assetId} is not a supported bounded image.`,
        );
      }
    }
    assets.set(assetId, {
      buffer,
      mimeType: row.mime_type ?? "application/octet-stream",
    });
  }
  return assets;
}

function assertRenderDeadline(deadlineAt?: number) {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new DesignPreviewRenderError(
      "design_export_timeout",
      "The design export exceeded its execution time limit.",
    );
  }
}

function remainingRenderSeconds(deadlineAt: number) {
  assertRenderDeadline(deadlineAt);
  return Math.max(1, Math.ceil((deadlineAt - Date.now()) / 1_000));
}

function referencedAssetIds(scene: LoomicSceneV1): string[] {
  return [
    ...new Set(
      scene.objects.flatMap((object) =>
        object.type === "image" || object.type === "svg"
          ? [object.assetObjectId]
          : [],
      ),
    ),
  ];
}

function renderObject(
  object: Exclude<DesignObject, { type: "group" }>,
  index: number,
  definitions: string[],
  imageData: ReadonlyMap<string, string>,
): string {
  const transform = `rotate(${object.rotation} ${object.x + object.width / 2} ${object.y + object.height / 2})`;
  const common = `opacity="${object.opacity}" transform="${transform}"`;
  if (object.type === "image" || object.type === "svg") {
    const href = imageData.get(object.assetObjectId);
    if (!href) throw missingAsset(object.assetObjectId);
    const fit = object.type === "image" ? object.fit : "contain";
    const aspect =
      fit === "fill"
        ? "none"
        : fit === "cover"
          ? "xMidYMid slice"
          : "xMidYMid meet";
    const flipX = object.flipX ? -1 : 1;
    const flipY = object.flipY ? -1 : 1;
    const flip = `translate(${object.flipX ? object.x * 2 + object.width : 0} ${object.flipY ? object.y * 2 + object.height : 0}) scale(${flipX} ${flipY})`;
    if (object.type === "image") {
      const crop = object.crop ?? { x: 0, y: 0, width: 1, height: 1 };
      const imageX = object.x - (object.width * crop.x) / crop.width;
      const imageY = object.y - (object.height * crop.y) / crop.height;
      const imageWidth = object.width / crop.width;
      const imageHeight = object.height / crop.height;
      const clipId = `image-clip-${index}`;
      const mask = object.mask;
      const clipX = object.x + object.width * (mask?.x ?? 0);
      const clipY = object.y + object.height * (mask?.y ?? 0);
      const clipWidth = object.width * (mask?.width ?? 1);
      const clipHeight = object.height * (mask?.height ?? 1);
      definitions.push(
        `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${
          mask?.shape === "ellipse"
            ? `<ellipse cx="${clipX + clipWidth / 2}" cy="${clipY + clipHeight / 2}" rx="${clipWidth / 2}" ry="${clipHeight / 2}"/>`
            : `<rect x="${clipX}" y="${clipY}" width="${clipWidth}" height="${clipHeight}" rx="${
                mask?.shape === "rounded_rect"
                  ? Math.min(clipWidth, clipHeight) * (mask.radius ?? 0.1)
                  : 0
              }"/>`
        }</clipPath>`,
      );
      const filterAttribute = imageFilter(object, index, definitions);
      const stroke = paint(object.stroke, `image-stroke-${index}`, definitions);
      const strokeWidth = object.strokeWidth ?? 0;
      const outline =
        strokeWidth > 0 && stroke !== "none"
          ? mask?.shape === "ellipse"
            ? `<ellipse cx="${clipX + clipWidth / 2}" cy="${clipY + clipHeight / 2}" rx="${clipWidth / 2}" ry="${clipHeight / 2}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
            : `<rect x="${clipX}" y="${clipY}" width="${clipWidth}" height="${clipHeight}" rx="${
                mask?.shape === "rounded_rect"
                  ? Math.min(clipWidth, clipHeight) * (mask.radius ?? 0.1)
                  : 0
              }" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
          : "";
      return `<g opacity="${object.opacity}" transform="${transform} ${flip}" ${filterAttribute}><image x="${imageX}" y="${imageY}" width="${imageWidth}" height="${imageHeight}" href="${href}" preserveAspectRatio="${object.crop ? "none" : aspect}" clip-path="url(#${clipId})"/>${outline}</g>`;
    }
    return `<image x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" href="${href}" preserveAspectRatio="${aspect}" opacity="${object.opacity}" transform="${transform} ${flip}"/>`;
  }

  const fill =
    "fill" in object
      ? paint(object.fill, `fill-${index}`, definitions)
      : "none";
  const stroke =
    "stroke" in object
      ? paint(object.stroke, `stroke-${index}`, definitions)
      : "none";
  const strokeWidth = "strokeWidth" in object ? object.strokeWidth : 0;
  const shadow =
    "shadow" in object && object.shadow
      ? shadowFilter(object.shadow, `shadow-${index}`, definitions)
      : "";
  const style = `fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" ${shadow} ${common}`;
  switch (object.type) {
    case "rect":
      return `<rect x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}" rx="${object.radiusX ?? 0}" ry="${object.radiusY ?? 0}" ${style}/>`;
    case "circle":
      return `<ellipse cx="${object.x + object.width / 2}" cy="${object.y + object.height / 2}" rx="${object.width / 2}" ry="${object.height / 2}" ${style}/>`;
    case "triangle":
      return `<polygon points="${object.x + object.width / 2},${object.y} ${object.x + object.width},${object.y + object.height} ${object.x},${object.y + object.height}" ${style}/>`;
    case "line":
    case "arrow": {
      const markerId = `arrow-${index}`;
      if (
        object.type === "arrow" &&
        (object.arrowStart === "arrow" || object.arrowEnd === "arrow")
      ) {
        definitions.push(
          `<marker id="${markerId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${stroke}"/></marker>`,
        );
      }
      const markers =
        object.type === "arrow"
          ? `${object.arrowStart === "arrow" ? `marker-start="url(#${markerId})"` : ""} ${object.arrowEnd === "arrow" ? `marker-end="url(#${markerId})"` : ""}`
          : "";
      return `<line x1="${object.x1}" y1="${object.y1}" x2="${object.x2}" y2="${object.y2}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" ${common} ${markers}/>`;
    }
    case "text":
    case "textbox": {
      const lines =
        object.type === "textbox"
          ? wrapTextbox(
              object.text,
              object.width,
              object.fontSize,
              object.charSpacing,
            )
          : object.text.split("\n");
      const anchor =
        object.textAlign === "center"
          ? "middle"
          : object.textAlign === "right"
            ? "end"
            : "start";
      const x =
        object.textAlign === "center"
          ? object.x + object.width / 2
          : object.textAlign === "right"
            ? object.x + object.width
            : object.x;
      const letterSpacing = (object.fontSize * object.charSpacing) / 1000;
      return `<text x="${x}" y="${object.y + object.fontSize}" font-family="${escapeXml(object.fontFamily)}" font-size="${object.fontSize}" font-weight="${escapeXml(String(object.fontWeight))}" font-style="${object.fontStyle}" text-anchor="${anchor}" letter-spacing="${letterSpacing}" ${style}>${lines.map((line, lineIndex) => `<tspan x="${x}" dy="${lineIndex === 0 ? 0 : object.fontSize * object.lineHeight}">${escapeXml(line)}</tspan>`).join("")}</text>`;
    }
  }
}

function imageFilter(
  object: Extract<DesignObject, { type: "image" }>,
  index: number,
  definitions: string[],
) {
  const filters = object.filters;
  const shadow = object.shadow;
  if (!filters && !shadow) return "";
  const id = `image-filter-${index}`;
  const primitives: string[] = [];
  if (filters?.brightness !== undefined || filters?.contrast !== undefined) {
    const contrast = 1 + (filters.contrast ?? 0);
    const intercept = (filters.brightness ?? 0) - (filters.contrast ?? 0) / 2;
    primitives.push(
      `<feComponentTransfer><feFuncR type="linear" slope="${contrast}" intercept="${intercept}"/><feFuncG type="linear" slope="${contrast}" intercept="${intercept}"/><feFuncB type="linear" slope="${contrast}" intercept="${intercept}"/></feComponentTransfer>`,
    );
  }
  if (filters?.grayscale) {
    primitives.push('<feColorMatrix type="saturate" values="0"/>');
  } else if (filters?.saturation !== undefined) {
    primitives.push(
      `<feColorMatrix type="saturate" values="${1 + filters.saturation}"/>`,
    );
  }
  if (filters?.sepia) {
    primitives.push(
      '<feColorMatrix type="matrix" values="0.393 0.769 0.189 0 0 0.349 0.686 0.168 0 0 0.272 0.534 0.131 0 0 0 0 0 1 0"/>',
    );
  }
  if (filters?.blur !== undefined && filters.blur > 0) {
    primitives.push(`<feGaussianBlur stdDeviation="${filters.blur * 10}"/>`);
  }
  if (shadow) {
    primitives.push(
      `<feDropShadow dx="${shadow.offsetX}" dy="${shadow.offsetY}" stdDeviation="${shadow.blur / 2}" flood-color="${escapeXml(shadow.color)}" flood-opacity="${shadow.opacity}"/>`,
    );
  }
  definitions.push(
    `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">${primitives.join("")}</filter>`,
  );
  return `filter="url(#${id})"`;
}

function paint(
  value: DesignPaint | null | undefined,
  id: string,
  definitions: string[],
): string {
  if (!value) return "none";
  if (value.kind === "solid") return escapeXml(value.color);
  const stops = value.stops
    .map(
      (stop) =>
        `<stop offset="${stop.offset * 100}%" stop-color="${escapeXml(stop.color)}"/>`,
    )
    .join("");
  if (value.kind === "radial") {
    definitions.push(
      `<radialGradient id="${id}" cx="${value.centerX}" cy="${value.centerY}" r="${value.radius}">${stops}</radialGradient>`,
    );
  } else {
    definitions.push(
      `<linearGradient id="${id}" gradientTransform="rotate(${value.angle} .5 .5)">${stops}</linearGradient>`,
    );
  }
  return `url(#${id})`;
}

function shadowFilter(shadow: DesignShadow, id: string, definitions: string[]) {
  definitions.push(
    `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${shadow.offsetX}" dy="${shadow.offsetY}" stdDeviation="${shadow.blur / 2}" flood-color="${escapeXml(shadow.color)}" flood-opacity="${shadow.opacity}"/></filter>`,
  );
  return `filter="url(#${id})"`;
}

function objectBounds(objects: readonly DesignObject[]) {
  const left = Math.min(...objects.map((object) => object.x));
  const top = Math.min(...objects.map((object) => object.y));
  const right = Math.max(...objects.map((object) => object.x + object.width));
  const bottom = Math.max(...objects.map((object) => object.y + object.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function wrapTextbox(
  text: string,
  width: number,
  fontSize: number,
  charSpacing: number,
) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const character of paragraph) {
      const advance = characterAdvance(character, fontSize, charSpacing);
      if (line && lineWidth + advance > width) {
        lines.push(line.trimEnd());
        line = character.trimStart();
        lineWidth = line ? advance : 0;
      } else {
        line += character;
        lineWidth += advance;
      }
    }
    lines.push(line);
  }
  return lines;
}

function characterAdvance(
  character: string,
  fontSize: number,
  charSpacing: number,
) {
  const spacing = (fontSize * charSpacing) / 1000;
  if (/\s/u.test(character)) return fontSize * 0.33 + spacing;
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(character))
    return fontSize + spacing;
  return fontSize * 0.6 + spacing;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function missingAsset(
  assetId: string,
  kind: "preview" | "export" = "preview",
): DesignPreviewRenderError {
  return new DesignPreviewRenderError(
    `design_${kind}_asset_missing`,
    `Design asset ${assetId} is missing.`,
  );
}
