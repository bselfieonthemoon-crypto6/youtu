# Legacy Agent 退役依赖审计（Step 0）

目标：生产运行时只保留 Mastra；legacy Agent 不可启用，其后删除代码与测试；数据库历史数据保留。
本文件为 **只读审计**，本阶段未修改任何生产代码。

## 0. 边界

**退役对象（legacy Agent 运行时）**
- `runtime.ts` 的 legacy 分支（`streamRun:982-3507`、legacy helper `3511-3693/3695-3701/3774-3798`、默认 `createLoomicDeepAgent` 工厂 `607-626`、`persistence`/`backends` 的 legacy 用法）
- `deep-agent.ts` 及其值导入的整棵 legacy 树
- legacy 任务/工作流/意图：`design-task-*`、`deferred-design-task`、`workflow-execution`、`design-delegation-*`、`sub-agents`、`intent-*`、`result-continuation`、`autonomous-execution`
- legacy 上下文：`context-compaction`、`active-skill-guidance`、`skill-reference-projection`
- legacy 持久化：`persistence/*`（LangGraph checkpointer/store）
- legacy 图片提案/确认：`tools/image-generate` 的提案路径、`tools/image-generation-confirmation`、`image-proposal-*`、`image-confirmation-*`

**保留对象（不属于退役）**
- 无限画布编辑器、原生画板编辑、`/api/designs/*` 及设计资源/模板/导出
- 图片/视频异步任务、worker、finalizer、计费、来源绑定、权限
- **Mastra 共用件**：`design.sync`+outbox/fanout、`agent.retry_tool`+`tool-execution-service`+`read-tool-registry`、`agent.confirm_action`+`destructive-confirmation-service`（设计用途）、`canvas.resume`+`event-buffer`、run history+`agent-run-service`、`stream-adapter`、`context-budget`、`backends/*`、`workspace-skills`/`skill-composition`/`tools/workspace-skill-tools`、`tools/index.ts`（共享工厂）
- 历史数据库数据（不 drop）

---

## 1. 运行时入口与配置

| 事实 | 证据 |
|---|---|
| 未设置 `LOOMIC_AGENT_RUNTIME` → **Mastra**（默认） | `runtime.ts:421-430` |
| `=mastra` → Mastra；非法值 → **抛错** | `runtime.ts:427-429` |
| `=legacy` → 仅此能启用 legacy | `runtime.ts:424-425` |
| `createAgentRunService` 注入 legacy `agentFactory` 优先级最高（测试 seam） | `runtime.ts:595-598` |
| `app.ts` 在 `buildApp` 解析一次运行模式并暴露到 health | `app.ts:260,597-600`；`http/health.ts:10,17` |

**显式设置 `legacy` 的位置**
- 本地脚本：`scripts/start-local-api.ps1:2,14,20,54`（默认 `-AgentRuntime mastra`，可传 `legacy`）
- 文档：`docs/mastra-agent-migration-20260913.md:10`（**已过时/反了**，代码默认是 mastra）
- `.env.example`/`.env.local`/Dockerfile/railway/vercel：**无** `LOOMIC_AGENT_RUNTIME`

**绕开解析的入口**：仅 `runtime.ts:607-626` 的默认 legacy factory（测试/脚本注入除外）。`worker.ts`、`http/**`、`ws/**` 均无直接 legacy 实例化。

**结论**：生产已默认 Mastra；legacy 只在显式 `legacy` 或测试注入 `agentFactory` 时启用。

---

## 2. 最高优先级阻塞：模块图污染

**问题**：`mastra-runtime.ts:21` **值导入** `buildImageGenerationModelConstraint` from `./runtime.js`；`runtime.ts:110` **值导入** `deep-agent.js` → `deep-agent.ts` 值导入几乎整棵 legacy 树。
→ 只要加载 Mastra 运行时，就会连带求值整棵 legacy 图。**直接删除 `deep-agent.ts` 会在 import 期打断 Mastra。**

**必做前置（Step 3 之前）**：把 `runtime.ts` 中 Mastra 需要的最小面抽出/断开：
- 抽出到独立模块（建议 `agent/runtime-shared.ts`）：`CreateAgentRuntimeOptions`、`RuntimeRunRecord`、`RoutedRunCreateRequest`、`AgentRunService`、`buildImageGenerationModelConstraint`、`resolveAgentRuntimeMode`、`toMastraRunInput`、状态助手（`mapEventToStatus`/`syncPersistedRunFromEvent`/`toFailedEvent`/`updatePersistedRunStatus`/`updatePersistedRunFailure`）。
- 让 `mastra-runtime.ts` 只导入该共享模块 + `mastra-*`，使 legacy import 全部落在将被删除的 `runtime.ts` legacy 段内。
- 这是“先重构后删除”的必要项，不是可选。

---

## 3. 模块分类表

### 3a. Mastra-required（保留）
`mastra-runtime.ts`、`mastra-agent.ts`、`mastra-toolkit.ts`、`mastra-context.ts`、`mastra-memory-adapter.ts`、`mastra-image-tool.ts`、`mastra-image-jobs.ts`、`mastra-image-execution-policy.ts`、`mastra-image-ratio-state.ts`、`mastra-image-source-grounding.ts`、`mastra-image-status-tools.ts`、`mastra-video-tool.ts`、`mastra-video-jobs.ts`、`mastra-history-attachments.ts`、`mastra-run-types.ts`、`mastra-run-integration.ts`、`mastra-tool-policy.ts`、`context-budget.ts`、`tools/clarification-tool.ts`、`tools/conversation-evidence.ts`

### 3b. SHARED（保留，但注意 legacy 污染）
- 后端工厂（**Mastra 也用**）：`backends/index.ts`、`backends/dev.ts`、`backends/prod.ts`、`backends/skill-snapshot.ts`
- 工具工厂与工具：`tools/index.ts`（共享工厂，**不能整删**）、`tools/inspect-canvas.ts`、`tools/manipulate-canvas.ts`、`tools/project-search.ts`、`tools/design-tools.ts`（读工具保留；写工具 `manipulate_design/apply_design_template/export_design` 被 Mastra 过滤，建议拆读/写）、`tools/design-discovery.ts`、`tools/design-image-target.ts`、`tools/brand-kit.ts`、`tools/screenshot-canvas.ts`、`tools/review-image-results.ts`、`tools/workspace-skill-tools.ts`、`tools/prompt-library-tools.ts`、`tools/video-generate.ts`（Mastra 不构造，但被 `tools/index.ts` 导入）
- `tools/image-generate.ts`：**被 Mastra 值导入**（`mastra-agent.ts:11`、`mastra-image-tool.ts:15`、`mastra-image-jobs.ts:17` 用其类型/助手）→ 需从中抽共享部分，再删 legacy 提案路径
- `image-proposal-sources.ts`、`image-edit-routing.ts`、`related-image-context.ts`、`canvas-scene-index.ts`、`attachment-resolver.ts`、`attachment-vision-analyzer.ts`、`workspace-skills.ts`、`skill-composition.ts`、`workspace-chat-model.ts`、`openai-compatible-chat-model.ts`、`image-result-verification.ts`、`stream-adapter.ts`
- transport（共享）：`design.sync`+`features/realtime/realtime-fanout-service.ts`+`features/designs/design-outbox-service.ts`；`agent.retry_tool`+`features/agent-runs/tool-execution-service.ts`+`agent/tools/read-tool-registry.ts`；`agent.confirm_action`+`features/agent-actions/destructive-confirmation-service.ts`；`canvas.resume`+`ws/event-buffer.ts`；run history+`features/agent-runs/agent-run-service.ts`

### 3c. LEGACY-only（删除）
- 根：`deep-agent.ts`、`context-compaction.ts`、`active-skill-guidance.ts`、`skill-reference-projection.ts`、`deferred-design-task.ts`、`workflow-execution.ts`、`sub-agents.ts`、`result-continuation.ts`、`autonomous-execution.ts`、`design-task-tools.ts`、`design-task-completion.ts`、`design-task-verification.ts`、`intent-context.ts`、`intent-effect-observation.ts`、`intent-write-context.ts`、`intent-write-gate.ts`、`intent-write-middleware.ts`、`expert-model-resolver.ts`、`image-proposal-relation.ts`、`image-failure-receipt.ts`、`image-job-status-query.ts`、`generated-image-source-names.ts`、`image-result-task-marker.ts`、`pending-image-acknowledgement.ts`、`requested-image-review.ts`、`running-image-cancellation.ts`、`runtime-target-observation.ts`、`ambiguous-image-reference.ts`、`canvas-agent-evaluation.ts`、`demand-loaded-tools.ts`
- 子目录：`persistence/*`、`prompts/design-guidance.ts`、`prompts/intent-guidance.ts`、`prompts/loomic-main.ts`、`evals/intent-cases.ts`、`tools/arrange-design-boards.ts`、`tools/autonomous-export-design.ts`、`tools/create-design-boards.ts`、`tools/design-delegation-tools.ts`、`tools/named-image-cancellation.ts`、`tools/workflow-tools.ts`
- 图片提案/确认：`tools/image-generation-confirmation.ts`（Mastra 构造后被过滤）、`tools/completed-image-replay.ts`（被其引用）、`tools/image-confirmation-authorization.ts`（legacy 专属判定；注意其被 `image-generate.ts` 值导入，需先断开）
- `features/agent-tasks/*`：`agent-task-service`、`agent-workflow`、`agent-target-scope-service`、`agent-continuation-*`、`agent-autonomy-*`、`agent-delegation-service`、`agent-design-creation-service`、`agent-autonomy-canvas/export-service`（**逐个确认无 Mastra/worker/frontend 消费者后再删**）

### 3d. 特例/待决
| 项 | 情况 | 建议 |
|---|---|---|
| `mastra-design-tools.ts` + `mastraDesignCreationService` | Mastra 命名但**未被 `mastra-runtime` 消费**；仅测试用 | 删除（画板不再由 agent 控制） |
| `mastra-image-authorization-cases.ts` | 仅测试 | 保留（DB parity 测试用）或随测试迁移 |
| `tools/read-tool-registry.ts` | 被 `app.ts`/`ws` 用于 retry（共享） | **保留** |
| `tools/image-generate.ts` | 同时被 legacy 与 Mastra 值导入 | 抽共享部分后再删 legacy 路径 |
| `evals/intent-cases.ts` | legacy intent 语料 | 随 legacy 删除 |
| `prompts/*` | legacy 系统提示；Mastra 用内嵌 `CONVERSATIONAL_DESIGN_INSTRUCTIONS` | 删除 |

---

## 4. 前端与 transport 消费者

| 能力 | Web 消费者 | Mastra 使用 | 判定 |
|---|---|---|---|
| design task（`designTask` 字段、`/design-task`、`useDesignTask`） | `chat-sidebar.tsx:215-216`、`chat-submission-scope.ts` | **否**（Mastra 不建 task；GET 恒 null） | legacy-only → 迁移/删除 |
| `DesignTaskCard` | 定义但**从未渲染** | 否 | 删除 |
| `taskContinuation`/`nextDeliverable`/`correctionOfRunId` | `chat-sidebar.tsx`、`chat-submission-scope.ts` | 否（透传后丢弃） | 删除（需同步改共享契约） |
| `design.sync` | canvas/design 编辑器 | **是**（fanout/outbox） | **保留** |
| `agent.retry_tool` | `use-websocket`、`chat-sidebar`、`tool-block-view` | **是**（每次 run 写 tool ledger） | **保留** |
| `agent.confirm_action` | 确认 UI | **是**（设计类确认，注入 Mastra） | **保留**（去掉图片确认用法） |
| `canvas.resume` | chat-sidebar | **是**（事件回放） | **保留** |
| run history / `tool_executions` | `run-history-panel`、`agent-run-history` | **是** | **保留** |
| `image_confirmation` 字段 | `chat-sidebar.tsx` | 透传但**从不读取** | legacy-only → 删除 |
| `requiresInlineImageConfirmation` | `clarification-dialog.tsx` | 否（Mastra 不返回 `awaiting_confirmation`） | 删除 |
| `get_image_proposal`/`confirm_image_generation` | 历史渲染 | 否（被 filter） | 删生产端；历史渲染可留可清 |
| `continue-results`/`autonomy` HTTP | 无 | 否（410 tombstone） | 删除 |
| `contextual_image_confirmation`/`semantic_image_confirmation` | 无 | 否 | 删除 |

---

## 5. 共享包（`packages/shared`）

**可删（仅 legacy 消费者）**
- `task-message-routing.ts`（`classifyTaskMessage`）
- `image-confirmation.ts`（`isExplicitImageConfirmationMessage`/`isExplicitImageCancellation`）
- `agent-delegation-contracts.ts`

**模块保留但需裁剪 legacy 导出**
- `contracts.ts`：`designTaskTargetSchema`、`designTaskAuthorizedTargetsSchema`、`designTaskRequestSchema`、`taskContinuationCandidateSchema`，以及 `runCreateRequestSchema` 里的 `designTask`/`taskContinuation`/`nextDeliverable`/`correctionOfRunId`/`imageConfirmation`
- `design-contracts.ts`：保留 `designSyncEventSchema`；审计 task/verification 专用导出
- `agent-collaboration-contracts.ts`：schema 保留（settings 兼容），但唯一运行时读者是 legacy delegation，退役后为 dead config

---

## 6. 数据库（本轮不动 schema）

- 不 drop 表/RPC/trigger/migration 历史；保留 RLS；不把 service-role 权限开放给 `authenticated`。
- 记录“停止写入/无代码调用”的 legacy 对象（legacy 任务表、autonomy 表/RPC、legacy 图片提案 RPC 等），后续单独归档。
- 冻结日期与最后写入版本在 Step 5 完成后补记。

---

## 7. 测试处理

**随 legacy 删除（整组，而非只删失败断言）**——见审计列出的 ~60 个文件，重点：
- `canvas-agent-evaluation.integration.test.ts`（2 个 GraphRecursionError）
- `design-delegation-isolation.integration.test.ts`（1）
- `result-continuation.test.ts`（1）
- `context-*`、`deferred-*`、`intent-*`、`design-task-*`、`runtime-*`（checkpoint/task/design）、`workflow-execution`、`sub-agents`/delegation、`skill-library.integration`（legacy 组合）、`tools/*` 中 legacy 确认/提案相关

**保留并修复（真实漂移）**
- `web/test/login.test.tsx`（Loomic→Cromic 文案）
- `web/test/image-toolbar.test.ts`（放大指令文案）
- `web/test/image-generator-prompt-library.test.ts`
- `web/test/canvas-minimap.test.tsx`（缺 `ToastProvider`）
- `server/generation/providers/apiyi-video.test.ts`（FormData/ReadableStream）
- `server/features/images/outpaint.test.ts`（超时）

**新增 Mastra-only 守卫测试**
- 默认只能是 Mastra；`legacy` 配置启动失败；非法值失败
- 生产依赖图不得 import legacy 目录（可用 import 图断言）
- Skill `requiredTools` 与 Mastra 工具面一致（已有 `mastra-skill-tool-contract`）
- Web 不请求 legacy design-task/confirmation 路由；WS 不发 legacy command

---

## 8. 删除顺序（最小风险）

1. **抽共享面**：从 `runtime.ts`/`image-generate.ts`/`design-tools.ts` 抽出 Mastra 需要的类型/助手到独立模块，断开 `mastra-runtime → runtime → deep-agent` 的 import 链（Step 3）。
2. **冻结入口**：`LOOMIC_AGENT_RUNTIME=legacy` 启动失败；非法值失败；启动日志显示模式（可独立回退）。
3. **前端解除 legacy 依赖**：design task、图片提案确认卡、`requiresInlineImageConfirmation`、`taskContinuation` 等字段的下发。
4. **删服务端 legacy 运行时**：`deep-agent.ts`、legacy 分支、任务/工作流/意图/上下文/持久化、legacy 工具（逐文件，不整目录）。
5. **删 transport 与共享契约**：legacy 路由、WS 命令、`read-tool-registry` 旧项、共享 schema。
6. **删测试 + 补守卫**。
7. **清理依赖与 env 文档**；记录保留的 DB 对象。

---

## 9. 验收门槛（Step 0）

- [x] 每个候选模块有生产可达性证据（本文件 §3）。
- [x] 已分为：可直接删除 / 先迁移再删除 / Mastra 共用必须保留 / DB 历史仅停止访问。
- [x] 明确第一障碍：模块图污染（§2），须先重构。
- [ ] 待人工确认：`features/agent-tasks/*` 中哪些可整删（需逐个确认 worker/frontend 消费者）。

## 10. 需要人类决策的点

1. `features/agent-tasks/*` 的服务：`agent-task-service`、`agent-workflow`、`agent-target-scope-service` 等是否仍有**非 agent** 消费者（前端 `useDesignTask`、HTTP `/design-task`、worker）？——决定“随 legacy 删除”还是“保留但去 agent 绑定”。
2. `agent.confirm_action`（destructive confirmation）：设计类确认保留；图片相关确认 UI 是否清理？
3. `prompts/*` 与 `evals/intent-cases`：确认无产品用途后删除。
4. `mastra-design-tools.ts`：确认画板不再由 agent 创建后删除。

---

## 11. 执行完成记录（Step 7，2026-09-17）

### 代码
- `runtime.ts` 收敛为 Mastra-only；`LOOMIC_AGENT_RUNTIME` 仅允许未设置或 `mastra`，`legacy`/非法值启动即失败（`resolveAgentRuntimeMode`）；health `agentRuntime` 收窄为 `literal("mastra")`。
- 删除整个 legacy DeepAgent 簇：`deep-agent`、`design-task-*`、`intent-*`、`context-compaction`、`active-skill-guidance`、`skill-reference-projection`、`result-continuation`、`autonomous-execution`、`workflow-execution`、`sub-agents`、`deferred-design-task`、`expert-model-resolver`、`persistence/*`、`prompts/*`、`evals/intent-cases`、`mastra-design-tools`、legacy `tools/*`（含 `image-generate` 的确认/提案路径、`image-confirmation-authorization`、`image-generation-confirmation`、`completed-image-replay` 等）。
- 删除未接线的 `features/agent-tasks/*` 服务与路由：autonomy/continuation/delegation/design-creation 系列、`http/agent-autonomy.ts`、`http/agent-continuations.ts`、`/design-task` 路由。**保留** `agent-task-service`、`agent-target-scope-service`、`agent-workflow`、`canvas-result-review`（设计类 destructive confirmation 与 review 工具仍用）。
- 前端移除 design-task / `taskContinuation` / `imageConfirmation` / `requiresInlineImageConfirmation` 及其 hooks/components。
- `packages/shared` 删除 `task-message-routing`、`image-confirmation`、`agent-delegation-contracts`，并裁剪 `contracts.ts` 的 legacy 字段与 health 的 `legacy` 值。
- 新增守卫测试 `apps/server/src/agent/legacy-retired.test.ts`：默认只能 Mastra、legacy/非法值失败、生产依赖图不得再 import 已退役模块。

### 数据库（本轮不 drop schema，历史数据保留）
- **停止写入 / 无代码调用**（可后续离线归档）：
  - `langgraph.checkpoints`、`langgraph.checkpoint_writes`、`langgraph.checkpoint_blobs`、`langgraph.store`（及各自 `*_migrations`、`langgraph.update_updated_at_column`）。
  - `public.agent_design_tasks`、`agent_design_task_runs`、`agent_design_task_jobs`。
  - `public.agent_task_autonomy`、`agent_task_continuations`、`agent_task_target_scopes`。
  - `public.agent_autonomy_preferences`、`agent_autonomy_image_leases`、`agent_autonomy_tool_leases`、`agent_autonomy_canvas_arrangements`、`agent_autonomy_exports`。
  - `public.agent_delegations`、`agent_design_creation_batches`。
  - `public.image_proposal_turn_relations`、`image_contextual_confirmation_bindings`、`design_agent_tool_requests`。
  - RPC/助手：`loomic_propose_image`、`loomic_decide_current_image`、`loomic_get_current_image_proposal`、`loomic_get_image_proposal_relation_context`、`loomic_get_semantic_image_confirmation_review`、`loomic_record_image_proposal_turn_relations`、`loomic_bind_reviewed_semantic_image_confirmation`、`loomic_agent_task_update_brief`、`loomic_agent_task_update_workflow`、`loomic_agent_design_mutate`、`loomic_agent_design_context_workspace`、`loomic_agent_task_bind_job`、`loomic_agent_task_guard_design_version`、`loomic_validate_agent_design_version`、`loomic_record_agent_continuation`、`loomic_supersede_continuations_on_new_run`、`private.loomic_is_image_*`、`private.loomic_named_image_confirmation_scope`、`private.loomic_image_turn_preserves_proposal`。
- **保留并继续使用**：`public.agent_runs`（run history）、`public.agent_run_context_snapshots` + `loomic_agent_context_capture`（Mastra 上下文）、`public.agent_action_confirmations` + `loomic_create_agent_action_confirmation` / `loomic_claim_agent_action_confirmation`（设计类 durable confirmation）、agent-collaboration settings（`loomic_valid_agent_collaboration`、`loomic_validate_agent_role_models`）。
- 迁移文件与历史数据**不删除**，无需回滚；冻结日期 **2026-09-17**，Mastra-only 为最后写入版本。
