# 首批流程回归：Skill 工具契约与成本生命周期

本轮只新增回归测试与说明，保留原有用例。不修改生成流程、工具注册、Skill manifest、计费、恢复开关或数据库；没有新增 migration，也不需要重启服务。

## Skill manifest 与 Mastra 工具面

新测试 `apps/server/src/agent/mastra-skill-tool-contract.test.ts` 遍历当前 21 个 manifest，使用真实 `createMastraToolkit`、`createMastraImageTools` 工厂构建工具集合。测试不会执行写入工具或调用供应商；模型 readiness 以受控初始值隔离，结论只针对工具依赖。

- 14 个包的必需工具可在 Mastra 注册集合中满足，`list_skills` 必须实际列出这些包。
- 7 个要求 `manipulate_design` 的画板包按显式列表保持 unavailable；不使用假工具绕过 Mastra 画板只读边界。新增未知依赖或异常不可用会让测试失败。
- `discover_tools` 属于 stream runtime 的延迟加载机制，不当作 toolkit 的业务工具。复跑既有 SDK 流中的延迟工具发现测试，确认注册工具可在发现后的步骤调用。
- 注册契约不要求所有工具都在首步常驻。这个测试也不能证明旧执行入口仍被生产流程调用。

## 成本生命周期与可见性

`mastra-image-jobs.test.ts` 新增 8 个数据驱动集成场景：0/7 积分 × 排队占位、成功、取消、dead_letter。每个场景经过真实 submitter，终止分支经过真实 finalizer，仅数据库、供应商与画布写入边界使用 mock。

断言排队与回写卡片保持相同 job ID 和持久化 `creditsCost`、`pricingVersion`、`actualQuality`、`actualResolution`；成本等于持久化 job 的 `credits_cost`。排队输出为实际 `queued`，不是虚构的 processing DB 状态。终止状态保留成本记录；不引入 `output.billing.charged`。

Web 在保留原有测试外新增 32 个组合：generate/edit × 0/7 积分 × queued、processing、succeeded、finished、failed、canceled、dead_letter、refunded。真实组件验证前四种显示中性的“本次任务”回执，后四种隐藏；同时核对非默认质量、分辨率与历史计价版本。记录存在不等于宣称已扣费。

## 验收

139 个不重复的选定用例通过，全部单 worker、按批次串行运行：

| 文件或选定范围 | 用例 |
| --- | ---: |
| mastra-image-jobs | 34 |
| job-canvas-finalizer | 24 |
| mastra-toolkit | 6 |
| 新 manifest 契约 | 1（遍历 21 个 manifest） |
| mastra-agent 延迟发现专项 | 1（其余 16 个本次未选） |
| Web tool-block-view | 73 |

主控以 1536MB 完成服务端生产源码 typecheck（排除测试的既有临时配置），exit 0。未跑全量类型检查；Web 生产源码未改动，其此前两处类型问题不在本轮修复范围。Web 3020 和 API 3002/api/health 均返回 200。

实际分工：Terra（medium）编写 manifest 契约测试；主控复核、补成本生命周期和前端矩阵、执行串行验收。后续上下文连续性、并发专项和观测字段不属于本轮。
