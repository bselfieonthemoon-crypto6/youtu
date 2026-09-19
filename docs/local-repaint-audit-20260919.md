# 局部重绘（local_repaint）逻辑审查（2026-09-19）

对象：画板工具栏的「局部重绘」链路 —— `canvas-tool-menu.tsx`（涂抹面板 / 提交 / 恢复）
→ `POST /api/jobs/image-generation`（`createJobWithReplay`）→ worker executor
（`prepareLocalRepaint` → 供应商 mask edit → `composeLocalRepaint`）→
`job-canvas-finalizer`（占位元素替换）→ 客户端轮询取回。

本次为**静态审查 + 单元/执行器级测试**，没有触发付费调用。

## 一、审查结论（按链路）

| 环节 | 结论 |
| --- | --- |
| 像素空间 | 遮罩与源图尺寸恒等：`prepareCanvasImageOperation` 返回裁剪/翻转后的真实像素（`rendered.width/height`），涂抹面板按同一尺寸渲染遮罩；服务端再校验尺寸一致（`invalid_input`） |
| 遮罩语义 | 浏览器黑=保留 / 白=重绘 → 供应商 mask 透明=重绘（`255 - 灰度`），两侧语义一致 |
| 空遮罩 | 客户端 64×64 探针（`hasVisibleMask`）拒绝全空涂抹；服务端拒绝无 ≥8 像素的遮罩 |
| 旋转/翻转 | 翻转在导出时烘焙（`scale: [-1,1]`），旋转由覆盖层的逆变换处理，遮罩不偏移 |
| 尺寸比例 | 执行器用真实源图比例覆盖客户端 `aspect_ratio`；合成后尺寸恒等于源图 |
| 付费边界 | `claim → 调用 → saveReturned → 下载 → archive(source-before-matting)`：重试复用归档字节，**不会二次付费**；客户端 `repaintSubmissionRef` 复现同一请求，服务端按 `target.element_id` 重放去重（同占位符不同入参 → 409） |
| 失败结算 | 明确失败 → `dead_letter` + 自动退积分；未知结果 → `image_generation_result_unknown`，不自动重试、不重复扣费 |
| 上下文 | 遮罩=0 的像素逐字节复制源图，alpha 不动；透明源保持 alpha，不透明源不引入透明 |

## 二、本次修复的两处逻辑问题

### 1. 供应商返回不同形状的帧会被静默拉伸（服务端）

`composeLocalRepaint` 原来无条件 `resize(w, h, { fit: "fill" })`。当供应商返回的帧比例与源图不一致
（非原生尺寸模型只按“横/竖/方”三档申请尺寸，例如 4:3 源图按 3:2 出图，或网关忽略 `size`），
涂抹区域会被各向异性拉伸，而选区外的源像素依旧逐字节保留 —— 用户看到的是“只在选区内悄悄变形”。

这与仓库自身的既有约定冲突：`assertImageAspectRatio`（“Reject provider output that would have to be
stretched, cropped or padded”）与 `composeOutpaint`（“已停止合成，避免拉伸和接缝”）都拒绝拉伸。

现在 `composeLocalRepaint` 先判定形状（容差 1%，与上述两处一致）：不一致则抛
`local_repaint_geometry_mismatch`，不合成、不重复付费，并在消息中给出两个尺寸与建议（换用输出尺寸
与图片比例匹配的模型）。供应商原始结果此前已归档，积分由 worker 自动退回。
该错误码与 `outpaint_geometry_mismatch` 一起加入 worker 的 `NON_RETRYABLE_CODES`（判定是确定性的，
归档字节永远相同，重试只会重复同样的拒绝）。

### 2. 未确认的请求仍可编辑遮罩/描述（前端）

两种“请求已被服务端持有”的状态下，面板看起来仍可编辑，但点击时并不会提交用户看到的内容：

- `repaintSubmissionRef`（提交结果未确认）：再次点击会**原样重发**旧 payload，用户刚改的遮罩/描述被丢弃；
- `repaintJobRef`（结果未知的任务在追踪）：再次点击只会**查询原任务**，编辑同样无效。

现在这两种状态下面板只读（画布 `pointer-events-none`、描述框与画笔/撤销/重做/清空/快捷文案按钮全部禁用），
按钮文案区分为「重试原请求」/「查询原任务」，并给出对应说明（取消后再重新开始即可修改）。

## 三、已知的取舍与未做的验证

- **未做真实付费验收**：本次没有调用供应商，因此“同比例帧在真实模型下确实返回同尺寸”仍依赖既有假设
  （原生尺寸模型由 `resolveNativeImageSize` 保证 ≤1% 误差）。若要用真图复验，需要一次付费局部重绘。
- **保留一处轻微冗余**：`handleConfirmErase` 在 `monitorCanvasGenerationJob`（内部已等待画布元素 30 次）
  之后又等 30 次，等价于把画布同步等待放宽到约 60s，属既有行为，未改。
- **明确失败后重试会再画一个占位框**：失败时占位元素被标记 `status: "error"`（有意作为画布反馈），
  下次重试在相同坐标新建占位框，两者重叠；又因为服务端以占位符 id 作重放键，重试必须换新 id，
  所以这是当前设计的必然外观，属观感问题而非逻辑错误。
- **不可达分支**：画布侧 `ImageEraseOverlay` 恒为 `repaint` 模式，`_mode` 参数与透明/智能擦除分支只在
  设计编辑器（`design-editor-session.tsx`）使用，未删除。

## 四、覆盖本次改动的测试

- `apps/server/src/features/images/local-repaint.test.ts`：形状不一致 → 拒绝；1% 内 → 正常合成且尺寸=源图。
- `apps/server/src/features/jobs/executors/image-generation-durable-recovery.test.ts`：
  同比例不同像素尺度的帧恢复源图尺寸；形状不一致的帧两次执行都拒绝且 `generateImage` 只被调用一次（有归档作栅栏）。
- `apps/server/src/worker.test.ts`：两个几何错误码立即 dead-letter（不重试）。
- `apps/web/src/components/canvas/image-eraser-overlay.test.tsx`（新增）：
  涂抹+描述可提交；`locked` 时画布与描述只读、按钮为回放文案；设计编辑器的透明/智能面板不受影响。
