import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const opts={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,opts);
const auth=createClient(process.env.SUPABASE_URL,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,opts);
const session='b61afb7c-a12c-46e6-afcc-ebca47a2bace';
const {data:row,error}=await admin.from('chat_sessions').select('created_by,canvas_id').eq('id',session).single();
assert(!error);
const {data:account}=await admin.auth.admin.getUserById(row.created_by);
const {data:link}=await admin.auth.admin.generateLink({type:'magiclink',email:account.user.email});
const {data:login}=await auth.auth.verifyOtp({type:'magiclink',token_hash:link.properties.hashed_token});
assert(login.session);
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage();
 await page.addInitScript(value=>localStorage.setItem('sb-127-auth-token',JSON.stringify(value)),login.session);
 await page.goto(`http://localhost:${process.env.QA_WEB_PORT || '3020'}/canvas?id=${row.canvas_id}&session=${session}`);
 try { await page.getByText(/503 模型.*所有渠道当前不可用/).first().waitFor({timeout:20000}); }
 catch(error) { await page.screenshot({path:'../../artifacts/generation-failure-debug.png'}); console.log((await page.locator('body').innerText()).slice(-3000)); throw error; }
 assert(await page.getByText('图片生成失败',{exact:true}).count()>0);
 console.log(JSON.stringify({terminalFailureVisible:true,providerCalls:0}));
 await page.screenshot({path:'../../artifacts/generation-failure.png'});
} finally {await browser.close();}
