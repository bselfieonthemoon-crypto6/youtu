# 去背景技能接入当前 Agent

## 问题与修复

本地启用图片模型为 `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`；旧 `gpt-image-2` 渠道已禁用。背景技能 2.1.0 固定要求旧模型并声明旧 `confirm_image_generation` 工具，与 Mastra 当前直接提交工具不一致。

- 背景技能升级 2.2.0。已有图使用 `edit_image`，默认 `operation=generate`，传入认证 `sourceAssetIds`、`sourceUsage=edit`、`background=transparent`、`outputFormat=png`。使用当前启用模型，不开启旧渠道，不修改旧专用 `remove_background` 的模型约束。
- readiness 要求当前有图片生成模型及 `edit_image`；Mastra 按本轮实际工具再次检查。只读技能不增加图片任务授权。
- Agent 根据已有图片去背景、抠图、扣出主体做透明 PNG 等意图，自动通过 `list_skills` 和 `use_skill` 获取正文，而非仅命中界面标签或预载全部技能。讨论、否定、等待、画板透明导出与从零透明生图分开处理；新图使用 `generate_image` 的透明参数。
- 显式透明请求在最终交付前校验 PNG 与非空、非全不透明的 Alpha。结果先进入持久化检查点，因此上游忽略透明参数时，重试不会重复调用付费生成。
- 新增独立迁移 `20260915000001_sync_background_removal_skill.sql`，仅更新这一既有 system skill 及其文件，保留 UUID、工作区 enabled 选择和其他技能。本地已执行并核验。

## 真实联调

独立 QA 画布：`da588157-539c-422c-be6b-84a966ba4c71`。未操作用户现有画布内容。

1. 用户语义为只说明去背景和透明导出区别、不执行。真实浏览器 run `52dbb3f3-9295-4cb7-b71b-04c8404034b6` 完成，工具调用数 0。
2. 上传一张原海报，不点名技能，请求去掉背景并交付透明 PNG。真实浏览器 run `09c7eb99-8f29-4334-a68b-f89cfe4f88d0` 自动调用 `list_skills → use_skill → edit_image`。
3. `use_skill` 返回 `loaded`、version `2.2.0`、readiness `ready`，正文 hash `408c3cdb2f2785081583e1e8674f196cfd85b6ae88cd3baa32290f8da741ab31`。
4. 图片任务 `6f12a28a-3a17-44af-92c2-2e25cda31d70` 成功，实际模型 `gpt-image-2.5-flare`；单张源图、transparent、png。结果 1280×640，有真实 Alpha，约 80.95% 像素完全透明，素材已写入画布。
5. 页面刷新后结果可解码显示，无页面错误、无请求失败、无额外图片生成提交。

证据：`artifacts/background-skill-20260915/` 包含前后 readiness、真实对话工具流、任务结果和输出 PNG。浏览器截图在 `artifacts/paid-dialogue-browser/da588157-539c-422c-be6b-84a966ba4c71-background-skill-ready.png`。

## 检查及限制

- 7 个服务端测试文件共 142 项通过；服务端 TypeScript 检查通过。
- 技能目录 12 项、局部同步 2 项测试通过，两个生成脚本 `--check` 均通过。
- 真实测试验证了自动调用、单源透明编辑、原图权限绑定、任务完成与画布显示，不代表所有关键词和上游模型都逐项完成真实测试。关键词由 Agent 结合上下文理解，不是忽略否定条件的硬编码付费开关。
- 图像编辑存在重绘；本次样本可见主体细节变化及光晕。Alpha 校验只证明透明文件，不等于精细抠图或逐像素保真。
- 本地 API 和 Worker 已重启加载新代码；前端通过接口读取技能，无需改动当前前端构建。

## 分工

- Sol / gpt-5.6-sol，high：Agent 意图路由与真实 SDK 工具流测试。
- Terra / gpt-5.6-terra，medium：技能正文、依赖、目录及局部同步迁移。
- 主控：实际模型核对、输出 Alpha 校验、集成检查、本地同步和真实浏览器/图片任务联调。
