# 原生图片尺寸与画质独立验收

## 实施范围

- APIYI 原生 gpt-image-2、gpt-image-2.5-flare、gpt-image-2.5-sunburst 及日期后缀：比例 + resolution 计算 size，quality 单独映射 standard→low、hd→medium、ultra→high。
- 普通生图默认 1k + low；节点 1K/2K/4K 控件只选择分辨率；高清工具 2K/4K 传独立 resolution，默认 quality=standard。
- 尺寸满足 16px 对齐、最大边3840、比例不超过3:1、总像素655360..8294400。常用16:9对应1280×720、2048×1152、3840×2160；4K方图受总像素限制，映射2880×2880。
- 保留其他模型原有横竖尺寸预设；不改变 all 的接口分支。不因返回尺寸偏差隐藏已经生成的图片。
- 计费/套餐校验取画质与分辨率中较高的既有档位，供应商 quality 不随分辨率自动升档；未重新设计价格表。
- 新增数据库迁移20260914000001；在原有原子函数中验证并保存resolution，保持旧请求恢复、锁、授权、账本、队列与幂等校验。原迁移未修改。

## 真实浏览器验收

独立QA画布：8975b870-80dd-497a-9adb-86d4582504e4；会话0e85ef40-781d-4e98-af43-faf20c5a821b。没有修改用户当前作品。

实际生图渠道均为gpt-image-2.5-flare，均成功、无回退、每个任务一次provider attempt：

| 实际入口 | 请求 | 实际结果 | Job |
| --- | --- | --- | --- |
| 对话首次生成咖啡图 | 16:9 / 1k / standard→low | 1280×720，聊天图片成功解码、画布显示 | 62e4ae2f-2386-4913-be00-6772d21941e0 |
| 点击原图高清工具 | 原图1280:720 / 2k / standard→low / 1张参考图 | 2048×1152，新图显示在原图右侧 | 1c1ca917-3c4c-4cce-ac37-b860b2c043ac |
| 连续对话改为抹茶图 | 16:9 / 4k / standard→low / 1张参考图 | 3840×2160，MATCHA与抹茶主体可见，成功交付 | 9ec488a1-b6eb-496f-bd8d-13460378b7a0 |

证据：
- artifacts/paid-dialogue-live/browser-turns/2026-09-14T07-19-06-144Z.json
- artifacts/paid-dialogue-live/native-upscale-20260914.json 与同名PNG
- artifacts/paid-dialogue-live/browser-turns/2026-09-14T07-22-44-528Z.json
- artifacts/paid-dialogue-live/2026-09-14T07-22-44-528Z-live-delivery.png

真实测试发现并纠正：Agent曾将工具内部standard误说成接口不支持low。已补充工具描述及系统说明，并以只讨论、不生成的一轮验证，run eb9c7bdc-23cf-4723-a3cb-6a6c43ff6020正常结束，tools=[]，正确解释Low可搭配4K。

测试夹具曾缺thread_id导致测试请求在创建run之前被拒绝，已补齐夹具字段；工具栏定位脚本第一次未选中图片，未提交任务，改为实际点击图片后通过。两者不计为成功生图调用。

## 自动化与数据库检查

- 共享尺寸/普通job/节点contract：43通过。
- 前端弹窗与节点请求/未知重试：13通过。
- 原生provider请求与其他模型预设回归：42通过。
- Mastra提交工具：27通过；节点服务：20通过。
- HTTP计费顺序、2K/4K分辨率计费及提交前权限拦截：13通过。
- 前后端类型检查通过；生产前端构建通过。
- 本地真实数据库事务回滚验收通过：新尺寸成功、payload保存、重放、尺寸冲突、旧请求兼容、单次账本、队列失败回滚。测试期间暂停空闲Worker以避免DDL与队列轮询争锁，随后恢复。

## 覆盖边界与运行版本

- gpt-image-2和sunburst的本次验证为请求构造测试，没有分别执行付费生图；真实3次生图只验证flare。
- 方图4K、竖图与其他合法比例通过尺寸计算测试，未逐一付费生成。
- 节点路径验证了前端请求、服务层和数据库事务，未另做节点UI付费生成。
- 供应商仍可能出图比例有偏差或返回故障；不作零故障保证。
- 本地API已重启（Mastra + observational memory），Worker运行，Web使用.next-production-native-size。
- 实际协作：Terra medium负责共享/后端适配；Sol high负责数据库原子迁移与事务验收；主控负责前端、补充回归、集成复核及真实浏览器验收。
