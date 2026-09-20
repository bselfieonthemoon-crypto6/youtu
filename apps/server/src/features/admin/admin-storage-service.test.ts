import { describe, expect, it } from "vitest";

import { AdminStorageError, createAdminStorageService } from "./admin-storage-service.js";

function fakeAdmin(input: {
  isActorAdmin?: boolean;
  overview?: unknown;
  orphans?: unknown;
  queue?: unknown;
  large?: unknown;
  claim?: unknown;
  rpcError?: { message: string } | null;
  removeError?: { message: string } | null;
  claimError?: { message: string } | null;
  finalizeError?: { message: string } | null;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const removals: Array<{ bucket: string; paths: string[] }> = [];
  const from = () => {
    const builder: any = {
      select() { return builder; },
      eq() { return builder; },
      is() { return builder; },
      maybeSingle: async () => ({ data: input.isActorAdmin === false ? null : { user_id: "actor" }, error: null }),
    };
    return builder;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (input.rpcError) return { data: null, error: input.rpcError };
    if (fn === "admin_asset_overview") {
      return {
        data: input.overview ?? {
          totalObjects: 10, totalBytes: 100, pendingCount: 1, gcEligibleCount: 2, gcClaimedCount: 0,
          buckets: [], scopes: [], workspaces: [],
        },
        error: null,
      };
    }
    if (fn === "admin_asset_orphan_candidates") {
      return { data: input.orphans ?? { total: 0, pageConfirmed: true, objects: [] }, error: null };
    }
    if (fn === "admin_asset_queue") {
      return { data: input.queue ?? { kind: args.p_kind, total: 0, objects: [] }, error: null };
    }
    if (fn === "admin_asset_large_objects") {
      return { data: input.large ?? { objects: [] }, error: null };
    }
    if (fn === "admin_claim_orphan_asset") {
      if (input.claimError) return { data: null, error: input.claimError };
      return { data: input.claim ?? { assetId: args.p_asset_id, bucket: "workspace-assets", objectPath: "w/1/x.png", alreadyPending: false }, error: null };
    }
    if (input.finalizeError) return { data: null, error: input.finalizeError };
    return { data: { assetId: args.p_asset_id, deleted: true }, error: null };
  };
  return {
    client: {
      from,
      rpc,
      storage: {
        from: (bucket: string) => ({
          remove: async (paths: string[]) => {
            removals.push({ bucket, paths });
            return { error: input.removeError ?? null };
          },
        }),
      },
    } as never,
    rpcCalls,
    removals,
  };
}

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET = "55555555-5555-4555-8555-555555555555";

function service(input: Parameters<typeof fakeAdmin>[0] = {}) {
  const fake = fakeAdmin(input);
  return { ...createAdminStorageService({ getAdminClient: () => fake.client }), fake };
}

describe("admin storage service", () => {
  it("refuses a non-platform-admin actor before reading or writing anything", async () => {
    const { overview, orphanCandidates, queue, largeObjects, purgeOrphan, fake } = service({ isActorAdmin: false });
    const calls = [
      () => overview(ACTOR),
      () => orphanCandidates(ACTOR),
      () => queue(ACTOR, "pending_delete"),
      () => largeObjects(ACTOR),
      () => purgeOrphan(ACTOR, { assetId: ASSET, reason: "清理孤儿" }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "platform_admin_required", statusCode: 403 });
    }
    expect(fake.rpcCalls).toHaveLength(0);
    expect(fake.removals).toHaveLength(0);
  });

  it("returns the overview unchanged and clamps the workspace list", async () => {
    const overview = {
      totalObjects: 5735, totalBytes: 1436990476, pendingCount: 4, gcEligibleCount: 3, gcClaimedCount: 0,
      buckets: [{ bucket: "workspace-assets", scope: "workspace", objects: 5731, bytes: 1436990204,
        pendingCount: 0, gcEligibleCount: 3, claimedCount: 0 }],
      scopes: [{ scope: "workspace", objects: 5735, bytes: 1436990476 }],
      workspaces: [],
    };
    const { overview: call, fake } = service({ overview });
    await expect(call(ACTOR, 500)).resolves.toEqual(overview);
    expect(fake.rpcCalls[0]!.args).toEqual({ p_actor_user_id: ACTOR, p_workspace_limit: 100 });
  });

  it("passes orphan filters through and clamps the page", async () => {
    const { orphanCandidates, fake } = service({});
    await orphanCandidates(ACTOR, {
      bucket: " workspace-assets ", workspaceId: "11111111-1111-4111-8111-111111111111",
      minBytes: 1024, limit: 10_000, offset: -5,
    });
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_asset_orphan_candidates",
      args: {
        p_actor_user_id: ACTOR, p_bucket: "workspace-assets",
        p_workspace_id: "11111111-1111-4111-8111-111111111111",
        p_min_bytes: 1024, p_limit: 100, p_offset: 0,
      },
    });

    // A blank bucket means "every bucket", never an empty-string match.
    await orphanCandidates(ACTOR, { bucket: "   " });
    expect(fake.rpcCalls[1]!.args).toMatchObject({ p_bucket: null, p_min_bytes: null, p_limit: 50, p_offset: 0 });
  });

  it("rejects an unknown queue kind before the database call", async () => {
    const { queue, fake } = service({});
    await expect(queue(ACTOR, "wat")).rejects.toMatchObject({ code: "admin_unknown_kind", statusCode: 400 });
    expect(fake.rpcCalls).toHaveLength(0);

    await queue(ACTOR, " pending_delete ", { limit: 5, offset: 10 });
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_asset_queue",
      args: { p_actor_user_id: ACTOR, p_kind: "pending_delete", p_limit: 5, p_offset: 10 },
    });
  });

  it("clamps the large-object ranking to a bounded page", async () => {
    const { largeObjects, fake } = service({});
    await largeObjects(ACTOR, 10_000);
    await largeObjects(ACTOR);
    expect(fake.rpcCalls[0]!.args).toEqual({ p_actor_user_id: ACTOR, p_limit: 50 });
    expect(fake.rpcCalls[1]!.args).toEqual({ p_actor_user_id: ACTOR, p_limit: 20 });
  });

  it("purges in order: claim, remove the object, then finalize the row", async () => {
    const { purgeOrphan, fake } = service({});
    await expect(purgeOrphan(ACTOR, { assetId: ASSET, reason: " 孤儿素材 " })).resolves.toEqual({
      bucket: "workspace-assets", objectPath: "w/1/x.png",
    });
    expect(fake.rpcCalls.map(call => call.fn)).toEqual([
      "admin_claim_orphan_asset", "admin_finalize_orphan_asset",
    ]);
    expect(fake.rpcCalls[0]!.args).toEqual({
      p_actor_user_id: ACTOR, p_asset_id: ASSET, p_reason: "孤儿素材",
    });
    expect(fake.removals).toEqual([{ bucket: "workspace-assets", paths: ["w/1/x.png"] }]);
  });

  it("leaves the asset pending when the object cannot be removed", async () => {
    // Deleting the row before the object would leak the object forever, so a failed
    // removal must stop here and leave the work to the GC worker.
    const { purgeOrphan, fake } = service({ removeError: { message: "storage down" } });
    const error = await purgeOrphan(ACTOR, { assetId: ASSET, reason: "清理孤儿" }).catch(caught => caught);
    expect(error).toBeInstanceOf(AdminStorageError);
    expect(error.message).toContain("待删队列");
    expect(fake.rpcCalls.map(call => call.fn)).toEqual(["admin_claim_orphan_asset"]);
  });

  it("does not touch storage when the claim is refused", async () => {
    const { purgeOrphan, fake } = service({ claimError: { message: "ASSET_REFERENCED: the asset still has live references" } });
    await expect(purgeOrphan(ACTOR, { assetId: ASSET, reason: "清理孤儿" })).rejects
      .toMatchObject({ code: "admin_asset_referenced", statusCode: 409 });
    expect(fake.removals).toHaveLength(0);
    expect(fake.rpcCalls.map(call => call.fn)).toEqual(["admin_claim_orphan_asset"]);
  });

  it("reports a claim without a bucket as a failure instead of deleting nothing", async () => {
    const { purgeOrphan, fake } = service({ claim: { assetId: ASSET, bucket: null, objectPath: null } });
    await expect(purgeOrphan(ACTOR, { assetId: ASSET, reason: "清理孤儿" })).rejects
      .toMatchObject({ code: "admin_write_failed" });
    expect(fake.removals).toHaveLength(0);
  });

  it("translates every refusal code instead of leaking the raw message", async () => {
    const cases: Array<[string, string, number]> = [
      ["FORBIDDEN: actor is not an active platform admin", "platform_admin_required", 403],
      ["REASON_REQUIRED: a reason is required", "admin_reason_required", 400],
      ["UNKNOWN_ASSET: no such stored object", "admin_asset_not_found", 404],
      ["ASSET_REFERENCED: the asset still has live references", "admin_asset_referenced", 409],
      ["ASSET_FINALIZE_REFUSED: not pending", "admin_asset_not_pending", 409],
      ["UNKNOWN_KIND: bad kind", "admin_unknown_kind", 400],
      ["something unexpected", "admin_write_failed", 500],
    ];
    for (const [message, code, statusCode] of cases) {
      const { overview } = service({ rpcError: { message } });
      const error = await overview(ACTOR).catch(caught => caught);
      expect(error, message).toBeInstanceOf(AdminStorageError);
      expect(error, message).toMatchObject({ code, statusCode });
      expect(error.message, message).not.toContain(":");
    }
  });
});
