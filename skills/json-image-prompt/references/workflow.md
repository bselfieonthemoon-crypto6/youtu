# 图像需求结构化：按需细则

## 与参考库协作

参考 Skill 只提供案例与可借鉴要点；本 Skill 将当前用户原话、有效纠正和兼容的参考维度整理成一份提示。不拼接多个模板，不复制案例品牌或文案。案例 ID/链接不是输入图身份；需要真实图像参考时从当前附件或受信图片记录核验 assetId。

## 可执行参数

`generate_image` 接收 title、字符串 prompt，以及可选 model、aspectRatio、quality、resolution、outputFormat、background。新图不能传 inputImages、sourceAssetIds 或原生设计 target。修改原图/参考图使用 `edit_image`，需真实 `sourceAssetIds` UUID，`sourceUsage=edit/reference`。来源未核验则不提交。Auto 模型可省略 model；显式模型只能来自本轮已发布工作区目录，不能由外部 Skill 固定。

默认 quality=standard（Low）、resolution=1k（1K）；仅用户明确要求 Medium/High 画质时分别用 hd/ultra，明确要求 2K/4K 时提高 resolution。质量与像素档位独立。UI 明确比例优先；编辑源图默认保留比例，用户要求变更才设 aspectRatio 与 aspectRatioIntent=resize。

用户要求透明底时用 background=transparent、outputFormat=png，但 PNG 容器本身不证明 alpha；要据真实结果核验。已有图去背景应使用相应已启用技能与已注册工具，不把普通重新生成当无损抠图。

## 预算与状态

本运行时无旧的 get_image_proposal/confirm_image_generation 步骤；图片工具在当前用户授权和服务端守卫下直接提交。只要方案、否定或先等待时不调用它们。processing/unknown 不是成功；状态不明先查询原任务，不以过期、失败或质量建议自动授权新付费生成。

本说明为 Loomic 图片流程，来源只启发方法；实际工具 schema、当前授权与任务回执优先。
