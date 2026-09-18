# 原位画板外侧遮罩与画布平移

## 改动

原位编辑时，Fabric 为显示画板外溢出的对象扩展了 canvas 尺寸。遮罩本身虽然已有 `pointer-events: none`，其下面的 upper canvas、canvas-container 和绝对定位容器仍然占据命中区域，导致外层 Excalidraw 收不到拖动起始事件。

仅在可编辑的 inline overflow 模式下，让扩展容器和 lower canvas 不参与鼠标命中，将 upper canvas 的命中区域裁到画板内。下层绘制、遮罩和溢出预览继续显示；外部拖动直接由浏览器交给 Excalidraw，无合成事件转发，也不修改画板数据。

边界：不能在画板外开始选中溢出对象，需从板内或图层列表选择。板内开始的拖动可以继续到板外。全屏编辑器保持原有交互。

## 验证

- 旧版本真实浏览器复现：遮罩四边都命中 `upper-canvas`，拖动后画布位移为 0。
- `apps/web/scripts/verify-overflow-pan.mjs` 在独立 QA 项目验证四边拖动、板内对象拖动保存、拖出画板和鼠标中键平移；结果在 `artifacts/overflow-pan-20260915/verified.json`。
- Fabric surface 与 inline editor 两组测试共 19 项通过。补齐 surface 测试 mock 的 `calcOffset`，避免原有 mock 初始化报错。
- 生产构建输出 `.next-production-overflow-pan-final`，用于本地 3020。
- 全量 TypeScript 检查未通过：未修改的 `src/components/canvas/design-create-panel.test.tsx` 存在 `findByRole` 的 `exact` 参数和 mock.calls 可能为 undefined 共 4 条错误。

## 分工

Terra / gpt-5.6-terra，medium：只读检查事件路径及边界。主控：实现、浏览器复现、集成验证与本地运行版本更新。
