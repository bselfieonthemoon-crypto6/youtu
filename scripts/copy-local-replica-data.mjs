// Small read batches, per-table transactions, and resumable completion ledger.
// Destination is fixed to the isolated test database, never the live database.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const require=createRequire(new URL('../apps/server/package.json',import.meta.url));
const {Client,types}=require('pg');
// Preserve database timestamp precision instead of converting through JS Date.
for(const oid of [1082,1114,1184])types.setTypeParser(oid,v=>v);
const inspected=JSON.parse(execFileSync('docker',['inspect','supabase_db_thtdhcvjppuvlvahfmga'],{encoding:'utf8'}))[0];
const password=inspected.Config.Env.find(v=>v.startsWith('POSTGRES_PASSWORD='))?.slice(18);
const local=new Client({host:'127.0.0.1',port:54322,user:'supabase_admin',password,database:'loomic_replica_light_20260907'});
const cloud=new Client({connectionString:process.env.SUPABASE_DB_URL,connectionTimeoutMillis:15000});
const ledgerPath='artifacts/local-replica-20260907/table-copy.json';
const ledger=JSON.parse(await readFile(ledgerPath,'utf8').catch(()=>'{}'));
const q=s=>'"'+s.replaceAll('"','""')+'"';
await local.connect();await cloud.connect();
try{
  await local.query("set session_replication_role='replica'");
  const tables=(await cloud.query("select schemaname,tablename from pg_tables where schemaname in ('public','auth','storage') or (schemaname='langgraph' and tablename like '%migration%') or (schemaname='pgmq' and tablename='meta') order by 1,2")).rows;
  for(const {schemaname,tablename} of tables){
    const table=q(schemaname)+'.'+q(tablename);
    const key=schemaname+'.'+tablename;
    if(ledger[key]!==undefined)continue;
    const attributes=(await cloud.query('select attname,atttypid from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped and attgenerated=\'\' order by attnum',[table])).rows;
    const columns=attributes.map(r=>r.attname);
    const existing=Number((await local.query(`select count(*) as n from ${table}`)).rows[0].n);
    if(existing)throw new Error(`Refusing to overwrite existing rows in ${key}`);
    const names=columns.map(q).join(',');
    let count=0;
    await cloud.query('begin isolation level repeatable read read only');
    await local.query('begin');
    try{
      await cloud.query(`declare replica_cursor no scroll cursor for select ${names} from ${table}`);
      for(;;){
        const batch=await cloud.query('fetch 10 from replica_cursor');
        if(!batch.rowCount)break;
        for(const row of batch.rows){
          await local.query(`insert into ${table} (${names}) overriding system value values (${columns.map((_,i)=>'$'+(i+1)).join(',')})`,attributes.map(a=>row[a.attname]!==null && [114,3802].includes(a.atttypid)?JSON.stringify(row[a.attname]):row[a.attname]));
          count++;
        }
      }
      await cloud.query('commit');await local.query('commit');
      ledger[key]=count;
      await writeFile(ledgerPath,JSON.stringify(ledger,null,2));
      console.log(`${key}: ${count} rows copied`);
    }catch(error){
      await cloud.query('rollback').catch(()=>{});await local.query('rollback').catch(()=>{});
      console.error(`Table copy failed: ${key}; code=${error.code??'connection'}`);
      process.exitCode=1;break;
    }
  }
  if (!process.exitCode) {
    const sequences=(await cloud.query("select schemaname,sequencename from pg_sequences where schemaname in ('public','auth','storage','pgmq','langgraph')")).rows;
    for(const s of sequences){
      const name=q(s.schemaname)+'.'+q(s.sequencename);
      const state=(await cloud.query(`select last_value,is_called from ${name}`)).rows[0];
      await local.query('select setval($1::regclass,$2::bigint,$3::boolean)',[name,state.last_value,state.is_called]);
    }
    console.log(`Sequence state synchronized: ${sequences.length}`);
  }
}finally{await cloud.end();await local.end();}
