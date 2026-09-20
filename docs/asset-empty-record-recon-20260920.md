# 素材空记录排查与清理记录（2026-09-20）

> 状态：**已完成排查 + 已删除「死记录」子集；其余部分按用户要求暂停（"先不用清除了，后面再说"）**。
> 本文只记录事实与可复现命令，未改动任何产品代码。

## 一、关键发现：存储服务与应用不在同一个库

本机存储容器 `supabase_storage_thtdhcvjppuvlvahfmga` 的 `DATABASE_URL` 指向 **`postgres`** 库，
而应用（server / worker / web）连的是 **`loomic_replica_light_20260907`**。两边各有自己的 `storage` schema：

| 位置 | `storage.objects` | 说明 |
| --- | --- | --- |
| `postgres`（存储服务实际使用） | **94** 行，全部 `workspace-assets` | 创建时间集中在 **2026-09-04 ~ 2026-09-05**，此后没有任何新增 |
| `loomic_replica_light_20260907`（应用库） | 6398 行 | 09-07 复制快照带进来的历史元数据，存储服务并不读它 |

磁盘 `supabase_storage_...:/mnt/stub/stub`（`STORAGE_BACKEND=file`、`FILE_STORAGE_BACKEND_PATH=/mnt`）
下共 **96 个文件**，与那 94 个对象一一对应（多出的 2 个是被替换掉的旧版本）。

结论：**应用库里的 `asset_objects` 记录，一条都无法在运行中的存储服务里找到对应文件**（实测命中 = 0）。
即 `GET /api/uploads/:assetId/url` / 签名 URL 对这些素材必然取不到对象。

## 二、历史素材其实还在磁盘上，只是没灌回去

- 目录：`artifacts/local-replica-20260907/storage/<bucket>/<object_path>`（仓库根为 `E:\Loomic\Loomic`）
- 规模：**4153 个文件 / 309.7 MB**（`workspace-assets` 4117、`project-assets` 36）
- 覆盖：**4076 条** `asset_objects` 记录（键为 `bucket` + `object_path`）
- `artifacts/local-replica-20260907/storage-hydrated.json` 声称 4153 个全部已安装，
  但运行中的存储服务里一个都没有 —— **该 ledger 不可信**；要重新灌入必须先清空它
  （`hydrate-local-replica-storage.mjs` 会跳过 ledger 中已列出的条目）。

## 三、四类划分（5743 行快照，2026-09-20）

「有文件」= 在历史仓库 `artifacts/local-replica-20260907/storage/` 中存在；
「被引用」= 被 10 张内容表以 `ON DELETE RESTRICT` 外键引用
（`design_resources`×2、`design_documents`、`design_document_asset_refs`、`design_preview_requests`、
`design_template_asset_refs`、`design_templates`、`font_faces`、`resource_import_items`、
`text_presets`、`skill_previews`）。

| 类别 | 条数 | 处置 |
| --- | --- | --- |
| ① 无引用 + 无任何文件（死记录） | **1015** | ✅ 已删除（执行时实际 1017 条） |
| ② 无引用 + 历史仓库有文件 | 97 | ⏸ 保留，可救 |
| ③ 被引用 + 历史仓库有文件 | **3979** | ⏸ 保留；当前表现为裂图，`hydrate` 即可修复 |
| ④ 被引用 + 无任何文件 | 652 | ⏸ 保留；无法修复（删不掉，被外键约束） |

合计 5743；另 `asset_references`（`ON DELETE CASCADE`）在删除时连带减少 302 行（320 → 18）。

## 四、已执行的改动

```sql
-- 事务内按「无 RESTRICT 引用 且 无历史文件」删除
delete from public.asset_objects a using dead d where a.id = d.id;
```

- `asset_objects`：5745 → **4730**
- `asset_references`：320 → **18**
- 未触碰 `storage` schema、未删除任何磁盘文件、未改代码
- 备份（CSV，含表头）：
  - `artifacts/cleanup-empty-assets-20260920/loomic-assets-all.csv`（全部 5743 行）
  - `artifacts/cleanup-empty-assets-20260920/loomic-assets-dead.csv`（1015 行）
  - `artifacts/cleanup-empty-assets-20260920/loomic-assets-recoverable-unref.csv`（97 行）
  - ⚠️ 有 2 行在「导出备份」到「执行删除」的约两分钟窗口内被并发写入并落入死记录集合，
    未包含在上述备份中（该窗口内 `asset_objects` 由 5743 增长到 5745）。
- 排查用的临时表（`public._cleanup_*`）已全部 drop，并 `notify pgrst, 'reload schema'`。

## 五、后续可选动作（未执行）

1. **灌回历史素材（推荐，一条命令级）**：清空 `storage-hydrated.json` 的 ledger →
   跑 `scripts/hydrate-local-replica-storage.mjs` → 4076 条记录恢复可用（含 ③ 的 3979 条裂图）。
2. **继续清理**：删 ② 的 97 条（无引用但有文件，删掉即永久失去这批素材）。
3. ④ 的 652 条只能随内容一起清理，或在确认无价值后连同外键引用一起处理。

## 六、附注：仓库根目录

`pwsh` 默认工作目录是 `E:\Loomic`，它是**父目录**；git 仓库与 `apps/`、`packages/`、`artifacts/`
都在 `E:\Loomic\Loomic`。用绝对路径时必须带这一层，否则会误判「目录不存在」。
