import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createClient} from '@supabase/supabase-js';

assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421', 'Local replica only');
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const api='http://127.0.0.1:3002';
const reportPath='artifacts/material-library-import-20260915/import.json';
const sourceDir='C:/Users/lenovo/Downloads/素材库';
const sharp=createRequire(new URL('../apps/server/package.json',import.meta.url))('sharp');
const mode=process.argv[2]??'inspect';
if(mode==='inspect') {
 for(const table of ['canvases','design_resources']) {
  const r=await db.from(table).select(table==='canvases'?'id,name,workspace_id,created_by,updated_at':'id,name,scope,workspace_id,status').order('updated_at',{ascending:false}).limit(12);
  assert.ifError(r.error);console.log(table,JSON.stringify(r.data));
 }
} else {
 assert.equal(mode,'import');
 const ownerId=process.argv[3];assert(ownerId,'Explicit local owner id required');
 const account=await db.auth.admin.getUserById(ownerId);assert.ifError(account.error);
 const link=await db.auth.admin.generateLink({type:'magiclink',email:account.data.user.email});assert.ifError(link.error);
 const auth=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const login=await auth.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});assert.ifError(login.error);
 const token=login.data.session.access_token;
 async function call(path,method='GET',body) {
  const res=await fetch(api+path,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
  const json=await res.json();assert(res.ok,`${path}: ${res.status} ${JSON.stringify(json.error)}`);return json;
 }
 const viewer=await call('/api/viewer');const workspaceId=viewer.workspace.id;assert.equal(workspaceId,'25eb32ef-ff55-4de7-8c10-9390a51ece06','Expected current canvas workspace');
 let report;try{report=JSON.parse(await readFile(reportPath,'utf8'));assert.equal(report.workspaceId,workspaceId);}catch(error){if(error.code!=='ENOENT')throw error;report={ownerId,workspaceId,items:[]};}
 await mkdir('artifacts/material-library-import-20260915',{recursive:true});
 const save=()=>writeFile(reportPath,JSON.stringify(report,null,2));
 const files=await readdir(sourceDir,{recursive:true});
 for(const filename of files.filter(file=>file.toLowerCase().endsWith('.png')).sort()) {
  const name=filename.replace(/\\/g,'/').replace(/\.png$/i,'');
  const bytes=await readFile(`${sourceDir}/${filename}`);const meta=await sharp(bytes).metadata();assert(meta.width && meta.height);
  let item=report.items.find(x=>x.name===name);
  if(!item){item={name,width:meta.width,height:meta.height};report.items.push(item);await save();}
  if(!item.assetId){
   const form=new FormData();form.append('file',new Blob([bytes],{type:'image/png'}),`${name}.png`);
   const res=await fetch(api+'/api/uploads',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form,signal:AbortSignal.timeout(30000)});const uploaded=await res.json();assert(res.ok,JSON.stringify(uploaded.error));item.assetId=uploaded.asset.id;await save();
  }
  if(!item.resourceId){
   item.requestId??=crypto.randomUUID();await save();
   const resource=await call('/api/admin/design-catalog/resources','POST',{request_id:item.requestId,scope:'workspace',workspace_id:workspaceId,kind:'image',name,description:'用户提供的素材库 PNG 原图。',asset_object_id:item.assetId,preview_asset_object_id:item.assetId,category_id:null,tag_ids:[],source_url:null,author:null,license_name:null,license_url:null,attribution:'来自用户提供的本地素材库',usage_restrictions:null});
   item.resourceId=resource.id??resource.entity_id;assert(item.resourceId);await save();
  }
  const row=await db.from('design_resources').select('status,revision').eq('id',item.resourceId).single();assert.ifError(row.error);
  let revision=row.data.revision;
  for(const status of row.data.status==='published'?[]:row.data.status==='pending_review'?['published']:['pending_review','published']) {
   const changed=await call('/api/admin/design-catalog/status','POST',{request_id:crypto.randomUUID(),entity_kind:'resource',entity_id:item.resourceId,expected_revision:revision,status});revision=changed.revision;
  }
  const list=await call(`/api/design-resources?status=published&workspace_id=${workspaceId}&query=${encodeURIComponent(name)}`);assert(list.items.some(x=>x.id===item.resourceId));
  for(const kind of ['content','preview']) {
   const res=await fetch(`${api}/api/design-resources/${item.resourceId}/${kind}`,{headers:{Authorization:`Bearer ${token}`}});assert(res.ok);
   const output=Buffer.from(await res.arrayBuffer());const decoded=await sharp(output).metadata();assert(decoded.width && decoded.height,`${kind} invalid image`); if(meta.hasAlpha)assert(decoded.hasAlpha,`${kind} alpha missing`);
   if(kind==='content')assert(bytes.equals(output),'Original PNG bytes must survive upload and download');
  }
  item.status='published';item.alphaVerified=!!meta.hasAlpha;item.originalVerified=true;await save();console.log(`${name}: published, original PNG and preview verified`);
 }
 console.log(JSON.stringify({workspaceId,count:report.items.length,reportPath}));
 await auth.auth.signOut({scope:'local'});
}

