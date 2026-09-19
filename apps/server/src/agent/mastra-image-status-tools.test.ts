import { describe, expect, it, vi } from "vitest";
import { createMastraImageJobScopeQuery, createMastraImageStatusTools } from "./mastra-image-status-tools.js";
import { ImageJobAccessError } from "../features/jobs/conversation-image-job-access.js";
import { toolExecutionContext } from "./tools/tool-run-context.js";
import type { AgentToolExecutionContext } from "./tools/tool-run-context.js";

/**
 * Mastra declares `execute` optional because a tool may be schema-only. Both tools
 * here are always built with a handler, so direct calls use a view that makes it
 * required; `jobId` may be omitted so the tool can fail closed on its own.
 */
type ImageStatusInput = { jobId?: string };
type ImageStatusResult = { status?: string; summary?: string };

function directTool(tool: { execute?: unknown }) {
  return tool as unknown as {
    execute: (input: ImageStatusInput, context: AgentToolExecutionContext) => Promise<ImageStatusResult>;
  };
}

function directTools(tools: ReturnType<typeof createMastraImageStatusTools>) {
  return { getImageStatus: directTool(tools.getImageStatus), cancelImageJob: directTool(tools.cancelImageJob),
    getVideoStatus: directTool(tools.getVideoStatus) };
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function fixture(status = "running") {
  const scope = { userId:id(1),workspaceId:id(2),sessionId:id(3),canvasId:id(4),liveDesignIds:new Set([id(5)]) };
  const user = { id:id(1),accessToken:"token",email:"",userMetadata:{} };
  const getConversationImageJob=vi.fn(async()=>({id:id(6),status,model:"workspace:nano",requestedAspectRatio:"3:4",
    creditsCost:"7",creditsCostColumn:7,pricingVersion:"credits-v1",quality:"hd",resolution:"2k"}));
  const getConversationVideoJob=vi.fn(async()=>({id:id(6),status,duration:"8",resolution:"1080p",
    requestedAspectRatio:"16:9",completed_at:"2026-09-19T10:00:00.000Z"}));
  const cancelJobAdmin=vi.fn(async()=>({id:id(6),status:"canceled"}));
  return {scope,user,getConversationImageJob,getConversationVideoJob,cancelJobAdmin,
    tools:directTools(createMastraImageStatusTools({user,scope,
      jobService:{getConversationImageJob,getConversationVideoJob,cancelJobAdmin} as never}))};
}
describe("Mastra image status tools",()=>{
  it("returns persisted model/ratio via the authorized service",async()=>{
    const f=fixture();
    await expect(f.tools.getImageStatus.execute({jobId:id(6)}, toolExecutionContext({}))).resolves.toMatchObject({model:"workspace:nano",requestedAspectRatio:"3:4"});
    expect(f.getConversationImageJob).toHaveBeenCalledWith(f.user,f.scope,id(6));
  });
  it("exposes the persisted submission receipt without raw payload fields",async()=>{
    const f=fixture();
    const result=await f.tools.getImageStatus.execute({jobId:id(6)}, toolExecutionContext({})) as Record<string,unknown>;
    expect(result).toMatchObject({creditsCost:7,pricingVersion:"credits-v1",actualQuality:"Medium",actualResolution:"2K"});
    expect(result).not.toHaveProperty("creditsCostColumn");
    expect(result).not.toHaveProperty("quality");
    expect(result).not.toHaveProperty("resolution");
  });
  it("uses the service authorization for cancellation and preserves live scope",async()=>{
    const f=fixture();f.scope.liveDesignIds.add(id(7));
    await expect(f.tools.cancelImageJob.execute({jobId:id(6)}, toolExecutionContext({}))).resolves.toMatchObject({status:"canceled"});
    expect(f.cancelJobAdmin).toHaveBeenCalledWith(f.user,id(6),f.scope);
  });
  it.each(["succeeded","failed","dead_letter","canceled"])("does not cancel terminal %s",async status=>{
    const f=fixture(status);
    const result=await f.tools.cancelImageJob.execute({jobId:id(6)}, toolExecutionContext({}));
    expect(result).toMatchObject({status});expect(result.summary).toContain("任务已经结束");
    expect(result.summary).not.toMatch(/已退款|退款成功/);expect(f.cancelJobAdmin).not.toHaveBeenCalled();
  });
  it("returns forbidden without claiming cancellation or refund",async()=>{
    const f=fixture();f.cancelJobAdmin.mockRejectedValue(new ImageJobAccessError());
    const result=await f.tools.cancelImageJob.execute({jobId:id(6)}, toolExecutionContext({}));
    expect(result.status).toBe("forbidden");expect(result.summary).not.toMatch(/已退款|已请求停止/);
  });
  it("fails closed on read authorization",async()=>{
    const f=fixture();f.getConversationImageJob.mockRejectedValue(new ImageJobAccessError());
    await expect(f.tools.getImageStatus.execute({}, toolExecutionContext({}))).resolves.toMatchObject({status:"forbidden"});
  });
  it("does not query for a mismatched runtime user identity",async()=>{
    const f=fixture();f.scope.userId=id(8);
    await expect(f.tools.getImageStatus.execute({}, toolExecutionContext({}))).resolves.toMatchObject({status:"forbidden"});
    expect(f.getConversationImageJob).not.toHaveBeenCalled();
  });
  it("keeps dynamic canvas/live-design fences for other runtime reads",()=>{
    const live=new Set<string>();const query={eq:vi.fn(),or:vi.fn()};const fence=createMastraImageJobScopeQuery(id(4),live);
    fence(query);expect(query.eq).toHaveBeenCalledWith("canvas_id",id(4));live.add(id(5));fence(query);
    expect(query.or).toHaveBeenCalledWith(`canvas_id.eq.${id(4)},design_id.in.(${id(5)})`);
  });
  it("reads an older video job through the same membership fence",async()=>{
    const f=fixture("dead_letter");
    await expect(f.tools.getVideoStatus.execute({jobId:id(6)}, toolExecutionContext({}))).resolves.toMatchObject({
      status:"dead_letter",completedAt:"2026-09-19T10:00:00.000Z",requestedAspectRatio:"16:9"});
    expect(f.getConversationVideoJob).toHaveBeenCalledWith(f.user,f.scope,id(6));
    // compactMastraToolResult normalizes the numeric duration.
    const result = await f.tools.getVideoStatus.execute({jobId:id(6)}, toolExecutionContext({})) as Record<string, unknown>;
    expect(result.duration).toBe(8);
  });
  it("answers a failed video in Chinese instead of relaying the upstream text",async()=>{
    const f=fixture("dead_letter");
    f.getConversationVideoJob.mockResolvedValue({id:id(6),status:"dead_letter",error_code:"http_401",
      error_message:"Invalid token",completed_at:null} as never);
    const result=await f.tools.getVideoStatus.execute({jobId:id(6)}, toolExecutionContext({})) as Record<string,unknown>;
    expect(result.errorLabel).toContain("凭据");
    expect(JSON.stringify(result)).not.toContain("Invalid token");
  });
  it("fails closed on video read authorization",async()=>{
    const f=fixture();f.getConversationVideoJob.mockRejectedValue(new ImageJobAccessError());
    await expect(f.tools.getVideoStatus.execute({}, toolExecutionContext({}))).resolves.toMatchObject({status:"forbidden"});
  });
});
