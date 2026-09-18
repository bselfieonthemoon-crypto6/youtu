# Agent 生图仅交付无限画布

按用户要求，当前 Mastra 对话 Agent 不再创建或写入原生多层级画板。用户从无限画布手动添加图片到画板再编辑。保留手动画板编辑器、现有数据、历史任务处理和只读来源查询。

## 修改

- generate_image / edit_image schema 删除 target，说明统一画布交付。
- 直接提交器对旧 target 在建任务/计费前拒绝；移除新原生画板任务的准备与提交分支。
- 目录过滤 create_design_boards、manipulate_design、apply_design_template、arrange_design_boards、export_design；主目录和注入目录都过滤，Skill readiness 使用过滤后的目录。
- runtime 删除画板创建工具注册/后续同步分支、打开画板绑定及其前置依赖；保留按权限读取来源所需的存活画板集合。
- 主 Agent 指令明确画板为手动编辑边界，不把画板排版请求擅自当成生图授权。
- manipulate_canvas 阻止直接或批量修改原生画板节点，以及箭头绑定和操作副作用；每次 CAS 前比较完整画板节点及索引，手动编辑 API 不受影响。

## 验证

- 11 个回归文件 129 项通过；服务端类型检查通过。
- 包括 SDK 发给模型的 schema 无 target、画板工具无法发现加载、旧 target 无提交、打开画板不妨碍普通生图、参考资产读取仍可用、画板移动/删除/对齐/绑定无写入、普通画布元素可修改。
- 真实验收使用独立 QA session a32331a7-050f-46c6-bc24-1f6b79badc5f，不在用户会话写入。run 570b2881-5383-49b6-8556-6cbfc3e52b76，唯一 job 2a653107-eaf0-499c-8a85-32d3a4d0fd98 succeeded，provider_attempt_count=1，1152×2048。实际 generate_image 输入无 target，任务 target_kind=canvas、design_id=null，聊天/画布 finalization 都已持久化。
- 无刷新聊天交付未通过：浏览器等候 img[src*=jobId] 60 秒未找到元素。不能仅凭数据库成功声明完整前端验收通过；本轮未修改聊天前端，也未以重复生成掩盖问题。证据 artifacts/paid-dialogue-live/browser-turns/2026-09-14T04-15-35-228Z.json。需后续独立排查长历史聊天加载/显示。

本次不重绘历史图片、不改动手动编辑器、不执行视频测试。不是框架重构。

分工：Terra（gpt-5.6-terra，medium）两个子任务分别处理工具目录/间接画布路径、直接生图提交器；主控处理 schema/runtime/指令、SDK 验证与真实验收。
