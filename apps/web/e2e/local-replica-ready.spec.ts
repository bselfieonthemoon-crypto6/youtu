import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
test.use({trace:'off',video:'off',actionTimeout:15000});
const local=process.env.SUPABASE_URL==='http://127.0.0.1:54421';

test('local registration initializes a usable account',async({page})=>{
 test.skip(!local,'Local replica only');
 page.on('requestfailed',r=>console.log('Request failed',new URL(r.url()).pathname,r.failure()?.errorText));
 page.on('console',m=>{if(m.type()==='error'&&/CORS|preflight/.test(m.text()))console.log(m.text().replace(/\?[^\s']+/g,'?[redacted]'));});
 await page.goto('/register');
 const email=`replica-${Date.now()}@example.com`;
 await page.getByLabel('Email',{exact:true}).fill(email);
 const password=`Local-${crypto.randomUUID()}!`;
 await page.getByLabel('Password',{exact:true}).fill(password);
 await page.getByLabel('Confirm password',{exact:true}).fill(password);
 await page.locator('button[type=submit]').click();
 await expect(page).toHaveURL(/\/home/,{timeout:60000});
 console.log('New account registration and workspace bootstrap passed');
});

test('real dialogue generates one canvas image and one artboard image',async({page,request})=>{
 test.skip(!local,'Local replica only');test.setTimeout(600000);
 const url=process.env.SUPABASE_URL!;
 const admin=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
 const {data:{user}}=await admin.auth.admin.getUserById('541006fa-d2a1-4305-be55-b6263c27a1e3');
 const {data:link,error}=await admin.auth.admin.generateLink({type:'magiclink',email:user!.email!});
 if(error)throw new Error('Test authentication unavailable');
 const client=createClient(url,process.env.SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 const {data:auth}=await client.auth.verifyOtp({token_hash:link.properties.hashed_token,type:'magiclink'});
 expect(auth.session).toBeTruthy();
 const headers={Authorization:`Bearer ${auth.session!.access_token}`};
 const server='http://127.0.0.1:3002';
 const resumeCanvas=process.env.LOOMIC_LOCAL_RESUME_CANVAS_ID;
 const resumeDesign=process.env.LOOMIC_LOCAL_RESUME_DESIGN_ID;
 let canvasId=resumeCanvas;
 if(!canvasId){
  const created=await request.post(`${server}/api/projects`,{headers,data:{name:`本地完整生图验收 ${Date.now()}`}});
  expect(created.ok()).toBe(true);const {project}=await created.json();canvasId=project.primaryCanvas.id;
 }
 const key=`sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
 await page.addInitScript(({key,session})=>localStorage.setItem(key,JSON.stringify(session)),{key,session:auth.session});
 await page.goto(`/canvas?id=${canvasId}`);
 const generate=async(prompt:string,designId?:string)=>{
   const input=page.getByPlaceholder('Start with an idea, or type "@" to mention');await expect(input).toBeEnabled({timeout:60000});
   await input.click();await input.fill(prompt);await expect(input).toHaveValue(prompt);console.log('Chat prompt filled');
   const send=page.getByRole('button',{name:'发送消息',exact:true});
   await expect(send).toBeEnabled({timeout:60000});await send.click();console.log('Chat prompt submitted');
   const confirm=page.getByRole('button',{name:/确认方案，继续生成/});
   await expect(confirm).toBeVisible({timeout:150000});await confirm.click();
   let job:any;
   await expect.poll(async()=>{
     const {data,error}=await admin.from('background_jobs').select('id,status,error_code,design_id,job_type').eq(designId?'design_id':'canvas_id',designId??canvasId!).eq('job_type','image_generation').order('created_at',{ascending:false});
     if(error)throw new Error('Cannot inspect local test job');
     job=data?.find(j=>designId?j.design_id===designId:!j.design_id);
     if(job&&['failed','dead_letter','canceled'].includes(job.status))throw new Error(`Generation terminal: ${job.status}/${job.error_code}`);
     return job?.status;
   },{timeout:240000,intervals:[2000]}).toBe('succeeded');
   console.log(JSON.stringify({canvasId,designId:designId??null,jobId:job.id,status:job.status}));
   return job.id;
 };
 try{
   if(!resumeCanvas)await generate('请生成一张 1:1 的原创蓝色小鲸鱼插画，纯白背景，只生成一张放到无限画布中。使用标准画质，方案已明确，请调用生图工具提交确认方案。');
   const snap=await request.get(`${server}/api/canvases/${canvasId}`,{headers});const {canvas}=await snap.json();
   let designId=resumeDesign;
   if(!designId){
    const board=await request.post(`${server}/api/designs`,{headers,data:{request_id:crypto.randomUUID(),canvas_id:canvasId,expected_canvas_revision:canvas.revision,canvas_element_id:crypto.randomUUID(),name:'本地 Agent 画板验收',width:640,height:480,background:'#ffffff',node:{x:400,y:100,width:640,height:480}}});
    expect(board.ok()).toBe(true);designId=(await board.json()).design_id;
   }
   await page.reload();
   const preview=page.locator(`[data-testid="design-node-preview"][data-design-id="${designId}"]`);
   await expect(preview).toBeVisible({timeout:60000});
   console.log('Artboard preview visible');
   const box=await preview.boundingBox();expect(box).toBeTruthy();
   // A zoomed artboard can extend beneath the chat sidebar. Click its visible
   // canvas portion rather than the center of its full off-screen bounds.
   const left=Math.max(box!.x,20),right=Math.min(box!.x+box!.width,950);
   const top=Math.max(box!.y,65),bottom=Math.min(box!.y+box!.height,800);
   expect(right).toBeGreaterThan(left);expect(bottom).toBeGreaterThan(top);
   await page.mouse.dblclick((left+right)/2,(top+bottom)/2);
   await expect(page.getByTestId('design-inline-editor')).toBeVisible();
   console.log('Artboard editor opened');
   // The chat session is hydrated independently of the artboard. Wait for
   // existing history before entering text, which session switching clears.
   await expect(page.getByText('图片生成结果',{exact:true}).first()).toBeVisible({timeout:60000});
   await generate('请给当前设计画板生成一张深蓝色科技背景，铺满画板并放在最底层，保留已有元素。只生成一张，标准画质，请直接提交确认方案。',designId);
   await expect.poll(async()=>{
     const r=await request.get(`${server}/api/designs/${designId}`,{headers});const {design}=await r.json();
     return design.scene.objects.some((o:any)=>o.type==='image');
   },{timeout:60000}).toBe(true);
   await page.screenshot({path:'test-results/local-replica-generation.png'});
 }finally{await client.auth.signOut({scope:'local'});}
});
