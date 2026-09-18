# 主 / 子 Agent 与专用分层实施记录

## 本轮范围

按用户选择只推进此前规划第 1 项（主 / 子 Agent）与第 3 项（专用分层），不增加知识库、文档导入、向量库、个人或项目长期记忆管理，不迁移到 Mastra。沿用现有 DeepAgents 1.13.2 / LangGraph。

结果必须区分：**主 / 子 Agent 已接通并通过真实模型验收；Qwen 专用分层已接入协议、队列和 UI，但模型尚未部署、真实分层质量尚未验收。** 不应把这两种状态都描述为已经可直接生产使用。

## 主 / 子 Agent

- 主 Agent 自行决定是否委派；简单修改不强制多 Agent。本轮专家只对已有、已授权的设计任务开放。
- 三个角色：参考分析 `reference_analysis`、设计规划 `design_planning`、设计审查 `design_review`。
- 受控工具 `delegate_design_tasks` 每批 1–3 个任务，配套 `get_design_delegations` 读取持久结果。没有新通用任意子 Agent 入口。
- 实际 DeepAgents 构造中移除自动通用 `task` 工具；已用真实图执行及无网络模型测试确认伪造 `general-purpose` 调用不能绕过。
- 专家运行独立 LangChain Agent，工具为空，不继承父运行的凭据配置、文件系统、持久记忆、checkpoint 或递归委派。只读当前任务/纠正、设计结构、已有附件分析和启用的 Skill 内容快照，返回公开建议。
- 专家不直接修改设计或发起生图。主 Agent 是这些专家结果的唯一执行者，继续经过原有目标限定、原子版本校验和保存/预览校验。
- 没有当前图像证据的专家不能宣称完成视觉验收。结构分析与真正看图验收不是同一件事。
- 每轮默认并发 2、总任务数 6、单任务 90 秒；管理员可调整到并发 1–3、任务数 1–8、超时 10–120 秒。专家输出上限 3000 tokens，不自动进行模型失败重试。这是运行上限，不是精确货币预算或平台计费方案。
- 工作区设置可为三个角色各自选择已启用文本模型，或跟随主 Agent。独立模型使用绑定委派/角色/工作区的不可变凭据快照；终态销毁临时凭据，前端与工具结果不返回凭据。
- 设置以分区 partial PUT 保存，修改子模型不覆盖主模型，修改主模型不覆盖子模型。失效选择保留并提示；可以关闭协作，重新启用时重新检查模型。
- 协作分区必须完整提交，拒绝只有 `enabled` 等字段的嵌套半对象，避免 schema 默认值清空专家选择；合法模型 UUID 在入口规范为小写，避免“保存成功但执行不匹配”。这两项由独立代码复查发现并补了回归测试。
- 需求纠正、目标或设计版本变动、撤权、取消、超时都会阻止失效建议继续落入设计；请求键复用只读既有记录，不重复发起专家推理。已发出的远程请求不承诺一定能停止计费。
- 持久记录保存任务版本、对象目标、父工具调用、模型、Skill 版本与内容 hash、公开结论和状态。界面可展开查看，明确“分析已返回”不等于“画板已交付”。

目前没有新增任意用户自定义 Agent 创建器、知识库访问、跨项目自主写入或无限递归协作。并发限制是每轮，不是全平台跨会话限流；文本模型供应商费用也未新增独立账单产品。

## 多用户权限验收与修正

真实验收发现：`agent_runs` 是私有运行记录，没有用户 SELECT 策略；直接从子任务 RLS 查询它，会导致**其他用户看不到，本人也看不到**。新增独立 08 迁移，通过窄范围的 definer 判定重新核对运行创建者及当前项目/工作区权限，修复本人读取；没有开放整个 `agent_runs` 表。

数据库验收使用真实 PostgreSQL、Vault 与 RLS，在完整事务内创建合成用户/工作区/运行/模型并回滚，覆盖本人可读、跨租户拒绝、模型快照冻结、凭据销毁、重放、不合法配置、失效模型仍能关闭、纠正失效。仅证明这些已列出的边界，不承诺所有未来异常已穷尽。

可重复数据库校验：`node scripts/test-agent-collaboration-local.mjs`。迁移脚本 `node scripts/apply-local-agent-collaboration.mjs` 默认只读预检，传 `--apply` 才对固定本地副本应用未登记迁移；不会修改云端环境。

本地副本已应用的新迁移：

- `20260909000005_agent_collaboration_settings.sql`
- `20260909000006_agent_delegations.sql`
- `20260909000007_expert_model_snapshots.sql`
- `20260909000008_collaboration_read_and_disable.sql`

这些迁移已登记且不可原地修改。未操作远程数据库或用户原画板。

## 真实模型闭环证据

测试：`apps/web/e2e/design-task-steering-local.spec.ts` 中 `real LLM coordinates parallel read-only experts and the main agent saves the targeted edit`，显式 `LOOMIC_DESIGN_EXPERT_LIVE=true`，未拦截或伪造模型结果。

成功运行：`cc6d3f4b-4164-41d0-8014-5d8930d875f1`。

数据库记录两个专家开始时间分别为 `2026-09-08T19:46:58.333899Z`、`2026-09-08T19:46:58.333873Z`，结束时间约 `19:47:03.68Z`，确实重叠运行。实际模型为 `apiyi:gemini-3.1-flash-lite`（本轮跟随主模型），两个专家均返回结论。

主 Agent 随后只将测试标题 `SUMMER PREVIEW` 修改为 `AUTUMN STUDIO`；确认字体、字号、位置、颜色、副标题、背景、尺寸、对象 ID 及另一个画板不变。保存文档 revision 2、预览 revision 2，刷新后像素和保存结构一致。该次验证为文本替换及结构/保存校验，不把专家建议中的字号单位等文字表述当成产品事实。未创建图片或视频生成任务。

证据目录：`apps/web/test-results/experts-agent-live/design-task-steering-local-edca9-ent-saves-the-targeted-edit-chromium/`，包含 `actual-expert-collaboration.json`、`actual-experts-saved-reloaded.png`。测试项目通过正常删除项目接口**归档**，并非物理删除；用户原画板没有修改。

重跑方式（会调用现有文本模型，可能产生供应商费用）：

```powershell
$env:LOOMIC_E2E_EXTERNAL_STACK='true'
$env:LOOMIC_E2E_BASE_URL='http://localhost:3020'
$env:LOOMIC_E2E_SERVER_URL='http://127.0.0.1:3002'
$env:LOOMIC_DESIGN_EXPERT_LIVE='true'
$env:LOOMIC_CLEANUP_SKILL_QA='true'
# cwd: apps/web
node --env-file=../../artifacts/local-replica-20260907/app.env node_modules/@playwright/test/cli.js test e2e/design-task-steering-local.spec.ts -g 'coordinates parallel' --output=./test-results/experts-agent-live
```

## 专用分层：接入完成，模型待部署

图片工具栏与画板图片工具增加明确的 **Qwen 专用分层**。原本地分层仍默认可用，精确 `gpt-image-2` 去背景不变。没有恢复已移除的抠图预览弹窗。

- 只有显式 `model: qwen-image-layered` 才进入新后端；健康检查未配置/错误即禁用或拒绝，不静默退回普通抠图或生图。
- 原图、任务 ID、模型标识、层序、PNG alpha、非空层、重复层、尺寸与累计大小都校验。
- 持久化完整分层包后再写独立私有图层资产，后续保存/签名失败可复用既有结果；相同 job ID 可重发网络请求，但兼容后端必须保证不重复推理。
- 附本地权重 Sidecar，只读取明确的本地模型路径，不自动安装依赖、下载权重或退回 CPU。
- 当前电脑为 AMD 集显，未发现 CUDA 独显；没有 Qwen 权重，现有工作区供应商目录也没有该专用模型。因此未运行真实 Qwen 推理、未外发用户图，不能报告真实效果或性能。
- Qwen 输出 RGBA 位图层，不恢复原始 PSD 文本对象、字体或保证像素级无损。[官方模型卡](https://huggingface.co/Qwen/Qwen-Image-Layered)
- 未配置专用供应商费率；站内记录 0 积分不代表远程算力免费。界面已明确可能产生外部服务费用。

详细配置与协议见 [专用分层后端](./qwen-layer-backend.md)。要继续真实效果验收，需用户确定兼容分层服务地址或可部署模型的 GPU 主机；不能把公共演示页当作稳定生产 API。

## 最终回归与界面验收

| 检查 | 结果与边界 |
| --- | --- |
| 服务端全量单测 | 147 个测试文件、893 项通过；包含新委派、权限、模型解析和分层协议用例 |
| 共享协议单测 | 9 个测试文件、122 项通过 |
| 前端相关回归 | 首轮 9 个测试文件、100 项通过；最终安全 Markdown 与模型提示修正后，43 项相关回归通过 |
| Python 分层 Sidecar | 6 项通过；合成协议验收，不是真实 Qwen 推理 |
| TypeScript | 服务端、前端均通过 |
| 真实模型端到端 | 53.5 秒通过；两位专家实际并行，主 Agent 精确改字、保存及刷新恢复 |
| 最终只读浏览器验收 | 11.0 秒通过；两个角色卡片展开及刷新恢复，设置保持不变，没有写请求或新增模型调用 |

最终只读 UI 证据目录：`apps/web/test-results/experts-ui-read-only/agent-collaboration-read-l-3db41-r-backend-without-mutations-chromium/`。其中 `expert-ui-read-only-evidence.json` 记录 `cardsVerified=true`、`settingsUnchanged=true`、`blockedMutations=[]`、`agentRunRequests=[]`、`actualModelCalls=0`，Qwen 后端 `configured=false`、`available=false`。四张截图逐张检查，公开结论使用受限 Markdown 展示，不自动载入外链图片或 HTML。该只读验收复查上节的真实运行，不将它当作另一轮真实模型执行。

## 知识库为何暂不做

多用户只是权限架构要求，不是必须有知识库的理由。临时生图、改图、抠图优先做好工具可靠性、意图和纠正；现有品牌套件可以先承接固定颜色/字体等规则。只有用户经常围绕同一品牌、商品、客户资料协作时，版本化知识库的复用和来源追溯才明显有价值。以后也应该按账号/团队/项目隔离，而不是把所有用户资料混成一个库。
