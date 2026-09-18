# 系列视觉设计：按需细则

每项记录用途、核心消息、共用身份、差异变量、比例与真实图片任务状态。叙事轮播按阅读顺序组织；发布物料可独立。相同内容只是尺寸不同，应重新安排画面，不虚构为新消息。

共用准确品牌文字、配色与已核验产品/Logo 来源。指定视觉参考时必须使用 `edit_image.sourceAssetIds` 的真实 UUID 与 `sourceUsage=reference`，不能只在 prompt 中称“跟上一张一样”。局部修改某张用它的真实 UUID 与 `sourceUsage=edit`，别整组重绘。生成可能改变商标与包装；逐张对照实际结果。

记录 completed、processing、unknown、failed、not_started 等真实状态；超时查原任务，不整批重跑。当前图片只落无限画布，不传原生画板 target；用户手动加入画板。未经用户授权不增加交付张数。
