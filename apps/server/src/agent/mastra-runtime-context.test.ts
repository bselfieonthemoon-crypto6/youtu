import { describe, expect, it } from "vitest";

import { createContextBudget } from "./context-budget.js";
import { declaresWorkspaceLibrary, resolveMastraHistoryLimits, resolveMastraMemoryMode, shouldCommitMastraHistory, MASTRA_RECENT_IMAGE_JOB_PROJECTION, projectMastraImageReceipt } from "./mastra-runtime.js";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";

describe("Mastra runtime context policy", () => {
  it("chooses one memory pipeline and rejects ambiguous configuration", () => {
    expect(resolveMastraMemoryMode({})).toBe("legacy");
    expect(resolveMastraMemoryMode({ LOOMIC_MASTRA_MEMORY_MODE: "observational" })).toBe("observational");
    expect(() => resolveMastraMemoryMode({ LOOMIC_MASTRA_MEMORY_MODE: "both" })).toThrow("mastra_memory_mode_invalid");
  });
  it("preserves actual model from projected database rows without loading binary payloads", () => {
    expect(MASTRA_RECENT_IMAGE_JOB_PROJECTION).toContain("model:payload->>model");
    expect(MASTRA_RECENT_IMAGE_JOB_PROJECTION).toContain("error_code");
    expect(MASTRA_RECENT_IMAGE_JOB_PROJECTION).not.toMatch(/(?:^|,)payload(?:,|$)/);
    expect(projectMastraImageReceipt({ model: "workspace:nano", aspectRatio: "3:4",
      status: "dead_letter", error_code: "provider_rejected", error_message: "no compatible channel" },
    [{ id: "workspace:nano", upstreamModelId: "nano-banana-2" }])).toMatchObject({
      actualSubmittedModel: "workspace:nano", actualSubmittedUpstreamModel: "nano-banana-2",
      requestedAspectRatio: "3:4", errorCode: "provider_rejected", error: "no compatible channel",
    });
  });

  it("carries an image's real pixels and its canvas element on the receipt, never onto the frame", () => {
    // The receipt is the only authority for source pixels: asset_objects has no
    // dimensions and the canvas element only holds the 381x512 display frame of
    // this 880x1184 PNG, which a status answer once reported as "实际像素".
    const receipt = projectMastraImageReceipt({
      id: first, status: "succeeded", model: "workspace:nano", canvas_id: second,
      design_id: "00000000-0000-4000-8000-000000000003",
      requestedAspectRatio: "3:4", resolution: "2k",
      result: { asset_id: second, width: 880, height: 1_184, canvas_element_id: "000fba30-7066-4b11-a1c0-a6af26b3ad6b" },
    }, []);
    expect(receipt).toMatchObject({ assetId: second, sourcePixelWidth: 880, sourcePixelHeight: 1_184,
      canvasElementId: "000fba30-7066-4b11-a1c0-a6af26b3ad6b" });
    // A receipt with no result (failed or in flight) must not claim dimensions.
    expect(projectMastraImageReceipt({ id: second, status: "running" }, []))
      .not.toHaveProperty("sourcePixelWidth");
  });

  it("keeps the four image sizes apart on one receipt and states the two it cannot answer", () => {
    // ①用户要求尺寸 ②AI 原始图片像素 ③画布显示尺寸 ④最终导出尺寸. This receipt can
    // authoritatively state ① and ②; ③ it can only point at by element id (the
    // canvas element carries the display frame); ④ it must report as unknown
    // rather than let ② or ③ be read as the export size.
    const receipt = projectMastraImageReceipt({
      id: first, status: "succeeded", model: "workspace:nano", canvas_id: second,
      design_id: "00000000-0000-4000-8000-000000000003",
      requestedAspectRatio: "3:4", resolution: "2k",
      result: { asset_id: second, width: 880, height: 1_184, canvas_element_id: "000fba30-7066-4b11-a1c0-a6af26b3ad6b" },
    }, []);
    expect(receipt).toMatchObject({
      // ① the requested frame: the submission's own ratio + resolution tier.
      requestedFrame: { aspectRatio: "3:4", resolution: "2k" },
      // ② the real pixels, authoritative on this row.
      sourcePixelWidth: 880, sourcePixelHeight: 1_184,
      // ③ a join key, not a size: the frame lives on this element in the canvas.
      canvasElementId: "000fba30-7066-4b11-a1c0-a6af26b3ad6b",
      // ④ never this job's answer, and stated rather than omitted.
      exportSize: null,
      hasSourcePixels: true, canvasElementIdKnown: true,
      // So an answer can move between the job world and the canvas world.
      canvasId: second, designId: "00000000-0000-4000-8000-000000000003",
    });
    for (const size of ["image_requested_frame", "image_source_pixels", "image_canvas_frame", "image_export_size"])
      expect(String(receipt.sizes)).toContain(size);
    expect(receipt.authorities.exportSize).toContain("design_export");
    expect(receipt.authorities.sourcePixels).toContain("background_jobs.result.width/height");
    // The frame cannot be inferred from this receipt at all, so the receipt must
    // not carry any bare width/height a caller could read as ② or ③.
    expect(receipt).not.toHaveProperty("width");
    expect(receipt).not.toHaveProperty("height");

    // A failed or in-flight job: ② is reported as absent rather than guessed, and
    // ④ is still explicitly null rather than dropped.
    const incomplete = projectMastraImageReceipt({ id: second, status: "running", requestedAspectRatio: "1:1" }, []);
    expect(incomplete).toMatchObject({ exportSize: null, hasSourcePixels: false, canvasElementIdKnown: false });
    expect(incomplete).not.toHaveProperty("sourcePixelWidth");
    expect(incomplete).not.toHaveProperty("canvasElementId");
    // Claimed pixels without a canvas placement must not pretend ③ is known.
    const unplaced = projectMastraImageReceipt({ id: second, status: "succeeded",
      result: { width: 1024, height: 1024 } }, []);
    expect(unplaced).toMatchObject({ sourcePixelWidth: 1024, sourcePixelHeight: 1024, canvasElementIdKnown: false });
  });

  it("derives the history byte ceiling from the current model budget", () => {
    const budget = createContextBudget(undefined, "lean-expandable");
    const limits = resolveMastraHistoryLimits(budget);

    expect(limits.maxContextBytes).toBe(Math.max(128, Math.min(
      48_000,
      budget.targetTokens * 2,
      Math.max(128, budget.inputCeilingTokens - 832),
    )));
    expect(limits.summaryTargetBytes).toBeLessThan(limits.maxContextBytes);
    expect(limits.summarizerInputBytes).toBeLessThanOrEqual(28_000);
  });

  it("commits when coverage changes even if the summary text is identical", () => {
    const snapshot = {
      summary: "same facts",
      coverage: { messageIds: [first], omissions: [] },
    } as never;

    expect(shouldCommitMastraHistory({
      summary: "same facts",
      coverageMessageIds: [first, second],
      omissions: [],
    }, snapshot)).toBe(true);
  });

  it("commits when omissions change even if summary and coverage are identical", () => {
    const snapshot = {
      summary: "same facts",
      coverage: { messageIds: [first], omissions: [] },
    } as never;

    expect(shouldCommitMastraHistory({
      summary: "same facts",
      coverageMessageIds: [first],
      omissions: ["older evidence remains available"],
    }, snapshot)).toBe(true);
  });

  it("does not rewrite an unchanged snapshot or commit an empty summary", () => {
    const snapshot = {
      summary: "same facts",
      coverage: { messageIds: [first], omissions: ["bounded"] },
    } as never;

    expect(shouldCommitMastraHistory({
      summary: "same facts",
      coverageMessageIds: [first],
      omissions: ["bounded"],
    }, snapshot)).toBe(false);
    expect(shouldCommitMastraHistory({
      summary: "",
      coverageMessageIds: [first, second],
      omissions: ["changed"],
    }, snapshot)).toBe(false);
  });
});

describe("workspace-library attachment follows declaration or adoption, never keywords", () => {
  const metadata = {
    "game-promo-visuals": { attachWorkspaceLibrary: true },
    "campaign-design": { attachWorkspaceLibrary: false },
  };
  const rule = (declaredSkills: string[], mentionedSkills: string[] = []) =>
    declaresWorkspaceLibrary({ declaredSkills, mentionedSkills, metadata });

  it("enables the library path for the Skill the turn declares", () => {
    // A user @mention is their own decision.
    expect(rule([], ["game-promo-visuals"])).toBe(true);
    // A continuation reuses the Skill the session already adopted.
    expect(rule(["game-promo-visuals"])).toBe(true);
  });

  it("stays off for a Skill that declares no library, for an unknown one, and for a keyword-only match", () => {
    expect(rule(["campaign-design"], ["campaign-design"])).toBe(false);
    expect(rule(["not-an-enabled-skill"])).toBe(false);
    // The branch the call site deliberately does not take: "做一个游戏充值活动图"
    // matches the promo package's keywords, but a run that neither named it nor read
    // it must not attach its library — a candidate is a hint for the model, not an
    // adoption, and acting on one would restore runtime routing.
    expect(rule([])).toBe(false);
  });
});
