# 用户检查清单 × 实际状态（2026-09-20）

对照用户本轮给出的 4 个优先级 + 三阶段实施顺序，逐条核对**代码事实**（不是计划）。
状态含义：✅ 已修并锁定 ｜ 🟡 部分修 ｜ 🔵 本轮进行中 ｜ ❌ 未修。

上一轮提交：`abba46a`（四项 P0/P1 修复）、`6be10c5`（回归结论），已在 `feat/mastra-migration` 与 `main`。

## 第一阶段

| # | 清单项 | 状态 | 代码事实 / 证据 |
| --- | --- | --- | --- |
| 1 | 生成完成后仍显示"正在生成中" | ✅ | 卡片消息 `id=job id` 是提交时写的，终态只**原地改写**它，位置不变，所以用户最后读到的是同轮的乐观承诺。`job-canvas-finalizer.ts` 的 `appendSettledNotice()` 现在覆盖**成功**路径（canvas + design）并带原始像素；被"编辑并重发"丢弃的回合不追加。单测 3 条。 |
| 2 | 尺寸信息不准确（四层语义） | 🔵 | 上一轮已区分**画布显示框**与**AI 原始像素**（`canvas_frame_width/height` vs 回执 `sourcePixelWidth/Height`），并让所有画布清单共用 `compareCanvasOrder` + `canvas_index`。**本轮补齐**：① 用户要求尺寸 ② AI 原始像素 ③ 画布显示尺寸 ④ 最终导出尺寸 四者显式命名；编号/顺序改绑**稳定 asset ID**（位置只作展示）。 |
| 3 | "不要生成"仍路由为生成 | ✅ | 根因是 `NEGATION_PATTERN` 只认紧邻动词（`不要生成`），而真实原文否定的是**动作词**（`不要创建任务`／`不能自行选择或生成`／`不要自行猜目标或开始生成`），于是命中了被否定的"提交**生成**"。新增 `prohibited_action`（同分句内禁止标记 + 生成动作词），并按 `禁止执行 > 查询/分析 > 澄清 > 编辑 > 新生成` 的方向让确定性回退落 `non_design`；疑问词补 `哪个/哪一张`。单测 5 条。 |
| 4 | 健康检查不完整 | 🔵 | 事实：`apps/server/src/http/health.ts` 此前是**常量** `{ok:true}`，所以 `chat_messages` 写入超时（statement timeout）时它照样报正常。**本轮实现**：`/api/health` 覆盖 数据库读写 / Agent runtime / 后台任务队列 / 图片存储 / Worker 在线，逐项 `status`+`latencyMs`；Worker 需真实心跳（`private` 表 + 迁移）。约束：保持既有探测方（Playwright webServer、`scripts/start-local-api.ps1`、多个验收脚本）可用。 |
| 5 | 任务/图片/画布元素 ID 关联 | 🔵 | 现状：回执已有 `assetId`/`canvasElementId`，卡片 `messageId` **等于** job id（设计如此），但这四个 id 还没在 占位框 / 成品元素 / 卡片 上一致出现。**本轮实现**：四 id 一致化 + 单测。 |

## P1 路由与安全边界（用户清单的第二组）

| # | 清单项 | 状态 | 代码事实 |
| --- | --- | --- | --- |
| 1 | 否定意图优先级（`禁止执行 > 查询/分析 > 澄清 > 编辑 > 新生成`） | ✅ | 见第一阶段 #3。确定性回退已按"否定/提问优先"落 `non_design`。 |
| 2 | 路由结果与最终工具行为一致（`detectedIntent` / `executedAction`） | ❌ | 现状只记录**路由判定**（`design.routing` 事件：intent / reasonCode / source / confidence），**没有**"本轮实际执行了什么"的第二层记录；campaign 中确实出现过路由 `new_generation` 而模型只澄清。计划：run 结束后记录 `executedAction`（是否调用 generate_image/edit_image/ask_clarification/纯文本）+ 最终交付资产，并与路由并列展示，让"路由说新生成、实际只澄清"可见而不是矛盾。 |
| 3 | Skills 组合冲突 | ❌ | 见第三阶段 #1（`skill_output_kind_conflict`）。 |
| 4 | 自动匹配结果让用户看得懂 | 🟡 | **已有**：`describeDesignRouting()` 给出候选技能 + 命中关键词 + 判定依据（模型判定/模型不可用回退/规则 + 置信度）+ 候选助手指南 + 非标准尺寸启用。**② 分层已修**（`5cf51bf`）：普通界面只显示短提示（候选技能 + 命中关键词），判定依据/助手指南/尺寸启用这些**用户无法据以行动**的诊断信息移入高级模式（`localStorage.setItem("loomic:routing-detail","1")`，无需重建；存储不可用时保持短提示）。措辞**刻意不改**：运行时不再"选定"技能，所以不能说"正在使用某技能"。**① 仍缺**："本轮是否会生图"的诚实表述 —— 路由的 `new_generation` **不等于**真的会生图（必须等工具回执），需要与 `executedAction` 一起做。 |

## 第二阶段

| # | 清单项 | 状态 | 代码事实 |
| --- | --- | --- | --- |
| 1 | 多图系列一次性交付 | 🟡 | **已修**：来源判定按 run 冻结（缓存键去掉 proposal 摘要）+ 并发调用共享在途评审 + 拒绝记为未完成输出，所以同一 step 的第二张不再被 `source_grounding_ambiguous` 拦下。**未做**："开始前一次性确定 系列数量/主参考图/每张是否以上一张为风格参考/必须一致的要素" —— 属技能**方法层**，而技能正文同时经 SQL 迁移入库，单独改 `SKILL.md` 到不了运行时，需走打包流水线。 |
| 2 | 编辑 / 变体 / 覆盖原图 区分 | ❌ | 现状：单点改字后台记录是 `generate`，画布**新增**一张并保留原稿（效果好但语义没区分）。缺：覆盖编辑 / 保留为新版本 / 局部重绘 / 全图重生成 四类显式区分，以及 UI 上的"替换原图 / 保留为新版本"选择。 |
| 3 | 参考图角色显式绑定 | 🟡 | 服务端 grounding 评审已区分 `usage=edit`（改它本身）与 `usage=reference`（据它做新图），且要求**用户证据**原文；但用户界面看不到"哪张是编辑对象／风格参考／内容参考／忽略"，模型仍可能靠"这张/上一张"推断。 |
| 4 | 取消后的占位框 | 🔵 | 事实：文案已由 `canvasFailureLabel("canceled")` 写成"生成已取消"，但占位框**自身状态字段仍是 `error`**。用户已定方案（明确"已取消" + 删除占位框 / 重新生成 / 修改提示词后重试，不把用户主动取消展示成错误）。**本轮实现**。 |
| 5 | 删除确认真实浏览器验收 | ❌ | 删除前要求确认是对的；CLI 用 `agent.confirm_action` 得到 `confirmation_execution_failed`/`not_found`，只能说明**伪造浏览器确认**不通，不能判定卡片有缺陷。需要真实浏览器点击（创建、过期、执行、刷新四个面）。 |
| 6 | 非标准尺寸精确交付（320×70） | ❌ | 已定性并做了逻辑验证：`--aspect` 的入口是**封闭枚举**（UI 预设），320:70=4.57:1 也超出技能可提交的 1:3–3:1，正确路径是写进请求文本 → 替代为 `3:1` 并**披露偏差**（已有单测）。**未做**清单要求的完整交付链：原生尺寸生成素材 → 程序画布按精确尺寸合成 → 导出后读文件头验证真实像素 → 交付卡片同时显示 目标尺寸/实际导出尺寸/格式/是否含透明通道。 |

## 第三阶段

| # | 清单项 | 状态 | 代码事实 |
| --- | --- | --- | --- |
| 1 | Skills 输出协议统一 | ❌ | `use_skill` 要求传入该技能**自己声明的** `runtime.outputKinds`，模型传错即 `skill_output_kind_conflict`（`workspace-skill-tools.ts:48`）。本轮证据显示它**可恢复**（同 run 稍后加载成功），所以不是阻塞项，但多技能组合时输出协议确实不统一（清单建议统一为 guidance/prompt/copy/generation_request/canvas_operation）。 |
| 2 | 费用与账务核对 | 🟡 | **用户侧已修**（`a1f0571`）：`tool-block-view.tsx` 的成本回执在字段不全时**直接 `return null`**，卡片上干脆没有费用行——而"没有费用行"会被用户读成"这次免费"。现在不完整回执明确显示**"费用数据暂不可用"**（不编数字、不给计价依据），只有"从未有过回执"的结果（预检失败/取消/退款）才什么都不显示；4 条新测试覆盖 queued/processing/succeeded/finished。**管理端对账本来就有**：`admin_workspace_billing(p_actor_user_id, p_workspace_id, p_tx_limit)` 返回 `mismatchedJobs`（把 `credits_cost` 与额度流水实际扣费/退款逐条比对），管理页展示最近 20 条"为空表示当前对得上"；已在本机库核实 `admin_workspace_billing` / `admin_set_workspace_plan` / `admin_adjust_credits` 三个函数都存在。**仍缺**：回执本身没有显式 `costStatus`，其它消费方（状态工具/模型）仍只能靠"字段缺失"推断；这是小项，排在正在改 `mastra-image-status-tools.ts` 的工作流落地后做，避免同文件互踩。 |
| 3 | 错误分类 | 🟡 | **已有**：`providerFailureDescription`（按 error code 给中文原因）、`canvasFailureLabel`（区分渠道过载/拒绝/额度/凭据/尺寸校验）、`sanitizeErrorForClient`。**本轮新增统一分类实体**：`apps/server/src/features/jobs/job-failure-class.ts` —— 六类 + `unknown`（用户输入 / Agent 路由 / 平台·DB·API / 供应商 / 已取消 / 入口不支持 / 原因未知），`status` 优先于 `errorCode`（取消就是取消，哪怕带着别的错误码），`unknown` 是**真实答案**而不是兜底猜测；`PROVIDER_FAILURE_CODES` 导出后由测试双向校验，防止"文案认识、分类不认识"漂移。18 条测试。**仍缺**：各用户可见文案面接入它（`canvasFailureLabel` 在 D 的 `job-canvas-finalizer.ts`，落地后接；web 卡片同理）。 |
| 4 | 自动回归用例（11 条流程） | 🟡 | 已有仿真 harness（`apps/server/scripts/agent-sim-tools.mjs`）+ 结构检查 8 类违规定义 + 本轮新增的 19 条单测；缺清单列的 11 条流程的**固定回归集**（只讨论不生图 / 只给提示词 / 明确生成 / 生成后改口 / 多图系列 / 透明背景 / 多参考图消歧 / 运行中取消 / 删除确认 / 非标准尺寸 / 新话题不继承）。 |
| 5 | 执行过程可观测性（每轮执行摘要） | ❌ | 未做：用户意图 / 匹配 Skill / 使用工具 / 创建任务数 / 最终交付资产 的每轮摘要。 |
| 6 | 测试报告即时读取竞态 | ✅ | 已修：`run.completed` 到助手消息落库之间存在竞态，harness 立即读取会得到空 `assistantMessages`（campaign 里出现过一次）。现在有界轮询（≤12s，400ms 间隔）并记录 `assistantMessageWaitMs`，让"没回答"与"稍后回答"可区分。 |

## 剩余项的实施计划（按文件，供后续轮次机械执行）

按依赖关系排序；标注 **依赖** 的项必须等对应工作流落地后再动，避免同文件互踩。

1. **编辑 / 变体 / 覆盖区分**（阶段二 #2）
   - 现状：单点改字后台记录是 `generate`，画布**新增**一张并保留原稿；`canvas-element-writer.ts` 已有 `replaceElementId`（"替换某个元素"）这条通路。
   - 做法：在 image job 的 payload/回执里显式区分 `editTarget: "replace" | "new_version"`（并区分局部重绘/全图重生成），由 `edit_image` 的输入决定；UI 在提交前给"替换原图 / 保留为新版本"选择。**默认必须安全**：未明确选择时保留为新版本，绝不销毁原稿。
   - 文件：`apps/server/src/agent/mastra-image-tool.ts`（edit 工具输入/回执）、`apps/server/src/features/jobs/generation-identity.ts`（本轮新建，可承载身份与目标）、交付卡片/画布选择控件（web）。测试：工具回执断言 + web 交互断言。
   - **依赖**：D 的 `canvas-element-writer.ts` 改动落地后（replace/insert 语义）。

2. **参考图角色显式绑定**（阶段二 #3）
   - 现状：服务端 grounding 评审已区分 `usage=edit`（改它本身）/`usage=reference`（据它做新图）且要求用户证据原文；用户看不到逐图角色。
   - 做法：对每张候选图输出角色 `edit_target` / `style_reference` / `content_reference` / `ignored`；**用户显式指定优先**，模型推断的必须标注"推断"并要求证据原文；UI 允许点选角色。
   - 文件：`mastra-image-source-grounding.ts`、`related-image-context.ts`、回执投影。测试：评审输入/输出 + 渲染文本。
   - **依赖**：B 的 `related-image-context.ts` / `mastra-runtime.ts` 改动落地后。

3. **路由双层状态 `detectedIntent` / `executedAction`**（P1 组 #2）+ **执行摘要**（阶段三 #5）
   - 做法（合并做，同一写入点）：run 结束后追加一条执行记录，字段 = 是否调用 `generate_image`/`edit_image`、是否 `ask_clarification`、是否纯文本、创建任务数、最终交付资产 id；即"用户意图 / 匹配 Skill / 使用工具 / 创建任务数 / 最终交付资产"的每轮摘要，与 `design.routing` 并列（高级模式展示）。
   - 文件：`mastra-runtime.ts`（B 正在改）、`packages/shared` 事件契约、web 展示。测试：runtime 事件字段 + web 渲染。
   - **依赖**：B 的 `mastra-runtime.ts` 改动落地后。

4. **错误分类**（阶段三 #3）
   - 做法：新增单一分类模块 `classifyJobFailure({ status, errorCode })` → 六类（用户输入 / Agent 路由 / DB·API / 图片供应商 / 任务取消 / 测试入口不支持），输出稳定的 class + 中文文案；所有用户可见文案从它取，**只有确实未知**才允许回落到"生成失败"。
   - 文件：新建 `apps/server/src/features/jobs/job-failure-class.ts` + 测试（可先独立完成）；再改 `provider-failure-copy.ts`（无人占用）；`canvasFailureLabel`（在 D 的 `job-canvas-finalizer.ts`）落地后接入。
   - **依赖**：接入 finalizer 那一步需要 D 落地。

5. **非标准尺寸精确交付**（阶段二 #6，清单里最大的一项）
   - 目标流程（用户给定）：识别目标尺寸 → 选接近比例的原生尺寸生成素材 → 极端横幅优先生成"透明主体 / 背景 / 可编辑文字" → **程序画布按精确尺寸合成** → 导出后**读文件头验证真实像素** → 交付卡片同时显示 目标尺寸 / 实际导出尺寸 / 文件格式 / 是否含透明通道。
   - 现状：只有"把尺寸写进请求文本 → 替代 `3:1` 并披露偏差"的逻辑验证（已有单测）。合成、导出、文件头校验这条链**不存在**。
   - 文件：新增精确尺寸合成 + 导出验证模块（`features/designs/` 下）、`export-dimension-contract.ts`（B 本轮新建，正好承载导出尺寸契约）、交付卡片（web）。若需持久化"目标尺寸/导出尺寸"，先评估复用现有 design/export 表，**非必要不加迁移**。
   - 建议单独一轮做，并配一条 `--paid` 回归流程。

6. **多图系列"开始前一次性确定"**（阶段二 #1 的剩余半条）与 **技能输出协议统一**（阶段三 #1）
   - 现状：`use_skill` 要求传入该技能**自己声明的** `runtime.outputKinds`，模型传错即 `skill_output_kind_conflict`（可恢复）；系列流程的"数量/主参考图/逐张一致性"没有前置确定。
   - 做法：统一为清单建议的五类输出（`guidance` / `prompt` / `copy` / `generation_request` / `canvas_operation`），在每个技能的 manifest 里显式声明；冲突回执必须**总是**回带该技能允许的 outputKind 列表；系列流程写入技能方法层。
   - **关键约束**：技能正文与 manifest **同时经 SQL 迁移入库**（如 `20260915000004_nonstandard_image_size_approximation.sql`），单独改 `skills/**` 到不了运行时。必须先找到生成该迁移的打包脚本，连同迁移一起改，否则改了等于没改。
   - **依赖**：需要先确认打包脚本位置（下一轮第一步）。

7. **删除确认浏览器验收**（阶段二 #5）— 本轮 E 工作流在做（创建/过期/执行/刷新四阶段 + 判定 CLI 的 `not_found` 是否只存在于 CLI）。

## 总体判断（与用户一致）

主链路可用，不需要推倒重做。真正该收紧的是**状态准确、路由安全、资产绑定、尺寸可信、多图完成度**这五件基础事。
本轮优先做第一阶段的三项（健康检查、尺寸四层 + asset 绑定、四 ID 关联）与用户已定方案的取消占位框；
第二阶段剩余的（编辑/变体区分、参考图角色、删除确认浏览器验收、非标准尺寸精确交付）与第三阶段
（技能协议、费用核对、错误分类、回归集、执行摘要）在后续轮次继续，逐项留测试与结论。
