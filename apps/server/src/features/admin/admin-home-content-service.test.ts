import { describe, expect, it } from "vitest";

import type { AdminHomeDiscoveryCaseUpsertRequest, AdminHomeExampleUpsertRequest } from "@loomic/shared";

import { AdminHomeContentError, createAdminHomeContentService } from "./admin-home-content-service.js";

function fakeAdmin(input: {
  isActorAdmin?: boolean;
  overview?: unknown;
  list?: unknown;
  upsert?: unknown;
  category?: unknown;
  toggle?: unknown;
  reorder?: unknown;
  rpcError?: { message: string } | null;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
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
    if (fn === "admin_home_content_overview") {
      return {
        data: input.overview ?? {
          discovery: { categories: [], itemCount: 0, activeItemCount: 0 },
          example: { categories: [], itemCount: 0, activeItemCount: 0 },
        },
        error: null,
      };
    }
    if (fn === "admin_home_content_list") {
      return { data: input.list ?? { kind: args.p_kind, total: 0, items: [] }, error: null };
    }
    if (fn === "admin_upsert_home_discovery_case" || fn === "admin_upsert_home_example_example") {
      return { data: input.upsert ?? { id: "generated-id", created: true, sortOrder: 7 }, error: null };
    }
    if (fn === "admin_upsert_home_category") {
      return { data: input.category ?? { key: args.p_key, kind: args.p_kind, created: false, sortOrder: 3 }, error: null };
    }
    if (fn === "admin_set_home_content_active") {
      return { data: input.toggle ?? { kind: args.p_kind, id: args.p_entity_id, isActive: args.p_is_active, wasActive: true, hiddenItems: 4 }, error: null };
    }
    return { data: input.reorder ?? { kind: args.p_kind, ordered: 5 }, error: null };
  };
  return { client: { from, rpc } as never, rpcCalls };
}

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_ID = "branding-case";
const EXAMPLE_ID = "33333333-3333-4333-8333-333333333333";

function service(input: Parameters<typeof fakeAdmin>[0] = {}) {
  const fake = fakeAdmin(input);
  return { ...createAdminHomeContentService({ getAdminClient: () => fake.client }), fake };
}

const caseInput: AdminHomeDiscoveryCaseUpsertRequest = {
  caseId: null, categoryKey: "branding-design", title: "标题", coverImageUrl: "https://example.com/c.png",
  authorName: "作者", authorAvatarUrl: "", caseUrl: "", seedPrompt: "提示", isActive: true, reason: "新建案例",
};

const exampleInput: AdminHomeExampleUpsertRequest = {
  exampleId: null, categoryKey: "branding", title: "示例", prompt: "提示",
  imageUrls: ["https://example.com/a.png"],
  inputMentions: [{ name: "Logo", type: "image", imgSrc: "https://example.com/l.png" }],
  isActive: true, reason: "新建示例",
};

describe("admin home content service", () => {
  it("refuses a non-platform-admin actor before reading or writing anything", async () => {
    const { overview, list, upsertDiscoveryCase, upsertExample, upsertCategory, setActive, reorderContent, reorderCategories, deleteContent, fake } =
      service({ isActorAdmin: false });
    const calls = [
      () => overview(ACTOR),
      () => list(ACTOR, { kind: "discovery_case" }),
      () => upsertDiscoveryCase(ACTOR, { ...caseInput }),
      () => upsertExample(ACTOR, { ...exampleInput }),
      () => upsertCategory(ACTOR, { kind: "discovery_category", key: "k", label: "L", dataType: null, accent: null, isActive: true, reason: "原因" }),
      () => setActive(ACTOR, { kind: "discovery_case", entityId: CASE_ID, isActive: false, reason: "下架" }),
      () => reorderContent(ACTOR, { kind: "discovery_case", categoryKey: "branding-design", orderedIds: [CASE_ID], reason: "排序" }),
      () => reorderCategories(ACTOR, { kind: "discovery_category", orderedKeys: ["branding-design"], reason: "排序" }),
      () => deleteContent(ACTOR, { kind: "discovery_case", entityId: CASE_ID, reason: "删除" }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "platform_admin_required", statusCode: 403 });
    }
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("returns the overview unchanged so the route can validate it", async () => {
    const overview = {
      discovery: { categories: [{ key: "branding-design" }], itemCount: 8, activeItemCount: 7 },
      example: { categories: [], itemCount: 36, activeItemCount: 36 },
    };
    const { overview: call } = service({ overview });
    await expect(call(ACTOR)).resolves.toEqual(overview);
  });

  it("passes filters through, turning blank selections into null and keeping false", async () => {
    const { list, fake } = service({});
    await list(ACTOR, { kind: "discovery_case", categoryKey: " branding-design ", active: false,
      query: "  标题  ", limit: 10, offset: 20 });
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_home_content_list",
      args: {
        p_actor_user_id: ACTOR, p_kind: "discovery_case", p_category_key: "branding-design",
        p_active: false, p_query: "标题", p_limit: 10, p_offset: 20,
      },
    });

    // A blank category or query means "no filter", never an empty-string match.
    await list(ACTOR, { kind: "example_example", categoryKey: "   ", query: "" });
    expect(fake.rpcCalls[1]!.args).toMatchObject({
      p_category_key: null, p_query: null, p_active: null, p_limit: 50, p_offset: 0,
    });
  });

  it("clamps the page size and keeps a malformed list payload visible", async () => {
    const { list, fake } = service({ list: { kind: "discovery_case", total: "nope", items: "nope" } });
    const result = await list(ACTOR, { kind: "discovery_case", limit: 10_000, offset: -4 });
    expect(fake.rpcCalls[0]!.args).toMatchObject({ p_limit: 200, p_offset: 0 });
    expect(result.total).toBe("nope");
    expect(result.items).toEqual([]);
  });

  it("creates a discovery case with every field and reports the real position", async () => {
    const { upsertDiscoveryCase, fake } = service({});
    await expect(upsertDiscoveryCase(ACTOR, { ...caseInput })).resolves.toEqual({
      id: "generated-id", created: true, sortOrder: 7,
    });
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_upsert_home_discovery_case",
      args: {
        p_actor_user_id: ACTOR, p_case_id: null, p_category_key: "branding-design", p_title: "标题",
        p_cover_image_url: "https://example.com/c.png", p_author_name: "作者", p_author_avatar_url: "",
        p_case_url: "", p_seed_prompt: "提示", p_is_active: true, p_reason: "新建案例",
      },
    });
  });

  it("creates an example with its images and mentions", async () => {
    const { upsertExample, fake } = service({ upsert: { id: EXAMPLE_ID, created: false, sortOrder: 2 } });
    await expect(upsertExample(ACTOR, { ...exampleInput })).resolves.toEqual({
      id: EXAMPLE_ID, created: false, sortOrder: 2,
    });
    expect(fake.rpcCalls[0]!.args).toMatchObject({
      p_example_id: null, p_image_urls: ["https://example.com/a.png"],
      p_input_mentions: [{ name: "Logo", type: "image", imgSrc: "https://example.com/l.png" }],
    });
  });

  it("returns the category key, kind and whether it was created", async () => {
    const { upsertCategory, fake } = service({});
    await expect(upsertCategory(ACTOR, {
      kind: "example_category", key: "branding", label: "Branding", dataType: "Branding",
      accent: "special", isActive: true, reason: "改分类",
    })).resolves.toEqual({ key: "branding", kind: "example_category", created: false, sortOrder: 3 });
    expect(fake.rpcCalls[0]!.args).toEqual({
      p_actor_user_id: ACTOR, p_kind: "example_category", p_key: "branding", p_label: "Branding",
      p_data_type: "Branding", p_accent: "special", p_is_active: true, p_reason: "改分类",
    });
  });

  it("reports how many entries a publish switch hides", async () => {
    const { setActive, fake } = service({});
    await expect(setActive(ACTOR, { kind: "discovery_category", entityId: "branding-design", isActive: false, reason: "下架分类" }))
      .resolves.toEqual({ hiddenItems: 4, wasActive: true });
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_set_home_content_active",
      args: { p_actor_user_id: ACTOR, p_kind: "discovery_category", p_entity_id: "branding-design",
        p_is_active: false, p_reason: "下架分类" },
    });
  });

  it("sends the whole ordered list for both reorder calls", async () => {
    const { reorderContent, reorderCategories, fake } = service({});
    await expect(reorderContent(ACTOR, { kind: "example_example", categoryKey: "branding",
      orderedIds: [EXAMPLE_ID, "44444444-4444-4444-8444-444444444444"], reason: "排序" }))
      .resolves.toEqual({ ordered: 5 });
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_reorder_home_content",
      args: { p_actor_user_id: ACTOR, p_kind: "example_example", p_category_key: "branding",
        p_ordered_ids: [EXAMPLE_ID, "44444444-4444-4444-8444-444444444444"], p_reason: "排序" },
    });

    await reorderCategories(ACTOR, { kind: "discovery_category", orderedKeys: ["a", "b"], reason: "排序" });
    expect(fake.rpcCalls[1]).toEqual({
      fn: "admin_reorder_home_categories",
      args: { p_actor_user_id: ACTOR, p_kind: "discovery_category", p_ordered_keys: ["a", "b"], p_reason: "排序" },
    });
  });

  it("deletes an entry through the audited function", async () => {
    const { deleteContent, fake } = service({});
    await expect(deleteContent(ACTOR, { kind: "discovery_case", entityId: CASE_ID, reason: "删除" })).resolves.toBeUndefined();
    expect(fake.rpcCalls[0]).toEqual({
      fn: "admin_delete_home_content",
      args: { p_actor_user_id: ACTOR, p_kind: "discovery_case", p_entity_id: CASE_ID, p_reason: "删除" },
    });
  });

  it("translates every refusal code instead of leaking the raw message", async () => {
    const cases: Array<[string, string, number]> = [
      ["FORBIDDEN: actor is not an active platform admin", "platform_admin_required", 403],
      ["REASON_REQUIRED: a reason is required", "admin_reason_required", 400],
      ["UNKNOWN_CATEGORY: no such discovery category", "admin_category_not_found", 404],
      ["UNKNOWN_CONTENT: no such example", "admin_content_not_found", 404],
      ["UNKNOWN_KIND: kind must be discovery_case", "admin_unknown_kind", 400],
      ["INVALID_ORDER: the ordered list contains duplicates", "admin_invalid_order", 400],
      ["UNSUPPORTED_TARGET: only discovery cases and examples can be deleted", "admin_unsupported_target", 400],
      ["INVALID_CONTENT: a title is required", "admin_invalid_content", 400],
      ["something unexpected", "admin_write_failed", 500],
    ];
    for (const [message, code, statusCode] of cases) {
      const { overview } = service({ rpcError: { message } });
      const error = await overview(ACTOR).catch(caught => caught);
      expect(error, message).toBeInstanceOf(AdminHomeContentError);
      expect(error, message).toMatchObject({ code, statusCode });
      expect(error.message, message).not.toContain(":");
    }
  });
});
