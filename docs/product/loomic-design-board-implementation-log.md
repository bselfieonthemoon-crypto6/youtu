# Loomic 原生设计画板实施日志

> 建立时间：2026-09-03  
> 对应 PRD：`docs/product/loomic-design-board-prd-2026-09-03.md`

## 脏工作树保护基线

实施启动时 `git status --porcelain` 共 266 项：112 项已跟踪变更、154 项未跟踪路径。这些均视为用户在本功能开始前已经存在的受保护工作，不得通过 reset、checkout、删除、覆盖或全仓格式化回退。

已有改动覆盖根配置、Web、Server、Shared、Supabase、测试、模型和文档目录。设计画板实施可以在必要时增量编辑重叠文件，但必须先检查当前内容，只做局部补丁，并在下方登记本功能新增或修改的文件。

## 阶段状态

| 阶段 | 状态 | 备注 |
| --- | --- | --- |
| 0 基线与最终 PRD | PASSED | 独立 PM 二审 PASSED；原首审 P0 全部清零 |
| 1 共享契约与数据库基础 | PASSED | 五轮独立技术审查闭环；PM 最终门禁 PASSED |
| 2 设计服务、API 与异步协议 | PASSED | 技术交叉审查与 PM 最终门禁 PASSED；无已知 P0/P1 |
| 3 无限画布垂直切片 | PASSED | 技术门禁与独立 PM 门禁通过；真实 Chrome 1/1 PASS |
| 4 核心 MVP设计编辑器 | PASSED | 完整回归、真实 Chrome 与独立 PM 门禁通过；无已知 P0/P1 |
| 5 资源中心、模板、后台和导入 | PASSED | 三轮独立 PM 门禁闭环；真实 Stage 5 E2E 3/3 PASS |
| 6 Agent 与 design-target 生图 | PASSED | 真实 Provider E2E、完整回归与独立 PM 门禁通过；无已知 P0/P1 |
| 7 高级编辑与后台大尺寸导出 | IN_PROGRESS | 阶段 6 已放行；进入设计图片高级编辑、模板变量与后台导出闭环 |
| 8 系统回归与发布验收 | PASSED | 20/20 用户流程、9/9 补充流程、性能/安全/文档及独立门禁全部通过 |

## 本功能触碰文件

- `docs/product/loomic-design-board-prd-2026-09-03.md`：新增并收口最终 PRD。
- `docs/product/loomic-design-board-implementation-log.md`：新增实施、验证和问题闭环日志。

后续每阶段在验收前追加文件、命令、测试结果、遗留问题和验收结论。

阶段 1 新增或修改：

- `packages/shared/src/design-contracts.ts`、`design-contracts.test.ts`：场景、命令、DTO、资源、预览与 WS payload 契约。
- `packages/shared/src/job-contracts.ts`、`job-contracts.test.ts`、`ws-protocol.ts`、`index.ts`：design target、worker parser 与共享导出。
- `packages/shared/src/supabase/database.ts`：由最终本地 schema 重新生成。
- `supabase/migrations/20260903000001_native_design_board_foundation.sql`：设计画板、资源、Job/finalization/outbox、RLS、CAS 与 GC 基础。
- `apps/server/src/features/designs/design-foundation-migration.test.ts`、`design-foundation-local-db.qa.sql`：静态和真实数据库验收。
- `apps/server/src/features/uploads/upload-service.ts`、`upload-service.test.ts`、`apps/server/src/app.ts`：上传/删除显式授权后使用 service-role，避免新权限模型造成回归。
- `apps/server/src/features/jobs/job-service.ts`、`apps/server/src/features/credits/credit-service.ts`、`apps/server/src/features/providers/provider-snapshot-service.ts`：生成类型后的兼容调整。

阶段 2 新增或修改：

- `apps/server/src/features/designs/design-command-applier.ts`、`design-service.ts` 及对应测试：服务端权威命令应用、幂等、Design/Canvas 双 CAS 与生命周期服务。
- `apps/server/src/http/designs.ts`、`design-async.ts` 及对应测试：create/get/mutate/rename/copy/delete/restore/reference、preview/export enqueue 严格 API。
- `apps/server/src/features/designs/design-outbox-service.ts`、`design-preview-service.ts`、`design-export-service.ts`、`design-async-worker.ts` 及对应测试：outbox、预览、导出队列与可恢复 worker 协议。
- `apps/server/src/features/designs/design-binding-reconciler.ts`、`design-reference-reconciler.ts`、`apps/server/src/features/jobs/design-target-normalizer.ts`、`design-job-finalizer.ts` 及对应测试：绑定、引用、现代/旧版 target 归一化与 finalizer 补偿。
- `apps/server/src/features/jobs/job-service.ts`、`job-canvas-finalizer.ts`、图片/视频 executor、`apps/server/src/app.ts`、`worker.ts`、连接管理：接通 design target、异步消费者、outbox dispatcher 与 worker 生命周期。
- `supabase/migrations/20260904000001_design_lifecycle_and_async_delivery.sql`、`20260904000002_design_binding_reconciler.sql`、`20260904000003_design_async_worker_recovery.sql`：生命周期 RPC、request ledger、preview/export、outbox、reconciler 与恢复扫描。
- `apps/server/src/features/designs/design-foundation-local-db.qa.sql`、`design-binding-reconciler-local-db.qa.sql`、`design-async-local-db.qa.sql`：真实数据库权限、CAS、跨租户、补偿和回滚验收。
- `packages/shared/src/design-contracts.ts` 及测试、`packages/shared/src/supabase/database.ts`：严格响应/错误契约与最终本地 schema 生成类型。

## 阶段 0 验收记录

- 结论：PASSED。
- 证据：产品、架构、前端三路交叉审查；独立 PM 二审确认 Fabric、px、资源 ID、权限、平台管理员、原子创建、CAS、Job target、GC和阶段依赖均无结构性阻塞。
- 遗留风险：无 P0/P1；阶段 1 必须以精确 shared schema 和隔离 migration 测试兑现协议，不连接远程生产数据库。

## 阶段 1 问题闭环

- Shared 契约首轮开发测试：typecheck PASS，69/69 tests PASS，build PASS。
- 独立代码审查：REJECTED。测试未覆盖 legacy/modern Job target 冲突、WS确认额外字段、资源状态漂移、统一命令动作、对象类型 patch、Group 图约束和 scope/preview 冗余字段一致性。
- 处置：已回派 Shared 开发 Agent 修复全部 P0/P1并补负向测试；阶段 1 保持 IN_PROGRESS，未进入阶段 2。
- Shared 第二版：typecheck PASS，86/86 tests PASS，build PASS；首轮协议缺口均已补齐。
- 独立复审：再次 REJECTED。剩余 P0 为 outbox/WS envelope 与 finalization UUID 的 SQL/TS 不一致；P1 为 actor/platform admin/preview/zIndex/文字效果与文字模板结构。
- 处置：数据库与 Shared 两线继续按单一协议修复，阶段 1 仍保持 IN_PROGRESS。
- Shared 第三版：typecheck PASS，91/91 tests PASS，build PASS；WS/outbox、preview、zIndex、paint/shadow、文字模板和 design export worker 契约已对齐。
- 数据库主线验证：空库 reset PASS，migration 9/9 tests PASS，lint 0 error，真实 SQL QA 覆盖 RLS、CAS、幂等、finalization、GC 和 service-role 跨工作区目标完整性后回滚无残留。
- 第三轮攻击性复审：REJECTED。发现 mutation 可借客户端 `next_scene` 夹带未授权改动、空 canvas target 可绕过租户关系、上传接口与新 `asset_objects` 写权限不兼容；同时要求补齐嵌套 Job 资产引用、SQL preview/scene 强约束、软删除可见性和平台资源发布可见性。
- 处置：继续修复数据库确定性 mutation 与完整性约束，并补真实负向 SQL 测试；上传元数据写入迁移到 service-role 且保留显式用户权限校验。阶段 1 不放行。
- 第四轮复审：REJECTED。原 3 个 P0 与 4 个 P1 已通过，唯一剩余 P1 为 SQL typed scene 校验弱于 Shared。
- 处置：SQL validator 对齐 10 类持久对象、paint/gradient/shadow、范围、必填/可选/null 与未知字段规则，并加入合法矩阵和恶意 rect 真实测试。
- 第五轮独立技术门禁：PASSED。原攻击用例、全部既定回归、空库 reset、完整 SQL QA、Shared 91/91、Server 相关 22/22、migration 11/11 和两端 typecheck 全部通过。
- PM 最终门禁：PASSED。阶段 1 无剩余 P0/P1，允许阶段 2 开始。

## 阶段 2 问题闭环

- 首轮实现完成设计 CRUD/mutation、预览/导出 enqueue、outbox、Job target/finalizer 和 binding/reference reconciler。
- 交叉技术审查发现并修复：公开 preview finalize 越权、request ledger 外键顺序、旧测试 target 漂移、binding LIMIT 饥饿与项目一致性、缺少 preview/export consumer、PGMQ 重投、finalizer 固定窗口饥饿，以及 copy 时目标 Canvas CAS 被错误映射为 Design conflict。
- 最终技术复验：Shared 94/94、Server 336/336 tests PASS；Shared/Server typecheck PASS；数据库 lint 0 error。
- 真实数据库验收：foundation、binding reconciler、async 三套 SQL QA 全部 PASS，并在事务中回滚无残留。
- 渲染器阶段边界：Stage 2 交付可替换 renderer port；未安装真实渲染器时明确写入 `dead_letter`/preview `error`，不永久停留 `queued`，真实渲染由阶段 4/7接入。
- PM 最终门禁：PASSED。阶段 2 无已知 P0/P1，允许阶段 3 开始。

## 阶段 3 问题闭环

- 首轮垂直切片完成工具栏入口、空白设计创建、Canvas revision 链、Fabric 单实例浮层、类型化 Design API/controller 与复制检测。
- 首轮独立技术门禁：REJECTED。4 个 P1 为编辑器只读且无真实保存、缺少可用的服务端复制命令、全局键盘/剪贴板事件可能穿透、设计节点没有稳定占位/私有预览消费；同时缺少真实 Chromium 证据。
- 修复已实施：背景色/透明背景通过结构化 `canvas.update` + CAS 保存并权威回读；选中节点提供打开/专用复制设计；浮层捕获隔离 keyboard/clipboard；视口内节点提供稳定占位和私有 Blob 预览（最多 4 并发、3 次重试、卸载 revoke），并接收 `design.sync` 后刷新 Canvas。
- 自动化浏览器脚本已覆盖真实登录、创建、保存、刷新、复制拦截、专用复制及 20 次 Fabric 生命周期，禁止生产 API mock；本地真实执行仍等待 Docker Desktop 引擎恢复后复验。
- 最终静态回归：Shared 96/96、Server 339/339、Web 211/211 tests PASS；Shared/Server/Web typecheck PASS；Web production build PASS；Stage 3 相关 Biome 检查 PASS。
- 20 次 Fabric 生命周期门禁进一步收紧：每轮打开都要求全页 viewport=1、Fabric `.canvas-container`=1、标准 lower/upper DOM canvas=2；每轮关闭三者均为 0。该指标对应一个真实 Fabric 实例，Playwright discovery 1/1 PASS。
- 真实 Chromium 当前环境阻塞：本机没有 `LOOMIC_E2E_EMAIL`/`LOOMIC_E2E_PASSWORD`；本地 Supabase 依赖 Docker，而 Docker Desktop 4.88.0 因无法删除 `C:/Users/lenovo/AppData/Local/Docker/run/sailor-ingest.sock` 启动失败。未连接或修改远程 Supabase，阶段 3 在获得安全测试环境前不放行。
- 首次真实 E2E 启动发现 Playwright health probe 误写为 `/health`，实际服务端路由为 `/api/health`；已修复并复跑。Chrome、Web 和 API 均成功拉起并进入 1/1 用例，随后按设计在缺少 `LOOMIC_E2E_EMAIL`/`LOOMIC_E2E_PASSWORD` 时失败，且保留 screenshot/video/trace。当前唯一直接执行阻塞为安全测试账号；现有 `.env.local` 连接远程项目且未应用本功能 schema，不在未授权情况下迁移或写入。
- 独立最终复核：`TECHNICAL PASSED — RELEASE GATE BLOCKED ON REAL CHROMIUM EVIDENCE`。最终生产代码无已知 P0/P1；Stage 3 总门禁保持未通过，禁止提前进入 Stage 4。
- 用户选择本地验收方案后，已停止 Docker/WSL 并将损坏的 `C:/Users/lenovo/AppData/Local/Docker/run` 可恢复地备份为 `run-stale-codex-20260904`；Docker 成功重建该目录。随后启动又暴露第二个损坏的 Windows Unix socket：`C:/Users/lenovo/AppData/Local/docker-secrets-engine/engine.sock`。Docker 全部进程停止后，Windows 仍返回 error 1920 且无法移动父目录，需通过 Windows 重启释放该系统级 reparse point 后继续；未执行 factory reset，镜像、容器和数据卷未删除。
- 进一步恢复尝试：已通过 UAC 成功重启 `WSLService`，并完成管理员 `chkdsk C: /scan`（exit 0）；管理员 `fsutil reparsepoint delete` 仍失败、socket 仍返回 error 1920。确认必须由 Windows 重启/离线阶段释放，无法在当前登录会话安全修复。
- Docker Desktop 后续恢复，`docker info` 确认 Server 29.7.2；本地 Supabase 正常启动并确认 42 个 migration 全部应用。验收栈隔离使用 Web `127.0.0.1:3100`、API `127.0.0.1:3101`、本地 Auth/DB，未复用 3000/3001 或远程项目。
- 真实验收过程修复了三个测试基础设施问题：health probe 使用真实 `/api/health`；Playwright 从 E2E URL 自动解析隔离端口而非调用硬编码 3000 的开发脚本；新 Supabase 本地 ES256 token 不注入旧 HS256 `JWT_SECRET`，改走服务端既有 `auth.getUser()` 验证。
- 真实流程还将节点交互从固定 Canvas 坐标改为按 `designId` 查找可见覆盖层中心后向底层 Canvas 发送事件，避免刷新/视口恢复后的定位漂移；临时用户、聊天会话和关联本地测试数据在每轮结束后清理。
- 最终真实 Google Chrome 结果：1/1 PASSED（45.4s）。覆盖真实登录、UI 创建项目/空白设计、背景 `#123456` 结构化 mutation + CAS 保存、刷新持久化、专用服务端复制与不同 `designId`、原生 Ctrl+C/V 重复节点拦截及持久化、20 轮 Fabric 单实例打开/关闭与零残留。
- 独立 PM 最终门禁：PASSED。定向复跑 9 files/34 tests 与 Web typecheck PASS；P0/P1 均为 0，阶段 4 正式放行。

## 阶段 4 问题闭环

- 完成 10 类 Fabric 对象、属性与图层管理、拖拽排序、复制/替换、对齐吸附与参考线、画布裁剪/扩展/等比缩放、统一命令历史、撤销/重做、自动保存、冲突恢复、真实预览以及 PNG/JPEG/透明 PNG 1x/2x 导出。
- 完成编辑器单实例生命周期、关闭前持久化、服务端 CAS 与客户端冲突 UI；本地保留方案按服务端最新场景重放未保存命令，避免覆盖其他编辑者的数据。
- 首轮独立 PM 审查发现两个 P1：画布缩放语义未统一且对象版本未递增；预览渲染缺少 Group 变换、Arrow 端点、Shadow 和 Textbox 换行。两项均已修复，并由 Shared/Server/Web 共用确定性缩放规则；新增 `20260904000004_design_canvas_scale_semantics.sql` 以封闭 SQL mutation 绕过。
- 完整验证：Shared 97/97、Web 260/260、Server 351/351 tests PASS；三包 typecheck PASS。真实本地 Supabase + Server + Web + Chromium 1/1 PASS（50.4s），覆盖 640x360→800x600 等比缩放、对象尺寸与版本、撤销/重做、保存权威回读、复制和 20 轮编辑器生命周期。
- 独立 PM 最终门禁：PASSED。两个既有 P1 均关闭，定向复跑 Shared 24/24、Web 21/21、Server 11/11 全部通过；无新增 P0/P1，阶段 5 正式放行。

## 阶段 5 问题闭环

- 状态：IN_PROGRESS。范围为公共/工作区资源、设计模板、文字模板、图片/SVG、字体、分类/标签、收藏/最近使用、后台管理以及安全导入/采集；阶段通过前不开放依赖入口。
- 第一条真实垂直链完成：Shared 99/99、Server 392/392、Web 266/266 tests PASS，三包 typecheck PASS；空库 reset 与 Stage 5 真实 SQL QA PASS。真实本地 Supabase/API/Web/Chromium 1/1 PASS（40.0s），覆盖上传、资源发布与搜索插入、保存刷新、`assetObjectId + resourceId` 持久化、从设计创建/发布模板、按 `template_id` 创建独立设计和精确清理。
- 真实 E2E 发现并修复三个 mock 未覆盖的问题：catalog create payload 混入 RPC 独立字段；模板详情漏取 `resource_id`；解构 Supabase `from()` 后丢失 receiver 导致运行时 TypeError。
- 独立 PM 首轮门禁：REJECTED，无 P0，5 个 P1。阻断项为：缺生产批量导入/API/UI；导入 lease 缺 claim-token fencing；后台仍为只读占位；已保存自定义字体重开不加载/无缺失替换；发布允许空授权记录。
- 处置：数据库、Server 与 Web 三线分别修复 lease/授权、批量安全导入与完整管理 API、后台管理与字体恢复加载。阶段 5 保持 IN_PROGRESS，禁止提前进入阶段 6。
- 第二轮实现补齐：claim-token fencing、强制授权发布门禁、七类混合 manifest 原子入队/拓扑 worker、ZIP/JSON/server-directory 安全导入、完整后台管理、字体冷缓存恢复与缺失替换。独立 PM 二审仅剩“后台导入宣称 ZIP/混合 JSON 但没有调用真实 multipart/inline 入口”一个 P1。
- 最终修复：后台提供 ZIP/JSON multipart、`manifest_inline` 七类清单和双端配置控制的 server-directory 三种真实模式；真实 worker 混合包导入 category/tag/resource 后显示 3/3 imported 和逐项报告。
- 最终回归：Shared 99/99、Server 417/417、Web 277/277 tests PASS，三包 typecheck PASS；空库 reset、Stage 5/foundation SQL QA、双 worker lease 竞态 PASS；真实 Stage 5 Playwright 3/3 PASS（资源/模板、自定义字体冷缓存、混合 ZIP 与报告）。
- 独立 PM 三审：PASSED。原 5 个 P1 全部关闭，无新增 P0/P1或阻断性 P2，阶段 6 正式放行。

## 阶段 6 问题闭环

- 状态：PASSED。完成 Agent 设计摘要/对象读取、结构化修改、资源搜索、模板套用、导出和图片生成插入指定设计，并复用人工 UI 的命令/CAS/确认/审计与 finalizer 幂等协议。
- 真实第三方 Provider 浏览器 E2E 1/1 PASS：覆盖六个 Agent 设计工具、`gpt-image-2` 真实生图、精确积分扣费、Job/Worker/Asset、Design object/ref/revision/preview、`design.sync`、审计链、幂等重放、409 冲突与刷新恢复。
- 独立审查发现并关闭三项恢复边界：preview/export 使用 job-derived 资产 ID、固定路径和可重放上传；崩溃窗口重试严格复用资产；chat recovery 在数据库侧过滤未完成项，避免前 100 条历史记录造成恢复饥饿。
- 最终验证：Shared 104/104、Server 447/447、Web 286/286 tests PASS；三包 typecheck PASS；恢复专项 15/15 PASS；独立 PM 门禁 PASSED，P0/P1 为 0。

## 阶段 7 实施入口

- 状态：PASSED。完成图片裁剪、蒙版、滤镜、描边、阴影、去背景、框选主体、透明/智能擦除与图层拆分；Fabric 与服务端导出的 fit/crop/mask/渐变语义已对齐。
- 模型操作统一绑定 design/source object/version/asset，复用 Job、积分、CAS、finalizer 与 `design.sync`；平台素材授权、幂等重放、资源 provenance、失败恢复和 FeyNoBG Windows 内存压力提示均已闭环。
- 模板支持 text/image/color/font typed variables、后台 CAS 编辑、权威依赖引用、智能匹配 diff、required 阻止与显式 apply；禁止 `scene.replace`，跨 workspace、下架资源及 asset/resource/font 配对在服务与数据库双重校验。
- 超过 32MP 自动进入后台导出；冻结 revision 支持 1000+ 历史分页重建，并有资源数量/源字节/解码像素/内存/120s 时间预算、任务恢复、取消、签名下载、保留期和无饥饿两阶段 GC。
- 真实本地 Stage 7 E2E 1/1 PASS（2.1 分钟）：高级字段刷新、本地透明擦除→design finalizer、模板 preview/apply 持久化、6000×6000（36MP）后台导出恢复与签名 PNG 下载；无 APIYI、无生产请求 mock，测试后用户/任务/项目残留均为 0。
- 最终回归：Shared 109/109、Server 483/483、Web 319/319；五包 typecheck、SQL QA、数据库迁移与 lint 无 error；独立门禁复审 PASSED，P0/P1 为 0。

## 阶段 8 发布验收

- 状态：PASSED。机器可读覆盖矩阵记录 PRD 20/20 个用户流程和 9/9 个补充恢复/压力流程；真实本地 Supabase、API、Web 与 Google Chrome Stage 8 E2E 2/2 PASS（2.2 分钟），没有拦截或 mock 生产接口，也未调用付费 Provider。
- 压力实测为 1,000 个普通图片节点 + 100 个设计预览节点；真实 viewport 位移 178.89px，201 frames，100.17 FPS，Long Task 0。Browser heap 76.2MB→48.0MB→54.2MB；Next Working Set 2.395GB→2.372GB→2.281GB；20 次编辑器创建/销毁后无 Fabric 残留。
- 持久化验收从权威设计 DTO 核验文字字号 52、italic、center、fill、形状对齐、z-index 与资源/资产 ID；离线 dirty 重试后刷新重开仍为 `#223344`；双窗口 409、画布 tombstone、资源/字体/生成失败状态均通过。
- PNG、JPEG、透明 PNG 均读取实际下载字节，校验 magic、非零内容和 640×360 尺寸；透明 PNG 解码采样确认存在 alpha `<255`。
- 回归期间发现并关闭两个生产竞态：双击曾命中旧选中设计，现以事件坐标和预览 DOMRect 为权威；属性面板异步回包/重建曾丢失正在输入的字号，现以对象级草稿、200ms 防抖及 Enter/blur 幂等提交保证最终值。
- 发布安全升级将生产审计从 2 critical/55 high 降至 0 critical/0 high；安全版本包括 tar 7.5.22、Fastify 5.12.3、Next 15.5.25、Sharp 0.35.4、Undici 7.29.0、ws 8.21.3、js-yaml 4.3.2、Google GenAI 1.52.0 和 protobufjs 7.6.6。剩余 1 moderate 为 Google Vertex 间接 uuid@10 特定 API 路径、1 low 为 Next 构建期 Babel 链，均有明确非范围证据。
- 最终自动化：Shared 109/109、Server 105 files/483 tests、Web 72 files/324 tests，五包 typecheck、触及文件 Biome、数据库迁移/SQL QA 均通过；DB lint 仅保留两个既有 `IMMUTABLE` 函数含 `STABLE` 表达式 warning，无 error。
- 文档完成：设计画板架构、运维手册、资源导入指南、用户指南及 Stage 8 覆盖矩阵。测试结束后 Stage 8 用户、项目、资源、字体和 3320/3321 监听残留均为 0。
- 独立 PM/技术最终门禁：PASSED（P0=0、P1=0）。
