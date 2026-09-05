import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { collectExpiredDesignExportAssets } from "./design-export-gc.js";

function setup(options: {
  claim: unknown;
  prepared?: boolean;
  pending?: boolean;
  storageError?: { message: string } | null;
}) {
  const assetId = randomUUID();
  const claimToken = randomUUID();
  const scan = {
    select: vi.fn(() => scan),
    like: vi.fn(() => scan),
    not: vi.fn(() => scan),
    lte: vi.fn(() => scan),
    order: vi.fn(() => scan),
    limit: vi.fn(async () => ({
      data: [
        {
          id: assetId,
          gc_claim_token: options.pending ? claimToken : null,
          deletion_pending_at: options.pending
            ? "2026-09-11T00:00:00.000Z"
            : null,
          bucket: "workspace-assets",
          object_path: "expired.png",
        },
      ],
      error: null,
    })),
  };
  const rpc = vi.fn(async (name: string) => {
    if (name === "loomic_asset_gc_claim") {
      return {
        data:
          options.claim === "valid"
            ? [
                {
                  claim_token: claimToken,
                  bucket: "workspace-assets",
                  object_path: "expired.png",
                },
              ]
            : options.claim,
        error: null,
      };
    }
    if (name === "loomic_asset_gc_prepare_delete") {
      return { data: options.prepared ?? true, error: null };
    }
    return { data: true, error: null };
  });
  const remove = vi.fn(async () => ({
    data: null,
    error: options.storageError ?? null,
  }));
  return {
    assetId,
    claimToken,
    scan,
    rpc,
    remove,
    admin: {
      from: vi.fn(() => scan),
      rpc,
      storage: { from: vi.fn(() => ({ remove })) },
    },
  };
}

describe("design export asset GC", () => {
  it("deletes an expired unreferenced asset through both RPC fences", async () => {
    const state = setup({ claim: "valid" });
    await expect(
      collectExpiredDesignExportAssets(state.admin as never),
    ).resolves.toEqual({ checked: 1, deleted: 1, skipped: 0, failed: 0 });
    expect(state.remove).toHaveBeenCalledWith(["expired.png"]);
    expect(state.rpc).toHaveBeenCalledWith(
      "loomic_asset_gc_prepare_delete",
      expect.objectContaining({ p_asset_id: state.assetId }),
    );
    expect(state.rpc).toHaveBeenCalledWith(
      "loomic_asset_gc_finalize",
      expect.objectContaining({ p_asset_id: state.assetId }),
    );
  });

  it("skips an expired asset when the claim RPC finds a live reference", async () => {
    const state = setup({ claim: [] });
    await expect(
      collectExpiredDesignExportAssets(state.admin as never),
    ).resolves.toEqual({ checked: 1, deleted: 0, skipped: 1, failed: 0 });
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("leaves a prepared asset recoverable when storage deletion fails", async () => {
    const state = setup({
      claim: "valid",
      storageError: { message: "storage unavailable" },
    });
    await expect(
      collectExpiredDesignExportAssets(state.admin as never),
    ).resolves.toEqual({ checked: 1, deleted: 0, skipped: 0, failed: 1 });
    expect(state.rpc).not.toHaveBeenCalledWith(
      "loomic_asset_gc_finalize",
      expect.anything(),
    );
  });

  it("resumes a crash after prepare without taking a new claim", async () => {
    const state = setup({ claim: [], pending: true });
    await expect(
      collectExpiredDesignExportAssets(state.admin as never),
    ).resolves.toEqual({ checked: 1, deleted: 1, skipped: 0, failed: 0 });
    expect(state.rpc).not.toHaveBeenCalledWith(
      "loomic_asset_gc_claim",
      expect.anything(),
    );
    expect(state.rpc).toHaveBeenCalledWith(
      "loomic_asset_gc_finalize",
      expect.objectContaining({ p_claim_token: state.claimToken }),
    );
  });

  it("scans past a failed first page so later assets are not starved", async () => {
    const rows = Array.from({ length: 26 }, (_, index) => ({
      id: randomUUID(),
      gc_claim_token: null,
      deletion_pending_at: null,
      bucket: "workspace-assets",
      object_path: `export-${index}.png`,
    }));
    const scan = {
      select: vi.fn(() => scan),
      like: vi.fn(() => scan),
      not: vi.fn(() => scan),
      lte: vi.fn(() => scan),
      order: vi.fn(() => scan),
      limit: vi.fn(async () => ({ data: rows, error: null })),
      update: vi.fn(() => scan),
      eq: vi.fn(async () => ({ data: null, error: null })),
    };
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      data:
        name === "loomic_asset_gc_claim"
          ? [
              {
                claim_token: randomUUID(),
                bucket: "workspace-assets",
                object_path: rows.find((row) => row.id === args.p_asset_id)
                  ?.object_path,
              },
            ]
          : true,
      error: null,
    }));
    const remove = vi.fn(async ([path]: string[]) => ({
      data: null,
      error: path === "export-25.png" ? null : { message: "unavailable" },
    }));
    const admin = {
      from: vi.fn(() => scan),
      rpc,
      storage: { from: vi.fn(() => ({ remove })) },
    };

    await expect(
      collectExpiredDesignExportAssets(admin as never, new Date(), 25),
    ).resolves.toEqual({ checked: 26, deleted: 1, skipped: 0, failed: 25 });
    expect(scan.limit).toHaveBeenCalledWith(100);
    expect(remove).toHaveBeenCalledWith(["export-25.png"]);
  });
});
