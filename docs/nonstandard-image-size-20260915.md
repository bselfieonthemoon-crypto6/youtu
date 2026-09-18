# 非标准尺寸适配技能验收

## 规则

- 独立应用技能 `nonstandard-image-size` v1.0.0，已安装到当前本地工作区并启用。
- 当前请求明确允许近似或明确使用本技能时加载；“适配面板”或只报尺寸本身不等于近似授权。
- 保留目标 W:H，自定义比例支持 1:3 至 3:1。现有解析器选择请求尺寸的比例误差不超过 1%；最终图片必须另查实际尺寸。
- 小目标可能生成较大图片；不把比例相近说成像素相近，不声称已经缩放。
- 超出范围不自动钳制、拉伸、裁切；先说明不能接近，提供后续处理选项。
- 新请求不继承近似授权，明确精确尺寸要求优先。UI 显式比例优先。
- 图片交付无限画布；GIF、压缩、透明背景及原生画板写入不由本技能自动承诺。
- 未修改共享尺寸算法或标准生图参数默认值。其他技能、工作区安装状态的数据库校验和保持一致。

## 测试结果

1. 原始清单 13 个目标：10 个支持尺寸 × 1K/2K/4K 共 30 次请求映射均在 1% 内；480×112、720×96、656×176 超范围明确拒绝。另校验 3 个标准流程尺寸快照。
2. native-image-size 10 项、Mastra agent/image tool 42 项、技能目录 12 项测试通过；服务端 typecheck 通过。
3. 真实 Agent 正向测试 run `1668a997-c4a1-4088-86e5-a9220af74c3c`：自动 list_skills → use_skill → generate_image。第一次 use_skill 错传 outputKind=image 被类型检查拒绝，Agent 随后成功读取技能。没有因此重复生图。
4. 唯一图片任务 `07704d37-3d76-4315-850a-2a09aa984b1e` 成功，当前已启用 gpt-image-2.5-flare，目标比例 719:1280，实际 PNG 1152×2048，比例误差 0.1391%，已写入测试无限画布。已读取原始图片尺寸并预览确认竖向植物插画。
5. 真实反向测试 run `9f6ac336-d126-42f3-b7aa-0c0fc428d54a`：新任务只讨论 720×96，明确不继承近似授权；工具调用数为 0，回答说明 7.5:1 超出当前范围。

证据：`artifacts/nonstandard-image-size-20260915/`，包括尺寸矩阵、技能 ready 状态、浏览器两轮记录、实际图片和 result.json。浏览器报告包含重复的工具事件回放，数据库确认只有一个生成任务。

## 复现

```powershell
node --import ./apps/server/node_modules/tsx/dist/loader.mjs scripts/verify-nonstandard-image-sizes.mts
node scripts/build-design-skill-catalog.mjs --check
node --env-file=artifacts/local-replica-20260907/app.env scripts/verify-nonstandard-skill-result.mjs
```

单技能增量迁移：`20260915000002_nonstandard_image_size_skill.sql`。本地安装脚本 `sync-local-nonstandard-skill.mjs --apply-local` 仅针对固定本地副本，保留现有开关选择。

实现分工：Terra（medium）技能包、触发指引和目录测试；主控规则矩阵、复核、定向本地安装、真实浏览器与产物验收。
