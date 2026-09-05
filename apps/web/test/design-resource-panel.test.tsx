// @vitest-environment jsdom

import type { DesignResourceDto } from "@loomic/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listResources: vi.fn(),
  getResourcePreview: vi.fn(),
  getResourceContent: vi.fn(),
  setFavorite: vi.fn(),
  recordRecentUse: vi.fn(),
}));

vi.mock("../src/lib/design-resource-api", () => ({
  createDesignResourceApiClient: () => ({
    ...mocks,
    listTemplates: vi.fn(),
    listTextPresets: vi.fn(),
    listFonts: vi.fn(),
  }),
}));

import { DesignResourcePanel } from "../src/components/design/design-resource-panel";

const resource = {
  id: "11111111-1111-4111-8111-111111111111",
  scope: "platform" as const,
  workspace_id: null,
  kind: "image" as const,
  name: "封面素材",
  description: null,
  asset_object_id: "22222222-2222-4222-8222-222222222222",
  preview_asset_object_id: null,
  width: 800,
  height: 600,
  checksum_sha256: null,
  revision: 1,
  status: "published" as const,
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
};

beforeEach(() => {
  mocks.listResources.mockResolvedValue({
    items: [resource],
    next_cursor: null,
  });
  mocks.getResourcePreview.mockResolvedValue(new Blob(["preview"]));
  mocks.getResourceContent.mockResolvedValue(new Blob(["content"]));
  mocks.setFavorite.mockResolvedValue(true);
  mocks.recordRecentUse.mockResolvedValue({
    used_at: "2026-09-04T00:00:00.000Z",
    use_count: 1,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DesignResourcePanel", () => {
  it("loads authorized previews lazily, inserts durable resources and revokes Blob URLs", async () => {
    const createObjectURL = vi.fn(() => "blob:resource-preview");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    const onInsertResource = vi.fn(
      async (_resource: DesignResourceDto, _source: Blob) => undefined,
    );
    const view = render(
      <DesignResourcePanel
        accessToken="token"
        workspaceId="33333333-3333-4333-8333-333333333333"
        onInsertResource={onInsertResource}
      />,
    );

    const card = await screen.findByRole("button", {
      name: /^封面素材\s*平台$/,
    });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    await userEvent.click(card);
    await waitFor(() => expect(onInsertResource).toHaveBeenCalledOnce());
    expect(onInsertResource.mock.calls[0]?.[0]).toMatchObject({
      id: resource.id,
      asset_object_id: resource.asset_object_id,
    });
    expect(mocks.recordRecentUse).toHaveBeenCalledWith(
      "token",
      resource.id,
      "33333333-3333-4333-8333-333333333333",
    );

    await userEvent.click(
      screen.getByRole("button", { name: `收藏 ${resource.name}` }),
    );
    await waitFor(() => expect(mocks.setFavorite).toHaveBeenCalled());

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:resource-preview");
  });
});
