# WebSocket 连接归属修复与后续流程

## 修改范围

- 每次连接注册得到独立的服务端内部身份。客户端 connectionId 只作提示，不参与权限或回执路由；同用户重连、跨用户同名连接均互不覆盖。
- 路由、移除和 RPC 只接受内部连接身份，删除模糊的客户端别名/userId 回退。旧身份断开后不会被同名客户端提示重新解析。
- RPC pending 绑定接收请求的连接身份与 socket 实例；他人、旧实例的回执不能完成该请求。断开后释放对应 pending，防止悬挂。

## 验收

主控验收已完成：

- 15 个相关回归文件、41 项测试通过；服务端 TypeScript 类型检查通过。覆盖全部 ws、HTTP run auth、截图 RPC。
- 在确认活动 runs/jobs 均为 0 后重载 API，当前 PID 22328；未重启 worker、无数据库迁移。
- 真实双用户/同用户同名连接探针 5/5 通过，旧连接关闭不影响新连接。证据 artifacts/saas-boundary/ws-connection-collision-29cda1c6-7ebb-4807-aad6-0f1a8a1fb5b6-retest.json。
- 真实既有 WebSocket 隔离探针 7/7 通过：其中 6 项身份/订阅隔离，1 项仅无效 run ID 拒绝，不冒充真实跨用户取消。证据 artifacts/saas-boundary/ws-isolation-00639b8f-3ee2-4e46-9c91-df007b8647a6-retest.json。
- 受控 RPC 探针 4/4 通过，B 不能代答，A 仍能正常完成。证据 artifacts/saas-boundary/ws-rpc-cross-connection-controlled-retest.json。
- 所有真实探针使用专用 QA 身份，无 provider 请求或业务数据写入；生成测试登录凭据产生认证侧记录。保留原失败证据，新复测写入 retest 文件。

新增 handler-runtime-cancel-boundary.test.ts 通过：使用实际 runtime 注册 accepted run，通过 Fastify injectWS 取消；他人不能取消、owner 可以取消，同会话可以再注册独立 run。未调用供应商，也未证明运行中第三方请求可被撤回，不计为真实付费任务取消测试。

## 继续检查发现的未修复项

团队成员移除尚未联动已有广播订阅。受控测试调用实际 workspace-member-service.remove（DB 响应受控），完成成员移除后调用 ConnectionManager.pushToCanvas，仍收到一个事件。此处是组件级组合证据，不是生产环境真实团队删除/跨进程泄露实测。证据 artifacts/saas-boundary/ws-membership-revocation-controlled.json。

应继续检查/实现工作区权限变更后的订阅失效、活动工具权限重验以及多进程失效传播；只在本地断开一个 socket 不足以解决多实例部署。

其他未完整验收：多 worker 崩溃恢复、真实未知上游结果/退款结算、生产规模负载。用户亲自试用适合评估设计质量与体验，不能替代这些工程边界测试。

## 实际分工

Sol/high 负责连接与 RPC 业务实现和定向测试；Luna/medium 调整验收脚本并检查成员移除流程；主控复核两处额外别名绕过、修正测试断言、补实际 registry 取消检查并负责部署验收。另一 Luna 的追加任务被平台线程数量限制拒绝，未计作已执行。
