# 设计画板架构说明

## 系统边界

设计画板是 Excalidraw 无限画布中的一种轻量节点，但设计内容由独立的结构化文档保存。无限画布只保存 `designId`、预览和节点位置；文字、形状、图片引用、逻辑尺寸、版本与模板数据不写入 Excalidraw `customData`。

```text
Canvas Design Node -> Design API -> design_documents / revisions / objects
                         |                    |
                         |                    +-> asset references
                         +-> outbox/jobs -> Worker -> preview/export/finalizer
Agent design tools ------^                         -> private workspace-assets
```

## 主要模块

- Web：`canvas-editor.tsx` 负责无限画布节点；`components/design/` 负责单实例 Fabric 编辑器；`design-command-history.ts` 将一次用户手势作为一次原子 revision 提交。
- Server：`http/designs.ts` 提供创建、读取、CAS mutation、复制、软删除和恢复；`design-resources.ts`、`design-templates.ts` 与 `design-catalog-*` 提供资源和模板；`design-async.ts` 提供预览与导出任务。
- Worker：执行预览、后台导出、资源导入、图片任务 finalization 与安全回收。副作用使用 request/idempotency key，允许崩溃后重放但不能重复插入或扣费。
- Database：Supabase Postgres 保存设计文档、revision、对象、资源引用、模板变量、任务和 outbox。RLS 与服务端工作区校验共同隔离租户；更新使用 expected revision，冲突返回 409。
- Storage：用户内容只进入私有 `workspace-assets`，读取时签发短效 URL。场景长期保存稳定的资产 ID，不保存短效 URL。

## 一致性与生命周期

1. 创建设计与绑定无限画布节点使用 request ID；未完成绑定由 reconciler 恢复或标记 orphaned。
2. 人工编辑与 Agent 修改进入相同 mutation、revision、引用同步和审计链路。
3. 自动保存失败时客户端保留 dirty 命令；409 时暂停覆盖，由用户重试或放弃本地并加载权威版本。
4. 删除节点写 tombstone 并软删除设计；GC 只有在保留期结束且没有活跃引用时才删除私有对象。
5. 预览和导出由后台任务生成；finalizer 通过唯一键保证重复消费安全。

## 性能设计

- 非激活设计节点不挂载 Fabric，只渲染轻量预览；只加载视口内资源。
- 同一时刻仅有一个设计编辑器实例；关闭时释放 Canvas、监听器和图片引用。
- 连续拖动在客户端合并，但不同用户手势按 revision 顺序提交。
- 浏览器本地导出上限为 32,000,000 像素；更大任务转后台。后台上限为单边 32,768、总像素 64,000,000、估算内存 768,000,000 字节。

## 权限原则

- 工作区成员只能读取获授权范围；设计写入要求 owner/admin。
- 平台资源只有已发布且具备来源/授权记录时可供普通用户和 Agent 使用。
- Agent 继承发起用户权限，service role 仅用于受控 Worker/GC，不代表内容所有者。
- URL/压缩包导入执行 SSRF、重定向、内容类型、数量、展开大小与路径穿越校验。

契约和完整数据表以 `packages/shared/src/design.ts`、`apps/server/src/http/` 与 `supabase/migrations/20260903*` 至 `20260907*` 为准。
