# 专用图片分层后端（Qwen-Image-Layered）

## 当前状态与范围

本轮接通的是专用模型的服务协议、用户显式选择、健康预检、任务执行和多层资产保存，不是已完成真实模型部署或效果验收。现有本地 `split_layers` 保持默认；只有请求明确选择 `model: "qwen-image-layered"` 才走专用后端。未配置、未就绪、返回错误模型或无效分层时会失败并说明原因，不会改用 FeyNoBG/BiRefNet 或普通生图来冒充结果。

当前机器只读检查：AMD Radeon 集成显卡、未发现 NVIDIA CUDA 设备，系统内存约 23.37 GiB；项目 models 和 Hugging Face 缓存有 FeyNoBG/BiRefNet、SAM2、LaMa，没有 Qwen-Image-Layered。当前工作区六个供应商模型也不包含专用分层模型。没有下载模型、启动真实推理或外发用户图。

[官方模型卡](https://huggingface.co/Qwen/Qwen-Image-Layered) 标注 20B、BF16、Apache-2.0，并提供 CUDA 运行示例。20B 参数按 BF16 粗算约 40 GB，仅是参数体积估算，不是运行显存需求或本机基准。官方示例推荐 640 分辨率。要完成真实模型验证，需要用户选择有合适 GPU 的部署主机，或明确授权并提供兼容的远程服务。

专用分层生成多个 RGBA 位图层，不代表恢复原始 PSD 对象、字体、隐藏像素或像素级无损；具体场景必须检查重合成图与原图。提示词也不保证指定每一层的语义内容。[官方说明](https://github.com/QwenLM/Qwen-Image-Layered)

## 服务端配置

仅由管理员在 API 与 Worker 的启动环境配置，客户端不得提交服务地址或 Token。

| 环境变量 | 含义 |
| --- | --- |
| `LOOMIC_QWEN_LAYER_URL` | 兼容下述协议的服务根地址；本地建议 `http://127.0.0.1:8875` |
| `LOOMIC_QWEN_LAYER_TOKEN` | 可选 Bearer 凭据；不得放在 URL 中 |
| `LOOMIC_QWEN_LAYER_ALLOW_REMOTE` | 只有明确配置为 `true` 才允许非回环 HTTPS 服务；默认不允许 |
| `LOOMIC_QWEN_LAYER_TIMEOUT_MS` | 1,000–1,800,000 毫秒，默认 600,000 |

URL 不允许用户信息、查询参数或片段；不跟随重定向。客户端使用独立 HTTP dispatcher，不继承全局代理，以免本地图片被代理转发。客户端图片只发送给被管理员明确允许的这个后端，不读取返回值中的任意外部图片 URL。

`GET /api/images/layer-backend` 要求登录，返回 `configured`、`available`、`model`、`remote`、`reason`，不返回端点或凭据。可用只表示此刻的模型/协议健康检查通过，不保证之后的运行或效果。远程服务或自有 GPU 算力可能收费；当前受控后端没有供应商计费费率集成，Loomic 积分记录为 0，**不能据此宣称免费**。

## 可选的本地权重 Sidecar

项目包含 `apps/server/scripts/qwen_layer_server.py`，供用户选定的 CUDA BF16 主机运行。需要完整的本地 Qwen 模型目录和支持 `QwenImageLayeredPipeline` 的 Torch/Diffusers/Transformers/Pillow 环境。脚本不安装依赖；仅使用显式本地路径、`local_files_only=True`、HF 离线模式，不会自动下载或退回 CPU。依赖与模型部署需另行确认。[官方运行示例](https://huggingface.co/Qwen/Qwen-Image-Layered)

操作方在选定的 GPU 主机安装并准备权重后运行，例如：

```text
python apps/server/scripts/qwen_layer_server.py --model-dir /srv/models/Qwen-Image-Layered --cache-dir /srv/private/loomic-layer-cache --host 127.0.0.1 --port 8875
```

以上路径是部署示例，不是当前机器已有目录。默认只监听回环；非回环监听要求至少 24 字符 Token，并应由操作者配置 HTTPS 反向代理与访问限制。结果缓存含用户图片，应放在私有持久化目录，不得映射为公开静态目录。清理缓存需与任务保留周期协调，不能在重试窗口内删除幂等记录。

## 适配协议 v1

`GET /health` 必须返回：

```json
{"protocol_version":1,"model_id":"Qwen/Qwen-Image-Layered","model_loaded":true,"idempotency":true}
```

`POST /v1/layers` 必须同时携带 `Idempotency-Key: <job UUID>`。请求 JSON：

```json
{"protocol_version":1,"request_id":"<job UUID>","model_id":"Qwen/Qwen-Image-Layered","source_sha256":"<normalized PNG SHA256>","image_base64":"<original PNG base64>","layers":4,"resolution":640,"seed":777}
```

响应：

```json
{"protocol_version":1,"request_id":"<same job UUID>","model_id":"Qwen/Qwen-Image-Layered","source_sha256":"<same PNG SHA256>","order":"back-to-front","width":640,"height":640,"layers":[{"index":0,"png_base64":"<RGBA PNG>"},{"index":1,"png_base64":"<RGBA PNG>"},{"index":2,"png_base64":"<RGBA PNG>"},{"index":3,"png_base64":"<RGBA PNG>"}]}
```

宽高随原图比例变化，示例 640×640 不是固定输出。Sidecar 使用官方 Diffusers 流程，后者已经移除了输入条件帧，不应再次丢掉返回的第一层。[实现](https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/qwenimage/pipeline_qwenimage_layered.py)

当前 UI/任务固定四层；服务适配器本身支持 2–8 层但未对公共请求开放任意参数。所有输出必须是相同尺寸的非空 RGBA PNG，至少一层含透明像素；重复文件、层数不符、错误模型/任务/原图哈希、全不透明、JPEG、累计超限等都拒绝。原图限制 30 MiB/25M 像素，响应 JSON 64 MiB，归一化后输出累计 64 MiB。所有层使用同一变换恢复到原图尺寸，以原相对层序写入；缩放不意味着恢复原始细节。

## 幂等、保存与失败

任务先将完整验证后的分层包存入私有 `workspace-assets/<workspace>/generated/<job>-qwen-layer-checkpoint.json`，再按既有确定性资产 ID 写入 PNG 图层。签名、资产登记或画布回填失败后重跑任务时，可直接复用这个包，不再次推理。

在完整包写入前出现不确定状态时，后端必须用相同任务 ID 返回先前结果，不得重新扣费或重复推理。配套 Sidecar 在推理前保存请求指纹标记、完成后原子保存结果；重启发现标记而没有结果时返回需要操作者恢复，不自动重复计算。重试网络请求与重新推理不是同一件事。

结果包读失败/损坏不会被当成“不存在”然后重新生成。当前已知配置、输出、超时和存档错误会终止任务并显示原因，不自动换模型；依旧保留原图。模型成功不等于用户视觉认可。

## 验证方式

单元/集成测试使用合成 RGBA 图片及回环 HTTP 协议测试后端，不是 Qwen 模型效果测试：

```text
pnpm --filter @loomic/server exec vitest run src/features/images/qwen-layer-separation.test.ts src/http/jobs-qwen-layers.test.ts src/features/jobs/executors/qwen-layer-delivery.test.ts
python -X utf8 apps/server/scripts/test_qwen_layer_server.py
```

实际模型验收尚未执行；服务配置后应以经用户允许的少量样本检查层序、透明边缘、元素丢失与重合成误差，再决定是否切换默认工具。
