# 跨轮上传参考图修复

## 问题与修复

用户会话 `473c80de-4b2b-46c5-b40d-78c72d3392f7` 在 15:40:15 上传参考图，15:40:49 回复“就按复刻，提交”，Agent 却要求重传。原消息 `b25467ac-5c85-4f3c-ba5d-fba20ca43d0a` 的 image/upload 块及资产 `5d15c558-ad08-4328-9ff9-d2526248d671` 一直存在。

原因：Mastra 历史上下文只读纯文本；来源候选只包含本轮附件、画布图与生成结果，历史上传没有进入候选。

现在按已验证会话读取历史用户上传元数据，保留独立 assetId、消息 ID、时间和原话摘录。本轮附件优先，历史上传作为独立来源，模型不会把本轮 attachments 为空当作没有原图。最近最多 8 个历史上传进入上下文，更早已知 ID 可按需查询；查询先筛选带上传的消息，纯文字轮次不会直接挤掉参考记录。

使用前重新核对同会话上传消息、工作区资产与删除状态，通过 assetId 从存储读取，不使用旧签名链接。历史上传存在不等于新任务的生成授权，且不自动变成本轮附件。删除、缺失或暂时读取失败会给出不同原因。

## 验收

- 用户原参考图：使用真实用户认证恢复 28648 字节 WebP，过期 URL 未参与下载。
- 第一轮真实浏览器上传植物参考图，只描述，不生成。run `2ef75534-c07f-49bb-aac8-cc423d499aa5`。
- 第二轮不附图，要求按上轮原图复刻横版。run `3e63c9a3-4b6f-401a-ab70-f8258742b854`。
- 唯一生成任务 `34ab9f52-1263-426c-9aa5-8b27b53652f4` 成功，使用第一轮资产 `7003c85f-08c4-44d8-89e9-d303eec5a77c`；provider 输入与原文件 SHA256 一致，结果已入画布。
- 66 项定向测试通过，包括历史上传筛选、当前附件优先、跨范围/删除阻断、来源解析、图像工具和 Mastra 回归。

证据位于 `artifacts/historical-reference-20260915/`，两个浏览器回合、`original-user-reference.json`、`result.json`。浏览器事件可能重复回放，数据库验证仅一个生成任务。

复现：

```powershell
node --env-file=artifacts/local-replica-20260907/app.env --import ./apps/server/node_modules/tsx/dist/loader.mjs scripts/verify-user-historical-reference.mts
node --env-file=artifacts/local-replica-20260907/app.env scripts/verify-historical-reference-result.mjs
```

分工：Sol（high）实现与局部测试；主控实际对话核验、代码复核、数据库/浏览器及输入字节验收。已加载到本地 API。
