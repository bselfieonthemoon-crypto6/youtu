# Agent + Skill 升级与回退

基线提交：e7ecb97；标签：agent-skills-baseline-20260905。
Git 保存代码，不备份数据库、Storage、密钥或 models。此次升级没有数据库迁移。
提交使用仅对命令生效的 Codex <codex@local.invalid> 身份，未设置全局身份；未推送远程。

新增内置 Skill：logo-design、campaign-design、product-visual、design-review。
通过既有 /skills/ 文件系统路由读取，Dockerfile 已复制 skills/，无需数据库安装。
内置项不出现在工作区数据库 Skill 管理列表中；同名已启用工作区 Skill 优先。

## 快速关闭

在 API 进程环境设置 LOOMIC_DESIGN_SKILLS_ENABLED=false 并重启 API。
这会停止注入新增设计协作规则和内置目录，恢复原主提示词。既有工作区 Skill 照常生效。
技能文件仍在磁盘，明确要求读取文件仍可能访问；开关是行为回退，不是文件访问权限。
重新设置 true 或删除变量后重启 API 可恢复升级。

## 代码回退

用 git log --oneline 找到 feat(agent): route bundled design skills with rollback switch 提交，
执行 git revert <该提交ID> 可撤回主 Agent 接入；需要时再 revert 新增 Skill 提交。
先检查未提交改动，避免覆盖后续工作。不要 reset --hard 或删除模型和数据库。

## 人工对话验收

每项记录选用的 Skill、工具、是否询问、方案内容和用户评价。自动化通过不等于创意质量通过。

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
