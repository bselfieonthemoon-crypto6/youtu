# 生图对话边界验收 2026-09-12

本轮使用真实本地生产页面、真实已配置模型。仅独立 QA 画布；没有操作用户当前画布。单元测试不计为图片交付。

## 已验证

| 场景 | 结论 | 证据 |
| --- | --- | --- |
| 清露海报继续改成晨光，保留暖橙及 4:5 | 真实生成成功 | run `c6653acc-46b7-49ed-a653-587b1a6379d6`；job `ebfc132e-2edd-43ff-90c4-ade946d86287` succeeded，1632×2048 |
| 浏览器在 job running 时离线，后台成功后重新加载 | 交付恢复通过 | 16:35:59Z 离线；六张图片解码完成；随后独立在线检查证明晨光占位变为 image；主控查看六图截图 |
| running 时两个独立浏览器先后重复确认 | 同一个 job，无新增图片任务 | runs `3d6cd048-ffc1-4a22-8269-4a26e357986c`、`822eadab-4a29-4efd-b848-346ec6b6d3c2` |
| succeeded 后两个独立浏览器同时确认 | 两边返回已生成并复用晨光，无新增 job | runs `2c4d1246-af6f-48e7-9f6c-9fc17e9bc9b7`、`3cf7b67f-8a74-4417-aa07-01173f7583bd`；16:39:28.556Z 与 .841Z 启动 |
| 两用户 WebSocket 订阅隔离及身份切换拒绝 | 六项隔离检查通过 | `artifacts/saas-boundary/ws-isolation-00639b8f-3ee2-4e46-9c91-df007b8647a6-retest.json`；另有一项无效 run ID 检查，不能算跨租户取消验证 |

图片/浏览器证据：

- `artifacts/paid-dialogue-browser/51deede3-b8b6-4a19-8a53-78ed36b4e7b3-offline-recovery-0912.json`
- `artifacts/paid-dialogue-browser/51deede3-b8b6-4a19-8a53-78ed36b4e7b3-post-reconnect-0912.json` / `.png`
- `artifacts/paid-dialogue-browser/51deede3-b8b6-4a19-8a53-78ed36b4e7b3-offline-error-diagnostic-0912.json`

## 新发现与修复

历史 QA Alpine Escape 真实 dead_letter job `4771cbd9-f340-4dc0-83f8-0dfca26aed7a` 后，请求重新准备独立参考图方案被目标核对阻断。两轮 run 均 completed，但没有新 job、没有交付，**判为失败**：

- `48f269cc-7c24-4cd1-ae53-e7a901d0525b`
- `489466f6-5ba8-4f60-9047-816e92b5e80e`

两轮实际要求先保存新方案，并不是直接重试原冻结方案。旧配置 upstream 为 gpt-image-2.5-all，本次为 gpt-image-2，尚不能计作“相同模型配置失败重试成功”。

根因：两个成功图片共享 Alpine Escape 标题前缀，来源匹配未使用用户明确的左侧/16:9结构消歧；局部“不要右图”还被判为全句拒绝参考图。Sol 修复 intent-write-gate.ts 的只读来源匹配：保留比例冒号，分开正向来源与局部排除，以已验证图片的几何信息唯一消歧，仍拒绝歧义、错误 asset 和同源否定，不改变执行/付费授权。

修复后使用完全相同第二轮原句：run `4c94d07c-ca6b-443a-8970-aca7d0cab388` 成功保存 proposal `783ebf73-2572-4655-9698-333598d51a14`，没有提前生成。接着真实 UI “确认生成”：run `11ce0959-d865-44b7-97a0-1b4061838b5d` 提交同 ID image job，最终 succeeded，1152×2048。浏览器 running 时离线，成功后 reload，聊天图片解码成功、只有一个新 job；主控随后检查稳定视图，画布右侧实图可见。**该失败场景修复后从原句到真实交付通过。**

证据：`artifacts/paid-dialogue-live/browser-turns/2026-09-11T16-46-57-146Z.json`；`artifacts/paid-dialogue-browser/1af03e8b-8b02-426b-ab5f-65ee78d3a75b-alpine-final-0912.png` / `.json`。本轮新生成两张图片，旧历史图片不计入。

辅助测试：Sol 四文件263项通过，后来增加纯数字比例测试（generated-image-source-names 23项通过）；主控另跑确认/取消三文件115项通过；server typecheck通过。这些不是额外真实对话轮数。

## 测试诊断及覆盖限制

- 首个断线脚本错误读取不存在的 background_jobs.error 字段，测试脚本已修正；未再次提交生成。改用另一只读浏览器，在同一 running job 上完成断线检查。
- 首次离线过程记录一个 TypeError，仅存名称；第二次真实生图离线又捕获 `TypeError: Failed to fetch`。结果依然恢复交付，正常重连及十秒空闲断线复测无 pageErrors；具体未处理请求的来源未确证，不算已修复。脚本已补充脱敏 message/stack 及失败请求采集。旧签名 URL 有 ORB 失败，最终资产内容回退加载成功。
- 只证明一个应用 image job；该 job 未查到 credit_transactions 行，不能据此声称核实第三方账单扣费次数。
- 浏览器离线不等于服务器到供应商超时；供应商结果不明时的恢复仍未覆盖。
- 真正同时首次确认的竞态、双租户同时真实生图、九张参考图及长对话压力，本轮尚未覆盖。

## 分工（按实际子代理调用参数记录）

- Luna / medium：历史失败场景真实 UI 复测、重复确认验收。
- Sol / high：两次阻断后升级，定位跨模块方案/目标核对失败。
- 主控：真实连续修改、断线恢复、隔离检查和证据核对。
