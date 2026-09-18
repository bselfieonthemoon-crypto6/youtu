# 多用户 SaaS Agent 边界验收（2026-09-11）

## 结论

本次实测未发现跨租户数据读取/写入成功，真实非零并发计费也没有重复入账。但仍有错误反馈及提示信任边界待完善，不能据此宣布全场景生产安全。此次只修改测试脚本、测试及报告，没有修改或重启生产服务。

## 标准与方法

使用 OpenAI Docs 核对 [Agent 安全指南](https://developers.openai.com/api/docs/guides/agent-builder-safety) 与 [评估最佳实践](https://developers.openai.com/api/docs/guides/evaluation-best-practices)。据此检查非可信数据的消息角色、结构化接口与针对异常轨迹的评估。它们不是完整的 SaaS 合规认证；租户隔离、账务和并发用真实本地 API/PostgreSQL 单独验证。

实际分工：Luna/medium 做失败/并发可控回归及 WebSocket 验证；复用已核实的 Luna/medium 做上下文/Skills 可控回归。主控负责双租户 API/RLS、真实非零账务并发、真实 9 图与复核。第二个新代理因平台数量限制改为复用，没有暗中升级子代理模型。

## 真实 API、RLS、存储与计费

脚本：apps/server/scripts/test-saas-isolation-live.ts。
最终证据：artifacts/saas-boundary/isolation-00639b8f-3ee2-4e46-9c91-df007b8647a6.json。

- 两个全新账号、两个独立个人工作区，双向测试；82 项断言，78 通过、4 失败。
- 用户只能读取自身项目、画布、任务；对方数据返回 404。聊天列表返回 200 空数组，无私有消息内容，因此不算泄露。
- 直接 RLS 对项目、画布、会话、消息、任务、资产均隐藏对方行。
- 对方不能下载或签发私有图片地址；匿名 public URL 不能绕过访问控制。
- 跨租户画布保存、项目更新和真实存在的 job 取消被拒绝；聊天写入也未落库，但错误码不正确，见下方。
- 交错并发 viewer 请求保持各自 workspace。
- 真实扣费 RPC 四并发：仅一次 charged_new，余额只减 5。
- 真实退款 RPC 四并发：一次成功，其余 credit_job_already_refunded；只存在一条扣费与一条退款，净额为 0，余额准确恢复。普通外国租户 JWT 无权调用退款 RPC。
- 这些是本地数据库积分，不是第三方支付结算或真实付费任务失败退款。计费 QA job 从未进入队列，最后为 canceled。

初次探针为 72 项/6 未通过，其中两项是测试把安全的空消息列表也要求为 404；核对实际空响应后修正断言，并用新的双用户 fixture 重跑。旧证据保留为 isolation-faa5be17-b76c-4214-9034-1bc7ecb768a7.json，不能将其当成泄露证据。

WebSocket 另有 6 项真实隔离检查通过：双方恢复自身画布、不能恢复对方画布、连接不能换绑另一个用户、换绑拒绝后保留原身份。第 7 项只是无效 run ID 返回 not found，不作为跨用户取消验收。证据：artifacts/saas-boundary/ws-isolation-00639b8f-3ee2-4e46-9c91-df007b8647a6.json。未向活动流注入事件，不能据此声称验证了所有广播隔离。

## 可控回归

主控合并复跑 8 个文件，186 tests 全部通过（各子报告计数与此重叠，不累加）。覆盖取消后不开始 fallback/后处理、同轮确认幂等、非零退款调用竞态、技能恶意正文和交错状态、长历史投影。

1000 轮及 9×8192 图片 token 是离线投影/预算测试，不是 1000 次真实请求。恶意 Skill 测试证明正文未提升为系统角色，不能证明所有提示注入都无法影响模型。

## 真实九图与后续对话

证据：artifacts/paid-dialogue-live/qa-nine-boundary-20260911.json。
会话：056b5b6e-e8e5-405c-bc91-434171478bde，画布：3619585d-8be8-4859-9162-61e92cb8d03a。

- 9 张用代码制作的 512×512 测试卡，图片上有数字与英文，文件名不包含答案。不是 AI 生成图片。
- 实际发送 9 个真实资产附件，经应用 WebSocket→视觉处理→文本模型流程。日志 attachments_analyzed count=9。
- 真实 DeepSeek 对话第 1 轮逐一正确识别 1–9 与 ALPHA/BRAVO/CHARLIE/DELTA/ECHO/FOXTROT/GOLF/HOTEL/INDIA。检查工具分批调用；一次 image_review_timeout（viewed=false）后再次读到第 9 图像素（viewed=true），没有终止对话。但批次回执错误判断“缺少其余图片”，不能把工具状态判为全绿，见问题 4。
- 第 2 轮不传图片、不重新识图，正确回答 ALPHA、ECHO、INDIA；tools=0，jobs=0。
- 2 轮是真实模型对话，不等于仅 2 次供应商调用；主模型、视觉预处理及分批检查可能各自调用。未提交任何生图任务。
- 这证明真实九图识别及短期连续对话，不证明 GPT Image 2 同时九图生成、复杂照片识别、长期压缩后的像素恢复。

## 待处理发现

1. **P2 未授权聊天写入错误映射**：对他人 canvas 创建会话、向他人 session 写消息均返回 500/chat_error，而非明确 403/404。双向复现共 4 项失败。RLS 实际阻止落库，未证明越权成功。位置：apps/server/src/features/chat/chat-service.ts 的 createSession（约 101–115）与 createMessage（约 188–223）。建议先验证所属范围，再按权限/不存在分类响应，避免前端当作临时服务故障重试。
2. **P2 重复退款的服务反馈**：worker 的查后调用存在竞态，数据库正确串行化且不会重复退款，但第二个服务调用抛重复退款错误。建议返回可验证的既有退款结果，保留 workspace/job/金额校验，不能吞掉任意数据库异常。详见 luna-failure-boundaries-20260911.md。
3. **信任边界待专项验证**：deep-agent.ts 的 CurrentConversationIntent 将 currentUserPrompt 序列化追加到 SystemMessage，虽标注为数据且后端另有权限门禁，但与官方“不把非可信变量放进高优先级消息”的建议不一致。这是代码审查风险，不是已复现的越权。建议将原话留在用户角色、系统只放固定解释规则，再做最终请求回归及对抗测试。
4. **P2 多参考图检查批次范围误报**：真实请求 9 张图，reference_analysis 分成 4/4/1 张，但每批仍使用要求识别全部 9 张的 currentUserPrompt。三个读取成功的批次分别返回 unavailable/failed/unavailable，原因均包含“仅提供 N 张，缺少其余图片”。原文同时准确识别了该批数字与单词，主 Agent 最终正确合并，但工具状态和错误提示不准确。位置：apps/server/src/agent/tools/review-image-results.ts 约 174–178 的 taskBrief 传递。建议提供服务器可验证的本批资产与全局序号/总量，不将批次外的图判作缺失；reference_analysis 与成图验收语义分开。

## 仍未验证

完整真实支付网关退款、多个 worker 进程崩溃/重启竞态、真实双客户端同时确认的完整入队闭环、团队角色撤销后现有连接权限、跨进程事件广播、真实超长对话、9 图生图供应商接受能力、生产规模负载和公平调度。

保留 4 个新增隔离 QA 账号及其工作区/测试资产、一个九图 QA 项目便于复核；没有删除任何原有用户数据。登录及创建 fixture 会写入本地认证/业务测试记录，不能声称“没有数据库写入”。
