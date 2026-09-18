"use client";
import { useRef, useState } from "react";
import { createImageGenerationJob, fetchImageModels } from "../../lib/server-api";
import { createImageReplacementElement, updateImageReplacementElement } from "../../lib/canvas-image-replacement";

export type OutpaintSource = { dataURL: string; width: number; height: number };
export function ImageOutpaintPanel({ source, placement, api, accessToken, canvasId, preferredModel, onClose }: {
  source: OutpaintSource; placement: { x: number; y: number; width: number; height: number };
  api: any; accessToken: string; canvasId: string; preferredModel?: string | undefined;
  onClose: () => void;
}) {
  const [margins,setMargins]=useState({top:Math.round(source.height*.25),bottom:Math.round(source.height*.25),left:Math.round(source.width*.25),right:Math.round(source.width*.25)});
  const [prompt,setPrompt]=useState(""); const [busy,setBusy]=useState(false); const [error,setError]=useState("");
  const busyRef=useRef(false);
  const pending=useRef<{payload:Parameters<typeof createImageGenerationJob>[1];placeholderId:string}|null>(null);
  const active=useRef<{id:string;placeholderId:string}|null>(null);
  const width=source.width+margins.left+margins.right, height=source.height+margins.top+margins.bottom;
  const valid=Object.values(margins).every(v=>Number.isInteger(v)&&v>=0&&v<=4096) && Object.values(margins).some(v=>v>0) && width<=3840&&height<=3840&&width*height<=8294400&&Math.max(width/height,height/width)<=3;
  const frozen=busy || Boolean(pending.current) || Boolean(active.current);
  async function submit(){
    if(busyRef.current||!valid)return;
    busyRef.current=true;setBusy(true);setError("");
    try{
      if(!active.current){
        if(!pending.current){
          const models=(await fetchImageModels(accessToken)).models;
          const model=models.find(m=>m.id===preferredModel)?.id??models[0]?.id;
          if(!model)throw Error("尚未配置可用图片模型。");
          const scale=placement.width/source.width;
          const next={x:placement.x+placement.width+40,y:placement.y,width:width*scale,height:height*scale};
          const placeholderId=createImageReplacementElement(api,next,"outpaint");
          pending.current={placeholderId,payload:{canvas_id:canvasId,operation:"outpaint",model,quality:"standard",prompt:prompt.trim()||"自然延伸画面，保持原图的风格、光线和透视。",input_images:[source.dataURL],outpaint_margins:margins,placeholder_element_id:placeholderId,placement_x:next.x,placement_y:next.y,placement_width:next.width,placement_height:next.height}};
        }
        const submission=pending.current!;
        try{
          const response=await createImageGenerationJob(accessToken,submission.payload);
          active.current={id:response.job.id,placeholderId:submission.placeholderId};pending.current=null;
          updateImageReplacementElement(api,submission.placeholderId,{jobId:response.job.id});
        }catch(cause){
          const status=cause&&typeof cause==="object"&&"status"in cause?Number(cause.status):0;
          if(status>=400&&status<500){updateImageReplacementElement(api,submission.placeholderId,{isDeleted:true});pending.current=null;throw cause;}
          throw Error("提交结果尚未确认，范围和描述已锁定。点击重试会恢复同一请求，请勿重复创建任务。");
        }
      }
      // The canvas monitors durable placeholders by jobId, independently of this dialog.
      // Close on acceptance; generation and result synchronization continue on the canvas.
      onClose();
    }catch(cause){setError(cause instanceof Error?cause.message:"扩图失败");}
    finally{busyRef.current=false;setBusy(false);}
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onPointerDown={e=>e.stopPropagation()}>
    <section role="dialog" aria-modal="true" aria-label="扩图" className="max-h-[90vh] w-[540px] overflow-auto rounded-2xl border bg-background p-5 shadow-xl" onKeyDown={e=>e.stopPropagation()}>
      <h2 className="font-semibold">扩图</h2><p className="mt-1 text-xs text-muted-foreground">只生成外扩区域，原图保留；结果作为新图片放在旁边。</p>
      <div className="my-4 flex h-52 items-center justify-center rounded-lg bg-muted p-2">
        <div data-testid="outpaint-preview" className="relative border border-dashed border-primary" style={{width:Math.min(470,190*width/height),height:Math.min(190,470*height/width),backgroundImage:"repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%)",backgroundSize:"16px 16px"}}>
          <img alt="保留的原图" src={source.dataURL} className="absolute" style={{left:`${margins.left/width*100}%`,top:`${margins.top/height*100}%`,width:`${source.width/width*100}%`,height:`${source.height/height*100}%`}} />
        </div>
      </div>
      <fieldset disabled={frozen} className="space-y-3 disabled:opacity-60">
        <div className="flex gap-2">{[10,25,50].map(n=><button key={n} type="button" className="rounded border px-2 py-1 text-xs" onClick={()=>setMargins({top:Math.round(source.height*n/100),bottom:Math.round(source.height*n/100),left:Math.round(source.width*n/100),right:Math.round(source.width*n/100)})}>四周 +{n}%</button>)}<button type="button" className="rounded border px-2 py-1 text-xs" onClick={()=>setMargins({top:0,bottom:0,left:0,right:0})}>清零</button></div>
        <div className="grid grid-cols-4 gap-2">{([['top','上'],['bottom','下'],['left','左'],['right','右']] as const).map(([key,label])=><label key={key} className="text-xs">{label}（像素）<input aria-label={`${label}扩展像素`} type="number" min={0} max={4096} step={1} value={margins[key]} className="mt-1 w-full rounded border bg-background p-2" onChange={e=>setMargins(v=>({...v,[key]:Number(e.target.value)}))}/></label>)}</div>
        <label className="block text-sm">补充描述（可选）<textarea aria-label="扩图描述" className="mt-1 w-full rounded border bg-background p-2" value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="例如：右侧延伸为花园，保持原有光线"/></label>
      </fieldset>
      <p className="mt-2 text-xs">输出：{width} × {height} 像素</p>
      {!valid&&<p role="alert" className="mt-2 text-xs text-destructive">请设置有效扩展范围：至少一侧大于 0，最长边不超过 3840，像素总数不超过 8294400，宽高比不超过 3:1。</p>}
      {error&&<p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy||Boolean(pending.current)} className="rounded border px-3 py-2 text-sm" onClick={onClose}>关闭</button><button type="button" disabled={busy||!valid} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" onClick={()=>void submit()}>{busy?"扩图中…":error?"重试 / 查询任务":"开始扩图"}</button></div>
    </section>
  </div>;
}
