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
