# 云端 Supabase 启动修复记录

2026-09-06 保留现有云端连接，补齐 20260902000001 至 20260907000004 共 17 个仓库迁移。
共 54 个版本，缺失项为零。每个迁移与版本记录在同一事务提交，随后刷新 PostgREST schema cache。

迁移前在云端隔离 schema `loomic_backup_20260906` 保存 71 张表的数据副本及 public/private 函数定义。
已撤销 PUBLIC、anon、authenticated 对副本 schema 和表的访问。
这是同实例数据副本，不是完整异地备份，也不包含 Storage 二进制文件。
本机 pg_dump/数据快照下载未完成，不应把 artifacts 中不完整文件作为恢复依据。
Git 回退不撤销数据库迁移；不要在共享数据库直接运行 down/reset。

迁移完成且 Worker 重启之前的核对：
- 项目 22、画布 22、供应商配置 1、Storage 对象 153，数量与迁移前一致。
- 画布 content 聚合 MD5 前后均为 644136298915324f32ab1615712b3e82。

运行验证：
- pnpm dev 启动 web、API 和 Worker。
- /admin、/canvas 返回 200；/api/health 返回 ok。
- 一次性云端账号真实登录后 /api/projects 返回 200，账号已删除。
- 私有 Storage 签名下载返回 200。
- 已启用模型：text 2、image 3、video 1；未发起付费生成。
- 重启后观察中未再出现缺少 design 字段、队列或 RPC 的错误。

注意：Worker 已将部分历史完成任务补写到画布，迁移后运行期的 content 可能与上述校验值不同。
浏览器旧会话出现 invalid_token，需用户刷新会话或重新登录。新账号登录验证正常。
