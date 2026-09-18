# Luna WebSocket ownership retest（2026-09-11）

本报告是修复后的持续验收脚本契约；本轮未修改业务源码、未重启服务。脚本会在 Sol 修复 `ConnectionManager`/handler 后重跑。

主控后续已完成加载与复测，结果见 ws-ownership-fixes-20260911.md。主控修正了碰撞分支的断言和 RPC 内部 ID 使用，并将成员测试改为实际调用 remove 服务（受控 DB），避免仅改变一个无关联常量作为撤销证据；旧失败文件保留，修复后证据写入 retest 文件。

## 修复后必须满足的断言

- 跨租户复用同一客户端 `connectionId` 必须在握手时明确拒绝，或允许两条连接但严格隔离：A 回执只能到 A、B 回执只能到 B，关闭旧连接不能删除新连接。
- 同一用户使用同一 `connectionId` 重连仍是允许路径；旧连接关闭后，新连接仍可恢复自己的 canvas。
- RPC response 必须校验来源 connectionId：B 的伪 response 不得完成 A 的 pending；随后 A 的真实 response 必须正常完成，避免安全修复造成永久 pending。

## 新增/调整脚本

- `apps/server/scripts/test-ws-connection-collision-live.ts`
  - 真实 API/WebSocket 双 QA 用户碰撞测试。
  - 兼容两种安全实现：B 握手被拒绝，或两连接共存但完全隔离。
  - 增加同用户重连及旧 socket 关闭后的新 socket 可用性。
  - 仍不启动 agent run、不调用 provider、不触碰原用户 canvas。
- `apps/server/scripts/test-ws-rpc-cross-connection-live.ts`
  - 受控内存测试；B response 先尝试污染 A pending，随后 A response 完成同一 RPC。
  - 不是网络/跨用户生产广播实测。
- `apps/server/scripts/test-ws-membership-revocation-controlled.ts`
  - 受控检查：模拟 `workspace_members` 删除后，缓存 canvas subscription 是否仍收到广播。

## 成员移除流程当前证据

受控脚本当前失败：membershipExists=false 时仍 deliveredFrames=1。代码路径显示 `workspace-member-service.remove` 只删除 `workspace_members`（约 139–146 行）；`ConnectionManager.pushToCanvas` 仅依据 `canvasIndex` 向已绑定 socket 推送（约 153–166 行），没有实时成员资格重验或撤销订阅。因此当前只能报告为“成员移除后旧 socket 仍可收到 canvas 广播”的受控复现；尚未对 QA 团队成员执行真实删除，未操作原用户数据。

证据：[ws-membership-revocation-controlled.json](../artifacts/saas-boundary/ws-membership-revocation-controlled.json)

## 真实/模拟边界

- 真实：collision 脚本的双 JWT、双 socket、同 ID 握手、canvas.resume、close 生命周期。
- 模拟：RPC ownership 和 membership revocation，均为进程内 fake socket，无 DB 写入、无 provider 请求。
- 尚未覆盖：真实 agent run registry cancel、跨进程广播、团队成员撤销后的真实长连接、生产负载。
