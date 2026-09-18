# Luna 成员权限撤销生命周期测试（2026-09-11）

## 范围与结论

本次使用隔离 Fastify app 和内存 DB double 编排，但调用了真实 `WorkspaceMemberService.remove`、真实 workspace member DELETE route、真实 WebSocket handler 和真实 `ConnectionManager`。没有使用本地 QA workspace，没有连接外部 API/DB，没有重启服务，也没有操作原用户 canvas。

结果：

- 成员撤销前，真实 WS 协议 `canvas.resume` 成功订阅。
- 通过真实 DELETE `/api/workspace/members/:userId` 调用真实 remove service 后，内存 membership 行被删除。
- 撤销后新建 socket 的 `canvas.resume` 被真实 handler 拒绝。
- 撤销后旧 socket 仍收到 `ConnectionManager.pushToCanvas` 广播，安全断言失败。这确认现有订阅没有随成员移除失效。

证据：[ws-membership-lifecycle-harness.json](../artifacts/saas-boundary/ws-membership-lifecycle-harness.json)

## 命令与计数

`node --import tsx scripts/test-membership-lifecycle-live-harness.ts`（工作目录 `apps/server`）

- 5 项检查：4 通过、1 失败。
- 通过：撤销前订阅、真实 remove 路由 204、membership 删除、新订阅拒绝。
- 失败：`old subscription is revoked from future broadcasts`，旧 socket 收到 post-removal event。
- `realMemberService=true`、`realWsHandler=true`、`realConnectionManager=true`。
- `realDatabase=false`、`realApiProtocol=false`、`providerRequests=0`、`applicationDataWrites=0`。

## 真实与模拟边界

- 真实实现：成员服务、成员 HTTP 路由、WS 握手/命令 handler、ConnectionManager、Fastify websocket wiring。
- 隔离替身：认证 token、viewer workspace、canvas authorization、Supabase admin/user query builder 和 membership rows，全部为内存 double；因此不能宣称真实数据库/RLS 或生产广播泄露。
- 该测试仍足以证明当前组件编排语义：remove service 不通知 ConnectionManager，而 pushToCanvas 不重验 membership，旧缓存订阅继续收事件。

## 代码路径观察

`WorkspaceMemberService.remove` 删除 `workspace_members` 后直接返回；没有 revoke/close/invalidate connection 的调用。`ConnectionManager.pushToCanvas` 依据缓存 `canvasIndex` 遍历 socket，不查询当前 membership。因此新订阅会因 canvasService 的实时授权被拒，旧订阅不会自动失效。

## 未覆盖

真实 Supabase membership 删除、真实团队成员 QA workspace、跨进程广播、真实 agent run cancel、worker 重启和生产负载仍未执行。本轮刻意不将 QA 用户加入原 workspace，也未执行任何业务数据写入。
