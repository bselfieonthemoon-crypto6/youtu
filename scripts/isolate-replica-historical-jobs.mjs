import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
const require=createRequire(new URL('../apps/server/package.json',import.meta.url));const {Client}=require('pg');
const url=new URL(process.env.SUPABASE_DB_URL);
if(url.hostname!=='127.0.0.1'||url.pathname!=='/loomic_replica_light_20260907')throw new Error('Replica database required');
const db=new Client({connectionString:url.toString()});await db.connect();
try{
 await db.query('begin');
 const jobs=(await db.query("select * from background_jobs where created_at < '2026-09-07T09:00:00Z' and status in ('queued','running') for update")).rows;
 const runs=(await db.query("select * from agent_runs where created_at < '2026-09-07T09:00:00Z' and status='running' for update")).rows;
 if(jobs.length||runs.length)await writeFile('artifacts/local-replica-20260907/historical-jobs-before.json',JSON.stringify({jobs,runs}));
 if(jobs.length)await db.query("update background_jobs set status='canceled',canceled_at=now(),updated_at=now(),error_code='local_replica_historical_task' where id=any($1::uuid[])",[jobs.map(x=>x.id)]);
 if(runs.length)await db.query("update agent_runs set status='canceled',completed_at=now(),updated_at=now(),error_code='local_replica_historical_run' where id=any($1::uuid[])",[runs.map(x=>x.id)]);
 await db.query('commit');console.log(JSON.stringify({historicalJobsIsolated:jobs.length,historicalRunsIsolated:runs.length}));
}catch(e){await db.query('rollback');throw e;}finally{await db.end();}
