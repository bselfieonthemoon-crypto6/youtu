## 核心要求
- 代码旨在为高效生产和高质量要求而不是MVP搭建DEMO完成，完成功能要考虑产品特性和整体交互，阅读以及撰写时思维需要有大局观，以第一性原理直击痛点。
- 在相关代码加入对应日志便于后续线上或本地排查，以及TODO或相关备注 为后续他人接手提供更好的桥梁。赠人玫瑰手留余香。

# 架构第一性原则（必须遵守）

## R1 — 轻量 Agent，能力下沉到 Skills

| 层 | 职责 | 边界 |
|---|---|---|
| **Agent（大脑）** | 识别意图 → 选工具 → 读回执 → 回话 | 只做调度，不做实现 |
| **Skills** | 能力、方法论、领域知识（`SKILL.md` + `manifest.json`） | 尽量承载"怎么做" |
| **Tools** | 原子动作的可调用骨架 | 只做"能不能调"，不夹带业务策略 |

推论：**意图识别属于 Agent/Skill 层，不应写成 TypeScript 服务端代码里的硬编码判定。**
（历史反例：`mastra-image-execution-policy.ts` 用中文正则从句子里判"用户是否授权 hd/2k/4k"，`mastra-image-ratio-state.ts` 用正则判"改比例还是保持源图"。新增能力时优先考虑写成 Skill，而不是再加一条服务端规则。）

服务端只保留**安全栅栏**（鉴权、计费、幂等、来源血缘、越权防护）；**能力与方法**交给 Skill 和模型。

## R2 — 运行时是 Mastra，LangChain/DeepAgents 已退役

- **唯一编排框架：`@mastra/core`。** Agent、工具、记忆都在 Mastra 上。
- **LangChain 已不再需要**：`langchain`、`@langchain/langgraph*`、`@langchain/google-genai`、`@langchain/google-vertexai`、`langsmith`、`deepagents` 均不得新增引用；发现残留一律迁移到 Mastra。
- 模型通道统一走 `@ai-sdk/openai-compatible`（`createOpenAICompatible`）+ `createSafeProviderFetch` 出口约束。
- `LOOMIC_AGENT_RUNTIME` 只接受 `mastra`；`legacy` 会 fail fast。`agent/prompts/`、`agent/persistence/`、`agent/evals/`、`agent/backends/` 已删除，不要按旧文档恢复。
- 历史文档中描述 DeepAgents / LangGraph / `FilesystemMiddleware` / 虚拟文件系统（`/workspace`、`/memories`、`/skills`）/ 图片提案两轮确认 的内容**均已失效**，只作为问题记录。

## 计费与授权的既有边界（不要削弱）
- 生图默认 Low(`standard`) + 1K；Medium/High 与 2K/4K **分别**需要本轮用户原文明确授权。
- 单 run `generate_image` + `edit_image` 共享配额，默认 4、硬上限 8。
- 付费调用一旦结果未知，**绝不自动重试或换渠道**。

# 框架使用指南

当前运行时是 **Mastra**，工具层用 `@mastra/core/tools` 的 `createTool`，模型层用 `@ai-sdk/openai-compatible`。
遇到不确定的 API，**先读 `node_modules` 里的 `.d.ts` 源码或官方文档再动手**：

- Mastra：https://mastra.ai/docs
- AI SDK：https://ai-sdk.dev/docs
- nextjs / excalidraw / fabric 等同样要求：**先获取信息上下文再开干**，否则容易返工。
