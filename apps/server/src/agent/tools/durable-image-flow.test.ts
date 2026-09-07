import { describe, expect, it, vi } from "vitest";
import { isExplicitImageConfirmationMessage } from "@loomic/shared";
import { createDestructiveConfirmationService } from "../../features/agent-actions/destructive-confirmation-service.js";
import type { ImageProposalStore } from "../../features/agent-actions/image-proposal-store.js";
import { createImageGenerateTool } from "./image-generate.js";
import { createImageGenerationConfirmationTool } from "./image-generation-confirmation.js";

const id = "10000000-0000-4000-8000-000000000001";
const context = {
  configurable: {
    access_token: "test-token",
    user_id: "user",
    canvas_id: "canvas",
    session_id: "session",
    run_id: id,
    user_prompt: "确认生成",
  },
};
const frozen = {
  title: "Logo",
  prompt: "red logo",
  model: "test",
  aspectRatio: "1:1",
};
function store(): ImageProposalStore {
  return {
    latest: vi.fn(async () => null),
    propose: vi.fn(async () => ({
      confirmationId: id,
      canvasId: "canvas",
      kind: "image_generation",
      details: {},
      expiresAt: "2099-01-01",
    })),
    decide: vi.fn(async () => ({
      id,
      input: structuredClone(frozen),
      status: "confirmed",
    })),
    job: vi.fn(async () => null),
  };
}
describe("durable conversational image boundary", () => {
  it.each([
    "不要确认生成",
    "确认，但先改成红色",
    "可以，但是换成方形",
    "不同意",
    "确认吗",
    "不可以生成",
    "请问如何确认",
  ])("does not execute ambiguous/negative approval: %s", async (prompt) => {
    const db = store();
    const submit = vi.fn();
    const tool = createImageGenerationConfirmationTool({
      confirmationService: createDestructiveConfirmationService(),
      proposalStore: db,
      submitImageJob: submit,
    });
    const result = await tool.invoke(
      { confirmationId: id, decision: "confirm" },
      { configurable: { ...context.configurable, user_prompt: prompt } },
    );
    expect(result).toMatchObject({ error: "explicit_confirmation_required" });
    expect(db.decide).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  it.each([
    "确认生成",
    "好的",
    "确认，就按这个生成",
    "确认，请按上述方案继续执行并生成预览",
  ])("shares the UI approval vocabulary: %s", (prompt) =>
    expect(isExplicitImageConfirmationMessage(prompt)).toBe(true),
  );
  it("saves frozen input without calling the provider", async () => {
    const db = store();
    const submit = vi.fn();
    const tool = createImageGenerateTool({
      proposalStore: db,
      submitImageJob: submit,
      availableModels: [],
    });
    expect(await tool.invoke(frozen, context)).toMatchObject({
      status: "awaiting_confirmation",
    });
    expect(db.propose).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  it("uses the new confirmation run's executor after service reconstruction", async () => {
    const db = store();
    const oldSubmit = vi.fn();
    await createImageGenerateTool({
      proposalStore: db,
      submitImageJob: oldSubmit,
      availableModels: [],
    }).invoke(frozen, context);
    const newSubmit = vi.fn(async () => ({
      jobId: id,
      status: "processing" as const,
    }));
    const confirm = createImageGenerationConfirmationTool({
      confirmationService: createDestructiveConfirmationService(),
      proposalStore: db,
      submitImageJob: newSubmit,
    });
    expect(
      await confirm.invoke(
        { confirmationId: id, decision: "confirm" },
        context,
      ),
    ).toMatchObject({ status: "processing", jobId: id });
    expect(oldSubmit).not.toHaveBeenCalled();
    expect(newSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: id, prompt: "red logo" }),
    );
  });
  it("does not silently drop unresolved reference images", async () => {
    const db = store();
    const tool = createImageGenerateTool({
      proposalStore: db,
      availableModels: [],
    });
    expect(
      await tool.invoke(
        { ...frozen, inputImages: ["unresolved-asset"] },
        context,
      ),
    ).toMatchObject({ error: "invalid_reference_image" });
    expect(db.propose).not.toHaveBeenCalled();
  });
  it("blocks accidental fallback from a design to the infinite canvas", async () => {
    const db = store();
    vi.mocked(db.latest).mockResolvedValue({
      id,
      status: "confirmed",
      input: {
        ...frozen,
        target: {
          kind: "design",
          design_id: id,
          expected_revision: 1,
          idempotency_key: id,
          placement: { x: 0, y: 0 },
        },
      },
    });
    const tool = createImageGenerateTool({
      proposalStore: db,
      availableModels: [],
    });
    expect(
      await tool.invoke(frozen, {
        configurable: { ...context.configurable, user_prompt: "换成红色" },
      }),
    ).toMatchObject({ error: "design_target_required" });
    expect(db.propose).not.toHaveBeenCalled();
  });
  it("revalidates before creating a design job but allows replay after design changes", async () => {
    const db = store();
    vi.mocked(db.decide).mockResolvedValue({
      id,
      status: "confirmed",
      input: {
        ...frozen,
        target: {
          kind: "design",
          design_id: id,
          expected_revision: 1,
          idempotency_key: id,
          placement: { x: 0, y: 0 },
        },
      },
    });
    const validate = vi.fn(async () => {
      throw new Error("画板版本已改变");
    });
    const submit = vi.fn(async () => ({
      jobId: id,
      status: "processing" as const,
    }));
    const tool = createImageGenerationConfirmationTool({
      confirmationService: createDestructiveConfirmationService(),
      proposalStore: db,
      validateDesignTarget: validate,
      submitImageJob: submit,
    });
    expect(
      await tool.invoke({ confirmationId: id, decision: "confirm" }, context),
    ).toMatchObject({ error: "confirmation_unavailable" });
    expect(submit).not.toHaveBeenCalled();
    vi.mocked(db.job).mockResolvedValue({ id, status: "succeeded" });
    expect(
      await tool.invoke({ confirmationId: id, decision: "confirm" }, context),
    ).toMatchObject({ jobId: id, status: "processing" });
    expect(validate).toHaveBeenCalledTimes(1);
  });
});
