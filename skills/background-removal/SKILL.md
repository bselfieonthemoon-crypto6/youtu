---
name: background-removal
description: 将已有图片编辑为透明背景 PNG，或生成透明素材；区分图片透明处理与画板透明导出。
metadata:
  author: loomic
  version: "2.2.0"
---

# 背景去除与透明素材

先区分三种请求：已有图片主体分离、新生成素材要透明、画板导出透明。保留当前目标和原始资产，明确要保留的主体；头发、玻璃、白色产品和孔洞需要实际预览才能判定效果。

已有图片使用 edit_image：operation=generate、sourceUsage=edit、sourceAssetIds=[原图]、background=transparent、outputFormat=png。它直接提交当前已解析的原图编辑任务，保留原始资产；不能把方案或请求已提交说成透明素材已生成。新生成素材则使用 generate_image，并同样明确 background=transparent 与 outputFormat=png。缺少适用工具、已启用的图片模型或源图时如实说明，不虚构旧确认步骤，不下载模型。

透明参数请求的是生成结果的透明背景，不能借助提示词只选择某个主体或指定交互蒙版；outputFormat=png 本身也不替代 background=transparent。图片编辑可能改变主体文字、纹理与边缘，不是逐像素分割。用户明确要求产品标签或原图像素完全不变时，先说明此能力限制，不把该流程描述为无损方案。画板透明导出只影响导出底色，不去掉照片像素内背景。按任务需要读 [透明处理边界](references/workflow.md)。

## Loomic 范围

只建议/分析时不调用写入或生成。后续若用户要求落地，使用当前真实目标、工具与模型；update_design_brief 可用时合并仍有效的保留项和最新纠正。已禁用技能、用户权限、目标锁和付费确认不能由本说明绕过。未收到实际图像不声称视觉验收；不存在的工具不能靠提示词补齐。
