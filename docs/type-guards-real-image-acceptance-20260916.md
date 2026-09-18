# 类型检查护栏与真实图片验收

## 边界

建立可执行类型护栏并修复已发现的类型错误，不改变生成架构。所有编译器进程顺序运行，单进程堆上限 1536 MiB；堆上限不是长期稳定性的证明。

根目录 `pnpm typecheck` 的 Turbo 调度已设 `--concurrency=1`，避免新的 Server/Web 检查入口被同时调度。

## Server

`pnpm --filter @loomic/server typecheck` 改为分批检查。按原 tsconfig 动态枚举全部根文件，分为 production、scripts、test/spec；脚本和测试按 32 个根文件一批，每批包含生产源码与 ambient 声明，避免隔离后丢失 Fastify 插件/全局类型。每批使用全新 Node 编译器进程，整个编译器堆在批次结束后释放。

任何诊断或未执行完的批次均 exit 1，OOM/进程异常提前停止并标明未完成。完整报告位于 `artifacts/typecheck/server-*.json`；原单进程全量命令保留为 `typecheck:full`。

首次运行覆盖原配置 640 个根文件，发现并修复：

- continuity 测试需 await runtime factory 的 Promise/AsyncIterable 联合返回。
- bridge 测试的 findLast 超出项目 ES2022 lib，改用 reverse/find。
- SDK schema 夹具仍使用旧状态工具参数，改为当前 service 方法与完整 scope。

首次分批还暴露了 ambient 丢失的夹具问题；最终 runner 在每批保留整个 production root set，不通过修改生产类型或隐藏错误绕过它。

## Web

修复两处可选 accessToken 显式传 undefined 的 exactOptionalPropertyTypes 错误。生产源码检查使用独立配置，避免累积历史 `.next-*` 生成类型污染检查。

`build` 明确执行 `pnpm typecheck:production && next build`，检查失败即不运行 Next 构建，不依赖 pnpm 的可选 pre/post lifecycle 配置。保留 Next 的 `ignoreBuildErrors` 不再意味着通过 pnpm build 可以静默跳过生产源码门禁。直接调用 next build 仍能绕开这个入口，正式构建应使用 package build。

默认 `pnpm --filter @loomic/web typecheck` 检查生产源码、next-env.d.ts 当前引用的生成类型，以及 119 个测试根文件（源码目录内 10 个 + test 目录下 109 个，含 helpers）。不包含原配置未纳入的 e2e，未运行 fresh Next typegen 或单进程全量检查。

最终主控实跑 Web default typecheck：生产阶段 + 4 个独立测试编译批次，exit 0。非法 batch-size `32bad` 负向实跑 exit 1，未启动编译批次。

最终主控实跑 Server default typecheck：270 production / 49 scripts / 321 tests，原配置全部 640 个根文件、14 批通过，completed=true，exit 0。报告：`artifacts/typecheck/server-2026-09-15T16-38-40-753Z.json`。

分批覆盖不等于把所有测试 ambient 声明放进同一个巨大 program 的检查；原始 full 命令保留，未再次尝试以免 OOM。

受影响运行时测试：Server 3 文件 20 项 / Web 4 文件 19 项 / workspace 9 项通过，共 48 项。Web 运行中发现 design-image-tools 的断言仍把 AI 面板入口当成本地 split_layers 入口；只修正测试，分别锁定打开 AI 面板与本地回调，未改生产行为。

该测试修正后，对它所在的 Web 32–64 根文件批次（包含全部生产源码）再做类型检查。未进行完整 Next 构建，也未把单元测试全绿当作真实供应商端到端验收。

## 真实验收准备

只操作本地副本：`http://127.0.0.1:54421`，环境文件为 `artifacts/local-replica-20260907/app.env`。禁止替换成指向云端的 `.env.local`。

```powershell
# apps/server 中运行：无模型调用，只读健康、当前工作区任务和模型目录。
node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx scripts/preflight-real-image-acceptance.mjs

# 新建空白 QA 项目/会话，不提交 agent run。
node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx scripts/prepare-real-image-acceptance.mjs --prepare
```

本次夹具：`artifacts/real-image-acceptance/fixture-1789489715534.json`；独立 canvas `b5459851-1715-4b07-8aaa-939ab6ff2628` / session `e255ab46-4ea3-4d55-9dcc-528c9869d059`。

方案：一个生成任务，Low/1K、1:1，蓝色背景上橙色球与白色立方体，无用户素材。使用当前配置的 `gpt-image-2.5-flare`；失败不追加任务。本地积分预计 0，不等于供应商费用为 0；尚无供应商账户金额预估。

真正付费阶段复用 `apps/web/scripts/run-paid-dialogue-browser.mjs`，必须显式 `--submit` 并指定夹具与原文。之后执行：

```powershell
# 获得供应商费用授权后，在 apps/web 中执行；不会重复提交失败任务。
$qaFixturePath = 'E:/Loomic/Loomic/artifacts/real-image-acceptance/fixture-1789489715534.json'
$qaFixture = Get-Content -LiteralPath $qaFixturePath -Raw | ConvertFrom-Json
$qaArguments = @('--env-file=../../artifacts/local-replica-20260907/app.env',
  'scripts/run-paid-dialogue-browser.mjs', '--submit',
  ('--fixture=' + $qaFixturePath), ('--prompt=' + $qaFixture.prompt))
& node @qaArguments
```

```powershell
node --env-file=../../artifacts/local-replica-20260907/app.env --import tsx scripts/audit-real-image-acceptance.mjs --fixture=../../artifacts/real-image-acceptance/fixture-1789489715534.json
```

postflight 检查真实 DB 的单任务、Low/1K、成功状态、画布元素、聊天卡片、持久化成本回执与该任务实际积分扣减流水（不得重复扣减）。逐字段比对服务端真实回执，不依赖不存在的 output.billing 嵌套字段。空会话已实测 exit 1，不把零任务当作通过。它不独立证明浏览器视觉、供应商调用次数或供应商账户金额，需与浏览器截图/网络及 worker 记录共同验收。

运行核对发现 Web 监听 localhost，IPv4 127.0.0.1 访问失败；保持既有 Web。API 3002 未运行，已以 1024 MiB 堆上限恢复，健康 200；未启动 worker 或提交付费任务。

最终只读预检：Web/API 均 200，当前工作区 active image jobs=0。报告 `artifacts/real-image-acceptance/preflight-1789490567931.json`。付费提交仍等待明确费用授权；没有真实图片生成或供应商结果，因此不报告 E2E 通过。

分工：子代理请求配置为 gpt-5.6-terra / medium，负责 Web 类型与检查入口；本次使用全历史 fork，工具未返回可核验的实际型号元数据，不能确认请求配置实际生效。主控负责 Server 检查、最终 Web 门禁收紧、测试类型修复、QA 夹具与验收脚本及最终验收。
