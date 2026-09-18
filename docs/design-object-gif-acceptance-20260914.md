# 对象动画与整画板 GIF 导出验收

2026-09-14，本地版本 `.next-production-board-gif-final`。

## 功能

- 对象属性新增动画：无、上下浮动、放大缩小。
- 默认周期 2 秒、幅度 10。周期可设 0.5～10 秒，浮动幅度单位为画板像素，缩放幅度为百分比。
- 浮动围绕原位置上下运动；缩放按原尺寸→放大→原尺寸线性往返，不改变透明度。
- 动画参数保存到对象，支持关闭及撤销；静态位置、尺寸、透明度不随动画改变。
- 完整编辑器的导出格式新增动态 GIF，输出整个画板。动画应用于 GIF 导出，编辑画布不自动播放。
- 浏览器独立只读 Fabric 克隆逐帧渲染，gifenc 编码，不调用 Agent、图片模型或计费任务。
- GIF 最长边 1024px、最多 60 帧、最长 10 秒。多个周期优先取共同周期，超过 10 秒截断；UI 有说明。GIF 固有 256 色与二值透明限制仍适用。

## 验收

独立 QA 画布 `ceb0e623-df19-4a62-bf6c-a48b56e05723`，未修改用户当前画布。

真实 Chrome 操作：选择图层→设置动画→保存→完整编辑器→导出 GIF→下载→刷新。

| 场景 | 输出尺寸 | 帧数 | 不同帧数 | 周期 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 图片上下浮动 | 1024×576 | 24 | 13 | 2000ms | 通过 |
| 图片线性缩放 | 1024×576 | 24 | 13 | 2000ms | 通过 |
| 图片缩放＋文字浮动 | 1024×576 | 24 | 24 | 2000ms | 通过 |

Pillow 解码验证循环为无限循环、逐帧 disposal=2。保存前后对比静态 x/y/width/height/rotation/opacity 不变。浏览器监测 Agent 与生图请求均为 0。

证据：`artifacts/paid-dialogue-live/manual-board-20260914.json` 的 animation 项与 `board-animation-{float,scale,mixed}.gif`。脚本 `apps/web/scripts/test-manual-board-browser.mjs --stage=animation`。

辅助检查：共享契约 37 项通过；主控 Web GIF/静态导出/Fabric/属性面板 37 项通过；Web 与 Server TypeScript 通过。子代理另验证 Overlay/Surface 回归。新迁移 `20260914000002_design_object_animation.sql` 已应用本地数据库，严格校验、patch 写入/清空及原图片高级字段回归通过。

未做真实浏览器验收：超大画板压力、组合嵌套动画、异周期超过 10 秒的截断、所有字体和移动端。没有宣称覆盖所有边界。

## 分工

- Sol/high：GIF 编码渲染；另一 Sol/high：数据库校验迁移。
- Terra/medium：对象属性 UI 与测试。
- 主控：契约、Fabric 序列化与撤销、集成部署及真实浏览器和 GIF 解码验收。
