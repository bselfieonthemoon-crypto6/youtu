# 可纠正设计 Agent：完整纵向样板与验收

验收日期：2026-09-09（本地测试副本，Web 3020 / API 3002）。

结论：本报告定义的纵向样板已实施；237 项相关自动化测试通过，并完成真实模型自主排版、执行中纠正、实际数据库竞争和浏览器刷新验收。下文分别注明实测覆盖与未覆盖边界，不以此承诺整个 SaaS 或模型输出永远无误。

## 本次交付的边界

这次实现的是一条可实际使用的纵向链路，不是把全部 SaaS 架构重写一遍：

用户选择画板或独立图片 → 持久化目标与需求版本 → Agent 读取真实状态、整理结构化需求 → 自主选择已有 Skill / 工具 → 执行中可补充或纠正 → 拦截旧任务写入 → 核验保存和预览 → 刷新恢复需求。

未迁移到 Mastra；继续复用现有 DeepAgents/LangGraph、工具、Skill、任务队列、设计文档和预览服务。没有将长期记忆、知识库、任意子 Agent DAG、商业计费架构的全部规划算作已交付。

## 可以如何体验

1. 打开/选中一张画板，向 Agent 提出具体设计要求。单张独立图片也可作为绑定目标。
2. 「当前需求」卡展示目标、保留项、调整项和完成标准。确有关键歧义才提问，不再强制通用问卷。
3. 执行中继续输入补充要求并发送。默认继续原目标；任意点击其他元素不会偷偷改掉任务目标。
4. 要更换目标，先选择新对象，点击「改用当前选中对象」，再发送纠正；发送前可撤销这次目标选择。
5. 完成后卡片展示实际核验的文档/预览版本，明确区分视觉已检查、未检查和检查不可用。刷新后可恢复持久化需求。

## 已实现的确定性保护

| 机制 | 具体实现 |
| --- | --- |
| 意图持久化 | `agent_design_tasks` 保存目标、原始需求、纠正记录、当前运行和版本；运行快照不可变 |
| 接收先落库 | HTTP 202 / WebSocket ACK 之前完成鉴权与目标校验、创建任务版本；失败不启动 Agent |
| 纠正不串线 | 先原子推进需求版本，再取消旧运行；每个版本单独的图检查点；前端隔离旧运行事件 |
| 修改前有需求 | 工具中间件要求结构化 brief；存在待回答问题时禁止写操作 |
| 专业操作先读 Skill | 排版/样式、创建对象、生图和模板操作，在存在启用 Skill 时要求先实际读取一个启用 Skill；模型自主选用，简单改字/移动可直达 |
| 目标绑定 | 明确区分画板和独立图片；禁止越界画板、裸画布操作和视频生成；独立图片绑定真实原图资产 |
| 提交时再检查 | 数据库锁将需求纠正与设计/图片落地串行化，不只做执行前检查 |
| 迟到结果 | 旧需求的生成结果不插入当前画布；已成功生成的资产保留在任务结果中，不伪装成生成失败 |
| 结果核验 | `verify_design_result` 重读服务端文档并检查预览版本；视觉检查读取实际渲染图，核验期间变更使旧结论失效 |
| 不把空操作当完成 | 相同值的修改不提交、不增加版本；核验比较本轮开始时的真实场景，忽略 objectVersion 后无变化会明确警告 |
| 最终回答再验收 | 专业画板操作的最终回答前，再通过原用户权限读取当前文档/预览，必须与核验版本一致；不能拿修改前的核验放行修改后的结果 |
| 有限修复闭环 | 未产生变化、核验过期或存在客观视觉问题时最多补救两次；仍不满足则明确失败，不继续无限重试；不释放被拒绝的“已完成”文本 |
| 客观视觉与审美分离 | 专用结果核验返回客观问题、可选建议、无法确认三类；只传明确需求和真实文档属性，禁止把上轮评审意见当成新需求反复回灌 |
| 原确认边界 | 既有图片付费确认仍保留，不因自主执行或 Skill 而自动扩大付费权限 |

## 真实模型验收：执行中纠正

使用当前配置的 `apiyi:gemini-3.1-flash-lite`，没有拦截模型响应或合成运行事件。

- 初始请求：仅把目标画板的指定标题改成 `SPRING STUDIO`，保持字体、位置、尺寸、其他图层不变。
- 原运行尚未完成时通过真实输入框补充：最终改成 `AUTUMN STUDIO`。
- 旧运行 `00983eb0-298e-4431-8bf5-da8c1473ef02` 最终状态 `canceled`。
- 新运行 `e33c8771-30ad-4fb6-928f-d8a2d75a9d40` 最终状态 `completed`，需求版本 2。
- 实际工具序列：`inspect_design` → `update_design_brief` → `inspect_design` → `get_design_objects` → `manipulate_design` → `verify_design_result`。
- 最终标题、字体和属性逐字段断言通过；其他图层与另一张画板的场景内容保持一致。
- 文档版本 2、预览版本 2；退出编辑、刷新后预览像素和需求均保持。
- 图片/视频生成任务数为 0；没有触发媒体生成费用。
- 最后一次 Playwright 实测通过，34.5 秒。模型自行选择 `visual:false`，按实际文档核对简单改字；没有把它当作视觉质量验收。

[打开执行中纠正样板](http://localhost:3020/canvas?id=2fab3661-ca16-4fc3-abf9-a2008cc518d1&session=4dfac71a-6cb8-47f7-bd73-c5f37628779f)。

[机器可读证据](E:/Loomic/Loomic/apps/web/test-results/design-task-steering-live-background-verified/design-task-steering-local-a55f0--and-preserves-other-layers-chromium/actual-llm-steering-evidence.json)；[真实浏览器截图](E:/Loomic/Loomic/apps/web/test-results/design-task-steering-live-background-verified/design-task-steering-local-a55f0--and-preserves-other-layers-chromium/actual-llm-correction-saved.png)。

## 自动化和真实数据库证据

- 服务端相关回归：20 个测试文件、192 个测试通过，包含真实 Agent 图运行、Skill 文本块读取、最终回答缓冲、最新版本核验与客观视觉问题阻断。
- 前端相关回归：45 个测试通过，包含双击焦点路由、无实际内容变化提示、视觉问题与保存状态分别显示。
- 前后端 TypeScript 检查通过，共享包构建通过。
- 真实数据库回滚脚本：权限、错误会话、错误原图、其他画板、未授权图层、旧版本写入、任务来源不可变、成功资产保留，全部断言通过；测试行最终回滚。
- 双连接竞争脚本：确实检查到 PostgreSQL `Lock` 等待。纠正先提交时，迟到写入等待后被拒绝；写入先提交时，纠正等待后推进需求，合法先完成的结果保留。两种顺序通过，测试行已按精确 ID 清理。
- 真实浏览器 CAS/预览测试：旧设计版本写入返回 409，已保存结果与预览不被覆盖，刷新结果不变；末轮通过，9.7 秒。
- 会话删除真实数据库测试：移除会话及运行后，设计正文、版本和审计记录保留；新增的任务外键和旧设计审计外键不会阻止级联清理。

## 真实模型验收：自主选择 Skill 并排版

同样使用 `apiyi:gemini-3.1-flash-lite`，向真实聊天输入框提出自然语言排版要求，**没有 @Skill，也没有在请求里指定 Skill**。启用列表包含 15 个 Skill，模型自主选择并读取 `/workspace-skills/typography-layout/SKILL.md`（520 字符完整说明）。

指定保留两段英文、Arial、文字颜色、蓝色背景、640×360 画板和另一张画板；只调整已有两个文字对象，不增删对象、不生图。

| 实际文档属性 | 修改前 | 修改后 |
| --- | --- | --- |
| 标题字号 / y | 38 / 80 | 48 / 100 |
| 标题字重 | 700 | 700 |
| 副标题字号 / y | 22 / 220 | 24 / 200 |
| 副标题字重 | 700 | 400 |
| 两段文字、Arial、颜色、其他对象与画板 | 原始内容 | 逐字段比对不变 |

- 真实工具顺序：读取设计 → 保存需求 → 读取 Skill → 修改命令（一次字段校验反馈后修正并实际应用）→ 核验实际结果。
- 最终运行 `d381f352-cb53-4546-a1b6-ae74756998eb` 完成；文档版本和预览版本均为 2，`contentChanged=true`。
- 视觉核验成功：`visualBlockingIssues=[]`、`visualError=null`，返回“客观问题：未发现明确问题”。
- 对实际预览的文字像素做边距检查，不使用对象宽度代替字形宽度。512×288 预览换算为设计像素，左/右/上/下留白分别为 41.25 / 152.5 / 113.75 / 136.25，均大于该测试要求的 8 像素。
- 退出原位编辑、刷新后的实际预览像素相同；未增删任何对象，另一画板不变，媒体生成任务为 0。
- 严格 Playwright 实测完整通过，1.2 分钟；主代理和审计代理均目检截图确认标题完整显示。

[打开自主排版样板](http://localhost:3020/canvas?id=e09d90c2-bbb6-4c8a-84c5-359088ea3bde&session=750fcabe-9906-400a-833f-b89f2bd5cb16)。

[机器可读验收证据](E:/Loomic/Loomic/apps/web/test-results/design-task-skill-live-visual-verified/design-task-steering-local-6e11a-for-professional-typography-chromium/actual-autonomous-skill-evidence.json)；[真实浏览器截图](E:/Loomic/Loomic/apps/web/test-results/design-task-skill-live-visual-verified/design-task-steering-local-6e11a-for-professional-typography-chromium/actual-autonomous-typography.png)。

测试入口：

```text
apps/web/e2e/design-task-steering-local.spec.ts
apps/server/src/agent/design-task-tools.test.ts
apps/server/src/agent/design-task-verification.test.ts
apps/server/src/agent/design-task-skill-read.test.ts
apps/server/src/agent/design-task-completion.integration.test.ts
apps/server/src/agent/runtime-design-task.test.ts
apps/server/src/http/runs-design-task.test.ts
apps/server/src/features/agent-tasks/agent-task-local-db.qa.sql
apps/server/src/features/agent-tasks/agent-task-design-assertions.qa.sql
apps/server/src/features/agent-tasks/agent-task-race-local.qa.mjs
```

SQL 只针对 `loomic_replica_light_20260907`，需本地 `supabase_admin` 执行。主回滚脚本的 `\ir` 需要将两个文件放在同一目录或执行前内联。实测使用 `artifacts/local-replica-20260907/app.env`，没有使用根目录的云端配置。

## 本轮实测发现并修复的问题

首轮真实模型测试失败：WebSocket 的手动参数映射遗漏 `designTask`，导致浏览器虽然发送目标和纠正关系，后端仍走普通对话。已补齐转发，并新增真实 WebSocket 边界测试，确保任务准备完成前不能发 ACK / 开始执行；加强后的真实模型测试通过。没有把这次失败算成通过。

同时修复：HTTP 任务准备失败仍显示 accepted、旧运行清掉新运行连接状态、明确图片目标误依赖关键词/强制忽略改尺寸意图、新纠正继续显示旧验收记录、核验过程中设计变化却沿用旧视觉结论。

专业排版首轮又发现两个真实问题：模型没有读 Skill；不合法的样式字段被笼统报错后，模型删去样式，只重复写入已有文字，却声称完成排版。已增加专业 Skill 执行约束、明确的 object_type/snake_case 字段指导、同值写入拒绝，以及独立场景变化比对。失败证据保存在 `apps/web/test-results/design-task-skill-live-verified/design-task-steering-local-6e11a-for-professional-typography-chromium/actual-autonomous-skill-failure.json`，没有将失败计为通过。

第二轮模型已自主选对 Skill，但执行层仅识别字符串，漏认 DeepAgents 标准文本块数组，导致成功读取仍被拦截。已支持字符串、文本块数组、ToolMessage 和匹配工具调用 ID 的 Command 消息，并用真实 DeepAgent + 本地脚本模型证明“读取前拦截→真实读取→允许修改”。错误结果、无关消息、二进制内容不算成功读取。另加真实 Agent 图的有限核验/重规划测试，以及运行流测试，确认被拒绝的结论不会先显示给用户。

第三轮排版已真实生效，却在核验版本 3 后再次改到版本 4，结束时错误复用了旧核验；最终 72 号标题还出现裁切。已改为结束前重新读取权威版本，并增加当前版本客观视觉问题的阻断。视觉复查原来复用了“参考图理解”提示，而且将包含上次评审的整个 brief 再当成用户要求，造成主观建议自我强化；现在用专用结果核验、需求字段白名单和结构化客观问题，审美建议不要求自动返工。第三轮的失败与截图保存在 `apps/web/test-results/design-task-skill-live-approved/`，没有将其算为通过。

末轮简单改字复测还出现视觉误报：模型把默认白色 canvas 底色当成用户要求，忽略覆盖其上的未改变蓝色矩形。真实文档与图层比对确认背景没有改变。已给视觉核验补充完整非文字层信息及前后数据比对，明确底色不等于最终可见背景，并新增无供应商调用的背景覆盖回归。最后一次真实纠正运行选择 `visual:false`，所以只能确认纠正流程无回归，**不能据此宣称视觉背景误报已经在真实供应商上验证消失**。历史误报证据保留在 `apps/web/test-results/design-task-steering-live-final-runtime/`；不修改历史记录掩盖它。

真实鼠标操作还发现双击画板会同时开启 Excalidraw 隐藏文字编辑器，抢走聊天焦点。已消费画板的双击事件，正常画布双击不变；真实浏览器复测已能直接输入，无需先开图层面板绕行。

本地已应用迁移：`20260908000007_agent_design_task_intent.sql` 和 `20260909000001_detach_design_audit_on_session_delete.sql`。后者保留设计审计原始 ID 与记录，只将可删除会话的活动关联改成可解除的外键。测试临时数据库行均回滚/按精确 ID 清理；用于浏览器排错的旧 QA 项目归档，可恢复，不改动用户原项目。

## 不能混同为已经保证的事项

- “这组验收全部通过”不等于“所有用户输入、第三方模型和网络条件永远零错误”。
- 当前纠正方式是在安全边界取消旧模型运行、用最新需求重新规划；不是第三方模型内部随时修改 token，也不是完整依赖图的局部回放系统。
- 已发往供应商的工作不一定能取消计费；保证的是旧结果不能误写当前对象。未对付费图片、视频、支付订阅做本轮真实供应商验收。
- 迟到图片沿用现有任务资产保留期（7 天），不是无限期归档。
- 前端原位编辑目前绑定整个画板；按名称仅修改指定图层已通过本样板逐字段验证。后端支持 objectIds 限定，但尚未把编辑器当前选中图层自动接成强制字段级权限。
- 刷新后使用界面当前配置的模型；不把“恢复原始运行的历史模型配置”声称为已完成。
- 视觉模型的审美判断不是客观保证；未检查/不可用会明确显示，文字验收以真实属性比对为准。
- “未发现明确的视觉问题”不等于审美满分。未使用视觉或视觉服务不可用时，程序只允许报告已经确认的保存/预览状态；不能把它说成已通过视觉质量验收。本样板专业排版的真实验收额外要求成功的视觉记录和实际文字像素安全边距。
- 终态版本核对保证的是核对当时的状态；用户在完成后继续编辑会产生新的版本，不能将旧完成报告解读为后续版本也被验收。

验收采用实际工具轨迹、持久化状态、真实数据库竞争和浏览器最终结果联合核对，参考 [OpenAI Agent evals](https://developers.openai.com/api/docs/guides/agent-evals) 的端到端评测思路，而不只检查提示词。
