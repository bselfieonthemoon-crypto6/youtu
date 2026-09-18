# 恢复一键抠图（2026-09-08）

## 模型核对

- 默认：models/feynobg，feyninc/FeyNobg，BiRefNet 架构；权重 1,051,353,168 字节。当前 Python worker 使用 nobg 处理器，CPU 推理，1024×1024 输入归一化，alpha 恢复到原图尺寸，再输出 PNG。
- 已下载的官方候选：models/birefnet-dynamic-matting-benchmark，ZhengPeng7/BiRefNet_dynamic-matting；权重 444,473,596 字节，revision 074df545be87034e74a96bf71566ecbbc4c15f0a。独立实验目录，非当前默认模型。
- 官方基础示例也是图片归一化、模型输出 mask、还原尺寸并写入 alpha，不需要 LLM。dynamic-matting 可使用可变形状；现有候选实验保留比例并对齐 32 像素，默认 FeyNoBG 使用固定正方形输入。两者权重与处理器不同，不应当直接混用。
- 历史真实样本对比见 matting-quality-trial-20260908.md。官方候选也曾保留 Logo 黑底，不能以“官方”推断所有素材效果更好。

来源：
https://github.com/ZhengPeng7/BiRefNet
https://huggingface.co/ZhengPeng7/BiRefNet
https://huggingface.co/ZhengPeng7/BiRefNet_dynamic-matting

## 本次变更

去除背景按钮直接调用现有异步 image-generation 作业，operation=remove_background、model=local:feynobg。结果位于原图右侧（间距 40），保持原图；使用现有持久化、任务状态与恢复链路。提交期间阻止快速重复点击。

删除预览弹窗、保留/删除笔刷辅助库、其专用 LLM 定位和 subject-preview HTTP 接口，以及对应的旧预览测试。移除工具栏“主体选取”入口，旧本地偏好自动过滤该入口。未删除模型、原图或已保存结果；未动独立橡皮、图层拆分、设计画板已有区域操作和后端公共处理能力。

移除的 9 个预览专用源码/测试文件先备份至 artifacts/matting-preview-removal-20260908/backup，可恢复。并新增直接抠图的浏览器回归测试。

## 验证

- Web / Server TypeScript 检查通过。
- Web 21 项测试通过（工具栏、原图像素读取、橡皮、占位图）。
- Server 11 项测试通过（本地处理参数、FeyNoBG worker）。
- 浏览器 3 项通过：真实本地模型点击抠图、未标注上传图原像素读取、资产预览原像素读取；含裁剪后输入及旧工具偏好兼容。
- 真实任务 3744e219-5c7f-4ec1-81c3-162d20710182 成功，测试画布 866c209d-f6d1-498a-bc01-b5216bf4756b。透明 PNG 已入库存储，原图未删除，位置正确，刷新后仍只有原图与结果两张图片。无 subject-preview 调用。
- 测试用合成图验证流程和透明通道，不代表所有设计素材的抠图质量已改善。未切换默认模型、下载新模型、调用在线抠图或修改用户原画布。
