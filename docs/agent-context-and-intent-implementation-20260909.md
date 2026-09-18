# Agent 上下文与 Skills 调用边界：实施与验收

日期：2026-09-09。范围：落实联合设计的第一版工程闭环；沿用 DeepAgents / LangGraph，不迁移框架，不增加企业知识库，不切换现有模型。

## 实施结果

### 1. 模型容量与发送预算

- 供应商模型可配置总窗口、输入上限、输出上限、验证来源、验证日期及版本。配置随主 Agent / 专家执行快照冻结，后续修改供应商不能改变在途调用的限制。
- 供应商设置中的文本模型新增「上下文容量」。未填写时明确显示「未验证」，不按 Gemini / DeepSeek / OpenAI 等名称猜测实际接入能力。修改上游模型 ID 或类型会清除旧容量配置。
- 环境接入可用 `LOOMIC_MODEL_CONTEXT_PROFILES_JSON` 按完整模型引用提供验证配置；没有改动现有环境配置。
- 估算包括中文、图片以及实际发往供应商的工具 JSON schema。估算不是精确 tokenizer；真实 usage 缺失时记为 `null`，不伪造为零。
- 发送前检查位于模型适配器，覆盖主 Agent、专家、安全摘要及使用该适配器的视觉调用；同时约束实际请求的输出字段。预算超限不静默截断用户原文。

| 接入状态 | 应用工作窗口 | 整理阈值 | 整理目标 | 输入硬上限 | 生成预留 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 容量未验证 | 64,000 | 24,000 | 16,000 | 40,000 | 8,000 |
| 已验证 128K，且输入/输出限制足够 | 128,000 | 48,000 | 32,000 | 80,000 | 16,000 |

数字为 Loomic 的保守起始策略，不是当前供应商的实际容量或 OpenAI 强制标准。较小的已验证输入/输出限制会进一步调整预算；更大窗口不会默认无限扩大工作包。

### 2. 用户意图优先于 Skills

- 每次模型调用重新读取当前任务和成员权限，注入来源化工作包：用户 goal / 纠正原文、目标、约束、模型 brief、执行版本分开存放。
- 用户不需要额外说「严格按我的要求」。Skill、案例、视觉分析、专家提案和历史摘要都是方法建议或证据，不能自行扩大目标、修改准确文案或恢复批准。
- 移除「所有生图/编辑都必须先读取专业 Skill」的强制条件；简单、明确的编辑可以直接使用确定性工具。
- 对可确定的局部改字/改填充色增加服务端字段和准确值检查，未定位唯一目标时拒绝猜测后写入。任务、对象范围、版本、付费方案和幂等保护继续沿用现有服务。
- 专家接收同源意图包，Skill 正文不再升级为系统权限。预算不够时明确省略整个 Skill，不截半篇冒充完整读取。
- 生图节点保留用户输入的首尾空格、换行和标点；空白校验不再改写实际提交文本。端点不支持节点参考图时明确阻止，不静默忽略已保存的参考图。

边界说明：确定性字段锁目前是小范围、完整句式的规则，不是覆盖所有自然语言的语义分类器。复杂请求仍由模型理解，受目标/版本/批准等服务端保护，不能宣称所有语义偏离都可被程序百分之百识别。

### 3. 长对话整理、原文回读与恢复

- 用应用控制的同名 middleware 接管 DeepAgents 默认整理入口；不再依赖未知模型的通用大阈值。旧 `_summarizationEvent` 不作为新的裁剪依据。
- 当前原话、有效意图包、完整最近工具调用/结果配对保留。普通会话保留用户原文；绑定设计任务的旧过程可以在当前用户证据独立钉住后整理。
- 超过软阈值时，使用当前冻结模型做独立、无工具、无自动重试的有界摘要：每块估算不超过 16K，最多 3 次，每次输出最多 1,500 tokens。
- 摘要只保留公开事实、未完成事项及可核对的来源 ID；统计遗漏和摘录，去掉图片字节及显式内部推理块。摘要期间用户纠正、撤权或来源变化会使旧工作包失效。
- 保存摘要、完整来源 hash、公开意图包、预算与可用 usage；缓存绑定授权范围、任务链、来源水位、模型及预算版本。用 CAS 防止旧摘要或迟到遥测覆盖新工作包。
- 新增只读 `read_conversation_evidence`，按当前会话权限分页回读原消息和附件元数据。工具不返回凭据或通用资产访问权。
- checkpoint 缺失/不兼容时，取消恢复最后 30 条的机械截断，从持久聊天及有权限的摘要重建。短恢复包不再覆盖历史工具事实摘要。
- 删除或编辑原消息、附件失效会增加 `historyEpoch`。每次运行校验 checkpoint 的 epoch；不匹配时重建缓存。模型/摘要/工具执行前后也检查，防止删除内容从旧缓存再次进入模型或新摘要。

来源限制：摘要里的 graph message IDs 不冒充数据库聊天 ID。原聊天文本可直接回查；完整工具历史仍依赖 graph checkpoint，并未新增通用工具产物归档检索系统。缓存重建后不能凭摘要推断批准、成功执行或已删除附件的视觉内容。

### 4. 失败与纠正

- 上下文超限、摘要失败、工作包冲突及模型配置异常显示具体中文原因；已有部分回答时也显示错误，刷新运行历史后原因仍可读。
- 沿用 `run.failed` 事件，通过 `details.reasonCode` 区分原因；不会自动重试付费生成或切换模型。
- 内部摘要的文本、推理、工具和错误事件不会混入用户聊天。
- 请求日志只记录安全路径，URL 查询参数和认证头脱敏，包括 Fastify 404 消息中的 URL；不改变原请求的鉴权数据。本轮生成的旧 API 日志已做 JWT 脱敏，不回写或删除其他历史日志。
- 来源删除只能阻止后续使用，不能撤回已发送给供应商的数据或已开始的付费请求。

## 数据库与部署

仅应用到固定本地副本 `loomic_replica_light_20260907`，未部署外部生产环境。

| 迁移 | 内容 | SHA-256 |
| --- | --- | --- |
| 20260909000009 | 私有上下文快照、来源水位、权限与 CAS、原文回查 | `b713fd77d0b7ad8c499754889cd42ca4b29bb60a7229bb8a5f19def7f246dccc` |
| 20260909000010 | 模型容量配置及运行/专家冻结快照 | `d726e144856ebf55bd8193cb302fd7f529848ea50bdfc6b101d1d6f1a54b5524` |
| 20260909000011 | 原文/附件删除后的 checkpoint 失效代次 | `f9a7a81ffb33dd9c1acdf2e2f7d1b7cfc0a268e28fe9f8e387ecece45139c8f5` |

应用脚本：`node scripts/apply-local-agent-context.mjs --apply`。默认不带参数只预检。本地 API 已在确认无进行中 Agent 运行后重新启动，前端仍使用 3020 开发服务。原画板、素材、模型选择及凭据没有改动；兼容恢复仅重建内部 graph 缓存，不删除持久聊天原文。

## 验收证据

- 共享契约：146 项通过，包含容量字段严格校验。
- 服务端全量：1,101 项通过；机器报告：`artifacts/context-server-tests-20260909.json`。随后请求日志脱敏按独立定向回归补验。
- 日志补验：6 项真实 Fastify 内存日志测试通过，包含编码/重复查询参数、认证头、子日志、404；服务端类型检查再次通过。
- 前端全量单元测试：96 文件 / 539 项通过。
- 真实 DeepAgent 执行图 + MemorySaver：110 轮中文历史自动整理、原文钉住、公开意图快照、epoch 持久化及失效重建通过；使用离线脚本模型，无网络付费调用。
- PostgreSQL 事务回滚验收：跨租户/会话、成员撤权、来源变更、同版本 brief 修改、CAS、冻结配置、非法容量、消息/附件删除与 epoch 防回退均通过。没有读取 Vault 凭据。
- 已通过真实本地 PostgREST 对当前用户授权运行的只读 `capture` 验证，确认新接口返回有效 `historyEpoch` 和 `reload_live_authority`，零写入、零模型调用。
- 服务端与前端最终 TypeScript 检查通过，共享契约构建通过。
- 浏览器设置页只读验收通过（1 项）：真实本地 API、真实 Chrome，检查未知容量提示和输入字段、设置前后一致、无 API 写入、无 Agent 运行、无页面错误。已目视检查截图 `apps/web/test-results/playwright/context-settings-read-loca-ddcb2-pacity-or-changing-settings-chromium/context-capacity-controls.png`。

初次前端全量运行误把 Playwright 文件交给 Vitest，产生 runner 错误；改为 `vitest run test` 后真实单元测试全部通过。首次浏览器测试在 API 尚未启动完成时连接失败，健康检查后复跑通过；同时修正测试请求异常的日志脱敏，避免测试框架输出临时认证头。初期类型检查发现 optional 类型与测试接口问题，修正后复验通过。这些早期失败不计为通过。

可复跑的主要命令：

```powershell
pnpm --filter @loomic/shared build
pnpm --filter @loomic/shared test
pnpm --filter @loomic/server exec vitest run
pnpm --filter @loomic/server typecheck
pnpm --filter @loomic/web exec vitest run test
pnpm --filter @loomic/web typecheck
node scripts/test-agent-context-local.mjs
node scripts/test-model-context-local.mjs
```

浏览器脚本 `apps/web/e2e/context-settings-read-local.spec.ts` 仅在明确启用本地只读验收时执行，使用本地环境文件加载认证配置，不应在终端输出环境或密钥。

## 尚未声称完成的验证

本轮没有真实付费生图，也未评测当前供应商在 128K 下的真实成功率、延迟和费用。当前模型容量仍未验证；工程预算不等于升级了模型窗口。

新增的语义摘要会产生当前文本模型的推理费用（有界调用、无隐藏重试），不是免费或无损记忆。下一步应在用户确认的测试预算内，用固定真实任务集测长会话的意图保持、视觉质量、摘要准确率和成本，再校准预算。未新增企业文档知识库、跨项目个人记忆、通用向量检索或独立 tokenizer。

本次按 OpenAI Docs 核对「窗口/输出限制分开管理、压缩不替代授权状态、结合上下文遵守用户意图」的原则；采用的是兼容接口上的应用层实现，不是声称已接入 OpenAI Responses 的原生 compaction。

- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state#managing-the-context-window)
- [Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [Model guidance](https://developers.openai.com/api/docs/guides/latest-model#initiative-and-follow-through)
