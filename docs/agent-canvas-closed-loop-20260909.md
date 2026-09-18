# 画布 Agent 闭环：第一阶段实现与验收（2026-09-09）

## 本轮范围

本轮把“任务规划 → 获准执行 → 异步结果 → 真实验收 → 下一步建议”接为可持久化、可纠正、可追踪的最小闭环，并补全画布观察和任务级评测入口。不是宣称 Agent 已经能够完全自主完成任意多画板项目。

### 1. 可持久化的任务工作流

- 在已有设计任务的 brief 中维护有版本的工作流，最多 20 步，校验依赖环、重复 ID 和目标范围。
- 模型可以描述计划、读取计划及选择就绪步骤，不能直接把步骤标记为完成。
- 计划仅列可执行交付步骤；读取、Skill 选择和验收内嵌在交付步骤里。成功读取画板不能把“修改海报”步骤标记为完成。
- 生成提案、真实 job、执行结果、实际验收结果分别绑定；多个生成结果逐个验收，不用最后一张的结果代替全部。
- 工作流版本 CAS 与任务 revision 一起校验，普通 brief 更新不能覆盖并发的工作流进度。
- 工作流计划不授予执行权限。跨目标步骤仍需要确认，已存在的用户意图、目标绑定、付费确认与纠正规则继续生效。
- 聊天中显示步骤、进度、待生成/需处理状态和需确认的目标。

### 2. 异步图片结果接续

- 已绑定当前任务的 image_generation job 产生持久结果事件；成功事件在结果已落画布/聊天后才就绪。failed、canceled、dead_letter 也有终态记录。
- 用户明确打开“出图后自动检查并整理下一步”后，当前页面以用户认证身份领取事件。默认关闭，重新打开页面或切换会话需要重新启用。
- 使用原任务、原目标、原模型和当前纠正；不把后台结果伪装成用户授权的新指令。
- 每个结果最多 4 轮主模型决策、1 次视觉检查。接续不做模型摘要、不恢复整段聊天 checkpoint；使用当前任务约束和有界画布观察。禁止生成、重试图片、修改作品、执行脚本与委派。
- 独立图片绑定确切 job/asset；画板检查要求本次生成 asset 仍在实际画板中，强制读取同步后的预览像素。结果被替换、用户纠正、预览变化、图片不可读时不能宣称验收通过。
- 领取、run 绑定与发布有数据库租约。重复领取、旧结果晚到、普通新指令抢占、停止、进程中断都有明确终态；未知结果不自动重发模型请求。
- 检查结论与事件完成原子保存到聊天；字节预算防止长中文结论超过数据库限制。

### 3. 全画布观察

- 全局摘要覆盖全部有效节点的数量、类型、范围、区域和关系，优先带入选中节点，不再固定只取前 30 项。
- `inspect_canvas` 支持搜索、区域、精确 ID 和修订绑定分页；截断时明确告诉模型还有哪些细节未读取。
- 125 节点的真实 runtime 回归确认第 110 个选中节点进入实际模型输入。
- 观察不等于写权限。写入意图审核仍保留独立上限；超过安全观察预算需要缩小目标/分批，不能直接全画布无边界操作。

### 4. 任务级评测

- 10 个固定场景，覆盖指代、目标、保护对象、用户纠正、批量提案、异常恢复等。
- 提供真实 Agent 图 + 隔离工具 fixture 的评测入口。默认 dry-run，不读密钥、不请求模型。
- 只有显式 `--live` 才调用真实模型，设全局调用上限；fixture 不提交真实生图，不修改真实画布。
- 脚本测试验证流程规则；真实模型评测验证决策表现；真实图像质量评测是另一层，三者不能混为一谈。
- 具体运行参数见 [任务级评测说明](./canvas-agent-task-evaluation.md)。

## 验收证据

最终回归于本地 22:22 启动，全部通过：

| 验证 | 结果 | 命令/证据 |
| --- | --- | --- |
| 服务端完整回归 | 215 文件 / 1,820 项通过 | `pnpm --filter @loomic/server exec vitest run --maxWorkers=2`；`artifacts/agent-closed-loop-server-final.log` |
| 网页完整单元回归 | 102 文件 / 651 项通过 | `pnpm --filter @loomic/web test --maxWorkers=2`；`artifacts/agent-closed-loop-web-final.log` |
| 共享契约 | 14 文件 / 184 项通过 | `pnpm --filter @loomic/shared exec vitest run --maxWorkers=2` |
| 类型检查 | server / web / shared 全通过 | 三个包的 `typecheck` |
| 工作区结构检查 | 9 项通过 | `pnpm run test:workspace` |
| PostgreSQL 事务验证 | 部署前及部署后均通过 | `node scripts/test-agent-continuations-local.mjs`；每次均 ROLLBACK |
| 评测入口 dry-run | 10 个场景 / 0 次真实模型调用 | `pnpm --filter @loomic/server exec tsx scripts/evaluate-canvas-agent.ts` |
| 本地 API / 网页 | HTTP 200 | `GET :3002/api/health`；`GET :3020/home` |
| 未认证的接续/停止 | HTTP 401 | 实际 HTTP 请求，无用户凭据 |

三个应用包合计 **2,655 项自动化测试**，另有 **9 项工作区检查**通过。数据集 hash：`98ceb06b1a90f136eab5b9357179cfcc14012c47ed6d85ef1058f4b6c884daf4`。

真实 runtime 测试验证当前目标/纠正、独立上下文和第 110 个选中节点进入模型调用入口；真实 Agent 图的离线模型测试验证 4 次主调用上限、额外摘要为 0、委派在 intent reviewer 之前被阻止。503 故障模拟确认接续模型关闭 SDK 内部重试，原模型配置不变。

网页最初误用 `vitest run`（未限定 `test`），将 Playwright 专用文件也当成 Vitest 文件加载，出现 25 个测试入口错误；已按项目 `test` 脚本重跑并通过。这里不把它们当作浏览器端到端测试通过。

本轮未运行真实模型评测，未调用付费生图/改图/视觉 API，未修改用户实际画布。

## 本地部署

- 新增 migration `20260909000017_agent_task_continuations.sql` 与 `20260909000018_agent_workflow_cas.sql`。
- `node scripts/apply-local-agent-closed-loop.mjs` 默认只读预检；`--apply` 仅能部署到固定开发副本，且要求没有进行中的 Agent/图片任务。
- `node scripts/test-agent-continuations-local.mjs` 在事务中验证结果记录、租约、停止、新指令抢占与权限，所有测试数据回滚。
- 两项 migration 已注册到 `loomic_replica_light_20260907`，没有部署到远程/生产库。
- 本地 API 已在 22:23 重启为 PID `21076`；日志 `artifacts/agent-closed-loop-server-20260909-222313.out.log` / `.err.log`。重启前确认没有进行中的任务；Worker 保持运行，网页使用热更新。

## 明确尚未覆盖的能力

1. 这是“认证页面驱动”的接续：关闭页面后不会持续领取任务。事件持久保留，不是无人在线的后台自主 Agent。已经发出的模型请求可能继续完成并产生费用。
2. 接续只做结果检查及下一步建议，不会自动执行下一步付费出图或设计修改。自动修复循环需要另行确定预算、授权和停止策略。
3. 仅覆盖已绑定当前设计任务的生成 job；普通未绑定任务的节点出图不是自动接续对象。
4. 多目标计划不是跨画板写权限；本轮没有取消单目标安全边界。
5. 没有实际运行 live 模型评测，因此不能声称“用户意图理解 100%”或给出未经实测的通过率。
6. 没有引入 Qwen 分层、其他新模型、知识库或后台常驻委派执行器。
7. 原生破坏性修改若返回 `confirmation_required`，工作流保守显示“需要处理”。已有确认流程不被绕过，但本轮尚未增加“用户确认后自动回填原生步骤”的可信回调，不能把这条分支宣称为全自动闭环。
8. 生产默认/workspace 模型的接续关闭内部重试；外部自行注入的非 OpenAI `BaseLanguageModel` 只能约束逻辑调用，不能替其未知实现担保物理请求次数。

## 方法依据

本轮使用 OpenAI Docs skill 核对评测方法：以真实任务轨迹检查工具选择、步骤和产物，不以模型一句“已完成”替代验证；参考 [Trace grading](https://developers.openai.com/api/docs/guides/trace-grading) 与 [Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)。本地评测脚本不是对 OpenAI 托管 Evals 服务的依赖。
