const EXCALIDRAW_CONTEXT_MENU_ZH_CN: Readonly<Record<string, string>> = {
  "Canvas & Shape properties": "画布与图形属性",
  "Copy link to object": "复制对象链接",
  "Crop image": "裁剪图片",
  "Toggle grid": "切换网格",
  "Wrap selection in frame": "用画框包住所选内容",
};

/**
 * Fill the small set of context-menu translation gaps left by Excalidraw's
 * bundled zh-CN locale. The menu actions remain Excalidraw-native; only their
 * visible and accessible labels are replaced.
 */
export function localizeExcalidrawContextMenus(root: ParentNode): void {
  const labels = root.querySelectorAll<HTMLElement>(
    ".context-menu-item__label",
  );
  for (const label of labels) {
    const translated = EXCALIDRAW_CONTEXT_MENU_ZH_CN[label.textContent?.trim() ?? ""];
    if (translated) label.textContent = translated;
  }
}
