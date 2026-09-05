import type { CanvasContent, CanvasDetail, Json } from "@loomic/shared";

import type { AuthenticatedUser, UserSupabaseClient } from "../../supabase/user.js";
import { mergeCanvasContent } from "./canvas-content-merge.js";
import {
  collectCanvasOwnedStoragePaths,
  garbageCollectOrphanAssets,
  reconcileCanvasAssetReferences,
} from "./canvas-asset-references.js";

export class CanvasServiceError extends Error {
  readonly statusCode: number;
  readonly code: "canvas_not_found" | "canvas_save_failed";

  constructor(
    code: "canvas_not_found" | "canvas_save_failed",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type CanvasService = {
  getCanvas(user: AuthenticatedUser, canvasId: string): Promise<CanvasDetail>;
  getCanvasWorkspaceId?(
    user: AuthenticatedUser,
    canvasId: string,
  ): Promise<string>;
  saveCanvasContent(
    user: AuthenticatedUser,
    canvasId: string,
    content: CanvasContent,
  ): Promise<number>;
};

/**
 * Marker prefix for files that have been extracted to Supabase Storage.
 * Format: `oss://bucket/objectPath`
 */
const OSS_MARKER_PREFIX = "oss://";
const CANVAS_FILES_BUCKET = "workspace-assets";

export function createCanvasService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): CanvasService {
  return {
    async getCanvas(user, canvasId) {
      const client = options.createUserClient(user.accessToken);
      const { data, error } = await client
        .from("canvases")
        .select("id, name, project_id, revision, content")
        .eq("id", canvasId)
        .single();

      if (error || !data) {
        throw new CanvasServiceError("canvas_not_found", "Canvas not found.", 404);
      }

      const content = (data.content as CanvasContent) ?? { elements: [], appState: {} };

      // Resolve OSS-stored files back to base64 dataURLs for the frontend
      const resolvedContent = await resolveElementAssetUrls(
        client,
        await resolveFilesFromStorage(client, content),
      );

      return {
        id: data.id,
        name: data.name,
        projectId: data.project_id,
        revision: data.revision,
        content: resolvedContent,
      };
    },

    async saveCanvasContent(user, canvasId, content) {
      const client = options.createUserClient(user.accessToken);

      const { data: canvasRow, error: canvasError } = await client
        .from("canvases")
        .select("project_id")
        .eq("id", canvasId)
        .single();
      if (canvasError || !canvasRow) {
        throw new CanvasServiceError("canvas_not_found", "Canvas not found.", 404);
      }
      const { data: projectRow, error: projectError } = await client
        .from("projects")
        .select("workspace_id")
        .eq("id", canvasRow.project_id)
        .single();
      if (projectError || !projectRow) {
        throw new CanvasServiceError("canvas_not_found", "Canvas not found.", 404);
      }

      // Extract base64 files to Storage, replacing dataURLs with oss:// markers
      const leanContent = await extractFilesToStorage(
        client,
        projectRow.workspace_id,
        canvasId,
        content,
      );

      // Optimistic merge prevents an older browser snapshot from overwriting
      // elements inserted concurrently by the Agent or another tab.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { data: latest, error: readError } = await client
          .from("canvases")
          .select("content, updated_at, revision")
          .eq("id", canvasId)
          .single();
        if (readError || !latest) break;

        const merged = mergeCanvasContent(
          (latest.content as CanvasContent) ?? { elements: [], appState: {} },
          leanContent,
        );
        const { data: updated, error } = await client
          .from("canvases")
          .update({
            content: merged as unknown as Json,
            revision: latest.revision + 1,
          })
          .eq("id", canvasId)
          .eq("updated_at", latest.updated_at)
          .eq("revision", latest.revision)
          .select("id, revision")
          .maybeSingle();

        if (error) {
          throw new CanvasServiceError(
            "canvas_save_failed",
            "Unable to save canvas.",
            500,
          );
        }
        if (updated) {
          const orphanAssetIds = await reconcileCanvasAssetReferences(
            client as any,
            canvasId,
            merged,
          );
          await garbageCollectOrphanAssets(client as any, orphanAssetIds);

          const oldPaths = new Set(collectCanvasOwnedStoragePaths(
            (latest.content as CanvasContent) ?? { elements: [], appState: {} },
            projectRow.workspace_id,
            canvasId,
          ));
          const livePaths = new Set(collectCanvasOwnedStoragePaths(
            merged,
            projectRow.workspace_id,
            canvasId,
          ));
          const removedPaths = [...oldPaths].filter((path) => !livePaths.has(path));
          if (removedPaths.length > 0) {
            await client.storage.from(CANVAS_FILES_BUCKET).remove(removedPaths);
          }
          return updated.revision;
        }
      }

      throw new CanvasServiceError(
        "canvas_save_failed",
        "Canvas changed while saving. Please retry.",
        409,
      );
    },

    async getCanvasWorkspaceId(user, canvasId) {
      const client = options.createUserClient(user.accessToken);
      const { data: canvas, error: canvasError } = await client
        .from("canvases")
        .select("project_id")
        .eq("id", canvasId)
        .single();
      if (canvasError || !canvas)
        throw new CanvasServiceError("canvas_not_found", "Canvas not found.", 404);
      const { data: project, error: projectError } = await client
        .from("projects")
        .select("workspace_id")
        .eq("id", canvas.project_id)
        .single();
      if (projectError || !project)
        throw new CanvasServiceError("canvas_not_found", "Canvas not found.", 404);
      return project.workspace_id;
    },
  };
}

// ---------------------------------------------------------------------------
// File extraction (save path): base64 dataURL → Supabase Storage + oss:// marker
// ---------------------------------------------------------------------------

type CanvasFileRecord = Record<string, Record<string, unknown>>;

async function extractFilesToStorage(
  client: UserSupabaseClient,
  workspaceId: string,
  canvasId: string,
  content: CanvasContent,
): Promise<CanvasContent> {
  const files = (content as { files?: CanvasFileRecord }).files;
  if (!files || Object.keys(files).length === 0) {
    return content;
  }

  const updatedFiles: CanvasFileRecord = {};

  await Promise.all(
    Object.entries(files).map(async ([fileId, fileData]) => {
      const dataURL = fileData.dataURL as string | undefined;
      const storageRef = fileData.storageRef as string | undefined;

      // A signed URL was hydrated to dataURL in the browser. Preserve the
      // private object marker instead of uploading a duplicate object.
      if (storageRef?.startsWith(OSS_MARKER_PREFIX)) {
        updatedFiles[fileId] = {
          ...fileData,
          dataURL: storageRef,
          storageUrl: undefined,
        };
        return;
      }

      // Already extracted to storage — keep marker
      if (dataURL?.startsWith(OSS_MARKER_PREFIX)) {
        updatedFiles[fileId] = fileData;
        return;
      }

      // Only process base64 data URLs
      if (!dataURL?.startsWith("data:")) {
        updatedFiles[fileId] = fileData;
        return;
      }

      try {
        const { buffer, mimeType } = parseDataURL(dataURL);
        const ext = mimeToExt(mimeType);
        const objectPath = `${workspaceId}/canvas-files/${canvasId}/${fileId}.${ext}`;

        // Upsert: the same file ID may be re-saved
        const { error: uploadError } = await client.storage
          .from(CANVAS_FILES_BUCKET)
          .upload(objectPath, buffer, { contentType: mimeType, upsert: true });

        if (uploadError) {
          // On upload failure, keep the original base64 (graceful degradation)
          updatedFiles[fileId] = fileData;
          return;
        }

        updatedFiles[fileId] = {
          ...fileData,
          dataURL: `${OSS_MARKER_PREFIX}${CANVAS_FILES_BUCKET}/${objectPath}`,
        };
      } catch {
        // Unparseable dataURL — keep as-is
        updatedFiles[fileId] = fileData;
      }
    }),
  );

  return {
    ...content,
    files: updatedFiles,
  } as CanvasContent;
}

// ---------------------------------------------------------------------------
// File resolution (load path): oss:// marker → base64 dataURL
// ---------------------------------------------------------------------------

async function resolveFilesFromStorage(
  client: UserSupabaseClient,
  content: CanvasContent,
): Promise<CanvasContent> {
  const files = (content as { files?: CanvasFileRecord }).files;
  if (!files || Object.keys(files).length === 0) {
    return content;
  }

  // Separate OSS files from inline files
  const updatedFiles: CanvasFileRecord = {};
  const ossEntries: Array<{ fileId: string; fileData: Record<string, unknown>; bucket: string; objectPath: string }> = [];
  const assetIdsByFile = new Map<string, string>();
  for (const element of (content.elements ?? []) as Array<Record<string, unknown>>) {
    const fileId = element.fileId;
    const customData = element.customData as Record<string, unknown> | undefined;
    if (typeof fileId === "string" && typeof customData?.assetId === "string") {
      assetIdsByFile.set(fileId, customData.assetId);
    }
  }

  for (const [fileId, fileData] of Object.entries(files)) {
    const dataURL = fileData.dataURL as string | undefined;
    if (!dataURL?.startsWith(OSS_MARKER_PREFIX)) {
      updatedFiles[fileId] = fileData;
      continue;
    }

    const ref = dataURL.slice(OSS_MARKER_PREFIX.length);
    const slashIdx = ref.indexOf("/");
    if (slashIdx === -1) continue;
    const assetId = assetIdsByFile.get(fileId);
    if (assetId) {
      updatedFiles[fileId] = {
        ...fileData,
        assetId,
        dataURL: undefined,
        storageRef: dataURL,
      };
      continue;
    }
    ossEntries.push({
      fileId,
      fileData,
      bucket: ref.slice(0, slashIdx),
      objectPath: ref.slice(slashIdx + 1),
    });
  }

  if (ossEntries.length === 0) {
    return content;
  }

  // Resolve short-lived private URLs instead of downloading each file.
  // Group by bucket (normally all in one bucket)
  const byBucket = new Map<string, typeof ossEntries>();
  for (const entry of ossEntries) {
    const list = byBucket.get(entry.bucket) ?? [];
    list.push(entry);
    byBucket.set(entry.bucket, list);
  }

  for (const [bucket, entries] of byBucket) {
    const signedUrls = await createSignedUrlMap(
      client,
      bucket,
      entries.map((entry) => entry.objectPath),
    );
    for (const entry of entries) {
      const signedUrl = signedUrls.get(entry.objectPath);
      if (!signedUrl) continue;
      updatedFiles[entry.fileId] = {
        ...entry.fileData,
        dataURL: undefined,
        storageRef: `${OSS_MARKER_PREFIX}${bucket}/${entry.objectPath}`,
        storageUrl: signedUrl,
      };
    }
  }

  return {
    ...content,
    files: updatedFiles,
  } as CanvasContent;
}

async function resolveElementAssetUrls(
  client: UserSupabaseClient,
  content: CanvasContent,
): Promise<CanvasContent> {
  const elements = (content.elements ?? []) as Array<Record<string, unknown>>;
  const assetIds = [...new Set(elements.flatMap((element) => {
    if (element.isDeleted) return [];
    const customData = element.customData as Record<string, unknown> | undefined;
    return typeof customData?.assetId === "string" ? [customData.assetId] : [];
  }))];
  if (assetIds.length === 0) return content;

  const assets: Array<{ id: string; bucket: string; object_path: string }> = [];
  for (let start = 0; start < assetIds.length; start += 100) {
    const { data } = await client
      .from("asset_objects")
      .select("id, bucket, object_path")
      .in("id", assetIds.slice(start, start + 100));
    if (data) assets.push(...data);
  }
  const urls = new Map<string, string>();
  const assetsByBucket = new Map<string, typeof assets>();
  for (const asset of assets) {
    const list = assetsByBucket.get(asset.bucket) ?? [];
    list.push(asset);
    assetsByBucket.set(asset.bucket, list);
  }
  for (const [bucket, bucketAssets] of assetsByBucket) {
    const signedUrls = await createSignedUrlMap(
      client,
      bucket,
      bucketAssets.map((asset) => asset.object_path),
    );
    for (const asset of bucketAssets) {
      const signedUrl = signedUrls.get(asset.object_path);
      if (signedUrl) urls.set(asset.id, signedUrl);
    }
  }

  const files = {
    ...((content as { files?: CanvasFileRecord }).files ?? {}),
  };
  for (const element of elements) {
    const customData = element.customData as Record<string, unknown> | undefined;
    const assetId = customData?.assetId;
    const fileId = element.fileId;
    const url = typeof assetId === "string" ? urls.get(assetId) : undefined;
    if (!url || typeof fileId !== "string") continue;
    const existing = files[fileId] ?? {};
    const existingDataURL = existing.dataURL;
    files[fileId] = {
      ...existing,
      id: existing.id ?? fileId,
      assetId,
      dataURL: undefined,
      ...(typeof existingDataURL === "string" &&
      existingDataURL.startsWith(OSS_MARKER_PREFIX)
        ? { storageRef: existingDataURL }
        : {}),
      storageUrl: url,
    };
  }

  return {
    ...content,
    files,
    elements: elements.map((element) => {
      const customData = element.customData as Record<string, unknown> | undefined;
      const assetId = customData?.assetId;
      const url = typeof assetId === "string" ? urls.get(assetId) : undefined;
      if (!url) return element;
      return {
        ...element,
        ...(customData?.isVideo ? { link: url } : {}),
        customData: { ...customData, storageUrl: url },
      };
    }),
  } as CanvasContent;
}

async function createSignedUrlMap(
  client: UserSupabaseClient,
  bucket: string,
  objectPaths: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (let start = 0; start < objectPaths.length; start += 100) {
    const batch = objectPaths.slice(start, start + 100);
    const { data, error } = await client.storage
      .from(bucket)
      .createSignedUrls(batch, 900);
    if (error || !data) continue;
    for (let index = 0; index < data.length; index += 1) {
      const signedUrl = data[index]?.signedUrl;
      const objectPath = data[index]?.path ?? batch[index];
      if (signedUrl && objectPath) result.set(objectPath, signedUrl);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseDataURL(dataURL: string): { buffer: Buffer; mimeType: string } {
  // Format: data:[<mediatype>][;base64],<data>
  const match = dataURL.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) {
    throw new Error("Invalid data URL");
  }
  return {
    mimeType: match[1]!,
    buffer: Buffer.from(match[2]!, "base64"),
  };
}

function mimeToExt(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/svg+xml": return "svg";
    case "image/gif": return "gif";
    default: return "bin";
  }
}
