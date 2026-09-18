// Real UI turns for Mastra Memory acceptance. No images or write actions are requested.
// This is a QA harness: it uses only the supplied fixture, never the ambient browser session.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
assert(process.argv.includes('--submit'), '--submit explicitly authorizes real model calls');
const fixture = arg('fixture');
assert(fixture, '--fixture is required (use the QA fixture, not the ambient browser session)');

// Deliberately uncommon exact values make cross-turn Memory recall distinguishable from defaults.
const keyFacts = {
  brand: '潮汐织所',
  slogan: 'MAKE ROOM FOR LIGHT',
  hex: '#6B4EFF',
  ratio: '2:3',
};
const cases = [
  {
    prompt: `我们开始一个全新的品牌讨论，先只记录需求，不生成图片，也不要修改画布。品牌名必须逐字写作“${keyFacts.brand}”，英文宣传语是“${keyFacts.slogan}”，主色先定为 #243B53，画布比例先定 4:5。请复述这四项。`,
    required: [keyFacts.brand, keyFacts.slogan, '#243B53', '4:5'],
  },
  {
    prompt: `修订刚才的${keyFacts.brand}方案：主色改成 ${keyFacts.hex}，品牌名、英文宣传语和比例保持不变。只确认修订结果，不生成、不执行。`,
    required: [keyFacts.hex, keyFacts.brand],
  },
  {
    prompt: `活动日期改为 11 月 23 日，地点先记为南岸店；仍然只讨论，不生图。请确认日期和地点。`,
    required: ['23', '南岸店'],
  },
  {
    prompt: `比例现在改为 ${keyFacts.ratio}，不要把它当成生成授权。请只回答当前比例。`,
    required: [keyFacts.ratio],
  },
  {
    prompt: '假设以后把主色试成亮黄色，可能更醒目吗？这只是一个未采用的假设，不要改动已确认的颜色，也不要生成。请比较后明确说明没有采纳。',
    required: [],
  },
  {
    prompt: '之前顺带考虑过加入金色边框，现在取消这个想法；不要把取消的边框当作当前需求，也不要生成。请简短确认。',
    required: [],
  },
  {
    prompt: '切换一下上下文：旧项目 MOSS COFFEE 的横版稿件保持不动。请回到当前的新品牌项目，说明当前品牌名，不生成。',
    required: [keyFacts.brand],
  },
  {
    prompt: `回到${keyFacts.brand}。请检查英文宣传语是否仍是“${keyFacts.slogan}”，不要因为我提到旧项目而替换它，也不要执行任何工具。`,
    required: [keyFacts.slogan],
  },
  {
    prompt: '我只是问问：如果把比例做成 1:1，社交头像会有什么优点？这不是确认修改，当前比例保持不变；不要生成。',
    required: [],
  },
  {
    prompt: `只做一次记忆核对，不生成、不改画布、不调用写入工具：当前品牌名、主色、活动日期、地点和比例分别是什么？主色应以最后一次已确认的修订为准。`,
    required: [keyFacts.brand, '#6B4EFF', '23', '南岸店', keyFacts.ratio],
  },
  {
    prompt: '未来可以讨论包装和门店海报的延展，但这只是未执行的计划。请说明你会保留哪些品牌一致性信息，不要生成多张图，也不要把计划当成授权。',
    required: [],
  },
  {
    prompt: '最终核对，仍然不要生成或执行：请从此前对话中回忆，逐字列出当前品牌名、唯一英文宣传语、最后确认的主色十六进制值、比例、活动日期和地点。不要混入假设、取消项或旧项目的信息。',
    required: [keyFacts.brand, keyFacts.slogan, keyFacts.hex, keyFacts.ratio, '23', '南岸店'],
  },
];

if (process.argv.includes('--soak')) {
  const topics = ['纸张纹理和文字清晰度', '远距离阅读与字号层级', '画面留白和内容密度',
    '印刷与屏幕色彩差异', '系列作品如何统一而不重复', '主视觉和背景的关系',
    '中文与英文的排版节奏', '移动端预览和海报观看距离', '装饰元素的取舍', '交付前的文字与比例检查'];
  cases.splice(cases.length - 1, 0, ...topics.map(topic => ({
    prompt: `继续当前新品牌的设计讨论，不改变任何已确认内容，不生成图片、不修改画布。请围绕“${topic}”写约400字通用分析，仅为设计建议，不将新建议视为已采纳需求。本轮不要复述品牌名、宣传语、色号、日期、地点或比例，也不要在结尾重复已确认事项。`,
    required: [],
  })));
}

const start = Number(arg('start') ?? 0);
const count = Number(arg('count') ?? cases.length);
assert(Number.isInteger(start) && start >= 0 && start < cases.length, '--start must select a case');
assert(Number.isInteger(count) && count >= 1, '--count must be a positive integer');
const directory = resolve(dirname(fixture), 'browser-turns');
const report = { startedAt: new Date().toISOString(), kind: 'mastra_memory_acceptance', fixture, turns: [] };
const writeNames = new Set([
  'generate_image', 'edit_image', 'generate_video', 'cancel_image_job', 'manipulate_canvas',
  'manipulate_design', 'apply_design_template', 'create_design_boards', 'arrange_design_boards',
  'persist_sandbox_file', 'export_design',
]);
await mkdir(directory, { recursive: true });

try {
  for (let index = start; index < Math.min(cases.length, start + count); index++) {
    const { prompt, required } = cases[index];
    const before = new Set(await readdir(directory));
    const code = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [
        '--env-file=../../artifacts/local-replica-20260907/app.env',
        'scripts/run-paid-dialogue-browser.mjs', '--submit', '--product-defaults', `--fixture=${fixture}`,
        `--prompt=${prompt}`, '--timeout-minutes=4',
      ], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', done);
    });
    const files = (await readdir(directory)).filter(name => !before.has(name) && name.endsWith('.json'));
    assert.equal(files.length, 1, 'Expected exactly one new turn evidence');
    const evidenceFile = files[0];
    const evidence = JSON.parse(await readFile(resolve(directory, evidenceFile), 'utf8'));
    const writes = (evidence.toolStarts ?? []).filter(event => writeNames.has(event.toolName));
    const missing = required.filter(value => !evidence.assistant.includes(value));
    const result = { index, evidence: evidenceFile, runId: evidence.runId, status: evidence.status,
      required, missing, writeTools: writes.map(event => event.toolName) };
    report.turns.push(result);
    assert.equal(code, 0, 'Browser process failed');
    assert.equal(evidence.status, 'run.completed');
    assert.deepEqual(writes, [], 'Memory discussion must not invoke write tools');
    assert.deepEqual(missing, [], `Stable key facts missing in turn ${index + 1}`);
    console.log(`PASS Mastra Memory dialogue turn ${index + 1}`);
  }
} catch (error) {
  report.error = String(error.message);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const output = resolve(dirname(fixture), `memory-acceptance-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(`Memory acceptance evidence: ${output}`);
}
