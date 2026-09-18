# 节点提示词库：实施与验收

## 入口与行为

在无限画布底部点击「AI 生成图片」，或选中一个已有生图节点；在节点浮动设置栏的参考图按钮旁点击「提示词」。

- 搜索名称、正文、标签及来源模型标签，按分类和来源筛选，分页加载。
- 卡片按需加载远程示例封面，使用 `object-contain` 完整显示；详情提供图集切换、放大查看，以及完整原文、作者、原始条目、来源许可和模型适用说明。
- 图片只由浏览器直连公开来源，不经服务端抓取或转存。超过 25 秒仍未加载则展示失败态，可手动重试或查看原案例；图片失败不阻断提示词使用。
- 33 条标题/标签明确标注 NSFW 的上游案例默认不请求图片，需点击「显示此案例图片」。确认只对该案例及本次库会话有效；不扫描正文、不声称已对图片内容做审核，也不删除记录。
- 空节点「使用此提示词」；已有文字明确选择「替换当前提示词」或「追加到末尾」。不悄悄覆盖原草稿。
- 只填入提示词，不提交任务、不调用模型、不自动改变用户的模型、尺寸、清晰度或参考图。模型标签来自上游，并非我方逐模型效果认证。
- 提示词选择及手动输入都写入该节点 `customData.prompt`，经过现有画布自动保存。关闭重选、切换节点、刷新及撤销同步以场景数据为准。
- 外部提示词仅作为可编辑正文显示，不作为系统指令、脚本或自动执行的 Skill。

顺带修复：原节点生成前仅保留 React 草稿、节点切换复用 state、撤销不回显、长 workspace 模型 ID 挤压工具栏等问题。

此前纯文本阶段的浏览器验收还发现模型列表加载时在 React state updater 内写入画布，产生跨组件渲染期更新错误；已将场景写入移到回调中并在响应时读取节点最新模型，避免迟到响应覆盖用户已选模型。该阶段最终 `consoleErrors=[]`，并新增 StrictMode 和延迟响应回归；本轮远程图片浏览器结果另记于验收部分。

发现现有文字生图直连接口不接收参考图，原上传按钮会造成「看似已上传但生成未使用」的误导。本次没有扩展该旧接口；有参考图时明确阻止提交并引导到支持参考图的改图入口，避免默默忽略图片后计费。库中需要参考图的案例有独立提示，示例图不会自动成为用户输入。

## 来源与数据范围

参考 [Infinite Canvas](https://github.com/basketikun/infinite-canvas) 的聚合来源，独立实现本项目界面与 API，没有复制它的前端代码。其来源底层是 [Image Prompt Registry](https://github.com/yukkcat/image-prompts)。固定审核版本 `bc5dd581b2d910209b965b9e77f47ff48a9eddcc`，上游该快照共 1,742 条；首批收录如下：

| 来源 | 本次收录 | 状态 |
| --- | ---: | --- |
| Banana Prompt Quicker | 323 | 文本、出处与远程示例图 URL；来源标注 MIT |
| Awesome GPT-4o Image Prompts / ImgEdify | 76 | 文本、出处与远程示例图 URL；来源标注 MIT |
| YouMind GPT Image 2 | 126 | 文本、出处与远程示例图 URL；来源标注 CC BY 4.0 |
| YouMind Nano Banana Pro | 129 | 文本、出处与远程示例图 URL；来源标注 CC BY 4.0 |
| DavidWu GPT Image 2 | 0 | 仅来源入口，许可正文待确认 |
| Freestylefly GPT Image 2 | 0 | 仅来源入口，第三方内容权利需逐项确认 |
| ZeroLu Awesome GPT Image | 0 | 仅来源入口，MIT / CC BY 声明范围待澄清 |

合计 **654 条可填入提示词、7 个来源入口**。这是快照中的有效记录数，不是 654 次实际生图验收，不代表整个 YouMind 网站内容。

当前已补齐 **654 条封面、80 条多图案例、798 个不同图片 URL**。按用户后续要求，原“纯文本卡片”阶段已升级为远程图文预览；本地数据保留 URL，不保存图片文件，也不进入页面便请求全库图片。外站失效和大图传输仍可能出现，地址覆盖数量不等于全量图片可达性保证。作者、原始链接、许可证和归类改动说明随记录保留；图片及具体使用权利不因聚合展示而改变。

来源调查见 [审核报告](./prompt-library-source-audit-20260909.md)，远程图片的原项目核对、全量 URL 统计和 HEAD 抽样见 [远程预览记录](./prompt-library-remote-preview-20260909.md)。完整许可随数据分发在 `apps/server/data/prompt-library/THIRD_PARTY_NOTICES.md`。

## 本地服务与发布

- 登录后只读 `GET /api/prompt-library?q=&source=&category=&offset=0&limit=24`。
- 服务端从本地 `apps/server/data/prompt-library/catalog.json` 首次加载并缓存检索索引，正文查询不访问 GitHub、Canvas.best、模型或数据库；展示图片时浏览器按需访问相应公开图床。
- 认证在读取文件之前；单页最多 48 条，关键词最多 160 字符；重复参数、非法分页、陌生参数拒绝，未知来源/分类返回空列表。
- 数据损坏返回通用不可用提示，不泄漏文件路径，不静默展示空库。失败也缓存，发布修正数据后须重启 API。
- 版本、schema、来源计数、稳定 ID、来源可用状态、大小限制均校验；3 个仅来源入口不能带可套用内容。
- 无数据库迁移、无新模型、无额外付费订阅、无定时外部同步。

离线校验（不连接外网）：

```powershell
node scripts/import-prompt-library.mjs --check
```

受控重建（只取固定已审核提交的 manifest 与 4 个数据文件，验证 SHA-256 和数量；不执行外部代码、不下载图片）：

```powershell
pnpm --filter @loomic/shared build
node scripts/import-prompt-library.mjs --refresh
```

更新上游前需要审核许可和差异，再显式修改固定提交及 `scripts/prompt-library-sources.json`。发布时必须同时携带 `apps/server/data/prompt-library/`（包括许可），不要只复制源代码而漏掉数据。导入完成后的 API 重启在没有活跃生成/Agent 任务时进行。

## 本轮远程图片验收

| 检查 | 当前结果 |
| --- | --- |
| 后端相关回归 | 83 / 83 通过 |
| UI 与节点/API 客户端相关回归 | 47 / 47 通过（其中图文 UI 29 项） |
| shared 契约套件 | 144 / 144 通过（其中提示词契约 22 项） |
| 导入器回归 / 离线校验 | 10 / 10 通过；654 条快照校验通过 |
| TypeScript | server / web 均通过 |
| 真实浏览器 | Chromium 本地真实 API / 数据 / 远程图片 / 持久化流程通过，最终运行 24.3 秒 |

当前回归覆盖远程地址与图集契约、真实快照统计、图文展示、按需加载、失败态/手动重试，以及保留原提示词填入边界。图片只作案例展示，不自动加入参考图或触发生图。

真实浏览器使用独立新建 QA 项目，没有修改用户当前画布；结束后归档该测试项目并仅注销 QA 自己的登录会话。验证了 4 个收录来源各一张真实封面、苹果海报第 2 张附图、放大及 Escape 只关闭放大层。首屏 24 条数据只有 8 张可见卡片挂载 `img src`；网络检查中图片请求均没有 Authorization / Referer。额外注入一次附图网络失败，错误提示后点击重试，真实远程图片成功加载；对应唯一 `imageNetworkErrors` 是预期注入的 `net::ERR_FAILED`，应用 `consoleErrors=[]`。追加、替换、手工编辑、双节点独立草稿、刷新恢复及模型/尺寸/参考图保持不变全部通过；没有调用模型，没有生成费用。

本轮截图及结构化证据位于 `apps/web/test-results/prompt-library-images-live/prompt-library-local-uses--47614-pendent-drafts-after-reload-chromium/`，包括 `prompt-library-browser.png`、`prompt-library-detail.png`、`prompt-library-image-zoom.png`、`prompt-library-evidence.json`。截图已实际检查，卡片、大图均完整显示。浏览器抽样成功不代表全量 798 个 URL 永久可达；公网域名字面校验也不是 DNS 重绑定或远程跳转的完整检测。

上一阶段纯文本版已有实际 API、双节点草稿保存和刷新恢复的浏览器证据，目录为 `apps/web/test-results/prompt-library-live/prompt-library-local-uses--47614-pendent-drafts-after-reload-chromium/`。该历史证据不等同于本轮远程图片验收，原先“浏览库没有图片请求”的断言亦不适用于当前图文版。

运行验收（只操作新建的本地测试项目）：

```powershell
# cwd: apps/web
$env:LOOMIC_E2E_EXTERNAL_STACK='true'
$env:LOOMIC_E2E_BASE_URL='http://localhost:3020'
$env:LOOMIC_E2E_SERVER_URL='http://127.0.0.1:3002'
$env:LOOMIC_PROMPT_LIBRARY_QA='true'
node --env-file=../../artifacts/local-replica-20260907/app.env node_modules/@playwright/test/cli.js test e2e/prompt-library-local.spec.ts --output=./test-results/prompt-library-images-live
```
