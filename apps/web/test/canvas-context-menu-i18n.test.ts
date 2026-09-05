import { describe, expect, it } from "vitest";

import { localizeExcalidrawContextMenus } from "../src/lib/canvas-context-menu-i18n";

describe("localizeExcalidrawContextMenus", () => {
  it("fills translation gaps without changing already-localized labels", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="context-menu-item__label">Wrap selection in frame</div>
      <div class="context-menu-item__label">Crop image</div>
      <div class="context-menu-item__label">Copy link to object</div>
      <div class="context-menu-item__label">Toggle grid</div>
      <div class="context-menu-item__label">Canvas &amp; Shape properties</div>
      <div class="context-menu-item__label">删除</div>
    `;

    localizeExcalidrawContextMenus(root);

    expect(
      Array.from(root.querySelectorAll(".context-menu-item__label"), (label) =>
        label.textContent?.trim(),
      ),
    ).toEqual([
      "用画框包住所选内容",
      "裁剪图片",
      "复制对象链接",
      "切换网格",
      "画布与图形属性",
      "删除",
    ]);
  });
});
