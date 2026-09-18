import { isUuid, type ImageAttachment } from "@loomic/shared";
import sharp from "sharp";

import { safeDownload, validateDownloadedBuffer } from "../security/safe-download.js";

const MAX_AGENT_IMAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
  "image/tiff",
];

type AttachmentClient = {
  from: (table: string) => any;
  storage: { from: (bucket: string) => any };
};

type CanvasContentLike = {
  elements?: Array<Record<string, any>>;
  files?: Record<string, Record<string, any>>;
};

export type ResolvedAgentAttachment = {
  assetId: string;
  mimeType: string;
  buffer: Buffer;
};

const MAX_VISION_EDGE = 1024;

/**
 * Produce a lightweight copy for model vision input.
 *
 * The original attachment remains available to image-generation tools. Only
 * this derived copy is embedded in the LangGraph message/checkpoint, avoiding
 * multi-megabyte base64 blobs being duplicated at every graph step.
 */
export async function optimizeAgentVisionAttachment(
  attachment: ResolvedAgentAttachment,
): Promise<ResolvedAgentAttachment> {
  try {
    const buffer = await sharp(attachment.buffer, { animated: false })
      .rotate()
      .resize({
        width: MAX_VISION_EDGE,
        height: MAX_VISION_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ effort: 3, quality: 78 })
      .toBuffer();

    return {
      assetId: attachment.assetId,
      mimeType: "image/webp",
      buffer,
    };
  } catch (error) {
    console.warn(
      `[runtime] Vision image optimization failed assetId=${attachment.assetId}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return attachment;
  }
}

export async function resolveAgentImageAttachment(options: {
  client: AttachmentClient;
  attachment: ImageAttachment;
  canvasContent?: CanvasContentLike | null;
  supabaseUrl?: string;
}): Promise<ResolvedAgentAttachment> {
  const { attachment, client, canvasContent } = options;
  const canvasElement = canvasContent?.elements?.find(
    (element) => element.id === attachment.assetId && !element.isDeleted,
  );
  const elementAssetId = canvasElement?.customData?.assetId;
  const databaseAssetId = isUuid(attachment.assetId)
    ? attachment.assetId
    : typeof elementAssetId === "string" && isUuid(elementAssetId)
      ? elementAssetId
      : null;

  if (databaseAssetId) {
    const { data: asset, error } = await client
      .from("asset_objects")
      .select("bucket, object_path, mime_type")
      .eq("id", databaseAssetId)
      .single();
    if (error || !asset) throw new Error("attachment_not_found");
    return downloadStorageImage(client, attachment.assetId, asset);
  }

  const fileId = typeof canvasElement?.fileId === "string" ? canvasElement.fileId : null;
  const storageRef = fileId ? canvasContent?.files?.[fileId]?.storageRef : null;
  if (typeof storageRef === "string") {
    const parsed = parseStorageRef(storageRef);
    if (!parsed) throw new Error("attachment_storage_ref_invalid");
    return downloadStorageImage(client, attachment.assetId, {
      bucket: parsed.bucket,
      object_path: parsed.objectPath,
      mime_type: attachment.mimeType,
    });
  }

  // Canvas inline images are accepted only when the element exists in the
  // already-authorized canvas. Arbitrary client-provided data URLs are not.
  if (canvasElement && attachment.url.startsWith("data:")) {
    const downloaded = await safeDownload(attachment.url, {
      kind: "image",
      maxBytes: MAX_AGENT_IMAGE_BYTES,
      allowDataUri: true,
      allowedMimeTypes: ALLOWED_IMAGE_MIMES,
    });
    return {
      assetId: attachment.assetId,
      mimeType: downloaded.mimeType,
      buffer: downloaded.buffer,
    };
  }

  // Product seed images are public by design, but only the project's own
  // home-seeds path is accepted. Other remote URLs never reach the downloader.
  if (attachment.assetId.startsWith("seed-") && options.supabaseUrl) {
    const projectHost = new URL(options.supabaseUrl).hostname;
    const parsed = new URL(attachment.url);
    // Only the project's own storage host may serve product seed images; a
    // client-supplied `seed-` id must not turn into an arbitrary fetch of any
    // public Supabase-hosted object.
    if (
      parsed.hostname !== projectHost
      || !parsed.pathname.startsWith("/storage/v1/object/public/project-assets/home-seeds/")
    ) {
      throw new Error("attachment_seed_url_invalid");
    }
    const downloaded = await safeDownload(attachment.url, {
      kind: "image",
      maxBytes: MAX_AGENT_IMAGE_BYTES,
      timeoutMs: 30_000,
      maxRedirects: 0,
      allowedHosts: [projectHost],
      allowedMimeTypes: ALLOWED_IMAGE_MIMES,
    });
    return {
      assetId: attachment.assetId,
      mimeType: downloaded.mimeType,
      buffer: downloaded.buffer,
    };
  }

  throw new Error("attachment_not_authorized");
}

async function downloadStorageImage(
  client: AttachmentClient,
  requestedAssetId: string,
  asset: { bucket: string; object_path: string; mime_type?: string | null },
): Promise<ResolvedAgentAttachment> {
  const { data, error } = await client.storage.from(asset.bucket).download(asset.object_path);
  if (error || !data) throw new Error("attachment_download_failed");
  if (data.size > MAX_AGENT_IMAGE_BYTES) throw new Error("attachment_too_large");
  const buffer = Buffer.from(await data.arrayBuffer());
  const mimeType = asset.mime_type || data.type || "application/octet-stream";
  validateDownloadedBuffer(buffer, {
    kind: "image",
    maxBytes: MAX_AGENT_IMAGE_BYTES,
    allowedMimeTypes: ALLOWED_IMAGE_MIMES,
    mimeType,
  });
  return { assetId: requestedAssetId, mimeType, buffer };
}

function parseStorageRef(value: string): { bucket: string; objectPath: string } | null {
  if (!value.startsWith("oss://")) return null;
  const slash = value.indexOf("/", "oss://".length);
  if (slash < 0) return null;
  const bucket = value.slice("oss://".length, slash);
  const objectPath = value.slice(slash + 1);
  if (!bucket || !objectPath || objectPath.includes("..")) return null;
  return { bucket, objectPath };
}
