// Run from the repository root with node --env-file=.env.local.
// Read-only cloud access; isolated local database; no application/worker switch.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, stat, writeFile, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import net from 'node:net';
import { createClient } from '@supabase/supabase-js';
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { Client } = require('pg');
const root = path.resolve('artifacts/local-replica-20260907');
await mkdir(root, { recursive: true });
const container = 'supabase_db_thtdhcvjppuvlvahfmga';
const lightweight = process.argv.includes('--lightweight');
const database = lightweight ? 'loomic_replica_light_20260907' : 'loomic_replica_20260907';
async function docker(args, input, output) {
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Docker operation failed (${code}); diagnostic retained locally`)));
  });
  child.stdin.end(input);
  const copied = output ? pipeline(child.stdout, createWriteStream(output)) : (async () => { for await (const chunk of child.stdout) {} })();
  try { await Promise.all([done, copied]); }
  finally { if (stderr) await writeFile(path.join(root, 'last-operation.log'), stderr); }
}
const cloud = new Client({ connectionString: process.env.SUPABASE_DB_URL });
await cloud.connect();
try {
  const tables = await cloud.query("select schemaname,tablename from pg_tables where schemaname in ('public','auth','storage') order by 1,2");
  const objects = (await cloud.query('select bucket_id,name,metadata from storage.objects order by bucket_id,name')).rows;
  await writeFile(path.join(root, 'storage-inventory.json'), JSON.stringify(objects));
  const schemaOnly = process.argv.includes('--schema-only');
  const dump = path.join(root, schemaOnly ? 'cloud-schema.dump' : lightweight ? 'cloud-light.dump' : 'cloud.dump');
  if (!process.argv.includes('--files-only') && !(await stat(dump).catch(() => null))) {
    const u = new URL(process.env.SUPABASE_DB_URL);
    // Docker's outbound route may differ from Windows; relay encrypted PG traffic.
    const relay = net.createServer(socket => {
      const upstream = net.connect(u.hostname.endsWith('.pooler.supabase.com') ? 5432 : Number(u.port||5432),u.hostname);
      socket.on('error',()=>upstream.destroy());
      upstream.on('error',()=>socket.destroy());
      socket.on('close',()=>upstream.destroy());
      upstream.on('close',()=>socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    await new Promise(resolve=>relay.listen(0,'0.0.0.0',resolve));
    const values = ['host.docker.internal',String(relay.address().port),decodeURIComponent(u.username),decodeURIComponent(u.password),u.pathname.slice(1)||'postgres'];
    if (values.some(v => /[\r\n]/.test(v))) throw new Error('Invalid connection fields');
    console.log('Creating consistent cloud database snapshot...');
    const exclusions = schemaOnly ? " --schema-only --exclude-schema='loomic_backup_*'" : lightweight ? " --exclude-table-data='langgraph.*' --exclude-table-data='pgmq.*'" : '';
    try { await docker(['exec','-i',container,'sh','-c','read -r PGHOST; read -r PGPORT; read -r PGUSER; read -r PGPASSWORD; read -r PGDATABASE; export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE; PGCONNECT_TIMEOUT=20 PGGSSENCMODE=disable PGSSLMODE=require pg_dump --format=custom --no-owner --inserts --rows-per-insert=100'+exclusions], values.join('\n')+'\n', dump+'.partial'); }
    finally { relay.close(); }
    await rename(dump+'.partial',dump);
  }
  // Restore is opt-in and never targets an existing database.
  if (process.argv.includes('--restore')) {
    await docker(['exec',container,'createdb','-U','postgres',database]);
    await docker(['cp',dump,`${container}:/tmp/loomic-replica-20260907.dump`]);
    await docker(['exec',container,'pg_restore','-U','postgres','-d',database,'--no-owner','/tmp/loomic-replica-20260907.dump']);
    console.log('Isolated database restored. No worker is connected.');
  }
  if (process.argv.includes('--snapshot-only')) { console.log('Snapshot stage complete'); process.exitCode=0; }
  else {
  const storage = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession:false } });
  let cursor=0, completed=0, failed=0;
  const failures=[];
  await Promise.all(Array.from({length:8},async()=>{
    while(cursor<objects.length){
      const item=objects[cursor++];
      const target=path.resolve(root,'storage',item.bucket_id,item.name);
      if(!target.startsWith(path.join(root,'storage')+path.sep))throw new Error('Unsafe storage path');
      const existing=await stat(target).catch(()=>null);
      if(existing && existing.size===Number(item.metadata?.size)){completed++;continue;}
      try{
        await mkdir(path.dirname(target),{recursive:true});
        let blob;
        for(let attempt=0;attempt<3;attempt++){
          const response=await storage.storage.from(item.bucket_id).download(item.name);
          if(!response.error){blob=response.data;break;}
        }
        if(!blob)throw new Error('Download failed');
        await writeFile(target+'.partial',Buffer.from(await blob.arrayBuffer()));
        await rename(target+'.partial',target);
        completed++;
      }catch{failed++;failures.push({bucket:item.bucket_id,name:item.name});}
      if((completed+failed)%100===0)console.log(`Files copied ${completed}/${objects.length}; failed ${failed}`);
    }
  }));
  await writeFile(path.join(root,'copy-report.json'),JSON.stringify({database,tableCount:tables.rowCount,files:objects.length,completed,failed,failures},null,2));
  console.log(JSON.stringify({completed,failed,total:objects.length}));
  }
}finally{await cloud.end();}
