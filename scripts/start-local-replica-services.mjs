import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('artifacts/local-replica-20260907');
await mkdir(root,{recursive:true});
const inspect=name=>JSON.parse(execFileSync('docker',['inspect',name],{encoding:'utf8'}))[0];
const envOf=d=>Object.fromEntries(d.Config.Env.map(v=>[v.slice(0,v.indexOf('=')),v.slice(v.indexOf('=')+1)]));
const database='loomic_replica_light_20260907';
const services={auth:54432,rest:54431,storage:54433};
const copies={};
for(const [kind,port] of Object.entries(services)){
 const source=inspect(`supabase_${kind}_thtdhcvjppuvlvahfmga`);
 const env=envOf(source);
 for(const key of ['GOTRUE_DB_DATABASE_URL','PGRST_DB_URI','DATABASE_URL'])if(env[key]){
   const url=new URL(env[key]);url.pathname='/'+database;env[key]=url.toString();
 }
 if(kind==='auth')Object.assign(env,{GOTRUE_SITE_URL:'http://localhost:3020',API_EXTERNAL_URL:'http://127.0.0.1:54421',GOTRUE_JWT_ISSUER:'http://127.0.0.1:54421/auth/v1',GOTRUE_URI_ALLOW_LIST:'http://localhost:3020/**',GOTRUE_DISABLE_SIGNUP:'false'});
 if(kind==='storage')Object.assign(env,{VECTOR_ENABLED:'false',VECTOR_STORE_MIGRATIONS_ENABLED:'false',ENABLE_IMAGE_TRANSFORMATION:'false'});
 const file=path.join(root,`${kind}.env`);
 await writeFile(file,Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
 const name=`loomic_replica_${kind}`;
 let exists=false;try{inspect(name);exists=true;}catch{}
 if(exists && kind==='auth' && envOf(inspect(name)).GOTRUE_DISABLE_SIGNUP!==env.GOTRUE_DISABLE_SIGNUP){
  // Replace only this stateless replica service; its database remains untouched.
  execFileSync('docker',['rm','-f',name],{stdio:'pipe'});exists=false;
 }
 if(!exists){
  const args=['run','-d','--name',name,'--network','supabase_network_thtdhcvjppuvlvahfmga','--env-file',file,'-p',`127.0.0.1:${port}:${kind==='auth'?9999:kind==='rest'?3000:5000}`];
  if(kind==='storage')args.push('-v','loomic_replica_storage:/mnt');
  args.push(source.Config.Image);
  execFileSync('docker',args,{stdio:'pipe'});
 }else execFileSync('docker',['start',name],{stdio:'pipe'});
 copies[kind]=env;
 console.log(`${name}: localhost:${port}`);
}
const db=envOf(inspect('supabase_db_thtdhcvjppuvlvahfmga'));
const dbUrl=new URL('postgresql://postgres@127.0.0.1:54322/'+database);dbUrl.password=db.POSTGRES_PASSWORD;
// Separate generated config; never edit the live .env.local files.
const overrides={SUPABASE_URL:'http://127.0.0.1:54421',NEXT_PUBLIC_SUPABASE_URL:'http://127.0.0.1:54421',SUPABASE_DB_URL:dbUrl.toString(),SUPABASE_ANON_KEY:copies.storage.ANON_KEY,NEXT_PUBLIC_SUPABASE_ANON_KEY:copies.storage.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:copies.storage.SERVICE_KEY,SUPABASE_JWT_SECRET:copies.auth.GOTRUE_JWT_SECRET,SUPABASE_PROJECT_ID:'loomic-local-replica',LOOMIC_SERVER_PORT:'3002',LOOMIC_WEB_ORIGIN:'http://localhost:3020',NEXT_PUBLIC_SERVER_BASE_URL:'http://127.0.0.1:3002',LOOMIC_NEXT_DIST_DIR:'.next-local-replica'};
// GoTrue signs with its local asymmetric key set. Use its authenticated local
// getUser endpoint instead of treating the legacy HMAC secret as that key.
overrides.SUPABASE_JWT_SECRET='';
const source=await readFile('.env.local','utf8');
const filtered=source.split(/\r?\n/).filter(l=>!Object.keys(overrides).some(k=>l.startsWith(k+'=')));
await writeFile(path.join(root,'app.env'),filtered.join('\n')+'\n'+Object.entries(overrides).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n');
console.log('Isolated service configuration ready; no worker started.');
