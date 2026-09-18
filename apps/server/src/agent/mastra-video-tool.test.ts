import { describe, expect, it, vi } from "vitest";

import { createMastraVideoTool } from "./mastra-video-tool.js";
import type { MastraVideoJobContext } from "./mastra-video-jobs.js";
import { toolExecutionContext } from "./tools/tool-run-context.js";
import type { AgentToolExecutionContext } from "./tools/tool-run-context.js";

/**
 * Raw arguments as the model sends them, before the tool's Zod schema applies its
 * defaults. Mastra types `execute`'s parameter from the schema's *parsed* output
 * and declares `execute` itself optional.
 */
type VideoToolInput = {
  title: string;
  prompt: string;
  model?: string;
  duration?: number;
  sourceAssetIds?: string[];
};

function directTool(tool: { execute?: unknown }) {
  return tool as unknown as {
    execute: (input: VideoToolInput, context: AgentToolExecutionContext) => Promise<unknown>;
  };
}

const assetId = "10000000-0000-4000-8000-000000000001";
const config = {
  signal: new AbortController().signal,
  configurable: { user_id: "user", access_token: "token", workspace_id: "workspace", session_id: "session",
    canvas_id: "canvas", run_id: "run" },
};
const models = [{
  id: "workspace:video", provider: "workspace", displayName: "Video", description: "",
  capabilities: { textToVideo: true, imageToVideo: true, videoToVideo: false, audio: true },
  limits: { maxDuration: 10, allowedDurations: [5, 10], maxResolution: "1080p" as const, maxInputImages: 1 },
}];

function fixture() {
  const submit = vi.fn(async (_context: MastraVideoJobContext, _input: unknown) => ({ jobId: "job-1", status: "processing" as const }));
  return { submit, tool: directTool(createMastraVideoTool({ createUserClient: vi.fn(), submitter: { submit }, availableVideoModels: models })) };
}

describe("Mastra native video tool", () => {
  it("submits only the selected published workspace model", async () => {
    const f = fixture();
    await expect(f.tool.execute({ title: "视频", prompt: "蓝色海报动态", model: "workspace:video", duration: 5 }, toolExecutionContext(config)))
      .resolves.toMatchObject({ status: "processing", jobId: "job-1" });
    expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ runId: "run", signal: config.signal }),
      expect.objectContaining({ model: "workspace:video", duration: 5 }));
  });

  it("resolves only an authenticated asset id before passing an internal data URI", async () => {
    const f = fixture();
    const reference = "data:image/png;base64,aGVsbG8=";
    await f.tool.execute({ title: "视频", prompt: "让图片动起来", sourceAssetIds: [assetId] }, toolExecutionContext({
      ...config, configurable: { ...config.configurable, user_attachment_map: { [assetId]: reference } },
    }));
    expect(f.submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inputImages: [reference] }));
  });

  it("rejects URLs and unavailable models without submitting", async () => {
    const f = fixture();
    await expect(f.tool.execute({ title: "视频", prompt: "动态", sourceAssetIds: ["https://example.test/a.png"] } as any, toolExecutionContext(config))).rejects.toThrow();
    await expect(f.tool.execute({ title: "视频", prompt: "动态", model: "veo-default" }, toolExecutionContext(config)))
      .resolves.toMatchObject({ status: "failed", error: "video_model_required" });
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("fails closed without the actual run signal", async () => {
    const f = fixture();
    await expect(f.tool.execute({ title: "视频", prompt: "动态" }, toolExecutionContext({ configurable: config.configurable })))
      .resolves.toMatchObject({ status: "failed", error: "video_context_unavailable" });
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("does not submit changed arguments again after an unknown submitter outcome", async () => {
    const f = fixture();
    f.submit.mockRejectedValueOnce(new Error("poll transport lost"));
    const first = await f.tool.execute({ title: "视频", prompt: "动态海报", model: "workspace:video" }, toolExecutionContext(config));
    const second = await f.tool.execute({ title: "视频", prompt: "改用另一个风格", model: "workspace:video", duration: 10 }, toolExecutionContext(config));
    expect(first).toMatchObject({ status: "unknown", error: "video_submission_unknown" });
    expect(second).toEqual(first);
    expect(f.submit).toHaveBeenCalledOnce();
  });
});
