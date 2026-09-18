# 授权对照、自修复观测与会话图片任务权限

## 1. TS/SQL 授权对照

- `mastra-image-authorization-cases.ts` 为 TS 单测和手动对照提供 24 个共享用例与期望结果；正则实现仍各自保留。
- `pnpm --filter @loomic/server test:authz-parity` 显式运行，不进入默认 `test`。需要有权读取现有函数的 `SUPABASE_DB_URL`。
- 运行器使用只读事务并回滚，读取已部署的 00006 guard，从实际 `loomic_image_tier_authorized(request_text, ...)` 调用提取固定模式，检查数量、内容及顺序；SQL 注释不能掩盖漂移。
- 同时比较四个档位授权、输出数量、错误码与额度。共享向量固定默认配置 4，不改变生产环境的可配置额度。
- 包含无数据库写入的负控制：替换单条模式必须被拒绝。缺配置或连接失败均明确输出“未执行”，返回非零；连接及查询设 10 秒超时。
- TS 负责前置快速失败；生成提交仍以 DB guard 为最终执行权威。没有修改现有 DB 函数或增加 migration。

## 2. D 自修复日志与开关

| 环境变量 | 默认 | 关闭后的行为 |
| --- | --- | --- |
| `LOOMIC_MASTRA_WRITE_REPAIR_ENABLED` | true | 不调用分类或恢复模型，不追加恢复文案 |
| `LOOMIC_MASTRA_WRITE_REPAIR_TOOL_CHOICE` | true | 保留恢复，仅移除恢复首步的 required tool choice |

开关支持 true/false/1/0，非法值拒绝。默认保持既有行为，不减少原先的恢复步骤。

`console.info("[mastra-write-repair]", {...})` 记录 runId、阶段、决策、工具名、结果、耗时及跳过原因，不包含用户原文或回复内容。包括已写入、关闭、超长跳过、分类不可用、恢复未写入和恢复异常。恢复流异常继续交给既有适配器产生 `run.failed`，日志不能替代真实工具回执。

## 3. G 查看与取消权限

实际数据库的 user policy 为 creator-only，工作区角色不会自动绕过该 RLS。因此查询集中在 JobService，使用 service-role，并在服务内部进行显式授权：

1. 校验可信用户身份与 scope UUID。
2. 每次读取当前工作区成员身份及 role。
3. 核对持久化 chat session 的 canvas，以及 canvas 的 workspace。
4. 查询限制在工作区、会话、图片任务类型和当前 canvas/live design 围栏。

成员可查看同会话其他成员的任务。`cancelJobAdmin` 自行检查上述范围及“创建者或 owner/admin”，不能仅依赖工具层授权。非成员、普通成员取消他人及越界访问都被拒绝。

新旧取消入口共享原来的条件更新（只从 queued/running 转 canceled），没有复制退款或账务流程。终止任务不重复更新。工具继续明确不承诺退款或重新生成。

## 验收记录

本轮 114 个不重复定向用例通过，按批次串行执行：

| 范围 | 用例 |
| --- | ---: |
| image status tools / job-service | 10 + 33 |
| mastra-agent / env | 17 + 3 |
| execution-policy / toolkit / skill integration / runtime-context / run-integration | 25 + 6 + 4 + 6 + 10 |

主控执行当前部署函数的授权对照：24 个共享用例通过，缺 DB 与无法连接两种负向运行均返回非零。

权限数据库烟测使用隔离 schema，复制当前公共表结构和已部署 creator-only RLS 表达式，通过实际 JobService 查询 PostgreSQL。验证原始 user RLS 不允许成员读取他人任务、owner 也不能直接更新他人任务；显式服务授权后成员读取、创建者/owner/admin 取消成功；普通成员取消他人、其他工作区成员读写、会话/画布越界被拒绝；取消重放不重复改变终止状态。全部事务回滚，未创建公共任务、未入队、未调用供应商。该烟测覆盖 SQL 与服务授权，未模拟 PostgREST HTTP 传输。

主控完成服务端生产源码类型检查（排除测试的临时配置，1536MB，exit 0）。没有运行全量类型检查；不以代理曾单独运行的全量 typecheck 输出作为本轮集成结论。

额外只读验收：通过实际本地 Supabase/PostgREST admin client 调用 `getConversationImageJob`，当前工作区、会话、画布范围的已成功任务能正常读取。没有修改该公共任务。

生效验收：确认没有排队/执行中的任务后重启 API PID 20668（1024MB）与 worker PID 13560（1536MB），worker 日志确认启动。Web 3020、API 3002/api/health、其他项目 3001 均返回 200。Web 前端未修改，未重建。

## 实际代理分工与偏离

两个 Terra（medium）分别编写授权对照与 D 日志/开关。计划的 Sol 权限代理受平台任务数量限制未启动，G 由主控直接实施及验收。D 代理曾未等待串行调度运行一次全量 typecheck；后续所有验收恢复串行，不再运行全量检查。
