import { describe, expect, it, vi } from "vitest";

const structuredTransport = vi.hoisted(() => ({
  bodies: [] as Array<Record<string, any>>,
  fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
    structuredTransport.bodies.push(body);
    const message = [...(body.messages ?? [])].reverse().find((item: any) => item.role === "user");
    const content = typeof message?.content === "string" ? message.content
      : Array.isArray(message?.content) ? message.content.map((item: any) => item?.text ?? "").join("") : "{}";
    const packet = JSON.parse(content) as { manifestDigest: string };
    return new Response(JSON.stringify({
      id: "chatcmpl_source_grounding", object: "chat.completion", created: 1,
      model: "deepseek-v4-flash-vision-exp",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
        decision: "bind", manifestDigest: packet.manifestDigest, candidateKeys: ["source-1"], usage: "reference",
        evidence: { sourceId: id(20), quote: "刚才双叶logo" }, reasonCode: "recent_result",
      }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }),
}));

vi.mock("../security/safe-provider-fetch.js", () => ({
  createSafeProviderFetch: () => structuredTransport.fetch,
}));

import {
  buildMastraImageSourceCandidates,
  buildMastraImageSourceEffectiveBrief,
  createMastraExplicitImageSourceResolver,
  createMastraImageSourceGrounder,
  createMastraImageSourceMaterializer,
  createMastraImageSourceReviewer,
  mastraImageSourceReviewSchema,
  type MastraImageSourceCandidate,
  type MastraImageSourceReviewer,
} from "./mastra-image-source-grounding.js";
import { createMastraWorkspaceModel } from "./mastra-agent.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const assetId = id(1);
const jobId = id(2);
const canvasId = id(3);
const designId = id(4);
const context = {
  userId: id(10), accessToken: "private-token", workspaceId: id(11), sessionId: id(12),
  canvasId, runId: id(13), signal: new AbortController().signal,
};
const proposal = { title: "茶叶海报", prompt: "做一张双叶品牌海报", operation: "generate" as const };

function candidate(overrides: Partial<MastraImageSourceCandidate> = {}): MastraImageSourceCandidate {
  return { candidateKey: "source-1", assetId, provenance: ["recent_succeeded_job"], jobId,
    title: "刚才的双叶 logo", promptExcerpt: "深蓝色双叶标志", ...overrides };
}

function grounder(reviewer: MastraImageSourceReviewer, candidates = [candidate()], timeoutMs?: number) {
  const materialize = vi.fn(async (selected: readonly MastraImageSourceCandidate[]) => selected.map(item => ({
    assetId: item.assetId, inputImage: "data:image/png;base64,aGVsbG8=",
  })));
  return {
    materialize,
    resolve: createMastraImageSourceGrounder({
      currentRequest: { sourceId: id(20), text: "参考刚才双叶logo生成海报", provenance: "current_user" },
      effectiveBrief: [{ sourceId: id(21), text: "修改深蓝叶片成双叶", provenance: "recent_user" }],
      candidates, reviewer, materialize, ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
  };
}

describe("Mastra image source grounding", () => {
  it("does not call the reviewer or materializer when no trusted candidates exist", async () => {
    const reviewer = vi.fn();
    const f = grounder(reviewer, []);
    await expect(f.resolve({ context, proposal })).resolves.toEqual({ decision: "independent", authorizationGranted: false });
    expect(reviewer).not.toHaveBeenCalled();
    expect(f.materialize).not.toHaveBeenCalled();
  });

  it("binds only opaque candidate keys backed by an exact user quote and memoizes only its reviewer decision", async () => {
    let packet: any;
    const reviewer = vi.fn(async input => {
      packet = input;
      return { decision: "bind", manifestDigest: input.manifestDigest, candidateKeys: ["source-1"], usage: "reference",
        evidence: { sourceId: id(20), quote: "刚才双叶logo" }, reasonCode: "recent_result" };
    });
    const original = candidate();
    const f = grounder(reviewer, [original]);
    original.title = "mutated https://private.example/?token=secret";
    const first = await f.resolve({ context, proposal });
    const second = await f.resolve({ context, proposal });

    expect(first).toMatchObject({ decision: "bind", usage: "reference", sourceAssetIds: [assetId], authorizationGranted: false });
    expect(second).toEqual(first);
    expect(reviewer).toHaveBeenCalledOnce();
    // Authorization and source availability are rechecked on every use.
    expect(f.materialize).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(packet)).not.toContain(assetId);
    expect(JSON.stringify(packet)).not.toContain(jobId);
    expect(JSON.stringify(packet)).not.toContain("private-token");
    expect(JSON.stringify(packet)).not.toContain("private.example");
    expect(packet.candidates[0]).toMatchObject({ candidateKey: "source-1", title: "刚才的双叶 logo" });
    f.materialize.mockRejectedValueOnce(new Error("source access revoked"));
    await expect(f.resolve({ context, proposal })).resolves.toMatchObject({ decision: "recoverable", code: "source_grounding_unavailable" });
    expect(reviewer).toHaveBeenCalledOnce();
    expect(f.materialize).toHaveBeenCalledTimes(3);
    // A transient read failure must not poison the next user-authorized attempt.
    await expect(f.resolve({ context, proposal })).resolves.toMatchObject({ decision: "bind", sourceAssetIds: [assetId] });
    expect(f.materialize).toHaveBeenCalledTimes(4);
  });

  it("does not memoize failed reviews or share a decision between runs", async () => {
    const reviewer = vi.fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockImplementation(async input => ({ decision: "bind", manifestDigest: input.manifestDigest,
        candidateKeys: ["source-1"], usage: "reference", evidence: { sourceId: id(20), quote: "刚才双叶logo" },
        reasonCode: "recent_result" }));
    const f = grounder(reviewer);

    await expect(f.resolve({ context, proposal })).resolves.toMatchObject({ decision: "recoverable", code: "source_grounding_unavailable" });
    await expect(f.resolve({ context, proposal })).resolves.toMatchObject({ decision: "bind", sourceAssetIds: [assetId] });
    await expect(f.resolve({ context: { ...context, runId: id(14) }, proposal })).resolves.toMatchObject({ decision: "bind", sourceAssetIds: [assetId] });

    expect(reviewer).toHaveBeenCalledTimes(3);
    expect(f.materialize).toHaveBeenCalledTimes(2);
  });

  it("reviews one verdict per run+manifest and keeps the memo bounded across runs", async () => {
    const reviewer = vi.fn(async input => ({ decision: "independent", manifestDigest: input.manifestDigest,
      reasonCode: "explicit_independent" }));
    const f = grounder(reviewer);
    const proposals = Array.from({ length: 9 }, (_, index) => ({ ...proposal, title: `方案 ${index}` }));

    // Nine zero-source proposals of ONE run ask the same question about the same
    // frozen request+manifest, so the run answers it once whatever each proposal
    // says. This is the mid-series fix: a same-step pair used to review twice and
    // could reach two different verdicts for one user request.
    for (const item of proposals) await f.resolve({ context, proposal: item });
    await f.resolve({ context, proposal: proposals[0]! });

    expect(reviewer).toHaveBeenCalledOnce();
    expect(f.materialize).not.toHaveBeenCalled();

    // Nine DIFFERENT runs still review separately, and the memo stays bounded.
    const runContexts = Array.from({ length: 9 }, (_, index) => ({ ...context, runId: id(30 + index) }));
    for (const [index, runContext] of runContexts.entries())
      await f.resolve({ context: runContext, proposal: proposals[index]! });
    expect(reviewer).toHaveBeenCalledTimes(10);

    // A run still inside the memo answers from it...
    await f.resolve({ context: runContexts[8]!, proposal: proposals[0]! });
    expect(reviewer).toHaveBeenCalledTimes(10);
    // ...while a run whose entry was evicted is reviewed again instead of
    // inheriting another run's verdict.
    await f.resolve({ context: runContexts[0]!, proposal: proposals[0]! });
    expect(reviewer).toHaveBeenCalledTimes(11);
  });

  it("shares one in-flight review between two concurrent calls of the same run", async () => {
    let releaseReview!: () => void;
    const gate = new Promise<void>(resolve => { releaseReview = resolve; });
    const reviewer = vi.fn(async (input: Parameters<MastraImageSourceReviewer>[0]) => {
      await gate;
      return { decision: "independent" as const, manifestDigest: input.manifestDigest,
        reasonCode: "explicit_independent" as const };
    });
    const f = grounder(reviewer);

    // The reviewer is invoked inside the synchronous part of `resolve`, so both
    // calls already share ONE invocation before either is awaited.
    const first = f.resolve({ context, proposal: { ...proposal, title: "新品主视觉" } });
    const second = f.resolve({ context, proposal: { ...proposal, title: "日常场景" } });
    expect(reviewer).toHaveBeenCalledOnce();

    releaseReview();
    await expect(first).resolves.toEqual({ decision: "independent", authorizationGranted: false });
    await expect(second).resolves.toEqual({ decision: "independent", authorizationGranted: false });
    expect(reviewer).toHaveBeenCalledOnce();
    expect(f.materialize).not.toHaveBeenCalled();
  });

  it("does not leak one run's frozen verdict into another run", async () => {
    const reviewer = vi.fn(async input => ({ decision: "independent", manifestDigest: input.manifestDigest,
      reasonCode: "explicit_independent" }));
    const f = grounder(reviewer);

    await f.resolve({ context, proposal });
    await f.resolve({ context: { ...context, runId: id(15) }, proposal });

    expect(reviewer).toHaveBeenCalledTimes(2);
  });

  it("returns recoverable without materialization for mismatched evidence, ambiguity, errors, and timeout", async () => {
    const mismatch = grounder(async input => ({ decision: "bind", manifestDigest: input.manifestDigest,
      candidateKeys: ["source-1"], usage: "reference", evidence: { sourceId: id(20), quote: "并不存在的原话" },
      reasonCode: "recent_result" }));
    await expect(mismatch.resolve({ context, proposal })).resolves.toMatchObject({ decision: "recoverable", code: "source_grounding_unavailable" });
    expect(mismatch.materialize).not.toHaveBeenCalled();

    const unclear = grounder(async input => ({ decision: "ambiguous", manifestDigest: input.manifestDigest,
      candidateKeys: ["source-1"], reasonCode: "insufficient_context" }));
    await expect(unclear.resolve({ context, proposal })).resolves.toMatchObject({ decision: "recoverable", code: "source_grounding_ambiguous" });

    const failed = grounder(async () => { throw new Error("provider unavailable"); });
    await expect(failed.resolve({ context, proposal })).resolves.toMatchObject({ decision: "recoverable", code: "source_grounding_unavailable" });

    const hanging = grounder(async () => await new Promise(() => undefined), undefined, 20);
    await expect(hanging.resolve({ context, proposal })).resolves.toMatchObject({ decision: "recoverable", code: "source_grounding_unavailable" });
  });

  it("runs the real Mastra structured-output path through the DeepSeek compatibility model with no tools", async () => {
    structuredTransport.bodies.length = 0;
    structuredTransport.fetch.mockClear();
    const model = createMastraWorkspaceModel({
      baseUrl: "https://synthetic.invalid/v1", apiKey: "synthetic-only",
      upstreamModelId: "deepseek-v4-flash-vision-exp",
    });
    const f = grounder(createMastraImageSourceReviewer(model));

    await expect(f.resolve({ context, proposal })).resolves.toMatchObject({
      decision: "bind", sourceAssetIds: [assetId], authorizationGranted: false,
    });
    expect(structuredTransport.fetch).toHaveBeenCalledOnce();
    expect(structuredTransport.bodies[0]?.model).toBe("deepseek-v4-flash-vision-exp");
    expect(structuredTransport.bodies[0]?.tools).toBeUndefined();
    expect(structuredTransport.bodies[0]?.response_format).toBeUndefined();
    const structuredMessages = JSON.stringify(structuredTransport.bodies[0]?.messages);
    expect(structuredMessages).toMatch(/JSON/i);
    expect(structuredMessages).toContain("manifestDigest");
    expect(structuredMessages).toContain("candidateKeys");
    expect(structuredMessages).toContain("ambiguous");
    expect(structuredTransport.bodies[0]?.thinking).toEqual({ type: "disabled" });
  });

  it("keeps only bounded whole recent user messages", () => {
    expect(buildMastraImageSourceEffectiveBrief([
      { id: "old", role: "user", content: "use source A" },
      { id: "latest", role: "user", content: "use source B " + "x".repeat(500) },
    ], "current", 200)).toEqual([]);
    const result = buildMastraImageSourceEffectiveBrief([
      { id: "assistant", role: "assistant", content: "hidden scratchpad" },
      { id: "old", role: "user", content: "x".repeat(500) },
      { id: "recent", role: "user", content: "参考刚才结果" },
      { id: "current", role: "user", content: "current" },
    ], "current", 200);
    expect(result).toEqual([{ sourceId: "recent", text: "参考刚才结果", provenance: "recent_user" }]);
  });

  it("resolves explicit IDs from the frozen manifest without a semantic reviewer", async () => {
    const materialize = vi.fn(async (selected: readonly MastraImageSourceCandidate[]) => selected.map(item => ({
      assetId: item.assetId, inputImage: "data:image/png;base64,aGVsbG8=",
    })));
    const resolve = createMastraExplicitImageSourceResolver({ candidates: [candidate()], materialize });
    await expect(resolve({ context, sourceAssetIds: [assetId] })).resolves.toEqual({
      sourceAssetIds: [assetId], inputImages: ["data:image/png;base64,aGVsbG8="],
    });
    await expect(resolve({ context, sourceAssetIds: [id(99)] })).rejects.toThrow("explicit_source_not_in_manifest");
    expect(materialize).toHaveBeenCalledOnce();
  });

  it("does not let an explicit recent job replace the single canvas-selected source", async () => {
    const selectedAssetId = id(30);
    const recentAssetId = id(31);
    const candidates = [
      candidate({ candidateKey: "source-1", assetId: selectedAssetId, provenance: ["selected_canvas_image"] }),
      candidate({ candidateKey: "source-2", assetId: recentAssetId, provenance: ["recent_succeeded_job"] }),
    ];
    const materialize = vi.fn(async (selected: readonly MastraImageSourceCandidate[]) => selected.map(item => ({
      assetId: item.assetId, inputImage: "data:image/png;base64,aGVsbG8=",
    })));
    const resolve = createMastraExplicitImageSourceResolver({ candidates, materialize,
      requiredSourceAssetId: selectedAssetId });

    await expect(resolve({ context, sourceAssetIds: [recentAssetId] }))
      .rejects.toThrow("explicit_source_conflicts_with_canvas_selection");
    await expect(resolve({ context, sourceAssetIds: [selectedAssetId] }))
      .resolves.toMatchObject({ sourceAssetIds: [selectedAssetId] });
    expect(materialize).toHaveBeenCalledOnce();
  });

  it("fails closed when semantic grounding replaces the single canvas-selected source", async () => {
    const selectedAssetId = id(32);
    const recentAssetId = id(33);
    const candidates = [
      candidate({ candidateKey: "source-1", assetId: selectedAssetId, provenance: ["selected_canvas_image"] }),
      candidate({ candidateKey: "source-2", assetId: recentAssetId, provenance: ["recent_succeeded_job"] }),
    ];
    const materialize = vi.fn();
    const resolve = createMastraImageSourceGrounder({
      currentRequest: { sourceId: id(20), text: "把选中的 aaaa 改成红色", provenance: "current_user" },
      effectiveBrief: [], candidates, requiredSourceAssetId: selectedAssetId, materialize,
      reviewer: async input => ({ decision: "bind", manifestDigest: input.manifestDigest,
        candidateKeys: ["source-2"], usage: "edit", evidence: { sourceId: id(20), quote: "选中的 aaaa" },
        reasonCode: "recent_result" }),
    });

    await expect(resolve({ context, proposal })).resolves.toMatchObject({
      decision: "recoverable", code: "source_grounding_ambiguous",
    });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("keeps all sixteen explicit sources ordered and rejects a seventeenth", async () => {
    const candidates = Array.from({ length: 16 }, (_, index) => candidate({
      candidateKey: `source-${index + 1}`,
      assetId: id(100 + index),
    }));
    const materialize = vi.fn(async (selected: readonly MastraImageSourceCandidate[]) => selected.map((item, index) => ({
      assetId: item.assetId, inputImage: `data:image/png;base64,cmVm${index}`,
    })));
    const resolve = createMastraExplicitImageSourceResolver({ candidates, materialize });
    const sourceAssetIds = candidates.map(item => item.assetId);
    await expect(resolve({ context, sourceAssetIds })).resolves.toMatchObject({
      sourceAssetIds, inputImages: sourceAssetIds.map((_, index) => `data:image/png;base64,cmVm${index}`),
    });
    await expect(resolve({ context, sourceAssetIds: [...sourceAssetIds, id(999)] }))
      .rejects.toThrow("explicit_source_manifest_invalid");

    const review = { decision: "bind", manifestDigest: "a".repeat(64), candidateKeys: candidates.map(item => item.candidateKey),
      usage: "reference", evidence: { sourceId: id(20), quote: "刚才双叶logo" }, reasonCode: "recent_result" };
    expect(mastraImageSourceReviewSchema.safeParse(review).success).toBe(true);
    expect(mastraImageSourceReviewSchema.safeParse({ ...review, candidateKeys: [...review.candidateKeys, "source-17"] }).success).toBe(false);
  });

  it("resolves an old explicit asset through a scoped lookup and still materializes lineage", async () => {
    const lookup = vi.fn(async () => [candidate()]);
    const materialize = vi.fn(async () => [{ assetId, inputImage: "data:image/png;base64,aGVsbG8=" }]);
    const resolve = createMastraExplicitImageSourceResolver({ candidates: [], lookup, materialize });
    await expect(resolve({ context, sourceAssetIds: [assetId] })).resolves.toMatchObject({ sourceAssetIds: [assetId] });
    expect(lookup).toHaveBeenCalledWith([assetId], context);
    expect(materialize).toHaveBeenCalledOnce();
    await expect(resolve({ context, sourceAssetIds: [id(99)] })).rejects.toThrow("explicit_source_not_in_manifest");
  });

  it("freezes ordered trusted candidates and merges provenance without exposing source IDs as keys", () => {
    const candidates = buildMastraImageSourceCandidates({
      currentAttachments: [],
      canvasCandidates: [{ elementId: "element-private", canvasIndex: 0, assetId, title: "双叶", priority: "selected" }],
      recentJobs: [{ id: jobId, status: "succeeded", result: { asset_id: assetId }, title: "最近双叶",
        prompt: "深蓝双叶", createdAt: "2026-09-13T00:00:00.000Z", designId }],
      canvasId, liveDesignIds: new Set([designId]),
    });
    expect(candidates).toEqual([expect.objectContaining({ candidateKey: "source-1", assetId,
      provenance: ["selected_canvas_image", "recent_succeeded_job"], elementId: "element-private", jobId })]);
  });
});

function queryChain(final: () => Promise<{ data: any; error: any }>, terminal: "single" | "maybeSingle") {
  const chain: any = {};
  for (const method of ["select", "eq", "or"] as const) chain[method] = vi.fn(() => chain);
  chain[terminal] = vi.fn(final);
  return chain;
}

describe("Mastra grounded source authorization", () => {
  it("materializes a succeeded exact-session job only while its design remains live", async () => {
    const canvas = queryChain(async () => ({ data: { id: canvasId, content: { elements: [
      { id: "board", type: "embeddable", x: 0, y: 0, width: 100, height: 100, isDeleted: false, customData: { designId } },
    ] } }, error: null }), "single");
    const job = queryChain(async () => ({ data: { id: jobId, status: "succeeded", result: { asset_id: assetId },
      canvas_id: null, design_id: designId }, error: null }), "maybeSingle");
    const client = { from: vi.fn((table: string) => table === "canvases" ? canvas : job) };
    const resolveAttachment = vi.fn(async () => ({ assetId, mimeType: "image/png", buffer: Buffer.from("hello") }));
    const scopeImageJobs = vi.fn((query: any) => query);
    const materialize = createMastraImageSourceMaterializer({ client, attachmentMap: {}, userId: context.userId,
      workspaceId: context.workspaceId, sessionId: context.sessionId, canvasId, scopeImageJobs, resolveAttachment });

    await expect(materialize([candidate()], { signal: context.signal, usage: "reference" })).resolves.toEqual([
      { assetId, inputImage: "data:image/png;base64,aGVsbG8=" },
    ]);
    expect(scopeImageJobs).toHaveBeenCalledOnce();
    expect(job.eq.mock.calls).toEqual(expect.arrayContaining([
      ["id", jobId], ["created_by", context.userId], ["workspace_id", context.workspaceId],
      ["session_id", context.sessionId], ["job_type", "image_generation"],
    ]));
    expect(resolveAttachment).toHaveBeenCalledWith(expect.objectContaining({ attachment: expect.objectContaining({ assetId }) }));
  });

  it("rejects a completed job after its design is deleted", async () => {
    const canvas = queryChain(async () => ({ data: { id: canvasId, content: { elements: [
      { id: "board", type: "embeddable", x: 0, y: 0, width: 100, height: 100, isDeleted: true, customData: { designId } },
    ] } }, error: null }), "single");
    const job = queryChain(async () => ({ data: { id: jobId, status: "succeeded", result: { asset_id: assetId },
      canvas_id: null, design_id: designId }, error: null }), "maybeSingle");
    const resolveAttachment = vi.fn();
    const materialize = createMastraImageSourceMaterializer({
      client: { from: vi.fn((table: string) => table === "canvases" ? canvas : job) }, attachmentMap: {},
      userId: context.userId, workspaceId: context.workspaceId, sessionId: context.sessionId, canvasId,
      scopeImageJobs: query => query, resolveAttachment,
    });
    await expect(materialize([candidate()], { signal: context.signal, usage: "reference" }))
      .rejects.toThrow("source_candidate_out_of_scope");
    expect(resolveAttachment).not.toHaveBeenCalled();
  });

  it("rejects a job hidden by the exact creator/workspace/session scope", async () => {
    const canvas = queryChain(async () => ({ data: { id: canvasId, content: { elements: [
      { id: "board", type: "embeddable", x: 0, y: 0, width: 100, height: 100, customData: { designId } },
    ] } }, error: null }), "single");
    const job = queryChain(async () => ({ data: null, error: null }), "maybeSingle");
    const resolveAttachment = vi.fn();
    const materialize = createMastraImageSourceMaterializer({
      client: { from: vi.fn((table: string) => table === "canvases" ? canvas : job) }, attachmentMap: {},
      userId: context.userId, workspaceId: context.workspaceId, sessionId: context.sessionId, canvasId,
      scopeImageJobs: query => query, resolveAttachment,
    });
    await expect(materialize([candidate()], { signal: context.signal, usage: "edit" }))
      .rejects.toThrow("source_candidate_out_of_scope");
    expect(job.eq.mock.calls).toEqual(expect.arrayContaining([
      ["created_by", context.userId], ["workspace_id", context.workspaceId], ["session_id", context.sessionId],
    ]));
    expect(resolveAttachment).not.toHaveBeenCalled();
  });
});
