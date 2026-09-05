import { describe, expect, it, vi } from "vitest";

import { createDesignCatalogReadService } from "./design-catalog-read-service.js";

const user = { id: "user", accessToken: "token" };

function failedQuery(error: { code: string; message: string }) {
  const query: Record<string, unknown> = {};
  for (const method of [
    "select",
    "is",
    "order",
    "limit",
    "eq",
    "ilike",
    "or",
    "in",
  ])
    query[method] = vi.fn(() => query);
  // biome-ignore lint/suspicious/noThenProperty: Supabase builders are intentionally thenable
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: null, error }).then(resolve);
  return query;
}

describe("design catalog read service", () => {
  it("rejects a tampered cursor before querying", async () => {
    const from = vi.fn(() => failedQuery({ code: "x", message: "unused" }));
    const service = createDesignCatalogReadService({
      createUserClient: () => ({ from }) as never,
    });
    await expect(
      service.listFonts(user as never, { cursor: "tampered", limit: 30 }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(from).not.toHaveBeenCalled();
  });

  it("maps RLS denial without exposing database details", async () => {
    const from = vi.fn(() =>
      failedQuery({ code: "42501", message: "secret policy detail" }),
    );
    const service = createDesignCatalogReadService({
      createUserClient: () => ({ from }) as never,
    });
    await expect(
      service.listTextPresets(user as never, { limit: 30 }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Catalog access denied.",
    });
  });
});
