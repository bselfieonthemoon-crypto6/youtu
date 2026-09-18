# 本地轻量副本：页面联调

状态：本地注册、认证、资源读取、画板编辑、无限画布和画板内真实对话生图、PNG 导出验证通过；后续非视频回归汇总见 `local-nonvideo-regression-20260907.md`，不是全功能生产迁移验收。

## 独立入口

- 前端：http://localhost:3020
- API：http://127.0.0.1:3002
- 本地 Supabase 网关：http://127.0.0.1:54421
- 数据库：loomic_replica_light_20260907
- 现有 3010 / 3001 和云端配置未切换。
- 私有配置、数据、复制报告均在 Git 忽略的 artifacts/local-replica-20260907。

## 已验证

- 4153 个文件通过本地 Storage API 安装，失败 0。
- 原库对象所有权和 ACL 在隔离库恢复，认证采用本地 GoTrue getUser 验证。
- inline-artboard-live.spec.ts：认证、创建隔离测试项目、保存、撤销/重做、素材拖入、刷新恢复通过。
- local-replica-read.spec.ts：原画布预览和聊天图片可显示，观察期间云端 Supabase 请求 0。
- 测试项目 c8711286-8673-4ca3-adf8-fb9d522678af 只存在于副本。
- 本地注册及工作区初始化通过，网关修复了重复 CORS 响应头。
- 无限画布真实对话生图成功：任务 bf6832b1-23ba-4016-b60c-a3808b508627。
- 画板内真实对话生图成功：任务 baebc145-a736-4c4b-a789-745f379b0aa4；目标 3534e747-72a5-4ff4-bfdf-810a3ad6814c，独立 API 检查确认 scene 中存在 image 对象。
- 带生成图片的画板导出成功：任务 2c577776-04cf-4809-b376-e115ca86b69f；下载 PNG 349610 字节，640×480。
- 浏览器脚本的点击位置、输入焦点和任务轮询范围已修正；后续注册与完整对话生图用例从头重跑 2 项通过，另画板编辑与资源读取 2 项通过。不是全部页面 E2E 覆盖。
- PNG 导出和下载通过：任务 8ef275b7-979f-41ab-bcbd-6a9c91efc0bc，文件头及 640×480 尺寸验证通过（空白测试画板）。
- 自动化测试：Server 532、Web 359、Shared 109，共 1000 项通过；Web/Server 类型检查通过。
- 129 条 HTTP 路由完成未登录权限/输入探测及已登录 GET 探测，无 5xx；不等于全部写接口业务成功路径已覆盖。

## 限制

- 已启动副本 Worker；启用前隔离了旧未完成任务，避免重放云端遗留生成。外部生图仍使用真实供应商 API。
- 旧 Agent 内部快照、旧队列消息未复制；历史后台任务记录保留，不能直接视作可恢复任务。
- 本地历史图片链接已替换 168 个；签名有效期 7 天。78 次旧引用未找到可签名对象，未伪造或删除历史内容，其他历史页面仍需单独核查。
- 副本修改不回写云端。新注册已开放，认证和权限校验保留。
- 尚未验证所有页面、所有历史资源、付费生成和第三方接口。

## 重启（仓库根目录）

先执行 `node scripts/start-local-replica-services.mjs`，然后在独立终端执行：

1. `node scripts/local-replica-gateway.mjs`
2. 在 apps/server：`node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx src/server.ts`
3. 在 apps/web：`node --env-file=../../artifacts/local-replica-20260907/app.env node_modules/next/dist/bin/next dev -p 3020`
4. 在 apps/server：`node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx src/worker.ts`

不要使用常规 `pnpm dev` 启动副本：它会使用原配置并启动 Worker。
