# Agent 编排与 Skills 调度审计（2026-09-18）

范围：`薄 agent + 厚 Skills` 改造完成后，**编排、Skills 自动调用、意图识别、上下文流转**四条链路的最终审查。
方法：代码级审查 + 用测试固化结论 + 全量 typecheck/测试/编码审计。本轮**没有新的付费模型调用**，结论全部来自代码与离线测试；此前那次真实生图验收（1 张、`localCreditsDeducted: 0`）不重复消费。

---

## 一、本轮发现并修复的四个问题

### 1. `compose_skills` 的能力回执缺口（编排 / 自动调用）

`mastra-agent.ts` 里服务端可识别能力的三条回执——`nonstandard_size_skill_loaded_run_id`、`promo_library_auto_run_id`、`session_loaded_skill_slug`——只在 `use_skill` 分支写入，`compose_skills` 只写了「读过哪些技能」。而 `compose_skills` 恰恰是 agent 指令推荐、且唯一能「主技能 + 辅助技能」一起读的路径。后果有三个，都是真实可复现的：

- 模型用 `compose_skills` 读了 `nonstandard-image-size`，付费提交仍被判 `image_nonstandard_size_skill_required`——**技能正文确实读到了，却被当成没读**，这正是「用户很懵」的那类错误；
- 组合 `game-promo-visuals` 不会启用工作区素材库自动路径（该能力的声明者只有这一个包）;
- 组合不会写会话的 `activeSkill`，下一轮「继续」丢掉交付物技能。

修复：两条读取路径共用一个 `applyLoadedGuide(name, instructions)`；`compose_skills` 对 **primary + helpers 全部**应用能力回执，但只有 **primary** 成为 sticky 交付物（辅助技能不得顶替主技能）。同一条规则只有一处实现，两条路径无法再漂移。

固化：`mastra-agent.test.ts` 改为三态循环——**没读 / `use_skill` / `compose_skills`**，分别断言能力回执、sticky 技能、已读集合。

### 2. 素材库自动附加的触发来源（R1 边界）

`attachWorkspaceLibrary` 在本轮改造中被从「唯一路由赢家」放大为**关键字候选全集**。候选只是给模型看的提示，而「没读到的技能等于没选」是本设计的核心；由词触发等于把刚拆掉的路由搬回来——一次运行可以在完全没读到某个包的方法时，替它附加素材库引用。

修复：改为**本轮声明（用户点名，或延续轮中会话已采用的技能）或模型实际读取**（读取回执由 run 自己记录，且现在 `use_skill`/`compose_skills` 都算）。抽成纯函数 `declaresWorkspaceLibrary` 并固化语义。

### 3. 观测诚实性：`[skill-dispatch-outcome]`

薄 agent 之后该日志的 `hinted` 记的是「声明集」（点名/延续记住/确定性启用），但注释承诺的 `hintedNeverRead` 是「**关键字命中却未被模型读取**」这一维护信号——也就是说，一个包的 `routing.keywords` 命中了、模型却读了别的，恰恰不再产生任何信号，维护信号事实上消失了；同时延续轮里「模型没有重读上一轮已采用的技能」这种正常行为会被误报。

修复：拆成 `candidates`（用户原话命中的候选）/ `declared`（点名或已采用）/ `read` / `candidatesNeverRead`（真正的维护信号）/ `readNothing`，与注释一致。

### 4. 契约与注释的过时表述

`packages/shared/src/skill-runtime-contracts.ts` 是**技能包作者读的契约**，其中 `routing` 仍写着「auto-select this Skill as the primary one」「the runtime preloads every matching helper ALONGSIDE the primary Skill」。新增 skill 包只要插进来就生效，靠的正是这份契约准确，因此按现状重写为「候选提示 + tier 只决定如何报告与不得成为 sticky」。同时清掉 `mastra-runtime.ts`、`design-turn-intent.ts`、`mastra-agent.test.ts` 中残留的「预载 / 唯一主技能 / 路由赢家」表述。

---

## 二、四条链路的结论

- **编排**：runtime 只保留技能目录、工具面、授权/计费闸门与安全底线。确定性启用只剩两类，且都不是路由：用户原话给出非标准尺寸 → **方法**可用（比例授权仍是独立闸门）；点名/已采用的技能 → 素材库路径。付费档位（hd/ultra/2K/4K）与出图数量仍由服务端从**用户本轮原话**判定——规则 R1 明确「鉴权、计费」属于服务端保留的栅栏，模型不能给自己授权 4K，这与「意图识别下沉」并不冲突。
- **Skills 自动调用**：目录（每包自带 `whenToUse`）常驻 + 候选提示 → 模型自行 `list_skills` / `use_skill` / `compose_skills`。两条读取路径的正文都不受压缩预算影响（`METHOD_READ_TOOL_NAMES`），`discover_tools` 只负责把 `compose_skills` 之类的工具放进可见面。
- **意图识别**：四个标签 + 只在不确定回合调用的模型分类器 + 确定性回退（模型不可用时标注 `fallback`）。`new_generation` 只有在**本轮真实写入回执**存在时才替换会话系列，因此误分类不会抹掉用户已记住的风格/尺寸/素材。
- **上下文流转**：series / style / sizes / materialAssetIds / unfinished_outputs 都建立在「真实回执优先，原话次之」之上；`unfinished_outputs` 在 `finally` 中按 run 快照写入或清空，覆盖用户中途停止的情形。修复 1 之后，`compose_skills` 也会写 `activeSkill`，延续轮的不再丢技能。

## 三、验证

- server：246 个文件 / 1937 项测试通过；typecheck 11/11 批通过（500 roots）。
- web：119 / 782 通过。shared：17 / 243 通过。
- UTF-8 编码审计（严格解码 + BOM + U+FFFD + 乱码标记）覆盖全部改动文件，干净。
- 定向证据：`mastra-agent.test.ts`（三态读取回执）、`mastra-runtime-context.test.ts`（素材库触发语义）、`mastra-agent.test.ts`（压缩不得丢弃任一读取路径的正文）。
