// Usage (from apps/server): node --env-file=../../.env.local --import tsx ../../scripts/import-local-design-library.mjs [--apply]
// Additive import: deterministic request/asset IDs, existing catalog lifecycle,
// workspace-only pending review. Never executes code from the supplied plugin.
import {createRequire} from 'node:module';
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inspectImportBuffer} from '../apps/server/src/features/design-resources/design-resource-import-service.ts';
import {loomicSceneV1Schema,designTextPresetContentSchema} from '../packages/shared/src/design-contracts.ts';
const require=createRequire(new URL('../apps/server/package.json',import.meta.url));
const {Pool}=require('pg');const {createClient}=require('@supabase/supabase-js');
const root='C:/Users/lenovo/Downloads/新建文件夹/画布插件/public';
const apply=process.argv.includes('--apply');
const phase=process.argv.find(a=>a.startsWith('--phase='))?.split('=')[1]??'all';
const limit=Number(process.argv.find(a=>a.startsWith('--limit='))?.split('=')[1]??Infinity);
const db=new Pool({connectionString:process.env.SUPABASE_DB_URL,max:6});
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const uuid=s=>{const h=createHash('sha256').update('loomic-local-library-v1:'+s).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const json=async file=>JSON.parse(await readFile(path.join(root,'local-data',file),'utf8'));
let workspace,actor;
const assets=new Map(),fonts=new Map(),fontsByFile=new Map(),counts={},failures=[];
const tally=k=>counts[k]=(counts[k]??0)+1;
const sourceInfo={source_url:'https://github.kuaitu.cc',usage_restrictions:'用户提供的本地资源；未验证商用授权，请使用者自行核实。'};
async function rpc(name,args){const keys=Object.keys(args);return (await db.query(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as data`,Object.values(args))).rows[0].data;}
async function catalog(kind,key,payload){
 if(!apply)return {entity_id:uuid(key),revision:2};
 const args={p_request_id:uuid(workspace+':'+key+':create'),p_entity_kind:kind,p_scope:'workspace',p_workspace_id:workspace,p_payload:JSON.stringify(payload),p_actor_user_id:actor};
 let entry=await rpc('loomic_catalog_create',args);
 for(const status of ['pending_review'])entry=await rpc('loomic_catalog_set_status',{p_request_id:uuid(workspace+':'+key+':'+status),p_entity_kind:kind,p_entity_id:entry.entity_id,p_expected_revision:entry.revision,p_status:status,p_actor_user_id:actor});
 return entry;
}
async function asset(url,converted=false){
 const key=converted?'font:'+url:url;
 if(assets.has(key))return assets.get(key);
 const pending=(async()=>{
  if(!url.startsWith('/local-assets/')||url.includes('..'))throw Error('Non-local or unsafe asset path');
  const file=converted?path.resolve('../../artifacts/converted-fonts',path.basename(url,path.extname(url))+'.ttf'):await realpath(path.join(root,url));
  if(!converted&&!file.toLowerCase().startsWith((path.resolve(root)+path.sep).toLowerCase()))throw Error('Asset escapes source root');
  const bytes=await readFile(file);
  const ext=path.extname(file).toLowerCase();
  const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ttf':'font/ttf','.otf':'font/otf','.woff':'font/woff'}[ext];
  if(!mime)throw Error('Unsupported file '+ext);
  const inspected=await inspectImportBuffer(bytes,mime);
  const id=uuid(workspace+':asset:'+inspected.sha256),objectPath=`${workspace}/design-library-v1/${inspected.sha256}${ext}`;
  if(apply){
   const exists=(await db.query('select id from public.asset_objects where id=$1',[id])).rowCount;
   if(!exists){
    const upload=await admin.storage.from('workspace-assets').upload(objectPath,bytes,{contentType:mime,upsert:false});
    if(upload.error&&!/already exists|duplicate/i.test(upload.error.message))throw upload.error;
    await db.query('insert into public.asset_objects(id,workspace_id,bucket,object_path,mime_type,byte_size,created_by) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do nothing',[id,workspace,'workspace-assets',objectPath,mime,bytes.length,actor]);
   }
  }
  return {id,...inspected};
 })();assets.set(key,pending);return pending;
}
function paint(value){if(value==null||value==='')return null;if(typeof value!=='string')throw Error('Unsupported gradient/pattern');return {kind:'solid',color:value};}
async function objects(list,key){
 const out=[];
 for(const [i,o] of list.entries()){
  if(o.id==='workspace')continue;
  if(o.type==='group'||o.type==='path'||o.type==='curved-text'||o.clipPath||o.skewX||o.skewY||o.filters?.length)throw Error('Unsupported object/transform: '+o.type);
  const sx=o.scaleX??1,sy=o.scaleY??1;
  if(sx<=0||sy<=0)throw Error('Unsupported negative scale');
  const width=o.width*sx,height=o.height*sy;
  const ax=o.originX==='center'?width/2:o.originX==='right'?width:0;
  const ay=o.originY==='center'?height/2:o.originY==='bottom'?height:0;
  const radians=(o.angle??0)*Math.PI/180;
  const base={objectId:uuid(key+':'+i),objectVersion:1,x:(o.left??0)-ax*Math.cos(radians)+ay*Math.sin(radians),y:(o.top??0)-ax*Math.sin(radians)-ay*Math.cos(radians),width,height,rotation:o.angle??0,opacity:o.opacity??1,zIndex:out.length,locked:false,visible:o.visible!==false};
  const shadow=o.shadow?{color:o.shadow.color,blur:o.shadow.blur??0,offsetX:o.shadow.offsetX??0,offsetY:o.shadow.offsetY??0,opacity:1}:undefined;
  let item;
  if(o.type==='image'){
   if(o.cropX||o.cropY)throw Error('Image crop requires review');
   const a=await asset(o.src);item={...base,type:a.kind==='svg'?'svg':'image',assetObjectId:a.id,flipX:o.flipX??false,flipY:o.flipY??false,...(a.kind==='svg'?{}:{fit:'fill'})};
  }else if(['textbox','i-text','text'].includes(o.type)){
   if(o.flipX||o.flipY||Math.abs(sx-sy)>.001||o.underline||o.linethrough||o.overline||Object.keys(o.styles??{}).length)throw Error('Unsupported text styling');
   const face=fonts.get(o.fontFamily);if(!face)throw Error('Missing font: '+o.fontFamily);
   item={...base,type:'textbox',text:o.text??'',fontFamily:face.name,fontFaceId:face.id,fontSize:(o.fontSize??40)*sx,fontWeight:o.fontWeight??'normal',fontStyle:o.fontStyle??'normal',textAlign:o.textAlign??'left',lineHeight:o.lineHeight??1.16,charSpacing:o.charSpacing??0,fill:paint(o.fill)??{kind:'solid',color:'#000'},stroke:paint(o.stroke),strokeWidth:(o.strokeWidth??0)*sx,...(shadow?{shadow}:{})};
  }else if(['rect','circle','triangle'].includes(o.type)){
   item={...base,type:o.type,fill:paint(o.fill),stroke:paint(o.stroke),strokeWidth:(o.strokeWidth??0)*sx,...(shadow?{shadow}:{}),...(o.type==='rect'?{radiusX:(o.rx??0)*sx,radiusY:(o.ry??0)*sy}:{})};
  }else throw Error('Unsupported type: '+o.type);
  out.push(item);
 }return out;
}
async function attempt(kind,key,fn){try{await fn();tally(kind);}catch(e){failures.push({kind,key,error:e.message});}}
async function batch(items,fn){let index=0;await Promise.all(Array.from({length:6},async()=>{for(;;){const i=index++;if(i>=items.length)return;await fn(items[i],i);if(i%100===0)console.log('Progress',i,JSON.stringify(counts),'skipped',failures.length);}}));}
try{
 const target=(await db.query('select w.id,w.owner_user_id from public.canvases c join public.projects p on p.id=c.project_id join public.workspaces w on w.id=p.workspace_id where c.id=$1',['0560072c-5c8a-4954-b037-9b476246a671'])).rows[0];
 if(!target)throw Error('Workspace missing');workspace=target.id;actor=target.owner_user_id;
 const lib=await json('content-libraries.json'),tmpl=await json('templates.json'),fontList=(await json('fonts.json')).fonts;
 if(phase!=='materials')for(const f of fontList)await attempt('fonts',f.name,async()=>{
  if(fontsByFile.has(f.file)){fonts.set(f.name,fontsByFile.get(f.file));return;}
  const a=await asset(f.file,true);const family=await catalog('font_family','font-family:'+f.file,{name:f.name,...sourceInfo});
  const face=await catalog('font_face','font-face:'+f.file,{family_id:family.entity_id,asset_object_id:a.id,style:a.style,weight:a.weight,format:a.format,checksum_sha256:a.sha256,allow_web_embed:a.webEmbedAllowed});
  const mapping={id:face.entity_id,name:a.familyName};fonts.set(f.name,mapping);fontsByFile.set(f.file,mapping);
 });
 console.log('Fonts',JSON.stringify(counts),'failures',JSON.stringify(failures));
 if(phase!=='templates')await batch(lib.materials.slice(0,limit),async m=>attempt('materials',String(m.id),async()=>{
  const a=m.attributes;
  if(!a.img?.data?.attributes?.url)throw Error('Source catalog has no material asset URL');
  const media=await asset(a.img.data.attributes.url);
  await catalog('resource','material:'+m.id,{name:a.name,kind:media.kind==='svg'?'svg':'image',asset_object_id:media.id,preview_asset_object_id:media.id,width:media.width,height:media.height,checksum_sha256:media.sha256,...sourceInfo});
 }));
 if(phase!=='materials')await batch(tmpl.templates.slice(0,limit),async t=>attempt('templates',String(t.id),async()=>{
  const a=t.attributes,ws=a.json.objects.find(o=>o.id==='workspace');
  if(!ws)throw Error('Missing template canvas');
  const scene=loomicSceneV1Schema.parse({schemaVersion:1,engine:'fabric',canvas:{width:Math.round(ws.width*(ws.scaleX??1)),height:Math.round(ws.height*(ws.scaleY??1)),background:typeof ws.fill==='string'?ws.fill:null},objects:await objects(a.json.objects,'template:'+t.id)});
  const preview=a.img?.data?.attributes?.url?await asset(a.img.data.attributes.url):null;
  const payload={name:a.name,scene,preview_asset_object_id:preview?.id??null,...sourceInfo};
  try{await catalog('template','template:'+t.id,payload);}catch(error){
   if(!error.message?.includes('design_templates_live_name_key'))throw error;
   // Different source templates may have identical display names. Preserve both.
   await catalog('template','template:'+t.id+':named',{...payload,name:a.name+' [本地 '+t.id+']'});
  }
 }));
 if(phase!=='materials')await batch([...lib.fontStyles,...await json('main-visual-presets.json')].slice(0,limit),async t=>attempt('text_presets',String(t.id),async()=>{
  const a=t.attributes;
  const style=designTextPresetContentSchema.parse({schemaVersion:1,objects:await objects([a.json],'text:'+t.id)});
  const preview=a.img?.data?.attributes?.url?await asset(a.img.data.attributes.url):null;
  await catalog('text_preset','text:'+t.id,{name:a.name,style,preview_asset_object_id:preview?.id??null,...sourceInfo});
 }));
 console.log('FINAL',JSON.stringify({apply,counts,failures}));
}finally{await db.end();}
