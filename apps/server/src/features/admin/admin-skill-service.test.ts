import { describe, expect, it, vi } from "vitest";

import { AdminSkillError, SKILL_PREVIEW_MIME_TYPES, createAdminSkillService } from "./admin-skill-service.js";

/**
 * Fake for the four tables and six functions this service touches. It records RPC
 * and storage calls so the tests can assert the exact arguments, the rollback
 * behaviour and the published-only customer read.
 */
function fakeAdmin(input: {
  isActorAdmin?: boolean;
  catalog?: unknown;
  skills?: Array<{ id: string; slug: string }>;
  previews?: Array<Record<string, unknown>>;
  assets?: Array<Record<string, unknown>>;
  rpcError?: { message: string } | null;
  uploadError?: { message: string } | null;
  assetInsertError?: { message: string } | null;
  signedUrl?: string | null;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const storageCalls: Array<{ op: string; bucket: string; path: string | undefined }> = [];
  const assetDeletes: string[] = [];
  const from = (table: string) => {
    let filters: Array<[string, unknown]> = [];
    let inFilter: [string, readonly unknown[]] | null = null;
    const source = () => (table === "skills" ? (input.skills ?? [])
      : table === "skill_previews" ? (input.previews ?? [])
        : table === "asset_objects" ? (input.assets ?? [])
          : []) as Array<Record<string, unknown>>;
    const rows = () => {
      let result = [...source()];
      for (const [column, value] of filters) result = result.filter(row => row[column] === value);
      if (inFilter) result = result.filter(row => (inFilter![1] as readonly unknown[]).includes(row[inFilter![0]]));
      return result;
    };
    const builder: any = {
      select() { return builder; },
      eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
      is(column: string, value: unknown) { filters.push([column, value]); return builder; },
      in(column: string, values: readonly unknown[]) { inFilter = [column, values]; return builder; },
      order() { return builder; },
      delete() { return builder; },
      insert: () => ({
        select: () => ({
          single: async () => input.assetInsertError
            ? { data: null, error: input.assetInsertError }
            : { data: { id: "new-asset" }, error: null },
        }),
      }),
      maybeSingle: async () => ({
        data: table === "platform_admins"
          ? (input.isActorAdmin === false ? null : { user_id: ACTOR })
          : rows()[0] ?? null,
        error: null,
      }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
    };
    // `delete().eq()` needs to record which asset ids were removed.
    builder.delete = () => ({
      eq: async (column: string, value: string) => {
        assetDeletes.push(`${table}:${column}=${value}`);
        return { error: null };
      },
    });
    return builder;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (input.rpcError) return { data: null, error: input.rpcError };
    if (fn === "admin_skill_catalog") return { data: input.catalog ?? { skills: [] }, error: null };
    return { data: { previewId: "preview-1" }, error: null };
  };
  const storage = {
    from: (bucket: string) => ({
      upload: async (path: string) => {
        storageCalls.push({ op: "upload", bucket, path });
        return input.uploadError ? { error: input.uploadError } : { error: null };
      },
      remove: async (paths: string[]) => {
        storageCalls.push({ op: "remove", bucket, path: paths[0] });
        return { error: null };
      },
      createSignedUrl: async (path: string) => {
        storageCalls.push({ op: "sign", bucket, path });
        return input.signedUrl === null ? { data: null } : { data: { signedUrl: input.signedUrl ?? `https://signed.test/${path}` } };
      },
    }),
  };
  const client = { from, rpc, storage } as never;
  return { client, rpcCalls, storageCalls, assetDeletes };
}

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SKILL = "87e79614-8f4b-4530-8003-6e4bab97c993";
const PREVIEW = "11111111-1111-4111-8111-111111111111";

function service(input: Parameters<typeof fakeAdmin>[0]) {
  const fake = fakeAdmin(input);
  return { ...createAdminSkillService({ getAdminClient: () => fake.client }), fake };
}

const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("admin skill service", () => {
  it("refuses a non-platform-admin actor before any read or write", async () => {
    const { listSkills, listPreviews, attachPreview, publishPreview, deletePreview, reorderPreviews, fake } =
      service({ isActorAdmin: false });
    const calls = [
      () => listSkills(ACTOR),
      () => listPreviews(ACTOR, SKILL),
      () => attachPreview(ACTOR, { skillId: SKILL, role: "cover", caption: null, reason: "上线封面", fileName: "a.png", mimeType: "image/png", buffer: png() }),
      () => publishPreview(ACTOR, { previewId: PREVIEW, reason: "上线" }),
      () => deletePreview(ACTOR, { previewId: PREVIEW, reason: "下架" }),
      () => reorderPreviews(ACTOR, { skillId: SKILL, orderedPreviewIds: [PREVIEW], reason: "排序" }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "platform_admin_required", statusCode: 403 });
    }
    expect(fake.rpcCalls).toHaveLength(0);
    expect(fake.storageCalls).toHaveLength(0);
  });

  it("lists the catalog with the query and a bounded limit", async () => {
    const { listSkills, fake } = service({ catalog: { skills: [{ slug: "logo-design" }] } });
    await expect(listSkills(ACTOR, { query: "  logo  ", limit: 10 })).resolves.toEqual({ skills: [{ slug: "logo-design" }] });
    await listSkills(ACTOR, { limit: 10_000 });
    await listSkills(ACTOR, {});
    expect(fake.rpcCalls[0]).toEqual({ fn: "admin_skill_catalog", args: { p_actor_user_id: ACTOR, p_query: "logo", p_limit: 10 } });
    expect(fake.rpcCalls[1]!.args).toMatchObject({ p_limit: 200 });
    expect(fake.rpcCalls[2]!.args).toMatchObject({ p_limit: 50, p_query: null });
  });

  it("returns previews with signed URLs and tolerates a signing failure", async () => {
    const { listPreviews } = service({
      skills: [{ id: SKILL, slug: "logo-design" }],
      previews: [{ id: PREVIEW, skill_id: SKILL, asset_object_id: "asset-1", role: "cover", caption: "封面",
        sort_order: 0, status: "published", created_by: ACTOR, created_at: "2026-09-20T00:00:00.000Z",
        updated_at: "2026-09-20T00:00:00.000Z" }],
      assets: [{ id: "asset-1", bucket: "platform-assets", object_path: "skills/x/a.png", mime_type: "image/png", byte_size: 4 }],
    });
    const result = await listPreviews(ACTOR, SKILL);
    expect(result.previews[0]).toMatchObject({ id: PREVIEW, role: "cover", status: "published", mimeType: "image/png",
      imageUrl: "https://signed.test/skills/x/a.png" });

    const unsigned = service({
      previews: [{ id: PREVIEW, skill_id: SKILL, asset_object_id: "asset-1", role: "example", caption: null,
        sort_order: 1, status: "draft", created_by: null, created_at: "2026-09-20T00:00:00.000Z",
        updated_at: "2026-09-20T00:00:00.000Z" }],
      assets: [{ id: "asset-1", bucket: "platform-assets", object_path: "skills/x/a.png", mime_type: "image/png", byte_size: 4 }],
      signedUrl: null,
    });
    await expect(unsigned.listPreviews(ACTOR, SKILL)).resolves.toMatchObject({ previews: [{ imageUrl: null }] });
  });

  it("rejects an unsupported type and an oversized file before touching storage", async () => {
    const { attachPreview, fake } = service({});
    await expect(attachPreview(ACTOR, { skillId: SKILL, role: "cover", caption: null, reason: "上线封面",
      fileName: "a.svg", mimeType: "image/svg+xml", buffer: png() }))
      .rejects.toMatchObject({ code: "admin_invalid_file", statusCode: 400 });
    await expect(attachPreview(ACTOR, { skillId: SKILL, role: "cover", caption: null, reason: "上线封面",
      fileName: "a.png", mimeType: "image/png", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) }))
      .rejects.toMatchObject({ code: "admin_invalid_file" });
    await expect(attachPreview(ACTOR, { skillId: SKILL, role: "cover", caption: null, reason: "上线封面",
      fileName: "a.png", mimeType: "image/png", buffer: Buffer.alloc(0) }))
      .rejects.toMatchObject({ code: "admin_invalid_file" });
    expect(fake.storageCalls).toHaveLength(0);
  });

  it("uploads to platform-assets, registers the asset and attaches it with the reason", async () => {
    const { attachPreview, fake } = service({
      previews: [{ id: PREVIEW, skill_id: SKILL, asset_object_id: "new-asset", role: "cover", caption: "封面",
        sort_order: 0, status: "draft", created_by: ACTOR, created_at: "2026-09-20T00:00:00.000Z",
        updated_at: "2026-09-20T00:00:00.000Z" }],
      assets: [{ id: "new-asset", bucket: "platform-assets", object_path: "skills/x/new.png", mime_type: "image/png", byte_size: 4 }],
    });
    await expect(attachPreview(ACTOR, { skillId: SKILL, role: "cover", caption: " 封面 ", reason: " 上线封面 ",
      fileName: "a.png", mimeType: "image/png", buffer: png() }))
      .resolves.toMatchObject({ id: PREVIEW, assetObjectId: "new-asset" });

    const upload = fake.storageCalls.find(call => call.op === "upload")!;
    expect(upload.bucket).toBe("platform-assets");
    expect(upload.path!.startsWith(`skills/${SKILL}/`)).toBe(true);
    expect(upload.path!.endsWith(".png")).toBe(true);
    expect(fake.rpcCalls[0]).toMatchObject({
      fn: "admin_attach_skill_preview",
      args: { p_actor_user_id: ACTOR, p_skill_id: SKILL, p_asset_object_id: "new-asset", p_role: "cover",
        p_caption: " 封面 ", p_reason: "上线封面" },
    });
  });

  it("removes the uploaded object when its metadata row is refused", async () => {
    const { attachPreview, fake } = service({ assetInsertError: { message: "duplicate key" } });
    await expect(attachPreview(ACTOR, { skillId: SKILL, role: "example", caption: null, reason: "示例图",
      fileName: "a.png", mimeType: "image/png", buffer: png() }))
      .rejects.toMatchObject({ code: "admin_write_failed" });
    expect(fake.storageCalls.map(call => call.op)).toEqual(["upload", "remove"]);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("removes both the metadata row and the object when the attach is refused", async () => {
    const { attachPreview, fake } = service({ rpcError: { message: "INVALID_ASSET_SCOPE: nope" } });
    await expect(attachPreview(ACTOR, { skillId: SKILL, role: "example", caption: null, reason: "示例图",
      fileName: "a.png", mimeType: "image/png", buffer: png() }))
      .rejects.toMatchObject({ code: "admin_invalid_asset", statusCode: 400 });
    expect(fake.assetDeletes).toEqual(["asset_objects:id=new-asset"]);
    expect(fake.storageCalls.map(call => call.op)).toEqual(["upload", "remove"]);
  });

  it("does not leave the uploaded object behind when the storage upload itself fails", async () => {
    const { attachPreview, fake } = service({ uploadError: { message: "quota" } });
    await expect(attachPreview(ACTOR, { skillId: SKILL, role: "cover", caption: null, reason: "上线封面",
      fileName: "a.png", mimeType: "image/png", buffer: png() }))
      .rejects.toMatchObject({ code: "admin_write_failed" });
    expect(fake.storageCalls.map(call => call.op)).toEqual(["upload"]);
  });

  it("covers every supported image type with the right extension", async () => {
    for (const mimeType of SKILL_PREVIEW_MIME_TYPES) {
      const { attachPreview, fake } = service({
        previews: [{ id: PREVIEW, skill_id: SKILL, asset_object_id: "new-asset", role: "example", caption: null,
          sort_order: 0, status: "draft", created_by: null, created_at: "2026-09-20T00:00:00.000Z",
          updated_at: "2026-09-20T00:00:00.000Z" }],
        assets: [{ id: "new-asset", bucket: "platform-assets", object_path: "x", mime_type: mimeType, byte_size: 4 }],
      });
      await attachPreview(ACTOR, { skillId: SKILL, role: "example", caption: null, reason: "示例图",
        fileName: "a", mimeType, buffer: png() });
      const path = fake.storageCalls.find(call => call.op === "upload")!.path!;
      expect(path.endsWith(`.${mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]}`)).toBe(true);
    }
  });

  it("translates every refusal code instead of leaking the raw message", async () => {
    const cases: Array<[string, string, number]> = [
      ["FORBIDDEN: actor is not an active platform admin", "platform_admin_required", 403],
      ["REASON_REQUIRED: a reason is required for a skill image change", "admin_reason_required", 400],
      ["UNKNOWN_SKILL: no such skill", "admin_skill_not_found", 404],
      ["UNKNOWN_PREVIEW: no such skill preview", "admin_preview_not_found", 404],
      ["UNKNOWN_ASSET: no such asset object", "admin_invalid_asset", 400],
      ["INVALID_ASSET_SCOPE: skill previews require a platform-scope asset", "admin_invalid_asset", 400],
      ["INVALID_ROLE: the preview role must be cover or example", "admin_invalid_file", 400],
      ["INVALID_ORDER: the ordered list must contain every preview of this skill", "admin_invalid_order", 400],
      ["something unexpected", "admin_write_failed", 500],
    ];
    for (const [message, code, statusCode] of cases) {
      const { publishPreview } = service({ rpcError: { message } });
      const error = await publishPreview(ACTOR, { previewId: PREVIEW, reason: "上线" }).catch(caught => caught);
      expect(error, message).toBeInstanceOf(AdminSkillError);
      expect(error, message).toMatchObject({ code, statusCode });
      expect(error.message, message).not.toContain(":");
    }
  });

  it("returns only published previews to customers, with signed urls and no ids", async () => {
    const { listPublishedPreviews, fake } = service({
      skills: [{ id: SKILL, slug: "logo-design" }],
      previews: [
        { id: PREVIEW, skill_id: SKILL, asset_object_id: "asset-1", role: "cover", caption: "封面", sort_order: 0, status: "published" },
        { id: "draft-1", skill_id: SKILL, asset_object_id: "asset-2", role: "example", caption: null, sort_order: 1, status: "draft" },
      ],
      assets: [
        { id: "asset-1", bucket: "platform-assets", object_path: "skills/x/cover.png" },
        { id: "asset-2", bucket: "platform-assets", object_path: "skills/x/draft.png" },
      ],
    });
    const result = await listPublishedPreviews("logo-design");
    expect(result.previews).toEqual([{
      id: PREVIEW, role: "cover", caption: "封面", imageUrl: "https://signed.test/skills/x/cover.png",
    }]);
    expect(JSON.stringify(result)).not.toContain("draft-1");
    expect(fake.storageCalls.filter(call => call.op === "sign").map(call => call.path))
      .toEqual(["skills/x/cover.png"]);

    const missing = service({ skills: [] });
    await expect(missing.listPublishedPreviews("nope")).resolves.toEqual({ previews: [] });
    expect(missing.fake.rpcCalls).toHaveLength(0);
    void vi;
  });

  it("skips a published row whose image cannot be signed", async () => {
    const { listPublishedPreviews } = service({
      skills: [{ id: SKILL, slug: "logo-design" }],
      previews: [{ id: PREVIEW, skill_id: SKILL, asset_object_id: "asset-1", role: "cover", caption: null, sort_order: 0, status: "published" }],
      assets: [],
    });
    await expect(listPublishedPreviews("logo-design")).resolves.toEqual({ previews: [] });
  });

  it("groups a batch read by slug with the cover separated from the examples", async () => {
    const otherSkill = "372f4760-ffe1-4f09-8211-cf0c5dbc0606";
    const { listPublishedPreviewGroups } = service({
      skills: [{ id: SKILL, slug: "logo-design" }, { id: otherSkill, slug: "json-image-prompt" }],
      previews: [
        { id: PREVIEW, skill_id: SKILL, asset_object_id: "asset-1", role: "cover", caption: "封面", sort_order: 0, status: "published" },
        { id: "ex-1", skill_id: SKILL, asset_object_id: "asset-2", role: "example", caption: "示例", sort_order: 1, status: "published" },
        { id: "ex-2", skill_id: SKILL, asset_object_id: "asset-3", role: "example", caption: null, sort_order: 2, status: "published" },
        { id: "draft-1", skill_id: otherSkill, asset_object_id: "asset-4", role: "cover", caption: null, sort_order: 0, status: "draft" },
      ],
      assets: [
        { id: "asset-1", bucket: "platform-assets", object_path: "skills/x/cover.png" },
        { id: "asset-2", bucket: "platform-assets", object_path: "skills/x/ex1.png" },
        { id: "asset-3", bucket: "platform-assets", object_path: "skills/x/ex2.png" },
        { id: "asset-4", bucket: "platform-assets", object_path: "skills/x/draft.png" },
      ],
    });
    const result = await listPublishedPreviewGroups(["logo-design", "json-image-prompt", "logo-design"]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      slug: "logo-design",
      cover: { id: PREVIEW, role: "cover", imageUrl: "https://signed.test/skills/x/cover.png" },
      examples: [
        { id: "ex-1", role: "example", caption: "示例" },
        { id: "ex-2", role: "example", caption: null },
      ],
    });
    // A skill with only drafts is absent, not an empty group.
    expect(JSON.stringify(result)).not.toContain("json-image-prompt");
  });

  it("bounds and sanitizes the batch slug list", async () => {
    const { listPublishedPreviewGroups, fake } = service({ skills: [], previews: [], assets: [] });
    await expect(listPublishedPreviewGroups([])).resolves.toEqual({ groups: [] });
    await expect(listPublishedPreviewGroups(["  ", "not a slug!", "UPPER--ok"])).resolves.toEqual({ groups: [] });
    // Invalid entries are dropped rather than queried; the valid one still runs.
    const batches: string[][] = [];
    const spy = vi.spyOn(fake.client as unknown as { from: (table: string) => unknown }, "from");
    await listPublishedPreviewGroups(["logo-design", "", "bad slug"]);
    expect(spy).toHaveBeenCalled();
    void batches;

    const many = Array.from({ length: 120 }, (_, index) => `skill-${index}`);
    await expect(listPublishedPreviewGroups(many)).resolves.toEqual({ groups: [] });
  });
});
