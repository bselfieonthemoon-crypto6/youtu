// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/design-resource-api", () => ({
  createDesignResourceApiClient: () => ({
    listTemplates: vi.fn(async () => ({
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          scope: "platform",
          workspace_id: null,
          name: "社交媒体模板",
          description: null,
          width: 1200,
          height: 628,
          schema_version: 1,
          engine_version: "fabric@7.4.0",
          status: "published",
          preview_asset_object_id: null,
          category_id: null,
          tag_ids: [],
          source_url: null,
          author: null,
          license_name: null,
          license_url: null,
          attribution: null,
          usage_restrictions: null,
          deleted_at: null,
          created_at: "2026-09-04T00:00:00.000Z",
          updated_at: "2026-09-04T00:00:00.000Z",
        },
      ],
      next_cursor: null,
    })),
  }),
}));

import {
  type BlankDesignInput,
  DesignCreatePanel,
} from "../src/components/canvas/design-create-panel";

afterEach(cleanup);

describe("DesignCreatePanel templates", () => {
  it("only opens a template entry after the real catalog returns rows", async () => {
    const onCreate = vi.fn(async (_input: BlankDesignInput) => undefined);
    render(
      <DesignCreatePanel
        accessToken="token"
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "模板" }));
    await userEvent.click(screen.getByRole("button", { name: /社交媒体模板/ }));
    await userEvent.click(screen.getByRole("button", { name: "使用模板创建" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      templateId: "11111111-1111-4111-8111-111111111111",
      width: 1200,
      height: 628,
    });
  });
});
