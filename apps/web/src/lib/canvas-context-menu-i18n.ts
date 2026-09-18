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
  // Use the browser top layer, so canvas previews and portal toolbars cannot
  // cover the menu. Keep its DOM parent and native Excalidraw event handlers.
  for (const menu of root.querySelectorAll<HTMLElement>(".popover:has(> .context-menu)")) {
    if (menu.isConnected && typeof menu.showPopover === "function" && !menu.hasAttribute("popover")) {
      const rect = menu.getBoundingClientRect();
      menu.setAttribute("popover", "manual");
      Object.assign(menu.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, right: "auto", bottom: "auto", margin: "0" });
      menu.showPopover();
    }
  }
  const labels = root.querySelectorAll<HTMLElement>(
    ".context-menu-item__label",
  );
  for (const label of labels) {
    const translated = EXCALIDRAW_CONTEXT_MENU_ZH_CN[label.textContent?.trim() ?? ""];
    if (translated) label.textContent = translated;
  }
}
