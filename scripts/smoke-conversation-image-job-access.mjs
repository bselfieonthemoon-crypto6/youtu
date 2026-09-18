import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createJobService} from '../apps/server/src/features/jobs/job-service.ts';
const require=createRequire(new URL('../apps/server/package.json',import.meta.url));
const {Client}=require('pg');
const url=process.env.SUPABASE_DB_URL;
if(!url || !['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)) throw Error('Local SUPABASE_DB_URL required; not executed.');
const db=new Client({connectionString:url});await db.connect();
const schema='image_access_smoke_'+randomUUID().replaceAll('-','');
// Adapter executes the actual service queries against an isolated PostgreSQL schema.
// No queues, storage uploads, public jobs, or provider calls are involved.
function from(table){
 assert(['workspace_members','chat_sessions','canvases','background_jobs'].includes(table));
 const filters=[],values=[];let columns='*',patch=null,sort='',limit='';
 const bind=value=>{values.push(value);return '$'+values.length;};
 const chain={
  select(value){columns=value.split(',').map(col=>col.includes(':')?`${col.split(':')[1].replace(/->>([a-z_]+)/g,"->>'$1'")} AS "${col.split(':')[0]}"`:col).join(',');return chain;},
  eq(column,value){assert(/^[a-z_]+$/.test(column));filters.push(`${column}=${bind(value)}`);return chain;},
  in(column,list){filters.push(`${column}::text=ANY(${bind(list)}::text[])`);return chain;},
  or(){throw Error('This smoke uses the exact canvas fence; dynamic design fence is unit-tested.');},
  order(column){assert.equal(column,'created_at');sort=' ORDER BY created_at DESC';return chain;},
  limit(n){assert.equal(n,1);limit=' LIMIT 1';return chain;},
  update(value){patch=value;return chain;},
  async maybeSingle(){
   let sql;
   if(patch){const sets=Object.entries(patch).map(([key,value])=>{assert(['status','canceled_at'].includes(key));return `${key}=${bind(value)}`;});sql=`UPDATE ${schema}.${table} SET ${sets.join(',')} WHERE ${filters.join(' AND ')} RETURNING ${columns}`;}
   else sql=`SELECT ${columns} FROM ${schema}.${table} WHERE ${filters.join(' AND ')}${sort}${limit}`;
   try{const result=await db.query(sql,values);assert(result.rows.length<=1);return {data:result.rows[0]??null,error:null};}
   catch(error){return {data:null,error};}
  }
 };return chain;
}
try{
 await db.query('BEGIN');
 const policies=await db.query("SELECT cmd,qual FROM pg_policies WHERE schemaname='public' AND tablename='background_jobs' AND policyname='background_jobs_user_policy'");
 assert.equal(policies.rows.length,1,'Deployed creator-only policy must exist');
 assert.equal(policies.rows[0].cmd,'ALL');assert.match(policies.rows[0].qual,/auth\.uid\(\)\s*=\s*created_by/);
 await db.query(`CREATE SCHEMA ${schema};
 CREATE TABLE ${schema}.workspace_members(workspace_id uuid,user_id uuid,role text);
 CREATE TABLE ${schema}.chat_sessions(id uuid,canvas_id uuid);
 CREATE TABLE ${schema}.canvases(id uuid,workspace_id uuid);
 CREATE TABLE ${schema}.background_jobs (LIKE public.background_jobs INCLUDING DEFAULTS);
 ALTER TABLE ${schema}.background_jobs ENABLE ROW LEVEL SECURITY;
 CREATE POLICY creator_only ON ${schema}.background_jobs FOR ALL TO authenticated USING(${policies.rows[0].qual});
 GRANT USAGE ON SCHEMA ${schema} TO authenticated;
 GRANT SELECT,UPDATE ON ${schema}.background_jobs TO authenticated;`);
 const a=randomUUID(),b=randomUUID(),owner=randomUUID(),manager=randomUUID(),outsider=randomUUID();
 const workspace=randomUUID(),otherWorkspace=randomUUID(),canvas=randomUUID(),session=randomUUID();
 for(const [user,role,ws] of [[a,'member',workspace],[b,'member',workspace],[owner,'owner',workspace],[manager,'admin',workspace],[outsider,'owner',otherWorkspace]])
  await db.query(`INSERT INTO ${schema}.workspace_members VALUES($1,$2,$3)`,[ws,user,role]);
 await db.query(`INSERT INTO ${schema}.canvases VALUES($1,$2);`,[canvas,workspace]);
 await db.query(`INSERT INTO ${schema}.chat_sessions VALUES($1,$2);`,[session,canvas]);
 const scope={workspaceId:workspace,sessionId:session,canvasId:canvas,liveDesignIds:new Set()};
 const service=createJobService({createUserClient(){throw Error('User cancellation path must not be used');},getAdminClient:()=>({from}),pgmq:{}});
 const user=id=>({id,accessToken:'not-used',email:'',userMetadata:{}});
 async function job(creator,status='running',jobSession=session){
  const id=randomUUID();await db.query(`INSERT INTO ${schema}.background_jobs(id,workspace_id,canvas_id,session_id,created_by,queue_name,job_type,status,payload) VALUES($1,$2,$3,$4,$5,'isolated-never-enqueued','image_generation',$6,'{}')`,[id,workspace,canvas,jobSession,creator,status]);return id;
 }
 const readJob=await job(b);
 await db.query('SET LOCAL ROLE authenticated');
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[a]);
 assert.equal((await db.query(`SELECT id FROM ${schema}.background_jobs WHERE id=$1`,[readJob])).rowCount,0,'Creator-only RLS must hide B job from A');
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[owner]);
 assert.equal((await db.query(`UPDATE ${schema}.background_jobs SET status='canceled' WHERE id=$1 RETURNING id`,[readJob])).rowCount,0,'Workspace owner still cannot update another creator through raw user RLS');
 await db.query('RESET ROLE');
 assert.equal((await service.getConversationImageJob(user(a),scope,readJob)).id,readJob,'Member service read B job');
 const memberJob=await job(b);await assert.rejects(service.cancelJobAdmin(user(a),memberJob,scope),error=>error.code==='image_job_forbidden');
 assert.equal((await db.query(`SELECT status FROM ${schema}.background_jobs WHERE id=$1`,[memberJob])).rows[0].status,'running');
 for(const actor of [owner,manager,a]){
  const id=await job(actor===a?a:b);assert.equal((await service.cancelJobAdmin(user(actor),id,scope)).status,'canceled');
  assert.equal((await service.cancelJobAdmin(user(actor),id,scope)).status,'canceled','Terminal replay remains canceled');
 }
 await assert.rejects(service.getConversationImageJob(user(outsider),scope,readJob),error=>error.code==='image_job_forbidden');
 await assert.rejects(service.cancelJobAdmin(user(outsider),readJob,scope),error=>error.code==='image_job_forbidden');
 await assert.rejects(service.getConversationImageJob(user(a),{...scope,canvasId:randomUUID()},readJob),error=>error.code==='image_job_forbidden');
 const elsewhere=await job(b,'running',randomUUID());assert.equal(await service.getConversationImageJob(user(a),scope,elsewhere),null);
 await assert.rejects(service.cancelJobAdmin(user(owner),elsewhere,scope),error=>error.code==='job_not_found');
 console.log('Image access SQL smoke passed: creator-only RLS confirmed; member read, creator/owner/admin cancel, member/outsider deny, session/canvas fences, terminal replay.');
}finally{await db.query('ROLLBACK');await db.end();}
