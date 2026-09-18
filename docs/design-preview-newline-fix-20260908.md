# 画板自动预览失败：回车符被误判为缺字

## 实际根因

设计 `4e9585ba-2f23-41d6-86aa-4fe01436511d` 的内容为 revision 87，预览停在 revision 69，preview_status=error。

逐字检查实际绑定字体 `HappyZcool-2016`（face `9d816ae7-559e-44b1-b487-a106bd2b1157`）发现：可见文字均有字形，缺字检测命中的是换行控制字符。电话、地址和英文标题的文本末尾含独立 `\r\r`。原有分行只匹配 `\r?\n`，没有识别独立 CR；控制字符被送入 fontkit，返回 glyph 0，触发 design_font_glyph_missing，导致整张预览失败。

## 修复范围

- 统一处理 CRLF、CR、LF、Unicode 行/段分隔符，保留空行，不修改存储文本或字体绑定。
- 绑定字体描边渲染与普通文字预览/导出均使用同一分行规则。
- 真正的可见字符缺字仍报错，不暗中换字体；诊断信息补充 Unicode 码点、文字对象 ID 和字体 ID。
- 未改变自动保存机制、图层、布局和用户内容，也没有隐藏过期预览提示。

## 验证与恢复

- 原文档修复前能够复现错误；修复后使用原始场景和原字体成功渲染 WebP 预览及 PNG 导出。
- 字体和预览渲染 24 项测试通过，涵盖换行变体、空行、真实缺字仍报错、原始场景不变。
- 服务端 TypeScript 检查通过。
- 更新本地 worker 后，通过正常、带用户权限的预览接口重新生成 revision 87。任务 `c1bdc04c-2096-437f-8289-ff62a79977d1` 成功，preview_revision=87、preview_status=ready，scene 和 revision 均未修改。
- Chromium 真实测试 `design-autosave-preview-local.spec.ts` 通过（12.2 秒）：独立测试画板包含同一字体及 CR 文本；编辑后不点击保存/完成，先确认自动保存和后台预览均成功、版本一致，再退出检查外部图片变化，刷新后仍一致。字体绑定保持不变。

恢复脚本 `apps/server/scripts/repair-local-design-preview.ts` 限定本地副本，只请求重新生成预览，不修改文档内容。
