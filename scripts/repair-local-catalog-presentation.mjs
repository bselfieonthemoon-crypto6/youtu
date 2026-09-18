import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {loomicSceneV1Schema,designTextPresetContentSchema} from '../packages/shared/dist/design-contracts.js';
const require=createRequire(new URL('../apps/server/package.json',import.meta.url));
const {Pool}=require('pg');
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const db=new Pool({connectionString:process.env.SUPABASE_DB_URL});
const apply=process.argv.includes('--apply');
const uuid=s=>{const h=createHash('sha256').update('loomic-local-library-v1:'+s).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const root='C:/Users/lenovo/Downloads/新建文件夹/画布插件/public/local-data/';
const backup=[];const report={repaired:0,qaArchived:0,counts:{},invalid:[],missingAssets:[]};
try {
 assert.equal((await db.query('select current_database() as name')).rows[0].name,'loomic_replica_light_20260907');
 const library=JSON.parse(await readFile(root+'content-libraries.json','utf8'));
 const templates=JSON.parse(await readFile(root+'templates.json','utf8'));
 const originals=new Map();
 for(const t of library.fontStyles) originals.set(uuid('text:'+t.id+':0'),t.attributes.json);
 for(const t of templates.templates) t.attributes.json.objects.forEach((o,i)=>originals.set(uuid('template:'+t.id+':'+i),o));
 await db.query('BEGIN');
 for(const [table,column] of [['text_presets','style'],['design_templates','scene']]) {
  const rows=(await db.query(`select * from ${table} where deleted_at is null for update`)).rows;
  report.counts[table]=rows.length;
  for(const row of rows) {
   if(row.author==='Local QA' && row.license_name==='Test fixture' && row.usage_restrictions==='Local test only' && row.name.startsWith('QA updated ')) {
    backup.push({table,row});report.qaArchived++;
    if(apply) await db.query(`update ${table} set deleted_at=now(),revision=revision+1,updated_at=now() where id=$1`,[row.id]);
    continue;
   }
   const value=structuredClone(row[column]);let changed=false;
   for(const o of value.objects) {
    const source=originals.get(o.objectId);
    if(!source || !['text','textbox'].includes(o.type))continue;
    for(const [key,val] of [['paintFirst',source.paintFirst??'fill'],['splitByGrapheme',source.splitByGrapheme??false]]) {
     if(o[key]!==val){o[key]=val;changed=true;}
    }
   }
   const checked=(column==='scene'?loomicSceneV1Schema:designTextPresetContentSchema).safeParse(value);
   if(!checked.success){report.invalid.push({table,id:row.id});continue;}
   if(changed){backup.push({table,row});report.repaired++;
    if(apply)await db.query(`update ${table} set ${column}=$2,revision=revision+1,updated_at=now() where id=$1`,[row.id,JSON.stringify(value)]);
   }
  }
 }
 for(const table of ['design_resources','font_families']) {
  const rows=(await db.query(`select * from ${table} where deleted_at is null and author='Local QA' and license_name='Test fixture' and usage_restrictions='Local test only' and name like 'QA updated %' for update`)).rows;
  for(const row of rows){backup.push({table,row});report.qaArchived++;if(apply)await db.query(`update ${table} set deleted_at=now(),revision=revision+1,updated_at=now() where id=$1`,[row.id]);}
 }
 for(const table of ['design_resources','font_faces']){
  report.counts[table]=Number((await db.query(`select count(*) from ${table} where deleted_at is null`)).rows[0].count);
  report.missingAssets.push(...(await db.query(`select r.id,'${table}' as source from ${table} r left join asset_objects a on a.id=r.asset_object_id left join storage.objects s on s.bucket_id=a.bucket and s.name=a.object_path where r.deleted_at is null and s.id is null`)).rows);
 }
 await mkdir('artifacts/local-replica-20260907',{recursive:true});
 if(apply)await writeFile(`artifacts/local-replica-20260907/catalog-repair-backup-${Date.now()}.json`,JSON.stringify(backup));
 await db.query(apply?'COMMIT':'ROLLBACK');
 console.log(JSON.stringify({...report,apply},null,2));
}catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();}
