import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspace = '25eb32ef-ff55-4de7-8c10-9390a51ece06';
const actor = '541006fa-d2a1-4305-be55-b6263c27a1e3';
const specs = [
  ['站点 Logo',480,112,'PNG ≤200KB；宽高各允许 ±15px'],
  ['APP 图标',512,512,'PNG ≤200KB；宽高各允许 ±15px'],
  ['首页轮播',656,288,'GIF ≤500KB；静态图 ≤300KB；宽高各允许 ±15px'],
  ['首页小图',350,300,'动图 ≤150KB；宽高各允许 ±15px'],
  ['首页下载图',720,96,'≤200KB；宽高各允许 ±15px'],
  ['推广配置图',512,268,'动图 ≤200KB；宽高各允许 ±15px'],
  ['APP 启动宣传图',719,1280,'固定尺寸；GIF ≤300KB；静态图 ≤200KB'],
  ['首页小浮标',115,115,'PNG/GIF ≤180KB；宽高各允许 ±15px'],
  ['PWA 推广图',340,320,'固定尺寸；PNG ≤300KB；原需求同时提到动图，格式待确认'],
  ['智能 APK 启动图',1080,1920,'PNG ≤800KB；可选另一规格 1440×2560'],
  ['智能 APK 启动图',1440,2560,'PNG ≤800KB；可选另一规格 1080×1920'],
  ['首页弹窗',600,800,'GIF ≤350KB；静态图 ≤180KB；宽高各允许 ±15px'],
  ['活动横幅',656,176,'动图 ≤300KB；宽高各允许 ±15px'],
] as const;
if (process.env.SUPABASE_URL !== 'http://127.0.0.1:54421') throw Error('Local database only');
const db = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await db.connect();
const hashProtected = async () => {
  const result: Record<string,string> = {};
  for (const table of ['canvases','design_documents','asset_objects','font_faces','text_presets']) {
    result[table] = (await db.query(`select md5(coalesce(string_agg(row_to_json(t)::text, '' order by id),'')) as hash from public.${table} t`)).rows[0].hash;
  }
  return result;
};
try {
  await db.query('BEGIN');
  const owner = (await db.query('select owner_user_id from workspaces where id=$1',[workspace])).rows[0];
  if (owner?.owner_user_id !== actor) throw Error('Workspace owner changed');
  const templates = (await db.query('select * from design_templates where workspace_id=$1 and deleted_at is null order by id for update',[workspace])).rows;
  const resources = (await db.query('select * from design_resources where workspace_id=$1 and deleted_at is null order by id for update',[workspace])).rows;
  const referenced = (await db.query('select distinct resource_id from design_document_asset_refs union select distinct resource_id from design_template_asset_refs')).rows;
  const inUse = new Set(referenced.map(r => r.resource_id));
  const removable = resources.filter(r => !inUse.has(r.id));
  const skipped = resources.filter(r => inUse.has(r.id)).map(r => ({id:r.id,name:r.name}));
  const before = await hashProtected();
  console.log(JSON.stringify({templates:templates.length,removableResources:removable.length,skipped,specs:specs.length}));
  if (!process.argv.includes('--apply')) { await db.query('ROLLBACK'); process.exitCode=0; }
  else {
    if (templates.length !== 141 || resources.length !== 3965) throw Error('Catalog changed or reset already applied; inspect before retry');
    const backup = resolve('../../artifacts',`website-library-backup-${Date.now()}.json`);
    await writeFile(backup,JSON.stringify({workspace,actor,templates,resources,before},null,2),{flag:'wx'});
    for (const [kind,rows] of [['template',templates],['resource',removable]] as const) {
      for (const row of rows) await db.query('select public.loomic_catalog_set_deleted($1,$2,$3,$4,true,$5)',[randomUUID(),kind,row.id,row.revision,actor]);
      console.log(`${kind}: ${rows.length} soft deleted`);
    }
    for (const [label,width,height,note] of specs) {
      const payload={name:`${label} · ${width}×${height}`,description:`网站尺寸空白模板。${note}。文件限制为导出要求，不由空白模板自动保证。`,scene:{schemaVersion:1,engine:'fabric',canvas:{width,height,background:'rgba(255,255,255,1)'},objects:[]}};
      await db.query("select public.loomic_catalog_create($1,'template','workspace',$2,$3::jsonb,$4)",[randomUUID(),workspace,JSON.stringify(payload),actor]);
    }
    const after=await hashProtected();
    if(JSON.stringify(before)!==JSON.stringify(after)) throw Error('Protected data changed; rollback');
    const created=(await db.query('select id,name,width,height,scene,status from design_templates where workspace_id=$1 and deleted_at is null order by name',[workspace])).rows;
    if(created.length!==13 || created.some(r=>r.scene.objects.length!==0)) throw Error('Preset verification failed');
    const remaining=(await db.query('select count(*)::int as count from design_resources where workspace_id=$1 and deleted_at is null',[workspace])).rows[0].count;
    if(remaining!==skipped.length) throw Error('Resource count mismatch');
    await db.query('COMMIT');
    const report={backup,deletedTemplates:templates.length,deletedResources:removable.length,skipped,created,protectedDataUnchanged:true};
    await writeFile(`${backup}.report.json`,JSON.stringify(report,null,2),{flag:'wx'});
    console.log(JSON.stringify(report));
  }
} catch(error) { await db.query('ROLLBACK'); throw error; }
finally { await db.end(); }
