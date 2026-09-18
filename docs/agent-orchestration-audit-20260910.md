# Agent 编排审计（2026-09-10）

## 结论与范围

当前不宜宣称完整智能闭环。主要问题不是缺少更多 Skill 或更多 Agent，而是对话语义、持久方案、确认和任务执行之间缺少一致的交付物身份绑定。

本次为只读审计：检查主运行入口、确认与生成、上下文/工具/接续路径、测试和已有真实模型报告；读取用户指定会话的必要文本与方案字段。未调用收费模型、未重跑生图、未修改生产逻辑或画布。不是每个供应商、每个工具和所有并发时序的全面验收。

## 官方参考与项目推导

- [Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration)：区分主控调用专家与转交会话；只有职责或工具边界确实需要时才拆代理。本项目宜由一个主控保持任务与用户沟通的一致性，专家只处理有界子任务。
- [Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)：自动校验与人工批准职责不同。本项目应让模型解析语义，但由服务端校验具体动作、版本、目标和授权；不能把识别到确认词等同于批准任意历史方案。
- [Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals)：基于完整执行轨迹诊断工具选择和流程，再建立可重复评测。仅通过组件单测，不证明用户任务执行成功。

上述是官方工程指导。下文的字段、状态机和验收方案是针对本项目的设计建议，不是 OpenAI 强制要求，也不要求迁移现有框架。

## F1 / P1：确认绑定了会话最后方案，而非当前交付物

证据：

- `apps/server/src/agent/runtime.ts:2035-2059`：普通确认语句走快捷分支，`store.latest` 的 ID 直接作为确认目标。
- `apps/server/src/features/agent-actions/image-proposal-store.ts:95-104`：按 session、created_by、created_at 查最后方案；没有当前交付物/需求版本条件。
- `apps/server/src/agent/tools/image-generate.ts:949-961`：同轮接续也可能优先确认已有方案。

真实会话 `940093d9-5dda-4479-8366-d6ce698090a9`（以下 UTC）：

| 时间 | 事件 |
| --- | --- |
| 10:31:59 | 宣传图方案 af4d66be-6c36-46bb-930a-4e0385196989 保存，后完成 |
| 10:39:19 | 用户：再继续生成一张落地页 |
| 10:39:26 | 助手描述沿用 aaa.com 品牌的落地页，询问确认 |
| 10:39:34 / 10:39:48 | 用户两次确认，返回旧生成结果 |

数据库没有对应落地页方案。这里是同一品牌设计任务下的下一项交付物，不应清空上下文；同时也不能把上一张图的幂等重放当作下一项的生成。

整改：引入 task → deliverable → proposal revision → execution 的明确关联。重复确认同一方案才重放原任务；新增落地页创建新的交付物，继承适用的品牌事实与引用素材。确认应绑定正在讨论的已展示方案，不能仅凭 latest 推断。

## F2 / P1：助手口头方案与持久化方案脱节

`apps/server/src/agent/prompts/loomic-main.ts:107-108` 已要求先冻结方案再询问确认，但真实对话没有做到。提示词约定没有形成可验证的输出状态。

整改：询问执行确认必须有相应的已保存方案与版本。将方案说明和绑定信息作为同一次状态转换发布；若模型遗漏工具调用，应由主控修复计划并核验，而不是展示无法准确执行的确认。已有自然语言方案恢复时需确认其来源和当前性，不得借恢复扩大用户授权。

## F3 / P1：可恢复确认错误没有接回主控

`apps/server/src/agent/tools/image-generation-confirmation.ts:75-90` 在比例变化时返回可处理错误，要求重新准备方案；`apps/server/src/agent/runtime.ts:2129-2172` 对该快捷路径仍记录工具完成并结束 run，没有进入普通 Agent 循环处理下一步。

整改：区分 submitted、replayed、needs_replan、needs_clarification、terminal_failure 等结果。可恢复错误交回主控处理同一交付物；不能在失败后偷偷提交收费替代任务。run 正常结束与用户任务成功应分别记录。

## F4 / P2：确认词规则不能替代对话指代解析

`apps/server/src/agent/tools/image-confirmation-authorization.ts:8-12` 使用固定语句识别。严格费用校验应保留，但它只能表示本轮有批准意图，无法证明批准对象。当前既可能把正确确认指向旧方案，也会要求用户重复特定措辞。

整改：结合最近实际问题、当前方案和用户最新修改解析确认/补充/纠正/新增交付物；最终授权仍由服务端绑定到具体方案版本。歧义时短问一次，不通过宽松正则把所有“好的”变成付费授权。

## F5 / P1 验收缺口：缺少当前版本的连续任务成功证据

本次安全复跑：

```text
pnpm --filter @loomic/server exec vitest run src/agent/evals/intent-cases.test.ts src/agent/tools/image-confirmation-continuation.test.ts
2 files passed; 65 tests passed
```

- `intent-cases.test.ts:13-33,66-70` 使用由期望值构造的 witness 检查评分器契约，不是让模型执行任务。
- `image-confirmation-continuation.test.ts:202-216` 覆盖已有 pending 方案确认，没有证明前一个交付物完成后新增落地页的路径正确。
- `apps/server/scripts/evaluate-intent-understanding.ts` 是真实模型语义诊断，但不执行工具。
- `apps/server/scripts/evaluate-intent-tool-routing.ts:36` 明确是首次工具选择，不是端到端。

已有报告（历史快照，不代表当前代码或全部模型能力）：

| 报告 | 结果 | 范围 |
| --- | --- | --- |
| artifacts/intent-understanding-20260909/baseline-dev.json | 9/24 | 合成语义诊断 |
| optimized-dev.json | 11/24 | 合成语义诊断，0 调用错误 |
| holdout.json | 2/8 | 含 2 项调用错误 |
| tool-routing-final.json | 7/8 | 仅第一次工具选择 |

这些报告记录模型为 apiyi:gemini-3.1-flash-lite。不能将老报告套到当前配置，也不能用新单测全绿掩盖未验收的多轮流程。

## 补充：上下文、接续与隔离审计

### F6 / P1：新交付物和新任务的边界没有独立表示

`packages/shared/src/task-message-routing.ts:16-22` 先识别新画板/海报，再识别延续。例：“再做一张同一品牌海报”走 fresh_canvas；而“再继续生成一张落地页”因“继续”走 followup。两个都可能是同一品牌任务的下一项交付物，但路由只有 followup/fresh_task/fresh_canvas/chat。

`apps/web/src/components/chat-sidebar.tsx:1052-1084` 对不同路由的目标绑定及附件继承不同；`supabase/migrations/20260908000007_agent_design_task_intent.sql:124-131` 在无 correctionOfRunId 的任务更新时替换 goal、清空 corrections 与 brief。代码表明连续设计需求存在丢失持久约束的路径；不代表所有历史聊天都被清空，也不代表品牌库记录丢失。

整改：分别判断“新增交付物还是修改现有交付物”和“继承哪些用户约束”。不靠扩充落地页关键词解决一般语义问题；不将新对象创建等同于新业务任务。

### F7 / P2，待时序复现：停止与工作流状态回写的竞争

`apps/server/src/features/agent-tasks/agent-continuation-runner.ts:29,66-75,94` 在 claim 后、模型前的停止检查前写入 job_finished；`agent-workflow.ts:654-702` 接受 canceled 步骤的完成事件，并可能设为 running 以等待检查。需要复现“claim → 用户停止 → job_finished”顺序。

记录真实已完成产物本身可以合理，但不应把用户已经停止的自动流程恢复为运行态。建议分离产物事实与执行授权，并用原子停止/租约检查保护工作流迁移。本次未证明停止后会新增收费任务。

### F8 / P1，条件风险：filesystem 模式的 workspace 根目录未按用户/画布隔离

`apps/server/src/agent/backends/dev.ts:28-37,64-76` 接收 canvasId 但 workspace 路由仍使用共享 agentFilesRoot。多用户启用此模式时存在跨任务文件读取风险。生产 StoreBackend 有画布命名空间。

本次检查本地 env 文件配置为 `LOOMIC_AGENT_BACKEND_MODE=state`，因此不将此项描述为当前已发生的数据泄露；没有读取跨用户文件做证明。上线应禁用多租户 filesystem 模式，或先实现服务端隔离。

### 未采纳为已确认缺陷的疑点

按需工具选择使用最后一条 HumanMessage 的 id/content 计算轮次键。进一步检查确认 LangGraph messagesStateReducer 会给缺少 ID 的消息分配 UUID，因此排除“相同文字必然导致跨轮工具泄漏”的推断，不作为本次缺陷。

## 建议实施顺序（汇总）

1. 先统一交付物、方案版本和确认绑定，修复 F1/F2；不删除幂等机制。
2. 统一可恢复工具错误的回环与终止状态，修复 F3；避免重复付费。
3. 用结构化上下文区分品牌长期约束、本次交付物、用户最新修改与历史输出；模型负责解释自然语言，程序负责权限与一致性。
4. 在隔离测试空间跑真实多轮文本编排，执行工具使用可控替身；通过后再做少量真实收费链路验收。不要直接用用户原画布当测试场。

## 必须验收的场景

| 场景 | 必须满足 |
| --- | --- |
| Logo → 宣传图 → 落地页 | 继承品牌与真实素材；每个新交付物独立方案和任务；不复用旧结果冒充新图 |
| “继续”“再做一张”“按上面的” | 按最近目标解析；对象确实歧义才询问 |
| “文字不变，只改横版” | 只改变指定条件；已有事实不丢失；旧确认不可执行新版本 |
| 连点确认、断线重连 | 同一批准最多一次收费提交 |
| 修改比例后确认 | 自动回到可恢复流程；不无限重复提示，也不擅自花费 |
| 压缩后继续上一任务 | 保留最新用户约束、素材 ID、当前交付物和执行状态 |
| 供应商终态失败/放置失败 | 明确停止或恢复已有产物；不冒充成功、不重复生图 |
| 新对话/切换目标 | 不错误继承另一任务的批准、文案或目标 |

验收必须核对实际工具轨迹、持久状态、提交次数和画布产物，而不只检查最终回复是否好听。

## 审计分工

- 主控：官方文档对照、真实会话核对、测试及历史评测核验、交叉复核与报告。
- gpt-5.6-sol / high（audit_confirmation）：确认、幂等、任务与交付物绑定。
- gpt-5.6-sol / high（audit_context_loop）：上下文、工具选择、自动接续和条件隔离风险。
- 计划中的 gpt-5.6-luna / medium 未启动成功（平台线程上限）；测试审计由主控完成，不计为实际参与。
