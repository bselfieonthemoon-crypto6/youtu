# 设计画板运维手册

## 启动与依赖

1. 从 `.env.example` 配置 Supabase、Storage、服务端地址和模型供应商，不要把密钥提交到仓库。
2. 执行 `pnpm install`、`pnpm exec supabase db reset`（新环境）和 `pnpm dev`。
3. 生产环境必须同时运行 Web、API 和 Worker；只运行 Web/API 会导致预览、导入、导出与 finalizer 停留在排队状态。
4. 使用 FeyNoBG 时先执行 `pnpm model:feynobg:download`，生产容器设置 `LOOMIC_FEYNOBG_MODEL_DIR`；Windows CPU 默认限制线程以避免模型峰值内存放大。

可选目录导入需要同时配置服务端 `LOOMIC_DESIGN_IMPORT_ROOT` 和 Web 的 `NEXT_PUBLIC_LOOMIC_DESIGN_IMPORT_DIRECTORY_ENABLED=true`。目录必须是专用只读导入目录，不能指向仓库、用户主目录或系统根目录。

## 发布前门禁

```powershell
pnpm typecheck
pnpm test
pnpm exec supabase migration list --local
pnpm exec supabase db lint --local --level warning
pnpm --filter @loomic/web test:e2e:stage8
pnpm audit --prod --audit-level high
```

Stage 6 的真实 Provider 用例会产生第三方费用，只在凭据明确可用且需要发布复验时运行。普通回归不得 mock 生产 API 后宣称真实通过。

## 监控重点

- `background_jobs`：按 `queued/running/failed/needs_attention`、job type、重试次数和租约年龄告警。
- outbox/finalizer：关注过期 claim、重复投递、长期未 finalization；幂等重放不应新增第二个对象。
- 导入：关注 item 数、压缩前后字节、失败原因和授权审核状态。
- 导出：关注像素预算、估算内存、Worker RSS、超时和签名下载失败。
- Storage/GC：关注孤儿资产、删除保留期、claim starvation 和私有桶签名错误。
- Web：关注设计保存 409、离线 dirty、预览 404、字体加载失败和单页内存趋势。

日志不得写 API Key、用户原始私有素材、完整签名 URL 或 service-role token。

## 故障处理

| 现象 | 检查 | 处理 |
| --- | --- | --- |
| 保存失败但页面仍有修改 | API/网络、409 和当前 revision | 保留页面；网络恢复后点重试。409 先比较或选择放弃本地并重载 |
| 预览/导出一直排队 | Worker、job lease、outbox | 恢复 Worker；由过期租约恢复器重领，不直接改成功状态 |
| 图片或字体刷新后缺失 | 资产引用、bucket、签名和授权 | 修复引用/权限后重新签名；不要把短效 URL 回写场景 |
| 大图导出被拒绝 | 逻辑尺寸、总像素、内存估算 | 降低尺寸或拆分；不要提高到超过 64MP 后直接在浏览器执行 |
| FeyNoBG 退出或内存不足 | 模型目录、Python、线程数和主机内存 | 降低 `LOOMIC_FEYNOBG_CPU_THREADS`，确保部署主机留足模型峰值内存 |
| 导入失败 | report、MIME、许可、路径与预算 | 修正源包后使用 retry；安全校验失败不自动重试 |

## 备份与恢复

- 数据库与 `workspace-assets` 必须采用同一恢复点策略；只恢复数据库会留下缺失对象，只恢复 Storage 会产生孤儿文件。
- 灾难恢复后先校验 design/asset references，再开放 Worker，最后开放写流量。
- 不手工物理删除设计或资产；使用软删除和 GC 流程。回滚应用版本时不得回滚已经应用且有数据的新迁移。
