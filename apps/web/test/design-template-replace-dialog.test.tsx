import "@testing-library/jest-dom/vitest";

import type {
  DesignTemplateDetailDto,
  DesignTemplateReplacePreviewRequest,
} from "@loomic/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesignTemplateReplaceDialog } from "../src/components/design/design-template-replace-dialog";

afterEach(cleanup);

describe("DesignTemplateReplaceDialog", () => {
  it("shows smart diff and blocks apply while required values are unresolved", () => {
    const onBindingsChange = vi.fn();
    const onApply = vi.fn();
    render(
      <DesignTemplateReplaceDialog
        detail={detail()}
        bindings={[]}
        preview={{
          design_id: ids.design,
          template_id: ids.template,
          design_revision: 2,
          template_revision: 3,
          commands: [],
          differences: [],
          unresolved_keys: ["title"],
        }}
        onBindingsChange={onBindingsChange}
        onPreview={vi.fn()}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("缺少必填变量：title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认应用替换" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "标题文本" }), {
      target: { value: "秋季上新" },
    });
    expect(onBindingsChange).toHaveBeenCalledWith([
      { key: "title", type: "text", value: "秋季上新" },
    ]);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("labels smart matches and requires an explicit apply click", () => {
    const onApply = vi.fn();
    render(
      <DesignTemplateReplaceDialog
        detail={detail()}
        bindings={[]}
        preview={{
          design_id: ids.design,
          template_id: ids.template,
          design_revision: 2,
          template_revision: 3,
          commands: [
            {
              action: "object.update",
              object_id: ids.object,
              expected_object_version: 1,
              patch: { object_type: "text", text: "秋季上新" },
            },
          ],
          differences: [
            {
              variable_key: "title",
              type: "text",
              object_id: ids.object,
              property: "text",
              source: "smart",
              before: "旧标题",
              after: "秋季上新",
            },
          ],
          unresolved_keys: [],
        }}
        onBindingsChange={vi.fn()}
        onPreview={vi.fn()}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("智能匹配")).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认应用替换" }));
    expect(onApply).toHaveBeenCalledOnce();
  });
});

const ids = {
  template: "10000000-0000-4000-8000-000000000001",
  design: "20000000-0000-4000-8000-000000000001",
  object: "30000000-0000-4000-8000-000000000001",
  workspace: "40000000-0000-4000-8000-000000000001",
} as const;

function detail(): DesignTemplateDetailDto {
  return {
    template: {
      id: ids.template,
      scope: "workspace",
      workspace_id: ids.workspace,
      name: "活动模板",
      description: null,
      width: 1080,
      height: 1080,
      schema_version: 1,
      engine_version: "fabric@7.4.0",
      revision: 3,
      status: "published",
      preview_asset_object_id: null,
      category_id: null,
      tag_ids: [],
      variables: [
        {
          key: "title",
          label: "标题",
          type: "text",
          required: true,
          target: { object_id: ids.object, property: "text" },
        },
      ],
      source_url: null,
      author: null,
      license_name: "自有版权",
      license_url: null,
      attribution: null,
      usage_restrictions: "工作区内使用",
      deleted_at: null,
      created_at: "2026-09-07T00:00:00.000Z",
      updated_at: "2026-09-07T00:00:00.000Z",
    },
    scene: {
      schemaVersion: 1,
      engine: "fabric",
      canvas: { width: 1080, height: 1080, background: "#ffffff" },
      objects: [textObject()],
    },
    asset_refs: [],
    font_face_ids: [],
  };
}

function textObject() {
  return {
    objectId: ids.object,
    objectVersion: 1,
    type: "text" as const,
    name: "标题",
    role: "title" as const,
    x: 20,
    y: 30,
    width: 320,
    height: 80,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    zIndex: 0,
    text: "旧标题",
    fontFamily: "Arial",
    fontSize: 48,
    fontWeight: 700,
    fontStyle: "normal" as const,
    textAlign: "left" as const,
    lineHeight: 1.2,
    charSpacing: 0,
    fill: { kind: "solid" as const, color: "#111111" },
  };
}
