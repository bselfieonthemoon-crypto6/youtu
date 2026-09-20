# 管理后台 B6a：首页内容管理（2026-09-20）

承接总规划（`docs/admin-console-plan-20260920.md` 第六节）与 B5b。
本批填掉规划里最大的一块空白：**首页两个内容库此前完全没有管理面**——
`home_discovery_cases/categories` 与 `home_example_categories/examples` 全仓服务端代码零引用，
只有迁移与导入脚本写过它们，浏览器直接读表。

> 范围说明：B6「内容与存储」按风险拆开。**B6a（本批，已完成）**= 首页内容管理；
> **B6b（下一步）**= 设计目录后台补全（预览图/标签/上架状态/批量）；
> **B6c**= 资产与存储（占用统计、孤儿盘点、待删队列、清理）。
> 本批不动设计目录与存储，理由见文末"有意不做"。

## 一、动手前先查清楚的三件事（都影响设计）

1. **`is_active` 就是发布开关。** 客户侧由浏览器直连 Supabase 读表，RLS 只给 authenticated 一条
   `is_active = true` 的 SELECT；案例/示例还额外要求**其分类也是 active**。
   所以"下架分类"会连带隐藏它下面的全部内容——后台必须把这件事说出来，而不是让人自己去发现。
   因此列表每行都带 `categoryIsActive`（分类已下架徽标），切换开关会返回 `hiddenItems`（本次连带隐藏多少条）。
2. **`sort_order` 带唯一索引**：两张内容表是 `(category_key, sort_order)` 唯一，两张分类表是 `sort_order` 全表唯一。
   于是"直接写第 N 位"是颗地雷——同一分类里第二条想占 3 就会违反唯一约束。
   所以**排序不走 upsert**：新条目一律追加到末尾，所有顺序调整走独立的 reorder 函数，
   并且先把整组行挪到临时负数位置、再赋最终值，避免中途碰撞。
3. **分类外键是 `ON DELETE CASCADE`**：删除分类会把整个内容库一起删掉。
   所以后台**没有"删除分类"**，数据库层也会直接拒绝（`UNSUPPORTED_TARGET`），只提供下架。

## 二、数据库（迁移 `20260920000007_admin_home_content.sql`，已应用并登记）

**两个只读函数**
| 函数 | 作用 |
| --- | --- |
| `admin_home_content_overview(actor)` | 两个库的全部分类：key/label/排序/上下架/条目数与已上架数，以及每库的条目总数 |
| `admin_home_content_list(actor, kind, category_key, active, query, limit, offset)` | 按内容类型（`discovery_case` / `example_example`）列出条目，可按分类、上下架、标题/提示词筛选 |

**七个写入函数**（都是"平台管理员 + 原因必填 + 同事务写审计"）
| 函数 | 说明 |
| --- | --- |
| `admin_upsert_home_discovery_case(...)` | 新建或修改发现案例；**从不改 `view_count`/`like_count`**；换分类时在新分类末尾取位 |
| `admin_upsert_home_example_example(...)` | 新建或修改示例；校验预览图（非空、≤1000 字符）与输入素材（`name`/`imgSrc` 必填，`type` 只能是 `tool`/`image`） |
| `admin_upsert_home_category(...)` | 新建或修改分类；key 必须是 `^[a-z0-9][a-z0-9-]{0,62}$`；新建追加到末尾，改名保持位置 |
| `admin_set_home_content_active(actor, kind, entity_id, is_active, reason)` | 上架/下架条目或分类；分类会返回 `hiddenItems` |
| `admin_reorder_home_content(actor, kind, category_key, ordered_ids, reason)` | 重排某分类下的条目；列表必须**恰好**是该分类的全部条目且不重复 |
| `admin_reorder_home_categories(actor, kind, ordered_keys, reason)` | 重排某库的全部分类（因为 `sort_order` 全表唯一） |
| `admin_delete_home_content(actor, kind, entity_id, reason)` | 只允许删条目；分类返回 `UNSUPPORTED_TARGET` |

外加两个私有辅助：`private.admin_require_reason`、`private.admin_write_home_audit`（写 `target_kind='home_content'`）。

审计动作：`home.discovery_case.create|update|activate|deactivate|reorder|delete`、
`home.example_example.*`、`home.category.create|update`、`home.discovery_category.activate|deactivate|reorder`、
`home.example_category.*`，`before`/`after` 存整行快照（删除时 `after` 为 NULL）。

## 三、服务端

- `features/admin/admin-home-content-service.ts`：`assertActor` → 调 RPC → 把
  `FORBIDDEN`/`REASON_REQUIRED`/`UNKNOWN_CATEGORY`/`UNKNOWN_CONTENT`/`UNKNOWN_KIND`/`INVALID_ORDER`/
  `UNSUPPORTED_TARGET`/`INVALID_CONTENT` 翻成 403/400/404/404/400/400/400/400。
  必填字段**原样透传**给契约解析（函数少返回一个字段就变成响亮的 500，而不是界面悄悄显示 0）。
- `http/admin-home-content.ts`：9 个端点（overview / items / discovery-cases / examples / categories /
  active / reorder / category-order / delete）。请求体全部 `.strict()`，多一个字段就拒；
  对 uuid 主键的类型（example）额外校验实体 id 是 uuid，discovery 的短 slug 则不校验。

## 四、前端

`/admin → 首页内容`（仅平台管理员）：
- **分类区**：两个库的分类列表（名称、key、`已上架/已下架`、`已上架数/总数`），
  每个分类支持上移/下移（提交全库完整顺序）、编辑（改名/数据类型/强调样式，key 只读）、上下架；
  下架分类的确认框会说明"会同时隐藏它下面的全部内容"，执行后提示实际隐藏了多少条。
- **条目区**：按 `发现案例 / 示例` 切换；筛分类、上下架状态、关键词（提交式），
  表格显示顺序位、标题、分类、上架状态（分类已下架时加"分类已下架"徽标）、更新时间；
  行操作：上移/下移、编辑、上下架、删除。
  **当筛选隐藏了部分条目时排序按钮禁用**并提示原因——服务端只接受完整列表，前端不假装能做到。
- **编辑表单**：发现案例（标题/封面图/作者/作者头像/案例链接/灵感提示词/上架）；
  示例（标题/提示词/**每行一个预览图地址**/**每行「名称 | tool 或 image | 图片地址」**的输入素材/上架）。
  图片与素材行在提交前本地校验，报错指出第几行错在哪；每个动作都是**行内原因 + 确认**。

## 五、验证

- 服务端新增 `admin-home-content-service.test.ts`（11 例：非管理员在读写之前被拒、
  概览原样返回、空筛选变 NULL 且 `active=false` 保持 false、页大小与偏移夹取并保留畸形负载可见、
  新建案例全字段与**真实返回的 created/sortOrder**、示例的图片与素材透传、分类返回 key/kind/created、
  上下架报告 hiddenItems、两种重排都提交完整列表、删除、9 种拒绝码翻译不留原始消息）
  与 `admin-home-content.test.ts`（11 例：9 个端点都要认证、概览、单类型列表 + 6 种非法查询、
  案例写入与 5 种非法请求体、示例的图片/素材/uuid 校验、分类 key 形状、
  **uuid 类型实体 id 校验而 slug 不校验**、分类删除请求根本到不了服务层、
  重排空列表/重复、删除、拒绝码映射、500 不泄漏内部消息）。
- Web 新增 `admin-home-content-section.test.tsx`（13 例：分类列表与上架计数、条目列表与"分类已下架"徽标、
  切换内容库并把图片/素材回填到编辑器、提交式筛选且筛选时禁用排序、
  条目下架需原因 + 确认、**分类下架报告隐藏条数**、移动条目提交完整新顺序、
  编辑案例全字段保存、图片行本地拦截、新建分类且编辑时 key 只读、删除需原因 + 确认、
  加载失败重试、行解析/格式化函数）。
- **真实数据端到端**（`artifacts/admin-console-smoke.mjs` 的 B6a 段，会先清理上次崩溃残留再测量）：
  概览两个库（发现 8 条 / 8 分类、示例 36 条 / 6 分类）→ 新建分类 → 新建两个案例
  → 确认新条目**追加到末尾且只返回该分类的条目**（`total=2`、顺序 `[0,1]`）
  → 编辑（`created=false`）→ 重排并核对顺序真实落库 → **分类下架报告 `hiddenItems=2`**、单条下架为 0
  → 分类重排（全库排列）后确认新的第一个分类 → 新建示例（2 张预览图 + 1 个输入素材）
  → **7 类非法写入 + 2 个非法查询全部被拒**（未知 kind / 未知分类 / 原因过短 / 不完整排序列表 /
  分类删除 / 非法图片地址 / 未知示例 / 非法 kind 查询 / limit=0）
  → 清理：条目走控制台删除、分类走服务角色（控制台没有这条路）、恢复分类顺序与条目数。
- 旧批次回归：B1–B5b 全部段落仍然通过（脚本最后打印 `SMOKE OK`）。
- 全量：server / web 测试与两端 typecheck 全绿，编码审计干净；
  `check:postgrest-schema`（清单已加入本批 9 个函数）确认 **32 个函数**在 schema cache 中可见。

## 六、有意不做

- **图片上传**：首页图片现在是 `project-assets` 公开桶里的 URL，首页直接把 URL 塞进 `<img>`。
  本批只让后台**维护 URL**；把首页图片改存私有桶会连带改客户侧读取路径（要改成签名 URL），
  那是另一件事，不该混在"补管理面"里。
- **设计目录补全**：规划里同属第六节，但设计目录已经有完整的 admin API + 工作区级 UI，
  剩下的是界面补字段（预览图/标签/上架状态/批量），属于纯前端收敛，放到 B6b 单独做。
- **批量操作**：先保证单条的原因、确认、审计路径正确；批量等有真实需求再做。
- **内容级联影响预览**：下架分类目前只报告条数，不逐条列出会被隐藏的内容。
- **删除分类**：外键级联，永久不做（需要先有"迁移分类下的内容"这样的功能才谈得上）。
