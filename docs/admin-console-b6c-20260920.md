# 管理后台 B6c：存储健康与孤儿回收（2026-09-20）

承接总规划（`docs/admin-console-plan-20260920.md` 第七节）与 B6b。
`asset_objects` / `asset_references` 此前**没有任何管理面**，而删除逻辑散落在
`design-export-gc.ts`、`canvas-asset-references.ts` 与上传删除函数里。

> 本批是 B6 的最后一块。范围 = 占用统计 + 孤儿盘点 + 待删/回收队列 + 大文件排行（只读）
> + **一条**清理动作（只走既有回收流程）。

## 一、动手前的测量决定了整个设计 ★

"这个素材还有没有活引用"的权威判据是 `private.loomic_asset_has_live_references`：
十个 `EXISTS`，最后一个是**扫 `background_jobs.result` 的 jsonb**。在本地副本（5735 个对象）实测：

| 做法 | 耗时 |
| --- | --- |
| 对全部对象逐条跑权威检查 | **115 秒** |
| 集合化的"候选"查询（覆盖所有指向素材的列） | **0.02 秒** |
| 对**一页 50 条**跑权威检查 | **1.0 秒** |

所以孤儿列表**必须**是两层的：列表用集合化候选查询，权威结论只给当前这一页
（`confirmedOrphan`），清理时再复核一次。三层口径在副本上的实测值：
**5419** 个素材根本没有 `asset_references` 行 → 列引用把它收窄到 **1307** 个候选 →
权威检查判定 **1298** 个孤儿。差的 **9 个**只因为某个任务的 `result` jsonb 提到了它。
也就是说候选查询**偏多**（安全方向），而且**永远不会自己拍板**。

## 二、数据库（迁移 `20260920000008_admin_storage_health.sql`，已应用并登记）

**四个只读函数**
| 函数 | 作用 |
| --- | --- |
| `admin_asset_overview(actor, workspace_limit)` | 总量（对象/字节）、按桶/scope、最占空间的工作区、三个队列计数 |
| `admin_asset_orphan_candidates(actor, bucket, workspace_id, min_bytes, limit, offset)` | 候选孤儿列表；**只为返回的这一页**计算权威结论，并返回 `pageConfirmed` 说明结论只对这一页成立 |
| `admin_asset_queue(actor, kind, limit, offset)` | `pending_delete` / `gc_eligible` / `gc_claimed` 三个队列 |
| `admin_asset_large_objects(actor, limit)` | 最大对象排行（含引用数与权威结论） |

**两个写入函数**（平台管理员 + 原因必填 + 同事务审计 `target_kind='asset'`）
| 函数 | 说明 |
| --- | --- |
| `admin_claim_orphan_asset(actor, asset_id, reason)` | 调**既有** `loomic_orphan_asset_claim`（它内部会复查引用并置 `deletion_pending_at`/`gc_*`）；返回空就抛 `ASSET_REFERENCED` |
| `admin_finalize_orphan_asset(actor, asset_id, reason)` | 调**既有** `loomic_orphan_asset_finalize`（内部要求已置待删且仍无引用）；返回 false 就抛 `ASSET_FINALIZE_REFUSED` |

审计动作：`storage.orphan.claim`、`storage.orphan.purge`（`before` 存整行快照）。
**没有任何绕过引用检查的物理删除**，也没有新的删除语义。

两个函数都保持了 `STABLE`：候选/队列查询用**单条语句的 CTE**而不是临时表——
临时表会让函数变成写入型，`STABLE` 会直接报错。

## 三、服务端

- `features/admin/admin-storage-service.ts`：读函数透传并夹取边界；清理是**三步**：
  1. `admin_claim_orphan_asset`（数据库复核引用 → 置待删 → 写审计）；
  2. 服务端删存储对象；
  3. `admin_finalize_orphan_asset`（删行 + 写审计）。
  **对象先删**：如果第 2 步失败，素材就留在待删队列里，由既有回收流程收尾——
  先删行会永久留下无主对象。此时接口返回明确文案"已留在待删队列"，而不是含糊的失败。
- `http/admin-storage.ts`：`GET /api/admin/storage/overview|orphans|queue|large-objects`
  与 `POST /api/admin/storage/orphans/purge`；参数不合法 400，拒绝码映射
  404 `admin_asset_not_found` / 409 `admin_asset_referenced` / 409 `admin_asset_not_pending`。

## 四、前端

`/admin → 存储`（仅平台管理员）：
- **占用卡片**：对象总数、占用、待删/可回收/已领取；按桶表（对象/占用/待删与可回收）与最占空间工作区表。
- **孤儿候选**：按桶/工作区/最小字节筛选；表格给出大小、桶与路径、工作区、`asset_references` 引用数、
  **权威判定**（`确认无引用` / `仍被引用`）、创建时间与天数、是否已在待删队列。
  被权威判定为"仍被引用"的行**清理按钮直接禁用**——服务端也会拒，但不该让人点了才知道。
  列表上方写明"共 N 条候选（当前页 M 条已逐条复核）"，避免把候选总数当成孤儿总数。
- **删除与回收队列**：三种队列切换，显示待删/回收/领取时间。
- **最大对象排行**：大小、桶与路径、工作区、类型、引用数与"疑似孤儿"标记。
- **清理**：行内原因 + 确认，说明"认领 → 删对象 → 收尾，任一步失败都不会留下无主对象"。

## 五、验证

- 服务端新增 `admin-storage-service.test.ts`（10 例：非管理员在读写前被拒、
  概览透传与工作区上限夹取、孤儿筛选透传与分页夹取、空白桶视为"全部"、
  **未知队列类型在数据库调用前就被拒**、大文件排行上限、**清理顺序为认领→删对象→收尾**、
  **删对象失败时不再收尾**（断言只调用了认领）、认领被拒时不碰存储、
  认领没返回桶时报失败而不是"删了 0 个"、7 种拒绝码翻译不留原始消息）
  与 `admin-storage.test.ts`（8 例：5 个端点都要认证、概览 + 3 个非法 workspaceLimit、
  孤儿筛选透传 + 5 个非法参数、队列缺 kind 与未知 kind 映射、大文件排行边界、
  清理成功与 3 种非法请求体、404/409/403 映射、500 不泄漏内部消息）。
- Web 新增 `admin-storage-section.test.tsx`（7 例：占用卡片与按桶/工作区表、
  **被权威否决的候选项标记且清理按钮禁用**、提交式筛选 + 队列类型切换触发的调用、
  **清理需行内原因 + 确认并回显清理了多少**、被拒绝时显示服务端原因且确认框保留、
  加载失败重试、字节与队列标签格式化）。
- **真实数据端到端**（`artifacts/admin-console-smoke.mjs` 的 B6c 段）：
  概览的桶/scope 计数必须与总数**逐项相加一致**（1370.4 MB / 5735 个对象 / 2 个桶）→
  孤儿候选一页 10 条、**含逐条权威复核 435ms**、`pageConfirmed=true` →
  三个队列可读且排行严格递减 → 7 个非法查询 400 →
  **清理一个被引用的素材返回 409 `admin_asset_referenced`**、未知对象 404、匿名 401 →
  上传一个探针 PNG 并**真实走完清理**：认领 → 删对象 → 收尾，
  断言 `asset_objects` 行与存储对象都消失、审计含 `storage.orphan.claim` 与 `storage.orphan.purge`，
  最后清掉探针的审计行。
- 旧批次（B1–B6b）全部段落仍通过，脚本打印 `SMOKE OK`。
- 全量：server / web 测试与两端 typecheck 全绿，编码审计干净；
  `check:postgrest-schema`（清单已加入本批 6 个函数）确认 **38 个函数**在 schema cache 中可见。

## 六、有意不做

- **按工作区逐个跑全量孤儿扫描**：权威检查 20ms/条，全库要两分钟。
  现在只对"当前页"给权威结论；要做全量盘点得先给引用检查建索引或加物化视图，
  那属于性能工程，不该塞进管理面。
- **批量清理**：一次只清理一个对象，且只走既有回收流程。批量删存储是不可逆操作，
  先让人逐条看清路径再谈。
- **在界面里改 `deletion_pending_at` / `gc_*`**：那些字段属于回收流程的状态机，
  后台只读不改，避免与 worker 抢同一个状态。
- **给 `asset_objects` 加"引用来源"的可视化**：现在只给 `asset_references` 计数；
  要列出"到底被哪条记录引用"需要把十个来源都查一遍，留到有明确需求时再做。
