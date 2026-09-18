import {createClient} from '@supabase/supabase-js';
import {test,expect} from '@playwright/test';

test.use({trace:'off',video:'off'});
test('copied canvas reads authenticated local assets without cloud Supabase traffic',async({page})=>{
  test.skip(process.env.SUPABASE_URL!=='http://127.0.0.1:54421','Isolated local replica only');
  const url=process.env.SUPABASE_URL!;
  const admin=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
  const {data:{user}}=await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
  const {data:link,error}=await admin.auth.admin.generateLink({type:'magiclink',email:user!.email!});
  if(error)throw new Error('Local test authentication unavailable');
  const client=createClient(url,process.env.SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
  const {data:auth}=await client.auth.verifyOtp({token_hash:link.properties.hashed_token,type:'magiclink'});
  expect(auth.session).toBeTruthy();
  const key=`sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
  await page.addInitScript(({key,session})=>localStorage.setItem(key,JSON.stringify(session)),{key,session:auth.session});
  const remote:string[]=[];
  let localAssets=0;
  page.on('request',request=>{
    const parsed=new URL(request.url());
    if(parsed.hostname.endsWith('.supabase.co'))remote.push(parsed.hostname+parsed.pathname);
  });
  page.on('response',response=>{
    if(response.url().startsWith('http://127.0.0.1:3002/api/uploads/') && response.ok())localAssets++;
  });
  try{
    await page.goto('/canvas?id=aa990d3b-1c04-4cb4-b3f7-93eef1d40356&session=73fd8cd8-7043-4a2c-a8ac-31149cac87c0');
    const preview=page.locator('[data-testid="design-node-preview"][data-design-id="c0f64c76-fc8d-43d0-8326-b4d825daad65"] img');
    await expect(preview).toBeVisible({timeout:60000});
    await expect(preview).toHaveAttribute('src',/^blob:/);
    await expect.poll(()=>localAssets).toBeGreaterThan(0);
    expect(remote).toEqual([]);
    await page.screenshot({path:'test-results/local-replica-canvas.png'});
    console.log(JSON.stringify({localAssetResponses:localAssets,cloudSupabaseRequests:remote.length}));
  }finally{await client.auth.signOut({scope:'local'});}
});
