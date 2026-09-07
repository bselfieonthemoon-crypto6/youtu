# 本地设计资源导入说明（2026-09-06）

源目录：`C:/Users/lenovo/Downloads/新建文件夹/画布插件/public`。
目标：画布 `0560072c-5c8a-4954-b037-9b476246a671` 所属工作区。

## 安全边界

- 只读取 JSON 和资产，不执行来源插件代码，不修改源文件。
- 文件通过项目现有 MIME、SVG 安全、字体嵌入权限检查。
- 云端文件进入私有 `workspace-assets`，路径为工作区下 `design-library-v1/`。
- 目录通过现有 catalog RPC 创建并进入 `pending_review`，没有绕过发布校验。
- 未核实素材授权；插件代码 MIT 许可不等同于全部采集素材的许可。发布前须补齐可验证的授权信息及使用范围。
- 不改主 Agent、生成流程、已有画布或数据库权限。

## 执行方式

在项目根目录安装隔离的转换依赖（不写入项目运行依赖）：

```powershell
python -m pip install --target artifacts/font-converter fonttools brotli
$env:PYTHONPATH='E:/Loomic/Loomic/artifacts/font-converter'
python scripts/convert-local-fonts.py 'C:/Users/lenovo/Downloads/新建文件夹/画布插件/public' 'E:/Loomic/Loomic/artifacts/converted-fonts'
```

在 `apps/server` 运行（依赖现有根目录环境变量，不输出凭据）：

```powershell
node --env-file=../../.env.local --import tsx ../../scripts/import-local-design-library.mjs
node --env-file=../../.env.local --import tsx ../../scripts/import-local-design-library.mjs --apply --phase=materials
node --env-file=../../.env.local --import tsx ../../scripts/import-local-design-library.mjs --apply --phase=templates
node --env-file=../../.env.local --import tsx ../../scripts/import-local-design-library.mjs --apply --phase=files
node --env-file=../../.env.local --import tsx ../../scripts/import-local-design-library.mjs --apply --phase=extra-fonts
```

默认是 dry-run，但需要数据库读取目标工作区。`--limit=1` 可限定试导入条数。
固定源版本使用确定性请求 ID 和文件内容哈希，可重跑；不要在同一请求 ID 下更改源内容。若源数据更新，需要另行设计版本更新流程。

## 转换范围与限制

- 图片素材、简单可编辑模板、基础文字预设。
- 保留受支持对象的位置、尺寸、角度、层级及字体引用；模板写入前通过原生场景 schema。
- 不支持的分组、路径、曲线文字、渐变、复杂裁剪/滤镜等会跳过，不伪装为可编辑的扁平预览图。
- 同内容素材由现有 checksum 唯一约束去重；不同模板同名时追加来源编号，不覆盖原模板。
- 字体 WOFF2 转 TTF 保留元数据；未通过现有嵌入权限检查的字体不强行启用。这不是对原字体许可的法律判断。
- 此批导入不迁移来源分类、标签和收藏关系，仍需后续整理。

## 验证与后续

最终云端查询：素材 1,098，模板 147，文字预设 9，字体家族 9 / 字体文件 9，全部 `pending_review`。

素材源 1,235 条：1,098 入库，5 条同内容去重，100 条缺资产地址，30 条格式不支持，1 条非本地/不安全路径，1 条 MIME 不符。模板源 155 条：147 入库（其中 21 条同名模板追加来源编号），8 条因复杂变换、路径、曲线文字、缺字体或非本地文件跳过。文字预设源共 58 条：9 入库、49 跳过。字体源 33 条：11 条映射至 9 个独立文件（含 2 个别名）、22 条未通过当前嵌入权限检查。

已执行全量 dry-run（场景/文字 schema 和文件校验）、实际云端导入及幂等重跑；抽查 3 个存储文件下载大小一致，另抽查 3 个素材文件 SHA-256 与目录记录一致。执行脚本语法检查通过。

尚未进行逐模板视觉一致性验收。资源处于待审核，因此正常画板面板（仅展示 published）暂时不显示；可在后台「设计资源」审核目录查看。授权确认、字体依赖发布及模板预览验收完成后再按目录流程发布。

脚本输出的 `FINAL` 区分处理成功数与失败项；字体处理成功数包含来源别名，不代表独立字体文件数。

## 全磁盘资源补入（第二批）

用户要求把所有本地资源入库后，新增 `files` 阶段，递归扫描上述源目录的 `local-assets`，而不只处理 JSON 中已登记的素材。范围不包括用户其他目录或插件可执行代码。

- 预检共 4,002 个文件：3,965 个图片/SVG、36 个字体文件（含 2 个扩展名为 `.bin` 的 WOFF2）以及 1 个忽略的 `.DS_Store`。
- 原清单之外的模板配图、模板预览、文字预设预览也作为独立图片素材入库。预览不等于可编辑模板或文字预设。
- `files` 阶段按实际文件签名处理误命名的 PNG/JPEG/WebP；SVG 只去除旧外部 DTD 声明、XML 声明和头部注释，不请求 DTD，不允许内部实体，不放宽现有 SVG 安全检查。只上传规范化副本，源文件不变。
- 字体另行检查：原清单的字体由原阶段处理，6 个未列入清单的字体由 `extra-fonts` 阶段处理。字体权限不合格仍不会强制启用。
- 每次运行在 `artifacts/local-design-import-<phase>-<apply|dry>.json` 保存结果报告。数据库、文件上传失败不会记作成功，重跑可以补偿；`files` 成功数包含已存在、去重、忽略和转交字体阶段项，须看 `new_file_resources` 确认本轮新建数。
- 第二批仍全部为待审核，未发布；不改变生产运行代码或发布规则。

规范化及安全回归测试：在 `apps/server` 执行 `node --import tsx --test ../../scripts/local-design-file-format.test.mjs`。

第二批实际执行结果：新增 2,867 个图片/SVG 资源、5 款字体。云端总量为图片/SVG 3,965、可编辑模板 147、文字预设 9、字体家族/文件各 14，全部待审核。素材目录的 `asset_object_id` 缺失记录数为 0。抽查规范化后的 3 个 SVG 和 1 个误扩展名 PNG，云端 SHA-256 与入库记录一致，6 项格式/安全测试通过。

最终全量 dry-run 重扫：4,002 个文件全部归类，3,965 个图片/SVG 全部命中已有目录哈希、36 个文件转交字体阶段、1 个系统文件忽略，新增候选 0、文件阶段失败 0。

实际上传批次日志中 2 个 `.bin` 条目被记为格式失败；进一步按文件头确认它们是字体，已在原字体阶段检查且未通过嵌入权限。现已修正分类，后续文件阶段转交字体处理而不重复报图片格式错误。对全部 36 个字体文件再次读取 OS/2 元数据：14 个通过当前规则，22 个未通过。未伪造授权或删除权限元数据。

边界：3,965 个图片/SVG 文件全部入素材目录，不代表 155 个模板及 58 个文字预设全部支持原生编辑。仍有 8 个模板、49 个文字预设不满足现有转换能力，原 JSON 留在源目录，相应本地预览文件已作为图片素材保存。100 条无资产地址的来源素材记录不能凭名称可靠恢复，但本地实际存在的图片文件均已覆盖。

## 2026-09-07 管理员批量发布

用户明确要求发布后，已应用迁移 `20260908000003_workspace_resource_publication`（编号跟随仓库已有迁移顺序）：工作区素材发布不再强制填写授权元数据。平台素材、模板和字体的原有规则不变；权限校验、RLS、原图/预览所属工作区及删除状态检查不变。不补写虚假许可证。

`scripts/publish-local-workspace-resources.mjs` 在同一事务中备份、迁移并通过既有 `loomic_catalog_set_status` 发布，仅选择当前工作区 `design-library-v1/` 来源且待审核的素材。保留标准修订号、发布人、发布时间和 mutation 审计记录。脚本需在 `apps/server` 用根环境文件运行。

结果：3,965 个素材已发布，发布依赖检查失败数 0。数据库 RLS 验证：工作区 owner 可读 3,965 个，非工作区成员可读 0 个。模板、文字预设及字体本次未修改发布状态。已备份原始资源行和发布函数至 `loomic_backup_20260907` 私有 schema，撤销了 PUBLIC/anon/authenticated 访问。
