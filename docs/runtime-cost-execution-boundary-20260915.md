# 本地运行环境与 Mastra A/F 执行边界

## 本次行为

- 保留需求明确后直接执行。只展示提交回执中的实际成本；提交前预览后续补充。
- 回执携带服务端持久化的 `creditsCost`、`pricingVersion`、`actualQuality`、`actualResolution`。排队与完成卡片显示“本次任务”，失败、取消与退款状态隐藏成本展示。当前本地商业化开关关闭，实际 0 积分如实显示。
- 默认 Low（`standard`）+ 1K。Medium/High 与 2K/4K 分别要求本轮用户原文明确授权；引用内容、历史对话和生成提示词不能授权升级。未授权请求在建任务、扣费之前明确拒绝。
- generate/edit 共用单 run 数量额度：默认 4，环境配置可降至 1–4，明确请求数量最多 8。数据库锁定当前 run 并统计全部状态的既有任务，避免跨进程循环提交；同一任务重放不增加数量。
- 旧 GPT 执行分支未传递 2K/4K 时明确拒绝升级。旧 `remove_background` 执行器固定 Medium + 1K，禁止与回执档位不一致；默认 Low 的去背景继续使用现有 `edit_image` 透明 PNG 流程。
- 不修改价格表、供应商重试/checkpoint、旧确认链、design-target 路径、D 自修复和 G 协作权限。

## 本地运行

- 实际地址：Web http://localhost:3020，API http://localhost:3002/api/health；两者重启后均返回 200。3001 的其他项目保持运行。
- 已验证进程命令行：Web PID 41676 / 1024MB，API PID 15964 / 1024MB，worker PID 27212 / 1536MB；worker 日志确认启动。
- 四个本地启动/构建脚本提供独立 Node 堆上限。测试文件并行关闭，单 worker；包测试串行。此次生产 Web 构建以 1536MB、单 CPU 完成，使用 `.next-production-cost-boundary-20260915`。
- 堆上限约束 V8 老生代，不能作为进程总内存或系统总内存上限。没有关闭其他应用、WSL 或清理用户文件。
- 本地副本已事务应用迁移 `20260915000005` 和后续增量 `20260915000006`。没有应用到云端数据库。

## 验证

304 个不重复用例通过，测试单 worker 执行：

| 范围 | 用例 |
| --- | ---: |
| image-tool / image-jobs / execution-policy / finalizer / job-service / native-ratio | 163 |
| 计费与供应商参数矩阵 | 51 |
| 成本卡片渲染 | 41 |
| agent / source-grounding / native-ratio-preflight | 34 |
| ratio-state / toolkit / 迁移后的 skill 集成 | 15 |

主控独立执行隔离数据库烟测：23 组 JS/SQL 授权对照；旧去背景 Low/Ultra/2K 拒绝、已授权 Medium1K 接受；8 个并发提交仅 4 个接受；达到上限后的重放仍返回同一任务。隔离记录均为取消状态，测试 schema 清理完成，没有调用付费图片服务。

计费采用 quality 与 resolution 的较高档位，重复映射具有幂等性；没有证实重复计费。矩阵覆盖当前配置口径与供应商请求参数，不代表已核对供应商真实结算价格。详细矩阵见 `image-cost-receipt-matrix-20260915.md`。

服务端生产源码类型检查通过（临时配置排除测试文件，1536MB，exit 0）。完整 server typecheck 在 768MB、1536MB 均堆耗尽；完整 Web typecheck 在 768MB 堆耗尽，因此不能声称全量类型检查通过。Web 构建沿用既有跳过类型错误配置。自然语言授权依然是有明确测试的正则启发式，极端表达可能被拒绝。

Web 生产源码类型检查完成（1536MB），报告两个之前已记录的 `accessToken` 可选参数类型问题：`image-selection-toolbar.tsx:116`、`design-image-tools.tsx:114`，exit 2。本次成本卡片文件没有类型诊断；不据此声称 Web 全量类型检查通过。

## 实际分工

- Luna / medium：启动脚本内存配置与串行测试设置。
- Sol / high：服务端当前轮授权、持久化回执、单 run 原子边界及 SQL 烟测。
- Terra / medium：成本卡片与计费/供应商矩阵测试。
- 主控：交叉复核、构建、独立数据库烟测、本地迁移与重启验收。
