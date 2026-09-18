# 提示词库远程示例图片：原项目核对与实现依据

核对日期：2026-09-09。范围为当前已收录的 4 个来源、654 条提示词；不扩大到其余 3 个仅链接来源。本次用户明确要求加入图片，允许需要时请求远程资源，因此此前实施记录中的“纯文本、不加载示例媒体”是旧阶段策略，不再代表本次目标。

## 原项目如何实现

只读核对 [Infinite Canvas 提示词页面](https://github.com/basketikun/infinite-canvas/blob/main/web/src/pages/prompts/index.tsx)、[提示词服务](https://github.com/basketikun/infinite-canvas/blob/main/web/src/services/api/prompts.ts)、[来源解析器](https://github.com/basketikun/infinite-canvas/blob/main/web/src/services/api/prompt-source-runtime.ts)、[卡片组件](https://github.com/basketikun/infinite-canvas/blob/main/web/src/components/prompts/prompt-card.tsx)和[详情组件](https://github.com/basketikun/infinite-canvas/blob/main/web/src/pages/prompts/components/prompt-detail-dialog.tsx)的 `main` 版本：

| 环节 | 原项目行为 | Loomic 本次应保持的核心行为 |
| --- | --- | --- |
| 数据 | 请求提示词 JSON，将正文及图片 URL 放入 IndexedDB；1 小时过期后后台刷新 | 保留现有已审核正文快照，在数据中补足公开示例图片 URL，不把媒体文件搬入项目 |
| 卡片 | 直接 `img src=coverUrl`；浏览器原生懒加载；普通 4:3、紧凑正方形；`object-cover` | 卡片展示示例图，只加载当前可见列表，不进入页面便请求全部图片 |
| 详情 | 点击才打开，显示封面和最多 6 张附加图；主图高 192/224 px；附图懒加载 | 点击查看大图及同条目图集，完整图适合 `object-contain`，保留正文和来源 |
| 图片网络 | 组件直接访问来源图片 URL，未使用自身图片代理、转存、`srcset` 或 `referrerPolicy` | 由浏览器按需直接获取公开图片；不建立任意 URL 服务端抓取接口 |
| 使用提示词 | 复制正文、加入文字素材 | 仍由用户选择替换/追加节点草稿，不自动生成、不切模型、不把展示图隐式当作参考输入 |

原项目详情仅在 `referenceImageUrls.length > 1` 时显示附图。当前 Banana 有 3 条恰好“一张独立封面 + 一张独立 reference”，该判断会漏掉附图。我们应先对 `[coverUrl, ...referenceImageUrls]` 去重，再按完整图集展示。这里的 `referenceImageUrls` 是上游字段名，不能据此判定这些图都是用户生成时所需的原始输入图。

原项目中并未发现图像压缩或缩略图转码逻辑：CSS 缩小显示不等于只传小文件。应以懒加载、有界分页、详情按需加载控制请求数量，并明确远程不可达时的失败态。

## 固定数据版本的完整 URL 统计

数据基于现有固定 registry 提交 `bc5dd581b2d910209b965b9e77f47ff48a9eddcc`，路径 `dist/sources/<source-id>.json`。统计读取 JSON，不下载/存储图片，不执行来源仓库代码。

| 来源 | 条目 | 缺封面 | 非空 reference 的条目 | reference URL 总数 | 合并封面后去重图数 | 多图条目 | 单条最多图数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| banana-prompt-quicker | 323 | 0 | 3 | 3 | 326 | 3 | 2 |
| awesome-gpt4o-image-prompts | 76 | 0 | 76 | 76 | 76 | 0 | 1 |
| youmind-gpt-image-2 | 126 | 0 | 126 | 190 | 190 | 41 | 4 |
| youmind-nano-banana-pro | 129 | 0 | 129 | 206 | 206 | 36 | 4 |
| 合计 | 654 | 0 | 334 | 475 | 798 | 80 | 4 |

全部 1,129 个原始封面/reference 地址均为 HTTPS，未发现 URL 语法异常、userinfo 或非标准端口。条目内合并去重后 798 张；全库按 URL 去重亦为 798 张。重复主要是 reference 数组再次包含封面。

来源主机（封面/reference 重复计数）：`pbs.twimg.com` 162、`camo.githubusercontent.com` 70、`cdn.jsdelivr.net` 66、`github.com` 7、`i.mji.rip` 7、`linux.do` 10、`storage.googleapis.com` 4、`cdn.imgedify.com` 152、`cms-assets.youmind.com` 651。

## 小量远程 HEAD 抽样

每个主机抽取一个已有 URL，HEAD 请求不读取图片正文。结果只说明本机、本次请求，不代表所有图片或所有地区均可访问。

| 主机 | HEAD 状态 | 抽样响应类型 / 大小 |
| --- | --- | --- |
| cdn.imgedify.com | 200 | JPEG / 70,341 bytes |
| cdn.jsdelivr.net | 200 | PNG / 1,125,034 bytes |
| cms-assets.youmind.com | 200 | JPEG / 145,789 bytes |
| github.com | 200（原地址跟随正常跳转） | JPEG / 986,660 bytes |
| i.mji.rip | 200 | PNG / 2,020,015 bytes |
| pbs.twimg.com | 200 | JPEG / 385,988 bytes |
| storage.googleapis.com | 200 | PNG / 1,343,881 bytes |
| camo.githubusercontent.com | 403 | 未读取正文；示例地址是上游已有 GitHub 图片代理地址 |
| linux.do | 403 | 未读取正文 |

因此不应把“654 条都补有示例图地址”描述成“654 张图片实测均能加载”。失败卡片仍应保留提示词、来源入口和手动重试，不能让图片失败阻断填入提示词；不能通过无约束代理隐藏外部资源失败。

## 已实施情况与验收进度

当前已将 654 条封面、80 条多图案例、798 个不同图片 URL 接入现有提示词库。卡片与详情按需直连远程图片，不新增服务端图片抓取或转存；封面/大图使用 `object-contain` 完整显示，详情支持图库切换及放大。图片加载超过 25 秒进入明确失败态，提供手动重试和原案例入口；展示图片不自动加入节点参考图，也不发起生成请求。`no-referrer` 避免向图床发送当前画布 URL。

已确认后端相关回归 **83 / 83**、前端 UI/节点/API 客户端 **47 / 47**、shared 契约 **144 / 144**、导入器 **10 / 10** 通过，server / web 类型检查通过。真实 Chromium 浏览器流程通过（最终 24.3 秒）：4 个来源各抽样真实封面、多图切换、完整放大、首屏 24 条仅挂载 8 张可见图片、无远程 Authorization/Referer、原文替换/追加及双节点刷新恢复；注入一次附图失败后点击重试成功从真实原站加载。应用错误为空，生成请求为 0，未操作用户画布。截图已经检查，详情见 [主实施记录](./prompt-library-implementation-20260909.md)。这不是全量 798 个远程地址的可达性保证。

独立复查还发现 33 条记录的标题/标签有明确 NSFW 标记，现默认不挂载图片、不提前请求，需用户显式点击显示；仅在本次库会话内记住该条目。此保护只依据上游显式标识，不扫描正文、不下载分析图片，不代表内容已经人工或模型审核。

## 验收和后续回归的产品边界

1. 卡片显示封面、详情显示去重后的图集，80 条多图案例不丢图；原图比例在详情完整呈现。
2. 只渲染当前页图片，切页或切条目不会预加载全库；关闭详情不会继续主动加载下一张。
3. 图片请求使用公开远程地址，不附加 Loomic API token 或私有素材数据；`referrerPolicy="no-referrer"` 不把当前私有画布 URL 发送给图床。
4. 失败可重试、可打开原案例，图片失败不影响搜索、正文、替换/追加和节点草稿持久化。
5. 选择提示词不自动把示例图附加为生成参考图，不自动发起计费任务，不自动切换 `gpt-image-2` 与其他模型。
6. 现有作者、来源及许可说明继续保留；不将示例图描述成 Loomic 创作或承诺原作者为本项目背书。

此文档包含源核对、统计与当前实施进度；真实浏览器截图、运行方法和验收详情见主实施记录。
