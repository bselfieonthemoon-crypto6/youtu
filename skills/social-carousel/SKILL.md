---
name: social-carousel
description: 规划或生成按阅读顺序排列的社交轮播图片，统一视觉身份并逐页核对文案；普通单张海报不扩成系列。
metadata:
  author: loomic
  version: "2.2.0"
---

# 社交轮播图

按用户指定平台、顺序、张数与事实组织阅读：封面给明确收益，内容卡各有任务，结尾只在需要时给真实入口。已有张数优先，不强制固定页数或三套方案。用故事推进、结论加证据或视觉先行选择节奏；不要为了简洁删掉关键事实。分页细则读 [轮播方法](references/workflow.md)。

当前 Agent 可交付的是无限画布上的位图，不是多页可编辑原生画板。准确标题、序号、数字与 CTA 在每页 prompt 中逐字保留，再据实际图片核对；不要宣称文字仍在原生 textbox 层。用户只改第三页时，先找到第三页真实来源图，用 `edit_image` 的 UUID 来源修改；不要重新生成其余页或把整批计划称作成品。

## Loomic 执行边界

只策划时不提交付费任务。新页用 `generate_image`，有当前核验的参考/编辑源时用 `edit_image` 的 `sourceAssetIds`、`sourceUsage=reference/edit`。两者不传原生画板 `target`；用户须自行将图片加入原生画板，Agent 不创建、写入、安排或导出画板。多页按真实授权和预算逐项提交、记录状态；默认 `quality=standard`、`resolution=1k`，模型取本轮工作区目录。processing/unknown 先查原任务，不整批重跑；没有真实结果不报完成。
