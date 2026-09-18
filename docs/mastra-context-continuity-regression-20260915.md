# Mastra 上下文连续性回归（2026-09-15）

## 范围

只新增测试与本说明，不修改生产流程、压缩算法、价格、数据库或工具契约。下一步并发专项与观测字段不在本轮范围。

新增 `apps/server/src/agent/mastra-context-continuity.test.ts` 两个运行时边界用例，使用真实 `createMastraRunFactory`、历史上下文编译器及来源简报构建函数。数据库、工具工厂、外部摘要模型和最终 SDK stream 是隔离边界；不调用付费模型。

## 锁定的契约

- 当前持久化消息按 ID 去重，当前用户原话完整保留且在最终消息中只出现一次。
- 品牌「澄屿」逐字进入最终请求；摘要指令明确原文保留和最新纠正优先。
- 来源简报使用真实的六个用户轮次窗口；窗口外旧风格不进入这个简报。普通历史证据仍允许保留旧品牌和旧风格，这不是全历史语义删除。
- 超预算时显式注入摘要供应商故障；断言实际尝试摘要，并解析最终 `current_context.historyOmissions`，确认不可用原因被记录、当前原话仍完整。
- 数据库分页夹具按实际 range 返回片段；固定 legacy 历史编译模式，避免开发机环境变量改变测试路径。

这些测试证明上下文传递及指令契约，不证明真实模型在所有自然语言措辞下都会正确消解纠正，也不覆盖 observational memory 分支。

## 验证

单 worker 定向集：

```powershell
pnpm exec vitest run src/agent/mastra-context-continuity.test.ts src/agent/mastra-context.test.ts src/agent/mastra-runtime-context.test.ts src/agent/mastra-image-source-grounding.test.ts --no-file-parallelism --maxWorkers=1
```

结果：4 文件、36 项通过（新增 2 / context 14 / runtime-context 6 / grounding 14）。

生产源码类型检查：使用排除 `*.test.ts` / `*.spec.ts` 的临时 server 配置，`tsc --noEmit` exit 0。未运行全量类型检查，避免此前的内存耗尽风险；该结果不等同于测试源码全量类型检查。

分工：gpt-5.6-terra、medium 起草新增测试；主控收紧分页、显式摘要故障、原文去重与 JSON 遗漏断言，并完成集成验证。
