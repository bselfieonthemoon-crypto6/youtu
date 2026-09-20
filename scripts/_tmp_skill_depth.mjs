import fs from 'node:fs';
import path from 'node:path';

const root = 'E:/Loomic/Loomic/skills';
const dirs = fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()).sort();

const rows = [];
for (const d of dirs) {
  const dir = path.join(root, d);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const l = (manifest.metadata && manifest.metadata.loomic) || {};

  const skillMd = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const bodyLines = skillMd.split('\n').filter((x) => x.trim() && !x.startsWith('---') && !/^\s*(name|description|metadata|author|version):/.test(x)).length;

  let refCount = 0;
  let refBytes = 0;
  const refsDir = path.join(dir, 'references');
  if (fs.existsSync(refsDir)) {
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const fp = path.join(p, e.name);
        if (e.isDirectory()) walk(fp);
        else if (e.isFile() && /\.(md|txt|json)$/.test(e.name)) {
          refCount += 1;
          refBytes += fs.statSync(fp).size;
        }
      }
    };
    walk(refsDir);
  }

  rows.push({
    slug: d,
    ver: manifest.version,
    cat: manifest.category,
    exec: l.execution || '-',
    role: (l.composition && l.composition.role) || '-',
    prio: (l.routing && l.routing.priority) !== undefined ? l.routing.priority : '-',
    reqTools: (l.requiredTools || []).length,
    intents: (l.intents || []).length,
    lim: (l.limitations || []).length,
    src: (l.sources || []).length,
    bodyLines,
    refCount,
    refKB: Math.round(refBytes / 1024),
  });
}

const pad = (v, n) => String(v).padEnd(n);
console.log(pad('slug', 26) + pad('ver', 8) + pad('exec', 10) + pad('role', 10) + pad('prio', 5) + pad('tools', 6) + pad('intents', 8) + pad('lim', 4) + pad('src', 4) + pad('body', 5) + pad('refs', 5) + 'refKB');
console.log('-'.repeat(105));
for (const r of rows) {
  console.log(
    pad(r.slug, 26) + pad(r.ver, 8) + pad(r.exec, 10) + pad(r.role, 10) + pad(r.prio, 5) +
    pad(r.reqTools, 6) + pad(r.intents, 8) + pad(r.lim, 4) + pad(r.src, 4) + pad(r.bodyLines, 5) + pad(r.refCount, 5) + r.refKB,
  );
}

console.log('\n=== 体量排序（正文行数 + 参考KB）===');
[...rows].sort((a, b) => (a.bodyLines + a.refKB) - (b.bodyLines + b.refKB))
  .forEach((r) => console.log(`  ${pad(r.slug, 26)} body=${pad(r.bodyLines, 4)} refs=${pad(r.refCount, 3)} refKB=${r.refKB}`));

console.log('\n=== 汇总 ===');
console.log(`技能数: ${rows.length}`);
console.log(`execution 分布: ${JSON.stringify(rows.reduce((a, r) => ((a[r.exec] = (a[r.exec] || 0) + 1), a), {}))}`);
console.log(`category 分布: ${JSON.stringify(rows.reduce((a, r) => ((a[r.cat] = (a[r.cat] || 0) + 1), a), {}))}`);
console.log(`有 sources 的技能数: ${rows.filter((r) => r.src > 0).length}/${rows.length}`);
console.log(`无 sources 的技能: ${rows.filter((r) => r.src === 0).map((r) => r.slug).join(', ')}`);
console.log(`无 references 目录的技能: ${rows.filter((r) => r.refCount === 0).map((r) => r.slug).join(', ')}`);
console.log(`正文 <= 20 行的技能: ${rows.filter((r) => r.bodyLines <= 20).map((r) => r.slug).join(', ')}`);
