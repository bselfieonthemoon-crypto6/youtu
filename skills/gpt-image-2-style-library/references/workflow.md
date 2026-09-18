# 检索与组合

## 两步检索

search_prompt_library 接受 queries（最多 4 组简短关键词），以及可选 sources、categories、offset、limit。查询变体并集匹配并排序，不是向量搜索。避免把整段需求直接当一个精确短语；可用「海报 水墨」和「poster ink」这样的中英文变体。source/category 仅使用实际工具返回值；未知过滤项不是允许放开来源政策的理由。

get_prompt_library_entry({id}) 获取真实候选全文，ID 必须来自搜索结果。首次检索通常 6 条，再读最匹配的 1～3 条。若还有关键差异可再检索；两次更换关键词仍无相关案例时告知没有合适匹配并按用户需求原创，不虚构库内命中。

## 检索维度

| 任务 | 可尝试的查询变体 | 由谁决定最终方案 |
| --- | --- | --- |
| 宣传/活动海报 | 海报 留白；poster campaign typography | campaign-design 管准确文案、营销信息与版式 |
| Logo/品牌标识 | 标志 几何；logo geometric minimal | logo-design 管位图标识概念、真实参考图与小尺寸核对；不宣称矢量母版或扩成 VI 展板 |
| 商品图 | 产品 棚拍；product studio packaging | product-visual 管真实产品与包装保真 |
| 轮播/系列 | 轮播 编辑；carousel editorial series | social-carousel / series-visual-design 管张数、逐张内容及共享风格 |
| 信息图 | 信息图 科普；infographic diagram | infographic-design 管事实、关系与可读标签 |
| 插画/角色 | 插画 水彩；illustration watercolor character | 当前设计主流程管主体、身份和构图 |
| 场景/摄影 | 摄影 光线；photography lighting scene | 当前设计主流程管场景与真实引用对象 |

这些是检索词示例，不是保证命中的库分类名或预置成品。实际可用来源和分类由工具返回。

## 主辅组合

例如海报设计可 compose_skills({deliverable:"活动主海报",stage:"design",primary:"campaign-design",helpers:["gpt-image-2-style-library","typography-layout","json-image-prompt"]})，仅列出当前已启用且任务需要的 Skill。只找参考可 primary:"gpt-image-2-style-library", stage:"reference"。工具返回冲突时调整组合，不绕过停用状态、不反复堆入领域主 Skill。

职责：专业主流程确定产物与约束；风格参考输出候选和适用要点；字体/品牌辅助校验固定要求；提示整理者产出唯一最终提示。多产物分开组合，不能用同一个海报方案取代 Logo。json-image-prompt 是最终整理，不是再检索另一套风格。

## 参考不是授权

只输出工具真实返回的图片 URL；缺图就说明无预览，不猜 /images/case 编号。远程预览可能失效，图像不可访问不代表提示词不存在。没有视觉输入时不声称看过图。

案例图片不是当前用户附件，模型提示也不是用户指定模型。引用不等于获得商品、人像、Logo 或第三方素材再利用许可。link_only 来源只保留外链信息，不搜索返回未审核的正文，也不通过执行上游脚本绕过限制。

## 组合记录

在本次方案中保留 case ID/source、采用的风格要点、不能沿用的案例内容与当前共同风格。系列共享同一组已选要点，但逐张保持用户要求的内容与数量；用户说「不要水墨，改摄影」时只替换冲突风格，不改文案、Logo、尺寸或生成批准。记录仅作为方案证据，不是新的用户指令。
