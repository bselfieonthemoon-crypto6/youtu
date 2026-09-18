// Explicit one-call paid probe. No catalog/job/canvas mutations or auto retries.
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { imageGenerationPayloadSchema } from "@loomic/shared";
import assert from "node:assert/strict";
import { createSafeProviderFetch } from "../src/security/safe-provider-fetch.js";
import { loadServerEnv } from "../src/config/env.js";
import { createAdminSupabaseClient } from "../src/supabase/admin.js";
import { OpenAIImageProvider } from "../src/generation/providers/openai-image.js";
import { prepareLocalRepaint, localRepaintRequest, composeLocalRepaint } from "../src/features/images/local-repaint.js";
const submit = process.argv.includes("--submit");
if (!submit && !process.argv.includes("--inspect")) throw Error("Requires --submit or --inspect");
const model = process.argv.find(a => a.startsWith("--model="))?.slice(8);
if (model !== "gpt-image-2.5-flare" && model !== "gpt-image-2.5-sunburst") throw Error("Unsupported probe model");
const env=loadServerEnv();
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(env.supabaseUrl ?? "")) throw Error("Local DB only");
const db=createAdminSupabaseClient(env);
const {data:job,error}=await db.from("background_jobs").select("payload,workspace_id").eq("id","f852e9f9-fd03-4369-81e9-6035e766f381").single();
if(error)throw error;
const payload=imageGenerationPayloadSchema.parse(job.payload);
const {data:row,error:me}=await db.from("workspace_provider_models").select("provider_config_id,enabled").eq("id","748c78b1-29cd-438f-a23c-d6b7367c64f8").single();
if(me||!row?.enabled)throw Error("Original provider model unavailable");
const {data:config}=await db.from("workspace_provider_configs").select("base_url,api_key_secret_id,enabled,workspace_id").eq("id",row.provider_config_id).single();
if(!config?.enabled||config.workspace_id!==job.workspace_id)throw Error("Provider scope mismatch");
const secret=await db.rpc("loomic_provider_secret_read",{p_secret_id:config.api_key_secret_id});
if(secret.error||!secret.data)throw Error("Credentials unavailable");
const bytes=async (url:string) => {
 if(url.startsWith("data:"))return Buffer.from(url.split(",")[1]!,"base64");
 const r=await fetch(url);if(!r.ok)throw Error(`Image download ${r.status}`);return Buffer.from(await r.arrayBuffer());
};
const prepared=await prepareLocalRepaint(await bytes(payload.input_images![0]!),await bytes(payload.mask_image!));
const request={...localRepaintRequest(prepared,payload.prompt),model,aspectRatio:`${prepared.width}:${prepared.height}`,quality:process.argv.includes("--high") ? "ultra" as const : payload.quality ?? "standard"};
const dir=`../../artifacts/repaint-probe-${model}-${Date.now()}`;
await mkdir(dir,{recursive:true});
await writeFile(`${dir}/source.png`,prepared.sourcePng);
await writeFile(`${dir}/mask.png`,prepared.providerMaskPng);
await writeFile(`${dir}/request.json`,JSON.stringify({...request,inputImages:"source.png",maskImage:"mask.png"},null,2));
console.log(JSON.stringify({event:submit?"submitting":"inspecting",model,dir,maxCalls:submit?1:0,background:prepared.background}));
try {
 const upstream=new OpenAIImageProvider(String(secret.data),config.base_url);
 const client=(upstream as any).client;
 const realFetch=client.fetch;
 let calls=0;
 client.fetch=createSafeProviderFetch(config.base_url,{fetch:async(input,init)=>{
   if(++calls>1)throw Error("No retries allowed");
   const encoded=new Request(input,init);
   assert.equal(new URL(encoded.url).pathname,"/v1/images/edits");
   assert(encoded.headers.get("content-type")?.includes("multipart/form-data; boundary="));
   const form=await encoded.clone().formData();
   const image=form.get("image[]") ?? form.get("image[0]") ?? form.get("image");
   const mask=form.get("mask");
   assert(image instanceof File && mask instanceof File);
   assert(Buffer.from(await image.arrayBuffer()).equals(prepared.sourcePng));
   assert(Buffer.from(await mask.arrayBuffer()).equals(prepared.providerMaskPng));
   const maskMeta=await sharp(prepared.providerMaskPng).metadata();
   assert.equal(maskMeta.width,prepared.width);assert.equal(maskMeta.height,prepared.height);
   const alpha=await sharp(prepared.providerMaskPng).extractChannel("alpha").raw().toBuffer();
   let editPixels=0,preservePixels=0;
   for(let i=0;i<alpha.length;i++){assert.equal(alpha[i],255-prepared.maskPixels[i]!);if(alpha[i]===0)editPixels++;if(alpha[i]===255)preservePixels++;}
   assert(editPixels>0 && preservePixels>0);
   assert.equal(form.get("quality"),process.argv.includes("--high")?"high":"low");
   const report={event:"multipart_verified",fields:[...form.keys()],model:form.get("model"),quality:form.get("quality"),size:form.get("size"),background:form.get("background"),sourceUnchanged:true,maskUnchanged:true,width:prepared.width,height:prepared.height,editPixels,preservePixels};
   await writeFile(`${dir}/transport.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
   if(!submit)return new Response(JSON.stringify({data:[{b64_json:prepared.sourcePng.toString("base64")}]}),{headers:{"content-type":"application/json"}});
   // clone().formData() tees the encoded body. Forward the untouched Request
   // branch, not the original now-locked input stream.
   return realFetch(encoded);
 }});
 const result=await upstream.generate(request);
 const original=await bytes(result.url);
 await writeFile(`${dir}/provider-original.png`,original);
 await writeFile(`${dir}/composed.png`,await composeLocalRepaint(prepared,original));
 const metadata=await sharp(original).metadata();
 console.log(JSON.stringify({event:"returned",model,dir,width:metadata.width,height:metadata.height,channels:metadata.channels}));
}catch(error){console.log(JSON.stringify({event:"failed",model,code:(error as any).code,message:String(error instanceof Error?error.message:error).replace(/https?:\/\/\S+/g,"[url]")}));process.exitCode=1;}
