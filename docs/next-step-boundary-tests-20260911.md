# 下一步边界测试汇总

后续修复状态：本报告记录的两项确认问题已完成修复，并在真实双 API + 本地数据库复测通过；过程中发现的 WebSocket 首帧丢失也已修复。见 [实时连接边界修复与复测](./realtime-boundary-fixes-20260911.md)。以下保留原始失败证据，worker 边界仍须按下文限定范围理解。

本轮继续测试而非修复：未修改业务实现、未重启 API/worker、未使用原用户画布、未调用第三方模型或生图。两个实际 gpt-5.6-luna / medium 子代理分别检查成员生命周期与 worker 恢复，主控复核并补双实例 outbox 测试。

## 1. 成员撤销：处理链复现旧订阅未失效

使用真实 member DELETE route、WorkspaceMemberService.remove、Fastify WebSocket handler、ConnectionManager；认证、viewer、canvas 权限查询及 DB 是隔离替身。

主控独立重跑 test-membership-lifecycle-live-harness.ts，5 项安全检查中 4 项通过、1 项失败：
- 撤销前可以订阅；删除路由返回 204，受控成员行删除；撤销后新连接不能订阅。
- 已订阅的旧连接仍收到撤销后的事件。

这是服务/协议处理链的受控复现，不是实际生产团队 DB 删除。证据 artifacts/saas-boundary/ws-membership-lifecycle-harness.json。应修复旧订阅失效，并覆盖跨实例传播。

## 2. 多实例设计通知：全局出箱与本地广播不匹配

主控新增并运行 test-design-outbox-multi-instance-controlled.ts：两个独立 ConnectionManager 与真实 DesignOutboxService/真实 broadcaster，共享受控单次领取仓库。生产 SQL 的领取函数使用 FOR UPDATE SKIP LOCKED，发布状态是全局的；app 为每个实例创建各自的 manager 与 dispatcher。

2 项投递要求均未满足：
- A 领取并标记 published，A 连接收到 1 条，B 连接收到 0 条；B dispatcher 已无该事件可领取。
- A 没有本地连接时仍标记 published，只有 B 有连接也收不到事件。

证据 artifacts/saas-boundary/design-outbox-multi-instance-controlled.json。这是双实例组件模拟，不是启动两个生产进程或真实数据库集群的实测；说明当前代码缺少面向所有实例的广播交付环节。不能把全局 published 等同于全部实例/浏览器已收到。需要共享广播机制或按实例投递/补拉策略，而不是让多个实例竞争后只向本地发送。

## 3. Worker 恢复：范围与证据限制

详见 docs/luna-worker-recovery-next-20260911.md。可控测试应只认定通用 worker 在模拟租约过期后能够再次进入 executor；不能将 mock executor 两次进入等同于真实供应商重复计费。视频 executor 有 VT 续租，图片 executor 另有持久化恢复保护；需要区分不同执行器与消息重新可见的前提。真实双进程崩溃、数据库租约竞争及供应商幂等尚未完成实测。

## 基线和结论

主控复跑 outbox service、member service、member routes、context recovery 的 4 个既有文件，12/12 tests 通过。它们不覆盖上述生命周期/双实例组合问题，因此不与新增失败探针矛盾。

当前仍不适合宣布多用户部署边界全部通过。优先修复成员撤销联动与跨实例事件交付，再做真实隔离部署复测；用户上手试用不能替代这些检查。
