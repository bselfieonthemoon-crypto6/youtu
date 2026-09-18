# 真实网页多轮生图验收记录

> 历史验收记录。无人值守相关目标已由用户撤销，不再继续实施。当前需求以 `conversation-first-reliability.md` 为准；本文件中的失败与测试事实保留，不表示已全部修复。

## 专用模型隔离复测与专项审查（2026-09-11 04:04 本地）

- 旧 `c0077569` 已经真实取消（202/run.canceled），无新方案；证据 `browser-turns/2026-09-10T19-51-50-386Z.json`。
- 使用专用 `workspace:29a0cb35-0794-4239-9a95-948c8cf93705`（gpt-image-2）启动 `dcbe564c-992c-4dda-87c4-c3912889bf2d`，仍出现三次 generate_image 定位拦截，无新方案或图片任务。用现有隔离 QA cancel 流程明确停止，browser 收到 run.canceled；证据 `browser-turns/2026-09-10T19-58-13-905Z.json`。不能将取消写成自然完成。
- 已委派一个 Sol/high 子代理 source_selector_diagnosis 审查选择器漂移。checkpoint 显示引用实际 asset 正确，但出现用户引用与选择值不一致、目标未找到两类 gate 拒绝；专项修复尚在进行，未宣称通过。
- 浏览器 QA 回执新增 plans 数组收集 plan.updated 事件，node --check 通过；本轮已启动进程仍用启动前代码，不倒填新字段。
- 当前无上述运行待等待，下一步接收专项修复并复核权限边界/测试，然后部署复测。透明 PNG 未生成，不要确认旧无参考错误方案 ac5232f4。

## 原图名称关联的真实权限验证（2026-09-11 03:58 本地，运行尚未结束）

- 新 run `c0077569-00fa-44ee-8237-22075c5d003c` 明确要求原版 Logo 作为去背景来源，先准备不确认。观察到多次 generate_image 被拦截；当前 proposal=0，不以失败重试当作成功。
- 通过 QA 所有者真实登录后的 Supabase 用户客户端调用 generatedImageSourceNames，返回三条准确映射，包括原图 `9c9711cc` → `Northstar Logo 方案 — 抽象四角星与轨道`。因此数据库关联路径已获得实际 RLS 验证；模型定位选择仍未通过，未宣称端到端修复。
- 当前工作区已启用专用 `gpt-image-2`：`workspace:29a0cb35-0794-4239-9a95-948c8cf93705`，对应供应商也启用。下次透明处理测试应在 UI 明确选此模型，而不是继续使用 `gpt-image-2.5-all` 或让 Agent 暗自改模型。
- 运行仍由 browser helper session 76247 观察，无重复提交；下一步先检查同一运行终态。旧错误待确认方案 `ac5232f4` 不授权执行。

## 无名画布原图的可信名称定位（2026-09-11 03:52 本地）

- 数据库核对：Northstar 三个 image 元素均无 name/title；原 Logo 的名称 `Northstar Logo 方案 — 抽象四角星与轨道` 只在原生成方案中。旧 gate 不能从无名对象精确匹配用户名称，导致错误拒绝。
- 新增只读 generatedSourceName：authenticated client 按用户、会话、画布查成功图片任务，再将 result.asset_id / canvas_element_id 与当前存活画布对象、未删除资产和原方案标题交叉核对。未知/错误记录不增加来源权限。
- 新增 generated_source_name 选择器：用户原话中的名称片段可以匹配该可信标题，必须只匹配一张；仅允许 generate_image 独立输出的原图读取，不授权覆盖/移动/删除。名称并非指令，模型仍须通过其余来源、模型和费用边界。
- 4 项新增测试通过：来源关联及过滤、删除资产不匹配、唯一名称允许、同名拒绝、禁止写入（第一项含多断言）；现有 14 项上下文与 112 项 gate 测试通过，最终类型检查通过。
- 确认无运行中的 run/job 后重启 API，部署名称定位和上一轮参考重试保护。真实对话复测尚待进行；旧错误 pending 方案未确认，透明实际处理、串行三种格式交付仍未验收。

## 原图重试保护与停止已知错误测试（2026-09-11 03:46 本地）

- `cbf9be36-8cc0-4fc1-9647-5dcb98d25de2` 最终通过真实取消 API（202）停止，browser 收到 run.canceled，不冒充自然完成。证据 `artifacts/paid-dialogue-live/browser-turns/2026-09-10T19-38-01-382Z.json`。停止前多次 generate_image 返回 proposal_already_frozen_for_run，没有新增图片任务；不再无效等待同一方案循环。
- 新增每轮参考重试保护：带 inputImages 的方案被拒后，后续 generate_image 不允许删除全部参考图改为纯文字方案。修正参考标识仍进入原有证据核对，不自动信任最初被拒的 ID。用户下一轮改变要求不受旧轮标记影响。
- 10 项 intent-write-middleware 测试及类型检查通过；覆盖丢弃参考的重试在执行前被拒、替换为纠正后的标识仍需重新核对。代码尚未部署到 API；不宣称原图引用根因或透明交付已全部修复。
- 仍须处理：正确原 Logo 选择器、明确透明交付的执行配置，以及已冻结错误方案不能在本轮修正导致的重复调用。旧 pending 方案 `ac5232f4` 从未确认，不应用它继续生成。

## 计划注册真实复测与约束丢失（2026-09-11 03:44 本地，运行尚未结束）

- 补正新回归测试的快照类型声明后，完整服务器类型检查通过；API 已重启为 PID 22904。首次浏览器加载超时 sentRunCommands=0，DB 无新 run 后才重试。
- `5c692ece-a0e2-41a1-bcc1-3d58593266dd` 已正确指出原 Logo asset `d8bcd99c-bc72-4f99-ba9d-bec4353ddf1b`，但 tools=[]，仍只有口头方案，不能算持久保存成功。
- 后续明确要求实际保存计划的 run `cbf9be36-8cc0-4fc1-9647-5dcb98d25de2`：只读 LangGraph checkpoint（thread `thread_7679a366-c3ab-4b9b-a453-e9e8be39d8c5`）确认 write_todos 真正执行并保存三个交付物，注册修复获得真实运行证据。
- 同一运行先被拒绝旧图引用（没有匹配用户指代的真实对象），随后丢掉 inputImages 保存 pending 方案 `ac5232f4-7429-4376-85cb-71068664f6e7`：referenceImageCount=0、outputFormat=png、foregroundPolicy=null。与沿用原 Logo 和实际透明处理要求不符，禁止把此方案当作验收通过；本轮未确认生成。
- 最近检查 Northstar 图片任务仍为 3 个，无新增图片任务。运行当时仍 running，browser helper session=18559；不能因观察等待而重复提交或断言失败结束。下一步先等同一运行终态并取最终回执，再修复丢弃参考约束及透明交付约束的问题。

## 多交付物准备发现注册缺口（2026-09-11 03:35 本地）

- 实际 Northstar run `889b1d11-3dfd-44bc-8b2e-ae63b06bb6b8` 要求先准备透明 PNG、保留后续两个 JPG、分别确认。最终方案未保存，图片任务仍为原来 3 个，没有新增收费生图。
- 浏览器证据 `artifacts/paid-dialogue-live/browser-turns/2026-09-10T19-26-59-559Z.json`；只读解码该轮 LangGraph checkpoint 发现：request_tools 接受 write_todos，但实际调用报 not a valid tool。随后 generate_image 以 reference 引用旧图，被来源范围核对阻止。不能把两个问题混为供应商故障。
- 已在 deep-agent 显式注册 todoListMiddleware。当前依赖默认仅在 Codex harness 注入它，工作区 Gemini 配置没有该工具，导致工具目录与实际运行不一致。修复保留原有权限边界；未放宽旧图引用。
- 2 项注册回归通过，其中真实本地 harness 使用模拟模型调用 write_todos，将三个 pending 交付物写入 checkpoint 并读取验证；18 项流式适配测试及修改后类型检查通过。这不是收费对话验收，API 尚需重启后进行真实复测。
- 尚待：真实三交付物计划、Northstar 原 Logo 消歧、透明通道及 JPG 格式的实际交付。目标未完成。

## 只读生成状态查询（2026-09-11 03:26 本地）

- 新增严格的只读状态入口，在上下文整理及模型构造之前读取 authenticated client 下当前 user/workspace/session/canvas 的 image_generation 记录。具名查询核对已保存方案标题（兼容中文标题、英文提示词），找不到不猜测；排队/生成中/失败/取消与完成分开报告，不调用视觉评审或重新生成。
- 17 项针对性测试与服务器类型检查通过。测试覆盖查询边界、复合操作不被吞掉、跨范围过滤、名称不匹配、数据库错误不泄露、终态不误报成功。未宣称所有自然语言措辞均走此入口。
- 实际网页发送“图做好了吗？只查看刚才会员卡任务的真实状态，不要重新生成。”：run `11a2f7e2-e8be-4a63-86e0-e244a65f4610` completed，tools=[]，正确引用 `08f135e9-7547-4f0b-891f-d6f50b254132`。回复明确只证明生成完成，不证明视觉验收或画布仍有该图片。
- 数据库核验：回复按 run ID 持久保存一条；该隔离会话仍为 succeeded=3、canceled=1，无新增生成任务。证据 `artifacts/paid-dialogue-live/browser-turns/2026-09-10T19-25-42-716Z.json`。
- 未修改现有用户作品。其余多交付物/透明格式和自然语言运行中取消仍未完成验收，完整目标保持进行中。

## 短答认可与明确确认接续（2026-09-11 03:15 本地）

- B7 修复：短答认可仅保留对话上下文，不授权付费生成，不重建方案。已确认/已生成的方案不显示“尚未提交”。25 项相关测试、类型检查通过。
- `20260911000005_image_acknowledgement_context` 保留短答前的方案；实际发现提交 RPC 另有两处历史检查仍只接受明确确认，导致 run `0734d07d` 反复查询/重规划。该运行经真实取消 API 停止，未产生 job，不冒充自然完成。
- `20260911000006_confirm_after_acknowledgement` 只调整两处历史消息过滤，当前消息仍必须明确确认。数据库事务回滚验证：短答 run 不能确认；之后明确确认 run 可转 confirmed。已正式应用两个迁移，未修改旧失败轨迹。
- 真实短答 run `9b62669f-07f3-49b5-9503-9d63729678f8` 正确提示“当前方案已保存，尚未提交生成”；原方案 `08f135e9-7547-4f0b-891f-d6f50b254132` pending / job=0。修复后明确确认 run `d6316d9b-ea20-49de-9d18-8aecdd7769bd` 一次提交**同一方案 ID**。
- 图片成功交付：asset `ca43c666-5961-41c8-8df8-f48d1b849bf1`，1254×1254，画布元素512×512；刷新截图 `b42ddab3-873b-44b4-a10e-73b16d986e36-card-after-ack-confirm.png`。可见米白/棕色、圆角、Mellow Coffee / Members Club；另有小字装饰，不宣称严格“仅这些文字”的质量验收通过。
- A6 真实状态查询仍有缺陷：`59fe42ba` 在图片交付附近遭遇 agent_context_conflict；重试 `74a2ced7` 最终正确说已交付，但错误调用视觉检查工具并返回 review_job_requires_image_task。**须补只读任务状态通路，不计此项通过。**
- 本轮新增一张明确确认的测试图片，累计16个图片job：成功交付14、取消1、dead_letter1；没有新子代理。API PID36848，旧用户作品未修改。

## 矩阵审计新增证据（2026-09-11 03:04 本地）

03:06 澄清最终实测通过：run `f316c5a3-cf8e-4cf7-aa41-eaa8c091f233`，轨迹 `2026-09-10T19-05-52-916Z.json`。真实页面收到“画布上有多张图片。你指的是哪一张，以及要改哪一部分的颜色？”；无工具调用，无新增方案或生图。API PID 24048 已加载修复。此前启动页面未加载的尝试 sentRunCommands=0，核对后才重试。

- 新增 `docs/agent-paid-dialogue-coverage-20260911.md`，逐项区分行为已覆盖、具体示例未覆盖、失败和等待复测。发现透明 PNG/两种 JPG 的组合交付尚仅有文字清单（run `05e91bef`），不能算串行任务验收。
- C1/C2：`d9cb4aa8` 只讨论会员卡圆角，无工具；`679f9fa1` 在“那就按你说的做一个”后保存方案 `08f135e9-7547-4f0b-891f-d6f50b254132`，pending / job=0，没有直接收费。
- B7 短答“嗯，可以”run `698419b1-2971-4966-9abd-cccb560c1be4` 错误尝试 generate_image，最终报方案未保存，原 proposal 仍 pending / job=0。**这一项未通过，尚需修复。**
- B8 多图无选中“把那个也做成蓝色”run `b2bd82b2` 错误尝试生图两次。补了基于 live canvas 的只读澄清，明确描述/最近图片/真实选中不拦截；第一次复测 `ea862318` 阻止了调用但输出为空，进一步补上服务端澄清事件进入消息流。23 项定向测试、类型检查通过，最终真实复测待完成。
- 本轮未新增生图或子代理；原用户作品未修改。没有把失败拦截当成正确交互。

## 具名自然语言取消复测（2026-09-11 02:53 本地）

- 新增具名待确认方案解析：当前用户/会话/画布范围内，仅唯一匹配名称的 pending 方案可取消；问句、条件、否定和复合命令不走直接取消。同名多项及查询不完整不选择。此入口不授权生成，也不冒充“取消供应商正在生成的 job”；后者仍走任务取消 API。
- 数据库 `loomic_decide_image` 实际函数已核对：锁住会话和精确方案，限定 auth.uid/workspace 成员，只允许未过期 pending 转 canceled。若并发确认先发生，会拒绝而不是谎称未生成。
- 58 项取消/授权/存储测试及服务器类型检查通过。补跑关联抠图测试曾出现 9 项失败，原因是测试缺少真实附件映射而先命中来源校验；补齐测试前置数据，未放松生产来源校验，23 项全部通过。另两个 durable / 比例 suite 共 38 项通过。
- 真实网页准备 run `2cebe485-138d-47db-af91-279c9fdfda8e` 保存 `周末优惠券`，proposal `3c189a25-f179-4ddd-bf3e-e0bb185f0dbe`；自然语言“取消刚才那个周末优惠券方案”run `da98f2c6-0cd1-4aef-82dd-44c8cf07e17c` 实际调用 confirm_image_generation(decision=cancel)。数据库 canceled，关联 job 数为 0，不是仅口头取消。
- 轨迹 `artifacts/paid-dialogue-live/browser-turns/2026-09-10T18-53-05-812Z.json`，刷新截图 `b42ddab3-873b-44b4-a10e-73b16d986e36-named-cancel-verified.png`。本轮没有新增图片，无新子代理；API PID 35072。
- 最终逐项覆盖审计仍待完成，不把首批真实场景等同于所有自然语言组合或全部设计能力均已验收。

## 画布比例与同系列提交修复（2026-09-11 02:44 本地）

02:45 交付复测：job `81327087-1da6-44d9-890b-e7b8de0d574e` succeeded，asset `5929cd3e-2485-41ce-8775-7288afeb6ce4`，原图 1672×941；数据库及刷新后的前端画布元素均为 511.7279489904357×288，比例一致，不再变成正方形。真实截图 `2ef6f296-499d-4c16-84dc-dcf5cfbf03a9-ratio-delivery-verified.png`，另用纯视口缩放截图 `...-ratio-delivery-fit.png` 展示新旧图。文字 River Club / Weekend by the river 与三条波浪可见；旧失败样例未改写。累计图片 job 15 个，其中成功交付 13、取消 1、dead_letter 1；本次只新增一张确认过的图片。

- 定位横版显示拉伸根因：最终交付沿用生成占位框的宽高，没有按返回图片实际比例适配。现保留实时位置，在预留框内等比放置；横版、竖版、移动后交付、幂等回放相关测试通过（canvas writer + finalizer 共 33 项），服务器类型检查通过。不会批量修改既有用户图片。
- 真实同系列请求 `2026-09-10T18-39-33-844Z.json` 被 invalid_command 拒绝，未创建 run：nextDeliverable 错用了含 sessionId 的 UI scope，而后端严格契约只接受 taskId/runId/revision。修复序列化，新增严格契约回归，23 项前端测试及类型检查通过。最初判断为旧生产包不准确，源码同样存在问题，现已修复。
- 新生产包 `.next-production-paid-qa-ratio` 构建通过并部署（首次字体网络下载失败保留旧服务，重试成功）。API PID 8592、worker PID 23464、web PID 20576。
- 真实复测保存成功：run `26a047b9-a8d3-4525-b73f-da6c3e678083`，方案 `81327087-1da6-44d9-890b-e7b8de0d574e`，16:9 River Club 宣传图，品牌与新小标题继承、保留旧图、无参考图参数（该轮仅文字品牌续做，不计作原图参考继承）。确认 run `d553d0a8-af4e-492d-be52-51e1695e20d5` 一次提交同 ID job。**当前正在真实生成，画布等比显示尚待交付后验证。**

## 最新核验与仍未完成的项目（2026-09-11 02:36 本地）

最终输出复测通过：run `e0e01522-a6b4-4151-b717-20f7dd5cb626`，轨迹 `artifacts/paid-dialogue-live/browser-turns/2026-09-10T18-36-18-142Z.json`。仅一次 review_image_results，读取横版 asset `1d06239f-1ea0-468b-a0a6-6dc9b853035a`，viewed=true / passed / blockers=[]；用户端仅收到真实检查通过报告，不再出现旧方图的相反结论。没有生成或修改图片，prepared read 的 acceptanceRecorded=false，未伪造持久化验收。以下保留前序失败经过；画布显示比例及具名取消仍未完成。

- 数据库重新核对：五个隔离 QA 会话共有 14 个图片 job，其中 succeeded=12、canceled=1、dead_letter=1。成功交付数不是视觉全通过数，也不是供应商账单金额。本轮仅重新检查已有图片，没有新增生图 job。
- `20260911000004_preserve_confirmation_continuation` 已应用，修复纯确认消息误停当前检查接续；新需求仍终止旧授权，停止后再次确认不会恢复授权。SQL rollback 用例通过。River Club 横版 job `beaaa37c-8079-4bed-9ab6-7e42c69ad2d7`（asset `1d06239f-1ea0-468b-a0a6-6dc9b853035a`，1672×941）经确认 run `e2a6bd38-4bee-4a31-bf17-b73f64225b89` 后自动触发检查 `deeab6d5-f1b3-4d8d-9d77-300fed6590d6`，无人工重新开启接续。
- 自动检查原始结论把“比例符合、三条波浪正确、文字准确”错误列为 blocker。已强化结构化约束，检测到正向项目混入 blocker 时，使用同一图片、原截止时间重新核验一次；仍矛盾则 unavailable，不伪造通过，不重新生图。对应测试通过，后续真实只读检查返回 passed / blockers=[]。
- 第二张 River Club 方图的旧 pending 检查通过正常 API 恢复后，run `22516462-5dcf-4827-ae6c-70dbdda3d23f` 真实检查并分开报告水印问题和可选建议。重复确认 run `8dd6765e-b85a-405f-b41f-9ccf197a6cac` 复用原 job，未新增图片。这项包含人工恢复，不冒充全自动通过。
- 手动“检查刚才横版图片”run `5320e3a2-8512-4ad8-b075-14194539f90c` 未调用工具，错看早期方图。专用检查阶段修复后又发现 prepared task 清空结果上下文；新增带版本检查的只读旧结果入口，不激活新任务、不复制旧验收授权。run `dce665bc-104b-47b6-9c21-f7315676f90a` 实际查看正确横版 asset 并返回 passed，但模型总结仍错误，且重复检查；保留失败轨迹。
- 后续 run `7738e654-4aad-44bf-8bc2-f566dd478402` 已只调用一次真实检查并返回 passed，但早期错误流式文字仍在正确报告之前显示。已补专用检查结论流式门禁，普通对话不变；**该最终输出修复尚待真实复测，不能先算通过**。相关 42 项测试、类型检查通过。
- 页面截图 `2ef6f296-499d-4c16-84dc-dcf5cfbf03a9-latest-review-final.png` 暴露另一项待核对问题：横版原文件 1672×941，但画布元素仍为 512×512，存在显示拉伸。必须核对交付尺寸逻辑，不把原文件比例正确当作整个画布显示正确。
- 尚需完成：上述最终报告显示复测、画布比例显示修复、具名自然语言取消的持久化边界、矩阵逐项覆盖审计。历史段落的“未完成”以本节最新核验为准，但不得把未跑的矩阵用例标为通过。
- 本轮主控直接处理，没有新增子代理；项目真实检查仍用 Gemini Flash Lite。没有修改原用户作品。

## 自动像素检查真实链路（02:07 本地）

- Pine Trail `7b360771-6f26-48da-ba89-d42b9b1f44c3` 已真实出图（asset `f1cb5620-6b5a-49bd-a456-043d3c478b37`，1254×1254），registration=bound，并自动创建检查 run `6721fdbe-b227-40a2-93c3-9c5424da0843`，但被 `continuation_model_budget_exhausted` 中断。保留失败记录，没有重置该终态事件冒充复测。
- 检查阶段已优化为直接加载 `review_image_results` 定义并优先检查精确结果，避免技能/工具发现往返占用四轮预算；未扩大生成、写入、委派权限。22 项相关测试通过。
- 独立 River Club 复测：canvas `2ef6f296-499d-4c16-84dc-dcf5cfbf03a9`，session `d41bcdf5-5400-4365-8a23-ac284f450365`，真实模型仍为 Gemini Flash Lite + gpt-image-2.5-all（显式覆盖 manifest 的初始默认模型）。保存 run `eb6644cf-58b7-477a-a51d-e38d5b6addb8`，确认 run `6ac8add1-9523-4177-9ea9-5e3837cc317b`。
- job `785a4cb4-da0b-4d15-bda3-eaaef1d64fbe` 成功，asset `27d02af2-9a94-46ef-9774-bfa2b763097c`，1254×1254。自动检查 run `2dcb4621-024c-4a4a-b2f6-1337093fd324` 实际调用 review_image_results；brief.imageVerification.viewed=true，持久化检查结论。**自动触发/真实查看/保存并发布结论链路通过；图像质量结论为未通过，不能混为生成失败。**
- 图片有三条蓝色波浪、绿色 River Club 字样，以及平台水印。像素检查将水印列为违反“不要其他文字或装饰”的 blocker，将绿色文字列为可选建议；但最终自由文本错误升级建议并说“本次生成失败”。截图 `2ef6f296-499d-4c16-84dc-dcf5cfbf03a9-auto-review-completed.png` 保留原问题。
- 现已改为按结构化检查证据渲染结论，将 blocker/建议/不确定项分开，不采用模型自由总结；补传原文件像素宽高用于比例检查。27 项定向测试与类型检查通过并已部署，**这两项最新修改尚待真实复测**；未改写已保存的旧报告。
- 本轮没有新增子代理；沿用此前冻结交接结果，主控仅做集成、定向修复及真实验证。所有原用户作品仍未修改。

## 局部修改复测与自动检查验证（01:56 本地）

- Northstar 自然语言“刚刚生成的宣传图”局部改按钮颜色通过：proposal/job `98aa1da2-3654-4460-9ff4-688e7665c8d6`，保存 run `bafcd6ec-1019-489a-815c-b364974681b8`，一次确认 run `04cd44a5-2d1c-401c-a991-25dbb9a57f44`。
- 冻结 input 的 sourceUsage=edit、aspectRatio=4:5，inputImageSources 精确绑定原宣传图 `aac4e6b9-e633-40ab-b845-08d7f12035f1` 与原图 hash；真实产物 `f12497de-5842-4a8e-8c9e-4dee7e8e56a9`，1122×1402。截图 `00ad5da8-eebb-4cf3-97f4-bce3db48549b-purple-button-result.png`：紫色按钮、品牌文字、人物和整体版式保持，旧 Logo 与宣传图保留。此为视觉检查，不宣称非编辑区逐像素完全一致。
- 取消最终页面截图 `b42ddab3-873b-44b4-a10e-73b16d986e36-canceled-complete-final.png` 已确认聊天和画布占位均显示取消，不再混为失败。
- `20260911000003_agent_continuation_commit_fence` 经本地 rollback SQL 实测后已正式应用：active brief 可保存；stop 后相同 claim 写 brief/workflow 均拒绝，数据不变。API 已重启加载。
- 自动检查真实复测：job `7b360771-6f26-48da-ba89-d42b9b1f44c3` 经 run `89543228-7d7f-45d0-a650-e2d299f832a5` 一次确认提交，数据库 registration=registered 且绑定精确确认 run；图片尚在生成，不能先算自动验收通过。
- 首次自动化浏览器尝试因启动加载未找到输入框超时，轨迹 `2026-09-10T17-54-57-603Z.json` 证明 sentRunCommands=0；核实后重新打开提交，未重复生图。

## 生成中取消与并发修复（01:47 本地）

- 新咖啡优惠券方案 `60558040-6d10-4ce8-876b-7595e61b9382` 经真实网页保存并确认（run `1ee601a7-18d9-42d9-b12e-fadb599f3e64`），数据库观察到 running、attempt_count=1、image_enqueued_at 后，调用隔离 fixture 对应的真实取消 API。
- 状态变为 canceled。worker 日志证实供应商约 36 秒后完成处理，但终态取消胜出，没有发布新图，未创建新尝试；其返回/归档不能算用户成功交付，也不能声称第三方未收费或退款。
- 终态收敛标记为 canceled。前端原来把 canceled 硬投影成 failed，现已分别显示“图片生成已取消”及“任务已取消，不会将后续结果放入画布”。真实生产页面截图 `b42ddab3-873b-44b4-a10e-73b16d986e36-canceled-chat-fixed.png` 已检查；画布占位对应取消文案另补修，等待最终生产包截图验证。
- 取消 UI 相关 3 suites / 90 tests 通过；画布占位及工具卡片额外 2 suites / 40 tests 通过，两个数字有重叠，不应相加为独立用例总数。前端类型检查通过。
- 自动检查新绑定 migration `20260911000002_plain_canvas_result_review` 经 11 个 rollback-only SQL 场景通过后，已应用到本地 replica 并登记迁移。成功交付后只允许检查精确结果，不授权额外生图；关闭、停止、新用户消息、取消、错误资产、跨用户、已删除元素均不绑定。
- 独立复核发现旧 workflow 接续的停止竞态（检查 lease 与写 workflow 分离）；已安排单独原子写入修复。新普通生图无 workflow 分支不触发该路径，但尚不将整个自动执行算通过。

## 后续实测状态（01:30 本地）

- 已产出 7 张真实图片，另一次参考图请求因 multipart HTTP 400 失败；数字不是全部通过数，也不是第三方账单核对结果。
- 旅行横版 → 原图参考 → 9:16 竖版成功：job `67aa9105-b72d-4a50-9638-5ac72b891792`，asset `2ba4b312-f4ea-4903-9196-a86c0d36d4df`，941×1672。保留原横版，视觉主题与文案一致。旧失败 job 没有重试。
- 失败占位修复已部署并真实刷新验证：`1af03e8b-8b02-426b-ab5f-65ee78d3a75b-terminal-fixed.png` 中旧占位显示红色“生成失败”，不再显示正在生成。数据库终态 marker 已写入。
- 咖啡会员卡方案 `64bedf68-9071-4232-bb51-f734d5f5130f`：真实发送“取消生成”，run `7c31191a-5b8e-4ff0-93be-a74ec3c28f56` 调用取消工具，方案数据库状态 canceled，未产生图片 job，通过。更早的具名优惠券取消仅口头回复取消、旧方案仍 pending，不计作持久取消通过。
- 含糊修改“把那个改得更好看一点”只返回建议，没有写入或生图；未充分澄清指代，不计作理解目标完全通过。
- Northstar 局部按钮改紫色：run `5660857f-0b8c-4c91-876a-55efae30d4d6` 已正确指向宣传图 asset，但多图场景 target_not_found 拦截。当前最近成功成图选择器修复已完成离线测试，尚待部署后真实复测，不能算已通过。
- Pine Trail 独立画布 `bba41609-debf-41cd-8e99-01fd92af2abc` 在真实页面开启自动执行后，job `dedfe2c8-1267-4201-815b-ad25936c701c` 成功，asset `48c6e7a2-9560-4031-b8fa-88d2fa4e3acf`，1254×1254。页面刷新截图 `bba41609-debf-41cd-8e99-01fd92af2abc-autonomy-no-review.png`。
- Pine Trail 视觉人工检查：品牌文字、配色、山峰、太阳与正方形符合；要求三棵松树，但底部另有一棵装饰小树，严格数量不符。更重要的是，没有自动检查续跑，任务/图片绑定表和 continuation 均无记录。自动执行链路不通过，正在补普通空画布生图交付后的只读检查绑定。没有手动调用检查冒充自动检查。

下文保留历史故障与当时状态，最新状态以上述实测记录为准。

## 01:13 本地最新状态

- Northstar Logo → 实际 Logo 参考 → 4:5 宣传图已真实出图通过：方案/任务 `43eaa6da-582f-4d8c-a5c5-4ac260071454`，asset `aac4e6b9-e633-40ab-b845-08d7f12035f1`，1122×1402；原 Logo 未替换。文案、星轨、蓝紫品牌保持可见。截图 `00ad5da8-eebb-4cf3-97f4-bce3db48549b-logo-to-poster-4x5-complete.png`。
- 咖啡比例纠正通过：任务 `2400684a-81ea-42b3-84fd-72fc8aa2ac71`，asset `dc525718-9a4f-4fda-b48d-e04938bf7fa4`，1122×1402≈4:5；旧失败比例图片保留。新图坐标跟随旧画布布局，旧负坐标未改，不将该旧画布截图计作新首图定位验收。
- 旅行第一次参考图任务 `4771cbd9-f340-4dc0-83f8-0dfca26aed7a` 实际 HTTP 400，dead_letter、attempt_count=1、无最终 asset。根因已本地重现：全局 FormData 传给 package Undici 后变成 `[object FormData]` / text/plain。已修安全网络适配层：由全局 Request 编码 multipart 边界和字节，再将流交给 Undici；真实 SDK → 适配层离线测试也通过（不算真实出图）。
- API PID 9684 / worker PID 7952 已加载 multipart 修复。Northstar 上述带参考图成功证明该修复实际有效。
- 旅行失败后的新方案 `67aa9105-b72d-4a50-9638-5ac72b891792` 经重新确认，目前正在实际生成 9:16。旧失败任务没有重试或复活。
- Agent 取消场景：`9b72793e-2bc8-47b3-8ebc-39da6f3d737c` 经隔离 fixture 的真实取消 API 变为 canceled；方案保存恰好先于取消完成，仍为 pending，无自动生图。随后另发明确确认才创建上述失败任务。此项不是“自然语言取消图片 job”验收，不能混算。
- 失败后刷新，聊天卡片正确显示“图片生成失败”，但画布占位仍“正在生成图片”；交给 Sol 修复后台终态投影。截图 `1af03e8b-8b02-426b-ab5f-65ee78d3a75b-reference-upload-failed-settled.png`。
- 局部改色 run `6795c72e-9ebb-45db-8e35-1ce53c6f3c31` 找对宣传图 asset，但 strict quote 校验失败；诊断 sourceMatchesCurrent/sourceExists=true、quoteMatches=false。正在引入服务端原句引用编号，恢复后仍做严格校验；尚未部署复测。

以下时间段条目为历史过程，不应把“正在处理”误读为当前部署状态。

## 最新进度（2026-09-11 00:46 本地）

- 实际完成两次收费图片调用；Northstar 1:1 Logo 通过基础尺寸/内容检查，Mellow Coffee 海报实际 1024×1536，不符合请求 4:5，不能算通过。
- 咖啡方案 `03f0167f-5aaa-4711-868b-353d1dcd021c` 经真实网页保存、确认、worker 成功；原始 asset `8e1e8d68-6e44-4e6b-a7f0-d7330a48889c` 保留作失败证据。截图 `artifacts/paid-dialogue-browser/b42ddab3-873b-44b4-a10e-73b16d986e36-cafe-ratio-mismatch.png`。
- 适配器错误地将当前 `gpt-image-2.5-all` 的 4:5 请求映射成 1024×1536。现已按 all 路由省略原生 size 字段并前置比例要求，新增原始像素比例校验，错误比例不拉伸/裁切/补边，不发布到画布，不自动重复付费。供应商是否实际遵循比例仍须真实出图验证。
- 同时修复空画布默认负坐标（首图跑出视野）：新默认位置 80,80；保留用户明确位置，不移动既有作品。尚待新图验证显示。
- 本地 API PID 35700、worker PID 34276 已加载以上修复；网页生产构建未变。部署前确认没有运行中的任务。
- Northstar 续做复测 run `10770079-e6b0-47ae-a0d3-cd9e612ec5e9`：能读到真实 Logo assetId，但方案仍被门禁拒绝。页面正确显示“未保存”，没有新收费 job。继续排查，不计通过。
- 咖啡纠正比例复测 run `1a98e223-5119-4a80-bc22-65cd1a86e151`：保存方案也被拒绝；无新增收费 job，继续排查。
- 本轮集成定向 5 suites / 51 tests 通过，不能替代上述未通过的真实场景。

### 00:50 补充：第三次真实出图

- 新隔离旅行项目 `c36f8457-f1d9-4f3d-a6c6-a65f53dc58d7`，画布 `1af03e8b-8b02-426b-ab5f-65ee78d3a75b`，会话 `8d9a78dd-13f9-4603-b559-bb8791a115cc`。
- 方案 run `e0206c53-fcf1-4514-b5b3-d5ffc0b7c628` 一次成功；确认 run `d0c45632-67f9-480d-8450-288d5c6e02f9` 一次提交。
- job `6c8bc8b3-9cc4-4b48-89c5-8fe5e7d91757` succeeded；asset `99019e87-1668-45ff-b57c-56df8d8a84b7` 实际 **1672×941**，在 1% 像素取整容差内符合 16:9。
- 图片生成期间已关闭自动化浏览器；重新打开后图片完整出现在 80,80，无半图出界。截图 `artifacts/paid-dialogue-browser/1af03e8b-8b02-426b-ab5f-65ee78d3a75b-travel-16x9-complete.png`。视觉检查：雪山/森林/湖面、左侧准确品牌与副标题、无人，符合主要要求；有应用水印。
- 发现模型口头添加“包含自动去背景”，但冻结 input 无 target、无 foregroundPolicy，只有 generate。实际未抠图；已补工具回执明确无此步骤（31 条 durable 测试通过），后续部署/实测。不能把错误回复计为完整对话通过。
- 纯讨论 run `cf03ec21-4848-411d-8b1a-c9a66a4a0a19` 返回三条排版建议，tools 为空，未新增 job，通过“不误生成”边界。

## 范围与现场

这份记录只记录实际执行结果，不把场景设计、单元测试或 mock 图片算作真实生图通过。

- 隔离项目：`52f2673b-4116-44f9-a895-29d47a464202`
- 隔离画布：`00ad5da8-eebb-4cf3-97f4-bce3db48549b`
- 隔离会话：`b99b8922-5344-4998-b762-6714c0b1a17d`
- 文本模型：`gemini-3.1-flash-lite`（workspace 模型）
- 图片模型：`gpt-image-2.5-all`（workspace 模型，按近期真实成功记录选用）
- 初始积分：500；未充值、未修改共享供应商配置。
- 真实输入通过生产网页输入框发送；不直接插入方案或生成任务。原用户画布不修改。

## 已执行

| 步骤 | 真实输入/动作 | 结果与证据 |
| --- | --- | --- |
| 1 | 帮我设计一个Logo。 | 正确询问品牌名与用途，未生图。run `db561694-be07-4e44-b16e-39c737bb59b9`；发现 assistant 澄清消息在数据库中重复保存两次，另行修复。 |
| 2 | 提供 Northstar AI 记账工具、具体颜色、图形、文字、1:1 白底 PNG、新增不替换，先保存方案不要生成 | 失败。run `6779ef64-98a7-475b-a488-6f4c52cd1d07`，15:45:08–15:53:04 UTC；无工具完成、无图片任务。供应商返回 400，工具声明的 `$ref` 不兼容。页面长时间思考后仅提示通用失败，不能算通过。 |
| 3 | 换用已配置的 Deepseek 文本模型，请继续保存刚才的完整方案，暂不生成 | `inspect_canvas` 和 `generate_image` 成功，保存 pending 方案 `9c9711cc-ce41-40fe-8fff-8a2613f56745`，品牌、配色、比例等已保留。随后上下文整理 `source_mismatch` 失败，run `cef78071-5870-4097-86c3-b69580fdfc75`，不得算完整通过。 |
| 4 | 确认生成刚才保存的 Northstar Logo 方案，按该方案生成一张。 | run `1edc61f8-4296-4bd8-bde8-561f95691354`：已有 pending 方案却返回 `no_current_proposal`，最终又因摘要来源校验失败结束。没有图片任务。确认语句被当成新需求，正在修复 TS/SQL 一致性。 |
| 5 | 部署修复后原句确认 | run `d8f1a344-c5b0-4a7b-a83a-f5a1791cadd8` 直接提交成功。唯一 job `9c9711cc-ce41-40fe-8fff-8a2613f56745`，16:12:17–16:13:11 UTC，succeeded，attempt_count=1，真实 asset `d8bcd99c-bc72-4f99-ba9d-bec4353ddf1b`，1024×1024。 |
| 6 | 生图期间再次发送“确认生成” | run `67da8b9a-0c61-405a-988b-4d164b75fb44` 返回同一 job，没有增加任务。 |
| 7 | 图片完成后刷新页面 | 画布存在一个 512×512 显示元素，对应真实 1024×1024 图片；截图检查 Northstar 拼写、星轨与蓝紫配色可见，旧页面可重新载入。 |

原始脱敏轨迹：`artifacts/paid-dialogue-live/browser-turns/`。

## 正在处理

- 工具 JSON Schema 的模型兼容性，以及不可恢复的参数错误是否被无效重试。
- 工具格式错误的前端回执：静态安全说明 + `tool_schema_incompatible` + `automaticRetry: false`，相关单测 19/19 通过；尚需部署实测。
- 澄清消息重复持久化。
- 短对话在方案工具调用后发生摘要来源校验失败。

延迟证据补充：SDK 对 HTTP 400 不重试，回归请求计数确认只提交一次该失败请求。整轮耗时约 476 秒；单 TCP 连接/最终错误 request id 不足以证明整轮只有一次 HTTP 请求，目前继续核对 checkpoint 内模型工具往返，不能把总耗时全部归因于网关单次请求。

Checkpoint 已证实第二轮在同一 thread 中有 7 次 `generate_image` 尝试，参数含错误的 `model_id`、`aspect_ratio`、`target:{kind:canvas}`，被门禁拒绝但未作为前端工具事件显示。已补精确字段/目标修正提示（不自动转换用户模型与目标）以及脱敏的工具阻断事件。

尚未完成全套真实图片及后续系列验收，不得用以上单测替代。

已完成首张真实图片，后续系列验收仍进行中。应用积分仍为 500，job 的 credits_cost/transaction_id 为空；使用 workspace 自备供应商模型，不能据此宣称第三方账单免费或已核对其精确费用。

本地已应用新迁移 `20260911000001_natural_image_confirmation`，保留此前已应用迁移原文。SQL 实测长确认 true、修改和未同意 false；API 更新为 PID 33752。Web 继续使用现有生产构建，未重新启动图片 worker。

## 后续真实场景发现

- Northstar 宣传图续做 run `2e8fb744-43e1-43b1-a63b-d62c202faa17`：Gemini 完成对话、没有再报 schema 400，但两次方案工具被拒绝。模型未提供真实 `inputImages`，读原文只读了最旧五条；另一次 reviewer 把“先给我方案”误判为只讨论，不允许保存。还未产生第二张图片。
- 独立咖啡店测试：project `275b8a70-d084-4820-8a12-25cdf98f836f`，canvas `b42ddab3-873b-44b4-a10e-73b16d986e36`，session `61abe911-e1a1-459f-8dac-5a5e13778f7d`，manifest `qa-cafe-20260911.json`。
- 咖啡海报 run `7be3dfbd-961e-4b7c-adec-5ee9fdddb292`：三次调用都被拦截，依次缺 title、仍缺 title、用了错误字段 modelId；数据库无方案，模型却回复“已保存”。不能算通过。
- 已定位懒加载顺序错误：意图审核先于工具定义加载，模型猜测参数直接进入审核。候选修复首次只加载真实 schema，不执行动作，下一模型步按真实定义重试。
- 候选真实性修复：未保存的最终回复在 graph 内替换为确定性失败回执，避免把假成功带入后续上下文；拒绝之后的未经核验成功文案不先流出，正常文本流式不变。相关 109 项定向测试通过，仍待真实回归。
