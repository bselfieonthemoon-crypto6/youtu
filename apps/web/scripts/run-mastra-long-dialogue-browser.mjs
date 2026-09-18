// Real UI turns, not seeded history or a mocked model. Stops on first failure.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
assert(process.argv.includes('--submit'), '--submit explicitly authorizes real model calls');
const fixture = arg('fixture');
assert(fixture);
const cases = [
  ['开始一组新系列设计讨论，暂时不要生成。新品牌是 LARK STUDIO（不是 MOSS COFFEE），做城市花店。主色先考虑珊瑚橙，辅色奶油白。宣传文案先考虑 BLOOM TODAY，活动日期 10 月 18 日，地点河畔店；不要电话和二维码。先用两句话复述，后面我会逐项修订。', ['LARK STUDIO', 'BLOOM TODAY']],
  ['修正一下：主色不要珊瑚橙了，改深紫色，奶油白保留。品牌不变。只记住这次修订，不生成，简短答复。', ['深紫']],
  ['文案也改一下，不要 BLOOM TODAY，最终英文是 FIND YOUR BLOOM。活动改 10 月 20 日，地点仍然河畔店。请确认最终文案和日期，不生图。', ['FIND YOUR BLOOM', '20']],
  ['先讨论用图：这次新品牌不能挪用咖啡品牌的双叶标识，也不要咖啡杯或咖啡豆。主视觉可以是纸艺花束和有层次的花瓣，避免写实人像；表现城市街角小店的亲切、干净、轻松。请说说纸艺花束与立体陶瓷花瓶两个方向的区别，只讨论不执行。', []],
  ['选择纸艺花束方向，放弃陶瓷花瓶。比例先暂定 4:5，不生成。请用一句话总结选择。', ['纸艺', '4:5']],
  ['现在只是问问，换成浅粉色会不会显得更柔和？这不是确认改色，也不要生成。请分析两个颜色对比，不改变已确定的主色。', []],
  ['继续确认排版方向，但不要生成：品牌名完整拼写要放顶端，宣传文案要比地点和日期醒目；花束不能挡住文字。留足奶油白空间，整体有编辑式的秩序，边缘不要堆太多装饰，不要价格、二维码、网址、假水印。说一下信息层级即可。', []],
  ['我又改主意了，成品不是 4:5，要 3:4 竖版。图面上的英文文案和活动日期仍按最后确认版本。现在不生图，只复述最终比例、文案和日期。', ['3:4', 'FIND YOUR BLOOM', '20']],
  ['临时插一句旧项目：MOSS COFFEE 已经有两张横版，先保持它们不动。现在主项目还是新的花店。不要生成，告诉我两者的品牌区分。', ['LARK STUDIO', 'MOSS COFFEE']],
  ['回到花店。还缺品牌名吗？如果之前有了不要再问我。当前只是核对信息，不执行。简短回答。', ['LARK STUDIO']],
  ['我们想做系列感：以后可以延伸同色系的社交媒体配图、门店海报和纸袋。但是这些是未来想法，不是现在让你生成多张；本轮只讨论怎样保持同一品牌的字体、配色、花束语言。请给三条建议。', []],
  ['最终核对，先不要生成：列出我们最后确定的品牌、主色、辅色、唯一英文宣传文案、活动日期、地点、比例、主视觉。不要混入被否定的早期选项，也不要混进 MOSS COFFEE 的元素。', ['LARK STUDIO', '深紫', '奶油白', 'FIND YOUR BLOOM', '20', '河畔', '3:4', '纸艺']],
  ...[
    '纸艺花瓣怎样表现手工折痕，同时避免做成真实摄影或油画',
    '品牌名字距、主文案换行与远距离阅读的关系',
    '深色印刷与奶油白纸张之间怎样避免文字对比不足',
    '花束和文字区域怎样分开，怎样留出安全边距',
    '如何让同系列的门店海报和手机预览有一致的视觉印象',
    '日期与地点文字怎样清晰可读但不抢主文案',
    '怎样避免图像模型把折纸花束误画成陶瓷或塑料玩具',
    '图形与装饰线条的数量怎样控制，如何避免过度堆叠',
    '后续做尺寸变体时哪些内容应该固定，哪些布局可以变化',
    '如何检查生成图有没有多余英文、错误品牌字母或额外水印',
  ].map(topic => [`仍是当前花店项目，只讨论，不生成、不修改任何画布，也不更改已经确认的需求。请具体分析：${topic}。给出约400字的设计说明，包括原因、可采用方法和需要避免的问题。不要把这里的讨论当作新的执行授权。`, []]),
  ['这些讨论结束了，回头只核对最终执行用的八项信息：品牌、主色、辅色、唯一英文宣传文案、日期、地点、比例、主视觉。要求采用此前最后确认版本，不重新向我收集已提供的信息。现在还不要生成。', ['LARK STUDIO', '深紫', '奶油白', 'FIND YOUR BLOOM', '20', '河畔', '3:4', '纸艺']],
];
const start = Number(arg('start') ?? 0), count = Number(arg('count') ?? cases.length);
const directory = resolve(dirname(fixture), 'browser-turns');
const report = { startedAt: new Date().toISOString(), kind: 'real_browser_conversation', turns: [] };
await mkdir(directory, { recursive: true });
try {
  for (let index = start; index < Math.min(cases.length, start + count); index++) {
    const [prompt, required] = cases[index];
    const before = new Set(await readdir(directory));
    const code = await new Promise((done, reject) => {
      const child = spawn(process.execPath, ['--env-file=../../artifacts/local-replica-20260907/app.env',
        'scripts/run-paid-dialogue-browser.mjs', '--submit', '--product-defaults', `--fixture=${fixture}`,
        `--prompt=${prompt}`, '--timeout-minutes=4'], { stdio: 'inherit' });
      child.on('error', reject); child.on('exit', done);
    });
    const files = (await readdir(directory)).filter(f => !before.has(f) && f.endsWith('.json'));
    assert.equal(files.length, 1, 'Expect exactly one new turn evidence; do not run another probe in this directory concurrently');
    const evidence = JSON.parse(await readFile(resolve(directory, files[0]), 'utf8'));
    const result = { index, evidence: files[0], runId: evidence.runId, status: evidence.status,
      required, missing: required.filter(s => !evidence.assistant.includes(s)) };
    report.turns.push(result);
    assert.equal(code, 0, 'Browser process failed');
    assert.equal(evidence.status, 'run.completed');
    const writeNames = new Set(['generate_image', 'edit_image', 'generate_video', 'cancel_image_job',
      'manipulate_canvas', 'manipulate_design', 'apply_design_template', 'create_design_boards',
      'arrange_design_boards', 'persist_sandbox_file', 'export_design']);
    const writes = (evidence.toolStarts ?? []).filter(t => writeNames.has(t.toolName));
    assert.equal(writes.length, 0, 'Discussion must not write');
    assert.deepEqual(result.missing, [], 'Check semantic evidence before calling missing spelling a product failure');
    console.log(`PASS real dialogue turn ${index + 1}`);
  }
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  const path = resolve(dirname(fixture), `long-dialogue-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(`Batch evidence: ${path}`);
}
