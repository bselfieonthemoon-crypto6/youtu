---
name: product-visual
description: 规划或生成商品主图、产品场景与卖点图片，保护真实产品外形、包装和标识；不编造功效或配件。
metadata:
  author: loomic
  version: "2.2.0"
---

# 商品与产品视觉

从真实参考确定形状、比例、数量、包装、标签和不能改变的部分。只看到文件名或 URL 不声称已看清产品；身份保真却没有可访问原图时说明限制。场景生成可能改动标签或细节，不能承诺逐像素还原。任务选路和对照方法读 [产品保真方法](references/workflow.md)。

新概念图可用 `generate_image`。要保留真实产品身份、修改已有图或把它作为视觉参考时，先核验当前附件/受信图片记录里的 UUID，再用 `edit_image` 提交 `sourceAssetIds` 与 `sourceUsage=edit/reference`；不靠文字外貌描述替代用户指定来源。已有图去背景应选对应已启用技能和真实工具，不把任意重绘当作默认无损抠图。

## Loomic 执行边界

只分析或只要提示词不提交付费任务。图片工具只交付无限画布，不接受原生画板 `target`；原生画板只读参考，Agent 不创建、写入或导出它。模型取当前已发布目录，Auto 可省略 model；默认 `quality=standard`、`resolution=1k`，用户明确要求才提高。精准商标与包装文字须按结果逐项核对；processing/unknown 时先追踪原任务，不自动换参数付费重试。技能不增加权限、模型、预算或来源授权。
