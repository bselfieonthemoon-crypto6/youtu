import { describe, expect, it } from "vitest";
import { resolveImageEditRouting } from "./image-edit-routing.js";

const source = { assetId: "logo", width: 1200, height: 1200 };
const canvas = { elements: [{ id: "el", type: "image", customData: { assetId: "logo" }, x: 10, y: 20, width: 300, height: 300 }] };
describe("current attachment edit routing", () => {
  it("honors an explicit image target independently of wording without overriding resize intent", () => {
    expect(resolveImageEditRouting({ prompt: "这里比画板里的暗一些", explicitSourceAssetId: "logo", attachments: [source], canvas })?.assetId).toBe("logo");
    expect(resolveImageEditRouting({ prompt: "输出9:16", explicitSourceAssetId: "logo", attachments: [source], canvas })?.aspectRatio).toBe("1:1");
    expect(resolveImageEditRouting({ prompt: "更亮一些", explicitSourceAssetId: "other", attachments: [source], canvas })).toBeUndefined();
  });
  it.each(["黑色背景改为绿色", "背景改为绿色", "把背景去掉", "修改这张图，不要改画板"])("binds current image instead of historical board: %s", (prompt) => {
    expect(resolveImageEditRouting({ prompt, explicitSourceAssetId: "logo", attachments: [source], canvas })).toEqual({
      assetId: "logo", aspectRatio: "1:1",
      placement: { placementX: 350, placementY: 20, placementWidth: 300, placementHeight: 300 },
    });
  });
  it.each(["把这张图片放进画板，替换背景", "修改画板背景", "参考这个Logo设计一张海报", "确认生成", "再来一张"])("does not override intentional design/reference/confirmation: %s", (prompt) => {
    expect(resolveImageEditRouting({ prompt, attachments: [source], canvas })).toBeUndefined();
  });
  it("does not treat an attached board preview as a standalone image", () => {
    expect(resolveImageEditRouting({ prompt: "改成绿色", explicitSourceAssetId: "logo", attachments: [source], canvas: { elements: [{ ...canvas.elements[0], customData: { assetId: "logo", kind: "loomic-design" } }] } })).toBeUndefined();
  });
  it("does not force a guessed source for multiple or absent attachments", () => {
    for (const attachments of [[], [source, { ...source, assetId: "other" }]]) expect(resolveImageEditRouting({ prompt: "改为绿色", attachments })).toBeUndefined();
  });
  it("preserves non-square original dimensions, but allows explicit resizing", () => {
    expect(resolveImageEditRouting({ prompt: "背景改成红色，保持原图比例", explicitSourceAssetId: "logo", attachments: [{ ...source, width: 1536, height: 1024 }] })?.aspectRatio).toBe("3:2");
    expect(resolveImageEditRouting({ prompt: "背景改绿，比例不变", explicitSourceAssetId: "logo", attachments: [{ ...source, width: 1536, height: 1024 }] })?.aspectRatio).toBe("3:2");
    expect(resolveImageEditRouting({ prompt: "keep original aspect ratio", explicitSourceAssetId: "logo", attachments: [{ ...source, width: 1536, height: 1024 }] })?.aspectRatio).toBe("3:2");
    // Routing exposes the source fact even for resize requests. The reviewed
    // generate_image aspectRatio wins when the user actually requests resize.
    expect(resolveImageEditRouting({ prompt: "改为9:16竖版", explicitSourceAssetId: "logo", attachments: [source] })?.aspectRatio).toBe("1:1");
  });
  it.each(["这张图背景改成绿色会更好吗？", "高级一点", "背景改绿色", "为什么换成这个颜色？"])("never turns words into enforced scope: %s", prompt => {
    expect(resolveImageEditRouting({ prompt, attachments: [source], canvas })).toBeUndefined();
  });
  it("keeps the validated source when other references are present", () => {
    expect(resolveImageEditRouting({ prompt: "参考另一张图的光线", explicitSourceAssetId: "logo", attachments: [{ assetId: "lighting-reference" }, source], canvas })?.assetId).toBe("logo");
  });
});
