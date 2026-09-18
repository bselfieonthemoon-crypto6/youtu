# Mastra 上下文观测与一致性护栏

## 范围

仅增加脱敏日志、测试和说明。不改变预算参数、历史分页、压缩算法、自修复行为或数据库；不增加 migration。测试不调用付费模型。

## 日志口径

- `[mastra-context]` 移至最终用户消息装配之后。保留原有统计，新增 `sourceExhausted`、`summarized`、`summarizerBatches`、`summarizerDurationMs`、`currentContextBytes`。
- `messageCount` 现在统计最终装配的消息，包含历史摘要与当前用户消息；`currentContextBytes` 包含当前原话及整个 `<current_context>` 包。
- `summarized` 表示最终存在非空摘要，不等同于本轮模型成功生成过摘要。
- 摘要调用数与耗时只覆盖 legacy 历史编译 callback，失败调用通过 finally 计入。observational 模式返回 null，避免把未观测到的调用报成零。
- `[mastra-context-budget]` 在 agent 装配处估算首次消息、实际系统指令及全部注册工具定义（含 discover_tools），记录 `estimatedInputTokens/inputCeilingTokens/softLimitTokens`。
- 使用全部注册工具是保守估算，可能高于首次实际启用的工具集合；不覆盖后续工具结果、自修复附加指令或供应商转换，不是 wire 实测 token，也不增加拒绝闸门。
- Schema 无法转换时估算值返回 null 并记录 `schemaEstimateAvailable=false`，不影响执行。日志不输出原文、摘要、工具描述、附件或凭据。

此前的 `openai-compatible-chat-model.ts` wire guard 属于 LangChain 兼容模型路径，不能直接证明 Mastra AI SDK 模型具有同样的 wire guard；本轮没有重构模型通道。

## 连续性测试

在既有真实运行时边界测试中增加：

1. 旧风格仍在最近窗口、连续品牌纠正、否定助手建议：保留按时间排序的证据，当前原话最后，并锁定摘要指令的纠正与未采纳建议规则。
2. 摘要成功路径：外部摘要模型返回显式 synthetic 结果，品牌与多语言文案逐字传入历史摘要，并标明它不是当前用户指令。
3. 日志断言：摘要失败次数、耗时、遗漏、最终消息字节数与真实装配结果一致，不泄露原话。

这证明传递与指令契约，不声称模拟模型证明了真实语义理解或全历史旧风格删除。

## 验证方式

测试固定单 worker：`--no-file-parallelism --maxWorkers=1`；生产源码类型检查排除 test/spec，内存上限 1536 MiB。不运行全量类型检查。

主控定向集：agent 17 / continuity 4 / runtime-context 6 / context 14，共 41 项通过。生产源码 `tsc --noEmit` exit 0。

最终主控集成：上述 41 项加预算 bridge 15 项，5 文件、56 项通过（单 worker，exit 0）。新增测试源码未做全量类型检查。源码变更尚未重建或重启正在运行的 production Web/API；日志将在新版本加载后生效。

预算 bridge 新增 15 项：7 组代表性能力/策略组合分别使用 1/32 条历史消息，摘要与历史共享完整 byte 上限，并叠加明确大小的非 ASCII 系统、工具及当前请求开销；14 项正常容量场景满足 token ceiling。

剩余 1 项记录实际边界：合法 verified profile 的 window=8,192 / input=1,024 / output=256 时，历史编译器仍有 1,500-byte 下限。最坏非 ASCII 历史加固定开销会超 token ceiling，测试明确断言该风险存在，而不是把它伪装成容量验收通过。本轮不修改行为；如需支持这种小输入容量，应另行修正桥接下限或模型可用性规则。

该测试只检查指定消息数量和明确大小的开销，不保证任意当前输入、工具集合或历史消息数量都能装入模型。

分工：gpt-5.6-terra（medium）编写预算 bridge 纯测试；主控补日志、连续性测试并完成集成验收。
