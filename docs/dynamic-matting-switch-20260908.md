# 本地一键抠图切换至 BiRefNet_dynamic-matting

## 生效范围

本地副本 app.env 设置 `LOOMIC_BACKGROUND_REMOVAL_MODEL=birefnet-dynamic-matting`。仅影响公共本地处理器的 `remove_background` 操作，因此工具栏以及调用此操作的 Agent/设计画板任务都会使用新模型；图层拆分、区域抠图、橡皮、智能修复不切换算法。

沿用现有异步作业、资产存储和原图右侧插图逻辑。请求里的 local:feynobg 仍是兼容的本地处理入口；任务结果的 model 由实际处理器返回，现为 local:birefnet-dynamic-matting，不再将执行模型误记为 FeyNoBG。

## 推理

- 使用已经下载、此前审核过代码的本地 checkpoint：models/birefnet-dynamic-matting-benchmark。
- 离线加载（local_files_only），CPU float32，默认 2 线程。
- 保持比例，推理长边最多 1024，尺寸对齐 32；不是 2K 高分辨率质量试验。
- 输出恢复原尺寸；原 RGB 不变，原 alpha 与预测 alpha 取最小值，避免让已有透明区域变不透明。
- 动态模型与 FeyNoBG 按需加载，切换时释放另一份模型，降低双模型驻留内存。
- 配置错误、文件缺失或推理失败会明确失败，不自动回退旧模型。

## 验证与限制

Python 10 项测试、服务端 11 项测试及前后端 TypeScript 检查通过。真实浏览器作业验证实际结果 model 字段，而不只检查配置。

真实 Logo 任务 `f46021de-de7c-400a-82ff-170a24e21dae` 成功；结果明确为 `local:birefnet-dynamic-matting`。在独立测试画布 `d3ccff95-dc9c-448e-83fa-e31aefb81e97` 验证 PNG 入库、原图保留、右侧插图和刷新后两张图均已加载（通过有色像素断言排除灰色占位图）。浏览器测试共 47.1 秒（包含建图、上传、推理、保存和刷新，不是单独模型耗时）。

首次使用合成圆形测试图时，模型预测主体过于透明，未通过主体不透明度断言。这是质量限制，不能声称切换后所有素材效果更好；未降低不透明度断言掩盖问题，改用之前的真实 Logo 样本另行验证完整任务链路。历史 Logo 黑底可能被作为主体保留的问题仍应由用户观察。

## 回退

将本地副本 app.env 的 `LOOMIC_BACKGROUND_REMOVAL_MODEL` 改为 `feynobg`，再重启 API 和 worker。旧模型、已有图片、已生成结果均未删除，切换不会重算历史图片。

可用 `LOOMIC_BIREFNET_MODEL_DIR` 指定另一处已下载的兼容本地模型目录；不要将 FeyNoBG 权重与官方处理器混用。
