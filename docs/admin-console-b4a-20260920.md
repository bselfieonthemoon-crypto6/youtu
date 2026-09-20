# 管理后台 B4a：技能目录与技能图片（2026-09-20）

承接总规划（`docs/admin-console-plan-20260920.md` 第五节）与 B1–B3。
本批解决你点名的问题：**技能只有图标、没有图片**，而且技能本身只有工作区级视图。

> 说明：B4 拆成两半。**B4a（本批，已完成）**= 数据库 + 服务端 + 后台管理界面 + 客户侧只读接口；
> **B4b（下一批）**= 把封面/示例图接到用户侧的技能卡与详情弹窗上。接口已经就绪，B4b 只改前端。

## 一、数据库（迁移 `20260920000004_skill_previews.sql`，已应用并登记）

**新表 `public.skill_previews`**
| 列 | 说明 |
| --- | --- |
| `skill_id` | 归属技能（`ON DELETE CASCADE`） |
| `asset_object_id` | 指向既有 `asset_objects`（`ON DELETE RESTRICT`）——**不新建存储桶** |
| `role` | `cover`（卡片图）或 `example`（示例图） |
| `caption` | 可选说明（≤300） |
| `sort_order` | 同角色内排序 |
| `status` | `draft`（仅后台可见）或 `published`（所有登录用户可见） |
| `created_by` / 时间戳 | 追溯 |

- 唯一约束 `(skill_id, asset_object_id)`；**部分唯一索引**保证"每个技能最多一张已发布封面"，卡片图永不歧义。
- `FORCE ROW LEVEL SECURITY` 且**不建 policy**：读写都走服务角色。
- **图片本体复用平台级素材**：写进既有 `platform-assets` 桶 + `scope='platform'` 的 `asset_objects` 行
  （与设计目录导入同一条路径）。该桶没有任何 authenticated 存储策略，所以**客户侧看图必须经过服务端**。

**六个函数**（都只授予 `service_role`；写操作 = 平台管理员 + 原因必填 + 审计同事务）
- `admin_attach_skill_preview`（挂载；只接受 platform 作用域素材，工作区素材会被拒，避免把一个租户的上传泄露给所有人）
- `admin_publish_skill_preview`（发布；若为封面，**同事务把原封面降级为草稿**并把这件事写进审计）
- `admin_unpublish_skill_preview`、`admin_delete_skill_preview`（删除只删记录，**存储对象留给既有回收流程**）
- `admin_reorder_skill_previews`（要求传入该技能的**全部**图片 id，去重校验，否则拒绝）
- `admin_skill_catalog`（读：技能身份、输出类型、**有多少工作区启用**、图片与已发布图片数、是否已有封面）

审计动作：`skill.preview.attach/publish/unpublish/delete/reorder`（`target_kind=skill`，含 before/after）。

## 二、服务端

- `features/admin/admin-skill-service.ts`：
  - 上传：校验类型（**只允许 png/jpeg/webp**，不接 SVG）与大小（1B–5MB）→ 写入 `platform-assets`
    → 插入 `asset_objects`（platform 作用域）→ 调 RPC 挂载。
    **失败回滚**：RPC 被拒会同时删掉素材行与存储对象；连素材行都插不进去时删掉已上传对象——
    不留"半挂载"的孤儿。
  - 读：后台视图带每张图的**短时签名 URL**（签名失败返回 `null` 并在界面提示，而不是给一个坏图）。
  - 客户侧 `listPublishedPreviews(slug)`：**只返回 `published`**，且不暴露素材 id；签名失败的行直接跳过。
- `http/admin-skills.ts`：
  - 后台：`GET /api/admin/skills`、`GET|POST /api/admin/skills/:id/previews`（multipart 上传）、
    `POST .../:previewId/publish|unpublish`、`DELETE .../:previewId`、`POST .../order`
  - 客户侧：`GET /api/skills/:slug/previews`（只需登录，已发布图片）
  - 9 种拒绝码翻译成 403/404/400/500，非法请求一律 400 `admin_invalid_request`。

## 三、前端

`/admin → 技能与图片`（仅平台管理员）：左侧技能列表（slug/版本/分类/**启用工作区数**/图片数与是否有封面）+
搜索；右侧选中技能后：输出类型与安装统计、**上传表单**（文件 + 用途 + 说明 + 原因，前端先校验类型与大小）、
按「封面 / 示例」分组的图片网格（图片、状态、说明、类型），每张图支持
**发布/下架、上移/下移、删除**，每个动作都是**行内原因 + 确认**；草稿与已发布在界面上一眼可辨。

## 四、验证

- 服务端新增 `admin-skill-service.test.ts`（12 例：非管理员在读之前被拒、目录查询与收窄、
  签名 URL 与**签名失败为 null**、类型/大小/空文件三种本地拒绝、
  上传参数与 RPC 参数（含 caption/reason trim）、**素材行被拒时删对象**、
  **挂载被拒时删素材行 + 对象**、上传本身失败不留残件、三种图片类型扩展名、
  9 种拒绝码翻译、**客户侧只返回已发布且不含草稿 id**、无法签名的已发布行被跳过）
  与 `admin-skills.test.ts`（11 例：8 个端点都要认证、目录 limit 边界、坏技能 id、后台可见草稿、
  **真实 multipart 上传**（文件/用途/说明/原因与字节一致）、缺文件/未知用途/原因过短、
  发布/下架/删除/排序成功路径、坏 preview id 与空排序列表、客户侧只读 + slug 校验、
  拒绝码映射、500 不泄漏内部消息）。
- Web 新增 `admin-skills-section.test.tsx`（12 例：列表与选中加载、提交式搜索与切换技能、
  文件大小本地校验、上传为草稿并带原因、**发布需原因 + 确认**、下架、组内上移排序、
  **服务端拒绝后保留该行**、取消不调用服务端、空组与图片链接过期提示、加载失败重试、标签与本地校验函数）。
- **真实数据端到端**（`artifacts/admin-console-smoke.mjs`）：真实 69 字节 PNG 经 multipart 上传
  → 201 草稿 → 后台视图带签名 URL → 发布 → **客户侧接口可见（1 张已发布）** → 下架后从客户侧消失
  → **SVG 被拒 `admin_invalid_file`** → 删除 → 审计含四类 `skill.preview.*` 记录
  → 脚本最后清掉自检素材（1 个对象 + 1 行素材记录）。
- 全量：server / web 测试与两端 typecheck 全绿，编码审计干净（见提交信息）。

## 五、有意不做

- **用户侧技能卡/详情展示**：B4b，本批先把接口与数据打通（`GET /api/skills/:slug/previews` 已完成并实测）。
- **技能包版本历史**：图片有排序与状态，但技能正文的 diff/回滚仍是缺的（规划里的"重新导入并显示变更摘要"）。
- **拖拽排序**：先用上移/下移 + 明确原因（可测试、可审计），拖拽留到有明确需求时再做。
- **SVG 上传**：客户侧展示的是所有登录用户，SVG 可携带脚本，因此只收位图。
