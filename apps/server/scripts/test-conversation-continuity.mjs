// Real-provider, user-driven dialogue acceptance. No fabricated chat history.
// Each subprocess sends one ordinary user turn and waits for the actual result.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const fixture = process.argv[2];
assert(fixture, 'Pass a dedicated QA fixture manifest');
const initialPrompts = [
  '纠正一下：品牌中文名是澄屿，不是澄岛，英文仍是 CHENGDAO。其他不变，暂不生成。',
  '第一张海报准备做 4:5，用于小红书。先只记录，不执行。',
  '主色改成深海蓝，不再用松绿。米白保留。只更新需求。',
  '我们可以讨论一下为什么无糖茶饮适合克制的设计吗？不要生成。',
  '之后还需要同系列的会员卡，横版 16:9。但先不做，也不要把海报改成横版。',
  '会员卡单独用银灰辅助色，海报继续米白。帮我核对一下两个物料的区别，不执行。',
  '山雾改名为山岚，是产品名，品牌名不要改。记下来，暂不生成。',
  '标题字体倾向宋体，正文用黑体。不要修改包装上的固定文案。先讨论。',
  '会员卡不要写产品名称，品牌名必须保留。还不用做。',
  '海报底部可以预留二维码位置，但不要编造二维码或门店地址。暂不执行。',
  '我说的预留是留白，不要画一个假的二维码。继续记住这些限制。',
  '你觉得同系列一致性应该体现在什么地方？只讨论，不生成。',
  '会员卡比例再改成 3:2，海报比例不动。不执行。',
  '先别做会员卡，优先讨论海报。会员卡需求不要丢掉。',
  '海报加一句「慢一点，喝好茶」，但原先那句必须仍然保留。暂不生成。',
  '刚加的那句话先取消，只取消这句新增文案，最早要求的那句保留。先别生成。',
  '不要用金色，也不要做奢华风；清爽克制就好。仍只讨论。',
  '现在用简短清单列出海报当前要求，特别是最新品牌名、产品名、比例和不能变的文案，不生成。',
  '再回顾会员卡的最终比例、辅助色、能不能放产品名。只回答，别执行。',
  '最终核对：分别列出海报和会员卡的所有有效要求，以及已经取消或改掉的旧要求。不要生成，不要建画板。',
];
const extended = process.argv.includes('--extended');
const prompts = extended ? [
  '继续刚才失败的核对，分别复述海报和会员卡的有效要求。不要生成，不建画板。后续只讨论，每次尽量简短。',
  ...Array.from({ length: 10 }, (_, round) => [
    `海报额外加一个小标题「青山来信${round + 1}」，最初的固定文案保留。只讨论，不执行。`,
    `刚才的小标题改成「山间茶事${round + 1}」，只替换这个小标题，产品名和品牌不变。暂不执行。`,
    '这个小标题适合放在主标题旁边还是底部？仅给建议，不要当成我确认了新方案。用两句话回答。',
    `会员卡暂定加活动编号「CD-${round + 1}」，不要把海报小标题搬到卡上。只讨论。`,
    '取消刚加的活动编号，会员卡回到没有活动编号的状态。只撤回这一项，不取消整张卡。暂不执行。',
    '海报现在的小标题是什么？最早那句固定文案还在吗？只回答，不调用生成。',
    '海报刚才新增的小标题也取消，回到没有额外小标题的版本。其他长期要求继续保留，先不生成。',
    '检查现在两种物料各自的比例和辅助色，再核对品牌名、产品名、固定文案、会员卡禁用的内容。简短回答，绝对不要生成。',
  ]).flat(),
] : initialPrompts;
const existing = JSON.parse(readFileSync(fixture, 'utf8')).turns;
const startIndex = extended ? Math.max(0, existing.length - 21) : 0;
if (extended && startIndex) assert.equal(existing.at(-1).prompt, prompts[startIndex - 1], 'Unexpected fixture history; review before resuming');
for (let i = startIndex; i < prompts.length; i++) {
  const before = JSON.parse(readFileSync(fixture, 'utf8')).turns.length;
  const run = spawnSync(process.execPath, ['--env-file=../../artifacts/local-replica-20260907/app.env', '--import', 'tsx',
    'scripts/test-paid-dialogue-live.ts', '--turn', prompts[i], '--submit', '--fixture', fixture],
  { encoding: 'utf8', timeout: 240000 });
  assert.equal(run.status, 0, `Turn ${i + 1} failed: ${run.stdout}\n${run.stderr}`);
  const state = JSON.parse(readFileSync(fixture, 'utf8'));
  assert.equal(state.turns.length, before + 1);
  const turn = state.turns.at(-1);
  assert.equal(turn.runStatus, 'completed');
  assert.equal(turn.jobs.length, 0, 'Discussion must not generate paid images');
  assert.equal(turn.observedJobIds.length, 0);
  const reply = (turn.assistantTexts ?? []).join('\n');
  if (extended && i > 0 && (i - 1) % 8 === 5) {
    const subtitle = `山间茶事${Math.floor((i - 1) / 8) + 1}`;
    assert(reply.includes(subtitle) && reply.includes('无糖，也有回甘'),
      `Latest correction lost at turn ${turn.index}: ${reply}`);
  }
  console.log(JSON.stringify({ turn: turn.index, prompt: prompts[i], responses: turn.assistantTexts?.map(t => t.slice(0, 1800)),
    tools: turn.toolEvidence.map(t => t.toolName) }));
}
console.log('Continuity sequence finished; semantic responses require review, not merely exit-code success.');
