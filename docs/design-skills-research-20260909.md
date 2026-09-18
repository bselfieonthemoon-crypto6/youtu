# Loomic 设计 Skills 与配套模型调研

调研日期：2026-09-09。范围：美图设计室、Lovart、TapNow、LibTV，以及有源码、示例或论文的设计项目。

本轮仅检查公开文档、源码、许可及 Loomic 当前配置。没有安装 Skill、启用新模型、下载权重、执行外部脚本或调用付费生成接口。本文件是调研产物，不是实施记录。

## 结论与证据边界

值得优先评估的是：SVG Logo、宣传封面、轮播叙事、信息图结构、品牌约束和设计复核；抠图、选物、图片分层则需要专用执行后端，不能靠多写一份 Skill 获得像素能力。

没有找到足以证明下列所有 Skill 都“独立验证效果优秀”的统一评测。能核实的是：哪些有完整实现、作者真实案例、第三方方法复用、工程测试或模型论文。仓库星数、安装量、厂商效果图不作为质量结论。所有新候选都尚未通过 Loomic 样板验收。

本文区分三类：

- **设计 Skill**：可阅读的流程、参考资料和脚本；可以考虑移植设计知识，但不等于能直接运行在 Loomic。
- **执行工具／模型**：提供 SVG 转换、透明蒙版、RGBA 分层等实际产物，需要平台封装调用。
- **商业平台流程／连接器**：可借鉴产品方法，或购买远程服务；不能宣称其内部设计算法已经开源。

优先级是本项目的选择建议，不是效果排名。许可只记录本次看到的原文，不替代针对商业 SaaS 集成方式的许可审查。

## 一、模型怎么配

### 1. 当前项目可复用的模型

只读查询本地副本当前工作空间：以下模型与其供应商配置均启用，供应商最近测试状态为 succeeded。这只是配置状态，不代表所有 Skill 或每个模型端点已经通过本轮生成实测。

| 当前配置 ID | 建议职责 | 注意事项 |
|---|---|---|
| `gemini-3.1-flash-lite` | 理解需求、拆分任务、选择 Skill、生成结构化布局、简单 SVG／文字修改 | 当前 Agent 默认值；可作为首轮低成本基线，不据此断言其复杂设计能力最强 |
| `deepseek-v4-flash-vision-exp` | 看参考图、辅助文字识别、描述对象、视觉复核 | 项目已配置的实验模型 ID；不是分割模型，不能用自然语言描述代替 alpha 蒙版 |
| `gpt-image-2` | 参考图生图、局部改图、背景素材、透明素材 | 复用当前 API 路线；透明任务精确指定此 ID，不使用 `-all` |
| `nano-banana-2` | 系列主视觉、商品参考图编辑的备选对照 | 这是当前供应商侧 ID；不要未经核验就改成 Google 原生 ID |
| `gpt-image-2-all` | 当前另外存在的图片路由 | 不作为本报告透明背景任务的推荐路由 |
| `veo-3.1-fast-generate-preview` | 当前存在的视频模型 | 本轮静态设计候选不依赖它，不测试视频 |

本地依据：[默认 Agent 模型](/E:/Loomic/Loomic/apps/server/src/config/env.ts:4)、[抠图模型常量](/E:/Loomic/Loomic/apps/server/src/features/images/api-background-removal.ts:7)、[文字识别模型](/E:/Loomic/Loomic/apps/server/src/features/images/image-text-recognizer.ts:19)、[图片适配器](/E:/Loomic/Loomic/apps/server/src/generation/providers/openai-image.ts)。本轮未输出供应商密钥。

OpenAI 官方当前把 `gpt-image-2` 的透明背景标为 preview：使用 `background: "transparent"`，输出 PNG 或 WebP，不支持透明 JPEG。官方仍列出文字、品牌一致性和精确构图限制。因此“支持透明”不等于“原主体像素完全不变”，也不意味着可以代替原生字体和图层编辑。[官方图片指南](https://developers.openai.com/api/docs/guides/image-generation)

Google 官方将 Nano Banana 2 对应为 `gemini-3.1-flash-image`，Nano Banana Pro 对应为 `gemini-3-pro-image`；这是 Google 原生 API 命名，不是对本项目供应商别名映射的实测保证。[Google 图片模型说明](https://ai.google.dev/gemini-api/docs/image-generation)

### 2. 需要新增时的候选

| 候选模型／服务 | 用途 | 是否为现有配置 | 本轮结论 |
|---|---|---|---|
| `gemini-3.1-pro-preview` | 复杂 brief、SVG 方案、跨页约束与评审的对照主模型 | 否 | 官方有模型页；可做升级候选，尚未证明比现有模型更适合我们的样板。[模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview) |
| `gemini-3-pro-image` | 复杂主视觉、参考一致性对照 | 否 | Baoyu 后端有适配；供应商可用性和价格另验 |
| `ZhengPeng7/BiRefNet_dynamic-matting` | 自动前景 alpha | 不在上述统一云模型清单；历史已有本地路线 | 不因曾下载就视为已满足质量验收；先用旧失败样例比较 |
| `facebook/sam2.1-hiera-small` | 点／框交互选物 | 不在上述清单 | 选区后端候选，不是自动细边缘 matting |
| `Qwen/Qwen-Image-Layered` | 多层 RGBA 拆解 | 不在上述清单 | 最贴近分层需求，但部署较重 |
| Photoroom Remove Background API | 商业自动抠图对照 | 不在上述清单 | 不需要本地 GPU，内部模型不可选，按量计费 |

Claude Code、Codex 是执行环境，不是精确模型名称。部分上游只说明使用 Claude Code，没有披露 Sonnet／Opus 版本，本文不补造一个“作者验证模型”。迁移到 Loomic 后使用现有模型是我们的适配建议，不是上游已经测试过的组合。

## 二、优先评估的真实设计 Skills

### A1. SVG Logo：neonwatty/logo-designer-skill

**价值：**从品牌信息出发比较概念，保留图标、字标等稳定分组，按反馈局部迭代，并检查小尺寸辨识度。直接写 SVG，适合真正的矢量标志，而不只是输出一张 Logo 图片。[Skill 源码](https://github.com/neonwatty/logo-designer-skill/blob/main/skills/logo-designer/SKILL.md)

**证据：**有作者 Bullhorn／Seatify 的概念与修正案例；code-katz 公开致谢其 SVG 方法，构成复用迹象。不是独立审美评测。导出测试使用 fakeResvg，不能据此声称真实渲染已验证。[作者案例](https://neonwatty.com/posts/logo-designer-skill-claude-code/)、[复用说明](https://github.com/code-katz/claude-illustrate-skill#prior-art)、[测试](https://github.com/neonwatty/logo-designer-skill/blob/main/tests/export.test.mjs)

**模型：**上游明确 Claude Code，未锁定精确推理模型；核心不需要生图模型。Loomic 可先用现有 Gemini 写 SVG，必要时比较 Pro 候选；视觉模型只辅助复核。复杂绘画型品牌图可另调用 `gpt-image-2`，但不应假装它输出了矢量。

**适配／许可：**MIT。迁移分组、概念比较、小尺寸复核；不要照搬 bypassPermissions、自动 PR 或导出脚本中的临时下载行为。SVG 必须经过安全解析。[许可](https://raw.githubusercontent.com/neonwatty/logo-designer-skill/main/LICENSE)、[导出脚本](https://github.com/neonwatty/logo-designer-skill/blob/main/skills/logo-designer/scripts/export.sh)

### A2. 中文轮播：baoyu-xhs-images

**价值：**按照故事、知识密度和视觉主导等策略拆页，区分封面、内容页和结尾，并用前页建立后续风格参考。适合小红书、商品卖点和知识轮播。[Skill](https://github.com/JimLiu/baoyu-skills/blob/main/skills/baoyu-xhs-images/SKILL.md)

**证据：**完整流程、参考库与作者样图；公开问题也能看到实际使用，但有用户报告返回历史图片，因此“有人使用”不等于“可靠性无问题”。[样图](https://github.com/JimLiu/baoyu-skills#baoyu-xhs-images)、[产物异常问题](https://github.com/JimLiu/baoyu-skills/issues/185)

**模型：**推理模型未固定；上游共用图像后端支持 GPT Image／Gemini Image。我们建议现有 Gemini 负责内容与排版，`gpt-image-2` 或 `nano-banana-2` 只负责所需视觉素材。

**必须改造：**原版倾向整页位图，不能直接满足画板文字可编辑。应移植分页策略，把标题、正文和 CTA 生成为原生文字，多画板共享品牌与素材。MIT，外部素材另外核权。[许可](https://raw.githubusercontent.com/JimLiu/baoyu-skills/main/LICENSE)

### A3. 信息图：baoyu-infographic

**价值：**按比较、流程、层级、时间线等信息关系选结构，再选视觉风格；适合产品说明、功能对比、活动流程和数据宣传图。[Skill](https://github.com/JimLiu/baoyu-skills/blob/main/skills/baoyu-infographic/SKILL.md)

**证据：**完整布局参考和作者展示，未找到独立效果对照。**模型：**同 Baoyu 共用路由；迁移后纯结构图可只用主 LLM＋原生形状／文字，不必每次付费生图。插画需要时再调用图片模型。

**必须改造：**数字和事实绑定原始资料；不要让图像模型重写数据。布局转成可编辑分组和连接线，不把整图位图当作分层交付。许可同仓库 MIT。[仓库](https://github.com/JimLiu/baoyu-skills)

### A4. 宣传封面：baoyu-cover-image

**价值：**把主视觉、色彩、渲染、文字密度和情绪分别决策，能形成更明确的美术方向，适合活动封面、宣传主图。[Skill](https://github.com/JimLiu/baoyu-skills/blob/main/skills/baoyu-cover-image/SKILL.md)

**证据：**源码、参考文件和作者风格样图；不是独立效果排名。**模型：**现有 Gemini 编写 brief；`gpt-image-2`／`nano-banana-2` 生成背景或主体。不能因调用相同图片模型就把不同 Skill 视为相同能力——区别在内容决策和构图约束。

**必须改造：**保留原生标题和客户字体；用户只改一句话时，不重生成全图。原版的确认、重试和收费调用必须服从平台规则。许可同仓库 MIT。[样图与说明](https://github.com/JimLiu/baoyu-skills#baoyu-cover-image)

### A5. 字体、布局与评审：Impeccable

**价值：**重点借用 typeset、layout、critique、polish。字体复核要求尊重权威字体来源与既有身份；验收需要真实渲染／代码证据，不只是说“通过”。适合我们此前字体不一致、文本溢出、预览错位这类问题。[Skill](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/SKILL.md)、[字体复核实现](https://github.com/pbakaus/impeccable/blob/main/.agents/skills/impeccable/reference/typeset.md)

**证据：**有命令、检测器、测试入口和作者网页案例。本轮没有执行其测试；网页案例也不能直接证明海报设计质量。[测试入口](https://github.com/pbakaus/impeccable/blob/main/package.json)、[作者案例](https://impeccable.style/cases/neo-mirai/)

**模型：**未固定精确主模型；代码属性检查不需生图模型，像素复核可用当前 DeepSeek Vision／Gemini Vision。**适配：**DOM/CSS 检查改成 Loomic scene、字体资源和渲染检查；确定性校验先行，视觉模型只作补充，限制反复精修次数。Apache-2.0。[许可](https://raw.githubusercontent.com/pbakaus/impeccable/main/LICENSE)

### A6. 海报构图：Anthropic canvas-design

**价值：**先建立视觉理念，围绕留白、尺度和层级形成作品，再精修。可作为艺术海报／封面的构图方法库。[Skill](https://github.com/anthropics/skills/blob/main/skills/canvas-design/SKILL.md)

**证据：**Anthropic 官方创意示例，不是该 Skill 的独立生产质量评测。**模型：**面向 Claude，未固定具体型号；无需必备图像模型，生成插画时可配现有 `gpt-image-2`。

**适配：**原输出侧重 PNG/PDF，不能直接替代原生画板；抽象少字的倾向必须服从客户文案和品牌。此目录 Apache-2.0，不将结论扩展到仓库全部 Skills。[官方定位](https://github.com/anthropics/skills)、[独立许可](https://raw.githubusercontent.com/anthropics/skills/main/skills/canvas-design/LICENSE.txt)

### A7. 品牌提取：OpenDesign brand-extract

**价值：**从实际网页 DOM/CSS 和资产提取配色、字体、Logo，并形成结构化品牌包，减少每次设计重新猜测品牌。[完整 Skill](https://raw.githubusercontent.com/nexu-io/open-design/main/skills/brand-extract/SKILL.md)

**证据：**完整实现和品牌预览／确认流程；没有找到此单项的独立效果测试。**模型：**工具调用 LLM＋浏览器真实测量，视觉模型辅助；不需要图像生成模型。

**适配：**只处理用户授权的品牌资料，存入 Loomic Brand Kit 和长期资源库；缺字体不能静默替换。它依赖 OpenDesign CLI，需改成平台工具。根项目 Apache-2.0，第三方子目录保留各自许可。[项目与许可边界](https://github.com/nexu-io/open-design)、[许可](https://raw.githubusercontent.com/nexu-io/open-design/main/LICENSE)

### A8. 商品宣传套图：OpenDesign ecommerce-image-workflow

**价值：**以真实商品图为输入，约束外形、颜色、Logo 与材质；拆出主图、卖点、场景等用途，维护实际产物清单，避免编造商品事实。[完整 Skill](https://raw.githubusercontent.com/nexu-io/open-design/main/skills/ecommerce-image-workflow/SKILL.md)

**证据：**明确的输入契约、清单和检查表；检查表存在不等于已经跑通效果验收。[检查表](https://raw.githubusercontent.com/nexu-io/open-design/main/skills/ecommerce-image-workflow/references/checklist.md)

**模型：**主 LLM 负责商品事实与用途拆解，图片后端必须支持参考图；我们可用 `gpt-image-2`，以 `nano-banana-2` 作对照。原版未强制特定图片模型。

**适配：**只在授权预算内生成；先验一张，再扩展套图。母版、文字、卖点字段应原生可编辑，不能直接照搬 OpenDesign 的文件／队列命令。许可按根项目及实际引用文件逐项复核。

### Baoyu 后端的精确模型依据

消费者 Skill 未锁定推理模型。共享 baoyu-image-gen 的 OpenAI provider 当前默认 `gpt-image-2`；Google provider 当前默认 `gemini-3-pro-image`，支持列表包含 `gemini-3.1-flash-image`。这证明源码适配范围，不保证每个供应商在线可用或质量最优。[OpenAI provider](https://github.com/JimLiu/baoyu-skills/blob/main/skills/baoyu-image-gen/scripts/providers/openai.ts)、[Google provider](https://github.com/JimLiu/baoyu-skills/blob/main/skills/baoyu-image-gen/scripts/providers/google.ts)

导入 Skill 文字不会自动安装这些 provider、CLI 和图片库。Loomic 当前从数据库加载启用 Skill 及文本附件，应把调用映射到现有受控工具，而不是假设外部 shell 运行环境天然存在。[本地加载实现](/E:/Loomic/Loomic/apps/server/src/agent/workspace-skills.ts:37)

## 三、抠图、选物、分层和矢量化：需要封装的后端

以下不是已经可导入的设计 Skill。接入时应形成“选择工具→处理→验证→入库→插入正确节点”的平台工作流。

| 能力／后端 | 配套模型 | 为什么进入候选池 | 输出与部署边界 |
|---|---|---|---|
| 保留当前透明改图基线 | `gpt-image-2`，不带 all | 当前项目已有路线，官方明确支持透明输出 | API 付费；生成式编辑不保证主体像素不变；不是原始图层恢复 |
| 自动前景抠图 | `ZhengPeng7/BiRefNet_dynamic-matting` | 有权重、代码、模型卡和作者评估入口 | 软 alpha；本地推理有算力成本，需对照旧失败图片。[模型卡](https://huggingface.co/ZhengPeng7/BiRefNet_dynamic-matting) |
| 点／框选主体 | `facebook/sam2.1-hiera-small` | 官方代码、公开基准及交互预测示例 | 输出选区，不是发丝、玻璃透明度的完整解决方案；推荐 GPU 评估。[模型卡](https://huggingface.co/facebook/sam2.1-hiera-small) |
| 文字指定主体 | `facebook/sam3` | 原生概念提示和官方评测 | 权重访问受控，自定义许可；不是 SAM2 的 Apache 许可。[模型卡](https://huggingface.co/facebook/sam3)、[许可](https://github.com/facebookresearch/sam3/blob/main/LICENSE) |
| 图片分层 | `Qwen/Qwen-Image-Layered` | 有可运行示例与图层重建论文指标 | RGBA 位图层，不是原始 PSD／矢量／字体文字；部署较重。[模型卡](https://huggingface.co/Qwen/Qwen-Image-Layered)、[论文](https://arxiv.org/html/2512.15603v1) |
| 自托管图片编辑 | `Qwen/Qwen-Image-Edit-2511` | 开放 checkpoint、参考图编辑示例 | 20B BF16，可能有非目标区域漂移；尚无本轮对 gpt-image-2 的实测优势。[模型卡](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) |
| 商业抠图 API | Photoroom 内部模型，未公开可选 ID | 有正式 API、蒙版和边缘处理能力 | 按量收费，无需本地 GPU；不是开源模型。[API 文档](https://docs.photoroom.com/remove-background-api-basic-plan) |
| 位图 Logo 转 SVG | VTracer，不需要生成模型 | 有 CLI／Python／Web 实现、示例和公开发行 | 算法描摹，适合图形矢量化；不会自动还原原字体或原作者路径。[项目](https://github.com/visioncortex/vtracer) |

### 关键选型限制

**BiRefNet 与 rembg 不要混淆。**BiRefNet 是模型，rembg 是多模型封装。rembg 当前模型注册表没有 dynamic-matting；不能声称改成 `rembg -m birefnet-dynamic-matting` 就能运行。general 路径使用固定 1024 预处理，与 dynamic 的原生使用路径不同。[注册表](https://github.com/danielgatis/rembg/blob/main/rembg/sessions/__init__.py)、[general 实现](https://github.com/danielgatis/rembg/blob/main/rembg/sessions/birefnet_general.py)

rembg 自身 MIT，但当前 main 文档的默认 bria-rmbg／RMBG-2.0 有单独商业限制；应显式锁定经批准的权重和版本，不依赖默认下载。BiRefNet dynamic-matting 模型卡标注 MIT。[rembg 文档](https://github.com/danielgatis/rembg#models)、[BiRefNet 模型卡](https://huggingface.co/ZhengPeng7/BiRefNet_dynamic-matting)

**不能拿通用模型显存当 dynamic-matting 的最低配置。**BiRefNet 仓库的效率表是特定模型、尺寸与硬件的作者测试；输入变大后显存和耗时需另外测。当前机器能否稳定跑、单图多少秒，本轮没有执行验证。[官方效率与推理说明](https://github.com/ZhengPeng7/BiRefNet)

**选物与精细抠图要分层。**SAM2.1 small 为 46M 参数，可点／框提示；其代码与权重为 Apache-2.0。SAM3 适合语义对象提示，但使用自定义 SAM License。两者输出 mask 之后，必要时再接边缘精修，不应把“选到物体”承诺成“透明材质也完全保真”。[SAM2 官方实现](https://github.com/facebookresearch/sam2)、[SAM3 官方实现](https://github.com/facebookresearch/sam3)

**Qwen 分层是真正值得试的方向，但有成本。**官方示例可以输出多个 RGBA 文件；模型为 20B BF16，光参数按两字节估算约 40GB，这不是实际显存下限，尚有其他组件、激活、卸载或量化影响。当前模型卡建议 640 分辨率。应先比较图层重新合成后的误差，再判定可用；文字分到 PNG 不代表可以改字体。[模型卡](https://huggingface.co/Qwen/Qwen-Image-Layered)

分层论文有 Crello I2L 协议下的定量结果，比只有演示图的候选证据更充分；这是作者指定数据集结果，不是我们中文海报的成功率。不要把它宣传成恢复原始设计源文件。[论文与评估协议](https://arxiv.org/html/2512.15603v1)

**Photoroom 的费用可预估，但需实际账户确认。**查询日官方页面列 Basic 抠图 $0.02/图，Plus 图片编辑 $0.10/图；sandbox 有带水印测试额度。两种 API 能力和计费不同，不能把 Plus 全部功能算成两美分。厂商对比测试属于自评，不认作独立排名。[官方定价](https://www.photoroom.com/api/pricing)、[厂商评测](https://www.photoroom.com/blog/image-background-removal-technology-comparison)

**remove.bg 暂不作为首选新增依赖。**官方已出现 2026-12-01 迁往 Leonardo 的计划，Leonardo 有相应迁移指南；不能说现在已停服。新接口的认证、返回和存储默认行为有变化，指南列模型 `remove-bg`，默认保存在 library，需 `ephemeral:true` 才不创建长期 library 资产。适合作为对照项，长期接入先确认迁移合同与隐私边界。[当前 API](https://www.remove.bg/api)、[官方迁移指南](https://docs.leonardo.ai/docs/migrate-from-the-removebg-api-to-leonardoai)

**VTracer 是不需要生图模型的实用补充。**位图图标先描摹成 SVG，再做路径数量、轮廓和多尺寸渲染对比；不要再次“设计”或改变用户已有 Logo。许可 MIT，输出字体仍可能只是路径。[许可](https://github.com/visioncortex/vtracer/blob/master/LICENSE)

## 四、四个平台：可以借什么，不能误认为有什么

| 平台 | 最适合借鉴的公开方法 | 是否找到可移植内部 Skill | 需要的模型／服务 |
|---|---|---|---|
| 美图设计室 | 结构化品牌输入、可编辑 Logo；字段绑定母版后批量套图 | 有名为 Skills 的产品入口，但未找到相应内部 SKILL.md 开源包；另有 API／SDK | 内部具体模型未公开，API／SDK 是独立服务合作 |
| Lovart | Brand Kit 与成功流程 Skill 分开；用户选中对象再下修改指令 | 官方产品有内置／自定义 Skills；公开同名连接器只是远程 Agent 适配，不是内部设计引擎 | 平台远程模型路由和额度；模型偏好不一定是强约束 |
| TapNow | 模板包含节点、连线、参数；非破坏性生成、先验一张再扩展 | 找到平台内可复用模板，未核实可下载设计 Skill 源码／第三方 API 契约 | 官方文档列 GPT Image 2、Banana Pro、Seedream 5.0 Pro 等；账户可用项另验 |
| LibTV | 广告／视频生产工作流、无限画布、远程任务回查 | 官网有 CLI Skill 入口，但本次最新版下载返回 404；另有旧公开远程适配仓库 | 远程 LibTV Agent 选模型，需要其账号、凭证和额度；不是只使用 Loomic 现有模型 |

### 美图设计室

官方 Logo 帮助描述品牌名／口号／行业输入及生成后编辑；批量套模板通过标签绑定文字和图片，适合我们做“确认母版→填入多组数据→输出系列画板”。[Logo 帮助](https://www.designkit.cn/help/92)、[批量套模板](https://www.designkit.cn/help/10)

自动抠图之后的保留／去除、修补和边缘处理可参考其操作划分，但不因此恢复用户已经要求删除的预览模块；未来交互必须重新得到用户选择。[抠图帮助](https://www.designkit.cn/help/84)

确有 Skills 场景页与 API／SDK 合作入口，但本次没有找到内部流程可自由导入的源码。底层模型未公开，不根据效果图猜模型。[Skills 产品页](https://www.designkit.cn/brand-design/logo-design)、[开放能力说明](https://www.designkit.cn/help/59)、[Agent 帮助](https://www.designkit.cn/help/137)

### Lovart

官方文档支持内置和自定义 Skills，可将成功对话沉淀为流程；Brand Kit 与流程各司其职。高级编辑文档描述对象指向、元素拆分和 PSD 输出，但这只证明官方宣称的产品能力，本轮没有实测任意图片分层质量。[Agent Skills](https://www.lovart.ai/docs/how-to-prompt/agent-skills)、[高级编辑](https://www.lovart.ai/docs/edit-your-design/advanced-ai-editing)

`lovartai/lovart-skill` 有真实客户端代码，但本次未完成官网反链归属验证；README／frontmatter 声明 MIT，所指 LICENSE 返回 404，许可需补证。其上传、传话、等待、取回产物都依赖远程 Lovart；列出的 GPT Image 2、Nano Banana、Seedream 等不是开源本地模型。[公开仓库](https://github.com/lovartai/lovart-skill)、[Skill 原文](https://raw.githubusercontent.com/lovartai/lovart-skill/main/skills/lovart-skill/SKILL.md)

模型选择规则允许 Agent 根据情况路由到相似模型。我们有“只能 gpt-image-2、不能 all”的硬约束时，不能把模型偏好当作白名单保证。[官方模型选择规则](https://www.lovart.ai/docs/how-to-prompt/selecting-ai-models)

### TapNow

最值得迁移的是围绕选定节点明确“改什么、保留什么、参考哪张”，并在批量扩展前先确认一个结果。模板应用新增节点组，不覆盖原画布；整组执行前确认消耗。[Agent 流程](https://docs.tapnow.ai/zh/docs/agent/tapnow-agent)、[模板文档](https://docs.tapnow.ai/zh/docs/canvas/use-library-and-templates)

官方图片工具文档列出了模型选择与多种编辑能力，但公开画布可以克隆不等于内部 Agent／Skill 源码已开源。本轮未找到足以支撑第三方 API 接入的公开契约。[图片模型与编辑](https://docs.tapnow.ai/en/docs/canvas/generate-and-edit-images)

### LibTV／Liblib

官网有 Skills 与 CLI 页；本次按其最新 ZIP 链接两次只读请求均为 HTTP 404／OSS NoSuchKey，因此没有安装或检查该 ZIP 的内容。这是本次可用性观察，不是宣称服务永久不可用。[官网](https://www.liblib.tv/)、[CLI 页](https://www.liblib.tv/cli)

旧仓库 `libtv-labs/libtv-skills` 有完整 MIT 文本，但未完成官网反链归属验证，也不能当作当前 ZIP 的源码。它是“上传参考→发送消息→等待远程 Agent→获取结果”的连接器。[旧仓库](https://github.com/libtv-labs/libtv-skills)、[旧 Skill](https://raw.githubusercontent.com/libtv-labs/libtv-skills/main/skills/libtv-skill/SKILL.md)、[许可](https://raw.githubusercontent.com/libtv-labs/libtv-skills/main/LICENSE)

旧说明列 NanoBanana、Midjourney、Seedream 5.0 及视频模型，但接口主要传 sessionId/message，没有独立严格的模型选择参数。上传路径在 README 与脚本中不一致，下载逻辑可能覆盖同名文件；不能直接照搬进入 SaaS。[接口实现](https://raw.githubusercontent.com/libtv-labs/libtv-skills/main/skills/libtv-skill/scripts/_common.py)、[上传](https://raw.githubusercontent.com/libtv-labs/libtv-skills/main/skills/libtv-skill/scripts/upload_file.py)、[下载](https://raw.githubusercontent.com/libtv-labs/libtv-skills/main/skills/libtv-skill/scripts/download_results.py)

Liblib.art 的模型／工作流 API 与 LibTV Agent 不是同一套契约，不把二者文档混用。[Liblib.art 开放平台](https://www.liblib.art/apis)

## 五、次选与暂缓项

| 项目 | 可取之处／模型 | 为什么不直接加 |
|---|---|---|
| Huashu Design | 品牌资产核验、风格库、HTML 视觉与精修；工具型 LLM 可执行，纯代码构图不必生图 | 有作者案例和 OpenDesign 方法引用，但原文强制新设计出三个方向，含随机风格选择，与用户明确意图冲突；只适合抽取方法。当前 raw LICENSE 为 MIT。[Skill](https://raw.githubusercontent.com/alchaincyf/huashu-design/master/SKILL.md)、[许可](https://raw.githubusercontent.com/alchaincyf/huashu-design/master/LICENSE) |
| Anthropic theme-factory | 跨画板统一配色／字体规则；主 LLM 即可 | 是主题资料库，不是完整设计生产流程；不能覆盖用户已有品牌。该目录 Apache-2.0。[Skill](https://github.com/anthropics/skills/blob/main/skills/theme-factory/SKILL.md)、[许可](https://raw.githubusercontent.com/anthropics/skills/main/skills/theme-factory/LICENSE.txt) |
| Anthropic brand-guidelines | 品牌规范的可执行表达；主 LLM 即可 | 实际为 Anthropic 自家规范，不能把其字体／品牌色套到用户设计上；只能参考结构。该目录 Apache-2.0。[Skill](https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md)、[许可](https://raw.githubusercontent.com/anthropics/skills/main/skills/brand-guidelines/LICENSE.txt) |
| guizang-ppt-skill | 杂志／瑞士风格、叙事节奏、多页模板；代码型 LLM，图片模型可选 | 有完整模板和 OpenDesign 下游引用，但上游当前 LICENSE 实际为 AGPL-3.0，与下游部分 MIT 描述不一致；另有强制主题限制。商业 SaaS 接入先明确具体版本／授权，不默认可整包迁入。[源码](https://github.com/op7418/guizang-ppt-skill)、[实际 LICENSE](https://raw.githubusercontent.com/op7418/guizang-ppt-skill/main/LICENSE) |
| OpenDesign 整包 | 可借鉴品牌、模板、资源与工具分层 | 是完整平台，很多目录是指向上游的 catalog stub；不是“全部几百个 Skill 都能直接用”，也不能用根许可覆盖第三方子目录。[仓库说明](https://github.com/nexu-io/open-design) |
| ui-ux-pro-max 等 Web UI 资料库 | 网页／App 界面设计 | 当前优先目标是原生画板、Logo、海报和图片处理；不因流行而列入第一批 |
| 只有聚合页、自动安装命令的 Skill | 作为发现上游的索引 | 没有实际实现、样例或许可时，不认定为“已验证好用” |

归藏许可观察不代表历史 MIT 版本必然失效；本轮没有完成历史提交与授权链核验，因此不据下游说明替上游作许可保证。

## 六、适配到 Loomic 时应保持的共同契约

以下为本项目的架构建议，不是声称上游已经具备，亦未在本轮实施：

1. **Skill 提供方法，平台控制权限。**模型、付费次数、目标对象和写入范围由平台约束；Skill 不得自行扩权、下载安装、自动发布或无限重试。
2. **明确用户指向。**绑定 canvasId、designId、elementId、sourceAssetId 和设计版本；用户发 Logo 改背景时，不能改旁边画板背景。
3. **小改动不重做整套设计。**原生文字修改只变对应对象；指定字体保持原样。新创作才需要概念探索，用户已经明确风格时不强制问卷／三方向。
4. **分开主体、背景与原生文字。**模型生成图片资产，平台负责布局、可编辑文字和可靠存储。允许按需求选择整图，但必须标注不可编辑部分。
5. **同一次生成有稳定身份。**生成任务、占位节点、最终资产一一对应；拖动占位后结果保留最新位置；两个并发任务不能互相覆盖或串图。
6. **资产验证后再声明完成。**核验真实图片字节、尺寸、alpha 与来源，入库并回读后再写入目标；不能拿旧图或供应商临时 URL 当新交付。
7. **系列稿先母版后扩展。**共享品牌、字体、商品参考与布局约束；只有确需生图的页才产生调用费用。
8. **验收分两层。**字体、对象位置、溢出、存储和版本使用确定性检查；审美、主体完整度由视觉复核与人工抽检补充，不让模型一句“通过”覆盖工程失败。

## 七、下一阶段建议与验收清单

本轮不自动进入添加阶段。建议先与你确认以下三个批次：

- **第一批：**Logo SVG、宣传封面、中文轮播、信息图结构，加上字体／布局复核。优先复用现有模型，不先增加供应商。
- **第二批：**品牌提取、商品保真套图、VTracer 矢量化；完善品牌与素材来源管理。
- **第三批：**专用抠图／交互选物／Qwen 分层的对照样板。保持当前抠图交互，不擅自恢复已删除的预览模块；按效果再决定本地或 API。

每个 Skill 在添加前锁定仓库提交、记录 LICENSE 和所用参考文件，移除不适合平台的安装、外发和权限指令。现有模型与新增候选要使用同一组真实输入比较，而不是拿供应商最佳样图作验收。

| 样板 | 必验项 | 不能接受的结果 |
|---|---|---|
| SVG Logo | 小尺寸识别、分组、透明导出、局部改色 | 只给位图冒充 SVG；变更非目标字标 |
| 中文宣传图 | 文案逐字、指定字体文件、原生图层、溢出检查 | 静默换字体；改标题导致整张重绘 |
| 五页轮播 | 标题顺序、品牌一致、无漏页、纠正单页不动其余页 | 五张互不相关图片；重复生成费用失控 |
| 商品套图 | 商品形状／Logo／颜色、无虚构卖点、来源一致 | 换成另一个商品；增加不存在的认证 |
| 去背景 | 真 alpha、孔洞／发丝／透明物、主体保真、最新节点位置 | 棋盘格画进图片；主体重绘但未告知 |
| 图片分层 | 每层 alpha、叠加回原图误差、独立移动、文字可编辑状态说明 | 遮挡补全被当作原图事实；位图文字冒充字体层 |
| 所有任务 | 用户中途纠正、并发、刷新回读、预览同步、取消与失败状态 | 串图、错目标、假成功、旧预览、资产刷新后丢失 |

审美可记录多次盲评，可靠性必须留下任务 ID、精确模型、Skill 版本、输入／输出资产、调用费用、验证项与失败原因。通过这一轮后，才可以准确地说某个组合“已经在 Loomic 验证可用”。
