import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { SafeDownloadError } from "../../security/safe-download.js";
import {
  type DesignResourceImportRepository,
  DesignResourceImportService,
  type ResourceImportItem,
  type ResourceImportJob,
  downloadImportFile,
  inspectImportBuffer,
  runDesignResourceImportPollingLoop,
} from "./design-resource-import-service.js";

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const itemId = "44444444-4444-4444-8444-444444444444";
const assetId = "55555555-5555-4555-8555-555555555555";
const claimToken = "99999999-9999-4999-8999-999999999999";

function importJob(
  sourceKind: ResourceImportJob["source_kind"] = "local_upload",
  attemptCount = 1,
): ResourceImportJob {
  return {
    id: jobId,
    scope: "workspace",
    workspace_id: workspaceId,
    source_kind: sourceKind,
    attempt_count: attemptCount,
    created_by: userId,
    claim_token: claimToken,
  };
}

function importItem(
  overrides: Partial<ResourceImportItem> = {},
): ResourceImportItem {
  return {
    id: itemId,
    import_job_id: jobId,
    source_key: "hero.png",
    asset_object_id: assetId,
    metadata: {},
    ...overrides,
  };
}

function repository(
  items: ResourceImportItem[],
  overrides: Partial<DesignResourceImportRepository> = {},
): DesignResourceImportRepository {
  return {
    claim: vi.fn(async () => []),
    listPendingItems: vi.fn(async () => items),
    loadStagedAsset: vi.fn(async (_job, id) => ({
      id,
      buffer: Buffer.alloc(0),
      mimeType: "application/octet-stream",
      objectPath: `staged/${id}`,
    })),
    persistDownloadedAsset: vi.fn(async ({ buffer, mimeType }) => ({
      id: assetId,
      buffer,
      mimeType,
      objectPath: `imports/${itemId}`,
    })),
    rememberDownloadedAsset: vi.fn(async () => undefined),
    findDuplicate: vi.fn(async () => null),
    findFontFamily: vi.fn(async () => null),
    createCatalog: vi.fn(async () => ({
      entity_id: "66666666-6666-4666-8666-666666666666",
      revision: 0,
      status: "draft",
      replayed: false,
    })),
    setCatalogPendingReview: vi.fn(async () => undefined),
    finalizeItem: vi.fn(async () => undefined),
    deferJob: vi.fn(async () => undefined),
    completeJob: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("design resource import worker", () => {
  it("imports a mixed manifest in dependency order and rewrites legacy paths", async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: "red" },
    })
      .png()
      .toBuffer();
    const fontAssetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const kinds = [
      ["category", "catalog/category", {}],
      ["tag", "catalog/tag", {}],
      ["font_family", "fonts/family", {}],
      ["font_face", "fonts/main.ttf", { family_id: "fonts/family" }],
      [
        "resource",
        "images/hero.png",
        { category_path: "catalog/category", tag_paths: ["catalog/tag"] },
      ],
      ["text_preset", "text/hero", { style: { fontFaceId: "fonts/main.ttf" } }],
      [
        "template",
        "templates/hero",
        {
          scene: {
            objects: [
              {
                resourceId: "images/hero.png",
                assetObjectId: "images/hero.png",
                fontFaceId: "fonts/main.ttf",
              },
            ],
          },
        },
      ],
    ] as const;
    const items = kinds.map(([kind, sourceKey, payload], index) =>
      importItem({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        source_key: sourceKey,
        asset_object_id:
          kind === "resource"
            ? assetId
            : kind === "font_face"
              ? fontAssetId
              : null,
        metadata: {
          entity_kind: kind,
          payload,
          depends_on:
            kind === "font_face"
              ? ["fonts/family"]
              : kind === "resource"
                ? ["catalog/category", "catalog/tag"]
                : kind === "text_preset"
                  ? ["fonts/main.ttf"]
                  : kind === "template"
                    ? ["images/hero.png", "fonts/main.ttf"]
                    : [],
        },
      }),
    );
    const results = new Map<
      string,
      { entityKind: never; entityId: string; assetObjectId: string | null }
    >();
    const idByKind = new Map<string, string>();
    const repo = repository(items, {
      loadStagedAsset: vi.fn(async (_job, id) => ({
        id,
        buffer: id === fontAssetId ? makeMinimalTtf("Manifest Sans") : png,
        mimeType: id === fontAssetId ? "font/ttf" : "image/png",
        objectPath: `staged/${id}`,
      })),
      createCatalog: vi.fn(async ({ entityKind }) => {
        const id = `10000000-0000-4000-8000-${String(idByKind.size + 1).padStart(12, "0")}`;
        idByKind.set(entityKind, id);
        return { entity_id: id, revision: 0, status: "draft", replayed: false };
      }),
      resolveImportResult: vi.fn(async (_job, key) => results.get(key) ?? null),
      finalizeItem: vi.fn(
        async ({
          itemId: finalizedId,
          entityKind,
          entityId,
          assetObjectId,
        }) => {
          const item = items.find((candidate) => candidate.id === finalizedId);
          if (item && entityKind && entityId)
            results.set(item.source_key, {
              entityKind: entityKind as never,
              entityId,
              assetObjectId,
            });
        },
      ),
    });

    await new DesignResourceImportService(repo).processJob(
      importJob("manifest"),
    );

    expect(repo.finalizeItem).toHaveBeenCalledTimes(7);
    expect(repo.createCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityKind: "template",
        payload: expect.objectContaining({
          scene: expect.objectContaining({
            objects: [
              expect.objectContaining({
                resourceId: idByKind.get("resource"),
                assetObjectId: assetId,
                fontFaceId: idByKind.get("font_face"),
              }),
            ],
          }),
        }),
      }),
    );
  });

  it("reports missing dependencies per item and rejects dependency cycles", async () => {
    const independent = importItem({
      id: "10000000-0000-4000-8000-000000000001",
      source_key: "category/ok",
      asset_object_id: null,
      metadata: { entity_kind: "category", payload: {} },
    });
    const missing = importItem({
      id: "10000000-0000-4000-8000-000000000002",
      source_key: "template/missing",
      asset_object_id: null,
      metadata: {
        entity_kind: "template",
        depends_on: ["images/missing.png"],
        payload: {},
      },
    });
    const partialRepo = repository([independent, missing], {
      resolveImportResult: vi.fn(async () => null),
    });
    await new DesignResourceImportService(partialRepo).processJob(
      importJob("manifest"),
    );
    expect(partialRepo.finalizeItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: "rejected",
        errorCode: "manifest_dependency_missing",
      }),
    );

    const cycleItems = [
      importItem({
        source_key: "a",
        metadata: { entity_kind: "category", depends_on: ["b"], payload: {} },
      }),
      importItem({
        id: "10000000-0000-4000-8000-000000000003",
        source_key: "b",
        metadata: { entity_kind: "tag", depends_on: ["a"], payload: {} },
      }),
      importItem({
        id: "10000000-0000-4000-8000-000000000004",
        source_key: "independent",
        asset_object_id: null,
        metadata: { entity_kind: "category", payload: {} },
      }),
    ];
    const cycleRepo = repository(cycleItems);
    await new DesignResourceImportService(cycleRepo).processJob(
      importJob("manifest"),
    );
    expect(cycleRepo.finalizeItem).toHaveBeenCalledTimes(3);
    expect(cycleRepo.finalizeItem).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "manifest_dependency_cycle" }),
    );
    expect(cycleRepo.finalizeItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "10000000-0000-4000-8000-000000000004",
        status: "imported",
      }),
    );
  });

  it("imports a real raster, derives trusted metadata and finalizes the item", async () => {
    const png = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 4,
        background: "red",
      },
    })
      .png()
      .toBuffer();
    const repo = repository([importItem()], {
      loadStagedAsset: vi.fn(async () => ({
        id: assetId,
        buffer: png,
        mimeType: "image/png",
        objectPath: "staged/hero.png",
      })),
    });

    await expect(
      new DesignResourceImportService(repo).processJob(importJob()),
    ).resolves.toBe("completed");

    expect(repo.createCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityKind: "resource",
        payload: expect.objectContaining({
          kind: "image",
          width: 8,
          height: 6,
          asset_object_id: assetId,
        }),
      }),
    );
    expect(repo.setCatalogPendingReview).toHaveBeenCalledOnce();
    expect(repo.finalizeItem).toHaveBeenCalledWith(
      expect.objectContaining({
        claimToken,
        status: "imported",
        entityKind: "resource",
      }),
    );
    expect(repo.completeJob).toHaveBeenCalledWith(jobId, claimToken);
  });

  it("uses the checksum to finish a retry as a duplicate without another upload", async () => {
    const png = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: "blue",
      },
    })
      .png()
      .toBuffer();
    const repo = repository([importItem()], {
      loadStagedAsset: vi.fn(async () => ({
        id: assetId,
        buffer: png,
        mimeType: "image/png",
        objectPath: "staged/hero.png",
      })),
      findDuplicate: vi.fn(async () => ({
        entityKind: "resource" as const,
        entityId: "77777777-7777-4777-8777-777777777777",
      })),
    });

    await new DesignResourceImportService(repo).processJob(importJob());

    expect(repo.persistDownloadedAsset).not.toHaveBeenCalled();
    expect(repo.createCatalog).not.toHaveBeenCalled();
    expect(repo.finalizeItem).toHaveBeenCalledWith(
      expect.objectContaining({ status: "duplicate" }),
    );
  });

  it("reports item failures independently and continues with the remaining items", async () => {
    const archive = Buffer.from("PK\u0003\u0004unsafe archive");
    const png = await sharp({
      create: {
        width: 3,
        height: 3,
        channels: 4,
        background: "green",
      },
    })
      .png()
      .toBuffer();
    const secondId = "88888888-8888-4888-8888-888888888888";
    const repo = repository(
      [importItem(), importItem({ id: secondId, asset_object_id: secondId })],
      {
        loadStagedAsset: vi.fn(async (_job, id) => ({
          id,
          buffer: id === assetId ? archive : png,
          mimeType: id === assetId ? "application/zip" : "image/png",
          objectPath: `staged/${id}`,
        })),
      },
    );

    await new DesignResourceImportService(repo).processJob(importJob());

    expect(repo.finalizeItem).toHaveBeenCalledTimes(2);
    expect(repo.finalizeItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        itemId,
        status: "rejected",
        errorCode: "archive_unsupported",
      }),
    );
    expect(repo.finalizeItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ itemId: secondId, status: "imported" }),
    );
  });

  it("defers transient downloads before attempt three and reaches a failed terminal item on attempt three", async () => {
    const item = importItem({
      source_key: "https://cdn.example/hero.png",
      asset_object_id: null,
    });
    const retryRepo = repository([item]);
    const download = vi.fn(async () => {
      throw new SafeDownloadError("timeout", "download timed out");
    });
    const service = new DesignResourceImportService(retryRepo, download);

    await expect(service.processJob(importJob("url", 1))).resolves.toBe(
      "deferred",
    );
    expect(retryRepo.deferJob).toHaveBeenCalledOnce();
    expect(retryRepo.deferJob).toHaveBeenCalledWith(
      jobId,
      claimToken,
      expect.stringContaining("download_timeout"),
      expect.any(Number),
    );
    expect(retryRepo.finalizeItem).not.toHaveBeenCalled();
    expect(retryRepo.completeJob).not.toHaveBeenCalled();

    const terminalRepo = repository([item]);
    await expect(
      new DesignResourceImportService(terminalRepo, download).processJob(
        importJob("url", 3),
      ),
    ).resolves.toBe("completed");
    expect(terminalRepo.deferJob).not.toHaveBeenCalled();
    expect(terminalRepo.finalizeItem).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "download_timeout",
      }),
    );
  });

  it("rejects manifest batches instead of pretending archive or multi-item support", async () => {
    const repo = repository([importItem()], {
      loadStagedAsset: vi.fn(async () => ({
        id: assetId,
        buffer: Buffer.from(
          JSON.stringify({
            version: 1,
            items: [{ source_url: "https://a.test/a.png" }],
          }),
        ),
        mimeType: "application/json",
        objectPath: "staged/manifest.json",
      })),
    });

    await new DesignResourceImportService(repo).processJob(
      importJob("manifest"),
    );

    expect(repo.finalizeItem).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "rejected",
        errorCode: "manifest_invalid",
      }),
    );
  });

  it("extracts font family metadata and preserves an explicit web-embed permission", async () => {
    const font = makeMinimalTtf("Loomic Sans");
    const repo = repository(
      [importItem({ metadata: { allow_web_embed: true } })],
      {
        loadStagedAsset: vi.fn(async () => ({
          id: assetId,
          buffer: font,
          mimeType: "font/ttf",
          objectPath: "staged/loomic.ttf",
        })),
      },
    );

    await new DesignResourceImportService(repo).processJob(importJob());

    expect(repo.createCatalog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        entityKind: "font_family",
        payload: expect.objectContaining({ name: "Loomic Sans" }),
      }),
    );
    expect(repo.createCatalog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        entityKind: "font_face",
        payload: expect.objectContaining({
          format: "ttf",
          weight: 400,
          allow_web_embed: true,
        }),
      }),
    );
  });

  it("rejects executable SVG, MIME spoofing, pixel bombs, and unsupported WOFF2", async () => {
    const maliciousSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    await expect(
      inspectImportBuffer(maliciousSvg, "image/svg+xml"),
    ).rejects.toMatchObject({ code: "svg_unsafe", retryable: false });

    const png = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: "black",
      },
    })
      .png()
      .toBuffer();
    await expect(inspectImportBuffer(png, "image/jpeg")).rejects.toMatchObject({
      code: "mime_mismatch",
      retryable: false,
    });

    await expect(
      inspectImportBuffer(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="40000" height="40000"/>',
        ),
        "image/svg+xml",
      ),
    ).rejects.toMatchObject({ retryable: false });

    await expect(
      inspectImportBuffer(Buffer.from("wOF2placeholder"), "font/woff2"),
    ).rejects.toMatchObject({
      code: "font_format_unsupported",
      retryable: false,
    });

    await expect(
      inspectImportBuffer(makeMinimalTtf("Restricted", 0x0002), "font/ttf"),
    ).rejects.toMatchObject({
      code: "font_embedding_forbidden",
      retryable: false,
    });
  });

  it("blocks redirects to private DNS in the import download path", async () => {
    await expect(
      downloadImportFile("https://public.example/start", {
        resolve: async (hostname) =>
          hostname === "internal.example" ? ["127.0.0.1"] : ["93.184.216.34"],
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://internal.example/secret" },
          }),
      }),
    ).rejects.toMatchObject({ code: "forbidden_address" });
  });

  it("backs off when idle or failing and exits the registered polling loop", async () => {
    const repo = repository([]);
    const service = new DesignResourceImportService(repo);
    let running = true;
    const sleep = vi.fn(async () => {
      running = false;
    });
    await runDesignResourceImportPollingLoop(service, {
      isRunning: () => running,
      sleep,
    });
    expect(repo.claim).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1_000);

    running = true;
    const failingService = {
      runOnce: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    } as unknown as DesignResourceImportService;
    const onError = vi.fn();
    await runDesignResourceImportPollingLoop(failingService, {
      isRunning: () => running,
      sleep: async () => {
        running = false;
      },
      onError,
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});

function makeMinimalTtf(familyName: string, fsType = 0): Buffer {
  const encoded = Buffer.alloc(familyName.length * 2);
  for (let index = 0; index < familyName.length; index += 1) {
    encoded.writeUInt16BE(familyName.charCodeAt(index), index * 2);
  }
  const nameTable = Buffer.alloc(18 + encoded.length);
  nameTable.writeUInt16BE(0, 0);
  nameTable.writeUInt16BE(1, 2);
  nameTable.writeUInt16BE(18, 4);
  nameTable.writeUInt16BE(3, 6);
  nameTable.writeUInt16BE(1, 8);
  nameTable.writeUInt16BE(0x0409, 10);
  nameTable.writeUInt16BE(1, 12);
  nameTable.writeUInt16BE(encoded.length, 14);
  nameTable.writeUInt16BE(0, 16);
  encoded.copy(nameTable, 18);

  const os2Table = Buffer.alloc(64);
  os2Table.writeUInt16BE(4, 0);
  os2Table.writeUInt16BE(400, 4);
  os2Table.writeUInt16BE(5, 6);
  os2Table.writeUInt16BE(fsType, 8);

  const tableDirectoryBytes = 12 + 2 * 16;
  const nameOffset = tableDirectoryBytes;
  const os2Offset = nameOffset + nameTable.length;
  const font = Buffer.alloc(os2Offset + os2Table.length);
  font.writeUInt32BE(0x0001_0000, 0);
  font.writeUInt16BE(2, 4);
  font.write("name", 12, "ascii");
  font.writeUInt32BE(nameOffset, 20);
  font.writeUInt32BE(nameTable.length, 24);
  font.write("OS/2", 28, "ascii");
  font.writeUInt32BE(os2Offset, 36);
  font.writeUInt32BE(os2Table.length, 40);
  nameTable.copy(font, nameOffset);
  os2Table.copy(font, os2Offset);
  return font;
}
