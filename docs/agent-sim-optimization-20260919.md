# 模拟用户战役后的优化批次（2026-09-19）

来源：`docs/agent-sim-campaign-20260919.md` 的"已确认但本轮未修（A–J）"表 +
独立核验建议。本轮把 A–J 里可代码化的部分全部落地，分四批，每批都保持
`pnpm --filter @loomic/server test`、`apps/web` 测试与两处 typecheck 全绿。

代码在 `feat/mastra-migration` 与 `main` 同步推送。

## 批次 1：终态可见性、取消结算、写入修复

| # | 问题（A/B/F/G + 核验新增） | 修法 | 关键文件 |
| --- | --- | --- | --- |
| A | 失败回执不是会话最后一条：终态只重写提交行，用户最后读到的是"正在生成中…出图后告诉你" | 终态结算时**追加**一条通知消息（`content_blocks:[{type:"text"}]`），id 由 job id 派生（`sha256` → 确定性 UUID）保证恰好一次 | `features/jobs/job-canvas-finalizer.ts` |
| B | 取消排队 job 后卡片/画布仍显示"生成中"，实测滞后 132–145 秒 | `POST /api/jobs/:jobId/cancel` 内同步调用 `settleTerminalJob`（app 注入），靠 `*_terminal_finalized_at` 幂等 | `http/jobs.ts`、`app.ts` |
| F | write-repair 的 `toolChoice:'required'` 只在 step 0，一次只读调用即满足 | 修复回合把可用工具临时收窄到本轮 `decision.writeToolNames`（从 registry 取，含按需加载工具） | `agent/mastra-agent.ts` |
| G | 画布失败占位框文案恒为"图片生成失败" | `canvasFailureLabel(status, errorCode)`：429/拒绝/超时未知/参数/安全策略各自成句 | `features/jobs/job-canvas-finalizer.ts` |
| E(前哨) | 同轮"判定需要写入却没写"的修复文案不明确 | 修复提示改为"我先确认这一步是否真的执行成功。" / "这次没有执行成功：本轮没有产生新的图片、修改或任务，已有内容不受影响。你可以再说一次，我来重做。" | `agent/mastra-agent.ts` |
| 新增 | 疑问句里的动词被当成执行意图（"生成一张图要花多少积分？"） | `generation_verb`/`edit_verb` 在疑问句下 `confidence:0.4`、把判定交给分类器 | `agent/design-turn-intent.ts` |
| 核验新增 | `list_skills`(24.8KB)、提示词库检索等大工具结果在事件与 transcript 里落成 `{}` | 分级有界截断（字符串/数组/键数）+ `truncated:true`，不再整块丢弃 | `agent/stream-adapter.ts`（已在 `20662cc` 提交） |

**回归**：`job-canvas-finalizer.test.ts`（追加通知、视频终态）、`jobs-validation.test.ts`
（取消即结算）、`mastra-agent.test.ts`（只收窄到写入工具 + 文案）、`design-turn-intent.test.ts`（疑问句延后判定）。

## 批次 2：画布占用感知、会话技能清单、错误文案本地化

| # | 问题（C/E + 核验新增） | 修法 | 关键文件 |
| --- | --- | --- | --- |
| C | `move` 把图片移到与已有元素**逐像素重叠**的位置，回复却说"留出适当间距"；`align`/`distribute` 无声叠压 | `applyMove` 先算占用比：≥50% 时沿"向右"让开一个 `OCCUPANCY_GAP=24` 并回报最终坐标与原坐标；`align`/`distribute` 保持语义但在压到**非目标**元素时返回 `warning:`（目标之间互相叠压不报） | `agent/tools/manipulate-canvas.ts` |
| E | 历史只回放文本，模型无法自查工具回执 → 同一会话里自称"没有实际加载过任何技能正文" | 新增 `session_design_context.read_skills`（有界、最新在前），运行结束时把本轮真正读过的技能（`status=loaded`/`composed` 回执）合并持久化；下一轮注入 `current_context.sessionReadSkills`，并注明"读过的技能不等于已选中或已执行，未列出的技能本轮没读过" | 迁移 `20260917000004`、`agent/session-design-context.ts`、`agent/mastra-runtime.ts` |
| 新增 | 工具冲突文案是英文（`This Skill does not declare the raster-image output kind…`），模型会照抄给用户 | `use_skill` 与 `compose_skills` 的冲突/校验文案全部中文化，code 字段不变（测试只断言 code） | `agent/tools/workspace-skill-tools.ts`、`agent/skill-composition.ts` |
| 新增 | 失败原因把上游英文原文（`504 Upstream model timed out. Try again later.`）带给用户 | 新增 `providerFailureDescription(errorCode)` 中文释义；回执新增 `errorLabel`，`videoExecutionState` 同样；提示词要求"面向用户一律用 errorLabel，`error/error_message` 只作排查依据" | `agent/provider-failure-copy.ts`、`agent/mastra-runtime.ts`、`agent/mastra-agent.ts` |

**回归**：`manipulate-canvas-placement.test.ts`（避让/阈值/最终坐标、distribute 越界告警、仅目标互压不告警）、`session-design-context.test.ts`（读写/合并/上限/列缺失回退）、`provider-failure-copy.test.ts`。

## 批次 3：视频状态、失败占位框清理、复核语义

| # | 问题（核验 p9 三项 + p3-F6 + 占位框清理） | 修法 | 关键文件 |
| --- | --- | --- | --- |
| 视频状态 | 上下文只带最近 3 条视频 job，长会话里旧终态 job 掉出后无法主动查 | 新增 `get_video_status`（同工作区成员 + 会话/画布栅栏，只读、不重提交不扣费不取消），上下文窗口放宽到 5 条 | `agent/mastra-image-status-tools.ts`、`features/jobs/job-service.ts`、`features/jobs/conversation-image-job-access.ts`（`scopeConversationJobs`）、`agent/mastra-runtime.ts` |
| 失败占位框 | 占位框是**有意保留**的重试入口，但 Agent 既分不清它和普通矩形，也不知道能删 | `inspect_canvas` 场景索引暴露 `generationStatus`/`generationJobId`（只有 `customData.type=image-generator|image-replacement` 才算，普通元素的 `status` 不误判），代表行渲染出来；提示词说明"这是有意保留的重试入口，用户要求去掉时按普通画布元素走 delete + 二次确认，生成中的不要删" | `agent/canvas-scene-index.ts`、`agent/mastra-agent.ts` |
| p3-F6 | `review_image_results` 返回 `status:"unavailable"` 却带完整看图描述与 `viewed:true`，读起来自相矛盾 | 明确语义：`status` 回答"是否得出了验收结论"，`viewed` 回答"是否看过图"；`unavailable` 时补 `statusMeaning`，参考分析文案区分"有问题/无法确认"两档；工具 description 写明读法 | `agent/image-result-verification.ts`、`agent/tools/review-image-results.ts` |
| H | 安全（IP/真人肖像/违法/越权）在提示词层无任何规则，只靠基座对齐 | 新增一条安全边界提示词：明确拒绝并给不侵权替代方向，不出"换名字的规避版"，不以"只是参考"先出图；非设计请求同样说明边界 | `agent/mastra-agent.ts` |

**回归**：`mastra-image-status-tools.test.ts`（视频读取/中文失败文案/越权失败关闭）、`canvas-scene-index.test.ts`（占位框标记与渲染）、`image-result-verification.test.ts`（`statusMeaning`）。

## 批次 4：环境侧结论与测试工具加固

### 环境侧（非代码缺陷，需知晓）

- **上游网关并发不稳**：战役高峰 32 个 job 中 19 个 `dead_letter`（`429 当前分组上游负载已饱和`、
  `504 Upstream model timed out`）。同一会话稍后重发常能成功 → 瞬时供应商故障。429 已按
  `provider_rate_limited` 分类并加限次重试（15s/30s/60s），仍失败即终态并不自动重试。
  **测试纪律**：不要并发跑多个出图回合；`dead_letter` 先重跑一次再当成产品缺陷。
- **视频供应商凭据无效**：唯一视频 job 4 秒内 `http_401 Invalid token`
  （`workspace:debd662d-…`），本副本视频链路 100% 不可用。现在会以中文终态文案告知
  （"渠道的凭据或配置无效…"）而不是静默；**凭据需环境侧配置**。

### harness（`apps/server/scripts/agent-sim-tools.mjs`）

- 新增 `check` 断言模式：把"结构不变量"变成可执行定义，退出码 1 表示有违规。
  不变量：`unfinished_runs`、`unfinished_jobs`、`card_not_settled`（终态 job 的卡片仍显示在途）、
  `missing_terminal_card`（Mastra 提交的终态 job 完全没有卡片，即"用户永远看不到结果"）、
  `missing_canvas_delivery`、`stale_generating_placeholder`、`orphan_error_placeholder`、
  `optimistic_tail`（所有 job 已终态，最后一条助手消息仍在承诺"生成中"）。
  `--allow <code>` 可接受已知环境性违规，`--out <json>` 同时保存完整证据；只断言结构事实，不评价设计好坏。
- `state` 与 `check` 共用 `collectEvidence`；`jobView` 增 `mastraSubmission`。
- 头部注释补充战役教训（长文本用 `--text-file`、并发会诱发 429/504、`check --allow unfinished_jobs` 的用法）。
- 实测（旧会话）：`check` 在 p2/p6 命中 `optimistic_tail`——正是批次 1 修掉的 A 类缺陷，
  其余 10 个会话干净，说明不变量既不空转也不误报。

## 未被本轮采纳（记录，避免重做）

- 提示词库/技能目录的**语义检索**：仍按声明关键词与目录描述选择，属方法层设计，不改。
- 画布上失败占位框**自动清理**：保留是刻意设计（重试入口），只补"可被用户要求删除"的路径。
- 聊天侧原生画板创建/导出（I 的大半）：产品决策，不在本轮范围，仅在提示词与边界说明里补足发现性。
- 上游网关与视频凭据：环境侧事项，代码侧只保证如实分类与中文告知。
