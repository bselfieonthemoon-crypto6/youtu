# 提示词库来源审核（2026-09-09）

## 结论与本次边界

用户指定的 [Infinite Canvas](https://github.com/basketikun/infinite-canvas) 的确内置 7 个来源，但实际消费的是独立的 [Image Prompt Registry](https://github.com/yukkcat/image-prompts) 统一 JSON，并不是把 7 个项目的代码嵌入产品。[提示词页面](https://canvas.best/prompts) 本次 HTTP 检查为 200，是客户端 SPA；浏览器展示行为应另做 UI 验证。

当前选定 4 个许可声明相对明确的来源，共 654 条提示词，已按用户后续要求补足远程示例图 URL：654 条封面、80 条多图案例、798 个不同地址；另外 3 个来源仍只提供链接，不复制其正文或图片。图片由浏览器按需直连，不转存本地。本文初次审核的纯文本阶段已被图文预览阶段取代，详见 [远程预览核对与统计](./prompt-library-remote-preview-20260909.md)。这是公开许可与数据结构的工程审核，不是对每个第三方作品权利链的法律担保，也不是 654 次生图效果测试。

本次不执行外部仓库代码，不安装插件，不移植 Infinite Canvas 的前端，不自动生成图片，不将示例图作为用户的参考素材，不新增知识库。

## 1. 来源与可核验数据

读取 [固定提交 manifest](https://raw.githubusercontent.com/yukkcat/image-prompts/bc5dd581b2d910209b965b9e77f47ff48a9eddcc/dist/manifest.json)：schemaVersion 为 1，生成时间为 2026-09-08 16:02:15 +08:00，总数 1,742，registryHash 为 `f9fd52e794f2f582fb617bce57e92f5d8b10445ebff910b728746ff7f58e9f80`。原始 main 版本把同一时间显示为 UTC，不影响数据哈希。

下表 byte 数为各规范化 JSON 的 UTF-8 完整体积，不包含任何图片；本次逐个读取并计算 SHA-256，与 manifest 的 7 个哈希均相符。

| 来源 ID | 实测条数 | JSON bytes | 当前处理 | 许可证据与注意点 |
| --- | ---: | ---: | --- | --- |
| banana-prompt-quicker | 323 | 397,075 | 文本及远程示例 URL | [MIT 正文](https://github.com/glidea/banana-prompt-quicker/blob/main/LICENSE)；[README](https://github.com/glidea/banana-prompt-quicker#readme)另要求第三方引用注明来源。保留条目作者和原链接。 |
| davidwu-gpt-image2-prompts | 494 | 1,059,345 | 仅来源链接 | [README](https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts#readme)末尾标 MIT，但根目录 LICENSE 返回 404，且汇总多个外部库。暂不整库再分发。 |
| freestylefly-gpt-image-2 | 541 | 1,252,781 | 仅来源链接 | [MIT 正文](https://github.com/freestylefly/awesome-gpt-image-2/blob/main/LICENSE)；[README](https://github.com/freestylefly/awesome-gpt-image-2#readme)明确第三方内容的原始权利归属及学习研究用途，要求继续遵循原来源许可。 |
| awesome-gpt-image | 53 | 61,366 | 仅来源链接 | [LICENSE](https://github.com/ZeroLu/awesome-gpt-image/blob/main/LICENSE)为 MIT，但 [README](https://github.com/ZeroLu/awesome-gpt-image#license)声称 CC BY 4.0，并注明内容来自互联网。适用范围有冲突，暂不复制。 |
| awesome-gpt4o-image-prompts | 76 | 96,430 | 文本及远程示例 URL | [MIT 正文](https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts/blob/main/LICENSE)。保留原始作者与来源。 |
| youmind-gpt-image-2 | 126 | 328,069 | 文本及远程示例 URL | [LICENSE](https://github.com/YouMind-OpenLab/awesome-gpt-image-2/blob/main/LICENSE)与 README 均 CC BY 4.0；需署名、链接许可、说明改动。 |
| youmind-nano-banana-pro | 129 | 262,082 | 文本及远程示例 URL | [LICENSE](https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/blob/main/LICENSE)与 README 均 CC BY 4.0；同上。 |

7 个源合计 3,457,148 bytes；首期 4 个源合计 1,083,656 bytes。YouMind 两个仓库 README 仅公开一部分精选条目，不能将它们网站标示的上万条数量说成本项目已经收录的条数。

对应数据路径统一为固定提交 `dist/sources/<来源 ID>.json`；消费者应使用 manifest 中的 path 和哈希验证，不随意信任外部输入的 URL。

上游原始入口也保存在 [sources.json](https://github.com/yukkcat/image-prompts/blob/main/sources.json)：

- Banana：`https://glidea.github.io/banana-prompt-quicker/prompts.json`
- DavidWu：`https://raw.githubusercontent.com/davidwuw0811-boop/awesome-gpt-image2-prompts/main/prompts.json`
- Freestylefly：`https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main/data/cases.json`
- ZeroLu：`https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main/README.zh-CN.md`
- ImgEdify：`https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main/README.zh-CN.md`
- YouMind GPT Image 2：`https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main/README_zh.md`
- YouMind Nano Banana Pro：`https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main/README_zh.md`

## 2. 许可不能混为一谈

Infinite Canvas 自身的 MIT 许可不能替所有提示词授权。Registry 的 [NOTICE](https://github.com/yukkcat/image-prompts/blob/main/NOTICE.md)也明确其 MIT 仅覆盖同步代码和文档，不重新许可提示词、图片、名称等上游内容。

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)允许商业分享和改编，但要求适当署名、链接许可证、说明修改，且不能对被许可材料附加限制。品牌、肖像、隐私等其他权利不一定包含在这份许可中。产品中的提示词详情和随附 notices 应保留这些信息，不能显示成 Loomic 自创或暗示原作者为产品背书。

当前分发文本、来源元数据和公开示例图片 URL，不改写原始 prompt 正文，不分发图片文件。我方额外分类及 URL 归一化/图集去重保留在修改说明中。此前首期曾去除媒体 URL，该策略现已更新。Banana 某些条目的 `author=Official` 和 sourceUrl 指向首页是上游缺省数据，不能据此宣称独立确认了真实作者。

完整上游许可证正文、registry 适用范围声明和我方修改说明保存在 `apps/server/data/prompt-library/THIRD_PARTY_NOTICES.md`。审核元数据保存在 `scripts/prompt-library-sources.json`；`entryCount` 是本地实际导入数量，初始值为 0，不拿上游数量冒充已完成导入。

## 3. 数据契约及容易出错的字段

上游 [格式定义](https://github.com/yukkcat/image-prompts/blob/main/docs/prompt-format.md)和 [JSON Schema](https://github.com/yukkcat/image-prompts/blob/main/schema/prompt.schema.json)要求顶层为数组；记录含 id、sourceId、title、prompt、description、coverUrl、referenceImageUrls、tags、author、sourceUrl、createdAt、imageMode、imageModel；可选 imageSize、imageCount。

本次实际检查：

- 首期 654 条均有非空 prompt；最长 prompt 2,445 字符，最长 title 50 字符，每条最多 3 个上游 tags。
- Banana：155 条 `generate`、168 条 `edit`；imageModel 均为空。
- ImgEdify 的 76 条和 YouMind 的 255 条 imageMode 都为空，表示未知，不表示不需要参考图。
- 原模型标签分别出现 `gpt4o`、`gpt-image-2`、`nano-banana-pro`；作为不可信来源标签展示，不能自动覆盖工作区模型，更不能将 gpt-image-2 替换成 gpt-image-2-all。
- `referenceImageUrls` 不可靠地等于“必需输入图”：ImgEdify 76/76 和 YouMind 255/255 都带这种 URL，许多实际上是结果展示图。Banana 仅 3/323 条提供 referenceImageUrls，但实际有 168 条 edit。不能依赖 URL 数量推导图生图，也不能自动附加它们。
- 缺少元数据的条目保持未知；不要用 LLM 猜测作者、原模型或授权范围。
- 提示词可能含 HTML 片段、变量占位符、模型指令或第三方专名，始终按文本渲染，仅在用户选择后写入节点草稿，不能插入系统提示词或自动授予工具能力。

## 4. 示例图片可用性与性能

历史首期对 7 源进行 HEAD 抽样，每源前两张，共 14 张：12 张 HTTP 200，ZeroLu 的 2 张 GitHub user-attachments 为 403。本轮针对已收录 4 源的 9 个图片主机再各抽一张：7 个主机成功，camo.githubusercontent.com 和 linux.do 为 403；均未下载图片文件。抽样不是全量存活保证，也不是图片授权核验。

主机分布包括 `pbs.twimg.com`、`camo.githubusercontent.com`、`cdn.jsdelivr.net`、`raw.githubusercontent.com`、`cdn.imgedify.com`、`cms-assets.youmind.com`，Banana 还引用论坛与其他图床。不同用户地区、跨域、防盗链和链接失效都可能改变表现。

抽样的 YouMind Nano PNG 达 7,779,837 bytes；Banana 首张 PNG 为 1,125,034 bytes；Freestylefly 某张 JPEG 为 1,800,176 bytes。因此“每条只展示一张小图”不代表网络只传缩略图。

当前方案：卡片按需远程显示完整封面，详情图集/放大使用 `object-contain`；浏览器直连公开来源，使用 `no-referrer`，不新增服务端任意 URL 抓取或转存。25 秒未加载进入失败态，可手动重试或查看原案例，不让图片失败阻断正文使用。之前“仅文本卡片”的建议仅属于首期历史阶段，不再作为当前产品行为。完整统计和实现边界见 [远程预览记录](./prompt-library-remote-preview-20260909.md)。

## 5. 源代码关键入口（只读参考）

- [prompt-source-presets.ts](https://github.com/basketikun/infinite-canvas/blob/main/web/src/services/api/prompt-source-presets.ts)：7 个 registry 来源配置。
- [prompt-source-runtime.ts](https://github.com/basketikun/infinite-canvas/blob/main/web/src/services/api/prompt-source-runtime.ts)：前端 fetch JSON 与宽松归一化。它的 URL 处理不适合作为服务端安全边界照搬。
- [prompts.ts](https://github.com/basketikun/infinite-canvas/blob/main/web/src/services/api/prompts.ts)：IndexedDB / localforage 缓存、按源刷新、前端过滤和分页。
- [use-prompt-source-store.ts](https://github.com/basketikun/infinite-canvas/blob/main/web/src/stores/use-prompt-source-store.ts)：浏览器来源配置持久化。
- [prompts/index.tsx](https://github.com/basketikun/infinite-canvas/blob/main/web/src/pages/prompts/index.tsx)：独立库页、筛选、详情、复制和素材收藏入口。
- [registry parsers.py](https://github.com/yukkcat/image-prompts/blob/main/prompt_registry/parsers.py)：源适配入口；本次不执行。

## 6. 推荐适配方式及验收点

采用固定版本、经哈希验证的本地正文及媒体 URL 快照，服务端提供有界搜索与分页，前端节点仅加载当前页。正文检索不依赖 GitHub/Canvas.best/YouMind 可达性；图片预览依赖各公开图床，失败时保留文字及来源入口。公共提示词快照不含租户资料，节点草稿和用户参考素材继续走现有项目权限与保存机制。

节点操作应是“打开提示词库 → 预览示例图/原文/来源/推荐模型 → 填入当前草稿 → 用户修改 → 原有生成按钮提交”。已有草稿不可无提示覆盖；可以提供追加与替换并保留取消。填词不能自动发起计费、切模型、换参考图、移动节点或修改其他节点。

验收应包括：正文离线可检索、4 源实际条数与 798 个图片 URL、3 源为 link_only 且正文未进入快照、原文/作者/来源/许可完整保留、分页与懒加载、完整图集/放大、外站失败和手动重试、HTML 按文本显示、选择后只改目标节点草稿、模型与参考图保持、刷新后草稿可恢复，以及填入提示词期间没有生成请求。当前测试进度以 [实施记录](./prompt-library-implementation-20260909.md)为准。
