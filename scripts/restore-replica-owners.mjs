import {createRequire} from 'node:module';
import {execFileSync,spawnSync} from 'node:child_process';
const require=createRequire(new URL('../apps/server/package.json',import.meta.url));const {Client}=require('pg');
const cloud=new Client({connectionString:process.env.SUPABASE_DB_URL});await cloud.connect();
try{
 const sql=[];
 const relations=await cloud.query("select format('ALTER %s %I.%I OWNER TO %I;',case c.relkind when 'S' then 'SEQUENCE' when 'v' then 'VIEW' when 'm' then 'MATERIALIZED VIEW' else 'TABLE' end,n.nspname,c.relname,pg_get_userbyid(c.relowner)) as sql from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('auth','storage','public','langgraph','realtime') and c.relkind in ('r','p','S','v','m')");
 sql.push(...relations.rows.map(r=>r.sql).filter(s=>!s.startsWith('ALTER SEQUENCE')));
 const funcs=await cloud.query("select format('ALTER ROUTINE %I.%I(%s) OWNER TO %I;',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),pg_get_userbyid(p.proowner)) as sql from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('auth','storage','public','langgraph','realtime') and p.prokind<>'a'");
 sql.push(...funcs.rows.map(r=>r.sql));
 const result=spawnSync('docker',['exec','-i','supabase_db_thtdhcvjppuvlvahfmga','psql','-U','supabase_admin','-d','loomic_replica_light_20260907','-v','ON_ERROR_STOP=1'],{input:sql.join('\n'),encoding:'utf8'});
 console.log(JSON.stringify({statements:sql.length,exitCode:result.status,error:result.stderr?.slice(0,500)}));
 process.exitCode=result.status??1;
}finally{await cloud.end();}
