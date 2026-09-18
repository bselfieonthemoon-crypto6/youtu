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

# 真实网站登录态与可见浏览器操作规范

对于 Lovart 这类带登录态、Cloudflare/验证码、且需要用户肉眼可见操作的网站，不要误以为 `agent-browser --headed` 一定会弹出用户桌面可见窗口。它常常只是 agent 自己的浏览器会话，用户未必看得到，也不适合让用户手动登录。

遇到这类网站，优先使用用户桌面可见的真实 Chrome，并按下面顺序执行：

1. 先用 AppleScript 直接把目标网址打开到用户当前可见的 `Google Chrome`：
   `osascript` 控制 Chrome 新开 tab 或窗口，确保用户真的能看到页面。
2. 如果后续需要抓请求、监听画布变化、研究交互链路，不要继续依赖普通可见会话，改为启动带远程调试端口的独立 Chrome：
   `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug-profile --new-window "<url>"`
3. 让用户在这个真实 Chrome 窗口里手动完成登录。
4. 登录完成后，再让 agent 通过 CDP 或 `agent-browser state save/load` 接管会话。
5. 如果历史记忆里提到某个 state 文件，例如 `/tmp/lovart-auth.json`，必须先检查文件是否真实存在；不存在就不要假设“第一种方式还能直接用”。

结论：凡是“需要用户看到窗口并手动登录”的任务，默认先用真实 Chrome；凡是“需要自动研究请求/DOM/画布变化”的任务，再切到带调试端口的真实 Chrome 会话，不要直接拿 `agent-browser --headed` 冒充用户可见浏览器。
