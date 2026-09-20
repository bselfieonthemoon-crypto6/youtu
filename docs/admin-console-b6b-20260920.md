# 管理后台 B6b：设计目录缩略图与批量上下架（2026-09-20）

承接总规划（`docs/admin-console-plan-20260920.md` 第六节）与 B6a。
规划里写的是"设计目录 UI 的关键字段补全（预览图、标签、上架状态、批量操作）"，
**动手前复核发现原判断高估了缺口**，这一批因此比原计划小：

| 原规划认为缺 | 复核结果 |
| --- | --- |
| 标签 | **不缺**。工作区级 UI 已有标签筛选，`updateDesignResourceRequestSchema` 早已接受 `tag_ids` |
| 上架状态 | **不缺**。UI 已有状态筛选与逐条变更（送审/发布/下架），表里本来就有 `status`/`published_at` |
| 批量操作 | 只有"批量导入任务"，没有多选批量改状态 |
| 预览图 | **确实缺**：表里有 `preview_asset_object_id`，接口也接受它，但列表里看不到图 |

## 一、为什么预览图需要服务端参与

`GET /api/design-resources/:id/preview` 早就存在（无预览图时回退到素材本体），
但它返回的是**需要 Authorization 头的二进制**，而浏览器的 `<img src>` 发不出这个头。
技能图片那批（B4a）遇到同一个问题时用的是**服务端签发短时 URL**，这里走同一条路。

## 二、服务端

- `features/design-resources/design-catalog-admin-service.ts` 新增只读方法
  `previewUrl(user, entityKind, entityId)`：
  1. **先按调用者自己的客户端**（RLS）读那一行——签名绝不能把调用者看不到的行里的素材暴露出去；
     读不到就 404，且**在访问任何存储之前**就返回。
  2. 取 `preview_asset_object_id ?? asset_object_id`。**模板没有 `asset_object_id`**
     （只有资源有），所以两种集合选的列不同——这一点是真实数据抓出来的：第一版统一
     `select("id,asset_object_id,preview_asset_object_id")` 让 PostgREST 直接拒绝整个查询，
     表现为模板缩略图 500。
  3. 用服务角色读 `asset_objects` 拿 bucket/object_path/mime_type，`createSignedUrl` 签 900 秒。
  4. **签名失败返回 `url: null`**，不抛错——界面显示占位符比显示坏图有用。
- `http/design-catalog-admin.ts` 新增 `GET /api/admin/design-catalog/:collection/:entityId/preview-url`
  （放在既有 `:collection/:entityId/references` 旁边，沿用同一个 collection→entity_kind 映射）。
  只有 `resources` / `templates` 两个集合有图；其余集合（预设、字体、分类、标签）返回 400
  `resource_invalid`，未知集合由既有的 collection 映射返回 400。

契约：`designCatalogPreviewUrlResponseSchema`（`packages/shared/src/design-contracts.ts`），
`uses_preview` 说明签的是显式预览图还是回退的素材本体。

## 三、前端

`/admin → 设计资源`（工作区级，沿用该页面既有的"行内 `window.confirm` + 逐条调用"约定，
不引入平台后台那套原因/审计表单——这是另一个授权模型）：

- **缩略图列**：列表加载后按页批量取签名 URL（一行一次请求，失败即占位），
  没有图的行显示 `—` 而不是坏图；切换集合会清空旧图与选择。
- **批量上下架**：多选 + 全选 + "批量上架/批量下架/清空选择"，
  **逐条调用既有 `setAdminCatalogStatus`**（每行保留自己的 `expected_revision`），
  **一条失败不影响其他条**，最后汇总"成功 N 条，失败 M 条（前三条原因）"。
  没有引入新的批量语义，也没有绕过 CAS。
- 只有 `resources` / `templates` 两个集合显示缩略图与批量控件（其余集合没有图）。

## 四、验证

- 服务端 `design-catalog-admin-service.test.ts` 新增 6 例：签显式预览图并报告 `uses_preview`、
  无预览图时回退素材本体、**签名失败返回 null 而不是抛错**、看不到的行 404 且不碰存储、
  5 个无图集合全部 400、**模板不会去查它没有的 `asset_object_id` 列**（断言选中的列）。
- `design-catalog-admin.test.ts` 新增 1 例：`resources`/`templates` 两个集合段映射到各自的
  entity_kind、未知集合 400 且到不了服务层。
- Web `design-resource-admin-section.test.tsx` 新增 3 例：逐行缩略图与**签名失败显示占位符**、
  批量状态变更**逐条调用并在部分失败时汇总**、无图集合上不出现批量控件。
- **真实数据端到端**（`artifacts/admin-console-smoke.mjs` 的 B6b 段，只读、无需造数据）：
  真实目录资源列表（用共享契约解析）→ 挑一个有 `preview_asset_object_id` 的条目
  → `preview-url` 返回 200、`uses_preview=true`、`asset_object_id` 与列表一致、
  `url` 是带 `token=` 的 http(s) 签名地址 → 模板集合：**本副本 13 个模板都没有预览图（与数据库一致）**，
  因此断言"无图"分支返回 404 `resource_not_found` → 未知条目 404、无图集合 400、未知集合 400、匿名 401。
- 旧批次（B1–B6a）全部段落仍通过，脚本打印 `SMOKE OK`。
- 全量：server / web 测试与两端 typecheck 全绿，编码审计干净。

## 五、有意不做

- **上传/清除预览图**：这需要先定"平台级条目的预览图落在哪个桶"（预览图上传目前只走
  `workspace-assets`，而目录条目有 `scope='platform'` 的一半，没有 `workspace_id`）。
  我的建议是平台级统一走 `platform-assets` + 服务端签名（与技能图片同一套），
  但那会新增一条上传路径与"半挂载"回滚逻辑，值得单独一批认真做，而不是塞进本批。
- **模板缩略图的真实链路**：本副本没有任何带预览图的在线模板，所以模板分支只验证到"无图"路径；
  等有带图模板时同一条路径即可用（服务端测试已覆盖带图情况）。
- **跨页批量**：批量只作用于当前页已加载的行，不引入"选中全部匹配"这种容易误伤的语义。
