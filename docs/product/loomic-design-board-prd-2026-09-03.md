# Loomic 原生设计画板 PRD

> 文档状态：Final / Approved v1.1（独立 PM Agent 二审 PASSED）  
> 日期：2026-09-03  
> 产品名称：设计画板（Design Board）  
> 适用范围：Loomic Web、Server、Worker、Agent、后台管理  
> 实施原则：独立设计与开发，不复制或依赖参考项目的业务代码、Vue UI、静态清单或数据结构；参考项目仅用于确认功能范围。设计编辑器确定使用精确版本 `fabric@7.4.0`，Loomic 自主定义 UI、场景适配器、数据协议、资源体系和 Agent 协议。

## 1. 产品结论

Loomic 将在现有 Excalidraw 无限画布中新增一种“设计画板节点”。用户可以创建任意逻辑尺寸的设计，在独立的大浮层编辑器中使用模板、文字模板、字体、图片、SVG和自采集素材完成排版，也可以让 Agent 查看并修改设计、搜索资源、套用模板，以及把 AI 生成图片直接插入指定设计。

产品采用两层画布，Fabric.js 是首版唯一设计引擎，不保留第二实现分支：

```text
Excalidraw 无限画布（组织、摆放、关联内容）
  └─ Design Board 节点（轻量预览）
       └─ 独立设计编辑器（固定逻辑尺寸、可编辑图层）
```

设计节点默认只渲染预览图。双击节点后，在全屏或大浮层中打开编辑器，并仅挂载当前一个设计引擎实例。设计文档、资源引用和版本独立保存，Excalidraw 节点只保存 `designId`、revision 和预览引用。

## 2. 背景与问题

当前 Loomic 擅长无限画布编排、AI 图片生成、视频生成和 Agent 操作，但缺少固定尺寸、可精细排版、可复用模板的设计环境。用户只能把最终图片放在无限画布上，无法继续编辑其中的标题、Logo、背景和装饰元素。

参考项目验证了以下需求具有实际价值：

- 自定义画板宽高和常用尺寸预设。
- 模板、素材、字体和文字效果资源库。
- 图片、SVG、文字、形状的图层化编辑。
- 对齐、组合、层级、锁定、裁剪、蒙版和导出。
- 将完整设计保存为可继续编辑的结构化场景。

但参考项目的 Vue 架构、静态大 JSON、全局 DOM 依赖、前端内存分页及不完整 Agent SDK不符合 Loomic 的 React、工作区权限、私有资产、异步任务和服务端 Agent 架构，因此不直接复用。

## 3. 产品目标

### 3.1 核心目标

1. 用户可以在无限画布中创建并管理任意尺寸的可编辑设计。
2. 用户可以使用平台公共资源和工作区私有资源。
3. 管理员可以导入、采集、审核、分类和发布模板、字体、文字模板及素材。
4. Agent 能以结构化命令读取和修改设计，不依赖模拟点击。
5. AI 图片生成继续使用 Loomic 现有供应商、模型、任务、积分和资产存储链路。
6. 在大型无限画布中保持可接受性能，不让每个设计节点常驻编辑器实例。
7. 为未来裁剪、蒙版、抠图、擦除、图层拆分和服务器大尺寸导出预留稳定扩展面。

### 3.2 成功标准

- 阶段 3 通过后，用户可以从工具栏在 3 次操作内创建空白设计；资源阶段完成后可在 3 次操作内从模板创建。
- 创建、编辑、关闭、刷新后，设计内容和无限画布节点位置均正确恢复。
- Agent 能在一次任务中定位目标设计、生成图片并插入指定图层位置。
- 模板和素材列表按需分页，不下载全量资源清单。
- 未激活的设计节点只加载预览，不创建 Fabric Canvas。
- 所有设计对象使用稳定 ID，人工操作和 Agent 操作进入同一历史和版本系统。
- 任何设计和模板使用中的资产不会被素材清理任务误删。

## 4. 非目标

第一版不包含：

- 完整 Photoshop 能力。
- PSD/PDF 导入导出。
- CMYK、专色、出血和专业印刷色管理。
- 视频时间轴、音频和动画设计。
- 多人实时光标协作。
- 移动端完整编辑体验。
- 无限尺寸的浏览器端无保护导出。
- 自动公开来源和授权不明确的历史资源。
- 首版 mm、cm、DPI、项目级 editor 角色和项目级 ACL；首版权限继承现有 workspace 角色模型。

## 5. 已确定的产品决策

### 5.0 引擎与协议

- 设计引擎确定为 `fabric@7.4.0`，依赖使用精确版本，不使用 `^` 或 `~`；Node.js 基线为 20 及以上。
- Fabric升级必须单独完成序列化、文字、组合、事件、导出与销毁回归。
- Loomic 场景协议不等同于 `canvas.toJSON()`；所有读写通过 `design-scene-adapter` 在白名单场景和 Fabric 实例之间转换。
- Loomic 坐标统一为左上角 `x/y`、逻辑 `width/height` 和角度制 `rotation`。适配器负责处理 Fabric 的原点和内部属性差异。
- 业务权限、授权、revision、审计和临时 URL不得写入 Fabric 对象。

### 5.1 编辑模式

采用“双击节点后在全屏或大浮层编辑”的方式。

- 无限画布负责节点的移动、缩放、连接和编排。
- 进入编辑模式后，快捷键、滚轮、拖动和选择事件交给设计编辑器。
- 退出编辑模式后，事件控制权交还 Excalidraw。
- 第一版不支持直接在缩小的无限画布节点内部持续编辑。

### 5.2 资源作用域

采用两层资源：

- 平台公共资源：平台管理员维护，所有可授权用户可用。
- 工作区私有资源：工作区 owner/admin 上传和管理，仅工作区成员可用。

同名资源不互相覆盖。搜索结果显示来源，工作区资源默认优先。

### 5.3 历史资源处理

参考项目中的模板、字体和素材只作为导入候选：

- 首次进入“待审核”状态。
- 完成文件校验、去重、来源补录和授权审核后才能发布。
- 测试字体、重复字体、异常格式和无法确认授权的内容默认不发布。

### 5.4 标识语义

- `assetObjectId`：`asset_objects.id`，表示对象存储中的一个受保护二进制文件。
- `resourceId`：`design_resources.id`，表示可搜索、分类、审核和发布的资源目录记录；它引用原始 `assetObjectId`，可另有缩略图资产。
- `previewAssetObjectId`：设计或模板最新预览对应的 `asset_objects.id`，不是 `resourceId`。
- 设计场景的图片对象持久化 `assetObjectId`，从资源中心插入时可附带来源 `resourceId`；禁止保存签名 URL和 object path。
- Excalidraw 设计节点只保存 `designId`、revision 和 `previewAssetObjectId` 等轻量字段。

### 5.5 首版权限矩阵

- 普通 workspace member 可以查看和导出其工作区内可访问项目的设计，并使用已发布资源。
- workspace owner/admin 可以创建、编辑、复制、删除设计，上传当前设计资产，管理工作区资源，并委托 Agent 执行写操作。
- 普通 member 首版不能上传、创建或修改设计；后续引入项目级 ACL及 editor 角色后再开放，不通过放宽整张 Canvas 或 Storage RLS实现。
- Agent 继承发起用户的业务权限；service role 只是 Worker/GC 的执行身份，不成为资源所有者。
- 平台公共资源由显式平台管理员管理，不把任意 workspace owner/admin 视为平台管理员。

### 5.6 生命周期、复制与删除

- 设计删除采用软删除，默认保留 30 天；删除设计节点时同步软删除其仅有绑定设计，但不立即删除资产。恢复节点时恢复同一 `designId`，超过保留期后只能由回收任务清理。
- 复制/粘贴或复制设计节点必须调用服务端 clone：生成新的 `designId`、新的 scene 对象 ID 和新的节点绑定；二进制资产通过引用共享，不复制对象存储文件。
- 设计模板套用同样创建独立设计与独立对象 ID；模板、原设计或资源后续更新不得静默改变副本。
- `asset_objects` 只在设计、模板、资源、消息、Canvas 和 Job 的权威引用并集均为空且超过保留窗口后，才允许由 service-role 两阶段 GC 删除。

## 6. 用户与权限

### 6.1 普通工作区成员

- 查看和导出所在工作区中可访问项目的设计。
- 使用平台公共资源和所在工作区已发布资源。
- 可以请求 Agent 分析设计；Agent 写操作仅在发起用户拥有 owner/admin 权限时执行。

### 6.2 工作区 owner/admin

- 创建、编辑、复制、软删除和恢复工作区设计。
- 通过受控 Upload API 上传当前设计所需的图片、SVG和字体；浏览器不直接写 Storage 或 `asset_objects`。
- 管理工作区模板、素材、字体、文字模板、分类和标签。
- 创建批量导入及采集任务。
- 审核资源来源和授权信息。
- 发布、下架或删除工作区资源。

### 6.3 平台管理员

- 管理平台公共资源。
- 查看采集任务、失败原因、重复资源及安全审核结果。
- 控制资源对所有工作区的可见范围。
- 平台管理员身份来自 `platform_admins` 表；仅 service role 可授予或撤销，服务端接口必须查询该表，前端是否显示入口不能作为鉴权依据。

## 7. 核心用户流程

### 7.1 创建空白设计

1. 用户点击无限画布底部工具栏中、图片图标右侧的“设计画板”。
2. 打开创建面板，默认停留在“自定义尺寸”。
3. 用户选择预设或输入整数像素宽高；首版固定使用 px，不显示单位选择和 DPI。
4. 系统在当前视口中心创建设计节点和独立设计文档。
5. 新节点被选中，用户可双击进入编辑。

### 7.2 从模板创建

本流程在资源中心和模板模块通过验收后启用。此前创建面板不显示模板页签、空列表或占位按钮。

1. 点击“设计画板”。
2. 切换到“模板”。
3. 按分类、标签、关键词、尺寸比例筛选。
4. 选择模板后显示名称、尺寸、资源来源和预览。
5. 确认后创建模板副本，不直接编辑模板原件。

### 7.3 编辑设计

1. 双击设计节点。
2. 打开大浮层编辑器。
3. 用户从左侧添加模板、文字、素材或上传内容。
4. 中间编辑设计画板。
5. 右侧修改选中对象属性和图层。
6. 自动保存场景；关闭时生成或刷新预览。

### 7.4 Agent 生成图片到设计

1. 用户选中设计节点或在对话中明确提到设计名称。
2. Agent 读取设计摘要和图层角色。
3. Agent 提出生成方案并按现有规则取得确认。
4. 现有生图任务完成并创建 `assetObjectId`。
5. 设计任务 finalizer 将图片对象写入目标设计。
6. 系统更新 revision、资产引用、预览并广播 `design.sync`。

### 7.5 原子创建、幂等与补偿

首选通过 `loomic_design_create` 原子 RPC 同时创建设计文档、节点绑定并合并最小 Excalidraw 节点：

1. 客户端预生成稳定的 `request_id` 和 `canvas_element_id`，网络重试必须复用。
2. 请求只提交 `request_id`、canvas、预期 Canvas revision、逻辑宽高、可选模板来源、element ID和节点位置尺寸，不接收任意 Fabric/Excalidraw JSON。
3. 服务端校验 owner/admin 权限、canvas/design 同项目和工作区、尺寸预算及 element ID唯一性，并自行白名单构造节点。
4. `design_creation_requests` 对 `(workspace_id, created_by, request_id)` 唯一；重复请求返回同一 `designId/elementId`。
5. 事务内创建或复制文档、建立 `design_nodes`、更新 Canvas revision并完成绑定，任一步失败全部回滚。
6. 模板复制只复制场景结构并建立资产/字体引用，不复制二进制文件。
7. 预览和存储上传是异步步骤；失败只标记待重试，不回滚已创建设计。
8. 若部署阶段暂时不能使用原子 RPC，才允许使用 `pending_node → active/orphaned` saga，并由 reconciler 补挂或软删除，客户端不得盲目物理删除。
9. 刷新发现 designId 不可用时显示可恢复错误状态，禁止无限请求。

## 8. 信息架构与界面

### 8.1 无限画布工具栏

顺序建议：

```text
文字 → 图片 → 设计画板 → AI 图片 → AI 视频
```

设计画板使用独立图标，不作为 Excalidraw `setActiveTool` 类型。点击后打开创建面板。

创建面板线框约束：桌面端宽 360px，锚定工具栏上方；标题下依次为尺寸预设网格、自定义宽高输入、背景色/透明开关和主操作按钮。宽高输入均明确标注 px，Enter 创建、Esc 关闭，错误显示在对应输入下方。阶段 5 通过前不渲染模板页签。

### 8.2 设计节点

设计节点 discriminator 为 `customData.kind === "loomic-design"`，首版 metadata 白名单为：

```json
{
  "kind": "loomic-design",
  "schemaVersion": 1,
  "designId": "uuid",
  "revision": 12,
  "previewAssetObjectId": "uuid-or-null",
  "previewRevision": 12
}
```

节点 revision 只是展示缓存，服务端 `design_documents.revision` 始终为权威值。预览不进入 Excalidraw `files`，节点不得保存设计场景、签名 URL或 object path。

节点默认展示：

- 最新预览图。
- 加载、保存、生成或错误状态。
- 选中时显示节点工具栏。
- 预览不可用时显示稳定占位符，不出现无限重试。

节点菜单至少包含：

- 打开编辑。
- 重命名。
- 从设计创建模板。
- 导出。
- 复制设计。
- 删除。

Excalidraw 原生复制、粘贴不得让两个节点共享同一个 `designId`。设计节点复制必须走专用“复制设计”命令：先幂等复制文档，再创建绑定新 `designId` 的节点；`onDuplicate/onPaste` 必须拦截直接复制。

预览要求：

- 最大边 512px，优先 WebP；透明内容可使用 WebP alpha 或 PNG。
- 只有场景 CAS 保存成功后才生成对应 revision 的预览，旧任务不能覆盖新 revision。
- 预览失败不回滚设计，继续显示上一张成功预览并标记 `preview_stale/error`。
- 预览通过鉴权内容接口转 Blob URL，缓存键为 `previewAssetObjectId + previewRevision`，卸载或淘汰时 revoke。
- 视口外使用 `IntersectionObserver` 停止请求；全页最多 4 个并发，失败最多 3 次并指数退避。
- 节点状态至少包括 `loading/ready/saving/generating/preview_stale/error/missing`。

### 8.3 大浮层编辑器

建议布局：

```text
顶部：返回、名称、保存状态、撤销/重做、缩放、预览、导出
左侧：文字、上传、形状；资源阶段通过后再启用模板、素材和字体资源
中间：固定尺寸设计画板
右侧：对象属性 / 图层
底部或浮层：上下文工具栏
```

编辑器必须复用 Loomic 的颜色、圆角、阴影、按钮、菜单、Toast 和对话框规范。

编辑浮层打开时 Excalidraw 保持挂载但设为 `inert` 且不可交互；浮层启用焦点陷阱。任一时刻只允许一个 `activeDesignId` 和一个 Fabric Canvas。Escape 优先退出文字编辑或子菜单，只有无子级交互时才关闭设计编辑器。

桌面端线框约束：浮层距视口四边 12px，顶部 48px，左栏 260px，右栏 300px，中间区域独立缩放和居中；窄于 1024px 显示只读/建议扩大窗口提示。关闭流程必须先处理 dirty 命令。打开与关闭各执行一次事件注册/清理；销毁时 await Fabric `dispose()`，撤销栈、ResizeObserver、键盘/指针监听器、计时器和 Blob URL全部释放。

## 9. 功能需求

### 9.1 画板与尺寸

| ID | 需求 | 优先级 |
|---|---|---|
| DB-001 | 支持输入 1–32768 的正整数像素宽高；超出前端像素预算时仍可编辑但必须后台导出 | P0 |
| DB-002 | 支持 1:1、4:3、3:4、16:9、9:16 等预设 | P0 |
| DB-003 | 设计逻辑尺寸与无限画布展示尺寸分离 | P0 |
| DB-004 | 支持修改设计尺寸，并选择裁切、扩展或按比例缩放内容 | P1 |
| DB-005 | 支持画板背景色和透明背景 | P0 |
| DB-006 | 首版仅支持 px；mm、cm 和 DPI 属于后续范围，首版 UI/API/表均不出现这些字段 | P0 |
| DB-007 | 对大尺寸给出内存预算提示并切换后台导出 | P1 |

“任意尺寸”指逻辑设计尺寸可自定义，不代表浏览器可以无上限分配像素。系统必须根据总像素、浏览器能力和导出倍率决定前端或后台渲染。

### 9.2 基础对象

MVP支持：

- 图片。
- SVG。
- 普通文字和文本框。
- 矩形、圆形、三角形。
- 直线和箭头。
- Group。

所有对象必须包含：

- 稳定 `objectId`。
- `type`。
- 位置、尺寸、旋转和透明度。
- 图层顺序。
- 锁定、可见状态。
- 可选语义角色：`background`、`title`、`subtitle`、`logo`、`product`、`decoration` 等。
- 对象版本号。

### 9.3 对象编辑

- 选择、多选、移动、缩放、旋转。
- 复制、删除、锁定、隐藏。
- 置顶、置底、上移一层、下移一层。
- 左右上下对齐、水平/垂直居中、平均分布。
- 组合与解组。
- 水平和垂直翻转。
- 数值修改位置、尺寸和角度。
- 边界吸附和对齐参考线。

### 9.4 文字

- 文本内容、字号、字体、字重、斜体。
- 左中右对齐、行高、字间距。
- 填充色、透明度、描边和阴影。
- 文字模板一键插入。
- 模板字体缺失时明确提示替换，不静默永久改变排版。
- 字体加载完成后重新计算文本尺寸。

### 9.5 图片与 SVG

- 上传、素材库插入和 AI 生成插入。
- 替换图片但保留位置和显示框。
- 适应、填充和原始尺寸。
- 水平/垂直翻转。
- SVG 服务端净化后才能进入资源库和设计场景。
- 外部 URL不能直接长期写入场景，必须先导入 Loomic 资产系统。

裁剪、蒙版、滤镜、描边、抠图、智能擦除和图层拆分列入高级编辑阶段。

### 9.6 图层

- 树状展示组和子对象。
- 选择、重命名、拖拽排序。
- 锁定、隐藏、批量操作。
- 图层搜索。
- 显示语义角色。
- Agent 操作后高亮受影响图层。

### 9.7 历史与保存

- 人工操作和 Agent 操作共用命令历史。
- 支持撤销/重做。
- 不使用每一步完整大场景快照作为唯一历史形式。
- Fabric 的 `object:moving/scaling/rotating` 不直接触发网络保存；一次指针变换在 `object:modified` 时合并为一个命令。
- 属性输入从聚焦到失焦合并为一个命令。
- 自动保存仅在命令提交后 debounce 1000ms；同一设计同时最多一个保存请求，保存期间的新命令进入下一批 dirty 队列。
- 所有 mutation 提交 `designId + expectedRevision + idempotencyKey + commands[]`；更新或删除已有对象还必须提交 `expectedObjectVersion`。
- 一个命令批次事务性全成或全败；成功后 document revision 只加 1，受影响对象版本各加 1。
- expectedRevision 落后时，仅当目标对象与其后的修改集合不相交才允许服务端最多重放 3 次；同对象冲突、resize、背景、reorder、group/ungroup 和模板整场景替换一律返回 409，禁止 last-write-wins。
- 409 返回最新 revision、冲突对象和是否可重试；UI暂停自动保存并保留本地命令，允许用户刷新合并、重试或明确放弃。
- `object.add` 通过 `objectId + idempotencyKey` 去重；删除已删除对象返回幂等成功/no-op。
- 关闭时必须 flush；失败时浮层不能静默关闭，提供重试、继续编辑和明确放弃。页面离开且仍 dirty 时显示离开确认。
- 浏览器会话维护命令级 undo/redo；撤销已持久化或 Agent 操作时以当前 revision 提交反向命令，而不是本地静默回滚。
- 每 50 个 revision 或达到场景体积阈值生成一次持久快照，其他版本保存命令批次，恢复时从最近快照重放。

### 9.8 导出

第一版支持：

- PNG。
- JPEG。
- 透明背景 PNG。
- 1×和2×倍率。
- 当前逻辑尺寸导出。

WebP、SVG、PDF不在首版范围；后台超大尺寸导出是阶段 7 的强制交付。

导出必须等待所需字体和图片加载完成，并对缺失资源给出明确错误。

## 10. 资源中心

### 10.1 资源类型

```text
DesignTemplate
TextPreset
RasterAsset
SvgAsset
FontFamily
FontFace
Category
Tag
```

### 10.2 资源作用域和状态

作用域：

- `platform`
- `workspace`

状态：

- `draft`
- `pending_review`
- `published`
- `rejected`
- `disabled`

### 10.3 资源浏览

- 服务端游标分页。
- 名称、标签和分类搜索。
- 类型、宽高比例、文件格式和作用域筛选。
- 列表只加载缩略图。
- 原文件在插入或编辑时按需加载。
- 支持收藏和最近使用。
- 收藏和最近使用分别持久化到 `resource_favorites` 与 `resource_recent_uses`，不只保存在浏览器。
- 分类和标签均带 `scope` 与可空 `workspace_id`；平台名称唯一约束与工作区名称唯一约束分开，禁止跨作用域串用。

### 10.4 模板

模板保存：

- 逻辑宽高。
- Loomic场景 schema 版本。
- 对象结构。
- `assetObjectId/fontFaceId` 引用；可额外记录来源 `resourceId`。
- 模板预览。
- 分类、标签和授权信息。
- 可选变量槽位，例如标题、Logo、产品图和背景图。

套用模板时创建独立设计副本。模板后续更新不能静默改变已经创建的设计。
模板只有在全部资产、字体和授权记录可用且已发布时才能发布；模板下架不影响已经创建的设计副本。

### 10.5 文字模板

文字模板不是单一字体名，而是一个或多个可编辑文字/形状对象，包含：

- 字体与字重。
- 字号、间距和行高。
- 填充、渐变、描边、阴影。
- 旋转和组合结构。
- 预览资产。
- 默认示例文字。

### 10.6 字体

字体采用 `FontFamily + FontFace` 模型，支持不同 weight/style。

- 校验扩展名、MIME、字体头和大小。
- 保存字体 family、weight、style、format。
- 记录来源、授权范围和是否允许 Web 嵌入。
- 只加载当前可见预览或当前设计实际使用的字体。
- 字体 URL运行时解析，场景只保存 `fontFaceId`。
- 字体不可用时显示缺失状态和替换入口。

## 11. 资源导入与采集

### 11.1 本地批量导入

后台支持上传资源包或选择服务器导入目录。导入任务流程：

```text
解析清单
 → 文件类型和安全校验
 → SHA-256 去重
 → 提取尺寸、MIME 和字体元数据
 → SVG 净化
 → 上传私有对象存储
 → 生成缩略图
 → 创建待审核记录
 → 建立旧路径到 resourceId 的映射
 → 转换模板对象引用
 → 输出成功、跳过和失败报告
```

### 11.2 URL采集

采集必须由服务端任务执行：

- 限制协议为 HTTPS/HTTP。
- 阻止 localhost、内网、云元数据地址及危险重定向，防止 SSRF。
- 限制文件大小、下载时间和重定向次数。
- 校验实际内容，不信任扩展名和响应 MIME。
- 下载后进入 Loomic 存储，不长期引用第三方 URL。
- 保存来源 URL、抓取时间、授权说明和内容哈希。

### 11.3 参考资源迁移

参考目录只作为一次性输入，迁移器不得让运行时代码依赖：

- `/local-data/*.json`
- `/local-assets/*`
- 原 Strapi `attributes/data/formats` 结构
- 原远程域名

迁移后所有资源必须能通过 Loomic Resource API和稳定 ID访问。

## 12. Agent 设计

### 12.1 原则

- Agent 不模拟 UI点击。
- Agent 不直接写未经验证的 Fabric JSON。
- Agent 与人工 UI 共用服务端命令契约。
- 所有修改声明 `designId` 和 `expectedRevision`。
- 删除和覆盖模板等破坏性操作沿用 Loomic 二次确认机制。
- API Key、供应商路由和积分计算始终在服务端。

### 12.2 Agent 工具

建议新增：

```text
inspect_design
get_design_objects
manipulate_design
search_design_resources
apply_design_template
export_design
```

`manipulate_design`、人工 UI和数据库 RPC 共用以下 canonical 命令动作；字段名使用 snake_case：

```text
canvas.update
object.add
object.update
object.remove
object.clone
object.reorder
objects.group
objects.ungroup
objects.align
objects.distribute
object.set_role
scene.replace
```

命令 envelope 和引用字段使用 snake_case；其中嵌入的 durable scene object 仍使用场景协议的 camelCase，不做第二份对象结构。WebSocket 事件沿用 Loomic 现有 camelCase 风格，数据库 outbox payload 保存可直接广播的同一事件 envelope。

### 12.3 Agent 上下文

`inspect_design` 默认返回摘要，避免把完整场景塞入模型上下文：

- 设计名称和尺寸。
- revision。
- 对象 ID、类型、角色、位置和尺寸。
- 文字对象的截断文本。
- 资源 ID。
- 当前选区。

只有明确需要时才读取单个对象完整属性。

### 12.4 AI 生成目标

API与 Agent 使用 snake_case。图片生成请求改为判别联合；兼容层继续接受旧 Canvas 顶层字段，但进入 Job 前必须规范化为以下冻结 target：

```json
{
  "target": {
    "kind": "design",
    "design_id": "uuid",
    "expected_revision": 12,
    "idempotency_key": "uuid",
    "placement": {
      "x": 120,
      "y": 80,
      "width": 600,
      "height": 600,
      "fit": "cover",
      "role": "background",
      "replace_object_id": null
    }
  }
}
```

Canvas target 规范为 `{ "kind": "canvas", "canvas_id": "uuid", ...原有占位和 placement 字段 }`。`background_jobs` 新增 `target_kind` 和可空 `design_id` 列；payload 不是权限依据，创建任务时必须验证并冻结 workspace/project/design 归属。

生成模型、提示词、参考图、积分、供应商快照和错误处理继续沿用现有链路。新增 `job_target_finalizations`，以 `(job_id, target_kind, target_id)` 唯一防重。Worker 成功后使用 finalization 行的稳定 UUID 作为 mutation `idempotency_key` 调用统一设计命令服务：创建资产、插入对象、同步引用、revision + 1、写 finalization/outbox，重试必须复用同一 UUID，不得重复插图或扣费。

新增对象遇到 revision 前进时可以在最新 revision 幂等重放；替换目标已变化或删除时，Job 保持 succeeded，finalization 进入 `needs_attention`，保留生成资产并等待协调，禁止再次调用付费模型。

## 13. 概念数据模型

```text
platform_admins
design_creation_requests
design_documents
design_nodes
design_document_versions
design_document_asset_refs
design_document_font_refs

design_templates
design_template_asset_refs
text_presets
design_resources
font_families
font_faces

resource_categories
resource_tags
resource_tag_links
resource_favorites
resource_recent_uses
resource_import_jobs
resource_import_items
job_target_finalizations
design_event_outbox
```

关键约束：

- `design_documents` 包含 workspace/project、name、scene、schema_version、engine_version、width、height、revision、preview_asset_object_id、created/updated actor、deleted_at；使用复合外键确保 project 与 workspace 一致。
- `design_nodes(canvas_id, element_id, design_id, workspace_id)` 是 Canvas 节点与设计文档的权威绑定；首版一个未删除设计最多绑定一个 live node。
- `design_document_versions` 保存 revision、parent_revision、命令批次、可选快照、actor_kind、actor_user_id、agent_run_id、tool_execution_id 和 idempotency_key。
- `design_document_asset_refs` 按 `design_id + object_id + slot` 引用 `asset_objects.id`；字体使用独立 `design_document_font_refs`。
- `design_creation_requests` 保证原子创建重放返回同一结果。
- `design_event_outbox` 与场景事务一起写入，投递 `design.sync` 后标记完成，避免数据库成功但事件丢失。
- 资源目录表统一保存 `scope`、可空 `workspace_id`、`status`、来源/授权和审计字段；platform 行要求 workspace_id 为空，workspace 行要求非空。
- 所有软删除实体使用 `deleted_at/deleted_by`，业务查询默认排除；唯一约束只约束 live 行。设计默认保留 30 天，导出结果默认保留 7 天，可由服务端策略缩短。

RLS 与服务边界：

| 数据域 | 读取 | 创建/修改 | 物理删除 |
| --- | --- | --- | --- |
| 工作区设计/版本/引用 | workspace member | workspace owner/admin，经服务端命令/RPC | 仅 service-role GC |
| 工作区资源/模板/字体 | 已发布项对 member 可读；草稿仅 owner/admin | workspace owner/admin，经管理 API | 仅 service-role GC |
| 平台公共资源/模板/字体 | 已发布项对已登录用户可读 | `platform_admins` 中 active 用户，经管理 API | 仅 service-role GC |
| 创建请求/finalization/outbox | 不向浏览器直接开放 | 受控 API、事务 RPC 或 Worker | service role |

所有复合关系必须同时校验 `workspace_id`，禁止仅凭全局 UUID建立跨工作区引用；浏览器不能直接调用 service-role 函数。RPC显式 revoke public/anon execute，再只 grant 给 authenticated 或 service role 所需入口。

设计场景外层格式：

```json
{
  "schemaVersion": 1,
  "engine": "fabric",
  "canvas": {
    "width": 1080,
    "height": 1080,
    "background": "#ffffff"
  },
  "objects": []
}
```

Fabric 原始字段必须经过白名单规范化。Loomic schema 是持久协议，Fabric JSON只是当前引擎载荷，不允许引擎私有字段无限扩散到服务端协议。

## 14. 资产存储和引用

- 原始图片、SVG、字体、模板预览和设计预览进入私有对象存储。
- 数据库存储对象路径和 `assetObjectId`，场景不保存短效签名 URL。
- 客户端通过鉴权内容接口或临时签名 URL加载。
- 设计保存时同步 `design_document_asset_refs`。
- `asset_objects` 增加 `scope = platform|workspace`：platform 资产允许 `workspace_id` 为空并进入私有 `platform-assets`；workspace 资产必须有 workspace_id并进入私有 `workspace-assets`，由 CHECK 保证组合有效。
- 保留现有 Canvas `asset_references`，新增设计、模板、资源、字体和预览专用引用；GC 的 live reference 查询必须 union 全部引用以及未过期 Job 结果。
- 删除设计使用软删除和保留期，避免误删后无法恢复。
- GC 使用两阶段 service-only 协议：达到 `eligible_at` 后 claim token/lease，删除 Storage 前及 finalize 前再次检查全部 live refs；claim 期间出现新引用必须取消删除。
- 普通浏览器无物理删除和 GC 权限；设计、模板软删除保留期内的引用仍算 live。

## 15. 同步与并发

- `canvases` 增加显式 revision，逐步替代 `updated_at` 作为并发令牌；设计文档拥有独立 revision。
- 每个对象拥有稳定 ID和对象版本。
- 保存采用 compare-and-swap。
- 并发与冲突遵循 9.7 的命令事务规则，不允许整场景最后写入者获胜。
- 新增 `design.sync` WebSocket 事件，携带 `designId`、revision 和更新类型。
- 无限画布只在设计预览变化时更新节点元数据，不因设计内部每次拖动重新加载全部 Excalidraw 内容。
- UI 与 Agent 的成功 mutation 在同一事务中写场景、版本、引用和 outbox；事件消费者按 revision 丢弃旧消息。

## 16. 性能要求

### 16.1 无限画布

- 未激活设计节点只渲染预览图片。
- 同一页面硬限制只允许一个活跃设计编辑器实例。
- 视口外预览不加载原图。
- 预览加载沿用视口优先，最大并发 4，单资源最多重试 3 次。
- 设计 JSON不进入 Excalidraw `files` 或 `customData`。
- 基准桌面环境的验收数据集为 1,000 个普通图片节点加 100 个设计预览节点；平移缩放目标不低于 30 FPS，且 Fabric 实例数始终不超过 1。

### 16.2 设计编辑器

- 资源列表采用游标分页和虚拟列表。
- 缩略图与原图分离。
- 字体按当前设计和可见列表加载。
- 连续拖动时不触发网络保存和预览渲染。
- 预览在命令空闲 2 秒、退出编辑或 Agent 命令批次结束后生成；拖动期间禁止生成。
- 大场景历史采用命令或增量补丁，避免 100 份完整场景快照。
- 1,000 个基础对象的设计在基准桌面环境中打开到可操作目标不超过 3 秒；连续变换目标不低于 30 FPS。

### 16.3 大尺寸导出

- 根据 `width × height × multiplier` 计算像素预算。
- 前端导出默认硬上限 32,000,000 像素；超过时禁止本地直接渲染，改为后台导出。该阈值可按实测下调，不可由普通用户绕过。
- 后台导出使用 `background_jobs.type = design_export`，payload 冻结 `design_id/revision/format/multiplier`，状态沿用现有 queued/running/succeeded/failed/canceled/dead_letter，结果是受权限保护的 `assetObjectId`。
- Worker 开始和写入结果前重新校验设计可访问性与资源授权；相同幂等键只产生一个结果任务。结果默认保留 7 天，过期后仅在无引用时进入两阶段 GC。
- 服务端硬限制单边、总像素、预计内存和执行时间；超限返回可操作错误，不进入无限重试。

## 17. 安全与合规

- 所有设计和资源 API按 5.5 权限矩阵校验；首版读取使用 workspace member，写入使用 owner/admin，平台公共资源写入使用 platform_admin。
- SVG入库前移除脚本、事件属性、外链和危险 XML。
- URL采集防 SSRF。
- 字体文件校验真实格式和大小。
- 资源记录必须支持来源、作者、授权、归属和使用限制字段。
- `pending_review` 资源不能被普通用户或 Agent 搜索到。
- Agent 属性修改使用白名单，禁止覆盖引擎内部字段。
- 删除对象、覆盖场景和替换整个模板需要明确用户意图。
- 导出前检查资源授权状态和加载状态。

## 18. 错误处理

必须覆盖：

- 设计保存冲突。
- 资源加载失败。
- 字体缺失或解析失败。
- 图片跨域或签名 URL过期。
- SVG净化失败。
- 模板依赖资源缺失。
- Agent 修改了已删除对象。
- 生图成功但设计 finalizer 失败。
- 预览生成失败。
- 大尺寸导出内存不足。

错误提示需要说明“发生了什么、数据是否已保存、用户可以做什么”。生成任务和 finalizer 必须支持幂等重试，不能重复插入同一图片。

## 19. 后台管理

后台增加：

```text
用户管理
模型供应商
设计模板
文字模板
素材
字体
分类与标签
采集/导入任务
```

列表能力：

- 搜索、筛选、分页。
- 批量分类、标签、发布、下架和删除。
- 查看文件、缩略图、哈希、尺寸、来源和授权。
- 查看资源被哪些设计或模板引用。
- 查看采集/导入任务进度和失败明细。

## 20. 埋点与可观测性

至少记录：

- 设计创建来源：空白、预设、模板、Agent。
- 设计进入编辑、保存成功/失败和冲突。
- 模板套用次数。
- 资源搜索、插入和加载失败率。
- 字体加载耗时及失败率。
- Agent 设计工具成功率、冲突率和重试次数。
- 设计预览生成耗时。
- 导出尺寸、耗时、失败原因。
- 生图成功但设计落图失败的数量。

日志不得包含供应商密钥、完整用户隐私素材或短效签名 URL。

- 审计记录至少包含 actor kind/user、workspace/project/design、动作、结果、request/idempotency key、旧/新 revision、时间和关联 Agent/Job ID；安全审计默认保留 180 天。
- 预览、签名 URL刷新、finalizer、导入和导出采用有上限的指数退避；业务失败最多 3 次，安全校验失败不重试，超过上限进入明确 failed/needs_attention 状态。
- UI 中文为当前默认文案，所有新增文案集中定义，组件不得散落不可替换的中英文常量。

## 21. 分阶段交付

### 阶段 0：基线与最终 PRD

- 冻结 Fabric 版本、px 范围、场景/命令/错误/事件 schema、权限矩阵、三类资源 ID和冲突语义。
- 完成设计节点、创建面板和大浮层线框说明。
- 建立当前脏工作树保护清单和实施状态表。

通过标准：PRD P0问题清零，独立 PM Agent 判定 PASSED。此阶段不实现生产功能。

### 阶段 1：共享契约与数据库基础

- 新增平台管理员、设计文档、节点绑定、版本、引用、资源、模板、字体、分类标签、收藏/最近使用、导入、finalization 和 outbox 表。
- 扩展 `asset_objects` platform/workspace 作用域及 `canvases.revision`。
- 完成 RLS、复合外键、索引、最小授权、原子创建、CAS mutation、引用同步与 GC RPC。
- 生成 shared Zod/TypeScript/Supabase 类型。

通过标准：空库迁移静态验证、RLS矩阵、跨工作区拒绝、CAS并发、同 request 重放、同 finalizer 重放、GC claim竞态和 Agent/用户同对象冲突测试通过；不连接远程生产数据库。

### 阶段 2：设计服务、API 与异步协议

- 完成 create/get/mutate/rename/copy/soft-delete/restore/preview/export/reference API。
- 完成幂等创建、Canvas 节点原子绑定、设计预览、`design.sync` outbox 投递和后台 reconciler。
- 扩展 Job design target、finalization ledger和兼容旧 Canvas payload 的规范化层。

通过标准：API鉴权、越权、409、幂等、补偿、预览旧 revision 防覆盖和 Job 恢复测试通过。

### 阶段 3：无限画布垂直切片

- 工具栏图片图标右侧加入设计画板入口。
- 创建面板只包含空白设计、像素尺寸预设和自定义 px尺寸，不显示模板入口。
- 在视口中心创建轻量节点，双击打开大浮层和最小 Fabric 画板。
- 完成事件/快捷键/撤销栈隔离、保存刷新恢复、预览与单 Fabric 实例约束。

通过标准：真实 Chromium 完成创建、打开、关闭、保存、刷新、节点复制拦截和连续打开/关闭 20 次的资源释放测试。

### 阶段 4：核心 MVP设计编辑器

- 支持图片、SVG、普通文字、文本框、矩形、圆形、三角形、直线、箭头和 Group。
- 完成基础属性、图层树、排序、重命名、搜索、锁定、隐藏、对齐、分布、组合和解组。
- 完成统一命令历史、撤销/重做、自动保存、冲突 UI和预览。
- 完成 PNG、透明 PNG和 JPEG导出。

通过标准：所有可见按钮均为真实实现；命令历史、变换合并、销毁、缺失资源、CAS、导出和回归测试通过。

### 阶段 5：资源中心、模板、后台和导入

- 实现公共/工作区资源、设计模板、文字模板、图片、SVG、字体、分类、标签、收藏和最近使用。
- 实现服务端分页、搜索、上传、审核、发布、下架、引用查看和安全删除。
- 实现通用本地导入和 URL采集，参考资源默认 `pending_review`。
- 本阶段通过后才在创建面板和编辑器中开放模板/素材/字体入口。

通过标准：权限、分页、发布依赖、去重、幂等、SVG、字体、SSRF和引用 GC测试通过。

### 阶段 6：Agent 与 design-target 生图

- 实现 `inspect_design`、`get_design_objects`、`manipulate_design`、`search_design_resources`、`apply_design_template` 和 `export_design`。
- Agent 与人工 UI共用命令服务、冲突协议、破坏性确认、历史和审计。
- 图片生成可落入指定设计并完成引用、revision、预览和 `design.sync`。

通过标准：Agent 鉴权、摘要读取、改文字、资源搜索、模板、生图插入、并发冲突和 finalizer 幂等浏览器验收通过，不重复扣费或插图。

### 阶段 7：高级编辑与后台大尺寸导出

- 裁剪、蒙版、滤镜、描边、阴影、抠图、智能擦除、图层拆分。
- 模板变量、智能替换和后台大尺寸导出。
- 所有模型功能继续走服务端供应商、积分与 Job。

通过标准：真实实现、任务进度/恢复、像素预算、内存、授权和模型失败测试通过。

### 阶段 8：系统回归与发布验收

- 执行全部自动化测试、20 个浏览器场景、性能压力和安全回归。
- 完成架构、运维、导入与用户文档。
- 最终 PRD 与实现对齐。

通过标准：无已知 P0/P1；P2已修复或有明确非范围证据；独立 PM Agent 判定全部模块 PASSED。

## 22. MVP验收标准

### 创建与恢复

- 在工具栏图片图标右侧能看到设计画板入口。
- 可以输入自定义宽高并创建节点。
- 设计实际宽高不随无限画布节点缩放改变。
- 刷新页面后节点、设计内容和预览恢复一致。

### 编辑

- 双击进入大浮层，退出后回到原画布位置。
- 可以添加、选择、移动、缩放、旋转和删除基础对象。
- 可以编辑文字及基础样式。
- 可以调整图层顺序、对齐、组合和锁定。
- 撤销/重做覆盖上述人工操作。

### 保存与资产

- 设计 JSON独立保存，不进入 Excalidraw `customData`。
- 图片通过 `assetObjectId` 引用，签名 URL过期不破坏设计。
- 删除无限画布节点后不会立即误删仍可恢复的设计资产。
- 保存冲突不会静默覆盖另一方修改。

### 导出

- PNG/JPEG导出尺寸符合设计逻辑尺寸。
- 透明背景 PNG保持透明。
- 字体或图片缺失时停止错误导出并显示明确原因。

### 性能

- 未激活节点不挂载 Fabric。
- 多个设计节点存在时只加载视口内预览。
- 连续拖动对象不产生每帧保存请求。
- 资源列表不下载全部原图。

### Agent阶段验收

- Agent 可以读取指定设计的结构摘要。
- Agent 可以添加文字、图片和形状并返回对象 ID。
- Agent 可以调用现有生图任务并把唯一结果插入指定设计。
- Agent 操作进入同一 revision、历史和资产引用体系。
- 重复 finalizer 不会重复添加图片。

### 兼容性与可访问性

- 桌面端验收矩阵覆盖当前稳定版 Chrome、Edge；Safari 与 Firefox 完成创建、编辑、保存、导出和快捷键烟测。首版移动端仅保证可查看并显示编辑能力限制。
- 创建面板与编辑浮层具备焦点陷阱、Esc 关闭/取消、可见焦点、可读 label、纯键盘保存与退出；图标按钮必须提供 `aria-label` 和 tooltip。
- 用户可见错误同时提供文字和状态图标，不只依赖颜色；编辑器缩放不应阻止浏览器页面的基本可访问性操作。

## 23. 实施状态与质量门禁

状态只使用 `PLANNED / IN_PROGRESS / IN_REVIEW / REJECTED / PASSED / BLOCKED`。每阶段通过后才能开始依赖它的下一阶段；若验收为 `REJECTED`，先修复并重验，不把已知 P0/P1 留给后续阶段。

| 阶段 | 当前状态 | 负责人 | 验收人 | 通过证据 |
| --- | --- | --- | --- | --- |
| 阶段 0：基线与最终 PRD | PASSED | 主 Agent | 独立 PM Agent | Final / Approved v1.1；2026-09-03 二审 PASSED |
| 阶段 1：共享契约与数据库基础 | PASSED | 主 Agent + 专项 Agent | 独立测试/PM Agent | 迁移、类型检查、RLS/CAS/幂等测试 |
| 阶段 2：设计服务、API 与异步协议 | PASSED | 主 Agent + 专项 Agent | 独立测试/PM Agent | Shared 94/94、Server 336/336、两端 typecheck、DB lint 与三套真实 SQL QA 通过；2026-09-04 PM 门禁 PASSED |
| 阶段 3：无限画布垂直切片 | PASSED | 主 Agent + 专项 Agent | 独立测试/PM Agent | 本地隔离 Supabase；真实 Chrome 1/1 PASS（45.4s）；2026-09-04 PM 门禁 PASSED |
| 阶段 4：核心 MVP设计编辑器 | PASSED | 主 Agent + 专项 Agent | 独立测试/PM Agent | Shared 97/97、Web 260/260、Server 351/351、三包 typecheck、真实 Chrome 1/1；2026-09-04 PM 门禁 PASSED |
| 阶段 5：资源中心、模板、后台和导入 | PASSED | 主 Agent + 专项 Agent | 独立测试/PM Agent | Shared 99/99、Server 417/417、Web 277/277、真实 Stage 5 E2E 3/3；2026-09-04 PM 三审 PASSED |
| 阶段 6：Agent 与 design-target 生图 | PASSED | 主 Agent + 专项 Agent | 独立测试/PM Agent | 真实 Provider E2E 1/1；Shared 104/104、Server 447/447、Web 286/286；恢复专项 15/15；三包 typecheck；独立 PM PASSED |
| 阶段 7：高级编辑与后台大尺寸导出 | PASSED | 主 Agent + 专项 Agent | 独立测试/PM Agent | Shared 109/109、Server 483/483、Web 319/319；真实本地 E2E 1/1（2.1m）；独立门禁 PASSED |
| 阶段 8：系统回归与发布验收 | PASSED | 主 Agent + 专项 Agent | 独立 PM Agent | 20/20 用户场景 + 9/9 补充场景；真实 Chrome 2/2；Web 324、Server 483、Shared 109；生产审计 0 critical/0 high；2026-09-04 独立门禁 PASSED |

脏工作树保护规则：实施开始时记录 `git status --short` 基线；每阶段只登记本阶段实际触碰的文件，不使用 `git reset`、`git checkout` 或覆盖式恢复命令，不删除或格式化与本项目阶段无关的既有改动。

## 24. 实施技术约束

1. 不复制参考项目的 Vue 页面或 View UI Plus 组件。
2. 不让 Loomic 运行时依赖参考目录、静态根路径或原 Strapi 数据结构。
3. 不直接导入来源和授权不明确的素材供普通用户使用。
4. 不把 Fabric 私有 JSON当作唯一长期公共协议。
5. 不把设计完整场景塞入 Excalidraw 元素。
6. 不让 Agent 绕过服务端权限、资源解析和命令验证。
7. 不在浏览器同时常驻多个完整设计编辑器。
8. 不为追求“任意尺寸”取消像素预算和导出保护。

## 25. 配套设计产物

以下产物随对应阶段同步落库并纳入验收，而不是阶段外的开放问题：

- 设计节点及创建面板线框图。
- 大浮层编辑器线框图。
- 设计场景和命令协议详细 schema。
- 数据库 ERD与 RLS规则。
- 资源导入映射规范。
- Agent 工具输入输出契约。
- 阶段 0 事件隔离技术验证清单。

## 26. 浏览器验收场景清单

最终至少覆盖以下 20 个真实用户流程，并另测非法尺寸、离线 dirty、双窗口冲突、复制、软删除和 20 次销毁压力：

1. 登录并打开无限画布；2. 在图片图标旁点击设计画板；3. 创建自定义尺寸设计；4. 双击进入大浮层；5. 添加文字、图片和形状；6. 修改文字样式；7. 调整图层和对齐；8. 撤销和重做；9. 退出编辑并看到更新预览；10. 刷新后完整恢复；11. 从模板创建新设计；12. 插入公共和工作区资源；13. 上传并使用字体；14. 让 Agent 查看设计；15. 让 Agent 修改文字；16. 让 Agent 生成图片并插入设计；17. 验证 Agent 和用户并发修改冲突处理；18. 导出 PNG、JPEG 和透明 PNG；19. 验证多个设计节点不会同时挂载多个 Fabric 实例；20. 验证资源加载失败、字体缺失和生成失败状态。

“验收通过”表示上述范围内无已知 P0/P1，P2 已修复或有明确非范围证据；不以无法证明的“绝对无 bug”作为发布声明。
