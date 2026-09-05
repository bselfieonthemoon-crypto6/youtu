# Stage 8 浏览器发布验收覆盖矩阵

机器可读版本见 `docs/qa/stage8-browser-coverage.json`。

## 结论

PRD 第 26 节的 20 个真实用户流程均已有浏览器证据。Stage 3/5/6/7 已经覆盖且成本较高的登录、持久化、模板、真实字体、Agent 六工具、真实生图幂等和后台大尺寸导出没有在 Stage 8 重复执行。Stage 8 新增的非付费 release spec 补齐了文字样式、图层与对齐、工作区资源、本地三格式导出、失败状态，以及所有额外恢复/压力场景。

## 新增 Stage 8 自动化

`apps/web/e2e/stage8-browser-release.spec.ts` 使用真实本地 Supabase、Web 和 API，不拦截生产接口，也不启动或调用付费 Provider。它覆盖：

- 1,000 个普通图片节点加 100 个设计预览节点，只挂载视口内预览；
- 通过 Playwright 真实鼠标滚轮改变 Excalidraw viewport，先断言设计预览坐标确实移动，再用 rAF 帧数与 Long Task 占用共同评估交互性能（FPS 不低于 30，Long Task 时间占比低于 25%）；
- 打开设计时始终只有一个 Fabric 容器，连续 20 次打开/销毁后无残留 Canvas；
- 非法尺寸、离线保存失败后保留 dirty 并原请求重试；刷新并重开设计后继续核验 `#223344` 已权威持久化；
- 双窗口真实 revision 冲突和“放弃本地并重载”恢复；
- 画布节点 Delete 产生并持久化 Excalidraw tombstone；
- 工作区资源经后台 API 真实创建、搜索和插入，保存后从严格设计 DTO 核验 `resourceId`、`assetObjectId`；文字、对齐与图层同样通过服务端对象字段验收。字体 404、设计预览资源 404、生成失败占位均有明确 UI；
- PNG、JPEG、透明 PNG 的真实浏览器下载；逐个读取下载字节，校验非零、PNG/JPEG magic、精确 `640×360` 尺寸，并对透明 PNG 解码采样确认存在 alpha `<255`；
- 浏览器 JS Heap 与监听 Web 端口的 Next dev 进程 Working Set 分开采样。先暖编译再取基线，避免把首次路由编译误记为画布增长；结果随 Playwright 报告附加为 `stage8-memory-evidence.json`。

## 内存门槛

- 压力数据相对浏览器基线增长小于 512 MiB；
- 20 次销毁并主动 GC 后，相对压力稳定点增长小于 128 MiB；
- Windows 上 Next dev Working Set 小于 4 GiB，压力加载相对暖基线增长小于 768 MiB；
- 20 次销毁期间 Next dev 继续增长小于 256 MiB。

Next dev 指标与浏览器指标分别记录，避免把开发编译缓存或旧开发进程的 5.6 GiB 占用归因到浏览器画布。CI/非 Windows 环境拿不到监听进程时，Next 指标明确记为 `null`；浏览器 CDP 指标属于发布门禁强制证据，任一指标缺失会直接失败，不允许用 `0` 代替后静默通过。

测试数据清理由真实 API/本地 Supabase 管理客户端完成，每一步都断言错误结果；项目、资源、字体、存储对象或账号任一清理失败都会使该用例失败。

## 运行

本地隔离栈应把 `LOOMIC_E2E_BASE_URL`、`LOOMIC_E2E_SERVER_URL`、
`NEXT_PUBLIC_SERVER_BASE_URL` 与 `LOOMIC_WEB_ORIGIN` 配成同一组 Web/API
端口，并从当前 `supabase status -o env` 注入
`LOOMIC_E2E_SUPABASE_URL` 和 `LOOMIC_E2E_SUPABASE_ADMIN_KEY`（优先使用
`status` 输出的新式 `SECRET_KEY`，同时兼容 legacy service-role JWT）。
专用变量可避免仓库 `.env.local` 中的远端凭据覆盖一次性本地验收环境。

```powershell
pnpm --filter @loomic/web test:e2e:stage8
pnpm --filter @loomic/web test
pnpm --filter @loomic/web typecheck
pnpm exec biome check apps/web/e2e/stage8-browser-release.spec.ts apps/web/src/components/design/design-editor-overlay.tsx apps/web/test/design-editor-overlay.test.tsx docs/qa/stage8-browser-coverage.json docs/qa/stage8-browser-coverage.md
```
