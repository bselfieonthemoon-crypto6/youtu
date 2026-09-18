import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
assert.equal(process.env.SUPABASE_URL,'http://127.0.0.1:54421');
const opts={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,opts);
const auth=createClient(process.env.SUPABASE_URL,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,opts);
const session='940093d9-5dda-4479-8366-d6ce698090a9';
const {data:row,error}=await admin.from('chat_sessions').select('created_by,canvas_id').eq('id',session).single();assert(!error);
const {data:account}=await admin.auth.admin.getUserById(row.created_by);
const {data:link}=await admin.auth.admin.generateLink({type:'magiclink',email:account.user.email});
const {data:login}=await auth.auth.verifyOtp({type:'magiclink',token_hash:link.properties.hashed_token});assert(login.session);
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 page.on('pageerror',error=>console.error('browser_page_error',error.message.replace(/https?:\/\/\S+/g,'[url]')));
 await page.addInitScript(value=>localStorage.setItem('sb-127-auth-token',JSON.stringify(value)),login.session);
 await page.goto(`http://localhost:3020/canvas?id=${row.canvas_id}&session=${session}`);
 try { await page.getByTestId('image-aspect-ratio-selector').click(); }
 catch(error) { await page.screenshot({path:'../../artifacts/orchestration-smoke-failure.png'}); throw error; }
 await page.getByTestId('image-aspect-ratio-option-16-9').click();
 await page.getByRole('button',{name:'图片比例：16:9',exact:true}).waitFor();
 await page.reload();
 await page.getByRole('button',{name:'图片比例：16:9',exact:true}).waitFor();
 await page.getByText('再继续生成一张落地页',{exact:true}).waitFor({timeout:30000});
 await page.getByText('连接已断开，正在重连...',{exact:true}).waitFor({state:'hidden',timeout:30000});
 await page.screenshot({path:'../../artifacts/chat-aspect-ratio.png'});
 console.log(JSON.stringify({ratioSelection:true,persistedAfterReload:true,conversationRestored:true,providerCalls:0}));
} finally {await browser.close();}
