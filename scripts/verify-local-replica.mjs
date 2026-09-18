import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { Client } = require('pg');
const inspection = JSON.parse(execFileSync('docker', ['inspect', 'supabase_db_thtdhcvjppuvlvahfmga'], {encoding:'utf8'}))[0];
const password = inspection.Config.Env.find(v=>v.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length);
if (!password) throw new Error('Local database credentials unavailable');
const local = new Client({host:'127.0.0.1',port:54322,user:'postgres',password,database:'loomic_replica_light_20260907',connectionTimeoutMillis:10000});
const cloud = new Client({connectionString:process.env.SUPABASE_DB_URL,connectionTimeoutMillis:10000});
await local.connect();
await cloud.connect();
try {
  const report={counts:{},roundTrips:{},design:null,tableCount:0,countMismatches:[]};
  const ledger=JSON.parse(await readFile('artifacts/local-replica-20260907/table-copy.json','utf8'));
  report.tableCount=Object.keys(ledger).length;
  const quote=s=>'"'+s.replaceAll('"','""')+'"';
  for(const [table,expected] of Object.entries(ledger)){
    const actual=Number((await local.query(`select count(*) as n from ${table.split('.').map(quote).join('.')}`)).rows[0].n);
    if(actual!==expected)report.countMismatches.push({table,expected,actual});
  }
  for(const name of ['public.canvases','public.chat_messages','public.design_documents','auth.users','storage.objects','langgraph.checkpoint_blobs']){
    report.counts[name]={local:(await local.query(`select count(*)::int as n from ${name}`)).rows[0].n,cloud:(await cloud.query(`select count(*)::int as n from ${name}`)).rows[0].n};
  }
  for(const [name,client] of [['local',local],['cloud',cloud]]){
    const samples=[];
    for(let i=0;i<5;i++){
      const start=performance.now();
      await client.query('select revision,width,height from public.design_documents where id=$1',['c0f64c76-fc8d-43d0-8326-b4d825daad65']);
      samples.push(Math.round((performance.now()-start)*100)/100);
    }
    report.roundTrips[name]=samples;
  }
  report.design=(await local.query('select revision,width,height from public.design_documents where id=$1',['c0f64c76-fc8d-43d0-8326-b4d825daad65'])).rows[0];
  await writeFile('artifacts/local-replica-20260907/database-verification.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}finally{await local.end();await cloud.end();}
