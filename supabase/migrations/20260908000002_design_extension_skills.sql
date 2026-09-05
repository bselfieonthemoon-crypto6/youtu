-- Additional design skills. Do not change existing workspace activation choices.
INSERT INTO public.skills (slug,name,description,author,version,category,source,skill_content,is_featured,metadata)
VALUES ('brand-consistency','品牌一致性','依据已绑定品牌套件和用户批准的作品保持跨设计一致性；适用于沿用品牌风格，不擅自重做品牌或修改套件。','Loomic','1.0','design','system','---
name: brand-consistency
description: 依据已绑定品牌套件和用户批准的作品保持跨设计一致性；适用于沿用品牌风格，不擅自重做品牌或修改套件。
---

先读取当前可用的 get_brand_kit；未绑定或工具不可用时使用用户提供的规范，不声称已获取品牌库。区分正式规范、用户本轮明确覆盖的要求和从参考图推断的风格，冲突时明确指出。

建立本轮固定项：Logo 比例与留白、准确品牌名、主辅色、字体角色、图像语言；同时说明允许变化的布局和装饰。沿用风格不等于复制同一构图。

优先使用真实品牌 Logo 资源，不通过生图重新绘制准确标识或品牌文字。品牌套件中的字体名称不代表字体文件已加载；仅使用当前工具能访问的字体，缺失时说明替代。

对已有画板先通过 inspect_design、get_design_objects 获取实际对象和版本，再局部调整。不得为统一风格重建未要求修改的内容，或修改品牌套件作为副作用。

颜色与字体字段可做结构核对；Logo 变形、视觉留白等需要真实图像输入才能确认。只拿到 URL 不声称完成视觉验收。

交付说明保留了哪些品牌规则、哪些地方作了适配及尚未验证的项。用户只询问一致性时只评估，不生成或修改。
',true,'{"bundle":"loomic-design-extension-v1"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,skill_content=EXCLUDED.skill_content,version=EXCLUDED.version,metadata=EXCLUDED.metadata,updated_at=now()
WHERE skills.source='system' AND skills.created_by IS NULL;
INSERT INTO public.skills (slug,name,description,author,version,category,source,skill_content,is_featured,metadata)
VALUES ('resource-template-composition','素材与模板编排','从当前工作区可访问的已发布素材与模板中选材并组织可编辑设计；适用于使用收藏资源，不将模板预览冒充可编辑模板。','Loomic','1.0','design','system','---
name: resource-template-composition
description: 从当前工作区可访问的已发布素材与模板中选材并组织可编辑设计；适用于使用收藏资源，不将模板预览冒充可编辑模板。
---

先明确尺寸、文案和哪些资源必须沿用。在当前工具提供的工作区上下文中调用 search_design_resources，按主题、资源类型缩小范围；有 next_cursor 时按需翻页，单页未命中不等于整个素材库为空。

搜索返回的是资源摘要：id、kind、尺寸及 preview_asset_object_id 等，不保证包含字体文件、模板修订号或可插入原图。预览资源 ID 不等于模板 ID、字体 ID 或原图 ID；不编造缺失字段，不把未导入的本地目录当作已可访问资源。

选择时说明候选与尺寸、主题、可编辑性及品牌的匹配原因。用户上传不等于已证实商用授权；授权信息未知时标记未知，不自行认证。

先读取目标画板的实际对象和版本。apply_design_template 会替换整个设计，并要求真实模板 ID、修订号及产品确认；不是追加素材。没有足够元数据或没有读取工具时，请用户在资源面板选择模板或提供所需信息，不猜版本，不绕过确认。

对于单个素材，只使用已取得的真实可用资产标识和当前工具支持的对象操作；保持背景、主体、文字分层。字体资源必须可加载；仅有字体名称时不能宣布已应用。无法插入时明确缺少哪一步，不谎报编排完成。

优先使用用户要求的已有资源。缺素材时提供替代选择或请求补充；不得自动改成整图付费生成，也不覆盖原模板。
',true,'{"bundle":"loomic-design-extension-v1"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,skill_content=EXCLUDED.skill_content,version=EXCLUDED.version,metadata=EXCLUDED.metadata,updated_at=now()
WHERE skills.source='system' AND skills.created_by IS NULL;
INSERT INTO public.skills (slug,name,description,author,version,category,source,skill_content,is_featured,metadata)
VALUES ('series-visual-design','系列视觉设计','规划多张内容各异而风格统一的设计；用于活动系列、轮播和成套物料，不把同一画面的尺寸适配重复规划为系列。','Loomic','1.0','design','system','---
name: series-visual-design
description: 规划多张内容各异而风格统一的设计；用于活动系列、轮播和成套物料，不把同一画面的尺寸适配重复规划为系列。
---

从任务确认系列用途、张数、每张准确内容和已有批准方向；信息足够就开始，不强制新增问卷。同一画面换尺寸属于适配，只有内容任务或叙事不同才需要系列规划。

划分统一项与变化项：统一品牌、字体系、配色和视觉语言；变化信息主次、主体位置、节奏和构图。不同画面应承担不同传播任务，不能仅换标题或颜色凑数量。

执行前用简短清单对应每张的主题、主文案、素材和目标尺寸，避免重复卖点或漏项。用户指定顺序与数量优先，不自行追加交付物。

探索中的大批量制作可建议先确认代表稿再扩展，但用户已批准方案或要求直接执行时不重复索要创意确认。付费任务仍遵守现有产品确认，说明预计张数；未获授权不批量生图。

将每张结果关联到实际 design_id、图层或任务 ID，保护原稿并记录完成状态。部分失败只处理未完成项，不整批重跑；超时先查询原任务，不把尚未完成当作失败重复扣费。

根据实际对象和可见图像检查系列一致性、内容差异及顺序。交付分别标明已完成、失败和待检查，不以一个成功任务代表整组完成。
',true,'{"bundle":"loomic-design-extension-v1"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,skill_content=EXCLUDED.skill_content,version=EXCLUDED.version,metadata=EXCLUDED.metadata,updated_at=now()
WHERE skills.source='system' AND skills.created_by IS NULL;
INSERT INTO public.skills (slug,name,description,author,version,category,source,skill_content,is_featured,metadata)
VALUES ('design-copywriting','设计文案策划','把用户提供的品牌与产品事实整理成宣传标题、卖点和行动引导；用于设计文案提炼，不擅自改动已确认的准确文字。','Loomic','1.0','design','system','---
name: design-copywriting
description: 把用户提供的品牌与产品事实整理成宣传标题、卖点和行动引导；用于设计文案提炼，不擅自改动已确认的准确文字。
---

先区分已证实事实、用户提供的主张和未知信息。保留品牌拼写、型号、价格、日期等准确内容；不得为了说服力编造折扣、销量、认证、效果承诺或用户评价。

围绕受众、使用场景和传播目标确定一个主信息，再组织标题、补充卖点和行动引导。信息不足时仅询问影响承诺真实性或主方向的缺项，其余可作为明确占位草稿。

备选文案应在表达角度上不同，而不是形容词替换。用户要求一版或已有定稿时不强制多方案；只做排版时不重新策划文案。

结合画面尺寸和阅读层级控制篇幅，但字符少不保证排版不溢出。必要时提供简短版与完整版，由实际排版检验；不为适配空间删去必要条件或改变价格含义。

需要准确呈现的文案优先使用可编辑文字对象，避免依赖生图模型拼写。落入画板时读取现有对象与版本，只修改指定文字层，不连带重绘图片。

只要文案建议时返回草稿，不调用生成或修改工具。标清待确认事实；品牌事实补齐后再定稿，不把占位符当成可发布成品。
',true,'{"bundle":"loomic-design-extension-v1"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,skill_content=EXCLUDED.skill_content,version=EXCLUDED.version,metadata=EXCLUDED.metadata,updated_at=now()
WHERE skills.source='system' AND skills.created_by IS NULL;

