# Luna WebSocket 深入边界测试（2026-09-11）

## 结论

在 API `127.0.0.1:3002` 上用保留的隔离 QA 双用户 fixture 做了真实双 socket 测试，复现了客户端可控 `connectionId` 的跨租户连接碰撞：A、B 使用同一个 `connectionId` 时，A socket 发出的 `canvas.resume` 成功回执被发送到了 B socket；A socket没有收到回执。随后关闭旧 A socket，B 的替换连接也收不到自己的 `canvas.resume` 回执，说明旧连接的 `remove(connectionId)` 会误删新连接。

另外做了一个不触网的受控 `ConnectionManager` RPC 回归：A connection 发起 RPC 后，使用 B connectionId 但已知请求 UUID 的 `rpc.response` 可以 resolve A 的 pending Promise。该项是内存级协议归属缺失证据，不是跨用户生产广播实测。

本轮没有改业务源码、没有重启服务、没有入队 agent run、没有 provider 请求，也没有操作原用户 canvas `f9ec6534-30bb-427a-8eaa-4440738530c0`。

## 实际命令与计数

1. `node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx scripts/test-ws-connection-collision-live.ts`（工作目录 `apps/server`）
   - 3 项检查：0 通过、3 失败；失败本身是预期的安全回归证据。
   - 真实网络/WebSocket、双 QA 用户、2 个 JWT；`providerRequests=0`、`applicationDataWrites=0`。
   - 证据：[ws-connection-collision-29cda1c6-7ebb-4807-aad6-0f1a8a1fb5b6.json](../artifacts/saas-boundary/ws-connection-collision-29cda1c6-7ebb-4807-aad6-0f1a8a1fb5b6.json)

2. `node --import tsx scripts/test-ws-rpc-cross-connection-live.ts`（工作目录 `apps/server`）
   - 3 项检查：2 通过、1 失败（foreign B response resolve A RPC）。
   - 受控内存测试，不访问 API/DB/provider；`realNetwork=false`、`providerRequests=0`、`applicationDataWrites=0`。
   - 证据：[ws-rpc-cross-connection-controlled.json](../artifacts/saas-boundary/ws-rpc-cross-connection-controlled.json)

## 真实 vs 受控

- 真实：握手认证、同 ID 双 socket 注册、A/B canvas.resume、旧 socket 关闭后的替换连接行为。
- 受控：RPC pending/response 归属，使用 fake WebSocket 直接调用 `ConnectionManager`；没有伪称为真实跨用户广播。
- 未执行真实 `agent.run` 或 `agent.cancel`：当前取消注册位于内存 `agentRuns`，仅插入 background_jobs 不能证明真实运行注册，且本轮明确避免排 worker 任务。
- 未注入活动 canvas 事件；没有把广播隔离声明为已验证。

## 证据解释与未覆盖

- `register(connectionId, userId, ws)` 允许第二个用户覆盖同 ID entry；handler 的 disconnect 回调仅按 ID 调用 `remove(connectionId)`，因此旧 socket 可删除新 entry。回执路由通过同一个 ID 的 manager entry，构成跨 socket/跨租户响应错投。
- `handleRpcResponse(connectionId, msg)` 按 UUID 查 `pendingRPCs`，没有校验响应来源 connectionId；已知 UUID 的外部 socket可代答。UUID不可预测性降低了可利用性，但不替代归属校验。
- 未验证真实多进程广播、团队成员权限撤销、生产负载、真实 agent run registry cancel、真实 provider/RPC 浏览器回执。

## 变更边界

新增仅测试脚本 `apps/server/scripts/test-ws-connection-collision-live.ts`、`apps/server/scripts/test-ws-rpc-cross-connection-live.ts` 与本报告；没有修改 `apps/server/src` 业务实现。
