# 对话只留文字与图片：过程步骤折叠（2026-09-19）

需求（产品负责人）：对话里只保留**文字对话**和**生成的图片**，把分析过程、工具调用等折叠起来。
截图里的「图片任务已提交或正在处理…」卡片、`job id/status/job type`、`本次任务 0 积分…` 回执、
「继续等待」按钮都不应默认占据对话。

## 规则

`apps/web/src/components/chat-message.tsx` 现在按块分类渲染，顺序不变：

- **默认显示**：文字（`text`）、执行计划（`plan`，非终态展开、终态自动折叠）、**已交付的图片/视频**
  （工具块带 `image`/`video` artifact）、**生成前确认**（付费授权）、**失败/取消/拒绝/参数校验失败**、
  设计交付结果与其提醒卡（`生成的目标设计`、`未应用到设计`）、可重试的读取失败、提示词库结果。
- **折叠进「过程」行**：其余工具步骤 —— 画布读取、已提交但仍在处理的任务、其成本回执、
  设计工具的成功回执、继续等待/放入画布等恢复控件。`thinking` 状态行（`✓ 分析完成` /
  `正在分析中`）保持一行细字，它是流式时唯一的活性提示，未折叠。
- 折叠按**连续段**分组，保留对话顺序：文字会打断分组，因此「卡片 / 文字 / 卡片」得到两行过程。

判定集中在 `tool-block-view.tsx` 的三个纯函数，UI 与分组共用同一份语义：

| 函数 | 作用 |
| --- | --- |
| `isUnrenderedToolBlock` | 本来就不渲染的块（`delegate_design_tasks`、`record_task_workflow`、`select_next_workflow_step`、对话式图片提案、内部确认）直接跳过，避免折叠行展开后是空的 |
| `isProcessOnlyToolBlock` | 没有 artifact、没有确认、没有失败/取消/拒绝/参数错误、没有设计交付的步骤 → 折叠 |
| `isToolBlockInProgress` | 折叠行是否还在处理（含 `status` 为 `queued/processing/running/submitting` 的任务回执），用于行的活性文案 |

## 交互

- 折叠行：`过程 · N 项`，`aria-expanded` 表达展开状态，`aria-label` 固定为 `过程 · N 项`（文案可变，
  可访问名稳定，便于测试）。工作仍在进行时显示 `正在处理…` 与转圈。
- 计划视图里点某个步骤的工具：`locateTool` 会**先展开该工具所在的过程行**，待其渲染后再滚动并高亮，
  因此折叠不会破坏「执行计划 → 定位工具」的既有能力。
- 折叠状态由 `AssistantMessage` 持有（受控），默认全部折叠；不持久化，重新打开对话即重置。

## 未折叠的例外（有意）

付费确认、失败、取消、拒绝、参数错误、设计未落地提醒都必须直接可见：隐藏它们会让用户看不到
需要自己决策或必须知道的事实。成本回执在**已交付图片**的块里仍然可见（该块不折叠），
仅在提交中/处理中这类过程块里随之折叠。

## 覆盖测试

- `apps/web/test/chat-process-group.test.tsx`：提交中任务 + 回执 + 继续等待按钮折叠为一行、
  展开后可见、交付图片/确认/失败保持可见、不渲染的块不产生空行、连续段分组与顺序。
- `apps/web/test/chat-message-internal-tools.test.tsx`：运行中的生图步骤改为「折叠行可达」。
- `apps/web/test/chat-message-plan-linking.test.tsx`：计划定位仍会滚动并高亮（自动展开折叠行）。
- 既有的 `chat-message-streaming-indicator` / `chat-image-aspect-ratio` / `tool-block-view` 未改语义，全部通过。

验证：`pnpm --filter @loomic/web typecheck` 通过；web 全量 120 文件 / 786 用例通过。
