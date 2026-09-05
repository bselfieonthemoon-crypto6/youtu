import "@testing-library/jest-dom/vitest";

import type { DesignTemplateDetailDto } from "@loomic/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesignTemplateVariablesDialog } from "../src/components/settings/design-template-variables-dialog";

afterEach(cleanup);

describe("DesignTemplateVariablesDialog", () => {
  it("edits and saves text, image, color and font variables", () => {
    const onSave = vi.fn();
    render(
      <DesignTemplateVariablesDialog
        detail={detail()}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue("title")).toBeInTheDocument();
    expect(screen.getByDisplayValue("hero_image")).toBeInTheDocument();
    expect(screen.getByDisplayValue("brand_color")).toBeInTheDocument();
    expect(screen.getByDisplayValue("headline_font")).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("默认标题"), {
      target: { value: "新的默认标题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存变量" }));

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          default_value: "新的默认标题",
        }),
        expect.objectContaining({ type: "image" }),
        expect.objectContaining({ type: "color" }),
        expect.objectContaining({ type: "font" }),
      ]),
    );
  });
});

const objectIds = {
  text: "10000000-0000-4000-8000-000000000001",
  image: "10000000-0000-4000-8000-000000000002",
  shape: "10000000-0000-4000-8000-000000000003",
};

function detail() {
  return {
    template: {
      id: "20000000-0000-4000-8000-000000000001",
      name: "品牌模板",
      variables: [
        {
          key: "title",
          label: "标题",
          type: "text",
          required: true,
          target: { object_id: objectIds.text, property: "text" },
          default_value: "默认标题",
        },
        {
          key: "hero_image",
          label: "主图",
          type: "image",
          required: true,
          target: { object_id: objectIds.image, property: "asset_object_id" },
        },
        {
          key: "brand_color",
          label: "品牌色",
          type: "color",
          required: false,
          target: { object_id: objectIds.shape, property: "fill" },
          default_value: "#ff0000",
        },
        {
          key: "headline_font",
          label: "标题字体",
          type: "font",
          required: false,
          target: { object_id: objectIds.text, property: "font_face_id" },
        },
      ],
    },
    scene: {
      objects: [
        { objectId: objectIds.text, type: "text", name: "标题" },
        { objectId: objectIds.image, type: "image", name: "主图" },
        {
          objectId: objectIds.shape,
          type: "rect",
          name: "背景",
          fill: { kind: "solid", color: "#ffffff" },
        },
      ],
    },
  } as unknown as DesignTemplateDetailDto;
}
