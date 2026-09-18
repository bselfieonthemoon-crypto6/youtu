# Luna 深入边界测试（2026-09-11）

## 结论

本轮只做本地可控故障和隔离 fixture 测试，没有访问用户 canvas `f9ec6534-30bb-427a-8eaa-4440738530c0`，没有重启服务，没有修改业务源码，也没有提交真实生图/付费任务。新增边界测试 3/3 通过；既有相关回归合计 86/86 与 72/72 通过。当前证据支持失败恢复、同轮重复确认、9 图分批上下文范围和多轮压缩边界，但不等于多进程、真实支付网关或所有第三方超时场景已验证；主控另有 WebSocket 漏洞发现，不能据此宣布整体无问题。

## 实际命令与结果

工作目录：`apps/server`。

```text
pnpm exec vitest run src/agent/tools/image-confirmation-turn-idempotency.test.ts src/features/jobs/executors/image-generation-durable-recovery.test.ts src/agent/attachment-resolver.test.ts src/agent/context-budget.test.ts src/agent/context-compaction.test.ts --config vitest.config.ts --reporter=verbose
```

结果：5 files / 86 tests passed。覆盖同一 authenticated turn 并发确认共享回执、失败后同轮不自动重试、新轮显式恢复、取消阻断 fallback、provider definite rejection 只走一次 frozen fallback、未知结果不补偿重试、存储重试不重复 provider 调用、9 个 `inputImages` 原样传给 fallback、上下文 1000 轮和 9 图预算。

```text
pnpm exec vitest run src/agent/image-result-verification.test.ts src/agent/tools/review-image-results.test.ts src/features/jobs/node-image-submission-service.test.ts src/features/jobs/job-service.test.ts --config vitest.config.ts --reporter=dot
```

结果：4 files / 72 tests passed。覆盖参考批次与结果验收隔离、旧 job/新 job 身份边界、存储/RLS 失败关闭、节点请求重复与冲突、任务 claim 和恢复边界。

新增测试：

```text
pnpm exec vitest run src/agent/luna-deep-boundary.test.ts --config vitest.config.ts --reporter=dot
```

结果：1 file / 3 tests passed，文件为 `apps/server/src/agent/luna-deep-boundary.test.ts`。

```text
pnpm exec tsx scripts/evaluate-agent-multiturn-live.ts
```

结果：入口自报 `live=false`、10 cases、`strict_mock`、`userCanvasWrites=0`；没有发起模型请求，本轮不把它算作多轮执行成功。历史隔离运行证据 `artifacts/agent-multiturn-live/latest.json` 为 12/12 assertions passed，状态为 memory persistence、strict mock image executor、0 canvas writes，且从 M8 checkpoint 恢复执行 M9/M10；该文件不是本轮新生成，也不能作为本轮真实模型或生产链路证据。

## 新增边界覆盖

1. `4/4/1` 参考图批次逐批调用 `reviewImagePixels`，每批提示只含本批 asset IDs/count，并明确其他图片可能在其他批次；验证第 9 张单图批次不会把 `asset-1` 等邻批资产带入。固定空模型回执只证明输入范围编码，不证明模型实际不会误报。
2. 模拟单批视觉模型瞬时超时：测试代码第一次调用返回 unavailable，然后由测试代码手动再次调用同一单图批次并得到 passed；两次请求的范围均是 `asset-9`。这只证明相同范围的重复调用不会在测试夹具中扩大输入，不证明生产环境自动重试编排，也不证明生成/计费幂等。
3. 多轮消息中先后出现两轮 9 图，再在最新用户轮同时携带 9 图和最终纠正；压缩投影保留最终纠正与 9 张图片，图像估算为 `9 * 8192`，没有静默削减用户约束。

## 真实 9 图邻近证据（复用，不冒充本轮新增）

`artifacts/paid-dialogue-live/qa-nine-boundary-20260911.json` 的第 4 轮是独立 QA fixture 的真实应用链路：9 个真实附件、4 次 `review_image_results`、无 job；第 9 张首次参数校验失败，重试后读到像素，最终识别 1–9 和 ALPHA…INDIA 正确。第 2 轮无图片、tools=0/jobs=0，仍正确回答 ALPHA/ECHO/INDIA。该证据证明了当前已修复链路的恢复与短期连续上下文，但批次回执仍可能是 unavailable/viewed，不能把它标成全绿。

## 模拟 vs 真实

- 86、72 和新增 3 项均为本地 mocks/内存 fixture；没有 Supabase、队列、第三方视觉/图片 provider 或真实扣费。
- 真实 9 图证据经过 API/WebSocket→视觉处理→文本模型，使用专用 QA 资产；没有生图任务和用户画布写入。
- 既有隔离多轮报告的模型是 `apiyi:gemini-3.1-flash-lite`，不是本轮子代理模型切换；本轮只按任务要求由 Luna 完成本地测试。

## 尚未覆盖与复现边界

- 两个独立 worker 进程同时执行同一 job、worker 崩溃/重启、跨进程事件广播。
- 真实第三方 provider 已接受请求但客户端断线、未知上游结果与幂等键行为；本轮仅模拟未知/超时/存储故障。
- 真实支付网关非零扣款、退款结算及真实双客户端同时确认入队闭环。
- 复杂照片/不可读文字、超过 9 张、多轮压缩后重新要求读取历史像素，以及 9 图生图 provider 接受能力。

已知邻近问题仍按主控报告保留：真实 9 图第 9 张首次调用的 `tool_executions.input` 是单图 `result_asset_ids=[第9张 asset]`、`mode=reference_analysis`、`comparison=individual`，参数本身有效；失败发生在模型输出解析，`output.error` 为 Zod `invalid_type`，路径 `suggestions[0]`，期望 string 但收到 object。随后同一单图输入再次调用成功并读到像素。这不是“第 9 张参数错误”，而是首次视觉模型回执 schema 不符合约定。批次中间回执仍可能显示 unavailable/viewed，即使像素已读；不能仅凭最终回答声称所有批次验收通过。
