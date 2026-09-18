import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createClient} from '@supabase/supabase-js';
const require=createRequire(new URL('../apps/server/package.json',import.meta.url));const {Client}=require('pg');
if(process.env.SUPABASE_URL!=='http://127.0.0.1:54421')throw new Error('Local replica only');
const d=JSON.parse(execFileSync('docker',['inspect','supabase_db_thtdhcvjppuvlvahfmga'],{encoding:'utf8'}))[0];
const password=d.Config.Env.find(v=>v.startsWith('POSTGRES_PASSWORD=')).slice(18);
const db=new Client({host:'127.0.0.1',port:54322,user:'supabase_admin',password,database:'loomic_replica_light_20260907'});
const storage=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const cache=new Map();const quote=s=>'"'+s.replaceAll('"','""')+'"';
const origin='https://thtdhcvjppuvlvahfmga.supabase.co/storage/v1/';
await db.connect();let changed=0,missing=0;
try{
 const cols=(await db.query("select c.table_name,c.column_name from information_schema.columns c join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name where c.table_schema='public' and t.table_type='BASE TABLE' and c.data_type in ('json','jsonb','text','character varying')")).rows;
 for(const col of cols){
  const table='public.'+quote(col.table_name),field=quote(col.column_name);
  const rows=(await db.query(`select ctid::text as row_id,${field}::text as value from ${table} where ${field}::text like $1`,['%'+origin+'%'])).rows;
  for(const row of rows){
   let value=row.value;
   const urls=[...new Set(value.match(/https:\/\/thtdhcvjppuvlvahfmga\.supabase\.co\/storage\/v1\/object\/(?:sign|public|authenticated)\/[^\s"<>\\]+/g)||[])];
   for(const old of urls){
    if(!cache.has(old)){
     const u=new URL(old);const parts=u.pathname.split('/').slice(5);const bucket=decodeURIComponent(parts.shift());const name=parts.map(decodeURIComponent).join('/');
     const {data,error}=await storage.storage.from(bucket).createSignedUrl(name,7*24*3600);
     if(error){missing++;continue;}
     cache.set(old,data.signedUrl);
    }
    value=value.replaceAll(old,cache.get(old));
   }
   if(value!==row.value){await db.query(`update ${table} set ${field}=$1 where ctid=$2::tid`,[value,row.row_id]);changed++;}
  }
 }
 console.log(JSON.stringify({localizedLinks:cache.size,updatedFields:changed,missing,validityDays:7}));
}finally{await db.end();}
