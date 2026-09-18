# Loomic Web 前端技术分析报告

> 分析范围：`E:\Loomic\Loomic\apps\web`（只读分析，未修改任何文件）
> 覆盖：`src/app`、`src/components/**`、`src/hooks`、`src/lib`、`next.config.ts`、`package.json`、`playwright.config.ts`
> 规模：`src` 下 269 个源文件，约 58,143 行（含 CSS）；组件目录 `canvas`(24) / `design`(16) / `chat`(16) / `brand-kit`(14) / `landing`(13) / `ui`(8) / `credits`(6) / `skills`(6) / `settings`(5) / `skeletons`(5) / `prompt-library`(2) / `auth`(1) / `icons`(1)；单元测试 108 个（`test/`），Playwright E2E 26 个（`e2e/`）

---

## 1. 前端技术栈与构建

### 1.1 核心框架与依赖

`apps/web/package.json`

| 分类 | 依赖 | 版本 | 说明 |
|---|---|---|---|
| 框架 | `next` | `^15.5.25` | App Router，React 19 |
| | `react` / `react-dom` | `^19.0.0` | |
| 画布 | `@excalidraw/excalidraw` | `^0.18.1` | 无限画布内核（动态 import，`ssr:false`） |
| 设计板 | `fabric` | `7.4.0`（精确固定） | Fabric.js，设计画板渲染 |
| 后端/鉴权 | `@supabase/supabase-js` | `^2.57.0` | 仅用于 Auth（PKCE）+ 首页示例内容的只读查询 |
| 内部包 | `@loomic/shared` | `workspace:*` | Zod 契约（StreamEvent / WS 协议 / design 契约 / DTO） |
| UI 基元 | `@base-ui/react` `^1.3.0` | | shadcn 风格 dialog/dropdown/avatar/input/label |
| | `class-variance-authority` `clsx` `tailwind-merge` | | className 组合 |
| | `lucide-react` `^1.0.1` | | 图标 |
| 动效 | `framer-motion` | `^12.38.0` | Landing + 卡片入场 + Toast |
| | `tw-animate-css` `^1.4.0` | | Tailwind v4 动画工具类 |
| 主题 | `next-themes` | `^0.4.6` | `attribute="class"`，默认 light |
| Markdown | `react-markdown` `^10.1.0` + `remark-gfm` `^4.0.1` | | 聊天消息渲染 |
| 其他 | `react-colorful` `^5.6.1` | | 画布背景色 / 品牌色选择器 |
| | `gifenc` `^1.0.3` | | 设计板动画 GIF 导出 |
| 构建 | `tailwindcss` / `@tailwindcss/postcss` | `^4.2.2` | **Tailwind v4**（CSS-first 配置） |
| 测试 | `vitest`(workspace) + `jsdom` + `@testing-library/react`；`@playwright/test 1.62.1` | | |

注意点：`apps/web/package.json` 未声明 `vitest` 本体（由 workspace 根提供），构建脚本为 `pnpm typecheck:production && next build`。

### 1.2 Next.js 配置：静态导出为默认

`apps/web/next.config.ts`（23 行）

```ts
distDir: process.env.LOOMIC_NEXT_DIST_DIR?.trim() || ".next",
...(process.env.LOOMIC_NEXT_SERVER_MODE === "true" ? {} : { output: "export" as const }),
...(process.env.LOOMIC_LOCAL_BUILD_SERIAL === "true" ? { experimental: { cpus: 1 } } : {}),
typescript: { ignoreBuildErrors: true },
env: { NEXT_PUBLIC_SERVER_BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY },
```

关键结论：

- **默认 `output: "export"`（纯静态导出，无 SSR / 无 Node runtime）**。只有 `LOOMIC_NEXT_SERVER_MODE=true` 时才走 `next start`。这直接决定了整个前端的架构形态：
  - 全部页面都必须 `"use client"`（已核实：`src/app` 下 18 个 `page.tsx`/`layout.tsx` 中除 `layout.tsx`、`not-found.tsx`、`loading-preview/page.tsx`、`dev/inline-artboard/page.tsx` 外全部是客户端组件）；
  - 鉴权、数据获取、重定向全在浏览器执行（`useAuth()` + `router.replace`）；
  - `src/app` 下**没有任何 `route.ts` / route handler / middleware**（已用文件系统枚举确认），即前端不提供任何 BFF 层，所有请求直连 Fastify 后端。
- `distDir` 可用 `LOOMIC_NEXT_DIST_DIR` 覆盖——这是为了让 Playwright 能并行起独立 dev server 而不与开发者手里的 `.next` 竞争（见 `playwright.config.ts:62-73`），但代价是仓库里残留了 **100+ 个 `.next-*` 目录**（见 §8）。
- `typescript.ignoreBuildErrors: true`：`next build` 不做类型检查，类型门禁靠独立的 `tsconfig.production.json` + `pnpm typecheck`。
- `env` 块把 `NEXT_PUBLIC_*` 显式内联；`lib/env.ts:4-7` 有注释提醒「必须直接引用 `process.env.NEXT_PUBLIC_*`，webpack DefinePlugin 只替换直接引用」。

### 1.3 Tailwind v4 与设计令牌

- `postcss.config.mjs` 仅一个插件 `@tailwindcss/postcss`。
- `src/app/globals.css`（573 行）：
  - `@import "tailwindcss"; @import "tw-animate-css"; @import "shadcn/tailwind.css";`
  - `@custom-variant dark (&:is(.dark *));`
  - `@theme inline { … }` 把 30+ 个 CSS 变量映射为 Tailwind 颜色/圆角令牌（`--color-background`…`--radius-4xl`）。
  - `:root` 使用 **oklch** 色彩空间定义主题（`--background: oklch(1 0 0)` 等）；品牌强调色 `--accent: oklch(0.90 0.17 115)`（荧光黄绿）。
  - 文件后半部分集中定义 landing 页的关键帧动画（`landing-border-shift`、`landing-hero-float`、`landing-orb-drift-*`、`landing-cta-pulse-ring`、`landing-gradient-drift-*` 等）。

### 1.4 状态管理与数据获取

**没有引入任何状态管理库**（无 Redux/Zustand/Jotai/SWR/React Query/TanStack Query）。模式如下：

1. **React 局部状态 + Context**：`lib/auth-context.tsx`（Supabase Session/User）、`components/toast.tsx`（命令式 `useToast()`）、`components/credits/tier-limit-toast.tsx`、`components/chat/generation-canvas-presence.tsx`（画布存在性读取）。
2. **自定义 hooks 承担"业务 store"**：`use-chat-sessions`、`use-websocket`、`use-credits`、`use-subscription`、`use-image-attachments` 等（详见 §4）。
3. **`useSyncExternalStore` + localStorage 做跨组件偏好共享**：`use-agent-model.ts`、`use-execution-mode.ts`（模块级 `listeners` Set + 缓存快照 + `storage` 事件）。
4. **`window` CustomEvent 做跨树通知**：`loomic:credits-updated`（余额权威下发）、`loomic:design-preview-refresh`、`loomic:skills-changed`。
5. **命令式 fetch 封装在 `src/lib/*-api.ts`**，全部手写 `fetch`，统一 `Authorization: Bearer <supabase access_token>`。全部 API 调用都集中在 `lib` 层，整个 `src/components/**/*.tsx` 里只有 **1 处**内联 `fetch`（`canvas-editor.tsx:756`，`beforeunload` 的 `keepalive` 兜底保存）。
6. **ref 模式规避 token 刷新副作用**：几乎所有页面/hook 都用 `accessTokenRef.current = session?.access_token` + `hasInitialized` ref，让"token 刷新"不进入依赖数组。这是本仓库最显著的一致性约定（见 `canvas/page.tsx:336-401`、`home/page.tsx:91-140`、`projects/page.tsx:30-70`、`settings/page.tsx:52-54`、`use-chat-sessions.ts:206-210`）。
7. **请求去重**：`lib/dedupe-request.ts` 用模块级 `Map` 共享同 key 的在途 Promise（`fetchSessions` 用 `sessions:{canvasId}`，`fetchBrandKits` 用 `brand-kits:list`）；`lib/skills-client.ts` 与 `use-job-fallback-polling.ts` 各自实现了同类的在途共享。

### 1.5 测试与工程链路

- `vitest.config.ts`：`environment: "jsdom"`，`maxWorkers: 1`、`fileParallelism: false`（串行，避免竞争），`@` → `src` 别名。
- `playwright.config.ts`（116 行）：单 chromium（强制 `channel: "chrome"`）、1440×1000、`workers: 1`、`fullyParallel: false`、timeout 120s，`trace/screenshot/video: retain-on-failure`。自建 `.env.local` 解析器（`loadEnvFile`/`unquote`，不覆盖已有 env），支持 `LOOMIC_E2E_EXTERNAL_STACK=true` 复用外部栈，否则自动拉起 `apps/server`（暴露 `/api/health`）与 `next dev`。
- `tsconfig.json` 的 `include` 里有 **100+ 个 `.next-*` 的 `types/**/*.ts`** 条目（`.next-e2e-3000`、`.next-production-*` … `.next-stage8-e2e-3300`），明显是长期迭代中不断追加的历史包袱（见 §8）。
- `scripts/` 下有 24 个一次性验证脚本（`check-*.mjs` / `run-*-browser.mjs` / `verify-*.mjs`），是本地浏览器验收入口的沉积层。

---

## 2. 路由与页面清单

`src/app` 目录结构（App Router；**无 route handler，无 middleware**）：

| 路由 | 文件 | 作用 | 关键组件 | 鉴权 |
|---|---|---|---|---|
| `/` | `app/page.tsx` | 营销落地页（Landing）。Hero + TrustBar 同步渲染，其余 6 段用 `next/dynamic({ssr:false})` 代码分割 | `FloatingNav`、`HeroSection`、`TrustBar`、`FeatureShowcase`、`ShowcaseGallery`、`HowItWorks`、`PricingPreview`、`FinalCTA`、`LandingFooter` | 公开 |
| `/login` | `app/login/page.tsx` | 登录（密码 / 邮件魔法链接 / 可选 Google）。读取 `?error=` 并由 `CALLBACK_ERROR_MESSAGES` 映射成文案 | `AuthShell`、`LoginForm` | 公开；已登录则 `replace("/home")` |
| `/register` | `app/register/page.tsx` | 注册（邮箱+密码，Supabase 邮件确认） | `AuthShell`、`RegisterForm` | 公开；已登录则 `replace("/home")` |
| `/auth/callback` | `app/auth/callback/page.tsx` | OAuth/魔法链接回调：`exchangeCodeForSession(code)` → `fetchViewer()` 预热工作区 → `/home`；5s 超时保护；错误经 `?error=` 回传登录页 | `LoadingScreen`、`getSupabaseBrowserClient` | 公开（回调） |
| `/pricing` | `app/pricing/page.tsx` | 定价页（月付/年付切换、套餐卡、功能对比、FAQ、CTA）。未登录点击购买 → `/login?redirect=/pricing` | `PricingNav/Hero/Toggle/Cards/Comparison/FAQ/CTA`；`useSubscription`；`createCheckout` | 公开（购买需登录） |
| `/loading-preview` | `app/loading-preview/page.tsx` | 5 行组件，仅渲染 `LoadingScreen`，用于视觉验收 | `LoadingScreen` | 公开 |
| `/canvas` | `app/canvas/page.tsx` | **主工作区**：Excalidraw 无限画布 + 右侧 Agent 聊天侧栏 + 图层/文件面板 + 底部工具栏 + 设计画板会话。`?id=<canvasId>`、`?session=`、`?prompt=` | `CanvasEditor`、`ChatSidebar`、`CanvasBottomBar`、`CanvasLayersPanel`、`CanvasFilesPanel`、`DesignEditorSession`、`GenerationCanvasPresenceProvider`、`CanvasLogoMenu`、`EditableProjectName`、`BrandKitSelector` | 需登录（`userId` 缺失 → `/login`） |
| `/home` | `app/(workspace)/home/page.tsx` | 工作区首页：品牌 Hero + 提示词输入框（含模型/比例/附件）+ 示例浏览器 + 最近 4 个项目 + 案例发现画廊 | `HomePrompt`、`HomeExampleBrowser`、`HomeDiscoveryGallery`、`DeleteProjectDialog`、`HomeProjectsSkeleton` | 需登录（`(workspace)/layout.tsx`） |
| `/projects` | `app/(workspace)/projects/page.tsx` | 项目列表（`fetchViewer` + `fetchProjects` 并行），创建/删除/跳转画布 | `ProjectList`、`ProjectsSkeleton`、`DeleteProjectDialog` | 需登录 |
| `/brand-kit` | `app/(workspace)/brand-kit/page.tsx` | 7 行壳，实体在 `components/brand-kit/brand-kit-page.tsx`；品牌套件（色板/字体/Logo/图片/指导语）编辑 | `BrandKitPage` → `BrandKitEditor` + 5 个 section | 需登录 |
| `/skills` | `app/(workspace)/skills/page.tsx` | 技能中心：已安装 / 技能目录 / 社区市场 / 导入 四个 tab | `SkillCard`、`CreateSkillDialog`、`SkillDetailDialog`、`MarketplacePanel`、`ImportPanel` | 需登录 |
| `/settings` | `app/(workspace)/settings/page.tsx` | 设置页，`SettingsTab = profile\|agent\|providers\|billing\|usage`（初值取 `?tab=`） | `ProfileSection`、`AgentSection`、`ProviderSettingsSection`、`BillingSection`、`CreditUsageHistory` | 需登录；`providers` tab 仅 `owner\|admin` |
| `/admin` | `app/(workspace)/admin/page.tsx` | 管理后台，tab `users\|providers\|resources` | `WorkspaceMembersSection`、`ProviderSettingsSection`、`DesignResourceAdminSection` | 需登录 **且** `role ∈ {owner, admin}`，否则渲染"无权访问管理后台" |
| `/dev/inline-artboard` | `app/dev/inline-artboard/page.tsx` | 开发探针页，`NODE_ENV !== "development"` 时 `notFound()` | `InlineArtboardProbe` | 仅开发环境 |
| `not-found` | `app/not-found.tsx` | 404 | — | 公开 |

Route group `(workspace)` 的 `layout.tsx`（55 行）承担全部工作区外壳：未登录 `router.replace("/login")`、`LoadingScreen`、a11y skip-link（跳到主内容）、`AppSidebar`、绝对定位的 `CreditHeaderButton`、`PageTransition`、移动端 `pb-14` 占位（为底部导航条让位）。

> 说明：因为 `output: "export"`，所有"鉴权要求"都是**客户端**的（`(workspace)/layout.tsx` + 各页面的 `ApiAuthError` → `signOut()` → `/login`）。真正的强制发生在 Fastify 后端。

---

## 3. 页面 / 功能模块详细说明

### 3.1 Landing（`/`）

`app/page.tsx:15-56` 用 6 个 `next/dynamic(..., {ssr:false})` 把 below-the-fold 段落拆成独立 chunk（注释明确写「减少初始 bundle，配合 `motion.tsx` 的 `whileInView`，只在滚动接近时才请求」）。

- `landing/floating-nav.tsx`：固定导航，滚动感知 blur，`NAV_LINKS = #features/#showcase/#pricing`，主题切换，移动端手风琴。**内联了自己的一份 `LoomicLogo`（L15-43），没有复用 `components/icons/loomic-logo.tsx`**。
- `landing/hero-section.tsx`：`useTypewriter` 打标题「让创意，自由生长」（60ms/字），英文副标 `AnimatedSubtitle`，AI 渐变噪点背景，`MockupCursor` 关键帧循环，`HeroMockup` 使用 `/images/showcase/showcase-12.jpg`（`priority`），`ScrollIndicator` 用 framer-motion `useScroll`+`useTransform`。
- `landing/trust-bar.tsx`：4 个**硬编码**数字（10,000+ 创作者 / 100,000+ 设计作品 / 50+ AI 模型 / 99.9% 服务可用性）经 `AnimatedCounter` 滚动。
- `landing/feature-showcase.tsx`（4 个功能，本地图片，左右交替入场）、`showcase-gallery.tsx`（8 张本地 `/images/showcase/*.jpg`）、`how-it-works.tsx`（3 步）、`pricing-preview.tsx`（**硬编码 ¥ 价格，与 `pricing-data.ts` 不一致，见 §8**）、`final-cta.tsx`（光球+粒子，CTA → `/register`）、`landing-footer.tsx`（3 列链接指向大量不存在的路由：`/changelog`、`/roadmap`、`/docs`、`/blog`、`/community`、`/templates`、`/about`、`/careers`）。
- **Landing 完全不发请求**（`landing/` 目录内 `fetch(` 命中数为 0）。所谓"动态内容"只在 `/home` 使用。
- `landing/motion.tsx` 提供 `fadeUp/blurIn/scaleUp/stagger/slideInLeft/slideInRight` 与 `ScrollReveal/StaggerContainer/FadeUp/BlurIn`，全部遵循 `useReducedMotion`。

### 3.2 认证流（`/login`、`/register`、`/auth/callback`）

- `lib/supabase-browser.ts`：单例 `createClient<Database>(url, anonKey, { auth: { detectSessionInUrl: false, flowType: "pkce" } })`；缺 env 直接抛错。
- `components/login-form.tsx`（289 行）：`mode: "magic" | "password"`。
  - 密码：`signInWithPassword` → 取 `data.session.access_token` → `bootstrapWorkspace()` = `fetchViewer(token)`（`GET /api/viewer`）→ `router.replace("/home")`。
  - 魔法链接：`signInWithOtp({ email, options: { emailRedirectTo: origin + "/auth/callback", shouldCreateUser: false } })` → 切到"查收邮件"态。
  - Google：仅当 `process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === "true"`（L30-31）时显示 → `signInWithOAuth({ provider:"google", options:{ redirectTo: …/auth/callback } })`。
  - 错误直接显示 `authError.message`（L67/L88/L112），未做脱敏。
- `components/register-form.tsx`（203 行）：`signUp` + `emailRedirectTo`；若直接返回 session 则跳 `/home`，否则显示确认态；仅做前端两次密码一致校验，无强度规则。
- `components/auth/auth-shell.tsx`：左黑右白的双栏外壳，左栏 `LoomicLogoInverted` + 标题 + 3 条 feature bullets（`fadeUp custom={i}`）；`register-form` 里有一个 "or" 分隔符但**没有 GitHub 按钮**。
- `app/auth/callback/page.tsx`：`exchangeCodeForSession(code)`；`CALLBACK_TIMEOUT_MS = 5000` 超时→`auth_callback_timeout`；`fetchViewer` 失败→`viewer_bootstrap_failed`；`started` ref 防 StrictMode 双跑。

### 3.3 工作区首页（`/home`）

`app/(workspace)/home/page.tsx`（422 行）

- 数据：`fetchProjects(token)` 取前 `RECENT_PROJECTS_LIMIT = 4`；`loadHomeExampleCategories()` / `loadHomeDiscoveryCategories()` 并行加载示例内容。
- **示例内容双层数据源**：`lib/home-example-library.ts` / `home-discovery-library.ts` 先用 Supabase 查 `home_example_categories/examples`、`home_discovery_categories/cases`（过滤 `is_active = true`），**结果为空则回退到内置 seed 数组**（`home-example-seeds.ts` 40KB ≈ 550 行硬编码卡片；`home-discovery-seeds.ts` 6.8KB）。
- 交互：
  - `HomePrompt`（forwardRef，暴露 `fill(text)`）：文本框 + 附件（`useImageAttachments`）+ `AgentModelSelector` + 图片模型偏好弹层；Enter 提交（IME 安全，`!e.nativeEvent.isComposing`）；**执行模式硬编码 `"thinking"`**（`home-prompt.tsx:149`）。
  - 点击示例 → `promptRef.current.fill(selection.prompt)`；点击"发现"案例 → 直接 `createNewProject({ prompt, executionMode: "thinking" })`。
  - 提交 → `handlePromptSubmit` → `useCreateProject().create({ prompt, attachments, imageGenerationPreference, videoGenerationPreference, model, executionMode })`。
- `useCreateProject`（`hooks/use-create-project.ts`）的关键设计：**先把初态写进 sessionStorage 再跳转**（`loomic:initial-attachments`、`loomic:initial-image-generation-preference`、`loomic:initial-video-generation-preference`、`loomic:initial-agent-model`、`loomic:initial-execution-mode`），调用 `POST /api/projects { name:"Untitled" }`，然后 `router.push("/canvas?id=<primaryCanvas.id>&prompt=<urlencoded>")`。注释解释了为什么不用 `window.open` 预开标签页（内嵌浏览器会丢 `WindowProxy`）。
- 项目卡：`router.push("/canvas?id=" + project.primaryCanvas.id)`，hover 显示删除按钮 → `useDeleteProject` → `DELETE /api/projects/{id}` + `DeleteProjectDialog`。

### 3.4 画布工作区（`/canvas`）— 核心页面

`app/canvas/page.tsx`（572 行，`CanvasPageContent` 由 `Suspense` 包裹，因为用了 `useSearchParams`）

**查询参数**：`?id=<canvasId>`（必填）、`?session=<sessionId>`（可选，直接进入某个会话）、`?prompt=`（一次性，捕获进 state 后由 `router.replace` 从 URL 抹掉）。

**加载流程**（`useEffect` L338-401）：
1. `fetchCanvas(token, canvasId)` → `setCanvasData({ id, name, projectId, revision, content:{ elements, appState, files } })`；
2. 并行 `fetchProject(token, c.projectId)` → `setBrandKitId` / `setProjectName`；
3. 用 `canvasLoadGenerationRef` 自增序号 + `isCurrentLoad()` 丢弃过期响应（画布切换竞态）；
4. `ApiAuthError` → `signOut()` + `/login`。

**本地状态（列出以便理解耦合度）**：`canvasData`、`error`、`pageLoading`、`chatOpen`（≥1024px 默认开）、`layersOpen`、`filesOpen`、`brandKitId`、`projectName`、`selectedCanvasElements`、`imageChatCommand`、`activeDesign`（`{designId, initialObjectId?}`）、`designSwitchError`。

**三个"保存句柄"ref**（跨组件命令式协作，是本页的核心机制）：
- `canvasSaveRef` ← `CanvasEditor` 通过 `onBindSave` 绑定 `persistCanvasNow`；
- `agentDesignSaveRef` ← `DesignEditorSession` 通过 `onBindAgentSave` 绑定；
- `saveBeforeLeaving()`（L85-92）先存设计板再存画布，任一未就绪就抛中文错误；
- `openDesignSafely(target)`（L97-116）切换设计板前先保存当前板，`designSwitchBusy` ref 防重入（防止用户连点导致丢失）。

**画布同步 `handleCanvasSync(requireSuccess?)`（L195-277）**——Agent/Worker 改动画布后的唯一刷新路径：
1. `fetchCanvas` 重新拉权威内容；
2. 校验 `canvasIdRef` / `canvasSyncGenerationRef` / `excalidrawApiRef` 三重身份，避免把 A 画布的响应写进 B；
3. `mergeCanvasElements(localElements, remoteElements)` 合并（见 §6.2），`api.updateScene({ captureUpdate:"IMMEDIATELY" })`；
4. 若有新增元素 → `requestAnimationFrame(() => api.scrollToContent(addedElements, { animate:true, fitToContent:true }))`，注释明确说「聚焦新生成节点，而不是 fit 整个可能巨大的画布，否则结果看起来像没出现」。

**渲染结构**（L425-562）：
- 左上：`CanvasLogoMenu`（`beforeLeave={saveBeforeLeaving}`）+ `EditableProjectName` + `BrandKitSelector`；
- 右上：`CreditHeaderButton`（随 `chatOpen` 切换 `right-3` / `right-[84px]`）；
- 中间：`CanvasEditor` + `CanvasEmptyHint` + `CanvasBottomBar` + `CanvasLayersPanel`（与 files 互斥）+ `CanvasFilesPanel`；
- 右侧：`GenerationCanvasPresenceProvider`（`key={canvasData.id}`，切换画布强制重挂）包住 `ChatSidebar`；
- 覆盖层：`activeDesign && pageRootRef.current` 时渲染内联 `DesignEditorSession`（`inline` + `backgroundRoot`），`onClose`/`onPreviewReady` 都 `dispatchEvent(new Event('loomic:design-preview-refresh'))`。

**传给 `ChatSidebar` 的 15 个 prop**（L510-541）：`accessToken、canvasId、open、onToggle、onImageGenerated、onVideoGenerated、onCanvasSync、onStreamEvent(=checkForTimedOutJobs)、initialPrompt、initialSessionId、onSessionChange、onRequestCanvasImages、onRequestCanvasSelection、currentBrandKitId、ws、selectedCanvasElements、imageChatCommand、onOpenDesign`，以及设计态下的 `activeDesignId`/`beforeDesignSend`。

**`handleRequestCanvasImages`（L303-327）**：直接读 Excalidraw 场景，把 `type==="image" && !isDeleted && fileId` 的元素映射成 `CanvasImageItem[]`（`kind:"canvas-image"`），标题取 `customData.title || customData.label || "Image N"`，`assetId` 优先取 `customData.assetId ?? file.assetId ?? el.id`。

**`handleRequestCanvasSelection`（L328-331）**：先校验画布 id 一致，再走 `lib/canvas-selection-snapshot.ts::captureCanvasSelection(api)`——在读时同步读真实 `getAppState().selectedElementIds` 并与 `getSceneElements()` 求交（过滤已删除），**超过 100 个选择则整体返回空**（注释：「部分选择会错误表达复数意图，绝不截断」）。

**超时任务补偿**：`useJobFallbackPolling({ accessTokenRef, onJobSucceeded: () => handleCanvasSync() })`，`onStreamEvent` 传入 `checkForTimedOutJobs`。

### 3.5 项目列表（`/projects`）

`fetchViewer` + `fetchProjects` 并行；`ProjectList` 渲染 `aspect-[286/208]` 卡片；`highlightId` state 预留（当前未写入）；加载中 `ProjectsSkeleton`；错误态有 Retry 按钮。

### 3.6 设置页（`/settings`）

`SettingsTab = "profile" | "agent" | "providers" | "billing" | "usage"`，初值来自 `?tab=`（白名单校验）。

| tab | 组件 | 端点 |
|---|---|---|
| profile | `ProfileSection` | `PATCH /api/viewer/profile { displayName }` |
| agent | `AgentSection` | `GET /api/models`、`PUT /api/workspace/settings { defaultModel }`（默认 `apiyi:gemini-3.1-flash-lite`） |
| providers | `ProviderSettingsSection`（仅 owner/admin） | 见下 |
| billing | `BillingSection` | `GET /api/payments/subscription`、`POST /api/payments/cancel`、`POST /api/payments/change-plan` |
| usage | `CreditUsageHistory` | `GET /api/credits/transactions?limit=` |

`settings/provider-settings-section.tsx`（536 行）：
- 能力枚举 `text | vision_input | image_generation | video_generation`；`MAX_MODELS = 500`、`DISCOVERY_PAGE_SIZE = 100`。
- 端点：`GET/POST /api/workspace/provider-configs`、`PUT/DELETE /api/workspace/provider-configs/{id}`、`POST .../{id}/test`、`POST /api/workspace/provider-configs/discover-models`（草稿态发现，**不落库**）、`POST .../{id}/discover-models`。
- Base URL 强制 HTTPS（`normalizeHttpsUrl`）；API Key 只写不读（编辑态显示 `••••{lastFour}`，留空表示保留原值）；创建/更新后**总是先跑 `testProviderConnection` 再发布模型**（`finishSave`）。
- 错误码映射 `providerErrorMessage`：`provider_forbidden`、`provider_auth_failed`、`provider_connection_timeout`、`provider_redirect_not_allowed`、`provider_response_too_large`、`provider_invalid_request`、`provider_conflict`。
- `settings/model-context-fields.tsx`：折叠 `<details>` 编辑 `contextWindowTokens/maxInputTokens/maxOutputTokens/profileSource`，用 `@loomic/shared` 的 `modelContextProfileSchema` 校验，并打 `verifiedAt` + `profileVersion:"administrator-v1"`；仅 `modality === "text"` 显示。
- 角色门禁**纯前端**：`canManageProviders = role === "owner" || role === "admin"`；非管理员经 `?tab=providers` 进入会被弹回 `profile`。

### 3.7 管理后台（`/admin`）

tab `users | providers | resources` → `WorkspaceMembersSection` / `ProviderSettingsSection` / `DesignResourceAdminSection`。角色非 owner/admin 直接渲染"无权访问管理后台"。

- `WorkspaceMembersSection`（177 行）：`GET/POST /api/workspace/members`、`PATCH/DELETE /api/workspace/members/{userId}`；角色下拉仅 owner 可改；owner 行不可改；禁止自删；错误码 `member_not_found`、`member_already_exists`、`member_owner_immutable`、`member_forbidden`。
- `settings/design-resource-admin-section.tsx`（**1645 行，本目录最大文件**）7 个 tab：`resources/templates/text-presets/fonts/categories/tags/imports`；游标分页 limit 50、250ms 防抖 + `AbortController`、有导入任务运行时 2s 轮询；全部走 `createDesignResourceApiClient()`（`lib/design-resource-api.ts`，1019 行）。状态机 `draft/rejected → pending_review → published/rejected → disabled → draft`。许可/署名在客户端强制（`validatedAttribution`：必须 `license_name`，且 `usage_restrictions` 或同时具备 source+license URL）；字体文件限 woff/ttf/otf（注释：「WOFF2 暂不支持元数据校验」）。导入模式：ZIP/JSON 包、内联 manifest、或服务器目录（**需 `NEXT_PUBLIC_LOOMIC_DESIGN_IMPORT_DIRECTORY_ENABLED === "true"`**，`admin/page.tsx:129`）。

### 3.8 技能中心（`/skills`）

tab `installed | catalog | marketplace | import`。`load()` 并行 `readSkills(token,"catalog")` + `readSkills(token,"workspace")` 后 `mergeSkillInstallation` 合并安装态；`listSequence`/`detailSequence` 单调序号丢弃过期响应；`locks` Set 防同一技能并发变更。

端点：`GET/POST /api/skills`、`GET/PUT/DELETE /api/skills/{id}`、`GET /api/skills/{id}/files`、`GET/POST /api/workspaces/skills`、`DELETE/PATCH /api/workspaces/skills/{skillId}`、`GET /api/skills/marketplace/search?q&page&limit`、`GET /api/skills/marketplace/detail?name`、`POST /api/skills/marketplace/install`、`POST /api/skills/import {url}`。

`create-skill-dialog.tsx` 用 `isSafeSkillFilePath`（仅允许 `scripts/|references/|assets/`，禁 `..`/绝对路径）+ `skillCreateRequestSchema`（256KiB 正文、≤64 文件 × 2MiB、总计 8MiB）做前端校验。`skill-detail-dialog.tsx` 中图片文件以 `data:{mime};base64` 预览且**刻意不交给 Agent**。

### 3.9 品牌套件（`/brand-kit`）

页面壳 7 行，实体在 `components/brand-kit/brand-kit-page.tsx`（313 行）+ `brand-kit-editor.tsx`（294 行）。按 `asset_type` 分区为 `colors | fonts | logos | images`，渲染顺序 Guidance → Logo → Color → Font → Image。

端点（`lib/brand-kit-api.ts`）：`GET/POST /api/brand-kits`、`GET/PATCH/DELETE /api/brand-kits/{id}`、`POST /api/brand-kits/{id}/duplicate`、`POST /api/brand-kits/{kitId}/assets`、`PATCH/DELETE /api/brand-kits/{kitId}/assets/{assetId}`、`POST /api/brand-kits/{kitId}/assets/upload`（multipart）。

- 颜色：hex 存在 `text_content`，`ColorPickerPopover`（react-colorful）。
- 字体：family 名存 `text_content`，`metadata {weight, category, source:"google_fonts"}`，并通过 effect 注入 `https://fonts.googleapis.com/css2?family=…&display=swap`；`FontPickerDialog` 调 `GET /api/fonts?search=&category=`（300ms 防抖，50/页无限滚动）。
- Logo/图片：隐藏 file input（png/jpeg/webp/gif/svg）→ multipart 上传。
- Header 的"应用到新项目"绑定 `kit.is_default`；"Extract from URL"按钮标注 "disabled Phase 1"（L183-191）。
- `components/brand-kit-selector.tsx`（141 行）是画布侧控件：选择后 `PATCH /api/projects/{projectId} { brand_kit_id }`；"无"项解绑为 `null`；失败静默（L77-79）。

### 3.10 定价页（`/pricing`）

`pricing-data.ts`（318 行）定义 `pricingTiers`：free $0（1500 credits，"50 积分/天"）、starter $12/$9（1200）、pro $39/$29（5000，最受欢迎）、ultra $99/$79（15000，最划算）、business $249/$199（50000，"联系销售"）；`featureCategories` = 创作能力/积分与用量/协作与管理/权益与支持。

购买链路：未登录 → `/login?redirect=/pricing`；已登录 → `POST /api/payments/checkout {plan,billingPeriod}` → `window.LemonSqueezy.Url.Open(checkoutUrl)`（否则 `window.open` 兜底）。`layout.tsx` 里通过 `next/script`（`strategy="lazyOnload"`）加载 `https://app.lemonsqueezy.com/js/lemon.js`。已有订阅时顶部显示 "You are on the X plan" + Manage → `/settings?tab=billing`。

### 3.11 加载页与开发探针

- `components/loading-screen.tsx`：全屏动画 Loomic SVG（blob 浮动 + 星形眼旋转 + stroke-dash 微笑）+ 3 个脉冲点。被工作区外壳、home/projects/canvas/login/register/auth-callback 与 `/loading-preview` 复用。
- `app/dev/inline-artboard/page.tsx` + `components/design/inline-artboard-probe.tsx`：开发用内联画板探针，状态存 `localStorage["loomic:inline-artboard-probe:v1"]`，生产构建 404。

### 3.12 画布 + Agent 聊天（最大子系统，见 §6 / §7）

`components/chat-sidebar.tsx` 2092 行、`components/chat/tool-block-view.tsx` 2114 行、`components/canvas-tool-menu.tsx` 2098 行、`components/design/design-editor-session.tsx` 2290 行、`components/design/fabric-object-editor.ts` 2426 行——五个"上帝组件"（详见 §6、§7、§8）。

**ChatSidebar**（`chat-sidebar.tsx`，2092 行）的完整 prop 列表见 §3.4；内部由 `SessionSelector`、`RunHistoryPanel`、`ChatSkills`、`ChatMessage`、`ChatInput`、`MessageMentionPicker`（来自 `canvas-image-picker.tsx`）、`ClarificationDialog`/`ConfirmationDialog`、`CreditInsufficientDialog` 组成。

**发送流程（`handleSend`，`:934-1341`）**：
1. 同步快照提交范围——`resolveFreshAuthorizedDesignScope`/`resolveFreshTaskTarget`（`lib/chat-submission-scope.ts`）、画布选择快照、`activeImageGenerationPreferenceRef`、`activeVideoGenerationPreferenceRef`、`agentModelRef`；
2. **强制 `currentExecutionMode = "thinking"` 并丢弃 `executionModeOverride` 实参**（`:1000-1004`，见 §8.3）；
3. 用 `submissionStartingVersionRef !== null` 做重复提交闸门；
4. 乐观追加用户消息（`crypto.randomUUID()`，blocks = `[text, ...mentionBlocks, ...imageBlocks]`，`:1058-1068`）；
5. **先持久化再启动**：`saveMessage(...)`（`:1072-1081`），返回的 `userMessageId` 绑定本次 run；
6. `autoTitleSession(text)`（首条消息截断到 50 字：47 + "..."）；
7. 追加空的 assistant 占位块 `assistant-${Date.now()}`；`setStreaming(true)`、`clearActiveRun()`；
8. 订阅 `ws.onEvent`（按 `submissionVersion` + `runIdRef.current` 过滤）；
9. `ws.startRun(payload, onAck, onError)`，30s "Agent 启动确认超时"（`:1215-1280`）；ACK 时记录 runId，并冲刷挂起的取消（`if (cancelRequestedRef.current) ws.cancelRun(id)`，`:1268`）；
10. `await streamDone`（由 `run.completed|run.failed|run.canceled` resolve）；清空输入框（除非 `preserveComposer`）；
11. `catch` 时若无 assistant 文本则写入 `agentStartErrorMessage(error)`（`:1288-1306`）；`finally` 里 detach、清 streaming，并对任何已结束的 run 调 `scheduleActiveRunRecovery()`。

**确认动作（`handleConfirmAction`，`:558-812`）**：10s ACK 超时 → `ws.confirmAction` → `markConfirmationHandled` 写 `localStorage["loomic:handled-confirmation:<id>"]` → `scheduleCanvasSyncBurst()`（立即 + 400ms/1.2s/3s/8s/20s/60s 六次刷新，`:262-275`）→ 对 `image_generation` 插入乐观的 "running" `generate_image` 占位块 → 从 `payload.result` 提取 `ImageArtifact` → 若 `status:"failed"` 且带 `jobId`，继续用 `waitForGenerationJob` 跟单（`:759-791`）。

**断线恢复（`:1635-1786`）**：监听 `ws.connected` 上升沿（`prevConnectedRef`）→ 若未置 `terminalRecoveryRef` 则 `reloadMessages` → `ws.resumeCanvas(canvasId, ack => …)`；ACK 需同时匹配 `activeRunId` **和** `activeSessionId`；若已在 `completedRunIdsRef` 中则只做一次有界的 `scheduleActiveRunRecovery` 重试；否则通过 `updateSessionMessages` 写入 `resumed_${activeRunId}` 占位（注释强调必须写进 cache）并另起 `ws.onEvent` 订阅。

**initialPrompt 自动发送（`:1567-1631`）**：条件 `!sessionsLoading && ws.connected && !initialPromptSent.current`；读取并**移除** sessionStorage 的 `INITIAL_ATTACHMENTS_KEY`/`INITIAL_IMAGE_GENERATION_PREFERENCE_KEY`/`INITIAL_AGENT_MODEL_KEY`，直接**丢弃** `INITIAL_EXECUTION_MODE_KEY`，然后 `setTimeout(…, 0)` → `handleSend(prompt, attachments, preference, undefined, "thinking")`。

**内联流处理**：`canvas.sync` → `onCanvasSync()`；`billing.error` 的 `insufficient_credits` → `CreditInsufficientDialog`，其余码 → `showTierLimit`（`:1136-1149`）；`run.failed` 且模型名含 `preview` → toast「当前 Preview 模型请求不稳定…」（`:1185-1193`）。

### 3.13 聊天消息渲染：流事件、工具块、计划、澄清、运行历史

**`use-chat-stream.ts::applyStreamEvent` 的逐事件行为**（`:31-338`，12 种 `StreamEvent`）：

| 事件 | 处理 |
|---|---|
| `plan.updated` | **在 `switch` 之前**处理：按 `planId` 原地替换 `plan` 块，忽略 `revision` 更旧的事件（`:48-91`） |
| `message.delta` | 追加到末尾 `text` 块，否则新起一块；null/undefined 忽略（`:94-116`） |
| `thinking.delta` | 同上，作用于 `thinking` 块（`:118-139`） |
| `tool.started` | 按 `toolCallId` 去重（重复则 warn），创建 `ToolBlock{status:"running", toolExecutionId?, input?, retryable?, planId?, planStepId?}`（`:141-182`） |
| `tool.completed` | 置 `status:"completed"` + `output`/`outputSummary`/`artifacts`；调用 `publishAuthoritativeCreditBalance(event.output)`；若 `toolName === "ask_clarification"` 则用 `clarificationRequestSchema` 校验并追加 `clarification` 块（`:184-237`） |
| `tool.failed` | `status:"failed"`，`outputSummary = event.error.message`（`:239-270`） |
| `run.failed` | 把所有 running 工具置 failed（"处理失败"），并以**去重方式**追加 `agentRunErrorMessage(event.error)` 文本（重放安全，`:272-306`） |
| `run.canceled` | running 工具 → `canceled` / "已取消"（`:308-331`） |
| `default` | **静默忽略**未知类型（面向未来的前向兼容，`:333-336`） |

`publishAuthoritativeCreditBalance`（`:345-358`）从 `output.billing.balanceAfter` 派发 `window` CustomEvent `loomic:credits-updated`，`use-credits.ts:66-76` 是唯一订阅者。

**`tool-block-view.tsx`（2114 行）**：`ToolBlockView`（`:143-608`，`memo`）三层渲染——状态行 + `ToolStatusIcon`、正文变体、计费/回执/恢复操作；另有一个 `createPortal` 的悬浮 `ToolDetailPanel`（`:1756-1903`），通过 `findSidebarRect`（`:128-137`，向上遍历找 `style.width` + `shrink-0`）定位在侧栏左侧，Esc 可关，内含可折叠原始输入与 `ToolOutputRenderer`。

- **正文变体**：`DesignToolResultCard`、`ImageArtifactCard`（内联预览 + hover 下载 + `onError` 时一次性刷新签名 URL，`:1645-1750`）、通用卡片（`getToolConfig().showCard && isCompleted`）、`MediaShimmer`、`MediaErrorCard`、`ConfirmationCard`、`BillingSummary`、`ImageCostReceipt`、`GeneratedDesignTargetCard`、`DesignFinalizationNoticeCard`，以及"继续等待"/"放入画布"恢复按钮。
- **特判工具名**：`generate_image`、`edit_image`、`confirm_image_generation`、`generate_video`（媒体）；`inspect_canvas`（可重试读取）；`screenshot_canvas`（抑制 artifact 回调）；`get_brand_kit`（自定义颜色/字体/Logo 渲染，`:1982-2114`）；`search_prompt_library`/`get_prompt_library_entry`（→ `PromptLibraryResult`）；`delegate_design_tasks`/`record_task_workflow`/`select_next_workflow_step`（返回 `null`，`:401`）；`design` 类工具 `DESIGN_TOOL_NAMES`（`:610-617`）。
- **artifact 规则**：主 artifact = 第一个 `image` artifact；`video` 只通过侧栏的 `onVideoGenerated` 回调落到画布（**没有内联视频卡**）。`readGenerationRecovery`（`:1018-1055`）判定 `canContinue`（`processing|queued|running|"timed out"|"still being generated"`）与 `succeeded`。`showRestore`（`:326-336`）要求 `isMediaTool && jobId && succeeded && !elementId && canvasPresence && !presence.has(jobId)`——即任务已成功、且实时画布上确实没有对应元素时才显示"放入画布"。
- **计费回执**：`readImageCostReceipt`（`:1111-1119`）只接受 `queued|processing|succeeded|finished` 状态且带整型 `creditsCost`/`pricingVersion`/`actualQuality`/`actualResolution`；`readImageForegroundPolicyDisclosure`（`:1446-1491`）是严格的 fail-closed 校验（`version===1`、`pricingVersion==="credits-v1"`、`totalCredits === generationCredits + mattingCredits`、`providerCalls ∈ {1,2}`），会话式图片提案缺少该披露时会渲染琥珀色警告（`:397-400`）。
- **重试工具**：仅 `inspect_canvas` 且 `status==="failed" && retryable===true && toolExecutionId && onRetryRead`（`:254-260`）；`handleRetryRead`（`:262-281`）是 `idle|retrying|completed|failed` 状态机，侧栏侧（`:814-846`）生成 `crypto.randomUUID()` → `ws.retryTool(toolExecutionId, requestId, ack)`（15s 超时）→ `status:"completed"` 时 `reloadMessages(sessionId)`。

**计划与思考**：`agent-plan-view.tsx` 的 `AgentPlanView({block, toolsByStepId, onLocateTool})` 在所有步骤终态后自动折叠（`wasTerminal` ref）；步骤链接跳到 `getToolExecutionAnchorId(toolCallId)` 并做 1.8s 高亮（`chat-message.tsx:442-453`）；`chat-message.tsx:420-440` 用 `toolsByPlanStep` 把工具按 `planId`/`planStepId` 归组。`thinking-block-view.tsx`（43 行）**刻意丢弃 thinking 文本**，只显示"正在分析中"/"分析完成"（仅审计保留）。

**澄清与确认**：`chat/clarification-dialog.tsx`（555 行）有四个解析器——`parseStructuredClarificationQuestions`（`:24-54`，优先语义化 `clarification` 块，回退已完成的 `ask_clarification` 工具输出）、`parseClarificationQuestions`（`:128-167`，编号列表正则 + 要求 ≥2 个问题或显式澄清导语）、`parseConfirmationRequest`（`:170-195`，设计提案散文）、`parseToolConfirmationRequest`（`:198-247`，`generate_image` 的 `awaiting_confirmation`、`apply_design_template`/`manipulate_design` 的 `confirmation_required` + `confirmation_id`）。`hasImageExecutionReceipt`（`:63-85`）用于抑制提交后的过期问卷。**没有 WS RPC**——决策路径就是 `agent.confirm_action`；`ConfirmationDialog.handleConfirm`（`:267-287`）await `onConfirmAction()`，`accepted|applied` 才关闭。`ClarificationDialog` 是 A/B/C 分步问卷，把答案拼成 `"1. <title>：<answer>"` 后按普通聊天消息提交。

**运行历史**：`chat/run-history-panel.tsx`（378 行）overlay `absolute inset-0 z-30`；state `runs/nextCursor/filter/loading/loadingMore/error/selectedId/detail/detailLoading/detailError`；**页大小 20** + 游标分页；端点 `GET /api/chat/sessions/{sessionId}/runs?cursor&limit`（limit 1..50，`server-api.ts:842-849` 校验）与 `GET /api/chat/sessions/{sessionId}/runs/{runId}`；行按"今天/昨天/日期"分组；详情渲染 `executionMode`、模型、耗时、起止时间、`error.message` 与逐工具 `attempt`/耗时。

**画布存在性**：`chat/generation-canvas-presence.tsx` 提供 `GenerationCanvasPresenceProvider({api, children})` + `useGenerationCanvasPresence()` → 返回 `ReadonlySet<string> | null`。`generationSceneKeys`（`:12-17`）收集元素 id 与 `customData.jobId`/`sourceJobId`，**包含已删除元素**，以免恢复 UI 把用户主动删除的东西复活；provider 在 `api.onChange` 内与点击时各重读一次（注释 `:33`）；在 `app/canvas/page.tsx:509-542` 以 canvas id 为 key 挂载（切换画布强制重挂）。

**输入区**：`chat-input.tsx`（476 行，forwardRef 暴露 `ChatInputHandle = {clearAtQuery, focus, setValue, prependInvitation}`）：Enter 提交（IME 安全 `!e.nativeEvent.isComposing`，`:141`）；草稿只在 `draftRevisionRef` 未变时恢复（`:119-131`），避免失败发送覆盖新输入；自动增高到 240px；**@mention 检测**（`:159-192`：最后一个 `@`、必须位于行首或紧跟空格/换行、query 不含空格）；**粘贴**（`:223-236`）提取 `image/*` 并阻止默认；拖放过滤 `image/*`；file input `accept="image/png,image/jpeg,image/webp,image/gif"`；**宽高比下拉 11 项** `auto,1:1,4:3,3:4,16:9,9:16,3:2,2:3,4:5,5:4,21:9` 经 `useImageModelPreference().setAspectRatio` 落盘（testid `image-aspect-ratio-selector`/`image-aspect-ratio-option-*`）；运行中显示停止按钮（取消中显示 spinner）。`chat-skills.tsx` 只暴露 4 个空状态技能芯片（`CHAT_SKILL_SLUGS = {logo-design, campaign-design, product-visual, creative-directions}`），点击把「请使用「<name>」技能协助我。」prepend 到输入框。`lib/chat-clipboard.ts::preserveChatCopy` 用 `stopImmediatePropagation()` 阻断 Excalidraw 的文档级 copy 监听（在 `chat-sidebar.tsx:286-293` 安装）。

---

## 4. 核心 hooks 清单

`src/hooks`（18 个文件）

| Hook 文件 | 行数 | 职责 | 关键状态 |
|---|---|---|---|
| `use-websocket.ts` | 440 | WebSocket 客户端：连接/指数退避重连、事件分发、命令发送、ACK 路由、RPC 注册、`design.sync` 分发 | `wsRef`、`connected`、`reconnectAttempt`、`eventListeners`/`designSyncListeners`（Set）、`ackListeners`（按 action 的 Map）、`rpcHandlers`（Map）、`pendingRun`、`connectionIdRef`（落 `sessionStorage["ws_connection_id"]`） |
| `use-chat-sessions.ts` | 399 | 会话与消息的 owner：初始化、切换、新建、删除、自动标题、断线重载 | `sessions`、`activeSessionId`、`messages`、`sessionsLoading`、`messagesLoading`、`streaming`；refs：`msgCacheRef`（**LRU，上限 10 个会话**）、`messageVersionRef`、`reloadRequestRef`、`activeSessionIdRef`/`messagesRef`/`sessionsRef` |
| `use-chat-stream.ts` | 358 | `applyStreamEvent(event, assistantId, sessionId)` —— StreamEvent → `ContentBlock[]` 的**唯一真相来源**，发送与重连复用 | 无 state；纯 reducer；副作用仅 `publishAuthoritativeCreditBalance` 派发 `loomic:credits-updated` |
| `use-job-fallback-polling.ts` | 182 | 超时任务兜底轮询。导出 `waitForGenerationJob`（按 `token:jobId` 共享在途轮询，5s 间隔、10 分钟上限，容忍网络错误）、`readGenerationJobElementId`、hook `useJobFallbackPolling` | 模块级 `sharedPolls` Map；hook 内 `onJobSucceededRef` |
| `use-create-project.ts` | 140 | 建项目 + 跳画布；把初态写 sessionStorage 交接给画布 | `creating`；导出 5 个 `loomic:initial-*` key |
| `use-image-attachments.ts` | 231 | 聊天/首页图片附件上传、重试、移除、清理 objectURL | `attachments`（`ImageAttachmentState[]`）；`attachmentsRef` 防闭包过期；10MB 上限、MIME 白名单 |
| `use-websocket` 配套 | — | — | — |
| `use-credits.ts` | 107 | 积分余额/每日领取/聚焦刷新 | `data: CreditBalanceResponse`、`loading`、`error`；监听 `loomic:credits-updated`（只接受有限数值） |
| `use-subscription.ts` | 75 | 订阅状态、取消、改套餐 | `subscription: SubscriptionStatus`、`loading`、`error` |
| `use-agent-model.ts` | 54 | Agent 模型偏好（`null` = 自动/工作区默认） | `useSyncExternalStore` over `localStorage["loomic:agent-model"]` |
| `use-execution-mode.ts` | 74 | 执行模式 `fast \| thinking`（默认 `fast`） | `localStorage["loomic:execution-mode"]` + 跨标签 `storage` 监听。**当前无实际消费者（见 §8）** |
| `use-image-model-preference.ts` | ~130 | 图片模型偏好 + 宽高比（`auto/1:1/4:3/3:4/16:9/9:16/3:2/2:3/4:5/5:4/21:9`） | `localStorage["loomic:image-model-preference"]` |
| `use-video-model-preference.ts` | ~100 | 视频模型偏好 | `localStorage["loomic:video-model-preference"]` |
| `use-image-toolbar-preferences.ts` | ~100 | 图片选择工具条的动作固定/顺序/标签显示 | `localStorage["loomic:image-toolbar:v2"]`（默认固定 7 个，上限 7） |
| `use-generation-error-handler.ts` | 58 | 生成错误分流：`insufficient_credits` 交调用方开弹窗；`concurrency_limit`/`model_not_accessible`/`resolution_not_allowed` → tier toast；其余 → 通用 toast | 无 state；返回 `handleGenerationError(error): boolean` |
| `use-workspace-skills.ts` | 33 | 工作区技能列表 + 变更订阅 | `{token, skills, loading, error}` + 单调 `sequence` ref |
| `use-delete-project.ts` | 67 | 删除项目 + 确认弹窗三步状态机 | `pendingId`、`deleting` |
| `use-breakpoint.ts` | 54 | `mobile(<768) \| tablet(768-1023) \| desktop(≥1024)` | `breakpoint`（`matchMedia` 监听） |
| `use-chat-sessions.test.ts` | — | 上述 hook 的单元测试 | — |

---

## 5. `lib` 工具层

`src/lib`（69 个文件，含 5 个测试）。按职责分组：

### 5.1 基础设施

| 文件 | 导出 | 说明 |
|---|---|---|
| `env.ts` | `getServerBaseUrl()`、`loadWebEnv()`、类型 `WebEnv` | 默认 `http://localhost:3001`；`requireEnv` 对 Supabase 变量抛错。注释强调 webpack DefinePlugin 只能替换直接引用 |
| `supabase-browser.ts` | `getSupabaseBrowserClient()` | 单例，PKCE，`detectSessionInUrl: false` |
| `auth-context.tsx` | `AuthProvider`、`useAuth()` | `{ user, session, loading, signOut }`；`getSession()` + `onAuthStateChange` |
| `dedupe-request.ts` | `dedupeRequest(key, fn)` | 模块级 in-flight Map，同 key 复用 Promise |
| `utils.ts` | `cn(...)`、`formatDate(iso)` | `twMerge(clsx())`；`YYYY-MM-DD` |

### 5.2 API 客户端（全部手写 fetch + Bearer）

| 文件 | 覆盖端点域 | 备注 |
|---|---|---|
| `server-api.ts`（**1116 行，最大 API 文件**） | viewer / projects / canvases / sessions / messages / uploads / models / image-models / video-models / jobs / agent generate / workspace settings / provider-configs / members / skills / marketplace / credits 无关部分 | `ApiAuthError`(401) 与 `ApiApplicationError(code, message)`；多处用 `@loomic/shared` 的 Zod schema `.parse()` 校验响应（canvas get/save、node-image、provider-config、member 等）；`fetchSessions` 走 `dedupeRequest`；含 `fetchSkillFiles` 返回 `any`（类型逃逸） |
| `design-api.ts`（466 行） | `/api/designs*`、`/api/jobs?job_type=design_export\|image_generation` | `createDesignApiClient()` 工厂（可注入 `fetch`/`baseUrl`，便于测试）；`DesignApiError` 带 `code` + `conflict{latestRevision, conflictObjectIds, retryable}`；每个响应都 `schema.parse` → 失败抛 `response_invalid` |
| `design-resource-api.ts`（**1019 行**） | `/api/design-resources*`、`/api/design-templates*`、`/api/design-text-presets`、`/api/design-fonts*`、`/api/admin/design-catalog/*`（含 imports/report/status/delete/restore/references） | 设计资源库 + 管理后台目录，全部走统一 `request({path, method, responseSchema})` |
| `design-canvas-image-api.ts` | `/api/designs/{id}/canvas-image-imports`、`.../{operationId}/undo` | 画布图片导入设计板（幂等 `request_id`） |
| `brand-kit-api.ts` | `/api/brand-kits*` | 本地重复实现了 `authHeaders`/`handleErrorResponse`（注释：「mirrored from server-api.ts, not exported there」） |
| `payments-api.ts` | `/api/payments/checkout\|subscription\|cancel\|change-plan` | LemonSqueezy 结算 |
| `credits-api.ts` | `/api/credits`、`/api/credits/transactions`、`/api/credits/claim-daily` | 文件头注释声称有 "admin ops"，实际未实现 |
| `font-api.ts` | `GET /api/fonts?search&category` | 非 2xx 返回 `[]` |
| `prompt-library-api.ts` | `GET /api/prompt-library?q&source&category&offset&limit` | `promptLibraryResponseSchema` 校验；`composeLibraryPrompt(current, selected, "replace"\|"append")` |
| `layer-backend.ts` | `GET /api/images/layer-backend`、`GET /api/images/semantic-layer-backend?layer_count=N` | 图层拆分后端可用性探测 |
| `skills-client.ts` | `readSkills`、`notifySkillsChanged`、`subscribeSkillsChanged`、`mergeSkillInstallation`、`skillErrorMessage`、`SKILL_CATEGORY_LABELS` | 在途读共享 keyed `scope:token`；`loomic:skills-changed` 事件总线；中文错误码映射 |

### 5.3 画布领域工具

| 文件 | 关键导出 | 说明 |
|---|---|---|
| `canvas-elements.ts`（388 行） | `isVideoUrl`、`scaleToFit`、`getViewportCenter`、`createExcalidrawImageElement`、`fetchAsDataURL`、`fetchCanvasStorageAsDataURL`、`fetchAssetAsDataURL`、`fetchAssetBlob`、`insertImageOnCanvas`、`insertVideoOnCanvas` | 图片元素工厂（完整 Excalidraw 元素字段）；三种取图通道：外部 URL 走 `/api/proxy-image?url=`（绕 CORS）、已签名的画布 URL 直连（`credentials:"omit"`）、素材走 `/api/uploads/{assetId}/content[?preview=1]`（Bearer，预览 30s / 原图 60s 超时）；视频用 `convertToExcalidrawElements([{type:"embeddable", link}])` |
| `canvas-element-merge.ts` | `mergeCanvasElements` | 本地 vs 远端元素合并（详见 §6.2） |
| `canvas-file-loader.ts` | `createCanvasFileLoadQueue`、`visibleCanvasFileIds`、`canvasFileSourceKey(sKey)` | 视口感知的图片懒加载队列：并发 4、最多 3 次指数退避重试（500ms 起）、`AbortController` 取消、按到视口中心距离排序、75% 边距 |
| `canvas-save-policy.ts` | `CANVAS_SAVE_DEBOUNCE_MS = 1500`、`deletionRevisionKey`、`canvasSaveDelay` | **删除墓碑（tombstone）签名变化时 `delayMs = 0`**，绕过防抖立即保存 |
| `canvas-app-state.ts` | `buildInitialCanvasAppState` | 强制 `objectsSnapModeEnabled: true`（对齐参考线/吸附） |
| `canvas-normalize.ts` | `normalizeCanvasElements` | 一次性修正服务端对文本尺寸的估算（DOM 实测重居中） |
| `canvas-selection-snapshot.ts` | `captureCanvasSelection` | 发送时实时读真实选择，与场景求交，>100 直接返回空 |
| `canvas-image-crop.ts` / `canvas-image-source.ts` | `getImageCropResolution`、`readImageNaturalSize`、`renderImageCrop`、`setImageNaturalSize`、`resolveCanvasImageSource`、`resolveCanvasImageGeometry`、`prepareCanvasImageOperation` | 裁剪/翻转/自然尺寸归一化；**先取原图再操作，绝不用显示尺寸推断源像素** |
| `canvas-image-replacement.ts` / `canvas-image-generator.ts` / `canvas-video-generator.ts` | create/is/update/resize/delete 五件套（三个文件高度雷同） | 占位节点生命周期 |
| `canvas-design.ts`（235 行） | `DESIGN_SIZE_PRESETS`（方形1080²/横版1600×900/竖版1080×1440/演示文稿1920×1080）、`readDesignNodeMetadata`、`findDesignOpenTarget*`、`getDesignNodePlacement`、`tombstonePastedDuplicateDesignNodes`、`getOrCreateDesignCopyAttempt` | 设计节点识别与"禁止直接复制"（把粘贴出来的重复设计节点打成墓碑并提示"请使用『复制设计』命令"） |
| `canvas-minimap.ts` | 小地图 AABB / 旋转感知布局 | |
| `canvas-tidy-layout.ts` | `tidyCanvasLayout` | "整理画布" |
| `canvas-context-menu-i18n.ts` | `localizeExcalidrawContextMenus` | 给 Excalidraw 原生右键菜单打中文补丁，并用 `showPopover()` 提升到 top layer |
| `canvas-image-source.ts` 等 | 见上 | |

### 5.4 设计与生成领域工具

| 文件 | 说明 |
|---|---|
| `design-node-helpers.ts`（3992B） | `collectDesignNodes`、`inspectPastedDesignNodes`、`DesignNodeElementLike` |
| `design-layer-model.ts` | 设计板图层模型 |
| `design-document-controller.ts`（14035B） | 设计文档控制器（加载/变更/保存编排） |
| `design-command-history.ts`（**21416B，最大 lib**） | 撤销/重做命令历史 + 版本重基（`createRevisionRebaser`） |
| `design-image-layout.ts`、`design-template-replacement.ts`、`design-board-label.ts`、`design-preview-ready.ts`、`design-font-loader.ts` | 图片排布、模板变量替换、板标签、预览就绪信号、字体加载 |
| `design-browser-export.ts`、`design-animated-gif-export.ts`、`design-gif-palette.ts`、`design-animation-events.ts`、`design-animation-evaluation.ts` | 浏览器端导出（PNG/JPEG/GIF）、调色板量化、动画事件与评估 |
| `image-eraser.ts`、`image-text-replacement-request.ts`、`image-board-placement.ts`、`image-proposal-destination.ts` | 涂抹遮罩生成、OCR 文本替换请求构造、图片↔设计板几何判定（`outside/center-inside/fully-contained` + adopt/copy 放置计算）、生成结果去向 |
| `node-image-generation.ts`（187 行） | 节点生图的两阶段提交：`submitDurableNodeImage` **先持久化画布再提交付费任务**；`state: submitting\|unknown\|accepted\|rejected`；unknown 重试复用同一 `request_id`；`confirmedRejectionCodes` 白名单决定"确定拒绝 vs 状态未知" |
| `agent-run-error.ts`（3621B） / `agent-start-error.ts` | `agentContextErrorMessage`（14 个 `agent_context_*` 错误码 → 中文指引）、`agentRunErrorMessage`、`agentStartErrorMessage` |
| `agent-run-history.ts`（239 行） | 手写严格解析器 `parseAgentRunListPage`/`parseAgentRunDetailResponse` + `AgentRunResponseParseError`；拒绝未知 status 与非法日期 |
| `chat-clipboard.ts` | `preserveChatCopy`：`stopImmediatePropagation()` 阻止 Excalidraw 的文档级 copy 监听，并写入 `text/plain` |
| `chat-message-resend.ts`、`chat-submission-scope.ts`、`chat-generation-presentation.ts` | 重发引用重建、提交时授权范围快照、生成结果展示 |
| `home-example-library.ts` / `home-example-seeds.ts` / `home-discovery-library.ts` / `home-discovery-seeds.ts` | 首页示例/案例：Supabase 读取 + seed 兜底（详见 §3.3） |

---

## 6. 画布（canvas）与设计（design）组件架构

### 6.1 Excalidraw 集成

- 加载方式：`canvas-editor.tsx:3` 副作用导入 `@excalidraw/excalidraw/index.css`；`:44-47` `const Excalidraw = dynamic(() => import("@excalidraw/excalidraw").then(m => m.Excalidraw), { ssr: false })`。
- API 获取与分发：`handleExcalidrawApi`（`:328-334`）存本地 state 并通过 `onApiReady` 抛给父页；父页同时保留 `excalidrawApiRef`（命令式）与 `excalidrawApi` state（渲染门控）。`DesignNodeOverlayLayer` 与 `MemoizedCanvasToolMenu`（`:62`，`memo` 包裹）只在 API 就绪后挂载。
- Excalidraw props（`:869-882`）：`langCode="zh-CN"`、`theme`（next-themes `resolvedTheme`）、`initialData={{elements, appState, files: inlineFiles}}`、`onChange`、`excalidrawAPI`、`renderEmbeddable`、`validateEmbeddable`。`MutationObserver`（`:184-193`）反复应用右键菜单中文化。
- 场景访问：`getSceneElements()`、`getSceneElementsIncludingDeleted()`（墓碑 + 保存载荷）、`updateScene({elements, appState?, captureUpdate:"NONE"|"IMMEDIATELY"})`、`getFiles()`/`addFiles()`、`getAppState()`、`onChange`、`onScrollChange`、`scrollToContent`、`setActiveTool`、`getAppState().pendingImageElementId`。
- `validateEmbeddable = () => true`（`:817`），`renderEmbeddable`（`:801-814`）拦截 `isVideoUrl(link)` 渲染 `VideoCanvasElement`（hover 播放、点击切换、阻止事件冒泡）。
- **服务端驱动的截图 RPC**：`ws.registerRPC("canvas.screenshot", …)`（`:583-660`），params `{ mode: "full"|"region"|"viewport", region?, max_dimension=1024 }`；`region` 用 AABB 相交，`viewport` 用 `scroll/zoom` 换算；返回 `{ url: <png dataURL>, width, height }`（**内联给模型，不上传**）。这是整个 Web 端**唯一注册的 RPC 方法**。
- `design.sync` 触发画布刷新：`:665-679`，100ms 防抖后调 `onCanvasRefreshRequest`。

### 6.2 画布元素模型与合并

**`customData` 实际使用字段**：`type`（`image-generator`/`video-generator`/`image-replacement`）、`status`、`operation`、`jobId`、`completedJobId`、`errorMessage`、`prompt`、`model`、`source`（`generated`/`uploaded`）、`title`、`label`、`assetId`、`storageUrl`、`mimeType`、`originalWidth`/`originalHeight`、`sourceJobId`、`inputImages`、`aspectRatio`、`quality`、`duration`、`resolution`、`isVideo`、`durationSeconds`、`nodeImageRequest{requestId,state,submissionRevision?,prompt,model,aspectRatio,quality,resolution?}`、`loomicLayerHidden`、`loomicLayerRestoreOpacity`、`loomicLayerRestoreLocked`、`kind:"loomic-design"`（小地图配色）、以及 `@loomic/shared` 的 `loomicDesignNodeMetadataSchema`（设计节点：`designId`、`revision`、`previewRevision`、`previewAssetObjectId`）。

**files 结构**：`Record<fileId, { id, dataURL, mimeType, created, storageRef?, assetId?, storageUrl? }>`。加载时（`canvas-editor.tsx:196-238`）拆成 `inlineFiles`（有 dataURL，直接进 initialData）与 `pendingUrls`（只有 assetId/storageUrl，走懒加载队列）。

**`mergeCanvasElements(local, remote)`（`lib/canvas-element-merge.ts`）合并策略**：
1. 本地顺序保持；远端独有的 id 追加到尾部（`:123-125`）。
2. 先判 `mergeCompletedImagePlaceholder`：worker 完成 `image-replacement` 后写入的墓碑（`customData.type==="image-replacement"` && 同 `jobId` && `completedJobId===jobId`）**即使浏览器几何版本更高也必须胜出**，否则后续自动保存会把占位符复活（`:38-40` 注释）。
3. 再走 shared 的 `mergeCompletedImageReplacement` / `mergePendingNodeImageSubmission`。
4. 否则比 `version`：远端更大取远端，**相等时保留浏览器副本**（可能含未落库改动）。
5. 设计节点特殊处理：`revision`/`previewRevision`/`previewAssetObjectId` 与几何 `version` 独立合并；预览版本更新时接受远端预览但保留本地位置尺寸，并把 `version+1`、`versionNonce+1` 以强制 Excalidraw 重渲染（`:97-119`）。

**保存策略**：
- 自动保存防抖 `CANVAS_SAVE_DEBOUNCE_MS = 1500`；`deletionRevisionKey` 指纹（所有墓碑 `id:version` 排序拼接）变化 → 立存（`canvasSaveDelay` 返回 0）。
- `hydratedRef` 门禁：Excalidraw 完全 hydrate 之前 `onChange` 一律跳过，避免用空元素 `FULL REPLACE` 抹掉画布（`:161-164`、`:400-403`）。
- 一次性 `normalizeCanvasElements`（`requestIdleCallback`，Safari 用 `setTimeout` 兜底）跑完后才 `hydratedRef = true`。
- 缩略图：`THUMBNAIL_DEBOUNCE_MS = 10000`、`THUMBNAIL_MAX_SIZE = 400`、webp q0.8 → `PUT /api/projects/{projectId}/thumbnail`。
- 三条 flush 路径：`persistCanvasNow`（通过 `onBindSave` 暴露给父页，若 `pendingImageElementId` 存在则拒绝离开）、`beforeunload`（`keepalive: true` 的裸 fetch，注释说明 64KiB 限制）、卸载时 flush。

**潜在持久化缺口**：保存载荷里的 file 条目只写 `id/dataURL/mimeType/created/storageRef/assetId`（`:439-447`、`:695-703`）——`storageUrl` 只被读、从未回写；且 `assetId`/`storageRef` 只从 `initialFilesRef`（初始加载）取，本地新产生的 asset 绑定不会进入后续保存。

### 6.3 工具栏与画布面板

- **`canvas-tool-menu.tsx`（2098 行）** 是画布控制中枢。`TOOL_GROUPS`/`TOOL_ICONS`/`TOOL_LABELS`（`:241-280`）渲染 hand/selection/rectangle/ellipse/arrow/line/freedraw/text/image（快捷键 H/V/R/O/A/L/P/T/9）为底部居中浮动条（`left: leftPanelOpen ? "calc(140px + 50%)" : "50%"`）。额外按钮："设计画板"（→ `DesignCreatePanel`）、"AI 生成图片"（`createImageGeneratorElement`）、"AI 生成视频"（`createVideoGeneratorElement({aspectRatio:"16:9"})`）。一个集中的 `excalidrawApi.onChange` 订阅（`:459-853`）同步当前工具、滚动/缩放、橡皮/裁剪会话边界，并把单选分派给设计 / 图片生成 / 视频生成 / 视频 embeddable / 图片面板。两个后台 effect 监控持久任务：`monitorCanvasGenerationJob`（`:158-206`，重试 3 次 + 最多 30×1s 完成轮询）与只读的节点请求恢复 `getNodeImageSubmission`（`:898-961`）。
- **`canvas-bottom-bar.tsx`**：背景色 popover（react-colorful `HexColorPicker` + 预设 + hex 输入；`:329` 的 "100%" 透明度字段是**只读装饰，无行为**）、图层开关、文件开关、小地图开关、"整理画布"（`tidyCanvasLayout`，设计态禁用）、缩小 / 百分比菜单 / 放大（`ZOOM_MIN 0.1`、`ZOOM_MAX 30`、`ZOOM_STEP 1.1`、预设 `[0.25,0.5,0.75,1,1.5,2]`）、Fit All（`scrollToContent()`）。
- **`canvas-layers-panel.tsx`**（280px）：元素倒序；缩略图取 `files[fileId].dataURL`；逐行锁定（`toggleCanvasLayerLock`）与显隐（`toggleCanvasLayerVisibility`：`opacity:0` + `locked` + `loomicLayerHidden`，恢复时还原先前值并取消选中）。
- **`canvas-files-panel.tsx`**：只列 `customData.source === "generated"` 或带 `title` 的图片；通过 data URL 锚点下载。
- **`canvas-minimap.tsx`** + `lib/canvas-minimap.ts`：224×144 SVG，旋转感知 AABB，可拖拽视窗、点击/拖拽平移、方向键平移，`data-testid="minimap-viewport"`。
- **`canvas-logo-menu.tsx`**：导航/项目菜单、本地图片导入（`FileReader` → `addFiles` + `createExcalidrawImageElement`，`scaleToFit(…,600)`）、撤销/重做（在 `.excalidraw-container` 上合成 `KeyboardEvent`）、手动克隆（+10 偏移）、删除项目；导航前先 `await beforeLeave`（保存画布）。
- **`canvas-empty-hint.tsx`**：500ms 轮询 `getSceneElements()`，空场景显示"输入你的想法开始创作"，并把 `C` 键绑定为打开聊天 + 聚焦 `textarea[data-chat-input]`。
- **`canvas-image-picker.tsx`** 实际上是聊天输入框的 `MessageMentionPicker`（canvas-image / brand-kit-asset / image-model / skill），不是画布工具条。
- **死代码**：`canvas-ai-toolbar.tsx` 与 `canvas-image-gen-panel.tsx` 互相引用、**没有任何页面/组件导入它们**。

### 6.4 图片编辑流水线（画布侧最大功能块）

选中图片后的动作由 `canvas/image-selection-toolbar.tsx` 呈现，动作集合定义在 `components/canvas/image-toolbar-types.ts`：

```
remove-background | split-layers | replace-text | edit-region | regenerate
| panorama | crop | upscale | erase | outpaint | add-to-chat | details | download
```

固定动作存 `localStorage["loomic:image-toolbar:v2"]`（默认 7 个、上限 7、`showLabels`），溢出菜单提供未固定动作 + "本地快速拆分" + Qwen `LayerBackendOption` + "自定义工具栏"对话框。`editingDesignId` 存在时退化为单个"加入画板"按钮（`data-testid="image-board-only-toolbar"`）。`edit-region` 与 `panorama` 已注册但 `available: false`。

所有生成式动作汇入 `handleDirectImageAction`（`canvas-tool-menu.tsx:1213-1444`）：`readOperationImage` → `prepareCanvasImageOperation`（`lib/canvas-image-source.ts:49-76`，应用裁剪与翻转、不烘焙旋转）→ 在 `(x+width+40, y)` 插入 `createImageReplacementElement` 占位 → `POST /api/jobs/image-generation` → 把 `jobId` 写入占位 `customData` → 监控 → 成功刷新画布（服务端插入真实元素并返回 `job.result.canvas_element_id`）/ 失败置 `status:"error"` + `errorMessage`。

| 功能 | 关键实现 | 后端 |
|---|---|---|
| regenerate | `ImageActionDialog` 备注 + `buildImageActionPrompt` | `POST /api/jobs/image-generation` |
| upscale | 2K/4K → `resolution:"2k"\|"4k"` | 同上 |
| remove-background | `operation:"remove_background"`，固定模型 `gpt-image-2`（`imageToolOperationModel`），`quality:"hd"` | 同上 |
| split-layers | 三选一：本地快拆 `local:feynobg`；语义拆分 `layer_backend:"semantic"` + `layer_names` + `repair_background`（报价来自 `GET /api/images/semantic-layer-backend?layer_count=N`）；Qwen `qwen-image-layered`（可用性探测 `GET /api/images/layer-backend`） | 同上 |
| replace-text | OCR `POST /api/images/recognize-text` → 原文/替换文本行 → `buildTextReplacementContent` 构造中文提示词 | `POST /api/jobs/image-generation` |
| erase / local_repaint | `image-eraser-overlay.tsx`：归一化 0-1 笔迹、半径相对短边、`add/subtract`、笔刷 8-120、撤销/重做/清空、64×64 探针校验（`hasVisibleMask`）拒绝空遮罩、Esc/Ctrl+Z；确认后 `onConfirm("smart", strokes, prompt)` → `mask_image = renderEraseMask(...)`（PNG dataURL） | `local_repaint` via `POST /api/jobs/image-generation` |
| crop | `handleCropImage` → Excalidraw 原生裁剪（`appState.croppingElementId`）+ `image-crop-resolution-panel.tsx` 手动 W/H 像素；`handleSaveCrop` 用 `prepareCanvasImageOperation` + `resizeImageCrop` 渲染真实裁剪像素，以新 `crypto.randomUUID()` fileId `addFiles`，在原图右侧插入新元素并还原原图，`createCropSaveGuard` 防并发 | **无后端**（纯本地） |
| outpaint | `image-outpaint-panel.tsx`：上/下/左/右留白 + 10/25/50% 预设、预览、校验（每边 ≤3840、总 ≤8,294,400 px、比例 ≤3） | `operation:"outpaint"` + `outpaint_margins` |
| details | `image-details-dialog.tsx`：标题、显示尺寸、原始尺寸、mime、创建时间、模型、prompt（可折叠）、element id、assetId、sourceJobId | 无 |
| 加入设计板 | `canvas-image-board-actions.tsx` + `image-board-picker.tsx`，仅手动/拖拽触发。`classifyImageBoardPlacement` 判 `outside/center-inside/fully-contained` 决定 adopt（保位置）或 copy（自适应）。重新拉画布、校验版本/锁定、"固化"素材（无 assetId 则 `POST /api/uploads`），然后 `POST /api/designs/{designId}/canvas-image-imports`（`request_id`、`expected_design_revision`、`expected_source_element_version`、`expected_board_element_version`、`mode`、`placement`）→ `POST /api/designs/{id}/preview`；撤销 `POST /api/designs/{id}/canvas-image-imports/{operationId}/undo` | 见左 |

**重要观察**：`canvas/image-region-matting-overlay.tsx`（区域抠图/背景移除 UI）**在画布侧完全没有使用**——它唯一的消费者是 Fabric 设计板（`design/design-editor-session.tsx:2020-2032`，走 `region_matting`）。因此 `handleDirectImageAction` 中 `"region-matting"`、`"erase-transparent"`、`"smart-erase"` 三个分支在画布上**无调用点**，只作为文案/错误字符串存在。

### 6.5 生成面板

- **`image-generator-panel.tsx`**：按 `elementBounds + canvasScrollZoom` 定位在视口坐标。prompt 直接写回 `customData.prompt`（因此画布撤销能恢复节点草稿）；模型来自 `GET /api/image-models`（展示 `creditCost`，`accessible === false` 显示锁）；质量 1K/2K/4K → `standard/hd/ultra`；比例 1:1/16:9/9:16/4:3/3:4 会改写占位尺寸；提示词库经 `PromptLibraryDialog` + `composeLibraryPrompt`。参考图上传 UI 存在但**带参考图提交会被拒绝**（`:218-221`，节点接口仅支持纯文本）。提交是刻意的两阶段（见 §5.4 `node-image-generation.ts`）。**面板内不轮询**，由画布级 monitor 轮询 `GET /api/jobs/{id}` 并通过画布刷新交付元素。
- **`video-generator-panel.tsx`**：首帧/尾帧上传成为 `inputImages` data URL；参数 popover（16:9/9:16、时长来自 `limits.allowedDurations`/`maxDuration`、分辨率由 `limits.maxResolution` 推导）；价格行来自 `model.pricing.rates`（`providerPointsPerSecond`、`cnyPerSecond.min–max`）；按钮显示 `getVideoCreditCost(model, duration, resolution)`。生成是**单次阻塞 `POST /api/agent/generate-video`**，带 `Idempotency-Key` 头（签名键 → `crypto.randomUUID`），卸载时用 `AbortController` 中止；结果替换占位并软删占位。
- `canvas/video-canvas-element.tsx` / `video-player-panel.tsx`：画布内视频播放器与独立播放面板。
- `canvas/generating-overlay.tsx`：生成中的 shimmer 覆盖层（由 tool menu 构造稳定 key）。

### 6.6 设计板（design board）架构

设计板是"画布上的一个可编辑文档节点"：Excalidraw 里用一个矩形 + `customData.kind === "loomic-design"` 表示，双击进入以 **Fabric.js 7.4.0** 为核心的编辑器（模态覆盖层或画布内联两种外壳）。

#### 6.6.1 四层职责划分

| 层 | 文件 | 职责 |
|---|---|---|
| **状态owner** | `design-editor-session.tsx`（2290 行） | 唯一与 REST 通信的组件；持有文档、`DesignCommandHistory`（`historyRef`，:146）、本地场景镜像 `sceneRef`/`scene`（:147/:159）、选中态、任务；把一切以 props 下发。注释 :129 自述"Owns the authoritative document, local Fabric adapter, and save history" |
| **外壳** | `design-editor-overlay.tsx`（1040 行） | `createPortal` 到 `document.body` 的全屏 `<dialog>`（:419）；只持有 chrome 状态（导出/关闭确认、resize 表单、窄屏只读门禁）；渲染 `FabricDesignSurface`（:815-830）并注入 `resourcePanel`/`imageTools`/`subInteraction` 插槽 |
| **内联外壳** | `design-inline-editor.tsx`（338 行） | 画布页使用的替代外壳（`inline` prop，session :1742 `const EditorShell = inline ? DesignInlineEditor : DesignEditorOverlay`）；DOM 探测 Excalidraw 画板预览矩形，把 Fabric 画布原地盖在节点上；"画板详情"按钮可 `setLegacy(true)`（:172/:138）退回全屏覆盖层 |
| **React↔Fabric 桥** | `fabric-design-surface.tsx`（447 行） | 创建 Fabric `Canvas`，经生命周期锁管理挂载/卸载，逻辑尺寸↔CSS 尺寸换算，通过 `forwardRef`/`useImperativeHandle`（:112-150）暴露 `FabricObjectEditorApi`；**不持有文档状态** |
| **引擎/交互** | `fabric-object-editor.ts`（**2426 行**） | `class FabricObjectEditor`（:249）实现 `FabricObjectEditorApi`（:173-245）：Fabric 对象、命中测试、变换、吸附、命令、序列化。与框架无关（单测、GIF 导出、动画预览都直接构造它） |

#### 6.6.2 Fabric 生命周期与 DPI/缩放

- `fabric-canvas-lifecycle.ts`（48 行）是一个**全局单例** `fabricCanvasLifecycle = new FabricCanvasLifecycle()`（:48），用 promise 链（`transition`，:11）**串行化** mount/dispose——因为 **Fabric 7 的 `dispose()` 是异步的**，React StrictMode 双挂载可能留下两个活画布。`mount()`（:13-24）总是先 dispose 当前实例；`unmount(canvas?)`（:26-35）在"替换已挂载"时直接 no-op（注释 :28-29：「stale React cleanup 可能在替换之后才到」）。
- `FabricDesignSurface` 的单个大 `useEffect`（:152-312）以 `[height, readOnly, width, padding]` 为键——**尺寸或只读态变化会整体重建 Fabric**。拆卸走 `disposeCanvas()`（:163-177）：`editor.dispose()` → 断开 `ResizeObserver` → 清 overflow clip-path → `mounted.off()` → `await fabricCanvasLifecycle.unmount(mounted)` → `onCanvasDispose`；异常经 `onCanvasError` + `console.error("[design-editor] Failed to initialize Fabric canvas:")`（:303）。
- **像素预算**：`FABRIC_EDITOR_MAX_BACKING_PIXELS = 16_000_000`（fabric-object-editor.ts:40），`renderScale = min(1, sqrt(budget / (viewportW*viewportH)))`（`resizeBackingStore`，:1496-1521）。Canvas 以 `enableRetinaScaling: false` 创建（surface :185）。
- **两套坐标系**：backing store = `logical × renderScale`（`backstoreOnly`，:1505-1511）；CSS 呈现 = `displaySize`/`inlineSize`（`setDimensions(..., {cssOnly:true})`）。viewport transform 为 `setViewportTransform([renderScale,0,0,renderScale, pad*renderScale, pad*renderScale])`（:1512-1519），其中 `padding = showOverflow && !readOnly ? max(width,height)/2 : 0`（:70）。因此 `ResizeObserver → fitToViewport`（:252-277）**永不改写文档坐标系**。
- DOM 覆盖层定位用 `getObjectViewportBounds()`（:292-313），镜像 Fabric 的 backstore→CSS 映射（`canvasBounds.width / canvas.getWidth() * renderScale`）并加回 `viewportPadding`。
- **溢出命中区**：内联溢出模式下，`upperCanvas.style.clipPath` 由 `makeOverflowHitPath()`（:403-439）在 `after:render` 与选中事件（:208-219）时重写，使画板外的空白区域用于平移、而画板与选中控制柄仍可命中（:345-353 关闭下层 canvas 的 pointer-events）。
- GIF/静态导出路径（session :1452-1456、:1550-1558）**绕过单例锁**，自己构造离屏 `<canvas>` 并手动 `editor.dispose(); canvas.off(); await canvas.dispose()`。

#### 6.6.3 节点模型（两种"节点"要区分）

**(a) 画布级设计节点**：Excalidraw 元素 + `customData`，由 `@loomic/shared` 的 `loomicDesignNodeMetadataSchema` 校验。`design-node-helpers.ts` 提供 `readDesignNodeMetadata`（:30）、`collectDesignNodes`（:39）、`findDuplicateDesignNodes`（:51）、`inspectPastedDesignNodes`（:78）。`canvas-design.ts:194` 用它实现"粘贴/复制设计节点"的拦截（注释 :73-77：「保留原 designId 会产生第二个权威绑定」），命中后打墓碑并提示"设计节点不能直接复制，请使用『复制设计』命令"。

**(b) 设计对象（层）**：`LoomicSceneV1` 内的一层，类型定义在 `packages/shared/src/design-contracts.ts`：
- `designObjectTypeSchema`（:102-113）：`image / svg / text / textbox / rect / circle / triangle / line / arrow / group`
- `role`（:116-123）：`background / title / subtitle / logo / product / decoration`
- `animation`（:126-131）：`{ type: "float"|"scale", durationMs 500–10000, amount 1–100 }`
- 基础字段（:133-148）：`objectId`(uuid)、**`objectVersion`(int ≥1，CAS 令牌)**、`name?`、`x/y/width/height/rotation/opacity/zIndex/locked/visible/role?`
- `zIndex` 由 `serializeScene()` 从 Fabric 堆叠顺序派生（fabric-object-editor.ts:383，back-to-front）

**Fabric 侧元数据**存在 `object.data` 的 `RuntimeMetadata {objectId, objectVersion, designType, source}`（:48-53），由 `tag()`（:1342-1362）写入、`readMetadata`（:1584-1593）/`requireMetadata`（:1595）读取；其中 `source` 是持久化 `DesignObject` 的 `structuredClone`——**运行时是几何的权威，克隆体是持久字段的权威**。

**映射双向**：`loadScene()`（:315-375）→ `fromDesignObject()`（:1235-1281，image/svg 走注入的 `resolveAsset`，异步）或 `fromSynchronousDesignObject()`（:1283-1334，同步类型）；Group 递归 `new Group(children, fabricOptions(object))`，子对象在顶层跳过（:336-362）。反向 `serializeScene()`（:377-399）→ `toDesignObject()`（:1364-1416），几何来自 `transformFields(runtime)`（:1624-1649，`util.qrDecompose(calcTransformMatrix())` + 图片呈现校正）。Fabric 以中心为原点，因此 `x = translateX - width/2`（:1642）——这是长期易踩的坑，`topLeftOrigin` 选项可强制 `originX/originY = left/top`。

**图层模型**（`design-layer-model.ts`，122 行）：`DesignLayerNode {object, children, depth}`、`DesignLayerAdapter {selectObjectIds, renameObject, updateObject, reorderObject, updateMany}`；`buildDesignLayerTree(objects, query)`（:51-96）roots 按 **zIndex 降序**（最前在上）、排除 group 子项、用 `ancestry` Set 防环、对 label/类型/角色做模糊匹配；`flattenVisibleDesignLayers`（:98-109）遵守折叠态；`designLayerMoveTarget(objects, id, up|down|top|bottom)`（:111-122）做平坦数组的索引算术。`TYPE_LABELS`/`DESIGN_ROLE_LABELS` 是硬编码中文（:25-45）。

**z-order / 锁定 / 显隐 / 分组**：
- `reorder(objectId, "front"|"back"|"forward"|"backward"|number)`（:764-785）→ `bringObjectToFront`/`sendObjectToBack`/`bringObjectForward`/`sendObjectBackwards`/`moveObjectTo`，发 `object.reorder {to_index}`。
- `setLocked`（:728-740）设置 lockMovement/X/Y、lockScaling/X/Y、lockRotation、`selectable: !locked`；`setVisible`（:742-752）设置 `visible`/`evented`/`selectable`；两者经 `updateObjects()`（:1418-1443）递增 `objectVersion` 并发 `object.update`。
- `group()`（:868-898）把子对象移出 canvas、构造 Fabric `Group`、生成带 `childObjectIds` 的持久 group 对象、发 `objects.group`；`ungroup()`（:900-933）用 `util.sendObjectToPlane(child, group.calcTransformMatrix())` 还原、发 `objects.ungroup`；`cloneSelection()`（:445-495）**明确拒绝克隆 group**（:452 "Group cloning is not supported by this editor version."），逐个发 `object.clone`。
- 对齐/分布：`align()`（:787-818）发 `objects.align`；`distribute()`（:820-866）要求 ≥3 个对象，发 `objects.distribute`。

#### 6.6.4 文档持久化与命令历史

**`lib/design-document-controller.ts`（476 行）在生产环境是死代码**——`DesignDocumentController`/`createDesignDocumentController` 只被 `test/design-document-controller.test.ts` 引用（:8/:22/:176）。它仍是一份有价值的参考规格：状态机 `idle|loading|ready|dirty|saving|conflict|reload_required|error`（:13-21）、`StableIdempotencyKeys`（:68-90，key 为 `design:{id}:mutation` 与 `design:{id}:preview:{revision}`）、`stage()`/`save()` 带 `expected_revision` + `idempotency_key`、冲突识别 `DesignApiError.code === "DESIGN_CONFLICT"`（:286）、`applySync()`（:371-385）只接受严格更新的 revision、`deriveDesignPreviewPresentation`（:419-454）。

**真实的持久化管线是 `lib/design-command-history.ts`（702 行）**，`DesignCommandHistory`（:109）是"渲染适配器 ↔ 网络"之间的纯协调者：
- `DESIGN_AUTOSAVE_DEBOUNCE_MS = 1_000`（:13）；`record(edit)`（:175）/`recordBatch(edits)`（:180-228）压入历史条目（`forward`/`inverse` 命令数组、`mergeKey`、`persistedApplied`、`hasPersistedTransition`）并 `scheduleAutosave()`（:385-397，1s 定时 + 发布 `nextSaveAt` + `pump()`）。
- **合并**：`canCoalesce()`（:519-550）+ `mergeEdits()`（:552-596）只合并同 `mergeKey` 且同主体（`mergeSubject`，:598-603）的重复 `object.update`/`canvas.update`，且仅当条目仍在队列中、未在飞行、未失败时（:527-530）。编辑器提供 `transform:{ids}`（fabric-object-editor.ts:1128）与 `text:{id}`（:1178）合并键；session 提供 `canvas:background`（design-editor-session.tsx:1197）。
- **一次手势一个请求**：`takePendingBatch()`（:633-642）只取**一个**待处理手势；注释（:634-639）解释：服务端对每条命令都同时校验输入场景与最终场景，若把连续手势合并会破坏 CAS。
- `pump()`/`runBatch()`/`completeBatch()`/`failBatch()`（:405-490）保证**恰好一个在途变更**（`activeSave`/`inFlight`），冻结请求（`FrozenBatch`，:96-99）；冲突时置 `failureKind="conflict"` + `conflictRevision`；`retry()`（:272-288）用**原幂等键**重放冻结请求；`resumeAfterReload(revision, rebase?)`（:294-316）恢复失败+待发操作并重写 CAS 字段；`reloadDiscard(revision)`（:319-334）丢弃本地操作与两个栈。
- 状态派生 `status()`（:492-498）：`destroyed|saving|error|conflict|clean|debouncing|dirty`；`getState()`（:148-167）返回 `{status, authoritativeRevision, dirty, canUndo, canRedo, queuedCommandCount, inFlightCommandCount, nextSaveAt, conflictRevision, error, dirtyBatches[]}`，`dirtyBatches` 区分 `failed|in_flight|queued`（:149-153、:614-672）。
- 撤销/重做跨持久边界时，`commandsForHistory()`（:343-362）经 `preparePersistedCommand` 重新派生命令；session 提供 `refreshCommandVersions`（design-editor-session.tsx:2161-2205）与 `createRevisionRebaser`（:2207-2227）。
- **预览是独立节流路径**：`ensurePreview()`（:389-403）以 `{id}:{revision}` 为 key 去重，失败降级为提示"设计已保存，但预览更新失败…"。`onFinish`（:1831-1852）循环 `flushAll → waitForDesignPreview → onPreviewReady` 直到历史干净，失败时清空请求 key 以便重试。

#### 6.6.5 Agent 集成模型

- **Agent 从不直接操作浏览器编辑器**。前端注册的 RPC **只有 `canvas.screenshot`**（`canvas-editor.tsx:583`），**没有任何 design.\* RPC**；`use-websocket.ts:245-258` 对未知 method 回 `No handler for method: ${req.method}`。
- Agent 端的设计工具在**服务端**执行（`apps/server/src/agent/tools/design-tools.ts`）：`inspect_design`、`get_design_objects`、`manipulate_design`、`search_design_resources`、`apply_design_template`、`export_design`、`list_designs`；破坏性操作（删除/整场景替换/套用模板）需确认，所有写操作都带 `expected_revision` + `idempotency_key`——与浏览器同一套 CAS 契约。
- **`design.sync`**：schema 在 `packages/shared/src/design-contracts.ts:1457-1494`
  ```
  { type:"design.sync", designId, revision,
    updateType:"created"|"mutated"|"renamed"|"preview"|"deleted"|"restored",
    changedObjectIds?, previewAssetObjectId?, previewRevision? }
  ```
  （superRefine 要求 preview 两个字段成对出现）。由 `use-websocket.ts:127-139` 的 `parseDesignSyncMessage` 校验后分发给 `designSyncListeners`。
- **两个消费者**：
  1. `design-editor-session.tsx:487-567` 的合并逻辑：
     - `updateType === "preview"`：原地 patch `preview_asset_object_id`/`preview_revision`/`preview_status`（:492-515）；
     - `mutated|renamed|restored` 且 `revision > authoritativeRevision`：本地历史处于 `dirty`/`saving`/`conflict` 时**只提示**「设计已在其他位置更新到版本 N；本地修改仍保留…」（:522-531）**不重载**；干净时串到 `syncReloadChainRef`（:532）→ `client.getDesign` → `history.reloadDiscard` → `editorRef.loadScene(authoritative.scene, fetchAssetBlob)` → `refreshTextMetrics()`（:540-557）；
     - `renamed` 在 `localRenameRef.current` 为真时忽略（:491），避免覆盖本地改名。
  2. `canvas-editor.tsx:665-679`：100ms 防抖后 `onCanvasRefreshRequest()`，刷新画布上的画板缩略图/原生节点元数据。
- **本地保存冲突的自动重基**：`design-editor-session.tsx:646-665` 最多重试 2 次（`autoRecoverAttemptsRef`），走 `reloadKeep` + `flushNow`；耗尽后才把 `conflictRevision` 暴露给 UI（`autoRecoverState === "exhausted"`，:1983-1985）。
- **`agentDesignSave` 绑定链**：session 通过 `onBindAgentSave` 在 effect 中发布 `flushAll`（:631-634）→ 画布页 `bindAgentDesignSave` 存入 `agentDesignSaveRef`（`app/canvas/page.tsx:80, 117-122`）→ 在四处 `await`：离开画布（`saveBeforeLeaving`，:85-92）、切换设计板（`openDesignSafely`，:97-116）、画板打开时发送 agent 消息（`beforeDesignSend`，:514-518）以及 :515-517。这保证 **Agent 检视到的永远是已持久化的 revision**。

#### 6.6.6 UI 面板清单

| 组件 | 行数 | 要点 |
|---|---|---|
| `design-editor-overlay.tsx` | 1040 | portalled `<dialog>`（:424-437）；打开时把 `backgroundRoot` 设为 `inert + aria-hidden`（:253-275）；`FOCUSABLE` 焦点陷阱（:138-145/:290-308）；`Ctrl/Cmd+Z/Y/S`（:316-334）；Escape 阶梯尊重 `[data-design-subinteraction='true']`（:335-353）；脏态 `beforeunload` 拦截（:277-282）；三栏网格 `260px \| 1fr \| 300px`（:594）。左栏 = 资源面板 + 添加对象（text/textbox/rect/circle/triangle/line/arrow/upload）+ 画板设置（背景色、透明、resize 宽/高/策略，1–32768 校验，:723-811）。Header = 返回/名称/状态/撤销/重做/保存/预览/导出。冲突横幅（:521-564）提供 **重试原请求 / 重载并保留本地修改 / 放弃本地并重载**；错误横幅（:566-586）；`<1024px` 只读（`useNarrowViewport`，:147-158/:588-592）。导出对话框（:872-964）支持 png / 透明 png / jpeg / gif × 1×/2×，内嵌 `DesignExportTaskList` |
| `design-properties-panel.tsx` | 1130 | props `selectedObjects` + `actions: DesignPropertiesActions`。多选行：对齐 ×6、分布 ×2、克隆、替换素材、成组/解组、翻转（:123-223）。单选分节：名称、x/y/宽/高/旋转/透明度、`ProportionalScale`（:51-76，带基线重检的百分比滑杆）、`AnimationProperties`（:574-696）、文本（内容/字体/字号/字重/斜体/行高/字距/对齐）、填充、描边+阴影、图片 `fit`（:544-566）与 `ImageAdvancedProperties`（:698-848：裁剪 %、遮罩形状、亮度/对比/饱和/模糊、灰度/棕褐、重置）。`TextField`（:934-1046）用 `TextFieldDraftContext`（key `objectId:label`）+ 200ms 防抖提交，避免打字在重渲染中丢失 |
| `design-layers-panel.tsx` | 351 | 搜索、上/下/顶/底重排、批量 锁定/解锁/隐藏/显示、拖拽重排（:161-188）、组展开折叠、双击或铅笔改名、锁/眼切换、角色/类型/子数副标题 |
| `design-image-tools.tsx` | 237 | 按钮：去除背景 / 框选主体 / 橡皮擦除 / 图层拆分（语义对话框）/ 本地拆分 + `LayerBackendOption`；任务列表带状态文案（:209-229）与取消。操作枚举（:19-24）：`remove_background \| region_matting \| split_layers \| erase_transparent \| smart_erase` |
| `design-resource-panel.tsx` | 596 | 4 个 tab：模板/素材/文字/字体（:20/:218-246）；250ms 防抖搜索（:74-77）；集合 all/favorites/recent；游标分页 limit 24；收藏切换；`RequestQueue(4)` 并发受限 + IntersectionObserver 懒加载预览（:515-596）；拖拽载荷 `application/x-loomic-design-resource`（:424-427） |
| `design-template-replace-dialog.tsx` | 362 | 变量绑定字段：text/color/image(`asset_object_id`+`resource_id`)/font(`font_face_id`+`font_family`)；权威 diff 列表带 `binding\|smart\|default` 来源标记（:349-353）；未解析键告警；预览存在且无未解析项时才允许应用 |
| `design-export-task-list.tsx` | 193 | 取消/重试/下载；`readExportPayload`（:133-150）与 `readExportResult`（:152-168）校验任务 payload/result 形状；`TERMINAL_FAILURES = failed\|dead_letter\|canceled`（:19） |
| `design-animation-preview.tsx` | 96 | 只读第二 Fabric 实例（`maxBackingPixels: 1024*1024`，:55），以 `applyAnimationFrame(timeMs)` 30fps 驱动；与属性面板通过 window CustomEvent `ANIMATION_CONTROL_EVENT`/`ANIMATION_STATUS_EVENT`（`lib/design-animation-events.ts`）通信；画布 pointer-down 时暂停（`pauseSignal`，fabric-design-surface.tsx:356） |
| `design-name-button.tsx` | 36 | portalled 改名表单，1–200 字符校验 |
| `design-node-overlay-layer.tsx` | 375 | 在 Excalidraw 上按 `(element + scroll) * zoom`（:92-95）渲染画板预览，64px 视口剔除，4 路并发，预览过期时 30 次 × 1.5s 重试（:175），图片抓取 3 次指数退避（:229-250）；跨标签刷新用 `DESIGN_PREVIEW_REFRESH_EVENT = 'loomic:design-preview-refresh'`（:14/:187），focus/visibilitychange 也会派发；原地改名发 `renameDesign` + `queueDesignPreview`（:306-319） |
| `design-editor-session.tsx` | 2290 | 见 6.6.1/6.6.4/6.6.5；约 40 个 `useState`/`useRef` + 15 个 handler |
| `fabric-design-surface.tsx` | 447 | 见 6.6.2 |
| `fabric-object-editor.ts` | 2426 | 见 6.6.3 |
| `fabric-canvas-lifecycle.ts` | 48 | 见 6.6.2 |
| `design-inline-editor.tsx` | 338 | 见 6.6.1 |
| `inline-artboard-probe.tsx` | 386 | **开发专用原型**（注释 :3 自述 "Development-only experiment. No project API, user document or Agent calls."），状态落 `localStorage["loomic:inline-artboard-probe:v1"]`；是 `FabricCanvasLifecycle` 类型类的唯一直接消费者 |

#### 6.6.7 设计板 REST / WS 契约

`lib/design-api.ts`（`createDesignApiClient`，统一 `Authorization: Bearer`）：

| 方法 | 端点 | 用途 |
|---|---|---|
| GET | `/api/designs/:designId` | `getDesign` → `DesignDocumentDto`（scene、revision、preview_*） |
| POST | `/api/designs` | `createDesign`（需 `canvas_id` + `expected_canvas_revision`） |
| POST | `/api/designs/:id/mutations` | `mutateDesign` —— CAS `expected_revision` + `idempotency_key` + `commands[]` |
| PATCH | `/api/designs/:id/name` | `renameDesign` |
| POST | `/api/designs/:sourceId/copy` | `copyDesign` |
| DELETE | `/api/designs/:id` | `deleteDesign` |
| POST | `/api/designs/:id/restore` | `restoreDesign` |
| GET | `/api/designs/:id/references` | `getDesignReferences`（素材/字体） |
| POST | `/api/designs/:id/preview` | `queueDesignPreview` |
| POST | `/api/designs/:id/exports` | `exportDesign`（服务端大图导出） |
| GET | `/api/jobs?job_type=design_export` | `listDesignExportJobs`（客户端按 design_id 过滤） |
| GET | `/api/jobs/:jobId` | 导出/生图任务查询 |
| POST | `/api/jobs/:jobId/cancel` | 取消导出/生图任务 |
| POST | `/api/jobs/image-generation` | `createDesignImageJob` |
| GET | `/api/jobs?job_type=image_generation` | `listDesignImageJobs` |

`lib/design-resource-api.ts`：`GET /api/design-resources`（status/query/collection/cursor/limit/workspace_id）、`/api/design-resources/:id/content`、`/preview`、`PUT|DELETE /favorite`、`POST /recent`、`GET /api/design-templates`、`/api/design-templates/:id`、`POST /:id/replace-preview`、`POST /:id/replace-apply`、`GET /api/design-text-presets`、`GET /api/design-fonts`、`GET /api/design-fonts/faces/:faceId/content`；管理端 `GET /api/admin/design-catalog/{resources,templates,text-presets,font-families,font-faces,categories,tags}`、`POST .../templates/from-design`、`PATCH .../templates/:id/variables`、`POST .../font-files`、`POST .../{status,delete,restore}`、`GET .../:collection/:id/references`、`POST|GET .../imports`、`GET .../imports/:jobId[/report]`、`POST .../imports/:jobId/{cancel,retry}`。

`lib/design-canvas-image-api.ts` → `POST /api/designs/:id/canvas-image-imports` 与 `.../undo`——**生产环境死代码（仅测试引用）**。素材字节经 `fetchAssetBlob(accessToken, assetObjectId[, {preview, signal}])`（`lib/canvas-elements.ts`）；上传走 `uploadFile` → `POST /api/uploads`。

WS：唯一入站设计事件是 `design.sync`（见 6.6.5）；出站只有 `rpc.response` 与五个 `command`（`agent.run`/`agent.cancel`/`agent.confirm_action`/`agent.retry_tool`/`canvas.resume`）；**无 design.\* RPC**。服务端 `design.sync` 生产者为 `apps/server/src/features/designs/design-outbox-service.ts:67` 与 `realtime-fanout-service.ts:12,89`。

---

## 7. 前后端契约

### 7.1 REST 端点（前端实际调用）

所有请求前缀 `${getServerBaseUrl()}`（`NEXT_PUBLIC_SERVER_BASE_URL`，默认 `http://localhost:3001`），鉴权统一 `Authorization: Bearer <supabase access_token>`。

**身份与工作区**

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/viewer` | 当前用户 + 工作区 + 角色（登录/回调预热、projects/admin 页） |
| PATCH | `/api/viewer/profile` | 改显示名 |
| GET / PUT | `/api/workspace/settings` | 读/写 `defaultModel` |
| GET / POST | `/api/workspace/provider-configs` | 供应商配置列表/创建 |
| PUT / DELETE | `/api/workspace/provider-configs/{id}` | 更新/删除 |
| POST | `/api/workspace/provider-configs/{id}/test` | 连接测试 |
| POST | `/api/workspace/provider-configs/discover-models` | 草稿态模型发现（不落库） |
| POST | `/api/workspace/provider-configs/{id}/discover-models` | 已存在配置的模型发现 |
| GET / POST | `/api/workspace/members` | 成员列表/添加 |
| PATCH / DELETE | `/api/workspace/members/{userId}` | 改角色/移除 |

**项目与画布**

| 方法 | 路径 | 用途 |
|---|---|---|
| GET / POST | `/api/projects` | 项目列表/创建 |
| GET / PATCH / DELETE | `/api/projects/{id}` | 项目详情/改名/绑品牌套件/删除 |
| PUT | `/api/projects/{projectId}/thumbnail` | 缩略图上传（multipart `file`，webp） |
| GET / PUT | `/api/canvases/{canvasId}` | 读画布 / 保存内容（PUT 返回新 `revision`） |
| PUT | `/api/canvases/{canvasId}`（+`keepalive`） | `beforeunload` 兜底保存 |

**会话与消息**

| 方法 | 路径 |
|---|---|
| GET / POST | `/api/canvases/{canvasId}/sessions` |
| PATCH / DELETE | `/api/sessions/{sessionId}` |
| GET / POST | `/api/sessions/{sessionId}/messages` |
| GET | `/api/chat/sessions/{sessionId}/runs?cursor&limit`（limit 1..50） |
| GET | `/api/chat/sessions/{sessionId}/runs/{runId}` |

**素材与图片代理**

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/uploads` | 上传素材（`file` + 可选 `projectId`） |
| GET | `/api/uploads/{assetId}/url` | 签名 URL |
| GET | `/api/uploads/{assetId}/content[?preview=1]` | 取素材字节（Bearer，预览 30s/原图 60s 超时） |
| DELETE | `/api/uploads/{assetId}` | 删除 |
| GET | `/api/proxy-image?url=` | 外部图片 CORS 代理 |
| POST | `/api/images/recognize-text` | OCR（文本替换） |
| GET | `/api/images/layer-backend` | 图层拆分后端可用性 |
| GET | `/api/images/semantic-layer-backend?layer_count=N` | 语义拆分报价 |

**模型与生成**

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/models` | Agent 文本模型列表 |
| GET | `/api/image-models` | 图片模型（`creditCost`、`accessible`、`minTier`） |
| GET | `/api/video-models` | 视频模型（`capabilities`、`limits`、`pricing.rates`） |
| POST | `/api/agent/generate-image` | 直接图片生成 |
| POST | `/api/agent/generate-video` | 直接视频生成（`Idempotency-Key`） |
| POST | `/api/agent/runs` | 创建 run（HTTP 路径，主要在 WS 之外使用） |
| POST | `/api/jobs/image-generation` | 建图任务（所有直接图片操作、文本替换、local_repaint、outpaint、upscale、拆层） |
| POST | `/api/jobs/node-image-generation` | 节点生图提交 |
| GET | `/api/jobs/node-image-generation/{requestId}?canvas_id&element_id` | 节点提交状态只读恢复 |
| GET | `/api/jobs/{jobId}` | 任务状态轮询 |
| GET | `/api/jobs?job_type=design_export\|image_generation` | 任务列表 |
| POST | `/api/jobs/{jobId}/cancel` | 取消 |
| POST | `/api/jobs/{jobId}/restore-to-canvas` | 显式放回画布 |

**设计 / 设计资源**

`POST /api/designs`；`GET|DELETE /api/designs/{id}`；`PATCH /api/designs/{id}/name`；`POST /api/designs/{id}/mutations`；`POST /api/designs/{source_design_id}/copy`；`POST /api/designs/{id}/restore`；`GET /api/designs/{id}/references`；`POST /api/designs/{id}/preview`；`POST /api/designs/{id}/exports`；`POST /api/designs/{id}/canvas-image-imports`；`POST /api/designs/{id}/canvas-image-imports/{operationId}/undo`；`GET /api/design-resources`（+/{id}/content、/preview、/favorite、/recent）；`GET /api/design-templates`（+/{id}、/{id}/replace-preview、/{id}/replace-apply）；`GET /api/design-text-presets`；`GET /api/design-fonts`（+/faces/{faceId}/content）；`GET /api/fonts?search&category`；`/api/admin/design-catalog/{resources|templates|text-presets|font-families|font-faces|categories|tags}`；`/api/admin/design-catalog/templates/from-design`；`/api/admin/design-catalog/templates/{id}/variables`；`/api/admin/design-catalog/font-files`；`/api/admin/design-catalog/status`；`/api/admin/design-catalog/delete|restore`；`/api/admin/design-catalog/{collection}/{id}/references`；`/api/admin/design-catalog/imports`（+`/{jobId}/report`、`/{jobId}/{action}`）。

**技能 / 提示词库 / 品牌套件 / 计费**

`GET|POST /api/skills`；`GET|PUT|DELETE /api/skills/{id}`；`GET /api/skills/{id}/files`；`GET|POST /api/workspaces/skills`；`PATCH|DELETE /api/workspaces/skills/{skillId}`；`GET /api/skills/marketplace/search?q&page&limit`；`GET /api/skills/marketplace/detail?name`；`POST /api/skills/marketplace/install`；`POST /api/skills/import`；`GET /api/prompt-library?q&source&category&offset&limit`；`GET|POST /api/brand-kits`；`GET|PATCH|DELETE /api/brand-kits/{id}`；`POST /api/brand-kits/{id}/duplicate`；`POST /api/brand-kits/{kitId}/assets`；`PATCH|DELETE /api/brand-kits/{kitId}/assets/{assetId}`；`POST /api/brand-kits/{kitId}/assets/upload`；`GET /api/credits`；`GET /api/credits/transactions?limit=`；`POST /api/credits/claim-daily`；`POST /api/payments/checkout`；`GET /api/payments/subscription`；`POST /api/payments/cancel`；`POST /api/payments/change-plan`。

### 7.2 WebSocket 协议

**连接**：`hooks/use-websocket.ts:107`
```
ws(s)://<serverBase>/api/ws?token=<access_token>&connectionId=<sessionStorage["ws_connection_id"]>
```
重连：指数退避 `min(30s, 1s · 2^n)`；关闭码 `4001` = 鉴权被拒（会用新 token 重试）；`getToken()` 返回 null 时每 500ms 重试。

**客户端 → 服务端**（信封 `{ type:"command", action, payload, accessToken, requestId? }`）

| action | payload | 触发点 |
|---|---|---|
| `agent.run` | `RunCreateRequest`（`sessionId, conversationId, userMessageId, prompt, activeDesignId?, canvasSelection?, canvasId, accessToken, attachments?, mentions?, imageGenerationPreference?, videoGenerationPreference?, model?, executionMode`） | `chat-sidebar.tsx:1222` |
| `agent.cancel` | `{ runId }` | `chat-sidebar.tsx:547` |
| `agent.confirm_action` | `{ confirmationId, decision: "confirm"\|"cancel" }` | `chat-sidebar.tsx:579` |
| `agent.retry_tool` | `{ toolExecutionId, requestId }` | `chat-sidebar.tsx:826` |
| `canvas.resume` | `{ canvasId, lastSeq: 0 }`（**`lastSeq` 硬编码 0，无真正重放**） | `chat-sidebar.tsx:1668` |
| `rpc.response` | `{ id, result? \| error? }` | `use-websocket.ts:263/267` |

**服务端 → 客户端**

| 消息 | 处理 |
|---|---|
| `{ type:"event", event: StreamEvent }` | 分发给所有 `onEvent` 订阅者（异常隔离） |
| `{ type:"design.sync", designId, revision, … }` | `designSyncEventSchema` 校验后分发给 `onDesignSync`；画布 100ms 防抖刷新 + 设计板按 revision 合并 |
| `{ type:"command.ack", action, payload, requestId? }` | `agent.run` 走专用 `pendingRun` 匹配；其余按 `action` 查 `ackListeners`；`agent.confirm_action` 且 `payload.status==="accepted"` 时**刻意保留监听器**等后续 `applied` |
| `{ type:"error", action, code, message }` | `agent.run` → `pendingRun.onError`；其他 action → 合成一个 `{status:"failed"}` 的 ack 回调 |
| `{ type:"rpc.request", id, method, params }` | 查 `rpcHandlers`（唯一注册：`canvas.screenshot`），回 `rpc.response` |

**StreamEvent（12 种）**（`packages/shared/src/events.ts:152-165`）
`run.started`、`message.delta`、`thinking.delta`、`plan.updated`、`tool.started`、`tool.completed`、`tool.failed`、`run.canceled`、`run.completed`、`run.failed`、`canvas.sync`、`billing.error`。

`ContentBlock` 类型（`packages/shared/src/contracts.ts`）：`text`、`thinking`、`plan`、`tool`、`image`、`mention`（`image-model`/`brand-kit-asset`/`skill`）、`clarification`。

### 7.3 WS RPC 方法

| method | 参数 | 返回 | 注册位置 |
|---|---|---|---|
| `canvas.screenshot` | `{ mode:"full"\|"region"\|"viewport", region?, max_dimension=1024 }` | `{ url: png dataURL, width, height }` | `canvas-editor.tsx:583` **（全站唯一）** |

---

## 8. 值得注意的工程细节 / 潜在问题

### 8.1 体量与"上帝组件"

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/components/design/fabric-object-editor.ts` | **2426** | Fabric 对象编辑全逻辑 |
| `src/components/design/design-editor-session.tsx` | **2290** | 约 12 个 `useEffect`、20+ handler，一个组件承载设计板全部会话逻辑 |
| `src/components/chat/tool-block-view.tsx` | **2114** | 工具块渲染 + 悬浮详情面板 + 十余种卡片变体 |
| `src/components/canvas-tool-menu.tsx` | **2098** | 约 30 个 `useState`、9 个子面板 |
| `src/components/chat-sidebar.tsx` | **2092** | 约 25 个 state、14 个 ref、12 个 effect |
| `src/lib/design-resource-api.ts` | 1019 | 设计资源 + 管理后台全部端点 |
| `src/lib/server-api.ts` | 1116 | 全部通用端点 |
| `src/components/settings/design-resource-admin-section.tsx` | 1645 | 7 个 tab × 列表/创建/导入/状态机 |
| `src/components/canvas-editor.tsx` | 927 | 画布宿主 |
| `src/lib/home-example-seeds.ts` | 40 KB / 550 行 | 硬编码示例内容 |

再加上设计板的 `design-properties-panel.tsx` 1130、`design-editor-overlay.tsx` 1040、`design-resource-api.ts` 1019——**5 个 2000+ 行文件全部集中在设计板与聊天/画布工具条**，这是本仓库结构风险最集中的区域。

`chat-sidebar.tsx` 尤需注意：`components/chat/index.ts` 的文件头注释声称这些巨物**已经被拆分**（并引用了旧行数 "chat-message.tsx (1205 lines) / chat-sidebar.tsx (936 lines)"），但侧栏实际已回涨到 2092 行——注释与现实脱节。

### 8.2 死代码与失效路径

- **组件**：`components/canvas-ai-toolbar.tsx`、`components/canvas-image-gen-panel.tsx`（互相引用，无外部导入）；`components/settings-layout.tsx`（被 `settings/page.tsx` 内联 tab 条取代）；`components/credits/model-tier-badge.tsx`；`components/chat/message-list.tsx`、`components/chat/message-error-boundary.tsx`（仅被 barrel 导出，侧栏自己内联了滚动容器 `chat-sidebar.tsx:1905-1975`）；`components/execution-mode-selector.tsx`。
- **Hook**：`use-execution-mode.ts` 因 `ExecutionModeSelector` 无人使用而失去唯一消费者。
- **模块（设计板）**：`lib/design-document-controller.ts`（476 行）与 `lib/design-canvas-image-api.ts`（154 行）**在生产环境无任何调用者**，只被 `test/` 引用；`design-inline-editor.tsx` 的 `legacy` 分支（:39/:138-139）长期保留整屏覆盖层作为回退。
- **函数**：`server-api.ts` 的 `fetchSkillFiles`、`discoverProviderModels` 有导出无调用；`canvas-tool-menu.tsx:70` 的 `uploadFile` 与 `canvas-editor.tsx:19` 的 `fetchAsDataURL` 是未使用导入；`canvas-tool-menu.tsx` 中 `"region-matting"`/`"erase-transparent"`/`"smart-erase"` 分支在画布侧不可达；`image-eraser-overlay.tsx` 的 `_mode` 参数与非 repaint 模式在画布侧未用。
- **`chat-message.tsx:37` 仍保留 `@deprecated Use ToolBlock from @loomic/shared instead`** 的 `ToolActivity` 再导出。
- **空实现**：`canvas-bottom-bar.tsx:329` 的 "100%" 透明度输入框是只读装饰；`image-generator-panel.tsx:218-221` 的参考图上传提交被显式拒绝；`brand-kit-editor.tsx:183-191` 的 "Extract from URL" 标注 "disabled Phase 1"；`image-selection-toolbar` 中 `edit-region`/`panorama` 标 `available: false`。

### 8.3 功能与文案不一致

1. **执行模式被硬编码为 `thinking`**：`chat-sidebar.tsx:1000-1004` 强制 `currentExecutionMode = "thinking"` 并**丢弃** `executionModeOverride` 实参；`home-prompt.tsx:149` 同样硬编码 `"thinking"`；`use-execution-mode.ts` 仍默认 `"fast"`；`INITIAL_EXECUTION_MODE_KEY` 在 `chat-sidebar.tsx:1602-1603` 被读出后丢弃。UI（`ExecutionModeSelector`）与存储键实际已失效，但 `RunHistoryPanel` 仍会为历史 run 渲染 "Fast"。
2. **两套定价真相**：`landing/pricing-preview.tsx`（¥99/¥299、"无限 AI 生成"、"每月 10 次 AI 生成"）与 `pricing-data.ts`（$ 价格 + credit 配额）互相矛盾。
3. **支付渠道文案错误**：`pricing-data.ts` 的 FAQ 写"我们通过 Stripe 接受…"，而实际实现是 LemonSqueezy（`payments-api.ts` + `layout.tsx` 加载 `lemon.js`）。
4. **品牌双名**："Cromic" 是用户可见品牌（`layout.tsx` metadata、landing、home、pricing、auth-shell、app-sidebar、chat-sidebar "Cromic Agent"），内部代号仍是 "Loomic"（`@loomic/*` 包名、`LoomicLogo`、`LoomicSceneV1`、`loomic:*` 存储键与事件名、`loomic-layer-*` customData）。
5. **语言不统一**：整体中文，但 `login-form`/`register-form`/`auth-shell`、`brand-kit` 大部分标签（"Brand Kit"、"Colors/Fonts/Logos/Images"）、`credit-*`、`billing-section`、`pricing-data.ts` 的 feature 文案仍为英文；`<html lang="zh-CN">` 与 Excalidraw `langCode="zh-CN"` 已对齐。无 i18n 框架，全部文案内联。
6. **`/admin` 对所有角色可见**：`app-sidebar.tsx:25-56` 把"管理后台"放进 `TOP_NAV_ITEMS`（桌面 rail + 移动底栏都渲染），真正的门禁只在 admin 页面内部。
7. **Landing 链接悬空**：`landing-footer.tsx` 的 `/changelog`、`/roadmap`、`/docs`、`/blog`、`/community`、`/templates`、`/about`、`/careers` 以及社交链接（裸 `github.com`/`x.com`/`discord.com`）在 `src/app` 中不存在。
8. **`/pricing` 的 `#features` 锚点挂在"功能对比"区块上**（`pricing/page.tsx:91-93`），而非功能区块。

### 8.4 重复实现

- **四个近乎相同的 `handleErrorResponse`**：`server-api.ts`、`payments-api.ts`、`credits-api.ts`、`brand-kit-api.ts`（后者甚至在注释里承认是"mirrored from server-api.ts, not exported there"）。
- **画布小程序三兄弟**：`canvas-image-generator.ts` / `canvas-video-generator.ts` / `canvas-image-replacement.ts` 的 create/is/update/resize/delete 五件套高度雷同。
- **`throttle` 复制粘贴**：`canvas-layers-panel.tsx:18-35` 与 `canvas-files-panel.tsx:16-33`。
- **操作 → 中文文案的阶梯**在 `canvas-tool-menu.tsx` 重复 4 次（`:1326-1429`），30×1s 完成轮询重复 3 次（`:1345`、`:1557`、`:1636`）。
- **两个积分挂件**：`credits/credit-balance.tsx` 与 `credits/credit-header-button.tsx` 各自实现套餐配色、领取按钮与 popover。
- **`formatDate` 重复**：`credit-usage-history.tsx:47` 本地再实现一份，遮蔽 `lib/utils.formatDate`。
- **Logo 重复**：`landing/floating-nav.tsx:15-43`、`landing/landing-footer.tsx` 各自内联 SVG，未复用 `components/icons/loomic-logo.tsx`。
- **流事件处理重复**：`chat-sidebar.tsx` 的发送监听（`:1157-1204`）与重连监听（`:1721-1759`）都实现了 `tool.completed` → artifact 回调 + `canvas.sync` + 终态处理。
- **`reloadMessages` 靠临时定时器驱动**（`:649` 8s、`:752` 1s、`:776` 500/1500/4000ms），而非事件驱动。
- **设计板**：`readDesignNodeMetadata` 存在两份（`design-node-helpers.ts:30` 带 `isDeleted`/候选判断，`canvas-design.ts:84` 仅 schema 校验）；`imageOperationLabel`（session `:2061`）与 `OPERATION_LABELS`（`design-image-tools.ts:26`）重复；GIF/静态导出路径（session `:1393-1559`）自己手工构造并拆解 `FabricObjectEditor` + `Canvas`，绕过共享生命周期；`inverseForCommand()`（`fabric-object-editor.ts:2137-2220`）对未枚举的命令一律回退 `{action:"scene.replace", scene: previousScene}`（整场景反向，安全但重）；`applyCommandsToScene()`（`:2233-2336`）是同一套命令语义在场景层的**第二份实现**。

### 8.5 类型安全与构建配置的松动处

- `next.config.ts` `typescript.ignoreBuildErrors: true`：`next build` 不拦类型错误。
- Excalidraw API / 元素在画布层几乎全是 `any`（`excalidrawApi: any`、`elements: any[]`、`appState: any`），多处带 `biome-ignore lint/suspicious/noExplicitAny`。
- `use-chat-stream.ts:48-91` 因为 `plan.updated` 不在 `switch` 的判别联合里，用 `(event as {type:string})` + 双重 cast 合成 `planBlock`；`tool.started/completed/failed` 用交叉类型拓宽以读取 `planId`/`planStepId`。
- `server-api.ts:998` `fetchSkillFiles` 返回 `as any`。
- 三个 `eslint-disable-next-line react-hooks/exhaustive-deps`（`use-chat-sessions.ts:209`、`canvas/page.tsx:400`、`chat-sidebar.tsx:2042` 的 a11y backdrop）；**整个 `src` 无 TODO/FIXME/HACK/XXX，也无 `@ts-ignore`/`@ts-expect-error`**——债务集中在结构与类型精度，而非标记注释。
- **设计板的隐式契约（新人必知）**：`patchToSceneKey`（`fabric-object-editor.ts:1962-1982`）必须与 shared 的 zod patch schema 保持同步，未知 key 会**静默按 identity 透传**（`:1993`）；`FabricDesignSurface` 只有在 `onCanvasReady` resolve **之后**才订阅 `object:added/modified/removed` → `onDirtyChange`（`:290-296`），注释："Hydration belongs to the caller and must not make a freshly opened document dirty"——破坏这个顺序会让刚打开的文档立刻变脏；窄屏只读阈值是硬编码的 1023px（`design-editor-overlay.tsx:151/:594`）。
- **渲染期副作用**：`design-editor-session.tsx:1728` 在 render 中给 `reloadKeepRef.current` 赋值；`fabric-design-surface.tsx:88/:102-110` 也在 render 期写 ref。
- **设计板的 props 透传过深**：`DesignEditorOverlayProps` 约 45 个字段（`:65-136`），`DesignInlineEditor` 全量转发并重复实现键盘/事件处理（`:117-135`）。
- **设计板轮询统一为 2s 且无退避**：导出任务（session `:226-248`）、生图任务（`:704-753`）、覆盖层 250ms 补偿 + 1.5s 过期重试（`design-node-overlay-layer.tsx:134/:177`）。
- **设计板有实测覆盖**：`test/design-document-controller.test.ts`、`design-node-helpers.test.ts`、`design-editor-session.test.tsx`（`:798`/`:854` 分别断言"干净时 reload"与"脏时冲突提示"）、`websocket-design-sync.test.ts`；E2E 有 `stage3/stage5/stage6/stage8` 四个 spec。

### 8.6 环境变量与特性开关

| 变量 | 位置 | 说明 |
|---|---|---|
| `NEXT_PUBLIC_SERVER_BASE_URL` | `lib/env.ts:6` | 后端基址，默认 `http://localhost:3001` |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `lib/env.ts:23,29`、`lib/supabase-browser.ts:10-11` | 缺一即抛错 |
| `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED` | `login-form.tsx:31` | `==="true"` 才显示 Google 登录 |
| `NEXT_PUBLIC_LOOMIC_DESIGN_IMPORT_DIRECTORY_ENABLED` | `admin/page.tsx:129` | `==="true"` 才启用"服务器目录导入" |
| `NODE_ENV` | `dev/inline-artboard/page.tsx:5`、`error-boundary.tsx:88` | 开发页 404 / 开发态错误详情 |
| `LOOMIC_NEXT_DIST_DIR`、`LOOMIC_NEXT_SERVER_MODE`、`LOOMIC_LOCAL_BUILD_SERIAL` | `next.config.ts` | 构建期开关（非运行时） |
| `LOOMIC_E2E_*` | `playwright.config.ts` | E2E 端口/外部栈 |

**没有通用特性开关框架**。行为门禁主要靠：模型元数据（`accessible`/`minTier`/`limits`/`pricing`）、服务端能力探测（`/api/images/layer-backend`）、`available: false` 的工具条项，以及一批 `localStorage`/`sessionStorage` 键（`loomic:agent-model`、`loomic:image-model-preference`、`loomic:video-model-preference`、`loomic:image-toolbar:v2`、`loomic:execution-mode`、`loomic:handled-confirmation:*`、`ws_connection_id`、`loomic:initial-*`）。

### 8.7 数据持久化与竞态上的真实缺口

1. **`storageUrl` 不回写**：画布保存载荷的文件条目只写 `assetId`/`storageRef`（且仅来自初始加载的 `initialFilesRef`），`storageUrl` 读而不写，本地新生成的素材绑定在后续保存中丢失。
2. **`beforeunload` 的 `keepalive` 受限**：内联 dataURL 很大的画布会超过浏览器 64KiB 的 keepalive 额度（代码注释已承认）。
3. **`canvas.resume` 的 `lastSeq` 恒为 0**：握手名义上支持事件重放，前端却从不推进序号，因此断线期间的事件实际依赖 `reloadMessages`（`GET /api/messages`）与临时定时器补齐，而不是真正的增量重放。
4. **三条独立的"重连"路径并存**：`use-websocket` 自带指数退避重连、`chat-sidebar` 的 `scheduleActiveRunRecovery` + `resumeRequest` + `terminalRecoveryRef`、以及 `observedGenerationJobs` 驱动的任务轮询——三者边界不易维护。
5. **画布内容需要本地"复制保护"**：`canvas-design.ts::tombstonePastedDuplicateDesignNodes` 在 `onChange` 里把粘贴出来的重复设计节点打成墓碑，并弹中文提示——这是一个用数据校验替代 UI 约束的补丁式设计。
6. **前端鉴权仅是 UX**：`(workspace)/layout.tsx` 的跳转、`/admin` 的角色判断、`settings` 的 providers tab 白名单全部客户端执行；后端必须自行强制（注释也如此声明）。

### 8.8 仓库卫生

- `apps/web/tsconfig.json` 的 `include` 列了 **100+ 个 `.next-*` 目录**的 `types/**/*.ts`（`.next-e2e-3000/3100/3200/3300/3310/3400`、`.next-inline-probe`、`.next-local-replica`、`.next-stage7-review-3200`、`.next-stage8-e2e-*`，以及约 90 个 `.next-production-*` 主题目录），且存在重复条目（`.next-e2e-3400` 出现 4 次）。
- `apps/web` 根目录下同时存在 `tsconfig.tsbuildinfo` 与 `next-env.d.ts` 的构建残留；`test/` 与 `src/` 下同时存在测试文件（如 `src/lib/chat-clipboard.test.ts`、`src/components/design/design-selection-toolbar.test.tsx`、`src/hooks/use-chat-sessions.test.ts` 与集中式 `test/*`）。
- `scripts/` 下 24 个一次性验收脚本（`check-*.mjs`、`run-*-browser.mjs`、`verify-*.mjs`、`create-native-size-qa.mjs`），长期沉淀为本地工作流的一部分，但未纳入 `package.json` 脚本入口（除 `run-web-typecheck.mjs`）。
- Playwright E2E 命名呈"阶段"演进痕迹：`stage3-design-board` → `stage5-design-resource` → `stage6-agent-design` → `stage7-design-advanced` → `stage8-browser-release`，另有 20 个 `*-local.spec.ts`（面向本机全栈的验收）。

### 8.9 值得肯定的工程设计

- **契约层扎实**：`@loomic/shared` 用 Zod 定义 `StreamEvent`、WS 协议、design 契约与 DTO；前端在 `server-api`/`design-api`/`design-resource-api`/`prompt-library-api`/`node-image-generation` 等处以 `schema.parse` 校验响应，把"后端返回格式漂移"转成显式错误而非静默错渲染。
- **付费路径的幂等与"状态未知"处理**：`node-image-generation.ts` 的两阶段提交（先持久化画布再提交任务）+ `request_id` 复用 + `submitting/unknown/accepted/rejected` 状态机 + `confirmedRejectionCodes` 白名单，是明确针对"POST 响应丢失不能重复扣费"设计的。
- **竞态防护成体系**：`canvasLoadGenerationRef`/`canvasSyncGenerationRef`（画布切换）、`messageVersionRef` + `reloadRequestRef`（会话快照回写）、`listSequence`/`detailSequence`（技能）、`submissionVersionRef` + `submissionStartingVersionRef`（重复提交）、`completedRunIdsRef`/`completedResumeRetriesRef` + `handledClarificationMessageIdsRef`（事件重放）、`consumedImageCommandRef`、`observedGenerationJobs`。
- **`design.sync` 的 revision 门禁**（`:520`）保证过期/重复同步不会覆盖本地编辑，冲突时给出可操作的中文提示。
- **性能细节**：`ChatMessage` 对 `contentBlocks` 做引用相等比较（`chat-message.tsx:145-160`）；`markdown-renderer` 的 `markdownComponents`/`remarkPlugins` 提到模块级常量；`ToolBlockView`/`ChatImage`/`ImagePill`/`MentionPill` 均 `memo`；`MemoizedCanvasToolMenu`；`chat-input` 的 `selectionSummary` memo；画布文件视口懒加载 + 并发 4 + 3 次退避重试；缩略图与自动保存分别 10s / 1.5s 防抖且删除绕过防抖。
- **无障碍与可用性**：工作区 skip-link、对话框 Esc 关闭、Toast 悬停暂停倒计时、`useReducedMotion` 覆盖全部 landing 动效、IME 安全的 Enter 提交（`!e.nativeEvent.isComposing`）、移动端 48px 触控目标与 `env(safe-area-inset-bottom)`。
- **Fabric 生命周期的正确抽象**：因为 Fabric 7 的 `dispose()` 是异步的，`fabric-canvas-lifecycle.ts` 用一个 promise 串行化的全局单例把 mount/dispose 排队，并对"替换已挂载"的迟到 cleanup 做 no-op——这是针对 React StrictMode 双挂载的精确修复，而不是绕过。
- **渲染预算与坐标系统分离**：`FABRIC_EDITOR_MAX_BACKING_PIXELS = 16M` + `renderScale` 限制 backing store，同时用 `setDimensions(..., {cssOnly:true})` 与 `setViewportTransform` 保证"呈现缩放"绝不污染文档坐标系；`getObjectViewportBounds()` 显式镜像 Fabric 的换算，供 DOM 覆盖层复用。
- **保存语义的显式化**：设计板命令历史"**一次手势一个请求**"的取舍写进了注释（服务端对每条命令同时校验输入与最终场景，合并会破坏 CAS），失败请求被**冻结**并可用原幂等键重放；画布侧把"删除墓碑签名变化 ⇒ 防抖 0ms"编码成 `canvas-save-policy.ts` 的纯函数并配有单测。
- **Agent 与编辑器的边界清晰**：Agent 全部在服务端改文档，前端只通过 `design.sync` 收敛；干净则整体 reload，脏则保留本地并暴露冲突三选一（重试原请求 / 重载保留本地 / 放弃本地），并先做 2 次自动重基。
