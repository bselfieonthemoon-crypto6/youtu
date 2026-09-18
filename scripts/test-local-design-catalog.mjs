import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createClient} from '@supabase/supabase-js';

// Deliberately refuses cloud URLs. All mutations target fresh test fixtures.
assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:54421');
const api='http://127.0.0.1:3002';
const sharp=createRequire(new URL('../apps/server/package.json',import.meta.url))('sharp');
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false}});
const report={started:new Date().toISOString(),checks:[],fixtures:{}};
const uuid=()=>crypto.randomUUID();
let token;
async function call(label,method,path,body,status=200){
 const response=await fetch(api+path,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
 const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data={bytes:raw.length};}
 report.checks.push({label,method,path,status:response.status,expected:status});
 assert.equal(response.status,status,`${label}: ${JSON.stringify(data.error??data).slice(0,300)}`);
 console.log(label+' '+response.status);return data;
}
async function binary(label,path){
 const response=await fetch(api+path,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
 const bytes=await response.arrayBuffer();report.checks.push({label,status:response.status,bytes:bytes.byteLength});assert.equal(response.status,200,label);assert(bytes.byteLength>0,label);return Buffer.from(bytes);
}
try{
 const {data:{user},error}=await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');assert(!error);
 const {data:link,error:linkError}=await admin.auth.admin.generateLink({type:'magiclink',email:user.email});assert(!linkError);
 const {data:auth,error:authError}=await client.auth.verifyOtp({token_hash:link.properties.hashed_token,type:'magiclink'});assert(!authError);token=auth.session.access_token;
 const project=(await call('project create','POST','/api/projects',{name:`Catalog QA ${uuid()}`,description:'Disposable isolated local regression fixture'},201)).project;
 report.fixtures.projectId=project.id;const canvas=project.primaryCanvas.id;report.fixtures.canvasId=canvas;
 const lists={};
 for(const kind of ['resources','templates','text-presets','fonts']){
  lists[kind]=await call(kind+' list','GET',`/api/design-${kind}?limit=30`);
  console.log(kind+' keys '+Object.keys(lists[kind]).join(','));
  await call(kind+' invalid limit','GET',`/api/design-${kind}?limit=0`,undefined,400);
 }
 for(const kind of ['resources','templates','text-presets','fonts']){
  const items=lists[kind].items??lists[kind].resources??lists[kind].templates??lists[kind].presets??lists[kind].families??lists[kind].fonts;
  assert(Array.isArray(items)&&items.length>0,kind+' must have local data');
  const selected=kind==='fonts'?items.find(item=>item.faces.some(face=>face.allow_web_embed)):items[0];assert(selected,kind+' readable fixture');
  const detail=await call(kind+' detail','GET',`/api/design-${kind}/${selected.id??selected.family?.id}`);
  if(kind==='resources'){await binary('resource content',`/api/design-resources/${items[0].id}/content`);await binary('resource preview',`/api/design-resources/${items[0].id}/preview`);}
  if(kind==='fonts'){const face=(detail.faces??detail.font?.faces??[]).find(f=>f.allow_web_embed);assert(face,'embeddable font face');await binary('font file',`/api/design-fonts/faces/${face.id}/content`);}
 }
 const c=(await call('canvas read','GET',`/api/canvases/${canvas}`)).canvas;
 const create={request_id:uuid(),canvas_id:canvas,expected_canvas_revision:c.revision,canvas_element_id:'qa-'+uuid(),name:'QA board',width:320,height:240,background:null,node:{x:40,y:40,width:320,height:240}};
 const created=await call('design create','POST','/api/designs',create,201);const id=created.design_id;report.fixtures.designId=id;
 const replay=await call('design create replay','POST','/api/designs',create,201);assert.equal(replay.design_id,id);assert(replay.replayed);
 let design=(await call('design read','GET',`/api/designs/${id}`)).design;
 const object={objectId:uuid(),objectVersion:1,type:'text',name:'QA heading',x:10,y:20,width:220,height:60,rotation:0,opacity:1,zIndex:0,locked:false,visible:true,text:'Local design QA',fontFamily:'Arial',fontSize:24,fontWeight:700,fontStyle:'normal',textAlign:'left',lineHeight:1.2,charSpacing:0,fill:{kind:'solid',color:'#112233'}};
 const mutation={design_id:id,expected_revision:design.revision,idempotency_key:uuid(),commands:[{action:'object.add',object}]};
 const changed=await call('object add','POST',`/api/designs/${id}/mutations`,mutation);
 const repeat=await call('mutation replay','POST',`/api/designs/${id}/mutations`,mutation);assert(repeat.replayed);assert.equal(repeat.revision,changed.revision);
 await call('stale revision conflict','POST',`/api/designs/${id}/mutations`,{...mutation,idempotency_key:uuid()},409);
 const revision=changed.revision;
 const concurrent=await Promise.all([0,1].map(i=>fetch(api+`/api/designs/${id}/mutations`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({design_id:id,expected_revision:revision,idempotency_key:uuid(),commands:[{action:'canvas.update',background:i?'#123456':'#abcdef'}]})})));
 assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);await Promise.all(concurrent.map(r=>r.arrayBuffer()));report.checks.push({label:'concurrent writers exactly one wins',statuses:[200,409]});
 design=(await call('persisted design','GET',`/api/designs/${id}`)).design;assert.equal(design.scene.objects.length,1);
 const renamed=await call('rename','PATCH',`/api/designs/${id}/name`,{design_id:id,expected_revision:design.revision,idempotency_key:uuid(),name:'QA renamed'});
 const currentCanvas=(await call('canvas for copy','GET',`/api/canvases/${canvas}`)).canvas;
 const copy=await call('design copy','POST',`/api/designs/${id}/copy`,{request_id:uuid(),source_design_id:id,canvas_id:canvas,expected_canvas_revision:currentCanvas.revision,canvas_element_id:'qa-copy-'+uuid(),node:{x:400,y:40,width:320,height:240}},201);report.fixtures.copyId=copy.design_id;
 const copied=(await call('copy read','GET',`/api/designs/${copy.design_id}`)).design;assert.equal(copied.scene.objects.length,1);assert.notEqual(copied.scene.objects[0].objectId,object.objectId);
 await call('references','GET',`/api/designs/${id}/references`);
 const removed=await call('soft delete','DELETE',`/api/designs/${id}`,{design_id:id,expected_revision:renamed.revision,idempotency_key:uuid()});
 await call('deleted not readable','GET',`/api/designs/${id}`,undefined,404);
 await call('restore','POST',`/api/designs/${id}/restore`,{design_id:id,expected_revision:removed.revision,idempotency_key:uuid()});
 design=(await call('restored read','GET',`/api/designs/${id}`)).design;assert.equal(design.name,'QA renamed');assert.equal(design.scene.objects.length,1);
 let previewAsset;
 for(const [format,multiplier,transparent] of [['png',1,true],['jpeg',2,false]]){
  const queued=await call(`export ${format}`,'POST',`/api/designs/${id}/exports`,{design_id:id,revision:design.revision,idempotency_key:uuid(),format,multiplier,transparent},202);
  const jobId=queued.job.id;let job;
  for(let n=0;n<90;n++){const result=await admin.from('background_jobs').select('status,result,error_code').eq('id',jobId).single();assert(!result.error);job=result.data;if(['succeeded','failed','dead_letter','cancelled'].includes(job.status))break;await new Promise(r=>setTimeout(r,1000));}
  assert.equal(job.status,'succeeded',`export ${format}: ${job.error_code}`);assert.equal(job.result.width,320*multiplier);assert.equal(job.result.height,240*multiplier);if(format==='png')previewAsset=job.result.asset_object_id;
  const recovered=await call('export recover','GET',`/api/jobs/${jobId}`);const url=recovered.job.result.signed_url;assert(['localhost','127.0.0.1'].includes(new URL(url).hostname));const download=await fetch(url);assert.equal(download.status,200);const bytes=Buffer.from(await download.arrayBuffer());assert(bytes.length>0);assert(format==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]===255&&bytes[1]===216);
  const meta=await sharp(bytes).metadata();assert.equal(meta.width,320*multiplier);assert.equal(meta.height,240*multiplier);
  if(transparent){assert(meta.hasAlpha);const corner=await sharp(bytes).extract({left:0,top:0,width:1,height:1}).ensureAlpha().raw().toBuffer();assert.equal(corner[3],0);}
  report.checks.push({label:`${format} export worker and download`,bytes:bytes.length,width:job.result.width,height:job.result.height,transparentVerified:transparent});
 }
 const attribution={source_url:null,author:'Local QA',license_name:'Test fixture',license_url:null,attribution:null,usage_restrictions:'Local test only'};
 const base={scope:'workspace',workspace_id:project.workspace.id,...attribution};
 const catalog=[];
 for(const [collection,kind,payload] of [
  ['categories','category',{scope:base.scope,workspace_id:base.workspace_id,parent_id:null,name:'QA category',slug:'qa-'+uuid(),sort_order:0}],
  ['tags','tag',{scope:base.scope,workspace_id:base.workspace_id,name:'QA tag',slug:'qa-'+uuid()}],
  ['font-families','font_family',{...base,name:'QA font family'}],
  ['text-presets','text_preset',{...base,name:'QA text preset',style:{schemaVersion:1,objects:[object]},preview_asset_object_id:null,category_id:null,tag_ids:[]}],
  ['templates','template',{...base,name:'QA template',description:null,scene:design.scene,preview_asset_object_id:null,category_id:null,tag_ids:[]}],
  ['resources','resource',{...base,name:'QA image',description:null,kind:'image',asset_object_id:previewAsset,preview_asset_object_id:previewAsset,category_id:null,tag_ids:[]}],
 ]){
  if('preview_asset_object_id' in payload)payload.preview_asset_object_id=previewAsset;
  const row=await call(`${kind} create`,'POST',`/api/admin/design-catalog/${collection}`,{request_id:uuid(),...payload,name:payload.name+' '+uuid()},201);
  const entityId=row.entity_id??row.id??row.template?.id;let rev=row.revision??row.template?.revision??0;assert(entityId,kind+' entity id');catalog.push({collection,kind,id:entityId});
  const updated=await call(`${kind} rename`,'PATCH',`/api/admin/design-catalog/${collection}/${entityId}`,{request_id:uuid(),expected_revision:rev,name:'QA updated '+kind+' '+uuid()});rev=updated.revision;
  for(const status of ['pending_review','published']){const expected=kind==='font_family'&&status==='published'?409:200;const out=await call(`${kind} ${status}`,'POST','/api/admin/design-catalog/status',{request_id:uuid(),entity_kind:kind,entity_id:entityId,expected_revision:rev,status},expected);if(expected===200)rev=out.revision;}
  await call(`${kind} references`,'GET',`/api/admin/design-catalog/${collection}/${entityId}/references`);
  const deleted=await call(`${kind} delete`,'POST','/api/admin/design-catalog/delete',{request_id:uuid(),entity_kind:kind,entity_id:entityId,expected_revision:rev});
  const restored=await call(`${kind} restore`,'POST','/api/admin/design-catalog/restore',{request_id:uuid(),entity_kind:kind,entity_id:entityId,expected_revision:deleted.revision});
  let cleanupRevision=restored.revision;
  if(kind==='resource'){
   let restoredRevision=restored.revision;
   for(const status of ['pending_review','published']){const out=await call('resource republish '+status,'POST','/api/admin/design-catalog/status',{request_id:uuid(),entity_kind:kind,entity_id:entityId,expected_revision:restoredRevision,status});restoredRevision=out.revision;}
   cleanupRevision=restoredRevision;
   await call('favorite resource','PUT',`/api/design-resources/${entityId}/favorite`);
   const favorites=await call('favorite list','GET','/api/design-resources?collection=favorites&limit=100');assert(favorites.items.some(item=>item.id===entityId));
   await call('unfavorite resource','DELETE',`/api/design-resources/${entityId}/favorite`);
   await call('resource recent use','POST',`/api/design-resources/${entityId}/recent`,{workspace_id:base.workspace_id});
   const recent=await call('recent resources','GET',`/api/design-resources?collection=recent&workspace_id=${base.workspace_id}&limit=100`);assert(recent.items.some(item=>item.id===entityId));
  }
  if(kind==='template'){
   const cv=(await call('template target canvas','GET',`/api/canvases/${canvas}`)).canvas;
   const instance=await call('instantiate template','POST','/api/designs',{...create,request_id:uuid(),expected_canvas_revision:cv.revision,canvas_element_id:'qa-template-'+uuid(),template_id:entityId},201);
   const instanceDoc=(await call('template instance read','GET',`/api/designs/${instance.design_id}`)).design;assert.equal(instanceDoc.scene.objects.length,design.scene.objects.length);
  }
  await call(`${kind} cleanup`,'POST','/api/admin/design-catalog/delete',{request_id:uuid(),entity_kind:kind,entity_id:entityId,expected_revision:cleanupRevision});
 }
 report.fixtures.catalog=catalog;
 report.outcome='passed';
}catch(error){report.outcome='failed';report.error=error.message;console.error(error.message);process.exitCode=1;}
finally{await writeFile('artifacts/local-replica-20260907/design-catalog-checks.json',JSON.stringify(report,null,2));await client.auth.signOut({scope:'local'});}
