# Loomic Skills 实施与验收（2026-09-09）

## 范围与交付

本轮实施的是 Loomic 项目自己的 Skills 层，不是个人 Codex 插件安装。新增子 Agent 架构、长期记忆与知识库均不在本轮范围。保留现有服务与画板执行链路，不自动下载模型、不接入新的付费供应商。

本地副本 `http://localhost:3020/skills` 已安装并启用 19 个系统技能。真实接口检测为 14 个配置就绪、5 个指导型受限，没有未知或不可用项；不将指导型技能宣传为自动执行引擎。已有安装的启停选择不会被迁移覆盖。技能内容为适配 Loomic 工具的原创流程；公开项目只作为标注来源的方法参考，不把上游许可扩大为本项目的再分发授权。

| 场景 | 技能 |
| --- | --- |
| 标识与品牌 | logo-design、brand-consistency |
| 宣传及商品视觉 | campaign-design、product-visual |
| 轮播及系列 | social-carousel、series-visual-design |
| 信息组织 | infographic-design、design-copywriting |
| 参考与探索 | reference-analysis、creative-directions |
| 原生画板与排版 | canvas-design、typography-layout、resource-template-composition |
| 修改、验收与交付 | design-refinement、design-review、design-delivery |
| 生图参数 | json-image-prompt |
| 去背景 | background-removal |
| 图片分层边界与现有入口 | image-layer-separation（受限指导） |

## 实际调用方式

1. 每轮仅查询当前工作区已安装且启用的技能，读取正文及引用文件，计算内容哈希。
2. 按真实已发布模型目录检测模型角色、能力与限定型号；按本轮工具集合再次检查必需工具。
3. 主 Agent 按用户意图选择技能。`list_skills` 展示依赖，`use_skill` 返回完整正文、版本、内容哈希和引用路径。
4. 正文存入本轮只读快照。不能用旧会话文件或 `/skills/` 回退读取已停用技能，也不能由 Agent 改写技能正文。
5. 专业画板操作检查完整读取证据；只读部分正文不能解锁专业修改。简单改字、移动不强制走设计探索流程。
6. 技能不改变原有目标绑定、用户纠正、版本冲突校验、付费确认或保存／预览验收规则。

工具结果沿用现有持久化运行记录，能回查本次实际读取的版本与正文哈希；读取成功不等于设计执行成功。没有新增一套平行的任务或记忆数据库。

## 管理层修复

- 正文、附件与工作区安装通过调用者 JWT/RLS 的原子 RPC 一起保存，任何一项失败回滚。
- 编辑名称保持稳定 slug；附件字段省略时保留，明确传空数组才清除，传附件列表时完整替换。
- 已安装页面只展示真实安装；卡片、聊天快捷技能与 `@` 提及共享实际启用状态。失败不关闭编辑弹窗、不吞掉查询错误。
- 作者编辑自己的技能，工作区成员可读已安装的私有技能，但不能编辑作者内容。工作区安装管理需要管理员／所有者权限；猜测私有技能 ID 不能安装。
- 导入必须有真实 `SKILL.md`，不再拿 README 冒充。缺文件、非法编码、路径或二进制依赖会明确拒绝，不静默丢弃后报成功。
- 正文限制 256 KiB；单个引用文件 2 MiB；最多 64 文件；文本包合计 8 MiB。支持中文与空格文件名，拒绝目录穿越、重复路径及不安全文件名。
- 迁移完成会通知本地 REST 服务刷新接口缓存。真实页面验收发现并修复了新 RPC 缓存未更新的问题，以及新错误码不被共享协议接受的问题。

## 模型与执行边界

技能详情区分“模型要求”和“当前匹配模型”，同时显示工具依赖、来源、许可及限制。`配置就绪` 只表示配置匹配，不是供应商在线率或画质保证；`部分能力受限` 与 `当前不可用` 不会伪装成完整执行能力。

普通规划／视觉任务匹配现有工作区对应能力模型，不擅自更换用户指定的主模型。普通生图继续尊重当前选择，没有全局改成另一型号。

去背景已接通 Agent → 持久化方案 → 用户确认 → 现有异步任务队列：

- `generate_image.operation = remove_background`。
- 必须一张已解析原图、`outputFormat = png`、`quality = hd`。
- 上游必须恰为 `gpt-image-2`，允许使用其工作区公开 ID，不允许 `-all`、`-vip` 或别名映射变更后静默替换。
- 创建方案、跨轮确认、最终提交任务均复核。没有异步任务服务时不降级成普通生图。
- 执行器使用透明 PNG 路径并检查实际 alpha，保留原始资产；不保证包装小字、纹理与边缘逐像素不变。
- 本轮验证了参数、确认、持久化与入队边界，没有额外调用收费生图接口做画质比较。

尚未接入的专用能力：Qwen RGBA 分层、SAM 交互分割、新专用抠图供应商。现有图片工具栏的拆分不等于恢复原始 PSD／文字字体层。Agent 自动创建多个画板、任意 SVG 路径写入、SVG/PDF 导出也不属于本轮已有工具；轮播可以规划并制作已绑定页面，不能假称已创建全部页面。

## 验证记录

已完成：

- 服务端全量：139 个测试文件，821 项通过。
- Shared：110 项通过。
- Skills 前端及原聊天回归：45 项通过。
- 目录生成、引用完整性、哈希漂移与 SQL 数据安全：11 项通过。
- 19 个技能包通过 skill-creator 格式检查。
- 真实数据库事务/RLS：23 项通过，全事务回滚。
- 独立账号 JWT 与实际运行时 loader：9 项通过，验证中文引用、跨成员读取、启停、更新哈希；临时数据已清理。
- 真实页面 CRUD：创建与中文附件、停用刷新、编辑、稳定 slug、卸载重装、清空附件、删除均已通过，未改变原有技能安装状态。
- 独立 forward-test：定稿 Logo 只改字、轮播先制作指定封面、严格逐像素抠图三个任务。发现摘要／完整对象字段说明歧义后进行了针对性修正，以追加迁移 04 发布，不改写已应用的 03。

### 真实模型自主选择与交付：通过

运行 `69314005-c480-4a22-8a58-f5d85ab53b7e`，用户请求未包含任何显式技能提及，使用实际供应商模型而非模拟响应：

- 自主选择 `typography-layout`，通过 `use_skill` 完整读取 1,354 字符正文，版本 `2.0.1`；内容哈希 `1ecb230a465d979875b367afd4807743d213c2c231a8542b097b6ae583015371`。
- 实际修改两个原生文字对象的字号、字重与位置，保留两段原文、Arial 字体、文字颜色、背景和 640×360 尺寸，另一个画板未变。
- 最终设计 revision=2，preview_revision=2，`saved_and_preview_synced`；实际预览有可见文字，四边留白检查通过；关闭编辑并刷新后像素和保存文档一致。
- 第一次模型命令漏传 `patch.object_type`，执行层返回明确验证错误，未应用任何命令；第二次修正后成功。这说明拒绝错误输入及自我纠正链路有效，不代表模型不会犯错。
- 测试项目已通过系统删除接口归档，不出现在正常项目列表；其画板数据按现有可恢复删除机制保留，并非物理擦除。仅处理本次 QA 项目，未删除用户作品。保留脱敏证据及截图。测试没有调用图片或视频生成，实际文本／视觉验收模型可能产生常规费用。

证据文件：

- [真实 Agent 结果](../apps/web/test-results/skills-agent-live/design-task-steering-local-6e11a-for-professional-typography-chromium/actual-autonomous-skill-evidence.json)
- [工具调用序列](../apps/web/test-results/skills-agent-live/design-task-steering-local-6e11a-for-professional-typography-chromium/actual-autonomous-tool-sequence.json)
- [实际画板截图](../apps/web/test-results/skills-agent-live/design-task-steering-local-6e11a-for-professional-typography-chromium/actual-autonomous-typography.png)
- [管理页面真实验收](../apps/web/test-results/skills-management-local/skills-management-local-Sk-1ff4f-e-and-toggle-survive-reload-chromium/skills-crud-evidence.json)
- [模型与能力详情截图](../apps/web/test-results/skills-management-local/skills-management-local-Sk-1ff4f-e-and-toggle-survive-reload-chromium/background-removal-model-details.png)

验收检查的是实际修改、真实存储和刷新结果，不把模型的“已完成”文字作为通过条件。19 项并未逐个进行付费生图画质 benchmark，不能将工程验收数量解释为所有设计类型的质量成功率。

## 复跑入口

- `scripts/build-design-skill-catalog.mjs --check`：校验当前包与最新生成迁移一致，无数据库写入。
- `scripts/apply-local-design-skills.mjs`：固定当前本地副本，按迁移记录应用 02/03/04，保留既有启停选择。
- `scripts/test-skills-package-local.mjs`：真实数据库回滚测试。
- `apps/server/scripts/test-workspace-skills-local.ts`：独立 JWT + 实际 loader 测试。
- `apps/web/e2e/skills-management-local.spec.ts`：真实页面管理验收。
- `apps/web/e2e/design-task-steering-local.spec.ts`：本地画板与真实模型验收；真实模型用例需要显式环境开关，可能产生文本／视觉模型费用。

运行本地验收时加载 `artifacts/local-replica-20260907/app.env`，不要误用线上 `.env.local`。不会在报告中输出密钥。多个用例不要同时为同一账号申请 magiclink，以免一次性令牌互相作废。

研究来源、模型候选及许可核查详见 `docs/design-skills-research-20260909.md`。后续可在当前“技能包→依赖→版本化读取→受控工具→验收”基础上再扩展子 Agent 和知识库。
