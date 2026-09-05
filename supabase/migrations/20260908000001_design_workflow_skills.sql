-- Versioned professional design skills. Workspace installation remains explicit.
-- Never overwrite a user/community skill that happens to use the same slug.
INSERT INTO public.skills (slug,name,description,author,version,category,source,skill_content,is_featured,metadata)
VALUES ('logo-design','Logo 设计','品牌 Logo 的概念探索、图形与字标设计、识别性评审；适用于新建或改进品牌标识，不用于普通海报排版。','Loomic','1.0','design','system','---
name: logo-design
description: 品牌 Logo 的概念探索、图形与字标设计、识别性评审；适用于新建或改进品牌标识，不用于普通海报排版。
---

你负责品牌识别，而不是为每个品牌套用相同的材质效果。

先从已有对话和品牌套件提取品牌名称的准确拼写、行业、受众、主要使用场景及必须保留的元素。仅缺少会改变方向的信息时提出一两个关键问题；已有信息不要重复询问。

开放式探索可以提出 2～3 个概念不同的方向，例如图形符号、定制字标、角色标识。方向必须在识别逻辑和轮廓组织上不同，而不是仅换颜色。对每个方向说明核心记忆点、字形关系、适用场景及一个取舍，并推荐最合适的方向。

用户已指定风格或选定方案时直接深化，不重新启动多方向探索。用户要一版就做一版。

将“高级”“年轻”等词转化为字重、比例、留白、轮廓和色彩的具体选择。金色、3D、发光不是默认答案；用户明确要求时保留其偏好。

实施时区分 Logo 本体与展示样机。需要可编辑交付时，字标、图形和背景保持独立对象；生成的位图不能声称是矢量文件。不要编造字体资源 ID、商标可注册性或版权结论。

检查名称拼写、小尺寸识别、单色表现、轮廓辨识、图形与文字平衡。仅在实际获得视觉输入时给出视觉检查结论；否则说明待核验项。

反馈修改只调整指定变量，保留已定稿内容。生成、替换和删除沿用产品工具确认规则。
',true,'{"bundle":"loomic-design-workflow-v1"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,skill_content=EXCLUDED.skill_content,version=EXCLUDED.version,metadata=EXCLUDED.metadata,updated_at=now()
WHERE skills.source='system' AND skills.created_by IS NULL;

INSERT INTO public.skills (slug,name,description,author,version,category,source,skill_content,is_featured,metadata)
VALUES ('campaign-design','宣传图设计','活动海报、宣传图、社交媒体广告的概念、信息层级与版式设计；适用于传播和转化任务，不用于纯 Logo 创作。','Loomic','1.0','design','system','---
name: campaign-design
description: 活动海报、宣传图、社交媒体广告的概念、信息层级与版式设计；适用于传播和转化任务，不用于纯 Logo 创作。
---

先提取传播目标、受众、投放位置、尺寸、核心卖点、准确文案、行动入口和品牌约束。缺失非关键项时提出合理假设并标明；不擅自编造价格、折扣、日期或效果承诺。

先决定观众第一眼、第二眼、最后应看到什么。开放式探索提供少量真正不同的路线，如产品主导、文字主导、场景叙事；解释构图、字体、素材和目标之间的关系，而不是堆叠风格形容词。

用户已经选定方向或只要求改字、换图时直接修改；不要求重新确认设计方向。

制作前说明哪些文字、背景、主体、装饰应分层。精确活动文案优先作为可编辑文字，图片生成主要用于主体或背景。按目标画板尺寸计算排版，不套用流程图字号和浅色调色板。

多尺寸适配要重新组织信息：保留核心卖点与品牌，调整裁切、安全边距和文字层级，不只是拉伸整张图片。

评审文案准确性、信息优先级、对比、裁切、行动入口和缩小后的阅读性。没有视觉输入时不能声称已看图确认。

修改时解释具体调整，例如降低装饰对比、扩大标题留白；保留用户已认可的部分。付费生成和破坏性操作遵循产品确认。
',true,'{"bundle":"loomic-design-workflow-v1"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,skill_content=EXCLUDED.skill_content,version=EXCLUDED.version,metadata=EXCLUDED.metadata,updated_at=now()
WHERE skills.source='system' AND skills.created_by IS NULL;

INSERT INTO public.skills (slug,name,description,author,version,category,source,skill_content,is_featured,metadata)
VALUES ('product-visual','商品图设计','商品主图、产品场景图和系列电商图片设计；重点保护真实产品特征、卖点与系列一致性。','Loomic','1.0','design','system','---
name: product-visual
description: 商品主图、产品场景图和系列电商图片设计；重点保护真实产品特征、卖点与系列一致性。
---

从用户素材识别产品类型、外形、包装、Logo、规格和不能改变的特征；区分有证据的事实与不确定细节。缺少必要参考图时先明确限制，不凭空声称保持真实外观。

根据用途选择白底识别、使用场景、细节展示或卖点说明。开放探索时在场景和信息表达上提出有区别的方向；用户指定方向时按要求实施。

生成提示中明确要保留的产品形状、比例、标签和数量。不要添加不存在的配件、认证、功效、包装文字或价格。

需要准确产品外观时，优先使用原产品素材配合可编辑背景和文案；不要把整图重新生成当作无损修改。

系列图固定产品尺度、光线逻辑、品牌色与排版体系，各张承担不同的信息任务。明确每张图片的目的与资源需求，避免未经用户要求无限生成变体。

检查产品是否变形、数量与标识是否准确、阴影是否合理、卖点是否有素材依据。工具返回成功不能代替视觉核验。

遵循现有生成确认、计费和资产权限，不承诺模型无法保证的精确还原。
',true,'{"bundle":"loomic-design-workflow-v1"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,skill_content=EXCLUDED.skill_content,version=EXCLUDED.version,metadata=EXCLUDED.metadata,updated_at=now()
WHERE skills.source='system' AND skills.created_by IS NULL;

INSERT INTO public.skills (slug,name,description,author,version,category,source,skill_content,is_featured,metadata)
VALUES ('design-review','设计评审','对已有设计提出具体、有依据的改进建议，或在复杂设计完成后检查质量；不把普通移动、改字任务扩展为全面重设计。','Loomic','1.0','design','system','---
name: design-review
description: 对已有设计提出具体、有依据的改进建议，或在复杂设计完成后检查质量；不把普通移动、改字任务扩展为全面重设计。
---

先确认设计用途、固定要求和用户希望检查的问题。评审参考当前版本，避免把个人偏好当作错误。

只有真正收到图像或视觉分析时才评价视觉事实。截图 URL、任务成功和对象坐标不能单独证明图像内容正确；缺少视觉信息时仅做结构检查并说明范围。

检查顺序：硬性要求与准确文字、信息层级与可读性、对齐留白与遮挡、品牌一致性、目标尺寸适配。Logo 加查小尺寸识别，宣传图加查行动入口，商品图加查产品保真。

优先指出最影响目标的 1～3 个问题。每个问题给出位置或对象、可观察现象、影响及具体调整。区分事实错误、目标相关建议和可选审美方向。

例如：“标题与副标题字重相近，优惠信息没有突出；可降低副标题字重并扩大两者间距。”不要只说“提升高级感”。

用户仅要求点评时不要修改或生成。要求优化时保留已批准方向，仅执行必要改动，使用现有权限与确认流程。

修改后对照原问题检查；最多提出有依据的下一轮建议，不自动进入无限生成和自我打分循环。
',true,'{"bundle":"loomic-design-workflow-v1"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,skill_content=EXCLUDED.skill_content,version=EXCLUDED.version,metadata=EXCLUDED.metadata,updated_at=now()
WHERE skills.source='system' AND skills.created_by IS NULL;

INSERT INTO public.skills (slug,name,description,author,version,category,source,skill_content,is_featured,metadata)
VALUES ('reference-analysis','参考图分析','分析参考图片的构图、字体、色彩、材质和可借鉴的设计关系；用于参考理解或比较，不代替图片生成。','Loomic','1.0','design','system','---
name: reference-analysis
description: 分析参考图片的构图、字体、色彩、材质和可借鉴的设计关系；用于参考理解或比较，不代替图片生成。
---

先明确用户要借鉴什么、保留什么、避免什么；已有说明不重复询问。

只有实际图像或可信视觉分析可以作为视觉事实。仅有截图 URL、文件名或对象坐标时说明信息限制，不能推断细节。多图逐一标识，避免把不同图的信息混在一起。

从视觉焦点、构图比例、文字层级、色彩对比、材质及留白分析；优先关注与用户目标有关的部分。难以辨认的文字明确标注，不编造字体名称或精确色号。

区分“可见事实”“设计推断”“迁移建议”。参考的关系可以借鉴，例如大小对比或非对称布局；不要机械复制他人标志或独特构图。

给出可执行的设计约束：背景与主体对比、标题占比、留白位置、可编辑文字和图片分层建议。保留品牌已有要求。

用户只要求分析时不生成、不修改。需要更细分析但现有工具不能提供视觉输入时说明待核验项。
',true,'{"bundle":"loomic-design-workflow-v1"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,skill_content=EXCLUDED.skill_content,version=EXCLUDED.version,metadata=EXCLUDED.metadata,updated_at=now()
WHERE skills.source='system' AND skills.created_by IS NULL;

INSERT INTO public.skills (slug,name,description,author,version,category,source,skill_content,is_featured,metadata)
VALUES ('creative-directions','创意方向探索','为开放式设计需求探索差异化概念、比较方案并解释取舍；已指定方向或简单修改时不启动多方案。','Loomic','1.0','design','system','---
name: creative-directions
description: 为开放式设计需求探索差异化概念、比较方案并解释取舍；已指定方向或简单修改时不启动多方案。
---

先提取设计目标与固定条件，界定本轮允许变化的变量。已有品牌、主体和准确文案不可任意变更。

用户允许探索时提出少量有本质区别的方向；用户要求一版就深入一版。差异来自核心概念、视觉组织、主体表达或字形策略，不能仅换颜色和材质。

每个方向给出核心记忆点、构图与素材组织、为什么适合目标、一个限制。推荐方向必须联系使用场景和受众，不用“更高级”代替理由。

交叉比较：如果两方案去掉风格形容词后仍是同一布局，应合并或换一种构思。不要为凑数量提供弱方案。

用户已选定方向时停止发散，保存对话中的决定并进入执行；收到局部修改不要重新生成整套概念。

讨论方案不自动触发付费生成。准备制作时按现有工具和产品确认执行，不为每个探索方向自动生图。
',true,'{"bundle":"loomic-design-workflow-v1"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,skill_content=EXCLUDED.skill_content,version=EXCLUDED.version,metadata=EXCLUDED.metadata,updated_at=now()
WHERE skills.source='system' AND skills.created_by IS NULL;

INSERT INTO public.skills (slug,name,description,author,version,category,source,skill_content,is_featured,metadata)
VALUES ('typography-layout','字体与版式','为宣传图、海报及设计画板建立文字层级、网格、留白与字体搭配；不把简单改字扩展为全面排版。','Loomic','1.0','design','system','---
name: typography-layout
description: 为宣传图、海报及设计画板建立文字层级、网格、留白与字体搭配；不把简单改字扩展为全面排版。
---

根据媒介、画板尺寸、文案长度和观看距离确定阅读优先级。准确文字内容是约束，不为好看删改价格、日期、品牌名称。

先建立主标题、副标题、正文和辅助信息层级，再处理字重、行距、对齐和留白。减少无目的的字体种类，用比例和对比组织信息。

只使用项目能获取的字体资源和真实 ID；字体不可用时明确降级，不声称已加载。中英文混排注意基线、字重观感和缺字，不能仅按字符数量保证无溢出。

优先保留可编辑文字，不将整张版式烧进图片。操作遵循当前设计对象版本，保持用户锁定或未要求修改的部分。

按目标尺寸检查边界、安全区、段落密度、对齐和遮挡。没有实际测量或视觉输入时不得承诺像素精确或已完成视觉验收。

简单改字直接执行；完整排版才需要上述流程。
',true,'{"bundle":"loomic-design-workflow-v1"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,skill_content=EXCLUDED.skill_content,version=EXCLUDED.version,metadata=EXCLUDED.metadata,updated_at=now()
WHERE skills.source='system' AND skills.created_by IS NULL;

INSERT INTO public.skills (slug,name,description,author,version,category,source,skill_content,is_featured,metadata)
VALUES ('design-refinement','反馈与定向修改','将设计反馈转成受控的局部调整，保留已认可内容；用于迭代，不自动扩展为重设计。','Loomic','1.0','design','system','---
name: design-refinement
description: 将设计反馈转成受控的局部调整，保留已认可内容；用于迭代，不自动扩展为重设计。
---

先从可见对话识别已定稿内容、被拒绝方向和本轮反馈。明确这次改变的对象与保持不变的对象。

“高级、简洁、有冲击力”等表述要结合当前证据解释为具体变化，如减少装饰竞争、调整留白或扩大主次对比；不要只把形容词追加到生成提示。

反馈存在两种会明显改变结果的解释时简短澄清；其余情况下说明合理理解并执行，避免反复追问。

优先使用可编辑对象做局部修改。用户只要求换文字、移动或尺寸调整时，不使用整图重新生成；需要生图则说明可能改变的范围并沿用现有确认流程。

一次迭代集中处理最关键的变量，保留用户明确认可部分。对比说明具体改了什么，不声称模型输出绝对保真。

用户只征求建议时不写入。没有实际视觉输入时不能假装看到修改结果；也不自动循环重试付费任务。
',true,'{"bundle":"loomic-design-workflow-v1"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,skill_content=EXCLUDED.skill_content,version=EXCLUDED.version,metadata=EXCLUDED.metadata,updated_at=now()
WHERE skills.source='system' AND skills.created_by IS NULL;

INSERT INTO public.skills (slug,name,description,author,version,category,source,skill_content,is_featured,metadata)
VALUES ('design-delivery','多尺寸适配与交付','把已确定设计适配不同尺寸并检查交付规格；支持现有格式，不虚构印刷、矢量或色彩管理能力。','Loomic','1.0','design','system','---
name: design-delivery
description: 把已确定设计适配不同尺寸并检查交付规格；支持现有格式，不虚构印刷、矢量或色彩管理能力。
---

先确认需要的尺寸、格式、透明背景、使用渠道及是否需要可编辑版本；不要自动增加用户未要求的交付物。

适配时保留核心信息和品牌，重新组织构图、裁切与文字层级，不将整图非等比拉伸。区分改变画板尺寸与缩放所有内容。

逐个目标尺寸检查主体完整性、文字边界、阅读顺序和安全留白。只对实际检查过的内容下结论。

按当前可用导出工具输出，并确认任务完成与文件可获取；拿到 jobId 不代表导出完成。

PNG/JPEG 等位图不得称为可编辑矢量。CMYK、出血、字体嵌入和印刷 PDF 仅在工具实际支持且检验后承诺，否则指出需后续处理。

多版本命名带尺寸或用途，保留原设计；覆盖、删除和付费任务继续遵循产品确认。
',true,'{"bundle":"loomic-design-workflow-v1"}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,skill_content=EXCLUDED.skill_content,version=EXCLUDED.version,metadata=EXCLUDED.metadata,updated_at=now()
WHERE skills.source='system' AND skills.created_by IS NULL;
