# 普通对话链路与无人值守遗留边界排查

进行中。不能用本文件表示完整验收通过。

## 核实的问题

- 用户当前会话 `2078d2d2-249f-4d77-b69d-3586c40aed50`：讨论横幅留白后“符合”“确认”，run `466a1019-f7fe-4200-a12f-68ea5eadebc4` 调用方案 `3105c879-3994-40e2-895a-03abcd0450e9` 被 `intent_review_unsupported_scope` 拦截，未提交渠道。DB 的 current-proposal 检查将任何非 decision 用户消息视为方案失效，讨论与需求变化混淆。
- 拦截后助手仍声称“请稍候，我将立即提交”，但 run 已 completed；不是后台正在执行。
- 打开原生编辑器会让 fresh chat 隐式绑定 activeDesignId，即使未明确选中目标。
- 不注入任何模型偏好的真实页面测试仍路由到 `apiyi:gemini-3.1-flash-lite`：run `a5a862ee-4e21-4670-8c00-e4935551bba5`。当前 `/api/models` 只有 DeepSeek。WS/HTTP 特判环境默认模型而绕过当前发布目录，是产品真实路由问题，不仅是以前脚本的问题。

## 无人值守实际状态

本轮只读 DB 核实：`record_agent_task_continuation` 与 `z_bind_delivered_canvas_review` 均 disabled；enabled autonomy preferences=0；enabled 或 running/waiting autonomy=0；service_role 无 claim continuation EXECUTE 权限。不要将历史 dead code 等同于仍在自动执行。

## 变更与验证进度

- Root：两种入口共用 live catalogue model resolver。Auto 使用当前目录，显式不可用模型拒绝，不能借环境默认别名绕过目录。初次 17 项模型路由测试通过，正补 WS Auto 验证。
- Root：生图确认门禁失败也纳入真实终态回执，不能在本轮已停止后承诺自动继续；26 项回执测试通过。
- Terra medium：移除打开编辑器对 fresh chat 的隐式目标绑定，保留选中对象、canvas-ref 和明确任务续接；报告 70 项前端测试、typecheck 通过。`.next-production-context` 生产构建通过，尚未切换在线进程。
- Sol high：正在实现服务端可信的方案与消息关系（讨论保留，实际修改失效，不确定可重评），与付费授权分离。新迁移尚未部署，后端完整链路尚未验收。
- Luna medium：只读检查 UI/提示词，发现隐式绑定与旧 execution-mode 测试；未修改代码。

## 独立真实测试

Fixture `artifacts/paid-dialogue-live/ordinary-context-20260913.json`：canvas `0e1fe3a8-8d9a-4947-bcff-f6be266c5834`，session `0bdad273-cc95-4d86-8624-e98b846aab37`。测试驱动 `--product-defaults` 禁止 text/image/ratio 覆盖，不从 fixture 注入旧模型；登录之外不修改偏好 storage，断言 wire 无 model 且 Auto models=[]。

初次发现错误默认路由的证据：`artifacts/paid-dialogue-live/browser-turns/2026-09-12T17-08-22-800Z.json`。仅讨论，未生成付费图片。后续必须在修复路由后完整走到图片交付，不能把这轮当作 DeepSeek 验收。

## 部署与实际复测（持续追加）

- 前端 `.next-production-context` 已切换 PID 32892。第一版关系迁移 `20260913000001` 已经两次真实 DB 事务回滚测试通过后正式部署，并登记 migration ledger。API PID 2216，部署时间约 2026-09-13 01:30 +08。
- 迁移前 schema 备份：`artifacts/local-replica-20260907/loomic-schema-before-dialogue-20260913.sql`。用户原会话消息未改写，测试在独立 QA。
- `f3b5ff28-1b63-4e07-a7be-fc759a309281`：页面无模型覆盖，DB 确认 text model=`workspace:b1b94c9a-cec3-4321-8eb4-898a6a5a41d6`（当前发布 DeepSeek）；保存 16:9 proposal `6d880f77-03d6-421b-a118-cad48cd46de0`。
- `d0c522e0-af9a-4814-a7fd-be36c757df8e`：只讨论留白，DB relation=`preserve`，无生成。
- `c5fff8b6-cf0d-4540-a763-b140dd52fbe5`：用户认可并要求保持原方案，真实 get_image_proposal 返回原 proposal，relation=`preserve`，方案未丢失。
- `5489881d-ebfc-4ede-8743-183afc27a2a3`：用户随后“确认”仍失败，零图片任务。原因是上一句 DeepSeek 自然表达“想生成时告诉我一声即可，我再提交任务”，第一版 CTA 固定措辞未覆盖，且把没有生成授权误等同于没有当前方案。证据 `artifacts/paid-dialogue-live/browser-turns/2026-09-12T17-33-53-542Z.json`。未将此算作通过，正修语义确认与只读方案关联的分离。
- 新查到普通写入中固定 8 次 review 上限。Root 已在源码移除成功次数额度，改为相同参数与相同证据连续三次拒绝后的防空转；参数或证据变化可重新核对，成功操作仍逐次校验。14 项测试通过，尚待最终 API 重启部署。
- Root 最终重新核验路由/失败反馈/退役入口 49 项通过，普通确认/恢复底层 72 项通过，前端 70 项通过。类型检查通过。以上不能代替尚未完成的真实出图验收。

## 第二次部署与真实交付

- 第二迁移 `20260913000002` 已完成真实事务回滚验收并正式应用，API PID 40196；普通成功写前复核的 8 次硬额度也已随本次重启移除。PostgREST schema cache 初次未更新导致新 RPC 暂不可用，发出 reload schema 通知后恢复；迁移文件已加入通知。
- `185d48e2-424a-464b-aedc-3bc34da22046`：同一失败 QA 再回复“确认”，成功提交原方案 `6d880f77-03d6-421b-a118-cad48cd46de0`。渠道实际返回 1024×1024 而请求 16:9，任务正确终止为 `image_aspect_ratio_mismatch`，没有伪装成交付成功。
- `ff55ae7a-0016-45af-8fc1-e9bd71003ddd`：失败后继续要求方形版本，成功保存新方案 `e3994425-370b-49da-b3f2-0157b66e1b38`，但同一句“确认按这个修改直接生成”仍被授权语法拒绝。此项未通过。
- `7a2f3bd6-dd2d-4542-9648-7fe5ff5031af`：随后独立回复“确认生成”，原新方案成功提交，job `e3994425-370b-49da-b3f2-0157b66e1b38` 为 succeeded。刷新页面后聊天图片解码为 1024×1024，画布中有实际 image 元素，页面无 JS 错误；已人工查看截图确认显示。
- 截图：`artifacts/paid-dialogue-browser/0e1fe3a8-8d9a-4947-bcff-f6be266c5834-ordinary-context-delivered.png`。失败任务仍为失败占位，未隐瞒或改写失败历史。
- `78e4cab2-8915-46f2-9ea9-b2e038377a57`：继续同系列第二张、先准备方案，generate_image 被 intent gate 连续拦截，最终明确未保存。本项仍失败，正在查具体拒绝原因。不能声称连续修改链路已通过。

本轮模型分工：Sol high 负责后端连续性与授权边界，Terra medium 负责前端隐式绑定，Luna medium 负责只读 UI/规则扫描；主控整合、部署和真实页面验收。测试页面不注入历史模型，使用产品当前默认配置。

## 本轮最终验收

- 同系列首拒已修：真实 checkpoint 的错误为 `intent_review_unfounded_selector`，错误要求用户一定说“刚刚生成的图片”；“接着做同系列第二张”未被理解为最新成图的延续，且输出序号被混为多源。现在该结构只允许最新可信图片作为 reference，不许可覆盖/edit；否定、多张源图、其他序号仍拒绝。
- `8fb8083d-48a4-4b55-9850-8e335833ff5c` 原句重放：正确读取第一张成图，保存新方案 `bb8561e8-16e1-43ff-972a-90ecc5633796`，referenceImageCount=1，比例 1:1；无重复询问品牌。
- `9bbb1891-6f3d-4af1-9b3c-fd3ff79cdd5e` 确认后真实 job succeeded。第二张图片保留色彩与品牌，云雾移左、文字移右，原图未覆盖。刷新后两张图均解码为 1024×1024，画布两个 image 元素，页面无错误。截图 `artifacts/paid-dialogue-browser/0e1fe3a8-8d9a-4947-bcff-f6be266c5834-ordinary-context-series-delivered.png` 已人工查看。
- 最终收紧多源边界后 API PID 38268。`89d5b7d3-4b22-491f-8477-438f7e4c2820` 再次确认返回同一个 bb856 job 的已完成结果；没有新增生图任务。最终 QA 共 3 个 job：2 succeeded、1 比例不符 dead_letter。
- 主控重新运行 44 项模型路由/失败回执/复核循环测试与 97 项确认/关系测试均通过；Sol 最终 selector 相关 180 项通过与 typecheck 通过。不同测试集有重叠，不能累加为唯一测试数。

剩余未通过：同一句自然语言同时修改并要求直接生成（ff55...）仍可能要求额外确认；不把分步成功当作该项修复。第三方本轮曾忽略 16:9；没有通过裁切、改尺寸或隐藏失败伪造成功。本轮未覆盖全部渠道、长时间并发和无限多轮情况。
