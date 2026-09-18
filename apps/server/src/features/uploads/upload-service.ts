import type { AssetBucket, AssetObject } from "@loomic/shared";
import sharp from "sharp";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";

export class UploadServiceError extends Error {
  readonly statusCode: number;
  readonly code: "upload_failed" | "asset_not_found" | "asset_in_use";

  constructor(
    code: "upload_failed" | "asset_not_found" | "asset_in_use",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type UploadFileInput = {
  bucket: AssetBucket;
  fileName: string;
  fileBuffer: Buffer;
  mimeType: string;
  workspaceId: string;
  projectId?: string | undefined;
};

export type UploadService = {
  uploadFile(
    user: AuthenticatedUser,
    input: UploadFileInput,
  ): Promise<{ asset: AssetObject; url: string }>;

  getAssetUrl(user: AuthenticatedUser, assetId: string): Promise<string>;

  getAssetContent(
    user: AuthenticatedUser,
    assetId: string,
    options?: { preview?: boolean },
  ): Promise<{ buffer: Buffer; mimeType: string }>;

  deleteAsset(user: AuthenticatedUser, assetId: string): Promise<void>;
};

const SIGNED_URL_EXPIRY_SECONDS = 900;
const MAX_CONCURRENT_CANVAS_PREVIEWS = 8;
let activeCanvasPreviews = 0;
const canvasPreviewWaiters: Array<() => void> = [];

export function createUploadService(options: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
}): UploadService {
  return {
    async uploadFile(user, input) {
      const client = options.getAdminClient();
      await assertUploadPermission(
        client,
        user.id,
        input.workspaceId,
        input.projectId,
      );
      if (input.mimeType === "image/svg+xml") {
        assertSafeUploadedSvg(input.fileBuffer);
      }

      const objectPath = buildObjectPath(
        input.workspaceId,
        input.projectId,
        input.fileName,
      );

      const { error: storageError } = await client.storage
        .from(input.bucket)
        .upload(objectPath, input.fileBuffer, {
          contentType: input.mimeType,
          upsert: false,
        });

      if (storageError) {
        throw new UploadServiceError(
          "upload_failed",
          `Storage upload failed: ${storageError.message}`,
          500,
        );
      }

      const { data: assetRow, error: insertError } = await client
        .from("asset_objects")
        .insert({
          workspace_id: input.workspaceId,
          bucket: input.bucket,
          object_path: objectPath,
          mime_type: input.mimeType,
          byte_size: input.fileBuffer.length,
          created_by: user.id,
          ...(input.projectId ? { project_id: input.projectId } : {}),
        })
        .select(
          "id, bucket, object_path, mime_type, byte_size, workspace_id, project_id, created_at",
        )
        .single();

      if (
        insertError ||
        !assetRow ||
        assetRow.workspace_id !== input.workspaceId
      ) {
        // Clean up the uploaded file on DB insert failure
        await client.storage.from(input.bucket).remove([objectPath]);
        throw new UploadServiceError(
          "upload_failed",
          "Failed to record asset metadata.",
          500,
        );
      }

      const url = await getAssetUrl(client, input.bucket, objectPath);

      return {
        asset: {
          id: assetRow.id,
          bucket: assetRow.bucket as AssetBucket,
          objectPath: assetRow.object_path,
          mimeType: assetRow.mime_type,
          byteSize: assetRow.byte_size,
          workspaceId: input.workspaceId,
          projectId: assetRow.project_id,
          createdAt: assetRow.created_at,
        },
        url,
      };
    },

    async getAssetUrl(user, assetId) {
      const client = options.createUserClient(user.accessToken);

      const { data: assetRow, error } = await client
        .from("asset_objects")
        .select("bucket, object_path")
        .eq("id", assetId)
        .single();

      if (error || !assetRow) {
        throw new UploadServiceError(
          "asset_not_found",
          "Asset not found.",
          404,
        );
      }

      return getAssetUrl(client, assetRow.bucket, assetRow.object_path);
    },

    async getAssetContent(user, assetId, contentOptions = {}) {
      const client = options.createUserClient(user.accessToken);
      const read = async () => {
        const { data: assetRow, error } = await client
          .from("asset_objects")
          .select("bucket, object_path, mime_type, byte_size")
          .eq("id", assetId)
          .single();

        if (error || !assetRow) {
          throw new UploadServiceError(
            "asset_not_found",
            "Asset not found.",
            404,
          );
        }
        if ((assetRow.byte_size ?? 0) > 30 * 1024 * 1024) {
          throw new UploadServiceError(
            "upload_failed",
            "Asset is too large to display.",
            413,
          );
        }

        const { data: blob, error: downloadError } = await client.storage
          .from(assetRow.bucket)
          .download(assetRow.object_path);
        if (downloadError || !blob) {
          throw new UploadServiceError(
            "asset_not_found",
            "Asset file is unavailable.",
            404,
          );
        }

        const original = Buffer.from(await blob.arrayBuffer());
        const mimeType =
          assetRow.mime_type ?? blob.type ?? "application/octet-stream";
        if (
          contentOptions.preview &&
          ["image/png", "image/jpeg", "image/webp"].includes(mimeType)
        ) {
          try {
            const buffer = await sharp(original, { animated: false })
              .rotate()
              .resize({
                width: 1280,
                height: 1280,
                fit: "inside",
                withoutEnlargement: true,
              })
              .webp({ quality: 78, effort: 3 })
              .toBuffer();
            return { buffer, mimeType: "image/webp" };
          } catch {
            // Preserve compatibility with unusual but browser-decodable files.
          }
        }

        return { buffer: original, mimeType };
      };

      return contentOptions.preview ? withCanvasPreviewSlot(read) : read();
    },

    async deleteAsset(user, assetId) {
      const client = options.getAdminClient();
      const asset = await client
        .from("asset_objects")
        .select("scope, workspace_id")
        .eq("id", assetId)
        .maybeSingle();
      if (
        asset.error ||
        !asset.data ||
        asset.data.scope !== "workspace" ||
        !asset.data.workspace_id
      ) {
        throw new UploadServiceError(
          "asset_not_found",
          "Asset not found.",
          404,
        );
      }
      await assertUploadPermission(
        client,
        user.id,
        asset.data.workspace_id,
        undefined,
      );

      const { data: claimed, error: claimError } = await callLegacyAssetRpc(
        client,
        "loomic_orphan_asset_claim",
        { p_asset_id: assetId },
      );
      if (claimError) {
        throw new UploadServiceError(
          "asset_not_found",
          "Asset not found.",
          404,
        );
      }
      const assetRow = Array.isArray(claimed) ? claimed[0] : null;
      if (!assetRow) {
        throw new UploadServiceError(
          "asset_in_use",
          "Asset is still used by a canvas.",
          409,
        );
      }

      const { error: removeError } = await client.storage
        .from(assetRow.bucket)
        .remove([assetRow.object_path]);
      if (removeError) {
        throw new UploadServiceError(
          "upload_failed",
          "Failed to delete asset file.",
          500,
        );
      }

      const { data: finalized, error: finalizeError } =
        await callLegacyAssetRpc(client, "loomic_orphan_asset_finalize", {
          p_asset_id: assetId,
        });
      if (finalizeError || finalized !== true) {
        throw new UploadServiceError(
          "upload_failed",
          "Failed to finalize asset deletion.",
          500,
        );
      }
    },
  };
}

/**
 * Fabric may parse workspace SVGs in the browser, so uploaded SVG must be
 * self-contained declarative artwork. Reject active content and external
 * references instead of attempting a lossy regex rewrite.
 */
export function assertSafeUploadedSvg(buffer: Buffer): void {
  const source = buffer.toString("utf8");
  const unsafe =
    !/<svg(?:\s|>)/i.test(source) ||
    /<!doctype|<!entity|<script|<foreignObject|<iframe|<object|<embed|<link|<style[^>]*>@import/i.test(
      source,
    ) ||
    /\bon[a-z]+\s*=/i.test(source) ||
    /(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|javascript:|file:)/i.test(
      source,
    ) ||
    /url\(\s*["']?\s*(?:https?:|\/\/|javascript:|file:)/i.test(source);
  if (unsafe) {
    throw new UploadServiceError(
      "upload_failed",
      "SVG contains active content or external references.",
      400,
    );
  }
}

async function withCanvasPreviewSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeCanvasPreviews >= MAX_CONCURRENT_CANVAS_PREVIEWS) {
    await new Promise<void>((resolve) => canvasPreviewWaiters.push(resolve));
  }
  activeCanvasPreviews += 1;
  try {
    return await task();
  } finally {
    activeCanvasPreviews -= 1;
    canvasPreviewWaiters.shift()?.();
  }
}

async function assertUploadPermission(
  admin: AdminSupabaseClient,
  userId: string,
  workspaceId: string,
  projectId: string | undefined,
): Promise<void> {
  const membership = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .in("role", ["owner", "admin"])
    .maybeSingle();
  if (
    membership.error ||
    !membership.data ||
    !["owner", "admin"].includes(String(membership.data.role))
  ) {
    throw new UploadServiceError(
      "upload_failed",
      "You do not have permission to upload to this workspace.",
      403,
    );
  }

  if (!projectId) return;
  const project = await admin
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (project.error || !project.data) {
    throw new UploadServiceError(
      "upload_failed",
      "The upload project does not belong to this workspace.",
      403,
    );
  }
}

async function callLegacyAssetRpc(
  client: UserSupabaseClient | AdminSupabaseClient,
  functionName: "loomic_orphan_asset_claim" | "loomic_orphan_asset_finalize",
  args: { p_asset_id: string },
): Promise<{ data: unknown; error: { message?: string } | null }> {
  const rpc = client.rpc as unknown as (
    name: string,
    rpcArgs: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
  return rpc.call(client, functionName, args);
}

function buildObjectPath(
  workspaceId: string,
  projectId: string | undefined,
  fileName: string,
): string {
  const timestamp = Date.now();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (projectId) {
    return `${workspaceId}/${projectId}/${timestamp}-${safeName}`;
  }
  return `${workspaceId}/${timestamp}-${safeName}`;
}

async function getAssetUrl(
  client: UserSupabaseClient,
  bucket: string,
  objectPath: string,
): Promise<string> {
  return createSignedUrl(client, bucket, objectPath);
}

async function createSignedUrl(
  client: UserSupabaseClient,
  bucket: string,
  objectPath: string,
): Promise<string> {
  const { data, error } = await client.storage
    .from(bucket)
    .createSignedUrl(objectPath, SIGNED_URL_EXPIRY_SECONDS);

  if (error || !data?.signedUrl) {
    throw new UploadServiceError(
      "upload_failed",
      "Failed to generate signed URL.",
      500,
    );
  }

  return data.signedUrl;
}
