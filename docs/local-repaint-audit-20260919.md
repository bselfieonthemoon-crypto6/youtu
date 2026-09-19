# 局部重绘（local_repaint）逻辑审查（2026-09-19）

对象：画板工具栏的「局部重绘」链路 —— `canvas-tool-menu.tsx`（涂抹面板 / 提交 / 恢复）
→ `POST /api/jobs/image-generation`（`createJobWithReplay`）→ worker executor
（`prepareLocalRepaint` → 供应商 mask edit → `composeLocalRepaint`）→
`job-canvas-finalizer`（占位元素替换）→ 客户端轮询取回。

本次为**静态审查 + 单元/执行器级测试 + 一次真实付费端到端验收**（第 五 节）。

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

现在 `composeLocalRepaint` 先判定形状（容差 **2%**）：不一致则抛
`local_repaint_geometry_mismatch`，不合成、不重复付费，并在消息中给出两个尺寸与建议（换用输出尺寸
与图片比例匹配的模型）。供应商原始结果此前已归档，积分由 worker 自动退回。
该错误码与 `outpaint_geometry_mismatch` 一起加入 worker 的 `NON_RETRYABLE_CODES`（判定是确定性的，
归档字节永远相同，重试只会重复同样的拒绝）。

容差取 2% 是**实测结论**而不是拍脑袋：原生尺寸解析器 `resolveNativeImageSize` 本身就把请求比例吸附到
16px 网格、误差可达 1%，而下面第五节的真实调用中 900×1200 的图确实由 `gpt-image-2.5-flare` 返回
`880×1184`（误差 0.90%）。若把门限设成 1%，就等于把门限压在流水线自身的噪声上，可能为一次不可见的
差异把已付费结果判失败；而真正需要拒绝的错配（只按横竖方申请的 3:2、方形回答给宽幅图等）要大一个数量级。

### 2. 未确认的请求仍可编辑遮罩/描述（前端）

两种“请求已被服务端持有”的状态下，面板看起来仍可编辑，但点击时并不会提交用户看到的内容：

- `repaintSubmissionRef`（提交结果未确认）：再次点击会**原样重发**旧 payload，用户刚改的遮罩/描述被丢弃；
- `repaintJobRef`（结果未知的任务在追踪）：再次点击只会**查询原任务**，编辑同样无效。

现在这两种状态下面板只读（画布 `pointer-events-none`、描述框与画笔/撤销/重做/清空/快捷文案按钮全部禁用），
按钮文案区分为「重试原请求」/「查询原任务」，并给出对应说明（取消后再重新开始即可修改）。

## 三、已知的取舍与未做的验证

- **保留一处轻微冗余**：`handleConfirmErase` 在 `monitorCanvasGenerationJob`（内部已等待画布元素 30 次）
  之后又等 30 次，等价于把画布同步等待放宽到约 60s，属既有行为，未改。
- **明确失败后重试会再画一个占位框**：失败时占位元素被标记 `status: "error"`（有意作为画布反馈），
  下次重试在相同坐标新建占位框，两者重叠；又因为服务端以占位符 id 作重放键，重试必须换新 id，
  所以这是当前设计的必然外观，属观感问题而非逻辑错误。
- **不可达分支**：画布侧 `ImageEraseOverlay` 恒为 `repaint` 模式，`_mode` 参数与透明/智能擦除分支只在
  设计编辑器（`design-editor-session.tsx`）使用，未删除。

## 四、覆盖本次改动的测试

- `apps/server/src/features/images/local-repaint.test.ts`：形状不一致 → 拒绝；1% 与 2% 门限内的差异 → 正常合成且尺寸=源图；超过门限 → 拒绝。
- `apps/server/src/features/jobs/executors/image-generation-durable-recovery.test.ts`：
  同比例不同像素尺度的帧恢复源图尺寸；形状不一致的帧两次执行都拒绝且 `generateImage` 只被调用一次（有归档作栅栏）。
- `apps/server/src/worker.test.ts`：两个几何错误码立即 dead-letter（不重试）。
- `apps/web/src/components/canvas/image-eraser-overlay.test.tsx`（新增）：
  涂抹+描述可提交；`locked` 时画布与描述只读、按钮为回放文案；设计编辑器的透明/智能面板不受影响。

## 五、真实付费端到端验收（1 次图片调用）

脚本：`apps/server/scripts/accept-local-repaint.mjs`（预检免费；`--submit` 才付费；支持
`--audit-only=<jobId>` 免费复验；**脚本自身从不重试**）。

源图 `apps/web/public/images/showcase/showcase-3.jpg`（900×1200 拼贴画），模型取
`/api/image-models` 第一项 `gpt-image-2.5-flare`（即客户端无偏好时的默认选择）。涂抹区域
`0.13,0.71,0.32,0.18`（老照片上那只白色蝴蝶），指令「移除涂抹区域内的蝴蝶，并根据周围的老照片背景自然补全」。
任务 `0974d592-be19-4b50-9627-7085cfd98dd1`：

| 检查项 | 结果 |
| --- | --- |
| 付费调用 | **1 次**（attempt-0 存档 + `-source-before-matting.png` 归档齐全；无 fallback、无抠图、无语义分层存档） |
| 请求冻结 | `local_repaint`、`quality=standard`、未固定 resolution、1 张源图、PNG 遮罩、遮罩尺寸=源图、`aspect_ratio=900:1200` |
| 供应商帧 | `880×1184`，与源图比例误差 **0.90%**（= 原生尺寸解析器自身的吸附误差，未见网关额外偏离） |
| 合成尺寸 | 交付图 900×1200，与源图、`result.width/height` 一致 |
| 选区外 | 1 030 696 个 mask=0 像素**逐字节相同**，违规 0，alpha 改动 0 |
| 选区内 | 49 304 个可编辑像素中 49 148 个改变（99.7%）；改动包围盒 `x117 y852 288×216` 与涂抹包围盒**完全一致** |
| 画布 | 2 个元素：原图保留 + 交付图；交付图**就地替换占位矩形**（id 沿用 `repaint-placeholder-…`），位置尺寸 = 请求的 `(940,0,900,1200)` |
| 计费 | `credits_cost=0`、无扣费流水、无退款流水（本地副本 0 积分） |

视觉检查（`artifacts/real-image-acceptance/local-repaint-zoom-*.png`、`...-montage-*.png`）：
蝴蝶被完整移除，肩部/手臂与老照片纸张、色调、左右边界都被合理续接，涂抹椭圆边缘与保留像素之间没有硬接缝。

诚实的质量观察：
- 补全区域的皮肤纹理比周围略糊、亮度略平，凑近看有一条淡淡的竖向接缝感；
- 蝴蝶下方翼尖有一小截露在涂抹椭圆之外，因此按“未涂抹像素逐字节不变”的契约**被原样保留**——
  这是正确行为，也说明涂抹要完全覆盖目标物体；
- 该次调用产生的是 `880×1184 → 900×1200` 的 0.90% 各向异性重采样（不可见），也正是把门限从 1% 放宽到
  2% 的实测依据。

本次未做浏览器渲染验收（`browserVisualVerified=false`）：画布写入、元素替换与位置由数据库内容核对。

