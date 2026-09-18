import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const options={auth:{persistSession:false,autoRefreshToken:false}};
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,options);
const account=await db.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');assert.ifError(account.error);
const link=await db.auth.admin.generateLink({type:'magiclink',email:account.data.user.email});assert.ifError(link.error);
const auth=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,options);
const login=await auth.auth.verifyOtp({type:'magiclink',token_hash:link.data.properties.hashed_token});assert.ifError(login.error);
try {
  const response=await fetch('http://127.0.0.1:3002/api/workspaces/skills',{headers:{Authorization:`Bearer ${login.data.session.access_token}`}});
  assert.equal(response.status,200);
  const {skills}=await response.json();
  const raster=['logo-design','campaign-design','product-visual','social-carousel','series-visual-design'];
  for(const slug of raster){const skill=skills.find(s=>s.slug===slug);assert(skill?.enabled,slug);assert.notEqual(skill.readiness?.status,'unavailable',`${slug} unavailable`);assert.equal(skill.version,'2.2.0');}
  assert.equal(skills.find(s=>s.slug==='canvas-design')?.readiness?.status,'unavailable');
  console.log(JSON.stringify(skills.filter(s=>s.enabled).map(s=>({slug:s.slug,version:s.version,status:s.readiness?.status,reasons:s.readiness?.reasons})),null,2));
}finally{await auth.auth.signOut({scope:'local'});}
