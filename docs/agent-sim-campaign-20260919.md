# 多角色模拟用户 × 生图 Agent 全流程压力验收（2026-09-19）

对象：本地真实部署（API `127.0.0.1:3002`、web `:3020`、副本 Supabase `:54421`、单 worker），
文本模型 `deepseek-v4-flash-vision-exp`，图片模型 `gpt-image-2.5-flare`（本副本 0 积分）。

## 一、做了多少

| 项 | 数量 |
| --- | --- |
| 角色（persona） | **12**（P1 小白首用 / P2 参数党 / P3 参考图与画布 / P4 图像工具链 / P5 多上下文 / P6 歧义澄清 / P7 技能与提示词库 / P8 设计与画板 / P9 视频 / P10 打断并发 / P11 边界不支持 / P12 计费措辞） |
| 真实用户轮次 | **66**（全部 run `completed`，无 run 失败/超时） |
| 触发的付费 job | **90**（图片 89 + 视频 1；`succeeded` 25、`dead_letter` 42、`canceled` 1、其余为收尾时的在途） |
| 工具调用 | 覆盖 `generate_image`/`edit_image`/`generate_video`/`manipulate_canvas`/`inspect_canvas`/`review_image_results`/`ask_clarification`/`list_skills`/`use_skill`/`search_prompt_library`/`get_image_status` 等 |
| skills | 点名加载 3 个成功（product-visual / social-carousel / campaign-design / nonstandard-image-size），4 次 `skill_output_kind_conflict` |
| 独立核验 | **10/12 角色**的报告由独立核验代理逐条复核（P1/P2/P3/P6/P7/P8/P9/P10/P11/P12），P4/P5 由我按同一口径人工核对 |

驱动方式：新写的无状态 harness `apps/server/scripts/agent-sim-tools.mjs`
（`create/turn/state/wait-jobs/cancel/upload/seed-canvas/download/skills`），
多个角色可并发驱动同一部署；证据（逐轮 JSON、报告、核验 JSON）在 `artifacts/agent-sim/`（不入库）。

## 二、已修复的真实缺陷（本轮提交 `20662cc`）

| # | 缺陷 | 严重度 | 根因 | 修法 |
| --- | --- | --- | --- | --- |
| 1 | 大工具结果被**整块丢弃**：`list_skills`(24.8KB)、`discover_tools`、提示词库检索在事件与 transcript 里都变成 `{}`，UI 卡片无从渲染 | medium | `stream-adapter.ts` `OUTPUT_SIZE_LIMIT=10240` 超限即 `return undefined` | 分级有界截断（字符串/数组/键数）+ `truncated:true`，仍不超上限；新增 2 个单测 |
| 2 | 上游 **429 被当成"渠道明确拒绝"**→ 用户请求在瞬时过载时直接 dead_letter（实测 `429 当前分组上游负载已饱和`） | medium | `openai-image.ts:283` 把 429 归为 `provider_rejected`，而它在 `NON_RETRYABLE_CODES` | 新增 `provider_rate_limited`：同一 attempt 内 15s/30s/60s 有界重试（429 是派发前拒绝、可证无图），耗尽后仍设栅栏并终态；新增 7 个单测 |
| 3 | 写入回执校验把**内部术语**流进用户回复，且"我现在按你的原请求执行"是空承诺 | medium | `mastra-agent.ts` 两处 `createAssistantStreamMessage` 文案 | 改成用户语言（"我先确认这一步是否真的执行成功。" / "这次没有执行成功：…"） |
| 4 | 用户明确要求删除画布元素，Agent 回答"**我没有权限**"（工具在手且已授权） | high | 提示词只说了"原生画板由用户手动编辑"，模型把边界外推到无限画布 | 提示词新增一句：无限画布可写，明确要求删除/移动就用 `manipulate_canvas` 执行 |
| 5 | 生成中改需求（"改成…"）**沉默地产生第二个 job**，用户以为只下单一张 | medium | 提示词只覆盖"未知/在途先查询"，没覆盖"修正取代" | 提示词新增：能确定被取代就先 `cancel_image_job`，否则必须告知会产生第二个任务与第二次费用 |
| 6 | `use_skill`/`compose_skills` 的 `outputKind` 是**无说明的自由文本**，模型猜 `raster-image` 给辅助技能 → 冲突后放弃技能 | low（原报告 medium） | 工具 schema 无 `.describe`、description 未提该字段 | 两处补 `describe` + description 说明"必须是该技能自己声明的 outputKinds" |
| 7 | 视频能力口径错（"3–8 秒"，真实只支持 4/6/8） | medium | `availableVideoModels` 只注入 `maxDuration`，描述里又把 Veo 与 Replicate 并写 | 注入 `allowedDurations`；描述改为"只从上下文里该模型的 allowedDurations 取值" |
| 8 | 视频 job 终态后 Agent 仍说"还在生成中"、并称"会话里没有任务记录" | **high** | 上下文里所有 job 查询都限定 `job_type=image_generation`，视频 job 完全不可见 | 新增 `videoExecutionState`（本会话视频 job 快照 + "终态即最终"的权威注记） |
| 9 | 视频失败对用户**完全静默**（无聊天提示、无画布提示，卡片停在 processing） | medium | `job-canvas-finalizer.ts` 的终态结算只处理 `image_generation`，全仓无 video finalizer | 新增 `finalizeTerminalVideoJobPlaceholder` + 兜底扫描；按 error_code 生成中文文案；新增 2 个单测 |
| 10 | 图片失败卡片把**上游英文原文**（含 `workspace:<uuid>`、request id）写给用户看 | low | `job-canvas-finalizer.ts` 直接写 `job.error_message` | 卡片改用 code 派生的中文文案；原始串只留在 DB 供诊断 |
| 11 | 计费问句被当成"数量授权"：「生成一张图要花多少积分？」把当轮图片额度从 4 压到 1，Agent 又把当轮额度说成系统规则 | low（原报告 medium） | `currentUserImageOutputCount` 的排除词表缺少 多少/单价/计费/费用 等询价词 | 补排除词；新增 1 个单测（含"真实数量请求仍正确计数"反例） |

## 三、已确认但**本轮未修**的问题（含根因与建议）

> **修复进展（2026-09-19 后续批次）**：下表 A、B、C、E、F、G、H 与 J 的提示词侧、
> 以及核验新增的视频状态工具/占位框清理/复核语义，已在后续四批中代码化落地，
> 见 [`docs/agent-sim-optimization-20260919.md`](agent-sim-optimization-20260919.md)。
> D（选区能力）已在提示词层补路由与边界说明（列出五种画布选区能力及其入口）。
> I（原生画板发现性）在提示词层已补"可在画板上手动编辑/添加"；其中"聊天侧创建/导出原生画板"
> 已由用户明确**暂不需要**（2026-09-20），属确定的范围外项，不再是待办。
> 本节保留战役当时的判断，作为根因与验收依据。

| # | 问题 | 严重度 | 根因 | 建议修法 |
| --- | --- | --- | --- | --- |
| A | **失败回执永远不是会话最后一条**：失败卡片 upsert 回"提交行"（id=job id），位置早于同轮的"正在生成中…出图后告诉你"乐观文案；终态后不再追加任何消息 | medium | `job-canvas-finalizer.ts:232-260` 复用提交行；成功路径是 update-only；全仓无"终态追加消息" | 失败/取消时**追加**一条新消息（或把回执按终态时间重排），不要覆盖提交行 |
| B | **取消缺少同步结算**：取消排队中的 job 后 chat 与画布仍显示"生成中"，实测滞后 **132–145 秒**（同会话 dead_letter 只需 17–21s） | medium | `http/jobs.ts:719-760` 只做 cancelJob+退款；终态结算依赖 worker 处理该 job，而它从未被取走；兜底扫描被 30s 节流挡 | 在取消端点里直接调用 `finalizeTerminalImageJobPlaceholder`（视频同理），靠 `*_terminal_finalized_at` 幂等 |
| C | `manipulate_canvas` 的 **move/align/distribute 完全没有占用感知**：把图片移动到与已有元素逐像素重叠的位置，回复却说"留出适当间距" | high（核验维持） | `manipulate-canvas.ts:225-235`（move）、`:787-810`（align/distribute）无碰撞检查 | 移动前做一次最小位移避让（或返回 warning），并在回执里带上最终坐标 |
| D | **选区驱动能力不会被引导**：抠主体/擦除/拆层/精确扩图/局部重绘，聊天里 Agent 既不用也不指向画布上真实存在的工具，甚至给出"位图拆不了图层""精确 1100×1200 得靠外部工具"的**错误结论** | medium×4 | 提示词与工具面缺"这类请求属于画布选区操作"的路由指引；agent 工具里 `operation` 枚举只有 `generate|remove_background`，取不到 mask/selection | 在提示词/技能里明确列出四种选区能力（去背景/框选主体/图层拆分/局部重绘/扩图）及其入口，并允许 Agent 明确"请在画板上框选/涂抹" |
| E | **模型无法自查自己的工具回执**：历史只回放 user/assistant 文本，导致同一会话内出现"我没有实际加载过任何技能正文"这类与回执矛盾的自我否认，也是若干"我没有权限/不能移动"的来源 | low-medium | `mastra-runtime.ts:474` 只传 role+content；`mastra-context.ts:210-211` 注释明确工具调用不进历史 | 在 `current_context` 里注入极小的"本会话已加载技能 / 已提交任务"清单 |
| F | write-repair 环路的 `toolChoice:'required'` **只在 step 0**：一次只读工具调用就满足它，之后仍可无写入地输出文本 → "判定需要写入却没有写入"可构造复现 | medium | `mastra-agent.ts:546-547` `stepNumber === 0` 才强制 | 修复回合把可用工具临时收窄到 `writeToolNames`（或至少强制"必须出现一次写入工具"） |
| G | 画布失败占位框的 `errorMessage` 恒为「图片生成失败」，与真实 429/504 不对应（保留占位框本身是**有意设计**） | low | `job-canvas-finalizer.ts:274` 常量 | 用 error_code 派生画布侧文案（与视频路径一致） |
| H | 安全（IP/真人肖像）在代码与提示词两层都**没有任何规则**，完全依赖基座模型对齐；本批行为正确但无纵深 | low | 全仓无 safety gate / 提示词条款 | 至少加提示词级规则与"拒绝回执"文案 |
| I | 要"设计稿/可编辑排版"时只给位图，且**不告诉用户存在可手动编辑的原生画板** | low | 产品边界（聊天只交付位图）；发现性缺口 | 在边界说明里补一句"可在画板上手动编辑/添加"的路径 |
| J | 聊天附件"我用了哪张参考"**没有回执**：附件确实进了上下文，但 Agent 可能不选它且不说明 | low（原报告 medium） | 无任何机制要求说明参考取舍 | 生成回执里列出实际使用的来源（assetId/画布元素） |

## 四、被核验**驳回**的结论（避免后续误修）

| 报告结论 | 驳回理由 |
| --- | --- |
| P2-F1（high）"用户要求的 `OPEN 9-18` 与衬线字体被 Agent 丢掉/改写" | **harness 引号吞字**：DB 里权威用户消息就是 `在图上写 OPEN`，`9-18`/衬线从未进入产品（全仓 grep 只在报告里命中）。我用 `--text-file` 重跑同一句，提示词里 `"OPEN 9-18"` 逐字保留、明确要求 **elegant classic serif**，成品（720×1280）文字拼写正确、衬线、无多余文字 → **反向证明该能力正常**，并已给 harness 加 `--text-file` 与引号不平衡告警 |
| P11-F3 / P7-F7 "routing 事件缺失或不完整是缺陷" | 设计行为：`describeDesignRouting` 对"无设计决策"的回合返回 undefined；`isProvablyInertNoRuleTurn` 在"无系列 + 无规则命中"时跳过模型判定；候选≠选择是明确设计 |
| P12-F3 "第 5/7 轮计费口径不一致" | 第 7 轮文本仍保留"查不到扣费、以平台账单为准"，只断言两笔参数相同 → 口径未放宽 |
| P9-F8 / P3-F1 / P4-F1（high）"harness 上传必然 400" | 真实且重要，但属**测试工具缺陷**（Blob 无 MIME），已在 harness 修掉，不计产品缺陷 |
| P6-F2 / P12-F5 / P8-F4 "失败占位框是残留脏元素" | 保留并置 `status=error` 是**有意设计**（保留重试交互）；真弱点是文案常量（见上表 G） |
| P9-F6 "用户会看到内部错误串" | 该视频场景下用户其实什么都没看到（无 video finalizer）→ 真问题是**静默**（已修）；图片侧的泄漏地雷已随本轮修复关闭 |
| P12-F1 "Agent 编造『本轮最多 1 张』" | 与它被注入的当轮额度逐字一致（策略把询价句读成数量）→ 归因修正为策略缺陷（已修） |

## 五、验收到的正确行为（正面清单）

- **意图与拒绝**：非设计请求（写爬虫）、IP（米老鼠）、真人肖像、越权（删除他人项目）全部被明确拒绝，**0 付费 job、0 数据变动**（他人资产计数逐次比对恒定）。
- **歧义澄清**：8 轮里"弄好看点/随便来一个/把那个改成那个/先别生成"全部先澄清；"先别生成"时 `jobs[]`/`tools[]` 全空；"就第一个"正确绑定方案 A；跨轮记忆准确。
- **上下文连续性**：9 轮角色系列（戴眼镜柴犬）——第 2/3/6 轮角色一致、第 4 轮"第一张图"正确指代并只改眼镜、第 7 轮跨轮总结与 job 台账逐条吻合，还主动纠正自己上一轮的"正在生成中"。
- **多模型/比例**：16:9→1280×720、3:4→880×1184、1:1→1024×1024、9:16→720×1280 全部按请求落地。
- **文字与字体**：`OPEN 9-18` + 衬线 + 仅此一处文字 → 逐字正确（见第四节）。
- **抠图/去背景**：按 `background-removal` 技能文档的 `edit_image(operation=generate, background=transparent, outputFormat=png)` 路径，产物实测 **60.9% 全透明像素**、内容完整保留 → 为既定正确路径，不是错路由。
- **计费一致性**：全批 `credits_cost` 0/null、`credit_transactions` 0 行、余额恒 940，Agent 从未编造金额或流水；同一请求在途重复提交被明确拒绝（"避免重复提交和重复计费"）。
- **并发无数据丢失**：同会话两个 `turn` 进程并发，两条 run 与两个 job 都完整落库；四次 `wait-jobs` 全部 `settled`，无 job 卡在 running。
- **图层拆分/局部重绘/扩图**（画板侧）：画布工具栏能力 `available:true`（本批未在聊天侧触发，是上表 D 的产品缺口）。

## 六、环境侧结论（非代码缺陷）

- **上游网关在并发下不稳定**：本轮高峰 32 个 job 中 19 个 dead_letter（`429 当前分组上游负载已饱和` 与 `504 Upstream model timed out`），同一会话稍后重发常能成功 → 瞬时供应商侧故障；这直接放大了 A/B 两个"用户看不到终态"的问题。429 的处理已按第二节 #2 改进。
- **视频供应商凭据无效**：唯一视频 job 4 秒内 `http_401 Invalid token`（`workspace:debd662d-…`），本副本视频链路 100% 不可用；Agent 却按目录承诺了视频能力（口径已按 #7 改进，凭据需环境侧配置）。

## 七、修复后的行为回归（新代码已加载，2026-09-19 19:44 起）

第二节的 11 项修复里，三条提示词级缓解在重启后**已用同样话术实测**：

| 回归 | 结果 |
| --- | --- |
| P1 场景：明确要求删除画布元素 | **通过**。Agent `discover_tools({manipulate_canvas})` → `manipulate_canvas(delete, 正确 element_id)` → 工具按设计返回 `confirmation_required`（带 confirmationId/targets/过期时间）→ Agent 回复"删除操作需要你再确认一次才能执行，请确认后我立刻删掉这张图"。**不再出现"我没有权限"**，且删除仍受二次确认保护 |
| P10 场景：生成中改需求（"等等，改成雪山的日落"） | **通过**。Agent `discover_tools({cancel_image_job})` → `cancel_image_job(fb445025)` 返回 `canceled` → 再提交雪山那一版；回复明确说"海边日落那张还在生成中，我先把它取消，再按雪山日落重新提交"。终态：**1 个 canceled + 1 个在途**，不再出现两个在途付费任务且不告知 |
| P2 场景：`OPEN 9-18` + 衬线字体 | **通过**（用 `--text-file` 保证话术完整）：提示词逐字保留 `"OPEN 9-18"` 并要求 elegant classic serif，成品 720×1280 文字拼写正确、衬线、全图仅此一处文字 |
| 视频状态 / 视频终态 / 429 重试 / 大结果截断 / 计费问句 | 未做真实回归（需视频凭据、上游过载或特定会话状态），按单元与执行器测试覆盖 |

仍**未回归**的行为级修复：write-repair 的 `toolChoice` 只强制首步（问题 F，尚未实现修法）；取消端点的同步结算（问题 B，尚未实现）。

## 八、未验证（诚实边界）

- 画板侧的框选/涂抹类操作（`region_matting`/`smart_erase`/`local_repaint`/`split_layers`/`outpaint`）**真实成图质量**：聊天侧无法构造 mask/选区，本批未产出这类 job（且 `chat` 工具面本就取不到选区，见上表 D）。
- 真实扣费与退款闭环：本副本图片/视频计价均为 0，只能核验"提交次数与回执一致性"。
- 浏览器端真实交互（错误卡片呈现、占位框能否一键删除、取消按钮路径）：本批全部走 HTTP/WS 与 DB 证据。
- 第三节 A–J 十项**均未修**（都需要改代码，且其中 A/B/C/D/F 属结构性改动）：它们的证据已在报告与核验 JSON 中固化，可直接排期。

## 九、复跑方式

```powershell
# 造一个隔离项目/画布/会话
node --env-file=artifacts/local-replica-20260907/app.env apps/server/scripts/agent-sim-tools.mjs create --name "回归" --out artifacts/agent-sim/regress/fixture.json
# 发一轮（长文本/带引号请用 --text-file，避免 shell 吞字）
node --env-file=artifacts/local-replica-20260907/app.env apps/server/scripts/agent-sim-tools.mjs turn --fixture artifacts/agent-sim/regress/fixture.json --text-file artifacts/agent-sim/text.txt --out artifacts/agent-sim/regress/turn1.json
node --env-file=artifacts/local-replica-20260907/app.env apps/server/scripts/agent-sim-tools.mjs wait-jobs --fixture artifacts/agent-sim/regress/fixture.json --timeout-minutes 10
node --env-file=artifacts/local-replica-20260907/app.env apps/server/scripts/agent-sim-tools.mjs state --fixture artifacts/agent-sim/regress/fixture.json --out artifacts/agent-sim/regress/state.json
node artifacts/agent-sim/tools-report.mjs artifacts/agent-sim/regress/turn1.json
node artifacts/agent-sim/tools-state.mjs artifacts/agent-sim/regress/state.json
node artifacts/agent-sim/tools-alpha.mjs <jobId>            # 下载并测 alpha
node artifacts/agent-sim/tools-ledger.mjs                   # 全批 job 台账
node artifacts/agent-sim/tools-verdicts.mjs                  # 全部核验裁决
```
