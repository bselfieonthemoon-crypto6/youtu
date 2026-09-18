# 生图边界第二轮验收

继续验证原模型失败重试、供应商未知结果、首次同时确认、双用户同时生图，以及上一轮离线错误。只操作独立 QA。真实 UI / 真实供应商与受控模拟、单元测试严格分列。

## 首次同时确认：交付通过

- 首轮请求保存「松风」方案，run `9c871612-3bd4-48eb-b3df-f936035c93f8`；未提前生图。
- 两个独立浏览器约定同一提交时间，实际发送 `2026-09-11T17:28:46.399Z` / `.415Z`，相差16ms。
- runs `da21a174-fa0e-4e05-85c9-0408372f4c72`、`f26aacf9-f08c-4218-bd5d-9af0c5a922ba` 均返回同 job `7dc13d5c-7f2a-43be-8bf5-966f457aecda`，没有无反馈或创建第二个job。
- job succeeded，1632×2048；聊天及画布实图均由主控检查，只有一张松风新图。第三方账单未查询，不能用单job直接代替扣费次数证明。
- 证据：`artifacts/paid-dialogue-live/browser-turns/2026-09-11T17-28-23-024Z.json` / `...262Z.json`；`artifacts/paid-dialogue-browser/51deede3-b8b6-4a19-8a53-78ed36b4e7b3-concurrent-first-delivery-phase2.png` / `.json`。

## 离线错误：已定位并修复代码

真实浏览器受控 beforeunload 复现 `TypeError: Failed to fetch`，bundle位置 `page-47ddd027fe0b1d55.js:1:154706` 精确对应 canvas-editor.tsx 的关闭前 PUT 保存请求。同步 try/catch 未处理 fetch Promise 异步拒绝。已添加 catch；保持 best-effort 保存，不重发图片任务。

Web构建 `.next-production-boundary2` 成功，TypeScript检查通过，已切换本地3020至该构建。修复后受控浏览器复测确实捕获 PUT `/api/canvases/51deede3-b8b6-4a19-8a53-78ed36b4e7b3` 的 `net::ERR_INTERNET_DISCONNECTED`，同时 pageErrors=[]，聊天/画布原七张图片均恢复；临时QA图形在恢复网络前撤销，DB无新增图形。证据 `artifacts/paid-dialogue-browser/51deede3-b8b6-4a19-8a53-78ed36b4e7b3-unload-fix-verified-phase2.json`。**此具体离线未处理异常已修复并真实浏览器复测通过**，不等于保证断网时尚未保存的新修改不丢失。

## 双租户：确认语序缺陷已部署修复，真实交付通过

两用户首轮均已保存方案，但第二轮「确认生成北岸烘焙这张海报。」/「确认生成星野天文馆这张海报。」未命中 TS/SQL named confirmation 白名单，被视为新需求。旧方案因此不再current，重建后再次要求确认。不是持久化丢失。

原失败：A run `aa1ab68c-7003-4064-a050-1008062af0ba`，B run `780b0651-7a00-41ce-833a-c0f2d0f244a9`；0 image jobs，不计为成功。证据保留在 `E:/Loomic/artifacts/two-tenant-paid-image/0a95c9c2-d184-4dc4-8fd3-9a074dd785c6/browser-turns/`。

修复 TS `image-confirmation-authorization.ts` 与 SQL `private.loomic_named_image_confirmation_scope`，named语法同时接受「这张+品牌+海报」和「品牌+这张+海报」；仍由冻结标题匹配，不扩大generic确认。migration `20260912000001_named_image_natural_order.sql` 已实库rollback演练后正式部署并注册。公开决定函数事务检查通过：一次确认、错误品牌/过期方案/跨owner-session-canvas/问句-条件-改参数-多张均按预期。使用专用QA画布，测试记录全部回滚。API PID640已加载修复。

修复后全新session以相同自然品牌确认原句，一次确认即提交：

| 用户 | 真实请求及结果 | 所属 |
| --- | --- | --- |
| A 北岸烘焙 | 首轮 `7e8b525f-4d86-4c6a-a1db-f473e8432748`；确认 `2ecdcc9a-4999-4c9f-bf55-443fc15695cf`；job `816bddbe-fea9-46dc-bae7-ad01c0334861` succeeded 1632×2048 | owner `541006fa-d2a1-4305-be55-b6263c27a1e3`，workspace `25eb32ef-ff55-4de7-8c10-9390a51ece06` |
| B 星野天文馆 | 首轮 `b4215fc1-3478-49ad-9aaa-bcaa85ade2fd`；确认 `decdf9bb-dc0a-4273-8bc6-9bd2357b491a`；job `9ea16484-9f9b-4c1d-95f9-7156e758535f` succeeded 2048×2048 | owner `13e7bf53-477c-4ce3-9b5f-75d98e9bda35`，workspace `dc16a64a-a887-4759-a43d-d408bbe34aad` |

主控独立登录A/B正式页面并查看截图：各自只显示自己的品牌、图片与对话，聊天图片解码成功、画布实图可见、pageErrors=[]。截图在 `artifacts/paid-dialogue-browser/a5d84d81-9996-492c-ab50-ebd9d8160244-tenant-A-phase2.png` 和 `db2a3069-7818-4912-8116-119a91a96a88-tenant-B-phase2.png`。两侧job/asset数据库归属正确。本阶段共真实新增3张（松风、北岸烘焙、星野天文馆），无模拟成功。

双用户初版报告false源于辅助解码脚本cwd错误（找不到Playwright依赖），非图片失败；已使用现有图片只读复核，不重发付费请求。两用户使用各自workspace配置但相同测试供应商凭证引用，因此不能声称不同供应商账单隔离已验证。

只读最终补验13项全部通过，`E:/Loomic/artifacts/two-tenant-paid-image/93aee4e1-c27a-4679-ac3d-590b3ac7da14/read-only-completion.json`：两边各自job/asset归属正确且实图可解码；A→B、B→A的job/canvas/asset-content均404，对方session messages返回空集。原始报告false保留作为脚本故障记录，以此补验和主控正式页面截图为交付验收证据。全量server/web typecheck均通过，结束核对active agent_runs=0。

## 尚未完成真实供应商故障注入

- 没有安全独立 QA 的 gpt-image-2 明确失败且未被后续需求覆盖的候选。唯一相符记录属于用户受保护会话，未操作。
- 当前 gpt-image-2 调用是同步 Images API，没有供应商taskId/status查询。响应丢失后无法凭空找回，应标记unknown而不是自动重发。
- 本地故障代理被正常SSRF防护阻止；未新增公网隧道，避免把实际密钥和图片交给额外第三方。未修改生产安全策略，没有创建代理配置或产生此项供应商请求。
- 相关5文件135项 mock/unit/executor 验证通过（明确拒绝可显式重试、unknown阻止自动重呼），**不算真实UI故障恢复验收**。

## 调用参数与分工

- Luna medium：真实失败候选核查、同步供应商接口边界审计。
- Terra medium：独立双租户真实对话与图片交付测试。
- Sol high：故障注入可行性审查、确认语序的TS/SQL窄修。
- 主控：离线错误定位/前端修复部署、首次并发确认、最终证据核对。
