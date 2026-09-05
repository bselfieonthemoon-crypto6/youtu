# Agent + Skill 升级与回退

基线提交：e7ecb97；标签：agent-skills-baseline-20260905。
Git 保存代码，不备份数据库、Storage、密钥或 models。九项 Skill 入库使用迁移 20260908000001_design_workflow_skills.sql。
提交使用仅对命令生效的 Codex <codex@local.invalid> 身份，未设置全局身份；未推送远程。

内置 Skill：logo-design、campaign-design、product-visual、design-review、reference-analysis、creative-directions、typography-layout、design-refinement、design-delivery。
仓库 skills/ 保存源文件，迁移将完整内容注册到系统 Skill 目录。未来修改需同步新增迁移，避免文件与数据库版本不一致。
页面 /skills 展示系统目录及工作区安装状态；Agent 通过既有 loadWorkspaceSkills 读取已安装且启用的条目，再从 /workspace-skills/ 按需读取指南。取消原 /skills/ 提示词兜底目录。
本次为当前工作区安装九项，冲突时不覆盖已有启停选择。迁移只注册目录，不自动给所有工作区安装。
启停会影响后续加载列表，不中断已执行中的调用，也不能抹除历史对话内容；提示词约束不是文件系统权限隔离。

## 快速关闭

在 API 进程环境设置 LOOMIC_DESIGN_SKILLS_ENABLED=false 并重启 API。
这会停止注入新增设计协作规则。已启用工作区 Skill 照常生效，当前启用列表的可用性约束保留。
如需停用某项指南，在 /skills 管理页面停用或卸载；开关是行为回退，不是文件访问权限。
重新设置 true 或删除变量后重启 API 可恢复升级。

## 代码回退

用 git log --oneline 找到 feat(agent): route bundled design skills with rollback switch 提交，
执行 git revert <该提交ID> 可撤回对应代码；后续提交依赖这次接入时，应先检查并按逆序回退相关提交。
代码回退不会撤销已应用的数据库迁移。数据库中的 Skill 可以先在页面停用，不要直接删除业务表。
先检查未提交改动，避免覆盖后续工作。不要 reset --hard 或删除模型和数据库。

## 人工对话验收

每项记录选用的 Skill、工具、是否询问、方案内容和用户评价。自动化通过不等于创意质量通过。

2026-09-06 接入验证：服务端类型检查通过；相关六个测试文件共 33 项通过。
使用一次性账号连接真实 Supabase 和本地 API，验证九项目录及详情、安装、停用、重新启用、卸载，并逐次调用 Agent 的 loadWorkspaceSkills 核对结果；测试数据已清理。
九份数据库内容与仓库源文件逐字核对（归一化换行）一致，当前工作区九项启用，/skills 页面 HTTP 200。
本轮未执行付费生图或对话创意质量评测，也未以浏览器点击方式验证所有页面交互。

| 请求 | 期待行为 |
| --- | --- |
| 帮我为儿童游戏品牌提出 Logo 方向，先不要生成 | 读取 Logo Skill，提出轮廓/识别逻辑不同的方向，不发起生图 |
| Logo 就用字标，一版，品牌名 ABC | 尊重一版和字标要求，不再给三套方向 |
| 做五一促销海报，优惠内容稍后给 | 不编造折扣和活动日期 |
| 用产品参考图做三张详情图，包装不能变 | 提取保真约束，每张承担不同信息任务 |
| 标题改成“新品上市” | 直接编辑，不增加方案问卷 |
| 把这个对象向右移动 20 | 原工具、坐标和版本流程保持 |
| 取消生成 | 使用原确认取消流程，不新建生成 |
| 图片放到画板背景层 | 指定 design target 和 layer_index，不落到外部无限画布 |
| 这个设计哪里有问题，先不要改 | 读取评审指南；未取得视觉信息时不声称看图，无写入 |
| 保留主体，只减弱装饰 | 保持已批准方案，不重做主体 |
| 聊聊今天心情 | 不加载设计 Skill，不调用视觉工具 |
| 同一任务关闭开关再运行 | 恢复原提示行为，已启用工作区 Skill 不受影响 |
