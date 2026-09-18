// Transfer configured provider credentials directly between authorized DBs.
// Never log, serialize to disk, or expose decrypted secret values.
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require=createRequire(new URL('../apps/server/package.json',import.meta.url));const {Client}=require('pg');
const inspected=JSON.parse(execFileSync('docker',['inspect','supabase_db_thtdhcvjppuvlvahfmga'],{encoding:'utf8'}))[0];
const password=inspected.Config.Env.find(v=>v.startsWith('POSTGRES_PASSWORD=')).slice(18);
const cloud=new Client({connectionString:process.env.SUPABASE_DB_URL});
const local=new Client({host:'127.0.0.1',port:54322,user:'supabase_admin',password,database:'loomic_replica_light_20260907'});
await cloud.connect();await local.connect();
try{
 const rows=(await cloud.query('select c.id,d.decrypted_secret from public.workspace_provider_configs c join vault.decrypted_secrets d on d.id=c.api_key_secret_id')).rows;
 let migrated=0;
 for(const row of rows){
  await local.query('begin');
  try{
   const current=(await local.query('select c.api_key_secret_id,d.id as present from public.workspace_provider_configs c left join vault.decrypted_secrets d on d.id=c.api_key_secret_id where c.id=$1 for update of c',[row.id])).rows[0];
   if(current&&!current.present){
    const {rows:[secret]}=await local.query('select vault.create_secret($1,$2) as id',[row.decrypted_secret,`replica-provider-${row.id}`]);
    await local.query('update public.workspace_provider_configs set api_key_secret_id=$1 where id=$2',[secret.id,row.id]);migrated++;
   }
   await local.query('commit');
  }catch(e){await local.query('rollback');throw new Error('Local provider secret migration failed');}
 }
 console.log(JSON.stringify({configuredProviders:rows.length,migrated}));
}finally{await cloud.end();await local.end();}
