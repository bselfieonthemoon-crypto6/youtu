import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const resourceId = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-09-04T00:00:00.000Z";
const resource = {
  id: resourceId,
  scope: "workspace",
  workspace_id: workspaceId,
  kind: "image",
  name: "封面素材",
  description: null,
  asset_object_id: "33333333-3333-4333-8333-333333333333",
  preview_asset_object_id: null,
  width: 800,
  height: 600,
  checksum_sha256: "a".repeat(64),
  revision: 1,
  status: "draft",
  category_id: null,
  tag_ids: [],
  source_url: null,
  author: null,
  license_name: null,
  license_url: null,
  attribution: null,
  usage_restrictions: null,
  deleted_at: null,
  created_at: timestamp,
  updated_at: timestamp,
} as const;

const api = vi.hoisted(() => ({
  listAdminResources: vi.fn(),
  listAdminTemplates: vi.fn(),
  listAdminTextPresets: vi.fn(),
  listAdminFontFamilies: vi.fn(),
  listAdminFontFaces: vi.fn(),
  listAdminCategories: vi.fn(),
  listAdminTags: vi.fn(),
  uploadAdminFontFile: vi.fn(),
  listImports: vi.fn(),
  createAdminResource: vi.fn(),
  createAdminTemplateFromDesign: vi.fn(),
  createAdminCatalogEntry: vi.fn(),
  updateAdminCatalogEntry: vi.fn(),
  setAdminCatalogStatus: vi.fn(),
  setAdminCatalogDeleted: vi.fn(),
  getAdminReferences: vi.fn(),
  getAdminCatalogPreviewUrl: vi.fn(),
  createImport: vi.fn(),
  createImportPackage: vi.fn(),
  createDirectoryImport: vi.fn(),
  getImport: vi.fn(),
  updateImport: vi.fn(),
}));
const uploadFile = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/design-resource-api", () => ({
  createDesignResourceApiClient: () => api,
}));
vi.mock("../src/lib/server-api", () => ({ uploadFile }));

import { DesignResourceAdminSection } from "../src/components/settings/design-resource-admin-section";

describe("DesignResourceAdminSection", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    const empty = { items: [], next_cursor: null };
    api.listAdminResources.mockImplementation(
      async (_token: string, request: { deleted?: string }) => ({
        items:
          request.deleted === "true"
            ? [{ ...resource, deleted_at: timestamp }]
            : [resource],
        next_cursor: null,
      }),
    );
    api.listAdminTemplates.mockResolvedValue(empty);
    api.listAdminTextPresets.mockResolvedValue(empty);
    api.listAdminFontFamilies.mockResolvedValue(empty);
    api.listAdminFontFaces.mockResolvedValue(empty);
    api.listAdminCategories.mockResolvedValue(empty);
    api.listAdminTags.mockResolvedValue(empty);
    api.listImports.mockResolvedValue(empty);
    api.createAdminResource.mockResolvedValue(resource);
    api.setAdminCatalogStatus.mockResolvedValue({
      entity_kind: "resource",
      entity_id: resourceId,
      revision: 2,
      status: "pending_review",
      replayed: false,
    });
    api.setAdminCatalogDeleted.mockResolvedValue({
      entity_kind: "resource",
      entity_id: resourceId,
      revision: 2,
      status: "draft",
      replayed: false,
    });
    api.getAdminReferences.mockResolvedValue({
      resource_id: resourceId,
      design_references: [],
    });
    api.getAdminCatalogPreviewUrl.mockResolvedValue({
      url: "https://signed.example/thumb",
      uses_preview: true,
    });
    api.createImport.mockResolvedValue({
      import_job_id: "44444444-4444-4444-8444-444444444444",
      status: "queued",
      replayed: false,
    });
    api.createImportPackage.mockResolvedValue({
      import_job_id: "44444444-4444-4444-8444-444444444444",
      status: "queued",
      replayed: false,
    });
    api.createDirectoryImport.mockResolvedValue({
      import_job_id: "44444444-4444-4444-8444-444444444444",
      status: "queued",
      replayed: false,
    });
    uploadFile.mockResolvedValue({
      asset: { id: "55555555-5555-4555-8555-555555555555" },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("shows a signed thumbnail per row and a placeholder when signing fails", async () => {
    api.listAdminResources.mockResolvedValue({
      items: [
        resource,
        { ...resource, id: "99999999-9999-4999-8999-999999999999", name: "无缩略图素材" },
      ],
      next_cursor: null,
    });
    api.getAdminCatalogPreviewUrl.mockImplementation(
      async (_token: string, _collection: string, id: string) =>
        id === resourceId
          ? { url: "https://signed.example/thumb", uses_preview: true }
          : { url: null, uses_preview: false },
    );
    render(
      <DesignResourceAdminSection
        accessToken="token"
        workspaceId={workspaceId}
      />,
    );
    await screen.findByText("封面素材");

    const thumbnails = await screen.findAllByTestId("catalog-preview");
    expect(thumbnails).toHaveLength(1);
    expect(thumbnails[0]).toHaveAttribute("src", "https://signed.example/thumb");
    // The row whose signature failed shows a dash rather than a broken image.
    expect(screen.getAllByTestId("catalog-preview-placeholder")).toHaveLength(1);
    expect(api.getAdminCatalogPreviewUrl).toHaveBeenCalledWith(
      "token",
      "resources",
      resourceId,
    );
  });

  it("applies a batch status change row by row and reports the outcome", async () => {
    api.listAdminResources.mockResolvedValue({
      items: [
        resource,
        { ...resource, id: "99999999-9999-4999-8999-999999999999", name: "第二张" },
      ],
      next_cursor: null,
    });
    api.setAdminCatalogStatus.mockImplementation(
      async (_token: string, input: { entity_id: string }) => {
        if (input.entity_id !== resourceId) throw new Error("revision conflict");
        return {
          entity_kind: "resource",
          entity_id: input.entity_id,
          revision: 2,
          status: "published",
          replayed: false,
        };
      },
    );
    render(
      <DesignResourceAdminSection
        accessToken="token"
        workspaceId={workspaceId}
      />,
    );
    await screen.findByText("封面素材");

    // The select-all box appears once the page's thumbnails have been fetched.
    fireEvent.click(await screen.findByLabelText("全选"));
    fireEvent.click(screen.getByRole("button", { name: "批量上架" }));

    await waitFor(() =>
      expect(api.setAdminCatalogStatus).toHaveBeenCalledTimes(2),
    );
    expect(api.setAdminCatalogStatus).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        entity_kind: "resource",
        entity_id: resourceId,
        expected_revision: 1,
        status: "published",
      }),
    );
    // One failure does not stop the other row, and the summary says so.
    expect(await screen.findByText(/成功 1 条，失败 1 条/)).toBeInTheDocument();
  });

  it("keeps bulk controls off the collections that have no thumbnail", async () => {
    render(
      <DesignResourceAdminSection
        accessToken="token"
        workspaceId={workspaceId}
      />,
    );
    await screen.findByText("封面素材");
    expect(screen.getByRole("button", { name: "批量上架" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "标签" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "批量上架" })).toBeNull(),
    );
    expect(api.getAdminCatalogPreviewUrl).toHaveBeenCalledTimes(1);
  });

  it("uploads a real resource record and runs the review/delete/restore/reference APIs", async () => {
    render(
      <DesignResourceAdminSection
        accessToken="token"
        workspaceId={workspaceId}
      />,
    );
    await screen.findByText("封面素材");

    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "新素材" },
    });
    fireEvent.change(screen.getByLabelText("素材文件（同时作为预览）"), {
      target: {
        files: [new File(["pixels"], "poster.png", { type: "image/png" })],
      },
    });
    fireEvent.change(screen.getByLabelText("授权/许可证名称 *"), {
      target: { value: "自有版权" },
    });
    fireEvent.change(screen.getByLabelText("使用限制"), {
      target: { value: "仅限本工作区使用" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建草稿" }));
    await waitFor(() => expect(api.createAdminResource).toHaveBeenCalled());
    expect(api.createAdminResource).toHaveBeenCalledWith(
      "token",
      expect.objectContaining({
        asset_object_id: "55555555-5555-4555-8555-555555555555",
        preview_asset_object_id: "55555555-5555-4555-8555-555555555555",
        license_name: "自有版权",
        usage_restrictions: "仅限本工作区使用",
      }),
    );
    expect(uploadFile).toHaveBeenCalledWith(
      "token",
      expect.any(File),
      workspaceId,
    );

    fireEvent.click(screen.getByRole("button", { name: "送审" }));
    await waitFor(() =>
      expect(api.setAdminCatalogStatus).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({
          entity_kind: "resource",
          entity_id: resourceId,
          status: "pending_review",
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "查看引用" }));
    await screen.findByText(/design_references/);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(api.setAdminCatalogDeleted).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("删除状态"), {
      target: { value: "true" },
    });
    await waitFor(() =>
      expect(api.listAdminResources).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({ deleted: "true" }),
        expect.any(AbortSignal),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "恢复" }));
    await waitFor(() =>
      expect(api.setAdminCatalogDeleted).toHaveBeenLastCalledWith(
        "token",
        expect.objectContaining({ entity_id: resourceId }),
        false,
      ),
    );
  });

  it("uploads a ZIP/JSON package directly through the multipart import API", async () => {
    render(
      <DesignResourceAdminSection
        accessToken="token"
        workspaceId={workspaceId}
      />,
    );
    await screen.findByText("封面素材");
    fireEvent.click(screen.getByRole("button", { name: "批量导入" }));
    const manifestFile = new File(["{}"], "manifest.json", {
      type: "application/json",
    });
    fireEvent.change(screen.getByLabelText("ZIP/JSON 清单包"), {
      target: { files: [manifestFile] },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建导入任务" }));

    await waitFor(() =>
      expect(api.createImportPackage).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({
          workspace_id: workspaceId,
          file: manifestFile,
        }),
      ),
    );
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("submits mixed metadata through the inline manifest contract", async () => {
    render(
      <DesignResourceAdminSection
        accessToken="token"
        workspaceId={workspaceId}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "批量导入" }));
    fireEvent.change(screen.getByLabelText("导入来源"), {
      target: { value: "inline" },
    });
    const manifest = {
      version: 1,
      items: [
        {
          source_key: "categories/brand",
          entity_kind: "category",
          payload: { name: "品牌", slug: "brand" },
        },
        {
          source_key: "tags/gold",
          entity_kind: "tag",
          payload: { name: "金色", slug: "gold" },
        },
        {
          source_key: "resources/logo",
          entity_kind: "resource",
          source_url: "https://example.com/logo.png",
          depends_on: ["categories/brand", "tags/gold"],
          payload: {
            name: "Logo",
            category_path: "categories/brand",
            tag_paths: ["tags/gold"],
          },
        },
      ],
    };
    fireEvent.change(screen.getByLabelText("Manifest JSON"), {
      target: { value: JSON.stringify(manifest) },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建导入任务" }));

    await waitFor(() =>
      expect(api.createImport).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({
          source_kind: "manifest_inline",
          workspace_id: workspaceId,
          manifest,
        }),
      ),
    );
  });

  it("shows directory availability and submits the configured server path", async () => {
    const { unmount } = render(
      <DesignResourceAdminSection
        accessToken="token"
        workspaceId={workspaceId}
      />,
    );
    await screen.findByText("封面素材");
    fireEvent.click(screen.getByRole("button", { name: "批量导入" }));
    expect(screen.getByText(/服务器目录导入未启用/)).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "服务器目录（未启用）" }),
    ).toBeDisabled();
    unmount();
    render(
      <DesignResourceAdminSection
        accessToken="token"
        workspaceId={workspaceId}
        directoryImportEnabled
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "批量导入" }));
    fireEvent.change(screen.getByLabelText("导入来源"), {
      target: { value: "directory" },
    });
    fireEvent.change(screen.getByLabelText("服务器目录路径"), {
      target: { value: "campaigns/autumn" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建导入任务" }));

    await waitFor(() =>
      expect(api.createDirectoryImport).toHaveBeenCalledWith(
        "token",
        expect.objectContaining({
          source_kind: "server_directory",
          workspace_id: workspaceId,
          directory_path: "campaigns/autumn",
        }),
      ),
    );
  });
});
