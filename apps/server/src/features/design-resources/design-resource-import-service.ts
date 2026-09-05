import { createHash, randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";

import type { Database } from "@loomic/shared";
import sharp, { type Metadata } from "sharp";

import {
  type SafeDownloadDependencies,
  SafeDownloadError,
  type SafeDownloadResult,
  safeDownload,
  validateDownloadedBuffer,
} from "../../security/safe-download.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import {
  UploadServiceError,
  assertSafeUploadedSvg,
} from "../uploads/upload-service.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_IMAGE_PIXELS = 80_000_000;
const MAX_FONT_METADATA_BYTES = 1024 * 1024;

export type ResourceImportJob = {
  id: string;
  scope: "platform" | "workspace";
  workspace_id: string | null;
  source_kind: "local_upload" | "url" | "manifest";
  attempt_count: number;
  created_by: string;
  claim_token: string;
};

export type ResourceImportItem = {
  id: string;
  import_job_id: string;
  source_key: string;
  asset_object_id: string | null;
  metadata: Record<string, unknown>;
};

export type ImportedAsset = {
  id: string;
  buffer: Buffer;
  mimeType: string;
  objectPath: string;
};

export type CatalogDuplicate = {
  entityKind: "resource" | "font_face";
  entityId: string;
};

type ImportCatalogKind =
  | "resource"
  | "template"
  | "text_preset"
  | "font_family"
  | "font_face"
  | "category"
  | "tag";

type ImportResult = {
  entityKind: ImportCatalogKind;
  entityId: string;
  assetObjectId: string | null;
};

export type DesignResourceImportRepository = {
  claim(claimToken: string, limit: number): Promise<ResourceImportJob[]>;
  listPendingItems(jobId: string): Promise<ResourceImportItem[]>;
  loadStagedAsset(
    job: ResourceImportJob,
    assetObjectId: string,
    maxBytes: number,
  ): Promise<ImportedAsset>;
  persistDownloadedAsset(input: {
    job: ResourceImportJob;
    item: ResourceImportItem;
    buffer: Buffer;
    mimeType: string;
    extension: string;
  }): Promise<ImportedAsset>;
  rememberDownloadedAsset(itemId: string, assetObjectId: string): Promise<void>;
  findDuplicate(
    job: ResourceImportJob,
    sha256: string,
    kind: "resource" | "font_face",
  ): Promise<CatalogDuplicate | null>;
  findFontFamily(
    job: ResourceImportJob,
    name: string,
  ): Promise<{ id: string; revision: number; status: string } | null>;
  createCatalog(input: {
    requestId: string;
    job: ResourceImportJob;
    entityKind: ImportCatalogKind;
    payload: Database["public"]["Functions"]["loomic_catalog_create"]["Args"]["p_payload"];
  }): Promise<{
    entity_id: string;
    revision: number;
    status: string;
    replayed: boolean;
  }>;
  setCatalogPendingReview(input: {
    requestId: string;
    job: ResourceImportJob;
    entityKind: ImportCatalogKind;
    entityId: string;
    expectedRevision: number;
  }): Promise<void>;
  finalizeItem(input: {
    jobId: string;
    claimToken: string;
    itemId: string;
    status: "imported" | "duplicate" | "failed" | "rejected";
    entityKind: ImportCatalogKind | null;
    entityId: string | null;
    assetObjectId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  }): Promise<void>;
  resolveImportResult?(
    jobId: string,
    sourceKey: string,
  ): Promise<ImportResult | null>;
  deferJob(
    jobId: string,
    claimToken: string,
    error: string,
    delaySeconds: number,
  ): Promise<void>;
  completeJob(jobId: string, claimToken: string): Promise<void>;
};

export class DesignResourceImportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DesignResourceImportError";
  }
}

type DownloadFile = (
  url: string,
  dependencies?: SafeDownloadDependencies,
) => Promise<SafeDownloadResult>;

export class DesignResourceImportService {
  constructor(
    private readonly repository: DesignResourceImportRepository,
    private readonly download: DownloadFile = downloadImportFile,
  ) {}

  async runOnce(
    limit = 2,
  ): Promise<{ claimed: number; completed: number; deferred: number }> {
    const jobs = await this.repository.claim(
      randomUUID(),
      Math.min(10, Math.max(1, limit)),
    );
    let completed = 0;
    let deferred = 0;
    for (const job of jobs) {
      const outcome = await this.processJob(job);
      if (outcome === "deferred") deferred += 1;
      else completed += 1;
    }
    return { claimed: jobs.length, completed, deferred };
  }

  async processJob(job: ResourceImportJob): Promise<"completed" | "deferred"> {
    const pendingItems = await this.repository.listPendingItems(job.id);
    let items: ResourceImportItem[];
    try {
      items = orderImportItems(pendingItems);
    } catch (caught) {
      const error = normalizeImportError(caught);
      for (const item of pendingItems) {
        await this.repository.finalizeItem({
          jobId: job.id,
          claimToken: job.claim_token,
          itemId: item.id,
          status: "rejected",
          entityKind: null,
          entityId: null,
          assetObjectId: null,
          errorCode: error.code,
          errorMessage: error.message,
        });
      }
      await this.repository.completeJob(job.id, job.claim_token);
      return "completed";
    }
    for (const item of items) {
      try {
        await this.processItem(job, item);
      } catch (caught) {
        const error = normalizeImportError(caught);
        if (error.retryable && job.attempt_count < 3) {
          await this.repository.deferJob(
            job.id,
            job.claim_token,
            `${error.code}:${error.message}`,
            Math.min(60, 2 ** job.attempt_count * 5),
          );
          return "deferred";
        }
        await this.repository.finalizeItem({
          jobId: job.id,
          claimToken: job.claim_token,
          itemId: item.id,
          status: error.retryable ? "failed" : "rejected",
          entityKind: null,
          entityId: null,
          assetObjectId: null,
          errorCode: error.code,
          errorMessage: error.message,
        });
      }
    }
    await this.repository.completeJob(job.id, job.claim_token);
    return "completed";
  }

  private async processItem(job: ResourceImportJob, item: ResourceImportItem) {
    if (item.metadata.manifest_dependency_cycle === true)
      throw permanent(
        "manifest_dependency_cycle",
        "Manifest dependencies contain a cycle.",
      );
    for (const dependency of stringArray(item.metadata.depends_on)) {
      if (!(await this.resolveResult(job.id, dependency)))
        throw permanent(
          "manifest_dependency_missing",
          `Manifest dependency ${dependency} is unavailable.`,
        );
    }
    const declaredKind = catalogKind(item.metadata.entity_kind);
    if (
      declaredKind &&
      declaredKind !== "resource" &&
      declaredKind !== "font_face"
    ) {
      await this.processCatalogItem(job, item, declaredKind);
      return;
    }
    const source = await this.resolveSource(job, item);
    const inspected = await inspectImportBuffer(source.buffer, source.mimeType);
    const duplicate = await this.repository.findDuplicate(
      job,
      inspected.sha256,
      inspected.kind === "font" ? "font_face" : "resource",
    );
    if (duplicate) {
      await this.repository.finalizeItem({
        jobId: job.id,
        claimToken: job.claim_token,
        itemId: item.id,
        status: "duplicate",
        entityKind: duplicate.entityKind,
        entityId: duplicate.entityId,
        assetObjectId: source.assetObjectId,
        errorCode: null,
        errorMessage: null,
      });
      return;
    }

    let assetObjectId = source.assetObjectId;
    if (!assetObjectId) {
      const stored = await this.repository.persistDownloadedAsset({
        job,
        item,
        buffer: source.buffer,
        mimeType: inspected.mimeType,
        extension: inspected.extension,
      });
      assetObjectId = stored.id;
      await this.repository.rememberDownloadedAsset(item.id, stored.id);
    }

    try {
      if (inspected.kind === "font") {
        const faceId = await this.createFont(
          job,
          item,
          assetObjectId,
          inspected,
          source.metadata,
        );
        await this.repository.finalizeItem({
          jobId: job.id,
          claimToken: job.claim_token,
          itemId: item.id,
          status: "imported",
          entityKind: "font_face",
          entityId: faceId,
          assetObjectId,
          errorCode: null,
          errorMessage: null,
        });
      } else {
        const overrides = isRecord(item.metadata.payload)
          ? await resolveLegacyReferences(item.metadata.payload, (sourceKey) =>
              this.resolveResult(job.id, sourceKey),
            )
          : {};
        const created = await this.repository.createCatalog({
          requestId: deterministicUuid(`${item.id}:resource:create`),
          job,
          entityKind: "resource",
          payload: compact({
            kind: inspected.kind === "svg" ? "svg" : "image",
            name: source.metadata.name ?? fileStem(item.source_key),
            description: null,
            asset_object_id: assetObjectId,
            preview_asset_object_id: assetObjectId,
            width: inspected.width,
            height: inspected.height,
            checksum_sha256: inspected.sha256,
            category_id: null,
            tag_ids: [],
            source_url: source.sourceUrl,
            author: source.metadata.author ?? null,
            license_name: source.metadata.licenseName ?? null,
            license_url: source.metadata.licenseUrl ?? null,
            attribution: source.metadata.attribution ?? null,
            usage_restrictions: source.metadata.usageRestrictions ?? null,
            ...(isRecord(overrides) ? overrides : {}),
          }),
        });
        await this.repository.setCatalogPendingReview({
          requestId: deterministicUuid(`${item.id}:resource:review`),
          job,
          entityKind: "resource",
          entityId: created.entity_id,
          expectedRevision: created.revision,
        });
        await this.repository.finalizeItem({
          jobId: job.id,
          claimToken: job.claim_token,
          itemId: item.id,
          status: "imported",
          entityKind: "resource",
          entityId: created.entity_id,
          assetObjectId,
          errorCode: null,
          errorMessage: null,
        });
      }
    } catch (error) {
      const concurrent = await this.repository.findDuplicate(
        job,
        inspected.sha256,
        inspected.kind === "font" ? "font_face" : "resource",
      );
      if (!concurrent) throw error;
      await this.repository.finalizeItem({
        jobId: job.id,
        claimToken: job.claim_token,
        itemId: item.id,
        status: "duplicate",
        entityKind: concurrent.entityKind,
        entityId: concurrent.entityId,
        assetObjectId,
        errorCode: null,
        errorMessage: null,
      });
    }
  }

  private async processCatalogItem(
    job: ResourceImportJob,
    item: ResourceImportItem,
    entityKind: Exclude<ImportCatalogKind, "resource" | "font_face">,
  ) {
    const rawPayload = isRecord(item.metadata.payload)
      ? item.metadata.payload
      : {};
    const payload = await resolveLegacyReferences(
      rawPayload,
      async (sourceKey) => this.resolveResult(job.id, sourceKey),
    );
    const created = await this.repository.createCatalog({
      requestId: deterministicUuid(`${item.id}:${entityKind}:create`),
      job,
      entityKind,
      payload:
        payload as Database["public"]["Functions"]["loomic_catalog_create"]["Args"]["p_payload"],
    });
    await this.repository.setCatalogPendingReview({
      requestId: deterministicUuid(`${item.id}:${entityKind}:review`),
      job,
      entityKind,
      entityId: created.entity_id,
      expectedRevision: created.revision,
    });
    await this.repository.finalizeItem({
      jobId: job.id,
      claimToken: job.claim_token,
      itemId: item.id,
      status: "imported",
      entityKind,
      entityId: created.entity_id,
      assetObjectId: null,
      errorCode: null,
      errorMessage: null,
    });
  }

  private resolveResult(jobId: string, sourceKey: string) {
    return (
      this.repository.resolveImportResult?.(jobId, sourceKey) ??
      Promise.resolve(null)
    );
  }

  private async createFont(
    job: ResourceImportJob,
    item: ResourceImportItem,
    assetObjectId: string,
    inspected: Extract<InspectedImport, { kind: "font" }>,
    metadata: ImportMetadata,
  ) {
    const overrides = isRecord(item.metadata.payload)
      ? await resolveLegacyReferences(item.metadata.payload, (sourceKey) =>
          this.resolveResult(job.id, sourceKey),
        )
      : {};
    const configuredFamilyId = isRecord(overrides)
      ? stringValue(overrides.family_id)
      : null;
    const existingFamily = await this.repository.findFontFamily(
      job,
      inspected.familyName,
    );
    let familyId: string;
    if (configuredFamilyId) {
      familyId = configuredFamilyId;
    } else if (existingFamily) {
      familyId = existingFamily.id;
    } else {
      const createdFamily = await this.repository.createCatalog({
        requestId: deterministicUuid(`${item.id}:font-family:create`),
        job,
        entityKind: "font_family",
        payload: {
          name: inspected.familyName,
          source_url: metadata.sourceUrl ?? null,
          author: metadata.author ?? null,
          license_name: metadata.licenseName ?? null,
          license_url: metadata.licenseUrl ?? null,
          attribution: metadata.attribution ?? null,
          usage_restrictions: metadata.usageRestrictions ?? null,
        },
      });
      familyId = createdFamily.entity_id;
      await this.repository.setCatalogPendingReview({
        requestId: deterministicUuid(`${item.id}:font-family:review`),
        job,
        entityKind: "font_family",
        entityId: familyId,
        expectedRevision: createdFamily.revision,
      });
    }
    const face = await this.repository.createCatalog({
      requestId: deterministicUuid(`${item.id}:font-face:create`),
      job,
      entityKind: "font_face",
      payload: {
        family_id: familyId,
        asset_object_id: assetObjectId,
        style: inspected.style,
        weight: inspected.weight,
        format: inspected.format,
        checksum_sha256: inspected.sha256,
        allow_web_embed:
          metadata.allowWebEmbed === true && inspected.webEmbedAllowed,
        ...(isRecord(overrides) ? overrides : {}),
      },
    });
    await this.repository.setCatalogPendingReview({
      requestId: deterministicUuid(`${item.id}:font-face:review`),
      job,
      entityKind: "font_face",
      entityId: face.entity_id,
      expectedRevision: face.revision,
    });
    return face.entity_id;
  }

  private async resolveSource(
    job: ResourceImportJob,
    item: ResourceImportItem,
  ): Promise<ResolvedSource> {
    const manifestSourceUrl = stringValue(item.metadata.source_url);
    if (manifestSourceUrl) {
      const downloaded = await this.download(manifestSourceUrl);
      return {
        ...downloaded,
        assetObjectId: null,
        objectPath: "",
        sourceUrl: downloaded.finalUrl,
        metadata: {
          ...metadataFrom(item.metadata),
          sourceUrl: downloaded.finalUrl,
        },
      };
    }
    const remembered = stringValue(item.metadata.import_asset_object_id);
    if (remembered) {
      const asset = await this.repository.loadStagedAsset(
        job,
        remembered,
        MAX_FILE_BYTES,
      );
      return {
        ...asset,
        assetObjectId: asset.id,
        sourceUrl: null,
        metadata: metadataFrom(item.metadata),
      };
    }
    if (
      job.source_kind === "local_upload" ||
      (item.asset_object_id &&
        (catalogKind(item.metadata.entity_kind) !== null ||
          typeof item.metadata.manifest_index === "number"))
    ) {
      if (!item.asset_object_id)
        throw permanent("staged_asset_missing", "The staged asset is missing.");
      const asset = await this.repository.loadStagedAsset(
        job,
        item.asset_object_id,
        MAX_FILE_BYTES,
      );
      return {
        ...asset,
        assetObjectId: asset.id,
        sourceUrl: null,
        metadata: metadataFrom(item.metadata),
      };
    }
    if (job.source_kind === "url") {
      const downloaded = await this.download(item.source_key);
      return {
        ...downloaded,
        assetObjectId: null,
        objectPath: "",
        sourceUrl: downloaded.finalUrl,
        metadata: {
          ...metadataFrom(item.metadata),
          sourceUrl: downloaded.finalUrl,
        },
      };
    }
    if (!item.asset_object_id)
      throw permanent("manifest_missing", "The manifest asset is missing.");
    const manifestAsset = await this.repository.loadStagedAsset(
      job,
      item.asset_object_id,
      MAX_MANIFEST_BYTES,
    );
    return this.resolveManifest(job, item, manifestAsset.buffer);
  }

  private async resolveManifest(
    job: ResourceImportJob,
    item: ResourceImportItem,
    buffer: Buffer,
  ): Promise<ResolvedSource> {
    if (looksLikeArchive(buffer)) {
      throw permanent(
        "archive_unsupported",
        "Archive imports are not supported by this worker version.",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw permanent("manifest_invalid", "The manifest is not valid JSON.");
    }
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !isRecord(value.item) ||
      Array.isArray(value.items)
    ) {
      throw permanent(
        "manifest_invalid",
        "Only a version 1 single-item manifest is supported.",
      );
    }
    const manifestItem = value.item;
    const sourceUrl = stringValue(manifestItem.source_url);
    const stagedId = stringValue(manifestItem.asset_object_id);
    if ((sourceUrl ? 1 : 0) + (stagedId ? 1 : 0) !== 1) {
      throw permanent(
        "manifest_invalid",
        "A manifest item requires exactly one source.",
      );
    }
    const metadata = metadataFrom(manifestItem);
    if (sourceUrl) {
      const downloaded = await this.download(sourceUrl);
      return {
        ...downloaded,
        assetObjectId: null,
        objectPath: "",
        sourceUrl: downloaded.finalUrl,
        metadata: { ...metadata, sourceUrl: downloaded.finalUrl },
      };
    }
    if (!stagedId) {
      throw permanent(
        "manifest_invalid",
        "The staged manifest source is invalid.",
      );
    }
    const asset = await this.repository.loadStagedAsset(
      job,
      stagedId,
      MAX_FILE_BYTES,
    );
    return { ...asset, assetObjectId: asset.id, sourceUrl: null, metadata };
  }
}

export type DesignResourceImportPollingOptions = {
  isRunning: () => boolean;
  limit?: number;
  idleDelayMs?: number;
  errorDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onError?: (error: unknown) => void;
};

export function orderImportItems(items: ResourceImportItem[]) {
  const byKey = new Map(items.map((item) => [item.source_key, item]));
  const state = new Map<string, "visiting" | "done">();
  const ordered: ResourceImportItem[] = [];
  const stack: ResourceImportItem[] = [];
  const cycleIds = new Set<string>();
  const visit = (item: ResourceImportItem) => {
    const current = state.get(item.id);
    if (current === "done") return;
    if (current === "visiting") {
      const start = stack.findIndex((entry) => entry.id === item.id);
      for (const entry of stack.slice(Math.max(0, start)))
        cycleIds.add(entry.id);
      return;
    }
    state.set(item.id, "visiting");
    stack.push(item);
    for (const dependency of stringArray(item.metadata.depends_on)) {
      const pending = byKey.get(dependency);
      if (pending) visit(pending);
    }
    stack.pop();
    state.set(item.id, "done");
    ordered.push(item);
  };
  for (const item of items) visit(item);
  return ordered.map((item) =>
    cycleIds.has(item.id)
      ? {
          ...item,
          metadata: { ...item.metadata, manifest_dependency_cycle: true },
        }
      : item,
  );
}

async function resolveLegacyReferences(
  value: unknown,
  resolve: (sourceKey: string) => Promise<ImportResult | null>,
  key = "",
): Promise<unknown> {
  if (Array.isArray(value))
    return Promise.all(
      value.map((entry) => resolveLegacyReferences(entry, resolve, key)),
    );
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (
      ["tag_paths", "tagPaths"].includes(childKey) &&
      Array.isArray(childValue)
    ) {
      output.tag_ids = await Promise.all(
        childValue.map(async (sourceKey) => {
          if (typeof sourceKey !== "string")
            throw permanent(
              "manifest_dependency_missing",
              "Manifest tag dependency is invalid.",
            );
          const result = await resolve(sourceKey);
          if (!result || result.entityKind !== "tag")
            throw permanent(
              "manifest_dependency_missing",
              `Manifest dependency ${sourceKey} is unavailable.`,
            );
          return result.entityId;
        }),
      );
      continue;
    }
    if (typeof childValue === "string") {
      const expected = referenceKind(childKey);
      if (expected) {
        if (isUuid(childValue)) {
          output[canonicalReferenceKey(childKey)] = childValue;
          continue;
        }
        const result = await resolve(childValue);
        if (!result || (expected !== "asset" && result.entityKind !== expected))
          throw permanent(
            "manifest_dependency_missing",
            `Manifest dependency ${childValue} is unavailable.`,
          );
        output[canonicalReferenceKey(childKey)] =
          expected === "asset" ? result.assetObjectId : result.entityId;
        if (output[canonicalReferenceKey(childKey)] === null)
          throw permanent(
            "manifest_dependency_missing",
            `Manifest asset ${childValue} is unavailable.`,
          );
        continue;
      }
    }
    output[childKey] = await resolveLegacyReferences(
      childValue,
      resolve,
      childKey,
    );
  }
  return output;
}

function referenceKind(key: string): ImportCatalogKind | "asset" | null {
  if (["resource_path", "resourcePath", "resourceId"].includes(key))
    return "resource";
  if (["asset_path", "assetPath", "assetObjectId"].includes(key))
    return "asset";
  if (["font_path", "fontPath", "fontFaceId"].includes(key)) return "font_face";
  if (["category_path", "categoryPath", "category_id"].includes(key))
    return "category";
  if (["font_family_path", "fontFamilyPath", "family_id"].includes(key))
    return "font_family";
  return null;
}

function canonicalReferenceKey(key: string) {
  if (["resource_path", "resourcePath", "resourceId"].includes(key))
    return "resourceId";
  if (["asset_path", "assetPath", "assetObjectId"].includes(key))
    return "assetObjectId";
  if (["font_path", "fontPath", "fontFaceId"].includes(key))
    return "fontFaceId";
  if (["category_path", "categoryPath", "category_id"].includes(key))
    return "category_id";
  if (["font_family_path", "fontFamilyPath", "family_id"].includes(key))
    return "family_id";
  return key;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function catalogKind(value: unknown): ImportCatalogKind | null {
  return typeof value === "string" &&
    [
      "resource",
      "template",
      "text_preset",
      "font_family",
      "font_face",
      "category",
      "tag",
    ].includes(value)
    ? (value as ImportCatalogKind)
    : null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Polls the database-backed import queue. The database claim RPC owns leasing
 * and retry limits, so restarting this loop is safe and does not duplicate a
 * completed item.
 */
export async function runDesignResourceImportPollingLoop(
  service: DesignResourceImportService,
  options: DesignResourceImportPollingOptions,
): Promise<void> {
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  while (options.isRunning()) {
    try {
      const outcome = await service.runOnce(options.limit ?? 2);
      if (outcome.claimed === 0 && options.isRunning()) {
        await sleep(options.idleDelayMs ?? 1_000);
      }
    } catch (error) {
      options.onError?.(error);
      if (options.isRunning()) {
        await sleep(options.errorDelayMs ?? 1_000);
      }
    }
  }
}

type ImportMetadata = {
  name?: string;
  author?: string;
  licenseName?: string;
  licenseUrl?: string;
  attribution?: string;
  usageRestrictions?: string;
  sourceUrl?: string;
  allowWebEmbed?: boolean;
};

type ResolvedSource = {
  buffer: Buffer;
  mimeType: string;
  objectPath: string;
  assetObjectId: string | null;
  sourceUrl: string | null;
  metadata: ImportMetadata;
};

type InspectedImport =
  | {
      kind: "raster" | "svg";
      mimeType: string;
      extension: string;
      width: number;
      height: number;
      sha256: string;
    }
  | {
      kind: "font";
      mimeType: string;
      extension: string;
      format: "woff" | "ttf" | "otf";
      familyName: string;
      style: "normal" | "italic";
      weight: number;
      webEmbedAllowed: boolean;
      sha256: string;
    };

export async function inspectImportBuffer(
  buffer: Buffer,
  declaredMimeType: string,
): Promise<InspectedImport> {
  if (buffer.length === 0 || buffer.length > MAX_FILE_BYTES)
    throw permanent("file_size_invalid", "The imported file size is invalid.");
  if (looksLikeArchive(buffer))
    throw permanent(
      "archive_unsupported",
      "Archive imports are not supported by this worker version.",
    );
  const detected = detectFormat(buffer);
  if (!detected)
    throw permanent(
      "file_type_invalid",
      "The imported file type is not supported.",
    );
  if (!mimeCompatible(declaredMimeType, detected.mimeType))
    throw permanent(
      "mime_mismatch",
      "The declared MIME type does not match the file content.",
    );
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (detected.kind === "font") {
    if (detected.format === "woff2")
      throw permanent(
        "font_format_unsupported",
        "WOFF2 metadata extraction is not yet supported.",
      );
    const table = (name: string) =>
      detected.format === "woff"
        ? extractWoffSfntTable(buffer, name)
        : extractSfntTable(buffer, name);
    const familyName = readFontFamilyName(table("name"));
    if (!familyName)
      throw permanent(
        "font_metadata_invalid",
        "The font family metadata is missing or invalid.",
      );
    const fontMetadata = readFontOs2Metadata(table("OS/2"));
    if (!fontMetadata) {
      throw permanent(
        "font_metadata_invalid",
        "The font embedding metadata is missing or invalid.",
      );
    }
    if (!fontMetadata.webEmbedAllowed) {
      throw permanent(
        "font_embedding_forbidden",
        "The font license metadata forbids web embedding.",
      );
    }
    return {
      kind: "font",
      mimeType: detected.mimeType,
      extension: detected.extension,
      format: detected.format,
      familyName,
      style:
        fontMetadata.italic || /italic/i.test(familyName) ? "italic" : "normal",
      weight: fontMetadata.weight,
      webEmbedAllowed: true,
      sha256,
    };
  }
  if (detected.kind === "svg") {
    try {
      assertSafeUploadedSvg(buffer);
    } catch (error) {
      if (error instanceof UploadServiceError) {
        throw permanent("svg_unsafe", error.message);
      }
      throw error;
    }
  } else {
    validateDownloadedBuffer(buffer, {
      kind: "image",
      maxBytes: MAX_FILE_BYTES,
      mimeType: detected.mimeType,
      allowedMimeTypes: [detected.mimeType],
    });
  }
  let metadata: Metadata;
  try {
    metadata = await sharp(buffer, {
      animated: false,
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
  } catch {
    throw permanent(
      "image_decode_invalid",
      "The image cannot be decoded safely.",
    );
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (
    width < 1 ||
    height < 1 ||
    width > 32_768 ||
    height > 32_768 ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw permanent(
      "image_dimensions_invalid",
      "The image dimensions exceed the safe limit.",
    );
  }
  return {
    kind: detected.kind,
    mimeType: detected.mimeType,
    extension: detected.extension,
    width,
    height,
    sha256,
  };
}

export async function downloadImportFile(
  url: string,
  dependencies?: SafeDownloadDependencies,
) {
  return safeDownload(
    url,
    {
      kind: "binary",
      maxBytes: MAX_FILE_BYTES,
      timeoutMs: 20_000,
      maxRedirects: 2,
    },
    dependencies,
  );
}

export function createSupabaseDesignResourceImportRepository(
  getAdminClient: () => AdminSupabaseClient,
): DesignResourceImportRepository {
  type Functions = Database["public"]["Functions"];
  type ImportRpcName =
    | "loomic_catalog_create"
    | "loomic_catalog_set_status"
    | "loomic_resource_import_claim"
    | "loomic_resource_import_complete"
    | "loomic_resource_import_defer"
    | "loomic_resource_import_finalize_item";
  type ImportRpcArgs<Name extends ImportRpcName> = {
    [Key in keyof Functions[Name]["Args"]]: Functions[Name]["Args"][Key] | null;
  };
  const rpc = async <Name extends ImportRpcName>(
    name: Name,
    args: ImportRpcArgs<Name>,
  ) => {
    // PostgreSQL routine arguments are nullable unless the routine validates
    // them, while generated Supabase function Args do not encode nullability.
    const result = await getAdminClient().rpc(name, args as never);
    if (result.error) throw new Error(result.error.message ?? `${name}_failed`);
    return result.data;
  };
  return {
    async claim(claimToken, limit) {
      const data = await rpc("loomic_resource_import_claim", {
        p_claim_token: claimToken,
        p_limit: limit,
      });
      return (Array.isArray(data) ? data : []).map(parseJob);
    },
    async listPendingItems(jobId) {
      const { data, error } = await getAdminClient()
        .from("resource_import_items")
        .select("id, import_job_id, source_key, asset_object_id, metadata")
        .eq("import_job_id", jobId)
        .in("status", ["pending", "running"])
        .order("created_at");
      if (error)
        throw new Error(`resource_import_items_query_failed:${error.message}`);
      return (data ?? []).map((row) => ({
        ...row,
        metadata: isRecord(row.metadata) ? row.metadata : {},
      }));
    },
    async loadStagedAsset(job, assetObjectId, maxBytes) {
      const { data: asset, error } = await getAdminClient()
        .from("asset_objects")
        .select(
          "id,scope,workspace_id,bucket,object_path,mime_type,byte_size,deletion_pending_at",
        )
        .eq("id", assetObjectId)
        .maybeSingle();
      if (
        error ||
        !asset ||
        asset.scope !== job.scope ||
        asset.workspace_id !== job.workspace_id ||
        asset.deletion_pending_at ||
        (asset.byte_size ?? 0) > maxBytes
      ) {
        throw permanent(
          "staged_asset_unavailable",
          "The staged asset is unavailable or outside the import scope.",
        );
      }
      const downloaded = await getAdminClient()
        .storage.from(asset.bucket)
        .download(asset.object_path);
      if (downloaded.error || !downloaded.data)
        throw transient(
          "storage_download_failed",
          "The staged file could not be downloaded.",
        );
      const buffer = Buffer.from(await downloaded.data.arrayBuffer());
      if (buffer.length > maxBytes)
        throw permanent(
          "file_size_invalid",
          "The staged file exceeds the size limit.",
        );
      return {
        id: asset.id,
        buffer,
        mimeType:
          asset.mime_type ?? downloaded.data.type ?? "application/octet-stream",
        objectPath: asset.object_path,
      };
    },
    async persistDownloadedAsset({ job, item, buffer, mimeType, extension }) {
      const bucket =
        job.scope === "platform" ? "platform-assets" : "workspace-assets";
      const objectPath =
        job.scope === "platform"
          ? `imports/${job.id}/${item.id}.${extension}`
          : `${job.workspace_id}/imports/${job.id}/${item.id}.${extension}`;
      const upload = await getAdminClient()
        .storage.from(bucket)
        .upload(objectPath, buffer, { contentType: mimeType, upsert: false });
      if (upload.error && !/already exists/i.test(upload.error.message))
        throw transient("storage_upload_failed", upload.error.message);
      const createdUpload = !upload.error;
      const { data, error } = await getAdminClient()
        .from("asset_objects")
        .insert({
          scope: job.scope,
          workspace_id: job.workspace_id,
          bucket,
          object_path: objectPath,
          mime_type: mimeType,
          byte_size: buffer.length,
          created_by: job.created_by,
        })
        .select("id")
        .single();
      if (error || !data) {
        const existing = await getAdminClient()
          .from("asset_objects")
          .select("id")
          .eq("bucket", bucket)
          .eq("object_path", objectPath)
          .maybeSingle();
        if (!existing.data) {
          if (createdUpload) {
            await getAdminClient().storage.from(bucket).remove([objectPath]);
          }
          throw transient(
            "asset_record_failed",
            error?.message ?? "Asset metadata insert failed.",
          );
        }
        return { id: existing.data.id, buffer, mimeType, objectPath };
      }
      return { id: data.id, buffer, mimeType, objectPath };
    },
    async rememberDownloadedAsset(itemId, assetObjectId) {
      const { data } = await getAdminClient()
        .from("resource_import_items")
        .select("metadata")
        .eq("id", itemId)
        .single();
      const metadata = isRecord(data?.metadata) ? data.metadata : {};
      const { error } = await getAdminClient()
        .from("resource_import_items")
        .update({
          metadata: { ...metadata, import_asset_object_id: assetObjectId },
        })
        .eq("id", itemId);
      if (error) throw transient("import_checkpoint_failed", error.message);
    },
    async resolveImportResult(jobId, sourceKey) {
      const { data, error } = await getAdminClient()
        .from("resource_import_items")
        .select("status,result_entity_kind,result_entity_id,asset_object_id")
        .eq("import_job_id", jobId)
        .eq("source_key", sourceKey)
        .maybeSingle();
      if (error)
        throw transient("import_dependency_query_failed", error.message);
      const kind = catalogKind(data?.result_entity_kind);
      if (
        !data ||
        !["imported", "duplicate"].includes(data.status) ||
        !kind ||
        !data.result_entity_id
      )
        return null;
      return {
        entityKind: kind,
        entityId: data.result_entity_id,
        assetObjectId: data.asset_object_id,
      };
    },
    async findDuplicate(job, sha256, kind) {
      const table = kind === "resource" ? "design_resources" : "font_faces";
      const query = getAdminClient()
        .from(table)
        .select("id")
        .eq("scope", job.scope)
        .is("deleted_at", null)
        .eq("checksum_sha256", sha256);
      const scoped = job.workspace_id
        ? query.eq("workspace_id", job.workspace_id)
        : query.is("workspace_id", null);
      const { data, error } = await scoped.limit(1).maybeSingle();
      if (error) throw transient("dedupe_query_failed", error.message);
      return data ? { entityKind: kind, entityId: data.id } : null;
    },
    async findFontFamily(job, name) {
      const query = getAdminClient()
        .from("font_families")
        .select("id,revision,status")
        .eq("scope", job.scope)
        .is("deleted_at", null)
        .ilike("name", name);
      const scoped = job.workspace_id
        ? query.eq("workspace_id", job.workspace_id)
        : query.is("workspace_id", null);
      const { data, error } = await scoped.limit(1).maybeSingle();
      if (error) throw transient("font_family_query_failed", error.message);
      return data ?? null;
    },
    async createCatalog({ requestId, job, entityKind, payload }) {
      return (await rpc("loomic_catalog_create", {
        p_request_id: requestId,
        p_entity_kind: entityKind,
        p_scope: job.scope,
        p_workspace_id: job.workspace_id,
        p_payload: payload,
        p_actor_user_id: job.created_by,
      })) as Awaited<
        ReturnType<DesignResourceImportRepository["createCatalog"]>
      >;
    },
    async setCatalogPendingReview({
      requestId,
      job,
      entityKind,
      entityId,
      expectedRevision,
    }) {
      await rpc("loomic_catalog_set_status", {
        p_request_id: requestId,
        p_entity_kind: entityKind,
        p_entity_id: entityId,
        p_expected_revision: expectedRevision,
        p_status: "pending_review",
        p_actor_user_id: job.created_by,
      });
    },
    async finalizeItem(input) {
      await rpc("loomic_resource_import_finalize_item", {
        p_import_job_id: input.jobId,
        p_claim_token: input.claimToken,
        p_item_id: input.itemId,
        p_status: input.status,
        p_result_entity_kind: input.entityKind,
        p_result_entity_id: input.entityId,
        p_asset_object_id: input.assetObjectId,
        p_error_code: input.errorCode,
        p_error_message: input.errorMessage,
      });
    },
    async deferJob(jobId, claimToken, errorMessage, delaySeconds) {
      await rpc("loomic_resource_import_defer", {
        p_import_job_id: jobId,
        p_claim_token: claimToken,
        p_error_message: errorMessage,
        p_delay_seconds: delaySeconds,
      });
    },
    async completeJob(jobId, claimToken) {
      await rpc("loomic_resource_import_complete", {
        p_import_job_id: jobId,
        p_claim_token: claimToken,
      });
    },
  };
}

function parseJob(value: unknown): ResourceImportJob {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    (value.scope !== "platform" && value.scope !== "workspace") ||
    (value.source_kind !== "local_upload" &&
      value.source_kind !== "url" &&
      value.source_kind !== "manifest") ||
    typeof value.attempt_count !== "number" ||
    typeof value.created_by !== "string" ||
    typeof value.claim_token !== "string"
  ) {
    throw permanent("import_job_invalid", "The claimed import job is invalid.");
  }
  return {
    id: value.id,
    scope: value.scope,
    workspace_id: stringValue(value.workspace_id) ?? null,
    source_kind: value.source_kind,
    attempt_count: value.attempt_count,
    created_by: value.created_by,
    claim_token: value.claim_token,
  };
}

type DetectedFormat =
  | { kind: "raster" | "svg"; mimeType: string; extension: string }
  | {
      kind: "font";
      mimeType: string;
      extension: string;
      format: "woff" | "woff2" | "ttf" | "otf";
    };

function detectFormat(buffer: Buffer): DetectedFormat | null {
  if (buffer.length < 4) return null;
  if (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return { kind: "raster", mimeType: "image/png", extension: "png" };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return { kind: "raster", mimeType: "image/jpeg", extension: "jpg" };
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii")))
    return { kind: "raster", mimeType: "image/gif", extension: "gif" };
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return { kind: "raster", mimeType: "image/webp", extension: "webp" };
  if (
    /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(
      buffer.subarray(0, 4096).toString("utf8"),
    )
  )
    return { kind: "svg", mimeType: "image/svg+xml", extension: "svg" };
  const magic = buffer.subarray(0, 4).toString("ascii");
  if (magic === "wOFF")
    return {
      kind: "font",
      mimeType: "font/woff",
      extension: "woff",
      format: "woff",
    };
  if (magic === "wOF2")
    return {
      kind: "font",
      mimeType: "font/woff2",
      extension: "woff2",
      format: "woff2",
    };
  if (magic === "OTTO")
    return {
      kind: "font",
      mimeType: "font/otf",
      extension: "otf",
      format: "otf",
    };
  if (buffer.readUInt32BE(0) === 0x00010000 || magic === "true")
    return {
      kind: "font",
      mimeType: "font/ttf",
      extension: "ttf",
      format: "ttf",
    };
  return null;
}

function mimeCompatible(declared: string, actual: string) {
  const normalized = declared.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    !normalized ||
    normalized === "application/octet-stream" ||
    normalized === "binary/octet-stream"
  )
    return true;
  const aliases: Record<string, string[]> = {
    "image/jpeg": ["image/jpg"],
    "font/ttf": ["application/x-font-ttf"],
    "font/otf": ["application/x-font-opentype"],
    "font/woff": ["application/font-woff"],
    "font/woff2": ["application/font-woff2"],
  };
  return (
    normalized === actual || aliases[actual]?.includes(normalized) === true
  );
}

function extractSfntTable(buffer: Buffer, target: string) {
  if (buffer.length < 12) return null;
  const count = buffer.readUInt16BE(4);
  for (let i = 0; i < count; i += 1) {
    const offset = 12 + i * 16;
    if (offset + 16 > buffer.length) return null;
    if (buffer.subarray(offset, offset + 4).toString("ascii") === target) {
      const tableOffset = buffer.readUInt32BE(offset + 8);
      const length = buffer.readUInt32BE(offset + 12);
      if (
        length > MAX_FONT_METADATA_BYTES ||
        tableOffset + length > buffer.length
      )
        return null;
      return buffer.subarray(tableOffset, tableOffset + length);
    }
  }
  return null;
}

function extractWoffSfntTable(buffer: Buffer, target: string) {
  if (buffer.length < 44) return null;
  const count = buffer.readUInt16BE(12);
  for (let i = 0; i < count; i += 1) {
    const offset = 44 + i * 20;
    if (offset + 20 > buffer.length) return null;
    if (buffer.subarray(offset, offset + 4).toString("ascii") === target) {
      const tableOffset = buffer.readUInt32BE(offset + 4);
      const compressed = buffer.readUInt32BE(offset + 8);
      const original = buffer.readUInt32BE(offset + 12);
      if (
        compressed > MAX_FONT_METADATA_BYTES ||
        original > MAX_FONT_METADATA_BYTES ||
        tableOffset + compressed > buffer.length
      )
        return null;
      const data = buffer.subarray(tableOffset, tableOffset + compressed);
      try {
        return compressed < original
          ? inflateSync(data, { maxOutputLength: MAX_FONT_METADATA_BYTES })
          : data;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function readFontFamilyName(table: Buffer | null) {
  if (!table || table.length < 6) return null;
  const count = table.readUInt16BE(2);
  if (count > 1_024) return null;
  const stringOffset = table.readUInt16BE(4);
  const candidates: Array<{ score: number; value: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 12;
    if (offset + 12 > table.length) break;
    const platform = table.readUInt16BE(offset);
    const language = table.readUInt16BE(offset + 4);
    const nameId = table.readUInt16BE(offset + 6);
    const length = table.readUInt16BE(offset + 8);
    const relative = table.readUInt16BE(offset + 10);
    if (nameId !== 1 || stringOffset + relative + length > table.length)
      continue;
    const raw = table.subarray(
      stringOffset + relative,
      stringOffset + relative + length,
    );
    const value = (
      platform === 0 || platform === 3
        ? decodeUtf16Be(raw)
        : raw.toString("latin1")
    )
      .replace(/\0/g, "")
      .trim();
    if (value)
      candidates.push({
        score: (platform === 3 ? 4 : 0) + (language === 0x409 ? 2 : 0),
        value,
      });
  }
  return candidates.sort((a, b) => b.score - a.score)[0]?.value ?? null;
}

function readFontOs2Metadata(table: Buffer | null): {
  italic: boolean;
  weight: number;
  webEmbedAllowed: boolean;
} | null {
  if (!table || table.length < 10) return null;
  const weight = table.readUInt16BE(4);
  const fsType = table.readUInt16BE(8);
  if (weight < 1 || weight > 1_000) return null;
  return {
    italic: table.length >= 64 && (table.readUInt16BE(62) & 0x0001) !== 0,
    weight,
    // fsType=0 is the OpenType installable-embedding permission. Restrictive,
    // preview/print-only and editable-only licenses are deliberately not
    // accepted for a browser-served font catalog.
    webEmbedAllowed: fsType === 0,
  };
}

function decodeUtf16Be(buffer: Buffer) {
  const swapped = Buffer.alloc(buffer.length);
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    swapped.writeUInt8(buffer.readUInt8(index + 1), index);
    swapped.writeUInt8(buffer.readUInt8(index), index + 1);
  }
  return swapped.toString("utf16le");
}

function looksLikeArchive(buffer: Buffer) {
  return (
    (buffer[0] === 0x50 && buffer[1] === 0x4b) ||
    (buffer[0] === 0x1f && buffer[1] === 0x8b) ||
    (buffer.length >= 262 &&
      buffer.subarray(257, 262).toString("ascii") === "ustar")
  );
}
function deterministicUuid(seed: string) {
  const hash = createHash("sha256").update(seed).digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6);
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);
  const value = hash.subarray(0, 16).toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function fileStem(value: string) {
  let path = value;
  try {
    path = new URL(value).pathname;
  } catch {
    // A local source key is already a path-like value.
  }
  const name = path.split("/").pop() || "Imported asset";
  return name.replace(/\.[^.]+$/, "").slice(0, 200) || "Imported asset";
}
function metadataFrom(value: Record<string, unknown>): ImportMetadata {
  return compact({
    name: stringValue(value.name),
    author: stringValue(value.author),
    licenseName: stringValue(value.license_name),
    licenseUrl: stringValue(value.license_url),
    attribution: stringValue(value.attribution),
    usageRestrictions: stringValue(value.usage_restrictions),
    sourceUrl: stringValue(value.source_url),
    allowWebEmbed: value.allow_web_embed === true ? true : undefined,
  }) as ImportMetadata;
}
function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}
function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function permanent(code: string, message: string) {
  return new DesignResourceImportError(code, message, false);
}
function transient(code: string, message: string) {
  return new DesignResourceImportError(code, message, true);
}
function normalizeImportError(error: unknown) {
  if (error instanceof DesignResourceImportError) return error;
  if (error instanceof SafeDownloadError)
    return new DesignResourceImportError(
      `download_${error.code}`,
      error.message,
      ["timeout", "network_error", "upstream_status"].includes(error.code),
    );
  return transient(
    "import_internal_error",
    error instanceof Error ? error.message : String(error),
  );
}
