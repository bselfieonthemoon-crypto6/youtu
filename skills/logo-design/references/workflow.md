# Logo 与品牌标识：按需细则

## 从概念到标记

寻找首字母、产品动作、空间负形或品牌故事中的一个核心记忆点。只是同一轮廓换颜色不算不同概念。提示中区分标记、准确字标与展示背景；需要纯标识时别把样机一起烧进 Logo 本体。局部反馈只调整用户指定比例、颜色或间距，不默认重设计。

## 位图与小尺寸

`generate_image` 接收 title、字符串 prompt、可选 aspectRatio/outputFormat/background；`edit_image` 另需真实 `sourceAssetIds` UUID 和 `sourceUsage`。不传原生画板 target、inline SVG、虚构 path 参数或旧确认 ID。已有正式 Logo 要保持可识别身份，但生成编辑可能改变字形，须以实际结果核对。

横向组合标不等于方形 favicon。用户要求小图标时可单独规划；未取得实际 16/32px 渲染时说明尚未验证。单色检查也不能仅凭大尺寸彩色图宣称通过。

本说明是 Loomic 图片流程；来源只启发设计方法，不代表上游脚本已运行或所有模型均已验证。当前工具 schema 与任务回执优先于旧文案。
