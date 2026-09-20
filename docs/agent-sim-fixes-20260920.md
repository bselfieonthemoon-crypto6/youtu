# 2026-09-20 全量模拟用户测试:产品问题修复记录

输入：`artifacts/agent-sim-20260920/full-report.md` 与四个子代理报告（luna-a/b/c/c2）。
本文只记录**根因、修复、测试与边界结论**；证据都指向仓库内可复查的 JSON。

## P1-a 任务已终态，助手尾句仍说"正在生成中"

**根因（证据）**：`artifacts/agent-sim-20260920/luna-a/recovery/check-04.json`

| 消息 | id | createdAt | 内容 |
| --- | --- | --- | --- |
| 卡片 | `2bf1d5b7-…`（= job id） | 07:26:44.642 | 提交时写入；终态时被**原地改写**为"图片生成完成" |
| 助手尾句 | `e4cd28a6-…` | 07:26:46.614 | "海报已提交，竖版 3:4，**正在生成中**，出图后我再看…" |

job 在 07:27:23 succeeded（`chat_finalized_at` 同一秒）。消息按 `created_at` 排序，而卡片的位置是
**提交时间**，所以改写它并不能把它变成最新一条 —— 用户最后读到的仍是那句乐观承诺。

失败/取消路径早已修过这个问题（`finalizeTerminalImageJobPlaceholder` 终态时会**追加**一条通知），
但**成功路径没有**：`finalizeCurrentImageJobToCanvas` 只做 update-only 的卡片改写。

**修复**：`apps/server/src/features/jobs/job-canvas-finalizer.ts`

- 抽出 `appendSettledNotice()`，失败/取消、视频、**图片成功**三条路径共用；id 由 job id 经 sha256
  派生 → 重放或恢复扫描只会改写同一行，恰好一次。
- canvas 成功路径在卡片确实存在时追加：
  `图片已生成并放入画布：{title}（原始像素 W×H）。`
  该文案顺带把**原始像素**写进会话 —— 这正是 P1-b 的另一半根因（画布元素只知道显示框）。
- design 成功路径同样追加（同一条缺口，不能只修一半）。
- 被"编辑并重发"丢弃的回合（`chatRows` 为空）**不追加**：否则会把用户主动丢弃的那次尝试重新显示出来。

**测试**：`job-canvas-finalizer.test.ts` 新增 3 条（canvas 成功追加 + 像素尺寸 + 重放同 id；丢弃回合不追加；
design 成功追加），并把设计恢复路径的 upsert 计数断言 1 → 2。

**残留风险（已知）**：若供应商极快、作业在助手写完尾句**之前**就终态，追加的通知会早于尾句。
当前链路里图像生成 ≥数十秒，未观察到该顺序。

## P1-c 明确"不生成/只查询"的消息仍被路由为 `new_generation`

**证据**：`luna-c2/turn-03.json`、`turn-05.json`、`turn-08.json` 的 `design.routing` 事件，
三条全部 `source: "deterministic"`、`confidence: 1`、`intent: "new_generation"`、`reasonCode: "explicit_creation"`。
原文：

1. "…先问我具体是哪一张，**不要自行猜目标或开始生成**。"
2. "…没有让我提交生成；…请明确回答没有任务，**不要创建任务**。"
3. "…就先问我，**不能自行选择或生成**。"

**根因（两处）**：

1. `NEGATION_PATTERN` 只认紧邻动词（`不要生成`/`别做`）。这三句把否定指向**动作词**，位置并不紧邻，
   于是 `GENERATION_PATTERN` 命中了"提交**生成**"这类**被否定的提及**，给出 confidence 1 的创建判定。
2. `QUESTION_PATTERN` 收了 `哪些`，却漏了 `哪个`/`哪一张`，所以"哪一张适合做编辑目标"连"疑问句"都不算。

**修复**：`apps/server/src/agent/design-turn-intent.ts`

- 新增规则 `prohibited_action`：**同一分句内**同时出现禁止标记（封闭类）与"生成动作"词才算。
  分句作用域是关键——"不要用蓝色，做成红色海报"否定的是**属性**，该分句没有动作词，
  所以它依然是自信的 `new_generation`；只有"不要生成蓝底的"这种才降级。
- 该规则产出 `non_design / declined_or_hedged` + `needsModel: true`，但**不加 clamp**：
  同一分句可能属于"否掉一个选项 + 要求出图"的真实指令，正则不能取消用户真的提出的请求。
  安全方向由确定性回退保证：模型不可用时落到 `non_design`，不会替换会话系列。
- 疑问词补 `哪个|哪一?张|哪几|哪种`。
- 分类器提示词补一条：要求不要创建/提交/挑选/开始生成的回合是 `non_design`，
  但"否掉一个选项同时要求另一个"仍是 `new_generation`。

**测试**：`design-turn-intent.test.ts` 新增 5 条（三条原文 + 两个反例 + 模型可发布 + 无模型回退 + 疑问词）。

**顺带修掉一个我引入的误判**：`能不能帮我生成一张海报` 里的 `不能` 被当成禁止标记，
把它变成了拒绝——**已有的回归测试抓到了**。用 `(?<!能)不能|(?<!可)不可` 修正，
并在注释里记录原因。

## P1-b 状态回答把画布显示框当成原图像素，且同尺寸图片顺序颠倒

**证据**：`artifacts/agent-sim-20260920/luna-a/recovery/check-04.json`
`evidence.canvas.images[0]` 是 `{w:381,h:512}`（画布元素），而同一份文件里
`evidence.jobs[0].result` 是 `{width:880,height:1184}`（真实 PNG，下载校验为 880×1184）。
助手回答状态时用了前者并称之为"实际像素"，还把两张 1024×1024 方图的顺序说反了。

**根因（两条，互相独立）**：

1. `inspect_canvas` 与画布场景上下文只给元素的 `width`/`height`，**没有任何地方说明它是画布显示框**。
   真实像素只存在于作业回执 `background_jobs.result.width/height`；`public.asset_objects`
   **没有** width/height 列，画布文档也不存原始像素。因此"真实像素"在画布观察面里根本取不到，
   模型只能拿显示框当答案。
2. **顺序**：当时存在**三个互不对齐的顺序**且没有共同的 ordinal 可对齐 ——
   `inspect_canvas` / 场景索引按画布文档序（旧→新）列，`related_image_candidates`
   按 `ordinal` **降序**（新→旧）列，作业回执按 `created_at` 降序。而 turn-08 **没有调用任何工具**，
   它是把注入上下文里这几种顺序合并起来回答的，于是两张同为 512×512 的方图被说反。
   注意注入上下文里**唯一**的画布图片清单其实是 `related_image_candidates`
   （场景渲染对图片代表项传了 `omitImageRepresentativeDetails: true`），它才是真正反转顺序的那一面。

**修复**：

- `apps/server/src/agent/canvas-scene-index.ts`
  - 给 `width`/`height` 补类型注释：它们是画布显示框，不是源图像素。
  - `compactSceneEntry` **改名**为 `canvas_frame_width` / `canvas_frame_height`，并显式给出
    `canvas_index`（元素在画布文档中的位置）。重命名是刻意的：模型读的就是这段 JSON，
    裸 `width`/`height` 紧挨 image id 正是被误读的入口。
  - 新增 `CANVAS_FRAME_DIMENSION_NOTE` 与 `CANVAS_ORDER_NOTE` 两句语义说明，挂在**始终存在**的尾部
    （预算紧张时先丢区域/代表，不丢这两句）。
  - 所有排序统一走共用的 `compareCanvasOrder`（升序 `ordinal`），查询与渲染不再各排一套。
- `apps/server/src/agent/tools/inspect-canvas.ts`：工具描述与响应新增
  `dimensions.note` / `dimensions.order`。
- `apps/server/src/agent/mastra-runtime.ts`：作业回执投影新增 `sourcePixelWidth` /
  `sourcePixelHeight` / `canvasElementId` —— 这是模型能读到真实像素和"承载它的画布元素"的
  唯一位置，便于把回执与画布观察对齐。
- `apps/server/src/agent/related-image-context.ts`：候选**按画布序列出**（真正反转顺序的那一面）；
  保留策略与被动视觉输入仍是"选中优先、其次最新"（它们是偏好，不是展示顺序），
  每个候选带 `canvasIndex`，渲染时输出 `canvas_index`，并在标题行说明这是画布顺序。
- **刻意不改** `mastra-agent.ts`（不新增提示词规则）：该说的语义属于**观察面与回执**，
  不属于 Agent 的硬编码判断（R1）。也没有为了拿像素给 `inspect_canvas` 加 `background_jobs`
  查询，更没有给 `asset_objects` 加列/迁移 —— 它只读 `canvases.content`。

**测试**：`canvas-scene-index.test.ts`、`tools/inspect-canvas.test.ts`、
`related-image-context.test.ts`、`mastra-runtime-context.test.ts`。

## P2 多图系列同轮只交付 1/2

**证据**：`artifacts/agent-sim-20260920/luna-b/b2/16-series-two-generate.json`、
`16-state.json`；完整根因分析见 `artifacts/_probe/rca-series-source-ambiguity.md`。

**根因（已定位到行）**：

- 来源清单在 run 开始前**冻结一次**（`mastra-runtime.ts:568-577`，`mastra-image-source-grounding.ts:180-185`），
  两次 `generate_image` 调用在同一 step 相隔 **10ms** 并发发出，评审的缓存键
  **包含 proposal 摘要**（`mastra-image-source-grounding.ts:198-199`），于是第二次调用
  自己又跑了一遍评审，而清单里只有先前就存在的无关素材（透明 diffuse 图），
  它自己的 prompt 又声称与本轮第一张保持同一视觉身份 → 评审返回 `ambiguous`，拒绝且不建 job。
- 本轮第一张图当时还没成功（`succeeded` 07:37:22.373，拒绝发生在 07:37:06.900），
  所以"把本轮产物当候选"无法修复这一例。
- 另一个尖角：这条拒绝**没有**被记录成未完成输出（`:353-354`），所以缺的那一张
  在下一轮完全不可见，用户说"继续"也无从知道还欠一张。

**修复**：

- **冻结本轮来源判定**（`mastra-image-source-grounding.ts`）：评审缓存键去掉 `proposal` ——
  评审回答的是"**本轮用户请求**是否要求用到清单里的某张图"，这是**回合**的属性而非某个 proposal 的属性；
  同时用一张 in-flight promise 表让并发调用**共享同一次评审**（检查-写入是同步的，
  两个并发调用不可能各起一次评审）。不同 run 或不同清单仍然各自评审；失败/超时/不可用
  （`undefined`）**不落缓存**，下次仍会问评审。
- **把拒绝记为未完成输出**（`mastra-image-tool.ts`）：与其它提交前拒绝一致，
  这样系列中途缺的一张会在下一轮作为未完成工作可见。
- **已知取舍（记录在案）**：同一 run 内若两个零来源 proposal 的真意不同（一个应绑定已有图、
  另一个应是全新的），冻结会让后者继承前者的判定。方向上只会更"用参考图"或更"不用参考图"，
  两条都不会把**错误的用户图**当来源（安全性质未削弱），代价是质量层面的可能偏差。
  按 R1，模型若明确知道要用哪张图，应当走 `edit_image` + `sourceUsage=reference` 显式绑定。

**测试**：`mastra-image-source-grounding.test.ts`（并发共享一次评审、跨 run 仍分别评审）、
`mastra-image-tool.test.ts`（同 run 第二次零来源调用可提交、拒绝被记录）。

**顺带修正的测试隔离问题**：拒绝现在会写进本轮 `configurable`，于是两个沿用模块级 `baseConfig`
的既有用例把一条"横幅"记录泄漏给了后续用例（首轮 5 个失败）。已给这两处各自独立的本轮上下文
（`mastra-image-tool.test.ts:542`、`:751-757`），生产行为不变。

**未做（后续项）**：方法层的 Skill 条款 —— "同一系列里有先后依赖的多张图必须**串行**提交：先交第一张、
用 `get_image_status(jobId)` 拿到真实 assetId，再用 `edit_image`（`sourceUsage=reference`）提交后续张；
不要在同一个工具批次里并行提交有依赖的两张"。**没有**直接改 `skills/`：技能正文还会经
SQL 迁移写入数据库，单独改 `SKILL.md` 到不了运行时，需要走技能打包/迁移那条流水线。

## 边界结论（不是本轮代码修复项）

### 1. `--aspect 320:70` 返回 `invalid_command`（测试入口边界，已定位）

根因是**契约层的封闭枚举**，不是 Agent 能力缺失：

- `packages/shared/src/contracts.ts:66-70`：`imageGenerationPreferenceSchema.aspectRatio` 只接受
  `auto/1:1/4:3/3:4/16:9/9:16/3:2/2:3/4:5/5:4/21:9`。
- 仿真脚本把 `--aspect` 塞进 `imageGenerationPreference`（`apps/server/scripts/agent-sim-tools.mjs:445`），
  非预设值在 WS 命令 schema 阶段就被拒（`apps/server/src/ws/handler.ts:323-326`），**不会创建 run**。

而且 `320:70 = 4.571:1` 本身超出 `nonstandard-image-size` 技能可提交的 `1:3–3:1` 范围，
正确路径是用户把尺寸写进**请求文本**，由技能选用最近的合法比例（`3:1`）并如实说明约 52% 的比例偏差。
因此要验证 320×70，应把尺寸写进 prompt 正文，而不是使用 `--aspect` 标志。

### 2. 删除确认闭环

CLI 用 `agent.confirm_action` 复现得到 `confirmation_execution_failed` / `Confirmation is not_found`，
确认表零匹配 —— 只能说明**由 CLI 伪造浏览器确认**走不通，不能据此判定浏览器确认卡片有缺陷。
该场景仍需真实浏览器点击验收。

### 3. 取消后的占位框语义（需要产品定义）

代码事实：`canvasFailureLabel("canceled", …)` 已把占位框文案写成"生成已取消"，但占位框自身的
`status` 字段仍是 `error`。结构检查通过（它指向本会话的终态任务），但产品语义未定：
(a) 取消后移除占位框；(b) 保留但标明"已取消"且不可重试；(c) 保留并作为重试入口。
